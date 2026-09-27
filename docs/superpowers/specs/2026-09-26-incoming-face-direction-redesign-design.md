# Incoming-face direction redesign — design

**Tracks:** [#174](https://github.com/cory-johannsen/foundry-pf2e-dungeon-crawl/issues/174) (extends this issue's own scope — see its comment trail for how this was discovered). Residual gap tracked separately as [#196](https://github.com/cory-johannsen/foundry-pf2e-dungeon-crawl/issues/196).

## Problem

Task 6's own whole-pipeline regression sweep (500 seeds, the real
generation pipeline) found that **31.3% of all corridor edges** have
their target room's north-neighbor grid cell occupied by an unrelated
room. Since a room's incoming connection is hard-wired to its north
face (a design decision from #93's Task 5 redesign) and that neighbor's
own containment walls (#174's own Task 5) now seal its margin
completely, a corridor for these edges cannot physically reach its
target without either crossing a room's footprint or being
architecturally invalid.

This was not caught earlier because it was assumed rare (the design
spec's own "no free path" fallback explicitly frames this as "a densely
packed layout with zero free cells to route through") — empirically it
is the single most common failure mode, since any unrelated room can
land at `{rank: target.rank - 1, col: target.col}` in a branching layout
without the layout being "densely packed" in any visible sense.

An implementer's attempted geometric workaround (a fixed "safe lane"
along a cell's far edge, `trunkLaneCorridorSegments`) was independently
reviewed and found unsound: 100% broken for west-exit connections (cuts
through the *source* room's own interior), and roughly 50% of remaining
cases are bisected by a real, undeleted containment wall belonging to
the intervening room — an invisible, impassable corridor, a worse
failure mode than the visible-crossing bug this whole effort exists to
fix.

Widening `findCorridorPath`'s search margin does not help: 97.4% of
null-path cases are caused by the target's north-neighbor cell being
hard-occupied (a margin-independent block), not by the search box being
too small (confirmed empirically — a 5x wider search margin recovers
only 1.4% of null-path cases).

## Root cause

The actual root cause is not the pathfinding or the wall-building — it
is that a room's incoming face is fixed to north regardless of where its
real parent(s) actually sit in the generated layout, decoupling "where
the door is" from "where the corridor can actually go."

## Goals

- Reduce the rate of structurally boxed-in corridor edges from 31.3% to
  as low as a contained change can reach.
- Do not introduce a new invisible-corridor failure mode (the
  `trunkLaneCorridorSegments` mistake).
- Preserve every already-shipped invariant this session's own work
  established: merge rooms get one door per real parent (#93), a hidden
  detour's incoming connection is still built as real geometry before
  any placeholder it supersedes is deleted (#110), determinism per seed,
  orthogonal-only corridors.
- Do not change `computeRanks`/`computeColumns` (still a non-goal,
  unchanged from #174's own original spec — this redesign works with
  whatever layout they already produce, same reasoning as #174's own
  "pathfind at build time" decision).

## Non-goals

**2026-09-27 update:** the ~7.9% residual this section describes as
issue #196's own scope was later found, empirically, to be much larger
(~31.6%) against the real pipeline — `computeColumns`' gapless packing
meant west was rarely actually available. Superseded by
`docs/superpowers/specs/2026-09-27-column-gap-packing-design.md`, which
closes #196 by a different mechanism (guaranteeing west via a layout
change, not routing around its absence).

- Fully general incoming-on-any-of-4-faces routing. Considered
  (Approach B below) and rejected for now: it would require incoming
  connections on a marginable face (east/south) to get their own
  gap-coordination logic the way outgoing connections already have, and
  would let a single merge room need door slots split across genuinely
  different faces at once — a materially larger rework than this
  redesign, without a proportionally larger payoff (see Decision).
- Closing the full residual gap (rooms whose north AND west neighbors
  are both occupied, ~7.9% of edges). Tracked as
  [#196](https://github.com/cory-johannsen/foundry-pf2e-dungeon-crawl/issues/196).
  These edges keep today's existing accepted degradation: the pre-#174
  direct-line/corner corridor, which may visibly cross a room's
  footprint.
- Fixing `exitFaceForIndex`'s own layout-unawareness (assigning a
  child's exit face by index, ignoring where it actually lands in
  `computeColumns`) — this is #174's *other*, still-open original root
  cause, but it doesn't move the number this redesign targets (it's
  about which face the *source* exits from, not why an unrelated third
  room occupies the *target's* neighbor cell). Left for its own,
  separate follow-up if it turns out to matter after this fix ships.

## Decision

A room's incoming face is chosen once per room, at layout-precompute
time (the whole graph's rank/column positions are already fully known
before any room's walls are built — confirmed existing "full
pregeneration" behavior, `scripts/ui/dungeon-app.mjs`), from exactly two
candidates — **north**, then **west** as a fallback:

1. If the room's north-neighbor cell (`{rank: room.rank - 1, col:
   room.col}`) is empty, or occupied only by one of the room's own real
   parents or its hidden detour source, incoming = **north** (today's
   behavior, unchanged for the common case).
2. Otherwise, if the room's west-neighbor cell (`{rank: room.rank, col:
   room.col - 1}`) is empty, or occupied only by one of the room's own
   real parents/hidden source, incoming = **west**.
3. Otherwise, the room falls into the residual boxed-in bucket (#196) —
   incoming stays conceptually "north" for the purpose of the existing
   direct-line fallback (see Error handling), since there is no
   marginless face available at all.

**Why north-then-west, not a fuller set of candidates:** north and west
are the *only* two faces that are structurally marginless today — a
room always anchors at its own cell's top-left corner
(`roomRect`), so its north and west edges always coincide with the
cell's own north/west edges, regardless of room size. East and south
can have margin (for a `ROOM_SIZE_SMALL` room). Restricting incoming to
{north, west} means neither candidate face ever needs new
margin-gap-coordination logic — `cellMarginWalls` keeps its existing
east/south-only scope entirely unchanged. `exitFaceForIndex` already
treats west as a valid, marginless *outgoing* face today, so this isn't
a new geometric case for the codebase to handle, just a new place to
apply an existing one.

**Why this is worth doing over full 4-face generality (Approach B):**
measured empirically (same 500-seed sweep): north-or-west drops the
boxed-in rate from 31.3% to ~7.9% — it captures the large majority of
the win. Going further (any of 4 faces) would need incoming connections
on a marginable face to coordinate their own gap the way outgoing
connections do today, and would let a merge room need door slots on
genuinely different faces simultaneously (breaking the "one incoming
face per room" simplification `northDoorSlots`'s whole design rests on)
— a disproportionate increase in scope for the remaining, already-rare
tail.

**A room's incoming face is single-valued, not per-connection.** All of
a room's incoming connections (a merge room's several real parents, plus
a hidden detour source) still subdivide that *one* chosen face — exactly
like today's `northDoorSlots` subdivides north. This keeps the
merge-door logic (per-parent door count, `dungeonDoorFromRoomId`
disambiguation, #156's hidden-door handling) untouched; only *which*
face gets subdivided changes.

## Architecture

### New pure function: `incomingFaceFor`

`scripts/dungeon-layout.mjs` gains a new pure function, computed once
per room during the existing layout-precompute pass (alongside
`computeRanks`/`computeColumns`'s own output):

```js
export function incomingFaceFor(roomId, positionByRoomId, occupiedCells, legitimateSourceIds) {
  const pos = positionByRoomId[roomId];
  // A room's own id is never the occupant of a NEIGHBOR cell (each cell
  // holds at most one room, and a neighbor is by definition a different
  // cell) — the only exclusions that matter are this room's own real
  // parents/hidden source, which legitimately DO occupy an adjacent cell
  // in the common "parent directly above/beside" case.
  const isFreeOrLegitimate = (rank, col) => {
    const occupant = occupiedCells[`${rank},${col}`];
    return occupant == null || legitimateSourceIds.has(occupant);
  };
  if (isFreeOrLegitimate(pos.rank - 1, pos.col)) return 'north';
  if (isFreeOrLegitimate(pos.rank, pos.col - 1)) return 'west';
  return 'north'; // residual boxed-in case (#196) — see Error handling
}
```

`legitimateSourceIds` is the set of a room's own real parent ids
(`parentRoomIdsFor`) plus its hidden detour source id, if any (already
computed today via `incomingConnectionsFor`/`hiddenIncomingByRoomId` —
this function just reuses that existing data, not new state).

`incomingFaceByRoomId` (a `Map<roomId, 'north'|'west'>`) is derived once
for the whole graph, the same way `occupiedCells` already is, and
threaded through `state` alongside `layoutPositionByRoomId` — computed
in `scripts/ui/dungeon-app.mjs` right after `layoutPositionByRoomId` is
built (the same spot, same pattern, since both are pure derivations of
the same precomputed rank/column data).

### Wall/door geometry (`scripts/dungeon-layout.mjs`, `scripts/dungeon-scene.mjs`)

- `roomEnclosureWalls(seed, roomId, { incomingCount, incomingFace,
  outgoingFaces }, rect)` gains an `incomingFace` parameter (default
  `'north'`, preserving today's exact behavior for any caller that
  doesn't pass one — though `buildRoomAtGraphNode` always will). The
  `incomingCount === 0` solid-wall branch and the "leave this face open
  for door-carving" branch both target `incomingFace` instead of the
  literal `'north'`.
- `northDoorSlots(rect, count)` becomes `doorSlotsForFace(rect, count,
  face)`: for `face === 'north'`, identical output to today's
  `northDoorSlots` (divides the top edge along width). For `face ===
  'west'`, the mirrored computation — divides the left edge along
  height:
  ```js
  export function doorSlotsForFace(rect, count, face) {
    const { gx, gy, gw, gh } = rect;
    if (face === 'west') {
      const step = gh / count;
      return Array.from({ length: count }, (_, i) => ({
        x1: gx, y1: gy + i * step, x2: gx, y2: gy + (i + 1) * step,
      }));
    }
    const step = gw / count;
    return Array.from({ length: count }, (_, i) => ({
      x1: gx + i * step, y1: gy, x2: gx + (i + 1) * step, y2: gy,
    }));
  }
  ```
- `exitFaceForIndex(index, incomingFace)` gains the `incomingFace`
  parameter: outgoing candidates are always "the 3 faces that aren't
  `incomingFace`," in a fixed order per incoming face so results stay
  deterministic:
  ```js
  const OUTGOING_CANDIDATES = {
    north: ['south', 'east', 'west'], // byte-identical to today
    west: ['south', 'east', 'north'],
  };
  export function exitFaceForIndex(index, incomingFace = 'north') {
    return OUTGOING_CANDIDATES[incomingFace][index];
  }
  ```
  Every existing call site passes `incomingFace` (from
  `state.incomingFaceByRoomId[roomId]`); every room whose incoming face
  is (and stays) `'north'` gets an identical result to today, so this is
  provably a no-op for the majority case.
- `outgoingMarginOffset`'s existing `exitFace !== 'south'` branch
  (center-based for east/west/anything-not-south) is unaffected — north
  is still never a `marginFaces` candidate in `buildRoomAtGraphNode`
  (`marginFaces = outgoingFaces.filter(f => f === 'east' || f === 'south')`
  stays unchanged), since north is marginless regardless of whether it's
  used for incoming or (now, sometimes) outgoing.

### Corridor endpoint geometry (`buildEdgeCorridor`)

`buildEdgeCorridor` gains an `incomingFace` parameter (threaded from
`state.incomingFaceByRoomId[toRoomId]`). Every place that currently
hard-wires the target's entry row to `toRect.gy`/`toSlot.y1` (north)
branches on `incomingFace`.

**A real, easy-to-miss geometric trap here**: `buildEdgeCorridor`
currently computes `slotWidth` once, generically, at the top of the
function — `const slotWidth = toSlot.x2 - toSlot.x1;` — which silently
assumes a north-facing slot (`x1 !== x2`, `y1 === y2`). For a west-facing
slot (`doorSlotsForFace(toRect, count, 'west')`'s own output has `x1 ===
x2`, `y1 !== y2`), that same expression evaluates to **zero**. This must
become face-aware too:
```js
const slotSpan = incomingFace === 'west' ? (toSlot.y2 - toSlot.y1) : (toSlot.x2 - toSlot.x1);
```
(every other current use of `slotWidth` in the file gets renamed to
`slotSpan` for clarity, since it's no longer always a literal width).

- **North** (today's behavior, unchanged): `entryPoint = {x: toSlot.x1 +
  slotSpan/2, y: toSlot.y1}` (`toSlot.y1 === toRect.gy`).
- **West** (mirrored): `entryPoint = {x: toSlot.x1, y: toSlot.y1 +
  slotSpan/2}` (`toSlot.x1 === toRect.gx`, and `toSlot` now comes from
  `doorSlotsForFace(toRect, count, 'west')`, whose `x1`/`x2` are both
  `toRect.gx` and whose `y1`/`y2` span the slot).

The existing same-column/south-exit fast path (`exitFace === 'south' &&
sameColumn`) gets a mirrored sibling for a west-incoming target:
`exitFace === 'east' && sameRank` (parent directly to the child's left,
exiting east into the child's west face) — same shape as today's fast
path with the x/y axes and step directions swapped, reusing
`doorOffsetAt`'s existing `'outgoing'`/`'incoming'` roles (the seed key
for the incoming offset becomes `` `${toRoomId}-${incomingFace}-${toSlot.y1}` ``
generalized from today's literal `` `${toRoomId}-north-${toSlot.x1}` `` —
for a room whose incoming face is `'north'`, this string is
byte-identical to today, so existing seeds' door offsets for
north-incoming rooms are unaffected).

The multi-cell (obstacle-routed) branch's target-side connector
(`cornerConnector(lastCellPoint, entryPoint, ...)`) already takes
`entryPoint` as a parameter — no change needed there beyond `entryPoint`
itself now being face-aware, per above.

### Pathfinding (`findCorridorPath`)

The `canEnter` guard generalizes from "only the target's north-rank
neighbor may step into it" to "only the target's `incomingFace`
neighbor may step into it":

```js
const incomingNeighbor = incomingFace === 'west'
  ? { rank: toPos.rank, col: toPos.col - 1 }
  : { rank: toPos.rank - 1, col: toPos.col };
const canEnter = (from, to) => {
  if (to.rank === toPos.rank && to.col === toPos.col) {
    return from.rank === incomingNeighbor.rank && from.col === incomingNeighbor.col;
  }
  return true;
};
```

`findCorridorPath` gains an `incomingFace` parameter (default `'north'`,
preserving today's exact behavior for the residual boxed-in case where
incoming conceptually stays "north" per the Decision section above).

### Removing `trunkLaneCorridorSegments`

Task 6's `trunkLaneCorridorSegments` helper (and its two call sites in
`buildEdgeCorridor`'s `!path` sub-branches) is deleted. With the
boxed-in rate down to ~7.9% and tracked properly as #196, the correct
fallback for a null path is reverting to `buildEdgeCorridor`'s original,
pre-Task-6 behavior: the same offset-based (same-column/same-row,
adjacent) or center-based (different-column/different-row) direct/corner
line it already draws for the `path.length <= 2` case, applied
uniformly whether `path` is a short real path or `null`. This is an
honest, visible degradation (a DM can see and route around it) rather
than an invisible wall-bisected one.

## Data flow

1. `scripts/ui/dungeon-app.mjs`, immediately after `layoutPositionByRoomId`
   is built (existing code): derive `incomingFaceByRoomId` by calling
   `incomingFaceFor` once per room, using the already-computed
   `occupiedCells`-equivalent (inverting `layoutPositionByRoomId`, same
   pattern `buildPopulateAndUnlockGraphNode` already uses) and each
   room's own `parentRoomIdsFor`/`hiddenIncomingByRoomId` entry as
   `legitimateSourceIds`.
2. `incomingFaceByRoomId` is added to `state` alongside
   `layoutPositionByRoomId`, threaded the same way through
   `buildPopulateAndUnlockGraphNode` → `buildRoomAtGraphNode` (for wall
   geometry) and → `buildEdgeCorridor` (for corridor geometry).
3. `buildRoomAtGraphNode` passes `incomingFace` into
   `roomEnclosureWalls`, `doorSlotsForFace`, and `exitFaceForIndex`
   (replacing today's implicit `'north'` assumptions in each).
4. `buildPopulateAndUnlockGraphNode` passes `incomingFace` (of the
   *target* room) into `buildEdgeCorridor` and `findCorridorPath` for
   every connection being built into that room.

## Error handling / edge cases

- **Both north and west neighbors occupied by an unrelated room (the
  residual ~7.9%).** `incomingFaceFor` returns `'north'` (the Decision
  section's stated tiebreak), and `findCorridorPath` returns `null` for
  these connections exactly as it does today — triggering the restored
  (post-`trunkLaneCorridorSegments`-removal) direct-line fallback.
  Tracked for a real fix as #196; not solved by this redesign.
- **A room with zero incoming connections (the entry room).**
  `incomingFaceFor` is never called for it (no `legitimateSourceIds`,
  no meaningful "incoming face" to choose) — `roomEnclosureWalls`
  already branches on `incomingCount === 0` before ever consulting
  `incomingFace`, unchanged from today.
- **A merge room whose real parents sit on genuinely different sides**
  (e.g., one parent north, one parent west). `incomingFaceFor`'s check
  only asks "is the *neighbor cell* free-or-legitimate," not "which
  specific parent sits there" — so this is handled correctly by
  construction: if the north-neighbor cell happens to be occupied by
  one of the room's own real parents (a completely normal, expected
  case for the "parent directly above" shape), it counts as available,
  regardless of whether OTHER parents sit elsewhere entirely
  unconnected to this room's own adjacent cells (those other parents'
  own corridors still route via `findCorridorPath`/`buildEdgeCorridor`
  as multi-cell paths converging on the *same* chosen incoming face,
  exactly like today's design already requires for any non-adjacent
  parent).
- **The #110 fog-leak-avoidance ordering still applies** — new real wall
  geometry (whichever face's doors) is still created before the
  frontier placeholder it supersedes is deleted, never the reverse;
  this redesign changes *which* face gets that treatment, never the
  ordering itself.
- **Determinism per seed.** `incomingFaceFor` is a pure function of
  already-deterministic inputs (rank/column positions, which are
  themselves already deterministic per seed) — same seed still produces
  the same `incomingFaceByRoomId`, same as every other derived piece of
  state in this pipeline.

## Testing

- Pure-function unit tests for `incomingFaceFor`: north available (common
  case, unchanged), north blocked but west available (the fix's target
  case), both blocked (residual case, returns `'north'` as documented),
  and the "occupied by one of my own real parents" exclusion (including
  a merge room with 2+ real parents, at least one of which legitimately
  sits at the north-neighbor position).
- `doorSlotsForFace`: north output byte-identical to the old
  `northDoorSlots` for the same inputs (regression-proof the rename);
  west output correctly divides the left edge along height.
- `exitFaceForIndex(index, incomingFace)`: `incomingFace='north'`
  produces byte-identical output to today's existing tests (no
  behavior change for the majority case); `incomingFace='west'`
  produces the mirrored candidate set, still deterministic and never
  colliding with `'west'` itself.
- `buildEdgeCorridor` west-incoming cases: the new same-rank/east-exit
  fast path produces geometry mirrored (axes swapped) from the existing
  same-column/south-exit fast path's own already-tested cases; the
  multi-cell branch's target-side connector correctly uses a
  west-facing `entryPoint`.
- `findCorridorPath` with `incomingFace='west'`: only the target's
  west-neighbor may step into it; a north-neighbor-only route is
  correctly rejected the same way today's north-only tests reject a
  non-north approach.
- **Whole-pipeline regression sweep (mirroring Task 6's own
  methodology, updated)**: across the same 500-seed/roomCount sweep,
  assert (a) zero corridor-vs-room-footprint overlaps for every edge
  whose `incomingFaceFor` result is not the residual case, (b) the
  measured boxed-in rate is at or below the ~7.9% this design predicts
  (a regression here means either `incomingFaceFor`'s own logic broke,
  or a downstream layer stopped honoring its result), and (c) for every
  `incomingFace='west'` room, its door/corridor geometry actually lands
  on the west face (not silently still north) — a sanity check that the
  new parameter is actually threaded through every layer, not just
  computed and ignored somewhere along the chain.
- Live Foundry verification (same boundary this codebase always uses
  for Foundry-glue code): confirm a west-incoming room's door is
  visually on the correct wall, opens/unlocks correctly, and its
  corridor connects without crossing another room — at least one
  generated dungeon is very likely to contain a west-incoming room
  given ~24% of rooms are expected to need one (31.3% minus 7.9%).

## Out of scope, tracked separately

- [#196](https://github.com/cory-johannsen/foundry-pf2e-dungeon-crawl/issues/196):
  the residual ~7.9% boxed-in case (both north and west neighbors
  occupied) — needs margin-aware routing through an occupying room's own
  margin, a separate design effort.
- `exitFaceForIndex`'s own layout-unawareness (assigning exit face by
  index rather than actual relative position) — #174's other original
  root cause, not addressed here since it doesn't move this redesign's
  target number.
