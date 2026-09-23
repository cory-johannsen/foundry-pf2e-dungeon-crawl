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
  const result = await fetchFlavorCustomization({ ...settings, kind, context });
  await apply(result);
}

/**
 * Runs a single kind's whole check-and-fulfill sequence (the getPending
 * lookup plus fulfillOne's fetch+apply) inside one try/catch, so a throw
 * anywhere in that sequence — including the getPending lookup itself —
 * is contained to this one kind. This is what lets
 * fulfillPendingCustomizations check/fulfill the other three kinds even
 * when one kind's getter or fetch/apply throws.
 */
async function fulfillKind(kind, getPending, apply) {
  try {
    const pending = await getPending();
    if (!pending) return;
    await fulfillOne(kind, pending, (result) => apply(pending, result));
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
 * fulfilled it in time" does today. Each kind is checked and fulfilled
 * inside its own try/catch (see fulfillKind), so a failure in one kind's
 * lookup, fetch, or apply step never prevents the other three kinds from
 * being checked and fulfilled in the same call, and this function itself
 * never throws.
 */
export async function fulfillPendingCustomizations(sceneId) {
  await fulfillKind(
    "trap",
    () => getPendingTrapCustomization(sceneId),
    (trap, result) => applyTrapCustomization(trap.actorId, result),
  );

  await fulfillKind(
    "skill_challenge",
    () => getPendingSkillChallengeCustomization(sceneId),
    (skillChallenge, result) =>
      applySkillChallengeCustomization(skillChallenge.sceneId, skillChallenge.roomId, result),
  );

  await fulfillKind(
    "puzzle",
    () => getPendingPuzzleCustomization(sceneId),
    (puzzle, result) => applyPuzzleCustomization(puzzle.sceneId, puzzle.roomId, result),
  );

  await fulfillKind(
    "narrative",
    () => getPendingNarrativeCustomization(sceneId),
    (narrative, result) => applyNarrativeCustomization(narrative.sceneId, narrative.roomId, result),
  );
}
