/**
 * Laya adapter for agent-controlled combat decisions — a second provider
 * alongside Claude (`providers/claude.mjs`), same `decide()` interface. Laya
 * (ConvAI Innovations' open-weight, non-autoregressive decision model)
 * answers typed `choice`/`score`/`bool` questions about a state blob in a
 * single forward pass, returning calibrated probabilities instead of
 * generated text — see #102 for the confirmed wire protocol this mirrors.
 */

import { readEnvOrDotenv } from '../foundry-client.mjs';

// Laya's `choice` question silently truncates each option's token budget
// past ~20 candidates rather than erroring — degrading accuracy with no
// warning. `endTurn` is always kept (the safe fallback) alongside the first
// 19 others rather than risk it being silently dropped from a long list.
const MAX_CRITERIA = 20;

function truncatedCriteria(candidates) {
  const endTurn = candidates.find((c) => c.id === 'endTurn');
  const others = candidates.filter((c) => c.id !== 'endTurn');
  const kept = endTurn ? [...others.slice(0, MAX_CRITERIA - 1), endTurn] : others.slice(0, MAX_CRITERIA);
  return Object.fromEntries(kept.map((c) => [c.id, c.summary]));
}

export async function decide(context, {
  apiKey = readEnvOrDotenv('LAYA_API_KEY'),
  baseUrl = readEnvOrDotenv('LAYA_BASE_URL') ?? 'https://laya.johannsen.cloud',
  fetchImpl = fetch
} = {}) {
  const criteria = truncatedCriteria(context.candidates);
  const body = {
    state: { self: context.self, opponents: context.opponents, roundNumber: context.roundNumber },
    questions: {
      candidate: {
        type: 'choice',
        instructions: 'Given the current combat state, which action should the agent take?',
        criteria
      }
    }
  };

  const res = await fetchImpl(`${baseUrl}/v1/predict`, {
    method: 'POST',
    headers: {
      ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  });
  // Checked before parsing as JSON — an error response isn't guaranteed to
  // be JSON (a 500 can come back as plain text), and res.json() throwing on
  // malformed input would otherwise replace a clear "500: ..." with a
  // confusing "Unexpected token" parse error.
  if (!res.ok) {
    throw new Error(`laya provider: API request failed (${res.status}): ${await res.text()}`);
  }
  const payload = await res.json();

  const candidateId = payload.answers?.candidate?.choice;
  if (!Object.prototype.hasOwnProperty.call(criteria, candidateId)) {
    throw new Error(`laya provider: candidateId "${candidateId}" was not offered`);
  }
  // Laya never generates text — no field to fill for `rationale`, left
  // unset per #102's own recommendation rather than faking one.
  return { candidateId, rationale: undefined };
}
