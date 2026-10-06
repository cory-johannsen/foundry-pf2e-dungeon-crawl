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
    isGM = true,
    relay,
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
      if (room.puzzle.resolved || stages.every((s) => s.attempted)) {
        notify(localize("PF2EDC.Dungeon.Puzzle.DialogNothingToAttempt"));
        return;
      }
      const choice = await promptPuzzleStage(stages, characters);
      if (!choice?.actorId || !Number.isInteger(choice.stageIndex)) return;
      // A player never rolls locally: the GM client rolls AND records, so
      // the outcome can't be self-reported (and nothing rolls twice).
      if (isGM) {
        await attemptPuzzleStageFor(
          sceneId,
          roomId,
          choice.stageIndex,
          choice.actorId,
        );
      } else {
        // requestDungeonAction itself warns when the relay fails.
        await relay("attemptPuzzleStage", {
          sceneId,
          roomId,
          stageIndex: choice.stageIndex,
          actorId: choice.actorId,
        });
      }
    } else {
      if (!room?.challenge) return;
      const skills = room.challenge.specialtySkills;
      if (!characters?.length) {
        notify(localize("PF2EDC.Dungeon.SkillChallenge.DialogNoCharacters"));
        return;
      }
      if (
        room.challenge.resolved ||
        !Array.isArray(skills) ||
        skills.length === 0
      ) {
        notify(localize("PF2EDC.Dungeon.SkillChallenge.DialogNothingToAttempt"));
        return;
      }
      const choice = await promptSkillChallenge(skills, characters);
      if (!choice?.actorId || !choice?.skill) return;
      if (isGM) {
        await attemptSkillChallengeFor(sceneId, choice.actorId, choice.skill);
      } else {
        // requestDungeonAction itself warns when the relay fails.
        await relay("attemptSkillChallenge", {
          sceneId,
          roomId,
          actorId: choice.actorId,
          skill: choice.skill,
        });
      }
    }
  } finally {
    inFlight.delete(key);
  }
}

/**
 * The whole token click: reveal first (GM runs it directly, a player relays
 * `roomFeatureInteract`), then -- only if the reveal actually happened --
 * offer the check. `runAction` is the GM-side runRoomFeatureAction wrapper
 * (returns its `{ok}` result); `relay` is requestDungeonAction (resolves a
 * boolean). A failed reveal (GM errored / not acted on, or no GM answered
 * the relay) never opens the dialog.
 */
export async function handleRoomFeatureClick(route, deps) {
  const { isGM, runAction, relay, onError = () => {} } = deps;
  if (isGM) {
    try {
      const result = await runAction(route);
      if (result?.ok === false) return;
    } catch (err) {
      onError(err);
      return;
    }
  } else {
    const ok = await relay("roomFeatureInteract", route);
    if (!ok) return;
  }
  await promptRoomFeatureCheck(route, deps);
}
