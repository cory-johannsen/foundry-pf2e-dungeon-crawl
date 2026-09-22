# Manipulate-action and move-action triggers for Reactive Strike — design

**Tracks:** [#13](https://github.com/cory-johannsen/foundry-pf2e-dungeon-crawl/issues/13), a follow-up from [foundry-deck-of-many-things#202](https://github.com/cory-johannsen/foundry-deck-of-many-things/issues/202) (shipped: the ranged-Strike-triggered slice of Reactive Strike / Attack of Opportunity only).

## Problem

`handleRangedAttackForReactiveStrike` (`dungeon-combat.mjs:1306`) already offers eligible agent-controlled reactors a Reactive Strike when an opponent's ranged Strike produces a `createChatMessage` with `flags.pf2e.context.type === "attack-roll"`. Reactive Strike / Attack of Opportunity has two other real triggers PF2e#202 deliberately deferred:

- A manipulate action within reach — often produces no roll or chat message at all, so `createChatMessage` can't detect it.
- A move action (Stride) within reach — only generic `updateToken` fires, with no way to distinguish a real Stride from a GM drag, forced movement, or a teleport effect.

## Investigation

This module's agent-controlled combatants never take manipulate actions at all — `agent-candidates.mjs` offers only `stride`, `strike`, `multiStrike`, and various `cast*`/`breathWeapon` candidates, no interact/draw/retrieve action. So the manipulate-action trigger is entirely about a **player character's** manipulate action, which has no reliable hook (confirmed live during #202's own research; not re-verified live here — this session had no `FOUNDRY_REST_API_KEY` configured).

Move actions split into two cases with very different detectability:

- **Agent-controlled Stride.** The module drives this itself, via two code paths that both call `me.update({x, y})` on the combatant's own token: `strideByPosture()` (the agent-loop-driven AI's own turn) and `stepToward()` (the default heuristic AI's turn, and the agent-timeout fallback). Both are exactly, non-heuristically detectable — no ambiguity with GM drags or forced movement, because the module itself is the mover in both cases. (This correction was made during final review; the original investigation missed `stepToward` as a second instance of the same exact-detection case.)
- **Player-character Stride.** Goes through Foundry's normal UI with no reliable hook, same as the manipulate-action case.

## Decision

Automate the case that can be automated exactly; give the GM a manual control for the two cases that fundamentally can't be detected. No heuristics (position-delta guessing, chat-message pattern-matching) are used anywhere — they'd misfire in real play (false positives from GM drags/forced movement, false negatives from manipulate actions with no message), which is worse than an explicit manual step.

## Architecture

1. **Extract the shared reactor-offer logic.** The per-reactor eligibility-and-execution loop currently inlined in `handleRangedAttackForReactiveStrike` (lines 1327–1364: agent-controlled check, one-reaction-per-round check, in-scope-item lookup, in-reach ready-strike matching, weapon-restriction parsing, strike execution, chat announcement) becomes a new function:

   ```js
   async function offerReactiveStrikesAgainst(combat, mover)
   ```

   `handleRangedAttackForReactiveStrike` calls it after its existing `createChatMessage`-specific filtering (attack-roll type, ranged option, resolving `attacker` from the message) — behavior unchanged.

2. **Automatic trigger: agent-controlled Strides.** At the end of `strideByPosture()`, after `me.update(...)` actually moves the token (i.e. past all of its existing no-op early returns), call:

   ```js
   await offerReactiveStrikesAgainst(combat, combatant);
   ```

   Reusing the same `combat` already passed into `strideByPosture`.

3. **Manual trigger: PC manipulate/move actions.** Add a second entry to the existing `Hooks.on("getCombatTrackerEntryContext", ...)` registration in `module.mjs` (alongside `ToggleAgentControlLabel`):

   - Label: `PF2EDC.Dungeon.Combat.ReactiveStrikeCheckLabel`
   - Icon: a reasonable free FontAwesome icon distinct from the robot icon already used (e.g. `fa-solid fa-bolt`)
   - `condition`: combatant resolves and is not defeated (no agent-controlled/party restriction — a GM may want this for any row)
   - `callback`: resolve the combatant, call `offerReactiveStrikesAgainst(combat, combatant)`, GM-gated via `game.user.isGM` (matching every other mutating hook handler in this file)

## Positional check

Both new triggers reuse the existing Chebyshev-distance-based reach check already in `offerReactiveStrikesAgainst` (inherited from the current implementation), evaluated against the mover's **final** position only — not whether the mover passed through a reactor's reach mid-move. PF2e's actual rule also allows Reactive Strike on leaving reach; this is a known simplification consistent with the rest of this file's existing narrow v1 scope (approved as in-scope for this item, no follow-up filed).

## Data flow

- **Agent vs. agent/PC:** an agent-controlled combatant Strides via the normal AI turn loop → `strideByPosture` moves the token → `offerReactiveStrikesAgainst` runs automatically, no GM action needed.
- **PC vs. agent:** a PC manipulates or Strides during their own turn (outside this module's control) → the GM (or auto-GM in a GM-less run) right-clicks that PC's combat-tracker row → "Reactive Strike Check" → `offerReactiveStrikesAgainst` runs the identical eligibility/execution path.

All three trigger sources (existing ranged-attack hook, new auto-Stride hook, new manual tracker action) funnel through the same function, so reaction economy (`getReactionUsed`/`markReactionUsed`), weapon restrictions, and the chat announcement stay consistent regardless of trigger source.

## Error handling

No new failure modes beyond what `offerReactiveStrikesAgainst` already handles by construction (missing item, no ready action in reach, reactor already used their reaction this round — each already a silent `continue`/skip, not an error). The manual trigger callback additionally no-ops if `game.combat` is missing or the row's combatant can't be resolved, matching `toggleAgentControlled`'s existing guard style.

## Testing

New `tests/dungeon-combat-reactive-strike.test.mjs`:
- `offerReactiveStrikesAgainst` extracted and tested directly (currently untested even for the existing ranged-attack path) — eligible reactor triggers, ineligible reactor (not agent-controlled, already used reaction, out of reach, no matching restricted weapon) does not.
- `strideByPosture` invokes `offerReactiveStrikesAgainst` after a real move, and does not after a no-op (no speed, no path, no waypoint).
- The new tracker-context-menu callback resolves the right combatant and is GM-gated.

`handleRangedAttackForReactiveStrike`'s existing behavior (no dedicated test today) gets incidental coverage through the new `offerReactiveStrikesAgainst` tests, since it now delegates to that function.

## Out of scope

- Full-path (not just final-position) reach detection for movement, for both this item's triggers and the existing ranged case.
- Any automatic detection for PC manipulate actions or PC Strides — deliberately left manual per the Decision section above.
