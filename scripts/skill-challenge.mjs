/**
 * Foundry glue for core skill-challenge mechanics (#162) — the live-roll
 * half of skill-challenge-mechanics.mjs's pure Victory Point bookkeeping.
 * Kept in its own file rather than folded into dungeon-runner.mjs (state
 * persistence) or dungeon-combat.mjs (nothing here is a Combatant, same
 * reasoning trap-combat.mjs's own docblock already gives for traps).
 */

/** Suppresses PF2e's own check confirmation dialog for the duration of
 * `fn`, restoring whatever it was set to afterward — the exact same
 * pattern trap-combat.mjs's own withDialogsSuppressed already uses for
 * disable-check rolls. */
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
 * Rolls `actor`'s `skill` (a slug from `skill-challenge-mechanics.mjs`'s
 * `ALL_SKILLS`) against `dc` (`dcForAttempt`'s own output — this function
 * has no opinion on how the DC was derived) and returns `{outcome, dc,
 * skill}`, the shape `dungeon-runner.mjs`'s `recordSkillChallengeAttempt`
 * takes directly. `null` if `actor` doesn't actually have that skill (a
 * caller offering only real `ALL_SKILLS` slugs should never hit this, but
 * guarding rather than crashing on a bad slug matches every other roll
 * helper in this module).
 */
export async function rollSkillChallengeAttempt(actor, skill, dc) {
  const skillStat = actor.skills?.[skill];
  if (!skillStat) return null;
  return withCheckDialogSuppressed(async () => {
    await skillStat.roll({ dc: { value: dc }, createMessage: true });
    const outcome =
      game.messages.contents.at(-1)?.flags?.pf2e?.context?.outcome ?? null;
    return { outcome, dc, skill };
  });
}
