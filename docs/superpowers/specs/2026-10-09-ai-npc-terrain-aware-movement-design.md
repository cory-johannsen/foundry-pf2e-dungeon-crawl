# Advanced AI Actors: Terrain- and Elevation-Aware Movement (Fly, Swim, Burrow, Climb)

**Issue:** #973 — terrain- and elevation-aware movement for Fly, Swim, Burrow and Climb abilities, deferred from #932.

**Builds on:** #932 / `docs/superpowers/specs/2026-10-08-ai-npc-movement-abilities-design.md` (the movement plan, the `npcMove` vocabulary, the generalized `strideByPosture` executor that today paths every mode with the same 2-D wall/occupancy pathing and the mode's Speed), #972 / `docs/superpowers/specs/2026-10-09-ai-npc-movement-riders-design.md` (rider execution on top of the same movement), and the module's existing pathing and region code (`posturePath`, `walkPath`, `movementBlockedEdges`, `nearestHazardousRegionPoint` in `scripts/dungeon-combat.mjs`).

**Status:** Approved. Scope was decided in a clarifying-question session with the owner on 2026-10-09 (see "Resolved decisions").

## Summary

#932 gives every alternate movement mode the same flat 2-D pathing with a different Speed and notes that elevation is not modeled. This spec makes the modes **actually different**, by reading **terrain and elevation from Foundry scene Regions**:

- A **Fly** move ignores difficult terrain and ground obstacles, can cross water, chasms and lava, and puts the token at an **elevation**.
- A **Swim** move is only legal through water; a land mover cannot enter deep water.
- A **Burrow** move passes under ordinary floor (but not through masonry walls or stone Regions).
- A **Climb** move can cross climbable surfaces such as chasm walls.
- **Difficult terrain** (PF2e's own `environmentFeature` Regions) costs extra movement for walkers and is ignored by flyers.

The terrain data comes from Regions a GM places, using PF2e's difficult-terrain behavior and a new **Terrain** region behavior this module registers. **Dungeon generation does not author terrain** in this issue (#1043), so a generated dungeon without terrain Regions behaves exactly as it does today. Elevation is **set and respected** for pathing, Region tests, adjacency checks and display; distances for reach, range and templates stay 2-D.

## Investigation findings

Confirmed against the repo, the installed PF2e system (v8.5.0, `pf2e.mjs`) and Foundry v14.

- **Generated dungeons carry no terrain data.** A room has a creature-type `locationTag` (aberration, beast, construct, dragon, elemental, fiend, plant, ...) used for art selection and AI flavor; there are no water, lava, chasm or elevation fields in layout generation (`dungeon-layout.mjs`, `dungeon-scene.mjs`). The only terrain-like asset is a `corridor-rubble` tile. Nothing places Regions.
- **The module already reads Regions once.** `nearestHazardousRegionPoint(scene, token, gridSize)` filters `scene.regions` for those carrying the module's own `hazardous` flag and tests each of a token's 3×3 neighborhood cell centers with `region.testPoint({ x, y, elevation })` — the object form is required, passing `elevation` separately silently returns `false` (a live-confirmed footgun the code documents). It uses the token's own `elevation`.
- **PF2e already models difficult terrain with Regions.** The system registers a region behavior `environmentFeature` (`EnvironmentFeatureBehaviorType`) with `terrain.difficult` of 0 (none), 1 (difficult) or 2 (greater difficult), and an `environment` behavior for environment types. `TokenDocumentPF2e#difficultTerrain` reads a token's current terrain from the regions it is inside, and actors expose `system.movement.terrain.difficult.ignored` / `greater.ignored` (what the actor ignores) plus slowdown fractions. So both the data and the "ignores difficult terrain" notion already exist in the system.
- **The movement pipeline.** `strideByPosture(combat, combatant, posture, target, …)` computes `posturePath(start, targetCell, posture, speedSquares, isBlocked, bounds, moverFootprint)` where `isBlocked` is a wall-edge predicate (`movementBlockedEdges`) and occupied footprints block; `walkPath` truncates to the Speed budget in squares; movement is a `{ teleport: true }` token update. There is no per-cell cost and no mode argument beyond #932's Speed budget.
- **Elevation exists in Foundry and is already read.** `token.elevation` is part of every token document, Regions have an elevation range, and `Region#testPoint` takes it into account; the flanking indicator already watches `changes.elevation`. Nothing in the movement code writes it.
- **Module-defined Region behaviors are supported.** Foundry lets a module declare a `RegionBehavior` subtype (a data model registered in `CONFIG.RegionBehavior.dataModels` and declared under `documentTypes` in `module.json`), which then appears in the Region configuration UI. This is the standard way PF2e adds its own behaviors and is cleaner than hand-set flags.
- **Walk-over traps trigger on token entry** (#753). A flying creature should not trigger a pressure-plate trap, which makes elevation a rule that other modules of the code must respect.

## Resolved decisions

1. **Terrain data comes from Foundry Regions** (PF2e `environmentFeature` plus a module Terrain behavior); no generation in this issue. Authoring terrain during dungeon generation is #1043.
2. **All four modes are in scope:** Fly, Swim, Burrow and Climb.
3. **Elevation is set and respected for pathing, Region tests, adjacency and display only.** Reach, range and template distances stay 2-D, with a GM note where 3-D would matter.

## Design

### Terrain vocabulary (the module's Terrain region behavior)

A `RegionBehavior` subtype `pf2e-dungeon-crawl.terrain` (declared in `module.json` and registered at `init`) with a small schema:

```js
{ kind: "water" | "lava" | "chasm" | "rubble" | "stone" | "climbable" | "ceiling" , difficult: 0 | 1 | 2 }
```

- `water`: deep water; open to swimmers.
- `lava`: open to flyers; deadly (and flagged) to walkers.
- `chasm`: a void; open to flyers, climbers crossing its walls (via `climbable`), impassable to walkers.
- `rubble`: ordinary floor that is difficult terrain (default `difficult: 1`).
- `stone`: solid; blocks burrowing.
- `climbable`: a surface a climber can traverse, including across a chasm.
- `ceiling`: a low ceiling that blocks flying through it.

PF2e's `environmentFeature` Regions continue to supply difficult/greater-difficult terrain exactly as the system defines them, so a GM can use either. A scene with **no** Terrain behaviors and no PF2e terrain features has no terrain: every query returns "plain floor" and pathing is identical to today (the guarded fast path).

### Terrain query (`scripts/terrain.mjs`, small and mostly pure)

`terrainAt(scene, point)` takes `{ x, y, elevation }` (the object form `testPoint` needs) and returns `{ kinds: Set, difficult: 0|1|2 }` from the scene's regions: the union of Terrain behavior kinds, and the maximum of the PF2e and module `difficult` values. `makeTerrainContext(scene, gridSize)` caches the region list and returns a fast `at(cell, elevation)`; when the scene has no relevant regions it returns `null`, which callers treat as "no terrain" so the existing code path runs unchanged.

### Mode rules (closed table, `MODE_RULES`)

For a cell with terrain `{ kinds, difficult }` and a mover with mode `m` and elevation `e`, `cellCost` returns a number of movement units (1 normally), a larger cost for difficult terrain, or `Infinity` when the cell is not enterable:

| Mode | Enterable | Difficult terrain | Notes |
|---|---|---|---|
| `land` | any cell except `water`, `lava`, `chasm`, `climbable`, `stone`-blocked tunnels | costs ×(1 + difficult) unless the actor ignores that terrain (`system.movement.terrain.difficult.ignored`) | the default and the #932 baseline |
| `fly` | any cell except under a `ceiling` | ignored; `rubble` costs nothing extra | sets elevation (below); not subject to walk-over triggers |
| `swim` | only cells within `water` | none | a swim move whose path leaves water is not legal; a swimmer with a land Speed may leave water on a later land move |
| `burrow` | any cell except under `stone` | none | masonry walls still block (wall edges); the default floor is burrowable |
| `climb` | floor cells (as land, at the climb Speed) and `climbable` cells | as land | `climbable` cells connect across a `chasm` |

Wall edges and creature footprints block every mode exactly as today (`movementBlockedEdges`, `otherCombatantFootprints`): flyers pass over terrain but not through walls.

### Pathing changes (extends #932's generalized `strideByPosture`)

- `posturePath` gains an optional `cellCost(cell)` function (default: every cell costs 1) and treats `Infinity` as blocked. `walkPath`'s budget is in **cost units** rather than raw squares when a cost function is present; with no cost function behavior and results are unchanged.
- `strideByPosture` builds `cellCost` from the mover's mode, the terrain context, the actor's ignored-terrain data and the mover's current elevation, and passes it through only when the scene has terrain (otherwise `null`).
- **Per-segment cost:** #932's `npcMove` plan already carries the `mode` per segment; the cost function is built per segment.
- Results gain a reason when a move is cut short: `"blocked-by-terrain"` (with the terrain kind) next to the existing `"blocked"`/`"no-route"`, so the report can say why.

### Elevation

- **Fly:** when a Fly segment executes, the executor writes `token.elevation = max(current elevation, FLY_ELEVATION_FT)` (default 10 ft) before the move (so Region tests at the new elevation apply along the path), and leaves the token at that elevation afterward. A flyer that **lands** — a later land/swim/burrow/climb move, or a Stride — resets elevation to 0 at the start of that move.
- **Other modes:** elevation is 0 (burrowing is not modeled below the floor).
- **Region elevation ranges** are honored automatically because every terrain test passes the mover's current elevation to `testPoint`.
- **Adjacency, reach, range and templates stay 2-D.** The vocabulary and executors compute them from grid cells as today; when a flyer at elevation attacks or is attacked, the GM report notes "elevation not included in reach" so 3-D effects are visible rather than silently wrong.
- **Display:** Foundry already shows the elevation badge; no extra UI.

### Interactions with other modules

- **Walk-over traps (#753):** the trap trigger handler ignores tokens whose `elevation` is at or above a small threshold (default 5 ft), so a flying creature does not trigger a pressure-plate trap. A flyer that lands on a trap cell does.
- **Hazardous regions:** `nearestHazardousRegionPoint` is unchanged; a flyer at elevation still tests the point at its own elevation, so a hazardous Region with an elevation range of 0 does not affect it.
- **#932's availability checks:** the `npcMove` vocabulary uses the same cost/terrain pathing, so a swim move is only offered when a legal path through water to the target exists, a burrow move when not blocked by stone, a climb move across a chasm when `climbable` connects it, and a fly move that would pass under a ceiling is not offered. In a scene with **no** water, swim moves are therefore not offered at all; this is the intended RAW behavior and a consequence the GM can see in the report.

### GM tooling

- The Terrain behavior appears in the Region configuration dialog like PF2e's own behaviors.
- A short README section ("Terrain regions") describes the kinds, the PF2e difficult-terrain behavior, how elevation is written and the no-terrain default.

## Error handling

- Region or behavior lookups that throw yield "plain floor"; terrain never makes a move fail because of a read error.
- A malformed behavior (unknown `kind`) is ignored and logged.
- If writing `token.elevation` fails, the move proceeds at the previous elevation and the GM is notified.
- A cost function that returns a non-number for a cell is treated as cost 1.
- Terrain context creation failing falls back to the no-terrain path.

## Testing

- **Terrain query (pure over fake regions):** union of kinds, maximum of difficult values, elevation passed in the object form, no regions → `null` context.
- **`cellCost` per mode:** every row of the mode table, including difficult terrain doubling/tripling and ignored terrain, walls unaffected, `Infinity` for blocked cells.
- **Pathing:** `posturePath` and `walkPath` with a cost function (budget in cost units, difficult cells consuming extra budget, blocked cells routed around or reported), and identical results with no cost function (golden regression against the existing movement tests).
- **Mode scenarios (small synthetic scenes):** a flyer crossing a chasm and lava, a swimmer confined to water, a burrower blocked by stone and walls, a climber crossing a chasm via `climbable`, a walker blocked by water or slowed by rubble.
- **Elevation:** set on the first Fly segment, applied to Region tests, reset when landing; flying creatures do not trigger the walk-over trap handler, landing ones do.
- **Vocabulary:** swim moves not offered without water, fly moves under ceilings not offered, blocked-by-terrain reasons.
- **Region behavior:** the Terrain subtype's schema and registration (with stubs).
- **Regression:** #932/#972 movement tests, `strideByPosture`/`posturePath` tests and hazardous-region tests keep passing.
- **Live verification:** a scene with a water Region, a chasm and a rubble patch; a flying monster crossing the chasm and not triggering a trap; a swimmer confined to the water; a walker routed around water; confirm the report notes for assumptions.

## Explicitly out of scope

- Authoring terrain Regions during dungeon generation — #1043.
- Full 3-D distance for reach, range and templates (kept 2-D with a GM note).
- Burrowing below the floor with its own elevation, ceilings for non-flying movement, and falling damage.
- Reactions to terrain changes and terrain effects beyond movement cost and passability (lava damage, drowning).
- Prose interpretation by the reasoning model.

## Open questions

None; scope questions were resolved with the owner on 2026-10-09. Implementation details left to planning: the exact `module.json` declaration for the Terrain region behavior on Foundry v14, the default `FLY_ELEVATION_FT` and trap-trigger elevation threshold, and how `posturePath`'s existing cost-free callers are kept byte-for-byte unchanged.
