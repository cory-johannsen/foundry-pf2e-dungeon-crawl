# West-Face Feasibility (Unreachable Detour Rooms) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **OPEN QUESTION (blocking, needs the owner's explicit OK on #906 before Task 2 merges).** The owner chose "direction 2":
> stop producing the layout, by not giving the detour a west face it cannot use, or by placing the detour elsewhere. The
> investigation (all numbers measured on `origin/main` at `893acea2`, 500 sweep seeds unless stated) found:
>
> 1. **A face-only fallback does nothing.** In all 12 #877 edges the detour's north neighbour is an unrelated room.
>    That is the only reason `incomingFaceFor` picked west, so a north approach is just as unreachable
>    (`findCorridorPath` returns null for north too). A prototype that falls back to north cleared **0 of 11** seeds
>    in the crossing sweep.
> 2. **"Place it elsewhere" (move the detour to the nearest free column where both of its links route) clears all 12 but
>    regresses the product ratchets.** Every unreachable detour sits on its own child's north gate cell (the child is
>    always a merge room at `(rank+1, 0)`). Moving the detour hands that gate to the child's other parents, and the
>    scene cannot build that convergence (the known gate-held class, #603). Routed pipeline: baseDead 1704 -> 1733,
>    found-dead 171 -> 240, stubs 1466 -> 1480, walls 250 -> 260, reachable rooms 7232 -> 7219, unreachable non-goal
>    209 -> 222, router unresolvable 140 -> 191. Unrouted stubs also exceed routed (1480 > 1466), which is the same
>    failure as the rejected stub-oracle attempt.
> 3. **Dropping the unreachable detour (this plan) clears all 12 and improves nearly every per-layout ratchet**:
>    dead real edges 2556 -> 2481, sealed doors 1294 -> 1218, unreachable rooms 2305 -> 2124, goal-lost dungeons
>    271 -> 245, walls 1270 -> 1145, tiles inside rooms 4676 -> 3922, reseeds 654 -> 499. **The cost is content.**
>    56 of 553 detour rooms (10%) disappear in 51/500 seeds. Shipped dungeons with a secret detour fall 147 -> 128 (the
>    reseed-sweep skew). Because many dungeons are now a different accepted reseed candidate, a few aggregates in the
>    routed pipeline move the wrong way: baseDead 1704 -> 1723, stubs 1466 -> 1495, dead-end rooms 1288 -> 1312,
>    reachable rooms 7232 -> 7225, unreachable non-goal rooms 209 -> 216. Rooms with 2+ live exits rise 1171 -> 1190
>    and walls fall 250 -> 242.
>
> Dropping a secret room is a product decision. The executor must get the owner's approval on #906 before merging Task
> 2, and stop if the owner prefers another trade-off.

**Goal:** A new (layoutVersion >= 3) dungeon never contains a hidden detour room that no corridor can reach. This takes #877's wall-crossing sweep from 101 crossings (12 edges, 11/100 seeds) to 0, and the #860 `otherRoom` overlap from 12 cells to 0.

**Architecture:** Three new pure functions in `scripts/dungeon-layout.mjs`. `unreachableDetourIds` reports a detour when `findCorridorPath` finds no path for its one hidden incoming link, on the face `incomingFaceFor` picks and with the source door face `outgoingDoorPlan` would use. `withoutDetours` removes those detours from the graph maps. `placeLayoutGraph` is the placement step that `computeRunLayout` and the test mirror `buildSweepLayout` both used to do inline (ranks, columns, the #415 shortcut prune), plus re-placing after the drop until no unreachable detour is left. Only new runs change. A persisted run keeps its stored `layoutPositionByRoomId`, and layoutVersion 1/2 placement is byte-identical.

**Tech Stack:** Node ESM (`.mjs`), Vitest (`npx vitest run`), Foundry VTT module (no Foundry API touched).

**Spec:** GitHub issue #906 (body and comments; the owner chose direction 2 on 2026-10-08) and #877's investigation comment, which identifies the 12 edges. There is no separate design doc. The OPEN QUESTION above is this plan's design decision and needs the owner's sign-off.

## Global Constraints

- PF2e rules are not involved; this is layout geometry only.
- Every merge to `main` bumps `module.json` `version` (CLAUDE.md, #69). This is a contained fix, so use a patch bump, and never reuse a version.
- `docs/architecture.md` changes only if a file-level import edge between `scripts/` files changes. This plan adds none: `dungeon-reseed.mjs` already imports `dungeon-layout.mjs`, and only the named symbols change.
- Persisted runs must not move: `computeRunLayout` only drops detours for `layoutVersion >= 3`. A run's stored `layoutPositionByRoomId` and `incomingFaceByRoomId` are never recomputed (`scripts/ui/dungeon-app.mjs` stores them at run start).
- Do NOT count null-path hidden links as stubs in `scripts/dungeon-stub-oracle.mjs`. That approach was tried and rejected on #877: it regressed routed dead edges to 1484 against 1466 unrouted, raised sealed doors from 1133 to 1147, and failed the #860 seed-51 repro.
- Ratchet rule: re-pin a moved ratchet only to the number the new code really measures, and say in a comment beside it what it was and why it moved (`#906: was N`). Never loosen a bound to make a test pass. Every number in Tasks 2-3 below was measured with exactly this plan's code (full suite: 161 files, 8762 passed, 1 todo). If a re-run gives a different number, stop and find out why before writing it down.
- Work in a worktree off `origin/main` (CLAUDE.md). Copy `.env`, and run `npm ci`. Never symlink `node_modules`.

## Review Focus

- **A dungeon with two unreachable detours, or one that only becomes unreachable after another is dropped**: `placeLayoutGraph` must loop to a fixed point. Two of 500 seeds need a second pass (sweep-337, sweep-374), pinned by `[dropped, multiPass] = [56, 2]` in Task 1.
- **A detour that IS reachable, including a hidden west-face one**: it must survive untouched. Task 1 pins `placeLayoutGraph` without the drop as byte-equal to the old inline placement on 100 seeds. Task 2 retargets the #860 repro to seed 10, which still builds a hidden west-face edge, and keeps `ownDest`/`doorUncovered` at 0 over the sweep.
- **Old runs and older layout versions**: v1/v2 placement must be unchanged. The default-geometry digest (`tests/dungeon-layout-default-identical.test.mjs`, v1) and the v1/v2 scene digests in `tests/dungeon-router-pipeline.test.mjs` must stay green with no re-pin. Task 2 also asserts v2 still contains sweep-81's `room-detour-0`.
- **`maxCol` after a drop**: the scene is resized from `maxCol`, so it must come from the final positions, not the pre-drop columns. Task 2 asserts it on 100 seeds.
- **Graph consistency after a drop**: no dangling id may be left in `edges`, `layoutEdges`, `hiddenEdges` or `hiddenRooms`, including the parent's `hiddenEdges` entry. Task 1's `withoutDetours` test covers this, and Task 2 asserts it on sweep-81's real layout.

---

### Task 1: Pure detour-reachability helpers and the shared placement step

**Files:**
- Modify: `scripts/dungeon-layout.mjs`. Insert directly after `incomingFaceFor` (its closing `}`, currently line 253, just before the `doorSlotsForFace` docblock).
- Create: `tests/dungeon-detour-reachability.test.mjs`

**Interfaces:**
- Consumes (all existing exports or function declarations in `scripts/dungeon-layout.mjs`, and all hoisted): `parentRoomIdsFor(layoutEdges, roomId)`, `incomingFaceFor(roomId, positionByRoomId, occupiedCells, legitimateSourceIds)`, `findCorridorPath(fromPos, toPos, occupiedCells, { fromRoomId, toRoomId, incomingFace, exitFace })`, `computeRanks(edges, entryId)`, `computeColumns(edges, ranks, entryId)`, `pruneConflictingShortcuts({ edges, hiddenRooms, hiddenEdges, hiddenIncomingByRoomId }, positionByRoomId)`.
- Produces:
  - `unreachableDetourIds({ positionByRoomId, layoutEdges, hiddenRooms, hiddenIncomingByRoomId = {} }) -> string[]` (sorted detour ids; `hiddenRooms` may be a Set or an array)
  - `withoutDetours({ rooms, edges, layoutEdges, hiddenRooms, hiddenEdges, hiddenIncomingByRoomId }, ids) -> { rooms, edges, layoutEdges, hiddenRooms: Set, hiddenEdges, hiddenIncomingByRoomId }` (pure)
  - `placeLayoutGraph(graph, { prune = true, dropUnreachableDetours = false }) -> { rooms, edges, layoutEdges, hiddenRooms, hiddenEdges, hiddenIncomingByRoomId, positionByRoomId, ranks, droppedDetours: string[] }`. `graph` is the shape `attachHiddenPaths` returns. With `prune: false`, `hiddenEdges` and `hiddenIncomingByRoomId` are the input objects themselves.

- [x] **Step 1: Write the failing tests**

Create `tests/dungeon-detour-reachability.test.mjs`:

```js
// #906: a detour room no corridor can reach is not produced. Every #877 wall crossing (12 edges, 11/100 seeds) was a
// hidden link X -> room-detour-N whose target sits in column 0 inside a solid stack of rooms: north is an unrelated
// room, the only west entry cell (rank, -1) cannot be reached without crossing the stack, findCorridorPath returns
// null and the scene draws buildEdgeCorridor's fallback line through other rooms and sealed cells.
import { describe, it, expect } from 'vitest';
import * as deck from '../scripts/dungeon-deck.mjs';
import {
  unreachableDetourIds, withoutDetours, placeLayoutGraph, computeRanks, computeColumns, pruneConflictingShortcuts,
  findCorridorPath, incomingFaceFor, parentRoomIdsFor,
} from '../scripts/dungeon-layout.mjs';

// Column 0 is a solid stack from rank 0 to rank 5 except the detour d at (3,0); its source x is at (2,2).
const STACK_POS = {
  'room-entry': { rank: 0, col: 0 }, a: { rank: 1, col: 0 }, b: { rank: 2, col: 0 }, d: { rank: 3, col: 0 },
  c: { rank: 4, col: 0 }, e: { rank: 5, col: 0 }, x: { rank: 2, col: 2 },
};
const STACK_EDGES = { 'room-entry': ['a'], a: ['b'], b: ['c'], x: ['d'], d: ['c'], c: ['e'] };

function attachedFor(i) {
  const seed = `sweep-${i}`;
  const roomCount = 6 + (i % 15);
  const g = deck.buildRoomGraph({ seed, roomCount });
  const r = deck.insertRestRoom({ rooms: g.rooms, edges: g.edges, seed, roomCount });
  return deck.attachHiddenPaths({ rooms: r.rooms, edges: r.edges, seed });
}

describe('unreachableDetourIds (#906)', () => {
  it('reports a column-0 detour whose north is an unrelated room and whose west cell is cut off by the stack', () => {
    expect(unreachableDetourIds({ positionByRoomId: STACK_POS, layoutEdges: STACK_EDGES, hiddenRooms: new Set(['d']) })).toEqual(['d']);
  });

  it('does not report it once a free column-0 cell inside the search bounds opens a way round to (rank, -1)', () => {
    const { e: _e, ...pos } = STACK_POS;
    const { c: _c, ...edges } = STACK_EDGES;
    expect(unreachableDetourIds({ positionByRoomId: pos, layoutEdges: { ...edges, c: [] }, hiddenRooms: ['d'] })).toEqual([]);
  });

  it('reports exactly the 12 #877 detours over the 100 crossing-sweep seeds, before any is dropped', () => {
    const found = [];
    for (let i = 0; i < 100; i += 1) {
      const A = attachedFor(i);
      const placed = placeLayoutGraph(A, { prune: true, dropUnreachableDetours: false });
      for (const id of unreachableDetourIds({
        positionByRoomId: placed.positionByRoomId, layoutEdges: placed.layoutEdges, hiddenRooms: placed.hiddenRooms,
        hiddenIncomingByRoomId: placed.hiddenIncomingByRoomId,
      })) found.push(`${i}:${id}`);
    }
    expect(found).toEqual([
      '8:room-detour-0', '36:room-detour-0', '41:room-detour-1', '48:room-detour-0', '51:room-detour-0',
      '52:room-detour-0', '56:room-detour-0', '69:room-detour-1', '81:room-detour-0', '87:room-detour-0',
      '87:room-detour-2', '94:room-detour-0',
    ]);
  });

  it('north is no alternative for any of them: it is blocked too (a face-only fallback cannot fix #877)', () => {
    for (const i of [8, 36, 41, 48, 51, 52, 56, 69, 81, 87, 94]) {
      const A = attachedFor(i);
      const placed = placeLayoutGraph(A, { prune: true, dropUnreachableDetours: false });
      const pos = placed.positionByRoomId;
      const occ = Object.fromEntries(Object.entries(pos).map(([id, p]) => [`${p.rank},${p.col}`, id]));
      for (const id of unreachableDetourIds({ positionByRoomId: pos, layoutEdges: placed.layoutEdges, hiddenRooms: placed.hiddenRooms, hiddenIncomingByRoomId: placed.hiddenIncomingByRoomId })) {
        const [src] = parentRoomIdsFor(placed.layoutEdges, id);
        expect(pos[id].col).toBe(0);
        expect(incomingFaceFor(id, pos, occ, new Set([src]))).toBe('west');
        expect(findCorridorPath(pos[src], pos[id], occ, { fromRoomId: src, toRoomId: id, incomingFace: 'north', exitFace: 'south' })).toBeNull();
      }
    }
  });
});

describe('withoutDetours (#906)', () => {
  it('removes the detour from every map and leaves everything else as it was', () => {
    const graph = {
      rooms: { 'room-entry': {}, x: {}, t: {}, d: {} },
      edges: { 'room-entry': ['x'], x: ['t'], d: ['t'], t: [] },
      layoutEdges: { 'room-entry': ['x'], x: ['t', 'd'], d: ['t'], t: [] },
      hiddenRooms: new Set(['d']),
      hiddenEdges: { x: ['d'] },
      hiddenIncomingByRoomId: { t: ['room-entry'] },
    };
    const out = withoutDetours(graph, ['d']);
    expect(Object.keys(out.rooms)).toEqual(['room-entry', 'x', 't']);
    expect(out.edges).toEqual({ 'room-entry': ['x'], x: ['t'], t: [] });
    expect(out.layoutEdges).toEqual({ 'room-entry': ['x'], x: ['t'], t: [] });
    expect([...out.hiddenRooms]).toEqual([]);
    expect(out.hiddenEdges).toEqual({});
    expect(out.hiddenIncomingByRoomId).toEqual({ t: ['room-entry'] });
    // pure: the input is untouched
    expect(graph.layoutEdges.x).toEqual(['t', 'd']);
    expect([...graph.hiddenRooms]).toEqual(['d']);
  });
});

describe('placeLayoutGraph (#906)', () => {
  it('without the drop it is exactly the old inline placement (ranks, columns, prune) on every one of 100 seeds', () => {
    for (let i = 0; i < 100; i += 1) {
      const A = attachedFor(i);
      const ranks = computeRanks(A.layoutEdges, 'room-entry');
      const cols = computeColumns(A.layoutEdges, ranks, 'room-entry');
      const pos = Object.fromEntries(Object.keys(A.rooms).map((id) => [id, { rank: ranks[id], col: cols[id] }]));
      const pruned = pruneConflictingShortcuts(A, pos);
      const placed = placeLayoutGraph(A, { prune: true, dropUnreachableDetours: false });
      expect(placed.positionByRoomId).toEqual(pos);
      expect(placed.ranks).toEqual(ranks);
      expect(placed.hiddenEdges).toEqual(pruned.hiddenEdges);
      expect(placed.hiddenIncomingByRoomId).toEqual(pruned.hiddenIncomingByRoomId);
      expect(placed.droppedDetours).toEqual([]);
    }
  });

  it('prune: false passes the hidden maps through untouched (layoutVersion 1)', () => {
    const A = attachedFor(13);
    const placed = placeLayoutGraph(A, { prune: false });
    expect(placed.hiddenEdges).toBe(A.hiddenEdges);
    expect(placed.hiddenIncomingByRoomId).toBe(A.hiddenIncomingByRoomId);
  });

  it('with the drop, seed 81 loses room-detour-0 and its child moves up into the freed rank', () => {
    const before = placeLayoutGraph(attachedFor(81), { prune: true, dropUnreachableDetours: false });
    const after = placeLayoutGraph(attachedFor(81), { prune: true, dropUnreachableDetours: true });
    expect(before.positionByRoomId['room-detour-0']).toEqual({ rank: 4, col: 0 });
    expect(before.positionByRoomId['room-rest']).toEqual({ rank: 5, col: 0 });
    expect(after.droppedDetours).toEqual(['room-detour-0']);
    expect(after.rooms['room-detour-0']).toBeUndefined();
    expect([...after.hiddenRooms]).not.toContain('room-detour-0');
    expect(after.positionByRoomId['room-rest']).toEqual({ rank: 4, col: 0 });
  });

  it('re-places until no detour is unreachable (500 seeds; a second pass is needed in some)', () => {
    let dropped = 0;
    let multiPass = 0;
    for (let i = 0; i < 500; i += 1) {
      const placed = placeLayoutGraph(attachedFor(i), { prune: true, dropUnreachableDetours: true });
      dropped += placed.droppedDetours.length;
      const firstPass = unreachableDetourIds({
        ...placeLayoutGraph(attachedFor(i), { prune: true, dropUnreachableDetours: false }),
      });
      if (placed.droppedDetours.length > firstPass.length) multiPass += 1;
      expect(unreachableDetourIds(placed)).toEqual([]);
    }
    expect([dropped, multiPass]).toEqual([56, 2]);
  });
});
```

- [x] **Step 2: Run them to verify they fail**

Run: `npx vitest run tests/dungeon-detour-reachability.test.mjs`
Expected: FAIL. The file does not load because `scripts/dungeon-layout.mjs` has no export named `unreachableDetourIds`, `withoutDetours` or `placeLayoutGraph`.

- [x] **Step 3: Implement the three functions**

In `scripts/dungeon-layout.mjs`, directly after the closing brace of `incomingFaceFor`:

```js
  if (isFreeOrLegitimate(pos.rank, pos.col - 1)) return 'west';
  return 'north';
}
```

insert:

```js
/**
 * #906: the detour rooms (`hiddenRooms`) of a placed layout that no corridor can reach. A detour has exactly one
 * incoming connection, its hidden link from its one `layoutEdges` parent; it is unreachable when `findCorridorPath`
 * finds no path for that link on the face `incomingFaceFor` gives the detour, with the source's door on the face
 * `outgoingDoorPlan` would give it (east for a target in a higher column, south otherwise).
 *
 * Measured (500 sweep seeds): every such detour sits in column 0 inside a solid stack of rooms. Its north neighbour
 * is an unrelated room (so `incomingFaceFor` falls back to west), and the only west entry cell (rank, -1) cannot be
 * reached from the source's column without crossing that stack, so north is no better than west. The scene then draws
 * `buildEdgeCorridor`'s null-path fallback line through other rooms and sealed cells (#877's crossings). The detour is
 * also always the room directly above its own child's north gate cell. Returns the ids, sorted.
 */
export function unreachableDetourIds({ positionByRoomId, layoutEdges, hiddenRooms, hiddenIncomingByRoomId = {} }) {
  const occupiedCells = {};
  for (const [id, p] of Object.entries(positionByRoomId)) occupiedCells[`${p.rank},${p.col}`] = id;
  const unreachable = [];
  for (const id of [...hiddenRooms].sort()) {
    const [sourceId] = parentRoomIdsFor(layoutEdges, id);
    if (sourceId == null) continue;
    const from = positionByRoomId[sourceId];
    const to = positionByRoomId[id];
    const legitimateSourceIds = new Set([...parentRoomIdsFor(layoutEdges, id), ...(hiddenIncomingByRoomId[id] ?? [])]);
    const path = findCorridorPath(from, to, occupiedCells, {
      fromRoomId: sourceId, toRoomId: id,
      incomingFace: incomingFaceFor(id, positionByRoomId, occupiedCells, legitimateSourceIds),
      exitFace: to.col > from.col ? 'east' : 'south',
    });
    if (path == null) unreachable.push(id);
  }
  return unreachable;
}

/**
 * #906: `graph` (the `attachHiddenPaths` shape) without the detour rooms `ids`: each leaves `rooms`, `hiddenRooms`,
 * its own `edges`/`layoutEdges` entry, its parent's `layoutEdges` list and its parent's `hiddenEdges` entry (dropped
 * when empty). `hiddenIncomingByRoomId` only ever holds shortcut links, never a detour, so it passes through. Pure:
 * returns new maps, `hiddenRooms` as a new Set.
 */
export function withoutDetours({ rooms, edges, layoutEdges, hiddenRooms, hiddenEdges, hiddenIncomingByRoomId = {} }, ids) {
  const drop = new Set(ids);
  const keep = (map) => Object.fromEntries(Object.entries(map)
    .filter(([id]) => !drop.has(id))
    .map(([id, kids]) => [id, kids.filter((kid) => !drop.has(kid))]));
  return {
    rooms: Object.fromEntries(Object.entries(rooms).filter(([id]) => !drop.has(id))),
    edges: keep(edges),
    layoutEdges: keep(layoutEdges),
    hiddenRooms: new Set([...hiddenRooms].filter((id) => !drop.has(id))),
    hiddenEdges: Object.fromEntries(Object.entries(keep(hiddenEdges)).filter(([, kids]) => kids.length > 0)),
    hiddenIncomingByRoomId,
  };
}

/**
 * #906: the placement step every layout builder shares: ranks and columns from `layoutEdges` (#156), the shortcut
 * prune (#415 Chunk 5) when `prune`, and, when `dropUnreachableDetours` (layoutVersion >= 3), the removal of every
 * detour `unreachableDetourIds` reports, re-placing until none is left (dropping a detour moves its child up a rank
 * and can change other cells; measured: a second pass is needed in 2 of 500 seeds). `graph` is the
 * `attachHiddenPaths` shape. Returns `{ rooms, edges, layoutEdges, hiddenRooms, hiddenEdges, hiddenIncomingByRoomId,
 * positionByRoomId, ranks, droppedDetours }` (`hiddenEdges`/`hiddenIncomingByRoomId` pruned; `droppedDetours` the
 * removed ids in removal order).
 */
export function placeLayoutGraph(graph, { prune = true, dropUnreachableDetours = false } = {}) {
  let g = graph;
  const droppedDetours = [];
  for (;;) {
    const ranks = computeRanks(g.layoutEdges, 'room-entry');
    const columns = computeColumns(g.layoutEdges, ranks, 'room-entry');
    const positionByRoomId = Object.fromEntries(Object.keys(g.rooms).map((id) => [id, { rank: ranks[id], col: columns[id] }]));
    const { hiddenEdges, hiddenIncomingByRoomId } = prune
      ? pruneConflictingShortcuts({
        edges: g.edges, hiddenRooms: g.hiddenRooms, hiddenEdges: g.hiddenEdges, hiddenIncomingByRoomId: g.hiddenIncomingByRoomId,
      }, positionByRoomId)
      : g;
    const unreachable = dropUnreachableDetours
      ? unreachableDetourIds({ positionByRoomId, layoutEdges: g.layoutEdges, hiddenRooms: g.hiddenRooms, hiddenIncomingByRoomId })
      : [];
    if (unreachable.length === 0) {
      return {
        rooms: g.rooms, edges: g.edges, layoutEdges: g.layoutEdges, hiddenRooms: g.hiddenRooms,
        hiddenEdges, hiddenIncomingByRoomId, positionByRoomId, ranks, droppedDetours,
      };
    }
    droppedDetours.push(...unreachable);
    g = withoutDetours(g, unreachable);
  }
}
```

- [x] **Step 4: Run the tests to verify they pass, and that nothing else moved**

Run: `npx vitest run tests/dungeon-detour-reachability.test.mjs tests/dungeon-layout.test.mjs tests/dungeon-corridor-wall-crossing-sweep.test.mjs`
Expected: PASS (3 files, 214 tests). The crossing sweep still pins 101 crossings, because nothing calls the new functions yet.

- [x] **Step 5: Commit**

```bash
git add scripts/dungeon-layout.mjs tests/dungeon-detour-reachability.test.mjs
git commit -m "#906: unreachableDetourIds, withoutDetours, placeLayoutGraph (pure, not wired)"
```

### Task 2: New runs drop unreachable detours (computeRunLayout + the sweep mirror), target sweeps re-pinned

**Files:**
- Modify: `scripts/dungeon-reseed.mjs` (the import block at lines 18-20; `computeRunLayout`, lines 88-126)
- Modify: `tests/helpers/layout-sweep.mjs` (the import block at lines 7-11; `buildSweepLayout`, lines 20-48). This is the test-side mirror of `computeRunLayout`. It must drop the same detours or every `buildSweepLayout(i, { layoutVersion: 3 })` ratchet disagrees with the product. `tests/dungeon-reseed.test.mjs` already asserts the two agree on 500 seeds.
- Modify: `tests/dungeon-detour-reachability.test.mjs` (append the computeRunLayout block)
- Modify: `tests/dungeon-corridor-wall-crossing-sweep.test.mjs`, `tests/dungeon-corridor-hidden-west-overlap-sweep.test.mjs`

**Interfaces:**
- Consumes: `placeLayoutGraph` and `unreachableDetourIds` from Task 1.
- Produces: `computeRunLayout(...)` keeps its signature and return shape. For `layoutVersion >= 3` its `rooms`, `edges`, `layoutEdges`, `hiddenRooms` and `hiddenEdges` no longer contain an unreachable detour, and `maxCol` comes from the final positions. `buildSweepLayout(i, opts)` keeps its signature and return shape.

- [x] **Step 1: Write the failing test**

Add `import { computeRunLayout } from '../scripts/dungeon-reseed.mjs';` after the existing `dungeon-layout.mjs` import in `tests/dungeon-detour-reachability.test.mjs`, and append:

```js
describe('computeRunLayout (#906)', () => {
  it('a v3 layout never contains an unreachable detour; v1/v2 layouts are placed as before', () => {
    for (let i = 0; i < 100; i += 1) {
      const ctx = { generator: deck, seed: `sweep-${i}`, roomCount: 6 + (i % 15) };
      const P = computeRunLayout({ ...ctx, topologyRouting: true });
      expect(unreachableDetourIds({
        positionByRoomId: P.layoutPositionByRoomId, layoutEdges: P.layoutEdges, hiddenRooms: P.hiddenRooms,
        hiddenIncomingByRoomId: P.hiddenIncomingByRoomId,
      })).toEqual([]);
      expect(P.maxCol).toBe(Math.max(...Object.values(P.layoutPositionByRoomId).map((p) => p.col)));
    }
    const v2 = computeRunLayout({ generator: deck, seed: 'sweep-81', roomCount: 6 + (81 % 15), layoutVersion: 2 });
    expect(v2.hiddenRooms).toContain('room-detour-0');
    const v3 = computeRunLayout({ generator: deck, seed: 'sweep-81', roomCount: 6 + (81 % 15) });
    expect(v3.hiddenRooms).not.toContain('room-detour-0');
    expect(v3.rooms['room-detour-0']).toBeUndefined();
    expect(v3.edges['room-detour-0']).toBeUndefined();
    expect(Object.values(v3.hiddenEdges).flat()).not.toContain('room-detour-0');
  });
});
```

- [x] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/dungeon-detour-reachability.test.mjs -t "computeRunLayout"`
Expected: FAIL. `unreachableDetourIds` returns `['room-detour-0']` for sweep-8, where `[]` is expected.

- [x] **Step 3: Wire `computeRunLayout`**

In `scripts/dungeon-reseed.mjs` replace the import

```js
  computeRanks, computeColumns, parentRoomIdsFor, incomingFaceFor, pruneConflictingShortcuts, NEW_RUN_LAYOUT_VERSION,
```

with

```js
  parentRoomIdsFor, incomingFaceFor, placeLayoutGraph, NEW_RUN_LAYOUT_VERSION,
```

then in `computeRunLayout` replace

```js
  const { rooms, edges: edgesBeforeStubs } = generator.insertRestRoom({
    rooms: generated.rooms, edges: generated.edges, seed, roomCount,
  });
  const { hiddenRooms, hiddenEdges: attachedHiddenEdges, layoutEdges, hiddenIncomingByRoomId: attachedHiddenIncoming } =
    generator.attachHiddenPaths({ rooms, edges: edgesBeforeStubs, seed, ...sets });
  // #156: ranks/columns come from layoutEdges (they include detour rooms).
  const ranks = computeRanks(layoutEdges, 'room-entry');
  const columns = computeColumns(layoutEdges, ranks, 'room-entry');
  const layoutPositionByRoomId = Object.fromEntries(
    Object.keys(rooms).map((id) => [id, { rank: ranks[id], col: columns[id] }]),
  );
  // #415 Chunk 5: drop optional hidden shortcuts that share an outgoing face lane; must precede the incoming faces.
  const { hiddenEdges, hiddenIncomingByRoomId } = pruneConflictingShortcuts({
    edges: edgesBeforeStubs, hiddenRooms, hiddenEdges: attachedHiddenEdges, hiddenIncomingByRoomId: attachedHiddenIncoming,
  }, layoutPositionByRoomId);
  const occupiedCells = {};
```

with

```js
  const restInserted = generator.insertRestRoom({
    rooms: generated.rooms, edges: generated.edges, seed, roomCount,
  });
  const attached = generator.attachHiddenPaths({ rooms: restInserted.rooms, edges: restInserted.edges, seed, ...sets });
  // #156 ranks/columns from layoutEdges, #415 Chunk 5 shortcut prune (must precede the incoming faces), and #906: a new
  // (v3) run drops every detour room no corridor can reach instead of drawing its fallback line through other rooms.
  const {
    rooms, edges: edgesBeforeStubs, layoutEdges, hiddenRooms, hiddenEdges, hiddenIncomingByRoomId,
    positionByRoomId: layoutPositionByRoomId, ranks,
  } = placeLayoutGraph(attached, { prune: true, dropUnreachableDetours: layoutVersion >= 3 });
  const occupiedCells = {};
```

and in its `return` replace

```js
    maxRank: Math.max(...Object.values(ranks)), maxCol: Math.max(...Object.values(columns)),
```

with

```js
    maxRank: Math.max(...Object.values(ranks)), maxCol: Math.max(...Object.values(layoutPositionByRoomId).map((p) => p.col)),
```

- [x] **Step 4: Wire the sweep mirror**

In `tests/helpers/layout-sweep.mjs` replace the import list

```js
  computeRanks, computeColumns, roomRect, incomingFaceFor, parentRoomIdsFor,
  incomingConnectionsFor, findPriorityCollision, assignDoorSlotsWithPriority,
  exitFaceForIndex, buildEdgeCorridor, outgoingDoorPlan, pruneConflictingShortcuts,
```

with

```js
  roomRect, incomingFaceFor, parentRoomIdsFor, placeLayoutGraph,
  incomingConnectionsFor, findPriorityCollision, assignDoorSlotsWithPriority,
  exitFaceForIndex, buildEdgeCorridor, outgoingDoorPlan,
```

and in `buildSweepLayout` replace

```js
  const { rooms, edges } = restRoom
    ? insertRestRoom({ rooms: generated.rooms, edges: generated.edges, seed, roomCount })
    : generated;
  const attached = attachHiddenPaths({ rooms, edges, seed });
  const { layoutEdges, hiddenRooms } = attached;
  const ranks = computeRanks(layoutEdges, 'room-entry');
  const cols = computeColumns(layoutEdges, ranks, 'room-entry');
  const ids = Object.keys(rooms);
  const pos = Object.fromEntries(ids.map((id) => [id, { rank: ranks[id], col: cols[id] }]));
  // #415 Chunk 5 (layoutVersion >= 2): mirrors dungeon-app.mjs, which prunes between positions and incoming faces.
  const { hiddenEdges, hiddenIncomingByRoomId } = layoutVersion >= 2
    ? pruneConflictingShortcuts({ edges, hiddenRooms, hiddenEdges: attached.hiddenEdges, hiddenIncomingByRoomId: attached.hiddenIncomingByRoomId }, pos)
    : attached;
  const occ = Object.fromEntries(
```

with

```js
  const base = restRoom
    ? insertRestRoom({ rooms: generated.rooms, edges: generated.edges, seed, roomCount })
    : generated;
  const attached = attachHiddenPaths({ rooms: base.rooms, edges: base.edges, seed });
  // Mirrors computeRunLayout (scripts/dungeon-reseed.mjs): the shared placement step. #415 Chunk 5 prunes shortcuts for
  // layoutVersion >= 2; #906 drops unreachable detour rooms for layoutVersion >= 3.
  const {
    rooms, edges, layoutEdges, hiddenRooms, hiddenEdges, hiddenIncomingByRoomId, positionByRoomId: pos,
  } = placeLayoutGraph(attached, { prune: layoutVersion >= 2, dropUnreachableDetours: layoutVersion >= 3 });
  const ids = Object.keys(rooms);
  const occ = Object.fromEntries(
```

- [x] **Step 5: Run the new test and the guards that must NOT move**

Run: `npx vitest run tests/dungeon-detour-reachability.test.mjs tests/dungeon-layout-default-identical.test.mjs tests/dungeon-reseed.test.mjs`
Expected: every test passes except exactly one, `chooseRunLayout > exhausted: keeps a candidate and warns instead of blocking`, which receives `[false, true, 0]` because sweep-12 no longer exhausts; Task 3 re-pins it. The v1 default-geometry digest is unchanged. "computeRunLayout equals the stub-free sweep layout" still holds, which proves the two placement paths agree.

- [x] **Step 6: Re-pin the two #906 target sweeps to the measured numbers**

Run first: `npx vitest run tests/dungeon-corridor-wall-crossing-sweep.test.mjs tests/dungeon-corridor-hidden-west-overlap-sweep.test.mjs`
Expected before the edit: FAIL. `seedsHit` is `[]` against the old `[8, 36, …, 94]`, `otherRoom` is `[]` against the old 12 `sweep-81` cells, and the seed-51 repro's last assertion is `false`, because seed 51 no longer builds a hidden west-face edge (its detour is dropped).

Then apply:

#### `tests/dungeon-corridor-wall-crossing-sweep.test.mjs`

Replace:

```js
    // Three wall-generation mechanisms -- cellMarginWalls' planned margin openings, transitCellContainmentWalls'
    // per-crossing openings, roomEnclosureWalls' per-direction wall -- each disagree with a hidden-detour edge's
    // real corridor tiles in 11/100 seeds (8,36,41,48,51,52,56,69,81,87,94). Pinned, not asserted to zero: the
    // cause spans independent subsystems and is tracked as #877. A future fix
    // lowers these numbers -- update this assertion to match, like tests/dungeon-corridor-joins-sweep.test.mjs.
    expect(stubPairs).toBeGreaterThan(0);
    expect([...seedsHit]).toEqual([8, 36, 41, 48, 51, 52, 56, 69, 81, 87, 94]);
    expect(byCategory).toEqual({
      dungeonCellMarginWallForRoom: 29,
      'dungeonTransitCellMarginForCell+dungeonTransitCellOpenings': 70,
      'dungeonEnclosureWallForRoom+dungeonEnclosureWallDirection': 2,
    });
```

with:

```js
    // #877/#906: the 101 crossings (29 cell-margin, 70 transit-cell, 2 enclosure walls; 12 edges in 11/100 seeds:
    // 8,36,41,48,51,52,56,69,81,87,94) were all one shape -- a hidden link into a column-0 detour room that no corridor
    // can reach, drawn as buildEdgeCorridor's null-path fallback line. #906 no longer produces that detour
    // (placeLayoutGraph drops it), so none is left.
    expect(stubPairs).toBeGreaterThan(0);
    expect([...seedsHit]).toEqual([]);
    expect(byCategory).toEqual({});
```

#### `tests/dungeon-corridor-hidden-west-overlap-sweep.test.mjs`

Replace (1):

```js
    // Tracked in #873 (which also notes the sealed-reveal-door transit-margin observation).
    // Second, distinct phenomenon #860 also reports: a corridor cell inside an
    // UNRELATED third room. Measured 17 cells before the fix; 12 remain after
    // it, all one seed (sweep-81, one straight row y=45, x=300..311 through
    // room-room-room-room-entry-0-0-0). That is a pathfinding route choice
    // (findCorridorPath), not the west-face leg overflow fixed here -- see the
    // known-residual note in buildEdgeCorridor's multi-cell branch. Pinned at
    // the real residual so the sweep is honest; tighten when it is fixed.
    expect(all.otherRoom.map((h) => `${h.seed} ${h.cell}`)).toEqual(
      Array.from({ length: 12 }, (_, k) => `sweep-81 ${300 + k},45`),
    );
```

with:

```js
    // Second, distinct phenomenon #860 also reports: a corridor cell inside an UNRELATED third room. 17 cells before
    // #860, 12 after it (all sweep-81, y=45, x=300..311 through room-room-room-room-entry-0-0-0): that detour had no
    // reachable approach at all, so the scene drew the null-path fallback line. #906 drops such detours: 0.
    expect(all.otherRoom.map((h) => `${h.seed} ${h.cell}`)).toEqual([]);
```

Replace (2):

```js
describe('#860 seed 51 (the issue\'s named repro)', () => {
  it('its hidden west-face corridor has no cell inside its destination room and covers its door\'s outside cell', async () => {
    const P = computeRunLayout({ generator: deck, seed: 'sweep-51', roomCount: 6 + (51 % 15), topologyRouting: true });
```

with:

```js
// #906: seed 51 (#860's named repro) no longer builds a hidden west-face edge -- its detour was unreachable and is now
// dropped -- so the repro runs on seed 10, the lowest sweep seed that still builds one.
describe('#860 repro on seed 10 (seed 51\'s detour is dropped by #906)', () => {
  it('its hidden west-face corridor has no cell inside its destination room and covers its door\'s outside cell', async () => {
    const P = computeRunLayout({ generator: deck, seed: 'sweep-10', roomCount: 6 + (10 % 15), topologyRouting: true });
```


- [x] **Step 7: Run the target sweeps to verify they pass**

Run: `npx vitest run tests/dungeon-corridor-wall-crossing-sweep.test.mjs tests/dungeon-corridor-hidden-west-overlap-sweep.test.mjs`
Expected: PASS (2 files, 3 tests). Crossings are 0 (`byCategory` `{}`), `otherRoom` is `[]`, `ownDest`, `ownSource`, `crossCorridor` and `doorUncovered` are still `[]`, and seed 10's hidden west-face edge passes the #860 repro.

- [x] **Step 8: Commit**

```bash
git add scripts/dungeon-reseed.mjs tests/helpers/layout-sweep.mjs tests/dungeon-detour-reachability.test.mjs   tests/dungeon-corridor-wall-crossing-sweep.test.mjs tests/dungeon-corridor-hidden-west-overlap-sweep.test.mjs
git commit -m "#906: new runs drop detour rooms no corridor can reach; #877 crossings 101 -> 0"
```

(The Task 3 ratchets are red between this commit and Task 3's. Both land in the same PR.)

### Task 3: Re-pin every other ratchet the drop moves (measured numbers only)

**Files (every ratchet that moves; nothing else may move):**
- `tests/dungeon-corridor-joins-sweep.test.mjs`, `tests/dungeon-goal-reseed.test.mjs`, `tests/dungeon-layout-buildability.test.mjs`, `tests/dungeon-layout-stubs-sweep.test.mjs`, `tests/dungeon-reseed-sweep.test.mjs`, `tests/dungeon-reseed.test.mjs`, `tests/dungeon-router-pipeline-sweep.test.mjs`, `tests/dungeon-router-pipeline.test.mjs`, `tests/dungeon-scene-sealed-edges.test.mjs`, `tests/dungeon-sealed-door-causes.test.mjs`, `tests/dungeon-stub-oracle-aware.test.mjs`, `tests/dungeon-stub-union-sweep.test.mjs`, `tests/dungeon-walled-sweep.test.mjs`

The following were checked and must NOT move. If one fails, stop: that is a real regression, not a re-pin. `tests/dungeon-layout-router.test.mjs`, `tests/dungeon-layout-passage.test.mjs`, `tests/walkability-oracle.test.mjs`, `tests/dungeon-west-face-door-margin.test.mjs` (the #873 sweep), `tests/dungeon-layout-default-identical.test.mjs`, and the v1/v2 digests in `tests/dungeon-router-pipeline.test.mjs`. All of the K6 invariants in `tests/dungeon-router-pipeline-sweep.test.mjs` hold: 500/500 goal-reachable, 0 dead left, 0 sealed progression doors, 0 door mismatches, 0 live unresolvable. The same goes for every "at most / at least" ceiling not listed below.

**Interfaces:**
- Consumes: the Task 2 behaviour.
- Produces: no code, only re-pinned assertions.

**Re-pin rule:** each edit below replaces a pinned value with the value this plan's code measures (full-suite run: 161 files, 8762 passed, 1 todo) and records the old value beside it. Where a number got worse (routed baseDead, stubs, dead-end rooms, `dungeon-goal-reseed` residual, `wallCut`), the comment says so plainly. These are part of the OPEN QUESTION trade-off and are not to be hidden. `UNROUTED` in the router-pipeline sweep is re-measured with `node tests/helpers/pipeline-measure.mjs 500 0`, as its own header instructs, because the unrouted v3 pipeline also drops the detours. Two bound-style assertions change form deliberately: `dungeon-reseed-sweep`'s candidate range moves to 1.95-2.05 around the measured 1.998 (499/500), and `dungeon-scene-sealed-edges`' base scene-valid bound becomes the exact 237 (it was "under 225"). The `exhausted` case in `tests/dungeon-reseed.test.mjs` moves from sweep-12 (it now needs fewer than 4 reseeds) to sweep-25, which needs 8. That was measured: `[exhausted, goalReachable, warnings] = [true, false, 1]` with `maxTries: 3`.

- [x] **Step 1: Run the full suite and confirm exactly these failures**

Run: `npx vitest run 2>&1 | grep -E "^ FAIL " | sort -u`
Expected: failures only in the 13 files listed above, and the received values equal the "with" numbers below.

- [x] **Step 2: Apply the re-pins**

#### `tests/dungeon-corridor-joins-sweep.test.mjs`

Replace (1):

```js
    // 1749 open joints (I2), is asymmetric on 530 (I1) and stacks 1247 cells (I0) (#860: west-face corridor geometry moved these from 1874/530/1257).
    expect([t.oldI2, t.oldI1, t.oldStackedCells]).toEqual([1749, 530, 1247]);
```

with:

```js
    // 1735 open joints (I2), is asymmetric on 518 (I1) and stacks 1230 cells (I0) (#860: west-face corridor geometry moved these from 1874/530/1257;
    // #906: unreachable detours are no longer produced, 1749/530/1247 -> 1735/518/1230).
    expect([t.oldI2, t.oldI1, t.oldStackedCells]).toEqual([1735, 518, 1230]);
```

Replace (2):

```js
      .toEqual([20095, 2480, 0, 0, 1259, 2]);
```

with:

```js
      .toEqual([19535, 2468, 0, 0, 1246, 0]);
    // #906: the sweep-51 cross-edge overlap (2 cells) was that seed's unreachable detour's fallback line; it is gone.
    // Pairs 20095 -> 19535, door ends 2480 -> 2468, corners 1259 -> 1246 (56 fewer detour rooms over 500 seeds; here 12 over 100).
```

Replace (3):

```js
    expect([t.oldTiles, t.corridorTiles]).toEqual([22901, 21519]);
```

with:

```js
    // #906: 22901 -> 22313 old tiles, 21519 -> 20948 corridor tiles (the dropped detours' corridors and fallback lines).
    expect([t.oldTiles, t.corridorTiles]).toEqual([22313, 20948]);
```

#### `tests/dungeon-goal-reseed.test.mjs`

Replace (1):

```js
    // Base: goal reachable in 265/500 after stubs (255 on the plain layout); 66% of dungeons have a secret detour.
    expect([base.valid, summarize(sweep, 0, 'gPlain').valid]).toEqual([265, 255]);
    expect(base.detourDungeons).toBe(330);
    // Share of runs ending with G true after N reseeds (stub-first policy).
    expect([1, 3, 5, 10, 20].map((N) => at(N).valid)).toEqual([389, 465, 485, 499, 500]);
    // Check-before-stubs policy (cheaper: stubs only for the accepted candidate): never better than stub-first.
    expect([1, 3, 5, 10, 20].map((N) => at(N, 'gPlain').valid)).toEqual([379, 459, 482, 497, 500]);
```

with:

```js
    // Base: goal reachable in 291/500 after stubs (281 on the plain layout); 61% of dungeons have a secret detour.
    // #906 (unreachable detours dropped): 265/255 -> 291/281, detour dungeons 330 -> 303.
    expect([base.valid, summarize(sweep, 0, 'gPlain').valid]).toEqual([291, 281]);
    expect(base.detourDungeons).toBe(303);
    // Share of runs ending with G true after N reseeds (stub-first policy). #906: was 389/465/485/499/500.
    expect([1, 3, 5, 10, 20].map((N) => at(N).valid)).toEqual([413, 484, 492, 500, 500]);
    // Check-before-stubs policy (cheaper: stubs only for the accepted candidate): never better than stub-first.
    // #906: was 379/459/482/497/500.
    expect([1, 3, 5, 10, 20].map((N) => at(N, 'gPlain').valid)).toEqual([404, 477, 490, 499, 500]);
```

Replace (2):

```js
    // Skew: secret-detour dungeons fall 66% -> 36% (full predicate: 22-25%); room count and kind mix hold.
    const a = at(20);
    expect(a.detourDungeons).toBe(180);
```

with:

```js
    // Skew: secret-detour dungeons fall 61% -> 32% (full predicate: 22-25%); room count and kind mix hold.
    // #906: accepted detour dungeons 180 -> 159 (base 330 -> 303).
    const a = at(20);
    expect(a.detourDungeons).toBe(159);
```

Replace (3):

```js
    expect([a.unreachDungeons, a.unreachRooms]).toEqual([47, 80]);
    expect(a.soleDeadDungeons).toBe(16);
    expect(a.sealedDoors).toBe(89);
    expect(base.unreachRooms).toBe(1275);
```

with:

```js
    // #906: residual 47/80 -> 50/85 and sole-dead 16 -> 19 (other seeds are accepted now), sealed doors 89 -> 63,
    // base unreachable rooms 1275 -> 1125.
    expect([a.unreachDungeons, a.unreachRooms]).toEqual([50, 85]);
    expect(a.soleDeadDungeons).toBe(19);
    expect(a.sealedDoors).toBe(63);
    expect(base.unreachRooms).toBe(1125);
```

#### `tests/dungeon-layout-buildability.test.mjs`

Replace:

```js
    expect(total.edges).toBe(9498);
```

with:

```js
    // #906: 9498 -> 9386, the 56 dropped (unreachable) detour rooms' two edges each.
    expect(total.edges).toBe(9386);
```

#### `tests/dungeon-layout-stubs-sweep.test.mjs`

Replace (1):

```js
const NO_RETREAT_NULL_EDGES = 2052;
```

with:

```js
const NO_RETREAT_NULL_EDGES = 1952; // #906: 2052 -> 1952 (unreachable detours dropped)
```

Replace (2):

```js
const RETREAT_ELIGIBLE = 1576;
```

with:

```js
const RETREAT_ELIGIBLE = 1573; // #906: 1576 -> 1573
```

#### `tests/dungeon-reseed-sweep.test.mjs`

Replace (1):

```js
    expect(stats.baseGoal).toBe(229);
```

with:

```js
    // #906 (unreachable detours dropped): 229 -> 255.
    expect(stats.baseGoal).toBe(255);
```

Replace (2):

```js
    expect(stats.cand).toBeGreaterThan(2.25);
    expect(stats.cand).toBeLessThan(2.4);
```

with:

```js
    // #906: mean candidates 2.25-2.4 -> 1.998 (499 reseeds over 500 bases, was 654).
    expect(stats.cand).toBeGreaterThan(1.95);
    expect(stats.cand).toBeLessThan(2.05);
```

Replace (3):

```js
    expect(stats.detour).toBe(147);
    expect(stats.hidden).toBeGreaterThan(0.34);
    expect(stats.hidden).toBeLessThan(0.42);
```

with:

```js
    // #906: 147 -> 128 detour dungeons accepted, hidden rooms ~0.38 -> 0.326 (unreachable detours are dropped).
    expect(stats.detour).toBe(128);
    expect(stats.hidden).toBeGreaterThan(0.3);
    expect(stats.hidden).toBeLessThan(0.35);
```

#### `tests/dungeon-reseed.test.mjs`

Replace:

```js
    // base 12 needs 11 reseeds (see the ratchet test); with maxTries 3 it exhausts.
    const r = await chooseRunLayout({ ...ctx(12, 'sweep-12'), maxTries: 3, warn: (m) => warnings.push(m) });
```

with:

```js
    // base 25 needs 8 reseeds; with maxTries 3 it exhausts. (#906: base 12 needed 11 before unreachable detours were
    // dropped; it now needs fewer than 4.)
    const r = await chooseRunLayout({ ...ctx(25, 'sweep-25'), maxTries: 3, warn: (m) => warnings.push(m) });
```

#### `tests/dungeon-router-pipeline-sweep.test.mjs`

Replace (1):

```js
// The same 500 seeds through the same pipeline WITHOUT routing (a v3 run created before the router), measured on main.
const UNROUTED = {
  baseDead: 1952, baseFoundDead: 419, stubs: 1466, walls: 495, unreachableNonGoalRooms: 463, roomsWith2PlusLiveExits: 1052,
  dungeonsWith2Plus: 479, reachableRooms: 6978, deadEndRooms: 1145, reseedTriesTotal: 654,
};
```

with:

```js
// The same 500 seeds through the same pipeline WITHOUT routing (a v3 run created before the router), measured on main.
// #906 re-measure (unreachable detours dropped from every v3 layout): was baseDead 1952, baseFoundDead 419, stubs 1466,
// walls 495, unreachableNonGoalRooms 463, roomsWith2PlusLiveExits 1052, dungeonsWith2Plus 479, reachableRooms 6978,
// deadEndRooms 1145, reseedTriesTotal 654.
const UNROUTED = {
  baseDead: 1978, baseFoundDead: 428, stubs: 1495, walls: 496, unreachableNonGoalRooms: 480, roomsWith2PlusLiveExits: 1072,
  dungeonsWith2Plus: 482, reachableRooms: 6961, deadEndRooms: 1166, reseedTriesTotal: 499,
};
```

Replace (2):

```js
    expect([total.reseedFirstTry, total.reseedMaxTries]).toEqual([234, 18]);
```

with:

```js
    expect([total.reseedFirstTry, total.reseedMaxTries]).toEqual([260, 12]); // #906: was [234, 18]
```

Replace (3):

```js
  it('pins the measured routed numbers', () => {
    expect([total.realEdges, total.baseDead, total.baseFoundDead]).toEqual([8557, 1704, 171]);
    expect([total.stubs, total.walls]).toEqual([1466, 250]);
    expect([total.roomsWith2PlusLiveExits, total.dungeonsWith2Plus, total.deadEndRooms]).toEqual([1171, 483, 1288]);
    expect([total.reachableRooms, total.unreachableNonGoalRooms, total.rooms]).toEqual([7232, 209, 7441]);
    expect(total.router).toEqual({
      edges: 8775, multi: 1941, placedFirst: 1769, rerouted: 32, unresolvable: 140, tries: 4265, baseCells: 4630, extraCells: 62,
      firstHopChanged: 17, lastHopChanged: 0, unresolvableIds: 140,
    });
```

with:

```js
  it('pins the measured routed numbers', () => {
    // #906 (unreachable detours dropped; 155 fewer reseeds, so many dungeons are a different accepted candidate): was
    // [8557, 1704, 171], [1466, 250], [1171, 483, 1288], [7232, 209, 7441]; router edges 8775, multi 1941,
    // placedFirst 1769, rerouted 32, unresolvable 140, tries 4265, baseCells 4630, extraCells 62, firstHopChanged 17.
    expect([total.realEdges, total.baseDead, total.baseFoundDead]).toEqual([8558, 1723, 173]);
    expect([total.stubs, total.walls]).toEqual([1495, 242]);
    expect([total.roomsWith2PlusLiveExits, total.dungeonsWith2Plus, total.deadEndRooms]).toEqual([1190, 484, 1312]);
    expect([total.reachableRooms, total.unreachableNonGoalRooms, total.rooms]).toEqual([7225, 216, 7441]);
    expect(total.router).toEqual({
      edges: 8751, multi: 1973, placedFirst: 1797, rerouted: 34, unresolvable: 142, tries: 4414, baseCells: 4677, extraCells: 68,
      firstHopChanged: 20, lastHopChanged: 0, unresolvableIds: 142,
    });
```

#### `tests/dungeon-router-pipeline.test.mjs`

Replace:

```js
    // #861: dead-end stub corridor tiles now use the openings-based piece rule (end/mid instead of the closed 'single'),
    // so the tiles digest moved (was e3123cd8...); the walls digest is byte-identical.
    expect({ walls: walls.digest('hex'), tiles: tiles.digest('hex') }).toEqual({ walls: 'c69fe85b77e393200a6ee0e885861e4c5eff61590a5310decc25119b9aecdbc0', tiles: '3dcc98a0499a692844f4c590676fb42b777b59d2e4106e4cfb8ef689066a4578' });
```

with:

```js
    // #861: dead-end stub corridor tiles now use the openings-based piece rule (end/mid instead of the closed 'single'),
    // so the tiles digest moved (was e3123cd8...); the walls digest is byte-identical.
    // #906 re-pin (deliberate, layout-level): every NEW v3 layout drops the detour rooms no corridor can reach, with or
    // without the routing flag; this digest hashes the layout itself (was walls c69fe85b..., tiles 3dcc98a0...).
    // A persisted run keeps its stored layout, so no existing run moves.
    expect({ walls: walls.digest('hex'), tiles: tiles.digest('hex') }).toEqual({ walls: '53e9f60d3f9ea70b4f82226f919fffefbf7d98749a1d4fae6ff1a695131b5710', tiles: '654348b88ad963fa0d04f7e44b9e3b7ff778f26e10e5192c8781c5afa5b9a802' });
```

#### `tests/dungeon-scene-sealed-edges.test.mjs`

Replace (1):

```js
const V3_SEALED_GATE_HELD = 460; // null path because a co-parent holds the gate cell: the dominant cause
```

with:

```js
const V3_SEALED_GATE_HELD = 443; // null path because a co-parent holds the gate cell: the dominant cause (#906: 460 -> 443)
```

Replace (2):

```js
    expect(withEnclosure).toBe(197);
```

with:

```js
    expect(withEnclosure).toBe(154); // #906: 197 -> 154
```

Replace (3):

```js
    // Base seeds: only ~41% are scene-valid under "null-path fallback = dead edge".
    expect(t.baseSceneValid).toBeLessThan(BASES * 0.45);
```

with:

```js
    // Base seeds: only ~47% (237/500) are scene-valid under "null-path fallback = dead edge" (#906: was ~41%, under 225).
    expect(t.baseSceneValid).toBe(237);
```

Replace (4):

```js
const NO_STUB_500 = { sealedDoors: 1294, sealedRealEdges: 1250, gateHeld: 1106, sole: 18, unreachableRooms: 335, dungeons: 58, goalUnreachable: 32 };
```

with:

```js
// #906 (unreachable detours dropped): was sealedDoors 1294, sealedRealEdges 1250, gateHeld 1106, sole 18, unreachableRooms 335,
// dungeons 58, goalUnreachable 32.
const NO_STUB_500 = { sealedDoors: 1218, sealedRealEdges: 1176, gateHeld: 1055, sole: 16, unreachableRooms: 261, dungeons: 53, goalUnreachable: 23 };
```

#### `tests/dungeon-sealed-door-causes.test.mjs`

Replace (1):

```js
    expect(causeCounts).toEqual({ sealedDoor: 1133, wallCut: 569 });
    expect(total).toBe(1133);
    // The scene draws a fallback line for 1,123 of them (path = what the SCENE draws, router verdict included).
    expect(tbl.path).toEqual({ 'null/gateHeld': 1040, 'null/routerUnresolvable': 83, 'found/adjacent': 10 });
    expect(tbl.incoming).toEqual({ 'merge(2+)': 1064, single: 69 });
    expect(tbl.doorsCovered).toEqual({ rev: 1131, 'out+rev': 1, out: 1 });
```

with:

```js
    // #906 (unreachable detours dropped): sealedDoor 1133 -> 1129, wallCut 569 -> 592.
    expect(causeCounts).toEqual({ sealedDoor: 1129, wallCut: 592 });
    expect(total).toBe(1129);
    // The scene draws a fallback line for 1,117 of them (path = what the SCENE draws, router verdict included).
    // #906: was 1040 / 83 / 10.
    expect(tbl.path).toEqual({ 'null/gateHeld': 1035, 'null/routerUnresolvable': 82, 'found/adjacent': 12 });
    expect(tbl.incoming).toEqual({ 'merge(2+)': 1061, single: 68 }); // #906: was 1064 / 69
    expect(tbl.doorsCovered).toEqual({ rev: 1128, out: 1 }); // #906: was rev 1131, out+rev 1, out 1
```

Replace (2):

```js
['dr2 dc- in-north']).toBe(984);
```

with:

```js
['dr2 dc- in-north']).toBe(986); // #906: was 984
```

Replace (3):

```js
    expect(tbl.coverKinds).toEqual({
      cellMargin: 803, plainFlank: 143, transitMargin: 69, 'cellMargin+plainFlank': 95, 'plainFlank+transitMargin': 23,
    });
    // Whose wall covers it: always the co-parent's own cell margin, a foreign transit cell, or an unflagged corridor flank.
    expect(tbl['cover(kind:relation)']).toEqual({
      'cellMargin:coParent': 803, 'plainFlank:plain': 143, 'transitMargin:foreign': 69, 'cellMargin:coParent|plainFlank:plain': 95,
      'plainFlank:plain|transitMargin:foreign': 23,
    });
```

with:

```js
    // #906: was cellMargin 803, plainFlank 143, transitMargin 69, cellMargin+plainFlank 95, plainFlank+transitMargin 23.
    expect(tbl.coverKinds).toEqual({
      cellMargin: 778, plainFlank: 155, transitMargin: 64, 'cellMargin+plainFlank': 107, 'plainFlank+transitMargin': 25,
    });
    // Whose wall covers it: always the co-parent's own cell margin, a foreign transit cell, or an unflagged corridor flank.
    expect(tbl['cover(kind:relation)']).toEqual({
      'cellMargin:coParent': 778, 'plainFlank:plain': 155, 'transitMargin:foreign': 64, 'cellMargin:coParent|plainFlank:plain': 107,
      'plainFlank:plain|transitMargin:foreign': 25,
    });
```

Replace (4):

```js
    expect([t['null/gateHeld total'], t['null/other total'], t['found total']]).toEqual([1040, 83, 10]);
```

with:

```js
    expect([t['null/gateHeld total'], t['null/other total'], t['found total']]).toEqual([1035, 82, 12]); // #906: was 1040/83/10
```

Replace (5):

```js
    expect(t['null/gateHeld -> wallCut']).toBe(1039);
    // The corridor behind the door still crosses 4+ walls for 1,036 of the gate-held ones.
    expect(t['null/gateHeld cut by 4+ wall(s)']).toBe(1036);
```

with:

```js
    expect(t['null/gateHeld -> wallCut']).toBe(1034); // #906: was 1039
    // The corridor behind the door still crosses 4+ walls for 1,033 of the gate-held ones (#906: was 1,036).
    expect(t['null/gateHeld cut by 4+ wall(s)']).toBe(1033);
```

Replace (6):

```js
    expect(u['status quo (all union-dead edges dropped)']).toEqual({ branching: 1164, exits: 6628, reached: 7128, dead: 1704, deadEnds: 1293 });
    expect(u['sealed-door edges live again']).toEqual({ branching: 1205, exits: 7769, reached: 7342, dead: 571, deadEnds: 433 });
    expect(u['nothing dead (graph upper bound)']).toEqual({ branching: 1241, exits: 8367, reached: 7441, dead: 0, deadEnds: 0 });
```

with:

```js
    // #906: was { 1164, 6628, 7128, 1704, 1293 }, { 1205, 7769, 7342, 571, 433 }, { 1241, 8367, 7441, 0, 0 }.
    expect(u['status quo (all union-dead edges dropped)']).toEqual({ branching: 1182, exits: 6616, reached: 7116, dead: 1723, deadEnds: 1316 });
    expect(u['sealed-door edges live again']).toEqual({ branching: 1225, exits: 7770, reached: 7338, dead: 594, deadEnds: 453 });
    expect(u['nothing dead (graph upper bound)']).toEqual({ branching: 1262, exits: 8395, reached: 7441, dead: 0, deadEnds: 0 });
```

#### `tests/dungeon-stub-oracle-aware.test.mjs`

Replace:

```js
    expect(none.sealedDoors).toBe(1294);
    expect([none.opt.goal, none.opt.dungeons]).toEqual([32, 58]);
    expect([cur.opt.goal, cur.opt.dungeons]).toEqual([26, 58]);
    // The 5 "extra" goal losses are the net of many losses and gains (churn); under strict nothing is lost.
    expect(churn.goalLost).toBe(23);
    expect(churn.goalGained).toBe(29);
```

with:

```js
    // #906 (unreachable detours dropped): was 1294, [32, 58], [26, 58], churn lost 23 / gained 29.
    expect(none.sealedDoors).toBe(1218);
    expect([none.opt.goal, none.opt.dungeons]).toEqual([23, 53]);
    expect([cur.opt.goal, cur.opt.dungeons]).toEqual([19, 50]);
    // The "extra" goal losses are the net of many losses and gains (churn); under strict nothing is lost.
    expect(churn.goalLost).toBe(17);
    expect(churn.goalGained).toBe(21);
```

#### `tests/dungeon-stub-union-sweep.test.mjs`

Replace:

```js
    expect([t.stubs, t.stubDungeons, t.maxStubs, t.soleChildStubs]).toEqual([1280, 457, 8, 1259]);
    expect(t.droppedByVerify).toBe(15);
    expect([t.sealedBefore, t.sealedAfter]).toEqual([1294, 4]);
    expect([t.deadBefore, t.deadAfter, t.deadDungeonsBefore, t.deadDungeonsAfter]).toEqual([2556, 0, 490, 0]);
    expect([t.unreachRoomsBefore, t.unreachRoomsAfter, t.goalLostBefore, t.goalLostAfter]).toEqual([2305, 2259, 271, 266]);
```

with:

```js
    // #906 (unreachable detours dropped): was [1280, 457, 8, 1259], 15, [1294, 4], [2556, 0, 490, 0],
    // [2305, 2259, 271, 266]. Fewer dead edges in, fewer walls out (tests/dungeon-walled-sweep.test.mjs), more of them stubs.
    expect([t.stubs, t.stubDungeons, t.maxStubs, t.soleChildStubs]).toEqual([1339, 463, 8, 1318]);
    expect(t.droppedByVerify).toBe(11);
    expect([t.sealedBefore, t.sealedAfter]).toEqual([1218, 4]);
    expect([t.deadBefore, t.deadAfter, t.deadDungeonsBefore, t.deadDungeonsAfter]).toEqual([2481, 0, 490, 0]);
    expect([t.unreachRoomsBefore, t.unreachRoomsAfter, t.goalLostBefore, t.goalLostAfter]).toEqual([2124, 2075, 245, 240]);
```

#### `tests/dungeon-walled-sweep.test.mjs`

Replace (1):

```js
    expect([t.walled, t.walledDungeons, t.maxWalled, t.lostFlagged]).toEqual([1270, 313, 15, 1]);
```

with:

```js
    // #906 (unreachable detours dropped): 1270 walls in 313 dungeons -> 1145 in 292.
    expect([t.walled, t.walledDungeons, t.maxWalled, t.lostFlagged]).toEqual([1145, 292, 15, 1]);
```

Replace (2):

```js
      .toEqual([19, 0, 4676, 1227, 0, 0]);
    expect([t.unreachBefore, t.unreachAfter, t.goalLostBefore, t.goalLostAfter]).toEqual([2305, 2259, 271, 266]);
```

with:

```js
      // #906: tiles inside a room 4676 -> 3922 (shipped) / 1227 -> 1099 (walled): the dropped detours' fallback lines.
      .toEqual([19, 0, 3922, 1099, 0, 0]);
    expect([t.unreachBefore, t.unreachAfter, t.goalLostBefore, t.goalLostAfter]).toEqual([2124, 2075, 245, 240]); // #906: was 2305/2259/271/266
```

- [x] **Step 3: Run the full suite**

Run: `npx vitest run`
Expected: `Test Files  161 passed (161)`, `Tests  8762 passed | 1 todo (8763)`

- [x] **Step 4: Commit**

```bash
git add tests/dungeon-corridor-joins-sweep.test.mjs tests/dungeon-goal-reseed.test.mjs tests/dungeon-layout-buildability.test.mjs   tests/dungeon-layout-stubs-sweep.test.mjs tests/dungeon-reseed-sweep.test.mjs tests/dungeon-reseed.test.mjs   tests/dungeon-router-pipeline-sweep.test.mjs tests/dungeon-router-pipeline.test.mjs tests/dungeon-scene-sealed-edges.test.mjs   tests/dungeon-sealed-door-causes.test.mjs tests/dungeon-stub-oracle-aware.test.mjs tests/dungeon-stub-union-sweep.test.mjs   tests/dungeon-walled-sweep.test.mjs
git commit -m "#906: re-pin the ratchets the detour drop moves (measured; old values recorded)"
```

### Task 4: Version bump and import-graph check

**Files:**
- Modify: `module.json` (`version`)

**Interfaces:**
- Consumes: Tasks 1-3 committed.
- Produces: the release version.

- [ ] **Step 1: Pick an unused version**

Run: `git fetch origin && git show origin/main:module.json | grep '"version"' && gh pr list --state open --json number,title,headRefName --limit 50`
Then for each open PR that touches `module.json`, run `gh pr diff <n> -- module.json`. Take the highest version among `origin/main` and the open PRs. It was `0.80.6` on `origin/main` when this plan was written. Use the next patch version (for example `0.80.7` if `0.80.6` is still the highest). Never reuse one.

- [ ] **Step 2: Bump it**

In `module.json` change `"version": "<current>"` to `"version": "<next patch>"`. If `origin/main` moved, rebase onto it first (`git rebase origin/main`) and re-run `npx vitest run`, since a newer main can move the ratchets again.

- [ ] **Step 3: Confirm no import edge changed**

Run: `npm run architecture:graph > /tmp/arch-906.txt && git diff --stat`
Expected: only `module.json` is changed by this task. The generated graph is file-level, and Tasks 1-3 add no new `scripts/` -> `scripts/` import edge, so `docs/architecture.md` needs no refresh. If the generator output differs from the Mermaid block in `docs/architecture.md`, run the `update-architecture-docs` skill instead of skipping it.

- [ ] **Step 4: Commit**

```bash
git add module.json
git commit -m "#906: bump version to <next patch>"
```

### Task 5 (agent-run, optional): relay-based live generation check

No human is needed. This runs only if the relay is configured (`.env` copied into the worktree). Use the `foundry-rest` skill for the connection and its script-filter caveats.

**Files:** none (read-only against the live world).

**Interfaces:**
- Consumes: the deployed module at the Task 4 version.
- Produces: a terse comment on #906 with the numbers.

- [ ] **Step 1: Confirm the live world runs this version**

Check `game.modules.get('pf2e-dungeon-crawl').version` against `module.json`. If it differs, stop: the world has not picked up the deploy (see the memory note on module-discovery races). That is not a code bug.

- [ ] **Step 2: Generate fresh layouts in the live module and check them**

Through the relay, run a script that imports the deployed `scripts/dungeon-reseed.mjs` and `scripts/dungeon-layout.mjs` (module path `modules/pf2e-dungeon-crawl/scripts/...`), and for `i` in 0..99 calls `chooseRunLayout({ generator: <dungeon-deck module>, seed: 'sweep-' + i, roomCount: 6 + (i % 15), topologyRouting: true })`. Do not start a run or build a scene. Return the number of chosen layouts for which `unreachableDetourIds({ positionByRoomId: L.layoutPositionByRoomId, layoutEdges: L.layoutEdges, hiddenRooms: L.hiddenRooms, hiddenIncomingByRoomId: L.hiddenIncomingByRoomId })` is non-empty.
Expected: 0. On `main` before this change it is 16 of 500 chosen routed layouts (for example sweep-163 `room-detour-1` and sweep-239~r1 `room-detour-0`).

- [ ] **Step 3: Record the result on the issue**

Run `gh issue comment 906 --body "Live relay check (vX.Y.Z): 0/100 chosen layouts with an unreachable detour (main before: 16/500)."`. Leave the lifecycle labels to the session that owns the issue.

---

## Self-Review

1. **Spec coverage.** Direction 2 says "don't give a column-0 detour a west face when no west-side approach is reachable, or place it elsewhere". The face part is shown to be a no-op: north is equally unreachable, a face-only prototype cleared 0/11 seeds, and Task 1's "north is no alternative" test pins this. The placement part was prototyped and regresses ratchets (OPEN QUESTION, item 2). The plan therefore implements the remaining way to avoid producing the layout, dropping the detour, and flags the content cost for owner approval. The #877 target (101 -> 0) and the #860 `otherRoom` target (12 -> 0) are Task 2. Every moved ratchet is re-pinned to measured numbers in Tasks 2-3. The version bump is Task 4, and the architecture-docs check is Task 4 Step 3 (no edge change). The stub-oracle approach is excluded in Global Constraints. The relay-based check is Task 5.
2. **Placeholder scan.** Every code step has the full code. Every re-pin has its exact old and new text. The version is the only value chosen at execution time, by an exact procedure (Task 4 Step 1), because open PRs can take numbers first.
3. **Type consistency.** `placeLayoutGraph` returns `positionByRoomId`, which `computeRunLayout` renames to `layoutPositionByRoomId` and `buildSweepLayout` to `pos`. `unreachableDetourIds` takes the same key names that `placeLayoutGraph` returns, so `unreachableDetourIds(placed)` works directly (Task 1 test). `hiddenRooms` is a Set from `attachHiddenPaths` and `withoutDetours`, and an array from `computeRunLayout`. `unreachableDetourIds` spreads it, so both work.
4. **Review Focus.** Each line has its test: the fixed-point loop (Task 1, `[56, 2]`), the reachable-detour survival (Task 1 byte-equality, Task 2 seed-10 repro), v1/v2 unchanged (Task 2 Step 5, plus the digests listed as must-not-move in Task 3), `maxCol` (Task 2 test), and graph consistency (Task 1 `withoutDetours` test, Task 2 sweep-81 asserts).
