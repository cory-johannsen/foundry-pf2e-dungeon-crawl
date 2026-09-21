/**
 * Pure combat-turn decision logic for agent-controlled combatants — no
 * Foundry API surface at all, so it's directly unit-testable with plain
 * objects. `dungeon-combat.mjs` is the only caller: it does every real
 * Combat/Actor/Token read (converting positions to `distanceSquares`, ready
 * actions to `{slug, label, variantCount, reachSquares}`, etc.) and owns
 * applying whichever candidate gets chosen back to the actual game — see
 * `docs/superpowers/specs/2026-09-20-agent-bridge-combat-ai-design.md`.
 */

export const MAX_ACTIONS_PER_TURN = 3;
export const AGENT_MELEE_REACH_SQUARES = 1;

/** Fresh per-turn bookkeeping — reset the instant an agent-controlled
 * combatant's turn becomes current. */
export function initAgentTurnState() {
  return { actionsRemaining: MAX_ACTIONS_PER_TURN, mapIncrement: 0 };
}

/**
 * Movement-posture candidates. `approach` is offered for every opponent
 * beyond melee reach; `retreat` only for an opponent already close (within
 * melee reach + 1) and only when this combatant has some ranged/reach
 * option (a pure melee brawler never wants to back off); `reposition` once,
 * only when a `hazard` is given and within 1 square.
 */
export function buildMovementCandidates({ opponents, hazard = null, hasRangedOrReach = false }) {
  const candidates = [];
  for (const opponent of opponents) {
    if (opponent.distanceSquares > AGENT_MELEE_REACH_SQUARES) {
      candidates.push({
        id: `stride:approach:${opponent.id}`, type: 'stride', posture: 'approach',
        targetId: opponent.id, cost: 1, summary: `Move toward ${opponent.name}`
      });
    } else if (hasRangedOrReach) {
      candidates.push({
        id: `stride:retreat:${opponent.id}`, type: 'stride', posture: 'retreat',
        targetId: opponent.id, cost: 1, summary: `Move away from ${opponent.name}`
      });
    }
  }
  if (hazard && hazard.distanceSquares <= 1) {
    candidates.push({
      id: 'stride:reposition', type: 'stride', posture: 'reposition',
      targetId: null, cost: 1, summary: 'Move away from the nearby hazard'
    });
  }
  return candidates;
}

/**
 * One candidate per ready action x each opponent currently within that
 * action's own reach, at the strike variant matching the turn's current
 * `mapIncrement` (clamped to the action's own variant count — a standard
 * PF2e strike always has exactly 3: no penalty, -4/-5, -8/-10, confirmed
 * live against a real bestiary actor during planning).
 */
export function buildStrikeCandidates({ readyActions, opponents, mapIncrement }) {
  const candidates = [];
  for (const action of readyActions) {
    const variantIndex = Math.min(mapIncrement, action.variantCount - 1);
    for (const opponent of opponents) {
      if (opponent.distanceSquares > action.reachSquares) continue;
      candidates.push({
        id: `strike:${action.slug}:${opponent.id}`, type: 'strike',
        actionSlug: action.slug, targetId: opponent.id, variantIndex, cost: 1,
        summary: `${action.label} vs ${opponent.name} (variant ${variantIndex})`
      });
    }
  }
  return candidates;
}

/**
 * One candidate per ready single-target, save-based spell x each opponent
 * within that spell's range, provided the spell's own action cost fits the
 * actions still remaining this turn (unlike a strike, a spell's cost isn't
 * always 1, so this check can't wait for `buildCandidateList`'s exhausted
 * short-circuit).
 */
export function buildSpellCandidates({ readySpells, opponents, actionsRemaining }) {
  const candidates = [];
  for (const spell of readySpells) {
    if (spell.cost > actionsRemaining) continue;
    for (const opponent of opponents) {
      if (opponent.distanceSquares > spell.rangeSquares) continue;
      candidates.push({
        id: `cast:${spell.slug}:${opponent.id}`, type: 'cast',
        spellId: spell.id, entryId: spell.entryId, targetId: opponent.id, cost: spell.cost,
        save: spell.save, basic: spell.basic,
        summary: `${spell.label} vs ${opponent.name}`
      });
    }
  }
  return candidates;
}

/**
 * The tier-specific overrides for a #140-scoped tier-scaling area spell
 * (Wronged Monk's Wrath-shaped: same emanation/burst shape at every tier,
 * only the radius and damage grow with action cost), parsed from raw
 * description prose — there is no structured field for this at all, only
 * "If you use N actions to cast the spell, increase the size of the
 * emanation/area to X feet and the damage to YdZ ... damage[, and AdB ...
 * damage]." clauses, one per non-minimum tier. The spell's own minimum
 * tier (1 action, usually) is *not* included here — it comes from the
 * spell's already-structured `system.area`/`system.damage` fields instead,
 * matching #122's established "minimum tier = structured data" convention.
 * Keyed by cost (2, 3, ...); a spell with no matching clauses at all
 * returns `{}`.
 */
export function parseAreaSpellTierOverrides(descriptionHtml) {
  const tiers = {};
  const tierRegex = /If you use (\d)\s+actions?\s+to cast the spell,([^]*?)(?=If you use \d|<hr|<\/p>\s*$|$)/gi;
  let match;
  while ((match = tierRegex.exec(descriptionHtml))) {
    const cost = Number(match[1]);
    const clause = match[2];
    const radiusMatch = /(\d+)\s*feet/.exec(clause);
    const damageMatches = Array.from(
      clause.matchAll(/(\d+d\d+)\s+(\w+)\s+damage/gi),
    );
    if (!radiusMatch || !damageMatches.length) continue;
    tiers[cost] = {
      cost,
      radiusFeet: Number(radiusMatch[1]),
      damage: damageMatches.map((m) => ({
        formula: m[1],
        type: m[2].toLowerCase(),
      })),
    };
  }
  return tiers;
}

/**
 * The best-scoring placement among a set of precomputed options, or `null`
 * if none catch at least one opponent — an ally-only or empty blast simply
 * isn't a candidate. Scoring is lexicographic (#126, decided live):
 * maximize opponents hit first, then — only to break a tie on that count —
 * prefer whichever placement hits fewer allies. A placement is never passed
 * over for a strictly worse one just because it grazes one fewer ally; this
 * is not a net "enemies minus allies" score. Shared by
 * `buildAreaSpellCandidates` (#119/#126, one candidate per spell) and
 * `buildTierScalingAreaSpellCandidates` (#140, one candidate per
 * cost tier of the same spell) — both need the identical placement-scoring
 * rule, just applied to a different unit of "one candidate."
 */
function bestAreaPlacement(placements) {
  return placements
    .filter((p) => p.affected.length > 0)
    .reduce((a, b) => {
      if (!a) return b;
      if (b.affected.length !== a.affected.length) {
        return b.affected.length > a.affected.length ? b : a;
      }
      const aAllies = a.affectedAllies?.length ?? 0;
      const bAllies = b.affectedAllies?.length ?? 0;
      return bAllies < aAllies ? b : a;
    }, null);
}

/**
 * One candidate per ready area spell (burst/emanation, save-based damage —
 * see dungeon-combat.mjs's isAreaSpellInScope), centered at whichever of the
 * caller's precomputed `placements` scores best (`bestAreaPlacement`). Real
 * token geometry (which opponents/allies actually fall within a given
 * radius of a given point, `affected`/`affectedAllies` on each placement)
 * is computed by the caller — this function only ever picks among
 * already-computed options.
 */
export function buildAreaSpellCandidates({ readyAreaSpells, actionsRemaining }) {
  const candidates = [];
  for (const spell of readyAreaSpells) {
    if (spell.cost > actionsRemaining) continue;
    const best = bestAreaPlacement(spell.placements);
    if (!best) continue;
    const idSuffix = best.centerId ? `:${best.centerId}` : '';
    candidates.push({
      id: `castArea:${spell.slug}:${best.centerType}${idSuffix}`, type: 'castArea',
      spellId: spell.id, entryId: spell.entryId, cost: spell.cost,
      save: spell.save, basic: spell.basic,
      centerType: best.centerType, centerId: best.centerId,
      affectedIds: best.affected.map((o) => o.id),
      affectedAllyIds: (best.affectedAllies ?? []).map((o) => o.id),
      summary: `${spell.label} (hits ${best.affected.map((o) => o.name).join(', ')})`
    });
  }
  return candidates;
}

/**
 * One candidate per affordable cost tier of a ready tier-scaling area
 * spell (#140 — Wronged Monk's Wrath-shaped: same burst/emanation shape at
 * every tier, only the radius and damage grow with cost) — unlike
 * `buildAreaSpellCandidates`, which offers one candidate per *spell*, this
 * offers one candidate per (spell, tier) pair, since a combatant with
 * enough actions remaining might reasonably choose to cast at 1, 2, *or* 3
 * actions and each tier has its own best placement (a bigger radius can
 * catch different opponents/allies than a smaller one centered the same
 * way). `readyTierScalingAreaSpells` entries are one per tier already (the
 * caller expands a single spell into its N tier entries), each carrying
 * its own `cost`/`placements`/`label` — execution re-derives which tier's
 * damage formula to use from the candidate's own `cost`, since a plain
 * spell's `rollDamage()` has no notion of action-count tiers at all
 * (confirmed live it only reads spell rank/heightening, never how many
 * actions were spent).
 */
export function buildTierScalingAreaSpellCandidates({ readyTierScalingAreaSpells, actionsRemaining }) {
  const candidates = [];
  for (const tier of readyTierScalingAreaSpells) {
    if (tier.cost > actionsRemaining) continue;
    const best = bestAreaPlacement(tier.placements);
    if (!best) continue;
    const idSuffix = best.centerId ? `:${best.centerId}` : '';
    candidates.push({
      id: `castAreaTier:${tier.slug}:${best.centerType}${idSuffix}`, type: 'castAreaTier',
      spellId: tier.id, entryId: tier.entryId, cost: tier.cost,
      save: tier.save, basic: tier.basic,
      centerType: best.centerType, centerId: best.centerId,
      affectedIds: best.affected.map((o) => o.id),
      affectedAllyIds: (best.affectedAllies ?? []).map((o) => o.id),
      summary: `${tier.label} (hits ${best.affected.map((o) => o.name).join(', ')})`
    });
  }
  return candidates;
}

/**
 * The per-action-cost-tier overrides for a #174-scoped dual-nature tiered
 * spell (Harm/Heal-shaped: a living-vs-undead spell whose SHAPE, not just
 * its magnitude, changes with action cost — single-target at 1-2 actions,
 * a self-centered area at 3). PF2e's own bestiary text uses a distinct
 * notation for this from #140's "If you use N actions..." prose: a
 * `<span class="action-glyph">N</span>` marker starting each tier's own
 * clause, confirmed live identical in structure across both Harm and Heal.
 * Extracts, per tier: `rangeFeet` (a number, or the literal string
 * `'touch'` for the 1-action tier — left as the raw signal since
 * interpreting `'touch'` into reach squares is dungeon-combat.mjs's job,
 * matching #122's existing `minimumTierRangeSquares` convention), `area`
 * (`{type, value}` parsed from an inline `@Template[type|distance:N]`
 * enricher, #123's already-established pattern, reused here since Harm/
 * Heal's own 3-action tier uses the identical enricher), and `bonus` (the
 * flat "increase the Hit Points restored by N" amount — confirmed live
 * this only ever attaches to a healing-direction single-target tier, never
 * the area tier, so it defaults to 0 when absent). All three tiers are
 * emitted (not just non-minimum ones, unlike #140's parser) since Harm/
 * Heal's *own* structured `system.range`/`system.area` fields don't carry
 * a usable minimum-tier value at all (`range.value` is the literal string
 * `"varies"`, `area` is `null`) — there's no structured fallback to lean
 * on here the way #140 could lean on `system.area`/`system.damage` for its
 * own minimum tier.
 */
export function parseActionGlyphTiers(descriptionHtml) {
  const tiers = {};
  const glyphRegex = /<span class="action-glyph">(\d)<\/span>([^]*?)(?=<span class="action-glyph">|<hr|$)/g;
  let match;
  while ((match = glyphRegex.exec(descriptionHtml))) {
    const cost = Number(match[1]);
    const clause = match[2];
    const tier = { cost };
    if (/range of touch/i.test(clause)) {
      tier.rangeFeet = 'touch';
    } else {
      const feetMatch = /range of (\d+)\s*feet/i.exec(clause);
      if (feetMatch) tier.rangeFeet = Number(feetMatch[1]);
    }
    const areaMatch = /@Template\[(\w+)\|distance:(\d+)\]/.exec(clause);
    if (areaMatch) tier.area = { type: areaMatch[1], value: Number(areaMatch[2]) };
    const bonusMatch = /increase the hit points restored by (\d+)/i.exec(clause);
    tier.bonus = bonusMatch ? Number(bonusMatch[1]) : 0;
    tiers[cost] = tier;
  }
  return tiers;
}

/**
 * Candidates for a #174-scoped dual-nature tiered spell (Harm/Heal-shaped)
 * — three distinct types, since the shape genuinely differs by tier:
 * `castDualHarm` (single-target, save-based damage, reuses #118's own
 * `castSpellAndApplySave` at execution time since confirmed live Harm/
 * Heal's damage-direction roll applies correctly through the standard
 * IWR-respecting path regardless of tier), `castDualHeal` (single-target,
 * no save, carries the tier's own flat `bonus` for execution to add before
 * negating — confirmed live the healing-direction roll always needs #132's
 * manual negation, never the standard path, for both Harm-heals-undead and
 * Heal-heals-living), and `castDualArea` (the 3-action shape change: one
 * candidate bundling every harm-group and heal-group target within the
 * emanation, split by creature type — reuses neither #118's nor #132's
 * pattern alone since a single cast must apply both effects to different
 * targets at once). The caller (dungeon-combat.mjs) has already resolved,
 * per tier, exactly which opponents/allies are in range *and* match this
 * spell's harm/heal polarity for that creature type — this function only
 * ever packages what it's given, same separation of concerns as every
 * other builder in this file.
 */
export function buildDualNatureSpellCandidates({ readyDualNatureSpells, actionsRemaining }) {
  const candidates = [];
  for (const spell of readyDualNatureSpells) {
    for (const tier of spell.singleTargetTiers ?? []) {
      if (tier.cost > actionsRemaining) continue;
      const tierLabel = `${spell.label} (${tier.cost} action${tier.cost > 1 ? 's' : ''})`;
      for (const target of tier.harmTargets ?? []) {
        candidates.push({
          id: `castDualHarm:${spell.slug}:${tier.cost}:${target.id}`, type: 'castDualHarm',
          spellId: spell.id, entryId: spell.entryId, cost: tier.cost, targetId: target.id,
          save: spell.save, basic: spell.basic,
          summary: `${tierLabel} vs ${target.name}`
        });
      }
      for (const target of tier.healTargets ?? []) {
        candidates.push({
          id: `castDualHeal:${spell.slug}:${tier.cost}:${target.id}`, type: 'castDualHeal',
          spellId: spell.id, entryId: spell.entryId, cost: tier.cost, targetId: target.id,
          bonus: tier.bonus ?? 0,
          summary: `${tierLabel} heals ${target.name}`
        });
      }
    }
    const area = spell.areaTier;
    if (area && area.cost <= actionsRemaining) {
      const harmTargets = area.harmTargets ?? [];
      const healTargets = area.healTargets ?? [];
      if (harmTargets.length || healTargets.length) {
        const parts = [];
        if (harmTargets.length) parts.push(`harms ${harmTargets.map((t) => t.name).join(', ')}`);
        if (healTargets.length) parts.push(`heals ${healTargets.map((t) => t.name).join(', ')}`);
        candidates.push({
          id: `castDualArea:${spell.slug}:${area.cost}`, type: 'castDualArea',
          spellId: spell.id, entryId: spell.entryId, cost: area.cost,
          save: spell.save, basic: spell.basic,
          harmIds: harmTargets.map((t) => t.id), healIds: healTargets.map((t) => t.id),
          summary: `${spell.label} (${area.cost} actions) ${parts.join('; ')}`
        });
      }
    }
  }
  return candidates;
}

/**
 * The target-count-per-action ratio for a #175-scoped target-count-scaling
 * spell (Rebuke Death-shaped: same single-target effect resolved
 * independently against N targets, where N grows with action cost, rather
 * than #140's shared-area or #174's shape-changing patterns) — parsed
 * directly from the spell's own *structured* `target.value` field
 * ("1 living creature per action spent to Cast this Spell", confirmed
 * live), unlike every other tier parser in this file, which has to dig
 * into raw description HTML because no structured field carries the
 * signal at all. Written as a general "N creature(s) per [M actions]
 * spent" pattern (an explicit "per 2 actions" denominator is supported,
 * defaulting to 1 when only "per action" appears) rather than hardcoded to
 * Rebuke Death's exact wording, consistent with every other parser this
 * session, even though it's confirmed live to be the only spell in the
 * core SRD pack with this exact shape. `null` when the target text doesn't
 * match at all (an ordinary fixed single-target phrase).
 */
export function parseTargetCountFormula(targetValue) {
  const match = /^(\d+)\s+[\w-]+(?:\s[\w-]+)*?\s+per\s+(?:(\d+)\s+)?actions?\s+spent/i.exec(
    targetValue ?? '',
  );
  if (!match) return null;
  const numerator = Number(match[1]);
  const denominator = match[2] ? Number(match[2]) : 1;
  return { countPerAction: numerator / denominator };
}

/**
 * One candidate per affordable tier of a ready #175-scoped target-count
 * spell, each bundling the tier's own pre-selected targets — the caller
 * (dungeon-combat.mjs) has already resolved, per tier, exactly which
 * allies are in range and how many the tier's own actions-spent afford
 * (sorted neediest-first, per live discussion), same separation of
 * concerns as every other builder in this file. A tier with zero selected
 * targets (nothing in range, or every reachable ally already at full HP)
 * is omitted entirely rather than offered as a no-op cast.
 */
export function buildTargetCountSpellCandidates({ readyTargetCountSpells, actionsRemaining }) {
  const candidates = [];
  for (const spell of readyTargetCountSpells) {
    for (const tier of spell.tiers ?? []) {
      if (tier.cost > actionsRemaining) continue;
      if (!tier.targets?.length) continue;
      candidates.push({
        id: `castTargetCount:${spell.slug}:${tier.cost}`, type: 'castTargetCount',
        spellId: spell.id, entryId: spell.entryId, cost: tier.cost,
        save: spell.save, basic: spell.basic,
        targetIds: tier.targets.map((t) => t.id),
        summary: `${spell.label} (${tier.cost} action${tier.cost > 1 ? 's' : ''}) on ${tier.targets.map((t) => t.name).join(', ')}`
      });
    }
  }
  return candidates;
}

/**
 * The per-action-cost-tier overrides for a #176-scoped auto-hit-at-max-
 * tier area spell (Force Rain-shaped: a burst/square area whose lower
 * tiers are ordinary save-scaled damage but whose *top* tier bypasses the
 * save entirely — "Creatures in the area don't attempt a saving throw and
 * instead automatically take 20 force damage", confirmed live) — a
 * genuinely different shape from #140's Wronged Monk's Wrath (every tier
 * save-scaled) and #174's Harm/Heal (shape changes, but every tier still
 * either saves or is a flat unconditional heal). Uses the same
 * `<span class="action-glyph">N</span>` tier notation #174's parser
 * already established, but the area enricher here uses a *different*
 * `@Template[type:X|distance:N]` key-value syntax (confirmed live) than
 * #174's positional `@Template[X|distance:N]` — a real second variant of
 * PF2e's own enricher grammar, not a typo, so this gets its own regex
 * rather than trying to force one pattern to cover both. Each tier gets
 * either `damageFormula`/`damageType` (an ordinary dice-based, save-scaled
 * tier) or `flatDamage`/`damageType` with `noSave: true` (the auto-hit
 * tier), never both — `noSave` is always present so the caller never has
 * to infer which shape a tier is from field presence alone. The 1-action
 * tier carries no `area` at all (Force Rain's own minimum tier is a
 * single structured "square", not a Template enricher — dungeon-combat.mjs
 * fills that in from the spell's structured `system.area` instead,
 * matching #140's established "structured minimum tier" convention).
 */
export function parseAutoHitAreaTiers(descriptionHtml) {
  const tiers = {};
  const glyphRegex = /<span class="action-glyph">(\d)<\/span>([^]*?)(?=<span class="action-glyph">|<hr|$)/g;
  let match;
  while ((match = glyphRegex.exec(descriptionHtml))) {
    const cost = Number(match[1]);
    const clause = match[2];
    const tier = { cost };
    const areaMatch = /@Template\[type:(\w+)\|distance:(\d+)\]/.exec(clause);
    if (areaMatch) tier.area = { type: areaMatch[1], value: Number(areaMatch[2]) };
    const flatMatch = /automatically take (\d+)\s+(\w+)\s+damage/i.exec(clause);
    if (flatMatch) {
      tier.noSave = true;
      tier.flatDamage = Number(flatMatch[1]);
      tier.damageType = flatMatch[2].toLowerCase();
    } else {
      const diceMatch = /deals (\d+d\d+)\s+(\w+)\s+damage/i.exec(clause);
      tier.noSave = false;
      if (diceMatch) {
        tier.damageFormula = diceMatch[1];
        tier.damageType = diceMatch[2].toLowerCase();
      }
    }
    tiers[cost] = tier;
  }
  return tiers;
}

/**
 * Candidates for a #176-scoped auto-hit-at-max-tier area spell — one
 * candidate per affordable tier, reusing `bestAreaPlacement` (#126/#140's
 * shared lexicographic enemies-then-allies scoring) exactly like #140's
 * `buildTierScalingAreaSpellCandidates`, since Force Rain's placements are
 * opponent-centered bursts at every tier (never a self-centered emanation)
 * — the same "choose the best center point" logic #119's original area
 * spells already use. The only real difference from #140's candidate
 * shape is the `noSave` flag carried straight through from the tier data,
 * so dungeon-combat.mjs's execution knows whether to roll a save at all
 * without re-deriving it from the spell.
 */
export function buildAutoHitAreaSpellCandidates({ readyAutoHitAreaSpells, actionsRemaining }) {
  const candidates = [];
  for (const tier of readyAutoHitAreaSpells) {
    if (tier.cost > actionsRemaining) continue;
    const best = bestAreaPlacement(tier.placements);
    if (!best) continue;
    const idSuffix = best.centerId ? `:${best.centerId}` : '';
    candidates.push({
      id: `castAutoHitAreaTier:${tier.slug}:${best.centerType}${idSuffix}`, type: 'castAutoHitAreaTier',
      spellId: tier.id, entryId: tier.entryId, cost: tier.cost,
      save: tier.save, basic: tier.basic, noSave: tier.noSave,
      centerType: best.centerType, centerId: best.centerId,
      affectedIds: best.affected.map((o) => o.id),
      affectedAllyIds: (best.affectedAllies ?? []).map((o) => o.id),
      summary: `${tier.label} (hits ${best.affected.map((o) => o.name).join(', ')})`
    });
  }
  return candidates;
}

/**
 * One candidate per ready single-target, attack-roll spell x each opponent
 * within that spell's range — same shape as buildSpellCandidates (#118's
 * save-based spells), minus `save`/`basic` (an attack-roll spell resolves
 * against AC via dungeon-combat.mjs's castAttackSpellAndApplyRoll, not a
 * target's own saving throw), and a distinct `castAttack` type so
 * applyAgentDecision's dispatch never conflates the two execution paths.
 */
export function buildAttackSpellCandidates({ readyAttackSpells, opponents, actionsRemaining }) {
  const candidates = [];
  for (const spell of readyAttackSpells) {
    if (spell.cost > actionsRemaining) continue;
    for (const opponent of opponents) {
      if (opponent.distanceSquares > spell.rangeSquares) continue;
      candidates.push({
        id: `castAttack:${spell.slug}:${opponent.id}`, type: 'castAttack',
        spellId: spell.id, entryId: spell.entryId, targetId: opponent.id, cost: spell.cost,
        summary: `${spell.label} vs ${opponent.name}`
      });
    }
  }
  return candidates;
}

/**
 * A spell's outcome→conditions map, parsed from the *raw* description HTML
 * PF2e stores on the item (`spell.system.description.value`), which uses
 * Foundry's `@UUID[Compendium.pf2e.conditionitems.Item.<id>]{<Label> <N>}`
 * enricher syntax to reference a condition inline — confirmed live this is
 * present for many but not all debuff spells, and even within one spell not
 * every outcome tier necessarily tags its condition directly (some restate
 * "as failure, but..." in plain text instead). Each outcome paragraph is
 * parsed independently: an outcome with no tag simply gets no entry (a safe
 * no-op at cast time, not a wrong answer) — cross-tier "as X, but also Y"
 * inheritance is not resolved. A condition mention with a trailing number
 * ("Frightened 2") becomes `{slug: 'frightened', value: 2}`; one without
 * ("Fleeing") becomes `{slug: 'fleeing', value: null}`.
 */
const OUTCOME_HEADINGS = {
  'Critical Success': 'criticalSuccess',
  'Success': 'success',
  'Failure': 'failure',
  'Critical Failure': 'criticalFailure'
};

export function parseConditionsByOutcome(descriptionHtml) {
  const byOutcome = {};
  for (const paragraph of descriptionHtml.matchAll(/<strong>([^<]+)<\/strong>([\s\S]*?)<\/p>/g)) {
    const outcome = OUTCOME_HEADINGS[paragraph[1].trim()];
    if (!outcome) continue;
    const conditions = Array.from(
      paragraph[2].matchAll(/@UUID\[Compendium\.pf2e\.conditionitems\.Item\.[^\]]+\]\{([^}]+)\}/g)
    ).map((tag) => {
      const label = tag[1].trim();
      const withValue = /^(.+?)\s+(\d+)$/.exec(label);
      const name = withValue ? withValue[1] : label;
      const value = withValue ? Number(withValue[2]) : null;
      const slug = name.toLowerCase().replace(/[^a-z]+/g, '-').replace(/(^-|-$)/g, '');
      return { slug, value };
    });
    if (conditions.length) byOutcome[outcome] = conditions;
  }
  return byOutcome;
}

/**
 * False once a limited-use spell has been exhausted for the day — confirmed
 * live this is a real gap none of #118-122 checked: `entry.cast()`
 * decrements `spell.system.location.uses` on a successful cast but does
 * NOT refuse or error once it hits 0, so without this check an
 * agent-controlled NPC could keep "casting" an exhausted spell every turn.
 * A spell with no `location.uses` at all (most non-innate casting, or a
 * cantrip) is always available. A spell whose name ends in `(At will)` or
 * `(Constant)` — the bestiary's own naming convention for genuinely
 * unlimited spells — is also always available: confirmed live these carry
 * the exact same `uses` shape and decrement identically, never refilling,
 * so checking `uses` for them would wrongly disable a spell meant to be
 * castable indefinitely.
 */
export function hasSpellUsesRemaining(spell) {
  if (/\((at will|constant)\)$/i.test(spell.name ?? '')) return true;
  const uses = spell.system?.location?.uses;
  if (!uses) return true;
  return uses.value > 0;
}

/**
 * The mechanical effect of a non-spell NPC action (a breath weapon, for
 * #123's v1 scope), extracted from its raw description text — unlike a
 * spell, an action item has no structured system.damage/defense/area
 * fields at all; everything lives in inline text enrichers. Confirmed live
 * across four real dragon breath weapons that `@Damage[NdM[type]]` +
 * `@Template[cone|distance:N]` + `@Check[save|dc:N|basic]` is a consistent
 * pattern. `null` when any of the three enrichers is missing, or when the
 * save isn't tagged `|basic` — a handful of sampled breath weapons use a
 * non-basic save with its own bespoke per-outcome text (matching #121's
 * discovery that condition/effect text isn't uniformly structured), which
 * v1 doesn't attempt to parse; only the well-understood basic-save halving/
 * doubling rule is handled here. The optional trailing
 * `[[/gmr NdM #Recharge ...]]` roll becomes `rechargeFormula`, or `null`
 * when the ability has no recharge text at all.
 */
export function parseBreathWeaponEffect(descriptionHtml) {
  const damageMatch = /@Damage\[(\d+d\d+)\[(\w+)\]/.exec(descriptionHtml);
  const templateMatch = /@Template\[(\w+)\|distance:(\d+)\]/.exec(descriptionHtml);
  const checkMatch = /@Check\[(\w+)\|dc:(\d+)\|basic\b/.exec(descriptionHtml);
  if (!damageMatch || !templateMatch || !checkMatch) return null;
  const rechargeMatch = /\[\[\/gmr (\d+d\d+) #Recharge/.exec(descriptionHtml);
  return {
    damageFormula: damageMatch[1],
    damageType: damageMatch[2],
    areaType: templateMatch[1],
    distanceFeet: Number(templateMatch[2]),
    save: checkMatch[1],
    dc: Number(checkMatch[2]),
    rechargeFormula: rechargeMatch ? rechargeMatch[1] : null,
  };
}

/**
 * One candidate per ready breath weapon, centered at whichever
 * caller-precomputed placement catches the most opponents — same
 * best-placement selection as buildAreaSpellCandidates, but for a plain
 * action item (`itemId`, no spellcasting entry involved) carrying its own
 * parsed damage formula/type and save/DC through to execution instead of
 * a spell's save/basic pair.
 */
export function buildBreathWeaponCandidates({ readyBreathWeapons, actionsRemaining }) {
  const candidates = [];
  for (const ability of readyBreathWeapons) {
    if (ability.cost > actionsRemaining) continue;
    const best = ability.placements
      .filter((p) => p.affected.length > 0)
      .reduce((a, b) => (!a || b.affected.length > a.affected.length ? b : a), null);
    if (!best) continue;
    const idSuffix = best.centerId ? `:${best.centerId}` : '';
    candidates.push({
      id: `breathWeapon:${ability.slug}:${best.centerType}${idSuffix}`, type: 'breathWeapon',
      itemId: ability.itemId, cost: ability.cost,
      damageFormula: ability.damageFormula, damageType: ability.damageType,
      save: ability.save, dc: ability.dc, rechargeFormula: ability.rechargeFormula ?? null,
      centerType: best.centerType, centerId: best.centerId,
      affectedIds: best.affected.map((o) => o.id),
      summary: `${ability.label} (hits ${best.affected.map((o) => o.name).join(', ')})`
    });
  }
  return candidates;
}

const MULTI_STRIKE_WORD_NUMBERS = { one: 1, two: 2, three: 3, four: 4, five: 5 };

/**
 * The named-Strike breakdown of a multi-strike bundle ability (Draconic
 * Frenzy-shaped: a `type: "action"` item with a fixed `system.actions.value`
 * and pure prose naming which of the actor's own Strikes it bundles, e.g.
 * "The dragon makes two claw Strikes and one tail Strike in any order.") —
 * confirmed live across 16+ real dragon bestiary actors that there is no
 * structured field for this at all, only this "N <name> Strike(s) ... in
 * any order" prose shape. Written as a general pattern (not hardcoded to
 * Draconic Frenzy specifically); a real observed phrasing quirk uses a
 * plural noun as the strike name ("one horns Strike"), left as-is here —
 * fuzzy-matching that name against the actor's real Strike slugs is
 * dungeon-combat.mjs's job, not this pure parser's. Requires "in any
 * order" to appear at all (guards against unrelated prose that happens to
 * mention "Strike"); returns `null` when that guard fails or no "N <name>
 * Strike(s)" clause is found.
 */
export function parseMultiStrikeBundle(descriptionHtml) {
  if (!/in any order/i.test(descriptionHtml)) return null;
  const strikeRegex = /\b(one|two|three|four|five|\d+)\s+([a-z][a-z\s]*?)\s+Strikes?\b/gi;
  const strikes = [];
  let match;
  while ((match = strikeRegex.exec(descriptionHtml))) {
    const countToken = match[1].toLowerCase();
    const count = MULTI_STRIKE_WORD_NUMBERS[countToken] ?? Number(countToken);
    const name = match[2].trim().toLowerCase();
    if (!count || !name) continue;
    strikes.push({ count, name });
  }
  return strikes.length ? strikes : null;
}

/**
 * One candidate per ready multi-strike bundle x each opponent within the
 * bundle's own reach (the caller resolves `strikes` to the actor's real
 * matched Strike slugs and computes `reachSquares` as the minimum reach
 * among them — see dungeon-combat.mjs — since every bundle strike found in
 * practice targets a single opponent, "in any order," not separate ones).
 * `mapIncrement` isn't threaded through here: it's resolved fresh at
 * execution time (dungeon-combat.mjs), same as a plain strike candidate's
 * own variant resolution.
 */
export function buildMultiStrikeCandidates({ readyMultiStrikeBundles, opponents, actionsRemaining }) {
  const candidates = [];
  for (const bundle of readyMultiStrikeBundles) {
    if (bundle.cost > actionsRemaining) continue;
    for (const opponent of opponents) {
      if (opponent.distanceSquares > bundle.reachSquares) continue;
      candidates.push({
        id: `multiStrike:${bundle.slug}:${opponent.id}`, type: 'multiStrike',
        itemId: bundle.itemId, targetId: opponent.id, cost: bundle.cost,
        strikes: bundle.strikes,
        summary: `${bundle.label} vs ${opponent.name}`
      });
    }
  }
  return candidates;
}

/**
 * One candidate per ready single-target, save-based debuff/condition spell
 * x each opponent within range — same shape as buildSpellCandidates, with
 * `save` (which statistic the target rolls) but no `basic` (there's no
 * damage to halve) and `conditionsByOutcome` carried through so
 * dungeon-combat.mjs's castDebuffSpellAndApplyCondition can apply whichever
 * conditions match the save's actual outcome without re-parsing anything.
 */
export function buildDebuffSpellCandidates({ readyDebuffSpells, opponents, actionsRemaining }) {
  const candidates = [];
  for (const spell of readyDebuffSpells) {
    if (spell.cost > actionsRemaining) continue;
    for (const opponent of opponents) {
      if (opponent.distanceSquares > spell.rangeSquares) continue;
      candidates.push({
        id: `castDebuff:${spell.slug}:${opponent.id}`, type: 'castDebuff',
        spellId: spell.id, entryId: spell.entryId, targetId: opponent.id, cost: spell.cost,
        save: spell.save, conditionsByOutcome: spell.conditionsByOutcome,
        summary: `${spell.label} vs ${opponent.name}`
      });
    }
  }
  return candidates;
}

/**
 * The hop distance (in feet) a chained spell like Chain Lightning arcs
 * between successive targets, parsed from its raw description text —
 * confirmed live this is the only spell in the SRD with this "1 creature,
 * plus any number of additional creatures" target shape, and its own hop
 * distance isn't encoded in any structured `system` field, only prose
 * ("arcs to another creature within 30 feet of the first target, jumps to
 * another creature within 30 feet of that target, and so on"). Written as
 * a general pattern match (not hardcoded to Chain Lightning specifically)
 * in case similar future content shares the phrasing; `null` when no such
 * phrase is found at all.
 */
export function parseChainHopDistance(descriptionHtml) {
  const match = /(?:arcs?|jumps?|chains?) to another creature within (\d+) feet/i.exec(descriptionHtml);
  return match ? Number(match[1]) : null;
}

/** One greedy walk from `startId`, always hopping to the *nearest*
 * not-yet-visited neighbor in `chainGraph` (opponent-to-opponent distances
 * only — allies are never included in `chainGraph` at all, see
 * dungeon-combat.mjs, so they're never a valid hop target), stopping once
 * no unvisited neighbor remains within hop range. Returns the ordered list
 * of ids visited, starting with `startId` itself. */
function buildGreedyChain(startId, chainGraph) {
  const visited = new Set([startId]);
  const chain = [startId];
  let current = startId;
  for (;;) {
    const candidates = (chainGraph[current] ?? []).filter((o) => !visited.has(o.id));
    if (!candidates.length) break;
    const nearest = candidates.reduce((a, b) => (b.distanceSquares < a.distanceSquares ? b : a));
    visited.add(nearest.id);
    chain.push(nearest.id);
    current = nearest.id;
  }
  return chain;
}

/**
 * One candidate per ready chained spell (Chain Lightning-shaped: a primary
 * target plus a greedily-extended chain of further targets), trying every
 * in-range opponent as the primary target and keeping whichever one
 * produces the longest resulting chain. `chainGraph` (opponent-to-opponent
 * hop adjacency, precomputed by the caller from real token geometry) never
 * includes allies, so the chain never hops into one — the agreed
 * ally-avoidance approach for #127 is simply "allies are never valid hop
 * targets," not a scored trade-off the way #126's area-spell placement is.
 * Damage isn't rolled once and shared across the chain the way Chain
 * Lightning's own rules text describes — confirmed live that reconstructing
 * a shared roll for independent per-target outcome scaling silently drops
 * IWR (resistance/weakness) handling — so dungeon-combat.mjs's execution
 * rolls damage independently per target instead, reusing #119's already-
 * proven per-target `spell.rollDamage()` mechanism; a small, disclosed
 * deviation from strict rules text in favor of correctness.
 */
export function buildChainSpellCandidates({ readyChainSpells, opponents, actionsRemaining }) {
  const candidates = [];
  for (const spell of readyChainSpells) {
    if (spell.cost > actionsRemaining) continue;
    const validPrimaries = opponents.filter((o) => o.distanceSquares <= spell.rangeSquares);
    if (!validPrimaries.length) continue;
    let best = null;
    for (const primary of validPrimaries) {
      const chain = buildGreedyChain(primary.id, spell.chainGraph);
      if (!best || chain.length > best.chain.length) best = { primary, chain };
    }
    const chainedIds = best.chain.slice(1);
    const names = best.chain.map(
      (id) => opponents.find((o) => o.id === id)?.name ?? id,
    );
    candidates.push({
      id: `castChain:${spell.slug}:${best.primary.id}`, type: 'castChain',
      spellId: spell.id, entryId: spell.entryId, cost: spell.cost,
      save: spell.save, basic: spell.basic,
      targetId: best.primary.id, chainedIds,
      summary: `${spell.label} vs ${names.join(', ')}`
    });
  }
  return candidates;
}

/**
 * One candidate per ready heal spell x each injured ally within range —
 * same shape as buildSpellCandidates (#118's single-target spells), but
 * targeting `allies` instead of `opponents` and never offering a candidate
 * for an ally already at full HP (healing them would be a wasted action —
 * confirmed live this needs `ally.hp`/`ally.maxHp`, not just an id/name).
 * No `save`/`basic` here: confirmed live a healing-trait spell's damage
 * roll applies unconditionally (no save, no outcome-based scaling) when
 * targeting a willing living creature — see dungeon-combat.mjs's
 * castHealSpellAndApply.
 */
export function buildHealSpellCandidates({ readyHealSpells, allies, actionsRemaining }) {
  const candidates = [];
  for (const spell of readyHealSpells) {
    if (spell.cost > actionsRemaining) continue;
    for (const ally of allies) {
      if (ally.distanceSquares > spell.rangeSquares) continue;
      if (ally.hp >= ally.maxHp) continue;
      candidates.push({
        id: `castHeal:${spell.slug}:${ally.id}`, type: 'castHeal',
        spellId: spell.id, entryId: spell.entryId, targetId: ally.id, cost: spell.cost,
        summary: `${spell.label} on ${ally.name}`
      });
    }
  }
  return candidates;
}

/**
 * The linked "Spell Effect" compendium item a buff spell (#170) actually
 * applies, parsed from its own description — confirmed live that
 * `entry.cast()` alone does NOT create this on the target (the same
 * "cast() only announces, never applies" pattern #118's own damage roll
 * and #121's condition application already need a separate step for);
 * dungeon-combat.mjs's `castBuffSpellAndApply` fetches this UUID via
 * `fromUuid()` and applies it directly via
 * `target.actor.createEmbeddedDocuments`. Every buff spell sampled during
 * research (Mountain Resilience, Blessing of Defiance, Infuse Vitality)
 * carries exactly one `@UUID[Compendium.pf2e.spell-effects.Item.ID]{...}`
 * tag; `null` when none is found (or it's from an unrelated compendium —
 * `pf2e.conditionitems`, say, which #121's debuff path already owns).
 */
export function parseSpellEffectUuid(descriptionHtml) {
  const match = /@UUID\[(Compendium\.pf2e\.spell-effects\.Item\.[^\]]+)\]\{[^}]*\}/.exec(
    descriptionHtml,
  );
  return match ? match[1] : null;
}

/**
 * The weapon-name restriction on a Reactive Strike/Attack of Opportunity
 * item's own name (#202), e.g. "Attack of Opportunity (Jaws Only)" ->
 * "jaws", "Reactive Strike (Tail Only)" -> "tail" — confirmed live across
 * real bestiary dragons this "(X Only)" suffix is how a multi-weapon
 * creature's reaction is restricted to a specific Strike. Returns `null`
 * for a plain, unrestricted name, or a non-weapon qualifier like
 * "(Special)" (Vrock/Balor-shaped — describes an *additional* trigger,
 * not a weapon restriction; #202's own v1 scope, the ranged-Strike
 * trigger only, never needs to parse that shape at all, since the
 * reactor just uses its normal reaction either way for that trigger).
 */
export function parseReactiveStrikeWeaponRestriction(itemName) {
  const match = /\(([a-z][a-z\s]*?)\s+only\)\s*$/i.exec(itemName ?? '');
  return match ? match[1].trim().toLowerCase() : null;
}

/**
 * One candidate per ready single-target buff spell x each ally within
 * range — same shape as `buildHealSpellCandidates`, minus its full-HP
 * exclusion (a buff applies regardless of current HP; there's no
 * equivalent "already at max" signal to check for a status effect without
 * inspecting the target's own current effects, deliberately out of scope
 * for v1 — an agent re-buffing an already-buffed ally is a minor
 * inefficiency, not a correctness bug).
 */
export function buildBuffSpellCandidates({ readyBuffSpells, allies, actionsRemaining }) {
  const candidates = [];
  for (const spell of readyBuffSpells) {
    if (spell.cost > actionsRemaining) continue;
    for (const ally of allies) {
      if (ally.distanceSquares > spell.rangeSquares) continue;
      candidates.push({
        id: `castBuff:${spell.slug}:${ally.id}`, type: 'castBuff',
        spellId: spell.id, entryId: spell.entryId, targetId: ally.id, cost: spell.cost,
        summary: `${spell.label} on ${ally.name}`
      });
    }
  }
  return candidates;
}

/** Always available — lets the agent stop spending actions early. */
export function endTurnCandidate() {
  return { id: 'endTurn', type: 'endTurn', cost: 0, summary: 'End turn' };
}

/** Full candidate list for one decision iteration. */
export function buildCandidateList({ opponents, readyActions, readySpells = [], readyAreaSpells = [], readyAttackSpells = [], readyDebuffSpells = [], readyBreathWeapons = [], readyMultiStrikeBundles = [], readyChainSpells = [], readyHealSpells = [], readyBuffSpells = [], readyTierScalingAreaSpells = [], readyDualNatureSpells = [], readyTargetCountSpells = [], readyAutoHitAreaSpells = [], allies = [], turnState, hazard = null, hasRangedOrReach = false }) {
  if (turnState.actionsRemaining <= 0) return [endTurnCandidate()];
  return [
    ...buildMovementCandidates({ opponents, hazard, hasRangedOrReach }),
    ...buildStrikeCandidates({ readyActions, opponents, mapIncrement: turnState.mapIncrement }),
    ...buildSpellCandidates({ readySpells, opponents, actionsRemaining: turnState.actionsRemaining }),
    ...buildAreaSpellCandidates({ readyAreaSpells, actionsRemaining: turnState.actionsRemaining }),
    ...buildAttackSpellCandidates({ readyAttackSpells, opponents, actionsRemaining: turnState.actionsRemaining }),
    ...buildDebuffSpellCandidates({ readyDebuffSpells, opponents, actionsRemaining: turnState.actionsRemaining }),
    ...buildBreathWeaponCandidates({ readyBreathWeapons, actionsRemaining: turnState.actionsRemaining }),
    ...buildMultiStrikeCandidates({ readyMultiStrikeBundles, opponents, actionsRemaining: turnState.actionsRemaining }),
    ...buildChainSpellCandidates({ readyChainSpells, opponents, actionsRemaining: turnState.actionsRemaining }),
    ...buildHealSpellCandidates({ readyHealSpells, allies, actionsRemaining: turnState.actionsRemaining }),
    ...buildBuffSpellCandidates({ readyBuffSpells, allies, actionsRemaining: turnState.actionsRemaining }),
    ...buildTierScalingAreaSpellCandidates({ readyTierScalingAreaSpells, actionsRemaining: turnState.actionsRemaining }),
    ...buildDualNatureSpellCandidates({ readyDualNatureSpells, actionsRemaining: turnState.actionsRemaining }),
    ...buildTargetCountSpellCandidates({ readyTargetCountSpells, actionsRemaining: turnState.actionsRemaining }),
    ...buildAutoHitAreaSpellCandidates({ readyAutoHitAreaSpells, actionsRemaining: turnState.actionsRemaining }),
    endTurnCandidate()
  ];
}

/** New turn state after applying `candidate` — a pure transition, no side effects. */
export function applyCandidateToTurnState(turnState, candidate) {
  if (candidate.type === 'endTurn') return { ...turnState, actionsRemaining: 0 };
  let mapIncrement = turnState.mapIncrement;
  if (candidate.type === 'strike') mapIncrement += 1;
  else if (candidate.type === 'multiStrike') {
    mapIncrement += candidate.strikes.reduce((sum, s) => sum + s.count, 0);
  }
  return { actionsRemaining: turnState.actionsRemaining - candidate.cost, mapIncrement };
}

/** The JSON context handed to a decision provider alongside its candidates
 * — candidates are trimmed to `{id, summary}` since a provider only ever
 * needs to pick an id, never the caller-side execution details. */
export function buildDecisionContext({ self, opponents, allies = [], candidates, roundNumber }) {
  return { self, opponents, allies, candidates: candidates.map(({ id, summary }) => ({ id, summary })), roundNumber };
}
