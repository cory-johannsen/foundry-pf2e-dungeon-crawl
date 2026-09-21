/**
 * Core skill-challenge mechanics (#162): the Victory Point bookkeeping for
 * a `skill_challenge` room, no Foundry dependency — same pure/glue split
 * every other room-kind pair in this module already uses
 * (`trap-mechanics.mjs`/`trap-combat.mjs`, `dungeon-deck.mjs`/
 * `dungeon-scene.mjs`).
 *
 * Grounded in GM Core's own Victory Point subsystem — the same mechanism
 * the rulebook itself uses for skill challenges, chases, research, and
 * infiltration — rather than an invented one: a target VP total, a
 * sequence of skill checks against a DC, VP gained/lost per degree of
 * success, resolving once VP hits the target (success) or the party's
 * attempt budget runs out first (failure). Confirmed live: no compendium
 * in this world's pf2e system carries structured data for this subsystem
 * at all (unlike traps' `pf2e.hazards` — see trap-mechanics.mjs), so this
 * file implements the VP math from the rules text directly, the same way
 * this module already implements combat resolution on top of PF2e's own
 * roll primitives rather than a packaged subsystem API.
 *
 * Explicit v1 design calls (#162 asked these be made deliberately, not
 * assumed):
 *   - Binary resolution only — a challenge resolves succeeded or failed,
 *     never GM Core's optional "qualified" partial-success tier. The rest
 *     of this module's room-resolution pipeline (`markRoomOutcome`) is
 *     itself already binary (`succeeded: boolean`), and a qualified-success
 *     tier would need its own new consequence path with nothing today to
 *     hook it to — deferred, not assumed away.
 *   - A flat, tunable VP target/attempt budget (no graduated
 *     easy/standard/hard tiers) — same "tunable, no anchor in the source
 *     material" precedent `ROOM_KIND_WEIGHTS`/`LOOT_GP_PER_XP` already set.
 *   - 3 "specialty" skills per challenge (2 tag-linked + 1 generic), rolled
 *     at the room's own level-appropriate Simple DC; any other real skill
 *     is still attemptable, but at DC+2 — GM Core's own specialty-vs-any
 *     split, simplified to a flat DC bump rather than a second full DC
 *     table.
 */
import { splitmix32, seedFromString } from "./prng.mjs";

// PF2e's own "Simple DC" table (GM Core) by character/party level. Same
// confidence level as encounter-roster.mjs's RELATIVE_XP table — a stable,
// commonly-cited rules table, not a guess. Indexed -1..25; clamped outside
// that range rather than extrapolated, since no dungeon room in this
// module runs a party anywhere near level 25.
const SIMPLE_DC_BY_LEVEL = {
  "-1": 13,
  0: 14,
  1: 15,
  2: 16,
  3: 18,
  4: 19,
  5: 20,
  6: 22,
  7: 23,
  8: 24,
  9: 26,
  10: 27,
  11: 28,
  12: 30,
  13: 31,
  14: 32,
  15: 34,
  16: 35,
  17: 36,
  18: 38,
  19: 39,
  20: 40,
  21: 42,
  22: 44,
  23: 46,
  24: 48,
  25: 50,
};

export function simpleDcForLevel(level) {
  const clamped = Math.max(-1, Math.min(25, Math.round(level ?? 0)));
  return SIMPLE_DC_BY_LEVEL[clamped] ?? 20;
}

// Attempting a non-specialty skill is still allowed (GM Core: "any
// character can attempt an alternative skill, but the DC is higher") —
// simplified here to a flat bump rather than a second DC table.
export const NON_SPECIALTY_DC_BUMP = 2;

// GM Core's own standard per-check VP table.
export const VP_DELTA_BY_OUTCOME = {
  criticalSuccess: 2,
  success: 1,
  failure: 0,
  criticalFailure: -1,
};

export function vpDeltaForOutcome(outcome) {
  return VP_DELTA_BY_OUTCOME[outcome] ?? 0;
}

// Tunable, no anchor in the source material (the book's Journey Spread
// never specifies skill-challenge difficulty, same gap ROOM_KIND_WEIGHTS'
// own comment already flags for room-kind mix). 6 VP at 1 VP/success is a
// "most of the party succeeds once" challenge; the attempt budget gives
// some slack beyond a perfect run so one early failure isn't fatal.
export const VP_TARGET = 6;

export function attemptBudgetForPartySize(partySize) {
  return Math.max(3, (partySize ?? 4) + 2);
}

// Every real (non-Lore) PF2e skill — Lore skills are excluded since
// they're per-character and not guaranteed to exist across the whole
// party, confirmed live against a real character actor's own
// `actor.skills` keys (which also included a `guild-lore` entry the
// generic list below deliberately leaves out).
export const ALL_SKILLS = [
  "acrobatics",
  "arcana",
  "athletics",
  "crafting",
  "deception",
  "diplomacy",
  "intimidation",
  "medicine",
  "nature",
  "occultism",
  "performance",
  "religion",
  "society",
  "stealth",
  "survival",
  "thievery",
];

// Two theme-linked skills per dungeon-deck.mjs's own LOCATION_TAGS — a
// deliberately simple, tunable mapping, not a rules citation. Every entry
// here must be a real slug from ALL_SKILLS.
const SKILLS_BY_LOCATION_TAG = {
  undead: ["religion", "intimidation"],
  beast: ["nature", "survival"],
  fiend: ["religion", "intimidation"],
  aberration: ["occultism", "arcana"],
  construct: ["crafting", "arcana"],
  elemental: ["nature", "arcana"],
  plant: ["nature", "survival"],
  dragon: ["arcana", "diplomacy"],
};

// Broad, generically-useful skills — the third specialty slot, and the
// fallback pair for a room with no locationTag/an unrecognized one, so a
// challenge is never built from fewer than the intended 3.
const GENERIC_SKILLS = ["society", "diplomacy", "athletics", "deception"];

/**
 * 3 specialty skill slugs for a challenge: the location tag's own 2 (or
 * `GENERIC_SKILLS`'s first 2 if the tag isn't recognized/given), plus one
 * more drawn from `GENERIC_SKILLS`, deterministic per `seed`+`roomId` —
 * same seeded-per-index convention as dungeon-deck.mjs's own picks.
 */
export function chooseSpecialtySkills(seed, roomId, locationTag) {
  const themed =
    SKILLS_BY_LOCATION_TAG[locationTag] ?? GENERIC_SKILLS.slice(0, 2);
  const rand = splitmix32(seedFromString(`${seed}-skillchallenge-${roomId}`));
  const pool = GENERIC_SKILLS.filter((s) => !themed.includes(s));
  const third = pool.length
    ? pool[Math.floor(rand() * pool.length)]
    : GENERIC_SKILLS[0];
  return [...new Set([...themed, third])];
}

/**
 * The DC for attempting `skill` in a challenge with `specialtySkills`, at
 * `partyLevel` — the room's Simple DC, +`NON_SPECIALTY_DC_BUMP` if `skill`
 * isn't one of the challenge's own specialties.
 */
export function dcForAttempt({ partyLevel, skill, specialtySkills }) {
  const base = simpleDcForLevel(partyLevel);
  return specialtySkills.includes(skill) ? base : base + NON_SPECIALTY_DC_BUMP;
}

/**
 * Whether `entry` (a `dungeon-setpieces.json` entry) is a usable
 * skill-challenge template — `kind === 'skill_challenge'` and exactly 3
 * real `ALL_SKILLS` slugs in `specialtySkills`. Guards rather than trusts a
 * hand-authored JSON entry blindly, the same caution `isSimpleAutomatableTrap`
 * applies to a live compendium document instead.
 */
export function isValidSkillChallengeTemplate(entry) {
  return (
    entry?.kind === "skill_challenge" &&
    Array.isArray(entry.specialtySkills) &&
    entry.specialtySkills.length === 3 &&
    entry.specialtySkills.every((s) => ALL_SKILLS.includes(s))
  );
}

/**
 * Picks one hand-authored skill-challenge template (#164) from `entries` —
 * `dungeon-setpieces.json`'s full mixed pool, filtered here to valid
 * `skill_challenge`-kind ones, same "filter to the kind this function cares
 * about, don't trust the caller to have pre-filtered" convention
 * `trap-library.mjs`'s `selectTrap` already uses. Deterministic per
 * `seed`+`roomId`, same seeding convention as `chooseSpecialtySkills`.
 * `null` if `entries` has no valid skill_challenge template at all — the
 * caller falls back to `chooseSpecialtySkills`'s own generic, template-free
 * selection in that case, per #164's "extends the pool, not a hard
 * dependency on it" scope.
 */
export function selectSkillChallengeTemplate(entries, seed, roomId) {
  const pool = (entries ?? []).filter(isValidSkillChallengeTemplate);
  if (!pool.length) return null;
  const rand = splitmix32(
    seedFromString(`${seed}-skillchallenge-template-${roomId}`),
  );
  return pool[Math.floor(rand() * pool.length)];
}

/**
 * Fresh Victory Point state for a room, deterministic per `seed`+`roomId`
 * for which 3 skills are specialties — `vpTarget`/`attemptBudget` are
 * *not* re-derived from the seed (no reason for them to vary run to run
 * the way flavor picks do), just this file's own tunable constants.
 *
 * `template` (#164, optional) — a `selectSkillChallengeTemplate` result —
 * supplies its own `specialtySkills` (an archetype-appropriate trio: a
 * chase's Acrobatics/Athletics/Stealth reads very differently from a
 * negotiation's Diplomacy/Deception/Intimidation) instead of the generic
 * `chooseSpecialtySkills` location-tag pick, which stays the fallback for
 * a room with no valid template available — same "only fall back to the
 * generic pick when hand-authored content doesn't cover this" shape #135
 * already uses for traps, adapted for hand-authored rather than
 * compendium-sourced content per #164's own explicit scope.
 *
 * `name`/`summary`/`skillFlavor` are persisted directly on the returned
 * state (from `template` when valid, else `null`/`{}`) rather than
 * re-derived from a freshly-reselected template on every render, the way
 * an earlier version of this pairing (#164) worked — #166 needs a stable
 * place for an external agent's customization to land and stick, and
 * persisting these once here, at creation, is what makes that possible:
 * `dungeon-runner.mjs`'s `applySkillChallengeCustomization` overwrites
 * exactly these three fields, nothing else.
 */
export function initSkillChallengeState({
  seed,
  roomId,
  locationTag,
  partySize,
  template = null,
}) {
  const valid = isValidSkillChallengeTemplate(template);
  return {
    vpTarget: VP_TARGET,
    attemptBudget: attemptBudgetForPartySize(partySize),
    specialtySkills: valid
      ? template.specialtySkills
      : chooseSpecialtySkills(seed, roomId, locationTag),
    name: valid ? (template.name ?? null) : null,
    summary: valid ? (template.summary ?? null) : null,
    skillFlavor: valid ? (template.skillFlavor ?? {}) : {},
    vp: 0,
    attemptsUsed: 0,
    resolved: null, // null while in progress, else 'success' | 'failure'
  };
}

/**
 * One resolved reducer step: applies `outcome`'s VP delta, clamped so a
 * run of critical failures can't push `vp` durably negative (a challenge
 * already going badly shouldn't need *more* successes than `vpTarget` to
 * recover from a debt), consumes one attempt, and sets `resolved` once
 * either the target is reached (success — checked first, so hitting the
 * target on the party's very last available attempt still resolves as a
 * win) or the attempt budget runs out short of it (failure). A no-op
 * (returns `state` unchanged) if already resolved — the caller's own job
 * to stop offering attempts once `resolved` is set, this is just the
 * belt-and-braces guarantee that calling it anyway can't overshoot the
 * budget or flip an already-decided outcome.
 */
export function applySkillChallengeAttempt(state, outcome) {
  if (state.resolved) return state;
  const vp = Math.max(0, state.vp + vpDeltaForOutcome(outcome));
  const attemptsUsed = state.attemptsUsed + 1;
  const resolved =
    vp >= state.vpTarget
      ? "success"
      : attemptsUsed >= state.attemptBudget
        ? "failure"
        : null;
  return { ...state, vp, attemptsUsed, resolved };
}
