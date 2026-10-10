# Advanced AI Actors: Enforce Wasted / Restricted Actions on Human-Driven Turns

**Issue:** #1094 — real enforcement of wasted and restricted actions on players' turns, deferred from #987.

**Builds on:** #987 / `docs/superpowers/specs/2026-10-09-ai-npc-custom-save-outcomes-design.md` (the `wasteActions` / `restrictActions` outcome kinds, their marker effects, the turn-start hook, and the reminder card this spec replaces for human-driven characters), #935 (`applyTimedEffect`, agent tagging), and the module's combat turn hooks in `scripts/module.mjs`.

**Status:** Approved. Scope was decided in a foreground question session with the owner on 2026-10-09 (see "Resolved decisions").

## Summary

#987 applies "waste N actions" and "the only action you can take is X" outcomes to AI-controlled targets automatically but only posts a reminder for human-driven characters. This spec makes the enforcement real. It does so by **depending on the PF2E Automated Action Tracker module** (`pf2e-auto-action-tracker`), which already tracks each combatant's action pips, and by **blocking disallowed rolls** while a restriction is active, with a per-roll GM override.

## Investigation findings

Confirmed against the installed tracker (v0.19.1, Foundry 13-14, requires `lib-wrapper` and `socketlib`) and the repo.

- **PF2e itself does not count a player character's actions.** The tracker adds that: per-combatant state lives in combatant flags under `flags.pf2e-auto-action-tracker` — `log` (an array of entries), `actionsSpent`, `reactionsSpent`, `sustainData`. Its slot engine computes capacity (Quickened, Slowed, Stunned, feats) and whispers an "Economy Alert" when actions are overspent.
- **The tracker already models a forced loss as a log entry.** At turn start it drains Slowed/Stunned/Paralyzed by pushing `{ type: "system", cost, msgId: "System", label, isQuickenedEligible: true, category: "system", linkedMessages: [] }` onto the log and writing `actionsSpent`. Its pips, hover text and overspend alert all derive from that log. A wasted action is the same thing with a different label.
- **The tracker has no public API.** It exposes no `game.modules.get(...).api`; its `ActionManager` is module-scoped. The only stable surfaces are the combatant flags and the module's socketlib calls (`addAction`, `removeAction`, `editAction`, GM-side only).
- **The tracker only advises.** Overspending produces a whisper; nothing is blocked. Blocking disallowed rolls is this module's job.
- **Applying Slowed N instead was rejected** (see decision 1): Slowed interacts with Quickened and slowed-immunity, so it would not follow the rules as written.

## Resolved decisions

1. **Wasted actions use the Automated Action Tracker.** The module declares `pf2e-auto-action-tracker` as a dependency and, at the start of an affected human-driven turn, adds a system log entry (`label: "Wasted: <ability>"`, `cost: n`) so the player's pips show the actions as spent. The tracker's own overspend whisper then covers a player trying to use them. Rejected: a module-owned pip tracker (duplicates the tracker) and Slowed (not rules-faithful).
2. **Restricted actions block disallowed rolls.** While a `restrictActions` effect is active on a human-driven character's turn, rolls that spend an action are blocked with an explanatory message; only the permitted action (Drown's Fortitude save to expel the water) goes through, and a success ends the restriction.
3. **The GM can override per roll.** A blocked roll shows the GM a one-click "allow this once" prompt.
4. **Reactions and free actions are in scope.** A restriction that names them (the effect's `restricts: ["action","reaction","free"]`) blocks reaction and free-action rolls too.
5. **Affected players get a turn-start prompt.** A whispered notice to the owning player when the loss or restriction takes effect, naming the ability and what it costs or permits. It replaces #987's public reminder card for characters with a player owner.
6. **Unselected options are filed:** a world setting switching enforcement between blocking and warn-only (#1198), and a GM-chat log of blocked and overridden rolls (#1199). The "general per-turn action tracker for every turn" option needs no ticket: the dependency on the tracker already provides it.

## Design

### Dependency

`module.json` gains `relationships.requires` entries for `pf2e-auto-action-tracker` (and the tracker's own `lib-wrapper` / `socketlib` are installed with it). If the tracker is inactive, the module posts a one-time GM warning at world ready, and enforcement degrades to #987's reminder card; AI-controlled enforcement is unaffected.

### Wasted actions (extends #987's turn-start hook)

For a human-driven combatant with a `wasteActions` marker effect:

- Append `{ type: "system", cost: min(n, remaining capacity), msgId: "System", label: "Wasted: <ability>", isQuickenedEligible: false, category: "system", linkedMessages: [] }` to the combatant's `flags.pf2e-auto-action-tracker.log` and update `actionsSpent` in the same `combatant.update` the tracker's own writer performs (GM client only). Capacity comes from the pips already shown: the clamp reads the tracker's slot count rather than assuming 3, so Quickened and Slowed are respected.
- The marker effect is consumed when the log entry is written; the entry itself disappears with the tracker's normal end-of-turn reset.
- Idempotent: an entry already present with the same `label` is not added twice (turn-change hooks can fire repeatedly).

### Restricted actions (extends #987's `restrictActions`)

- **Gate.** For a character with a `restrictActions` marker whose turn it is, intercept action-spending rolls (Strike and spell attack rolls, spell casts, skill actions, item/feat actions) and reaction / free-action usage when the effect's `restricts` includes them. Anything not in the effect's `onlyActions` list is blocked. The intercept point is chosen during planning (see open questions); the fallback is `preCreateChatMessage`, which can discard the message before it posts.
- **Permitted action.** The permitted escape save is allowed through; on a success the marker is removed, the restriction ends, and the player is told.
- **Override.** A blocked roll whispers the GM a prompt ("<name> tried <action> while restricted by <ability>. Allow once / Keep blocked"); "Allow once" lets the next matching roll through and logs it. The player sees why the roll was blocked.
- **Scope.** The gate applies only on the restricted character's own turn for actions; reaction / free-action restriction applies for the effect's whole duration.

### Turn-start prompt

On the affected character's turn, whisper the owning player(s): "<ability> — you must waste N action(s)" or "<ability> — the only action you can take is <permitted>". Characters with no player owner get none (GM-run characters keep the #987 reminder card).

## Error handling

- A tracker write that fails is logged and the GM is told; the #987 reminder card is posted as the fallback.
- If the combatant's tracker flags are unreadable or the shape differs from the expected (tracker version drift), the hook skips enforcement and warns once per session, naming the tracker version it read.
- A gate error never blocks a roll by accident: any exception inside the intercept lets the roll through and logs the error.
- A restriction on a combatant that is not the current turn's combatant blocks nothing except reactions/free actions where the effect says so.

## Testing

- **Wasted actions (mocked combatant flags):** the log entry shape matches the tracker's own system entries; `actionsSpent` is updated consistently; clamping to capacity under Quickened and Slowed; idempotency on repeated turn-change hooks; marker consumption.
- **Gate (pure decision function):** allowed vs blocked for strike / spell / skill / reaction / free action against `onlyActions` and `restricts`; the escape save allowed and its success clearing the marker; override-once consumption.
- **Degradation:** tracker inactive, flags missing, tracker version shape drift each fall back to the reminder card with one warning.
- **Regression:** AI-controlled #987 enforcement unchanged; human reminder card still posted when the tracker is inactive.
- **Live verification:** a Do a Jig! failure on a human-driven character shows the wasted pips spent in the tracker; a Drown failure blocks a Strike with the explanatory message, the GM override lets one through, and the escape save success ends the restriction.

## Explicitly out of scope

- A warn-only / strict world setting (#1198) and a GM-chat enforcement log (#1199).
- Enforcing anything on the tracker's own pip UI beyond adding log entries; modifying the tracker's code.
- The rest of the drowning rules and player-character suffocation saves (#1095).

## Open questions

None blocking. Left to planning: the best intercept point for blocking action-spending rolls (a pf2e pre-roll hook, a libWrapper wrap, or `preCreateChatMessage`), the exact tracker log-write sequence (direct flag update versus the tracker's `addAction` socket call, verified against its version), and the `restricts` field's place in #987's effect schema.
