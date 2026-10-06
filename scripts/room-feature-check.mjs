/**
 * #822: after a puzzle / skill-challenge room-feature token's reveal, offer
 * the matching skill-check attempt dialog -- the step #611/#623 never added,
 * which left the actual check stranded behind the tracker window's own form.
 * Foundry-free: every collaborator is injected (module.mjs wires the real
 * ones), so the decision logic is unit-testable in plain Node.
 */

const moduleInFlight = new Set();

/** Puzzle stages as the dialog wants them: the persisted stage list carries
 * only skill/dc/attempted, so add the index and a display label. */
export function puzzleStagesForDialog(stages, skillLabel) {
  return (stages ?? []).map((s, index) => ({
    index,
    skill: s.skill,
    dc: s.dc,
    label: skillLabel(s.skill),
    attempted: !!s.attempted,
  }));
}

/**
 * `route` is `{sceneId, roomId, kind}` from routeTargetTokenEvent. Resolves
 * once the dialog (and any attempt) is finished. Only puzzle and
 * skill_challenge kinds do anything; treasure is a no-op here. Shows a
 * notice (never a silent/empty dialog) when there is no party character or
 * nothing left to attempt. A per-room in-flight guard prevents stacked
 * dialogs from repeated clicks.
 */
export async function promptRoomFeatureCheck(
  route,
  {
    getRunState,
    characters,
    skillLabel,
    promptPuzzleStage,
    promptSkillChallenge,
    attemptPuzzleStageFor,
    attemptSkillChallengeFor,
    notify,
    localize,
    inFlight = moduleInFlight,
  },
) {
  const { sceneId, roomId, kind } = route ?? {};
  if (kind !== "puzzle" && kind !== "skill_challenge") return;
  const key = `${sceneId}:${roomId}`;
  if (inFlight.has(key)) return;
  inFlight.add(key);
  try {
    const room = getRunState(sceneId)?.rooms?.[roomId];
    if (kind === "puzzle") {
      if (!room?.puzzle) return;
      const stages = puzzleStagesForDialog(room.puzzle.stages, skillLabel);
      if (!characters?.length) {
        notify(localize("PF2EDC.Dungeon.Puzzle.DialogNoCharacters"));
        return;
      }
      if (stages.every((s) => s.attempted)) {
        notify(localize("PF2EDC.Dungeon.Puzzle.DialogNothingToAttempt"));
        return;
      }
      const choice = await promptPuzzleStage(stages, characters);
      if (!choice?.actorId || !Number.isInteger(choice.stageIndex)) return;
      await attemptPuzzleStageFor(
        sceneId,
        roomId,
        choice.stageIndex,
        choice.actorId,
      );
    } else {
      if (!room?.challenge) return;
      const skills = room.challenge.specialtySkills;
      if (!characters?.length) {
        notify(localize("PF2EDC.Dungeon.SkillChallenge.DialogNoCharacters"));
        return;
      }
      if (!Array.isArray(skills) || skills.length === 0) {
        notify(localize("PF2EDC.Dungeon.SkillChallenge.DialogNothingToAttempt"));
        return;
      }
      const choice = await promptSkillChallenge(skills, characters);
      if (!choice?.actorId || !choice?.skill) return;
      await attemptSkillChallengeFor(sceneId, choice.actorId, choice.skill);
    }
  } finally {
    inFlight.delete(key);
  }
}
