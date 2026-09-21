/**
 * Sound effects for dungeon-crawl actions and outcomes (#95): doors, strikes,
 * a creature's death, and save-based spells -- the same "something happened,
 * play a sound" principle card-sound.mjs already uses for card draws.
 *
 * The sound-selection logic (which key a given outcome/context maps to) is
 * pure and tested; only the play*Sound wrappers touch playSound (audio.mjs).
 *
 * Scope, and what's deliberately left out for a follow-up:
 *   - Sneak attack has no sound of its own. There's no reliable way to
 *     detect it from a landed strike without a live rogue character to
 *     verify the actual damage-roll tagging against (PF2e's own precision
 *     damage category, unverified here), and no existing detection code to
 *     build on -- guessing at the mechanism risked shipping something that
 *     silently never fires. Needs its own follow-up once verifiable live.
 *   - Spell *healing* has no sound. castSpellAndApplySave (dungeon-combat.mjs)
 *     is the only automated spellcasting path that exists today, and it's
 *     offensive/save-based only -- there's no automated healing-cast code
 *     path yet for a sound to hook into.
 *   - Trap triggers have no sound. Traps resolve through a GM-narrated
 *     puzzle_or_trap setpiece dialog (dungeon-deck.mjs), not a deterministic
 *     "triggered" event with a clean hook -- same reasoning as the two
 *     items above.
 */
import { playSound } from "./audio.mjs";

const MODULE_ID = "pf2e-dungeon-crawl";
const SOUND_DIR = `modules/${MODULE_ID}/assets/sounds`;

export const DUNGEON_SOUND_FILES = {
  doorOpen: "door-open.ogg",
  doorLock: "door-lock.ogg",
  doorUnlock: "door-unlock.ogg",
  strikeHitBludgeoning: "strike-hit-bludgeoning.ogg",
  strikeHitPiercing: "strike-hit-piercing.ogg",
  strikeHitSlashing: "strike-hit-slashing.ogg",
  strikeHitBow: "strike-hit-bow.ogg",
  strikeHitCrossbow: "strike-hit-crossbow.ogg",
  strikeHitThrown: "strike-hit-thrown.ogg",
  strikeMiss: "strike-miss.ogg",
  strikeCriticalMiss: "strike-critical-miss.ogg",
  strikeCriticalHit: "strike-critical-hit.ogg",
  strikeBlocked: "strike-blocked.ogg",
  creatureDeath: "creature-death.ogg",
};

// Spell hit/miss reuse existing card sounds -- no new asset needed, and both
// are already thematically arcane.
const SPELL_HIT_SOUND = `${SOUND_DIR}/card-arcane.ogg`;
const SPELL_MISS_SOUND = `${SOUND_DIR}/card-query.ogg`;

function soundPath(key) {
  const file = DUNGEON_SOUND_FILES[key];
  return file ? `${SOUND_DIR}/${file}` : null;
}

/** Ranged weapon groups this generator gives their own sound. Everything
 * else PF2e's ranged weapon groups cover (sling, dart, javelin, firearm --
 * see CONFIG.PF2E.weaponGroups for the full list, mostly sci-fi and
 * irrelevant to a fantasy game) shares one "thrown" bucket rather than one
 * sound per group. */
const RANGED_GROUP_KEY = {
  bow: "strikeHitBow",
  crossbow: "strikeHitCrossbow",
};
const RANGED_FALLBACK_KEY = "strikeHitThrown";

/** PF2e's three physical damage types, which between them cover every
 * mundane weapon and nearly every natural attack. Anything else (energy,
 * mental, poison, etc. -- a rare monster trait) falls to bludgeoning as the
 * least-wrong default: audible rather than silent, same principle
 * card-sound.mjs's own FALLBACK_GROUP already uses. */
const MELEE_DAMAGE_TYPE_KEY = {
  bludgeoning: "strikeHitBludgeoning",
  piercing: "strikeHitPiercing",
  slashing: "strikeHitSlashing",
};
const MELEE_FALLBACK_KEY = "strikeHitBludgeoning";

/**
 * Which hit-sound key a landed strike should play, from the weapon's own
 * group (ranged) or damage type (melee). Pure, so the bucketing is testable
 * without a live Foundry strike object -- dungeon-combat.mjs pulls
 * `isRanged`/`weaponGroup`/`damageType` off the real strike and passes them
 * in as plain values.
 */
export function strikeHitSoundKey({ isRanged, weaponGroup, damageType }) {
  if (isRanged) return RANGED_GROUP_KEY[weaponGroup] ?? RANGED_FALLBACK_KEY;
  return MELEE_DAMAGE_TYPE_KEY[damageType] ?? MELEE_FALLBACK_KEY;
}

/**
 * The sound path for one strike outcome (PF2e's four degrees of success), or
 * `null` for an outcome that gets no sound. `blocked` -- the target's shield
 * was raised at the moment the hit landed (dungeon-combat.mjs's own
 * heuristic for "count this as a blocked hit," not a confirmed Shield Block
 * reaction; PF2e exposes no direct "was Shield Block used" flag this could
 * check instead) -- takes priority over the weapon-specific hit sound, so a
 * blocked hit always sounds like impact-on-shield rather than
 * impact-on-flesh. A critical hit/miss gets one shared dramatic sting
 * regardless of weapon: a critical is a notable moment in its own right,
 * not just a louder version of the normal hit.
 */
export function strikeSoundPath(
  outcome,
  { isRanged, weaponGroup, damageType, blocked } = {},
) {
  if (outcome === "criticalSuccess") return soundPath("strikeCriticalHit");
  if (outcome === "criticalFailure") return soundPath("strikeCriticalMiss");
  if (outcome === "failure") return soundPath("strikeMiss");
  if (outcome !== "success") return null;
  if (blocked) return soundPath("strikeBlocked");
  return soundPath(strikeHitSoundKey({ isRanged, weaponGroup, damageType }));
}

/**
 * The sound path for one save-based spell outcome, or `null`. Inverted from
 * a strike's outcome semantics: the *target's save* succeeding means the
 * spell did little or nothing to them (a "miss" from the caster's
 * perspective), and the save failing means the spell landed. For
 * castSpellAndApplySave/castAreaSpellAndApplySaves.
 */
export function spellSaveSoundPath(outcome) {
  if (outcome === "criticalFailure" || outcome === "failure")
    return SPELL_HIT_SOUND;
  if (outcome === "success" || outcome === "criticalSuccess")
    return SPELL_MISS_SOUND;
  return null;
}

/**
 * The sound path for one attack-roll spell outcome, or `null`. NOT inverted
 * -- an attack-roll spell (castAttackSpellAndApplyRoll) resolves exactly
 * like a strike against the target's AC, so success/criticalSuccess is a
 * hit and failure/criticalFailure is a miss, same direction as
 * strikeSoundPath. Kept as its own function rather than a shared one with a
 * boolean flag: the two are different mechanics that happen to want the
 * same two sound files, not one mechanic with a variant.
 */
export function spellAttackSoundPath(outcome) {
  if (outcome === "success" || outcome === "criticalSuccess")
    return SPELL_HIT_SOUND;
  if (outcome === "failure" || outcome === "criticalFailure")
    return SPELL_MISS_SOUND;
  return null;
}

export function playStrikeSound(outcome, context) {
  const p = strikeSoundPath(outcome, context);
  if (p) playSound(p);
}

export function playSpellSaveSound(outcome) {
  const p = spellSaveSoundPath(outcome);
  if (p) playSound(p);
}

export function playAttackSpellSound(outcome) {
  const p = spellAttackSoundPath(outcome);
  if (p) playSound(p);
}

export function playCreatureDeathSound() {
  playSound(soundPath("creatureDeath"));
}

/** `kind` is `'open' | 'lock' | 'unlock'` -- the three door-state
 * transitions this generator's own doors go through (dungeon-scene.mjs). */
export function playDoorSound(kind) {
  const key =
    kind === "open"
      ? "doorOpen"
      : kind === "lock"
        ? "doorLock"
        : kind === "unlock"
          ? "doorUnlock"
          : null;
  const p = key ? soundPath(key) : null;
  if (p) playSound(p);
}
