# Advanced AI NPCs: Remaining Bespoke Movement-Ability Effects

**Issue:** #1038 — remaining bespoke movement-ability effects (difficult terrain, grab interactions, multi-Strike limits), deferred from #972.

**Builds on:** #972 / `docs/superpowers/specs/2026-10-09-ai-npc-movement-riders-design.md` (movement riders, charge, deferred MAP), #1037 / `docs/superpowers/specs/2026-10-09-ai-npc-path-damage-movement-design.md` (the executed `pathLog`, path saves), #932 (`npcMove` executor and parser), #933 (Strike-plus shapes, MAP), #986 (grab state), #915/#935, #925.

**Status:** Approved. Scope was decided in a foreground question session with the owner on 2026-10-09 (see "Resolved decisions").

## Summary

After #972 and #1037, four movement abilities still have trailing effects the module cannot model: **Devour All** (terrain changes along the path), **Skittering Assault** (a Strike per Stride at different creatures), **Impaling Charge** (a distance-conditional extra damage on a Strike after two Swims) and **Predatory Grab** (a Grab that carries the grabbed creature). This spec models all four as rider/override entries on the existing `npcMove` machinery, plus a **ranked coverage audit** for the remaining long tail with reviewed override entries for the top results.

## Investigation findings

- **Devour All** (vescavor swarm, 2 actions): the swarm Strides; all squares it occupies during the movement become difficult terrain; any creatures it moves through must succeed at a DC 21 Reflex save or fall Prone.
- **Skittering Assault** (gogiteth, 2 actions): Strides three times; once per Stride it may Strike a creature in reach at any point of that Stride; each attack must target a different creature; the multiple attack penalty is applied only after all the Strikes; a critical failure ends the ability.
- **Impaling Charge** (narwhal and six more creatures sharing the name, 2 actions): Swims twice and makes a tusk Strike; if it moved at least 20 feet from its starting position, the Strike deals an extra `1d10`. This is the shape #972's *charge* rider models (distance threshold, extra damage); it is verified against the rider table and added to the reviewed set if the phrasing is not yet covered.
- **Predatory Grab** (jungle drake, 1 action): "As Grab, but the grab doesn't end if they move away. Instead, they carry the Grabbed creature with them. A jungle drake can't Fly while grabbing a creature unless that creature can also Fly."
- **Machinery.** #972's rider table and executor already handle the charge, deferred MAP (`deferredIncrease`), push on hit and post-move saves. #1037 adds `pathLog`, per-square geometry and a path-save step. #986 holds the grab state (who holds whom). The module's scenes are built from walls and tile layers; temporary terrain is not modeled (see the terrain design below).

## Resolved decisions

1. **All four abilities in scope**, including Impaling Charge (verified against the existing charge rider) and Predatory Grab.
2. **A ranked coverage audit + reviewed override entries for the top N** for the long tail (N set by the audit, approved by the owner at planning); the rest stay out.
3. **RAW behavior throughout**; no house rules.

## Design

### Terrain along the path (Devour All)

New rider kind `terrainAlongPath: { effect: "difficultTerrain", scope: "occupiedSquares", duration: "encounter" }`. After the move, for each distinct cell in `pathLog` create the terrain marker:

- **Representation:** a Foundry **Region** (v14) on the scene covering the cell, with the PF2e system's difficult-terrain region behavior if the installed system provides one (verified at planning), else a module-owned region with `flags.pf2e-dungeon-crawl.difficultTerrain = true` that the module's own movement costing (`findPath` and the Stride/step helpers) treats as +1 cost per square. One region per ability use covering all cells (a union of grid squares), tagged with the combat id and removed at combat end.
- Terrain from this ability does not stack with existing difficult terrain beyond RAW (a square is either difficult or not).
- **Path save:** creatures the swarm moves through (token overlap with a path cell; the swarm is a large creature so "move through" is a creature occupying a square the swarm crosses) roll Reflex DC 21 through #915's save executor; on failure or critical failure they fall Prone (condition helper). Each creature once (#1037's de-duplication).

### Per-Stride Strike limits (Skittering Assault)

New rider/override kind `strideStrikeEach`: `{ strides: 3, strikesPerStride: 1, distinctTargets: true, deferredMap: true, endsOnCritFailure: true }`. The executor runs three Strides in sequence (the movement executor with a different destination each time chosen by the existing path planner toward unattacked foes); during each Stride, at the point of the Stride where a creature not yet attacked first comes within reach, it makes one leg Strike at that creature (variant index = the turn's current `mapIncrement`, per #933's deferred pattern); after the last Strike or the last Stride, `mapIncrement` advances by the number of Strikes made. If a Strike critically fails, the remaining Strides are skipped (the ability ends). Every attacked creature is recorded; a creature is never attacked twice.

### Charge variant (Impaling Charge)

If #972's charge rider already parses "If it moved at least N feet from its starting position, deals an extra XdY on this Strike" (it models a distance threshold and extra damage), no new code is needed beyond adding the phrasing to the rider grammar and the seven creatures' fixtures. The distance is the straight-line distance from the starting position to the Strike position (the rider's `straightLine`), matching the text "from its starting position", and the extra damage is added to the Strike's damage roll as an extra damage term (doubled on a critical like the rest of the Strike).

### Carry-while-grabbing (Predatory Grab)

Recognized as an override entry (the text refers to Grab). The Grab itself uses #986's grab state. The new rider `carryGrabbed` changes the grab's lifetime: normally a grab ends when the grabber moves away (the grabbed creature is no longer adjacent), but with `carryGrabbed` the executor keeps the grab and moves the grabbed token with the grabber: whenever the grabber's token moves (by the module's executors), the grabbed creature's token is moved to the nearest free square adjacent to the grabber's new position (teleport semantics, so wall collision does not strand it, per #141's `{ teleport: true }`). The flying restriction (`canFlyWhileCarrying` is false unless the grabbed creature has a Fly speed) is a filter on the ability's movement candidates: the drake's Fly Stride candidates are removed while it holds a creature that cannot fly. Escape releases the grab as usual.

### Long-tail audit (`tools/audit-movement-effects.mjs`)

Runs #932/#972's parsers over every NPC movement ability and lists those with unmodeled trailing text, ranked by the number of creatures sharing the ability name and by encounter frequency (how often the creature appears in generated dungeons). It emits a report and a fixture. At planning, the owner approves a top-N list; those get reviewed entries in the override table with fixture assertions, as in #947/#999.

### Reporting and vocabulary

All four abilities produce `npcMove` candidates with accurate summaries ("Strides 3 times, up to 3 leg Strikes at different creatures, MAP after"; "carries the grabbed creature while moving"; "squares occupied become difficult terrain; Reflex 21 or Prone"). Results report through #925 with the extra effects (terrain created, strikes made, carried creature).

## Error handling

- Region creation fails: the movement and save still resolve; the terrain is reported as not created to the GM.
- A carried creature with no free adjacent square: stays at its last position and the grab is released with a GM note.
- Interrupted movement: terrain covers only cells walked; Strikes made so far count.
- Missing enrichers: the entry is not offered.

## Testing

- **Terrain:** region created over unique cells, removed at combat end, movement costing treats it as difficult, no duplication of existing difficult terrain.
- **Skittering Assault:** distinct targets, one Strike per Stride, deferred MAP, ends on critical failure, fewer than three Strikes when no targets.
- **Impaling Charge:** threshold boundary at exactly 20 ft; extra damage doubles on a critical; all seven creatures' fixtures parse.
- **Predatory Grab:** carry movement, flying filter, release on Escape, no free square.
- **Audit:** ranking determinism; fixture of unmodeled abilities; override entries each have fixture assertions.
- **Live verification:** a vescavor swarm leaves difficult terrain behind it; a jungle drake carries a grabbed PC across the room.

## Explicitly out of scope

- Transformation moves and hide-in-place moves beyond the audited top N.
- Persistent terrain effects that outlast the combat.
- Movement abilities already modeled (#932, #972, #1037).

## Open questions

None. Planning-time details: whether the installed system has a difficult-terrain region behavior, and the audit's top-N cutoff.
