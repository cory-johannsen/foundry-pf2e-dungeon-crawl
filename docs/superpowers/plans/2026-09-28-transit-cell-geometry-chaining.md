# Transit-Cell Corridor Geometry Chaining Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a multi-cell corridor's geometry genuinely buildable by chaining every crossing point (source door → each transit cell → target door) end-to-end instead of seeding each piece's own entry/exit offset independently.

**Architecture:** A new pure helper (`projectOntoSide`) derives one cell-boundary point from a neighboring point's shared axis. `transitCellCrossing` gains an optional forced-points parameter that bypasses its own seeded offset when supplied. `buildEdgeCorridor`'s multi-cell branch threads a `chainAnchor` through its per-cell loop so every interior boundary is derived from its neighbor, anchored at the two true endpoints (the real room doors). `buildTransitCellIfNeeded`'s idempotency marker gains the edge's own id so two edges crossing the same cell each get their own tiles.

**Tech Stack:** Plain ES modules (`scripts/*.mjs`), Vitest (`tests/*.test.mjs`), no Foundry dependency in the files this plan touches except `scripts/dungeon-scene.mjs`'s one-line marker change (Foundry-glue, no automated test harness — see that file's own docblock).

**Spec:** `docs/superpowers/specs/2026-09-28-transit-cell-geometry-design.md`

## Global Constraints

- `CORRIDOR_LEN = DOOR_WIDTH = 1` (`scripts/dungeon-layout.mjs`) — every gap/wall opening is exactly 1 grid unit; forced points must land exactly on this width, never approximate.
- `transitCellCrossing` must stay byte-identical for every existing caller that omits the new options parameter — this is the regression floor for every test that predates this plan.
- Do not modify `findCorridorPath`, `computeRanks`, `computeColumns`, or `incomingFaceFor` — out of scope per the spec's own Non-goals (the #174 merge-room gate-sharing problem is a separate, later decision).
- `scripts/dungeon-scene.mjs` has no automated Foundry test harness (see `buildRoomAtGraphNode`'s own docblock, "no Foundry test harness exists for this file") — its one change in this plan is verified by direct code review plus the existing manual/live-verification checklist, not a new automated test.
- A forced point that exactly coincides with its anchor produces a harmless, minor redundant tile — accepted, not special-cased away (spec's own Non-goals/Error handling).

## Review Focus

- **Single-intermediate-cell path** (`path.length === 3`): the loop's only iteration has `isLast === true`, so both `forcedEntryPoint` and `forcedExitPoint` come from the two real room doors with zero seeded randomness for that cell — Task 3 tests this explicitly.
- **A west-incoming target combined with a multi-cell detour** (the chain's shared axis is `y`, not `x`): `projectOntoSide`'s `west`/`east` branches must be exercised, not just `north`/`south` — Task 1 tests all four sides directly, and Task 3 re-runs the pre-existing west-incoming multi-cell test (`tests/dungeon-layout.test.mjs:739`) unmodified to confirm it still passes.
- **A corner transit cell mid-chain** (`entrySide`/`exitSide` adjacent, not opposite): only one axis is forced by the chain; the perpendicular free axis must still get a real, deterministic seeded value, never `NaN`/`undefined` — Task 2 tests the options-omitted case retains this, and Task 3's chain tests confirm a corner cell's free axis is still populated.
- **Determinism**: same seed, same `edgeId`, same forced points in → same output out, every call — `projectOntoSide` is pure, so no new nondeterminism should appear — Tasks 2 and 3 both assert repeat-call equality.
- **`edgeId` must survive unchanged**: from `buildEdgeCorridor`'s own `` `${fromRoomId}->${toRoomId}` `` into each `transitCells` entry, and from there into `buildTransitCellIfNeeded`'s marker — a silently dropped or renamed `edgeId` would look fixed while still exhibiting bug #3 (dropped shared crossings) — Task 3 tests `transitCells[i].edgeId` equals the expected string; Task 4's diff is reviewed directly plus added to the manual checklist.
- **A first-hop direction that diverges from the room's own exit face** (the BFS path's very first step doesn't head toward `exitFace`, e.g. the room's immediate south neighbor is blocked so the path turns sideways at the first cell): only the axis matching the first transit cell's actual `entrySide` is forced to the source's real door coordinate — the other axis is legitimately the transit cell's own fixed boundary coordinate, not the room's door coordinate, since the room's own south/east face always sits inside a margin gap (`ROOM_SIZE_SMALL`/`LARGE` are both `< ROW_STRIDE`/`COLUMN_STRIDE`). A test (or a reviewer) that asserts BOTH axes unconditionally match the source door will be *wrong*, not catching a real defect — Task 5's sweep is written axis-aware for exactly this reason; the target side has no such split (a room always anchors flush at its own cell's north/west corner, so both axes coincide there unconditionally).

---

### Task 1: `projectOntoSide` helper

**Files:**
- Modify: `scripts/dungeon-layout.mjs` — insert after `cornerConnector` (currently ends at line 689), before `corridorTileVariant`.
- Test: `tests/dungeon-layout.test.mjs` — insert a new `describe('projectOntoSide', ...)` block after the `describe('cellBounds', ...)` block (currently ends at line 808), before `describe('findCorridorPath', ...)`.

**Interfaces:**
- Produces: `export function projectOntoSide(cell, side, anchor)` — `cell` is a `cellBounds(...)`-shaped rect (`{gx, gy, gw, gh}`), `side` is one of `'north'|'south'|'east'|'west'`, `anchor` is `{x, y}`. Returns `{x, y}` on `cell`'s own `side` boundary, sharing `anchor`'s axis-coordinate along that side.

- [ ] **Step 1: Write the failing tests**

```js
describe('projectOntoSide', () => {
  const cell = cellBounds(1, 2); // gx: INITIAL_GX + 26, gy: 13, gw: 13, gh: 13

  it('north: shares the anchor\'s x, sits on the cell\'s own north edge', () => {
    expect(projectOntoSide(cell, 'north', { x: cell.gx + 5, y: 999 }))
      .toEqual({ x: cell.gx + 5, y: cell.gy });
  });

  it('south: shares the anchor\'s x, sits on the cell\'s own south edge', () => {
    expect(projectOntoSide(cell, 'south', { x: cell.gx + 5, y: 999 }))
      .toEqual({ x: cell.gx + 5, y: cell.gy + cell.gh });
  });

  it('west: shares the anchor\'s y, sits on the cell\'s own west edge', () => {
    expect(projectOntoSide(cell, 'west', { x: 999, y: cell.gy + 5 }))
      .toEqual({ x: cell.gx, y: cell.gy + 5 });
  });

  it('east: shares the anchor\'s y, sits on the cell\'s own east edge', () => {
    expect(projectOntoSide(cell, 'east', { x: 999, y: cell.gy + 5 }))
      .toEqual({ x: cell.gx + cell.gw, y: cell.gy + 5 });
  });

  it('is pure — never mutates the cell or anchor it was given', () => {
    const cellCopy = { ...cell };
    const anchor = { x: cell.gx + 5, y: cell.gy + 5 };
    const anchorCopy = { ...anchor };
    projectOntoSide(cell, 'east', anchor);
    expect(cell).toEqual(cellCopy);
    expect(anchor).toEqual(anchorCopy);
  });
});
```

Also add `projectOntoSide` to the import list at the top of `tests/dungeon-layout.test.mjs` (alongside `cellBounds, findCorridorPath, INITIAL_GX, cellMarginWalls, transitCellCrossing,`).

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/dungeon-layout.test.mjs -t projectOntoSide`
Expected: FAIL — `projectOntoSide is not defined` / not exported.

- [ ] **Step 3: Implement `projectOntoSide`**

Insert into `scripts/dungeon-layout.mjs` immediately after `cornerConnector`'s closing `}` (after line 689):

```js
/**
 * A point on `cell`'s own `side` boundary that shares `anchor`'s
 * axis-coordinate along that side — north/south share `x`, east/west
 * share `y`. The other coordinate is always `cell`'s own boundary line,
 * never `anchor`'s (#225): `anchor` is typically a point on a NEIGHBORING
 * cell's own boundary, or a room's real door, not necessarily on `cell`
 * itself. Used by `buildEdgeCorridor`'s multi-cell chain (Task 3) to derive
 * each transit cell's forced entry/exit point from its neighbor's, so two
 * pieces that share a physical boundary always agree on where they cross
 * it, by construction rather than by coincidence.
 */
export function projectOntoSide(cell, side, anchor) {
  if (side === 'north') return { x: anchor.x, y: cell.gy };
  if (side === 'south') return { x: anchor.x, y: cell.gy + cell.gh };
  if (side === 'west') return { x: cell.gx, y: anchor.y };
  return { x: cell.gx + cell.gw, y: anchor.y }; // east
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/dungeon-layout.test.mjs -t projectOntoSide`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add scripts/dungeon-layout.mjs tests/dungeon-layout.test.mjs
git commit -m "$(cat <<'EOF'
Add projectOntoSide helper for #225 corridor-geometry chaining

Pure geometry helper: given a known point and a target cell/side,
derives the corresponding point on that cell's own boundary, sharing
the known point's axis-coordinate. First piece of the chained-
crossing-point fix for transit-cell corridor geometry (#225).

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: `transitCellCrossing` gains optional forced points

**Files:**
- Modify: `scripts/dungeon-layout.mjs:855-860` (`transitCellCrossing`'s signature and entry/exit point computation only — the `corridorSegments`/`plainWalls` body below it, lines 862-909, is untouched).
- Test: `tests/dungeon-layout.test.mjs` — extend the existing `describe('transitCellCrossing', ...)` block (currently lines 1137-1250).

**Interfaces:**
- Consumes: nothing new from Task 1 directly (Task 3 is what calls `projectOntoSide` to produce the forced points this task consumes).
- Produces: `transitCellCrossing(seed, rank, col, entrySide, exitSide, edgeId, { forcedEntryPoint, forcedExitPoint } = {})` — when `forcedEntryPoint`/`forcedExitPoint` are supplied (each a `{x, y}` or `undefined`), they're used verbatim in place of the seeded `doorOffsetAt` computation for that one point. Omitting the 7th argument, or passing `{}`, reproduces today's exact seeded behavior.

- [ ] **Step 1: Write the failing tests**

Add to the end of the existing `describe('transitCellCrossing', ...)` block, just before its closing `});` (after the "keeps every segment within cellBounds..." test, currently ending at line 1249):

```js
  it('uses a forced entry point verbatim instead of the seeded offset', () => {
    const forcedEntryPoint = { x: 12345, y: 67 };
    const result = transitCellCrossing('seed1', 1, 0, 'north', 'south', 'a->b', { forcedEntryPoint });
    expect(result.entryPoint).toEqual(forcedEntryPoint);
  });

  it('uses a forced exit point verbatim instead of the seeded offset', () => {
    const forcedExitPoint = { x: 999, y: 111 };
    const result = transitCellCrossing('seed1', 1, 0, 'north', 'south', 'a->b', { forcedExitPoint });
    expect(result.exitPoint).toEqual(forcedExitPoint);
  });

  it('forces entry and exit independently — one forced, the other still seeded', () => {
    const forcedEntryPoint = { x: 12345, y: 67 };
    const withForcedEntry = transitCellCrossing('seed1', 1, 0, 'north', 'south', 'a->b', { forcedEntryPoint });
    const seededOnly = transitCellCrossing('seed1', 1, 0, 'north', 'south', 'a->b');
    expect(withForcedEntry.entryPoint).toEqual(forcedEntryPoint);
    expect(withForcedEntry.exitPoint).toEqual(seededOnly.exitPoint); // exit still seeded, unaffected
  });

  it('omitting the options object is byte-identical to every pre-#225 call (regression guard)', () => {
    const withoutOptions = transitCellCrossing('seed1', 2, 1, 'west', 'east', 'x->y');
    const withEmptyOptions = transitCellCrossing('seed1', 2, 1, 'west', 'east', 'x->y', {});
    expect(withEmptyOptions).toEqual(withoutOptions);
  });

  it('a forced point still produces valid, in-bounds corridorSegments (corner case)', () => {
    // Adjacent sides (north/east) with entry forced onto the cell's own
    // north edge — the free axis (exit) is still seeded, and the
    // resulting corner geometry must stay inside the cell, same
    // containment guarantee as the fully-seeded case.
    const cell = cellBounds(0, 0);
    const forcedEntryPoint = { x: cell.gx + 3, y: cell.gy };
    const result = transitCellCrossing('seed1', 0, 0, 'north', 'east', 'a->b', { forcedEntryPoint });
    expect(result.entryPoint).toEqual(forcedEntryPoint);
    for (const seg of result.corridorSegments) {
      expect(seg.gx).toBeGreaterThanOrEqual(cell.gx);
      expect(seg.gx + seg.gw).toBeLessThanOrEqual(cell.gx + cell.gw);
      expect(seg.gy).toBeGreaterThanOrEqual(cell.gy);
      expect(seg.gy + seg.gh).toBeLessThanOrEqual(cell.gy + cell.gh);
    }
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/dungeon-layout.test.mjs -t transitCellCrossing`
Expected: FAIL — forced points are currently ignored (the function has no 7th parameter), so `result.entryPoint`/`result.exitPoint` won't equal the forced values.

- [ ] **Step 3: Implement the forced-points parameter**

In `scripts/dungeon-layout.mjs`, replace lines 855-860:

```js
export function transitCellCrossing(seed, rank, col, entrySide, exitSide, edgeId) {
  const cell = cellBounds(rank, col);
  const entryOffset = doorOffsetAt(seed, `transit-${rank}-${col}-${entrySide}-${edgeId}`, 'incoming', cell[SIDE_SPAN[entrySide]]);
  const exitOffset = doorOffsetAt(seed, `transit-${rank}-${col}-${exitSide}-${edgeId}`, 'outgoing', cell[SIDE_SPAN[exitSide]]);
  const entryPoint = SIDE_POINT[entrySide](cell, entryOffset);
  const exitPoint = SIDE_POINT[exitSide](cell, exitOffset);
```

with:

```js
export function transitCellCrossing(seed, rank, col, entrySide, exitSide, edgeId, { forcedEntryPoint, forcedExitPoint } = {}) {
  const cell = cellBounds(rank, col);
  // #225: a forced point (from buildEdgeCorridor's chain, Task 3) is used
  // verbatim in place of this cell's own independently-seeded offset —
  // the whole fix for "two pieces sharing a boundary don't agree on where
  // they cross it." Omitting both (every pre-#225 call site) falls
  // through to the exact original seeded behavior.
  const entryPoint = forcedEntryPoint
    ?? SIDE_POINT[entrySide](cell, doorOffsetAt(seed, `transit-${rank}-${col}-${entrySide}-${edgeId}`, 'incoming', cell[SIDE_SPAN[entrySide]]));
  const exitPoint = forcedExitPoint
    ?? SIDE_POINT[exitSide](cell, doorOffsetAt(seed, `transit-${rank}-${col}-${exitSide}-${edgeId}`, 'outgoing', cell[SIDE_SPAN[exitSide]]));
```

Everything after this (the `corridorSegments`/`plainWalls` computation, lines 862-909) is unchanged — it already only ever consumes `entryPoint`/`exitPoint` generically.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/dungeon-layout.test.mjs -t transitCellCrossing`
Expected: PASS (all tests in this describe block, old and new).

- [ ] **Step 5: Run the full test suite to confirm no other regression**

Run: `npx vitest run tests/dungeon-layout.test.mjs`
Expected: PASS (every existing test — this task changes `transitCellCrossing`'s signature but not its default behavior).

- [ ] **Step 6: Commit**

```bash
git add scripts/dungeon-layout.mjs tests/dungeon-layout.test.mjs
git commit -m "$(cat <<'EOF'
transitCellCrossing: accept optional forced entry/exit points (#225)

A 7th, optional options argument lets a caller pin one or both of a
transit cell's crossing points to an exact value instead of the
independently-seeded default — the mechanism buildEdgeCorridor's
multi-cell chain (next task) uses to keep adjacent pieces of a
corridor's geometry aligned. Omitting the argument reproduces today's
exact seeded behavior, byte-for-byte.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: `buildEdgeCorridor`'s multi-cell branch chains crossing points

**Files:**
- Modify: `scripts/dungeon-layout.mjs:352-446` (the `if (path && path.length > 2)` block inside `buildEdgeCorridor` only — everything before and after this block, and the two branches below it, are untouched).
- Test: `tests/dungeon-layout.test.mjs` — extend the existing `describe('buildEdgeCorridor (multi-cell path)', ...)` block (currently lines 561-675).

**Interfaces:**
- Consumes: `projectOntoSide` (Task 1), `transitCellCrossing`'s new options parameter (Task 2).
- Produces: each entry of `buildEdgeCorridor`'s returned `transitCells` array now also carries `edgeId` (string, `` `${fromRoomId}->${toRoomId}` ``) — this is what Task 4's `buildTransitCellIfNeeded` marker fix consumes. The function's own external signature and return shape (`{doorWall, revealDoorWall, plainWalls, corridorSegments, transitCells}`) are otherwise unchanged.

- [ ] **Step 1: Write the failing tests**

Add to the end of the existing `describe('buildEdgeCorridor (multi-cell path)', ...)` block, just before its closing `});` (after the "falls back to a direct line..." test, currently ending at line 674):

```js
  it('chains every crossing point end-to-end: entry/exit points align exactly across every boundary in a straight multi-cell corridor', () => {
    // Straight same-column descent, no obstacle needed — findCorridorPath
    // still returns a multi-cell path (rank 0 to rank 3 with nothing
    // blocking is 4 cells, 2 of them transit cells) since it always
    // routes cell-by-cell, not room-to-room. Kept deliberately straight
    // (entrySide/exitSide always 'north'/'south' here) so every forced
    // point shares the same axis (x) as the room doors' own — see the
    // Review Focus note on why a SIDEWAYS first hop needs its own,
    // axis-aware check instead (Task 5's whole-pipeline sweep covers that
    // general case).
    const fromRect = { gx: 300, gy: 0, gw: 12, gh: 12 };
    const toRect = { gx: 300, gy: 39, gw: 12, gh: 12 }; // rank 3
    const toSlot = { x1: 300, y1: 39, x2: 312, y2: 39 };
    const result = buildEdgeCorridor(
      'seed1', 'a', 'b', fromRect, toRect, { rank: 0, col: 0 }, { rank: 3, col: 0 },
      'south', toSlot, {},
    );
    expect(result.transitCells).toHaveLength(2); // ranks 1 and 2
    expect(result.transitCells.every((c) => c.entrySide === 'north' && c.exitSide === 'south')).toBe(true);

    // Source's real door (recoverable from doorWall's own center — same
    // convention the existing corner-branch tests use) aligns exactly
    // with the first cell's entry point.
    const sourceDoorX = (result.doorWall.x1 + result.doorWall.x2) / 2;
    expect(result.transitCells[0].entryPoint.x).toBeCloseTo(sourceDoorX, 9);

    // Target's real door (recoverable from revealDoorWall's own center)
    // aligns exactly with the last cell's exit point.
    const targetDoorX = (result.revealDoorWall.x1 + result.revealDoorWall.x2) / 2;
    const lastCell = result.transitCells[result.transitCells.length - 1];
    expect(lastCell.exitPoint.x).toBeCloseTo(targetDoorX, 9);

    // The shared border between the two transit cells coincides exactly —
    // no more independently-seeded mismatch (#225 bug #2).
    expect(result.transitCells[0].exitPoint).toEqual(result.transitCells[1].entryPoint);
  });

  it('every transitCells entry carries the edge\'s own id, unchanged, for buildTransitCellIfNeeded\'s marker (#225 bug #3)', () => {
    const fromRect = { gx: 300, gy: 0, gw: 12, gh: 12 };
    const toRect = { gx: 300, gy: 39, gw: 12, gh: 12 };
    const toSlot = { x1: 300, y1: 39, x2: 312, y2: 39 };
    const occupiedCells = { '1,0': 'blocker' };
    const result = buildEdgeCorridor(
      'seed1', 'source-room', 'target-room', fromRect, toRect, { rank: 0, col: 0 }, { rank: 3, col: 0 },
      'south', toSlot, occupiedCells,
    );
    expect(result.transitCells.length).toBeGreaterThan(0);
    for (const cell of result.transitCells) {
      expect(cell.edgeId).toBe('source-room->target-room');
    }
  });

  it('a single-intermediate-cell path forces BOTH entry and exit from the two real room doors — no seeded randomness at all', () => {
    // rank 0 -> rank 2, nothing blocked: findCorridorPath returns exactly
    // one intermediate cell (rank 1), so the loop's only iteration has
    // isLast === true from its very first step.
    const fromRect = { gx: 300, gy: 0, gw: 12, gh: 12 };
    const toRect = { gx: 300, gy: 26, gw: 12, gh: 12 }; // rank 2
    const toSlot = { x1: 300, y1: 26, x2: 312, y2: 26 };
    // Force the multi-cell branch even though this is a same-column,
    // south-exit connection, by blocking the same-column fast path isn't
    // possible directly -- instead use an east exit with a mismatched
    // column so the different-column path always goes multi-cell once an
    // obstacle forces a 3-cell route. Simplest reliable trigger: block
    // nothing and rely on same-column/south fast path NOT firing because
    // toPos is 2 ranks away with a real intermediate cell in between.
    // findCorridorPath still returns path.length === 3 here (adjacent
    // ranks 0,1,2), which is > 2, so buildEdgeCorridor takes the
    // multi-cell branch even with zero obstacles.
    const result = buildEdgeCorridor(
      'seed1', 'a', 'b', fromRect, toRect, { rank: 0, col: 0 }, { rank: 2, col: 0 },
      'south', toSlot, {},
    );
    expect(result.transitCells).toHaveLength(1);
    const sourceDoorX = (result.doorWall.x1 + result.doorWall.x2) / 2;
    const targetDoorX = (result.revealDoorWall.x1 + result.revealDoorWall.x2) / 2;
    expect(result.transitCells[0].entryPoint.x).toBeCloseTo(sourceDoorX, 9);
    expect(result.transitCells[0].exitPoint.x).toBeCloseTo(targetDoorX, 9);
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/dungeon-layout.test.mjs -t "chains every crossing point"`
Run: `npx vitest run tests/dungeon-layout.test.mjs -t "carries the edge's own id"`
Run: `npx vitest run tests/dungeon-layout.test.mjs -t "single-intermediate-cell path"`
Expected: FAIL — today's independently-seeded points don't coincide, and `transitCells` entries have no `edgeId` field yet.

- [ ] **Step 3: Implement the chain**

In `scripts/dungeon-layout.mjs`, replace the entire block from `const edgeId = ...` (line 358) through the `const corridorSegments = [...]` construction (ending line 433) — i.e. everything between `if (path && path.length > 2) {` and `const plainWalls = (...)`. The current block is:

```js
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
    const entryPoint = incomingFace === 'west'
      ? { x: toSlot.x1, y: toSlot.y1 + slotSpan / 2 }
      : { x: toSlot.x1 + slotSpan / 2, y: toSlot.y1 };
    const revealDoorWall = incomingFace === 'west'
      ? { x1: entryPoint.x, y1: entryPoint.y - DOOR_WIDTH / 2, x2: entryPoint.x, y2: entryPoint.y + DOOR_WIDTH / 2 }
      : { x1: entryPoint.x - DOOR_WIDTH / 2, y1: entryPoint.y, x2: entryPoint.x + DOOR_WIDTH / 2, y2: entryPoint.y };

    const firstCellPoint = transitCells[0].entryPoint;
    const lastCellPoint = transitCells[transitCells.length - 1].exitPoint;
    // ... [long comment block, unchanged, keep it] ...
    const corridorSegments = [
      ...cornerConnector(exitPoint, firstCellPoint, { toSide: transitCells[0].entrySide }),
      ...cornerConnector(lastCellPoint, entryPoint, { fromSide: transitCells[transitCells.length - 1].exitSide }),
    ];
```

Replace it with (note: `exitPoint`/`doorWall`/`entryPoint`/`revealDoorWall` move BEFORE the transit-cell loop, since the chain needs them as its two anchors; `firstCellPoint`/`lastCellPoint`/the big explanatory comment/`corridorSegments` construction stay exactly as they are today, unchanged, just after the new loop):

```js
    const edgeId = `${fromRoomId}->${toRoomId}`;
    const exitPoint = exitFace === 'east'
      ? { x: fromRect.gx + fromRect.gw, y: fromRect.gy + fromRect.gh / 2 }
      : exitFace === 'west'
      ? { x: fromRect.gx, y: fromRect.gy + fromRect.gh / 2 }
      : { x: fromRect.gx + fromRect.gw / 2, y: fromRect.gy + fromRect.gh };
    const doorWall = exitFace === 'south'
      ? { x1: exitPoint.x - DOOR_WIDTH / 2, y1: exitPoint.y, x2: exitPoint.x + DOOR_WIDTH / 2, y2: exitPoint.y }
      : { x1: exitPoint.x, y1: exitPoint.y - DOOR_WIDTH / 2, x2: exitPoint.x, y2: exitPoint.y + DOOR_WIDTH / 2 };
    const entryPoint = incomingFace === 'west'
      ? { x: toSlot.x1, y: toSlot.y1 + slotSpan / 2 }
      : { x: toSlot.x1 + slotSpan / 2, y: toSlot.y1 };
    const revealDoorWall = incomingFace === 'west'
      ? { x1: entryPoint.x, y1: entryPoint.y - DOOR_WIDTH / 2, x2: entryPoint.x, y2: entryPoint.y + DOOR_WIDTH / 2 }
      : { x1: entryPoint.x - DOOR_WIDTH / 2, y1: entryPoint.y, x2: entryPoint.x + DOOR_WIDTH / 2, y2: entryPoint.y };

    // #225: chain every intermediate cell's crossing point to its
    // neighbor's, anchored at the two real room doors just computed above
    // (exitPoint/entryPoint) — the fix for "two pieces sharing a physical
    // boundary don't agree on where they cross it" (see the design spec's
    // own Problem section for the three-symptom repro this closes). The
    // first cell's entry is forced from the SOURCE room's own door; the
    // last cell's exit is forced from the TARGET room's own door; every
    // interior cell's exit becomes the NEXT cell's forced entry, never
    // independently reseeded. A cell's own free perpendicular axis (when
    // entry/exit are adjacent, not opposite, sides) is still seeded via
    // doorOffsetAt inside transitCellCrossing, unchanged — only the FORCED
    // axis stops being random.
    const transitCells = [];
    let chainAnchor = exitPoint;
    for (let i = 1; i < path.length - 1; i += 1) {
      const cell = path[i];
      const cellRect = cellBounds(cell.rank, cell.col);
      const entrySide = directionBetween(cell, path[i - 1]);
      const exitSide = directionBetween(cell, path[i + 1]);
      const isLast = i === path.length - 2;
      const forcedEntryPoint = projectOntoSide(cellRect, entrySide, chainAnchor);
      const forcedExitPoint = isLast ? projectOntoSide(cellRect, exitSide, entryPoint) : undefined;
      const crossing = transitCellCrossing(seed, cell.rank, cell.col, entrySide, exitSide, edgeId, { forcedEntryPoint, forcedExitPoint });
      transitCells.push({ rank: cell.rank, col: cell.col, entrySide, exitSide, edgeId, ...crossing });
      chainAnchor = crossing.exitPoint;
    }

    const firstCellPoint = transitCells[0].entryPoint;
    const lastCellPoint = transitCells[transitCells.length - 1].exitPoint;
    // ... [keep the existing long comment block here verbatim, unchanged] ...
    const corridorSegments = [
      ...cornerConnector(exitPoint, firstCellPoint, { toSide: transitCells[0].entrySide }),
      ...cornerConnector(lastCellPoint, entryPoint, { fromSide: transitCells[transitCells.length - 1].exitSide }),
    ];
```

Everything from `const plainWalls = (...)` onward (line 434 through the function's closing `return { doorWall, revealDoorWall, plainWalls, corridorSegments, transitCells };` at line 445) is unchanged — `firstCellPoint`/`lastCellPoint` now automatically pick up the corrected, chained coordinates, so `cornerConnector`'s own call sites need no changes at all.

- [ ] **Step 4: Run the new tests to verify they pass**

Run: `npx vitest run tests/dungeon-layout.test.mjs -t "buildEdgeCorridor (multi-cell path)"`
Expected: PASS (all tests in this describe block, old and new).

- [ ] **Step 5: Run the full test suite — pre-existing tests must still pass unmodified**

Run: `npx vitest run tests/dungeon-layout.test.mjs`
Expected: PASS, including (do not skip checking these individually if anything fails):
- `'two different edges crossing the same intermediate cell get geometrically distinct, non-conflicting crossings (Review Focus)'` (line 593) — with chaining, the first cell's forced entry is identical between the two edges in this test (same `fromRect`/exit face), but interior cells' still-seeded exit points diverge by `edgeId`, cascading into every downstream forced entry — the test's own `.every(...)` check fails at the first diverging index, so `identicalGeometry` still evaluates to `false`. If this reasoning is wrong for the actual code, do not force the test to pass — investigate and ledger the finding per the SDD ruling process; this is a genuine design question, not a typo.
- The two "west-incoming target" multi-cell tests (`tests/dungeon-layout.test.mjs:739`, `:773`) — must pass with **zero changes to those tests**, confirming the chain generalizes correctly to west-incoming targets.
- The whole-graph "corridor routing regression sweep" describe block (line 1331) — the `overlappingFoundPathEdges` assertion (`toBe(0)`) must still pass; the boxed-in-rate assertion (`<= 0.27`) is unrelated to this plan's own change and must also still pass unchanged (this plan does not touch `findCorridorPath`/`incomingFaceFor`).

- [ ] **Step 6: Commit**

```bash
git add scripts/dungeon-layout.mjs tests/dungeon-layout.test.mjs
git commit -m "$(cat <<'EOF'
buildEdgeCorridor: chain multi-cell transit-cell crossing points (#225)

The multi-cell branch's transitCells loop now threads a chainAnchor
through every intermediate cell: the first cell's entry is forced from
the source room's own real door, the last cell's exit is forced from
the target room's own real door, and every interior cell's exit
becomes the next cell's forced entry. Adjacent pieces of a corridor's
geometry now agree on their shared crossing point by construction,
closing #225 bugs #1 (target door covered), #2 (consecutive cells'
borders mismatched), and the previously-unmeasured source-side
instance of the same defect. Each transitCells entry also now carries
its own edgeId, consumed by the next task's marker fix (bug #3).

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: `buildTransitCellIfNeeded`'s idempotency marker gains the edge id

**Files:**
- Modify: `scripts/dungeon-scene.mjs:178` (the `marker` constant inside `buildTransitCellIfNeeded`) and its own docblock (lines 156-176), plus `buildRoomAtGraphNode`'s manual/live-verification checklist (lines 295-332).

**Interfaces:**
- Consumes: `cell.edgeId` from Task 3's `transitCells` entries (already present on every object passed into this function — see `dungeon-scene.mjs:1206-1208`, `for (const cell of transitCells) { await buildTransitCellIfNeeded(scene, cell); }`).
- Produces: no change to this function's own external behavior/signature beyond which crossings it treats as "already built."

**No automated test** — `scripts/dungeon-scene.mjs` has no Foundry test harness (confirmed by its own docblock at line 296-298: "no Foundry test harness exists for this file"). This task's correctness is established by (a) the diff being a single, easily-reviewed line change, and (b) two new items added to the existing manual/live-verification checklist, checked the next time this module is verified live against a real Foundry world (per this plan's own final close-out, see Task 5's own note, and per [[feedback_worktree_env_and_stale_foundry]] — copy `.env` into this worktree and confirm the live world's module version matches this branch's `module.json` before trusting the result).

- [ ] **Step 1: Update the marker**

In `scripts/dungeon-scene.mjs`, change line 178 from:

```js
  const marker = `${cell.rank},${cell.col}:${cell.entrySide}-${cell.exitSide}`;
```

to:

```js
  const marker = `${cell.rank},${cell.col}:${cell.entrySide}-${cell.exitSide}:${cell.edgeId}`;
```

- [ ] **Step 2: Update the function's own docblock to explain why**

In `scripts/dungeon-scene.mjs`, in `buildTransitCellIfNeeded`'s docblock (lines 156-176), the paragraph beginning "Two different edges can route through the SAME empty cell via DIFFERENT entry/exit side pairs" already correctly describes the INTENT. Add one sentence noting the historical gap, immediately after that paragraph's existing text and before the "Idempotency for this EXACT entry/exit pair..." paragraph:

```js
 * #225 fix: the marker used to omit the edge's own id, so a SECOND edge
 * crossing the same cell with the SAME entry/exit side pair (routine
 * whenever multiple sources converge on one gate face from the same
 * general direction) was silently treated as "already built" and never
 * got its own tiles or opening — this is what `cell.edgeId` in the marker
 * below fixes.
```

- [ ] **Step 3: Add two items to `buildRoomAtGraphNode`'s manual/live-verification checklist**

In `scripts/dungeon-scene.mjs`, in the checklist above `buildRoomAtGraphNode` (currently items (a) through (i), ending at line 331 `... just assumed).`), add two new items:

```js
 * (j) [#225] a multi-cell corridor's target door is never covered by the
 *     final transit cell's own containment wall — the wall's gap and the
 *     room's own real door line up exactly, on a room reached by a
 *     genuinely obstacle-routed (not adjacent) connection.
 * (k) [#225] two different edges that route through the same empty
 *     transit cell (same rank/col, same entry/exit side pair) each get
 *     their own corridor floor tiles and their own opening in that
 *     cell's containment wall — neither edge's crossing silently
 *     disappears.
 */
```

- [ ] **Step 4: Run the existing full test suite to confirm nothing else broke**

Run: `npx vitest run`
Expected: PASS — this change only affects a Foundry-glue file with no automated coverage; the run confirms nothing in `dungeon-layout.mjs`/other test files was accidentally touched.

- [ ] **Step 5: Commit**

```bash
git add scripts/dungeon-scene.mjs
git commit -m "$(cat <<'EOF'
buildTransitCellIfNeeded: include edgeId in the idempotency marker (#225)

Two different edges crossing the same empty transit cell with the same
entry/exit side pair — routine whenever multiple sources converge on
one gate face from the same general direction — used to collide on
this marker and the second edge's own crossing was silently dropped
(no tiles, no opening). Adding edgeId (already present on every
transitCells entry per the previous task) makes each edge's crossing
independently trackable, closing #225 bug #3. No automated test:
scripts/dungeon-scene.mjs has no Foundry test harness (see
buildRoomAtGraphNode's own docblock) — verified via the manual/live
checklist instead (items j/k added).

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: whole-pipeline buildability sweep

**Files:**
- Test: `tests/dungeon-layout.test.mjs` — add one new `it(...)` inside the existing `describe('corridor routing regression sweep (#174)', ...)` block (currently lines 1331-1615), after the boxed-in-rate test (ending line 1614), before that describe block's closing `});`.

**Interfaces:**
- Consumes: `buildEdgeCorridor`'s chained output (Task 3) via the exact same sweep infrastructure the existing "no corridor segment overlaps..." test already uses (`buildRoomGraph`/`attachHiddenPaths`/`computeRanks`/`computeColumns`/`roomRect`/`doorSlotsForFace`).
- Produces: no new exported function — this is a regression test only.

- [ ] **Step 1: Write the failing test**

Add inside `describe('corridor routing regression sweep (#174)', ...)`, after the boxed-in-rate `it(...)` (line 1614) and before the describe block's closing `});` (line 1615):

```js
  // #225: every earlier sweep in this describe block only ever checked a
  // PROXY for buildability — a found path, or a corridor segment not
  // overlapping a room's footprint. Neither catches "a wall's own gap
  // sits at a different position than where the corridor actually
  // crosses that same physical boundary" — the real defect #225 fixed.
  // This sweep checks the actual invariant: for every multi-cell
  // connection produced by the real generation pipeline, the source's
  // real door, the target's real door, and every consecutive pair of
  // transit cells' shared borders all coincide EXACTLY (not just
  // "overlap") with where buildEdgeCorridor's own chain says the corridor
  // crosses them.
  it('every multi-cell corridor\'s crossing points are chained exactly — target door, source door, and every consecutive transit-cell border, across a large seed/roomCount sweep', () => {
    let totalMultiCellEdges = 0;
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
      const rectById = Object.fromEntries(
        Object.keys(rooms).map((id) => [id, roomRect(seed, id, positionByRoomId[id].rank, positionByRoomId[id].col)]),
      );

      for (const [fromId, children] of Object.entries(edges)) {
        for (let idx = 0; idx < children.length; idx += 1) {
          const toId = children[idx];
          const fromRect = rectById[fromId];
          const toRect = rectById[toId];
          const fromPos = positionByRoomId[fromId];
          const toPos = positionByRoomId[toId];
          const face = exitFaceForIndex(idx);
          const toSlot = doorSlotsForFace(toRect, 1, 'north')[0];
          const result = buildEdgeCorridor(
            seed, fromId, toId, fromRect, toRect, fromPos, toPos,
            face, toSlot, occupiedCells,
          );
          if (result.transitCells.length === 0) continue; // only multi-cell connections are in scope here
          totalMultiCellEdges += 1;

          // (a) source's own real door, recovered from doorWall's own
          // center. Only the axis matching the first transit cell's own
          // entrySide is FORCED to this value — north/south entrySide
          // forces x (the corridor descended/ascended straight into the
          // cell, so x carries over); east/west entrySide forces y. The
          // OTHER axis is legitimately the transit cell's own fixed
          // boundary coordinate, not the room's door coordinate: the
          // room's south/east face always sits inside a margin gap
          // (ROOM_SIZE_SMALL/LARGE are both < ROW_STRIDE/COLUMN_STRIDE),
          // so when the BFS path's first hop heads sideways instead of
          // straight out the room's own exit face, the connector's OTHER
          // leg bridges that perpendicular distance instead — asserting
          // both axes unconditionally here would be wrong, not a real
          // defect (confirmed by hand-derivation during this plan's own
          // design; see Task 3's straight-descent test for the case where
          // both axes DO coincide, by construction, when entrySide directly
          // opposes exitFace).
          const sourceDoorX = (result.doorWall.x1 + result.doorWall.x2) / 2;
          const sourceDoorY = (result.doorWall.y1 + result.doorWall.y2) / 2;
          const firstEntrySide = result.transitCells[0].entrySide;
          if (firstEntrySide === 'north' || firstEntrySide === 'south') {
            expect(result.transitCells[0].entryPoint.x).toBeCloseTo(sourceDoorX, 9);
          } else {
            expect(result.transitCells[0].entryPoint.y).toBeCloseTo(sourceDoorY, 9);
          }

          // (b) target's own real door, recovered from revealDoorWall's
          // own center — unlike the source side, BOTH axes always
          // coincide here unconditionally: a room always anchors flush at
          // its own cell's north/west corner (no margin on those two
          // sides), and findCorridorPath's canEnter constraint always
          // makes the LAST transit cell exactly the target's own
          // incoming-neighbor cell — so the shared boundary line's other
          // coordinate is always exactly the room's own cell edge too,
          // not just the forced axis.
          const targetDoorX = (result.revealDoorWall.x1 + result.revealDoorWall.x2) / 2;
          const targetDoorY = (result.revealDoorWall.y1 + result.revealDoorWall.y2) / 2;
          const lastCell = result.transitCells[result.transitCells.length - 1];
          expect(lastCell.exitPoint.x).toBeCloseTo(targetDoorX, 9);
          expect(lastCell.exitPoint.y).toBeCloseTo(targetDoorY, 9);

          // (c): every consecutive pair of transit cells' shared border —
          // one cell's exit must exactly equal the next cell's entry.
          for (let ci = 0; ci < result.transitCells.length - 1; ci += 1) {
            expect(result.transitCells[ci].exitPoint).toEqual(result.transitCells[ci + 1].entryPoint);
          }

          // (d): edgeId survives onto every transitCells entry, unchanged
          // — this is what lets two edges crossing the same cell (#225
          // bug #3) each get their own opening, per Task 4's marker fix.
          const expectedEdgeId = `${fromId}->${toId}`;
          for (const cell of result.transitCells) {
            expect(cell.edgeId).toBe(expectedEdgeId);
          }
        }
      }
    }
    expect(totalMultiCellEdges).toBeGreaterThan(50); // sanity: real multi-cell corridors were actually exercised
  });
```

- [ ] **Step 2: Run the test to verify it passes**

This task is written LAST, after Tasks 1-4 are already implemented and committed — it is a whole-pipeline regression guard for a fix already in place, not a unit spec driving new production code, so there is no separate "must fail first" step the way there was for Tasks 1-3.

Run: `npx vitest run tests/dungeon-layout.test.mjs -t "every multi-cell corridor's crossing points are chained exactly"`
Expected: PASS. If it fails, the chaining fix (Task 3) has a gap somewhere the buildEdgeCorridor-level tests in Task 3 didn't already catch — investigate and fix Task 3's own implementation (do not weaken this test to make it pass).

- [ ] **Step 3: Run the full test suite**

Run: `npx vitest run`
Expected: PASS — every test file in the suite, not just `dungeon-layout.test.mjs`.

- [ ] **Step 4: Commit**

```bash
git add tests/dungeon-layout.test.mjs
git commit -m "$(cat <<'EOF'
Add whole-pipeline buildability sweep for multi-cell corridors (#225)

Every earlier sweep in this file's corridor-routing regression
describe block checked a proxy for buildability (a found path, or no
footprint overlap) — never whether a wall's own gap actually lines up
with where the corridor crosses that same boundary, the real defect
#225 fixed. This sweep checks the real invariant directly across a
500-seed sweep: source door, target door, and every consecutive
transit-cell border coincide exactly, and edgeId survives onto every
transitCells entry.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Final close-out (after all 5 tasks)

Per this plan's own Task 4, `scripts/dungeon-scene.mjs` has no automated test harness — the marker fix (bug #3) needs live Foundry verification before this plan is considered fully proven, not just code-reviewed. Before merging:

1. Copy `.env` into this worktree from the main repo root, and confirm the live world's `game.modules.get('pf2e-dungeon-crawl').version` matches this branch's own `module.json` — both per [[feedback_worktree_env_and_stale_foundry]] — before trusting any live result.
2. Generate a dungeon whose layout includes at least one multi-cell (obstacle-routed) corridor, and confirm checklist items (j) and (k) added in Task 4 by inspection in the live scene.
3. Bump `module.json`'s version (patch bump — this is a routine fix, not an architecture-level change) per this repo's own `CLAUDE.md` versioning rule, in the same commit/PR that closes this plan out.
4. Run the `update-architecture-docs` skill only if this plan added/removed/rewired a `scripts/` file's imports — it did not (only existing files were modified), so this step is a no-op; confirm and skip.
