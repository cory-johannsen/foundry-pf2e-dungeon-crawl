# AI control for offline players' actors — design

**Tracks:** [#20](https://github.com/cory-johannsen/foundry-pf2e-dungeon-crawl/issues/20)

**Out of scope for this issue (not filed as follow-ups yet):**
- Full AI decision-making for skill challenges, puzzles, or narrative rooms — those rooms only get auto-rolled checks when a mechanic specifically calls on an AI-controlled actor (see "Skill checks" below), not independent AI-driven choices.
- Mid-run handoff — control is decided once at run start and does not change if a player logs in or out while the run is in progress.
- Real-time/LLM-driven decision-making for movement or non-combat checks — this reuses the existing heuristic/LLM combat engine for combat only.

## Problem

Dungeon crawls assume every party member is actively controlled by a logged-in human. If a player who started the crawl has party members who aren't currently logged in, those actors sit idle: they don't act in combat, don't move as the party explores, and can't contribute to skill challenges or puzzles that specifically call on them. This can stall or trivialize encounters that expect the full party's participation.

## Goal

When a dungeon crawl starts, automatically detect which party actors belong to a player who isn't currently logged in, and have those actors act on their own for the rest of the run: taking combat turns via the module's existing agent-controlled-turn engine, following the party leader as the group explores, and rolling their own skill checks when a room mechanic specifically calls on them.

## Architecture

One list, computed once, consumed by three independent subsystems:

```
createRun (dungeon-runner.mjs)
  → compute aiControlledActorIds, store on the run record
        │
        ├─→ Combat (dungeon-combat.mjs)
        │     startCombat flags these actors agentControlled: true
        │     existing heuristic/LLM turn engine (ITEM-8/agent-loop) runs unmodified
        │
        ├─→ Exploration (new dungeon-follow.mjs)
        │     updateToken hook on the leader's token
        │     → pathfinding.mjs routes each AI-controlled token toward the leader
        │
        └─→ Skill checks (skill-challenge.mjs, puzzle.mjs)
              actor selected to roll is AI-controlled?
              → rollSkillChallengeAttempt / rollPuzzleStageAttempt directly, no dialog
```

## Determining `aiControlledActorIds`

Computed once, in `createRun` (`scripts/dungeon-runner.mjs`), and stored on the run record alongside the existing `hostUserId`.

For each actor id in `partyActorIds()` (`dungeon-combat.mjs`):
1. Find the non-GM user with `OWNER` ownership level on that actor. Each Trusted-User player owns exactly one actor this way; the GM/agent user is the deployment-default owner of everything and is explicitly excluded from this check.
2. If no such non-GM owner exists (misconfigured ownership), the actor is left off the list — it stays human/GM-controlled by default. This fails safe rather than guessing.
3. If a non-GM owner exists but that user is not in `game.users.active`, the actor id is added to `aiControlledActorIds`.

This is computed once at run start and is static for the run's lifetime, per this issue's scope: a player logging in or out mid-run does not change an actor's control state until the next run.

## Combat integration (`dungeon-combat.mjs`)

No new turn-taking logic. The only change is widening the existing eligibility checks from "not in `partyActorIds()`" to "not in `partyActorIds()`, or actor id is in the run's `aiControlledActorIds`":

- `startCombat`'s existing NPC-flagging logic also flags combatants whose actor id is in `aiControlledActorIds` as `flags.dommt.agentControlled = true`.
- `autoPlayCombatantTurnIfDue` and `toggleAgentControlled` currently hard-exclude all party actors ("should never have the flag in the first place"); that exclusion becomes conditional on membership in `aiControlledActorIds`.

Everything downstream — the heuristic move-and-strike turn, and the LLM-driven agent-loop path from the [combat AI design](2026-09-20-agent-bridge-combat-ai-design.md) — is reused exactly as built for NPCs, with no PF2e-actor-type-specific branching.

## Exploration following (new `scripts/dungeon-follow.mjs`)

Room-to-room movement in this module is manual token dragging today — nothing currently bundles the party together as they explore a scene. This module adds that specifically for AI-controlled actors:

- Active only while the current scene belongs to a run with a non-empty `aiControlledActorIds`.
- Resolves "the leader" as the host user's (`hostUserId`, tracked on the run) own owned party actor's token on the current scene. If no such token can be resolved (e.g. a GM-hosted run with no GM-owned PC), the module no-ops for that run and logs one warning at run start.
- Registers `Hooks.on("updateToken", ...)`, filtered to fire only on updates to the leader's token.
- On a qualifying move, for each AI-controlled actor id with a token on the current scene: if it's more than one tile from the leader's new position, use the existing `pathfinding.mjs` to route it to a free tile adjacent to the leader, then update the token document to move it there.
- Debounced to at most one recompute/move per AI token per ~250ms, so a drag producing many intermediate `updateToken` events doesn't spam movement or fight the leader's own in-progress drag.
- If pathfinding can't find a route (e.g. blocked by a closed door or terrain), the token stays in place and a console warning is logged — no error surfaced to players, no retry loop.

## Skill checks (`skill-challenge.mjs`, `puzzle.mjs`)

Both `rollSkillChallengeAttempt(actor, skill, dc)` and `rollPuzzleStageAttempt(actor, skill, dc)` already suppress PF2e's roll-confirmation dialog and return `{outcome, dc, skill}` directly. Wherever existing code selects an actor and prompts a human to roll, add a branch: if that actor's id is in the active run's `aiControlledActorIds`, call the roll function directly and post the result to chat exactly as a human roll would be, skipping only the human-prompt step. No new decision logic — the actor doesn't choose *whether* to act, it's simply available whenever a mechanic calls on it.

## Error handling

| Condition | Behavior |
|---|---|
| Actor has no non-GM owner | Excluded from `aiControlledActorIds`; stays human/GM-controlled |
| Pathfinding finds no route to the leader | Token stays in place; console warning logged |
| No leader token resolvable for the run | Follow system no-ops for the whole run; one warning logged at run start |
| Combat agent-loop/LLM failure | Inherits the existing NPC fallback behavior (heuristic turn after timeout) unmodified |

## Testing

- Unit tests for `aiControlledActorIds` computation: mocked `game.users` and actor ownership maps, covering an offline non-GM owner, an online non-GM owner, GM-only ownership, and no-owner cases.
- Extend existing `dungeon-combat.mjs` tests to cover a party actor flagged `agentControlled` via the run's list, confirming the existing heuristic/LLM turn logic fires for it unchanged.
- Unit tests for the skill-challenge/puzzle auto-roll branch: an AI-controlled actor bypasses the dialog and returns a result; a human-owned actor's flow is unaffected.
- Unit-test the pure "find a free tile adjacent to the leader + path to it" computation in `dungeon-follow.mjs` in isolation from the `updateToken` hook wiring.
- The `updateToken` hook itself, and the end-to-end follow behavior, are canvas-driven and verified manually against a live Foundry world via `foundry-rest`, matching this repo's existing precedent for hook/canvas-touching code (ITEM-6/8/11, the combat AI design's `getPendingAgentTurn`/`applyAgentDecision`).

## Alternatives considered

- **Manual "sync party" trigger instead of live following.** A GM/leader-triggered button that snaps AI-controlled tokens to the leader on demand, instead of an automatic `updateToken` hook. Simpler and avoids any pathfinding/hook-spam risk, but requires the GM to remember to click it and lets the party visibly desync between clicks. Rejected in favor of live following for a smoother table experience, given `pathfinding.mjs` already exists to de-risk the automatic version.
- **Route non-combat behavior through the external agent-loop/LLM relay**, treating AI-controlled party actors identically to NPCs end-to-end (movement and skill-check decisions going through the same relay as combat AI). More architecturally unified, but makes simple exploration and skill-check auto-rolling depend on an external process being alive, and requires extending that tool to handle decisions it doesn't need to make here — the roll and movement-target logic is deterministic, not a judgment call. Rejected as unnecessary complexity for this issue's scope.
