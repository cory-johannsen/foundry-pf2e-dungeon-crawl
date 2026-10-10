/**
 * #952: normalizes a provider's own token-usage report into the decision
 * response's `meta` fields -- `{ usage?: {promptTokens, completionTokens,
 * totalTokens}, costUsd? }`, every field omitted when the provider didn't
 * report it (never guessed, never NaN). Two real shapes, both confirmed
 * against live responses on 2026-10-09:
 *   - litellm's OpenAI-compatible chat/completions `usage`:
 *     `{prompt_tokens, completion_tokens, total_tokens, cost}` (`cost` is
 *     passed through from OpenRouter by the deployed proxy);
 *   - OpenRouter's /api/alpha/decisions `usage`:
 *     `{input_tokens, output_tokens, cost}` (no total).
 * `fallbackCost` is a cost reported elsewhere (litellm's response-cost
 * header), used only when the payload carries none.
 */

function finiteNumber(value) {
  if (value === null || value === undefined || value === "") return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

export function usageMeta(usage, { fallbackCost } = {}) {
  const out = {};
  const u = usage && typeof usage === "object" ? usage : {};
  const promptTokens = finiteNumber(u.prompt_tokens ?? u.input_tokens);
  const completionTokens = finiteNumber(u.completion_tokens ?? u.output_tokens);
  let totalTokens = finiteNumber(u.total_tokens);
  if (totalTokens === undefined && promptTokens !== undefined && completionTokens !== undefined) {
    totalTokens = promptTokens + completionTokens;
  }
  const tokens = {};
  if (promptTokens !== undefined) tokens.promptTokens = promptTokens;
  if (completionTokens !== undefined) tokens.completionTokens = completionTokens;
  if (totalTokens !== undefined) tokens.totalTokens = totalTokens;
  if (Object.keys(tokens).length) out.usage = tokens;
  const costUsd = finiteNumber(u.cost) ?? finiteNumber(fallbackCost);
  if (costUsd !== undefined) out.costUsd = costUsd;
  return out;
}
