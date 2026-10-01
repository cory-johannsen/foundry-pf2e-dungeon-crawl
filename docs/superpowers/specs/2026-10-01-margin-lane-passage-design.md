# Margin-lane passage (Phase 4) — design note for #427

Status: design, 2026-10-01. Sibling of `2026-10-01-boxed-in-corridor-routing-design.md` (the spec; its
"Decisions" stay authoritative) and `2026-10-01-topology-aware-corridor-routing-design.md` (the router).
Written after the user's Q-A/Q-B/Q-C answers (below) moved Phase 4 ahead of the router. Nothing here is
implemented in `scripts/`; the only code is a test-only prototype (`tests/helpers/passage-prototype.mjs`,
`tests/dungeon-layout-passage-prototype.test.mjs`, plus a `slotOrder` option on `tests/helpers/buildability.mjs`
and `tests/helpers/topology-router.mjs`) that produced the measurements in section 4.

Decisions already taken (not re-asked): Q-A yes (about 185 more edges may join the boxed-in class in v3, tracked
by a combined null + unresolvable ratchet); Q-B skip the joint rip-up experiment; Q-C the router ships after
Phase 4. Different-target corridors never share floor; same-target corridors stay separate lanes; new runs get
layoutVersion 3 (v1/v2 byte-identical, digest tests hold); stubs follow the eligibility rule (sole-child stubs wait
on #439); the west-incoming `incomingFaceFor` redo is dropped or optional later.

## 1. What this phase is, in one paragraph

The edges that overlap an intermediate room today (1,132 on the v2 sweep) are all null-path edges whose
fallback line was drawn straight through whatever occupies the cells in between. 1,048 of them (93%) cut through
a co-parent of their own target: the **corner branch**, a second parent EAST of a merge room that sits directly
below its co-parent. Phase 4 draws such an edge as a one-tile-wide **lane through free tiles beside the occupied
cells** (the east and south margin strips every occupied cell has) instead of through them, with walls derived
from that same lane. The measurements say this is **not** the fix the spec hoped for. With the target's door-slot order changed
and lanes routed one at a time on top of the corridors that already exist, the prototype serves 193 of the 1,101
overlap edges (17.5%; 4.9% with today's slot order) and leaves 908 boxed in, because the corridors that already
exist partition the plane and a lane may not cross one (section 4). 98% of the remainder are sole-child sources,
so stubs cannot take it until #439 lands, and when stubs do remove fallback lines they free space for lanes
(upper bound 43%). The note therefore ratchets what Phase 4 achieves rather than promising zero, says plainly
that the achievable ceiling is about a fifth, and asks the user whether the lane half is worth its risk
(Q-D, section 11).

## 2. Which edges it applies to

All numbers: 500-seed sweep (`tests/helpers/layout-sweep.mjs`, rest room spliced, real + hidden edges,
layoutVersion 2 plan selector, door slots with priority), 9,498 edges. Baselines re-measured on current main
(0.54.71): nullPath 2,052; interOverlap 1,132 (0 on found paths); cutEdges 501 / cutOccurrences 814;
floorCrossings 484; deep target overlap 160; multi-cell 2,063.

| Class | Edges | Phase 4 treatment |
| --- | --- | --- |
| Found path (BFS non-null) | 7,446 | untouched (router chunk later) |
| Null path, fallback line misses every other room | 920 | untouched (includes #297 doglegs, 0 overlaps) |
| Null path, fallback line overlaps an intermediate room | 1,132 | **passage targets** |
| ...of which the overlapped room is a co-parent of the target (corner branch) | 1,048 | |
| ...of which another room (no relation to the target) | 84 | |
| Router-unresolvable (found path, no non-crossing lane assignment) | 185 (9% of multi-cell) | become passage targets once the router ships (Q-A) |

Shape of the 1,132 (exit face / incoming face / target column vs source column / rank gap):

| Shape | Edges |
| --- | --- |
| south, in north, target WEST, dr 2 | 634 |
| south, in north, target WEST, dr 3+ | 271 |
| south, in north, target WEST, dr 1 | 124 |
| south, in west, target WEST (dr 1: 35, dr 2: 33) | 68 |
| south, in north, same column, dr 3+ | 19 |
| east, in north, target EAST, dr 2 / dr 3+ | 15 / 1 |

"Target WEST" means the source sits east of the merge room: its planned exit is south (the outgoing plan uses
east only for a higher-column target), so the corner branch runs a horizontal leg along the source's south
margin row, then a vertical leg at the target slot's x down through the cells above the target, which is where
the co-parent sits. The 643 single-room overlaps are that vertical leg only; the 489 with two or more overlapped
rooms also cross same-rank neighbours (a SMALL source's south margin row is inside a LARGE neighbour's footprint).

Not in scope: the 920 null edges that already miss every room (the #297 dogleg and plain lines), the one-cell
target door tile (Decision 5), found paths.

## 3. Why the earlier attempts failed, and what this reuses

- **`trunkLaneCorridorSegments`** (bdcd209, deleted 338d99c). A hand-drawn 3-segment detour along a cell's far
  edge. It was never reconciled with the containment walls of the cells it crossed: 100% broken for west exits
  (its far-edge coordinate was independent of the source door), about half the rest bisected by a real wall.
  Lesson kept: **a lane is only buildable if its floor and walls come from one definition**. Here the lane is
  a tile list; floor, flank walls, cell-border openings and door mouths are all derived from it by one function
  (`passageLaneGeometry`), and the flood-fill oracle checks the built result, not the router's claim.
- **#297 Round 1** (dogleg through the blocker's margin band) worked geometrically (0 overlaps over 603
  same-column dr 2 edges) but sealed 375/380 co-parent doors, because the lane's cap wall landed on the co-parent's
  own door and the co-parent's own corridor already used the same margin band. Round 2 repaired it with **slot
  priority** (the colliding edge gets the target slot nearest the blocker's east margin, the co-parent the slot
  just west), leaving residuals tracked in #309 (same-size blocker/target, door-line proxy undercounting).
  Lesson kept: **the target's door-slot order and the lane must be decided together** (the same
  independently-seeded-values trap as #230/#231/#353/#355). This phase makes the order a rule (section 5.1).
- **Why a lane can fail where the dogleg did not**: #297 handled exactly one blocker cell with the lane in that
  blocker's margin band. A corner-branch lane runs past several cells and must share rails with other edges'
  corridors; section 4 measures how often it cannot.

## 4. Measurements (test-only prototype, 500 seeds)

### Model

`tests/helpers/passage-prototype.mjs`: for every passage target, find a one-tile-wide, turn-penalised Dijkstra
lane on the unit grid from the tile just outside the source door to the tile just outside the target door,
through **free tiles**: not inside any room rect, not on any other edge's floor (found edges and the null
fallbacks that miss every room keep their drawn v2 floor as obstacles), not on any other edge's door-mouth tile,
and not on a lane already placed. Targets are routed in canonical order (target rank, target id, source id), each
placed lane becoming an obstacle, so a served count is a simultaneous assignment, not a per-edge bound. The search
is bounded to the source/target cell box plus one cell. **An unserved target keeps its fallback line** (the
line through the room is still drawn, it is today's behaviour), so no served lane may cross it: a fixed-point loop
adds every unserved line that a lane crosses to the obstacle set and re-routes until none does (a first, naive
version without this loop reported 224 served instead of 193; 53 edges' lines conflicted on the first pass).
Free tiles include the east and south margin rails of occupied cells (exactly one tile wide next to a LARGE
room, up to 7 next to a SMALL one) and every empty cell, so this is an **upper bound on what a margin-lane rule
can serve**, not an under-estimate: the real rule is stricter (section 5).

Honest limits: obstacles are layoutVersion 2 floors (the router later re-routes about 36 and removes about 185);
lanes touch other floors only across a shared wall (the same flank-wall construction the router assumes); walls
are not generated here, so nothing in this section proves a wall set; the model has no live check.

### Slot order matters more than lanes

The first run kept today's door-slot assignment. sweep-0 (the spec's repro) shows why it fails: the second
parent's mouth lands WEST of the co-parent's corridor on the target's north face, inside a pocket enclosed by the
co-parent's widened corridor, the co-parent's room and the target. No lane exists regardless of geometry. Ordering
the target's incoming slots by approach side (a north face west to east by source column; same column: nearer rank
first so a farther same-column source passes on the east side; hidden last) removes the pocket. Prototype option
`slotOrder: 'approach'` in `visitEdges`, replacing #297's priority swap.

All rows are measured with `measureBuildability(layout, { slotOrder })` on the 500-seed v2 sweep; the "plan"
row reproduces the baselines exactly.

| Target slot order | interOverlap | nullPath | cutEdges / cutOccurrences | floorCrossings | deep target overlap |
| --- | --- | --- | --- | --- | --- |
| plan (today: list order plus #297 priority swap) | 1,132 | 2,052 | 501 / 814 | 484 | 160 |
| approach, nearer rank first, no priority swap | **1,101** | 2,052 | 500 / **819** | 484 | 160 |
| approach, farther rank first, no priority swap | 1,115 | 2,052 | 501 / 814 | 484 | 160 |
| approach, farther rank first, priority swap kept | 1,106 | 2,052 | 501 / 814 | 484 | 160 |

The order alone removes 17 to 31 overlaps and changes nothing else except cutOccurrences +5 on the best variant
(a K1 rise that Task 2.1 must resolve by picking a variant that holds every ratchet). It does not change which
edges lack a grid path (`findCorridorPath` is not touched).

### Lane results

500 seeds, layoutVersion 2 floors as obstacles, targets routed in canonical order, unserved lines respected
(section 4, "Model"). "Overlap class" is the null edges whose fallback line overlaps an intermediate room (1,132
under plan order, 1,101 under approach order).

| Variant | Targets | Served | Overlap class served | Residual |
| --- | --- | --- | --- | --- |
| plan slot order, overlap class only | 1,132 | 55 (4.9%) | 55 of 1,132 | 1,077 |
| approach order, overlap class only | 1,101 | **193 (17.5%)** | **193 of 1,101 (17.5%)** | **908** |
| approach order, **every null edge** a target, overlap class first | 2,052 | 594 (28.9%) | 219 of 1,101 (19.9%) | 1,458 (882 overlap) |
| approach order, overlap class plus the router's 177 unresolvable edges | 1,278 | 269 | 194 of 1,101; **75 of 177 unresolvable (42%)** | 1,009 (907 overlap) |
| hypothetical: no fallback line drawn at all (every unserved edge a stub), approach order | 1,101 | 468 (42.5%) | 468 | 633 |

Reading:
1. **The slot order is worth more than the lane rule**: 4.9% to 17.5% by ordering the target's incoming doors alone.
2. **Routing the 920 harmless fallback lines as lanes too does not help** (219 vs 193): their unserved majority
   keep their lines, which then block (535 first-pass conflicts), so the recommended scope is the overlap class only.
3. **The last row is the interesting one**: a fallback line is a barrier, so anything that removes lines (a dead-end
   stub for an eligible edge, or #439 making sole-child stubs eligible) also frees lanes. With no fallback line at all
   the prototype serves 468 of 1,101 (42.5%). It is an upper bound, not a plan: sole-child edges cannot be stubbed
   today.
4. The router's unresolvable edges are easier than the overlap class (42% vs 17.5%) because they have a free
   door pair, but they are a different population measured on v2 geometry (see unknowns).
5. **Lanes are not tours**: served length 14,431 tiles against 14,221 for the sum of Manhattan distances (1.015),
   1.5 turns per lane, 2.5 occupied cells' margins touched per lane, longest lane 154 tiles (118 of 193 are over 60
   tiles because the sources are 5 to 8 cells away).
6. The numbers are v2 geometry; routing the 36 re-routed and 177 unresolvable edges (the router) changes the
   obstacle set. Router prototype with approach order: 1,842 placed on shortest, 44 re-routed, **177
   unresolvable** (185 under plan order), 0 crossings among placed.

### What blocks the rest

Cause waterfall for the 908 residual edges of the best variant (the first relaxation that makes an edge routable,
cumulative: drop placed lanes and kept lines, then door mouths, then every floor):

| Residual cause | Edges |
| --- | --- |
| Other corridors' floors (found edges, fallback lines) | 874 (96%) |
| Other doors' mouth tiles | 34 (4%) |
| Lane contention on a one-tile rail | 0 |
| Rooms alone or the search box | 0 |

- **It is planarity, not geometry.** Rooms plus corridors partition the plane; a lane cannot cross a corridor
  (Decision 2), so a second parent whose mouth sits on the other side of a trunk (a column of rooms joined by consecutive
  corridors, the topology note's single-column trunk) has no lane at any width. With every floor removed
  (rooms only) all edges route, so the barrier is the corridors, not the rooms and not the search bound.
- **Residual by shape**: south/north/target-west dr 2: 489 residual vs 120 served (20%); dr 3+: 209 vs 57
  (21%); dr 1: 112 vs 12 (10%); west-incoming: 68 vs 0; same column dr 3+: 15 vs 3; east exits dr 2: 15 vs 0.
- **The residual is sole-child**: 888 of the 908 (98%) are the only real child of their source, so the stub rule
  excludes them until #439.
- Rails one tile wide did not bind in the best variant (no edge failed on lane contention); capacity matters only
  in the optimistic rows.
- More search is not the lever: raising the search box by two cells on a 30-seed spot check (earlier, pre-fixed-point
  model) served 47 instead of 39 but with tour-length lanes (up to 192 tiles); not pursued.

## 5. Design

### 5.1 `incomingDoorOrder` (layoutVersion 3)

A new pure function in `scripts/dungeon-layout.mjs`, `incomingDoorOrder(connections, positionByRoomId, face)`,
returns the connections sorted for slot assignment: key (major axis of the source's position along the face,
minor axis with the nearer first, hidden last, source id as the final tie-break). Version 3 replaces both the
list order and `findPriorityCollision`/`assignDoorSlotsWithPriority` with it; v1/v2 keep both untouched. It is
the incoming twin of `outgoingDoorPlan`'s `compareTargets`: a total order with no dependence on iteration order,
so the shuffle test applies. #297's same-column dr 2 doglegs are served by it (the farther source takes the east
slot, which is where the priority swap put it); the dogleg geometry itself is unchanged in v3.

The tie-break is tunable: the two variants measured are in the table above. The implementation PR must choose the
one that holds every v2 ratchet (K1); if neither does, order alone is not mergeable.

### 5.2 The lane

`planPassageLanes(layoutContext) -> Map<edgeId, { tiles, floors, walls, openingsByCell, doorMouths }>`,
pure and whole-layout, computed once per scene build pass from the same inputs `outgoingPlanFromState` uses
(memoised on the seed and layout digest; **derived, never stored**, so a router change later re-derives lanes with
no migration). Inputs: every edge's built geometry (a `buildEdgeCorridor` call per edge with its door ends, exactly
as `visitEdges` does; passage targets contribute only their door mouths), room rects, the outgoing plan.

- **Which edges**: null path (or router-unresolvable) AND the fallback overlaps a room other than the edge's own
  two. Trigger is computed from the layout, not from drawn geometry (#297 finding D: a separately re-derived
  trigger disagreed in 11 cases); one helper `needsPassage(edge)` is shared by planner, scene and tests.
- **Endpoints**: the tile outside the source door (from the planned `exitPoint`/`doorWall`) and the tile outside
  the target door (the slot from 5.1). One helper `mouthTile(doorWall, face)` is used by the planner, the wall
  builder and the oracle. Doors are never moved by a lane (#415 invariant: gap equals door, a full `DOOR_WIDTH`).
- **Search**: Dijkstra on unit tiles, 4-neighbour, cost 1 per step plus 3 per turn, neighbour order fixed, ties
  by insertion order, so the lane is a pure function of the obstacle set. Bound: source/target cell box plus one
  cell, and a cost cap. Deterministic and seed-stable: no seeded randomness; canonical target order; nothing reads
  `Object` key order.
- **Offsets and joins**: the lane has no free offset parameter. It runs wherever the search puts it: next to a
  LARGE room it is the one-tile margin rail (x = rect.gx + rect.gw for a vertical run, y = rect.gy + rect.gh
  for a horizontal one); next to a SMALL room it may sit anywhere in the wider margin. The join to the target door is
  the final tile; the elbow into the door is an ordinary 90-degree turn. Corner shapes are 1x1 elbows; there are no
  diagonals and no widened blobs.
- **Capacity**: a LARGE room's margin rail holds one lane. Two lanes needing the same rail serialize in canonical
  order and the later one detours or is residual. This is a real limit (section 4, "order" cause), not a bug.

### 5.3 Containment walls, door/wall agreement, and the trap

`passageLaneGeometry(lane)` returns, from the tile list alone: the floor rects (maximal straight runs), the flank
walls (every boundary of the floor not shared with the lane's own next/previous tile or one of its two door
openings), and `openingsByCell`: for every cell border the lane crosses, one opening `{ side, offset, width }`.
Consumers:

- an **occupied** cell crossed by the lane gets the openings in its `cellMarginWalls` call (the list-per-side
  generalisation #297 already made); `pendingForeignMarginOpenings` in v3 reads `openingsByCell` from the planner
  instead of re-calling `buildEdgeCorridor` per edge (so it can never disagree with the real lane: #297 finding C);
- an **empty** cell crossed by the lane gets the openings added to its transit-cell openings
  (`buildTransitCellIfNeeded` already accumulates openings per cell), and the flank walls come from the lane, not
  from a per-crossing guess;
- a wall may lie on a boundary between two floors (parallel lanes sharing one flank) but never inside a floor;
- no two different-target floors are connected: a lane tile is never edge-adjacent to a door-mouth tile of another
  edge in a way that would open into it (mouth tiles are reserved), and the flood-fill oracle asserts it.

**The trap, restated for this phase**: "a found path is not a buildable path". The lane search finding a tile path
proves nothing about walls. The acceptance test therefore builds floors and walls for every served lane exactly as
the scene would (`passageLaneGeometry` plus the existing margin/transit wall builders on the union of all
openings), runs `buildFloorModel`, and asserts: the lane's floor is connected door to door; no room tile, no other
edge's floor tile and no other edge's door mouth is reachable from it; no door is sealed (every edge's mouth tile
is reachable from its own door); no wall lies inside any floor. The oracle is the specification, the planner the
implementation.

### 5.4 Interactions

- **`outgoingDoorPlan`**: untouched. Source face and door come from it; the lane's start tile is derived from the
  plan entry. A lane does not create or move an outgoing door. Planned doors on a face are obstacles (mouth tiles),
  which is what keeps a lane off a room's own exits.
- **`pruneConflictingShortcuts`**: untouched, runs first as today; the sweep already includes its effect.
- **`findCorridorPath`**: untouched. It stays the pure BFS (`exitFace` first-hop rule, `incomingNeighbor` rule,
  occupied cells block). The lane is a separate pure function over a different occupancy (unit tiles); the two
  never share state, so the helpers that call `findCorridorPath` on plain occupancy (`findPriorityCollision` in v2,
  `outgoingMarginOffset`) keep their meaning. In v3 `findPriorityCollision` is not called (5.1 replaces it).
- **`buildEdgeCorridor`**: gains one optional trailing parameter `passage` (`{ floors, walls }` from the planner);
  when present, those replace the fallback segments and walls for that edge, the doors stay as computed. Absent,
  byte-identical (the digest tests are the proof). The edge's multi-cell and fast-path branches are not touched.
- **layoutVersion 3**: everything above is `>= 3`. v1/v2 runs never call the planner or `incomingDoorOrder`.
- **Fallback line**: a passage target with no lane keeps today's fallback line (a counted, listed residual). It
  is not a regression: it is what v2 draws now. If the edge is stub-eligible (non-sole-child, or a hidden shortcut)
  the stub chunk may later replace it; sole-child edges stay on the line until #439.
- **The later router**: the router treats a lane as the last, lowest-priority chord. It places found chains first
  (canonical order, as designed), then the passage planner runs on the router's output floors, so a lane never
  constrains a found edge and unresolvable edges join the passage targets automatically (Q-A). Because lanes are
  derived, shipping the router changes nothing stored; the router PR must re-measure the lane served count on its
  geometry (the unresolvable edges are the harder ones: section 4, last row).

## 6. Acceptance criteria and ratchets

Measured on the 500-seed sweep through one helper, only allowed to fall (rise): all v2 ratchets hold unchanged
on the v3 geometry before any lane is drawn, except where this note states an explicit new baseline.

- `NULL_PATH` combined boxed-in count (null union unresolvable): v3 starts at 2,052 and never rises in Phase 4.
- `INTERMEDIATE_OVERLAP`: v3 ceiling starts at 1,101 (order alone) and falls to 908 with lanes (the prototype's
  upper bound; the real ceiling is whatever Tasks 2.2 and 2.4 measure, K10 floor 145 served, so at most 956), then only
  falls; found paths exactly 0.
- `PASSAGE_SERVED_FLOOR`: served count may only rise; `PASSAGE_RESIDUAL_CEILING`: residual may only fall; the
  residual edge ids are written to `tests/fixtures/boxed-in-residual.json` so the stub chunk consumes the exact set.
- Oracle: 0 sealed doors, 0 cross-target connected floors, 0 leaks, 0 floor tiles inside rooms, every served lane
  connected door to door.
- cutEdges, cutOccurrences, floorCrossings, deep target overlap, source overlap, chain mismatch, door covered:
  not above their v2 value (cut occurrences reach 0 only in the router chunk).
- Lane length: total served tiles at most 1.15 times the sum of Manhattan distances (measured 1.015).
- Determinism: building with edges and rooms in reversed order gives the identical plan; two builds from one seed
  compare equal; `incomingDoorOrder` shuffled input gives identical output.
- One pinned real graph: the `sweep-0` repro (`room-room-entry-1` -> `room-merge-3`), verified to reproduce, not
  hand-built (#297 finding E).
- A new run is required to see a lane; live verification is the user's.

## 7. Kill criteria (same style as the spec)

- **K9 (incomingDoorOrder):** if no tie-break variant holds every v2 ratchet, or the order alone raises the
  overlap count, stop; do not ship the order. (Measured: overlap falls 1,132 -> 1,101 with cutOccurrences +5 on
  one variant, and falls 1,132 -> 1,115 with cutOccurrences unchanged on the other: pick by the ratchet.)
- **K10 (lanes net negative):** if building the real lanes (not the prototype) serves fewer than 75% of the
  prototype's 193 (that is, fewer than 145 of the 1,101 overlap edges, on the same 500 seeds; the prototype is an
  upper bound and 75% leaves room for the stricter real rule), or any ratchet rises, or the oracle finds any sealed door, severed floor, leak or cross-target
  connection, the lane PR is not mergeable. If it nets negative after everything is fixed it is **reverted**; the
  edges stay on the fallback line (v2 behaviour); `incomingDoorOrder` may still ship if K9 holds; Phase 4 is
  recorded as "the achievable ceiling is the order alone" and the remainder goes to the stub chunk and #439.
- **K11 (oracle disagrees with live):** if a v3 scene shows a severed or leaking lane the oracle did not predict,
  the oracle is wrong: fix it first (same as spec K5).
- **K12 (tours):** if more than 5% of served lanes exceed 2 times their Manhattan distance, or any lane crosses a
  cell border more than 12 times, add a length cap and re-measure before merge. (Measured: no lane above 170
  tiles; the long ones are sources 5-8 cells away, not detours.)
- **K13 (wiring):** if the scene's derived-per-build lane plan disagrees with the pure planner on any seed (the
  scene builds rooms in topological order, the planner is whole-layout), stop: that is the "independently-derived
  trigger" bug class.
- K1, K3-K8 unchanged.

## 8. Honest unknowns

- **Real vs prototype.** The prototype ignores walls; the real rule must also leave openings in margin walls and
  keep every door mouth reachable. K10 allows a 25% haircut; the actual loss is unmeasured until the geometry
  exists.
- **Router interaction.** Lanes were measured on v2 floors. After the router, 36 found edges move and about 185
  become targets; whether the served share holds is unknown (the unresolvable edges were measured: 75 of 177 served, 42%, on v2 floors).
- **Margin wall churn.** `cellMarginWalls` and `pendingForeignMarginOpenings` are #297's most fragile code (#309
  residuals: same-size blocker/target, 54 cases). v3 routes them through the planner; whether #309's residuals
  disappear or reappear in a new form is unknown.
- **Large tokens.** A one-tile lane cannot pass a Large token; the same is already true of every corridor
  today (`DOOR_WIDTH` 1). Not new, not fixed.
- **Hidden edges.** Their doors are keyed differently (`dungeonHiddenDoorForEdge`); lanes for hidden shortcuts and
  the unseal flow are untested against a relocated corridor.
- **Mixed-geometry v3 runs.** If v3 is stamped by the first Phase 4 PR and later chunks change v3 geometry, a v3
  run created before a later release and rebuilt through the ensure-built retry path would meet mismatched doors.
  Eager pregeneration makes this rare (question Q-E).

## 9. Layout of the work

See the plan (`docs/superpowers/plans/2026-10-01-boxed-in-corridor-routing.md`), Chunk 2: PR 2.1 `incomingDoorOrder`
(+ v3 stamp), PR 2.2 pure lane planner, oracle and ratchets, **Task 2.3 a user decision gate (wire or stop)**,
PR 2.4 `buildEdgeCorridor` `passage` argument and scene wiring, PR 2.5 ratchet down and residual fixture. Each bumps `module.json`, runs `update-architecture-docs` when imports
change, and re-measures on v3 geometry.

## 10. Prototype status

`tests/helpers/passage-prototype.mjs` (lane search, obstacle model, cause waterfall; option `relax` and
`slotOrder`), the `slotOrder` option on `visitEdges`/`measureBuildability` in `tests/helpers/buildability.mjs`,
and `unresolvableIds` on `routeLayoutTopologyAware`. Default behaviour of every existing helper is unchanged
(the buildability ratchet test is the proof). Test-only; discarded or promoted into `scripts/` by Chunk 2.

## 11. Product questions raised

- **Q-D (is the lane half worth its risk?).** The measured ceiling of Phase 4 is 193 of 1,101 overlap edges
  (17.5%) plus 75 of the router's 177 unresolvable edges; 908 overlap edges (98% sole-child) stay on the fallback
  line through the room until #439 lets them become stubs, after which lanes could reach up to 42.5%. Phase 4's
  lane half is also the highest-risk code in this effort (#297 history). Options: (A) proceed with Chunk 2 as
  planned (order, planner, wiring) and ratchet; (B) ship only Tasks 2.1 and 2.2 (order, pure planner, oracle),
  stop at the Task 2.3 gate with real numbers and decide wiring then, ideally after #439 so lanes and stubs are
  measured together; (C) skip lanes, go straight to the router and stubs. Recommendation: **B**. The cost of
  waiting is nil (nothing is worse in the meantime) and the gate has real numbers instead of prototype ones.
- **Q-E (v3 stamp timing).** Stamp layoutVersion 3 in the first Chunk 2 PR and let later chunks change v3
  geometry (a v3 run created by an early release and rebuilt through the ensure-built retry path after a later
  release would meet mismatched doors; eager pregeneration makes this rare), or bump per geometry release (v3 for
  Chunk 2, v4 for the router)? Recommendation: one evolving v3; the retry path is rare and the plan lists the risk.
- No other product question: the lane shape (hugs room exteriors, about 1.5 turns, never wider than one tile) and
  the incoming door order (planarity-consistent, deterministic) are internal; the user judges the look on a new v3 run.
