/**
 * OpenRouter "decisions" adapter — a Laya replacement for combat decisions
 * (#454) using inception/mercury-decide:free. Same `decide()` interface and
 * the same request body as `providers/laya.mjs`, but POSTed to OpenRouter's
 * /api/alpha/decisions endpoint with a top-level `model`. Such models can't
 * go through litellm's chat/completions path (OpenRouter rejects it with a
 * 400), hence a dedicated provider.
 */

import { readEnvOrDotenv } from "../env.mjs";
import { truncatedCriteria } from "./laya.mjs";
import { usageMeta } from "./decision-meta.mjs";

export async function decide(context, {
  apiKey = readEnvOrDotenv('OPEN_ROUTER_API_KEY') ?? readEnvOrDotenv('OPENROUTER_API_KEY'),
  baseUrl = 'https://openrouter.ai/api/alpha',
  model = 'inception/mercury-decide:free',
  fetchImpl = fetch,
  timeoutMs = 30000
} = {}) {
  // Same ~20-candidate cap (and endTurn-preserving truncation) as Laya.
  const criteria = truncatedCriteria(context.candidates);
  const body = {
    model,
    state: { self: context.self, opponents: context.opponents, roundNumber: context.roundNumber },
    questions: {
      candidate: {
        type: 'choice',
        instructions: 'Given the current combat state, which action should the agent take?',
        criteria
      }
    }
  };

  const res = await fetchImpl(`${baseUrl}/decisions`, {
    method: 'POST',
    headers: {
      ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body),
    // Under Foundry's 45s AGENT_TIMEOUT_MS budget, so a stuck upstream
    // call becomes a prompt 502 instead of hanging the request.
    signal: AbortSignal.timeout(timeoutMs)
  });
  // Checked before parsing as JSON — an error response isn't guaranteed to
  // be JSON, and a parse error would mask the real status.
  if (!res.ok) {
    throw new Error(`openrouter-decisions provider: API request failed (${res.status}): ${await res.text()}`);
  }
  const payload = await res.json();

  const candidateId = payload.answers?.candidate?.choice;
  if (!Object.prototype.hasOwnProperty.call(criteria, candidateId)) {
    throw new Error(`openrouter-decisions provider: candidateId "${candidateId}" was not offered`);
  }
  // A decisions model never generates text — no rationale to report.
  // #952: the payload names the dated model version that answered and its
  // usage ({input_tokens, output_tokens, cost}, confirmed live 2026-10-09).
  const meta = {
    model: typeof payload.model === 'string' && payload.model ? payload.model : model,
    ...usageMeta(payload.usage)
  };
  return { candidateId, rationale: undefined, meta };
}
