# Corridor routing and cell containment — design

**Tracks:** [#174](https://github.com/cory-johannsen/foundry-pf2e-dungeon-crawl/issues/174)

## Problem

Confirmed via two rounds of empirical investigation against the real
generation pipeline (`scripts/dungeon-deck.mjs` → `dungeon-layout.mjs` →
`dungeon-scene.mjs`), and confirmed live in Foundry (screenshot on
#174), the branching-dungeon-topology generator (#93) has two related
but distinct bugs:

1. **Corridor geometry crosses through other rooms' footprints in
   roughly 80% of generated dungeons.** Two independent root causes:
   - `exitFaceForIndex` (`dungeon-layout.mjs`) assigns a child's exit
     face (south/east/west) purely by index, with no regard to where
     the child actually lands in `computeColumns`' layout — a "3rd
     child → west" room routinely ends up *east* of its parent, so the
     corridor has to route backwards across the parent's own interior
     (~9.9% of edges).
   - `buildEdgeCorridor` does no obstacle-awareness at all — it draws a
     straight line (same-column) or an L-shaped two-segment path
     (different-column) regardless of what sits between source and
     target. A merge/detour target several ranks below its source
     (routine — a merge room's rank is `max(parent ranks) + 1`, #93's
     own design) draws a corridor straight through every intervening
     rank's row-band (~20% of edges).
2. **Every room's unused grid-cell margin is completely unwalled.**
   Every room/corridor sits inside a fixed `ROW_STRIDE`×`COLUMN_STRIDE`
   (13×13) cell regardless of the room's own actual size
   (`ROOM_SIZE_SMALL` = 6, 75% of rooms; `ROOM_SIZE_LARGE` = 12, 25%).
   `roomEnclosureWalls` only walls the room's own rect — the leftover
   margin (up to 7×13 units for a small room) has no walls at all.
   Confirmed live: this lets vision see straight through into open,
   unbuilt void space, and lets AI-controlled party tokens wander into
   that same void instead of staying inside the intended corridor path.

Two prior investigations (recorded on #174) ruled out cheaper
mitigations: fixing `exitFaceForIndex`'s face selection alone
eliminates the "own-room" crossings but leaves the overall ~80% broken
rate essentially unchanged (the two root causes are independent), and a
prototyped "margin-routing" middle ground (route through unused
grid-cell margin instead of full pathfinding) covers only ~57% of the
third-room-crossing cases and needs the same core "know about every
intermediate room, route around it" plumbing as full pathfinding — it
isn't actually a smaller implementation, and it doesn't touch problem 2
at all.

## Goals

- A corridor between any two connected rooms never visually crosses a
  third room's footprint, regardless of rank/column distance.
- Every room's full grid cell is sealed by walls except at genuine
  connection points (a real door, or a corridor's own pass-through) —
  closing both the vision leak and the movement leak.
- No regression to any existing generation invariant: single-entrance
  goal, 1-3 exits per non-entry/non-goal room, deterministic-per-seed
  output, the #110 create-before-delete ordering for superseded
  placeholders.

## Non-goals

- Changing room sizing or size variety (`ROOM_SIZE_SMALL`/`_LARGE` and
  their weights are unchanged).
- Changing the rank/column layout algorithm (`computeRanks`/
  `computeColumns` are unchanged — see Decision below for why).
- Diagonal corridors — routing stays orthogonal (north/south/east/west
  only), matching the existing visual style.
- Fixing combat-time token movement/pathfinding footprint issues — that
  is issue #140's own, unrelated territory (`pathfinding.mjs`,
  in-combat `stepToward`); this design is about dungeon *generation*
  geometry only.

## Decision

Two coordinated changes, confirmed with Cory, both scoped to
`dungeon-layout.mjs` (pure geometry/pathfinding, no Foundry) and
`dungeon-scene.mjs` (the Foundry wall/tile-building call sites):

- **Containment:** extend every room's enclosure-wall generation to
  wall its full grid cell, not just its own rect — reusing and
  extending the flanking-wall pattern `buildEdgeCorridor` already
  applies to a corridor's own strip, rather than inventing a new
  wall-generation concept.
- **Routing:** `buildEdgeCorridor` finds an actual path of cells
  between source and target (BFS over the rank/column grid, treating
  any cell occupied by a different room as blocked) before carving
  geometry, instead of assuming a direct or one-corner route.

**Why pathfind at build time instead of guaranteeing single-hop edges
at layout time** (the two candidates weighed): the alternative —
extending `computeColumns` to insert explicit transit cells so no edge
ever spans more than one rank/column — would touch the already-shipped,
already-reviewed layout algorithm and make dungeons visually sparser
(extra empty transit cells). Pathfinding at build time keeps
`computeRanks`/`computeColumns` untouched entirely, containing the
change to the corridor-building step and the room-wall step. Smaller
blast radius, chosen for that reason.

**Why the two changes are coupled, not independent:** pathfinding needs
a clean, binary "is this cell occupied by a room I'm not connecting to"
signal. Containment is what actually makes that distinction meaningful
at the wall level — today "empty cell" and "occupied cell" are only
distinguished in the room-graph data, never in the built geometry.

## Architecture

### Cell occupancy

A new pure helper, `cellBounds(rank, col)`, returns the full grid-cell
rect for a rank/column position:

```js
export function cellBounds(rank, col) {
  return {
    gx: INITIAL_GX + col * COLUMN_STRIDE,
    gy: rank * ROW_STRIDE,
    gw: COLUMN_STRIDE,
    gh: ROW_STRIDE,
  };
}
```

(Same origin `roomRect` already uses — a room's own rect is always the
top-left `roomSizeAt(seed, roomId)`-square sub-region of its cell.)

`occupiedCells` — a `Map<"rank,col", roomId>` — is derived once per
build pass from `state.layoutPositionByRoomId` (every room already
knows its own rank/col; this is a pure re-keying, not new state).

### Pathfinding

`findCorridorPath(fromPos, toPos, occupiedCells, { fromRoomId, toRoomId })`
(new, `dungeon-layout.mjs`, pure): BFS over the 4-directionally-adjacent
rank/column grid from `fromPos` to `toPos`. A cell is traversable if it
is empty, or if it's the source or target room's own cell; any other
occupied cell is blocked. Returns an ordered list of `{rank, col}` cells
from source to target inclusive (length 2 for adjacent cells with
nothing between them — the common case today — longer whenever a
detour around an occupied cell is needed).

**No-path fallback:** if BFS finds no route (a densely packed layout
with zero free cells to route through), fall back to today's direct
line between the two rects, logged as a warning. An imperfect corridor
beats a failed room build — this is a Review Focus-style degenerate
case, not a reason to throw.

### Corridor geometry

`buildEdgeCorridor` (reworked) takes the path from `findCorridorPath`
instead of just two rects, and emits, per adjacent pair of cells in the
path:

- At the two endpoints (source and target rooms' own rects): the same
  door/reveal-door wall pair it builds today, at the same
  `doorOffsetAt`/`northDoorSlots`-derived offsets.
- For every intermediate cell crossed (a cell in the path that is
  neither source nor target): floor tiles across the cell's own margin
  along the travel direction, flanking walls on either side of that
  strip (extending the existing `plainWalls` pattern from a single
  corridor width to the full cell), and — new — a wall segment sealing
  the *rest* of that cell's outer boundary (the part the corridor
  doesn't pass through), so an intermediate cell the corridor crosses
  is exactly as contained as an occupied room's cell is.

### Containment

`roomEnclosureWalls` (Task 5, extended) gains the cell-boundary walls
beyond the room's own rect. Concretely: a room's own south/east/west
faces are already walled today whenever they're not used for an
outgoing connection (`outgoingFaces` param) — that already seals the
room's interior from its own margin. What's missing is walling the
*outer* edge of the cell (the far side of the margin, at the cell
boundary) wherever the margin isn't being used as a corridor's own
travel path. Since a room's incoming connections are always north
(#93's Task 5 redesign) and its cell's north edge coincides with the
room's own north edge (rooms anchor at the cell's top-left corner, and
`roomSizeAt` never exceeds `COLUMN_STRIDE`/`ROW_STRIDE` on the axis that
matters — north is unaffected by size), only the east and south outer
cell edges ever need this treatment for a room smaller than
`ROOM_SIZE_LARGE`.

An empty cell that a corridor merely crosses (no room built there) gets
its full outer boundary walled the same way, with an opening only where
the corridor's own path enters and exits — built by the corridor-carving
step above, not by `buildRoomAtGraphNode` (nothing is ever built there
as a "room").

## Data flow

1. `occupiedCells` is derived once (`state.layoutPositionByRoomId` →
   `Map<"rank,col", roomId>`) before any connection is built for a room.
2. For each incoming connection (`sourceId → roomId`,
   `incomingConnectionsFor`, unchanged), call `findCorridorPath`.
3. Feed the returned path into the reworked `buildEdgeCorridor` along
   with the existing source/target rects and faces.
4. The caller (`buildPopulateAndUnlockGraphNode`) creates the endpoint
   doors exactly as today, and for each intermediate cell in the path:
   if it has no `dungeonCorridorCellBuilt` marker for *this crossing
   direction* yet, build its floor tiles + boundary walls (with the
   passthrough gap) and set the marker; if another edge already built
   this cell's corridor geometry from a *different* direction, add only
   the additional opening this edge's own crossing needs.

## Error handling / edge cases

- **No free path exists.** Fall back to the current direct-line
  corridor, log a warning. Never fail the room build over this.
- **Two different edges cross the same empty transit cell from
  different directions.** The idempotency marker for "this cell's
  corridor geometry is built" must be per-crossing-direction, not
  per-cell — a second edge needs to be able to add its own opening to
  an already-built transit cell rather than skip it as done, or
  duplicate the whole cell's walls.
- **Containment reopens already-shipped code.** `roomEnclosureWalls`
  (Task 5) and `buildEdgeCorridor`/`buildPopulateAndUnlockGraphNode`
  (Tasks 6/10/11/12, all from #93) are already shipped and reviewed —
  their existing tests will need updating to match the new wall/tile
  output, not just new tests added alongside them.
- **The #110 fog-leak-avoidance ordering still applies**: any new real
  wall geometry (endpoint doors, intermediate-cell pass-throughs) must
  be created before the frontier placeholder it supersedes is deleted,
  never the reverse — unchanged from #93's own convention, just
  extended to the new intermediate-cell geometry too.

## Testing

- Pure-function unit tests for `cellBounds` and `findCorridorPath`:
  blocked-cell avoidance, shortest-path correctness over a small hand-
  built occupancy map, and the no-path fallback.
- A regression sweep mirroring the investigation's own methodology:
  generate a large seed/roomCount range through the real
  `buildRoomGraph`/`attachHiddenPaths`/`computeRanks`/`computeColumns`/
  `buildEdgeCorridor` pipeline and assert **zero** corridor-vs-room-
  footprint overlaps (currently ~80% of edges show at least one). This
  is the test that actually proves the fix, not just unit coverage of
  the new pure functions in isolation.
- A containment sweep: for every built room (and every corridor-crossed
  empty cell) in a large generated sample, its full cell boundary is
  sealed except at genuine connection points.
- Live Foundry verification re-checking the two originally-reported
  live symptoms specifically: AI party movement staying inside
  corridors, and no vision leaking into unbuilt void space — the same
  boundary this codebase already uses for all Foundry-glue code (no
  automated test can exercise Foundry's own vision/pathing engines).

## Out of scope, tracked separately

Follow-up issue [#175](https://github.com/cory-johannsen/foundry-pf2e-dungeon-crawl/issues/175)
(unchosen sibling branches stay physically openable after a path is
chosen) is unrelated to this design and not addressed here.
