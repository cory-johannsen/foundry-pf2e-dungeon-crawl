import { readEnvOrDotenv } from "./env.mjs";

const CLAUDE_MODEL = "claude-sonnet-5";

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
          properties: { label: { type: "string" }, consequence: { type: "string" } },
          required: ["label", "consequence"],
        },
        minItems: 2,
        maxItems: 2,
      },
      suggestedObjective: { type: "string" },
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

/** Never changes gameplay values — only name/description/summary/flavor
 * text, mirroring the field-scoping rules tools/agent-loop/mcp-server.mjs's
 * submit_*_customization tools already enforced. `kind` selects which of
 * the four schemas is offered; the model can only fill fields real for
 * that kind.
 *
 * This module always calls the Claude Messages API directly — it never
 * goes through resolveProvider()/providers/index.mjs. Laya cannot
 * generate free text, so flavor-customization generation must not be
 * routable to the Laya provider under any provider-selection
 * configuration. */
export async function generateCustomization(
  kind,
  context,
  { apiKey = readEnvOrDotenv("ANTHROPIC_API_KEY"), fetchImpl = fetch } = {},
) {
  const schema = SCHEMAS[kind];
  if (!schema) throw new Error(`customization-generator: unknown kind "${kind}"`);

  const res = await fetchImpl("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: CLAUDE_MODEL,
      max_tokens: 4096,
      tools: [
        {
          name: "customize",
          description: toolDescription(kind),
          input_schema: schema,
        },
      ],
      tool_choice: { type: "tool", name: "customize" },
      messages: [
        {
          role: "user",
          content: `Write fitting flavor text for this ${kind.replace("_", " ")}, matching its mechanical context. Only fill fields that make sense for this entry.\n\n${JSON.stringify(context, null, 2)}`,
        },
      ],
    }),
  });

  if (!res.ok) {
    const errBody = await res.text();
    throw new Error(`customization-generator: API request failed (${res.status}): ${errBody}`);
  }

  const payload = await res.json();
  const toolUse = payload.content?.find((c) => c.type === "tool_use" && c.name === "customize");
  if (!toolUse) throw new Error("customization-generator: no customize tool call in response");
  return toolUse.input;
}
