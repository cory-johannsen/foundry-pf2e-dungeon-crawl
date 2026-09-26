import { nodeFetch } from "./node-fetch.mjs";
import { readEnvOrDotenv } from "./env.mjs";
import { selectCustomizationTier } from "./tier-selection.mjs";

const DEFAULT_TIMEOUT_MS = 300000;

const SCHEMAS = {
  trap: {
    type: "object",
    properties: {
      name: { type: "string" },
      description: { type: "string" },
    },
    required: ["name", "description"],
  },
  skill_challenge: {
    type: "object",
    properties: {
      name: { type: "string" },
      summary: { type: "string" },
      skillFlavor: { type: "object", additionalProperties: { type: "string" } },
    },
    required: ["name", "summary", "skillFlavor"],
  },
  puzzle: {
    type: "object",
    properties: {
      name: { type: "string" },
      summary: { type: "string" },
      playerDescription: { type: "string" },
      stageFlavor: { type: "object", additionalProperties: { type: "string" } },
    },
    required: ["name", "summary", "playerDescription", "stageFlavor"],
  },
  narrative: {
    type: "object",
    properties: {
      name: { type: "string" },
      summary: { type: "string" },
      revealText: { type: "string" },
      npcName: { type: "string" },
      npcHook: { type: "string" },
      options: {
        type: "array",
        items: {
          type: "object",
          properties: {
            label: { type: "string" },
            consequence: { type: "string" },
          },
          required: ["label", "consequence"],
        },
        minItems: 2,
        maxItems: 2,
      },
      suggestedObjective: { type: "string" },
    },
    required: ["name", "summary"],
  },
  treasure: {
    type: "object",
    properties: {
      name: { type: "string" },
      summary: { type: "string" },
    },
    required: ["name", "summary"],
  },
};

// Per-kind tool descriptions. Defaults to a generic sentence; "narrative"
// overrides it with the archetype→field guidance that
// tools/agent-loop/mcp-server.mjs's retired submit_narrative_customization
// tool spelled out explicitly (see its description there). The narrative
// schema lists revealText/npcName/npcHook/options/suggestedObjective as
// siblings with no schema-level conditional gating — without this text the
// model has no way to know which archetype implies which optional field.
const TOOL_DESCRIPTIONS = {
  narrative:
    'Write flavor text for a Pathfinder 2e dungeon narrative room. Never invent mechanics — only name/summary/flavor text. Only supply the fields matching this entry\'s own archetype: "lore" wants revealText; "ally" wants npcName and npcHook; "choice" wants exactly 2 options (each with a label and a consequence); "goal" wants suggestedObjective. name/summary always apply.',
};

function toolDescription(kind) {
  return (
    TOOL_DESCRIPTIONS[kind] ??
    `Write flavor text for a Pathfinder 2e dungeon ${kind.replace("_", " ")}. Never invent mechanics — only name/description/summary/flavor text.`
  );
}

function userMessageContent(kind, context) {
  return `Write fitting flavor text for this ${kind.replace("_", " ")}, matching its mechanical context. Only fill fields that make sense for this entry.\n\n${JSON.stringify(context, null, 2)}`;
}

async function generateWithLiteLLM(kind, context, schema, { baseUrl, apiKey, timeoutMs, fetchImpl }) {
  const headers = { "Content-Type": "application/json" };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

  const res = await fetchImpl(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model: selectCustomizationTier(kind),
      messages: [{ role: "user", content: userMessageContent(kind, context) }],
      tools: [
        {
          type: "function",
          function: { name: "customize", description: toolDescription(kind), parameters: schema },
        },
      ],
      tool_choice: { type: "function", function: { name: "customize" } },
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (!res.ok) {
    const errBody = await res.text();
    throw new Error(`customization-generator: request failed (${res.status}): ${errBody}`);
  }

  const payload = await res.json();
  const rawArguments = payload.choices?.[0]?.message?.tool_calls?.[0]?.function?.arguments;
  if (!rawArguments) throw new Error("customization-generator: no customize tool call in response");
  try {
    return JSON.parse(rawArguments);
  } catch (err) {
    throw new Error(`customization-generator: tool call arguments were not valid JSON: ${err.message}`);
  }
}

/** Never changes gameplay values — only name/description/summary/flavor
 * text, mirroring the field-scoping rules tools/agent-loop/mcp-server.mjs's
 * submit_*_customization tools already enforced. `kind` selects which of
 * the five schemas is offered; the model can only fill fields real for
 * that kind.
 *
 * Always talks to the litellm sidecar over its OpenAI-compatible
 * chat-completions route, with per-kind tier selection (see
 * tier-selection.mjs) picking which model litellm routes to — this module
 * still never goes through resolveProvider()/providers/index.mjs itself,
 * because Laya cannot generate free text and must remain unreachable from
 * this route under any configuration. */
export async function generateCustomization(
  kind,
  context,
  {
    baseUrl = readEnvOrDotenv("LITELLM_BASE_URL") ?? "http://litellm:4000/v1",
    apiKey = readEnvOrDotenv("LITELLM_API_KEY"),
    timeoutMs = Number(readEnvOrDotenv("LITELLM_TIMEOUT_MS")) || DEFAULT_TIMEOUT_MS,
    fetchImpl = nodeFetch,
  } = {},
) {
  const schema = SCHEMAS[kind];
  if (!schema) throw new Error(`customization-generator: unknown kind "${kind}"`);
  return generateWithLiteLLM(kind, context, schema, { baseUrl, apiKey, timeoutMs, fetchImpl });
}
