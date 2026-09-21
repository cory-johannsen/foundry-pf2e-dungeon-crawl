/**
 * Claude adapter for agent-controlled combat decisions — v1's only
 * provider (Laya tracked separately, #102, blocked on its own setup). Uses
 * tool-use with an enum of exactly the offered candidate ids, so a response
 * can't name something that was never on the list — no freeform-text
 * parsing to get wrong.
 *
 * Trap (#136) and skill-challenge (#166) flavor customization used to live
 * here too (a direct Anthropic API call). #185 moved that to
 * `mcp-server.mjs`, so an interactive agent session — any model, not a
 * hardcoded API call — fulfills those instead.
 */

import { readEnvOrDotenv } from "../foundry-client.mjs";

const CLAUDE_MODEL = "claude-sonnet-5";

async function callClaude(
  body,
  { apiKey = readEnvOrDotenv("ANTHROPIC_API_KEY"), fetchImpl = fetch } = {},
) {
  const res = await fetchImpl("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const payload = await res.json();
  if (!res.ok) {
    throw new Error(
      `claude provider: API request failed (${res.status}): ${payload?.error?.message ?? "unknown error"}`,
    );
  }
  return payload;
}

export async function decide(context, opts = {}) {
  const candidateIds = context.candidates.map((c) => c.id);
  const payload = await callClaude(
    {
      model: CLAUDE_MODEL,
      // Generous headroom above the ~50-100 tokens the tool_use block itself
      // needs: claude-sonnet-5's adaptive thinking tokens count against
      // max_tokens too, and with no explicit thinking/effort configuration a
      // small budget can be entirely consumed before the forced tool_use
      // block is ever emitted — surfacing as the same misleading "no
      // choose_action tool call" error below, just from a different cause.
      max_tokens: 4096,
      tools: [
        {
          name: "choose_action",
          description:
            "Choose exactly one candidate action for this combatant's turn.",
          input_schema: {
            type: "object",
            properties: {
              candidateId: { type: "string", enum: candidateIds },
              rationale: {
                type: "string",
                description: "One short sentence explaining the choice.",
              },
            },
            required: ["candidateId", "rationale"],
          },
        },
      ],
      tool_choice: { type: "tool", name: "choose_action" },
      messages: [
        {
          role: "user",
          content: `You are controlling an NPC's turn in a Pathfinder 2e combat. Pick the best candidate action.\n\n${JSON.stringify(context, null, 2)}`,
        },
      ],
    },
    opts,
  );

  const toolUse = payload.content?.find(
    (c) => c.type === "tool_use" && c.name === "choose_action",
  );
  if (!toolUse)
    throw new Error("claude provider: no choose_action tool call in response");

  const { candidateId, rationale } = toolUse.input;
  if (!candidateIds.includes(candidateId)) {
    throw new Error(
      `claude provider: candidateId "${candidateId}" was not offered`,
    );
  }
  return { candidateId, rationale };
}
