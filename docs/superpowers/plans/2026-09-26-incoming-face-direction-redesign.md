# Incoming-Face Direction Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a room's incoming connection land on its west face (not just north) when north is blocked by an unrelated room, dropping the rate of structurally boxed-in corridor edges from 31.3% to ~7.9% (the remainder tracked separately as #196), without introducing a new invisible-corridor failure mode.

**Architecture:** A new pure function, `incomingFaceFor`, chooses each room's incoming face once during the existing full-layout precompute pass (before any room's walls are built), based purely on whether that room's north-neighbor or west-neighbor grid cell is free (or occupied only by that room's own real parent(s)/hidden source). That single per-room choice threads through four already-identified layers: wall/door geometry (`roomEnclosureWalls`, `northDoorSlots`→`doorSlotsForFace`, `exitFaceForIndex`), corridor endpoint geometry (`buildEdgeCorridor`, gaining a mirrored west-incoming fast path), pathfinding (`findCorridorPath`'s `canEnter`), and PRNG seed derivation (`doorOffsetAt`'s incoming-offset seed key). Task 6's unsound `trunkLaneCorridorSegments` "safe lane" hack is removed and replaced with the original, honest pre-Task-6 direct-line fallback for whatever boxed-in residual remains.

**Tech Stack:** Vanilla JS (ESM), Vitest for pure-logic tests, Foundry VTT client APIs (untested directly, verified via live verification per this codebase's existing convention).

**Spec:** `docs/superpowers/specs/2026-09-26-incoming-face-direction-redesign-design.md`

## Global Constraints

- Corridors stay orthogonal only (north/south/east/west) — no diagonal routing.
- `computeRanks`/`computeColumns` are unchanged — this redesign works with whatever layout they already produce.
- A room's incoming face is single-valued: all of a room's incoming connections (multiple real parents for a merge room, plus a hidden detour source) subdivide the *same* chosen face, exactly like today's `northDoorSlots` subdivides north.
- Every new/changed pure function must be deterministic for a given seed — same seed, same output, every time.
- For any room whose incoming face is (and stays) `'north'`, every affected function must produce **byte-identical** output to today's pre-redesign behavior — this redesign must be provably a no-op for the majority case, not just "probably fine."
- The #110 fog-leak-avoidance ordering applies to every wall this plan touches: create the new real wall(s) before deleting whatever frontier placeholder they supersede, never the reverse.
- A room always anchors at its own cell's top-left corner (`roomRect`, unchanged) — north and west edges always coincide with the cell's own north/west edges; only east and south can ever have unused margin. This redesign relies on that property (it's *why* west is a safe second choice for incoming) but does not change it.

## Review Focus

- **A merge room with 2+ real parents, at least one of which legitimately sits at the room's own north-neighbor (or west-neighbor) position.** `incomingFaceFor`'s "occupied only by my own real parent" exclusion must not misfire and treat a legitimate parent as a blocker, which would wrongly push the room to a worse-fit face or the boxed-in fallback.
- **A room whose incoming face becomes `'west'` and which *also* has real outgoing children.** `exitFaceForIndex`'s candidate set must correctly exclude `'west'` and offer `'north'` instead for that room's own outgoing connections, with zero collision between the room's own incoming and outgoing faces.
- **The `slotWidth`/`slotSpan` axis trap in `buildEdgeCorridor`**: a west-facing door slot has `x1 === x2` (constant) and `y1 !== y2` (the span), the opposite of a north-facing slot. Any code that still computes `toSlot.x2 - toSlot.x1` unconditionally for a west-incoming target will silently get zero instead of the real slot width — this must be caught by TDD, not discovered live.
- **A room whose incoming face is (and stays) `'north'`** must see *zero* behavioral change anywhere in the pipeline — this is the regression risk of touching four already-shipped, already-reviewed layers to add one new case.
- **The post-redesign boxed-in rate** must be re-measured against the same 500-seed sweep Task 6 (the prior plan) used, and must land at or below the ~7.9% this design predicts — a higher number means a real logic gap, not just an acceptable residual.

---

## Task 1: `incomingFaceFor` and `doorSlotsForFace` (pure helpers)

**Files:**
- Modify: `scripts/dungeon-layout.mjs`
- Test: `tests/dungeon-layout.test.mjs`

**Interfaces:**
- Consumes: nothing new — pure functions of already-existing data shapes (`positionByRoomId`, `occupiedCells`, both already used elsewhere in this file in this exact shape).
- Produces: `incomingFaceFor(roomId, positionByRoomId, occupiedCells, legitimateSourceIds)` → `'north' | 'west'`. `doorSlotsForFace(rect, count, face)` → `{x1,y1,x2,y2}[]`, replacing `northDoorSlots` (deleted in this task — Task 2 onward update every call site).

- [ ] **Step 1: Write the failing tests**

```js
describe('incomingFaceFor', () => {
  it('returns north when the north-neighbor cell is empty', () => {
    const positionByRoomId = { r: { rank: 1, col: 1 } };
    expect(incomingFaceFor('r', positionByRoomId, {}, new Set())).toBe('north');
  });

  it('returns north when the north-neighbor cell is occupied only by a real parent', () => {
    const positionByRoomId = { r: { rank: 1, col: 1 }, p: { rank: 0, col: 1 } };
    const occupiedCells = { '0,1': 'p' };
    expect(incomingFaceFor('r', positionByRoomId, occupiedCells, new Set(['p']))).toBe('north');
  });

  it('falls back to west when north is blocked by an unrelated room but west is free', () => {
    const positionByRoomId = { r: { rank: 1, col: 1 }, blocker: { rank: 0, col: 1 } };
    const occupiedCells = { '0,1': 'blocker' };
    expect(incomingFaceFor('r', positionByRoomId, occupiedCells, new Set())).toBe('west');
  });

  it('falls back to west when north is blocked by an unrelated room, even if west is occupied by a legitimate parent', () => {
    const positionByRoomId = { r: { rank: 1, col: 1 }, blocker: { rank: 0, col: 1 }, p: { rank: 1, col: 0 } };
    const occupiedCells = { '0,1': 'blocker', '1,0': 'p' };
    expect(incomingFaceFor('r', positionByRoomId, occupiedCells, new Set(['p']))).toBe('west');
  });

  it('returns north (the documented residual-case tiebreak) when both north and west are blocked by unrelated rooms', () => {
    const positionByRoomId = { r: { rank: 1, col: 1 }, blockerN: { rank: 0, col: 1 }, blockerW: { rank: 1, col: 0 } };
    const occupiedCells = { '0,1': 'blockerN', '1,0': 'blockerW' };
    expect(incomingFaceFor('r', positionByRoomId, occupiedCells, new Set())).toBe('north');
  });

  it('correctly excludes multiple real parents for a merge room', () => {
    // Both p1 (north-neighbor) and p2 (elsewhere entirely) are this
    // room's own real parents — p1 sitting at the north-neighbor
    // position must not count as blocking.
    const positionByRoomId = { r: { rank: 2, col: 1 }, p1: { rank: 1, col: 1 }, p2: { rank: 0, col: 3 } };
    const occupiedCells = { '1,1': 'p1', '0,3': 'p2' };
    expect(incomingFaceFor('r', positionByRoomId, occupiedCells, new Set(['p1', 'p2']))).toBe('north');
  });
});

describe('doorSlotsForFace', () => {
  it('produces byte-identical output to the old northDoorSlots for face="north"', () => {
    const rect = { gx: 300, gy: 26, gw: 12, gh: 12 };
    expect(doorSlotsForFace(rect, 3, 'north')).toEqual([
      { x1: 300, y1: 26, x2: 304, y2: 26 },
      { x1: 304, y1: 26, x2: 308, y2: 26 },
      { x1: 308, y1: 26, x2: 312, y2: 26 },
    ]);
  });

  it('divides the west edge along height for face="west"', () => {
    const rect = { gx: 300, gy: 26, gw: 12, gh: 12 };
    expect(doorSlotsForFace(rect, 3, 'west')).toEqual([
      { x1: 300, y1: 26, x2: 300, y2: 30 },
      { x1: 300, y1: 30, x2: 300, y2: 34 },
      { x1: 300, y1: 34, x2: 300, y2: 38 },
    ]);
  });

  it('single slot spans the whole face, either orientation', () => {
    const rect = { gx: 300, gy: 26, gw: 6, gh: 6 };
    expect(doorSlotsForFace(rect, 1, 'north')).toEqual([{ x1: 300, y1: 26, x2: 306, y2: 26 }]);
    expect(doorSlotsForFace(rect, 1, 'west')).toEqual([{ x1: 300, y1: 26, x2: 300, y2: 32 }]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/dungeon-layout.test.mjs -t "incomingFaceFor|doorSlotsForFace"`
Expected: FAIL with "incomingFaceFor is not defined" / "doorSlotsForFace is not defined"

- [ ] **Step 3: Implement**

Add to `scripts/dungeon-layout.mjs`, near `parentRoomIdsFor`/`incomingConnectionsFor` (they're conceptually related):

```js
/**
 * Which compass face `roomId` should receive its incoming connection(s)
 * on — 'north' (today's only option, unchanged for the common case) or
 * 'west' as a fallback, chosen once per room from the fully precomputed
 * layout (every room's rank/col is already known before any room is
 * built). `legitimateSourceIds` is the set of this room's own real
 * parents (`parentRoomIdsFor`) plus its hidden detour source, if any —
 * one of THOSE occupying a candidate neighbor cell is the normal,
 * expected "parent directly above/beside" shape, not a blocker.
 *
 * North and west are the only two candidates because they're the only
 * two structurally marginless faces (a room always anchors at its own
 * cell's top-left corner, so north/west always coincide with the cell's
 * own edges regardless of room size) — neither ever needs new
 * margin-gap-coordination logic (`cellMarginWalls` stays scoped to
 * east/south only, unchanged).
 *
 * Returns 'north' for the residual case where BOTH neighbors are
 * occupied by an unrelated room (#196, not solved here) — the caller's
 * existing "no free path" fallback already handles this gracefully.
 */
export function incomingFaceFor(roomId, positionByRoomId, occupiedCells, legitimateSourceIds) {
  const pos = positionByRoomId[roomId];
  // A room's own id is never the occupant of a NEIGHBOR cell (each cell
  // holds at most one room, and a neighbor is by definition a different
  // cell) — the only exclusions that matter are this room's own real
  // parents/hidden source, which legitimately DO occupy an adjacent
  // cell in the common "parent directly above/beside" case.
  const isFreeOrLegitimate = (rank, col) => {
    const occupant = occupiedCells[`${rank},${col}`];
    return occupant == null || legitimateSourceIds.has(occupant);
  };
  if (isFreeOrLegitimate(pos.rank - 1, pos.col)) return 'north';
  if (isFreeOrLegitimate(pos.rank, pos.col - 1)) return 'west';
  return 'north';
}

/**
 * Divides a room's incoming face into `count` equal, contiguous door
 * slots, left-to-right (`face === 'north'`) or top-to-bottom
 * (`face === 'west'`). Replaces the old `northDoorSlots` (single-face
 * version) now that incoming can land on either of a room's two
 * marginless faces (`incomingFaceFor`) — `face === 'north'` produces
 * byte-identical output to the old function for the same inputs.
 */
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

Delete `northDoorSlots` entirely — Task 2 updates its only call site (`dungeon-scene.mjs`) to use `doorSlotsForFace` instead, in the same commit sequence, so there's no dangling reference between tasks. Update this file's own docblock references to `northDoorSlots` (e.g. `buildEdgeCorridor`'s docblock) to say `doorSlotsForFace` instead.

**Note for the implementer:** `incomingFaceFor` does not itself decide *when* it's called or how `occupiedCells`/`legitimateSourceIds` are built — that's Task 6's integration job. This task is pure, isolated, and testable without touching any other file.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/dungeon-layout.test.mjs -t "incomingFaceFor|doorSlotsForFace"`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add scripts/dungeon-layout.mjs tests/dungeon-layout.test.mjs
git commit -m "feat: add incomingFaceFor and doorSlotsForFace (north-or-west incoming choice)"
```

---

## Task 2: Generalize `exitFaceForIndex` and update its call sites

**Files:**
- Modify: `scripts/dungeon-layout.mjs`, `scripts/dungeon-scene.mjs`
- Test: `tests/dungeon-layout.test.mjs`

**Interfaces:**
- Consumes: nothing new.
- Produces: `exitFaceForIndex(index, incomingFace = 'north')` → `'south' | 'east' | 'west' | 'north'` (a room's Nth outgoing face, excluding whichever face is its own `incomingFace`).

- [ ] **Step 1: Write the failing tests**

```js
describe('exitFaceForIndex', () => {
  it('defaults to north-incoming behavior, byte-identical to before this change', () => {
    expect(exitFaceForIndex(0)).toBe('south');
    expect(exitFaceForIndex(1)).toBe('east');
    expect(exitFaceForIndex(2)).toBe('west');
  });

  it('produces the same result when incomingFace is explicitly north', () => {
    expect(exitFaceForIndex(0, 'north')).toBe('south');
    expect(exitFaceForIndex(1, 'north')).toBe('east');
    expect(exitFaceForIndex(2, 'north')).toBe('west');
  });

  it('excludes west and offers north instead when incomingFace is west', () => {
    expect(exitFaceForIndex(0, 'west')).toBe('south');
    expect(exitFaceForIndex(1, 'west')).toBe('east');
    expect(exitFaceForIndex(2, 'west')).toBe('north');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/dungeon-layout.test.mjs -t "exitFaceForIndex"`
Expected: FAIL (third test only — the first two already pass against the old signature, since an extra unused argument doesn't break a plain array lookup; this is fine, the third one is the real new-behavior assertion)

- [ ] **Step 3: Implement**

```js
const OUTGOING_CANDIDATES = {
  north: ['south', 'east', 'west'], // byte-identical to today's literal array
  west: ['south', 'east', 'north'],
};

/** Deterministic compass face for a room's Nth exit (0-2), always
 * distinct from its own incoming face (`incomingFaceFor`) — 'north' by
 * default, preserving every existing call site's exact behavior. */
export function exitFaceForIndex(index, incomingFace = 'north') {
  return OUTGOING_CANDIDATES[incomingFace][index];
}
```

Update every call site in `scripts/dungeon-scene.mjs` to pass the *acting* room's own incoming face:

- `buildRoomAtGraphNode` (lines ~311, 313, 320-321): these compute `roomId`'s own outgoing faces — pass `roomId`'s own incoming face. This task adds a new `incomingFace` parameter to `buildRoomAtGraphNode`'s own options object (Task 6 wires the real value through from `state`; for this task, thread the parameter through with a `'north'` default so nothing breaks before Task 6 lands):
  ```js
  // buildRoomAtGraphNode's destructured options gains:
  incomingFace = 'north',
  // ...
  const realOutgoingFaces = isGoal ? [] : childIds.map((_, i) => exitFaceForIndex(i, incomingFace));
  const outgoingFaces = hiddenChildId ? [...realOutgoingFaces, exitFaceForIndex(hiddenFaceIndex, incomingFace)] : realOutgoingFaces;
  const childIdByFace = {};
  childIds.forEach((id, i) => { childIdByFace[exitFaceForIndex(i, incomingFace)] = id; });
  if (hiddenChildId) childIdByFace[exitFaceForIndex(hiddenFaceIndex, incomingFace)] = hiddenChildId;
  ```
- `buildPopulateAndUnlockGraphNode` (lines ~1072-1074): this computes the *source* room's own outgoing face (`exitFaceFromSource`) — pass the **source's** own incoming face, not the target's:
  ```js
  const sourceIncomingFace = state.incomingFaceByRoomId?.[sourceId] ?? 'north'; // Task 6 populates incomingFaceByRoomId; default keeps this task's own tests passing standalone
  const exitFaceFromSource = hidden
    ? exitFaceForIndex(sourceChildIds.length, sourceIncomingFace)
    : exitFaceForIndex(sourceChildIds.indexOf(room.id), sourceIncomingFace);
  ```

**Note for the implementer:** do not wire `state.incomingFaceByRoomId` itself yet — Task 6 owns that. This task's job is only to make every `exitFaceForIndex` call site *capable* of passing a non-default `incomingFace`, defaulting to `'north'` everywhere so behavior is unchanged until Task 6 actually populates real values.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/dungeon-layout.test.mjs -t "exitFaceForIndex"`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add scripts/dungeon-layout.mjs scripts/dungeon-scene.mjs tests/dungeon-layout.test.mjs
git commit -m "feat: generalize exitFaceForIndex to exclude an arbitrary incoming face"
```

---

## Task 3: Generalize `roomEnclosureWalls` for a non-north incoming face

**Files:**
- Modify: `scripts/dungeon-layout.mjs`, `scripts/dungeon-scene.mjs`
- Test: `tests/dungeon-layout.test.mjs`

**Interfaces:**
- Consumes: nothing new.
- Produces: `roomEnclosureWalls(seed, roomId, { incomingCount, incomingFace = 'north', outgoingFaces }, rect)` — the `incomingCount === 0` solid-wall branch and the "leave open for door-carving" branch both target `incomingFace` instead of the literal `'north'`.

- [ ] **Step 1: Write the failing tests**

```js
describe('roomEnclosureWalls with incomingFace', () => {
  const rect = { gx: 300, gy: 26, gw: 12, gh: 12 };

  it('defaults to north, byte-identical to before this change', () => {
    const walls = roomEnclosureWalls('seed1', 'r', { incomingCount: 1, outgoingFaces: ['south'] }, rect);
    expect(walls.map((w) => w.dir).sort()).toEqual(['east', 'west']);
  });

  it('leaves the west face open (not north) when incomingFace is west', () => {
    const walls = roomEnclosureWalls('seed1', 'r', { incomingCount: 1, incomingFace: 'west', outgoingFaces: ['south'] }, rect);
    expect(walls.map((w) => w.dir).sort()).toEqual(['east', 'north']);
  });

  it('the entry room (incomingCount 0) still gets a solid wall on its own incoming face, even when that face is west', () => {
    const walls = roomEnclosureWalls('seed1', 'r', { incomingCount: 0, incomingFace: 'west', outgoingFaces: ['south', 'east'] }, rect);
    expect(walls.map((w) => w.dir).sort()).toEqual(['north', 'west']);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/dungeon-layout.test.mjs -t "roomEnclosureWalls with incomingFace"`
Expected: FAIL (the west-incoming cases; the default case already passes)

- [ ] **Step 3: Implement**

```js
export function roomEnclosureWalls(seed, roomId, { incomingCount = 0, incomingFace = 'north', outgoingFaces = [] }, rect) {
  const sides = roomSidesForRect(rect);
  const walls = [];
  const ALL_FACES = ['north', 'south', 'east', 'west'];
  for (const face of ALL_FACES) {
    if (face === incomingFace) continue;
    if (!outgoingFaces.includes(face)) walls.push({ dir: face, ...sides[face] });
  }
  if (incomingCount === 0) walls.push({ dir: incomingFace, ...sides[incomingFace] });
  return walls;
}
```

Note this is a strict generalization: for `incomingFace === 'north'`, the loop now iterates `['north','south','east','west']` and skips `'north'` explicitly (equivalent to the old `['south','east','west']` literal), and the solid-wall branch targets `sides.north` exactly as before — same output, different code path to get there.

Update `buildRoomAtGraphNode` (`scripts/dungeon-scene.mjs`, ~line 328) to pass `incomingFace` through:
```js
const walls = roomEnclosureWalls(seed, roomId, { incomingCount: incomingConnections.length, incomingFace, outgoingFaces }, rect).map(...)
```
(`incomingFace` here is the parameter Task 2 already added to `buildRoomAtGraphNode`'s own options, defaulting to `'north'`.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/dungeon-layout.test.mjs -t "roomEnclosureWalls"`
Expected: PASS (including every pre-existing `roomEnclosureWalls` test, unchanged)

- [ ] **Step 5: Commit**

```bash
git add scripts/dungeon-layout.mjs scripts/dungeon-scene.mjs tests/dungeon-layout.test.mjs
git commit -m "feat: generalize roomEnclosureWalls to accept a non-north incoming face"
```

---

## Task 4: Generalize `findCorridorPath`'s `canEnter` and thread `incomingFace` through `outgoingMarginOffset`

**Files:**
- Modify: `scripts/dungeon-layout.mjs`
- Test: `tests/dungeon-layout.test.mjs`

**Interfaces:**
- Consumes: nothing new.
- Produces: `findCorridorPath(fromPos, toPos, occupiedCells, { fromRoomId, toRoomId, incomingFace = 'north' })` — the target's incoming-neighbor cell (the only cell allowed to step into it) is now `{rank: toPos.rank - 1, col: toPos.col}` for `'north'` or `{rank: toPos.rank, col: toPos.col - 1}` for `'west'`. `outgoingMarginOffset(seed, fromRoomId, toRoomId, exitFace, fromRect, fromPos, toPos, occupiedCells, incomingFace = 'north')` gains the same trailing parameter, passed through to its own internal `findCorridorPath` call unchanged otherwise.

- [ ] **Step 1: Write the failing tests**

```js
describe('findCorridorPath with incomingFace', () => {
  it('defaults to north-only entry, byte-identical to before this change', () => {
    const occupiedCells = { '1,0': 'blocker' };
    const path = findCorridorPath({ rank: 0, col: 0 }, { rank: 2, col: 0 }, occupiedCells, { fromRoomId: 'a', toRoomId: 'b' });
    expect(path).toBeNull(); // north-neighbor (1,0) is the blocker
  });

  it('allows entry from the west-neighbor when incomingFace is west, even though north is blocked', () => {
    // toPos {rank:2,col:2}; north-neighbor (1,2) is blocked, west-neighbor (2,1) is free.
    const occupiedCells = { '1,2': 'blocker' };
    const path = findCorridorPath(
      { rank: 0, col: 0 }, { rank: 2, col: 2 }, occupiedCells,
      { fromRoomId: 'a', toRoomId: 'b', incomingFace: 'west' },
    );
    expect(path).not.toBeNull();
    expect(path[path.length - 1]).toEqual({ rank: 2, col: 2 });
    expect(path[path.length - 2]).toEqual({ rank: 2, col: 1 }); // must enter from the west-neighbor
  });

  it('still rejects a north approach when incomingFace is west (the target only accepts its own declared face)', () => {
    // toPos {rank:1,col:1}; its west-neighbor (1,0) is blocked, but its
    // north-neighbor (0,1) is free -- must NOT silently accept north
    // just because it's open, since incomingFace says west.
    const occupiedCells = { '1,0': 'blocker' };
    const path = findCorridorPath(
      { rank: 0, col: 1 }, { rank: 1, col: 1 }, occupiedCells,
      { fromRoomId: 'a', toRoomId: 'b', incomingFace: 'west' },
    );
    expect(path).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/dungeon-layout.test.mjs -t "findCorridorPath with incomingFace"`
Expected: FAIL (west-incoming cases)

- [ ] **Step 3: Implement**

```js
export function findCorridorPath(fromPos, toPos, occupiedCells, { fromRoomId, toRoomId, incomingFace = 'north' }) {
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
  // Generalized from #174's own north-only-entry fix: a room's incoming
  // connection lands on whichever face incomingFaceFor chose for it
  // (north or west, both structurally marginless) -- only that ONE
  // neighbor cell may step into the target; every other neighbor treats
  // it as unreachable, same as any blocked cell.
  const incomingNeighbor = incomingFace === 'west'
    ? { rank: toPos.rank, col: toPos.col - 1 }
    : { rank: toPos.rank - 1, col: toPos.col };
  const canEnter = (from, to) => {
    if (to.rank === toPos.rank && to.col === toPos.col) {
      return from.rank === incomingNeighbor.rank && from.col === incomingNeighbor.col;
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

And `outgoingMarginOffset`:

```js
export function outgoingMarginOffset(seed, fromRoomId, toRoomId, exitFace, fromRect, fromPos, toPos, occupiedCells, incomingFace = 'north') {
  if (exitFace !== 'south') {
    return fromRect.gh / 2 - DOOR_WIDTH / 2;
  }
  const sameColumn = fromPos.col === toPos.col;
  const path = sameColumn
    ? findCorridorPath(fromPos, toPos, occupiedCells, { fromRoomId, toRoomId, incomingFace })
    : null;
  const usesOffsetBasedExit = sameColumn && (!path || path.length <= 2);
  return usesOffsetBasedExit
    ? doorOffsetAt(seed, `${fromRoomId}-${exitFace}`, 'outgoing', fromRect.gw)
    : fromRect.gw / 2 - DOOR_WIDTH / 2;
}
```

`outgoingMarginOffset`'s own `incomingFace` parameter is the **child's** (`toRoomId`'s) incoming face — Task 6 threads it from `state.incomingFaceByRoomId[toRoomId]` at its call site in `buildRoomAtGraphNode`'s margin loop. No other change to `outgoingMarginOffset`'s own logic: it still only special-cases `exitFace === 'south'` (north/west are never `marginFaces` candidates regardless of this change, since north and west are both always marginless).

**Note for the implementer:** `outgoingMarginOffset`'s `exitFace !== 'south'` branch already covers east AND west exit faces identically (both center-based) — this task does not add a new branch there, only passes `incomingFace` through to the existing `findCorridorPath` call inside the `'south'` branch.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/dungeon-layout.test.mjs -t "findCorridorPath|outgoingMarginOffset"`
Expected: PASS (every pre-existing test in both describe blocks, plus the 3 new ones)

- [ ] **Step 5: Commit**

```bash
git add scripts/dungeon-layout.mjs tests/dungeon-layout.test.mjs
git commit -m "feat: generalize findCorridorPath's canEnter and outgoingMarginOffset for a west incoming face"
```

---

## Task 5: Generalize `buildEdgeCorridor` for a west-incoming target, remove `trunkLaneCorridorSegments`

**Files:**
- Modify: `scripts/dungeon-layout.mjs`
- Test: `tests/dungeon-layout.test.mjs`

**Interfaces:**
- Consumes: `findCorridorPath` (Task 4, now takes `incomingFace` inside its options object).
- Produces: `buildEdgeCorridor(seed, fromRoomId, toRoomId, fromRect, toRect, fromPos, toPos, exitFace, toSlot, occupiedCells, incomingFace = 'north')` — same return shape (`{doorWall, revealDoorWall, plainWalls, corridorSegments, transitCells}`), now correct for a west-incoming target and reverted to the original (pre-Task-6) direct-line fallback for a null path instead of the unsound `trunkLaneCorridorSegments`.

This is the highest-risk task in this plan — the codebase's own history (Task 3/4 of the prior plan, and this redesign's own predecessor Task 6) shows axis-swap geometry like this reliably needs a real TDD pass, not just careful reading. Write every test below and verify each by hand-tracing the coordinates before trusting green output.

- [ ] **Step 1: Write the failing tests**

```js
describe('buildEdgeCorridor with a west-incoming target', () => {
  const SMALL = ROOM_SIZE_SMALL;
  const smallRect = (rank, col) => {
    const cell = cellBounds(rank, col);
    return { gx: cell.gx, gy: cell.gy, gw: SMALL, gh: SMALL };
  };

  it('same-rank, east-exit fast path: door offsets align, corridor is a single horizontal segment', () => {
    const fromPos = { rank: 0, col: 0 };
    const toPos = { rank: 0, col: 1 };
    const fromRect = smallRect(0, 0);
    const toRect = smallRect(0, 1);
    const toSlot = doorSlotsForFace(toRect, 1, 'west');
    const result = buildEdgeCorridor(
      'seed1', 'a', 'b', fromRect, toRect, fromPos, toPos, 'east', toSlot[0], {}, 'west',
    );
    // doorWall sits on fromRect's own east face (a vertical segment)
    expect(result.doorWall.x1).toBe(fromRect.gx + fromRect.gw);
    expect(result.doorWall.x2).toBe(fromRect.gx + fromRect.gw);
    expect(result.doorWall.y1).not.toBe(result.doorWall.y2); // a real vertical span, not degenerate
    // revealDoorWall sits on toRect's own west face
    expect(result.revealDoorWall.x1).toBe(toRect.gx);
    expect(result.revealDoorWall.x2).toBe(toRect.gx);
    // exactly one horizontal corridor segment spanning between the two rooms
    expect(result.corridorSegments).toHaveLength(1);
    const seg = result.corridorSegments[0];
    expect(seg.gx).toBeCloseTo(fromRect.gx + fromRect.gw, 9);
    expect(seg.gx + seg.gw).toBeCloseTo(toRect.gx, 9);
  });

  it('the corridor segment never overlaps either room\'s own footprint', () => {
    for (let seedIndex = 0; seedIndex < 20; seedIndex += 1) {
      const seed = `sweep-west-${seedIndex}`;
      const fromPos = { rank: 0, col: 0 };
      const toPos = { rank: 0, col: 1 };
      const fromRect = smallRect(0, 0);
      const toRect = smallRect(0, 1);
      const toSlot = doorSlotsForFace(toRect, 1, 'west');
      const { corridorSegments } = buildEdgeCorridor(seed, 'a', 'b', fromRect, toRect, fromPos, toPos, 'east', toSlot[0], {}, 'west');
      for (const seg of corridorSegments) {
        const overlapsFrom = seg.gx < fromRect.gx + fromRect.gw && seg.gx + seg.gw > fromRect.gx && seg.gy < fromRect.gy + fromRect.gh && seg.gy + seg.gh > fromRect.gy;
        const overlapsTo = seg.gx < toRect.gx + toRect.gw && seg.gx + seg.gw > toRect.gx && seg.gy < toRect.gy + toRect.gh && seg.gy + seg.gh > toRect.gy;
        expect(overlapsFrom).toBe(false);
        expect(overlapsTo).toBe(false);
      }
    }
  });

  it('a null path (boxed in, both north and west neighbors occupied) falls back to the honest direct-line degradation, not a trunk-lane hack', () => {
    const fromPos = { rank: 0, col: 0 };
    const toPos = { rank: 2, col: 2 };
    const fromRect = smallRect(0, 0);
    const toRect = smallRect(2, 2);
    const toSlot = doorSlotsForFace(toRect, 1, 'north');
    // Block both toPos's north-neighbor (1,2) and west-neighbor (2,1).
    const occupiedCells = { '1,2': 'blockerN', '2,1': 'blockerW' };
    const result = buildEdgeCorridor('seed1', 'a', 'b', fromRect, toRect, fromPos, toPos, 'south', toSlot[0], occupiedCells, 'north');
    // fromPos/toPos are different columns, so this hits the
    // different-column/corner branch's own collapsed null-path handling
    // -- its found-path shape is always exactly 2 segments (one leg per
    // axis), never the old trunk-lane hack's 3-segment shape.
    expect(result.corridorSegments).toHaveLength(2);
  });

  it('north-incoming behavior is byte-identical to before this change (regression guard)', () => {
    const fromPos = { rank: 0, col: 0 };
    const toPos = { rank: 1, col: 0 };
    const fromRect = smallRect(0, 0);
    const toRect = smallRect(1, 0);
    const toSlot = doorSlotsForFace(toRect, 1, 'north');
    const withDefault = buildEdgeCorridor('seed1', 'a', 'b', fromRect, toRect, fromPos, toPos, 'south', toSlot[0], {});
    const withExplicitNorth = buildEdgeCorridor('seed1', 'a', 'b', fromRect, toRect, fromPos, toPos, 'south', toSlot[0], {}, 'north');
    expect(withDefault).toEqual(withExplicitNorth);
  });
});
```

Also **update every pre-existing `buildEdgeCorridor` test that currently exercises a `!path` (null) scenario** — these were written against `trunkLaneCorridorSegments`' own 3-segment output shape and must be rewritten to assert against the restored direct-line/corner shape instead (search the existing test file for tests referencing `trunkLaneCorridorSegments`, "safe lane", or asserting a `corridorSegments` length of 3 for a null-path case — the plan's own reference is Task 6 of the *prior* plan's own commits, `bdcd209`).

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/dungeon-layout.test.mjs -t "buildEdgeCorridor"`
Expected: FAIL (the new west-incoming tests; likely some prior null-path tests too, until Step 3 removes `trunkLaneCorridorSegments`)

- [ ] **Step 3: Implement**

At the top of `buildEdgeCorridor`, fix the `slotWidth`→`slotSpan` axis trap and thread `incomingFace`:

```js
export function buildEdgeCorridor(seed, fromRoomId, toRoomId, fromRect, toRect, fromPos, toPos, exitFace, toSlot, occupiedCells, incomingFace = 'north') {
  const path = findCorridorPath(fromPos, toPos, occupiedCells, { fromRoomId, toRoomId, incomingFace });
  const slotSpan = incomingFace === 'west' ? (toSlot.y2 - toSlot.y1) : (toSlot.x2 - toSlot.x1);
  const outgoingOffset = doorOffsetAt(seed, `${fromRoomId}-${exitFace}`, 'outgoing', fromRect.gw);
  const incomingSeedKey = incomingFace === 'west' ? `${toRoomId}-west-${toSlot.y1}` : `${toRoomId}-north-${toSlot.x1}`;
  const incomingOffset = doorOffsetAt(seed, incomingSeedKey, 'incoming', slotSpan);
```

(Every other reference to `slotWidth` in the function body becomes `slotSpan` — a pure rename, no behavior change for `incomingFace === 'north'` since `slotSpan` computes the exact same value `slotWidth` did.)

The multi-cell branch's `entryPoint` (currently hard-coded to `{x: toSlot.x1 + slotWidth/2, y: toSlot.y1}`) becomes:

```js
const entryPoint = incomingFace === 'west'
  ? { x: toSlot.x1, y: toSlot.y1 + slotSpan / 2 }
  : { x: toSlot.x1 + slotSpan / 2, y: toSlot.y1 };
```

The different-column/corner branch (the pre-existing code's final `return` block, which computes its own `exitPoint`/`entryPoint`/`corner`) needs the identical `entryPoint` fix — it currently hard-codes `entryPoint = { x: toSlot.x1 + slotWidth / 2, y: toSlot.y1 }` the same way the multi-cell branch used to. Replace that whole branch's body with:

```js
  const exitPoint = exitFace === 'east'
    ? { x: fromRect.gx + fromRect.gw, y: fromRect.gy + fromRect.gh / 2 }
    : exitFace === 'west'
    ? { x: fromRect.gx, y: fromRect.gy + fromRect.gh / 2 }
    : { x: fromRect.gx + fromRect.gw / 2, y: fromRect.gy + fromRect.gh };
  const entryPoint = incomingFace === 'west'
    ? { x: toSlot.x1, y: toSlot.y1 + slotSpan / 2 }
    : { x: toSlot.x1 + slotSpan / 2, y: toSlot.y1 };
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
```

This deletes the branch's own pre-existing `if (!path) { ... trunkLaneCorridorSegments(...) ... }` block entirely — a null path and a found `path.length <= 2` now produce identical geometry, since both take this same corner-based route unconditionally. The `entryPoint` fix here is the SAME conditional the multi-cell branch above already uses (both branches compute `entryPoint` from `toSlot`/`slotSpan` the same way — this is the one other place besides the multi-cell branch that needed it, and the ONLY two places in this function `entryPoint` is ever computed for a real `toSlot`-based connection).

Add the new same-rank/east-exit fast path, mirroring the existing same-column/south-exit one, **immediately after** the existing `if (exitFace === 'south' && sameColumn) { ... }` block and before the "different column" fallback:

```js
  const sameRank = fromRect.gy === toRect.gy;
  if (exitFace === 'east' && sameRank) {
    const faceX = fromRect.gx + fromRect.gw;
    const corridorEndX = toRect.gx;
    const doorY0 = fromRect.gy + outgoingOffset;
    const doorY1 = doorY0 + DOOR_WIDTH;
    const gapY0 = toSlot.y1 + incomingOffset;
    const gapY1 = gapY0 + DOOR_WIDTH;
    const spanY0 = Math.min(doorY0, gapY0);
    const spanY1 = Math.max(doorY1, gapY1);
    const plainWalls = [
      { x1: faceX, y1: fromRect.gy, x2: faceX, y2: doorY0 },
      { x1: faceX, y1: doorY1, x2: faceX, y2: Math.max(fromRect.gy + fromRect.gh, spanY1) },
      { x1: corridorEndX, y1: toSlot.y1, x2: corridorEndX, y2: gapY0 },
      { x1: corridorEndX, y1: gapY1, x2: corridorEndX, y2: toSlot.y2 },
    ].filter((w) => w.x1 !== w.x2 || w.y1 !== w.y2);
    // A null path (boxed in, both north and west neighbors occupied,
    // #196) and a found path.length<=2 now draw the exact same direct
    // line -- the distinction only mattered back when a null path took
    // the (now-deleted) trunkLaneCorridorSegments detour instead.
    return {
      doorWall: { x1: faceX, y1: doorY0, x2: faceX, y2: doorY1 },
      revealDoorWall: { x1: corridorEndX, y1: gapY0, x2: corridorEndX, y2: gapY1 },
      plainWalls,
      corridorSegments: [{ gx: faceX, gy: spanY0, gw: corridorEndX - faceX, gh: spanY1 - spanY0 }],
      transitCells: [],
    };
  }
```

Now **simplify** the original same-column/south branch's own `!path` handling the same way — delete its `if (!path) { ... trunkLaneCorridorSegments(...) ... }` block entirely, leaving only the single `return` its found-path case already had:

```js
    return {
      doorWall, revealDoorWall, plainWalls,
      corridorSegments: [{ gx: spanX0, gy: faceY, gw: spanX1 - spanX0, gh: corridorEndY - faceY }],
      transitCells: [],
    };
```

(A one-line comment above this `return` is worth keeping, replacing the deleted `if (!path)` block's own comment: "a null path and a length<=2 path now produce identical geometry — the distinction only mattered when `!path` took the (now-deleted) trunk-lane detour.")

Delete `trunkLaneCorridorSegments` (the whole function) and its docblock.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/dungeon-layout.test.mjs -t "buildEdgeCorridor"`
Expected: PASS — including every pre-existing test (with the null-path ones updated per Step 1's own instruction) and the new west-incoming tests.

- [ ] **Step 5: Run the full test file**

Run: `npx vitest run tests/dungeon-layout.test.mjs`
Expected: PASS. Investigate and fix (never weaken) any failure — `outgoingMarginOffset`'s own tests, `cellMarginWalls` alignment tests, and the Task-6-era regression sweep tests all transitively depend on `buildEdgeCorridor`'s exact output shape and may need their own null-path assertions updated the same way Step 1 already flagged.

- [ ] **Step 6: Commit**

```bash
git add scripts/dungeon-layout.mjs tests/dungeon-layout.test.mjs
git commit -m "feat: generalize buildEdgeCorridor for a west-incoming target, revert trunkLaneCorridorSegments to the honest direct-line fallback"
```

---

## Task 6: Wire `incomingFaceByRoomId` into the real pipeline

**Files:**
- Modify: `scripts/ui/dungeon-app.mjs`, `scripts/dungeon-scene.mjs`
- Test: manual/live verification (same Foundry-glue boundary as the rest of this codebase's wall/tile-building code) plus one pure-pipeline test in `tests/dungeon-layout.test.mjs` if a suitable seam exists without touching Foundry APIs (see Step 3).

**Interfaces:**
- Consumes: `incomingFaceFor` (Task 1), the generalized `exitFaceForIndex`/`roomEnclosureWalls`/`doorSlotsForFace`/`findCorridorPath`/`outgoingMarginOffset`/`buildEdgeCorridor` (Tasks 1-5).
- Produces: `state.incomingFaceByRoomId` (`Map<roomId, 'north'|'west'>`, or plain object keyed the same way `layoutPositionByRoomId` already is), populated once per generated dungeon and threaded through every call site Tasks 2-5 already prepared to accept it.

- [ ] **Step 1: Wire the precompute step**

In `scripts/ui/dungeon-app.mjs`, right after `layoutPositionByRoomId` is built (the existing block quoted below — modify in place):

```js
  const ranks = computeRanks(layoutEdges, 'room-entry');
  const columns = computeColumns(layoutEdges, ranks, 'room-entry');
  const layoutPositionByRoomId = Object.fromEntries(
    Object.keys(rooms).map((id) => [id, { rank: ranks[id], col: columns[id] }]),
  );
  // #174 follow-up (incoming-face redesign): choose each room's incoming
  // face once, from the fully precomputed layout, before any room's
  // walls are built -- same "full pregeneration" pattern
  // layoutPositionByRoomId itself already uses.
  const occupiedCellsForIncomingFace = {};
  for (const [id, pos] of Object.entries(layoutPositionByRoomId)) {
    occupiedCellsForIncomingFace[`${pos.rank},${pos.col}`] = id;
  }
  const incomingFaceByRoomId = Object.fromEntries(
    Object.keys(rooms).map((id) => {
      const legitimateSourceIds = new Set([
        ...parentRoomIdsFor(layoutEdges, id),
        ...(hiddenIncomingByRoomId[id] ?? []),
      ]);
      return [id, incomingFaceFor(id, layoutPositionByRoomId, occupiedCellsForIncomingFace, legitimateSourceIds)];
    }),
  );
  const maxRank = Math.max(...Object.values(ranks));
  const maxCol = Math.max(...Object.values(columns));
```

Add `parentRoomIdsFor` and `incomingFaceFor` to this file's existing `import { computeRanks, computeColumns } from "../dungeon-layout.mjs";` line.

Add `incomingFaceByRoomId` to the `state = {...}` assembly a few lines below, alongside `layoutPositionByRoomId`:

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
    maxRank,
    currentRoomId: 'room-entry',
    history: [],
  };
```

- [ ] **Step 2: Wire every consuming call site in `dungeon-scene.mjs`**

In `buildPopulateAndUnlockGraphNode`:
```js
  const incomingFace = state.incomingFaceByRoomId[room.id] ?? 'north';
```
(placed near the existing `occupiedCells` derivation, since both are per-room precomputed lookups from `state`)

Pass it into `buildRoomAtGraphNode`'s own call:
```js
    const { placeholderIdsByConnection } = await buildRoomAtGraphNode(
      scene,
      room.id,
      {
        rank, col, childIds, incomingConnections, hiddenChildId,
        isGoal: room.isGoal, locationTag: room.locationTag,
        artVariant: room.artVariant, seed: state.seed,
        layoutPositionByRoomId: state.layoutPositionByRoomId,
        occupiedCells, incomingFace,
        incomingFaceByRoomId: state.incomingFaceByRoomId,
      },
    );
```

Replace the `northDoorSlots(rect, incomingConnections.length)` call with:
```js
    const slots = incomingConnections.length ? doorSlotsForFace(rect, incomingConnections.length, incomingFace) : [];
```

Replace the *source's own* incoming face lookup for `exitFaceFromSource` (Task 2 already added the `sourceIncomingFace` line with a `?? 'north'` fallback — this task just confirms `state.incomingFaceByRoomId` is now real, non-empty data, so the fallback is never actually exercised in production):
```js
      const sourceIncomingFace = state.incomingFaceByRoomId[sourceId] ?? 'north';
```

Pass `incomingFace` (the **target** room's own incoming face) into `buildEdgeCorridor`:
```js
      const { doorWall, revealDoorWall, plainWalls, corridorSegments, transitCells } =
        buildEdgeCorridor(state.seed, sourceId, room.id, sourceRect, rect, sourcePos, { rank, col }, exitFaceFromSource, toSlot, occupiedCells, incomingFace);
```

In `buildRoomAtGraphNode`'s own margin-wall loop (the one calling `outgoingMarginOffset` for each of `roomId`'s own `marginFaces`), pass the **child's** own incoming face (not `roomId`'s own — this is the face the connection actually lands on at the far end):
```js
  for (const face of marginFaces) {
    const childId = childIdByFace[face];
    const childPos = childId ? layoutPositionByRoomId[childId] : null;
    const childIncomingFace = childId ? (incomingFaceByRoomId?.[childId] ?? 'north') : 'north';
    const offset = outgoingMarginOffset(
      seed, roomId, childId, face, rect, { rank, col },
      childPos ?? { rank: NaN, col: NaN }, occupiedCells, childIncomingFace,
    );
    const sideWalls = cellMarginWalls(rect, rank, col, { openSide: face, openOffset: offset, openWidth: DOOR_WIDTH });
    for (const side of sideWalls) if (side.dir === face) marginWalls.push(side);
    coveredMarginSides.add(face);
  }
```
(only the `outgoingMarginOffset` call itself changes — gaining `childIncomingFace` as its new trailing argument; every other line in this loop, and the `coveredMarginSides.size < 2` fallback block immediately after it, is unchanged.)
This requires threading `incomingFaceByRoomId` (the whole map, not just this room's own value) into `buildRoomAtGraphNode`'s own options — add it alongside the existing `layoutPositionByRoomId`/`occupiedCells` parameters, and pass `state.incomingFaceByRoomId` from `buildPopulateAndUnlockGraphNode`'s own call site.

**Note for the implementer:** there are now two *different* "incoming face" values in play inside `buildRoomAtGraphNode`: the room's *own* incoming face (`incomingFace`, used for its own wall-building/`exitFaceForIndex`/door-slot orientation) and, separately, each of its *children's* incoming faces (`incomingFaceByRoomId[childId]`, used only inside the margin-offset loop to match `buildEdgeCorridor`'s own branch selection for that outgoing connection). Do not conflate the two — a room's own incoming face has no bearing on which face its own children receive their connections on.

- [ ] **Step 3: Add one pure-pipeline sanity test**

In `tests/dungeon-layout.test.mjs`, confirm `incomingFaceFor` genuinely gets invoked with real, non-degenerate data across a real generated graph (this doesn't touch Foundry — it only exercises `dungeon-deck.mjs`'s pure graph functions plus the new pure helper, the same pattern the existing regression sweep already uses):

```js
describe('incomingFaceByRoomId derivation over a real generated graph', () => {
  it('produces a valid face for every room, and at least one west case across a wide sweep', () => {
    let sawWest = false;
    for (let i = 0; i < 200; i += 1) {
      const seed = `incoming-face-sweep-${i}`;
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
      for (const id of Object.keys(rooms)) {
        const legitimateSourceIds = new Set([
          ...parentRoomIdsFor(layoutEdges, id),
          ...(hiddenIncomingByRoomId[id] ?? []),
        ]);
        const face = incomingFaceFor(id, positionByRoomId, occupiedCells, legitimateSourceIds);
        expect(['north', 'west']).toContain(face);
        if (face === 'west') sawWest = true;
      }
    }
    expect(sawWest).toBe(true); // sanity: the sweep actually exercised the new fallback, not just the unchanged default
  });
});
```

Import `parentRoomIdsFor` in the test file's existing `dungeon-layout.mjs` import block if not already present.

- [ ] **Step 4: Run tests**

Run: `npx vitest run tests/dungeon-layout.test.mjs`
Expected: PASS

- [ ] **Step 5: Manual verification checklist (for Task 8's live pass)**

(a) A room whose `incomingFaceByRoomId` entry is `'west'` gets its real door built on its own west wall, not north. (b) That room's own outgoing children (if any) never land on `'west'` — `'north'` is offered instead where a normal room would have used `'west'`. (c) A merge room with 2+ real parents, one of which sits at the room's own north-neighbor position, still gets north as its incoming face (not incorrectly pushed to west). (d) The party can walk through a west-incoming room's door normally, and it unlocks/opens the same as any other door.

- [ ] **Step 6: Commit**

```bash
git add scripts/ui/dungeon-app.mjs scripts/dungeon-scene.mjs tests/dungeon-layout.test.mjs
git commit -m "feat: wire incomingFaceByRoomId into the real generation pipeline"
```

---

## Task 7: Regression sweep proving the new boxed-in rate

**Files:**
- Modify: `tests/dungeon-layout.test.mjs`

**Interfaces:**
- Consumes: `incomingFaceFor`, the generalized `buildEdgeCorridor`/`findCorridorPath`/`outgoingMarginOffset` (Tasks 1-6).
- Produces: no new exports — test coverage only, mirroring the prior plan's own Task 6 methodology exactly, updated for the new incoming-face-aware call signatures.

- [ ] **Step 1: Update the existing regression sweep**

Modify the prior plan's own `corridor routing regression sweep (#174)` describe block (in `tests/dungeon-layout.test.mjs`, added by the previous plan's Task 6) to:

1. Compute `incomingFaceByRoomId` for every room in the sweep the same way Task 6's own `dungeon-app.mjs` code does (reuse the exact derivation from Task 6's own Step 3 test, factored into a small local helper within the test file if that reduces duplication — not exported, test-only).
2. Pass each edge's own target `incomingFace` into `findCorridorPath`/`buildEdgeCorridor`/`outgoingMarginOffset` wherever the existing sweep calls them.
3. Add a new assertion: the measured boxed-in rate (edges whose `findCorridorPath` call returns `null`) is **at or below 10%** (a slightly loose bound around the design's own measured ~7.9%, to avoid a flaky test over exact sweep-seed sensitivity — a tighter bound can be set later once the exact number is reproduced against this task's own final code).
4. Keep the existing zero-overlap assertion for every edge whose path is non-null (the null-path residual is explicitly allowed to overlap per this design's own accepted degradation, tracked as #196 — do not assert zero overlap for those edges, since that would fail by design).

```js
  it('the boxed-in rate (null findCorridorPath) is at or below 10%, matching this redesign\'s own measured ~7.9%', () => {
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
    expect(nullPathEdges / totalEdges).toBeLessThanOrEqual(0.10);
  });
```

Also update the existing "no corridor segment overlaps any room footprint" sweep test and the "every SMALL room's cell-margin gap coincides" sweep test (both already present from the prior plan's Task 6) to thread `incomingFaceByRoomId[toId]` into every `findCorridorPath`/`buildEdgeCorridor`/`outgoingMarginOffset` call they make, and to **exclude** null-path edges from the zero-overlap assertion specifically (they're allowed to overlap per this design's own accepted degradation — asserting zero overlap for them would contradict the Decision section of the spec).

- [ ] **Step 2: Run the sweep**

Run: `npx vitest run tests/dungeon-layout.test.mjs -t "regression sweep"`
Expected: PASS. If the boxed-in rate assertion fails (rate above 10%), investigate `incomingFaceFor`'s own logic and its threading through Tasks 2-6 before touching the test's own threshold — a real logic gap is far more likely than the design's own empirical measurement being wrong twice.

- [ ] **Step 3: Run the full suite**

Run: `npx vitest run`
Expected: PASS, no regressions anywhere else in the codebase.

- [ ] **Step 4: Commit**

```bash
git add tests/dungeon-layout.test.mjs
git commit -m "test: update whole-pipeline regression sweep for north-or-west incoming, assert boxed-in rate <= 10%"
```

---

## Task 8: Live verification, final review, and close-out

**Files:** none (verification + process only)

- [ ] **Step 1: Live Foundry verification**

Run the manual checklist items from Task 6's own Step 5, against a real generated dungeon in a live Foundry world (same boundary this codebase always uses for Foundry-glue verification — no automated test can exercise Foundry's own rendering/door-unlock engine). Generate at least one dungeon large enough (`roomCount` high enough) to be very likely to contain a west-incoming room, given ~24% of rooms are expected to need one.

- [ ] **Step 2: Whole-branch final review**

Dispatch a final code reviewer (most capable available model) against the full diff since this plan's own base commit, covering all of Tasks 1-7. Specifically ask the reviewer to independently re-verify (not just trust the plan's own claims):
- Every function this plan touched produces byte-identical output for `incomingFace === 'north'` compared to its pre-redesign behavior (the single most important regression-safety property this whole plan rests on).
- The `slotWidth`→`slotSpan` axis fix in `buildEdgeCorridor` is applied everywhere the old `slotWidth` was used, with no missed reference.
- `trunkLaneCorridorSegments` is fully deleted, with no dangling reference or dead import.
- The measured boxed-in rate from Task 7's own sweep is genuinely at or below ~10%, not an assertion that was loosened to pass.

- [ ] **Step 3: Address final review findings**

One fix dispatch, one scoped re-review, adjudicate any residual findings per this plan's own established ruling process (ledgered, not silently applied).

- [ ] **Step 4: Merge and close out**

Following this branch's own established convention: merge `main` into this worktree's branch if it has moved, bump `module.json` (minor bump — this is an architecture-level change per this repo's own versioning convention, not a routine fix), run the `update-architecture-docs` skill if any `scripts/` import graph changed, open a PR, handle automerge (this repo's `allow_auto_merge` may be `false` — merge directly via `gh pr merge --squash --delete-branch` if `gh pr merge --auto` doesn't actually enable it, per this session's own established pattern), and close out the GitHub issue lifecycle:
- Comment on #174 confirming this redesign is complete, with the final measured boxed-in rate.
- #196 (the residual gap) stays open, unaffected by this close-out — it was always scoped as a separate follow-up, not something this plan resolves.
- Update project memory with the final outcome (the north-or-west redesign, the measured rate, and #196's own continued-open status) for future sessions picking up #196 or any related work.
