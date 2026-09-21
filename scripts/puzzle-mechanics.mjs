import { simpleDcForLevel } from "./skill-challenge-mechanics.mjs";

/**
 * Core puzzle mechanics (#137): the resolution model for a `puzzle`-kind
 * `dungeon-setpieces.json` entry, no Foundry dependency — same pure/glue
 * split every other room-kind pair in this module already uses
 * (`skill-challenge-mechanics.mjs`/`dungeon-runner.mjs`,
 * `trap-mechanics.mjs`/`trap-combat.mjs`).
 *
 * PF2e has no official puzzle subsystem the way GM Core's Victory Point
 * rules cover skill challenges — this file's model is this module's own
 * invention, close kin to `skill-challenge-mechanics.mjs`'s VP shape but
 * adapted to the real data a hand-authored puzzle entry already carries
 * (`hintChecks`: skill+DC+hint triples, confirmed live via `gh issue view
 * 137`'s own research that this field already exists in
 * `dungeon-setpieces.json` and was completely unread by any code before
 * this).
 *
 * Explicit v1 design calls (per live discussion):
 *   - Fully auto-resolving, no GM judgment call — each `hintCheck` becomes
 *     a *stage*; succeeding a stage's check both reveals its `hint` and
 *     counts toward a required-successes threshold. Reaching the
 *     threshold resolves the puzzle solved; the puzzle's own free-text
 *     `solution` field becomes narrative payoff shown once solved, not a
 *     GM-judged "did they get it right" check the way it reads in the
 *     source book.
 *   - One attempt per stage, ever — no retries, matching
 *     `skill-challenge-mechanics.mjs`'s per-check-outcome model and real
 *     puzzle flavor (you either notice the detail or you don't).
 *   - Stages are unordered — any not-yet-attempted stage can be attempted
 *     next, mirroring skill-challenge's own flexible-order model. No real
 *     puzzle content needs strict sequential gating today.
 *   - `requiredSuccesses` defaults to a majority (`ceil(n/2)`) of the
 *     stage count when a setpiece doesn't set its own — tunable, no
 *     rules-book anchor, same caveat `skill-challenge-mechanics.mjs`'s own
 *     `VP_TARGET` comment already makes; a party shouldn't need a
 *     perfect run to solve a puzzle any more than GM Core's own skill
 *     challenges expect one.
 *   - No separate attempt budget the way skill-challenge needs one — a
 *     puzzle's own stage count already bounds total attempts (each stage
 *     is attempted at most once), so resolution is fully determined once
 *     every stage has been attempted, or earlier once the threshold is
 *     hit or becomes mathematically unreachable.
 */

/** Majority (ceil of half) of `stageCount` — the default `requiredSuccesses`
 * for a puzzle that doesn't set its own. 0 for an empty stage list, rather
 * than 1, so a template with no hintChecks (already rejected by
 * `isValidPuzzleTemplate`) can't produce an impossible-to-solve puzzle if
 * somehow constructed anyway. */
export function defaultRequiredSuccesses(stageCount) {
  return Math.ceil((stageCount ?? 0) / 2);
}

/**
 * Whether `entry` (a `dungeon-setpieces.json` entry) is a usable puzzle
 * template — `kind === 'puzzle'` and at least one well-formed `hintChecks`
 * entry (a real `skill` string, a numeric `dc`, a `hint` string). Guards
 * rather than trusts a hand-authored JSON entry blindly, the same caution
 * `isValidSkillChallengeTemplate`/`isSimpleAutomatableTrap` already apply
 * to their own content sources.
 */
export function isValidPuzzleTemplate(entry) {
  return (
    entry?.kind === "puzzle" &&
    Array.isArray(entry.hintChecks) &&
    entry.hintChecks.length > 0 &&
    entry.hintChecks.every(
      (c) =>
        typeof c?.skill === "string" &&
        c.skill.length > 0 &&
        typeof c?.dc === "number" &&
        typeof c?.hint === "string" &&
        c.hint.length > 0,
    )
  );
}

/**
 * Fresh puzzle state from a template's own `hintChecks` — one stage per
 * check, in the same order, none attempted yet (each stage's own `skill`
 * lowercased to PF2e's slug convention, confirmed live the real data
 * doesn't already use it — see the inline comment below). `requiredSuccesses`
 * defaults to `defaultRequiredSuccesses` when not given explicitly (a
 * template entry may set its own via a `requiredSuccesses` field, for a
 * puzzle author who wants a stricter or looser threshold than the
 * default).
 */
export function initPuzzleState({
  hintChecks,
  requiredSuccesses = null,
  partyLevel = null,
  name = null,
  summary = null,
}) {
  // #138: hand-authored hintChecks carry the source book's own flat DC
  // (10 for both real entries) with an explicit note to scale it to the
  // actual party's level — unlike trap-library.mjs's own deliberate
  // choice NOT to rescale a picked trap's DC/damage (those are derived
  // stats off a compendium Actor, too risky to hand-rescale), a puzzle's
  // DC is just a plain number in hand-authored JSON, safe to replace
  // outright. Reuses skill-challenge-mechanics.mjs's own
  // simpleDcForLevel table rather than inventing a second one. Uniform
  // across every stage, matching skill_challenge's own "one DC for the
  // room" convention — no real puzzle content differentiates stage
  // difficulty today. `null` (the default) leaves each hintCheck's own
  // flat `dc` alone, for a caller that hasn't resolved a party level yet.
  const scaledDc = partyLevel != null ? simpleDcForLevel(partyLevel) : null;
  const stages = hintChecks.map((c) => ({
    // Lowercased to PF2e's own skill-slug convention — confirmed live the
    // real hand-authored hintChecks carry Title Case ("Perception",
    // "Society", ...), copied straight from the source book's own prose,
    // while every PF2e skill lookup (actor.skills, CONFIG.PF2E.skills)
    // keys on the lowercase slug. Normalized once here rather than at
    // every call site that reads stages[].skill.
    skill: (c.skill ?? "").toLowerCase(),
    dc: scaledDc ?? c.dc,
    hint: c.hint,
    attempted: false,
    succeeded: false,
  }));
  return {
    stages,
    requiredSuccesses: requiredSuccesses ?? defaultRequiredSuccesses(stages.length),
    successes: 0,
    attemptsUsed: 0,
    resolved: null, // null while in progress, else 'success' | 'failure'
    // #139: persisted at creation (from the setpiece template's own
    // name/summary, when given) rather than re-derived from the template
    // on every render, the same shape initSkillChallengeState's own
    // name/summary/skillFlavor already use — an external agent's
    // customization (#139, applyPuzzleCustomization) needs a stable place
    // to land and stick across renders.
    name,
    summary,
    stageFlavor: {},
  };
}

/**
 * One resolved reducer step: attempts `stageIndex`'s own check, marking it
 * succeeded on `"success"`/`"criticalSuccess"` (revealing its `hint` to
 * whatever caller reads `stages[stageIndex].hint` once `succeeded` is
 * true — this function doesn't itself do any hint delivery, just tracks
 * the state a caller renders from) or failed otherwise. Resolves
 * `"success"` the moment `successes` reaches `requiredSuccesses`, or
 * `"failure"` the moment reaching it becomes impossible (fewer
 * not-yet-attempted stages remain than still needed) — checked in that
 * order, so hitting the threshold on the party's very last available
 * stage still resolves as a win, matching
 * `applySkillChallengeAttempt`'s own "check success first" ordering.
 *
 * A no-op (returns `state` unchanged) if already resolved, if
 * `stageIndex` is out of range, or if that stage was already attempted —
 * the caller's own job to stop offering an attempted/resolved stage, this
 * is the belt-and-braces guarantee that calling it anyway can't
 * double-count a stage or flip an already-decided outcome.
 */
export function applyPuzzleStageAttempt(state, stageIndex, outcome) {
  if (state.resolved) return state;
  const stage = state.stages[stageIndex];
  if (!stage || stage.attempted) return state;

  const succeeded = outcome === "success" || outcome === "criticalSuccess";
  const stages = state.stages.map((s, i) =>
    i === stageIndex ? { ...s, attempted: true, succeeded } : s,
  );
  const successes = state.successes + (succeeded ? 1 : 0);
  const attemptsUsed = state.attemptsUsed + 1;
  const remainingStages = stages.filter((s) => !s.attempted).length;
  const resolved =
    successes >= state.requiredSuccesses
      ? "success"
      : successes + remainingStages < state.requiredSuccesses
        ? "failure"
        : null;
  return { ...state, stages, successes, attemptsUsed, resolved };
}
