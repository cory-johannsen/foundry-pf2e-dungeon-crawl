import { readEnvOrDotenv } from "../env.mjs";
import { nodeFetch } from "../node-fetch.mjs";
import { selectCombatTier } from "../tier-selection.mjs";
import { usageMeta } from "./decision-meta.mjs";

// Deliberately its own (shorter) default, separate from
// customization-generator.mjs's LITELLM_TIMEOUT_MS: kept well under
// Foundry's 35s client-side combat-decision timeout
// (scripts/agent-service-client.mjs's CLIENT_TIMEOUT_MS) and its 45s total
// AGENT_TIMEOUT_MS budget, so a stuck upstream call becomes a prompt 502
// instead of tying up Ollama's serial request queue.
const DEFAULT_COMBAT_TIMEOUT_MS = 30000;

async function callLiteLLM(body, { baseUrl, apiKey, timeoutMs, fetchImpl }) {
  const headers = { "Content-Type": "application/json" };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  const res = await fetchImpl(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    const errBody = await res.text();
    throw new Error(`litellm provider: API request failed (${res.status}): ${errBody}`);
  }
  return { payload: await res.json(), headers: res.headers };
}

/** #952: a response header's value, or undefined (a test double may carry
 * no `headers` at all). */
function headerValue(headers, name) {
  try {
    const value = headers?.get?.(name);
    return value === null || value === "" ? undefined : value;
  } catch {
    return undefined;
  }
}

export async function decide(
  context,
  {
    model = selectCombatTier(context),
    baseUrl = readEnvOrDotenv("LITELLM_BASE_URL") ?? "http://litellm:4000/v1",
    apiKey = readEnvOrDotenv("LITELLM_API_KEY"),
    timeoutMs = Number(readEnvOrDotenv("LITELLM_COMBAT_TIMEOUT_MS")) || DEFAULT_COMBAT_TIMEOUT_MS,
    fetchImpl = nodeFetch,
  } = {},
) {
  const candidateIds = context.candidates.map((c) => c.id);

  const { payload, headers } = await callLiteLLM(
    {
      model,
      messages: [
        {
          role: "user",
          content: `You are controlling an NPC's turn in a Pathfinder 2e combat. Pick the best candidate action.\n\n${JSON.stringify(context, null, 2)}`,
        },
      ],
      tools: [
        {
          type: "function",
          function: {
            name: "choose_action",
            description: "Choose exactly one candidate action for this combatant's turn.",
            parameters: {
              type: "object",
              properties: {
                candidateId: { type: "string", enum: candidateIds },
                rationale: { type: "string", description: "One short sentence explaining the choice." },
              },
              required: ["candidateId", "rationale"],
            },
          },
        },
      ],
      tool_choice: { type: "function", function: { name: "choose_action" } },
    },
    { baseUrl, apiKey, timeoutMs, fetchImpl },
  );

  const rawArguments = payload.choices?.[0]?.message?.tool_calls?.[0]?.function?.arguments;
  if (!rawArguments) throw new Error("litellm provider: no choose_action tool call in response");

  let parsed;
  try {
    parsed = JSON.parse(rawArguments);
  } catch (err) {
    throw new Error(`litellm provider: tool call arguments were not valid JSON: ${err.message}`);
  }

  const { candidateId, rationale } = parsed;
  if (!candidateIds.includes(candidateId)) {
    throw new Error(`litellm provider: candidateId "${candidateId}" was not offered`);
  }
  // #952: `model` here is the proxy's tier alias ("fast"/"reasoning",
  // litellm-config.yaml); the proxy names the real upstream model it routed
  // to in its x-litellm-model-name response header (confirmed live on the
  // deployed proxy, litellm 1.102.1), so `tier` and `model` differ whenever
  // that header is present. Usage and cost come from the payload's own
  // `usage` (cost passed through from OpenRouter), the response-cost header
  // only as a fallback.
  const meta = {
    tier: model,
    model: headerValue(headers, "x-litellm-model-name") ?? model,
    ...usageMeta(payload.usage, { fallbackCost: headerValue(headers, "x-litellm-response-cost") }),
  };
  return { candidateId, rationale, meta };
}
