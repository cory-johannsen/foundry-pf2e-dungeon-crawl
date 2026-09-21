# tools/agent-loop

Polls a live Foundry world for agent-controlled combatants' turns and plays
them via an LLM, instead of ITEM-8's fixed "move toward nearest, strike
once" heuristic. See `docs/superpowers/specs/2026-09-20-agent-bridge-combat-ai-design.md`
for the full design.

## Setup

1. **Self-host the relay** (avoids the public `foundryrestapi.com` relay's
   100 requests/month free-tier limit — this polls every few seconds):

   ```bash
   git clone https://github.com/ThreeHats/foundryvtt-rest-api-relay
   cd foundryvtt-rest-api-relay
   docker compose up -d
   ```

   Point Foundry's own `foundryvtt-rest-api` module at this relay instead of
   the public one (module settings → Relay URL).

2. **Environment variables** (a `.env` in the repo root, or the shell
   environment):

   ```
   FOUNDRY_BASE_URL=http://localhost:<your relay port>
   FOUNDRY_REST_API_KEY=<your relay's key>
   ANTHROPIC_API_KEY=<your Claude API key, only needed for combat-turn decisions>
   ```

   `FOUNDRY_CLIENT_ID` and `DOMMT_AGENT_PROVIDER` (default `claude`) and
   `DOMMT_POLL_INTERVAL_MS` (default `3000`) are optional overrides.

   **To use Laya instead of Claude** (`DOMMT_AGENT_PROVIDER=laya`), add:

   ```
   LAYA_API_KEY=<your Laya deployment's key, if auth is enabled>
   LAYA_BASE_URL=<your Laya deployment, default https://laya.johannsen.cloud>
   ```

   Laya never generates a `rationale` (it's non-autoregressive, calibrated
   probabilities only) — decisions still work, just without the "why" text
   Claude's adapter includes.

3. **Run it** alongside your Foundry session:
   ```bash
   node tools/agent-loop/poll.mjs
   ```

Leave it running for the length of a session. If it's not running (or
crashes), agent-controlled combatants still act — Foundry falls back to the
default heuristic after `AGENT_TIMEOUT_MS` (45s) and tells you so in chat,
distinguishing "the poller is running but didn't respond in time" from "the
poller doesn't appear to be running at all" (#113) using the heartbeat
below.

## Checking whether it's actually running (#113)

The poller pings a heartbeat into the world once per loop iteration, so a
GM can check its status without watching this terminal: click the robot
icon in the token scene controls, or run
`game.modules.get('deck-of-many-more-things').api.postAgentLoopStatus()`
from the console. Both post a GM-whispered chat card saying whether it's
connected, stale (was running, hasn't checked in recently), or never seen
this session.

## If it stops recovering after a relay hiccup (#115)

Every request sends `Connection: close`, so a dropped-then-restored relay
connection can't leave the poller stuck reusing a dead pooled socket — each
retry opens a fresh connection instead. If it still won't recover after a
relay blip, the terminal logs a louder warning once 10 poll cycles in a row
have failed; at that point, restarting the process (`Ctrl-C`, then
`node tools/agent-loop/poll.mjs` again) is the known-working fix.

## Flavor customization: trap (#136), skill-challenge (#166), puzzle (#139), and narrative (#167) content, via MCP (#185)

Unlike combat-turn decisions, flavor customization (a trap's name and
description; a skill-challenge room's name, summary, and per-skill flavor
text; a puzzle's name, summary, and per-stage hint flavor; a narrative
room's name, summary, and whichever archetype-specific field it uses)
doesn't come from a hardcoded API call in `poll.mjs`. It comes from
whatever _interactive agent session_ connects to `tools/agent-loop/mcp-server.mjs`
— any model, your choice, not locked to Claude/Anthropic. This is the
actual point of the "agent bridge" name: the poller automates the
time-critical stuff (combat, bounded by `AGENT_TIMEOUT_MS`), and everything
that isn't time-critical is left for an agent session to pick up and
fulfill on its own schedule.

**Run the MCP server** (separately from `poll.mjs` — it needs no
`ANTHROPIC_API_KEY` at all, only the same `FOUNDRY_BASE_URL`/
`FOUNDRY_REST_API_KEY` the poller uses):

```bash
node tools/agent-loop/mcp-server.mjs
```

It's already registered in this repo's `.mcp.json`, so a Claude Code
session opened here connects to it automatically. It exposes five tools:

- `list_pending_customizations` — any pending trap, skill-challenge,
  puzzle, and/or narrative customization request for the current (or a
  given) scene.
- `submit_trap_customization(actorId, name, description)`
- `submit_skill_challenge_customization(sceneId, roomId, name, summary, skillFlavor)`
- `submit_puzzle_customization(sceneId, roomId, name, summary, stageFlavor)`
- `submit_narrative_customization(sceneId, roomId, name, summary, ...archetype-specific fields)`
  — only the fields matching that entry's own `archetype` apply:
  `revealText` (lore), `npcName`+`npcHook` (ally), `options` (choice,
  exactly 2 `{label, consequence}` pairs), or `suggestedObjective` (goal).

A GM (or anyone with an MCP-connected session) just asks their agent to
"check for and fulfill any pending dungeon customizations" — the agent
calls `list_pending_customizations`, writes fitting content for whatever
comes back, and submits it. If nothing does, the room/trap keeps its
original template content — the same graceful degradation the combat-AI
half already relies on, and never anything that blocks room reveal or
discovery.

One real timing difference among the kinds: a trap spawns hidden (#135),
with a genuine window to customize it before the party ever reaches its
door. A skill-challenge, puzzle, or narrative room's content is shown the
instant the room becomes current, so there's no such window — the party
may see the un-customized name/summary first and see it change in place
only if and when a customization lands before the Dungeon Crawl tracker
next re-renders. Accepted as the honest trade-off rather than blocking
room display on it.
