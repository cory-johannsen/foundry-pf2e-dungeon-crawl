/**
 * #920: pure rules helpers for Antagonize (Player Core 2, swashbuckler 2):
 *
 *   "When you successfully Demoralize a creature, its Frightened condition
 *    can't decrease to less than 1 at the end of its turn until it either
 *    uses a hostile action against you or can no longer observe or sense you
 *    for at least 1 round."
 *
 * The installed pf2e system (8.5.0) only attaches a chat Note to the
 * Demoralize check; nothing enforces the floor. dungeon-combat.mjs stores
 * one entry per antagonizer on the frightened creature's actor
 * (`flags.pf2e-dungeon-crawl.antagonize`) and calls these helpers. No
 * Foundry API surface here.
 *
 * Entries are keyed by the antagonizer's combatant id, not its actor UUID:
 * Foundry expands dotted keys in update data, so a UUID key
 * ("Scene.x.Token.y.Actor.z") would be split into nested objects.
 */

import { DETECTION } from "./stealth-detection.mjs";

const MODULE_ID = "pf2e-dungeon-crawl";

export const ANTAGONIZE_FEAT_SLUG = "antagonize";

/** The frightened creature's `{ [antagonizerCombatantId]: entry }` map, or
 * `{}` when absent or malformed. Entry shape:
 * `{ antagonizerUuid, sinceWorldTime, unsensedSince: null | {round, turn} }`. */
export function readAntagonizeMap(actor) {
  const map = actor?.flags?.[MODULE_ID]?.antagonize;
  return map && typeof map === "object" && !Array.isArray(map) ? map : {};
}

/** The value Frightened may not decay below at the end of the actor's turn:
 * 1 while any antagonizer holds a floor, else 0. Several antagonizers still
 * floor at 1 ("can't decrease to less than 1"). */
export function frightenedFloorFor(actor) {
  return Object.keys(readAntagonizeMap(actor)).length > 0 ? 1 : 0;
}

/** Whether the frightened creature still observes or senses its
 * antagonizer, given the antagonizer's detection state from the creature's
 * point of view (the #616 stealth matrix; absent = observed). A hidden
 * creature is still sensed (its location is known); only undetected and
 * unnoticed mean "can no longer observe or sense you". */
export function sensesAntagonizer(detectionState) {
  return detectionState !== DETECTION.UNDETECTED && detectionState !== DETECTION.UNNOTICED;
}

/** True once `now` is at least one full round after `since` -- the same
 * initiative position (or later) in a later round. Both are `{round, turn}`. */
export function fullRoundElapsed(since, now) {
  if (now.round > since.round + 1) return true;
  return now.round === since.round + 1 && now.turn >= since.turn;
}

/** One sense sample for one entry, taken at a turn change. Sensed -> the
 * not-sensed clock is cleared. Not sensed -> the clock starts at this sample
 * (if not already running) and the entry expires once a full round has
 * passed since it started. Sampling at turn changes means a loss is only
 * noticed at the next turn boundary, so the floor never ends early. Returns
 * `{ entry, expired }` with the (possibly updated) entry. */
export function evaluateAntagonizeEntry(entry, { sensed, round, turn }) {
  if (sensed) return { entry: { ...entry, unsensedSince: null }, expired: false };
  const since = entry.unsensedSince ?? { round, turn };
  return {
    entry: { ...entry, unsensedSince: since },
    expired: fullRoundElapsed(since, { round, turn }),
  };
}

const HOSTILE_ROLL_TYPES = new Set(["attack-roll", "spell-attack-roll", "damage-roll"]);
const HOSTILE_SKILL_ACTIONS = ["action:demoralize", "action:feint"];

/** Whether a chat message's `flags.pf2e.context` records a hostile action by
 * the roller against `context.target`: an attack, spell attack or damage
 * roll, or a skill check that is an attack-trait maneuver or a Demoralize/
 * Feint. Other targeted skill checks (e.g. Request) are not hostile. */
export function isHostileCheckContext(context) {
  if (!context) return false;
  if (HOSTILE_ROLL_TYPES.has(context.type)) return true;
  if (context.type !== "skill-check") return false;
  const options = Array.isArray(context.options) ? context.options : [];
  return options.includes("item:trait:attack") || HOSTILE_SKILL_ACTIONS.some((o) => options.includes(o));
}

const SINGLE_TARGET_HOSTILE_TYPES = new Set([
  "strike",
  "cast",
  "castAttack",
  "castDebuff",
  "multiStrike",
  "castDualHarm",
  "maneuver",
  "feat",
  "npcAbility",
]);
const AREA_HOSTILE_TYPES = new Set(["castArea", "breathWeapon", "castAreaTier", "castAutoHitAreaTier"]);

/** The combatant ids an AI candidate (agent-candidates.mjs shapes) uses a
 * hostile action against. Healing, buffing, movement, Seek and self-effect
 * feats are not hostile. */
export function hostileTargetIdsOf(candidate) {
  if (!candidate) return [];
  const ids = [];
  if (SINGLE_TARGET_HOSTILE_TYPES.has(candidate.type) && candidate.targetId) ids.push(candidate.targetId);
  if (AREA_HOSTILE_TYPES.has(candidate.type) || candidate.type === "npcAbility") {
    ids.push(...(candidate.affectedIds ?? []));
  }
  if (candidate.type === "castChain") {
    if (candidate.targetId) ids.push(candidate.targetId);
    ids.push(...(candidate.chainedIds ?? []));
  }
  if (candidate.type === "castTargetCount") ids.push(...(candidate.targetIds ?? []));
  if (candidate.type === "castDualArea") ids.push(...(candidate.harmIds ?? []));
  return [...new Set(ids)];
}
