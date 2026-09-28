# Column gap-packing for guaranteed west-lane availability — design

**Tracks:** [#174](https://github.com/cory-johannsen/foundry-pf2e-dungeon-crawl/issues/174) (further extends this issue's scope). Supersedes the residual scope of [#196](https://github.com/cory-johannsen/foundry-pf2e-dungeon-crawl/issues/196) — expected to close it as a side effect, verified in Testing below.

## Problem

The incoming-face-direction redesign (see
`docs/superpowers/specs/2026-09-26-incoming-face-direction-redesign-design.md`)
let a room's incoming connection fall back to its west face when north is
blocked, predicting a drop in the "boxed in" corridor-edge rate from
31.3% to ~7.9%. Measured against the real, full pipeline (this issue's
own Task 7), the actual improvement was 32.18% → 31.58% — essentially
none.

**Root cause, confirmed via full-pipeline measurement**: `computeColumns`
assigns columns within a rank via a gapless counter (0, 1, 2, 3...), so
for any room past the first in its rank, the column immediately to its
west is always occupied by a same-rank sibling — not a legitimate
parent. `incomingFaceFor` correctly refuses to treat a sibling as
legitimate, so west is structurally available only for column-0 rooms,
and even then the BFS route to reach the (otherwise genuinely empty)
far-west lane from a distant source frequently exceeds
`findCorridorPath`'s search bounds. Widening the search margin does not
meaningfully help (confirmed empirically: even a 10x wider margin only
recovers ~1.6 additional percentage points) — this is not a search-bound
problem, it is that west is rarely even a legitimate candidate in the
first place.

## Decision

Change `computeColumns` to assign columns via a skip-by-2 counter (0, 2,
4, 6...) instead of skip-by-1, so every room's immediate same-rank
neighbor columns are *always* empty, never a sibling. This makes west
genuinely available for essentially every room whose north is blocked,
restoring (and, per the measurement in Testing below, exceeding) the
original ~7.9% prediction.

**This reverses an explicit, previously-confirmed decision.** The
original corridor-routing design
(`docs/superpowers/specs/2026-09-26-corridor-routing-and-cell-containment-design.md`,
Non-goals and Decision sections) explicitly considered and rejected
"extending `computeColumns` to insert explicit transit cells so no edge
ever spans more than one rank/column," reasoning that it would touch an
already-shipped, already-reviewed layout algorithm and make dungeons
visually sparser. That reasoning was sound *at the time* — the
alternative (pathfinding at build time, keeping `computeColumns`
untouched) was measured as sufficient. It has since been shown, by this
issue's own Task 7 measurement, not to be sufficient: the "boxed in"
problem north-or-west set out to solve is dominated by same-rank
sibling packing, which pathfinding-at-build-time cannot route around
without genuinely free space to route *through*. Given that, and given
Cory's explicit sign-off on the resulting visual cost (below), this
spec deliberately reverses that non-goal rather than silently
contradicting it.

**Accepted cost**: every rank's total width roughly doubles (half its
columns are now permanent empty spacers), and `resizeSceneForLayout`'s
scene width — already a pure function of `maxCol` — will be roughly 2x
larger for the same room count. No test or production code asserts an
exact scene width, so this is a real but silent efficiency cost, not a
functional regression. Confirmed with Cory before proceeding.

**Expected side effect**: since a room's west-neighbor cell becomes
structurally always-empty, the "both north and west blocked" residual
case #196 was tracking is expected to become vacuously rare-to-zero.
This spec does not implement a *targeted* fix for #196 — it's a
consequence of solving the underlying packing problem more generally.
Verified empirically in Testing; #196 is closed in this work's own
close-out if confirmed, not left to go stale.

## Architecture

### `computeColumns`

One-line change: `nextColByRank[rank] = col + 2` instead of `col + 1`.
The function's own docblock (currently describing "the next unused
column" via "a monotonic per-rank counter") is updated to describe the
skip-by-2 scheme and why (leaves a guaranteed-empty buffer column to
every room's own west side). The stale, pre-existing "column averaging"
comment elsewhere in the file's module-level docblock (already
inaccurate before this change — the current DFS-based `computeColumns`
never averaged columns, that was a pre-#93 design) is corrected in the
same pass since this task is already touching the surrounding
documentation.

No other production code needs to change to accommodate wider column
values — confirmed (Task 7's own investigation): `roomRect`/`cellBounds`
only ever multiply `col * COLUMN_STRIDE` (harmless for any non-negative
integer), nothing assumes column N+1 exists because column N does, and
`resizeSceneForLayout`'s width calculation is already a pure function of
`maxCol`.

### Buffer-column containment

Every odd (unused) column between two real rooms in the same rank is
now permanent, empty grid space that needs full 4-sided containment —
otherwise this redesign trades a visible "corridor crosses a room"
leak for an equally-real "vision/movement leaks into unbuilt void
between rooms" leak, defeating this whole multi-issue effort's own
core goal.

This reuses existing machinery rather than inventing new geometry:
`transitCellContainmentWalls(rank, col, [])` (already exported, already
tested to produce a fully-sealed 4-wall boundary when given no
openings) is the exact primitive needed. A new, small
`scripts/dungeon-scene.mjs` function,
`sealBufferCellIfUnbuilt(scene, rank, col)`, builds it idempotently,
using the *same* wall flags (`dungeonTransitCellMarginForCell`,
`dungeonTransitCellOpenings`) `buildTransitCellIfNeeded` already reads
and writes for a corridor-crossed transit cell:

```js
async function sealBufferCellIfUnbuilt(scene, rank, col) {
  const cellKey = `${rank},${col}`;
  const alreadyBuilt = scene.walls.some(
    (w) => w.getFlag(MODULE_ID, 'dungeonTransitCellMarginForCell') === cellKey,
  );
  if (alreadyBuilt) return;
  const marginWalls = transitCellContainmentWalls(rank, col, []).map((side) =>
    wallDoc(side, {
      flags: {
        [MODULE_ID]: { dungeonTransitCellMarginForCell: cellKey, dungeonTransitCellOpenings: [] },
      },
    }),
  );
  await scene.createEmbeddedDocuments('Wall', marginWalls);
}
```

**Why this composes correctly with `buildTransitCellIfNeeded`, in
either build order** (this is the one subtle correctness property this
design depends on, and it holds by construction, not by luck):

- **Buffer sealed first, corridor crosses it later**: `buildTransitCellIfNeeded`
  reads `existingMarginWalls` keyed by the same `dungeonTransitCellMarginForCell`
  flag, finds the buffer's own walls, reads back `priorOpenings = []`
  (exactly what `sealBufferCellIfUnbuilt` recorded), and rebuilds with its
  own entry/exit added to that empty list — precisely its existing,
  already-shipped, already-tested behavior for "a second edge crosses an
  already-built transit cell." No special-casing needed; a proactively-sealed
  buffer cell is indistinguishable, from `buildTransitCellIfNeeded`'s own
  point of view, from a transit cell a first real corridor already crossed
  with zero openings so far.
- **Corridor crosses it first, buffer-sealing check runs later**:
  `sealBufferCellIfUnbuilt`'s own `alreadyBuilt` check finds
  `dungeonTransitCellMarginForCell` walls already present (built by the real
  crossing) and does nothing — never re-seals over an opening a real corridor
  already needs.

**Trigger point**: `buildRoomAtGraphNode` (`scripts/dungeon-scene.mjs`),
which already receives `occupiedCells` (threaded in by the incoming-face
redesign's own Task 6). For the room being built, at `(rank, col)`, check
both same-rank neighbors, `(rank, col - 1)` and `(rank, col + 1)`: for
whichever is *not* present in `occupiedCells` (a real buffer column, not
another room), call `sealBufferCellIfUnbuilt(scene, rank, thatCol)`. A
buffer column between two real rooms gets triggered by whichever of its
two neighbors is built first; a "trailing" buffer column beyond the last
room in a rank (with no real room on either side) is never triggered by
anyone — correct, since nothing will ever be adjacent to it or route
through it, the same as space beyond `maxCol` has always been implicitly
unreachable.

## Data flow

1. `computeColumns` produces columns at 0, 2, 4, 6... per rank — no
   change to when or how it's called (`scripts/ui/dungeon-app.mjs`,
   unchanged call site).
2. `occupiedCells` (already derived from `layoutPositionByRoomId` at
   multiple existing call sites) naturally reflects the new column
   values — no change needed, since it's a pure re-keying of whatever
   `computeColumns` actually produced.
3. `buildRoomAtGraphNode`, for every room it builds, additionally seals
   its own same-rank buffer-column neighbors via `sealBufferCellIfUnbuilt`.
4. `buildTransitCellIfNeeded` (unchanged) correctly composes with step 3
   regardless of build order, per the Architecture section above.

## Error handling / edge cases

- **The #110 fog-leak-avoidance ordering still applies**:
  `sealBufferCellIfUnbuilt` only ever *creates* wall documents, never
  deletes anything on its own path — the only deletion in this whole
  interaction is `buildTransitCellIfNeeded`'s own existing, already-#110-compliant
  rebuild (create the new superseding walls, then delete the old ones).
- **A buffer column at the very start of a rank** (before column 0):
  does not exist — `computeColumns` still starts every rank's first room
  at column 0, unchanged; there is no "column -1" real cell to seal, and
  none is expected (west availability for a column-0 room already
  existed before this change, since nothing is ever placed at a negative
  column).
- **Determinism per seed**: `computeColumns`'s own output remains a pure
  function of the graph structure and `entryId`, unchanged in kind, just
  a different stride — same seed still produces the same columns, same
  buffer-column set.

## Testing

- `computeColumns`: update its own existing test suite's expectations
  where they'd otherwise assume unit steps (none currently assert exact
  literals per Task 7's own investigation, so this is mostly additive);
  add a new test asserting the stride invariant directly — every room's
  own column is even, and two same-rank rooms visited consecutively
  differ by exactly 2.
- `transitCellContainmentWalls`'s own "no openings → full seal" test
  already exists and needs no change — it's the exact primitive this
  design reuses, already proven correct.
- Whole-pipeline regression sweep (this issue's own Task 7 sweep,
  updated in place): re-measure the boxed-in rate (`findCorridorPath`
  returning `null`) across the same 500-seed sweep. Expected: at or near
  0%, confirming both the original design's own prediction and that
  #196's residual case is genuinely, empirically closed by this change
  — not just theoretically. Update the sweep's own comments (which
  currently cite the now-stale 31.3%/7.9%/24% figures) to reflect the
  new reality and point at this spec.
- Live Foundry verification (same boundary as all other wall-building
  code in this codebase): confirm a buffer column between two rooms is
  fully sealed with no visible gap or leak, confirm a corridor that
  legitimately needs to cross a buffer column still opens correctly
  (proving the composition property above holds in the live wall/tile
  data, not just in isolated unit tests), and confirm scene sizing at
  the new, wider `maxCol` renders correctly with no layout glitches.

## Out of scope

- Any change to the visual/gameplay experience of a wider dungeon beyond
  what's already implied by `resizeSceneForLayout`'s existing pure
  scaling — no new camera/zoom/pathing accommodation is being added for
  the larger scenes this produces.
- A fully general fix for `exitFaceForIndex`'s own layout-unawareness
  (still #174's other original, still-open root cause) — unaffected by
  this change either way.
