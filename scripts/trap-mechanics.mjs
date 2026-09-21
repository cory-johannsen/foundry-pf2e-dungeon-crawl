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
