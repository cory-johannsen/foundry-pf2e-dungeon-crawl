# Advanced AI Actors: Antagonize (Persistent Frightened Floor)

**Issue:** #920 — AI actors: Antagonize (persistent Frightened floor after Demoralize).

**Builds on:** #943 (baseline end-of-turn Frightened decay — the mechanism this spec constrains), #911 / `docs/superpowers/specs/2026-10-08-ai-actor-maneuver-variants-design.md` (the maneuver feat-modifier work this was deferred from) and #909 / `docs/superpowers/specs/2026-10-08-ai-actor-maneuvers-design.md` (the Demoralize executor). Cannot be implemented before #943.

**Status:** Approved. Scope questions were answered by the owner on 2026-10-08 (see "Resolved decisions").

## Summary

Antagonize (Swashbuckler, level 2) says: when you successfully Demoralize a creature, its Frightened condition can't decrease to less than 1 at the end of its turn until it either uses a hostile action against you or can no longer observe or sense you for at least 1 round. The PF2e system carries only a chat `Note` for it (no automation), and, per #943, nothing in the system or this module decrements Frightened at turn end in the first place.

This spec adds an **Antagonize floor**: a per-target record, created when an actor with the feat successfully Demoralizes a creature, that the baseline Frightened decay (#943) consults so the value never drops below 1 while the floor lasts. The floor is cleared when the frightened creature makes an attack roll or spell attack roll against its antagonizer, or when it has not sensed the antagonizer for at least one round. It applies to any actor — player-controlled or AI — because the module's baseline decay covers every combatant.

## Investigation findings

Confirmed against this repo, the installed PF2e system (`pf2e.mjs`, v8.5.0) and the local PF2e source data.

- **Feat data.** `feats/class/swashbuckler/level-2/antagonize.json`: description as above; `rules` is a single `Note` rule element (selector `skill-check`, outcomes success/critical success, predicate `action:demoralize`) that only displays the feat text on the Demoralize check. No condition or floor logic exists in the system.
- **No end-of-turn Frightened decay exists** in the system or module (#943). The system's end-of-turn pass (`CombatantPF2e#onEndTurn`) calls `ConditionPF2e#onEndTurn` on active conditions — which handles only persistent damage — and `EffectPF2e#onEncounterEvent("turn-end")` for effect expiry; it then fires `Hooks.callAll("pf2e.endTurn", combatant, encounter, userId)`. `actor.decreaseCondition(slug, { forceRemove })` is the public decrement API. The floor therefore has to be an extension point of #943's decay, not a patch of system behavior.
- **Detecting a Demoralize.** A Demoralize check is a skill check whose chat-message context (`flags.pf2e.context`) carries `options` including `action:demoralize`, an `outcome` (`success`/`criticalSuccess`), and the rolling actor and target actor. The same detection works for player-rolled and AI-rolled Demoralizes (the #909 executor rolls through the same system macro and reads the same outcome).
- **Detecting a hostile action.** Strike and attack-spell rolls produce chat messages whose `flags.pf2e.context.type` is `attack-roll` or `spell-attack-roll`, with the origin actor and the target actor/token recorded in the context. That is a reliable signal for "made an attack against X".
- **Sensing.** The module already computes line of sight and detectability for AI turns (`hasLineOfSight`, `detectableOpponents` in `scripts/dungeon-combat.mjs`). Those helpers answer "can combatant A see/detect combatant B" and are reused here from the frightened creature's point of view.
- **Time.** #785's game clock gives a real `game.time.worldTime`; one round is 6 seconds, which maps "at least 1 round" onto a clock difference.
- **Combat lifecycle hooks** available: `pf2e.endTurn`, Foundry's `combatTurnChange`/`updateCombat`, and `deleteCombat`.

## Resolved decisions

1. **Baseline decay is a separate foundation (#943).** This spec only adds the floor on top; #920 depends on #943.
2. **RAW sense-break.** The floor ends once a full round passes during which the frightened creature has not sensed its antagonizer, tracked with a per-target last-sensed timestamp (not a simplified "no line of sight at turn end" rule).
3. **Hostile action = an attack roll or spell attack roll by the frightened creature targeting its antagonizer.** Saving-throw spells, maneuvers and other effects are not counted in this version.
4. **Any actor, PC or AI.** A successful Demoralize by any actor with Antagonize creates the floor, detected from the chat message, whoever controls the actor.

## Design

### Data: the floor record

A flag on the **frightened creature's actor**: `flags.pf2e-dungeon-crawl.antagonize`, a map keyed by the antagonizer's actor UUID:

```json
{ "Actor.abc123": { "sinceWorldTime": 1200, "lastSensedWorldTime": 1200 } }
```

One entry per antagonizer; multiple antagonizers can hold floors on the same creature, and the creature's Frightened floor is 1 while any entry exists.

### Creating the floor

A `createChatMessage` handler (GM client only, matching the module's other chat-driven handlers) fires for a skill-check message with `action:demoralize` in its context options and `outcome` of `success` or `criticalSuccess`, where the rolling actor has a feat with slug `antagonize`. It writes the entry above on the target's actor with both timestamps set to the current `worldTime`. The AI maneuver executor (#909) needs no change: its Demoralize goes through the same system roll and produces the same chat message, so one handler serves PCs and AI. A target with no Frightened condition at that moment still gets the entry (RAW: the floor applies to the condition the Demoralize itself imposes; the baseline Demoralize consequence is applied by #909's executor or the player).

### Enforcing the floor

#943's decay routine exposes one extension point, a pure function `frightenedFloorFor(actor)` returning the minimum value Frightened may decay to. This spec supplies it: `1` when the actor's `antagonize` flag has at least one entry, otherwise `0`. The decay computes `newValue = max(currentValue - 1, floor)` (and removes the condition only when `newValue` is 0). Nothing else in the decay path changes.

### Clearing the floor

Two events remove an entry (and delete the flag when it is empty):

1. **Hostile action.** A `createChatMessage` handler for `attack-roll` / `spell-attack-roll` messages: if the **origin** actor is the frightened creature and the **target** actor's UUID is a key in its `antagonize` map, remove that entry.
2. **No sensing for a round.** On every turn change in an active combat (`combatTurnChange`), for each combatant that has an `antagonize` map, evaluate each entry: if the frightened creature currently senses the antagonizer (line of sight and detectability, reusing the `dungeon-combat.mjs` helpers from the creature's point of view), set `lastSensedWorldTime = worldTime`; otherwise, if `worldTime - lastSensedWorldTime >= 6` (one round), remove the entry. Sensing is therefore sampled at turn boundaries — an approximation of "continuously", noted explicitly; a creature that loses and regains sight between two turn changes within the same round is treated as having sensed the antagonizer.

Entries are also removed when the frightened creature no longer has the Frightened condition, when either actor is defeated or removed from the combat, and for all combatants when the combat is deleted.

### Reporting

The GM is whispered when a floor is created ("Antagonize: <target>'s Frightened can't fall below 1 while <source> holds it"), when it holds a decay at 1, and when it is cleared (with the reason: attacked the source, or lost sensing for a round), using the module's existing `whisperGm` convention.

## Error handling

- Unreadable context data (missing actor, target or outcome) → no floor is created; a handler never throws into the chat-message pipeline.
- A failing sense evaluation (token missing, no canvas) leaves the entry untouched for that pass and logs; it never clears a floor on error.
- Flag writes that fail are logged and reported to the GM; the underlying Demoralize result is unaffected.

## Testing

- **Pure helpers:** `frightenedFloorFor` (no flag → 0, one entry → 1, several entries → 1, malformed flag → 0), the entry-evaluation function (sensed → timestamp refreshed; not sensed for < 6 s → kept; ≥ 6 s → removed).
- **Create handler (mocked Foundry):** success and critical success by an actor with the feat create the entry; failure/critical failure, a non-Demoralize skill check, and an actor without the feat do not; works identically for a player-rolled and an AI-rolled message.
- **Clear handler:** an attack roll or spell attack roll by the frightened creature against its antagonizer removes that entry; against anyone else does not; a non-attack roll does not.
- **Decay integration (with #943):** Frightened 2 decays to 1 and then holds at 1 while an entry exists; decays to 0/removed once the entry is gone.
- **Lifecycle:** entries cleared on Frightened removal, defeat, and combat deletion.
- **Live verification:** a Swashbuckler with Antagonize Demoralizes a monster; the monster's Frightened holds at 1 across several of its turns, drops after it attacks the Swashbuckler, and drops after it loses sight of them for a round.

## Explicitly out of scope

- The baseline Frightened decay (#943).
- Counting saving-throw spells, maneuvers, Demoralize and other non-attack effects as hostile actions (decision 3); a possible later refinement.
- Applying the Demoralize condition itself (#909's executor or the player does that).
- Continuous per-frame sense tracking; sampling is at turn changes.
- Other Frightened-floor effects beyond Antagonize.

## Open questions

None. Implementation details left to planning: the exact helper signature #943 exposes for the floor, whether the sense check reuses the existing `detectableOpponents` result or calls `hasLineOfSight` directly, and the precise message flag fields used to read the origin and target actors on the installed system version.
