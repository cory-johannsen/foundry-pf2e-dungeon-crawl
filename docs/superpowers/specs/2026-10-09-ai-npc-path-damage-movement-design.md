# Advanced AI NPCs: Path-Damage Movement Abilities

**Issue:** #1037 — path-damage movement abilities (Flaming Strafe, Spine Rake, Dance of Burning War), deferred from #972.

**Builds on:** #972 / `docs/superpowers/specs/2026-10-09-ai-npc-movement-riders-design.md` (movement riders, post-move save, immunity windows), #932 (the `npcMove` executor and movement parser), #933 (Strike-plus shapes, MAP handling), #915 (save executor, degree outcomes, area membership), #935 (outcome model), #925 (result descriptor), #909 (candidates).

**Status:** Approved. Scope was decided in a foreground question session with the owner on 2026-10-09 (see "Resolved decisions").

## Summary

Three NPC abilities deal save-based damage to creatures *along the movement path*. This spec records the path that #932's executor actually walks, computes each ability's affected set from that path with per-creature de-duplication, and applies the save and damage through #915's executor. Allies are affected as the text says; the movement planner prefers paths that hit more enemies than allies.

## Investigation findings

- **Flaming Strafe** (phoenix, 1 action, fire/primal): Fly up to Speed; deals `6d6` fire damage to each creature within **20 feet of each square** moved through (basic Reflex DC 37).
- **Spine Rake** (sea serpent, 2 actions, attack/move): Swim or Stride; each creature the serpent is **adjacent to at any point during its movement** takes `4d6+8` slashing (basic Reflex DC 32).
- **Dance of Burning War** (caldera oni, 3 actions, once per minute): Stride, then a melee Strike; if it hits, Stride again and Strike again, until a Strike misses or three Strikes are made; then each creature **hit by a Strike during the dance** takes `3d6` fire plus `3d6` electricity (basic Reflex DC 34).
- **Machinery that exists.** #932's `npcMove` executor walks a path with the module's movement helpers (and #972 added riders such as post-move saves, pushes and deferred MAP). #915's save executor rolls a save per creature and applies degree outcomes, including a pure area-membership helper. #933 specifies Strike-plus shapes with deferred MAP. The mover's executed cells are not recorded today, and nothing de-duplicates a creature across squares.
- **Hazards of path damage.** A creature may be within range of several squares (damage once), may move during the action (position at the time of passing counts), and allies are included by the text ("each creature").

## Resolved decisions

1. **All three abilities in scope.**
2. **Affected set from the executed path:** per square walked, the creatures within the ability's radius at the moment the mover passes (not before or after), each creature once.
3. **RAW on allies:** every creature the text names is affected; the model's candidate summary reports the enemy/ally counts and the move planner prefers paths hitting more enemies than allies.

## Design

### Path record (`scripts/npc-move-path.mjs`, pure helpers + executor hook)

#932's executor appends each cell to `pathLog = [{ cell, position, step }]` as it walks (the cell and the token center after each step). The record is returned in the executor's result and available to riders. Pure helpers:

- `creaturesWithinRadius(position, radiusFeet, creatures)` using the same distance function as #915's area helper (chebyshev squares to feet, measured from the cell center to the creature's token edge, matching PF2e's grid measurement).
- `adjacentCreatures(position, creatures)` = radius 5 ft between token squares (touching).
- `affectedAlongPath(pathLog, { radiusFeet | "adjacent" }, creaturesAt)` where `creaturesAt(stepIndex)` returns the creatures' positions at that moment. Returns a `Set` of creature ids with the first step at which each was affected. A creature already in the set is not added again.
- The mover itself, creatures that are not on the scene or are defeated, and the mover's own allies **are not excluded** (RAW). Excluded: creatures with the same token as the mover; hidden/undetected rules do not exempt (an area effect).

### Rider kinds (extends #972's rider table)

`parseMoveRiders` gains:

- `pathDamage: { shape: "radius" | "adjacent", radiusFeet?: number, damage: [{ formula, type }], save: { statistic: "reflex", dc, basic: true } }`. Recognition requires the sentence "deal(s) <damage> to each creature within N feet of each square they move through" (Flaming Strafe) or "each creature the <name> is adjacent to at any point during its movement takes <damage>" (Spine Rake) with a single `@Damage`/`@Check` enricher pair. Anything else → not offered (all-or-nothing).

### Execution

After the move resolves (and, if the move was interrupted, with the path actually walked):

1. Build `affected = affectedAlongPath(pathLog, rider, creaturesAt)` in path order.
2. For each affected creature, once: roll the damage (one roll per creature; PF2e rolls damage once per ability, then each creature rolls its save — so the damage roll is made **once** for the ability and shared) and call #915's save executor with the basic-save degrees, applying `applyDamage` with the outcome multiplier.
3. Report through #925: one record listing affected creatures, degrees and damage.
4. Immunity windows from #972 do not apply (no immunity text).

### Dance of Burning War (`strideStrikeChain`)

A three-action ability with a frequency. The executor:

1. Records `hits = []`. Loop up to 3 times: Stride toward the chosen target (existing movement executor, the same `pathLog`), make a melee Strike with the creature's best melee attack (MAP counts as ordinary Strikes in the sequence); if it misses, break; if it hits, push the target id to `hits` and continue.
2. After the loop (or the first miss), for each distinct creature in `hits` roll the Reflex save (DC 34, basic) and apply the combined `3d6` fire + `3d6` electricity damage (rolled once for the dance, each damage type separately for resistance), once per creature.
3. The frequency is spent when the first Stride begins; interrupted dances still spend it. Announce.
Recognition: the ability's text is matched exactly by a reviewed override entry (the item has a unique structure), with a fixture check; the combined damage and DC are read from the item's enrichers.

### Vocabulary and candidates

`npcMove` entries for these abilities carry `pathDamage: { enemies, allies }` — counts computed over the **planned** path (the same geometry helper, using current positions) — and a summary like "Fly up to 60 ft, 6d6 fire to everything within 20 ft along the path (≈3 enemies, 1 ally)". The path planner enumerates candidate destinations (as #932 does for `npcMove`) and picks, per target, the destination maximizing `enemies − allies` among legal paths; ties by shortest path. Dance of Burning War is a `npcStrike`-style entry with the chosen target.

### Reporting

Result descriptor extended with `affected: [{ name, degree, damage }]`. Fire/electricity resistances and immunities are applied by the system's damage application.

## Error handling

- Path record empty (no movement possible): no damage, the ability is not spent if the move could not begin.
- Interrupted movement (reaction, blocked square): damage uses the path actually walked.
- A creature leaving the scene mid-action is skipped.
- Missing damage/save enrichers: the ability is not offered.

## Testing

- **Geometry helpers:** radius and adjacency membership at each step, de-duplication, ordering, creatures at different positions as the mover passes, diagonal measurement, exclusion of the mover.
- **Parser:** recognizes both phrasings; rejects partial matches; fixture hash for each item.
- **Executor (mocked Foundry):** one damage roll shared by all, per-creature saves with degrees, interrupted path, allies included, frequency handling.
- **Dance of Burning War:** stops on first miss; maximum three Strikes; hit creatures de-duplicated; frequency spent.
- **Planner:** prefers paths with more enemies than allies; ties by path length.
- **Live verification:** a phoenix flies through the party and the line of damage matches the squares it passed; a sea serpent's spine rake hits those it swam beside.

## Explicitly out of scope

- Path damage that leaves lingering terrain or hazards.
- Movement abilities with damage only at the destination (covered by #972's post-move save).
- Excluding allies (a house rule; not allowed without owner approval).

## Open questions

None. Planning-time details: where the executor appends cells to `pathLog` and the grid-edge measurement function.
