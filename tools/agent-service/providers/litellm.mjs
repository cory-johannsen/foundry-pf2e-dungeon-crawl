import { readEnvOrDotenv } from "../env.mjs";
import { nodeFetch } from "../node-fetch.mjs";
import { selectCombatTier } from "../tier-selection.mjs";

const DEFAULT_TIMEOUT_MS = 300000;

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
  return res.json();
}

export async function decide(
  context,
  {
    baseUrl = readEnvOrDotenv("LITELLM_BASE_URL") ?? "http://litellm:4000/v1",
    apiKey = readEnvOrDotenv("LITELLM_API_KEY"),
    timeoutMs = Number(readEnvOrDotenv("LITELLM_TIMEOUT_MS")) || DEFAULT_TIMEOUT_MS,
    fetchImpl = nodeFetch,
  } = {},
) {
  const candidateIds = context.candidates.map((c) => c.id);
  const model = selectCombatTier(context);

  const payload = await callLiteLLM(
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
  return { candidateId, rationale };
}
