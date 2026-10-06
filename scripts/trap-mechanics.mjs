/**
 * Core trap mechanics (#134): detect, disable, and resolve PF2e hazard-actor
 * traps built from real compendium content (`pf2e.hazards`, see #135) rather
 * than inventing a new trap data model.
 *
 * Confirmed live against real trap-tagged hazards (Hidden Pit, Poisoned Dart
 * Gallery, Scythe Blades, Wheel of Misery, Telekinetic Swarm Trap): official
 * PF2e hazard content is built for GM-narrated manual execution, not full
 * automation the way a Strike or a spell save already is elsewhere in this
 * module. `system.details.disable` and `system.details.routine` are
 * free-text HTML with embedded `@Check[skill|dc:N|...]`/`@Damage[...]`/
 * `@UUID[...]` inline-roll links a human would click, not structured
 * fields — even "complex" multi-action hazards like Wheel of Misery are a
 * paragraph a GM reads and executes by hand (roll 1d6, cast whichever spell
 * that segment lists), not callable game data.
 *
 * Two things ARE reliably structured, and this file's v1 automation is
 * built on exactly those:
 *
 *   - A simple (non-complex) trap's attack routine, when it has exactly one
 *     embedded melee/ranged item, compiles into a real Strike
 *     (`hazardActor.system.actions[0]`, confirmed live to have the same
 *     `.variants[0].roll()`/`.damage()` shape a creature's own strike does)
 *     — trap-combat.mjs rolls it exactly like dungeon-combat.mjs already
 *     rolls a combatant's strike.
 *   - `system.details.disable`'s `@Check[skill|dc:N|...]` syntax is PF2e's
 *     own stable inline-roll-link convention (used system-wide, not a
 *     one-off quirk of this content) and parses reliably with a plain
 *     regex, confirmed against every trap-tagged hazard checked live.
 *
 * A hazard whose routine doesn't reduce to one simple strike (a multi-stage
 * routine picking between effects, or a save-only effect with no embedded
 * strike item at all) isn't v1-automatable this way — `isSimpleAutomatableTrap`
 * says so explicitly rather than silently misfiring, and stays GM-narrated
 * for now, same as it is today. Confirmed live: 17 of the 24 trap-tagged
 * entries in `pf2e.hazards` are non-complex; this boundary is deliberately
 * scoped to the common case, not every possible hazard shape.
 */
import { splitmix32, seedFromString } from "./prng.mjs";

const DISABLE_CHECK_PATTERN =
  /@Check\[([\w-]+)\|dc:(\d+)(?:\|name:([^\]|]+))?/g;

/**
 * Every disable option a trap's `system.details.disable` text describes, as
 * `{skill, dc, label}`. A hazard can offer more than one way to disable it
 * (Wheel of Misery: two different Thievery checks against two different
 * targets, or a Dispel Magic) — all of them are returned, not just the
 * first, so a caller can offer a real choice rather than assuming one path.
 */
export function parseDisableChecks(disableHtml) {
  const checks = [];
  if (!disableHtml) return checks;
  for (const match of disableHtml.matchAll(DISABLE_CHECK_PATTERN)) {
    const [, skill, dc, label] = match;
    checks.push({ skill, dc: Number(dc), label: label?.trim() ?? null });
  }
  return checks;
}

/**
 * The DC to detect a trap via Perception (or an active Seek), from its own
 * Stealth value — the standard PF2e "DC = 10 + modifier" conversion, the
 * same one every skill DC in the system uses.
 */
export function trapDetectionDC(stealthValue) {
  return 10 + (stealthValue ?? 0);
}

/** #757: a trap's footprint size -- PF2e's own hazard data never
 * specifies one larger than 1x1 (confirmed live against all 53
 * pf2e.hazards entries), so this is a module-invented, seeded
 * convention for visual/tactical variety: 70% stay 1x1, 20% become an
 * elongated 2x1 or 1x2 (even split), 10% become 2x2. */
export function trapFootprintSize(seed, roomId) {
  const rand = splitmix32(seedFromString(`${seed}-trap-footprint-${roomId}`));
  const roll = rand();
  if (roll < 0.7) return { width: 1, height: 1 };
  if (roll < 0.9) {
    return rand() < 0.5 ? { width: 2, height: 1 } : { width: 1, height: 2 };
  }
  return { width: 2, height: 2 };
}

/** #753: what a party token's new position means for a not-yet-triggered
 * trap at `trapFootprint` -- "trigger" if the mover's own new footprint
 * actually overlaps the trap's (stepped onto it), "detect" if merely
 * Chebyshev-adjacent (one square away, including diagonally -- close
 * enough to notice without having walked onto it), otherwise "none".
 * Pure geometry only -- the caller (trap-combat.mjs) is responsible for
 * actually checking/setting trapDisabled/trapDetected/trapTriggered
 * actor flags; this function has no notion of trap state at all. */
export function classifyTrapMove(trapFootprint, moverFootprint) {
  const overlaps =
    trapFootprint.gx < moverFootprint.gx + moverFootprint.gw &&
    trapFootprint.gx + trapFootprint.gw > moverFootprint.gx &&
    trapFootprint.gy < moverFootprint.gy + moverFootprint.gh &&
    trapFootprint.gy + trapFootprint.gh > moverFootprint.gy;
  if (overlaps) return "trigger";

  const dx = Math.max(
    trapFootprint.gx - (moverFootprint.gx + moverFootprint.gw - 1),
    moverFootprint.gx - (trapFootprint.gx + trapFootprint.gw - 1),
    0,
  );
  const dy = Math.max(
    trapFootprint.gy - (moverFootprint.gy + moverFootprint.gh - 1),
    moverFootprint.gy - (trapFootprint.gy + trapFootprint.gh - 1),
    0,
  );
  return Math.max(dx, dy) <= 1 ? "detect" : "none";
}

const RANK_BY_NAME = { untrained: 0, trained: 1, expert: 2, master: 3, legendary: 4 };

/** #755: the minimum Perception proficiency rank a hazard's Stealth entry
 * lists (`system.attributes.stealth.details`, e.g. `<p>(trained)</p>`), as
 * 0..4, or `null` when none is listed. Only a clean, whole-text
 * parenthesised rank counts; anything else seen in pf2e.hazards
 * (`@Check[...]`, `(or 0 if ...)`, `or <em>detect magic</em>`, empty) is
 * "no minimum" rather than a guessed rank. */
export function trapMinProficiencyRank(stealthDetailsHtml) {
  if (typeof stealthDetailsHtml !== "string") return null;
  const text = stealthDetailsHtml.replace(/<[^>]*>/g, "").trim();
  const match = /^\((untrained|trained|expert|master|legendary)\)$/i.exec(text);
  return match ? RANK_BY_NAME[match[1].toLowerCase()] : null;
}

/** #755: PF2e RAW -- a hazard with no listed minimum proficiency gives every
 * character an automatic check; one with a minimum is checked only for a
 * character who is actively Searching and has at least that Perception rank. */
export function detectionEligibility({ minRank, searching, perceptionRank }) {
  if (minRank == null) return true;
  return searching === true && perceptionRank >= minRank;
}

/** #755: whether the mover's footprint is within `rangeSquares` of the
 * trap's -- Chebyshev distance between footprint edges (0 when overlapping). */
export function withinSearchRange(trapFootprint, moverFootprint, rangeSquares) {
  const dx = Math.max(
    trapFootprint.gx - (moverFootprint.gx + moverFootprint.gw - 1),
    moverFootprint.gx - (trapFootprint.gx + trapFootprint.gw - 1),
    0,
  );
  const dy = Math.max(
    trapFootprint.gy - (moverFootprint.gy + moverFootprint.gh - 1),
    moverFootprint.gy - (trapFootprint.gy + trapFootprint.gh - 1),
    0,
  );
  return Math.max(dx, dy) <= rangeSquares;
}

/**
 * Whether a trap-tagged hazard's own data is one this file's v1 automation
 * can actually run end-to-end: non-complex, exactly one ready strike-shaped
 * action, and at least one parseable disable check. Anything else needs GM
 * narration for now — see this file's own docblock for why that's a
 * deliberate v1 boundary, not a gap to silently paper over.
 */
export function isSimpleAutomatableTrap({
  isComplex,
  strikeActionCount,
  disableChecks,
}) {
  return !isComplex && strikeActionCount === 1 && disableChecks.length > 0;
}
