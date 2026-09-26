import { fetchFlavorCustomization } from "./agent-service-client.mjs";
import {
  getPendingTrapCustomization,
  applyTrapCustomization,
} from "./trap-combat.mjs";
import {
  getPendingSkillChallengeCustomization,
  applySkillChallengeCustomization,
  getPendingPuzzleCustomization,
  applyPuzzleCustomization,
  getPendingNarrativeCustomization,
  applyNarrativeCustomization,
  getPendingTreasureCustomization,
  applyTreasureCustomization,
} from "./dungeon-runner.mjs";

const MODULE_ID = "pf2e-dungeon-crawl";

async function fulfillOne(kind, context, apply) {
  const settings = { baseUrl: undefined, apiKey: undefined };
  settings.baseUrl = game.settings.get(MODULE_ID, "agentServiceUrl");
  if (!settings.baseUrl) return false;
  settings.apiKey = game.settings.get(MODULE_ID, "agentServiceApiKey");
  const result = await fetchFlavorCustomization({ ...settings, kind, context });
  await apply(result);
  return true;
}

/**
 * Runs a single kind's whole check-and-fulfill sequence (the getPending
 * lookup plus fulfillOne's fetch+apply), each step inside its own
 * try/catch, so a throw anywhere in that sequence — including the
 * getPending lookup itself — is contained to this one kind. This is what
 * lets fulfillPendingCustomizations check/fulfill the other kinds even
 * when one kind's getter or fetch/apply throws.
 *
 * #93 fix round 1: loop this kind until nothing is left pending, instead
 * of handling only the first — full pregeneration can leave several rooms
 * of the same kind pending at once (the original one-room-per-call design
 * assumed the old populateNextRoom's "exactly one new room at a time"
 * caller). Capped defensively (MAX_PENDING_PER_KIND) so a getPending/apply
 * bug that never actually clears "pending" can't spin forever; no real
 * dungeon has anywhere near this many rooms of one kind. Stops (rather
 * than continuing to the next iteration) on any error, so a persistently
 * failing room isn't retried in a tight loop within the same call — it'll
 * get another chance whenever this function is next invoked. Also stops
 * when fulfillOne skipped applying (no agent service configured) — the
 * same room would otherwise stay pending and be re-read on every
 * iteration up to the cap for nothing.
 */
const MAX_PENDING_PER_KIND = 50;

async function fulfillKind(kind, getPending, apply) {
  for (let i = 0; i < MAX_PENDING_PER_KIND; i += 1) {
    let pending;
    try {
      pending = await getPending();
    } catch (err) {
      console.error(
        `agent-service: ${kind} customization failed, leaving template content:`,
        err.message,
      );
      return;
    }
    if (!pending) return;
    try {
      const applied = await fulfillOne(kind, pending, (result) =>
        apply(pending, result),
      );
      if (!applied) return;
    } catch (err) {
      console.error(
        `agent-service: ${kind} customization failed, leaving template content:`,
        err.message,
      );
      return;
    }
  }
}

/**
 * Checks all five pending-customization kinds for `sceneId` and fulfills
 * whichever are pending via the hosted agent service — replaces the old
 * interactive-MCP-session flow (an agent connecting to
 * tools/agent-loop/mcp-server.mjs on its own schedule). Called
 * fire-and-forget from startDungeonRun (scripts/ui/dungeon-app.mjs), once,
 * after the whole graph is pregenerated (#93), so it never delays room
 * population or reveal — a failed or slow call just
 * leaves the original template content in place, same as "nothing
 * fulfilled it in time" does today. Each kind is checked and fulfilled
 * inside its own try/catch (see fulfillKind), so a failure in one kind's
 * lookup, fetch, or apply step never prevents the other four kinds from
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
      applySkillChallengeCustomization(
        skillChallenge.sceneId,
        skillChallenge.roomId,
        result,
      ),
  );

  await fulfillKind(
    "puzzle",
    () => getPendingPuzzleCustomization(sceneId),
    (puzzle, result) =>
      applyPuzzleCustomization(puzzle.sceneId, puzzle.roomId, result),
  );

  await fulfillKind(
    "narrative",
    () => getPendingNarrativeCustomization(sceneId),
    (narrative, result) =>
      applyNarrativeCustomization(narrative.sceneId, narrative.roomId, result),
  );

  await fulfillKind(
    "treasure",
    () => getPendingTreasureCustomization(sceneId),
    (treasure, result) =>
      applyTreasureCustomization(treasure.sceneId, treasure.roomId, result),
  );
}
