#!/usr/bin/env node
/**
 * Polls the live Foundry world (via the self-hosted foundry-rest relay) for
 * an agent-controlled combatant's due turn, asks the configured provider
 * which candidate to take, and applies it — repeating until that turn is
 * over, then waiting POLL_INTERVAL_MS before checking again. No Foundry
 * mutation happens anywhere in this file except through
 * module.api.applyAgentDecision.
 *
 * Trap (#136) and skill-challenge (#166) flavor customization used to live
 * here too, calling the Anthropic API directly. #185 moved that to
 * `mcp-server.mjs` instead, so an interactive agent session (any model, not
 * a hardcoded API call from this background process) fulfills those —
 * combat-turn decisions stay here because they're bounded by a mid-combat
 * timeout an interactive session can't reliably beat.
 *
 * Run: node tools/agent-loop/poll.mjs
 * Requires: FOUNDRY_REST_API_KEY, FOUNDRY_BASE_URL (your self-hosted relay),
 * ANTHROPIC_API_KEY (only if DOMMT_AGENT_PROVIDER=claude) — see README.md.
 */
import { runFoundryScript, readEnvOrDotenv } from "./foundry-client.mjs";
import { resolveProvider } from "./providers/index.mjs";

const POLL_INTERVAL_MS = Number(
  readEnvOrDotenv("DOMMT_POLL_INTERVAL_MS") ?? 3000,
);
const AGENT_PROVIDER_NAME = readEnvOrDotenv("DOMMT_AGENT_PROVIDER") ?? "claude";
const MODULE_ID = "deck-of-many-more-things";

async function getPendingTurn() {
  return runFoundryScript(
    `return await game.modules.get('${MODULE_ID}').api.getPendingAgentTurn();`,
  );
}

async function applyDecision(combatId, combatantId, candidateId, rationale) {
  return runFoundryScript(
    `return game.modules.get('${MODULE_ID}').api.applyAgentDecision(${JSON.stringify(combatId)}, ${JSON.stringify(combatantId)}, ${JSON.stringify(candidateId)}, ${JSON.stringify(rationale ?? null)});`,
  );
}

// #113: pinged once per outer loop iteration (see main()), independent of
// whether there's a pending turn — the only way Foundry can tell "the
// poller is running but nothing's due yet" apart from "the poller isn't
// running at all."
async function recordHeartbeat() {
  return runFoundryScript(
    `return game.modules.get('${MODULE_ID}').api.recordAgentLoopHeartbeat(${JSON.stringify({ provider: AGENT_PROVIDER_NAME, pollIntervalMs: POLL_INTERVAL_MS })});`,
  );
}

async function playOnePendingTurnToCompletion(decide) {
  let pending = await getPendingTurn();
  while (pending) {
    let decision;
    try {
      decision = await decide(pending.context, { fetchImpl: fetch });
    } catch (err) {
      console.error(
        "agent-loop: provider error, skipping this cycle:",
        err.message,
      );
      return; // let Foundry's own per-action timeout fallback handle it
    }
    console.log(
      `agent-loop: chose ${decision.candidateId} (${decision.rationale ?? "no rationale"})`,
    );
    try {
      pending = await applyDecision(
        pending.combatId,
        pending.combatantId,
        decision.candidateId,
        decision.rationale,
      );
    } catch (err) {
      console.error(
        "agent-loop: applyAgentDecision failed, skipping this cycle:",
        err.message,
      );
      return;
    }
  }
}

// #115: after this many consecutive failed cycles (heartbeat or poll, each
// counts), log one louder warning per streak rather than letting the same
// "will retry" line scroll by forever — a GM/dev watching the terminal
// should be able to tell "still retrying normally" apart from "this has
// been stuck a while and might need a restart" without counting lines.
const CONSECUTIVE_FAILURE_WARN_THRESHOLD = 10;
let consecutiveFailures = 0;
let warnedThisStreak = false;

function noteCycleOutcome(ok) {
  if (ok) {
    consecutiveFailures = 0;
    warnedThisStreak = false;
    return;
  }
  consecutiveFailures += 1;
  if (
    consecutiveFailures >= CONSECUTIVE_FAILURE_WARN_THRESHOLD &&
    !warnedThisStreak
  ) {
    warnedThisStreak = true;
    const approxSeconds = Math.round(
      (consecutiveFailures * POLL_INTERVAL_MS) / 1000,
    );
    console.error(
      `agent-loop: ${consecutiveFailures} consecutive relay failures (~${approxSeconds}s) — this may need attention beyond automatic retry (check the relay/self-hosted service, or restart this process).`,
    );
  }
}

async function main() {
  const decide = resolveProvider();
  console.log(
    `agent-loop: polling every ${POLL_INTERVAL_MS}ms with provider "${AGENT_PROVIDER_NAME}"`,
  );
  for (;;) {
    let cycleOk = true;
    try {
      await recordHeartbeat();
    } catch (err) {
      cycleOk = false;
      console.error(
        "agent-loop: heartbeat failed (Foundry may be unreachable):",
        err.message,
      );
    }
    try {
      await playOnePendingTurnToCompletion(decide);
    } catch (err) {
      cycleOk = false;
      console.error("agent-loop: poll cycle failed, will retry:", err.message);
    }
    noteCycleOutcome(cycleOk);
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
}

main();
