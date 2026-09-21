#!/usr/bin/env node
/**
 * MCP server exposing pending flavor-customization requests — trap (#136),
 * skill-challenge (#166), puzzle (#139), and narrative (#167) — to whatever
 * interactive agent session connects to it. Deliberately has no Anthropic
 * (or any LLM) dependency at all: content generation happens on the
 * connected session's own side, using whatever model it runs on, not a
 * hardcoded API call from this process. See #185 for why this replaced
 * `poll.mjs`'s old `tryCustomizeTrap`/`tryCustomizeSkillChallenge`
 * direct-API calls.
 *
 * Combat-turn decisions (`providers/claude.mjs`'s `decide`,
 * `providers/laya.mjs`) are NOT part of this — they stay on the fast,
 * automated path in `poll.mjs`, since they're bounded by a mid-combat
 * timeout an interactive session can't reliably beat.
 *
 * Run: node tools/agent-loop/mcp-server.mjs (stdio transport — registered
 * in this repo's .mcp.json so a Claude Code session opened here connects
 * automatically). Requires FOUNDRY_BASE_URL/FOUNDRY_REST_API_KEY, same as
 * poll.mjs — see README.md.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { runFoundryScript } from "./foundry-client.mjs";

const MODULE_ID = "deck-of-many-more-things";

export async function getPendingTrapCustomization(sceneId, opts = {}) {
  return runFoundryScript(
    `return game.modules.get('${MODULE_ID}').api.getPendingTrapCustomization(${JSON.stringify(sceneId ?? null)});`,
    opts,
  );
}

export async function applyTrapCustomization(
  actorId,
  customization,
  opts = {},
) {
  return runFoundryScript(
    `return game.modules.get('${MODULE_ID}').api.applyTrapCustomization(${JSON.stringify(actorId)}, ${JSON.stringify(customization)});`,
    opts,
  );
}

export async function getPendingSkillChallengeCustomization(
  sceneId,
  opts = {},
) {
  return runFoundryScript(
    `return game.modules.get('${MODULE_ID}').api.getPendingSkillChallengeCustomization(${JSON.stringify(sceneId ?? null)});`,
    opts,
  );
}

export async function applySkillChallengeCustomization(
  sceneId,
  roomId,
  customization,
  opts = {},
) {
  return runFoundryScript(
    `return game.modules.get('${MODULE_ID}').api.applySkillChallengeCustomization(${JSON.stringify(sceneId)}, ${JSON.stringify(roomId)}, ${JSON.stringify(customization)});`,
    opts,
  );
}

export async function getPendingPuzzleCustomization(sceneId, opts = {}) {
  return runFoundryScript(
    `return game.modules.get('${MODULE_ID}').api.getPendingPuzzleCustomization(${JSON.stringify(sceneId ?? null)});`,
    opts,
  );
}

export async function applyPuzzleCustomization(
  sceneId,
  roomId,
  customization,
  opts = {},
) {
  return runFoundryScript(
    `return game.modules.get('${MODULE_ID}').api.applyPuzzleCustomization(${JSON.stringify(sceneId)}, ${JSON.stringify(roomId)}, ${JSON.stringify(customization)});`,
    opts,
  );
}

export async function getPendingNarrativeCustomization(sceneId, opts = {}) {
  return runFoundryScript(
    `return game.modules.get('${MODULE_ID}').api.getPendingNarrativeCustomization(${JSON.stringify(sceneId ?? null)});`,
    opts,
  );
}

export async function applyNarrativeCustomization(
  sceneId,
  roomId,
  customization,
  opts = {},
) {
  return runFoundryScript(
    `return game.modules.get('${MODULE_ID}').api.applyNarrativeCustomization(${JSON.stringify(sceneId)}, ${JSON.stringify(roomId)}, ${JSON.stringify(customization)});`,
    opts,
  );
}

/** All four kinds share one scene-scoped query so a session can check "is
 * there anything to do" in a single call rather than four. Tags each
 * result with `kind` so the response is self-describing without the
 * caller having to remember which shape belongs to which submit tool. */
export async function listPendingCustomizations(sceneId, opts = {}) {
  const [trap, skillChallenge, puzzle, narrative] = await Promise.all([
    getPendingTrapCustomization(sceneId, opts),
    getPendingSkillChallengeCustomization(sceneId, opts),
    getPendingPuzzleCustomization(sceneId, opts),
    getPendingNarrativeCustomization(sceneId, opts),
  ]);
  const pending = [];
  if (trap) pending.push({ kind: "trap", ...trap });
  if (skillChallenge)
    pending.push({ kind: "skill_challenge", ...skillChallenge });
  if (puzzle) pending.push({ kind: "puzzle", ...puzzle });
  if (narrative) pending.push({ kind: "narrative", ...narrative });
  return pending;
}

export function buildServer() {
  const server = new McpServer({
    name: "foundry-agent-bridge",
    version: "1.0.0",
  });

  server.registerTool(
    "list_pending_customizations",
    {
      description:
        "List pending trap, skill-challenge, puzzle, and/or narrative flavor-customization requests for the current (or given) Foundry scene. Each entry's mechanical fields (trapLevel/partyLevel, specialtySkills/locationTag, a puzzle's stages skill/dc, or a narrative entry's archetype) are context only, for flavor to match — never rewrite gameplay values, only name/description/summary/flavor text.",
      inputSchema: {
        sceneId: z
          .string()
          .optional()
          .describe(
            "Scene id to check; defaults to the GM's currently-viewed scene.",
          ),
      },
    },
    async ({ sceneId }) => {
      const pending = await listPendingCustomizations(sceneId);
      return {
        content: [{ type: "text", text: JSON.stringify(pending, null, 2) }],
      };
    },
  );

  server.registerTool(
    "submit_trap_customization",
    {
      description:
        'Apply a new name and flavor description to a pending trap (an entry from list_pending_customizations with kind "trap", using its actorId). Never changes the trap\'s mechanics — name/description only.',
      inputSchema: {
        actorId: z.string(),
        name: z.string(),
        description: z.string(),
      },
    },
    async ({ actorId, name, description }) => {
      const result = await applyTrapCustomization(actorId, {
        name,
        description,
      });
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    },
  );

  server.registerTool(
    "submit_skill_challenge_customization",
    {
      description:
        "Apply a new name, summary, and per-skill flavor to a pending skill challenge (an entry from list_pending_customizations with kind \"skill_challenge\", using its sceneId/roomId). skillFlavor keys must be a subset of that entry's specialtySkills. Never changes the challenge's mechanics — name/summary/flavor text only.",
      inputSchema: {
        sceneId: z.string(),
        roomId: z.string(),
        name: z.string(),
        summary: z.string(),
        skillFlavor: z.record(z.string(), z.string()),
      },
    },
    async ({ sceneId, roomId, name, summary, skillFlavor }) => {
      const result = await applySkillChallengeCustomization(sceneId, roomId, {
        name,
        summary,
        skillFlavor,
      });
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    },
  );

  server.registerTool(
    "submit_puzzle_customization",
    {
      description:
        'Apply a new name, summary, and per-stage hint flavor to a pending puzzle (an entry from list_pending_customizations with kind "puzzle", using its sceneId/roomId). stageFlavor keys are stage indices (0-based, as strings) from that entry\'s own stages array. Never changes the puzzle\'s mechanics — each stage\'s own skill/dc, and how many stages must succeed, are fixed; only name/summary/hint flavor text can be rewritten.',
      inputSchema: {
        sceneId: z.string(),
        roomId: z.string(),
        name: z.string(),
        summary: z.string(),
        stageFlavor: z.record(z.string(), z.string()),
      },
    },
    async ({ sceneId, roomId, name, summary, stageFlavor }) => {
      const result = await applyPuzzleCustomization(sceneId, roomId, {
        name,
        summary,
        stageFlavor,
      });
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    },
  );

  server.registerTool(
    "submit_narrative_customization",
    {
      description:
        'Apply new content to a pending narrative room (an entry from list_pending_customizations with kind "narrative", using its sceneId/roomId). Only supply the fields matching that entry\'s own archetype: "lore" wants revealText; "ally" wants npcName and npcHook; "choice" wants exactly 2 options (each with a label and a consequence); "goal" wants suggestedObjective. name/summary always apply. Never changes anything mechanical — a narrative room has no mechanics beyond a single Continue action, so this is purely how it reads.',
      inputSchema: {
        sceneId: z.string(),
        roomId: z.string(),
        name: z.string(),
        summary: z.string(),
        revealText: z.string().optional(),
        npcName: z.string().optional(),
        npcHook: z.string().optional(),
        options: z
          .array(z.object({ label: z.string(), consequence: z.string() }))
          .length(2)
          .optional(),
        suggestedObjective: z.string().optional(),
      },
    },
    async ({
      sceneId,
      roomId,
      name,
      summary,
      revealText,
      npcName,
      npcHook,
      options,
      suggestedObjective,
    }) => {
      const result = await applyNarrativeCustomization(sceneId, roomId, {
        name,
        summary,
        revealText,
        npcName,
        npcHook,
        options,
        suggestedObjective,
      });
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    },
  );

  return server;
}

async function main() {
  const server = buildServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
