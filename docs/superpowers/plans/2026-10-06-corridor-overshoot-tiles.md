# Corridor Overshoot Tile Drop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix #859 — a corridor never draws a floor tile on a cell that falls inside a room's own rect (the "zero-length final leg" overshoot `cornerConnector`'s own `max(1,...)` occasionally produces), without changing the cell list #779's own trap placement reads.

**Root cause (confirmed current):** `corridorTilesForSegments` (the low-level per-segment tile builder, confirmed current `scripts/dungeon-scene.mjs`) has no concept of room rects at all — by design, it's a generic segment-to-tiles converter shared with transit-cell crossings. Room-rect awareness already exists one level up, in `corridorTrapCandidateCells` (confirmed current, excludes a cell inside either room's rect from **trap placement** — #779's own fix for the identical overshoot). The *tile-drawing* side of the exact same overshoot was deliberately left alone by #779's own scope, confirmed by its own still-passing test `"corridor floor tiles still include the overshoot cell (art output unchanged)"` — #859 is the follow-up that now wants it filtered too.

**Architecture:** A new pure function, `dropCorridorTilesInRects`, filters an array of corridor *tile objects* (not cells) by deriving each tile's own grid cell from its pixel position (the same technique `corridorCellKeyOfTile`, confirmed current, already uses) and dropping any whose cell falls inside one of the given room rects. It's applied only at the one real scene-building call site that pushes `edgePlan.main` into the room's own `tiles` array — `corridorTilesForSegments`, `corridorEdgeTiles`, and `corridorTrapCandidateCells`'s own unfiltered cell list (read by #779's trap placement) are all untouched, matching the issue's own explicit "without changing the cells #779 reads for trap candidates."

**Tech Stack:** Vanilla ES modules, Vitest.

**Spec:** None — a bounded, fully-diagnosed bug fix reusing an already-proven exclusion technique (#779's own `corridorTrapCandidateCells`) one layer up.

## Global Constraints

- Every merge to `main` bumps `module.json`'s `version` (CLAUDE.md). A routine rendering bug fix: patch bump. Re-check the current version immediately before committing, since concurrent sessions push to this repo.
- `corridorTilesForSegments`'s own return shape and every one of its existing callers (transit-cell crossings, `corridorEdgeTiles` itself) are unchanged — the fix is additive, applied only at the room-build call site.
- `edgePlan.mainCells`/`corridorTrapCandidateCells`'s own input and output are completely unaffected — #779's trap placement must keep seeing the exact same candidate cells as before.
- `corridorCellKeyOfTile`'s own existing behavior and callers (`skipClaimedCorridorTiles`, confirmed current) are unchanged — the new cell-derivation logic is factored out as a shared helper, not duplicated.
- Transit-cell crossing tiles are out of scope — overshoot is specifically a main-segment/room-boundary phenomenon; a transit cell is an intermediate routing waypoint that doesn't touch a room's own rect by construction.

## Review Focus

- **A main-segment tile whose cell falls inside the destination room's rect must never be drawn**, matching the issue's own primary complaint.
- **A main-segment tile whose cell falls inside the *source* room's rect must also never be drawn** — the same overshoot can occur at either end of a corridor, and `corridorTrapCandidateCells`'s own existing precedent already excludes both rects, not just one.
- **Every legitimate (non-overshoot) corridor tile must still be drawn, unchanged** — an overly broad filter that drops real corridor floor would be a worse regression than the bug it fixes.
- **#779's own trap-candidate cell list must be bit-for-bit unaffected** — confirmed by a dedicated test, not just by reading the code once.
- **`corridorTilesForSegments`'s own low-level behavior (still including the overshoot cell when called directly, e.g. for a transit crossing) must stay exactly as documented** — the existing test asserting this must keep passing unmodified.

---

### Task 1: The drop-in-rect filter

**Files:**
- Modify: `scripts/dungeon-scene.mjs` (`corridorCellKeyOfTile` refactor, new `corridorCellOfTile`/`dropCorridorTilesInRects`, wired into the room-build call site)
- Test: `tests/dungeon-scene-trap-placement.test.mjs` (reusing its own existing `overshoot` mock and `cState`/`cBuild`/`EDGE` fixtures — the exact established home for this exact overshoot scenario, confirmed current)

**Interfaces:**
- Produces: `corridorCellOfTile(tile): {gx, gy} | null` (the grid cell a corridor tile occupies, or `null` for non-corridor art — the numeric sibling of the existing `corridorCellKeyOfTile`, which now delegates to it). `dropCorridorTilesInRects(tiles, rects): tiles[]` — drops any tile whose own cell falls inside one of `rects`. Consumed at the one real call site in `buildPopulateAndUnlockGraphNode`.

- [ ] **Step 1: Write the failing tests**

Add to `tests/dungeon-scene-trap-placement.test.mjs`, inside the existing `describe("#779 corridor trap never lands inside a room (overshoot cell)", ...)` block (reusing its own `overshoot`/`cState`/`cBuild`/`rects`/`inRect` helpers exactly — confirmed current):

```js
  it("#859: a corridor floor tile is never drawn on a cell inside either room's rect", async () => {
    overshoot.on = true;
    const st = cState();
    const [fr, tr] = rects(st);
    const scene = makeScene();
    await cBuild(scene, st);
    const corridorTiles = scene.tiles.filter((t) => /corridor/.test(t.texture?.src ?? ""));
    expect(corridorTiles.length).toBeGreaterThan(0); // the fixture still draws real corridor floor
    for (const t of corridorTiles) {
      const cell = { gx: t.x / 100, gy: t.y / 100 };
      expect(inRect(cell, fr) || inRect(cell, tr)).toBe(false);
    }
  });

  it("#859: the overshoot cell's own trap-candidate list is unaffected by the tile filter", async () => {
    overshoot.on = true;
    const st = cState();
    // Unfiltered cell list #779's trap placement reads -- same call shape
    // this file's own existing edgeCells() helper already uses.
    const cellsWithOvershoot = edgeCells(st);
    expect(cellsWithOvershoot.some((c) => inRect(c, rects(st)[1]))).toBe(true); // still overshoots, unfiltered
  });
```

Add a new unit-level `describe` for the pure helper itself, in the same file or wherever its own sibling `corridorCellKeyOfTile`/`skipClaimedCorridorTiles` are already tested (check `tests/corridor-pieces.test.mjs`/`tests/dungeon-scene-corridor-edge-tiles.test.mjs` first for the real existing location before picking one):

```js
describe('dropCorridorTilesInRects (#859)', () => {
  const corridorTile = (gx, gy, src = 'modules/pf2e-dungeon-crawl/assets/dungeon-rooms/corridor-mid.webp') => ({
    texture: { src }, x: gx * 100 + 50, y: gy * 100 + 50,
  });

  it('drops a tile whose cell is inside a rect, keeps the rest', () => {
    const tiles = [corridorTile(4, 1), corridorTile(378, 41), corridorTile(380, 40)];
    const dst = { gx: 378, gy: 39, gw: 6, gh: 6 };
    expect(dropCorridorTilesInRects(tiles, [dst])).toEqual([corridorTile(4, 1), corridorTile(380, 40)]);
  });

  it('checks every given rect, not just the first', () => {
    const tiles = [corridorTile(4, 1)];
    const src = { gx: 0, gy: 0, gw: 6, gh: 6 };
    const dst = { gx: 378, gy: 39, gw: 6, gh: 6 };
    expect(dropCorridorTilesInRects(tiles, [src, dst])).toEqual([]);
  });

  it('never touches a non-corridor tile (room floor art)', () => {
    const roomTile = { texture: { src: 'modules/pf2e-dungeon-crawl/assets/dungeon-rooms/aberration-0.webp' }, x: 450, y: 450 };
    const dst = { gx: 4, gy: 4, gw: 1, gh: 1 };
    expect(dropCorridorTilesInRects([roomTile], [dst])).toEqual([roomTile]);
  });
});
```

Add `dropCorridorTilesInRects` to this test file's existing multi-line import from `../scripts/dungeon-scene.mjs`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/dungeon-scene-trap-placement.test.mjs -t "#859"`
Expected: FAIL — overshoot tiles still land inside the room rect today.

- [ ] **Step 3: Refactor `corridorCellKeyOfTile` and add the new functions**

In `scripts/dungeon-scene.mjs`, change (confirmed current):

```js
const CORRIDOR_TILE_SRC = /\/corridor(?:-[a-z]+)?\.webp$/;

/** "gx,gy" of a corridor tile (centre-anchored: x/y = cell*100 + 50), or null
 * for anything that is not corridor art (room floors, etc.). */
export function corridorCellKeyOfTile(tile) {
  const src = tile.texture?.src ?? tile.texture ?? "";
  if (!CORRIDOR_TILE_SRC.test(String(src))) return null;
  return `${Math.round((tile.x - 50) / 100)},${Math.round((tile.y - 50) / 100)}`;
}
```

to:

```js
const CORRIDOR_TILE_SRC = /\/corridor(?:-[a-z]+)?\.webp$/;

/** The grid cell {gx, gy} a corridor tile occupies (centre-anchored: x/y =
 * cell*100 + 50), or null for anything that is not corridor art (room
 * floors, etc.). */
export function corridorCellOfTile(tile) {
  const src = tile.texture?.src ?? tile.texture ?? "";
  if (!CORRIDOR_TILE_SRC.test(String(src))) return null;
  return { gx: Math.round((tile.x - 50) / 100), gy: Math.round((tile.y - 50) / 100) };
}

/** "gx,gy" of a corridor tile, or null -- see corridorCellOfTile. */
export function corridorCellKeyOfTile(tile) {
  const cell = corridorCellOfTile(tile);
  return cell ? `${cell.gx},${cell.gy}` : null;
}

/**
 * #859: drops a corridor tile whose cell falls inside any of `rects` -- a
 * room's own floor already covers that cell, so drawing a corridor tile
 * there too is always wrong. The "zero-length final leg" overshoot
 * (cornerConnector's own `max(1,...)`) occasionally produces exactly this
 * cell. #779's own corridorTrapCandidateCells already excludes the same
 * cells from trap placement; this is the tile-drawing side of the
 * identical fix, applied independently so a caller reading the unfiltered
 * cell list (trap placement) is unaffected.
 */
export function dropCorridorTilesInRects(tiles, rects) {
  return tiles.filter((tile) => {
    const cell = corridorCellOfTile(tile);
    if (!cell) return true;
    return !rects.some(
      (r) => cell.gx >= r.gx && cell.gx < r.gx + r.gw && cell.gy >= r.gy && cell.gy < r.gy + r.gh,
    );
  });
}
```

- [ ] **Step 4: Wire it into the room-build call site**

Change (confirmed current):

```js
      tiles.push(
        ...skipClaimedCorridorTiles(edgePlan.main, claimedCorridorCells).map((t) => ({
          ...t,
          flags: { [MODULE_ID]: { dungeonCorridorEdge: edgeId } },
        })),
      );
```

to:

```js
      tiles.push(
        ...dropCorridorTilesInRects(
          skipClaimedCorridorTiles(edgePlan.main, claimedCorridorCells),
          [sourceRect, rect],
        ).map((t) => ({
          ...t,
          flags: { [MODULE_ID]: { dungeonCorridorEdge: edgeId } },
        })),
      );
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run tests/dungeon-scene-trap-placement.test.mjs`
Expected: PASS, old and new cases green — in particular, the existing `"corridor floor tiles still include the overshoot cell (art output unchanged)"` test (confirmed current, calls `corridorTilesForSegments` *directly*, not through the room-build path this plan touches) stays green unmodified, confirming the fix is correctly scoped to the higher-level call site only.

- [ ] **Step 6: Run the full test suite to confirm no regression**

Run: `npx vitest run`
Expected: PASS — in particular every other #823 test (`tests/dungeon-scene-corridor-edge-tiles.test.mjs`, `tests/dungeon-corridor-joins-sweep.test.mjs`, `tests/corridor-pieces.test.mjs`) stays green, confirming the join/dedup/openings logic those tests cover is unaffected by this additive filter.

- [ ] **Step 7: Commit**

```bash
git add scripts/dungeon-scene.mjs tests/dungeon-scene-trap-placement.test.mjs
git commit -m "fix(#859): never draw a corridor tile on a cell inside a room's rect

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 2: Live verification (sweep), version bump

**Files:**
- Modify: `module.json`

No code changes in this task — verification and the version bump only.

- [ ] **Step 1: Run a real sweep to confirm the fix**

Reproducing the issue's own methodology (100 routed seeds, layout v3 + topology routing): generate a batch of real dungeon runs via `foundry-rest` and confirm no corridor tile's own `(x,y)` lands inside any room's own rect, mirroring this session's own real tile-inspection technique from #823's investigation:

```bash
echo 'const tiles = canvas.scene.tiles.contents; const rooms = Object.values((await import("/modules/pf2e-dungeon-crawl/scripts/dungeon-runner.mjs")).getRunState(canvas.scene.id).rooms); return { tileCount: tiles.length, roomCount: rooms.length };' | .claude/skills/foundry-rest/foundry-exec.sh
```

(Adjust to whatever's the cleanest live-reachable way to cross-check tile positions against room rects in this specific world — the Vitest-level fixture sweep in Task 1 is the real, primary confirmation; this live step is a sanity spot-check on actual generated content, matching the issue's own "verify with a sweep" instruction, in the actual running game rather than only in the test suite.)

- [ ] **Step 2: Bump module.json's version**

Re-check the current version first (concurrent sessions push to this repo):

```bash
git fetch origin main -q && git log origin/main -1 --oneline && grep version module.json
```

Apply a **patch** bump (a rendering bug fix), using whatever the fetch above shows as current.

- [ ] **Step 3: Commit**

```bash
git add module.json
git commit -m "chore(#859): bump version for the corridor overshoot tile fix

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Self-Review

**1. Scope coverage:** #859's own ask ("stop laying corridor tiles whose cell lies inside the destination room's rect, without changing the cells #779 reads for trap candidates... verify with a sweep") is fully covered: the filter applies to both room rects (source and destination, matching #779's own established precedent, not just the one the issue names first), trap candidates are confirmed unaffected by a dedicated test, and both a Vitest-level sweep (Task 1) and a live sweep (Task 2) verify the fix.

**2. Placeholder scan:** No TBD/TODO. Every code block is the complete real change.

**3. Type consistency:** `corridorCellOfTile(tile): {gx,gy}|null` and `corridorCellKeyOfTile`'s own refactored delegation to it keep `corridorCellKeyOfTile`'s existing signature and behavior completely unchanged for its one existing caller (`skipClaimedCorridorTiles`). `dropCorridorTilesInRects(tiles, rects)` mirrors `corridorTrapCandidateCells(cells, rects)`'s own rect-membership test exactly, just operating on tile objects instead of bare cells.

**4. Review Focus:** All five items (destination-room overshoot dropped, source-room overshoot also dropped, legitimate tiles unaffected, trap candidates unaffected, `corridorTilesForSegments`'s own low-level behavior unchanged) each map to a specific test. No gaps found.

---

Plan complete and saved to `docs/superpowers/plans/2026-10-06-corridor-overshoot-tiles.md`.
