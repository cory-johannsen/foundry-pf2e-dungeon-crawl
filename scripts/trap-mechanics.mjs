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
  basicSaveActionCount = 0,
  disableChecks,
}) {
  // #839: a hazard with no strike but a parseable basic-save-plus-damage
  // action is automatable too (triggerTrap's second branch).
  const runnable =
    strikeActionCount === 1 ||
    (strikeActionCount === 0 && basicSaveActionCount >= 1);
  return !isComplex && runnable && disableChecks.length > 0;
}

const SAVE_SLUGS = new Set(["reflex", "fortitude", "will"]);

/** The Effect paragraph (or the whole text when it has no Effect heading),
 * so Trigger-line wording is never mistaken for the effect. */
function effectText(html) {
  const m = /<strong>\s*Effect\s*<\/strong>/i.exec(html);
  return m ? html.slice(m.index + m[0].length) : html;
}

/** #839: plain text of a description -- tags dropped, PF2e enrichers turned
 * into their label (or a readable stand-in). */
export function plainDescriptionText(html) {
  if (typeof html !== "string") return "";
  return html
    .replace(
      /@(\w+)\[((?:[^[\]]|\[[^\]]*\])*)\](?:\{([^}]*)\})?/g,
      (_m, kind, inner, label) => {
        if (label) return label;
        if (/^template$/i.test(kind)) {
          const dist = /distance:(\d+)/.exec(inner);
          return dist ? `${dist[1]} feet` : inner.split("|")[0];
        }
        if (/^check$/i.test(kind)) {
          const [type, ...rest] = inner.split("|");
          const dc = rest.find((x) => x.startsWith("dc:"));
          return `${type}${dc ? ` DC ${dc.slice(3)}` : ""} check`;
        }
        return inner.split("|")[0];
      },
    )
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** #839: "creatures within N feet" stated by the hazard's own Effect text. */
export function parseAreaFeet(descriptionHtml) {
  if (typeof descriptionHtml !== "string") return null;
  const m = /creatures?\s+within\s+(\d+)\s+feet/i.exec(
    plainDescriptionText(effectText(descriptionHtml)),
  );
  return m ? Number(m[1]) : null;
}

const AREA_PHRASE = /(?:to\s+)?(?:all\s+|each\s+|every\s+)?(?:living\s+)?creatures?\s+within\s+\d+\s+feet/i;

/**
 * #839: parses a hazard action item's own description HTML for PF2e's own
 * inline-enricher syntax -- `@Check[<save>|dc:<n>|basic|...]` plus
 * `@Damage[<dice>d<faces>[<type>],...]`, optionally with an area phrase
 * ("creatures within N feet"). Returns null for anything outside this
 * narrow, confirmed shape -- no "basic" keyword, no parseable @Damage, or
 * no @Check at all -- rather than guessing at a hazard whose effect isn't
 * simple damage (a condition, banishment, initiative-rolling routine).
 * Deliberately does NOT resolve an area stated only via a referenced
 * spell's own stats (e.g. a hazard whose effect "casts Fireball" without
 * restating Fireball's own 20-foot burst in its own text) -- a known,
 * excluded case (#839's own plan), not a silent mis-parse.
 *
 * Also returns `traits` (the @Check's own `traits:`/`options:` segments, for
 * the save's roll options), `proneOnCritFail` (a "critically fail ... prone"
 * rider) and `unparsedText` (every other sentence after the save, so the
 * caller can tell the GM instead of silently dropping a rider).
 */
export function parseBasicSaveAction(descriptionHtml) {
  if (typeof descriptionHtml !== "string") return null;
  const checkMatch = /@Check\[([a-z]+)((?:\|[^\]]*)?)\]/i.exec(descriptionHtml);
  if (!checkMatch) return null;
  const save = checkMatch[1].toLowerCase();
  if (!SAVE_SLUGS.has(save)) return null;
  const segments = checkMatch[2].split("|").filter(Boolean);
  if (!segments.includes("basic")) return null;
  const dcSegment = segments.find((s) => s.startsWith("dc:"));
  const dc = dcSegment ? Number(dcSegment.slice(3)) : NaN;
  if (!Number.isFinite(dc)) return null;
  const listOf = (prefix) =>
    segments
      .filter((s) => s.startsWith(prefix))
      .flatMap((s) => s.slice(prefix.length).split(","))
      .map((x) => x.trim())
      .filter(Boolean);
  const traits = listOf("traits:");
  const options = listOf("options:");

  // The damage list nests one level of brackets (`3d6[fire]`), so the body is
  // any run of non-bracket characters or one `[...]` group.
  const damageMatch = /@Damage\[((?:[^[\]]|\[[^\]]*\])+)\]/i.exec(descriptionHtml);
  if (!damageMatch) return null;
  const damage = [];
  for (const part of damageMatch[1].split(",")) {
    const termMatch = /^\s*(\d+d\d+)\[([a-z-]+)\]\s*$/i.exec(part);
    if (!termMatch) return null; // an unrecognized damage shape -- stay conservative
    damage.push({ formula: termMatch[1], type: termMatch[2].toLowerCase() });
  }

  const areaFeet = parseAreaFeet(descriptionHtml);
  // An area the text names only by shape or via a referenced spell ("a
  // Fireball centered on ...", "in the area", a burst/radius) is one this
  // parser cannot size: stay conservative and let the guard rail handle it
  // rather than silently shrinking it to a single target.
  if (
    areaFeet === null &&
    /\b(?:fireball|burst|emanation|cone|radius|centered on)\b|\bin the area\b|\b(?:all|any|each|every) creatures?\b/i.test(
      plainDescriptionText(effectText(descriptionHtml)),
    )
  ) {
    return null;
  }

  // Everything after the save entry that is not the area phrase, the
  // "save" noise, or the prone rider is surfaced, never dropped.
  const afterCheck = descriptionHtml.slice(checkMatch.index + checkMatch[0].length);
  let proneOnCritFail = false;
  const unparsed = [];
  const residue = plainDescriptionText(afterCheck)
    .replace(AREA_PHRASE, " ")
    .replace(/^[\s)\].,;]*(?:saving throw|save)?[\s).]*/i, "");
  for (const raw of residue.split(/(?<=[.!?])\s+/)) {
    const sentence = raw.replace(/^[\s).,;]+|[\s]+$/g, "");
    if (!sentence || /^(?:saving throw|save)\W*$/i.test(sentence)) continue;
    if (/critically\s+fail[^.]*\bprone\b/i.test(sentence)) {
      proneOnCritFail = true;
      continue;
    }
    unparsed.push(sentence);
  }

  return {
    save,
    dc,
    damage,
    areaFeet,
    traits,
    options,
    proneOnCritFail,
    unparsedText: unparsed.join(" "),
  };
}

/** PF2e RAW basic-save degree-of-success damage scaling. */
export function basicSaveDamageMultiplier(outcome) {
  return { criticalSuccess: 0, success: 0.5, failure: 1, criticalFailure: 2 }[outcome] ?? 0;
}

/**
 * #839: distance in feet between two footprints ({gx, gy, gw, gh}) by PF2e's
 * diagonal counting (the first diagonal is 5 ft, the second 10 ft, and so
 * on): `gridDistance * (max(dx, dy) + floor(min(dx, dy) / 2))`, with dx/dy
 * the square gaps between the footprints' nearest edges (adjacent = 1, 0
 * when overlapping on that axis).
 */
export function footprintDistanceFeet(a, b, gridDistance = 5) {
  const dx = Math.max(a.gx - (b.gx + b.gw - 1), b.gx - (a.gx + a.gw - 1), 0);
  const dy = Math.max(a.gy - (b.gy + b.gh - 1), b.gy - (a.gy + a.gh - 1), 0);
  return gridDistance * (Math.max(dx, dy) + Math.floor(Math.min(dx, dy) / 2));
}
