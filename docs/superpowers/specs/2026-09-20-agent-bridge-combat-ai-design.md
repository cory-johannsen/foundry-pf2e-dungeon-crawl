# Agent-controlled combat AI — design

**Tracks:** [#94](https://github.com/cory-johannsen/foundry-deck-of-many-things/issues/94) (ITEM-23, combat-AI half only — dynamic puzzle/trap generation split into its own follow-up issue, not yet filed).

**Follow-ups filed out of scope for v1:**
- [#100](https://github.com/cory-johannsen/foundry-deck-of-many-things/issues/100) — real, obstacle/wall-aware pathfinding (v1 keeps the existing straight-line/distance math for movement postures)
- [#101](https://github.com/cory-johannsen/foundry-deck-of-many-things/issues/101) — spellcasting and other non-strike actions (v1 is Strikes + Stride only)
- [#102](https://github.com/cory-johannsen/foundry-deck-of-many-things/issues/102), blocked — a Laya provider adapter (v1 ships with a Claude adapter only)

## Problem

ITEM-8 (`dungeon-combat.mjs`'s `autoPlayCombatantTurnIfDue`) already automates every non-player combatant's turn, but with a deliberately dumb, fixed heuristic: move toward the nearest opponent, make exactly one strike (always the first ready one, never a second at increasing MAP), apply the result, advance the turn. That's an honest ceiling for trash mobs, but a boss or named leader deserves real tactical judgment — and even "real judgment" is wasted if the turn only ever spends one of a creature's three actions.

## Goal

Let an external decision-maker (an LLM today, potentially other providers later) control a combatant's turn instead of the heuristic — while keeping every actual game mutation inside this module's own existing, already-verified helpers, never through arbitrary code an external process supplies.

## Architecture

Three cleanly separated pieces:

1. **In-module (small).** A `flags.dommt.agentControlled` default, a change to `autoPlayCombatantTurnIfDue`'s guard, a per-turn/per-action timeout with heuristic fallback, and two new `module.api` methods that are the *only* way an external process can read pending-turn state or apply a decision.
2. **Infra (no new code — setup only).** The open-source `foundryvtt-rest-api-relay` self-hosted via Docker on the same machine as Foundry. Unlimited requests by default, no third-party dependency, no recurring cost — deliberately chosen over the public `foundryrestapi.com` relay (100 requests/month free tier) and over bootstrapping on Foundry MCP (a paid, pull-only, third-party-hosted alternative investigated and rejected — see Alternatives Considered).
3. **New tooling (this repo, `tools/agent-loop/`).** A polling script with no special Foundry access of its own — it only ever calls the two `module.api` methods via `foundry-rest`, and a pluggable decision-provider layer (Claude v1, Laya later per #102).

```
Foundry (GM client)                         tools/agent-loop/ (external process)
  autoPlayCombatantTurnIfDue                   poll loop:
    agentControlled? → skip, arm timeout          getPendingAgentTurn()  ──┐
    timeout fires? → heuristic + GM notice         │ via foundry-rest      │
                                                    ▼                       │
  module.api.getPendingAgentTurn()  ◄──────── candidates + context         │
  module.api.applyAgentDecision()   ◄──────── provider.decide() ───────────┘
    (only path that mutates the game)              (Claude / Laya)
```

## Decision protocol

The agent only decides **target, action, and movement posture** — never raw coordinates, and never anything outside Strikes/Stride (see #101 for the spellcasting follow-up). Movement mechanics stay the existing straight-line/distance math (see #100 for real pathfinding); what's new is that the agent *chooses* the posture instead of it being hardcoded to "always approach."

**Per-turn state**, held on the `Combat` document (`flags.dommt.agentTurnState`), reset the instant an agent-controlled combatant's turn becomes current:
```js
{ combatantId, actionsRemaining: 3, mapIncrement: 0 }
```

**Each iteration**, `getPendingAgentTurn()` builds a fresh candidate list from current state — one candidate per atomic, 1-action option, plus an always-available 0-cost `endTurn`:
- `stride:<approach|retreat|reposition>:<targetId>` — posture-based movement, each a distinct reason to move: `approach` closes distance toward `targetId` (today's only option); `retreat` increases distance from `targetId` — for a ranged/reach creature that shouldn't close to melee; `reposition` moves away from a nearby hazardous tile specifically, independent of any target. `retreat`/`reposition` are only offered when they'd actually change something (e.g. no `reposition` candidate if nothing hazardous is nearby).
- `strike:<targetId>:<actionSlug>` — one per ready strike × each opponent currently within that strike's reach, rolled at `strike.variants[min(mapIncrement, maxVariantIndex)]` so a 2nd/3rd strike in the same turn is correctly penalized.
- `endTurn` — lets the agent stop early rather than being forced to spend all 3 actions.

Context handed to a provider alongside the candidates:
```js
{
  self: { name, level, hp, conditions, readyActions },
  opponents: [{ name, hp, distanceSquares, conditions }],
  candidates: [...],
  roundNumber
}
```

**The loop** (driven by the poller, not Foundry): `getPendingAgentTurn()` → provider decides → `applyAgentDecision(combatId, combatantId, candidateId)` → repeat, until `actionsRemaining` hits 0, `endTurn` is chosen, or `getPendingAgentTurn()` returns `null` (turn already advanced by something else). `applyAgentDecision` is the only thing that ever mutates the game — it executes the chosen candidate via the same movement/strike/damage-application helpers ITEM-8's heuristic already uses, decrements `actionsRemaining` by the action's cost, increments `mapIncrement` on a Strike, and calls `combat.nextTurn()` itself once the turn is actually over.

## In-module changes (`dungeon-combat.mjs`, `module.mjs`)

- **Flag default.** `flags.dommt.agentControlled = true` set on every non-party Combatant at creation time (`startCombat`'s existing `createEmbeddedDocuments('Combatant', ...)` call) — party combatants never get it, mirroring the existing `partyActorIds()` split (ITEM-8's own reopening).
- **GM toggle.** A context-menu entry on each NPC row in Foundry's own Combat Tracker sidebar — not dungeon-specific UI, since this needs to work for the standalone "DOMMT: Generate Encounter" macro's combats too (ITEM-6's original scope). Exact hook API confirmed live during planning.
- **`autoPlayCombatantTurnIfDue`.** When the due combatant is `agentControlled`, it no longer runs the heuristic immediately. It initializes `agentTurnState` if this is a new turn, and arms a timeout (`setTimeout`, same pacing pattern as the existing `AUTO_PLAY_DELAY_MS`, default ~45s, re-armed after each `applyAgentDecision` call so a mid-turn stall still recovers). If the timeout fires and the turn/action state hasn't moved on, it falls back to today's heuristic for the *remainder* of that turn and posts both `ui.notifications.warn` and a chat message — a persistent, visible record that the agent didn't respond in time.
- **New `module.api` surface**, mirroring the existing `resetDungeon` precedent of exposing a scriptable entry point:
  - `api.getPendingAgentTurn()` → `{ combatId, combatantId, context, candidates } | null`
  - `api.applyAgentDecision(combatId, combatantId, candidateId)` → applies one candidate, returns updated turn state (or `null` once the turn has ended)

## Provider abstraction (`tools/agent-loop/providers/`)

Common interface:
```js
async function decide({ self, opponents, candidates, roundNumber }) → { candidateId, rationale? }
```
- **Claude adapter (v1).** Prompts with the context, uses tool-use / constrained JSON output rather than freeform text so parsing is reliable. `rationale` (optional) can be posted to chat for GM visibility into *why* the agent acted.
- **Laya adapter.** Tracked separately in #102 (blocked on the user's own Laya setup) — will send the state blob + candidate list as a `choice` question and pick the argmax over the returned calibrated probabilities.
- **Selection.** A config value the poller reads at startup (`DOMMT_AGENT_PROVIDER=claude|laya`) — no runtime switching for v1; restart the poller to change providers.

## Polling script (`tools/agent-loop/`)

- A Node script in this repo, matching the existing `tools/validate-cards.mjs` convention — run manually or as a background process alongside Foundry, not itself a Foundry module.
- Polls `getPendingAgentTurn()` via `foundry-rest` on a fixed interval (a few seconds — cheap, since the relay is self-hosted and unlimited).
- No special error-handling logic of its own: if the relay is unreachable it just keeps retrying, and if a provider call fails or returns an invalid candidate id it logs and skips that cycle — the in-module per-action timeout/fallback is the single source of truth for "nothing happened in time," so the poller doesn't need its own escalation path.

## Alternatives considered

- **Foundry MCP / Foundry API Bridge** (`alexivenkov/foundry-api-bridge-module`, `foundry-mcp.com`) — an existing, actively-maintained WebSocket bridge with a deep PF2e action toolset (`roll-strike`, `cast-spell`, condition management). Rejected for v1: it's strictly pull-based (an AI client calls tools; nothing pushes a Foundry-side event out, so it doesn't actually solve "notice a combatant's turn is due" any better than our own polling does), it's a third-party hosted service gated behind paid Patreon tiers for exactly the combat/token/scene tools this needs, and it would hand a third party full GM WebSocket control of the world. Self-hosting our own already-integrated relay avoids all three costs.
- **PF2e AI Combat Assistant** (`cammoraton/foundryvtt-pf2e-ai-combat-assistant`) — proves a Foundry module can call an LLM directly from the browser with no relay at all, but it's human-in-the-loop by design (the GM manually executes every suggested action and clicks Confirm/Skip) — the opposite shape from GM-less play. Not building on it directly, though its "re-prompt after each confirmed action, track the action count" pattern independently validated this design's iterative, action-by-action decision loop.
- **A custom push-based bridge** (the original issue's own sketch — new Foundry-side hooks pushing event envelopes to a new relay/WebSocket server we'd design and build) — rejected in favor of polling once it was clear a tabletop combat turn has no real-time deadline that push actually buys us, and polling reuses infrastructure (`foundry-rest`) this project already has working.

## Testing

- Candidate enumeration (movement postures, MAP-aware strike options, action-cost filtering) is pure data transformation over already-available combat state — real unit tests, unlike most of `dungeon-combat.mjs`.
- Provider adapters are pure request/response shaping, testable against a mocked HTTP layer — no live API calls needed in CI.
- `getPendingAgentTurn`/`applyAgentDecision` themselves are Foundry-API-touching — live-verify only via `foundry-rest`, same precedent as the rest of this file (ITEM-6/8/11).
- End-to-end: a scratch combat with an agent-controlled NPC, verifying a full 3-action turn (MAP increments correctly, a movement posture changes position sensibly, the timeout/fallback fires correctly when the poller is paused mid-turn).
