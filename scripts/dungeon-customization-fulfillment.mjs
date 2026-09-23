import { fetchFlavorCustomization } from "./agent-service-client.mjs";
import { getPendingTrapCustomization, applyTrapCustomization } from "./trap-combat.mjs";
import {
  getPendingSkillChallengeCustomization,
  applySkillChallengeCustomization,
  getPendingPuzzleCustomization,
  applyPuzzleCustomization,
  getPendingNarrativeCustomization,
  applyNarrativeCustomization,
} from "./dungeon-runner.mjs";

const MODULE_ID = "pf2e-dungeon-crawl";

async function fulfillOne(kind, context, apply) {
  const settings = { baseUrl: undefined, apiKey: undefined };
  settings.baseUrl = game.settings.get(MODULE_ID, "agentServiceUrl");
  if (!settings.baseUrl) return;
  settings.apiKey = game.settings.get(MODULE_ID, "agentServiceApiKey");
  try {
    const result = await fetchFlavorCustomization({ ...settings, kind, context });
    await apply(result);
  } catch (err) {
    console.error(`agent-service: ${kind} customization failed, leaving template content:`, err.message);
  }
}

/**
 * Checks all four pending-customization kinds for `sceneId` and fulfills
 * whichever are pending via the hosted agent service — replaces the old
 * interactive-MCP-session flow (an agent connecting to
 * tools/agent-loop/mcp-server.mjs on its own schedule). Called
 * fire-and-forget from populateNextRoom (scripts/ui/dungeon-app.mjs) so it
 * never delays room population or reveal — a failed or slow call just
 * leaves the original template content in place, same as "nothing
 * fulfilled it in time" does today.
 */
export async function fulfillPendingCustomizations(sceneId) {
  const trap = getPendingTrapCustomization(sceneId);
  if (trap) {
    await fulfillOne("trap", trap, (result) => applyTrapCustomization(trap.actorId, result));
  }

  const skillChallenge = await getPendingSkillChallengeCustomization(sceneId);
  if (skillChallenge) {
    await fulfillOne("skill_challenge", skillChallenge, (result) =>
      applySkillChallengeCustomization(skillChallenge.sceneId, skillChallenge.roomId, result),
    );
  }

  const puzzle = await getPendingPuzzleCustomization(sceneId);
  if (puzzle) {
    await fulfillOne("puzzle", puzzle, (result) =>
      applyPuzzleCustomization(puzzle.sceneId, puzzle.roomId, result),
    );
  }

  const narrative = await getPendingNarrativeCustomization(sceneId);
  if (narrative) {
    await fulfillOne("narrative", narrative, (result) =>
      applyNarrativeCustomization(narrative.sceneId, narrative.roomId, result),
    );
  }
}
