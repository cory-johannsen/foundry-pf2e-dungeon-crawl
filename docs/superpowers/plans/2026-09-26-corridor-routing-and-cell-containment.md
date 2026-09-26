# Corridor Routing and Cell Containment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make dungeon-generation corridors route around other rooms instead of crossing through them, and seal every room's unused grid-cell margin so vision and party movement can never leak into unbuilt void space.

**Architecture:** `dungeon-layout.mjs` gains pure grid-pathfinding (`findCorridorPath`, BFS over rank/column cells) and pure geometry helpers for a room's own cell-margin walls and a transit cell's crossing walls. `buildEdgeCorridor` is reworked to walk a multi-cell path instead of assuming a direct or one-corner route, reusing its existing straight/L-shaped segment logic per hop rather than inventing a new drawing algorithm. `dungeon-scene.mjs` wires this in: `buildRoomAtGraphNode` seals every room's own cell margin, and `buildPopulateAndUnlockGraphNode` derives which cells are occupied, pathfinds each connection, and builds real geometry for every intermediate cell the path crosses (idempotently, since two different edges can cross the same empty cell).

**Tech Stack:** Vanilla JS (ESM), Vitest for pure-logic tests, Foundry VTT client APIs (untested directly, verified via live verification per this codebase's existing convention).

**Spec:** `docs/superpowers/specs/2026-09-26-corridor-routing-and-cell-containment-design.md`

## Global Constraints

- Corridors stay orthogonal only (north/south/east/west) — no diagonal routing.
- `computeRanks`/`computeColumns` (the rank/column layout algorithm) are unchanged — pathfinding works with whatever layout they already produce.
- Room sizing (`ROOM_SIZE_SMALL`/`ROOM_SIZE_LARGE`) and weights are unchanged.
- Every new pure function must be deterministic for a given seed — same seed, same output, every time.
- The #110 fog-leak-avoidance ordering applies to every new wall: create the new real wall(s) before deleting whatever frontier placeholder they supersede, never the reverse.
- A room always anchors at its own cell's top-left corner (`roomRect`'s existing behavior, unchanged) — its north and west edges always coincide with its cell's north/west edges; only east and south can ever have unused margin.

## Review Focus

- **A room whose east or south face is used for an outgoing connection, and is also `ROOM_SIZE_SMALL`.** The corridor's own door sits on the room's own rect boundary, well short of the cell's actual edge — the cell-margin wall must still seal the rest of that side's margin without blocking the corridor's own strip through it.
- **Two different edges route through the exact same empty transit cell, from different direction pairs.** The second edge must be able to add its own opening to that cell's already-built boundary walls, not skip the cell as already-done or duplicate its geometry.
- **A path with no free cells to route through at all** (every neighboring cell already occupied by an unrelated room). `findCorridorPath` must return a clean "no path" signal, and the caller must fall back to a direct line rather than throwing or leaving the room half-built.
- **A merge room several ranks below one of its parents**, the routine case that caused the worst crossings today (a merge room's rank is `max(parent ranks) + 1`, so one parent can be many ranks shallower). The path between them must route around, not through, every intermediate rank's rooms.
- **A corridor path that bends within a single cell** (enters from one side, exits an adjacent, not opposite, side — e.g. enters north, exits east). The existing L-shaped 2-segment drawing logic must still produce a corner that stays inside that one cell's own bounds, not spill into a neighboring cell.

---

## Task 1: Cell occupancy and grid pathfinding

**Files:**
- Modify: `scripts/dungeon-layout.mjs`
- Test: `tests/dungeon-layout.test.mjs`

**Interfaces:**
- Consumes: `INITIAL_GX`, `COLUMN_STRIDE`, `ROW_STRIDE` (already exist in this file).
- Produces: `cellBounds(rank, col)` → `{gx, gy, gw, gh}` (the full grid-cell rect, exported new). `findCorridorPath(fromPos, toPos, occupiedCells, {fromRoomId, toRoomId})` → ordered array of `{rank, col}` from `fromPos` to `toPos` inclusive, or `null` if no path exists (exported new). `occupiedCells` is a plain object `{"rank,col": roomId}` — later tasks derive this once from `state.layoutPositionByRoomId`.

- [ ] **Step 1: Write the failing tests**

```js
import { cellBounds, findCorridorPath, INITIAL_GX, COLUMN_STRIDE, ROW_STRIDE } from '../scripts/dungeon-layout.mjs';

describe('cellBounds', () => {
  it('returns the full stride-sized cell at the same origin roomRect uses', () => {
    expect(cellBounds(0, 0)).toEqual({ gx: INITIAL_GX, gy: 0, gw: COLUMN_STRIDE, gh: ROW_STRIDE });
    expect(cellBounds(2, 3)).toEqual({
      gx: INITIAL_GX + 3 * COLUMN_STRIDE, gy: 2 * ROW_STRIDE, gw: COLUMN_STRIDE, gh: ROW_STRIDE,
    });
  });
});

describe('findCorridorPath', () => {
  it('returns a direct 2-cell path when adjacent and nothing blocks it', () => {
    const path = findCorridorPath(
      { rank: 0, col: 0 }, { rank: 1, col: 0 }, {}, { fromRoomId: 'a', toRoomId: 'b' },
    );
    expect(path).toEqual([{ rank: 0, col: 0 }, { rank: 1, col: 0 }]);
  });

  it('routes straight through empty cells when the endpoints are several ranks apart', () => {
    const path = findCorridorPath(
      { rank: 0, col: 0 }, { rank: 3, col: 0 }, {}, { fromRoomId: 'a', toRoomId: 'b' },
    );
    expect(path).toEqual([
      { rank: 0, col: 0 }, { rank: 1, col: 0 }, { rank: 2, col: 0 }, { rank: 3, col: 0 },
    ]);
  });

  it('detours around a cell occupied by an unrelated room', () => {
    const occupiedCells = { '1,0': 'blocker' };
    const path = findCorridorPath(
      { rank: 0, col: 0 }, { rank: 2, col: 0 }, occupiedCells, { fromRoomId: 'a', toRoomId: 'b' },
    );
    expect(path).not.toBeNull();
    expect(path).not.toContainEqual({ rank: 1, col: 0 });
    expect(path[0]).toEqual({ rank: 0, col: 0 });
    expect(path[path.length - 1]).toEqual({ rank: 2, col: 0 });
  });

  it('never treats the endpoints themselves as blocked, even though they are occupied by fromRoomId/toRoomId', () => {
    const occupiedCells = { '0,0': 'a', '1,0': 'b' };
    const path = findCorridorPath(
      { rank: 0, col: 0 }, { rank: 1, col: 0 }, occupiedCells, { fromRoomId: 'a', toRoomId: 'b' },
    );
    expect(path).toEqual([{ rank: 0, col: 0 }, { rank: 1, col: 0 }]);
  });

  it('returns null when every route is blocked within the search bounds', () => {
    const occupiedCells = { '1,0': 'x', '1,1': 'x', '1,-1': 'x', '0,1': 'x', '0,-1': 'x' };
    const path = findCorridorPath(
      { rank: 0, col: 0 }, { rank: 2, col: 0 }, occupiedCells, { fromRoomId: 'a', toRoomId: 'b' },
    );
    expect(path).toBeNull();
  });

  it('is deterministic — same inputs, same path, every call', () => {
    const occupiedCells = { '1,0': 'blocker' };
    const path1 = findCorridorPath({ rank: 0, col: 0 }, { rank: 2, col: 0 }, occupiedCells, { fromRoomId: 'a', toRoomId: 'b' });
    const path2 = findCorridorPath({ rank: 0, col: 0 }, { rank: 2, col: 0 }, occupiedCells, { fromRoomId: 'a', toRoomId: 'b' });
    expect(path2).toEqual(path1);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/dungeon-layout.test.mjs -t "cellBounds|findCorridorPath"`
Expected: FAIL (`cellBounds`/`findCorridorPath` not exported yet)

- [ ] **Step 3: Write minimal implementation**

```js
/** Full grid-cell rect for (rank, col) — a room/corridor's allotted
 * space, independent of the room's own actual size. Same origin roomRect
 * uses: a room always anchors at its cell's own top-left corner, so a
 * room's own rect and its cellBounds share the same gx/gy always. */
export function cellBounds(rank, col) {
  return {
    gx: INITIAL_GX + col * COLUMN_STRIDE,
    gy: rank * ROW_STRIDE,
    gw: COLUMN_STRIDE,
    gh: ROW_STRIDE,
  };
}

/**
 * BFS shortest path of cells from fromPos to toPos over the rank/column
 * grid, treating any cell occupied by a room other than fromRoomId/
 * toRoomId as blocked. Returns an ordered array of {rank, col} from
 * fromPos to toPos inclusive (length 2 when already adjacent with
 * nothing to route around), or null if no path exists within the search
 * bounds — callers fall back to a direct line in that case (see
 * buildEdgeCorridor), so returning null rather than throwing is
 * deliberate. The search space is bounded to a small margin around the
 * two endpoints' own bounding box (not the whole graph) — real dungeons
 * never need a detour wider than a room or two, and an unbounded search
 * risks wandering arbitrarily far in a degenerate all-blocked case.
 */
export function findCorridorPath(fromPos, toPos, occupiedCells, { fromRoomId, toRoomId }) {
  const SEARCH_MARGIN = 2;
  const key = (pos) => `${pos.rank},${pos.col}`;
  const minRank = Math.max(0, Math.min(fromPos.rank, toPos.rank) - SEARCH_MARGIN);
  const maxRank = Math.max(fromPos.rank, toPos.rank) + SEARCH_MARGIN;
  const minCol = Math.min(fromPos.col, toPos.col) - SEARCH_MARGIN;
  const maxCol = Math.max(fromPos.col, toPos.col) + SEARCH_MARGIN;
  const inBounds = (pos) =>
    pos.rank >= minRank && pos.rank <= maxRank && pos.col >= minCol && pos.col <= maxCol;
  const isBlocked = (pos) => {
    const occupant = occupiedCells[key(pos)];
    return occupant != null && occupant !== fromRoomId && occupant !== toRoomId;
  };
  // #174 fix round (found by Task 4's own review, not anticipated when
  // this task was first written): a room's own incoming connection
  // always lands on its north face (fixed since #93's Task 5 redesign),
  // and entryPoint has no spare margin to route through on any other
  // side (cellMarginWalls only ever seals east/south margin). A path
  // that reaches toPos from anywhere but its own north-adjacent cell
  // cannot be turned into corridor geometry without cutting into the
  // target room's own interior -- confirmed to happen with certainty
  // whenever toPos's own north neighbor is occupied by an unrelated
  // room, forcing a same-column detour to approach from another side.
  // Only toPos's own north neighbor may step into it; every other
  // neighbor treats toPos as unreachable from itself, same as any other
  // blocked cell. If that leaves no path at all, this correctly returns
  // null and the caller falls back to the existing direct-line
  // degradation (already an accepted, explicitly-designed imperfection
  // for the "no free path" case) rather than a "successful" path this
  // geometry cannot actually build without overlap.
  const canEnter = (from, to) => {
    if (to.rank === toPos.rank && to.col === toPos.col) {
      return from.rank === toPos.rank - 1 && from.col === toPos.col;
    }
    return true;
  };

  const goalKey = key(toPos);
  const queue = [fromPos];
  const cameFrom = new Map([[key(fromPos), null]]);
  while (queue.length) {
    const current = queue.shift();
    const currentKey = key(current);
    if (currentKey === goalKey) {
      const path = [];
      let step = currentKey;
      while (step !== null) {
        const [rank, col] = step.split(',').map(Number);
        path.unshift({ rank, col });
        step = cameFrom.get(step);
      }
      return path;
    }
    const neighbors = [
      { rank: current.rank - 1, col: current.col },
      { rank: current.rank + 1, col: current.col },
      { rank: current.rank, col: current.col - 1 },
      { rank: current.rank, col: current.col + 1 },
    ];
    for (const next of neighbors) {
      if (!inBounds(next)) continue;
      const nextKey = key(next);
      if (cameFrom.has(nextKey)) continue;
      if (isBlocked(next)) continue;
      if (!canEnter(current, next)) continue;
      cameFrom.set(nextKey, currentKey);
      queue.push(next);
    }
  }
  return null;
}
```

**Note for the implementer:** `INITIAL_GX`/`COLUMN_STRIDE`/`ROW_STRIDE` already exist in this file — import/reference them, do not redefine. This task adds no Foundry-facing behavior at all; it's pure graph search, safe to implement and test in complete isolation from everything else in this plan.

**Fix-round addendum (applies when this task is reopened for the #174
target-approach-direction gap):** add a test asserting that when `toPos`'s
own north-neighbor cell (`{rank: toPos.rank - 1, col: toPos.col}`) is
occupied by a room other than `fromRoomId`/`toRoomId`, `findCorridorPath`
returns `null` even though a longer BFS route into `toPos` from the east,
west, or south would otherwise exist (construct `occupiedCells` with that
north-neighbor cell occupied and a free lateral route into `toPos` from
another side — the pre-fix code would have returned that lateral path;
the fixed code must return `null`). Also add a test confirming a normal
detour that re-converges on `toPos`'s own column (obstacle blocking the
direct route, but `toPos`'s immediate north neighbor free) still finds a
path and that path's last two entries are `[{rank: toPos.rank - 1, col:
toPos.col}, toPos]`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/dungeon-layout.test.mjs -t "cellBounds|findCorridorPath"`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add scripts/dungeon-layout.mjs tests/dungeon-layout.test.mjs
git commit -m "feat: add cellBounds and findCorridorPath grid pathfinding"
```

---

## Task 2: Room-cell margin containment walls

**Files:**
- Modify: `scripts/dungeon-layout.mjs`
- Test: `tests/dungeon-layout.test.mjs`

**Interfaces:**
- Consumes: `cellBounds` (Task 1), `roomSidesForRect` (existing).
- Produces: `cellMarginWalls(rect, rank, col, { openSide = null, openOffset = 0, openWidth = 0 } = {})` → array of `{dir, x1, y1, x2, y2}` wall segments (exported new) sealing the room's cell margin beyond its own rect. `openSide` (`'east'` or `'south'`, or `null`) names which one of those two sides has a corridor's own connection routed through the margin on that side; `openOffset`/`openWidth` (grid units, measured from the cell's own top-left corner along that side) leave a gap in the cell-boundary wall exactly where that connection's own strip crosses it — everywhere else on that side stays a solid wall. When `openSide` is `null` (or doesn't match a side that actually has margin), that side's margin — if any — is sealed with one full-length wall.

- [ ] **Step 1: Write the failing tests**

```js
import { cellMarginWalls, cellBounds, COLUMN_STRIDE, ROW_STRIDE, ROOM_SIZE_SMALL, ROOM_SIZE_LARGE } from '../scripts/dungeon-layout.mjs';

describe('cellMarginWalls', () => {
  it('produces no walls for a ROOM_SIZE_LARGE room (no margin on either side)', () => {
    const rect = { gx: 300, gy: 0, gw: ROOM_SIZE_LARGE, gh: ROOM_SIZE_LARGE };
    expect(cellMarginWalls(rect, 0, 0)).toEqual([]);
  });

  it('seals both the east and south margin for a small room with no open connection', () => {
    const rect = { gx: 300, gy: 0, gw: ROOM_SIZE_SMALL, gh: ROOM_SIZE_SMALL };
    const walls = cellMarginWalls(rect, 0, 0);
    const east = walls.find((w) => w.dir === 'east');
    const south = walls.find((w) => w.dir === 'south');
    expect(east).toEqual({ dir: 'east', x1: 300 + COLUMN_STRIDE, y1: 0, x2: 300 + COLUMN_STRIDE, y2: ROW_STRIDE });
    expect(south).toEqual({ dir: 'south', x1: 300, y1: ROW_STRIDE, x2: 300 + COLUMN_STRIDE, y2: ROW_STRIDE });
  });

  it('leaves a gap in the east margin wall where a connection crosses it', () => {
    const rect = { gx: 300, gy: 0, gw: ROOM_SIZE_SMALL, gh: ROOM_SIZE_SMALL };
    const walls = cellMarginWalls(rect, 0, 0, { openSide: 'east', openOffset: 4, openWidth: 2 });
    const eastWalls = walls.filter((w) => w.dir === 'east');
    // Two remaining solid segments flanking the gap, never spanning across it.
    expect(eastWalls.length).toBe(2);
    for (const w of eastWalls) {
      expect(w.y2 <= 4 || w.y1 >= 6).toBe(true);
    }
  });

  it('omits a flanking segment entirely when the gap reaches a cell corner', () => {
    const rect = { gx: 300, gy: 0, gw: ROOM_SIZE_SMALL, gh: ROOM_SIZE_SMALL };
    const walls = cellMarginWalls(rect, 0, 0, { openSide: 'south', openOffset: 0, openWidth: ROOM_SIZE_SMALL });
    const southWalls = walls.filter((w) => w.dir === 'south');
    expect(southWalls.length).toBe(1); // only the segment from the gap's end to the cell's far corner
  });

  it('containment sweep: cellMarginWalls seals the full cell boundary except exactly at the declared opening, across many size/connection combinations', () => {
    // cellMarginWalls' own wall segments sit at the CELL's outer
    // boundary — a different (further out) x/y position than
    // roomEnclosureWalls' own room-rect walls whenever the room is
    // smaller than its cell, so the two wall sets are parallel, not
    // continuous, and are verified separately: roomEnclosureWalls' own
    // no-gap invariant is already covered by its own existing tests
    // (Task 5, #93); this sweep is cellMarginWalls' own equivalent,
    // checked across the realistic size/opening combination space rather
    // than the single hand-picked case each earlier test in this file
    // already covers. (The full room+margin containment, as one
    // continuous seal a token can't slip through, is verified live —
    // Task 5's own manual checklist — since only a real built scene's
    // wall documents share one true coordinate system to check for gaps
    // in.)
    function sideFullyAccountedFor(dir, cell, wallsOnThatSide, openStart, openEnd) {
      const full = dir === 'east' ? cell.gh : cell.gw;
      for (let unit = 0; unit < full; unit += 1) {
        const inOpening = openStart >= 0 && unit >= openStart && unit < openEnd;
        const covered = wallsOnThatSide.some((w) => {
          const lo = dir === 'east' ? w.y1 - cell.gy : w.x1 - cell.gx;
          const hi = dir === 'east' ? w.y2 - cell.gy : w.x2 - cell.gx;
          return unit >= Math.min(lo, hi) && unit < Math.max(lo, hi);
        });
        if (inOpening === covered) return false; // open-but-walled, or closed-but-gapped — either is wrong
      }
      return true;
    }

    for (const roomSize of [ROOM_SIZE_SMALL, ROOM_SIZE_LARGE]) {
      for (const opening of [
        {},
        { openSide: 'east', openOffset: 2, openWidth: 2 },
        { openSide: 'south', openOffset: 0, openWidth: 3 },
      ]) {
        const rank = 1;
        const col = 1;
        const rect = { gx: 300 + col * COLUMN_STRIDE, gy: rank * ROW_STRIDE, gw: roomSize, gh: roomSize };
        const margin = cellMarginWalls(rect, rank, col, opening);
        const cell = cellBounds(rank, col);
        for (const dir of ['east', 'south']) {
          const hasMargin = dir === 'east' ? roomSize < cell.gw : roomSize < cell.gh;
          if (!hasMargin) continue; // ROOM_SIZE_LARGE: nothing to check, already covered by the no-walls-at-all test
          const wallsOnSide = margin.filter((w) => w.dir === dir);
          const isOpenSide = opening.openSide === dir;
          const openStart = isOpenSide ? opening.openOffset : -1;
          const openEnd = isOpenSide ? opening.openOffset + opening.openWidth : -1;
          expect(sideFullyAccountedFor(dir, cell, wallsOnSide, openStart, openEnd)).toBe(true);
        }
      }
    }
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/dungeon-layout.test.mjs -t cellMarginWalls`
Expected: FAIL (`cellMarginWalls` not exported yet)

- [ ] **Step 3: Write minimal implementation**

```js
/**
 * Seals a room's grid-cell margin beyond its own rect — the space between
 * a (possibly smaller) room and the full COLUMN_STRIDE x ROW_STRIDE cell
 * it's allotted. A room always anchors at its cell's own top-left corner
 * (roomRect), so its north and west edges always coincide with the
 * cell's own north/west edges — only east and south can ever have
 * margin, regardless of room size. The room's OWN east/south walls
 * (roomEnclosureWalls, unchanged) already seal the room's interior from
 * this margin whenever those faces aren't used for an outgoing
 * connection; this function seals the OUTER edge of the margin (the
 * cell's own east/south boundary), so the margin becomes fully enclosed
 * dead space rather than open void — see the design's own reasoning for
 * why only two walls are needed to close an L-shaped region.
 */
export function cellMarginWalls(rect, rank, col, { openSide = null, openOffset = 0, openWidth = 0 } = {}) {
  const cell = cellBounds(rank, col);
  const walls = [];

  const sealSide = (dir, hasMargin, along) => {
    if (!hasMargin) return;
    if (openSide !== dir) {
      walls.push(along(cell.gx, cell.gy, cell.gx + cell.gw, cell.gy + cell.gh));
      return;
    }
    const gapStart = openOffset;
    const gapEnd = openOffset + openWidth;
    const full = dir === 'east' ? cell.gh : cell.gw;
    if (gapStart > 0) walls.push(along(cell.gx, cell.gy, cell.gx + cell.gw, cell.gy + cell.gh, 0, gapStart));
    if (gapEnd < full) walls.push(along(cell.gx, cell.gy, cell.gx + cell.gw, cell.gy + cell.gh, gapEnd, full));
  };

  const eastLine = (cgx, cgy, cgx2, cgy2, from = 0, to = cgy2 - cgy) =>
    ({ dir: 'east', x1: cgx2, y1: cgy + from, x2: cgx2, y2: cgy + to });
  const southLine = (cgx, cgy, cgx2, cgy2, from = 0, to = cgx2 - cgx) =>
    ({ dir: 'south', x1: cgx + from, y1: cgy2, x2: cgx + to, y2: cgy2 });

  sealSide('east', rect.gw < cell.gw, eastLine);
  sealSide('south', rect.gh < cell.gh, southLine);

  return walls;
}
```

**Note for the implementer:** `cellBounds` is Task 1's own function. `roomRect`/`ROOM_SIZE_SMALL`/`ROOM_SIZE_LARGE`/`COLUMN_STRIDE`/`ROW_STRIDE` already exist in this file. This function does NOT get wired into `buildRoomAtGraphNode` yet — that's Task 5, once the corridor-routing side (Tasks 3-4) also exists and can supply real `openSide`/`openOffset`/`openWidth` values. For this task, test it in isolation with hand-picked offsets.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/dungeon-layout.test.mjs -t cellMarginWalls`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add scripts/dungeon-layout.mjs tests/dungeon-layout.test.mjs
git commit -m "feat: add cellMarginWalls to seal a room's unused grid-cell margin"
```

---

## Task 3: Transit-cell crossing geometry

**Files:**
- Modify: `scripts/dungeon-layout.mjs`
- Test: `tests/dungeon-layout.test.mjs`

**Interfaces:**
- Consumes: `cellBounds` (Task 1).
- Produces: `transitCellCrossing(seed, rank, col, entrySide, exitSide, edgeId)` → `{ entryPoint, exitPoint, plainWalls, corridorSegments }` (exported new) — the geometry for ONE empty cell a corridor path crosses through: a straight or single-corner path from a pseudo-random point on `entrySide` to a pseudo-random point on `exitSide` (same seeded-offset convention as `doorOffsetAt`), the corridor floor-tile segment(s) along that path, and the flanking `plainWalls` containing the strip within the cell. `entrySide`/`exitSide` are compass directions (`'north'|'south'|'east'|'west'`); when they're opposite (a straight-through cell) the path is a single segment, when adjacent (a turn) it's an L-shaped 2-segment path — reusing the exact same straight/corner logic `buildEdgeCorridor` already has today, just scoped to one cell instead of the whole source-to-target span.

- [ ] **Step 1: Write the failing tests**

```js
import { transitCellCrossing, cellBounds, ROW_STRIDE, COLUMN_STRIDE } from '../scripts/dungeon-layout.mjs';

describe('transitCellCrossing', () => {
  it('draws a single straight segment for a north-to-south (opposite sides) crossing', () => {
    const result = transitCellCrossing('seed1', 1, 0, 'north', 'south', 'a->b');
    expect(result.corridorSegments).toHaveLength(1);
    expect(result.entryPoint.y).toBe(cellBounds(1, 0).gy);
    expect(result.exitPoint.y).toBe(cellBounds(1, 0).gy + ROW_STRIDE);
    // The straight segment never leaves this cell's own bounds.
    const cell = cellBounds(1, 0);
    for (const seg of result.corridorSegments) {
      expect(seg.gx).toBeGreaterThanOrEqual(cell.gx);
      expect(seg.gx + seg.gw).toBeLessThanOrEqual(cell.gx + cell.gw);
      expect(seg.gy).toBeGreaterThanOrEqual(cell.gy);
      expect(seg.gy + seg.gh).toBeLessThanOrEqual(cell.gy + cell.gh);
    }
  });

  it('draws an L-shaped 2-segment path for a north-to-east (adjacent sides) crossing, staying inside the cell', () => {
    const result = transitCellCrossing('seed1', 0, 0, 'north', 'east', 'a->b');
    expect(result.corridorSegments.length).toBeGreaterThanOrEqual(1);
    const cell = cellBounds(0, 0);
    for (const seg of result.corridorSegments) {
      expect(seg.gx).toBeGreaterThanOrEqual(cell.gx);
      expect(seg.gx + seg.gw).toBeLessThanOrEqual(cell.gx + cell.gw);
      expect(seg.gy).toBeGreaterThanOrEqual(cell.gy);
      expect(seg.gy + seg.gh).toBeLessThanOrEqual(cell.gy + cell.gh);
    }
  });

  it('is deterministic for a given seed, rank, col, and edgeId', () => {
    const a = transitCellCrossing('seed1', 2, 1, 'west', 'east', 'x->y');
    const b = transitCellCrossing('seed1', 2, 1, 'west', 'east', 'x->y');
    expect(b).toEqual(a);
  });

  it('produces a different offset for a different edgeId crossing the same cell', () => {
    const a = transitCellCrossing('seed1', 2, 1, 'west', 'east', 'x->y');
    const b = transitCellCrossing('seed1', 2, 1, 'west', 'east', 'p->q');
    expect(b.entryPoint).not.toEqual(a.entryPoint);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/dungeon-layout.test.mjs -t transitCellCrossing`
Expected: FAIL (`transitCellCrossing` not exported yet)

- [ ] **Step 3: Write minimal implementation**

```js
const SIDE_POINT = {
  north: (cell, offset) => ({ x: cell.gx + offset, y: cell.gy }),
  south: (cell, offset) => ({ x: cell.gx + offset, y: cell.gy + cell.gh }),
  west: (cell, offset) => ({ x: cell.gx, y: cell.gy + offset }),
  east: (cell, offset) => ({ x: cell.gx + cell.gw, y: cell.gy + offset }),
};
const SIDE_SPAN = { north: 'gw', south: 'gw', west: 'gh', east: 'gh' };

/**
 * Geometry for one EMPTY cell a corridor path crosses through — a
 * pseudo-random point on entrySide to a pseudo-random point on exitSide
 * (same seeded-offset convention as doorOffsetAt/buildEdgeCorridor),
 * connected by a straight segment (opposite sides) or a single-corner
 * L-shape (adjacent sides), always staying inside this one cell's own
 * bounds. `edgeId` (e.g. `${fromRoomId}->${toRoomId}`) salts the offset
 * so two different edges crossing the same cell get independently
 * randomized entry/exit points, not identical ones.
 */
const OPPOSITE_SIDE = { north: 'south', south: 'north', east: 'west', west: 'east' };

export function transitCellCrossing(seed, rank, col, entrySide, exitSide, edgeId) {
  const cell = cellBounds(rank, col);
  const entryOffset = doorOffsetAt(seed, `transit-${rank}-${col}-${entrySide}-${edgeId}`, 'incoming', cell[SIDE_SPAN[entrySide]]);
  const exitOffset = doorOffsetAt(seed, `transit-${rank}-${col}-${exitSide}-${edgeId}`, 'outgoing', cell[SIDE_SPAN[exitSide]]);
  const entryPoint = SIDE_POINT[entrySide](cell, entryOffset);
  const exitPoint = SIDE_POINT[exitSide](cell, exitOffset);

  const corridorSegments = [];
  const plainWalls = [];

  // #174 fix round 1 (found by this task's own review): straight-vs-turn
  // MUST be decided from entrySide/exitSide directly, never from
  // coincidental coordinate equality — entry/exit offsets are two
  // INDEPENDENTLY seeded doorOffsetAt draws, so even genuinely-opposite
  // sides essentially never produce equal coordinates by chance. An
  // earlier draft of this function checked
  // `entryPoint.x === exitPoint.x || entryPoint.y === exitPoint.y`,
  // which made the straight branch almost unreachable.
  if (OPPOSITE_SIDE[entrySide] === exitSide) {
    // Straight through — one segment, entry to exit directly.
    corridorSegments.push({
      gx: Math.min(entryPoint.x, exitPoint.x),
      gy: Math.min(entryPoint.y, exitPoint.y),
      gw: Math.max(CORRIDOR_LEN, Math.abs(exitPoint.x - entryPoint.x)),
      gh: Math.max(CORRIDOR_LEN, Math.abs(exitPoint.y - entryPoint.y)),
    });
  } else {
    // Adjacent sides — one corner, inside this cell. `corner` shares
    // entryPoint's own x and exitPoint's own y BY CONSTRUCTION, which
    // means segment 1 (entryPoint -> corner) is ALWAYS the vertical leg
    // (constant x) and segment 2 (corner -> exitPoint) is ALWAYS the
    // horizontal leg (constant y), regardless of which two sides are
    // actually in play — #174 fix round 1 (found by this task's own
    // review): an earlier draft assigned segment 1's `gw`/`gh` and
    // segment 2's `gw`/`gh` as though the VARIABLE dimension could be
    // either one, computing a `gw` that always evaluates to 0 for
    // segment 1 and a `gh` that always evaluates to 0 for segment 2 —
    // collapsing both legs into disconnected 1x1 stubs that never
    // actually reach the corner.
    const corner = { x: entryPoint.x, y: exitPoint.y };

    // #174 fix round 1 (found by this task's own review, a SECOND bug
    // beyond the one above): the fixed-CORRIDOR_LEN dimension must
    // extend INWARD from whichever point anchors it, not always in the
    // same (positive) direction — entryPoint.x sits at the cell's own
    // FAR east edge exactly when entrySide is 'east' (SIDE_POINT.east
    // uses `cell.gx + cell.gw`), and extending the segment's width
    // rightward from a far-edge point overflows past the cell entirely,
    // into the next column's own cell. Same reasoning for exitPoint.y
    // and 'south' (SIDE_POINT.south uses `cell.gy + cell.gh`). Every
    // other side (west/north, or north/south/east/west used in the
    // MIDDLE of a room's own face rather than as this leg's anchor) sits
    // at the cell's own near edge or somewhere in the interior, where
    // extending in the positive direction never leaves the cell (bounded
    // by doorOffsetAt's own maxOffset, which never lets an offset run
    // past `cell's own span - DOOR_WIDTH`).
    const seg1X = entrySide === 'east' ? entryPoint.x - CORRIDOR_LEN : entryPoint.x;
    const seg2Y = exitSide === 'south' ? exitPoint.y - CORRIDOR_LEN : exitPoint.y;

    corridorSegments.push({
      gx: seg1X, gy: Math.min(entryPoint.y, corner.y),
      gw: CORRIDOR_LEN, gh: Math.max(CORRIDOR_LEN, Math.abs(corner.y - entryPoint.y)),
    });
    corridorSegments.push({
      gx: Math.min(corner.x, exitPoint.x), gy: seg2Y,
      gw: Math.max(CORRIDOR_LEN, Math.abs(exitPoint.x - corner.x)), gh: CORRIDOR_LEN,
    });
  }

  return { entryPoint, exitPoint, plainWalls, corridorSegments };
}
```

**Note for the implementer:** `doorOffsetAt`, `cellBounds` (Task 1), `CORRIDOR_LEN` already exist. `plainWalls` is intentionally returned empty here — the flanking walls containing the corridor strip within this cell, and the cell's own outer-boundary containment (this cell's four sides minus the entry/exit gaps), are Task 4/5's job once this cell's crossing is placed within the context of the room-graph's actual containment walls; this task only produces the corridor's own travel-path geometry. Add a test sweeping all 8 valid adjacent-side pairings (north/east, north/west, south/east, south/west, east/north, east/south, west/north, west/south) asserting every returned segment stays within `cellBounds(rank, col)` — the two bugs already documented above were each found by exactly one hand-picked pairing failing in a way the OTHER 7 pairings didn't expose; a full sweep is what actually closes this class of risk, not another single example.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/dungeon-layout.test.mjs -t transitCellCrossing`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add scripts/dungeon-layout.mjs tests/dungeon-layout.test.mjs
git commit -m "feat: add transitCellCrossing geometry for empty cells a corridor path crosses"
```

---

## Task 4: Rework `buildEdgeCorridor` to walk a multi-cell path

**Files:**
- Modify: `scripts/dungeon-layout.mjs`
- Test: `tests/dungeon-layout.test.mjs`

**Interfaces:**
- Consumes: `findCorridorPath` (Task 1), `transitCellCrossing` (Task 3), `doorOffsetAt`/`northDoorSlots`/`roomSidesForRect` (existing, unchanged).
- Produces: `buildEdgeCorridor` (existing name, new signature): `buildEdgeCorridor(seed, fromRoomId, toRoomId, fromRect, toRect, fromPos, toPos, exitFace, toSlot, occupiedCells)` → `{ doorWall, revealDoorWall, plainWalls, corridorSegments, transitCells }`. `fromPos`/`toPos` are the two rooms' own `{rank, col}` (new params — needed to pathfind). `transitCells` is a new array of `{ rank, col, entrySide, exitSide, plainWalls, corridorSegments }`, one entry per intermediate cell the path crosses (empty when source and target are directly adjacent, today's common case) — the caller (Task 5) builds each one's actual wall/tile documents.

- [ ] **Step 1: Write the failing tests**

```js
import { buildEdgeCorridor } from '../scripts/dungeon-layout.mjs';

describe('buildEdgeCorridor (multi-cell path)', () => {
  it('matches today\'s direct behavior when source and target are adjacent (no transit cells)', () => {
    const fromRect = { gx: 300, gy: 0, gw: 12, gh: 12 };
    const toRect = { gx: 300, gy: 13, gw: 12, gh: 12 };
    const toSlot = { x1: 300, y1: 13, x2: 312, y2: 13 };
    const result = buildEdgeCorridor(
      'seed1', 'a', 'b', fromRect, toRect, { rank: 0, col: 0 }, { rank: 1, col: 0 },
      'south', toSlot, {},
    );
    expect(result.transitCells).toEqual([]);
    expect(result.doorWall).toBeDefined();
    expect(result.revealDoorWall).toBeDefined();
  });

  it('produces one transitCells entry per intermediate cell when routing around an obstacle', () => {
    const fromRect = { gx: 300, gy: 0, gw: 12, gh: 12 };
    const toRect = { gx: 300, gy: 26, gw: 12, gh: 12 }; // rank 2
    const toSlot = { x1: 300, y1: 26, x2: 312, y2: 26 };
    const occupiedCells = { '1,0': 'blocker' };
    const result = buildEdgeCorridor(
      'seed1', 'a', 'b', fromRect, toRect, { rank: 0, col: 0 }, { rank: 2, col: 0 },
      'south', toSlot, occupiedCells,
    );
    expect(result.transitCells.length).toBeGreaterThan(0);
    expect(result.transitCells.every((c) => `${c.rank},${c.col}` !== '1,0')).toBe(true);
  });

  it('two different edges crossing the same intermediate cell get geometrically distinct, non-conflicting crossings (Review Focus)', () => {
    // The actual wall-merging/idempotency check (skip vs. add-only-the-
    // new-opening) is Foundry-glue code in dungeon-scene.mjs, verified
    // live per Task 5's own manual checklist item (e) — this test pins
    // the piece buildEdgeCorridor itself is responsible for: that two
    // edges sharing a transit cell never get IDENTICAL geometry (which
    // would make "already built, skip" and "needs its own new opening"
    // indistinguishable), because each edge's own edgeId salts the
    // crossing's offset independently (see transitCellCrossing, Task 3).
    const fromRectA = { gx: 300, gy: 0, gw: 12, gh: 12 };
    const toRectA = { gx: 300, gy: 26, gw: 12, gh: 12 };
    const toSlotA = { x1: 300, y1: 26, x2: 312, y2: 26 };
    const occupiedCells = { '1,0': 'blocker' };
    const resultA = buildEdgeCorridor(
      'seed1', 'a', 'b', fromRectA, toRectA, { rank: 0, col: 0 }, { rank: 2, col: 0 },
      'south', toSlotA, occupiedCells,
    );

    const fromRectC = { gx: 300 + 13, gy: 0, gw: 12, gh: 12 };
    const toRectC = { gx: 300 + 13, gy: 26, gw: 12, gh: 12 };
    const toSlotC = { x1: 300 + 13, y1: 26, x2: 300 + 13 + 12, y2: 26 };
    const resultC = buildEdgeCorridor(
      'seed1', 'c', 'd', fromRectC, toRectC, { rank: 0, col: 1 }, { rank: 2, col: 1 },
      'south', toSlotC, occupiedCells,
    );

    // Both detour through rank 1 (col 0 blocked, but A and C are in
    // different columns so they don't actually share a cell here — this
    // is the control case, confirming two INDEPENDENT edges each get
    // their own transitCells at all).
    expect(resultA.transitCells.length).toBeGreaterThan(0);
    expect(resultC.transitCells.length).toBeGreaterThan(0);

    // Now force both to cross the SAME cell (1,0) by routing C's own
    // endpoints through col 0 too, with a DIFFERENT edgeId (fromRoomId/
    // toRoomId pair) than A's.
    const resultD = buildEdgeCorridor(
      'seed1', 'e', 'f', fromRectA, toRectA, { rank: 0, col: 0 }, { rank: 2, col: 0 },
      'south', toSlotA, occupiedCells,
    );
    expect(resultD.transitCells).toHaveLength(resultA.transitCells.length);
    const sameCells = resultD.transitCells.every((c, i) =>
      c.rank === resultA.transitCells[i].rank && c.col === resultA.transitCells[i].col,
    );
    expect(sameCells).toBe(true); // same cell(s) crossed...
    const identicalGeometry = resultD.transitCells.every((c, i) =>
      c.entryPoint.x === resultA.transitCells[i].entryPoint.x &&
      c.entryPoint.y === resultA.transitCells[i].entryPoint.y,
    );
    expect(identicalGeometry).toBe(false); // ...but a distinct crossing point, since edgeId differs
  });

  it('falls back to a direct line when findCorridorPath finds no route', () => {
    const fromRect = { gx: 300, gy: 0, gw: 12, gh: 12 };
    const toRect = { gx: 300, gy: 26, gw: 12, gh: 12 };
    const toSlot = { x1: 300, y1: 26, x2: 312, y2: 26 };
    const occupiedCells = {
      '1,0': 'x', '1,1': 'x', '1,-1': 'x', '1,2': 'x', '1,-2': 'x',
      '0,1': 'x', '0,-1': 'x', '0,2': 'x', '0,-2': 'x',
      '2,1': 'x', '2,-1': 'x', '2,2': 'x', '2,-2': 'x',
    };
    const result = buildEdgeCorridor(
      'seed1', 'a', 'b', fromRect, toRect, { rank: 0, col: 0 }, { rank: 2, col: 0 },
      'south', toSlot, occupiedCells,
    );
    expect(result.transitCells).toEqual([]);
    expect(result.doorWall).toBeDefined();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/dungeon-layout.test.mjs -t "buildEdgeCorridor \(multi-cell"`
Expected: FAIL (old signature/behavior)

- [ ] **Step 3: Write minimal implementation**

Replace `buildEdgeCorridor`'s body. The existing same-column/different-column straight/L-shaped logic (below, copied verbatim from the current file) becomes the `path.length <= 2` branch — completely unchanged behavior for the adjacent case (Review Focus: this must not regress the edges that were already routing correctly). A new branch handles a longer path by chaining `transitCellCrossing` (Task 3) across every intermediate cell, then connecting the first/last transit cell to the source/target exactly the way the endpoints connect to each other today:

```js
export function buildEdgeCorridor(seed, fromRoomId, toRoomId, fromRect, toRect, fromPos, toPos, exitFace, toSlot, occupiedCells) {
  const path = findCorridorPath(fromPos, toPos, occupiedCells, { fromRoomId, toRoomId });
  const slotWidth = toSlot.x2 - toSlot.x1;
  const outgoingOffset = doorOffsetAt(seed, `${fromRoomId}-${exitFace}`, 'outgoing', fromRect.gw);
  const incomingOffset = doorOffsetAt(seed, `${toRoomId}-north-${toSlot.x1}`, 'incoming', slotWidth);

  if (!path || path.length <= 2) {
    // Adjacent (or no-path fallback to today's direct line) — UNCHANGED
    // from before this task, verbatim, just with transitCells: [] added.
    const sameColumn = fromRect.gx === toRect.gx;
    if (exitFace === 'south' && sameColumn) {
      const faceY = fromRect.gy + fromRect.gh;
      const corridorEndY = toRect.gy;
      const doorX0 = fromRect.gx + outgoingOffset;
      const doorX1 = doorX0 + DOOR_WIDTH;
      const gapX0 = toSlot.x1 + incomingOffset;
      const gapX1 = gapX0 + DOOR_WIDTH;
      const spanX0 = Math.min(doorX0, gapX0);
      const spanX1 = Math.max(doorX1, gapX1);
      return {
        doorWall: { x1: doorX0, y1: faceY, x2: doorX1, y2: faceY },
        revealDoorWall: { x1: gapX0, y1: corridorEndY, x2: gapX1, y2: corridorEndY },
        plainWalls: [
          { x1: fromRect.gx, y1: faceY, x2: doorX0, y2: faceY },
          { x1: doorX1, y1: faceY, x2: Math.max(fromRect.gx + fromRect.gw, spanX1), y2: faceY },
          { x1: toSlot.x1, y1: corridorEndY, x2: gapX0, y2: corridorEndY },
          { x1: gapX1, y1: corridorEndY, x2: toSlot.x2, y2: corridorEndY }
        ].filter((w) => w.x1 !== w.x2 || w.y1 !== w.y2),
        corridorSegments: [{ gx: spanX0, gy: faceY, gw: spanX1 - spanX0, gh: corridorEndY - faceY }],
        transitCells: [],
      };
    }

    const exitPoint = exitFace === 'east'
      ? { x: fromRect.gx + fromRect.gw, y: fromRect.gy + fromRect.gh / 2 }
      : exitFace === 'west'
      ? { x: fromRect.gx, y: fromRect.gy + fromRect.gh / 2 }
      : { x: fromRect.gx + fromRect.gw / 2, y: fromRect.gy + fromRect.gh };
    const entryPoint = { x: toSlot.x1 + slotWidth / 2, y: toSlot.y1 };
    const corner = { x: entryPoint.x, y: exitPoint.y };

    const doorWall = exitFace === 'south'
      ? { x1: exitPoint.x - DOOR_WIDTH / 2, y1: exitPoint.y, x2: exitPoint.x + DOOR_WIDTH / 2, y2: exitPoint.y }
      : { x1: exitPoint.x, y1: exitPoint.y - DOOR_WIDTH / 2, x2: exitPoint.x, y2: exitPoint.y + DOOR_WIDTH / 2 };
    const revealDoorWall = { x1: entryPoint.x - DOOR_WIDTH / 2, y1: entryPoint.y, x2: entryPoint.x + DOOR_WIDTH / 2, y2: entryPoint.y };

    const plainWalls = [
      { x1: toSlot.x1, y1: entryPoint.y, x2: entryPoint.x - DOOR_WIDTH / 2, y2: entryPoint.y },
      { x1: entryPoint.x + DOOR_WIDTH / 2, y1: entryPoint.y, x2: toSlot.x2, y2: entryPoint.y },
    ].filter((w) => w.x1 !== w.x2 || w.y1 !== w.y2);

    return {
      doorWall,
      revealDoorWall,
      plainWalls,
      corridorSegments: [
        { gx: Math.min(exitPoint.x, corner.x), gy: Math.min(exitPoint.y, corner.y), gw: Math.max(CORRIDOR_LEN, Math.abs(corner.x - exitPoint.x)), gh: CORRIDOR_LEN },
        { gx: Math.min(corner.x, entryPoint.x), gy: Math.min(corner.y, entryPoint.y), gw: CORRIDOR_LEN, gh: Math.max(CORRIDOR_LEN, Math.abs(entryPoint.y - corner.y)) }
      ],
      transitCells: [],
    };
  }

  // Multi-cell path: chain transitCellCrossing across every intermediate
  // cell, then connect fromRect's own exit point to the first transit
  // cell's entry point, and the last transit cell's exit point to
  // toRect's own entry point, with a plain straight segment each (no
  // corner needed at the endpoints themselves — the corner-if-needed
  // logic lives inside each transit cell's own crossing, Task 3).
  const edgeId = `${fromRoomId}->${toRoomId}`;
  const transitCells = [];
  for (let i = 1; i < path.length - 1; i += 1) {
    const cell = path[i];
    const entrySide = directionBetween(cell, path[i - 1]);
    const exitSide = directionBetween(cell, path[i + 1]);
    const crossing = transitCellCrossing(seed, cell.rank, cell.col, entrySide, exitSide, edgeId);
    transitCells.push({ rank: cell.rank, col: cell.col, entrySide, exitSide, ...crossing });
  }

  const exitPoint = exitFace === 'east'
    ? { x: fromRect.gx + fromRect.gw, y: fromRect.gy + fromRect.gh / 2 }
    : exitFace === 'west'
    ? { x: fromRect.gx, y: fromRect.gy + fromRect.gh / 2 }
    : { x: fromRect.gx + fromRect.gw / 2, y: fromRect.gy + fromRect.gh };
  const doorWall = exitFace === 'south'
    ? { x1: exitPoint.x - DOOR_WIDTH / 2, y1: exitPoint.y, x2: exitPoint.x + DOOR_WIDTH / 2, y2: exitPoint.y }
    : { x1: exitPoint.x, y1: exitPoint.y - DOOR_WIDTH / 2, x2: exitPoint.x, y2: exitPoint.y + DOOR_WIDTH / 2 };
  const entryPoint = { x: toSlot.x1 + slotWidth / 2, y: toSlot.y1 };
  const revealDoorWall = { x1: entryPoint.x - DOOR_WIDTH / 2, y1: entryPoint.y, x2: entryPoint.x + DOOR_WIDTH / 2, y2: entryPoint.y };

  const firstCellPoint = transitCells[0].entryPoint;
  const lastCellPoint = transitCells[transitCells.length - 1].exitPoint;
  const corridorSegments = [
    { gx: Math.min(exitPoint.x, firstCellPoint.x), gy: Math.min(exitPoint.y, firstCellPoint.y), gw: Math.max(CORRIDOR_LEN, Math.abs(firstCellPoint.x - exitPoint.x)), gh: Math.max(CORRIDOR_LEN, Math.abs(firstCellPoint.y - exitPoint.y)) },
    { gx: Math.min(lastCellPoint.x, entryPoint.x), gy: Math.min(lastCellPoint.y, entryPoint.y), gw: Math.max(CORRIDOR_LEN, Math.abs(entryPoint.x - lastCellPoint.x)), gh: Math.max(CORRIDOR_LEN, Math.abs(entryPoint.y - lastCellPoint.y)) },
  ];
  const plainWalls = [
    { x1: toSlot.x1, y1: entryPoint.y, x2: entryPoint.x - DOOR_WIDTH / 2, y2: entryPoint.y },
    { x1: entryPoint.x + DOOR_WIDTH / 2, y1: entryPoint.y, x2: toSlot.x2, y2: entryPoint.y },
  ].filter((w) => w.x1 !== w.x2 || w.y1 !== w.y2);

  return { doorWall, revealDoorWall, plainWalls, corridorSegments, transitCells };
}

/** Which compass direction `from` a cell faces to reach an
 * orthogonally-adjacent `to` cell — 'north' if to is one rank up, etc. */
function directionBetween(from, to) {
  if (to.rank < from.rank) return 'north';
  if (to.rank > from.rank) return 'south';
  if (to.col < from.col) return 'west';
  return 'east';
}
```

**Note for the implementer:** `DOOR_WIDTH`, `CORRIDOR_LEN`, `doorOffsetAt` already exist in this file. Every caller of `buildEdgeCorridor` changes (two new params, `fromPos`/`toPos`, before `exitFace`, plus `occupiedCells` at the end, and a new `transitCells` field in the return value) — this task only changes the function itself; its one caller (`dungeon-scene.mjs`) is Task 5. If the multi-cell branch's endpoint-connecting segments (`corridorSegments` in that branch) don't line up cleanly with `transitCellCrossing`'s own entry/exit points for every side combination during your own TDD work, fix the geometry and add the missing test case to Task 6's own regression sweep — same expectation as Task 3.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/dungeon-layout.test.mjs -t "buildEdgeCorridor \(multi-cell"`
Expected: PASS. Also run the full `buildEdgeCorridor` describe block from earlier tasks (#93's own Task 6 tests) and fix any that broke from the signature change (add the new `fromPos`/`toPos`/`occupiedCells` args to their call sites — passing `{}` for `occupiedCells` and adjacent rank/col values reproduces today's exact behavior for those tests).

- [ ] **Step 5: Commit**

```bash
git add scripts/dungeon-layout.mjs tests/dungeon-layout.test.mjs
git commit -m "feat: rework buildEdgeCorridor to route around occupied cells"
```

---

## Task 5: Wire pathfinding, routing, and containment into `dungeon-scene.mjs`

**Files:**
- Modify: `scripts/dungeon-scene.mjs`
- Test: manual/live verification (same Foundry-glue boundary as the rest of this codebase's wall/tile-building code).

**Interfaces:**
- Consumes: `cellMarginWalls` (Task 2), `buildEdgeCorridor`'s new signature (Task 4), `state.layoutPositionByRoomId` (existing).
- Produces: `buildRoomAtGraphNode` now also creates cell-margin containment walls for the room it builds. `buildPopulateAndUnlockGraphNode` derives `occupiedCells` once, passes it and each room's `{rank, col}` into `buildEdgeCorridor`, and builds real Wall/Tile documents for every entry in the returned `transitCells` — idempotently, since two different edges can cross the same empty cell.

- [ ] **Step 1: Write the manual verification checklist**

(a) a small room (`ROOM_SIZE_SMALL`) with an outgoing connection on its south face has its margin sealed on both sides of the corridor's own strip, with no gap except where the corridor itself passes through; (b) a `ROOM_SIZE_LARGE` room's containment walls are a no-op (already confirmed by Task 2's own unit test, but confirm live nothing extra gets built for one); (c) a merge room several ranks below one of its parents gets a corridor that visibly routes around the intervening rooms, not through them; (d) walking the party down a corridor that crosses an empty transit cell shows fully sealed walls on every side except the two openings the corridor itself uses — no visible void, no vision leak past the corridor's own walls; (e) two different edges that happen to route through the same empty transit cell (construct a seed/roomCount where this occurs, or force it via a hand-built test state) both get their own opening, and neither edge's geometry overwrites the other's.

- [ ] **Step 2: (N/A — no automated test for this Foundry-glue file; Task 6 covers the pure-pipeline regression sweep)**

- [ ] **Step 3: Write the implementation**

In `buildRoomAtGraphNode`, after the room's own `roomEnclosureWalls` call, add its cell-margin walls. The `openSide`/`openOffset`/`openWidth` for a room's own outgoing connection (if any) come from the SAME `exitFaceForIndex`/`doorOffsetAt` values already computed for that room's own outgoing door — thread them through rather than recomputing:

```js
// After the existing roomEnclosureWalls(...) call and its wallDoc(...) mapping:
const marginWalls = cellMarginWalls(rect, rank, col, outgoingMarginOpening).map(
  (side) => wallDoc(side, {
    flags: { [MODULE_ID]: { dungeonCellMarginWallForRoom: roomId } },
  }),
);
walls.push(...marginWalls);
```

where `outgoingMarginOpening` is derived from whichever of the room's outgoing faces is `'east'` or `'south'` (if any) and that connection's own `doorOffsetAt`-derived offset/width — computed once per room, since a room's OWN east/south margin opening is fully determined by ITS OWN outgoing connection, decided once when the room is built (unlike a transit cell's opening, which can accumulate across multiple edges built at different times).

In `buildPopulateAndUnlockGraphNode`, derive `occupiedCells` once from `state.layoutPositionByRoomId` (every room id maps to its own `{rank, col}` — invert into `{"rank,col": roomId}`), and pass it plus each connection's own `sourcePos`/`{rank, col}` (already available — `sourcePos = state.layoutPositionByRoomId[sourceId]`, this room's own via the function's own `rank`/`col` params) into `buildEdgeCorridor`. For each entry in the returned `transitCells`, before creating its geometry, check whether that cell already has a marker for the SAME entry/exit side pair (idempotent), and only create the pieces that don't already exist:

```js
for (const cell of corridorResult.transitCells) {
  const marker = `${cell.rank},${cell.col}:${cell.entrySide}-${cell.exitSide}`;
  const alreadyBuilt = scene.walls.some(
    (w) => w.getFlag(MODULE_ID, 'dungeonTransitCellCrossing') === marker,
  );
  if (alreadyBuilt) continue;
  // Build this cell's corridor floor tiles (cell.corridorSegments) and
  // its outer-boundary containment (cellMarginWalls-style sealing on
  // whichever of the cell's four sides this crossing doesn't use),
  // flagging the crossing wall(s) with dungeonTransitCellCrossing: marker
  // so a second edge crossing the SAME cell with a DIFFERENT
  // entry/exit pair builds its own opening instead of skipping this
  // cell as done.
}
```

**Note for the implementer:** this is the integration task — most of the actual geometry logic already exists from Tasks 2-4; this task's own job is deriving `occupiedCells`, threading rank/col through the existing `buildPopulateAndUnlockGraphNode` call chain, and applying the #110 create-before-delete ordering to every new wall exactly as the existing code already does for room/door walls (create new geometry, THEN delete whatever frontier placeholder it supersedes — never the reverse). A transit cell's own containment walls (sealing the two sides its crossing DOESN'T use) follow the same "seal minus the gap" pattern as `cellMarginWalls`, generalized from 2 sides (east/south, room case) to potentially all 4 (a transit cell has no fixed anchor corner the way a room does) — write this as a small transit-cell-specific sealing helper in `dungeon-layout.mjs` if it doesn't cleanly reuse `cellMarginWalls` as-is (a transit cell isn't anchored top-left, so `cellMarginWalls`'s "only east/south have margin" assumption doesn't hold for it — read `cellMarginWalls`'s own Task 2 docblock for why, and generalize accordingly).

- [ ] **Step 4: Live verification**

Run the Step 1 checklist against a real Foundry world.

- [ ] **Step 5: Commit**

```bash
git add scripts/dungeon-scene.mjs
git commit -m "feat: wire cell containment and multi-cell corridor routing into room/corridor building"
```

---

## Task 6: Regression sweep proving the fix

**Files:**
- Modify: `tests/dungeon-layout.test.mjs`

**Interfaces:**
- Consumes: `buildRoomGraph`/`attachHiddenPaths` (`dungeon-deck.mjs`), `computeRanks`/`computeColumns`/`roomRect`/`buildEdgeCorridor` (`dungeon-layout.mjs`), all unchanged in their own outer signatures except `buildEdgeCorridor` (Task 4).
- Produces: no new exports — this task is pure test coverage proving the fix at the whole-pipeline level, the same methodology the original investigation used to find and characterize the bug in the first place.

- [ ] **Step 1: Write the regression sweep**

```js
import { buildRoomGraph, attachHiddenPaths } from '../scripts/dungeon-deck.mjs';
import { computeRanks, computeColumns, roomRect, buildEdgeCorridor, exitFaceForIndex, northDoorSlots } from '../scripts/dungeon-layout.mjs';

function rectsOverlap(a, b) {
  return a.gx < b.gx + b.gw && a.gx + a.gw > b.gx && a.gy < b.gy + b.gh && a.gy + a.gh > b.gy;
}

describe('corridor routing regression sweep (#174)', () => {
  it('no corridor segment overlaps any room footprint other than its own endpoints, across a large seed/roomCount sweep', () => {
    let totalEdges = 0;
    let overlappingEdges = 0;
    for (let i = 0; i < 500; i += 1) {
      const seed = `sweep-${i}`;
      const roomCount = 6 + (i % 15);
      const { rooms, edges } = buildRoomGraph({ seed, roomCount });
      const { layoutEdges } = attachHiddenPaths({ rooms, edges, seed });
      const ranks = computeRanks(layoutEdges, 'room-entry');
      const columns = computeColumns(layoutEdges, ranks, 'room-entry');
      const positionByRoomId = Object.fromEntries(
        Object.keys(rooms).map((id) => [id, { rank: ranks[id], col: columns[id] }]),
      );
      const occupiedCells = Object.fromEntries(
        Object.entries(positionByRoomId).map(([id, pos]) => [`${pos.rank},${pos.col}`, id]),
      );
      // Keyed by room id, not object reference — roomRect is called fresh
      // per edge below, so two calls for the same room id would otherwise
      // produce distinct object instances a `!==` reference check could
      // never actually exclude.
      const rectById = Object.fromEntries(
        Object.keys(rooms).map((id) => [id, roomRect(seed, id, positionByRoomId[id].rank, positionByRoomId[id].col)]),
      );

      for (const [fromId, children] of Object.entries(edges)) {
        for (let idx = 0; idx < children.length; idx += 1) {
          const toId = children[idx];
          totalEdges += 1;
          const fromRect = rectById[fromId];
          const toRect = rectById[toId];
          const toSlot = northDoorSlots(toRect, 1)[0];
          const result = buildEdgeCorridor(
            seed, fromId, toId, fromRect, toRect,
            positionByRoomId[fromId], positionByRoomId[toId],
            exitFaceForIndex(idx), toSlot, occupiedCells,
          );
          const allSegments = [
            ...result.corridorSegments,
            ...result.transitCells.flatMap((c) => c.corridorSegments),
          ];
          const hasOverlap = allSegments.some((seg) =>
            Object.entries(rectById).some(
              ([id, r]) => id !== fromId && id !== toId && rectsOverlap(seg, r),
            ),
          );
          if (hasOverlap) overlappingEdges += 1;
        }
      }
    }
    expect(overlappingEdges).toBe(0);
    expect(totalEdges).toBeGreaterThan(1000); // sanity: the sweep actually exercised real branching
  });
});
```

- [ ] **Step 2: Run the sweep, fix whatever it finds**

Run: `npx vitest run tests/dungeon-layout.test.mjs -t "regression sweep"`
Expected: initially likely FAIL — this test is designed to catch exactly the geometric edge cases Tasks 3-4's own docblocks flagged as needing real TDD iteration (corner-drawing, transit-cell chaining). Fix `transitCellCrossing`/`buildEdgeCorridor` until it passes; do not weaken the assertion. This is the test that actually proves the fix, not just unit coverage of the pieces in isolation.

- [ ] **Step 3: Commit**

```bash
git add tests/dungeon-layout.test.mjs
git commit -m "test: add whole-pipeline regression sweep proving zero corridor/room overlaps (#174)"
```

---

## Task 7: Live verification and final review

**Files:** none (verification-only task)

**Interfaces:** none.

- [ ] **Step 1: Run the full test suite**

Run: `npx vitest run`
Expected: all tests pass, no regressions in files this plan didn't intend to touch.

- [ ] **Step 2: Live-verify the two originally-reported symptoms specifically**

Start a run against a real Foundry world (GM-present or GM-less, either). Confirm, matching the screenshot evidence recorded on #174: (a) AI-controlled party movement stays inside corridors — no wandering into open void at a junction; (b) no vision leaks into unbuilt space outside a room/corridor's own walls, anywhere the party has line of sight down a corridor or across a junction.

- [ ] **Step 3: Fix anything found, one commit per fix**

Same convention as #93's own final review pass — a focused commit per finding, not one giant fixup.

- [ ] **Step 4: Close out**

Update issue #174 with the fix, comment confirming both symptoms are resolved (or, if anything from Step 3 remains, what's still open and why), then follow this repo's PR/automerge/version-bump convention (module.json minor bump — this reopens and meaningfully changes already-shipped generation code, not a routine fix).
