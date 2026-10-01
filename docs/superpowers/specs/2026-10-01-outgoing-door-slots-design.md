# Outgoing door slots and target-direction exit faces — design

**Tracks:** [#415](https://github.com/cory-johannsen/foundry-pf2e-dungeon-crawl/issues/415)

## Problem

A hallway is drawn straight across the interior of a room (user
screenshot, scene `l4vvlVbh5gbQQ6tN`, seed `1790885292144-m7xq6a6kjj`).

Reproduced offline against the shipped layout functions. The offending
corridor belongs to the **hidden shortcut** `room-room-entry-1`
(r1c2) -> `room-room-merge-3-0` (r4c0), confirmed live via
`hiddenIncomingByRoomId`. Its source room picks its exit face by child
index: the hidden child gets `exitFaceForIndex(children.length, 'north')`,
i.e. `'east'`. The target is at a LOWER column, so `buildEdgeCorridor`'s
general corner branch (`dungeon-layout.mjs`, "Different column" block)
draws leg 1 at the door row from `entryPoint.x` back to the east face:
`{gx:302, gy:15, gw:30, gh:1}` -- the whole width of the source room's
interior, at its centre row. That is exactly the live strip (tiles at
y=1550, `corridor-end` at x=33150).

The exit face is a function of *which child this is*, never of *where the
target is*. South happens to be safe for any target (its horizontal leg
runs in the source's own south margin row); east is safe only for a target
to the east; west only for one to the west.

Sweep (500 seeds, `roomCount = 6 + i % 15`, real + hidden edges, door
slots and incoming faces mirrored from `dungeon-scene.mjs`, 8,911 edges):

- **678 edges (7.6%) draw a corridor segment strictly inside their own
  SOURCE room**: hidden east with target col <= source col (347 of 387),
  hidden west (63 of 63 same-column), real west (171 of 171), real east to
  the same column (69 of 69), plus 24 real south edges.
- **2,046 edges (23%) overlap their own TARGET room** (not caused by the
  face choice; see "Target-room overlaps" below).
- The existing sweep (`tests/dungeon-layout.test.mjs`, "corridor routing
  regression sweep (#174)") never sees either class: it excludes the
  edge's own source and target from the overlap check, ignores hidden
  edges, and always passes `exitFaceForIndex(idx)` with a single north
  incoming slot.

This is the "independently-chosen values sharing one crossing point" shape
again (#225, #324): the face the room's walls are built for, the face the
corridor is built for, and where the target actually is, are three
unrelated decisions.

### Why changing only the face is not enough

A room has one door per outgoing face (`exitPoint` is the face centre, or
one seeded offset on the same-column fast path). With faces chosen by
target direction (south always valid; east if target col > source col;
west if target col < source col), distinct-face assignment is impossible
for **681 of 7,028 source rooms (9.7%)**, and for **504 (7.2%)** even if
west exits are allowed. Typical: two children that both need south, or
three children to the east. So the fix has two parts: choose each edge's
face by target direction, and allow several outgoing doors on one face.

## Goals

- No corridor segment of any real or hidden edge lies strictly inside its
  own source room, on any face, for any column relationship.
- Every outgoing door of a room is placed by one pure function, and every
  consumer (wall building, margin openings, corridor, collision checks)
  reads that function's result -- nothing re-derives a door position.
- No sight or movement leak around any door (the #324/#353/#355 class).
- Deterministic and seed-stable: same seed, same layout, always.

## Non-goals

- The target-room overlap class (filed separately, see below).
- Re-routing corridors around other rooms (`findCorridorPath`) or the
  multi-cell chain's own geometry, except where the exit point it is given
  changes.
- Changing incoming faces / `incomingFaceFor` / incoming door slots.

## Valid exit faces per target

Let `s`/`t` be source/target columns. Target rank is always >= source
rank + 1 (`computeRanks`), and `computeColumns` keeps every room on an
even column, so a column difference is never 1.

| Target | Face | Why |
|---|---|---|
| any | `south` | leg 1 runs along the source's south margin row, then down; already works for every column relationship (`real/south/dcol-1` and `dcol1` show source overlaps in only 24 of 7,028, see Risks) |
| `t > s` | `east` | leg 1 runs east through the source's east margin, away from the room |
| `t < s` | `west` (optional) | leg 1 would run west **out of a face that has no margin** (rooms have none on north/west, see `cellMarginWalls`) into the always-empty odd buffer column, which `sealBufferCellIfUnbuilt` walls off |
| any | `north` | never; it is an incoming face (or free when incoming is `west`, still never valid: targets are below) |

**Decision 1:** `west` is not assigned at all. Once a
face can carry several doors, south absorbs every non-east target, so west
is never required, and west would need new buffer-cell crossing geometry
(treat the buffer cell as a transit cell with an east entry side, with its
own openings) for no feasibility gain. Under this recommendation outgoing
candidates are `['south', 'east']` for both incoming faces. Using west would be a separate phase, cancelled by Decision 1.

## Face assignment (deterministic)

New pure function in `scripts/dungeon-layout.mjs`:

```
outgoingDoorPlan(seed, roomId, rect, pos, outgoingEdges, positionByRoomId,
                 incomingFace) -> Map<edgeKey, { face, slotIndex, slot,
                                                  exitPoint, doorSpan }>
```

- `outgoingEdges` is derived purely from `layoutEdges` and
  `hiddenIncomingByRoomId` (real children in `edges` order, then hidden
  targets in `hiddenIncomingByRoomId` key order). `edgeKey` is
  `${sourceId}->${targetId}`. No iteration-order or object-identity
  dependence beyond those already-persisted structures.
- Face: `east` if `target.col > pos.col`, else `south`.
- Slots on a face: edges sorted by a total order independent of build
  order: south ascending by `(target.col, target.rank, targetId)`, east
  descending by `(target.col, target.rank, targetId)` top-to-bottom (the
  nearest target takes the lowest door, so legs nest instead of crossing).
- `slot` comes from a new `outgoingSlotsForFace(rect, count, face)`
  mirroring `doorSlotsForFace` (equal contiguous divisions of the face).
- `exitPoint` is gap-START semantics (door span `[p, p + DOOR_WIDTH)` is
  one whole cell, #324), computed with `clampDoorStart` inside the slot.
  With `count === 1` it is **byte-identical to today**: the seeded
  `outgoingOffset` (`doorOffsetAt(seed, `${roomId}-${face}`, 'outgoing',
  size)`) on the same-column/same-rank fast path, the face centre
  otherwise. With `count > 1` it is the slot centre. Small rooms (6) fit 3
  one-cell doors on a face; the sweep must confirm no face ever needs more
  than `size / DOOR_WIDTH` doors (max 3 edges per room today).
- Randomness uses only `doorOffsetAt`'s existing seed keys; no new
  seeded values are introduced, so existing seeds keep their rolls.

## Touched code

All consumers switch from `exitFaceForIndex(i, incomingFace)` plus
in-place `exitPoint` computation to `outgoingDoorPlan`.

**`scripts/dungeon-layout.mjs`**

- `exitFaceForIndex` / `OUTGOING_CANDIDATES`: kept (legacy gate, see
  Migration) but no longer used by new-layout code.
- `roomEnclosureWalls`: `outgoingFaces` stays a list of faces, but a face
  with doors is no longer left wholly open for placeholders to cover. It
  gains an optional `doorSpansByFace`; each outgoing face contributes
  solid wall segments for everything outside its door spans (this absorbs
  today's `sourceFaceCapWalls`, which is built by the *child* per edge and
  would, with two doors on one face, cap one edge's door with the other
  edge's cap -- the #324 failure shape).
- `sourceFaceCapWalls`: removed from `buildEdgeCorridor` for new-layout
  edges (the source's own build now seals its face); kept for legacy.
- `buildEdgeCorridor` (all four branches): gains an optional `exitDoor`
  (`{ face, exitPoint }` from the plan). When present it replaces the
  branch's own `outgoingOffset` / centre computation:
  - same-column south fast path: `doorX0 = exitDoor.exitPoint.x`;
  - same-rank east fast path: `doorY0 = exitDoor.exitPoint.y`;
  - multi-cell branch and corner branch: `exitPoint = exitDoor.exitPoint`;
  - the dogleg branches (#297) keep their lane maths but start from the
    planned door.
  When absent, behaviour is unchanged (legacy and the ~4,000 lines of
  existing tests keep working).
- `outgoingMarginOffset`: returns the planned door's `{ offset, width }`
  (width widened by the corridor's real span as today) instead of
  re-deriving which branch fires. It becomes a thin reader of
  `outgoingDoorPlan` + one `buildEdgeCorridor` call for the width.
- `findPriorityCollision`, `pendingForeignMarginOpenings`: both
  enumerate source edges with `exitFaceForIndex(index, ...)` and only for
  real children. They switch to the plan, and `pendingForeignMarginOpenings`
  additionally iterates hidden edges (it currently ignores them).
  `sameColumnTwoDown` / `sameRankTwoOver` conditions are re-derived from
  the planned face, not the index.
- `cellMarginWalls`: already accepts an array of openings per side
  (#297); each planned door on a margin face contributes one opening
  `{ offset, width }`. No signature change; tests added for two openings
  from two source edges on one side.

**`scripts/dungeon-scene.mjs`**

- ~405-415: `realOutgoingFaces`, `outgoingFaces`, `childIdByFace` are
  replaced by the plan (`childIdByFace` is single-valued per face today
  and cannot represent two doors; margin openings are built per planned
  door).
- ~467-487: the margin-openings loop iterates planned doors, not
  `marginFaces`.
- ~530-556: frontier and hidden placeholders cover each door's span only
  (`doorSpan`), not the whole face (`roomSidesForRect(rect)[face]`);
  flags `dungeonFrontierWallForEdge` / `dungeonHiddenDoorForEdge` stay
  keyed by edge, so child-build supersession is unchanged.
- ~1218-1221: `exitFaceFromSource` and the `buildEdgeCorridor` call read
  the plan for the *source* and pass `exitDoor`.
- `unlockDoorsFromRoom` and `dungeonDoorFromRoomId` lookups are by edge
  already; no change expected, to be confirmed in the plan.

`scripts/ui/dungeon-app.mjs` (precompute of `incomingFaceByRoomId`) gains
a `layoutVersion` stamp only.

## Containment (no leaks)

Rules the plan's tests must assert, each as a wall-vs-opening check in the
style of the #225 buildability tests (not footprint overlap):

1. Every outgoing face is solid except exactly its planned door spans.
2. Each door span coincides with the corridor floor's own source-side
   end (same value, from the plan, in the wall, the margin opening and the
   corridor).
3. A margin opening exists for every door on a margin face and is as wide
   as that corridor's real floor there (#288's rule).
4. No source-face cap or margin wall ends up covering another edge's door.
5. Corridors on one face stay physically separate (Decision 3): no two
   edges' floors may overlap or touch. East doors are separate by slot
   row; south doors are separate only if their margin-row legs are
   disjoint, which fails for two lower-column targets (Open question 5).
   The test asserts pairwise floor disjointness per source room.

## Property test (acceptance criterion)

`tests/dungeon-layout.test.mjs`, new describe "no corridor lies inside its
own endpoints (#415)":

- Over >= 500 seeds, `roomCount = 6 + i % 15`: `buildRoomGraph`,
  `attachHiddenPaths`, `computeRanks/Columns`, `incomingFaceFor` per room
  with the same `legitimateSourceIds` as `dungeon-app.mjs`,
  `incomingConnectionsFor` for real + hidden, `findPriorityCollision` +
  `assignDoorSlotsWithPriority` for slots, the plan for exit faces/doors.
  This mirrors `buildPopulateAndUnlockGraphNode` exactly (the existing
  sweep does not).
- For every edge, no segment of `corridorSegments` or any transit cell's
  `corridorSegments` overlaps (strict `rectsOverlap`) its **source**
  rect. Must be zero.
- Same assertion against the **target** rect: ratcheted (a recorded
  ceiling that may only fall, as the #231/#297 sweeps do) until the
  separate target-overlap issue lands, then zero.
- Additional invariants: planned faces are in `{south, east}`; east only
  when target col > source col; per-face door spans are disjoint and
  within their slot; the plan is identical across two independent calls
  and unchanged by shuffling `edges` key order.
- First commit adds the source-overlap test and it must **fail** on main
  (678 expected failures) before any fix.

## Target-room overlaps (verified, separate)

Verified first, as requested. 2,046 of 8,911 edges draw a segment inside
their own target room: 1,183 east-exit multi-cell (+11 direct), 542 south-exit
multi-cell, 130 south-exit direct (incoming west), 176 west-exit (which
also fail on source) and 4 north-exit. It is **not** produced by the exit-face choice (east/south
edges fail it with a clean source), so it does not fall out of this
change. Two causes are visible in the code: (a) the documented #174 Task 4
residual (connector 2 into toRect's north/west face when the last hop
does not arrive from straight north, `buildEdgeCorridor` multi-cell
comment), and (b) `cornerConnector`'s degenerate leg
(`gh = max(CORRIDOR_LEN, |dy|)` extends one cell *into* the room when
`corner.y === to.y`). I have not isolated the split between them. Filed as
its own issue; this spec only ratchets it.

## Migration and existing runs

Geometry is regenerated deterministically from the persisted seed, but
built rooms are never rebuilt (`isSlotBuilt`), so a run built under the old
faces and extended under the new ones would meet mismatched doors.

- New run-state field `layoutVersion` (absent = 1). `createRun` /
  precompute stamps 2. Every plan consumer branches: version 1 uses
  today's `exitFaceForIndex` path untouched; version 2 uses the plan.
- Existing runs, including the user's current one, keep their old
  geometry (and the bug); only new runs get the fix. Unknown to check in
  the plan phase: whether any run is ever partially built (the code
  suggests full eager pregeneration at run start, in which case no
  mixing is possible, but the "ensure-built retry" paths imply it can
  happen). If partial builds exist, the version gate is what keeps them
  consistent.
- Single-edge, single-face rooms with a south or same-direction east
  target produce byte-identical geometry under version 2 (the `count === 1`
  rule), so most existing test fixtures are unchanged.

## Risks and unknowns

- Door-count capacity per face (3 doors on a 6-wide face, one cell each,
  slot width 2) is believed fine; the sweep must prove the maximum
  out-degree + hidden.
- Shared margin-row floors for two south doors (Containment rule 5).
- East doors stacked on one face: nested legs assumed non-crossing by the
  sort order; crossing would merge floors the same way.
- `real/south/dcol1` shows 13 and `dcol-1` 11 source overlaps even though
  south "always works": these are 24 edges whose cause is not yet known
  (multi-cell chain + `findCorridorPath` interaction is the suspect). The
  property test will either confirm they vanish with planned doors or
  surface a further cause; treated as in scope if it is the same shape.
  **Resolved in Chunk 4:** same shape (face versus path). The target's incoming
  face is `west`, so BFS routes through the buffer column, and when a north and
  a south route tie it tries north first; the connector then ran from the south
  door back across the source room. With a planned exit, `findCorridorPath`
  now refuses a first hop back across the source (north from a south door, west
  from an east door). Source overlap under the plan is 0 over the 500-seed sweep.
- Known, not this change: a merge target's wider floor than the margin opening
  (#231) and sibling lane conflicts (Open question 5) still show as margin walls
  cutting a floor; the buildability sweep ratchets them.
- The hidden edge's reveal flow (`unsealHiddenDoorFromRoom`) is keyed by
  edge and shouldn't change, but is untested against a relocated door.
- Live verification needs a **new** run (existing runs are version 1).

## Phasing

1. Pure layer: `outgoingSlotsForFace`, `outgoingDoorPlan`, the failing
   property test (source overlap), plan-level invariants. No behaviour
   change. Reviewable alone.
2. `buildEdgeCorridor` `exitDoor` in all branches, `outgoingMarginOffset`,
   `findPriorityCollision`, `pendingForeignMarginOpenings` (incl. hidden),
   `roomEnclosureWalls` door spans; unit tests per branch. Still unused by
   the scene.
3. Scene wiring (`dungeon-scene.mjs` placeholders, margin openings, source
   call), `layoutVersion` gate, wall-vs-opening buildability sweep, the
   property test goes green for source overlap.
4. Resolve Open question 5 (lane conflicts), as the user decides.

Phases 1+2 could be one PR if small; 3 is the risky one and ships alone.
Each PR bumps `module.json`; run `update-architecture-docs` when imports
change (phase 1 may add none).

## Decisions (user, 2026-10-01)

1. `west` is dropped as an assignable outgoing face. Lower-column targets
   use `south`; candidates are `['south', 'east']` for both incoming faces.
   Phase 4 (west via buffer cell) is cancelled.
2. Existing runs are ignored: only new runs get the fix, behind the
   `layoutVersion` gate (absent = 1 = legacy).
3. Corridors sharing a face stay physically separate: no merged floors.
   This replaces the "merge acceptable" stance in Containment rule 5 (see
   Open question 5 for the case this makes infeasible).
4. The target-room overlap class is ratcheted in the #415 property test and
   fixed under #416, not #415.

## Open question (found while planning)

5. Decision 3 cannot hold for every room. South doors' horizontal legs all
   run in the source's single, one-cell-deep south margin row. A
   lower-column target's leg runs west from its door to the target's
   entry; two lower-column targets on the same room therefore overlap in
   that row whatever the slot order (the far target's leg passes the
   other door). East doors are unaffected (each east slot is its own
   row). A same-column target's leg is vertical and can sit rightmost
   without overlap. Measured on the 500-seed sweep: about 149 of 7,028
   source rooms (2.1%) have two or more lower-column targets
   (`westcol,westcol` 139, `same,westcol,westcol` 1, `east,westcol,westcol`
   9). Options: (A) allow a shared trunk (merged floor) for that case only;
   (B) re-admit `west` for the second lower-column edge (buffer-cell
   crossing geometry, the cancelled phase 4); (C) avoid the situation at
   graph generation (e.g. hidden shortcut selection never adds a second
   lower-column target to a source; only valid if the real/hidden split of
   those 149 allows it, not yet measured); (D) deepen the margin (changes
   `CORRIDOR_LEN`/stride, rejected as it shifts every layout). The plan
   builds a lane-conflict ratchet and defers this to its last chunk.
