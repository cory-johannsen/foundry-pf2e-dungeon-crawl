#!/usr/bin/env node
/**
 * Fires repeated realistic combat-decision requests at a named litellm
 * model and reports a real tool-calling success rate — built for #454's
 * validation of inception/mercury-decide:free, but takes any model name
 * so a future validation (e.g. #166's gliner-2.5-decider) can reuse it.
 *
 * Requires a running tools/agent-service + litellm stack reachable at
 * LITELLM_BASE_URL (default http://localhost:4000/v1 for a locally
 * `docker compose up`'d litellm, not the agent-service's own 8787 — this
 * talks to litellm directly, bypassing the HTTP auth layer agent-service
 * adds, since it's exercising decide() as a library call, not the
 * deployed /v1/combat-decision endpoint), and whatever that model's own
 * provider needs (e.g. OPENROUTER_API_KEY for an openrouter/* entry).
 *
 * Run: node tools/agent-service/validate-decision-model.mjs [modelName] [trialCount]
 *
 * With PROVIDER=<name> (e.g. PROVIDER=openrouter) it instead exercises that
 * providers/index.mjs provider's decide() directly, with its own defaults
 * (model, endpoint, key) — modelName is ignored.
 */
import { decide as decideLitellm } from "./providers/litellm.mjs";
import { resolveProvider } from "./providers/index.mjs";
import { readEnvOrDotenv } from "./env.mjs";

const MODEL_NAME = process.argv[2] ?? "mercury-decide";
const PROVIDER = process.env.PROVIDER;
const TRIAL_COUNT = Number(process.argv[3]) || 10;
// Free-tier OpenRouter models rate-limit aggressively; this delay keeps a
// genuine tool-calling-reliability signal from being swamped by 429s that
// are really about request pacing, not the model itself (see this plan's
// Review Focus).
const DELAY_BETWEEN_TRIALS_MS = 2000;

const SAMPLE_CONTEXT = {
  self: { name: "Test Combatant", hp: 24, conditions: [] },
  opponents: [
    { id: "opp1", name: "Fighter", distanceSquares: 1, hp: 30 },
    { id: "opp2", name: "Wizard", distanceSquares: 3, hp: 18 },
  ],
  candidates: [
    { id: "strike:claw:opp1", summary: "Claw vs Fighter (variant 0)" },
    { id: "stride:approach:opp2", summary: "Approach Wizard" },
    { id: "endTurn", summary: "End turn" },
  ],
  roundNumber: 2,
};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRateLimitError(err) {
  return /429|rate limit/i.test(err.message);
}

async function runTrial(baseUrl, apiKey) {
  try {
    const result = PROVIDER
      ? await resolveProvider(PROVIDER)(SAMPLE_CONTEXT)
      : await decideLitellm(SAMPLE_CONTEXT, { model: MODEL_NAME, baseUrl, apiKey });
    return { ok: true, result };
  } catch (err) {
    return { ok: false, rateLimited: isRateLimitError(err), error: err.message };
  }
}

async function main() {
  const baseUrl = readEnvOrDotenv("LITELLM_BASE_URL") ?? "http://localhost:4000/v1";
  const apiKey = readEnvOrDotenv("LITELLM_API_KEY");

  console.log(`validate-decision-model: running ${TRIAL_COUNT} trials against ${PROVIDER ? `provider "${PROVIDER}"` : `"${MODEL_NAME}" via ${baseUrl}`}`);

  const results = [];
  for (let i = 0; i < TRIAL_COUNT; i += 1) {
    const result = await runTrial(baseUrl, apiKey);
    results.push(result);
    console.log(
      `  trial ${i + 1}/${TRIAL_COUNT}: ${result.ok ? `OK (${result.result.candidateId})` : `FAIL (${result.error})`}`,
    );
    if (i < TRIAL_COUNT - 1) await sleep(DELAY_BETWEEN_TRIALS_MS);
  }

  const succeeded = results.filter((r) => r.ok).length;
  const rateLimited = results.filter((r) => !r.ok && r.rateLimited).length;
  const otherFailures = results.length - succeeded - rateLimited;

  console.log("\nSummary:");
  console.log(`  succeeded: ${succeeded}/${results.length}`);
  console.log(`  rate-limited: ${rateLimited}/${results.length}`);
  console.log(`  other failures: ${otherFailures}/${results.length}`);
}

main();
