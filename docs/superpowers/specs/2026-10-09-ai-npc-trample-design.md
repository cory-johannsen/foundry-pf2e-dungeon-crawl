# Advanced AI Actors: Trample

**Issue:** #986 — Trample glossary abilities (basic Reflex save with size-based damage), deferred from #935.

**Builds on:** #932 / `docs/superpowers/specs/2026-10-08-ai-npc-movement-abilities-design.md` (the movement plan, the `npcMove` vocabulary entry and the generalized `strideByPosture` executor), #915 / `docs/superpowers/specs/2026-10-08-ai-npc-save-abilities-design.md` (save rolls and degree handling), #973 / `docs/superpowers/specs/2026-10-09-ai-npc-terrain-aware-movement-design.md` (terrain-cost pathing, which applies to the double-Speed Stride), #933 (limb-to-Strike resolution), #925's result descriptor, and the module's existing basic-save damage code (`castBreathWeaponAndApplyDamage` in `scripts/dungeon-combat.mjs`) and movement code (`posturePath`, `walkPath`, `otherCombatantFootprints`).

**Status:** Approved. Scope was decided in a clarifying-question session with the owner on 2026-10-09 (see "Resolved decisions").

## Summary

43 NPC actions in the bestiary data are **Trample**: a 3-action ability whose whole text is a glossary reference plus a size cap, a limb and a save DC. The monster Strides up to **double its Speed**, can move through the spaces of creatures of the listed size or smaller, and tramples each creature whose space it enters (once each); each trampled creature attempts a **basic Reflex save** against the ability's DC, and the monster deals the **damage of the listed Strike**. #915 left them out (they are damaging) and the breath-weapon code does not apply (there is no template).

This spec adds Trample as a plan kind of #932's `npcMove`: a dedicated parser for the glossary form, a route enumerator that paths through eligible **enemy** creatures, and an executor that walks the route, rolls **one damage roll** for the named limb's Strike, and applies it to every trampled creature scaled by that creature's save result. Enemies of the listed size or smaller are the only creatures it moves through.

## Investigation findings

Confirmed against the repo, the installed PF2e system and the local PF2e source data (Monster Core 1–2, Bestiary 1–3).

- **The glossary text (system, `PF2E.NPC.Abilities.Glossary.Trample`).** "The monster Strides up to double its Speed and can move through the spaces of creatures of the listed size, Trampling each creature whose space it enters. The monster can attempt to Trample the same creature only once in a single use of Trample. The monster deals the damage of the listed Strike, but trampled creatures can attempt a basic Reflex save at the listed DC (no damage on a critical success, half damage on a success, double damage on a critical failure)."
- **The ability item is almost empty.** Each Trample action's description is just `<size> or smaller, <limb>, @Check[reflex|dc:N|basic] @Localize[PF2E.NPC.Abilities.Glossary.Trample]`, for example "Medium or smaller, hoof, `@Check[reflex|dc:18|basic]`" (Centaur Herbalist), "Huge or smaller, corpse wave, … DC 37" (Warsworn), "Large or smaller, foot, … DC 25" (Stegosaurus). Cost is always 3 actions. The size distribution is Medium 15, Large 13, Huge 15; the limb names include hoof, foot, claw-like limbs and "corpse wave". No other rider is present, so there is nothing else to model.
- **Existing movement machinery is nearly sufficient.** `strideByPosture` plans a 2-D path, truncates it with `walkPath` to a Speed budget, and snaps tokens with `{ teleport: true }`-style updates. `walkPath` already lets a path **pass through an occupied cell** (#27: "still allowed to pass through this cell … but it never becomes the mover's own final resting cell") and only records an unoccupied cell as a stopping point, which is exactly the geometry Trample needs; wall edges (`movementBlockedEdges`) still block. #932 already adds a Speed budget factor and #973 adds a terrain cost function.
- **The save-and-damage executor exists.** `castBreathWeaponAndApplyDamage` rolls each target's save through `target.actor.saves[save].roll({ dc })`, reads the outcome from the created message, and applies damage with `roll.alter(0.5)` for a success, `roll.alter(2)` for a critical failure and no damage on a critical success, then `applyDamage` and `applyDefeatIfReducedToZero`. It rolls a **new damage roll per target** today; Trample's rule (decided below) is one roll for all.
- **Footprints.** Creature footprints use `footprint(token, gridSize)` (`gw`, `gh` squares), so Large and bigger creatures occupy several cells and a Large or Huge mover occupies a multi-cell footprint along its path.
- **Strike damage can be rolled once.** A strike action (`actor.system.actions` entry) exposes the damage roll the module already uses for Strikes; the system builds the roll with the actor's modifiers, and `DamageRoll#alter(multiplier, addend)` produces the scaled roll that `applyDamage` accepts, as in the breath-weapon code.
- **Reactions interplay.** The Trample Stride is a movement like any other; #931's movement events apply to it normally.

## Resolved decisions

1. **Roll the damage once and apply it to every trampled creature.** One damage roll of the named limb's Strike damage (as an area effect would), each creature applying its own basic Reflex save multiplier: none on a critical success, half on a success, full on a failure, double on a critical failure.
2. **Only enemies of the listed size or smaller are entered and trampled.** The AI never routes through allies, neutrals or larger creatures, and cannot end its move in an occupied square.

## Design

### Recognition (extends `scripts/npc-move-parse.mjs`)

`parseMovementAbility(item)` (#932) gains a **`trample`** branch tried before the movement grammar, because the Trample text has no movement sentence. It accepts an action item that references the Trample glossary entry (an `@Localize[PF2E.NPC.Abilities.Glossary.Trample]` token) **or** is named `Trample`, and whose text matches exactly `<size> or smaller, <limb>, @Check[reflex|dc:<N>|basic…]`:

```js
{ shape: "trample", cost: 3, plan: { kind: "trample", speedFactor: 2, maxSize: "med"|"lg"|"huge"|…, limb: "hoof", save: "reflex", dc: 18 } }
```

`maxSize` is one of `tiny`, `sm`, `med`, `lg`, `huge`, `grg` using the PF2e size ordering; "or smaller" means that size or any smaller one. Anything else in the text (a different save, extra sentences, an unknown size word) makes the item `null` (not offered). The limb resolves to a ready Strike with `matchMultiStrikeActionSlug`; an item whose limb cannot be resolved to a ready Strike is not offered.

### Route enumeration (extends `buildNpcMoveVocabulary`)

For each parsed Trample after #932's gates (cost 3 vs actions remaining, frequency):

- **Budget:** `2 × land Speed` in squares (cost units under #973's terrain cost function when the scene has terrain).
- **Eligible creatures:** opposing combatants (not defeated) whose `system.traits.size.value` is at most `maxSize`. Allies, neutrals and larger creatures are treated as **blocked** for this plan (their footprints are not enterable), unlike eligible enemies, which are **pass-through**.
- **Candidate routes:** for each opponent as a target, compute a path with `posturePath` toward it with the eligible enemies' footprints marked pass-through and everything else as the usual blockers; truncate with `walkPath` to the budget so the final resting cell is unoccupied. The **trample set** of a route is every eligible enemy whose footprint the mover's footprint overlaps at any step of the walked path (each counted once).
- **Ranking and cap:** routes are kept only if their trample set has at least one creature, deduplicated by trample set, ranked by enemies trampled (then by total expected damage using the limb's average damage against their saves), and capped at 6 entries.
- Entry: `{ type: "npcMove", shape: "trample", itemId, slug, name, cost: 3, posture: "approach", targetId, routeId, trampleIds[], summary }` with a deterministic `summary` ("Trample: Stride through the line, trampling 3 creatures (Reflex DC 18)"). Validation and the #909 reasoning call are as for other `npcMove` entries.

### Execution (extends `applyAgentDecision`'s `npcMove` branch)

1. Spend the cost through `turnState`; decrement frequency; post the usage message (`item.toMessage()`).
2. **Re-resolve the route** at execution time (creatures may have moved) with the same eligibility, and abort without spending the action if no creature can still be trampled.
3. **Walk** the route through #932's generalized stride executor with the double-Speed budget and the pass-through set, then recompute the **actual trample set** from the cells actually walked (a truncated move tramples fewer creatures).
4. **Damage roll once:** roll the named limb's Strike damage a single time through the system (non-critical, the actor's modifiers included) and keep the roll.
5. **Per creature (each at most once, in the order the path entered them):** roll the Reflex save against the DC through `target.actor.saves.reflex.roll({ dc: { value: dc } })`, read the degree, scale the **same** damage roll (`alter(0)` is skipped for a critical success; `alter(0.5, 0)` for a success; the roll unscaled for a failure; `alter(2, 0)` for a critical failure) and apply it with `applyDamage({ damage, token, outcome })`, then `applyDefeatIfReducedToZero`. The damage roll message is posted once; each save posts its own message as usual.
6. Announce publicly ("The mammoth tramples 3 creatures!") and report through #925's result descriptor listing each creature's save result and damage.

No Strike riders (Grab, Knockdown) apply: Trample uses the Strike's damage only.

### Reactions, terrain and reporting

- The movement events for #931 fire for the Trample Stride like any move (a creature with Reactive Strike can react as the mover leaves its reach), and #973's terrain costs and mode rules apply to the path.
- If the scene has no terrain and no relevant Regions, pathing is exactly as today.

## Error handling

- Parsing never throws; an item outside the exact form is `null` (not offered).
- A route with no walkable final cell (every cell occupied or blocked) is dropped.
- A save roll that throws for one creature is logged and skipped; the others still resolve and the shared damage roll is unaffected.
- A damage roll failure aborts the damage steps after the movement has happened, reporting to the GM (the creatures were still passed through).
- If the move is truncated to zero steps, the action is not spent.
- Reasoning-service failure → no Trample entries that turn; the existing candidate set proceeds.

## Testing

- **Parser (pure), real-text fixtures:** every size in the data (Medium, Large, Huge), limbs including "corpse wave", the glossary-token and name matches; near-misses that must return `null` (a different save, an extra sentence, an unknown size word).
- **Size ordering:** `maxSize` comparison for every pair of sizes ("or smaller" includes smaller and equal, excludes larger).
- **Route enumeration:** pass-through of eligible enemies, blocking of allies, neutrals and larger creatures, no ending on an occupied cell, trample sets for multi-cell footprints (Large and Huge on both sides), dedupe and ranking, the cap, no entry when no enemy can be trampled.
- **Executor (mocked Foundry):** the walked-path trample set after truncation, one damage roll shared by all, save-degree scaling (none, half, full, double), each creature at most once, public announcement, defeat handling per creature, partial failures, aborts.
- **Integration with #932/#973:** the double-Speed budget, terrain cost units, no regression for plain movement abilities.
- **Coverage audit:** all 43 Trample items parse; a golden file lists `{ creature, size, limb, dc }` so changes show in diffs.
- **Regression:** the breath-weapon and movement tests keep passing (breath weapons still roll per target).
- **Live verification:** a mammoth or stegosaurus trampling a line of party members and a monster that is truncated by a wall; confirm one damage roll applied with different save multipliers.

## Explicitly out of scope

- Changing the breath-weapon executor to roll once (it keeps rolling per target).
- Trampling allies, neutrals or creatures larger than the listed size.
- Trample variants that carry other riders (none exist in the data), and other movement abilities (#932/#972/#973).
- Prose interpretation by the reasoning model.

## Open questions

None; scope questions were resolved with the owner on 2026-10-09. Implementation details left to planning: how the limb's Strike damage roll is obtained without a critical, the exact pass-through marking in `posturePath` for multi-cell footprints, and the order creatures are trampled for chat reporting.
