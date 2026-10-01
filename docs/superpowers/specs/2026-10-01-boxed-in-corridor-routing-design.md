# Boxed-in corridor routing — design

**Tracks:** [#427](https://github.com/cory-johannsen/foundry-pf2e-dungeon-crawl/issues/427)
(found live during #415 verification; not caused by #415).

**Status:** design only. Open questions for the user are at the end; the
recommendation below depends on the answer to Q1.

## Problem

A real edge can have no grid path, and `buildEdgeCorridor` then draws a
direct line or corner straight through whatever occupies the cells in
between. Live repro (scene `vPjL50w7nUMOZIT3`, seed
`1790888990336-dby1e140idu`): `room-room-entry-1` (r1c2) -> `room-merge-3`
(r3c0). merge-3's `incomingFace` is `'north'`; its only legal entry cell
r2c0 holds its other parent `room-room-room-entry-0-0`, which
`findCorridorPath` treats as blocked, so the BFS returns `null`.

The same shape reproduces offline as `sweep-0` (`room-room-entry-1` r1c2
-> `room-merge-3` r3c0, identical positions), which is the fixture used
below.

User-chosen direction (recorded on #427): fix the multi-cell transit-cell
machinery, then redo the `incomingFaceFor` change that picks `'west'`
when the north gate cell is held by a co-parent. That change was tried and
reverted as net-negative because transit-cell geometry mishandled the extra
detours.

This spec re-measures both halves of that plan against today's `main`
(0.54.49, layoutVersion 2 live) before committing to it, because the
machinery the revert blamed has changed a great deal since (#225, #230,
#288, #294, #297, #324, #353, #355, #359, #415).

## What was tried before, and why it failed

All three attempts are `#174` / `column-gap-packing` history. Commit hashes
are from `git log -S` / `--grep`.

1. **`trunkLaneCorridorSegments`** (born in `bdcd209`, deleted in `338d99c`,
   2026-09-26). A 3-segment detour along a cell's far edge used for the
   null-path case. Its own review found it "100% broken for west-exit
   connections, and roughly half its remaining cases bisected by a real
   containment wall". Replaced by today's honest direct-line fallback, a
   documented limitation. Shape of the failure: a hand-drawn corridor that
   was never reconciled with the containment walls of the cells it passed
   through.
2. **Exempt a target's `legitimateSourceIds` in `findCorridorPath`'s
   `isBlocked`** (`f24c70f`, reverted by `2884101`). Unsound (final-review
   C1): a path routed straight through a co-parent's own room as empty
   transit space, then `buildTransitCellIfNeeded` built full containment
   walls over that room's cell and could seal the co-parent's own door.
3. **`incomingFaceFor` picks `'west'` when the north gate occupant is a
   co-parent** (a legitimate occupant counts as an open gate only if it is
   the room's SOLE source; `2884101`, reverted by `b0595cb`, 2026-09-27).
   Measured at the time: ~1,083 previously-direct connections became
   detours and ~89% ended with their own target door covered by a wall.
   Causes named then, all in the multi-cell machinery: (a) the last transit
   cell's exit offset was independent of the target's real door; (b)
   consecutive transit cells' crossing points did not line up on a shared
   border; (c) a second edge crossing an already-crossed cell with the same
   entry/exit side pair was dropped (idempotency marker lacked the edge
   id). These were filed as #225 and **fixed** on 2026-09-28 (#228 chained
   crossing points, #233/#230, marker includes the edge id).

So defects (a)-(c) that justified the revert are already fixed. The
question this spec answers is whether the redo is now a net win, and what
else blocks it.

## Measurements

All numbers are the 500-seed sweep (`tests/helpers/layout-sweep.mjs`,
`buildSweepLayout`, rest room spliced, real + hidden edges, layoutVersion 2
plan selector, door slots with priority), 9,930 edges. The scratch scripts
used are not committed; Phase 0 below turns them into ratchets. Nothing
here was verified in a live Foundry world; wall geometry is computed from
the layout functions, which is what the scene builds.

### Baseline (today)

| Metric | Value |
| --- | --- |
| Null-path edges | 2,470 (24.9%) |
| Intermediate-room overlaps | 1,316 (all null-path; 0 on found paths) |
| Multi-cell (detour) edges | 2,077 |
| Target door covered by a wall (last transit cell gap vs door) | 0 (the #225 fix holds) |
| Chain mismatches between consecutive cells | 0 |
| Transit cells used by 2 or more distinct edges | 1,257 of 4,546 |
| Edges whose floor is cut by ANOTHER edge's flank wall in a shared cell | 526 edges, 861 occurrences |
| Different-edge floor intersections inside one cell | 510 |
| Target-room overlap (#416) | 2,272 edges; 2,102 are exactly one cell (the door-cell tile just inside the target rim), 170 (all west-incoming) are 2-9 cells |

Every wall that cuts a floor is another edge's flank wall (the #355
sealing of a crossing's own passage). No containment wall and no
edge's own flank wall cuts a floor. That is a distinct, pre-existing
multi-cell defect: **two edges crossing one cell are built independently**,
so one edge's flank walls slice through the other's corridor. The #225 fix
chained crossing points within one edge; nothing coordinates two edges in
the same cell. It is real corridor severing in the built scene, in about
5% of edges today, and was never measured because the sweeps only check
found paths against room footprints.

Sample (seed `sweep-10`, cell r0c2): edge A (`room-entry` ->
`room-room-entry-1`) runs west->south as a vertical lane x=326..327,
y=2..13; edge B (`room-room-room-entry-0-0` -> `...-0-0-2`) runs west->east
as a horizontal lane at y=10. A's flank walls at x=326 and x=327 cut B's
floor; B's flanks at y=10 and y=11 cut A's. Different targets.

### Why the null edges are null

| Class (2,470) | Count |
| --- | --- |
| `incomingFace` north, north gate held by a co-parent (the live repro) | 2,275 |
| ...of which the west face has a path (what the redo would rescue) | 676 |
| ...of which the west face has NO path either | 1,599 |
| `incomingFace` already west, still unreachable | 195 |

The 1,599 are the key finding. computeColumns gives the trunk a single
column (the live repro and `sweep-0`: column 0 holds ranks 0-5). The west
cell of a merge room on that column, (3,-1), can only be reached around
the end of the trunk: rank -1 is excluded by the BFS bound
(`minRank = max(0, ...)`) and rank 6 is outside `SEARCH_MARGIN = 2`.
Widening the search does not rescue this sensibly: reachable at margin 8 for
2,337 of 2,470 edges, but the median path is 18 cells and the 90th
percentile 25. Not a corridor, a tour of the map.

Geometry of the null edges (dc = target column minus source column; dr =
rank gap), with how many overlap an intermediate room:

| Shape | Null | Overlap |
| --- | --- | --- |
| target-west, dr 2, in north | 673 + 59 hidden | 626 + 50 |
| target-west, dr 1, in north | 479 | 124 |
| target-west, dr 3+, in north | 271 + 118 hidden | 253 + 113 |
| same-column, dr 2 | 381 + 222 hidden | 0 + 0 (#297 dogleg covers it) |
| same-column, dr 3+ | 17 + 34 hidden | 17 + 34 |
| target-west, in west (all dr) | 97 + 54 + 33 + 11 | 25 + 10 + 33 + 11 |
| target-east, out east | 15 + 4 + 2 | 15 + 3 + 2 |

The same-column dr 2 class is already handled (#297 Round 1 dogleg through
the blocker's margin band, Round 2 slot priority). The 1,316 are the
**corner branch**: a second parent EAST of a merge room that is directly
below its co-parent. `buildEdgeCorridor`'s corner geometry runs a
horizontal leg in the source's south margin row, then a vertical leg at the
target slot's x, through the cells above the target, which is where the
co-parent sits. #297 explicitly left this branch out of scope.

### The redo, measured

Two variants of `incomingFaceFor` were run against the same sweep, plus the
current rule:

- `sole`: the reverted attempt (a legitimate gate occupant counts only as
  the sole source).
- `pathaware`: per room, compute both faces' null counts for that room's
  real incoming edges and take the lower; tie goes to today's rule. The
  null set is separable per target (a path depends only on the target's
  face and the fixed occupancy), so this is monotone non-increasing on null
  edges by construction.

| Metric | current | sole | pathaware |
| --- | --- | --- | --- |
| Null-path edges | 2,470 | 1,794 | 1,794 |
| Intermediate-room overlaps | 1,316 | 1,323 | 1,302 |
| Multi-cell edges | 2,077 | 3,850 | 3,395 |
| Rooms with west incoming | 831 | 1,928 | 1,473 |
| Edges with a cut floor (shared cells) | 526 | 1,713 | 1,679 |
| Cut occurrences | 861 | 2,588 | 2,528 |
| Transit cells shared by 2+ edges | 1,257 | 2,717 | 2,589 |
| Target-door covered (multi-cell) | 0 | 7 | 7 |
| Target overlap of 2+ cells (west) | 170 | not measured | 562 |

Even the best case, which cannot rescue more than 676 edges (27% of the null
set) because of the trunk, converts null edges into detours and leaves the
**intermediate-overlap count flat (1,316 -> 1,302, about 1%)**: the nulls it
leaves are the worse-geometry ones (the null fallback to a west-incoming
target overlaps an intermediate room in 78% of cases, versus 54% for a
north-incoming one today). At the same time it triples the shared-cell crossings
(cut floors 526 -> 1,679 edges) and exposes a west-target geometry fault (7
covered doors, 562 deep target overlaps). So the redo is net negative on
buildability today (it repeats the 2026-09-27 outcome with different
causes) and, **even fixed**, caps at removing under 30% of the null edges
and about 1% of the overlaps. It does not achieve the issue's actual goal
(no corridor through an occupied room).

### Reservation as an alternative to lane allocation

An obvious way to stop shared-cell cuts is to forbid sharing: route edges in
a fixed order and block cells already used by an earlier edge's transit
chain. Measured: null edges 2,470 -> 2,977 (+507) on current faces and
1,794 -> 3,030 (+1,236) with pathaware faces. Merging edges necessarily
share the cells near their target, so exclusivity manufactures nulls.
Rejected; lane allocation inside shared cells is the route.

### How constrained is a shared cell?

Of 1,800 shared-cell edge pairs, only 17 are forced to cross by their entry
and exit sides alone (all four sides distinct and interleaved; none with the
same target). The rest are orderable by choosing offsets within a side. But
the 510 observed intersections show that the real constraint is not the
sides: each edge's end points are pinned (source door and target door, by
the #225 chain), so within-side ordering is partly fixed upstream. The
sample above (A's west point above B's, forcing a crossing; reversed it
would nest) is the typical case. Whether a consistent assignment exists for
all of them is the first unknown (Phase 1 prototype).

## Goals

- No corridor segment of any real or hidden edge lies inside a room that is
  neither its source nor its target (intermediate overlaps 1,316 -> 0 for
  edges that are not provably boxed in; found paths already 0 and stay 0).
- No wall cuts another edge's corridor floor in a shared transit cell
  (861 -> 0). Independent of the redo: a bug today.
- No movement or sight leak and no progression bypass (see Containment).
- Deterministic and seed-stable: a fixed seed produces identical geometry
  every time, independent of edge/iteration order.
- Existing runs keep their geometry (layoutVersion gate).
- Every phase is a ratchet: no metric above may rise, in any phase.

## Non-goals

- The one-cell door-tile overlap of the target room (2,102 of the 2,272
  `#416` edges). Whether it is intended is #416's call (Q5); this spec only
  keeps it from growing and fixes the 2-9 cell west cases because they are
  caused by the geometry this spec touches.
- #415 Chunk 5 lane conflicts (sibling corridors from one source sharing
  the source's south margin row).
- Changing `computeColumns`, room sizes, or `CORRIDOR_LEN` / stride (every
  layout would shift).
- Live Foundry verification of the cut floors (computed, not observed;
  Phase 0 adds one live check).

## Approaches considered

**A. The user-chosen plan: fix multi-cell machinery, then redo
`incomingFaceFor` west.** The first half is real and independently worth
doing (861 cuts today). The second half, measured above, rescues at most 27%
of the null edges and moves overlaps by about 1%. It can be shipped as an
enabler later but is not the fix.

**B. Margin-lane pass-through for the corner branch (generalize #297).**
Every occupied cell has an east margin strip (full cell height) and a south
margin strip (full cell width), each at least `CORRIDOR_LEN` wide (exactly
one cell for a LARGE room). The corner branch's vertical leg shifts into
the co-parent's east margin strip, jogs back along its south margin row to
the target slot, and goes down. This is #297's Round 1 dogleg, which
already works (same-column dr 2: 0 overlaps across 603 edges), extended to
the corner branch and to dr 3+. It avoids the trunk entirely, adds no cells
to the path, and stays inside the existing margin-wall machinery
(`cellMarginWalls` already supports several openings per side; #297
generalized it). The risk is #297's history: Round 1 sealed 375/380
co-parent doors; Round 2 slot priority fixed most but left residuals
(#309: same-size blocker/target, 54 cases; `pendingForeignMarginOpenings`
disagreeing with the real corridor on the slot).

**C. Lane plan for shared cells, then B and/or A on top (recommended).**
Build the plan layer that A's first half needs (one pure function
assigning every crossing in every cell non-conflicting lanes, from the whole
layout), then re-measure; use B for the corner branch; keep A's `'west'`
choice as a later, ratcheted option only if it still nets positive.

**D. Re-layout to avoid the shape.** Place a merge room so its two parents
have distinct reachable faces (e.g. offset the merge room from the trunk).
Attractive in principle, but changes `computeColumns`; every dungeon's
layout would change (the same reason `CORRIDOR_LEN` is off the table), and
prior work (#300) found the real bugs in wall geometry, not placement.
Listed, not recommended.

**E. Accept the fallback, make it harmless.** Keep the direct line but
clip it and replace the through-room floor with a dead-end stub (no
connection for the second parent). A merge room's second parent then has a
door that leads nowhere: breaks the "every real parent reaches the merge
room" guarantee (#93). Rejected.

**Recommendation: C**, in the phases below, with a decision gate after
Phase 2. The redo (A) is last, optional, and subject to the kill criteria.

## Design

### Phase 0: measurement and ratchets (no behavior change)

Extend `tests/helpers/layout-sweep.mjs`:

- `buildSweepLayout(i, { restRoom, incomingFace })`: an optional
  `incomingFace(roomId, layout)` override, so variants (`sole`,
  `pathaware`, future) are measured by the same code that measures
  production. Defaults to today's `incomingFaceFor`.
- A `measureBuildability(layout)` that, for every edge, reports: null path,
  intermediate-room overlap (found vs null), target overlap split by depth
  (1 cell vs 2+), target-door gap vs door, chain mismatch, and per-cell
  accumulated walls (containment from the union of openings plus every
  crossing's flank walls) against every crossing's floor: cut-by-other-edge
  occurrences and different-edge floor intersections, split same-target vs
  different-target.
- A **flood-fill oracle** (the #297 final review's own lesson: the
  door-line proxy undercounted real failures roughly 5x). Rasterize the
  built floors and walls of a layout onto the unit grid and flood from each
  source door's outside cell, treating closed doors as passable only at
  their own door and every wall as solid. Assert connectivity (the corridor
  reaches its target door) and, for the leak check, that the reached floor
  contains no tile of a different-target edge's corridor.

Ratchets (all in the existing sweep style, ceilings only fall):
`NULL_PATH_CEILING = 2470`, `INTERMEDIATE_OVERLAP_CEILING = 1316`,
`INTERMEDIATE_OVERLAP_FOUND = 0` (exact), `SHARED_CELL_CUT_CEILING = 861`
(526 edges), `FLOOR_CROSSING_CEILING = 510`, `DEEP_TARGET_OVERLAP_CEILING =
170`, `TARGET_DOOR_COVERED = 0` (exact). Plus one live check (Q8): build a real run whose layout contains a known
cut (the `sweep-10` cell r0c2 shape; the sweep's `sweep-N` seeds can be
passed to a run as its seed) and confirm a token cannot walk edge A's
corridor. One PR, test-only apart from that check.

### Phase 1: lane plan for shared transit cells (layoutVersion 3)

New pure function in `scripts/dungeon-layout.mjs`:

```
transitLanePlan(seed, layoutPositionByRoomId, occupiedCells, edges, planFor, incomingFaceByRoomId)
  -> Map<edgeId, Map<"rank,col", { entryPoint, exitPoint }>>
```

It enumerates every edge's cell path (`findCorridorPath`, the same call
`buildEdgeCorridor` makes), groups crossings by cell, and for each border
assigns each crossing a distinct offset so that **floors of different
targets never intersect and never touch without a wall on the shared
boundary** (adjacent parallel lanes sharing one flank wall are fine; that
wall lies on a boundary, not inside a floor). Input and output are keyed by
edge id; edges are processed in a canonical order (target rank, target id,
source id), and nothing depends on `Object` insertion order or on which room
is built first (the scene builds rooms in topological order, not the
sweep's order). `buildEdgeCorridor` gains an optional `lanes` argument, the
same shape of change #415 used for `exitDoor`: when present the chain's
interior points come from the plan, the two end points stay pinned to the
real doors (#225 invariant: gap equals door exactly, a full `DOOR_WIDTH`).
Absent, behavior is byte-identical, which is how the version gate works.

Constraints the plan must honor, each already an invariant somewhere:
doors pinned (a plan that moves a door is a `#415` regression); a cell's
border is `COLUMN_STRIDE = 7` units wide (`ROOM_SIZE_LARGE + CORRIDOR_LEN`),
and the sweep shows up to 5 edges through one cell today (6 under the redo), so the lane allocator
must report infeasibility rather than overlap when a border cannot hold
them; straight vs L shape is decided by entry/exit sides (`transitCellCrossing`),
unchanged.

Unavoidable crossings (the 17 side-forced pairs, plus any the prototype
finds infeasible given pinned ends): never merge floors of different
targets (a corridor junction would let a party walk from one edge's
corridor into another edge's reveal door, a progression bypass around the
source's lock). The plan returns them as infeasible; the router then
treats the offending cell as blocked for the later edge (canonical order)
and re-runs `findCorridorPath`, exactly the rejected "reservation" idea but
applied only to the handful of forced conflicts, not to every shared cell.
Expected cost: tens of edges, to be measured (kill criterion K2).

Same-target edges (a merge room's several parents converging on its gate
lane) stay physically separate lanes, matching #415 decision 3. Whether
they may merge floors in the last cell is Q3.

Scene: `dungeon-scene.mjs` computes the plan once per run from
`state` (like `outgoingPlanFromState`), under `layoutVersion >= 3`;
`buildTransitCellIfNeeded` already accumulates openings per cell, so the
walls are the union of lane openings; flank walls come from the lanes, not
from per-crossing `flankSegment` guesses.

Exit criterion: `SHARED_CELL_CUT_CEILING` 861 -> 0 and
`FLOOR_CROSSING_CEILING` 510 -> 0 for different targets, null edges not above
2,470 + K2's allowance, every other ratchet unchanged.

### Phase 2: target-side west geometry

Prerequisite for any use of the west face. Fix, in `buildEdgeCorridor`'s
west-incoming corner/multi-cell branches: the 7 covered doors seen under
the redo (`sweep-25` `...-0-0` -> `room-merge-9`, `sweep-59`,
`sweep-177`; the last cell's gap does not match a west door) and the 2-9
cell target overlaps (170 baseline, 562 under the redo; likely
`cornerConnector`'s degenerate leg, #416 suspect b). Overlaps with #416:
land #416's west-incoming part here (or first), see Interactions.

Exit criterion: `TARGET_DOOR_COVERED` 0 under both `incomingFaceFor`
variants (the sweep helper's override makes this testable before the redo
ships); `DEEP_TARGET_OVERLAP_CEILING` 170 -> 0.

### Decision gate

After Phase 2, re-run the Phase 0 measurements with the `pathaware` override
on the new geometry. If the redo now improves every ratchet (nulls down,
overlaps down, cuts 0, doors 0) it proceeds to Phase 3; otherwise it is
dropped (K3). Independently, Phase 4 is where the 1,316 get fixed.

### Phase 3 (optional): `incomingFaceFor` west, path-aware

Selection rule in `scripts/dungeon-layout.mjs`, new exported
`incomingFaceForV3(roomId, ..., layout)` (version 3 only; `incomingFaceFor`
untouched so v1/v2 runs and tests stay byte-identical): for each room,
evaluate `findCorridorPath` for both faces for every real+hidden incoming
connection; choose the face with fewer null edges; tie goes to north (today's
behavior, so rooms that are fine are unchanged). Pure, per-room, no
cross-room dependency, deterministic. The chosen face is persisted in
`state.incomingFaceByRoomId` as today. Measured ceiling: nulls
2,470 -> 1,794; expect little overlap benefit (Phase 0's 1,302), so this phase
only ships if the gate says it is net positive.

### Phase 4: margin-lane pass-through for the corner branch

Design in outline (its own plan after Phase 1-2 measurements; the shape is
a generalization of `#297`'s dogleg, which is why it is not specified to
geometric detail here):

- Trigger: `findCorridorPath` is null and the corner branch's vertical
  leg would enter an occupied intermediate cell. Detect from the layout, not
  from the drawn geometry (`#297` Finding D: re-deriving the trigger
  separately from the geometry disagreed in 11 cases; share one helper, as
  `priorityIndexForEdge` now does).
- Geometry: the vertical leg in each occupied intermediate cell moves to
  the cell's east margin strip (offset fixed at `rect.gx + rect.gw`,
  the same value `#297` already derived), turns back west along the cell's
  south margin row only in the cell above the target gate, then goes down to
  the target slot. Slot priority (`assignDoorSlotsWithPriority`) already
  gives that edge the target slot nearest the east margin, so the
  horizontal jog does not cross the co-parent's own door. Intermediate
  cells with a room in them that are not the gate (dr 3+, `target-west dr3+`
  253 + 113 cases) pass through the same east strip.
- Containment: each occupied cell passed through gets one opening per
  strip crossing in its `cellMarginWalls` (`pendingForeignMarginOpenings`
  already scans edges for foreign openings; it must use the real corridor's
  lane, not the naive list-order slot, which is #297 Finding C).
- Known conflicts to design for, not around: the pass-through lane crosses
  the intermediate room's own east-exit corridor (an east door row crosses
  the east strip) and south-exit corridor in the south margin row; for a
  LARGE room the strip is exactly one cell wide, so these are junctions,
  forbidden between different targets (progression bypass). Likely
  resolution: choose, per cell, whichever strip (east or south margin) the
  room's own outgoing plan (`outgoingDoorPlan`) leaves clear for the needed
  stretch (a room has no north or west margin), and fall back to a null edge
  if neither is free. This is the principal unknown of the phase.

Exit criterion: `INTERMEDIATE_OVERLAP_CEILING` 1,316 -> 0 for edges that
are not provably boxed in (definition: a lane exists on some side of every
occupied intermediate cell per the room's own outgoing plan); the remainder
are counted, ratcheted, and listed.

## layoutVersion gate

Bump the run-state `layoutVersion` to **3** for new runs; consumers branch
(`>= 3`), identical to how #415 added 2. Reasons not to reuse 2: version 2
is live for new runs since 0.54.48 (the user's repro scene is v2) and
Phase 1/4 change corridor geometry for the same persisted seed and plan;
built rooms are never rebuilt (`isSlotBuilt`), so a v2 run extended under
new geometry via the "ensure-built retry" path would meet mismatched
doors and cells. The scene already threads `layoutVersion` through
`buildRoomAtGraphNode` and `outgoingPlanFromState`; the lane plan is read
the same way. Existing runs keep their geometry and their bug (same
decision as #415 decision 2). Phase 3's face choice lives behind 3 as well
(the persisted `incomingFaceByRoomId` makes a mixed run safe, but keeping
one switch avoids a combination nobody tested). Phase 0 is test-only and needs no version. Phase 2 changes west-incoming
geometry that exists in v2 runs today, so it is gated by 3 as well.

## Containment (no leaks)

This is the #324 / #353 / #355 / #359 class: every new corridor shape must
have its walls derived from the same lane that draws it.

1. A cell's outer boundary is solid except exactly the union of its
   crossings' entry and exit openings (`transitCellContainmentWalls`,
   unchanged).
2. Inside a shared cell, a wall may lie on a lane boundary only (a flank
   shared by two parallel lanes is one wall); no wall in any floor's
   interior. This is what Phase 1 fixes; the Phase 0 flood-fill makes it
   checkable, the 861 occurrences are the regression test.
3. No two different-target corridors are ever connected by floor (no
   junctions). Same-target merging is Q3.
4. Phase 4: an occupied cell's passage is bounded by the room's own
   enclosure on one side and a new margin wall on the other; the existing
   `cellMarginWalls` rule applies (a room's own east/south enclosure faces
   seal its interior from the strip).
5. Sight: vision-blocking walls are the same set as movement-blocking
   ones here (no windows); the flood-fill oracle runs on one set.

## Property test (acceptance criterion)

Ratchets live in the endpoint sweep file (`tests/dungeon-layout-endpoints.test.mjs`)
beside the #415 ceilings, all measured on the 500-seed sweep and only
allowed to fall. The headline:

- `INTERMEDIATE_OVERLAP_FOUND = 0` (exact, today), and for all edges
  `INTERMEDIATE_OVERLAP_CEILING` = 1,316 now; Phase 4 target 0 for non-boxed-in
  edges, with the remainder an explicit ratchet.
- `SHARED_CELL_CUT_CEILING` = 861 now; Phase 1 target 0.
- Every Phase's change must hold the other ratchets: null edges <= 2,470 +
  K2 allowance; target-door covered 0; deep target overlap <= 170;
  chain mismatch 0; source overlap 0; lane conflicts <= 329 (#415).
- Flood-fill oracle: 0 disconnected found corridors, 0 cross-target
  connected floors, 0 leaks.
- Determinism: building the layout with edges and rooms in reversed order
  yields the identical lane plan (as `outgoingDoorPlan`'s order-independence
  test does), and two builds from one seed compare equal.

Unit tests per phase (pure functions first, scene wiring last), plus the
one pinned real graph for the live repro (`sweep-0` positions, verified to
reproduce, not hand-built; #297 Finding E).

## Phasing

| PR | Content | Risk |
| --- | --- | --- |
| 0 | Sweep helper `incomingFace` override, `measureBuildability`, flood-fill oracle, ratchets at baseline, one live check | none (test only) |
| 1a | Lane-plan prototype: feasibility count of the 510 intersections with pinned ends (no behavior) | decides K2 |
| 1b | `transitLanePlan`, `buildEdgeCorridor` `lanes` argument, scene wiring, layoutVersion 3 | medium: new geometry source of truth |
| 2 | West-incoming target geometry (7 covered doors, 2-9 cell overlaps), with or ahead of #416 | medium |
| gate | Re-measure the `pathaware` variant on new geometry | none |
| 3 | `incomingFaceForV3` path-aware west (only if the gate passes) | low once 1-2 land |
| 4 | Margin-lane pass-through for the corner branch (own plan first) | high (#297 history) |

Each PR bumps `module.json` (patch; 1b and 4 are minor candidates) and runs
`update-architecture-docs` when imports change (the lane plan adds no new
module). Phases 1 and 4 can swap order; 1 first is recommended because both
need the plan layer (a pass-through lane is one more crossing in a cell).

## Interactions with #415 Chunk 5 and #416

**#415 Chunk 5** (lane conflicts, option C: stop generating hidden shortcuts
that put two lower-column targets on one source's south margin row) is the
same family: two corridors needing one piece of space. It is independent
in code: it changes `attachHiddenPaths` selection, not transit cells. It
does change the edge population (fewer hidden edges), so the absolute
baselines above will shift down when it lands; ceilings only fall, so no
ratchet breaks, but Phase 0's baselines should be re-measured after it.
Recommended order: Chunk 5 first or in parallel with Phase 0, since Phase 0
is test-only. No version bump needed for Chunk 5 (hidden edges are persisted
in state); Phase 1b's v3 is independent. Both touch `buildEdgeCorridor`'s
signature area: do not run Chunk 5's geometry-touching parts and Phase 1b
concurrently.

**#416** (target-room overlaps, 2,272) is not a prerequisite for #427's
found-path/intermediate goals, but its west-incoming part (170 deep overlaps,
562 under the redo) is exactly Phase 2. Either merge #416's west part into
Phase 2, or land #416 first and let Phase 2 consume it. The door-tile 1-cell
overlap (2,102) should be decided by Q5 before anyone chases it. Recommended:
**fold the west-incoming part of #416 into Phase 2, leave the one-cell
class to #416 afterwards.**

## Risks and unknowns

- The 510 intersections may not all be resolvable by interior offsets once
  the ends are pinned; the global lane ordering across a multi-cell chain
  can be unsatisfiable (A above B in one cell, below in the next). Not
  measured; Phase 1a decides.
- Border capacity: up to 6 edges through one 7-unit border; a plan that
  needs adjacent lanes with no gap relies on flank walls sharing a
  boundary. Needs a concrete hand-trace before the plan.
- Hidden edges: sealed until revealed; they cross cells like any edge
  (504 null hidden edges, 223 overlapping) and their doors are keyed
  differently (`dungeonHiddenDoorForEdge`). The lane plan must include
  them; the unseal flow is untested against relocated lanes.
- Phase 4 inherits #297's unfixed residuals (#309: same-size
  blocker/target, 54 cases) and its warning that door-line proxies
  undercount; the flood-fill oracle exists for that reason.
- The numbers are computed from layout functions, not observed. The cut
  floors may be masked in play by something this analysis does not model
  (e.g. door states, wall flags); the Phase 0 live check addresses this
  and could change Phase 1's priority.
- The #416 one-cell overlap may be a cosmetic door tile, in which case the
  `TARGET_OVERLAP` ratchet is mostly noise and the right metric is
  depth >= 2.
- "Provably boxed in" is not yet defined for Phase 4; today any edge
  whose BFS fails counts, and the margin-lane rule changes which edges are
  truly stuck.

## Kill criteria

Each is measured on the 500-seed sweep and decided by the ratchets, not
by judgment.

- **K1 (any phase):** if any ratchet rises (null, intermediate overlap,
  cuts, crossings, covered doors, deep target overlap, source overlap, lane
  conflicts, oracle leak) the phase is not mergeable as it stands; fix or
  revert. A "found path is not a buildable path" regression is a stop.
- **K2 (Phase 1):** if the lane plan needs to block more than ~2% of
  currently-found multi-cell edges (about 40 of 2,077) to resolve forced
  crossings, stop and take Q2/Q3 back to the user: either allow same-target
  merging or accept the cuts as documented residuals.
- **K3 (Phase 3):** if after Phases 1-2 the `pathaware` variant does not
  reduce intermediate overlaps by at least 15% (about 200 edges) **and**
  hold every other ratchet, drop it. The pre-fix evidence is 1%, so
  expect to drop it unless Phase 2 changes the picture.
- **K4 (Phase 4):** if the pass-through rule leaves more than ~10% of the
  1,316 undisposed (neither fixed nor classified as no free lane), or if
  the oracle finds any sealed co-parent door (the #297 Round 1 failure,
  375/380), stop and return to the user with Option D (re-layout) or Option E
  as the remaining choices.
- **K5:** if live verification of a v3 scene shows a severed or leaking
  corridor the oracle did not predict, the oracle is wrong: fix the oracle
  before shipping anything else.

## Open questions for the user

1. **Reorder the plan?** The measurements say the chosen order (multi-cell
   fix, then west redo) removes the cut floors (a real, independent bug) but
   the west redo itself rescues at most 27% of null edges and about 1% of the
   through-room overlaps (the trunk column blocks the west lane; Phase 4's
   margin-lane pass-through is what reaches the 1,316). Recommendation: Phases
   0, 1, 2 as written, a decision gate, the redo only if it passes, and Phase
   4 as the real fix. Proceed on that, or keep the redo as the primary goal
   regardless?
2. **Junctions between different-target corridors.** Is it ever acceptable
   for two edges to the same room to share floor? Recommendation: never (a
   party could walk from one corridor into another edge's closed, unlocked
   reveal door, bypassing the source's lock). That makes the 17 side-forced
   crossings (and any pinned-end ones) reroutes or nulls.
3. **Same-target merging.** May a merge room's several parents share the
   last cell's lane (a Y-junction into one door slot)? #415 decision 3 says
   separate; a Y-junction would reduce lane pressure. Default: separate.
4. **layoutVersion.** 3 for new runs (recommended) or reuse 2? Reuse is only
   safe if no v2 run is ever extended after the change; the repro scene is
   v2.
5. **Target-overlap ratchet semantics.** Is the one-cell door-tile inside
   the target's top row (2,102 edges) intended? If yes, the `#416` ratchet
   should count depth >= 2 only.
6. **When a merge room's second parent truly cannot reach (Phase 4's
   remainder).** Options: keep the honest direct-line fallback and accept it,
   re-layout for those seeds (D), or hide the edge (a secret door: the
   second parent's door becomes a hidden shortcut). Product decision, not an
   engineering one.
7. **Thresholds.** Are K2 (~2%), K3 (15%), K4 (~10%) the right lines, or do
   you want stricter ones?
8. **Phase 0 live check.** Authorize one Foundry world check of a cut floor
   (A's vertical lane in cell r0c2 of a real run) to confirm the cut floors
   are real in play, since the whole Phase 1 priority rests on computed
   geometry.
