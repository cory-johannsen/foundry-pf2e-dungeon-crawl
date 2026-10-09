# Advanced AI Actors: Death-Triggered NPC Reactions (Ferocity, Strike Before Dying, Self-Destruct)

**Issue:** #959 — death/down-triggered NPC reactions (Ferocity, Final Spite, Death Frenzy, ...), deferred from #931.

**Builds on:** #931 / `docs/superpowers/specs/2026-10-08-ai-npc-reactions-design.md` (the reaction registry, `resolveReactions`, the reaction-used economy, the hybrid decision, the public announcement conventions), #915 / `docs/superpowers/specs/2026-10-08-ai-npc-save-abilities-design.md` (area template parsing, save rolls, basic-save damage) with #935's timed-condition grammar, #925's reporting, and the module's damage and defeat code in `scripts/dungeon-combat.mjs` (`applyDefeatIfReducedToZero`, `rollAndApplyStrikeAtVariant`, `autoResolveIfDecided`, `resolveCombat`).

**Status:** Approved. Scope was decided in a clarifying-question session with the owner on 2026-10-09 (see "Resolved decisions").

## Summary

When a monster is reduced to 0 Hit Points the module turns that into a defeat immediately — a dead monster does nothing more. Many monsters have a **reaction triggered by that drop**. This spec adds the `reducedToZero` trigger to #931's reaction registry and models three families whose subject is the reactor itself: **Ferocity** (the monster stays at 1 HP, Wounded increases, unusable at Wounded 3), **Strike before dying** (Final Spite, Death Frenzy, Death Slam), and **Self-Destruct** (a delayed area explosion that an adjacent creature can cancel). Reactions that fire when a *different* creature dies are filed separately (#1019).

The trigger is caught at the module's own damage seam — `applyDefeatIfReducedToZero` — **before** the defeat is applied, with a fallback hook for damage the PF2e system applies itself that undoes the system's automatic defeat when the reaction cancels it. Death reactions are always automatic (deterministic policy, no confirmation) and announced publicly.

## Investigation findings

Confirmed against the repo, the installed PF2e system and the local PF2e source data (Monster Core 1–2, Bestiary 1–3).

- **The seam exists.** `applyDefeatIfReducedToZero(target)` (`dungeon-combat.mjs`, ~3560) is the single function the module calls after it applies damage — five call sites cover AI Strikes, multi-strike bundles, spells and the manual-Strike handler. It returns early if HP is above 0; for a character it adds the `dying` condition, for an NPC it calls `target.toggleDefeated()` (plus the death sound). Nothing runs in between, so a reaction can run at the top of it before defeat is applied.
- **System-applied damage bypasses the seam.** When a GM or player clicks the system's own damage-card button (spell damage, non-Strike damage), the PF2e system applies the damage and marks an NPC combatant defeated at 0 HP on its own. The module's `updateActor` hook (`dungeon-combat.mjs` ~859) sees this only afterward, and `autoResolveIfDecided` then reacts to the defeat; there is no point where a reaction can run first.
- **Population (bestiary data).** 34 death-triggered NPC reactions across 12 ability names. Subject is the reactor itself: **Ferocity** (16 uses, a glossary-form reaction, plus **Mortic Ferocity**, which adds Concealed to a Ferocity), **Final Spite** (Wight: a Strike before being destroyed), **Death Frenzy** (Reefclaw: a claw Strike before dying), **Death Slam** (Argorth: a tail Strike against a random creature within reach), **Self-Destruct** (Clockwork Dragon, 2 uses). Subject is another creature or a part (#1019): Reawaken! (6), Soul Feast, Preserve Prey, Responsive Recovery, Material Leap, Scuttle Away.
- **Ferocity's text (glossary, RAW).** "Trigger: The monster is reduced to 0 HP. Effect: The monster avoids being knocked out and remains at 1 HP, but its Wounded value increases by 1. When it is Wounded 3, it can no longer use this ability." Mortic Ferocity additionally makes the lifeleecher Concealed until the end of its next turn.
- **Self-Destruct's text.** "Trigger: The clockwork dragon is reduced to 0 Hit Points. Effect: The dragon screeches to a stop and emits a steady, loud ticking sound. At the beginning of what would have been its next turn, the dragon explodes, dealing 12d10 piercing damage in a 40-foot emanation (Reflex DC 37 basic save). An adjacent creature can cancel the self-destruct sequence by succeeding at a Thievery DC 37 check to Disable a Device." The item description carries the structured enrichers: `@Damage[12d10[piercing]|options:area-damage]`, `@Template[emanation|distance:40]`, `@Check[reflex|dc:37|basic|options:area-effect]` and the cancel check `@Check[thievery|dc:37|traits:action:disable-a-device]`.
- **The combat can end before the explosion.** `autoResolveIfDecided` resolves the combat as soon as every hostile is defeated, which would skip a pending Self-Destruct entirely.
- **Reaction economy exists** (`getReactionUsed`/`markReactionUsed`, #202/#931); Wounded is the system's own condition (`actor.increaseCondition("wounded")`, value readable from `actor.itemTypes.condition`).
- **Chat hooks exist for the cancel check.** A Disable a Device skill check is a normal chat message (`flags.pf2e.context`: action option, outcome, actor, target), already the style of signal #202/#931 use.

## Resolved decisions

1. **First slice: Ferocity, Strike before dying, and Self-Destruct.** Reactions triggered by another creature's death are #1019.
2. **Timing: the damage seam plus an `updateActor` fallback.** Run the reaction inside `applyDefeatIfReducedToZero` before defeat is applied; for system-applied damage, run it from `updateActor` after the fact and undo the system's automatic defeat when the reaction cancels it.
3. **Always automatic.** Death reactions use a deterministic policy with no confirmation, in every mode (human GM present or not), and are announced publicly.

## Design

### The `reducedToZero` trigger in the registry

#931's `REACTION_DEFS` gains a trigger kind `reducedToZero` and three definition kinds. `resolveReactions(combat, { trigger: "reducedToZero", reactor })` applies the usual shared gates (the reactor is agent-controlled, has the matching reaction item, has not used its reaction this round) and then the per-kind eligibility and policy below; a creature has one reaction per round, so at most one runs. The decision is deterministic: when several definitions match (rare), they run in priority order and the first that applies consumes the reaction.

| Reaction | Kind | Eligibility | Policy |
|---|---|---|---|
| Ferocity (and `<name> Ferocity` variants such as Mortic Ferocity) | `cancelDefeat` | Wounded value < 3 | always |
| Final Spite, Death Frenzy, Death Slam | `dyingStrike` | a ready Strike with the named limb and a legal target in reach | always |
| Self-Destruct | `delayedBlast` | the item parses as a delayed area effect | always (the text says it *must* be used) |

Matching uses the reaction item's name (and, for Ferocity, a glossary reference to the Ferocity entry) from the definition's `match`, as for the other registry entries.

### Where it is caught

1. **Module seam (primary).** At the top of `applyDefeatIfReducedToZero(target)`, after the HP check and for NPC targets that are agent-controlled combatants: call `resolveReactions(... "reducedToZero" ...)` and `await` it. If it reports `cancelled` (Ferocity), return without applying defeat. Otherwise continue and apply defeat as today (Strike-before-dying has already resolved; Self-Destruct has recorded its pending explosion and the creature is still defeated as normal). Player characters keep their existing `dying` handling (an AI-controlled character's feat reactions are #962).
2. **System-applied damage (fallback).** A new handler on the existing `updateActor` hook: when an NPC actor's `system.attributes.hp.value` changed to 0 or below, the actor belongs to a module combat, its combatant is already defeated by the system, the reaction has not been handled for this drop (a per-round flag `deathReactionHandled`), and an eligible definition exists → run the same `resolveReactions`. If Ferocity cancels, restore HP to 1 and `toggleDefeated()` again to clear the system's automatic defeat. Idempotence is enforced by the flag and by `markReactionUsed`.

### Ferocity (`cancelDefeat`)

1. `markReactionUsed(combat, reactorId, round)`.
2. Set the actor's HP to 1 (`actor.update({ "system.attributes.hp.value": 1 })`) and `actor.increaseCondition("wounded")`.
3. For `Mortic Ferocity`-style variants, parse the trailing sentence with #935's condition-and-duration grammar ("becoming Concealed until the end of their next turn") and apply it through #915's timed-condition helper; a variant with any sentence the grammar does not consume is not offered (all-or-nothing).
4. Announce publicly ("<name> refuses to fall!") and report through #925's result descriptor.

The seam then skips defeat; the fallback path undoes the automatic defeat as described.

### Strike before dying (`dyingStrike`)

1. `markReactionUsed`.
2. Choose the target: Death Frenzy and Final Spite use the existing deterministic opponent selection for a Strike in reach (the highest-priority opponent the named limb reaches); **Death Slam** picks a **random** creature within reach using the module's seeded generator (`splitmix32(seedFromString(...))` over combat id, round and reactor id), so the choice is reproducible.
3. Execute through `rollAndApplyStrikeAtVariant(combat, reactor, target, limbSlug, 0)` (variant 0, a reaction Strike), which also applies damage and any strike riders.
4. Announce publicly ("<name> lashes out as it falls!").

Because the seam runs before defeat, the reactor is still a live combatant; on the fallback path (already defeated by the system) the roll still works because the Strike does not depend on defeat state.

### Self-Destruct (`delayedBlast`)

1. **At the trigger:** parse the item (pure parser `parseDelayedBlast(item)` in `scripts/npc-reactions-death.mjs`) into `{ damageFormula, damageType, templateShape, distanceFeet, save, dc, cancel: { statistic, dc, action } }` from the structured enrichers; an item that does not yield every field is not offered. Record a pending blast on the combat: `flags.pf2e-dungeon-crawl.pendingBlasts = [{ reactorCombatantId, tokenCenter, round, params }]`, `markReactionUsed`, and announce publicly ("<name> screeches to a stop and begins to tick…"). The creature is still defeated normally (it has dropped).
2. **Detonation:** on the combat turn change that reaches the reactor's turn in the following round (the "beginning of what would have been its next turn"), a handler for the existing combat turn hook resolves the pending blast: all creatures in the emanation (centered on the recorded position, using the same template geometry as #915's area executor) roll the Reflex save against the DC, and basic-save damage is applied through `applyDamage` (degrees: critical success no damage, success half, failure full, critical failure double). The result is announced publicly and reported to the GM.
3. **Cancellation:** a `createChatMessage` handler watches for a Disable a Device skill check (the action's roll option `action:disable-a-device`) whose outcome is a success and whose rolling actor is adjacent to the pending reactor token; on a match the pending blast is removed and announced ("the ticking stops"). This works for player and AI rolls alike. The cancel check's own DC is the parsed `dc`; the module does not roll it, it only recognizes a successful check made with that DC or lower.
4. **Combat resolution is held.** While any pending blast exists, `autoResolveIfDecided` does not resolve the combat even though every hostile is defeated, so the explosion cannot be skipped; once detonated or cancelled the combat resolves as normal. If the party has no creature that can reach the reactor, the blast still detonates at its turn; combat length is bounded by the remaining initiative order.

### Reporting and policy

All three families announce publicly in chat and report through #925's result descriptor. None needs the #931 hybrid model call: each definition has exactly one deterministic policy ("always"), and the model is consulted only if several definitions match the same trigger.

## Error handling

- A failure in the seam hook is logged and the defeat proceeds exactly as before; a death reaction never prevents a defeat from being applied by throwing.
- If Ferocity's HP restore or Wounded increase fails, the fallback undo is not performed and the defeat stands.
- A `toggleDefeated` undo that fails leaves the creature defeated (safe default) and is reported to the GM.
- An unparseable Self-Destruct item is simply not offered; a pending blast whose data is corrupt is dropped with a GM note rather than detonating partially.
- A missing token or position for a blast cancels it with a GM note.

## Testing

- **Registry:** match rules for Ferocity (name and glossary), `<name> Ferocity` variants, Final Spite, Death Frenzy, Death Slam, Self-Destruct; reaction economy; Wounded 3 limit; priority order.
- **Seam:** `applyDefeatIfReducedToZero` runs the reaction first for an eligible agent-controlled NPC; Ferocity cancels defeat; a non-eligible or human-controlled target is defeated as before; characters keep `dying`.
- **Fallback hook:** a system-applied 0-HP update triggers the reaction once (idempotence via `deathReactionHandled` and the economy), Ferocity restores HP and clears the automatic defeat, a failed undo leaves the creature defeated.
- **Strike before dying:** target selection (deterministic and seeded random for Death Slam), executor call shape (limb, variant 0), works for an already-defeated combatant.
- **Self-Destruct:** `parseDelayedBlast` on the real Clockwork Dragon text and on malformed text; pending blast recorded; detonation at the right turn with correct save/damage degrees and template membership; cancellation by a successful adjacent Disable a Device check (and not by a failure or a non-adjacent actor); `autoResolveIfDecided` held while pending and released after.
- **Mortic Ferocity:** concealed applied with the right duration; a variant with unparsed text is not offered.
- **Regression:** existing defeat, loot conversion (#172), `autoResolveIfDecided` and #202/#931 reaction tests keep passing.
- **Live verification:** a Ferocity monster dropped by an AI Strike and by a system-applied damage card (it stays at 1 HP, Wounded rises, the third time it falls); a Reefclaw/Wight striking as it dies; a Clockwork Dragon counting down, being disarmed by a player once, and exploding once.

## Explicitly out of scope

- Reactions triggered by *another* creature's death or by a part being destroyed (Soul Feast, Preserve Prey, Reawaken!, Responsive Recovery, Material Leap, Scuttle Away) — #1019.
- AI-controlled **party characters'** death reactions (for example an ancestry Orc Ferocity feat) — #962.
- Player-controlled actors' own reactions.
- Reactions triggered by other drops (saves, spells, approaches) — #960 and #961.

## Open questions

None; scope questions were resolved with the owner on 2026-10-09. Implementation details left to planning: the exact existing combat turn hook the detonation handler attaches to, how the template geometry helper is shared with #915's executor, the Ferocity item-matching rules against the real item names, and where `deathReactionHandled` is stored.
