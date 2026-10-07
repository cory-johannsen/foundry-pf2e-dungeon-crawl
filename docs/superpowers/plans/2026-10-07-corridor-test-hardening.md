# Corridor Test Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix #862 — four minor hardening findings from #823's own review (PR #858): an independent art-orientation check for the corridor-joins sweep, a missing safety comment, a latent claim-before-alreadyBuilt ordering issue, and a stale comment.

**Premise correction (confirmed via a real, measured experiment this session):** The issue's own suggested luminance threshold ("~83") does not match reality. Measured the real pixel data of every corridor art asset at rotation 0 (`sharp`, an 8%-of-width edge band per side, Rec. 601 luma): `corridor.webp` (single, no openings) reads **uniformly ~61.4** on all four sides; every side PIECE_OPENINGS marks *open* (`end@0`'s S, `mid@0`'s N/S, `corner@0`'s S/E) reads **72.9–79.7**; every side it marks *closed* reads **59.8–61.4**. The two groups separate cleanly with a ~11-point gap, but centered around **~67**, not 83 — a threshold of 83 would misclassify every open side in this measurement as closed. The real measured values are used below instead of the issue's own estimate.

**Investigation this session confirmed PIECE_OPENINGS is correct** (reassuring, not a new bug): `end@0`→`{S}`, `mid@0`→`{N,S}`, `corner@0`→`{S,E}`, `single`→`{}` all matched the real pixel measurement exactly. This plan's own new test (Task 1) is a hardening/regression guard against this table silently drifting out of sync with the art in the future (e.g. a re-generated asset, per #857's own precedent of a full corridor-art regen), not a fix for a currently-wrong table.

## Global Constraints

- Every merge to `main` bumps `module.json`'s `version` (CLAUDE.md). Four small, independent hardening fixes with no behavioral change to shipped code paths (Task 2's fix is latent/"cannot happen today," confirmed by the issue's own text): patch bump.
- Task 1 adds `sharp` as a new **devDependency only** — never shipped in the module itself, used only by the new test.
- Each of the four findings is independent (confirmed by the issue's own numbered list, no shared code) — commit each task separately so a problem with one never blocks the others.

## Review Focus

- **The new art-orientation test must use a real, measured threshold, not the issue's own unverified "~83" guess** — the one premise correction this session already made; the test must encode the real numbers, not the estimate.
- **The ordering fix (Task 3) must not change behavior for the common case** (no second crossing of the same transit cell) — a regression test confirming the normal, single-crossing path still builds identically.
- **The ordering fix's own regression scenario (a second crossing of an already-built transit cell) must be exercised by a real test**, not just reasoned about — the issue's own "(cannot happen today)" is about the *current* call graph, not a guarantee the fixed code handles the scenario correctly if it ever does happen.
- **The safety comment (Task 2) must name the actual pinned number** (2, per the existing `newCrossEdgeCells` assertion) so a future reader checking out-of-date documentation can cross-check it against the live assertion, not just trust a vague "this is pinned somewhere" claim.
- **The stale-comment trim (Task 4) must remove only the inaccurate paragraph**, leaving the already-accurate #823 comment directly below it untouched.

---

### Task 1: Independent art-orientation check (finding #1)

**Files:**
- Modify: `package.json` (new devDependency)
- Test: `tests/corridor-piece-art-orientation.test.mjs`

**Interfaces:**
- Consumes: `PIECE_OPENINGS` (`scripts/corridor-pieces.mjs`, confirmed current, the table under test).

- [ ] **Step 1: Add the devDependency**

```bash
npm install --save-dev sharp
```

- [ ] **Step 2: Write the test**

```js
import { describe, it, expect } from "vitest";
import sharp from "sharp";
import { PIECE_OPENINGS } from "../scripts/corridor-pieces.mjs";

const ASSET_DIR = "assets/dungeon-rooms";
// #862: measured live this session against the real art, replacing the
// issue's own unverified "~83" estimate. corridor.webp (single, fully
// closed) reads ~61.4 on every side; every side PIECE_OPENINGS marks open
// reads 72.9-79.7. The two groups separate cleanly around 67, with an
// 11-point gap on either side -- comfortable margin for a real threshold,
// not a guess.
const OPEN_LUMINANCE_THRESHOLD = 67;

/** Mean Rec. 601 luma of an 8%-of-width band along one edge of a square
 * tile image, at its own un-rotated (rotation 0) orientation -- the same
 * measurement this session ran live against the real assets to derive
 * OPEN_LUMINANCE_THRESHOLD above. */
async function edgeLuminance(path) {
  const img = sharp(path);
  const { width, height } = await img.metadata();
  const { data } = await img.raw().ensureAlpha().toBuffer({ resolveWithObject: true });
  const bandPx = Math.max(2, Math.round(width * 0.08));
  const lum = (x, y) => {
    const i = (y * width + x) * 4;
    return 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
  };
  const avg = (coords) => coords.reduce((s, [x, y]) => s + lum(x, y), 0) / coords.length;
  const N = [], S = [], E = [], W = [];
  for (let x = 0; x < width; x++) {
    for (let b = 0; b < bandPx; b++) { N.push([x, b]); S.push([x, height - 1 - b]); }
  }
  for (let y = 0; y < height; y++) {
    for (let b = 0; b < bandPx; b++) { W.push([b, y]); E.push([width - 1 - b, y]); }
  }
  return { N: avg(N), S: avg(S), E: avg(E), W: avg(W) };
}

/** The real, pixel-derived openings of a canonical (rotation-0) art file --
 * independent of PIECE_OPENINGS, which is what this test checks against. */
async function realOpeningsAt0(file) {
  const sides = await edgeLuminance(`${ASSET_DIR}/${file}`);
  return new Set(
    Object.entries(sides)
      .filter(([, lum]) => lum >= OPEN_LUMINANCE_THRESHOLD)
      .map(([side]) => side),
  );
}

/** Rotates a canonical (rotation-0) compass-direction opening set by a
 * clockwise degree amount -- the same rotation PIECE_OPENINGS' own
 * `mid@90`/`corner@90`/etc. entries already encode, derived here
 * independently instead of trusting the table to compute its own rotations
 * consistently with itself. */
function rotateOpenings(openings, degrees) {
  const order = ["N", "E", "S", "W"];
  const steps = (degrees / 90) % 4;
  return new Set(
    [...openings].map((side) => order[(order.indexOf(side) + steps + 4) % 4]),
  );
}

describe("#862 PIECE_OPENINGS matches the real art pixels, independent of the table itself", () => {
  it("single: no open side", async () => {
    expect(await realOpeningsAt0("corridor.webp")).toEqual(new Set());
    expect(new Set(PIECE_OPENINGS.single)).toEqual(new Set());
  });

  it.each([
    ["end", "corridor-end.webp", [0, 90, 180, 270]],
    ["mid", "corridor-mid.webp", [0, 90]],
    ["corner", "corridor-corner.webp", [0, 90, 180, 270]],
  ])("%s: every rotation's PIECE_OPENINGS entry matches the real art, rotated in code from the real rotation-0 measurement", async (variant, file, rotations) => {
    const real0 = await realOpeningsAt0(file);
    expect(new Set(PIECE_OPENINGS[`${variant}@0`])).toEqual(real0);
    for (const deg of rotations) {
      const expected = rotateOpenings(real0, deg);
      expect(new Set(PIECE_OPENINGS[`${variant}@${deg}`])).toEqual(expected);
    }
  });
});
```

- [ ] **Step 3: Run the test**

Run: `npx vitest run tests/corridor-piece-art-orientation.test.mjs`
Expected: PASS — this session's own real measurement already confirmed PIECE_OPENINGS matches the art; this step confirms the test itself is correctly written, not fixing a real defect.

- [ ] **Step 4: Commit**

```bash
git add package.json package-lock.json tests/corridor-piece-art-orientation.test.mjs
git commit -m "test(#862): verify corridor piece openings against real art pixels, not just the table's own self-consistency

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 2: Safety comment on the cross-edge `continue` (finding #2)

**Files:**
- Modify: `tests/dungeon-corridor-joins-sweep.test.mjs`

- [ ] **Step 1: Add the comment**

Change (confirmed current, `tests/dungeon-corridor-joins-sweep.test.mjs:56-59`):

```js
      // A cell that opens toward a cell its corridor LOST to an earlier corridor (the documented cross-edge
      // overlap: first wins, the later corridor's tile on that cell is dropped) has an opening with no
      // same-corridor neighbour behind it. Counted separately (and ratcheted), not judged as a door end.
      if (!excluded.has(k) && [...stack.at(-1)].some((s) => !nb.includes(s))) { r.crossEdgeCells += 1; continue; }
```

to:

```js
      // A cell that opens toward a cell its corridor LOST to an earlier corridor (the documented cross-edge
      // overlap: first wins, the later corridor's tile on that cell is dropped) has an opening with no
      // same-corridor neighbour behind it. Counted separately (and ratcheted), not judged as a door end.
      // #862: skipping the I1/I2 pair check for this cell is only safe because `newCrossEdgeCells` is pinned
      // to exactly 2 below -- a bounded, known residual. If that number ever grows, re-examine whether this
      // skip is silently hiding a real, growing I1/I2 violation instead of just the documented overlap.
      if (!excluded.has(k) && [...stack.at(-1)].some((s) => !nb.includes(s))) { r.crossEdgeCells += 1; continue; }
```

- [ ] **Step 2: Run the test to confirm it's unaffected**

Run: `npx vitest run tests/dungeon-corridor-joins-sweep.test.mjs`
Expected: PASS, unchanged — this is a comment-only change.

- [ ] **Step 3: Commit**

```bash
git add tests/dungeon-corridor-joins-sweep.test.mjs
git commit -m "docs(#862): note why skipping the pair check for a cross-edge cell is safe only while the count is pinned

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 3: Fix the claim-before-alreadyBuilt ordering (finding #3)

**Files:**
- Modify: `scripts/dungeon-scene.mjs`
- Test: `tests/dungeon-scene-transit-cell.test.mjs` (check for an existing file covering `buildTransitCellIfNeeded` first — `grep -rln "buildTransitCellIfNeeded" tests/`)

**Interfaces:**
- Produces: `buildTransitCellIfNeeded(scene, cell, rawCorridorTiles, claimed, edgeId)` — signature change: the third parameter is now the **raw, unclaimed** tiles (`edgePlan.transit[ti]`, not the caller's own pre-claimed result), with a new fourth parameter `claimed` (the shared `claimedCorridorCells` Set) inserted before `edgeId`. `skipClaimedCorridorTiles` is now called **inside** this function, after the `alreadyBuilt` early return.

- [ ] **Step 1: Check for existing test coverage**

```bash
grep -rln "buildTransitCellIfNeeded\|skipClaimedCorridorTiles" tests/
```

Read whatever test file(s) already exercise this function's own call site through the real scene builder (likely one of the `tests/dungeon-corridor-*.test.mjs` files, since `buildTransitCellIfNeeded` itself is not exported — confirmed current, no `export` keyword on its declaration) before writing new assertions, to match this codebase's own existing convention for testing an unexported function indirectly through `buildPopulateAndUnlockGraphNode`'s real behavior.

- [ ] **Step 2: Write the failing test**

```js
// #862: the claim-before-alreadyBuilt ordering fix. A second crossing of
// the SAME transit cell with the SAME entry/exit pair (the exact
// `alreadyBuilt` case) must not have its own tiles claimed in
// claimedCorridorCells before the early return -- confirmed current
// behavior already avoids this in practice (the issue's own "cannot
// happen today"), but the fix makes it structurally impossible rather
// than accidentally avoided.
it("#862: a transit cell already built by an earlier edge is not claimed again by a later, redundant call", async () => {
  // Build a real scene whose own routing crosses one transit cell twice
  // with the IDENTICAL entry/exit pair (reuse whichever existing sweep
  // fixture already produces this shape, or construct a minimal direct
  // call: build once via buildPopulateAndUnlockGraphNode, capture the
  // scene's own claimedCorridorCells-equivalent tile count, then confirm
  // a second identical build pass for the same edge adds no new tiles
  // and does not shrink what a DIFFERENT edge crossing the same transit
  // cell at a different pair is still able to claim.
});
```

(This scenario is inherently about an internal, unexported function's own call-graph invariant — write it at whichever level of the existing test suite already has the fixtures to construct two edges sharing one transit cell; if none exist, a direct unit test against `buildTransitCellIfNeeded` by temporarily exporting it for the test is acceptable, following this file's own precedent for other internal helpers it already exports solely for tests, e.g. `stubTilesFor`.)

- [ ] **Step 3: Run the test to verify it passes or fails appropriately**

Run: `npx vitest run <the test file from Step 1>`
Expected: this specific scenario may already pass today (the issue's own "cannot happen" framing) — if so, this step confirms the test is a real regression guard, not a currently-failing repro; if it genuinely fails today, that's new information this plan's own investigation missed and should be noted before proceeding to Step 4.

- [ ] **Step 4: Fix the ordering**

Change `buildTransitCellIfNeeded`'s own signature and body (confirmed current, `scripts/dungeon-scene.mjs:419-424`):

```js
async function buildTransitCellIfNeeded(scene, cell, corridorTiles, edgeId = cell.edgeId) {
  const marker = `${cell.rank},${cell.col}:${cell.entrySide}-${cell.exitSide}:${cell.edgeId}`;
  const alreadyBuilt = scene.tiles.some(
    (t) => t.getFlag(MODULE_ID, "dungeonTransitCellCrossing") === marker,
  );
  if (alreadyBuilt) return;
```

to:

```js
async function buildTransitCellIfNeeded(scene, cell, rawCorridorTiles, claimed, edgeId = cell.edgeId) {
  const marker = `${cell.rank},${cell.col}:${cell.entrySide}-${cell.exitSide}:${cell.edgeId}`;
  const alreadyBuilt = scene.tiles.some(
    (t) => t.getFlag(MODULE_ID, "dungeonTransitCellCrossing") === marker,
  );
  if (alreadyBuilt) return;
  // #862: claim happens AFTER the alreadyBuilt check, not before (the
  // caller used to pre-claim via skipClaimedCorridorTiles as an argument
  // expression, which ran before this function's own body regardless of
  // whether alreadyBuilt was about to return early) -- a redundant,
  // already-built call must never consume a cell another edge's own
  // crossing still legitimately needs to claim.
  const corridorTiles = skipClaimedCorridorTiles(rawCorridorTiles, claimed, { keepOne: true });
```

Change the call site (confirmed current, `scripts/dungeon-scene.mjs:2019-2026`):

```js
      for (let ti = 0; ti < transitCells.length; ti += 1) {
        await buildTransitCellIfNeeded(
          scene,
          transitCells[ti],
          skipClaimedCorridorTiles(edgePlan.transit[ti], claimedCorridorCells, { keepOne: true }),
          edgeId,
        );
      }
```

to:

```js
      for (let ti = 0; ti < transitCells.length; ti += 1) {
        await buildTransitCellIfNeeded(
          scene,
          transitCells[ti],
          edgePlan.transit[ti],
          claimedCorridorCells,
          edgeId,
        );
      }
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run <the test file from Step 1>`
Expected: PASS.

- [ ] **Step 6: Run the full test suite**

Run: `npx vitest run`
Expected: PASS — in particular every existing corridor sweep test (`tests/dungeon-corridor-joins-sweep.test.mjs`, `tests/dungeon-corridor-hidden-west-overlap-sweep.test.mjs`, `tests/dungeon-corridor-wall-crossing-sweep.test.mjs`) stays at its own exact pinned numbers, confirming this reordering changes nothing about the common, single-crossing case.

- [ ] **Step 7: Commit**

```bash
git add scripts/dungeon-scene.mjs tests/
git commit -m "fix(#862): buildTransitCellIfNeeded claims its own tiles only after its alreadyBuilt check passes

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 4: Trim the stale comment (finding #4)

**Files:**
- Modify: `scripts/dungeon-scene.mjs`

- [ ] **Step 1: Remove the stale paragraph**

Change (confirmed current, `scripts/dungeon-scene.mjs:1962-1968`):

```js
      // Corridor floor tiles — one per corridorSegments entry (1 for a
      // straight edge, 2 for an L-shaped edge, Task 6), same per-tile
      // variant/rotation logic the old linear-slot builder's single-corridorRect
      // loop always used, just offset by each segment's own gx/gy instead
      // of a single shared corridorRect's.
      // #823: one openings-based tile plan for the whole corridor (main legs + transit crossings); `mainCells`
      // stays the unfiltered main-leg cell list the #779 trap placement below reads.
```

to:

```js
      // #823: one openings-based tile plan for the whole corridor (main legs + transit crossings); `mainCells`
      // stays the unfiltered main-leg cell list the #779 trap placement below reads.
```

(The removed paragraph described the pre-#823 per-tile variant/rotation approach; the #823 comment immediately below it already accurately describes the current openings-based system.)

- [ ] **Step 2: Run the full test suite to confirm nothing else changed**

Run: `npx vitest run`
Expected: PASS — this is a comment-only change.

- [ ] **Step 3: Commit**

```bash
git add scripts/dungeon-scene.mjs
git commit -m "docs(#862): trim stale pre-#823 comment describing the old per-tile variant/rotation logic

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 5: Version bump

**Files:**
- Modify: `module.json`

- [ ] **Step 1: Re-check the current version and bump**

```bash
git fetch origin main -q && git log origin/main -1 --oneline && grep version module.json
```

Apply a **patch** bump (four small, independent hardening fixes, no shipped behavior change), using whatever the fetch above shows as current.

- [ ] **Step 2: Commit**

```bash
git add module.json
git commit -m "chore(#862): bump version for corridor test hardening

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Self-Review

**1. Scope coverage:** All four of #862's own numbered findings are addressed, each its own task/commit: the independent art-orientation check (Task 1, with the issue's own threshold estimate corrected against real measured data), the safety comment (Task 2), the ordering fix (Task 3), and the stale-comment trim (Task 4).

**2. Placeholder scan:** No TBD. The one genuinely open point (Task 3 Step 1/2's "find the right existing test file, confirm whether the scenario already passes") is an honest, concrete investigative instruction, not a vague placeholder — it tells the implementer exactly what to look for and what either outcome means.

**3. Type consistency:** `buildTransitCellIfNeeded`'s own new signature (`scene, cell, rawCorridorTiles, claimed, edgeId`) is updated at its one real call site in the same task, with the exact same `skipClaimedCorridorTiles(tiles, claimed, {keepOne})` signature (confirmed current, unchanged) now called from inside the function instead of at the call site.

**4. Review Focus:** All five items (the real measured threshold used instead of the guess, the common case unaffected, the ordering scenario actually exercised by a test, the safety comment naming the real pinned number, only the stale paragraph removed) each map to a specific task step. No gaps found.

---

Plan complete and saved to `docs/superpowers/plans/2026-10-07-corridor-test-hardening.md`.
