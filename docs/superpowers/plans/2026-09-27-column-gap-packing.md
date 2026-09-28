# Column Gap-Packing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Guarantee every room a genuinely empty west lane by changing `computeColumns` to skip-by-2 column assignment, seal the resulting permanent buffer columns with full containment, and confirm this actually drives the "boxed in" corridor rate down near zero against the real pipeline (closing #196 as a measured side effect, not an assumption).

**Architecture:** `computeColumns` (`scripts/dungeon-layout.mjs`) changes its per-rank counter from `+1` to `+2`. A new `sealBufferCellIfUnbuilt` function (`scripts/dungeon-scene.mjs`) reuses the already-tested `transitCellContainmentWalls(rank, col, [])` primitive and the same wall flags `buildTransitCellIfNeeded` already reads/writes, so a proactively-sealed buffer cell and a later real corridor crossing compose correctly regardless of build order. `buildRoomAtGraphNode` triggers this for each room's own same-rank neighbor columns.

**Tech Stack:** Vanilla JS (ESM), Vitest for pure-logic tests, Foundry VTT client APIs (untested directly, verified via live verification per this codebase's existing convention).

**Spec:** `docs/superpowers/specs/2026-09-27-column-gap-packing-design.md`

## Global Constraints

- `computeColumns`'s own no-collision guarantee (no two same-rank rooms ever share a column) must hold under the new stride, exactly as it already does under the old one.
- The #110 fog-leak-avoidance ordering applies to every new wall: create new real geometry before deleting whatever it supersedes, never the reverse.
- Every new/changed pure function must be deterministic for a given seed.
- A proactively-sealed buffer cell and a later real corridor crossing of that same cell must compose correctly regardless of which happens first (see spec's own Architecture section for why this holds by construction).

## Review Focus

- **A buffer column between two real rooms, sealed by whichever room is built first.** The second room's own build (or a later corridor crossing) must never re-solidify or duplicate the first seal — idempotency via the shared `dungeonTransitCellMarginForCell` flag must actually work in both orderings.
- **A real corridor crossing a buffer column BEFORE either neighboring room's own proactive-seal check runs.** The proactive-seal's own `alreadyBuilt` check must correctly detect the real crossing's walls and skip, never re-sealing over an opening a corridor needs.
- **A "trailing" buffer column beyond the last room in a rank** (no real room on either side). Nothing should ever try to seal it — confirm this is genuinely inert, not silently broken.
- **The whole-pipeline boxed-in rate**, re-measured against the same 500-seed sweep this issue's own Task 7 used, must land at or near 0% — a higher number means a real logic gap in the column-stride change or its interaction with `incomingFaceFor`, not an acceptable residual.
- **Existing containment/corridor tests that construct their own `cellBounds`/rank/col fixtures by hand** (from earlier tasks in this whole multi-plan effort) must not silently assume adjacent (rank, col) and (rank, col+1) values without noticing the column semantics changed — a spot check that no such test's own intent breaks.

---

## Task 1: `computeColumns` skip-by-2 stride

**Files:**
- Modify: `scripts/dungeon-layout.mjs`
- Test: `tests/dungeon-layout.test.mjs`

**Interfaces:**
- Consumes: nothing new.
- Produces: `computeColumns(edges, ranks, entryId)` — same signature and return shape (`{roomId: columnNumber}`), now assigning 0, 2, 4, 6... instead of 0, 1, 2, 3... per rank.

- [ ] **Step 1: Write the failing test**

Add to the existing `describe('computeColumns', ...)` block in `tests/dungeon-layout.test.mjs` (do not remove any existing test — none currently assert an exact numeric column value, so all of them remain valid and passing under the new stride; this is purely additive):

```js
  it('assigns columns via a skip-by-2 stride: every room\'s own column is even, and same-rank rooms differ by exactly 2 in visit order (#174 follow-up: guarantees a genuinely empty west-neighbor column for every room, not just the first in its rank)', () => {
    const edges = { 'room-entry': ['a', 'b', 'c'], a: [], b: [], c: [] };
    const ranks = computeRanks(edges, 'room-entry');
    const cols = computeColumns(edges, ranks, 'room-entry');
    expect(cols['room-entry']).toBe(0);
    expect(cols.a).toBe(0);
    expect(cols.b).toBe(2);
    expect(cols.c).toBe(4);
    for (const id of Object.keys(edges)) expect(cols[id] % 2).toBe(0);
  });

  it('every same-rank room\'s immediate column neighbors (col-1, col+1) are guaranteed never occupied by another room in the same rank, across a wide sweep', () => {
    for (let n = 0; n < 40; n += 1) {
      const seed = `layout-${n}`;
      for (const roomCount of [3, 4, 6, 8, 12, 16, 24]) {
        const { rooms, edges } = buildRoomGraph({ seed, roomCount });
        const ranks = computeRanks(edges, 'room-entry');
        const cols = computeColumns(edges, ranks, 'room-entry');
        const usedByRank = {};
        for (const roomId of Object.keys(rooms)) {
          const key = ranks[roomId];
          usedByRank[key] ??= new Set();
          usedByRank[key].add(cols[roomId]);
        }
        for (const roomId of Object.keys(rooms)) {
          const key = ranks[roomId];
          const col = cols[roomId];
          expect(usedByRank[key].has(col - 1)).toBe(false);
          expect(usedByRank[key].has(col + 1)).toBe(false);
        }
      }
    }
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/dungeon-layout.test.mjs -t "computeColumns"`
Expected: FAIL (both new tests — the current gapless stride assigns `b`→1, `c`→2, and immediate neighbors ARE occupied by same-rank siblings today)

- [ ] **Step 3: Implement**

```js
/**
 * Column index (integer, per-rank left-to-right order, always even) via
 * a single DFS pass from entryId — #93 pre-flight fix (see the note
 * below the function for what the original bottom-up-width/top-down-centering
 * design got wrong and why it was replaced). Every room is visited
 * exactly once (first parent to reach it wins, matching the design's
 * "merge rooms placed once, whichever parent reaches them first"
 * intent); each NEW room claims the next unused EVEN column at its own
 * rank via a monotonic per-rank counter stepping by 2 (#174 follow-up —
 * previously stepped by 1), which guarantees two different rooms at the
 * same rank can never collide on a column AND leaves the odd column
 * immediately to every room's own west side permanently empty — a
 * genuinely free routing/incoming-face lane, not just a side effect of
 * visit order. `ranks` (pre-computed by computeRanks, already correctly
 * reflecting a merge room's longest-path rank) is looked up directly,
 * not re-derived from DFS depth, so a merge room still lands at its
 * correct rank regardless of which parent's branch reaches it first.
 */
export function computeColumns(edges, ranks, entryId) {
  const columns = {};
  const nextColByRank = {};
  const visited = new Set();

  function visit(roomId) {
    if (visited.has(roomId)) return;
    visited.add(roomId);
    const rank = ranks[roomId];
    const col = nextColByRank[rank] ?? 0;
    columns[roomId] = col;
    nextColByRank[rank] = col + 2;
    for (const childId of edges[roomId] ?? []) visit(childId);
  }
  visit(entryId);
  return columns;
}
```

Also fix the stale, pre-existing "column averaging" comment in this file's module-level docblock (unrelated to this task's own change in substance, but already wrong before this task and worth correcting in the same pass since it's directly adjacent to `COLUMN_STRIDE`, which this task's own reasoning references):

```js
// Uniform grid cell strides — a deliberate simplification of a fully
// variable-width tree layout (see the design spec): every column is wide
// enough for the largest room, every rank tall enough for the tallest, so
// no two rooms ever overlap regardless of their individual roomSizeAt
// roll. computeColumns assigns columns via a skip-by-2 counter (#174
// follow-up), leaving a permanent empty buffer column beside every real
// room for routing/incoming-face use, sealed by sealBufferCellIfUnbuilt
// (dungeon-scene.mjs).
export const ROW_STRIDE = ROOM_SIZE_LARGE + CORRIDOR_LEN;
export const COLUMN_STRIDE = ROOM_SIZE_LARGE + CORRIDOR_LEN;
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/dungeon-layout.test.mjs -t "computeColumns"`
Expected: PASS — including every pre-existing `computeColumns` test, unchanged (none assert exact literals, per this plan's own pre-flight investigation).

- [ ] **Step 5: Run the full test file**

Run: `npx vitest run tests/dungeon-layout.test.mjs`
Expected: PASS. This changes the numeric column values flowing into every downstream test that calls `computeColumns` as part of a larger sweep (the corridor-routing regression sweeps, the incoming-face sweep) — none of them assert exact column literals either (confirmed during this plan's own pre-flight investigation), so they should all still pass, but investigate and properly fix (never weaken) any surprise failure rather than assuming it's expected.

- [ ] **Step 6: Commit**

```bash
git add scripts/dungeon-layout.mjs tests/dungeon-layout.test.mjs
git commit -m "feat: computeColumns assigns columns via skip-by-2 stride, guaranteeing a free west lane"
```

---

## Task 2: Buffer-column containment (`sealBufferCellIfUnbuilt`)

**Files:**
- Modify: `scripts/dungeon-scene.mjs`

**Interfaces:**
- Consumes: `transitCellContainmentWalls(rank, col, openings)` (existing, unchanged), `wallDoc` (existing helper in this file).
- Produces: a new (not exported — module-private, matching `buildTransitCellIfNeeded`'s own visibility) `sealBufferCellIfUnbuilt(scene, rank, col)`, called from `buildRoomAtGraphNode` for each room's own same-rank neighbor columns.

- [ ] **Step 1: Implement `sealBufferCellIfUnbuilt`**

No automated test for this step in isolation — it's Foundry-glue code (creates embedded `Wall` documents against a live `scene`), the same boundary this codebase already uses for every other wall-building function in this file (`buildTransitCellIfNeeded`, `buildRoomAtGraphNode` itself, etc., none of which have dedicated unit tests). Its own correctness rests on the already-tested `transitCellContainmentWalls` primitive (verified: `transitCellContainmentWalls(rank, col, [])` produces a full 4-wall seal, existing test) plus this task's own manual verification checklist (Step 3) and Task 4's live pass.

Add immediately after `buildTransitCellIfNeeded` (so the two related functions stay adjacent in the file):

```js
/**
 * Proactively seals an empty buffer column (#174 follow-up:
 * computeColumns' skip-by-2 stride leaves one beside every room) with a
 * full 4-wall containment boundary, idempotently — using the exact same
 * `dungeonTransitCellMarginForCell`/`dungeonTransitCellOpenings` flags
 * `buildTransitCellIfNeeded` already reads and writes for a
 * corridor-crossed transit cell, so the two compose correctly regardless
 * of which runs first for a given cell:
 *
 * - Sealed here first, corridor crosses it later: `buildTransitCellIfNeeded`
 *   reads this function's own `dungeonTransitCellOpenings: []` back as
 *   `priorOpenings`, and rebuilds with its own entry/exit added — its
 *   existing, already-shipped behavior for "a second edge crosses an
 *   already-built transit cell," no special-casing needed.
 * - A corridor crosses it first, this runs later: `alreadyBuilt` below
 *   finds the crossing's own walls already tagged with this cell's key
 *   and does nothing, never re-sealing over an opening a corridor needs.
 */
async function sealBufferCellIfUnbuilt(scene, rank, col) {
  const cellKey = `${rank},${col}`;
  const alreadyBuilt = scene.walls.some(
    (w) => w.getFlag(MODULE_ID, "dungeonTransitCellMarginForCell") === cellKey,
  );
  if (alreadyBuilt) return;
  const marginWalls = transitCellContainmentWalls(rank, col, []).map((side) =>
    wallDoc(side, {
      flags: {
        [MODULE_ID]: { dungeonTransitCellMarginForCell: cellKey, dungeonTransitCellOpenings: [] },
      },
    }),
  );
  await scene.createEmbeddedDocuments("Wall", marginWalls);
}
```

- [ ] **Step 2: Wire the trigger into `buildRoomAtGraphNode`**

Immediately after this room's own enclosure walls are created (the existing `if (walls.length) await scene.createEmbeddedDocuments("Wall", walls);` line — add the new code right after it, in the same function):

```js
  if (walls.length) await scene.createEmbeddedDocuments("Wall", walls);

  // #174 follow-up: seal this room's own same-rank buffer-column
  // neighbors (computeColumns' skip-by-2 stride guarantees col-1/col+1
  // are never another real room) — idempotent, so it's safe to call
  // from whichever of a buffer column's two neighboring rooms happens
  // to be built first.
  for (const neighborCol of [col - 1, col + 1]) {
    if (occupiedCells[`${rank},${neighborCol}`] == null) {
      await sealBufferCellIfUnbuilt(scene, rank, neighborCol);
    }
  }
```

`occupiedCells` and `rank`/`col` are already parameters/locals in scope in `buildRoomAtGraphNode` (threaded in by the incoming-face redesign's own earlier work).

- [ ] **Step 3: Manual verification checklist (for Task 4's live pass)**

(a) A buffer column between two rooms in the same rank is fully sealed (no gap on any of its 4 sides) once at least one of the two neighboring rooms has been built. (b) A buffer column that a real corridor legitimately crosses (part of a multi-cell obstacle-routed path) still has that crossing's own opening — the room built AFTER the corridor's own crossing does not re-seal over it. (c) A buffer column crossed by a corridor is correctly sealed on its OTHER two sides even when a neighboring room's own proactive-seal check runs before the corridor's own crossing — i.e., verify the composition property holds in both orderings, not just one. (d) A "trailing" buffer column beyond the last room in a rank (nothing on either side) has no walls at all — confirming it's correctly never triggered, not silently broken.

- [ ] **Step 4: Run the full test suite**

Run: `npx vitest run`
Expected: PASS, no regressions (this task adds no new pure-function surface, so no new automated test is expected to fail or need updating beyond what Task 1 already touched).

- [ ] **Step 5: Sanity-check syntax**

Run: `node --check scripts/dungeon-scene.mjs`
Expected: OK.

- [ ] **Step 6: Commit**

```bash
git add scripts/dungeon-scene.mjs
git commit -m "feat: seal buffer columns left by computeColumns' skip-by-2 stride"
```

---

## Task 3: Re-measure the whole-pipeline boxed-in rate, update stale figures

**Files:**
- Modify: `tests/dungeon-layout.test.mjs`

**Interfaces:**
- Consumes: `computeColumns` (Task 1), `incomingFaceFor`/`findCorridorPath` (unchanged, from the incoming-face redesign).
- Produces: no new exports — this task re-measures and documents the real effect of Tasks 1-2, and corrects test comments that cite the now-stale 31.3%/7.9%/24% figures from before this plan.

- [ ] **Step 1: Locate and update the existing boxed-in-rate sweep test**

Find the test added by the incoming-face redesign's own Task 7 (search `tests/dungeon-layout.test.mjs` for `nullPathEdges / totalEdges` or `"the boxed-in rate"`). Its current assertion (`<= 0.10`) and comment (citing "~7.9%") both predate this plan's own fix — update the comment to reflect the real cause-and-effect chain, and tighten the ceiling to match what this plan's own change actually achieves:

```js
  it('the boxed-in rate (null findCorridorPath) is at or near 0%, now that computeColumns\' skip-by-2 stride (#174 follow-up) guarantees every room a genuinely free west lane', () => {
    let totalEdges = 0;
    let nullPathEdges = 0;
    for (let i = 0; i < 500; i += 1) {
      const seed = `sweep-${i}`;
      const roomCount = 6 + (i % 15);
      const { rooms, edges } = buildRoomGraph({ seed, roomCount });
      const { layoutEdges, hiddenIncomingByRoomId } = attachHiddenPaths({ rooms, edges, seed });
      const ranks = computeRanks(layoutEdges, 'room-entry');
      const columns = computeColumns(layoutEdges, ranks, 'room-entry');
      const positionByRoomId = Object.fromEntries(
        Object.keys(rooms).map((id) => [id, { rank: ranks[id], col: columns[id] }]),
      );
      const occupiedCells = Object.fromEntries(
        Object.entries(positionByRoomId).map(([id, pos]) => [`${pos.rank},${pos.col}`, id]),
      );
      const incomingFaceByRoomId = Object.fromEntries(
        Object.keys(rooms).map((id) => {
          const legitimateSourceIds = new Set([
            ...parentRoomIdsFor(layoutEdges, id),
            ...(hiddenIncomingByRoomId[id] ?? []),
          ]);
          return [id, incomingFaceFor(id, positionByRoomId, occupiedCells, legitimateSourceIds)];
        }),
      );

      for (const [fromId, children] of Object.entries(edges)) {
        for (const toId of children) {
          totalEdges += 1;
          const path = findCorridorPath(
            positionByRoomId[fromId], positionByRoomId[toId], occupiedCells,
            { fromRoomId: fromId, toRoomId: toId, incomingFace: incomingFaceByRoomId[toId] },
          );
          if (!path) nullPathEdges += 1;
        }
      }
    }
    expect(totalEdges).toBeGreaterThan(1000);
    expect(nullPathEdges / totalEdges).toBeLessThanOrEqual(0.02);
  });
```

(This is the same sweep body as before — only the `it(...)` description and the final threshold, `0.10` → `0.02`, change. Do not touch the sweep's own mechanics beyond swapping in `computeColumns`' new behavior implicitly by virtue of calling the real function.)

- [ ] **Step 2: Run the sweep and record the actual measured rate**

Run: `npx vitest run tests/dungeon-layout.test.mjs -t "boxed-in rate"`

If the `<= 0.02` ceiling fails, do not loosen it reflexively — investigate first: check whether `incomingFaceFor`'s own legitimacy exclusion is somehow still matching a same-rank buffer "occupant" it shouldn't (it shouldn't ever match anything, since buffer columns are never in `occupiedCells` at all), or whether some other interaction (e.g., `findCorridorPath`'s own `SEARCH_MARGIN` bound) is still limiting reachability even with the free lane now closer. If a genuine, well-understood residual remains above 2% after investigation, adjust the threshold to the actual measured value with a comment explaining why, rather than picking an arbitrary round number.

- [ ] **Step 3: Update the incoming-face redesign's own now-stale documentation references**

The design spec `docs/superpowers/specs/2026-09-26-incoming-face-direction-redesign-design.md` documents a 31.3%/7.9% pair, and its own Testing section describes a `<= 0.10` sweep ceiling — both now superseded by this plan's own spec and this task's own measurement. Add a short note at the top of that file's own "Non-goals" section (do not rewrite its historical numbers — they were real, measured findings at the time):

```markdown
**2026-09-27 update:** the ~7.9% residual this section describes as
issue #196's own scope was later found, empirically, to be much larger
(~31.6%) against the real pipeline — `computeColumns`' gapless packing
meant west was rarely actually available. Superseded by
`docs/superpowers/specs/2026-09-27-column-gap-packing-design.md`, which
closes #196 by a different mechanism (guaranteeing west via a layout
change, not routing around its absence).
```

- [ ] **Step 4: Run the full test suite**

Run: `npx vitest run`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add tests/dungeon-layout.test.mjs docs/superpowers/specs/2026-09-26-incoming-face-direction-redesign-design.md
git commit -m "test: re-measure boxed-in rate after computeColumns' skip-by-2 stride, update stale figures"
```

---

## Task 4: Fix `findCorridorPath`'s multi-parent exemption gap

**Files:**
- Modify: `scripts/dungeon-layout.mjs`, `scripts/ui/dungeon-app.mjs`, `scripts/dungeon-scene.mjs`
- Test: `tests/dungeon-layout.test.mjs`

**Why this task exists:** Task 3's own re-measurement found the boxed-in
rate only dropped from ~32.2% to ~23.3%, not the near-0% Tasks 1-2
predicted. Root-caused: `findCorridorPath`'s `isBlocked` check only
exempts the *current edge's own* `fromRoomId`/`toRoomId` from blocking —
not any of the target's *other* legitimate incoming sources. A merge
room with 2+ real parents (routine in this generator — "forced-merge...
not just the final goal") has all of its real parents sharing the SAME
gate cell concept (one incoming face, subdivided into door slots, per
`incomingFaceFor`'s own design) — but today, an edge from parent B
routing into that merge room sees parent A (a legitimate co-parent
occupying the gate cell) as an unrelated blocker, since `isBlocked` only
know about B and the merge room itself, not A. This accounts for ~21.7
of the ~23.3 percentage points measured in Task 3 — by far the dominant
remaining cause, and a distinct, well-understood bug unrelated to column
spacing.

**Interfaces:**
- Consumes: `parentRoomIdsFor` (existing), `hiddenIncomingByRoomId` (existing).
- Produces: `findCorridorPath(fromPos, toPos, occupiedCells, { fromRoomId, toRoomId, incomingFace, legitimateSourceIds = [] })` — a new options-object member, a plain array (never a `Set` — `state` is persisted via `replaceRunState`, and this codebase's own established convention, e.g. `hiddenRooms: [...hiddenRooms]`, always spreads a Set to an array before it enters `state`). `buildEdgeCorridor(..., incomingFace, legitimateSourceIds = [])` and `outgoingMarginOffset(..., incomingFace, legitimateSourceIds = [])` both gain the same trailing parameter, passed through unchanged to their own internal `findCorridorPath` calls. `state.legitimateSourceIdsByRoomId` (`Map<roomId, roomId[]>`), precomputed once alongside `incomingFaceByRoomId`.

- [ ] **Step 1: Write the failing tests**

```js
describe('findCorridorPath with legitimateSourceIds (merge-room multi-parent gate fix)', () => {
  it('defaults to the old fromRoomId/toRoomId-only exemption when legitimateSourceIds is omitted, byte-identical to before this change', () => {
    const occupiedCells = { '1,0': 'otherParent' };
    const path = findCorridorPath(
      { rank: 0, col: 0 }, { rank: 2, col: 0 }, occupiedCells,
      { fromRoomId: 'parentB', toRoomId: 'merge' },
    );
    expect(path).toBeNull(); // 'otherParent' still blocks, unchanged from today
  });

  it('a co-parent legitimately occupying the target\'s own gate cell no longer blocks a DIFFERENT parent\'s own edge into the same merge room', () => {
    // parentA sits directly north of the merge room (a completely normal
    // shape -- one real parent per rank-adjacent cell); parentB's own
    // edge into the SAME merge room must still be able to route in,
    // since parentA is one of the merge room's own legitimate sources,
    // not an unrelated blocker.
    const occupiedCells = { '1,0': 'parentA' };
    const path = findCorridorPath(
      { rank: 0, col: 2 }, { rank: 2, col: 0 }, occupiedCells,
      { fromRoomId: 'parentB', toRoomId: 'merge', legitimateSourceIds: ['parentA', 'parentB'] },
    );
    expect(path).not.toBeNull();
    expect(path[path.length - 1]).toEqual({ rank: 2, col: 0 });
  });

  it('an UNRELATED room (not in legitimateSourceIds) at the same position still blocks, exactly as before', () => {
    const occupiedCells = { '1,0': 'totallyUnrelatedRoom' };
    const path = findCorridorPath(
      { rank: 0, col: 2 }, { rank: 2, col: 0 }, occupiedCells,
      { fromRoomId: 'parentB', toRoomId: 'merge', legitimateSourceIds: ['parentA', 'parentB'] },
    );
    expect(path).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/dungeon-layout.test.mjs -t "legitimateSourceIds"`
Expected: FAIL (test 2 — today's `isBlocked` has no concept of a third-party legitimate source)

- [ ] **Step 3: Implement `findCorridorPath`'s exemption widening**

```js
  const isBlocked = (pos) => {
    const occupant = occupiedCells[key(pos)];
    if (occupant == null || occupant === fromRoomId || occupant === toRoomId) return false;
    return !legitimateSourceIds.includes(occupant);
  };
```
(replacing the existing single-line `isBlocked` body; `legitimateSourceIds` is destructured from the function's own options object with a `= []` default, added alongside the existing `incomingFace = 'north'` default in the function's own signature.)

Thread it through `buildEdgeCorridor` (its own internal `findCorridorPath` call already passes `{ fromRoomId, toRoomId, incomingFace }` — add `legitimateSourceIds` to that same object) and `outgoingMarginOffset` (same change to its own internal call), both gaining `legitimateSourceIds = []` as a new trailing parameter on their own signatures, passed straight through with no other logic change.

- [ ] **Step 4: Precompute `legitimateSourceIdsByRoomId` in `dungeon-app.mjs`**

Extend the existing `incomingFaceByRoomId` precompute block (right after `layoutPositionByRoomId` is built) — it already constructs `legitimateSourceIds` as a local `Set` per room; also capture it as a plain array in a new map:

```js
  const legitimateSourceIdsByRoomId = {};
  const incomingFaceByRoomId = Object.fromEntries(
    Object.keys(rooms).map((id) => {
      const legitimateSourceIds = new Set([
        ...parentRoomIdsFor(layoutEdges, id),
        ...(hiddenIncomingByRoomId[id] ?? []),
      ]);
      legitimateSourceIdsByRoomId[id] = Array.from(legitimateSourceIds);
      return [id, incomingFaceFor(id, layoutPositionByRoomId, occupiedCellsForIncomingFace, legitimateSourceIds)];
    }),
  );
```

Add `legitimateSourceIdsByRoomId` to the `state = {...}` assembly, alongside `incomingFaceByRoomId`:

```js
  state = {
    ...stateWithoutLegacyFields,
    rooms,
    edges,
    layoutEdges,
    hiddenRooms: [...hiddenRooms],
    hiddenEdges,
    hiddenIncomingByRoomId,
    layoutPositionByRoomId,
    incomingFaceByRoomId,
    legitimateSourceIdsByRoomId,
    maxRank,
    currentRoomId: 'room-entry',
    history: [],
  };
```

- [ ] **Step 5: Wire the two `dungeon-scene.mjs` call sites**

In `buildPopulateAndUnlockGraphNode`, where `incomingFace` is already looked up (`state.incomingFaceByRoomId[room.id] ?? 'north'`), add the equivalent lookup and pass it into the main `buildEdgeCorridor` call:

```js
  const legitimateSourceIds = state.legitimateSourceIdsByRoomId[room.id] ?? [];
```
```js
      const { doorWall, revealDoorWall, plainWalls, corridorSegments, transitCells } =
        buildEdgeCorridor(state.seed, sourceId, room.id, sourceRect, rect, sourcePos, { rank, col }, exitFaceFromSource, toSlot, occupiedCells, incomingFace, legitimateSourceIds);
```

Thread `state.legitimateSourceIdsByRoomId` (the whole map) into `buildRoomAtGraphNode`'s own options, alongside `incomingFaceByRoomId`:

```js
        layoutPositionByRoomId: state.layoutPositionByRoomId,
        occupiedCells, incomingFace,
        incomingFaceByRoomId: state.incomingFaceByRoomId,
        legitimateSourceIdsByRoomId: state.legitimateSourceIdsByRoomId,
      },
    );
```

`buildRoomAtGraphNode`'s own destructured options gains `legitimateSourceIdsByRoomId = {}` alongside `incomingFaceByRoomId = {}`. In its margin-wall loop, thread the CHILD's own legitimate sources (not the room's own) into `outgoingMarginOffset`:

```js
  for (const face of marginFaces) {
    const childId = childIdByFace[face];
    const childPos = childId ? layoutPositionByRoomId[childId] : null;
    const childIncomingFace = childId ? (incomingFaceByRoomId?.[childId] ?? 'north') : 'north';
    const childLegitimateSourceIds = childId ? (legitimateSourceIdsByRoomId?.[childId] ?? []) : [];
    const offset = outgoingMarginOffset(
      seed, roomId, childId, face, rect, { rank, col },
      childPos ?? { rank: NaN, col: NaN }, occupiedCells, childIncomingFace, childLegitimateSourceIds,
    );
    const sideWalls = cellMarginWalls(rect, rank, col, { openSide: face, openOffset: offset, openWidth: DOOR_WIDTH });
    for (const side of sideWalls) if (side.dir === face) marginWalls.push(side);
    coveredMarginSides.add(face);
  }
```

**Note for the implementer:** exactly like the `incomingFace`/`incomingFaceByRoomId` distinction Task 6 of the incoming-face redesign plan established, do not conflate `legitimateSourceIds` (whichever room's own sources are relevant at a given call — the room being built's own, for the main `buildEdgeCorridor` call; a specific child's own, for the margin loop's `outgoingMarginOffset` call) with each other.

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx vitest run tests/dungeon-layout.test.mjs -t "legitimateSourceIds"`
Expected: PASS

- [ ] **Step 7: Re-run Task 3's own boxed-in-rate sweep and record the new measurement**

Run: `npx vitest run tests/dungeon-layout.test.mjs -t "boxed-in rate"`

Update the sweep's own body (`tests/dungeon-layout.test.mjs`) to thread `legitimateSourceIds` into its own `findCorridorPath` calls, matching how `buildEdgeCorridor`'s real callers now do — the sweep already computes `legitimateSourceIds` locally per room for its own `incomingFaceFor` calls; reuse that same array:

```js
          const path = findCorridorPath(
            positionByRoomId[fromId], positionByRoomId[toId], occupiedCells,
            {
              fromRoomId: fromId, toRoomId: toId, incomingFace: incomingFaceByRoomId[toId],
              legitimateSourceIds: Array.from(new Set([
                ...parentRoomIdsFor(layoutEdges, toId),
                ...(hiddenIncomingByRoomId[toId] ?? []),
              ])),
            },
          );
```

Update the test's own threshold based on what this fix actually achieves — if the measured rate drops to at or near the ~1.5% column-0-west-lane-trap residual Task 3's own investigation already identified as the OTHER, smaller remaining cause, set the threshold accordingly (e.g. `<= 0.03`) with a comment citing the actual number, the same evidence-based approach Task 3 itself used. Do not target `<= 0.02` reflexively if the real number is different — report and set the threshold to match reality.

- [ ] **Step 8: Run the full test suite**

Run: `npx vitest run`
Expected: PASS, no regressions.

- [ ] **Step 9: Commit**

```bash
git add scripts/dungeon-layout.mjs scripts/ui/dungeon-app.mjs scripts/dungeon-scene.mjs tests/dungeon-layout.test.mjs
git commit -m "fix: findCorridorPath must exempt a target's own legitimate co-parents, not just the current edge's fromRoomId"
```

---

## Task 5: Live verification, final review, and close-out

**Files:** none (verification + process only)

- [ ] **Step 1: Live Foundry verification**

Run Task 2's own manual checklist (Step 3) against a real generated dungeon in a live Foundry world. Generate a dungeon large enough to be confident it contains: at least one buffer column between two real rooms with no corridor crossing it (fully sealed, no gap), and at least one buffer column a corridor's own multi-cell route legitimately crosses (correctly opened on the crossing sides, sealed on the others). Confirm the scene's own physical size (now roughly 2x wider than before this plan, per the spec's own accepted cost) renders and scrolls correctly with no visual glitches.

- [ ] **Step 2: Whole-branch final review**

Dispatch a final code reviewer (most capable available model) against the full diff since this plan's own base commit, covering Tasks 1-3. Specifically ask the reviewer to independently re-verify:
- `computeColumns`' own no-collision guarantee still holds under the new stride (not just for the sweep sizes this plan's own tests happen to cover).
- The `sealBufferCellIfUnbuilt`/`buildTransitCellIfNeeded` composition property (both build orderings) by tracing the actual flag read/write logic in both functions, not just trusting the plan's own docblock claim.
- The measured boxed-in rate from Task 3 is genuinely at or near 0%, not an assertion loosened without investigation.

- [ ] **Step 3: Address final review findings**

One fix dispatch, one scoped re-review, adjudicate any residual findings per this plan's own established ruling process (ledgered, not silently applied).

- [ ] **Step 4: Merge and close out**

Following this branch's own established convention: merge `main` into this worktree's branch if it has moved, bump `module.json` (minor bump — this reverses an architectural non-goal and changes the layout algorithm's own output, not a routine fix), run the `update-architecture-docs` skill if any `scripts/` import graph changed, open a PR, handle automerge (merge directly via `gh pr merge --squash --delete-branch` if `gh pr merge --auto` doesn't actually enable it), and close out the GitHub issue lifecycle:
- Comment on #174 confirming the boxed-in rate is now at or near 0%, referencing the actual measured number from Task 3.
- **Close #196** with a comment explaining it was resolved as a side effect of `computeColumns`' skip-by-2 stride (link this plan's own spec), once Task 3's own measurement confirms the residual case genuinely no longer occurs at meaningful scale — do not close it speculatively before that measurement exists.
- Update project memory with the final outcome (the column gap-packing fix, the real measured rate, and #196's closure) for future sessions.
