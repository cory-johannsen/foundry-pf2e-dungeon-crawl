/**
 * Turns a resolved abstract encounter (from encounter-deck.mjs) into actual
 * PF2e creatures, via the live bestiary. Kept separate from encounter-deck.mjs
 * so the rules-heavy shuffle/special-card logic stays testable with no
 * Foundry globals, while this half takes `api` as a parameter — same
 * injectable-dependency shape as `draw-target.mjs` — so it can be tested with
 * a stub `findCreatures` instead of a live world.
 */

// Monster Core is tried first, same reasoning as the Dragon/Monstrosity card
// handlers: adventure bestiaries are full of named plot characters, and a
// randomly-generated encounter should not hand the party someone's villain.
const MONSTER_CORE_PACKS = [
  "pf2e.pathfinder-monster-core",
  "pf2e.pathfinder-monster-core-2",
];

// The core bestiaries (Monster Core, Bestiary 1-3, NPC Core, NPC Gallery).
// Everything else matching CREATURE_PACK_PATTERN (adventure, Lost Omens, PFS)
// is the "boss pool": a dungeon's final room draws its boss from there, and
// ordinary rooms only fall back to it when nothing general fits.
const GENERAL_PACKS = [
  ...MONSTER_CORE_PACKS,
  "pf2e.pathfinder-bestiary",
  "pf2e.pathfinder-bestiary-2",
  "pf2e.pathfinder-bestiary-3",
  "pf2e.pathfinder-npc-core",
  "pf2e.npc-gallery",
];

// Troops and swarms are large by virtue of being many, which breaks "one
// slot = one creature/group" — excluded unconditionally, per the pf2e-data
// skill's guidance, regardless of what the GM's theme traits ask for.
const MANDATORY_EXCLUDE = ["troop", "swarm"];

// How far above/below the exact partyLevel + levelOffset target a match may
// fall. PF2e bestiaries are sparse at any single level, so an exact-level-only
// query often comes back empty.
const LEVEL_TOLERANCE = 1;

// GM Core's "Building Creature Encounters": XP awarded for a creature at a
// given level relative to the party's.
const RELATIVE_XP = {
  "-4": 10,
  "-3": 15,
  "-2": 20,
  "-1": 30,
  0: 40,
  1: 60,
  2: 80,
  3: 120,
  4: 160,
};

// Exported for combat-rewards.mjs — the same relative-level XP a combat
// room's advisory severity readout already uses is also the real XP a
// victory grants (see ITEM-6 in docs/backlog.md).
export function xpFor(levelOffset) {
  const clamped = Math.max(-4, Math.min(4, levelOffset ?? 0));
  return RELATIVE_XP[clamped] ?? 40;
}

// GM Core's "Building Creature Encounters": the total XP budget for each
// difficulty tier, baselined at a 4-PC party and adjusted by a flat amount
// per PC above or below that — the threshold side of the same relative-XP
// system `xpFor` draws from.
const XP_BUDGET_TIERS = {
  trivial: { base: 40, perExtraPc: 10 },
  low: { base: 60, perExtraPc: 15 },
  moderate: { base: 80, perExtraPc: 20 },
  severe: { base: 120, perExtraPc: 30 },
  extreme: { base: 160, perExtraPc: 40 },
};

/**
 * The XP budget for `tier` at a party of `partySize` — GM Core's per-PC
 * adjustment above/below the table's 4-PC baseline. Exported so a future
 * severity-label readout (the chat card currently only shows raw XP) can
 * reuse the same thresholds `resolveEncounterRoster`'s cap enforces.
 */
export function xpBudget(tier, partySize) {
  const { base, perExtraPc } = XP_BUDGET_TIERS[tier];
  return Math.max(0, base + perExtraPc * ((partySize ?? 4) - 4));
}

/**
 * The XP ceiling tier for a dungeon room's (effective) depth bias (#293,
 * extended by #412): below 0 caps at Trivial, 0 at Low, 1 at Moderate, 2 at
 * Severe, and 3 or more at Extreme (only reachable via the player's Extreme
 * difficulty shift, dungeon-deck.mjs's applyDifficultyShift). A missing
 * depth (`null`/`undefined`, e.g. the standalone macro) keeps the historical
 * Severe cap.
 */
export function xpCeilingTierForDepth(bias) {
  if (bias == null) return "severe";
  if (!Number.isFinite(bias)) return "severe";
  if (bias < 0) return "trivial";
  if (bias === 0) return "low";
  if (bias === 1) return "moderate";
  if (bias === 2) return "severe";
  return "extreme";
}

/**
 * #831: the exact inverse of `xpCeilingTierForDepth` above — maps a GM
 * Core difficulty tier name straight back to the depth bias that produces
 * it, so a direct tier picker (the standalone "Generate Encounter" macro,
 * which has no dungeon room/depth to derive one from) can drive the same
 * cap mechanism dungeon rooms already use, with no new XP-budget logic.
 * An unrecognized or missing tier falls back to Moderate (bias 1),
 * matching this file's own "default to Moderate" convention.
 */
const DIFFICULTY_TIER_TO_BIAS = {
  trivial: -1,
  low: 0,
  moderate: 1,
  severe: 2,
  extreme: 3,
};

export function depthBiasForDifficultyTier(tier) {
  return DIFFICULTY_TIER_TO_BIAS[tier] ?? DIFFICULTY_TIER_TO_BIAS.moderate;
}

/**
 * Per-force creature filter predicate (#1083). `family` is the ancestry-style
 * trait (goblin, orc, dragon...): PF2e NPCs carry no dedicated family field,
 * so it is a case-insensitive equality against any entry of the creature's
 * `traits` (system.traits.value). `rarity` is an exact match. null = no
 * constraint.
 */
export function creatureMatchesFilters(
  entry,
  { family = null, rarity = null } = {},
) {
  if (rarity != null && entry.rarity !== rarity) return false;
  if (family != null) {
    const want = String(family).toLowerCase();
    if (!(entry.traits ?? []).some((t) => String(t).toLowerCase() === want))
      return false;
  }
  return true;
}

/**
 * `levelOffsetBias` shifts the target level band — a dungeon room's
 * depth-based difficulty ramp (see dungeon-deck.mjs's depthBiasFor).
 * `requireTrait` is a single ANDed restriction — a dungeon room's own
 * location flavor (dungeon-deck.mjs's locationTagAt) — layered on top of the
 * broader any-of `traits` list. When both a theme and a location restriction
 * are set and neither loosened attempt finds anything, the location tag is
 * the one kept: it's the room's own specific identity, so the broader
 * dungeon-wide theme yields first rather than starving the room to empty.
 *
 * The final fallback drops `traits` entirely and always runs, even with no
 * `requireTrait` to fall back on — the free-text theme field on the
 * standalone macro takes any word a GM types, not just real trait tags, and
 * a word that matches nothing (e.g. "castle", a setting rather than a
 * creature trait) used to leave every single slot empty rather than falling
 * back to an untraited pick.
 */
async function pickCreature({
  api,
  partyLevel,
  levelOffset,
  traits,
  excludeTraits,
  rng,
  levelOffsetBias = 0,
  requireTrait = null,
  boss = false,
  upwardTolerance = LEVEL_TOLERANCE,
  levelOffsetMin = null,
  levelOffsetMax = null,
  family = null,
  rarity = null,
}) {
  let minLevel = partyLevel + levelOffset + levelOffsetBias - LEVEL_TOLERANCE;
  let maxLevel = partyLevel + levelOffset + levelOffsetBias + upwardTolerance;
  if (levelOffsetMin != null)
    minLevel = Math.max(minLevel, partyLevel + levelOffsetMin);
  if (levelOffsetMax != null)
    maxLevel = Math.min(maxLevel, partyLevel + levelOffsetMax);
  const excludeAll = [
    ...new Set([...(excludeTraits ?? []), ...MANDATORY_EXCLUDE]),
  ];
  const look = (packs, useTraits, excludePacks = []) =>
    api.findCreatures({
      minLevel,
      maxLevel,
      traits: useTraits ? traits : [],
      excludeTraits: excludeAll,
      packs,
      excludePacks,
      requireTrait,
      family,
      rarity,
    });

  let pool = [];
  if (boss) {
    pool = await look(null, true, GENERAL_PACKS);
    if (!pool.length) pool = await look(null, false, GENERAL_PACKS);
  }
  if (!pool.length) pool = await look(MONSTER_CORE_PACKS, true);
  if (!pool.length) pool = await look(GENERAL_PACKS, true);
  if (!pool.length) pool = await look(null, true);
  if (!pool.length) pool = await look(null, false);
  if (!pool.length) return null;
  return pool[Math.floor(rng() * pool.length)];
}

/**
 * Resolve every creature-track slot in `resolved` (from `dealEncounter`) into
 * a concrete bestiary entry.
 *
 * `group`: slots sharing a group id resolve to the *same* chosen creature,
 * repeated — a simplification of the book's more general "creatures that
 * work together" for phase 1 (good enough for "an encounter in this room";
 * revisit only if it reads wrong in play). Twins are treated the same way:
 * the book allows different creatures per twin, but one shared pick keeps
 * this phase simple.
 *
 * A slot with no bestiary match does not fail the whole encounter — it adds
 * a warning and is left out of the roster, matching the "place one yourself"
 * fallback the Dragon/Ooze/Monstrosity card handlers use.
 *
 * `partySize`, when given, caps the roster at a GM Core XP budget (#144;
 * Severe unless `depthBias` says otherwise, see below): the encounter deck's "draw a number of cards equal to the party
 * size" rule was adapted straight from 5e's much shallower per-monster XP
 * math, but a PF2e level-appropriate creature alone is already 40 XP
 * (`xpFor(0)`) — a party of 4 drawing 4 ordinary cards already lands at
 * exactly the Extreme threshold (160 XP) before a single `countsAs`/`group`
 * slot or Lurker/Twins card stacks anything on top. Once accepting a slot's
 * XP would push the running total past Severe, it's skipped instead
 * (`warnings` says how many) rather than silently landing Extreme — but
 * only once the roster already has *something* in it, so a single very
 * strong slot (or a party of 1) can't leave the whole encounter empty.
 * `null` (the default) disables the cap entirely, for callers with no real
 * party size to check against.
 *
 * `depthBias` (#293), when given, scales the ceiling with dungeon depth via
 * `xpCeilingTierForDepth`: -1 -> Trivial, 0 -> Low, 1 -> Moderate, 2 -> Severe, 3 -> Extreme,
 * so early rooms stay easy instead of every room being allowed up to Severe. `null`
 * (the default) keeps the Severe cap. It is deliberately separate from
 * `levelOffsetBias`, which defaults to 0 for standalone callers and would
 * otherwise silently tighten them to Low. The first-slot-always-accepted rule
 * applies at every tier.
 *
 * Skipping is decided by simple running-total order (foes, then Lurker,
 * then Twins) — a `group` slot's two members are checked independently, so
 * a "pack" pairing that happens to straddle the cap can end up with only
 * one of the pair spawning, and Twins ("the book calls this pairing a
 * climactic fight") can still get held back despite that framing. Revisit
 * only if either reads wrong in play, same as the group-simplification note
 * above.
 */
export async function resolveEncounterRoster({
  resolved,
  api,
  partyLevel,
  traits = [],
  excludeTraits = [],
  rng = Math.random,
  levelOffsetBias = 0,
  requireTrait = null,
  partySize = null,
  isBoss = false,
  depthBias = null,
  levelOffsetMin = null,
  levelOffsetMax = null,
  family = null,
  rarity = null,
  xpCapOverride = null,
}) {
  const warnings = [];
  const groupChoice = new Map();
  let approxXp = 0;
  let cappedCount = 0;
  const capTier = xpCeilingTierForDepth(depthBias);
  // A non-null override is clamped to a finite, non-negative budget: a
  // negative or NaN value means "no budget" (0), never "no cap".
  const xpCap =
    xpCapOverride != null
      ? Number.isFinite(xpCapOverride)
        ? Math.max(0, xpCapOverride)
        : 0
      : partySize != null
        ? xpBudget(capTier, partySize)
        : null;
  const filters = { levelOffsetMin, levelOffsetMax, family, rarity };

  const pick = (levelOffset, boss = false) =>
    pickCreature({
      api,
      partyLevel,
      levelOffset,
      traits,
      excludeTraits,
      rng,
      levelOffsetBias,
      requireTrait,
      boss,
      ...filters,
    });

  // Cap-aware pick (#293): with a cap, the largest relative level `d` (at
  // most the nominal slot level capped at +4 — GM Core's table maximum, where
  // xpFor stops clamping, so a bigger offset would be undercharged — at least
  // -4) whose XP for `count` creatures
  // fits the remaining budget. The pick is then limited to creatures whose
  // REAL level is <= partyLevel + d (no upward tolerance), so what is
  // charged is never below what spawns. Nothing fits even at -4 -> skipped
  // (null), except into an empty roster, which takes -4 rather than nothing.
  const fitOffset = (slotOffset, count) => {
    if (xpCap === 0) return null;
    const nominal = slotOffset + levelOffsetBias;
    for (let d = Math.min(nominal, 4); d >= -4; d -= 1) {
      if (approxXp + xpFor(d) * count <= xpCap) return d;
    }
    return approxXp === 0 ? -4 : null;
  };
  // Returns { chosen, contribution } or null when the cap holds the slot back.
  async function pickWithinCap(slotOffset, count, boss = false) {
    if (xpCap == null) {
      const chosen = await pick(slotOffset, boss);
      return {
        chosen,
        contribution: xpFor(slotOffset + levelOffsetBias) * count,
      };
    }
    const d = fitOffset(slotOffset, count);
    if (d == null) return null;
    let chosen = await pickCreature({
      api,
      partyLevel,
      levelOffset: d,
      traits,
      excludeTraits,
      rng,
      levelOffsetBias: 0,
      requireTrait,
      boss,
      upwardTolerance: 0,
      ...filters,
    });
    if (!chosen && d < slotOffset + levelOffsetBias) {
      // Clamped below the nominal level and nothing exists down there.
      // Later slot: the cap is what held it back, not a missing creature.
      if (approxXp > 0) return null;
      // Empty roster: an empty encounter is worse than an over-cap one, so
      // fall back to the nominal pick and charge its real level.
      chosen = await pick(slotOffset, boss);
      if (chosen)
        return {
          chosen,
          contribution: xpFor(chosen.level - partyLevel) * count,
        };
    }
    return { chosen, contribution: xpFor(d) * count };
  }

  const foes = [];
  for (const slot of resolved.foes ?? []) {
    const count = slot.countsAs ?? 1;
    const boss = isBoss && resolved.foes.indexOf(slot) === 0;
    let result;
    if (slot.group && groupChoice.has(slot.group)) {
      // Group members reuse the first pick, so charge that creature's real
      // level (not this slot's nominal one) and hold the member back if it
      // no longer fits.
      const chosen = groupChoice.get(slot.group);
      const contribution = chosen
        ? xpFor(chosen.level - partyLevel) * count
        : xpFor(slot.levelOffset + levelOffsetBias) * count;
      result =
        xpCap != null && approxXp > 0 && approxXp + contribution > xpCap
          ? null
          : { chosen, contribution };
    } else {
      result = await pickWithinCap(slot.levelOffset, count, boss);
      if (slot.group && result) groupChoice.set(slot.group, result.chosen);
    }
    if (!result) {
      cappedCount += 1;
      continue;
    }
    const { chosen, contribution } = result;
    if (!chosen) {
      warnings.push(
        `No creature found for a level ${partyLevel + slot.levelOffset + levelOffsetBias} slot — place one yourself.`,
      );
      continue;
    }
    foes.push({
      pack: chosen.pack,
      id: chosen.id,
      name: chosen.name,
      level: chosen.level,
      count,
      group: slot.group ?? null,
    });
    approxXp += contribution;
  }

  let friend = null;
  if (resolved.friend) {
    const chosen = await pick(resolved.friend.levelOffset);
    if (chosen)
      friend = {
        pack: chosen.pack,
        id: chosen.id,
        name: chosen.name,
        level: chosen.level,
      };
    else
      warnings.push(
        "No friendly creature found for the Friend card — place one yourself.",
      );
  }

  let lurker = null;
  if (resolved.lurker) {
    const result = await pickWithinCap(resolved.lurker.levelOffset, 1);
    if (!result) {
      cappedCount += 1;
    } else {
      const { chosen, contribution } = result;
      if (chosen) {
        lurker = {
          pack: chosen.pack,
          id: chosen.id,
          name: chosen.name,
          level: chosen.level,
        };
        approxXp += contribution;
      } else
        warnings.push(
          "No lurking creature found for the Lurker card — place one yourself.",
        );
    }
  }

  let twins = null;
  if (resolved.twins) {
    const [first] = resolved.twins;
    const result = await pickWithinCap(
      first.levelOffset,
      resolved.twins.length,
    );
    if (!result) {
      cappedCount += 1;
    } else {
      const { chosen, contribution } = result;
      if (chosen) {
        twins = resolved.twins.map(() => ({
          pack: chosen.pack,
          id: chosen.id,
          name: chosen.name,
          level: chosen.level,
        }));
        approxXp += contribution;
      } else
        warnings.push(
          "No creature found for the Twin cards — place one yourself.",
        );
    }
  }

  if (cappedCount > 0) {
    warnings.push(
      `Encounter capped at ${capTier[0].toUpperCase()}${capTier.slice(1)} difficulty for a party of ${partySize} — ${cappedCount} further creature card(s) held back.`,
    );
  }

  return {
    foes,
    friend,
    lurker,
    twins,
    noncombat: resolved.noncombat ?? null,
    goal: resolved.goal ?? null,
    warnings,
    approxXp,
    appliedFilters: ["levelRange", "family", "rarity", "xpCapOverride"],
  };
}
