# Stub Corridor Pieces And Corridor Wall Crossings Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix #861's part (1) — dead-end stub corridors render as a row of fully-walled boxes instead of using the #823 openings-based piece rule — and, for part (2), measure and honestly pin the real "solid wall crosses open corridor floor" phenomenon with a committed, categorized sweep, then re-file the harder, multi-subsystem root cause as its own properly-scoped, evidence-backed issue rather than guessing at a fix for three loosely-related wall-generation mechanisms in one pass.

**Why split:** Part (1) has one clear, scoped root cause and a already-proven fix pattern (#823's own `corridorPieceForOpenings`). Part (2), investigated this session with a real empirical probe (see Measured baseline below), turns out to span **three independent wall-generation mechanisms** (`cellMarginWalls`'s own planned/foreign margin-opening computation, `transitCellContainmentWalls`'s own per-crossing opening list, and `roomEnclosureWalls`'s own per-direction wall) — each apparently computing where a gap belongs from a different, independently-derived source than where `buildEdgeCorridor` ultimately draws the real corridor tiles, concentrated specifically on hidden-detour edges. Tracing and fixing three separate subsystems without first confirming which, if any, share one root cause is exactly the kind of blind, unverified multi-system change this project's own established practice (#230/#231/#232, #353/#355) avoids — a scoped fix plus an honestly-measured, evidence-backed follow-up issue is the responsible shape here, not a guessed patch.

**Architecture (part 1):** `stubTilesFor` (confirmed current, `scripts/dungeon-scene.mjs:360-378`) hard-codes every non-cap tile of a dead-end stub to the fully-walled `'single'` variant. Since a stub is always a single straight horizontal row (confirmed via `stubGeometry`, `scripts/dungeon-layout.mjs:3291-3327` — fixed `y = sourceRect.gy + sourceRect.gh`, `gx` varying), each non-cap tile's own openings are fully determined by its position in the line, with no need for `corridor-pieces.mjs`'s general `openingsOf(cell, cellSet)` cell-set scan: the door-end tile (`k === 0`) opens only toward the next cell; every interior tile opens both ways; the existing `rubble`-capped final tile is untouched (a deliberate, different asset, not part of the openings system).

**Architecture (part 2):** A new committed sweep (`tests/dungeon-corridor-wall-crossing-sweep.test.mjs`) groups a built scene's corridor tiles by their `dungeonCorridorEdge`/`dungeonStubCorridorFor` flag (same convention `tests/dungeon-corridor-joins-sweep.test.mjs` already uses), finds every pair of same-group, art-open-toward-each-other adjacent cells, and checks whether any **non-door** wall document crosses that shared boundary — explicitly excluding real door walls (`w.door !== CONST.WALL_DOOR_TYPES.NONE`), which are *supposed* to sit across a corridor/room joint. Each hit is categorized by its own module flag keys, giving a direct, evidence-based attribution to the generating mechanism rather than a guess.

**Tech Stack:** Vanilla ES modules, Vitest.

**Spec:** None — part (1) is a bounded, fully-diagnosed fix reusing an established pattern; part (2) is investigated to the point of a clear, evidence-backed scope decision (split into a new issue), not guessed at.

## Global Constraints

- Every merge to `main` bumps `module.json`'s `version` (CLAUDE.md). A rendering fix plus a new regression sweep: patch bump.
- `stubGeometry`'s own return shape (confirmed current: `{floor, walls, doorWall, flavor, length, dir, doorSpan}`) is unchanged — only `stubTilesFor`'s own internal per-tile variant/rotation choice changes.
- The rubble cap (`k === g.length - 1`) and the `g.length === 1` single-cell case (already `cap === true`, already using `'rubble'`) are both unchanged — confirmed current behavior for those two cases is already correct.
- Part (2)'s sweep **pins the real, currently-measured counts** (41 `dungeonCellMarginWallForRoom`, 34 `dungeonTransitCellMarginForCell+dungeonTransitCellOpenings`, 14 `dungeonEnclosureWallForRoom+dungeonEnclosureWallDirection`, across 11/100 seeds — measured this session, current `main`) rather than asserting zero — asserting zero here would be a false claim; a future fix lowers these numbers and updates the assertion, exactly `tests/dungeon-corridor-joins-sweep.test.mjs`'s own established before/after-numbers convention.
- A wall document with `door !== CONST.WALL_DOOR_TYPES.NONE` (a real door) is never counted as a "solid wall crossing a corridor" — a door is *supposed* to sit across that boundary; only a plain wall is a defect.

## Review Focus

- **A multi-cell stub's own door-end tile must open toward the stub's interior, not present a fully-walled box look, while still rendering NO opening toward the room it connects to** (that boundary is the room's own door wall, not the corridor tile's own texture) — matching how a real corridor's own end tile already behaves.
- **A stub's existing rubble cap and the `length === 1` single-cell case must render byte-identical to before** — both already measured correct; a fix that touches either would be new breakage, not the fix the issue asks for.
- **The wall-crossing sweep must never count a real door as a defect** — the dominant false-positive this session's own investigation hit first (315+43 door-wall hits versus the real 41+34+14 non-door hits) — the committed sweep's own door exclusion is the one piece of part (2) that is directly fixed by this plan (the measurement itself), even though the underlying wall-generation bug is re-filed rather than fixed here.
- **The follow-up issue must carry the real measured evidence** (exact counts, exact flag categories, the "concentrated on hidden-detour edges" finding, named example seeds/wall-ids) — not a restatement of #861's own original, now-superseded 60/100 estimate.
- **#861 itself must only close the stub-tile part** — the issue's own body covers two distinct defects; closing it on a part-1-only fix without clearly saying so would misrepresent the real state of part (2).

---

### Task 1: Fix stub corridor tile rendering (openings-based pieces)

**Files:**
- Modify: `scripts/dungeon-scene.mjs:360-378` (`stubTilesFor`)
- Test: `tests/dungeon-corridor-joins-sweep.test.mjs` or a new focused test file (see Step 1 — check which already covers stub tiles before adding a new file)

**Interfaces:**
- Consumes: `corridorPieceForOpenings(openings)` (confirmed current, `scripts/corridor-pieces.mjs:51`) — reused directly, no signature change.
- Produces: no change to `stubTilesFor`'s own call signature or return shape (still an array of tile objects with the same `{texture, x, y, width, height, rotation, flags}` shape) — only the `texture`/`rotation` VALUES change for non-cap tiles.

- [ ] **Step 1: Check for an existing stub-tile-specific test**

```bash
grep -rln "stubTilesFor\|dungeonStubCorridorFor" tests/
```

If a test already exercises `stubTilesFor`'s own output shape, extend it. Otherwise create `tests/dungeon-stub-corridor-pieces.test.mjs` (pure unit test, no scene stub needed — `stubTilesFor` is a plain function of a `stubGeometry`-shaped object).

- [ ] **Step 2: Write the failing test**

```js
import { describe, it, expect } from 'vitest';
import { stubTilesFor } from '../scripts/dungeon-scene.mjs';

const g = (length, dir) => ({ floor: [{ gx: 10, gy: 5, gw: length, gh: 1 }], length, dir });

describe('#861 stub corridor tiles use the openings-based piece rule, not a row of closed boxes', () => {
  it('a 3-long stub (dir=1): door-end "end" open toward next, mid "mid" both ways, cap stays rubble', () => {
    const tiles = stubTilesFor(g(3, 1), 'r->s');
    const variantOf = (t) => t.texture.src.split('/').pop().replace('.webp', '');
    expect(tiles.map((t) => [variantOf(t), t.rotation])).toEqual([
      ['corridor-end', 270], // k=0: opens E (dir>0), END_ROTATION_BY_OPENING.E = 270
      ['corridor-mid', 90], // k=1: opens E+W, mid@90
      ['corridor-rubble', 90], // k=2 (cap): unchanged -- dir>0 -> 90
    ]);
  });

  it('a 3-long stub (dir=-1): door-end opens W, mid still both ways, cap unchanged', () => {
    const tiles = stubTilesFor(g(3, -1), 'r->s');
    const variantOf = (t) => t.texture.src.split('/').pop().replace('.webp', '');
    expect(tiles.map((t) => [variantOf(t), t.rotation])).toEqual([
      ['corridor-end', 90], // k=0: opens W, END_ROTATION_BY_OPENING.W = 90
      ['corridor-mid', 90],
      ['corridor-rubble', 270], // dir<0 -> 270, unchanged
    ]);
  });

  it('a 2-long stub: door-end "end", cap stays rubble (no mid tile)', () => {
    const tiles = stubTilesFor(g(2, 1), 'r->s');
    const variantOf = (t) => t.texture.src.split('/').pop().replace('.webp', '');
    expect(tiles.map((t) => [variantOf(t), t.rotation])).toEqual([
      ['corridor-end', 270],
      ['corridor-rubble', 90],
    ]);
  });

  it('a 1-long stub: unchanged, the single cell is the rubble cap', () => {
    const tiles = stubTilesFor(g(1, 1), 'r->s');
    const variantOf = (t) => t.texture.src.split('/').pop().replace('.webp', '');
    expect(tiles.map((t) => [variantOf(t), t.rotation])).toEqual([['corridor-rubble', 90]]);
  });
});
```

`stubTilesFor` is not currently exported — add it to `scripts/dungeon-scene.mjs`'s own export list for this test (it is already a named `function` declaration, confirmed current; change `function stubTilesFor` to `export function stubTilesFor`).

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx vitest run tests/dungeon-stub-corridor-pieces.test.mjs`
Expected: FAIL — every non-cap tile currently reports `['corridor', 0]` (the `'single'` variant), not `'corridor-end'`/`'corridor-mid'`.

- [ ] **Step 4: Fix `stubTilesFor`**

Change (confirmed current):

```js
function stubTilesFor(g, key) {
  const f = g.floor[0];
  const tiles = [];
  for (let k = 0; k < g.length; k += 1) {
    const gx = g.dir > 0 ? f.gx + k : f.gx + f.gw - 1 - k;
    const cap = k === g.length - 1;
    tiles.push({
      texture: { src: CORRIDOR_ART_BY_VARIANT[cap ? "rubble" : "single"], anchorX: 0.5, anchorY: 0.5 },
      x: toPixels(gx) + toPixels(1) / 2,
      y: toPixels(f.gy) + toPixels(1) / 2,
      width: toPixels(1),
      height: toPixels(1),
      // The cap faces the dead end like corridorTileVariant's far 'end' tile (90 heading east, 270 west).
      rotation: cap ? (g.dir > 0 ? 90 : 270) : 0,
      flags: { [MODULE_ID]: { dungeonStubCorridorFor: key } },
    });
  }
  return tiles;
}
```

to:

```js
export function stubTilesFor(g, key) {
  const f = g.floor[0];
  const tiles = [];
  const forward = g.dir > 0 ? "E" : "W";
  const backward = g.dir > 0 ? "W" : "E";
  for (let k = 0; k < g.length; k += 1) {
    const gx = g.dir > 0 ? f.gx + k : f.gx + f.gw - 1 - k;
    const cap = k === g.length - 1;
    // #861: every non-cap tile now uses #823's openings-based piece rule --
    // the door-end tile (k=0) only ever opens toward the NEXT corridor
    // cell (never toward the room; that boundary is the room's own door
    // wall, not this tile's own texture), every interior tile opens both
    // ways along the line. The cap stays the dedicated rubble asset,
    // unchanged -- it was never part of the openings system (#438).
    const { variant, rotation } = cap
      ? { variant: "rubble", rotation: g.dir > 0 ? 90 : 270 }
      : corridorPieceForOpenings(k === 0 ? [forward] : [forward, backward]);
    tiles.push({
      texture: { src: CORRIDOR_ART_BY_VARIANT[variant], anchorX: 0.5, anchorY: 0.5 },
      x: toPixels(gx) + toPixels(1) / 2,
      y: toPixels(f.gy) + toPixels(1) / 2,
      width: toPixels(1),
      height: toPixels(1),
      rotation,
      flags: { [MODULE_ID]: { dungeonStubCorridorFor: key } },
    });
  }
  return tiles;
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run tests/dungeon-stub-corridor-pieces.test.mjs`
Expected: PASS.

- [ ] **Step 6: Run the full suite**

Run: `npx vitest run`
Expected: PASS across the board — `stubTilesFor` is only called from one site (`scripts/dungeon-scene.mjs:879`, confirmed current), and no other file imports it by name, so this change cannot ripple beyond stub-tile rendering.

- [ ] **Step 7: Commit**

```bash
git add scripts/dungeon-scene.mjs tests/dungeon-stub-corridor-pieces.test.mjs
git commit -m "fix(#861): dead-end stub corridors use the openings-based piece rule

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 2: Add the categorized wall-crossing sweep (pinning the real, measured state)

**Files:**
- Create: `tests/dungeon-corridor-wall-crossing-sweep.test.mjs`

**Interfaces:**
- Consumes: the same harness `tests/dungeon-corridor-joins-sweep.test.mjs` already uses (`computeRunLayout`, `planRunLayoutStubs`, `buildSceneForLayout`, `installFoundryStubs`, `sweepShapeOfRunLayout`, `PIECE_OPENINGS`).
- Produces: a permanent, categorized regression guard for "a non-door wall crosses an open corridor joint" — pinned to the real current counts, not zero, until the follow-up issue (Task 3) resolves the underlying cause.

- [ ] **Step 1: Write the sweep**

```js
import { describe, it, expect } from 'vitest';
import * as deck from '../scripts/dungeon-deck.mjs';
import { computeRunLayout, planRunLayoutStubs } from '../scripts/dungeon-reseed.mjs';
import { buildSceneForLayout, installFoundryStubs } from './helpers/scene-oracle.mjs';
import { sweepShapeOfRunLayout } from './helpers/walkability-oracle.mjs';
import { PIECE_OPENINGS } from '../scripts/corridor-pieces.mjs';

installFoundryStubs();
const MODULE_ID = 'pf2e-dungeon-crawl';
const SEEDS = 100;
const cellOf = (t) => [Math.round((t.x - 50) / 100), Math.round((t.y - 50) / 100)];
const keyOf = (gx, gy) => `${gx},${gy}`;
const DELTA = { E: [1, 0], S: [0, 1] };

/** Art-derived openings of a corridor or stub tile ('single'/'rubble' -> no
 * openings -- neither is part of the #823 openings system). */
function openingsOfTile(t) {
  const file = t.texture.src.split('/').pop().replace('.webp', '');
  const variant = file === 'corridor' ? 'single' : file.replace('corridor-', '');
  if (variant === 'single' || variant === 'rubble') return new Set();
  const rot = t.rotation ?? 0;
  const key = `${variant}@${variant === 'mid' ? rot % 180 : rot}`;
  const open = PIECE_OPENINGS[key];
  if (!open) throw new Error(`no opening entry for ${key}`);
  return new Set(open);
}

describe('#861 no solid (non-door) wall crosses an open corridor joint', () => {
  it('sweep: 100 routed v3 seeds, categorized by the crossing wall\'s own module flags', async () => {
    const byCategory = {};
    for (let i = 0; i < SEEDS; i += 1) {
      const P = computeRunLayout({ generator: deck, seed: `sweep-${i}`, roomCount: 6 + (i % 15), topologyRouting: true });
      const planned = await planRunLayoutStubs(P, { retreatAvailable: true });
      const L = sweepShapeOfRunLayout(planned.layout);
      const { scene } = await buildSceneForLayout(L, 3);

      const groups = new Map();
      for (const tile of scene.tiles) {
        const edge = tile.flags?.[MODULE_ID]?.dungeonCorridorEdge;
        const stubFor = tile.flags?.[MODULE_ID]?.dungeonStubCorridorFor;
        const gid = edge ?? (stubFor ? `stub:${stubFor}` : null);
        if (!gid) continue;
        if (!groups.has(gid)) groups.set(gid, new Map());
        groups.get(gid).set(keyOf(...cellOf(tile)), tile);
      }

      for (const cells of groups.values()) {
        for (const [k, tile] of cells) {
          const [gx, gy] = k.split(',').map(Number);
          const opens = openingsOfTile(tile);
          for (const side of ['E', 'S']) {
            if (!opens.has(side)) continue;
            const [dx, dy] = DELTA[side];
            if (!cells.has(keyOf(gx + dx, gy + dy))) continue;
            const boundary = side === 'E'
              ? { vertical: true, x: (gx + 1) * 100, y0: gy * 100, y1: (gy + 1) * 100 }
              : { vertical: false, y: (gy + 1) * 100, x0: gx * 100, x1: (gx + 1) * 100 };
            for (const w of scene.walls) {
              if (w.door) continue; // a real door is SUPPOSED to cross a corridor/room joint -- not a defect
              const [x1, y1, x2, y2] = w.c;
              const crosses = boundary.vertical
                ? x1 === x2 && x1 === boundary.x && Math.min(y1, y2) < boundary.y1 && Math.max(y1, y2) > boundary.y0
                : y1 === y2 && y1 === boundary.y && Math.min(x1, x2) < boundary.x1 && Math.max(x1, x2) > boundary.x0;
              if (!crosses) continue;
              const flagKeys = Object.keys(w.flags?.[MODULE_ID] ?? {}).join('+') || 'NO_FLAGS';
              byCategory[flagKeys] = (byCategory[flagKeys] ?? 0) + 1;
            }
          }
        }
      }
    }
    // Measured this session (2026-10-06, current main post-#858/#863/#865):
    // three wall-generation mechanisms -- cellMarginWalls' own planned
    // margin openings, transitCellContainmentWalls' own per-crossing
    // openings, and roomEnclosureWalls' own per-direction wall -- each
    // independently disagree with a hidden-detour edge's own REAL routed
    // corridor tiles in some seeds. Pinned here, not asserted to zero: the
    // underlying cause spans three independent subsystems and is tracked
    // as its own follow-up issue (see #861's own closing comment for the
    // issue number) rather than guessed at in this same pass. A future fix
    // lowers these numbers -- update this assertion to match, the same way
    // tests/dungeon-corridor-joins-sweep.test.mjs's own old/new numbers are
    // updated whenever corridor geometry legitimately changes.
    expect(byCategory).toEqual({
      dungeonCellMarginWallForRoom: 41,
      'dungeonTransitCellMarginForCell+dungeonTransitCellOpenings': 34,
      'dungeonEnclosureWallForRoom+dungeonEnclosureWallDirection': 14,
    });
  }, 600000);
});
```

- [ ] **Step 2: Run it to confirm it passes against the real, current state**

Run: `npx vitest run tests/dungeon-corridor-wall-crossing-sweep.test.mjs`
Expected: PASS with exactly the pinned counts above. If the real counts differ (concurrent sessions push to this repo constantly — re-check immediately before this step), update the `expect(byCategory).toEqual(...)` block to the actual, freshly-measured numbers rather than forcing the old ones — this test's entire purpose is to honestly reflect the current measured state, never a stale guess.

- [ ] **Step 3: Commit**

```bash
git add tests/dungeon-corridor-wall-crossing-sweep.test.mjs
git commit -m "test(#861): sweep categorizing walls that cross an open corridor joint

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 3: File the wall-crossing follow-up issue, update #861's own disposition

- [ ] **Step 1: File the follow-up issue with the real measured evidence**

```bash
gh issue create --title "Three wall-generation mechanisms disagree with real corridor routing on hidden-detour edges (solid wall crosses open corridor floor)" \
  --label bug \
  --body "$(cat <<'EOF'
Split from #861 (part 2). Investigated this session with a real, committed sweep (tests/dungeon-corridor-wall-crossing-sweep.test.mjs) rather than guessed at.

Measured (100 routed v3 seeds, current main post-#858/#863/#865): 11/100 seeds have a non-door wall document crossing a cell boundary the corridor's own art shows as open, split into three categories by the crossing wall's own module flags -- each a SEPARATE wall-generation mechanism:

- `dungeonCellMarginWallForRoom` (41 instances): a room's own cell-margin containment wall (cellMarginWalls, fed by plannedMarginOpenings for a routed/planned room) crosses a corridor joint.
- `dungeonTransitCellMarginForCell` + `dungeonTransitCellOpenings` (34 instances): a transit cell's own outer-boundary containment (transitCellContainmentWalls) crosses a corridor joint -- the wall's own recorded entry/exit crossing POINT (stored in its own dungeonTransitCellOpenings flag) does not match where the crossing's real floor tile ended up (confirmed by hand for seed-8: the wall's own recorded east-side opening is at y=28, but the actual corridor tile joint it should have left open is at y=32).
- `dungeonEnclosureWallForRoom` + `dungeonEnclosureWallDirection` (14 instances): a room's own enclosure wall (roomEnclosureWalls) crosses a corridor joint.

Every example this session's own probe found targets a `->room-detour-N` edge (a hidden detour corridor) -- this may be one shared root cause (the topology-routed detour path producing a real corridor route that some margin/enclosure computation doesn't fully account for) or three independent ones; not yet determined which.

Named repro: seed sweep-8, edge room-room-room-entry-1-1->room-detour-0, hits all three categories at once (cells 312/313, 325/326, 338/339, 353/354 along y=32; wall ids 308/317/330/316/358/435 in that seed's own build). Also seed-36/41, edge ->room-detour-0/1, enclosure-only hits at (300,51)->(300,52).

tests/dungeon-corridor-wall-crossing-sweep.test.mjs's own expect(byCategory)... pins these exact counts -- update it alongside whatever fix lands here.

A real fix needs tracing each of the three mechanisms' own opening-point source against buildEdgeCorridor's own REAL final tile geometry for a hidden-detour edge specifically, likely starting with the transit-cell case (concrete, already-demonstrated point-level mismatch above) before the other two.
EOF
)"
```

- [ ] **Step 2: Comment on #861 with the split disposition**

```bash
gh issue comment 861 --body "Part (1) (stub corridor tiles rendering as fully-walled boxes) fixed: stubTilesFor now uses the #823 openings-based piece rule. Part (2) (solid wall crossing open corridor floor) investigated with a real, committed, categorized sweep (tests/dungeon-corridor-wall-crossing-sweep.test.mjs) -- it spans three independent wall-generation mechanisms (cellMarginWalls/transitCellContainmentWalls/roomEnclosureWalls), all concentrated on hidden-detour edges, needing real per-mechanism tracing rather than a guessed blanket fix. Split out to its own evidence-backed issue: #<new-issue-number>."
```

(Run Step 1 first and substitute its real printed issue number here — `gh issue create` prints the new issue's URL/number on success.)

---

### Task 4: Version bump

**Files:**
- Modify: `module.json`

- [ ] **Step 1: Re-check the current version and bump**

```bash
git fetch origin main -q && git log origin/main -1 --oneline && grep version module.json
```

Apply a **patch** bump (a rendering fix plus a new regression sweep, not an architecture-level change), using whatever the fetch above shows as current.

- [ ] **Step 2: Commit**

```bash
git add module.json
git commit -m "chore(#861): bump version for the stub corridor piece fix

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Self-Review

**1. Scope coverage:** #861's own two-part ask is addressed honestly: part (1) gets a real, shipped fix with full TDD coverage (Task 1); part (2) gets the requested "sweep assertion" (Task 2, committed and pinned to real measured counts) plus a genuine, evidence-grounded decision to re-scope the actual fix into its own issue (Task 3) rather than guessing at three interacting subsystems in one pass — consistent with this project's own established practice for multi-mechanism bugs (#230/#231/#232).

**2. Placeholder scan:** No TBD/guessed numbers. Every count in Task 2/3 (41/34/14, 11/100 seeds, the seed-8 y=28-vs-y=32 point mismatch) was measured this session via a real, run probe against the current codebase, not invented.

**3. Type consistency:** `stubTilesFor`'s own call signature (`g, key`) and return shape are unchanged — only its internal variant/rotation computation changes, reusing `corridorPieceForOpenings`'s existing, already-tested signature verbatim (no new helper invented).

**4. Review Focus:** All five items (door-end-tile openings, cap/single-cell unchanged, door-exclusion correctness in the sweep, the follow-up issue's own evidence quality, #861's own accurate partial-close disposition) each map to a specific task step. No gaps found.

---

Plan complete and saved to `docs/superpowers/plans/2026-10-06-stub-corridor-pieces-and-wall-crossings.md`.
