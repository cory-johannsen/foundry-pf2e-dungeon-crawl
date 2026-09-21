/**
 * Foundry glue for core puzzle mechanics (#137) — the live-roll half of
 * puzzle-mechanics.mjs's pure stage bookkeeping. Kept in its own file
 * rather than folded into dungeon-runner.mjs (state persistence), the
 * same split skill-challenge.mjs/skill-challenge-mechanics.mjs already
 * uses.
 *
 * Not simply `rollSkillChallengeAttempt` reused as-is, even though the two
 * are otherwise identical (roll `actor`'s `skill` against `dc`, return
 * `{outcome, dc, skill}`): confirmed live that Perception — the skill
 * `the_perfect_hand`'s own first hintCheck actually uses — isn't a PF2e
 * "skill" at all. It has no entry in `actor.skills`; it lives at the
 * standalone `actor.perception` statistic instead (same `.roll()` shape,
 * confirmed live). `rollSkillChallengeAttempt` never needs this special
 * case (`skill-challenge-mechanics.mjs`'s own `ALL_SKILLS` list excludes
 * Perception entirely, matching GM Core's own specialty-skill scope), so
 * this stays a separate function rather than teaching that one a puzzle-
 * specific exception.
 */

/** Same dialog-suppression pattern skill-challenge.mjs's own
 * withCheckDialogSuppressed already uses — kept as this file's own copy
 * rather than shared, matching how trap-combat.mjs also keeps its own. */
async function withCheckDialogSuppressed(fn) {
  const prevShowCheck = game.user.flags?.pf2e?.settings?.showCheckDialogs;
  await game.user.update({ "flags.pf2e.settings.showCheckDialogs": false });
  try {
    return await fn();
  } finally {
    await game.user.update({
      "flags.pf2e.settings.showCheckDialogs": prevShowCheck,
    });
  }
}

/**
 * Rolls `actor`'s `skill` (a lowercase PF2e slug — `puzzle-mechanics.mjs`'s
 * `initPuzzleState` already normalizes a stage's own `skill` to this
 * convention) against `dc` and returns `{outcome, dc, skill}`, the shape
 * `dungeon-runner.mjs`'s `recordPuzzleStageAttempt` takes directly.
 * `actor.perception` for the `"perception"` slug specifically (confirmed
 * live it's not in `actor.skills`), `actor.skills[skill]` for every other
 * real slug. `null` if the resolved statistic doesn't exist at all — a
 * caller offering only a puzzle's own real stage skills should never hit
 * this, but guarding rather than crashing matches every other roll helper
 * in this module.
 */
export async function rollPuzzleStageAttempt(actor, skill, dc) {
  const stat = skill === "perception" ? actor.perception : actor.skills?.[skill];
  if (!stat) return null;
  return withCheckDialogSuppressed(async () => {
    await stat.roll({ dc: { value: dc }, createMessage: true });
    const outcome =
      game.messages.contents.at(-1)?.flags?.pf2e?.context?.outcome ?? null;
    return { outcome, dc, skill };
  });
}
