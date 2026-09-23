# Hosted agent service — replacing the relay + local poller — design

**Tracks:** [#105](https://github.com/cory-johannsen/foundry-pf2e-dungeon-crawl/issues/105)

**Related, filed as a separate follow-up (out of scope here):** GM-in-the-loop
removal for `scripts/dungeon-remote.mjs`'s GM-less mutation routing
(room population, follow-the-leader movement, etc.) — same "must have a
live privileged client connected" problem category as this issue, already
implicated in #65 and #87, but a different subsystem (privilege routing
between connected Foundry clients, not LLM decision-making) with its own
bug history. Filed as a companion issue that references this spec's
architecture where relevant.

## Problem

Combat-turn AI decisions (`docs/superpowers/specs/2026-09-20-agent-bridge-combat-ai-design.md`)
and flavor customization (`docs/superpowers/specs/2026-09-21-dungeon-customization-agent-design.md`)
both currently depend on a locally-run Node process someone has to keep
alive alongside their Foundry session:

- `tools/agent-loop/poll.mjs` polls a live Foundry world through the
  `foundryvtt-rest-api` relay (self-hosted via `foundryvtt-rest-api-relay`,
  or the rate-limited public `foundryrestapi.com`) for pending
  agent-controlled combatant turns, calls an LLM provider (Claude or Laya)
  for a decision, and writes it back through the same relay.
- `tools/agent-loop/mcp-server.mjs` exposes pending trap/skill-challenge/
  puzzle/narrative flavor-customization requests to whatever interactive
  MCP-connected agent session a GM chooses to run, on their own schedule.

Both require the relay to be running and reachable, and both require a
human to remember to start (and keep running) a local process. If the
poller isn't running or crashes, combatants fall back to the default
heuristic after a timeout; if no interactive session checks in, content
just stays un-customized. This is fragile in the same way #65 and #87
already document for the related `dungeon-remote.mjs` GM-less-mutation
relay dependency.

## Goal

Remove the local-process and relay dependency entirely for both paths.
Combat-turn decisions and flavor customization should both be served by a
persistent, always-on **hosted agent service** that Foundry's own
client-side module code calls directly over HTTPS — no relay, no poller,
no per-session step, nothing for a GM to start or babysit once it's
deployed.

**Design principle carried into this issue's implementation but not
required to be built now:** the hosted service's API contract must leave
room for actor-complexity-tiered reasoning (a boss or named leader
eventually getting deeper reasoning — more tool calls, a bigger model —
than a trash mob) without a future breaking change. v1 ships the same
simple, uniform decision call for every combatant; the schema just
reserves the field.

## Non-goals / explicitly out of scope

- `scripts/dungeon-remote.mjs`'s GM-in-the-loop mutation routing — tracked
  as a separate follow-up issue (see header).
- Real per-actor reasoning tiers (boss vs. trash mob getting different
  treatment) — the extension point is designed in, the behavior is not
  built.
- Any backwards-compatibility shim for `poll.mjs`/`mcp-server.mjs` — this
  is a clean cutover. Anyone currently running the old tooling must
  redeploy to the new service; there's no dual-running transition period.
- Spellcasting/non-Strike actions, real pathfinding — already tracked
  separately (#101, #100) and unaffected by this redesign.

## Deployment and ownership model

Each GM self-hosts their own instance of the new hosted agent service
(and, if they use the Laya provider, their own Laya deployment too) —
there is no shared multi-tenant service. This mirrors the existing
self-hosted-relay precedent and avoids any need for per-world
authentication/isolation on a shared backend: a single deployment only
ever serves one Foundry world, so a single shared-secret bearer token is
sufficient authentication.

## Architecture

```
Foundry (GM/host client, in-process)              Hosted agent service (self-hosted per GM)
  autoPlayCombatantTurnIfDue                         POST /v1/combat-decision
    agentControlled? → armAgentTimeout(45s)  ──fetch──►  Claude/Laya adapter
    ...decide-apply loop until turn over/timeout   ◄──── { candidateId, rationale }
    applyAgentDecision() [in-process, unchanged]

  trap spawns hidden / room becomes current          POST /v1/flavor-customization
    → build pending-customization context   ──fetch──►  Claude/Laya adapter
    ...                                             ◄──── { name, description, ... }
    apply*Customization() [in-process, unchanged]
```

Both paths originate inside Foundry's own client-side module code — the
same client that already runs `autoPlayCombatantTurnIfDue` (gated on
`game.user.isGM`) and already holds in-process access to every
`module.api.get*`/`apply*` function. What changes is *who* calls the
decision-making step: instead of an external process reaching in via the
`foundryvtt-rest-api` relay, the module calls out to the hosted service
directly via `fetch()`.

**Consequence:** the `foundryvtt-rest-api` relay (and
`foundry-client.mjs`'s `runFoundryScript`) is no longer a *production*
runtime dependency for either combat decisions or flavor customization —
it existed solely to let an external process reach into a live session,
and nothing external needs to reach in anymore. (It remains useful as a
*development*-time convenience via the `foundry-rest` tooling/skill for
live-verifying Foundry-side changes — that usage is unaffected.)

## Hosted service API contract

One service, two endpoints, under `tools/agent-service/` (renamed from
`tools/agent-loop/` — the "loop" is retired). Built on plain `node:http`
(no new framework dependency; this repo has none today and two routes
plus a bearer-token check doesn't need one). Reuses
`providers/claude.mjs`/`providers/laya.mjs` and `foundry-client.mjs`'s
`readEnvOrDotenv` largely unchanged.

### `POST /v1/combat-decision`

Request body — the same shape `getPendingAgentTurn()` already builds
today:

```js
{
  self: { name, level, hp, conditions, readyActions },
  opponents: [{ name, hp, distanceSquares, conditions }],
  candidates: [...],
  roundNumber,
  actorProfile: { tier: "standard" } // optional; extension point, ignored by v1
}
```

Response: `{ candidateId, rationale? }` — unchanged from today's provider
`decide()` contract.

`actorProfile` is the extension point for future actor-complexity
tiering: optional, defaulted to `{ tier: "standard" }` by the Foundry-side
caller, unused by the v1 service implementation (every request gets the
same Claude-or-Laya call regardless of its value). Adding a `"boss"` tier
later that triggers deeper reasoning server-side is additive, not a
breaking change to this contract.

### `POST /v1/flavor-customization`

Request body:

```js
{
  kind: "trap" | "skill_challenge" | "puzzle" | "narrative",
  // ...the same context shape each getPending*Customization() already returns,
  // e.g. for a trap: { actorId, trapLevel, partyLevel, ... }
}
```

Response: the matching `submit_*_customization` payload shape — e.g. for
a trap, `{ name, description }`; for a skill challenge,
`{ name, summary, skillFlavor }`; etc. Same data the interactive-MCP path
produces today, generated server-side instead.

### Auth

Both endpoints require `Authorization: Bearer <key>`, a single shared
secret the GM sets once when deploying their instance — analogous to
today's `LAYA_API_KEY` pattern, just fronting the new service instead of
Laya directly. A request without a valid bearer token gets a `401` before
any provider call is made.

## Foundry-side integration

- **Combat trigger** (`dungeon-combat.mjs`). `autoPlayCombatantTurnIfDue`
  already arms `armAgentTimeout(combat, combatant)` as a pure safety-net
  timeout when a combatant is `agentControlled`. New code sits alongside
  that arm: immediately start a decide-apply loop calling the hosted
  service directly (mirroring `poll.mjs`'s existing
  `playOnePendingTurnToCompletion`, just in-process instead of over the
  relay). The existing timeout keeps racing in the background exactly as
  it does today — if the hosted service errors, is unreachable, or is
  slow, the timeout fires and falls back to `playHeuristicTurn`, unchanged.
- **Flavor-customization trigger.** Moves from "an interactive session
  checks periodically" to event-driven: fire the hosted-service call the
  moment something becomes pending (a trap spawns hidden per #135; a
  skill-challenge/puzzle/narrative room becomes current), instead of
  waiting for a human to run the MCP loop. This closes the "party sees the
  un-customized name first" gap the current README documents as an
  accepted trade-off — content can now be ready before players ever see
  the template text.
- **New Foundry module settings** (world-scope, GM-only visibility):
  `agentServiceUrl`, `agentServiceApiKey`. This is the only configuration
  Foundry itself needs going forward. No `ANTHROPIC_API_KEY`,
  `LAYA_API_KEY`, `FOUNDRY_REST_API_KEY`, or `FOUNDRY_BASE_URL` anywhere
  near the browser client — those live only in the hosted service's own
  environment.
- **Removed:** `tools/agent-loop/poll.mjs`, `tools/agent-loop/mcp-server.mjs`,
  `tools/agent-loop/watch-pending.mjs`, `.claude/skills/dungeon-customizations`,
  the `.mcp.json` entry registering `foundry-agent-bridge`, and the
  relay-hosting portion of `tools/agent-loop/README.md` (replaced by the
  new service's own hosting docs). Corresponding tests
  (`tests/agent-loop-mcp-server.test.mjs`,
  `tests/agent-loop-watch-pending.test.mjs`) retire with the files they
  test. `npm run agent-loop`/`agent-loop-watch`/`agent-bridge-mcp` scripts
  are removed from `package.json`.
- **Moved, not deleted:** `tools/agent-loop/providers/*.mjs`,
  `foundry-client.mjs`'s `readEnvOrDotenv` → `tools/agent-service/`.
  `tests/agent-loop-claude-provider.test.mjs`/`agent-loop-laya-provider.test.mjs`/
  `agent-loop-provider-selection.test.mjs`/`agent-loop-foundry-client.test.mjs`
  move with them (renamed `agent-service-*`), their assertions largely
  unchanged since the provider `decide()` contract doesn't change.
- **Kept exactly as-is:** `module.api.getPendingAgentTurn`/
  `applyAgentDecision`, all four `getPending*Customization`/
  `apply*Customization` pairs, `AGENT_TIMEOUT_MS`, `armAgentTimeout`,
  `playHeuristicTurn`.

## Error handling and fallback

- **Combat:** unchanged. `AGENT_TIMEOUT_MS` (45s) still governs; the
  heuristic fallback and GM chat notice still fire exactly as today if the
  hosted service doesn't respond in time or errors.
- **Flavor customization:** preserves the existing "never blocks,
  degrades to template content" principle. If the hosted-service call
  fails or times out, the trap/room keeps its original un-customized
  name/description, logged for the GM — the same outcome as "nothing
  fulfilled it in time" produces today.
- **Service-side:** the hosted service needs basic resilience — a
  Claude/Laya request failure returns a clear error response promptly
  rather than hanging, so Foundry's `fetch()` always gets a timely
  rejection instead of waiting out its own budget on a stuck upstream
  call.

## Deployment and documentation

- `Dockerfile` + `docker-compose.yml` for the new service under
  `tools/agent-service/`, matching the pattern the current README already
  uses for the relay (`docker compose up -d`).
- `tools/agent-service/README.md` (replacing `tools/agent-loop/README.md`)
  covers: deploying this repo's new service, configuring the Foundry-side
  module settings, and self-hosting Laya — Laya is ConvAI Innovations'
  separate project; this repo's docs will link to/summarize its own
  hosting instructions rather than duplicate content this repo doesn't
  own, confirmed during implementation.
- `package.json` gains an `agent-service` script (e.g. `node
  tools/agent-service/server.mjs`) for local dev/testing, replacing the
  removed `agent-loop`/`agent-loop-watch`/`agent-bridge-mcp` scripts.

## Testing

- Provider `decide()` unit tests move over close to as-is (mocked-fetch
  style, `tests/agent-loop-claude-provider.test.mjs` →
  `tests/agent-service-claude-provider.test.mjs`, etc.) — the provider
  contract itself doesn't change.
- New tests cover the HTTP layer: route handling for both endpoints,
  bearer-token auth (valid, missing, invalid), request validation, and
  error-response shape on a provider failure — same vitest + mocked-fetch
  style already used for `agent-loop-mcp-server.test.mjs`.
- Foundry-side changes (the new in-module decide-apply loop, the
  event-driven customization trigger) get live-verified via the
  `foundry-rest` skill/tooling during development, the same precedent
  `dungeon-combat.mjs`'s other Foundry-API-touching code already follows.
  This is a development convenience only — production code no longer
  depends on the relay at runtime.

## Migration

This is a clean, breaking cutover — no dual-running transition period, no
backwards-compatibility shim for `poll.mjs`/`mcp-server.mjs`. Anyone
currently running the old local-process tooling must deploy the new
hosted service and update their Foundry module settings; the old
`npm run agent-loop`/`agent-loop-watch`/`agent-bridge-mcp` scripts and
their underlying files are removed in the same change, not deprecated
alongside the new ones.

## Alternatives considered

- **Two separate services** (one for combat decisions, one for flavor
  customization), split by latency profile. Rejected: both are simple
  request/response LLM calls with the same provider dependency and
  credentials; splitting doubles what each GM has to deploy/host/monitor
  for no real benefit given neither has meaningfully different
  reliability needs from the other in practice.
- **Serverless functions** instead of a persistent server. Rejected: ties
  hosting to a specific cloud platform (contradicts "whatever hosting I
  can find" self-hosting model), and cold-start latency is a real risk
  against the combat-decision timeout budget. A plain Docker container
  runs anywhere, matching the container-host plan and Laya's existing
  precedent.
- **Zero-setup shared service** (one instance covering every GM/world).
  Rejected: puts unbounded hosting cost and a single point of failure
  (every world's combat AI degrades together on an outage) on whoever
  runs it, and needs per-world multi-tenant auth/isolation the
  self-hosted-per-GM model avoids entirely.
