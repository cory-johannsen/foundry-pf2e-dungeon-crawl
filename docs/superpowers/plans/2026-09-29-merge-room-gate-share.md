# Merge-Room Second-Parent Corridor Overlap Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop `buildEdgeCorridor`'s same-column/same-rank fast-path null-path fallback from drawing a corridor through an intermediate blocking room's own footprint, by routing it through that room's own margin band instead.

**Architecture:** When the fast path's straight-line fallback would cross an occupied intermediate room's rect, reroute the corridor through a dogleg: turn out of the door's own column into the blocking room's east (or south) margin lane *while still inside the source room's own margin band* (never inside the blocking cell itself — a room's floor starts immediately at its own cell's NW corner, so there is no y-range inside the blocking cell where a lateral turn wouldn't overlap its floor), then run straight down that lane past the blocker. `cellMarginWalls` generalizes to support a second, independent opening on a side (the blocking room's own outgoing gap, if any, plus this foreign pass-through gap). Because this module performs eager, full-graph pregeneration (`roomsToEagerlyBuild`), a room's own margin walls can determine whether they need a foreign opening via a pure scan of the already-fully-known `state.edges`/`state.layoutPositionByRoomId` — no persisted registry, no retroactive wall-patching.

**Tech Stack:** Vanilla JS (ESM), Vitest, Foundry VTT v13/v14 module (`pf2e-dungeon-crawl`).

**Spec:** `docs/superpowers/specs/2026-09-29-merge-room-gate-share-design.md`

## Global Constraints

- `ROOM_SIZE_SMALL = 6`, `ROOM_SIZE_LARGE = 12`, `CORRIDOR_LEN = DOOR_WIDTH = 1`, `ROW_STRIDE = COLUMN_STRIDE = 13`, `INITIAL_GX = 300` (`scripts/dungeon-layout.mjs`).
- A room always anchors at its own cell's NW corner (`roomRect`): `roomRect(seed, roomId, rank, col).gx/gy === cellBounds(rank, col).gx/gy` always. Only east/south margin can ever exist.
- Scope is EXACTLY: `buildEdgeCorridor`'s `exitFace === 'south' && sameColumn` and `exitFace === 'east' && sameRank` branches, null-path (`!path`) case, and only when `toPos.rank === fromPos.rank + 2` (south) or `toPos.col === fromPos.col + 2` (east) — exactly one intermediate cell. Any larger gap, or the generic corner-fallback branch, is untouched and remains a documented residual.
- Do not touch `findCorridorPath`, `incomingFaceFor`, or the multi-cell (`path.length > 2`) branch.
- Every merge to `main` bumps `module.json`'s `version` (this repo's `CLAUDE.md`) — this plan's own bump is a **minor** bump (architecture-level change): `0.50.3` → `0.51.0`. Do not reuse a version number; if `main` has moved since this plan started, bump past whatever `main` has (see `feedback_ticket_before_work`/#288's own merge-conflict resolution for the exact recovery steps if that happens).
- No new files — every change lands in the two files this subsystem already lives in (`scripts/dungeon-layout.mjs`, `scripts/dungeon-scene.mjs`) and their existing test files. `docs/architecture.md` does not need refreshing (no new file, no new cross-file import edge).

## Review Focus

1. **Containment around the dogleg's own turn segment (inside the source room's own margin band) and lane segment (inside the blocking room's own margin)** — this file's own #294 lesson: a corridor floor being narrow doesn't itself stop movement; only walls do. Verify no gap lets a token step sideways out of the 1-wide dogleg path anywhere along its route, not just the straight-run portions. This is the single most likely place for a review to find a real defect, mirroring #294's own first-draft regression.
2. **The blocking room's own real connections aren't broken by the new foreign opening** — a blocking room can have its own outgoing connection (its own south/east margin gap) independent of the foreign pass-through opening this plan adds. Both must coexist on the same `cellMarginWalls` call without one clamping into or covering the other.
3. **The target's own door gap must track wherever the dogleg's lane actually lands**, not the original (now-abandoned) `doorX0` — the exact "two things must agree on a shared boundary" shape this file has hit four times already (`feedback_found_path_not_buildable_path`). A test asserting point equality never catches this; only a test reconstructing the real wall/gap geometry does.
4. **The dogleg activates only when actually needed** — when `doorX0` already falls in the blocking room's own margin (not its footprint), the existing straight-line behavior must be byte-identical to today's output; a sweep should confirm zero behavior change for every edge that doesn't need a dogleg.
5. **`cellMarginWalls`'s generalized multi-opening sealing is correct when only one opening is present** (the overwhelmingly common case, every room without a second real parent's shortcut nearby) — the existing single-opening test suite must keep passing unmodified, proving the generalization is a strict superset of the old behavior, not a rewrite that happens to pass the same assertions differently.

---

### Task 1: Generalize `cellMarginWalls` to support multiple openings per side

**Files:**
- Modify: `scripts/dungeon-layout.mjs:1009-1035` (`cellMarginWalls`)
- Test: `tests/dungeon-layout.test.mjs`

**Interfaces:**
- Consumes: nothing new from other tasks.
- Produces: `cellMarginWalls(rect, rank, col, openingsBySide)` — new signature. `openingsBySide` is `{ east?: Array<{offset, width}>, south?: Array<{offset, width}> }`, each array holding zero or more independent gaps on that side (today: at most one, a room's own outgoing gap; after Task 4: at most two, that gap plus one foreign pass-through gap). Returns the same shape as today: an array of `{dir, x1, y1, x2, y2}` wall segments, now with N+1 segments per side instead of at most 2, when N openings are present.

- [ ] **Step 1: Write the failing tests**

Add to `tests/dungeon-layout.test.mjs`, near the existing `cellMarginWalls` describe block:

```js
describe('cellMarginWalls — multiple openings per side', () => {
  it('seals a side with two non-overlapping openings into three segments', () => {
    const rect = { gx: 300, gy: 0, gw: 6, gh: 6 };
    const walls = cellMarginWalls(rect, 0, 0, {
      east: [{ offset: 1, width: 1 }, { offset: 4, width: 1 }],
    });
    const eastWalls = walls.filter((w) => w.dir === 'east').sort((a, b) => a.y1 - b.y1);
    // cell is (300,0)-13x13; rect is 6x6, so east margin runs y:[0,13].
    // Two 1-wide gaps at y=1 and y=4 split the east side into three segments:
    // [0,1], [2,4], [5,13].
    expect(eastWalls).toEqual([
      { dir: 'east', x1: 306, y1: 0, x2: 306, y2: 1 },
      { dir: 'east', x1: 306, y1: 2, x2: 306, y2: 4 },
      { dir: 'east', x1: 306, y1: 5, x2: 306, y2: 13 },
    ]);
  });

  it('with a single opening, matches the old single-opening call exactly', () => {
    const rect = { gx: 300, gy: 0, gw: 6, gh: 6 };
    const oldStyle = cellMarginWalls(rect, 0, 0, { east: [{ offset: 2, width: 1 }] });
    // Same result whether expressed as the old openSide/openOffset/openWidth
    // shape or the new list-of-one shape — this pins the generalization as
    // a strict superset, not a behavior change, for the common case.
    expect(oldStyle).toEqual([
      { dir: 'east', x1: 306, y1: 0, x2: 306, y2: 2 },
      { dir: 'east', x1: 306, y1: 3, x2: 306, y2: 13 },
    ]);
  });

  it('with no openings on a margin-having side, seals it fully (unchanged behavior)', () => {
    const rect = { gx: 300, gy: 0, gw: 6, gh: 6 };
    const walls = cellMarginWalls(rect, 0, 0, {});
    expect(walls).toEqual([
      { dir: 'east', x1: 306, y1: 0, x2: 306, y2: 13 },
      { dir: 'south', x1: 300, y1: 6, x2: 306, y2: 6 },
    ]);
  });

  it('a LARGE room (no margin on a side) ignores openings for that side', () => {
    const rect = { gx: 300, gy: 0, gw: 12, gh: 12 };
    const walls = cellMarginWalls(rect, 0, 0, { east: [{ offset: 0, width: 1 }] });
    // gw === cell.gw (13? no -- LARGE=12, cell=13, margin=1, so east DOES
    // have margin here) -- use gw===cell.gw case instead: a room exactly
    // filling the cell has no margin on that side at all.
    const fullRect = { gx: 300, gy: 0, gw: 13, gh: 13 };
    const noMarginWalls = cellMarginWalls(fullRect, 0, 0, { east: [{ offset: 0, width: 1 }] });
    expect(noMarginWalls.filter((w) => w.dir === 'east')).toEqual([]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/dungeon-layout.test.mjs -t "cellMarginWalls — multiple openings"`
Expected: FAIL — `cellMarginWalls` still has the old `{openSide, openOffset, openWidth}` signature, so calling it with `{east: [...]}` produces different (wrong) output.

- [ ] **Step 3: Reimplement `cellMarginWalls`**

Replace `scripts/dungeon-layout.mjs:1009-1035`:

```js
/**
 * Seals a room's grid-cell margin beyond its own rect (see original
 * docblock above this function, unchanged — the L-shaped-margin
 * reasoning, the #288 `rect.gw < cell.gw` fix, all still apply).
 *
 * #297: generalized from a single `{openSide, openOffset, openWidth}` to
 * `openingsBySide` (`{ east?: [{offset, width}], south?: [{offset, width}]
 * }`), so a side can carry the room's OWN outgoing gap and an independent
 * FOREIGN pass-through gap (another edge's dogleg routed through this
 * room's own margin) at once — needed because a foreign dogleg's lane can
 * land on the same side as this room's own outgoing connection. Every
 * existing call site passing a single opening is expressible as a
 * one-element array on that side; this function's own test suite pins
 * that the single-opening case produces byte-identical output to the old
 * single-opening signature (see this task's own review focus).
 */
export function cellMarginWalls(rect, rank, col, openingsBySide = {}) {
  const cell = cellBounds(rank, col);
  const walls = [];

  const sealSide = (dir, hasMargin, along) => {
    if (!hasMargin) return;
    const openings = (openingsBySide[dir] ?? [])
      .slice()
      .sort((a, b) => a.offset - b.offset);
    const full = dir === 'east' ? cell.gh : cell.gw;
    let cursor = 0;
    for (const { offset, width } of openings) {
      const gapStart = offset;
      const gapEnd = offset + width;
      if (gapStart > cursor) walls.push(along(cell.gx, cell.gy, cell.gx + cell.gw, cell.gy + cell.gh, cursor, gapStart));
      cursor = Math.max(cursor, gapEnd);
    }
    if (cursor < full) walls.push(along(cell.gx, cell.gy, cell.gx + cell.gw, cell.gy + cell.gh, cursor, full));
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

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/dungeon-layout.test.mjs -t "cellMarginWalls"`
Expected: PASS — both the new multi-opening tests and every pre-existing `cellMarginWalls` test (which must be updated to the new call shape in this same step — see Step 5).

- [ ] **Step 5: Update every existing `cellMarginWalls` call site and test to the new signature**

Search `scripts/dungeon-layout.mjs` and `scripts/dungeon-scene.mjs` for `cellMarginWalls(` — every call currently passing `{ openSide, openOffset, openWidth }` becomes `{ [openSide]: [{ offset: openOffset, width: openWidth }] }` when `openSide` is non-null, or `{}` when it's the no-opening call. `scripts/dungeon-scene.mjs`'s two call sites (inside `buildRoomAtGraphNode`, `scripts/dungeon-scene.mjs:434` and `:439`) are rewritten fully in Task 4 below — leave them as-is for now if this step's mechanical rewrite would conflict; Task 4 supersedes them. Update every pre-existing `cellMarginWalls` test in `tests/dungeon-layout.test.mjs` (search for `cellMarginWalls(`) to the new call shape, asserting identical expected output to before (the whole point of this task is that single-opening behavior is unchanged).

Run: `npx vitest run tests/dungeon-layout.test.mjs`
Expected: PASS, full file.

- [ ] **Step 6: Commit**

```bash
git add scripts/dungeon-layout.mjs tests/dungeon-layout.test.mjs
git commit -m "feat(#297): generalize cellMarginWalls to support multiple openings per side"
```

---

### Task 2: Dogleg detection + geometry in `buildEdgeCorridor`'s south fast path

**Files:**
- Modify: `scripts/dungeon-layout.mjs:500-631` (the `exitFace === 'south' && sameColumn` branch)
- Test: `tests/dungeon-layout.test.mjs`

**Interfaces:**
- Consumes: `roomRect`, `cellBounds`, `cornerConnector` (private to the file — this task must export it or inline its two-segment math; see Step 3's note), `DOOR_WIDTH`, `ROW_STRIDE` (all already in scope in this file).
- Produces: `buildEdgeCorridor`'s return value gains a new field, `foreignOpening`: `{ roomId, side: 'east' | 'south', offset, width } | null`. `null` for every call that doesn't need a dogleg (the overwhelming majority) — existing callers that don't read this field are unaffected.

- [ ] **Step 1: Write the failing tests**

Add to `tests/dungeon-layout.test.mjs`:

```js
describe('buildEdgeCorridor — #297 dogleg around a blocking intermediate room', () => {
  // Mirrors the live-reported repro: source at rank 0, target (a merge
  // room reached via a shortcut) at rank 2, same column -- with an
  // unrelated room occupying rank 1 of that same column whose footprint
  // the naive direct line would cross. A LARGE source room (gw=12) and a
  // SMALL blocking room (gw=6) reproduces the live scenario's own size
  // mix and guarantees doorX0 can land inside the blocker's narrower
  // footprint.
  const seed = 'dogleg-repro-seed';

  function findDoorOffsetInsideBlocker(fromRect, blockerGw) {
    // doorOffsetAt is deterministic per (seed, slot, role, roomSize) -- for
    // THIS seed/fromRoomId/exitFace combination it's a fixed value; this
    // helper just documents the intent for whoever re-derives the seed
    // later. The concrete seed above was chosen (see Step 1a) so the real
    // outgoingOffset it produces at 'from-room-south' already lands inside
    // a 6-wide blocker's own footprint -- no runtime search needed.
  }

  it('routes around a blocking room instead of crossing its footprint', () => {
    const fromRoomId = 'from-room';
    const toRoomId = 'to-room';
    const blockerRoomId = 'blocker-room';
    const fromPos = { rank: 0, col: 0 };
    const toPos = { rank: 2, col: 0 };
    const fromRect = roomRect(seed, fromRoomId, fromPos.rank, fromPos.col);
    const toRect = roomRect(seed, toRoomId, toPos.rank, toPos.col);
    const occupiedCells = {
      '0,0': fromRoomId,
      '1,0': blockerRoomId,
      '2,0': toRoomId,
    };
    const toSlot = doorSlotsForFace(toRect, 1, 'north')[0];

    const result = buildEdgeCorridor(
      seed, fromRoomId, toRoomId, fromRect, toRect, fromPos, toPos,
      'south', toSlot, occupiedCells, 'north',
    );

    const blockerRect = roomRect(seed, blockerRoomId, 1, 0);
    const blockerRight = blockerRect.gx + blockerRect.gw;

    // The real property, not a proxy: no corridor floor segment overlaps
    // the blocker's own rect at all.
    for (const seg of result.corridorSegments) {
      const overlapsX = seg.gx < blockerRect.gx + blockerRect.gw && seg.gx + seg.gw > blockerRect.gx;
      const overlapsY = seg.gy < blockerRect.gy + blockerRect.gh && seg.gy + seg.gh > blockerRect.gy;
      expect(overlapsX && overlapsY).toBe(false);
    }

    // A dogleg was actually exercised for this scenario (the whole point
    // of the test) -- if this ever fails, the seed no longer produces a
    // doorX0 inside the blocker's footprint and must be re-chosen.
    expect(result.foreignOpening).not.toBeNull();
    expect(result.foreignOpening.roomId).toBe(blockerRoomId);
    expect(result.foreignOpening.side).toBe('east');
    // The foreign opening's own offset must describe a gap that starts at
    // (or past) the blocker's own east edge, within the blocker's cell.
    const blockerCell = cellBounds(1, 0);
    expect(blockerCell.gx + result.foreignOpening.offset).toBeGreaterThanOrEqual(blockerRight);
    expect(result.foreignOpening.width).toBe(DOOR_WIDTH);
  });

  it('does not activate when the blocker exists but its footprint misses the fixed door column', () => {
    // A LARGE blocker (gw=12, filling almost the whole cell) whose own
    // margin the source's doorX0 might already sit past -- construct a
    // case where the blocker's own rect does NOT contain doorX0 and
    // confirm output is byte-identical to calling with no dogleg logic
    // (i.e. matches this same file's pre-#297 single-box shape).
    const fromRoomId = 'from-room-2';
    const toRoomId = 'to-room-2';
    const blockerRoomId = 'blocker-room-2';
    const fromPos = { rank: 0, col: 0 };
    const toPos = { rank: 2, col: 0 };
    // Pick a seed/room combination (documented, fixed) where the blocker's
    // own gw exactly equals ROW_STRIDE - DOOR_WIDTH (fills its cell to
    // within margin 1) and doorX0 lands at offset 0 (west edge) -- inside
    // a 1-wide margin is impossible to guarantee without a real blocker
    // rect, so this test instead directly constructs occupiedCells with NO
    // blocker at rank 1 (free cell) and asserts findCorridorPath finds a
    // real path (making buildEdgeCorridor take its FOUND-path branch, not
    // the null-path fallback this task touches at all) -- pinning that an
    // unoccupied intermediate cell never triggers dogleg logic.
    const fromRect = roomRect(seed, fromRoomId, fromPos.rank, fromPos.col);
    const toRect = roomRect(seed, toRoomId, toPos.rank, toPos.col);
    const occupiedCells = { '0,0': fromRoomId, '2,0': toRoomId };
    const toSlot = doorSlotsForFace(toRect, 1, 'north')[0];

    const result = buildEdgeCorridor(
      seed, fromRoomId, toRoomId, fromRect, toRect, fromPos, toPos,
      'south', toSlot, occupiedCells, 'north',
    );
    expect(result.foreignOpening).toBeNull();
  });
});
```

**Step 1a (implementer must do this before writing the assertions above):** the first test needs a concrete `seed` string for which the SOURCE room's real `outgoingOffset` (`doorOffsetAt(seed, 'from-room-south', 'outgoing', fromRect.gw)`, where `fromRect.gw` is whatever `roomSizeAt(seed, 'from-room')` rolls) lands inside the blocker room's own rolled width. Write a small throwaway Node script (not committed) that loops `seed = 'dogleg-repro-seed-' + i` for `i` from 0 upward, computing `roomSizeAt`/`doorOffsetAt`/`roomRect` exactly as `buildEdgeCorridor` does internally, and stop at the first `i` where `roomSizeAt(seed,'from-room')===ROOM_SIZE_LARGE`, `roomSizeAt(seed,'blocker-room')===ROOM_SIZE_SMALL`, and the resulting `doorX0` falls strictly inside `[blockerRect.gx, blockerRect.gx+blockerRect.gw)`. Use that concrete seed string in the test (replace `'dogleg-repro-seed'` literally) and delete the scratch script. This mirrors how the #294 plan's own `sweep-12` regression test was pinned to a concrete, verified seed rather than asserted against a randomly-chosen one.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/dungeon-layout.test.mjs -t "dogleg around a blocking"`
Expected: FAIL — `result.foreignOpening` is `undefined` (field doesn't exist yet), and corridor segments overlap the blocker's rect (today's actual bug).

- [ ] **Step 3: Implement the dogleg**

In `scripts/dungeon-layout.mjs`, inside the `if (exitFace === 'south' && sameColumn)` branch (currently `scripts/dungeon-layout.mjs:501-631`), insert dogleg detection immediately after the existing `sideWallEndY` computation (currently line 561) and before the existing `plainWalls` array (currently line 562):

```js
    // #297: exactly one intermediate cell exists between source and
    // target when they're 2 ranks apart in the same column on a null
    // path -- if that cell holds a real room (not this edge's own
    // source/target) whose own footprint the fixed doorX0 column would
    // cross, reroute through that room's own east margin instead of
    // straight through it. A larger rank gap always has more than one
    // intermediate cell and is left on the pre-existing direct-line
    // fallback unconditionally (#297's own documented scope limit).
    let dogleg = null;
    let foreignOpening = null;
    if (!path && toPos.rank === fromPos.rank + 2) {
      const blockRank = fromPos.rank + 1;
      const blockCol = fromPos.col;
      const occupantId = occupiedCells[`${blockRank},${blockCol}`];
      if (occupantId != null && occupantId !== fromRoomId && occupantId !== toRoomId) {
        const blockCell = cellBounds(blockRank, blockCol);
        const occupantRect = roomRect(seed, occupantId, blockRank, blockCol);
        // occupantRect.gx === blockCell.gx === fromRect.gx always (NW
        // anchor, same column) -- the occupant's own footprint spans
        // exactly [blockCell.gx, blockCell.gx + occupantRect.gw].
        const occupantEastEdge = occupantRect.gx + occupantRect.gw;
        if (doorX0 < occupantEastEdge) {
          // The turn MUST happen while still inside the SOURCE's own
          // margin band (faceY..blockCell.gy), never inside the blocking
          // cell itself -- a room's floor starts immediately at its own
          // cell's NW corner (no margin above/left of it), so there is no
          // y-range inside the blocking cell where turning wouldn't
          // overlap that room's own floor. The source's own margin is
          // always >= DOOR_WIDTH deep (the same margin invariant
          // cellMarginWalls relies on), so a DOOR_WIDTH-tall turn always
          // fits there even for a LARGE source room.
          const laneX0 = occupantEastEdge;
          const laneX1 = laneX0 + DOOR_WIDTH;
          const turnGx = Math.min(doorX0, laneX0);
          const turnGx2 = Math.max(doorX1, laneX1);
          const turnBottom = faceY + DOOR_WIDTH;
          dogleg = { laneX0, laneX1, turnGx, turnGx2, turnBottom, blockCell };
          foreignOpening = {
            roomId: occupantId,
            side: 'east',
            offset: laneX0 - blockCell.gx,
            width: DOOR_WIDTH,
          };
        }
      }
    }
```

Then, replace the existing `gapX0`/`gapX1`/`spanX0`/`spanX1` computation (currently `scripts/dungeon-layout.mjs:553-556`) with:

```js
    // #297: when a dogleg is active, the corridor's real approach to the
    // target is from the lane's own x, not the original (now-abandoned)
    // doorX0 -- the target's own gap must track wherever the corridor
    // actually lands, the same "two things must agree on a shared
    // boundary" requirement #230 already established for the non-dogleg
    // case.
    const targetFacingX0 = dogleg ? dogleg.laneX0 : doorX0;
    const gapX0 = Math.min(Math.max(targetFacingX0, toSlot.x1), toSlot.x2 - DOOR_WIDTH);
    const gapX1 = gapX0 + DOOR_WIDTH;
    const spanX0 = dogleg ? dogleg.turnGx : Math.min(doorX0, gapX0);
    const spanX1 = dogleg ? dogleg.turnGx2 : Math.max(doorX1, gapX1);
```

Then, replace the two `#294` side-wall entries (currently `scripts/dungeon-layout.mjs:617-618`, the last two entries of the `plainWalls` array before its `.filter(...)`) — keep everything else in that array unchanged, but make these two entries conditional:

```js
      ...(dogleg
        ? [
            // Cap the turn strip's own south edge except where the lane
            // continues down through it -- same "seal everything except
            // the declared opening" shape as the rest of this file's own
            // containment walls.
            { x1: dogleg.turnGx, y1: dogleg.turnBottom, x2: dogleg.laneX0, y2: dogleg.turnBottom },
            { x1: dogleg.laneX1, y1: dogleg.turnBottom, x2: dogleg.turnGx2, y2: dogleg.turnBottom },
            // Contain the lane's own sides for its full remaining run,
            // through the rest of the source's own margin AND the entire
            // blocking cell (corridorEndY, not sideWallEndY -- #297's own
            // dogleg is specifically the case #294 left uncontained,
            // scoped exactly to the lane's own real floor, not a wider
            // guess).
            { x1: dogleg.laneX0, y1: dogleg.turnBottom, x2: dogleg.laneX0, y2: corridorEndY },
            { x1: dogleg.laneX1, y1: dogleg.turnBottom, x2: dogleg.laneX1, y2: corridorEndY },
          ]
        : [
            { x1: spanX0, y1: faceY, x2: spanX0, y2: sideWallEndY },
            { x1: spanX1, y1: faceY, x2: spanX1, y2: sideWallEndY },
          ]),
```

Finally, replace the function's `corridorSegments` in its `return` statement (currently `scripts/dungeon-layout.mjs:628`) and add `foreignOpening` to the return:

```js
    return {
      doorWall, revealDoorWall, plainWalls,
      corridorSegments: dogleg
        ? [
            { gx: dogleg.turnGx, gy: faceY, gw: dogleg.turnGx2 - dogleg.turnGx, gh: DOOR_WIDTH },
            { gx: dogleg.laneX0, gy: dogleg.turnBottom, gw: DOOR_WIDTH, gh: corridorEndY - dogleg.turnBottom },
          ]
        : [{ gx: spanX0, gy: faceY, gw: spanX1 - spanX0, gh: corridorEndY - faceY }],
      transitCells: [],
      foreignOpening,
    };
```

Also add `foreignOpening: null` to the two OTHER `return` statements in this function that this task does not otherwise touch: the multi-cell branch's return (currently `scripts/dungeon-layout.mjs:486`, `return { doorWall, revealDoorWall, plainWalls, corridorSegments, transitCells };`) and the generic corner-fallback branch's return at the very end of the function (currently `scripts/dungeon-layout.mjs:729-738`). Leave the same-rank/east branch's own return untouched here — Task 3 adds its real `foreignOpening` value (not a `null` default) when it implements that branch's own dogleg. Every `buildEdgeCorridor` return must carry the same fields, since `pendingForeignMarginOpenings` (Task 4) always reads `.foreignOpening` off the result regardless of which branch fired.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/dungeon-layout.test.mjs -t "buildEdgeCorridor"`
Expected: PASS.

- [ ] **Step 5: Run the full existing test suite to confirm no regression**

Run: `npx vitest run`
Expected: PASS, all pre-existing tests unchanged in outcome (the dogleg only activates under the new, previously-unreached condition; every existing test's scenario has no such blocker present, so `dogleg` stays `null` and every formula above collapses to its pre-#297 form).

- [ ] **Step 6: Commit**

```bash
git add scripts/dungeon-layout.mjs tests/dungeon-layout.test.mjs
git commit -m "feat(#297): route the south fast path around a blocking intermediate room's own footprint"
```

---

### Task 3: Mirror the dogleg for the same-rank (east) fast path

**Files:**
- Modify: `scripts/dungeon-layout.mjs:641-683` (the `exitFace === 'east' && sameRank` branch)
- Test: `tests/dungeon-layout.test.mjs`

**Interfaces:**
- Consumes: the same pattern Task 2 established, mirrored onto the y-axis (south margin instead of east margin, `doorY0`/`doorY1` instead of `doorX0`/`doorX1`, `toPos.col === fromPos.col + 2` instead of `+2` on rank).
- Produces: the same `foreignOpening` field (`side: 'south'` instead of `'east'`) on this branch's own return.

- [ ] **Step 1: Write the failing test**

Add to `tests/dungeon-layout.test.mjs`, mirroring Task 2's own first test exactly but transposed onto columns/rows (source at `{rank:0,col:0}`, blocker at `{rank:0,col:1}`, target at `{rank:0,col:2}`, `exitFace: 'east'`). Follow Task 2's own Step 1a process to find a concrete seed producing a `doorY0` inside the blocker's own footprint.

```js
it('routes around a blocking room on the same-rank (east) fast path', () => {
  const fromRoomId = 'from-room-e';
  const toRoomId = 'to-room-e';
  const blockerRoomId = 'blocker-room-e';
  const fromPos = { rank: 0, col: 0 };
  const toPos = { rank: 0, col: 2 };
  const eastSeed = 'dogleg-repro-east-seed'; // replace per Task 2 Step 1a's process
  const fromRect = roomRect(eastSeed, fromRoomId, fromPos.rank, fromPos.col);
  const toRect = roomRect(eastSeed, toRoomId, toPos.rank, toPos.col);
  const occupiedCells = {
    '0,0': fromRoomId,
    '0,1': blockerRoomId,
    '0,2': toRoomId,
  };
  const toSlot = doorSlotsForFace(toRect, 1, 'north')[0];

  const result = buildEdgeCorridor(
    eastSeed, fromRoomId, toRoomId, fromRect, toRect, fromPos, toPos,
    'east', toSlot, occupiedCells, 'north',
  );

  const blockerRect = roomRect(eastSeed, blockerRoomId, 0, 1);
  for (const seg of result.corridorSegments) {
    const overlapsX = seg.gx < blockerRect.gx + blockerRect.gw && seg.gx + seg.gw > blockerRect.gx;
    const overlapsY = seg.gy < blockerRect.gy + blockerRect.gh && seg.gy + seg.gh > blockerRect.gy;
    expect(overlapsX && overlapsY).toBe(false);
  }
  expect(result.foreignOpening).not.toBeNull();
  expect(result.foreignOpening.roomId).toBe(blockerRoomId);
  expect(result.foreignOpening.side).toBe('south');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/dungeon-layout.test.mjs -t "same-rank (east) fast path"`
Expected: FAIL.

- [ ] **Step 3: Implement the mirrored dogleg**

In the `if (exitFace === 'east' && sameRank)` branch (`scripts/dungeon-layout.mjs:641-683`), apply the exact same transformation Task 2 applied to the south branch, with axes swapped: `doorX0/doorX1 → doorY0/doorY1`, `faceY → faceX`, `corridorEndY → corridorEndX`, `toPos.rank+2 → toPos.col+2` (test condition becomes `toPos.col === fromPos.col + 2`), blocking cell at `{rank: fromPos.rank, col: fromPos.col + 1}`, occupant's far edge is `occupantRect.gy + occupantRect.gh` (its own **south** margin, not east — the only margin a NW-anchored room ever has besides east), `sideWallEndX` in place of `sideWallEndY`, `foreignOpening.side: 'south'`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/dungeon-layout.test.mjs -t "same-rank (east) fast path"`
Expected: PASS.

- [ ] **Step 5: Run the full suite**

Run: `npx vitest run`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add scripts/dungeon-layout.mjs tests/dungeon-layout.test.mjs
git commit -m "feat(#297): mirror the dogleg fix onto the same-rank (east) fast path"
```

---

### Task 4: Scan for pending foreign openings and wire into `buildRoomAtGraphNode`

**Files:**
- Modify: `scripts/dungeon-layout.mjs` (new exported function, placed near `outgoingMarginOffset`)
- Modify: `scripts/dungeon-scene.mjs:349-450` (`buildRoomAtGraphNode`'s margin-wall construction) and its two call sites (`scripts/dungeon-scene.mjs` inside `buildPopulateAndUnlockGraphNode`, and `scripts/ui/dungeon-app.mjs` wherever `buildRoomAtGraphNode`/`buildPopulateAndUnlockGraphNode` is invoked — confirm via `grep -n "buildRoomAtGraphNode\|buildPopulateAndUnlockGraphNode" scripts/ui/dungeon-app.mjs` before editing; this task only needs `state.edges` threaded one level deeper, which is already present on every `state` object passed to `buildPopulateAndUnlockGraphNode` today — no new parameter at the `dungeon-app.mjs` call sites themselves).
- Test: `tests/dungeon-layout.test.mjs`, `tests/dungeon-scene.test.mjs`

**Interfaces:**
- Consumes: `buildEdgeCorridor` (Task 2/3's `foreignOpening` field), `roomRect`, `exitFaceForIndex`, `doorSlotsForFace`.
- Produces: `pendingForeignMarginOpenings(seed, roomId, rank, col, edges, layoutPositionByRoomId, incomingFaceByRoomId, occupiedCells)` — a new exported pure function in `scripts/dungeon-layout.mjs` returning `{ east: Array<{offset, width}>, south: Array<{offset, width}> }` (always both keys present, arrays possibly empty) for the given room. `buildRoomAtGraphNode` gains a new options field, `edges = {}`, threaded from `buildPopulateAndUnlockGraphNode`'s existing `state.edges`.

- [ ] **Step 1: Write the failing test for `pendingForeignMarginOpenings`**

Add to `tests/dungeon-layout.test.mjs`:

```js
describe('pendingForeignMarginOpenings — #297', () => {
  it('finds a foreign opening for the blocking room in a dogleg scenario', () => {
    const seed = 'dogleg-repro-seed'; // same concrete seed Task 2 pinned
    const fromRoomId = 'from-room';
    const toRoomId = 'to-room';
    const blockerRoomId = 'blocker-room';
    const layoutPositionByRoomId = {
      [fromRoomId]: { rank: 0, col: 0 },
      [blockerRoomId]: { rank: 1, col: 0 },
      [toRoomId]: { rank: 2, col: 0 },
    };
    const edges = { [fromRoomId]: [toRoomId, blockerRoomId] };
    const occupiedCells = { '0,0': fromRoomId, '1,0': blockerRoomId, '2,0': toRoomId };
    const incomingFaceByRoomId = { [toRoomId]: 'north', [blockerRoomId]: 'north' };

    const openings = pendingForeignMarginOpenings(
      seed, blockerRoomId, 1, 0, edges, layoutPositionByRoomId, incomingFaceByRoomId, occupiedCells,
    );

    expect(openings.east).toHaveLength(1);
    expect(openings.east[0].width).toBe(DOOR_WIDTH);
    expect(openings.south).toEqual([]);
  });

  it('finds no foreign opening for a room with no blocking role', () => {
    const seed = 'dogleg-repro-seed';
    const layoutPositionByRoomId = {
      'a': { rank: 0, col: 0 },
      'b': { rank: 1, col: 0 },
    };
    const edges = { a: ['b'] };
    const occupiedCells = { '0,0': 'a', '1,0': 'b' };
    const openings = pendingForeignMarginOpenings(
      seed, 'b', 1, 0, edges, layoutPositionByRoomId, { b: 'north' }, occupiedCells,
    );
    expect(openings.east).toEqual([]);
    expect(openings.south).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/dungeon-layout.test.mjs -t "pendingForeignMarginOpenings"`
Expected: FAIL — function doesn't exist.

- [ ] **Step 3: Implement `pendingForeignMarginOpenings`**

Add to `scripts/dungeon-layout.mjs`, near `outgoingMarginOffset`:

```js
/**
 * Every foreign margin opening `roomId`'s own `cellMarginWalls` call must
 * leave, for OTHER edges whose #297 dogleg routes through this room's own
 * margin band. A pure scan over the whole graph's real edges (`edges`,
 * never `layoutEdges` -- a hidden/detour edge's own routing is a separate,
 * untouched mechanism per this feature's own documented scope), calling
 * the SAME `buildEdgeCorridor` every real edge already goes through
 * (`buildPopulateAndUnlockGraphNode`'s own incoming-connections loop) and
 * reading back its `foreignOpening` field -- never re-deriving the
 * dogleg's own geometry separately, the same "call the real function,
 * don't approximate" precedent `outgoingMarginOffset` already set.
 *
 * Correct regardless of build order: this module performs eager,
 * full-graph pregeneration (`roomsToEagerlyBuild`), so every input here
 * (`edges`, `layoutPositionByRoomId`, `incomingFaceByRoomId`) is already
 * fully known before ANY room is built -- no persisted registry, no
 * retroactive wall-patching needed (see this feature's own spec for the
 * full reasoning and the two wrong designs it replaced).
 */
export function pendingForeignMarginOpenings(seed, roomId, rank, col, edges, layoutPositionByRoomId, incomingFaceByRoomId, occupiedCells) {
  const result = { east: [], south: [] };
  for (const [sourceId, childIds] of Object.entries(edges)) {
    const sourcePos = layoutPositionByRoomId[sourceId];
    if (!sourcePos) continue;
    const sourceIncomingFace = incomingFaceByRoomId?.[sourceId] ?? 'north';
    childIds.forEach((childId, index) => {
      const targetPos = layoutPositionByRoomId[childId];
      if (!targetPos) return;
      const exitFace = exitFaceForIndex(index, sourceIncomingFace);
      const sameColumnTwoDown = exitFace === 'south' && sourcePos.col === targetPos.col && targetPos.rank === sourcePos.rank + 2;
      const sameRankTwoOver = exitFace === 'east' && sourcePos.rank === targetPos.rank && targetPos.col === sourcePos.col + 2;
      if (!sameColumnTwoDown && !sameRankTwoOver) return;
      // Only worth calling buildEdgeCorridor (real work) when THIS room is
      // actually the blocking cell for this candidate edge.
      const blockRank = sameColumnTwoDown ? sourcePos.rank + 1 : sourcePos.rank;
      const blockCol = sameColumnTwoDown ? sourcePos.col : sourcePos.col + 1;
      if (blockRank !== rank || blockCol !== col) return;
      const sourceRect = roomRect(seed, sourceId, sourcePos.rank, sourcePos.col);
      const targetRect = roomRect(seed, childId, targetPos.rank, targetPos.col);
      const targetIncomingFace = incomingFaceByRoomId?.[childId] ?? 'north';
      const toSlot = doorSlotsForFace(targetRect, 1, targetIncomingFace)[0];
      const { foreignOpening } = buildEdgeCorridor(
        seed, sourceId, childId, sourceRect, targetRect, sourcePos, targetPos,
        exitFace, toSlot, occupiedCells, targetIncomingFace,
      );
      if (foreignOpening && foreignOpening.roomId === roomId) {
        result[foreignOpening.side].push({ offset: foreignOpening.offset, width: foreignOpening.width });
      }
    });
  }
  return result;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/dungeon-layout.test.mjs -t "pendingForeignMarginOpenings"`
Expected: PASS.

- [ ] **Step 5: Wire it into `buildRoomAtGraphNode`**

Read `scripts/dungeon-scene.mjs:349-450` in full before editing (the exact current margin-wall loop, `marginFaces`/`coveredMarginSides` bookkeeping) — this step replaces that whole block, not just a line. Add `edges = {}` to `buildRoomAtGraphNode`'s destructured options (alongside `layoutPositionByRoomId`, `occupiedCells`, `incomingFaceByRoomId`). Replace the margin-wall construction block (currently `scripts/dungeon-scene.mjs:414-442`) with:

```js
  const foreignOpenings = pendingForeignMarginOpenings(
    seed, roomId, rank, col, edges, layoutPositionByRoomId, incomingFaceByRoomId, occupiedCells,
  );
  const openingsBySide = { east: [...foreignOpenings.east], south: [...foreignOpenings.south] };
  for (const face of marginFaces) {
    const childId = childIdByFace[face];
    const childPos = childId ? layoutPositionByRoomId[childId] : null;
    const childIncomingFace = childId ? (incomingFaceByRoomId?.[childId] ?? 'north') : 'north';
    const { offset, width } = outgoingMarginOffset(
      seed, roomId, childId, face, rect, { rank, col },
      childPos ?? { rank: NaN, col: NaN }, occupiedCells, childIncomingFace,
    );
    openingsBySide[face].push({ offset, width });
  }
  const marginWalls = cellMarginWalls(rect, rank, col, openingsBySide);
```

(`marginFaces`/`childIdByFace`, defined just above this block at `scripts/dungeon-scene.mjs:370-414`, are unchanged — only the block that CALLS `cellMarginWalls` changes, since Task 1's generalized signature now accepts every opening — the room's own real outgoing gap(s) plus any foreign pass-through gap(s) — in one call instead of the old one-call-per-face-then-merge dance.)

Add `pendingForeignMarginOpenings` and `cellMarginWalls`'s new signature to this file's existing import from `dungeon-layout.mjs` (`scripts/dungeon-scene.mjs`'s top-of-file import list already imports `cellMarginWalls`; add `pendingForeignMarginOpenings` alongside it).

Then find where `buildRoomAtGraphNode` is called (`scripts/dungeon-scene.mjs`, inside `buildPopulateAndUnlockGraphNode`, currently around line 1124-1135) and add `edges: state.edges` to the options object passed in.

- [ ] **Step 6: Write a `dungeon-scene.mjs`-level test confirming the wiring**

Add to `tests/dungeon-scene.test.mjs` (find the existing `buildRoomAtGraphNode` describe block first and follow its own existing test-setup pattern for `scene`/mocked Foundry globals): a test building two rooms via `buildRoomAtGraphNode` — a blocking room and, via a second call representing the shortcut edge's own target build (matching how `buildPopulateAndUnlockGraphNode`'s real incoming-connections loop calls `buildEdgeCorridor` for the target's own incoming edges) — then asserting the blocking room's own created Wall documents include a `dungeonCellMarginWallForRoom`-flagged east wall with a gap matching the dogleg's own real lane position (read back via the same concrete seed Task 2 pinned). Mirror this test's exact setup shape from the nearest existing `buildRoomAtGraphNode`-level test in this file (read it first) rather than inventing new scaffolding.

- [ ] **Step 7: Run the full suite**

Run: `npx vitest run`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add scripts/dungeon-layout.mjs scripts/dungeon-scene.mjs tests/dungeon-layout.test.mjs tests/dungeon-scene.test.mjs
git commit -m "feat(#297): scan for and apply pending foreign margin openings when building a room"
```

---

### Task 5: Regression test for the exact live repro + system-wide sweep

**Files:**
- Modify: `tests/dungeon-layout.test.mjs`

**Interfaces:**
- Consumes: everything from Tasks 1-4.
- Produces: nothing new consumed by later tasks — this is the plan's own closing verification task.

- [ ] **Step 1: Write the dedicated regression test**

Mirror the #294 plan's own `sweep-12` regression test pattern (find it in `tests/dungeon-layout.test.mjs` and read it first for the exact scaffolding this codebase uses for a single-seed, full-pipeline regression). Reproduce the exact live scenario's own confirmed shape: a source room with TWO real children — the merge room at child index 0 (`exitFaceForIndex(0, 'north') === 'south'`, confirmed live: the merge room's own incoming door sat exactly at the source's south face, `y=19` for a source rect `(300,13)-6x6`) and the blocking room at child index 1 (`exitFaceForIndex(1, 'north') === 'east'`) — with `layoutPositionByRoomId` placing the merge room 2 ranks below the source in the SAME column, and the blocking room 1 rank below in that same column (occupying the intermediate cell), matching the confirmed live positions: source `(rank:1,col:0)`, blocking room `(rank:2,col:0)`, merge room `(rank:3,col:0)`. `edges[sourceId] = [mergeRoomId, blockingRoomId]` (this exact order — index 0 must be the merge room to get the south exit face the live repro used). Assert: no corridor segment (from the merge room's own incoming-edge `buildEdgeCorridor` call) overlaps the blocking room's own rect, and separately, that `pendingForeignMarginOpenings` for the blocking room's own position returns a non-empty `east` opening — full pipeline (`buildEdgeCorridor` + `pendingForeignMarginOpenings` + `cellMarginWalls` all together, not just one function in isolation).

- [ ] **Step 2: Run it to verify it fails against the OLD code**

This test should be written and run against a git stash of Tasks 2-4's changes (or simply trust that it exercises the real bug — since Tasks 2-4 are already committed by this point in the plan, running it now will PASS; the historical "did it fail before the fix" check is satisfied by the fact that Task 2's own Step 2 already demonstrated the bug's existence directly). Skip re-verifying against pre-fix code; proceed to Step 3.

- [ ] **Step 3: Write the system-wide sweep**

Mirror the #294 sweep's own scaffolding (seed corpus, room-count range, full pipeline invocation) exactly — find it in `tests/dungeon-layout.test.mjs` and reuse its harness. Replace its own per-scenario assertion with: for every generated dungeon in the corpus, for every corridor segment produced (across every real edge), assert it does not overlap any OTHER room's own rect (not just the edge's own source/target). Report (via a `console.log` in the test, matching how prior sweeps in this file report their own measured rates — search for `console.log` in the existing #230/#288/#294 sweep tests for the exact reporting convention) the measured overlap rate before and can compare against the spec's own success criteria (zero, for the single-intermediate-blocker case this plan covers).

- [ ] **Step 4: Run the full suite**

Run: `npx vitest run`
Expected: PASS. Note the sweep's own reported overlap rate in the commit message.

- [ ] **Step 5: Commit**

```bash
git add tests/dungeon-layout.test.mjs
git commit -m "test(#297): regression test for the live repro + system-wide corridor/footprint overlap sweep"
```

---

### Task 6: Version bump

**Files:**
- Modify: `module.json`

- [ ] **Step 1: Check `main`'s current version before bumping**

Run: `git fetch origin main && git show origin/main:module.json | grep version`

If `origin/main`'s version has advanced past `0.50.3` since this worktree was created, bump past THAT version instead of `0.51.0` — same recovery this session already documented for #288's own concurrent-merge conflict.

- [ ] **Step 2: Bump `module.json`**

Change `"version": "0.50.3"` to `"version": "0.51.0"` (or the higher value from Step 1) — a minor bump, since this is an architecture-level change (a new cross-room wall-opening coordination mechanism), not a routine fix, per this repo's own `CLAUDE.md`.

- [ ] **Step 3: Commit**

```bash
git add module.json
git commit -m "chore(#297): bump version to 0.51.0"
```
