> **SUPERSEDED (2026-10-06):** replaced by `2026-10-06-corridor-joins-and-corner.md`. This plan's merge-room dedup was implemented and reviewed: it changed nothing on the live pipeline (layout v3 + topology routing), because the live stacked tiles come from the transit-cell site and from repeated end caps at joins and bends, not from merge rooms. Do not implement this plan.

# Corridor Tile Merge-Room Dedup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix #823 — a merge room's own two (or more) parent corridors no longer place a second, stacked floor tile on a grid cell another connection already covered during the same room's build.

**Root cause (confirmed against the real live scene, not assumed):** This session queried the real running "Dungeon Crawl" scene's own 268 tiles directly. Every corridor tile's own grid placement is mathematically perfect — no gaps, no spacing errors anywhere. But 13 pairs of tiles sit at the **exact same** `(x, y)` position, each pair a different corridor-art variant/rotation stacked on top of the other. Tracing the code: `buildPopulateAndUnlockGraphNode`'s loop over a room's own `incomingConnections` (confirmed current, `scripts/dungeon-scene.mjs:1776`) calls `corridorTilesForSegments` independently for every incoming edge and pushes its own floor tiles unconditionally (`tiles.push(...edgeTiles)`, confirmed current line 1855) — with no check for whether an *earlier* connection in that same loop already placed a tile at that cell. A merge room (the existing code's own comment, confirmed current around line 1834, already acknowledges merge rooms have "MULTIPLE real doors") is exactly where two different parents' corridors can route through or terminate at a shared cell near the convergence point. Two full-opacity, differently-rotated wall+floor textures stacked on one cell is a strong, data-backed explanation for the reported seam/border artifact, and for the issue's own "roughly every 10th" observation as a function of how often merge-room junctions occur in a typical generated layout, not a literal modulo-10 bug.

**Confidence note (recorded here deliberately, not glossed over):** this session could not obtain a clean in-world screenshot to visually confirm the border/seam artifact pixel-for-pixel at a stacked-tile location (Foundry's own canvas culling made an off-screen capture render blank, and panning the live camera to force one was avoided per this session's own standing caution about disrupting a world other people may be actively viewing). The duplicate-tile-placement finding itself is fully data-confirmed via direct, read-only query of the live scene's real tile documents. The user reviewed this finding and approved proceeding with the dedup fix on that basis — Task 2's own live-verification step is where the actual visual symptom gets confirmed gone, not assumed.

**Architecture:** One small, directly-testable function, `pushUniqueCorridorTiles`, tracks which cells have already received a corridor floor tile during the current room's own build pass (a plain `Set` of `"gx,gy"` keys, scoped to one `buildPopulateAndUnlockGraphNode` call) and skips adding a second tile at an already-covered cell — first connection to reach a cell wins. The trap-placement logic #779 added immediately after (`corridorTrapCandidateCells(edgeCells, ...)`) deliberately keeps reading the **unfiltered** `edgeCells` — a shared cell is still a real, walkable floor cell for trap placement regardless of which connection's own art tile is the one actually rendered there, so #779's own behavior is completely unaffected by this plan.

**Tech Stack:** Vanilla ES modules, Vitest.

**Spec:** None — a bounded, data-confirmed bug fix; the one real open question (is this diagnosis solid enough to act on without a screenshot) was presented to and decided by the user directly in chat.

## Global Constraints

- Every merge to `main` bumps `module.json`'s `version` (CLAUDE.md). A routine rendering bug fix: patch bump. Re-check the current version immediately before committing, since concurrent sessions push to this repo.
- `corridorTilesForSegments`'s own return shape (`{tiles, cells}`, #779) and every other caller of it (the transit-cell site) are completely unchanged — this plan only touches how the *results* get pushed into the room's own `tiles` array at the one `incomingConnections`-loop call site.
- #779's own trap-placement logic (`corridorTrapCandidateCells(edgeCells, ...)`, confirmed current immediately after the tile push) keeps reading the unfiltered `edgeCells` — explicitly not touched by this fix.
- The fix only dedups **within one room's own build pass** (one `buildPopulateAndUnlockGraphNode` call) — it does not need to persist across rebuilds, since that whole function is already gated once-per-room by `isSlotBuilt` (confirmed current).
- No change to `buildEdgeCorridor`'s own pathfinding or to wall geometry — only which *floor tile* gets kept when two connections' own floor cells coincide.

## Review Focus

- **A merge room's second (and any further) incoming connection must never place a floor tile at a cell an earlier connection already covered**, while every genuinely distinct cell from every connection still gets its own tile — the core fix, and the thing a too-aggressive dedup could get wrong (accidentally dropping a *non*-colliding cell).
- **The kept tile at a shared cell must be the first connection's own tile**, not some merged/averaged result — a deterministic, simple rule, not a new compositing concept.
- **#779's own corridor trap placement must be completely unaffected** — it must still be able to land on a shared cell (reading the unfiltered `edgeCells`), confirmed by an explicit test, not just an assumption from reading the code once.
- **A non-merge room (the overwhelmingly common case, one incoming connection) must render byte-for-byte identical tiles to before this fix** — the dedup must be a no-op when there's nothing to dedup.
- **The fix must not depend on connection processing order being stable/predictable beyond "first in `incomingConnections` wins"** — whichever connection happens to come first in that array keeps its tile; this plan does not need to pick a "better" winner by any other rule.

---

### Task 1: The dedup function and its unit tests

**Files:**
- Modify: `scripts/dungeon-scene.mjs` (new `pushUniqueCorridorTiles`, wired into the `incomingConnections` loop)
- Test: `tests/dungeon-scene-trap-placement.test.mjs` (reusing its own real `buildPopulateAndUnlockGraphNode`/corridor fixtures — the natural home, already covering this exact code region for #779) or a new small dedicated test file, whichever reads more naturally once the exact diff is in front of the implementer

**Interfaces:**
- Produces: `pushUniqueCorridorTiles(tiles, edgeTiles, edgeCells, occupiedCellKeys)` — mutates `tiles` (appends non-duplicate entries) and `occupiedCellKeys` (a `Set<string>`, adds each newly-claimed cell's key) in place; returns nothing. Not exported unless the chosen test location needs it as an import (a same-file unit test needs no export; a separate test file does — match whichever Step 1 below ends up using).

- [ ] **Step 1: Write the failing tests**

Add a new `describe` block (location per the note above):

```js
describe('pushUniqueCorridorTiles (#823)', () => {
  it('keeps every tile when no cells collide', () => {
    const tiles = [];
    const occupied = new Set();
    pushUniqueCorridorTiles(
      tiles,
      [{ id: 'a' }, { id: 'b' }],
      [{ gx: 1, gy: 1 }, { gx: 1, gy: 2 }],
      occupied,
    );
    expect(tiles).toEqual([{ id: 'a' }, { id: 'b' }]);
    expect(occupied).toEqual(new Set(['1,1', '1,2']));
  });

  it('skips a later tile whose cell an earlier call already claimed, keeps the rest', () => {
    const tiles = [];
    const occupied = new Set();
    pushUniqueCorridorTiles(
      tiles,
      [{ id: 'a' }, { id: 'b' }],
      [{ gx: 1, gy: 1 }, { gx: 1, gy: 2 }],
      occupied,
    );
    pushUniqueCorridorTiles(
      tiles,
      [{ id: 'c' }, { id: 'd' }],
      [{ gx: 1, gy: 2 }, { gx: 5, gy: 5 }], // first cell collides with { id: 'b' }'s own cell
      occupied,
    );
    expect(tiles).toEqual([{ id: 'a' }, { id: 'b' }, { id: 'd' }]);
  });

  it('is a no-op shape for a single connection (nothing ever collides with itself in one call)', () => {
    const tiles = [];
    const occupied = new Set();
    const edgeTiles = [{ id: 'x' }, { id: 'y' }, { id: 'z' }];
    const edgeCells = [{ gx: 0, gy: 0 }, { gx: 0, gy: 1 }, { gx: 0, gy: 2 }];
    pushUniqueCorridorTiles(tiles, edgeTiles, edgeCells, occupied);
    expect(tiles).toEqual(edgeTiles);
  });
});
```

If this lands in `tests/dungeon-scene-trap-placement.test.mjs`, add `pushUniqueCorridorTiles` to its existing multi-line import from `../scripts/dungeon-scene.mjs` (confirmed current, line 59).

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/dungeon-scene-trap-placement.test.mjs -t "pushUniqueCorridorTiles"` (adjust path if a new file was used)
Expected: FAIL — not a function yet.

- [ ] **Step 3: Write `pushUniqueCorridorTiles` and wire it in**

In `scripts/dungeon-scene.mjs`, add near `corridorTilesForSegments` (or directly above `buildPopulateAndUnlockGraphNode`, whichever reads more naturally):

```js
/**
 * #823: tracks which corridor-floor-tile cells have already been placed
 * during the CURRENT room's own build pass, across every incoming
 * connection's own corridorTilesForSegments call. A merge room's two (or
 * more) parent corridors can route through or terminate at the same
 * physical cell near the convergence point -- each connection's own
 * independent corridorTilesForSegments call has no idea another
 * connection already placed a floor tile there, and without this, two
 * full-opacity, differently-rotated corridor textures stacked on one
 * cell produced a visible seam (confirmed live: 13 such stacked pairs
 * across the real running scene's own 268 tiles). First connection to
 * reach a cell keeps its own tile; appends nothing for a cell
 * `occupiedCellKeys` already has. `occupiedCellKeys` is owned and reset
 * by the caller once per room build -- this function only ever adds to
 * it, mirroring every other per-build Set this file already threads
 * through a loop this way.
 */
function pushUniqueCorridorTiles(tiles, edgeTiles, edgeCells, occupiedCellKeys) {
  edgeTiles.forEach((tile, idx) => {
    const cell = edgeCells[idx];
    const key = `${cell.gx},${cell.gy}`;
    if (occupiedCellKeys.has(key)) return;
    occupiedCellKeys.add(key);
    tiles.push(tile);
  });
}
```

Declare `const corridorCellKeys = new Set();` directly before the `for (let i = 0; i < incomingConnections.length; i += 1) {` loop (confirmed current, line 1776).

Change (confirmed current, line 1855):

```js
      tiles.push(...edgeTiles);
```

to:

```js
      pushUniqueCorridorTiles(tiles, edgeTiles, edgeCells, corridorCellKeys);
```

(`edgeCells` is already destructured on the preceding line, confirmed current line 1854 — no further change needed there. #779's own `corridorTrapCandidateCells(edgeCells, ...)` call, confirmed current immediately after, keeps using the same unfiltered `edgeCells` variable unchanged.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/dungeon-scene-trap-placement.test.mjs -t "pushUniqueCorridorTiles"`
Expected: PASS, all three cases green.

- [ ] **Step 5: Run the full test suite to confirm no regression**

Run: `npx vitest run`
Expected: PASS — in particular every existing #779 test in this same file stays green, confirming trap placement's own use of the unfiltered `edgeCells` is untouched, and every existing non-merge-room test (the overwhelming majority) stays byte-for-byte identical, confirming the dedup is a true no-op for the single-connection case.

- [ ] **Step 6: Commit**

```bash
git add scripts/dungeon-scene.mjs tests/dungeon-scene-trap-placement.test.mjs
git commit -m "fix(#823): dedup corridor floor tiles at a merge room's shared cells

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 2: Live verification, version bump

**Files:**
- Modify: `module.json`

No code changes in this task — verification and the version bump only.

- [ ] **Step 1: Live-verify via `foundry-rest`**

Generate several real dungeon runs (varying seeds, enough rooms to produce at least one merge room — a room with more than one real parent) and, for each, re-run the same duplicate-position scan this session's own investigation used, confirming zero same-position pairs remain:

```bash
echo 'const tiles = canvas.scene.tiles.contents.map(t => ({x:t.x,y:t.y})); const seen = new Map(); let dups = 0; for (const t of tiles) { const k = t.x+","+t.y; seen.set(k, (seen.get(k) ?? 0) + 1); } for (const [k,c] of seen) if (c > 1) dups++; return { totalTiles: tiles.length, duplicatePositions: dups };' | .claude/skills/foundry-rest/foundry-exec.sh
```

Expected: `duplicatePositions: 0` for every generated run tested (compare against this session's own investigation, which found 13 on the then-live scene before this fix). Separately, if the opportunity arises to view a merge-room junction directly in a connected client (not by having this session itself pan the shared camera), visually confirm the seam/border is gone — note in the PR description whether this was possible, since the original diagnosis itself was not pixel-confirmed.

- [ ] **Step 2: Bump module.json's version**

Re-check the current version first (concurrent sessions push to this repo):

```bash
git fetch origin main -q && git log origin/main -1 --oneline && grep version module.json
```

Apply a **patch** bump (a rendering bug fix), using whatever the fetch above shows as current.

- [ ] **Step 3: Commit**

```bash
git add module.json
git commit -m "chore(#823): bump version for corridor tile merge-dedup fix

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Self-Review

**1. Scope coverage:** #823's own "To investigate" list (art-baked border, tile sizing/placement rounding, texture scaling, Foundry tile overlay) was checked against real live data: placement is mathematically exact (ruling out rounding/sizing), and the real anomaly found was duplicate same-position tiles at merge-room junctions — a placement-logic gap distinct from every hypothesis the issue's own text floated, confirmed by direct query rather than assumed. The issue's own "Addendum" (periodic wall-removal overlap failure) is addressed by the same root cause and the same fix, reframed from "every 10th" (a literal period this investigation found no code-level evidence for) to "every merge-room junction" (a real, data-confirmed, non-periodic-but-recurring case).

**2. Placeholder scan:** No TBD/TODO. The one explicit, deliberate caveat (no pixel-level screenshot confirmation) is stated plainly in the plan's own "Confidence note," not hidden — this is an honest limitation recorded for the record, not a placeholder standing in for missing work.

**3. Type consistency:** `pushUniqueCorridorTiles(tiles, edgeTiles, edgeCells, occupiedCellKeys)`'s signature is defined once and used identically at its one real call site and in every test.

**4. Review Focus:** All five items (merge-room dedup works, first-connection-wins is deterministic, #779's trap placement is unaffected, the common single-connection case is an exact no-op, no dependency on anything beyond array order) each map to a specific test. No gaps found.

---

Plan complete and saved to `docs/superpowers/plans/2026-10-06-corridor-tile-merge-dedup.md`.
