import { nodeFetch } from "./node-fetch.mjs";
import { readEnvOrDotenv } from "./env.mjs";

const DEFAULT_TIMEOUT_MS = 30000;

/**
 * #910: the response schema is built per request from the vocabulary
 * actually sent -- `type`/`slug` are constrained to the (deduped) values
 * present in that call's own vocabulary (maneuvers and/or feat/class
 * actions), never a fixed list. `targetId` is nullable because self-effect
 * feat picks (stances, Rage) target the actor itself. Foundry still
 * re-validates every pick against the exact vocabulary entries it sent.
 */
function buildSchema(vocabulary) {
  const types = [...new Set(vocabulary.map((v) => v.type))];
  const slugs = [...new Set(vocabulary.map((v) => v.slug))];
  return {
    type: "object",
    properties: {
      picks: {
        type: "array",
        items: {
          type: "object",
          properties: {
            type: { type: "string", enum: types },
            slug: { type: "string", enum: slugs },
            targetId: { type: ["string", "null"] },
            rationale: { type: "string", description: "One short sentence explaining the pick." },
          },
          required: ["type", "slug", "targetId", "rationale"],
        },
      },
    },
    required: ["picks"],
  };
}

function userMessageContent(context, vocabulary) {
  return `You are proposing tactical options (combat maneuvers and feat/class actions) for an AI-controlled combatant's turn in a Pathfinder 2e combat. Pick a tactically sensible subset of the vocabulary below (zero or more) — never propose anything not listed in it.\n\nEntries with type "feat" are the combatant's own feats/class actions. kind "selfEffect" entries (stances, Rage) apply a lasting effect to the combatant itself (send targetId null): prefer raising a stance or buff early in the round when a fight is on, and remember only one stance can be active at a time. kind "composite" entries (Sudden Charge, Lunge, Twin Feint) are Strike-based actions against the listed targetId. Respect each entry's action cost.\n\nContext:\n${JSON.stringify(context, null, 2)}\n\nVocabulary (every legal (type, slug, targetId) option this turn):\n${JSON.stringify(vocabulary, null, 2)}`;
}

/**
 * #909: the reasoning-model stage of the maneuver pipeline — always
 * litellm (never provider-selectable, mirroring customization-generator.mjs:
 * this needs genuine structured generation over a variable-shaped
 * vocabulary, not a fixed single choice, so Laya's typed choice/score/bool
 * questions don't fit here any more than they fit flavor-customization).
 * Foundry is the authoritative validator of the returned picks against the
 * vocabulary it sent (see scripts/agent-candidates.mjs's
 * buildManeuverCandidates) — this function trusts the schema and the
 * model's own restraint, nothing more.
 */
export async function generateCombatCandidates(
  context,
  vocabulary,
  {
    baseUrl = readEnvOrDotenv("LITELLM_BASE_URL") ?? "http://litellm:4000/v1",
    apiKey = readEnvOrDotenv("LITELLM_API_KEY"),
    timeoutMs = Number(readEnvOrDotenv("LITELLM_COMBAT_CANDIDATES_TIMEOUT_MS")) || DEFAULT_TIMEOUT_MS,
    fetchImpl = nodeFetch,
  } = {},
) {
  const headers = { "Content-Type": "application/json" };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

  const res = await fetchImpl(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model: "reasoning",
      messages: [{ role: "user", content: userMessageContent(context, vocabulary) }],
      tools: [
        {
          type: "function",
          function: {
            name: "propose_candidates",
            description: "Propose a tactically sensible subset of the offered maneuver/feat vocabulary.",
            parameters: buildSchema(vocabulary),
          },
        },
      ],
      tool_choice: { type: "function", function: { name: "propose_candidates" } },
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (!res.ok) {
    const errBody = await res.text();
    throw new Error(`candidate-generator: request failed (${res.status}): ${errBody}`);
  }

  const payload = await res.json();
  const rawArguments = payload.choices?.[0]?.message?.tool_calls?.[0]?.function?.arguments;
  if (!rawArguments) throw new Error("candidate-generator: no propose_candidates tool call in response");
  try {
    return JSON.parse(rawArguments);
  } catch (err) {
    throw new Error(`candidate-generator: tool call arguments were not valid JSON: ${err.message}`);
  }
}
