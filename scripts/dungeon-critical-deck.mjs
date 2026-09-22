/**
 * PF2e's own `pf2e.criticaldeck` compendium (#28): a real Foundry
 * `JournalEntry` pack of 106 documents -- 53 "Critical Hit Deck #<n>", 53
 * "Critical Fumble Deck #<n>" -- each carrying one page whose
 * `pages[0].text.content` is HTML bundling ~4 sub-entries
 * (`<h1>name</h1><blockquote>effect html</blockquote><p><code>category</code></p>`).
 * On a Strike or spell-attack roll's crit/fumble, dungeon-combat.mjs's three
 * outcome-branching call sites draw one sub-entry at random from the
 * matching deck/category, auto-apply whichever of its directives parse
 * cleanly, and post the full card text to chat regardless -- so the GM can
 * hand-adjudicate anything left unparsed.
 *
 * Split pure/impure the same way dungeon-sound.mjs does: `parseDeckEntry`
 * and `pickSubentry` are pure and unit-testable against real fixture HTML
 * (no live Foundry needed); `drawAndApplyCriticalCard` is the one impure
 * orchestrator that touches `game.packs`, `Roll`, `fromUuid`, actor
 * mutators, and `ChatMessage.create`.
 *
 * Directive scope (see #50 for what's deliberately NOT covered here):
 *   - `@Damage[<formula>]` -- rolled and applied one of two ways depending
 *     on whether the formula carries a `[persistent,...]` bracket tag
 *     (confirmed live on Combustion/Corrosive, `1d6[persistent,fire]` /
 *     `1d6[persistent,acid]`): a *non*-persistent formula is rolled via
 *     plain `Roll` (same pattern `setAbilityRecharge` already uses) and
 *     applied via `actor.applyDamage({damage: total, token})`; a
 *     *persistent*-tagged formula is instead rolled via a real `DamageRoll`
 *     (`CONFIG.Dice.rolls.find((c) => c.name === "DamageRoll")`, same
 *     lookup `dungeon-combat.mjs`'s area-spell helpers already use) and
 *     applied with the full roll object (`applyDamage({damage: roll,
 *     token})`, not `roll.total`) -- per #36's research, PF2e's own
 *     `applyDamage` only auto-creates the `persistent-damage` condition when
 *     handed the real IWR-processed roll, not a bare number, so a plain
 *     `Roll`+total here silently collapsed persistent damage into ordinary
 *     instant damage (#50).
 *   - `@UUID[Compendium.pf2e.conditionitems.Item.<Name>]` (braced label with
 *     a trailing number, or bare) -- a condition, applied via
 *     `actor.increaseCondition(slug, ...)`. Slug convention matches
 *     `parseConditionsByOutcome` in agent-candidates.mjs exactly:
 *     `name.toLowerCase().replace(/[^a-z]+/g, '-').replace(/(^-|-$)/g, '')`.
 *   - `@UUID[Compendium.pf2e.other-effects.Item.<Name>]{...}` -- an
 *     arbitrary Effect item, applied via the exact `fromUuid` ->
 *     `.toObject()` -> `createEmbeddedDocuments("Item", [...])` pattern
 *     `castBuffSpellAndApply` already uses.
 *   - `@Localize[PF2E.PersistentDamage.<Type><N>.<outcome>]` (#50) -- a flat,
 *     no-roll persistent-damage shorthand (all 6 real occurrences use
 *     `Bleed1.success`, i.e. "1 persistent bleed damage", but parsed
 *     generically rather than hardcoded to that one key). The `.<outcome>`
 *     suffix is inert -- PF2e's own localization-key naming convention for
 *     save-outcome text variants of the same static effect, not something
 *     to branch on here. Applied via the same `DamageRoll` path as a
 *     persistent-tagged `@Damage`, built from a flat non-dice formula
 *     (`"(<N>)[persistent,<type>]"`, the analogous shape to the flat
 *     `"(20)[force]"` formula `castAutoHitAreaSpellAndApplyDamage` already
 *     uses for a fixed non-dice amount). A `@Localize` key that doesn't
 *     match this shape is never auto-applied -- flavor text only, same as
 *     any other unrecognized directive.
 *   - Any other `@UUID[...]` (spells-srd, actionspf2e, ...), `@Check[...]`,
 *     and bare prose with no directive at all are never auto-applied --
 *     flavor text only.
 *   - Weapon/item HP damage ("Your weapon takes...", "the weapon's current
 *     Hit Points are reduced to its Broken Threshold...") is resolved to
 *     `target: "weapon"` and applied to the attacker's actual strike weapon
 *     item (#60) -- a direct `system.hp.value` write, ignoring hardness per
 *     the card text, never an actor's HP. The "reduced to its Broken
 *     Threshold, then real damage once already broken" two-stage cards are
 *     handled as a separate, prose-pattern-matched `weaponBrokenThreshold`
 *     directive rather than through the generic per-directive walk -- see
 *     `extractWeaponBrokenThreshold`'s own docblock for why. A condition
 *     directed at a weapon is still always a no-op: items don't take actor
 *     conditions in this codebase's model.
 *
 * Subject detection walks back from each directive to the start of its
 * *sentence* (the text since the last `.`), then takes the right-most
 * subject-phrase match in that window -- not just a sentence-initial check
 * -- because one sentence can carry several directives sharing one subject
 * clause (confirmed live against critical-hit-deck-40's "Sliced Hand": two
 * conditions, one "the target is" clause). "your weapon"/"the weapon"/
 * "your item"/"the item" always wins over a bare "you"/"your" match
 * regardless of position, not just at the same or an earlier one -- see
 * `detectSubject`'s own docblock for the real card (#60's "Cracked") this
 * matters for. No match in the window at all -- an ambiguous or
 * third-party subject like "an ally" -- always skips, never guesses.
 *
 * A skipped directive does NOT cancel its sub-entry: whichever other
 * directives on that same sub-entry parse cleanly still apply, and the
 * full, unmodified effect HTML is always posted to chat either way.
 */

const CONDITION_UUID_PREFIX = "Compendium.pf2e.conditionitems.Item.";
const EFFECT_UUID_PREFIX = "Compendium.pf2e.other-effects.Item.";

const ENTRY_RE =
  /<h1>([\s\S]*?)<\/h1>\s*<blockquote>([\s\S]*?)<\/blockquote>\s*<p>\s*<code>([\s\S]*?)<\/code>\s*<\/p>/g;

const DIRECTIVE_RE = /@(\w+)\[((?:[^[\]]|\[[^[\]]*\])*)\](?:\{([^}]*)\})?/g;

// Rightmost match wins -- ordered most- to least-specific so "your weapon"
// is preferred over the bare "your" it also contains. "the ranged weapon"
// covers critical-fumble-deck-22's "Cracked" ("The ranged weapon (not the
// ammunition) you are using takes..."), which doesn't match the shorter
// "the weapon" phrase at all and, before #60, wrongly fell through to the
// bare "you" match a few words later (a real latent bug: it self-damaged
// the attacker's own creature HP on a fumble instead of the weapon).
const SUBJECT_RE =
  /\b(your weapon|the ranged weapon|the weapon|your item|the item|the target|your target|you|your)\b/gi;

function stripTags(html) {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** The right-most subject-phrase match in `window` (the text since the
 * start of the directive's own sentence), classified into who an
 * auto-applicable directive should target -- `"weapon"` (#60) for the
 * attacker's own weapon/item, or `"skip"` when nothing matches (ambiguous/
 * third-party subject).
 *
 * A weapon/item phrase wins regardless of its position, not just when it's
 * the right-most match: critical-fumble-deck-22's "Cracked" ("The ranged
 * weapon (not the ammunition) you are using takes...") has its weapon
 * phrase early in the sentence, followed by a trailing "you" a few words
 * later (from "you are using") that would otherwise be the right-most
 * match. Plain "rightmost wins" would pick "you" and misclassify this as
 * self-directed -- a real bug this fix corrects (#60), confirmed live: it
 * previously dealt the card's damage to the attacker's own creature HP
 * instead of the weapon. */
function detectSubject(window) {
  let lastPhrase = null;
  let lastWeaponPhrase = null;
  SUBJECT_RE.lastIndex = 0;
  let match;
  while ((match = SUBJECT_RE.exec(window))) {
    const phrase = match[1].toLowerCase();
    lastPhrase = phrase;
    if (phrase.includes("weapon") || phrase.includes("item")) {
      lastWeaponPhrase = phrase;
    }
  }
  if (lastWeaponPhrase) return "weapon";
  if (!lastPhrase) return "skip";
  if (lastPhrase.includes("target")) return "target";
  return "self";
}

/** Same slug convention as `parseConditionsByOutcome` in
 * agent-candidates.mjs (~line 537) -- matched exactly rather than invented
 * fresh, so a condition parsed off a crit-deck card slugs identically to
 * one parsed off a spell description. */
function slugifyConditionName(name) {
  return name
    .toLowerCase()
    .replace(/[^a-z]+/g, "-")
    .replace(/(^-|-$)/g, "");
}

/** A condition's `{name, value}` from either its braced label ("Sickened
 * 3" -> name "Sickened", value 3; "Fatigued" -> value null) or, when there's
 * no braces at all, the bare Item name off the UUID path itself. */
function parseConditionNameAndValue(uuidTail, brace) {
  const label = brace != null ? brace.trim() : uuidTail;
  const withValue = /^(.+?)\s+(\d+)$/.exec(label);
  if (withValue) return { name: withValue[1], value: Number(withValue[2]) };
  return { name: label, value: null };
}

// Matches PF2e's own recurring fumble-card sentence: "Your weapon's current
// Hit Point(s) are reduced to its Broken Threshold. If already [broken /
// @UUID[...Broken]], the weapon takes @Damage[<formula>] damage, ignoring
// Hardness." (#60) Deliberately prose-pattern-based, not directive-based --
// one of the three real cards using this shape ("Broken Haft",
// critical-fumble-deck-50) has no @UUID marker for the "already broken"
// check at all, just bare prose, so a design keying off parsing that
// directive would miss it. `hit points?` tolerates PF2e's own compendium
// typo ("Hit Point" singular on critical-fumble-deck-15) alongside the
// grammatically-correct plural on the other two real cards.
const BROKEN_THRESHOLD_RE =
  /[\s\S]*?current hit points? are reduced to its broken threshold[\s\S]*?@Damage\[\s*([^\]]+?)\s*\]/i;

/**
 * Detects the broken-threshold sentence anywhere in `effectHtml` and, if
 * found, returns the damage formula used for its "already broken" branch
 * plus `effectHtml` with that entire matched span removed -- so the normal
 * per-directive extraction below never independently re-processes the
 * @UUID[...Broken]/@Damage[...] markers embedded inside it, which would
 * otherwise double-apply, or apply the flat damage unconditionally instead
 * of only when the weapon is already broken (the actual runtime check
 * lives in applyDirective's own weaponBrokenThreshold branch, against the
 * live item's hp vs. brokenThreshold). Returns null if the sentence isn't
 * present, leaving the rest of extraction completely unchanged.
 */
function extractWeaponBrokenThreshold(effectHtml) {
  const match = BROKEN_THRESHOLD_RE.exec(effectHtml);
  if (!match) return null;
  return {
    formula: match[1].trim(),
    strippedHtml:
      effectHtml.slice(0, match.index) +
      effectHtml.slice(match.index + match[0].length),
  };
}

function findSentenceStart(text, endIndex) {
  const lastPeriod = text.lastIndexOf(".", endIndex - 1);
  return lastPeriod === -1 ? 0 : lastPeriod + 1;
}

// `PF2E.PersistentDamage.<Type><N>.<outcome>` -- e.g. "Bleed1.success" is
// type "bleed", flat value 1. The `.<outcome>` suffix is PF2e's own
// localization-key convention for which save-outcome text variant this is;
// it's always describing the same numeric effect on this static,
// pre-resolved deck text, so it's matched but never branched on.
const LOCALIZE_PERSISTENT_DAMAGE_RE =
  /^PF2E\.PersistentDamage\.([A-Za-z]+)(\d+)\.\w+$/;

/** True when a `@Damage[...]` formula carries a `[persistent,...]` bracket
 * tag anywhere in it (e.g. `"1d6[persistent,fire]"`) -- the formulas PF2e's
 * own `applyDamage` needs a real `DamageRoll` object (not a bare number) to
 * correctly recognize and auto-create the `persistent-damage` condition
 * for (#50). */
function isPersistentFormula(formula) {
  return /\[[^[\]]*\bpersistent\b[^[\]]*\]/.test(formula);
}

function buildDirective(keyword, bracketContent, brace, window, raw) {
  if (keyword === "Damage") {
    const subject = detectSubject(window);
    if (subject === "skip") return { type: "skip", raw, reason: "subject" };
    return { type: "damage", formula: bracketContent.trim(), target: subject };
  }

  if (keyword === "UUID") {
    const uuid = bracketContent.trim();

    if (uuid.startsWith(CONDITION_UUID_PREFIX)) {
      const subject = detectSubject(window);
      if (subject === "skip") return { type: "skip", raw, reason: "subject" };
      const tail = uuid.slice(CONDITION_UUID_PREFIX.length);
      const { name, value } = parseConditionNameAndValue(tail, brace);
      return {
        type: "condition",
        slug: slugifyConditionName(name),
        value,
        target: subject,
      };
    }

    if (uuid.startsWith(EFFECT_UUID_PREFIX)) {
      const subject = detectSubject(window);
      if (subject === "skip") return { type: "skip", raw, reason: "subject" };
      return {
        type: "effect",
        uuid,
        label: brace != null ? brace.trim() : null,
        target: subject,
      };
    }

    // Any other compendium (spells-srd, actionspf2e, ...) is never
    // auto-applied, regardless of subject.
    return { type: "skip", raw, reason: "other-uuid" };
  }

  if (keyword === "Localize") {
    const key = bracketContent.trim();
    const match = LOCALIZE_PERSISTENT_DAMAGE_RE.exec(key);
    if (!match) return { type: "skip", raw, reason: "localize" };

    const subject = detectSubject(window);
    if (subject === "skip") return { type: "skip", raw, reason: "subject" };
    return {
      type: "persistentDamage",
      damageType: match[1].toLowerCase(),
      value: Number(match[2]),
      target: subject,
    };
  }

  // @Check, @Template, or anything else this format grows later.
  return { type: "skip", raw, reason: "unsupported" };
}

/** Walks `effectHtml` left to right and returns every directive found, in
 * order -- `{type: 'damage'|'condition'|'effect'|'skip', ...}`. Pure: takes
 * only the sub-entry's own effect HTML, no live Foundry dependency. */
export function extractDirectives(effectHtml) {
  // #60: the broken-threshold sentence, when present, is stripped out
  // before the normal walk below ever sees it -- its embedded
  // @UUID[...Broken]/@Damage[...] markers (present on 2 of the 3 real
  // cards using this shape) must not also be independently extracted as
  // ordinary condition/damage directives.
  const brokenThreshold = extractWeaponBrokenThreshold(effectHtml);
  const html = brokenThreshold ? brokenThreshold.strippedHtml : effectHtml;
  const leadingDirectives = brokenThreshold
    ? [
        {
          type: "weaponBrokenThreshold",
          formula: brokenThreshold.formula,
          target: "weapon",
        },
      ]
    : [];

  const plain = stripTags(html);
  const matches = Array.from(
    plain.matchAll(new RegExp(DIRECTIVE_RE.source, "g")),
  );
  if (!matches.length) return leadingDirectives;

  // Sentence-boundary detection must ignore periods that are part of a
  // directive's own text -- a Compendium UUID path is full of them (e.g.
  // "Compendium.pf2e.conditionitems.Item.Enfeebled") -- confirmed against
  // critical-hit-deck-40's "Sliced Hand", where a second condition sharing
  // an earlier directive's "the target is" clause was wrongly treated as
  // its own sentence starting mid-UUID. Mask every directive span's
  // periods before scanning for sentence starts; the masked copy stays
  // the same length so `match.index` positions still line up, and the
  // (unmasked) `plain` text is still what each subject window is sliced
  // from.
  let masked = plain;
  for (const m of matches) {
    const maskedSpan = m[0].replace(/\./g, " ");
    masked =
      masked.slice(0, m.index) +
      maskedSpan +
      masked.slice(m.index + m[0].length);
  }

  return [
    ...leadingDirectives,
    ...matches.map((match) => {
      const [raw, keyword, bracketContent, brace] = match;
      const sentenceStart = findSentenceStart(masked, match.index);
      const window = plain.slice(sentenceStart, match.index);
      return buildDirective(keyword, bracketContent, brace, window, raw);
    }),
  ];
}

/** Parses one deck document's page HTML into its sub-entries --
 * `{name, category, effectHtml, directives}` -- in document order. Not
 * always exactly 4 per card, per #28's own confirmed-live sample data.
 * Pure. */
export function parseDeckEntry(html) {
  const entries = [];
  const re = new RegExp(ENTRY_RE);
  let match;
  while ((match = re.exec(html))) {
    const [, nameHtml, effectHtml, categoryHtml] = match;
    entries.push({
      name: stripTags(nameHtml),
      category: stripTags(categoryHtml),
      effectHtml: effectHtml.trim(),
      directives: extractDirectives(effectHtml),
    });
  }
  return entries;
}

/** Picks one sub-entry uniformly at random from `subentries` matching
 * `category` -- or, defensively, uniformly across every sub-entry
 * regardless of category if none match (shouldn't happen given #28's fixed
 * category sets, but a card format change shouldn't hard-fail a draw).
 * `rng` is injectable for deterministic tests, same convention
 * trap-library.mjs/encounter-roster.mjs already use. */
export function pickSubentry(subentries, category, rng = Math.random) {
  if (!subentries?.length) return null;
  const matching = subentries.filter((s) => s.category === category);
  const pool = matching.length ? matching : subentries;
  const index = Math.min(Math.floor(rng() * pool.length), pool.length - 1);
  return pool[index];
}

const HIT_DAMAGE_TYPE_CATEGORY = {
  bludgeoning: "Bludgeoning",
  piercing: "Piercing",
  slashing: "Slashing",
};

/** The Hit deck's category for a landed critical -- one of PF2e's three
 * physical damage types Title-Cased, or "Bomb or Spell" for anything else
 * (an energy/other damage type, or no weapon damage type at all -- the
 * spell-attack-roll call site has no `strike`). */
export function hitDeckCategory(damageType) {
  return (
    HIT_DAMAGE_TYPE_CATEGORY[(damageType ?? "").toLowerCase()] ??
    "Bomb or Spell"
  );
}

/** The Fumble deck's category for a fumbled attack roll -- `isRanged` wins
 * over `isUnarmed` (a ranged unarmed strike doesn't exist in PF2e, but if
 * it somehow did, Ranged is still the more specific signal for a fumble
 * deck built around delivery method). Everything else is Melee. */
export function fumbleDeckCategory({
  isRanged = false,
  isUnarmed = false,
} = {}) {
  if (isRanged) return "Ranged";
  if (isUnarmed) return "Unarmed";
  return "Melee";
}

function pageTextContent(doc) {
  const pages = Array.isArray(doc.pages)
    ? doc.pages
    : (doc.pages?.contents ?? []);
  return pages[0]?.text?.content ?? "";
}

/** Applies one already-classified directive and returns a short summary of
 * what happened (or `null` for a skip / a directive whose target actor
 * isn't available). `combatant` is the attacker (self), `target` is who
 * they struck -- either can be the applicable actor, since a Fumble card
 * can still target-direct an effect (confirmed live, critical-fumble-deck-2
 * "Overthink It"). Deliberately does not call `applyDefeatIfReducedToZero`:
 * crit-deck damage is flavor-scale (bleed, minor bludgeoning), not a
 * designed lethal blow, and that helper lives in dungeon-combat.mjs, not
 * here. */
async function applyDirective(directive, { combatant, target, strike }) {
  if (directive.type === "skip") return null;

  // #60: a "weapon" target is always the attacker's own equipment, never
  // an actor -- handled in its own branch, before the generic who/actor
  // resolution below, which would otherwise fall to the `: target` branch
  // (the DEFENDER, since "weapon" !== "self") and misapply the directive
  // to the wrong side, or to the wrong kind of document entirely.
  if (directive.target === "weapon") {
    const item = strike?.item;
    if (!item) return null;

    if (directive.type === "damage") {
      const roll = await new Roll(directive.formula).evaluate();
      const newValue = Math.max(0, (item.system?.hp?.value ?? 0) - roll.total);
      await item.update({ "system.hp.value": newValue });
      return {
        type: "damage",
        formula: directive.formula,
        total: roll.total,
        target: "weapon",
        itemName: item.name,
      };
    }

    if (directive.type === "weaponBrokenThreshold") {
      const value = item.system?.hp?.value ?? 0;
      const brokenThreshold = item.system?.hp?.brokenThreshold ?? 0;
      if (value <= brokenThreshold) {
        const roll = await new Roll(directive.formula).evaluate();
        const newValue = Math.max(0, value - roll.total);
        await item.update({ "system.hp.value": newValue });
        return {
          type: "weaponBrokenThreshold",
          stage: "damage",
          formula: directive.formula,
          total: roll.total,
          itemName: item.name,
        };
      }
      const newValue = Math.min(value, brokenThreshold);
      await item.update({ "system.hp.value": newValue });
      return {
        type: "weaponBrokenThreshold",
        stage: "reduceToThreshold",
        newValue,
        itemName: item.name,
      };
    }

    // A condition (or anything else) directed at a weapon is meaningless
    // in this codebase's model -- items don't take actor conditions.
    return null;
  }

  const who = directive.target === "self" ? combatant : target;
  const actor = who?.actor;
  if (!actor) return null;
  const token = who?.token;

  if (directive.type === "damage") {
    if (isPersistentFormula(directive.formula)) {
      const DamageRollClass = CONFIG.Dice.rolls.find(
        (c) => c.name === "DamageRoll",
      );
      const roll = new DamageRollClass(directive.formula);
      await roll.evaluate();
      await actor.applyDamage({ damage: roll, token });
      return {
        type: "damage",
        formula: directive.formula,
        total: roll.total,
        target: directive.target,
      };
    }
    const roll = await new Roll(directive.formula).evaluate();
    await actor.applyDamage({ damage: roll.total, token });
    return {
      type: "damage",
      formula: directive.formula,
      total: roll.total,
      target: directive.target,
    };
  }

  if (directive.type === "persistentDamage") {
    const DamageRollClass = CONFIG.Dice.rolls.find(
      (c) => c.name === "DamageRoll",
    );
    const formula = `(${directive.value})[persistent,${directive.damageType}]`;
    const roll = new DamageRollClass(formula);
    await roll.evaluate();
    await actor.applyDamage({ damage: roll, token });
    return {
      type: "persistentDamage",
      damageType: directive.damageType,
      value: directive.value,
      total: roll.total,
      target: directive.target,
    };
  }

  if (directive.type === "condition") {
    await actor.increaseCondition(
      directive.slug,
      directive.value != null ? { value: directive.value } : undefined,
    );
    return {
      type: "condition",
      slug: directive.slug,
      value: directive.value,
      target: directive.target,
    };
  }

  if (directive.type === "effect") {
    const effectDoc = await fromUuid(directive.uuid);
    if (!effectDoc) return null;
    await actor.createEmbeddedDocuments("Item", [effectDoc.toObject()]);
    return { type: "effect", name: effectDoc.name, target: directive.target };
  }

  return null;
}

function buildChatContent({ combatant, deckKind, chosen }) {
  const esc = (s) => foundry.utils.escapeHTML?.(String(s)) ?? String(s);
  const deckLabel = deckKind === "hit" ? "Critical Hit" : "Critical Fumble";
  const header = game.i18n.format("PF2EDC.Dungeon.Combat.CriticalDeckChat", {
    name: esc(combatant?.name ?? ""),
    deckLabel,
    cardName: esc(chosen.name),
    category: esc(chosen.category),
  });
  // The effect HTML is posted as-is: it carries the same @Damage/@UUID
  // enricher markup PF2e's own chat log re-enriches on render, same as
  // every other directive-bearing string this module ever hands
  // ChatMessage.create (see castBuffSpellAndApply's sibling chat cards).
  return `${header}${chosen.effectHtml}`;
}

/**
 * Draws one sub-entry from the live `pf2e.criticaldeck` pack's Hit or
 * Fumble deck (`deckKind: 'hit'|'fumble'`), filtered to `category`,
 * auto-applies whichever of its directives resolve cleanly, and posts the
 * full card to chat. `combatant` is the attacker whose Strike/spell-attack
 * just crit or fumbled; `target` is who they rolled against. Returns
 * `{subentry, applied}` or `null` if the pack isn't available or has
 * nothing to draw from -- deliberately a soft no-op rather than throwing,
 * since a missing/renamed compendium shouldn't break the surrounding
 * combat resolution.
 */
export async function drawAndApplyCriticalCard(
  deckKind,
  category,
  { combatant, target, strike } = {},
) {
  const pack = game.packs?.get("pf2e.criticaldeck");
  if (!pack) return null;

  const namePrefix =
    deckKind === "hit" ? "Critical Hit Deck #" : "Critical Fumble Deck #";
  const docs = (await pack.getDocuments?.()) ?? [];
  const deckDocs = docs.filter((doc) =>
    (doc.name ?? "").startsWith(namePrefix),
  );
  const subentries = deckDocs.flatMap((doc) =>
    parseDeckEntry(pageTextContent(doc)),
  );
  if (!subentries.length) return null;

  const chosen = pickSubentry(subentries, category);
  if (!chosen) return null;

  const applied = [];
  for (const directive of chosen.directives) {
    const outcome = await applyDirective(directive, {
      combatant,
      target,
      strike,
    });
    if (outcome) applied.push(outcome);
  }

  await ChatMessage.create({
    content: buildChatContent({ combatant, deckKind, chosen }),
  });

  return { subentry: chosen, applied };
}
