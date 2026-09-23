# Footprint-Aware Pathfinding Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make grid pathfinding and occupancy checking genuinely aware of a
mover's own multi-square footprint, end to end, so a Large (or larger)
creature can never path itself into (or be blocked by) a gap narrower than
its own size, and give a genuine "route exists but every landing spot is
occupied" stall a signal distinct from "no route exists at all."

**Architecture:** `findPath` (pathfinding.mjs) gains an optional `footprint`
parameter (default `{gw:1,gh:1}`, so every existing call is unaffected) and
decomposes each candidate step into per-cell `isBlocked` checks across the
mover's own `gw×gh` squares. Every caller — `dungeon-combat.mjs`'s
`stepToward`/`strideByPosture`/`pushTokenAway` and
`dungeon-follow-mechanics.mjs`'s `findFollowMove` — threads its own mover's
real footprint (`placement.mjs`'s `footprint()`) through to `findPath` and
to its own occupancy check, replacing every hardcoded `{gw:1,gh:1}`
assumption. `dungeon-follow.mjs`'s occupancy tracking converts from a
`Set<"gx,gy">` of single reference cells to an array of real
`{gx,gy,gw,gh}` footprints (via `placement.mjs`'s `overlaps()`), matching
`dungeon-combat.mjs`'s existing occupancy pattern instead of duplicating a
second, footprint-blind one. `stepToward`/`strideByPosture` finally return a
status string distinguishing "moved" from "no-route" (no path exists) from
"blocked" (a path exists but every reachable landing cell is occupied),
and `applyAgentDecision` whispers the GM a follow-up chat card only on
"blocked" — the case worth flagging as a genuine, possibly-temporary
stall.

**Tech Stack:** Vanilla JS (ESM), vitest, Foundry VTT v13/v14 module
(`scripts/*.mjs`), no build step.

**Spec:** `docs/superpowers/specs/2026-09-23-footprint-aware-pathfinding-design.md`

## Global Constraints

- Every merge to `main` bumps `module.json`'s `version` field (patch for
  this kind of fix; current value is `0.37.2` as of this plan). One
  catch-up bump at the end covers the whole branch — don't bump per task.
- A 1×1 footprint (today's default everywhere) must be provably a no-op:
  every existing test in `tests/pathfinding.test.mjs`,
  `tests/dungeon-combat-grid-snap.test.mjs`,
  `tests/dungeon-follow.test.mjs`, and `tests/dungeon-follow-mechanics.test.mjs`
  must still pass unmodified in behavior (some will need call-site updates
  for a changed function signature — see Task 3/4 — but their assertions
  and scenarios do not change).
- No change to `pathfinding.mjs`'s underlying A* algorithm structure beyond
  the per-footprint-cell decomposition (no alternate search algorithm, no
  memoization) — accept the O(gw×gh) per-step cost increase.
- Out of scope (do not touch): #141's Shove/forced-movement hypothesis;
  retry/priority/bump logic for a genuine mutual chokepoint contest between
  two same-size movers.
- Run `npx vitest run` after every task; all suites must pass before
  moving to the next task.

---

### Task 1: `findPath`'s footprint-aware core

**Files:**
- Modify: `scripts/pathfinding.mjs:83-147` (the `findPath` export)
- Test: `tests/pathfinding.test.mjs`

**Interfaces:**
- Consumes: nothing new — pure addition to `findPath`'s existing signature.
- Produces: `findPath(start, goal, isBlocked, bounds = null, maxExpansions = 20000, footprint = { gw: 1, gh: 1 })`.
  Every later task calls this new 6th positional parameter. `start`/`goal`
  remain the mover's own top-left reference cell (unchanged meaning).

- [ ] **Step 1: Write the failing tests**

Add to `tests/pathfinding.test.mjs`, inside the existing `describe("findPath", ...)` block (after the last existing `it(...)`, before its closing `});`):

```js
  it("with a non-default footprint, refuses a corridor only wide enough for a 1x1 mover", () => {
    // A 1-row-tall corridor at gy=1 (open), walled top (between gy 0/1) and
    // bottom (between gy 1/2) for gx 0..5 -- a 2x2 mover can never fit
    // inside it, since its own second row would always cross a wall.
    const isBlocked = (a, b) =>
      a.gy !== b.gy && Math.min(a.gy, b.gy) === 0 && a.gx >= 0 && a.gx <= 5 && b.gx >= 0 && b.gx <= 5
        ? true
        : a.gy !== b.gy && Math.min(a.gy, b.gy) === 1 && a.gx >= 0 && a.gx <= 5 && b.gx >= 0 && b.gx <= 5;
    const bounds = { gx0: 0, gy0: 0, gx1: 6, gy1: 3 };
    const path1x1 = findPath({ gx: 0, gy: 1 }, { gx: 5, gy: 1 }, isBlocked, bounds);
    expect(path1x1).not.toBeNull();
    const path2x2 = findPath(
      { gx: 0, gy: 1 },
      { gx: 5, gy: 1 },
      isBlocked,
      bounds,
      20000,
      { gw: 2, gh: 2 },
    );
    expect(path2x2).toBeNull();
  });

  it("with a non-default footprint, still finds a route through a corridor wide enough for its real size", () => {
    // Two open rows (gy 1 and gy 2), walled above gy=1 and below gy=2, for
    // gx 0..5 -- exactly wide enough for a 2x2 mover.
    const isBlocked = (a, b) => {
      if (a.gy === b.gy) return false;
      const boundary = Math.max(a.gy, b.gy);
      const inCols = a.gx >= 0 && a.gx <= 5 && b.gx >= 0 && b.gx <= 5;
      return inCols && (boundary === 1 || boundary === 3);
    };
    const bounds = { gx0: 0, gy0: 0, gx1: 6, gy1: 4 };
    const path = findPath(
      { gx: 0, gy: 1 },
      { gx: 5, gy: 1 },
      isBlocked,
      bounds,
      20000,
      { gw: 2, gh: 2 },
    );
    expect(path).not.toBeNull();
    for (const cell of path) {
      expect(cell.gy).toBeGreaterThanOrEqual(1);
      expect(cell.gy).toBeLessThanOrEqual(2);
    }
  });

  it("a 1x1 footprint (the default) is byte-identical to calling without the parameter", () => {
    const isBlocked = (a, b) =>
      a.gy !== b.gy && Math.max(a.gy, b.gy) === 1 && a.gx >= 0 && a.gx <= 4 && b.gx >= 0 && b.gx <= 4;
    const withoutParam = findPath({ gx: 2, gy: 0 }, { gx: 2, gy: 3 }, isBlocked);
    const withDefault = findPath(
      { gx: 2, gy: 0 },
      { gx: 2, gy: 3 },
      isBlocked,
      null,
      20000,
      { gw: 1, gh: 1 },
    );
    expect(withDefault).toEqual(withoutParam);
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/pathfinding.test.mjs`
Expected: the three new tests FAIL (`findPath` doesn't accept a 6th
parameter yet, so the 2x2 corridor-refusal test gets a non-null path and
fails its `toBeNull()` assertion; the other two should already pass since
they degrade to today's behavior — that's fine, Step 4 must not break
them).

- [ ] **Step 3: Implement `footprintBlocked` and thread `footprint` through `findPath`**

Replace `scripts/pathfinding.mjs`'s `findPath` export (lines 83-147) with:

```js
/** Whether moving the mover's own `footprint.gw × footprint.gh` block of
 * cells from `current` to `neighbor` (delta `dx,dy`) is blocked — checked
 * per individual cell of the footprint via `isBlocked`'s existing
 * single-cell-pair signature, rather than inventing swept-polygon
 * geometry. A 1×1 footprint reduces to exactly `isBlocked(current,
 * neighbor)`. */
function footprintBlocked(current, dx, dy, isBlocked, footprint) {
  for (let fx = 0; fx < footprint.gw; fx += 1) {
    for (let fy = 0; fy < footprint.gh; fy += 1) {
      const a = { gx: current.gx + fx, gy: current.gy + fy };
      const b = { gx: a.gx + dx, gy: a.gy + dy };
      if (isBlocked(a, b)) return true;
    }
  }
  return false;
}

/**
 * A* over an 8-directional grid of unit squares. `start`/`goal` are
 * `{gx, gy}` integer grid-square coordinates. `isBlocked(a, b)` takes two
 * adjacent cells (`b` one step from `a`, any of the 8 directions) and
 * returns whether movement between them is blocked — the caller owns what
 * "blocked" means (walls, in dungeon-combat.mjs's case).
 *
 * A diagonal step from A to D also checks the four orthogonal edges around
 * the shared corner — A to each flanking cell, and each flanking cell to D
 * — and is blocked if any of them is, even when `isBlocked` itself allows
 * the diagonal pair (A, D) directly. Checking only the two edges leaving A
 * isn't enough: a wall pair anchored at D's side of the corner (e.g. both of
 * D's own orthogonal approaches walled off, D reachable only diagonally)
 * forms just as solid a corner as one anchored at A's side. (This is exactly
 * the class of leak #110 reports on the vision side; this search refuses to
 * reproduce it on the movement side.)
 *
 * `bounds`, if given, is `{gx0, gy0, gx1, gy1}` (inclusive) — cells outside
 * are never visited. Omit it only when the caller already knows the search
 * space is small (bounded by a `maxExpansions` safety valve either way, so a
 * pathological unbounded call can't loop forever).
 *
 * `footprint` (#140) — `{gw, gh}`, default `{gw:1,gh:1}` — is the mover's
 * own size in grid squares, `start`/`goal` still naming its top-left corner
 * (same convention `placement.mjs`'s `footprint()` uses). Every candidate
 * step (including the diagonal flanking checks) is decomposed across the
 * mover's own `gw×gh` cells via `footprintBlocked`, so a mover too big for a
 * gap is refused the same way a 1×1 mover is refused a walled-off cell. The
 * default reduces to exactly today's single-cell behavior — a no-op for
 * every caller that doesn't opt in.
 *
 * Returns an array of `{gx, gy}` waypoints from `start` to `goal` inclusive
 * (`start` is always first), or `null` if no path exists.
 */
export function findPath(
  start,
  goal,
  isBlocked,
  bounds = null,
  maxExpansions = 20000,
  footprint = { gw: 1, gh: 1 },
) {
  if (start.gx === goal.gx && start.gy === goal.gy) return [{ ...start }];
  if (!inBounds(goal, bounds)) return null;

  const open = new Map(); // key -> {cell, f}
  const cameFrom = new Map();
  const gScore = new Map([[key(start), 0]]);
  open.set(key(start), { cell: start, f: chebyshev(start, goal) });

  let expansions = 0;
  while (open.size > 0) {
    if (expansions++ > maxExpansions) return null;

    let currentKey = null;
    let current = null;
    let bestF = Infinity;
    for (const [k, entry] of open) {
      if (entry.f < bestF) {
        bestF = entry.f;
        currentKey = k;
        current = entry.cell;
      }
    }
    open.delete(currentKey);

    if (current.gx === goal.gx && current.gy === goal.gy)
      return reconstructPath(cameFrom, current);

    const currentG = gScore.get(currentKey);
    for (const { dx, dy } of DIRECTIONS) {
      const neighbor = { gx: current.gx + dx, gy: current.gy + dy };
      if (!inBounds(neighbor, bounds)) continue;

      const diagonal = dx !== 0 && dy !== 0;
      if (diagonal) {
        const blockedNearSource =
          footprintBlocked(current, dx, 0, isBlocked, footprint) ||
          footprintBlocked(current, 0, dy, isBlocked, footprint);
        const flankA = { gx: current.gx + dx, gy: current.gy };
        const flankB = { gx: current.gx, gy: current.gy + dy };
        const blockedNearTarget =
          footprintBlocked(flankA, 0, dy, isBlocked, footprint) ||
          footprintBlocked(flankB, dx, 0, isBlocked, footprint);
        if (blockedNearSource || blockedNearTarget) continue;
      }
      if (footprintBlocked(current, dx, dy, isBlocked, footprint)) continue;

      const tentativeG = currentG + 1;
      const neighborKey = key(neighbor);
      if (tentativeG < (gScore.get(neighborKey) ?? Infinity)) {
        cameFrom.set(neighborKey, current);
        gScore.set(neighborKey, tentativeG);
        open.set(neighborKey, {
          cell: neighbor,
          f: tentativeG + chebyshev(neighbor, goal),
        });
      }
    }
  }
  return null;
}
```

Note the diagonal flanking checks are rewritten in terms of `dx`/`dy`
deltas (`footprintBlocked(current, dx, 0, ...)` etc.) rather than the
original's precomputed `flankA`/`flankB` cell objects passed straight to
`isBlocked`, since `footprintBlocked` needs the delta to decompose across
the mover's own footprint — `footprintBlocked(current, dx, 0, isBlocked,
footprint)` is exactly equivalent to the old `isBlocked(current, flankA)`
when `footprint` is `{gw:1,gh:1}` (single cell, so the loop body runs once
with `a = current`, `b = {gx: current.gx+dx, gy: current.gy}` — the same
`flankA`).

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/pathfinding.test.mjs`
Expected: PASS — all pre-existing tests plus the 3 new ones (18 total in
this file's `findPath` + `blockedEdgesFromWalls` + `hasLineOfSight`
describes combined; confirm exact count from the run's own summary).

- [ ] **Step 5: Commit**

```bash
git add scripts/pathfinding.mjs tests/pathfinding.test.mjs
git commit -m "$(cat <<'EOF'
feat(pathfinding): findPath accepts a mover footprint (#140)

findPath gains an optional footprint {gw,gh} parameter (default
{gw:1,gh:1}), decomposing every candidate step — including the diagonal
corner-cutting flank checks — across the mover's own gw×gh cells via a
new footprintBlocked helper. A 1x1 footprint is provably a no-op:
byte-identical to today's single-cell behavior for every caller that
doesn't opt in.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: `dungeon-combat.mjs` — footprint-aware occupancy and movement

**Files:**
- Modify: `scripts/dungeon-combat.mjs` (`cellOccupied` line 1961,
  `movementBlockedEdges` line 1891, `posturePath` line 1982, `walkPath`
  line 2025, `stepToward` line 2059, `pushTokenAway` line 2110,
  `strideByPosture` line 3205)
- Test: `tests/dungeon-combat-grid-snap.test.mjs` (extend — same file
  already exercises `stepToward`/`strideByPosture`/`pushTokenAway` with
  the same mock-combat helpers this task needs)

**Interfaces:**
- Consumes: `findPath(start, goal, isBlocked, bounds, maxExpansions, footprint)`
  from Task 1. `footprint(token, grid)` / `overlaps(a, b)`, already
  imported at `scripts/dungeon-combat.mjs:42`.
- Produces: `cellOccupied(cell, footprints, moverFootprint = {gw:1,gh:1})`,
  `movementBlockedEdges(combat, combatant, excludeCell, moverFootprint)`,
  `posturePath(start, targetCell, posture, speedSquares, isBlocked, bounds, moverFootprint)`,
  `walkPath(path, targetCell, speedSquares, stopWithinSquares, occupantFootprints, moverFootprint)`
  — every later task (Task 5) calls `stepToward`/`strideByPosture`/`pushTokenAway`
  unchanged in their own public signatures; only their internals change.

- [ ] **Step 1: Write the failing tests**

Add to `tests/dungeon-combat-grid-snap.test.mjs`. First, extend
`makeToken`/`makeCombatant` to accept a real size (default stays 1×1, so
every existing test is unaffected):

```js
function makeToken({ x, y, disposition = -1, width = 1, height = 1 } = {}) {
  const token = { x, y, disposition, width, height };
  token.update = vi.fn(async function (changes) {
    Object.assign(this, changes);
  });
  return token;
}

function makeCombatant({
  id,
  x,
  y,
  disposition = -1,
  speedFt = 30,
  width = 1,
  height = 1,
} = {}) {
  return {
    id,
    isDefeated: false,
    token: makeToken({ x, y, disposition, width, height }),
    actor: { system: { movement: { speeds: { land: { value: speedFt } } } } },
  };
}
```

Then add a new `describe` block at the end of the file (before the final
closing of the file):

```js
describe("footprint-aware movement (#140)", () => {
  it("a 2x2 mover refuses to end up straddling a 1-wide gap it doesn't fit through", async () => {
    installFoundryStubs();
    globalThis.CONST = {
      WALL_MOVEMENT_TYPES: { NONE: 0, NORMAL: 20 },
      WALL_DOOR_TYPES: { NONE: 0, DOOR: 1, SECRET: 2 },
      WALL_DOOR_STATES: { CLOSED: 0, OPEN: 1, LOCKED: 2 },
    };
    // Two rooms connected by a single 1-square-wide gap at gx=3 between
    // gy=1 and gy=2 -- walled everywhere else along that boundary row.
    // The boundary is one row below the mover's own starting footprint
    // (gy=0..1), not the boundary its start straddles (#140, found during
    // Task 2's own implementation): a 2x2 mover's start position already
    // occupies both gy=0 and gy=1, so testing a wall at the gy=0/gy=1
    // boundary would make Task 1's start-footprint validation reject the
    // mover outright before any movement happens at all, passing this
    // test for the wrong reason (never moving) and failing the paired
    // "wide enough" test below identically regardless of gap width. Using
    // the next boundary down means the mover legitimately starts valid
    // and must actually attempt a real transition to hit the gap.
    const wallSegments = [];
    for (let gx = 0; gx <= 6; gx += 1) {
      if (gx === 3) continue; // the one gap
      wallSegments.push({
        move: 20,
        door: 0,
        c: [gx * GRID_SIZE, 2 * GRID_SIZE, (gx + 1) * GRID_SIZE, 2 * GRID_SIZE],
      });
    }
    const mover = makeCombatant({
      id: "mover",
      x: 0,
      y: 0,
      width: 2,
      height: 2,
      speedFt: 100,
    });
    const target = makeCombatant({
      id: "target",
      x: 3 * GRID_SIZE,
      y: 4 * GRID_SIZE,
    });
    const combat = makeCombat({ combatants: [mover, target] });
    combat.scene.walls.contents = wallSegments;
    // makeCombat()'s scene has no width/height, so sceneBounds() (called
    // inside stepToward) returns null -- an unbounded search -- by
    // default. Bounded here to exactly the wall list's own span (gx 0..6)
    // so findPath can't flank around the open west/east edges where the
    // wall list simply has no data (found during Task 2's own
    // implementation: an unbounded 2x2 mover walked around through
    // gx=-1/-2, where nothing blocks it, re-entering the corridor past
    // the gap from outside the tested columns entirely).
    combat.scene.width = 7 * GRID_SIZE;
    combat.scene.height = 6 * GRID_SIZE;

    await stepToward(combat, mover, target, 10);

    // Never crossed into gy >= 2 -- confirms the mover was refused the
    // gap rather than squeezing a corner of its own footprint through it.
    expect(mover.token.y).toBeLessThan(2 * GRID_SIZE);
  });

  it("a 2x2 mover successfully crosses a 2-wide gap sized to fit it", async () => {
    installFoundryStubs();
    globalThis.CONST = {
      WALL_MOVEMENT_TYPES: { NONE: 0, NORMAL: 20 },
      WALL_DOOR_TYPES: { NONE: 0, DOOR: 1, SECRET: 2 },
      WALL_DOOR_STATES: { CLOSED: 0, OPEN: 1, LOCKED: 2 },
    };
    // Same gy=1/gy=2 boundary as the paired "refuses" test above, for the
    // same reason (the mover's own gy=0..1 starting footprint must not
    // already straddle the tested boundary).
    const wallSegments = [];
    for (let gx = 0; gx <= 6; gx += 1) {
      if (gx === 3 || gx === 4) continue; // a 2-wide gap
      wallSegments.push({
        move: 20,
        door: 0,
        c: [gx * GRID_SIZE, 2 * GRID_SIZE, (gx + 1) * GRID_SIZE, 2 * GRID_SIZE],
      });
    }
    const mover = makeCombatant({
      id: "mover",
      x: 0,
      y: 0,
      width: 2,
      height: 2,
      speedFt: 100,
    });
    const target = makeCombatant({
      id: "target",
      x: 3 * GRID_SIZE,
      y: 4 * GRID_SIZE,
    });
    const combat = makeCombat({ combatants: [mover, target] });
    combat.scene.walls.contents = wallSegments;
    // Same bounding as the paired "refuses" test above, same reason.
    combat.scene.width = 7 * GRID_SIZE;
    combat.scene.height = 6 * GRID_SIZE;

    await stepToward(combat, mover, target, 10);

    expect(mover.token.y).toBeGreaterThanOrEqual(2 * GRID_SIZE);
  });

  it("walkPath's landing check refuses a cell where the mover's own footprint would overlap another combatant", async () => {
    installFoundryStubs();
    globalThis.CONST = {
      WALL_MOVEMENT_TYPES: { NONE: 0, NORMAL: 20 },
      WALL_DOOR_TYPES: { NONE: 0, DOOR: 1, SECRET: 2 },
      WALL_DOOR_STATES: { CLOSED: 0, OPEN: 1, LOCKED: 2 },
    };
    // A 2x2 mover approaching a 1x1 blocker that sits one square past the
    // mover's own reach: the mover's footprint would overlap the blocker's
    // square if it advanced its full speed, so it must stop one square
    // short instead of straddling the blocker.
    const mover = makeCombatant({
      id: "mover",
      x: 0,
      y: 0,
      width: 2,
      height: 2,
      speedFt: 20,
    });
    const blocker = makeCombatant({ id: "blocker", x: 2 * GRID_SIZE, y: 0 });
    const target = makeCombatant({
      id: "target",
      x: 6 * GRID_SIZE,
      y: 0,
    });
    const combat = makeCombat({ combatants: [mover, blocker, target] });

    await stepToward(combat, mover, target, 10);

    // The mover's own 2x2 footprint from its landing cell must not overlap
    // the blocker's (2,0) square.
    const landedGx = Math.round(mover.token.x / GRID_SIZE);
    const overlapsBlocker = landedGx <= 2 && landedGx + 2 > 2;
    expect(overlapsBlocker).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/dungeon-combat-grid-snap.test.mjs`
Expected: the three new tests FAIL (today's `cellOccupied` hardcodes
`gw:1,gh:1` for the tested cell and `findPath`/`walkPath` never receive a
footprint, so a 2×2 mover is treated as 1×1 throughout — it will cross the
1-wide gap in the first new test, failing the `toBeLessThan` assertion).

- [ ] **Step 3: Thread footprint through `dungeon-combat.mjs`'s occupancy and movement functions**

Replace `cellOccupied` (`scripts/dungeon-combat.mjs:1958-1965`):

```js
/** Whether the mover's own `moverFootprint.gw × moverFootprint.gh` block,
 * anchored top-left at `cell`, overlaps any footprint in `footprints` — the
 * shared occupancy check `movementBlockedEdges` and `walkPath` both need.
 * `moverFootprint` defaults to a single square (#140: every pre-existing
 * caller that doesn't pass one keeps today's exact 1x1 behavior). */
function cellOccupied(cell, footprints, moverFootprint = { gw: 1, gh: 1 }) {
  return footprints.some((f) =>
    overlaps(
      { gx: cell.gx, gy: cell.gy, gw: moverFootprint.gw, gh: moverFootprint.gh },
      f,
    ),
  );
}
```

Replace `movementBlockedEdges` (`scripts/dungeon-combat.mjs:1885-1896`,
keep its docblock, change only the signature/body):

```js
function movementBlockedEdges(
  combat,
  combatant,
  excludeCell = null,
  moverFootprint = { gw: 1, gh: 1 },
) {
  const gridSize = combat.scene?.grid?.size ?? 100;
  const wallBlocked = sceneWallBlockedEdges(combat);
  const hostiles = hostileFootprints(combat, combatant, gridSize, excludeCell);
  return (a, b) => wallBlocked(a, b) || cellOccupied(b, hostiles, moverFootprint);
}
```

Replace `posturePath` (`scripts/dungeon-combat.mjs:1982-2006`, keep its
docblock, add the `moverFootprint` parameter and thread it to both
`findPath` calls):

```js
function posturePath(
  start,
  targetCell,
  posture,
  speedSquares,
  isBlocked,
  bounds,
  moverFootprint = { gw: 1, gh: 1 },
) {
  if (posture !== "retreat" && posture !== "reposition")
    return findPath(start, targetCell, isBlocked, bounds, 20000, moverFootprint);

  const dx = Math.sign(start.gx - targetCell.gx) || 1;
  const dy = Math.sign(start.gy - targetCell.gy) || 1;
  for (let dist = Math.max(1, speedSquares); dist >= 1; dist -= 1) {
    let gx = start.gx + dx * dist;
    let gy = start.gy + dy * dist;
    if (bounds) {
      gx = Math.min(Math.max(gx, bounds.gx0), bounds.gx1);
      gy = Math.min(Math.max(gy, bounds.gy0), bounds.gy1);
    }
    const path = findPath(
      start,
      { gx, gy },
      isBlocked,
      bounds,
      20000,
      moverFootprint,
    );
    if (path && path.length > 1) return path;
  }
  return null;
}
```

Replace `walkPath` (`scripts/dungeon-combat.mjs:2008-2050`, keep its
docblock, add the `moverFootprint` parameter):

```js
function walkPath(
  path,
  targetCell,
  speedSquares,
  stopWithinSquares,
  occupantFootprints = [],
  moverFootprint = { gw: 1, gh: 1 },
) {
  let stepIndex = 0;
  for (let i = 1; i < path.length && i <= speedSquares; i += 1) {
    if (stopWithinSquares > 0) {
      const remaining = Math.max(
        Math.abs(path[i].gx - targetCell.gx),
        Math.abs(path[i].gy - targetCell.gy),
      );
      if (remaining < stopWithinSquares) break;
    }
    if (!cellOccupied(path[i], occupantFootprints, moverFootprint)) {
      stepIndex = i;
    }
  }
  return stepIndex > 0 ? path[stepIndex] : null;
}
```

Update `stepToward` (`scripts/dungeon-combat.mjs:2059-2092`) to compute
and thread its own token's real footprint — insert the `moverFootprint`
line after `gridSize` is known, and pass it to the three call sites:

```js
export async function stepToward(combat, combatant, target, distanceSquares) {
  const gridSize = combat.scene?.grid?.size ?? 100;
  await snapTokenToGrid(combatant.token, gridSize);
  if (distanceSquares <= MELEE_REACH_SQUARES) return;
  const gridDistanceFt = combat.scene?.grid?.distance ?? 5;
  const speedFt = combatant.actor?.system?.movement?.speeds?.land?.value ?? 0;
  const speedSquares = Math.floor(speedFt / gridDistanceFt);
  if (speedSquares <= 0) return;

  const me = combatant.token;
  const dest = target.token;
  const moverFootprint = footprint(me, gridSize);
  const start = tokenCell(me, gridSize);
  const goal = tokenCell(dest, gridSize);
  const bounds = sceneBounds(combat, gridSize);
  const isBlocked = movementBlockedEdges(combat, combatant, goal, moverFootprint);
  const path = findPath(start, goal, isBlocked, bounds, 20000, moverFootprint);
  if (!path) return;

  const occupants = otherCombatantFootprints(combat, combatant, gridSize);
  const waypoint = walkPath(
    path,
    goal,
    speedSquares,
    MELEE_REACH_SQUARES,
    occupants,
    moverFootprint,
  );
  if (!waypoint) return;
  await me.update({ x: waypoint.gx * gridSize, y: waypoint.gy * gridSize });
  await offerReactiveStrikesAgainst(combat, combatant);
}
```

Update `pushTokenAway` (`scripts/dungeon-combat.mjs:2110-2134`) the same
way — the pushed token (`target`) is the mover here:

```js
export async function pushTokenAway(combat, attacker, target, distanceSquares) {
  const gridSize = combat.scene?.grid?.size ?? 100;
  await snapTokenToGrid(target.token, gridSize);
  const moverFootprint = footprint(target.token, gridSize);
  const start = tokenCell(target.token, gridSize);
  const awayFrom = tokenCell(attacker.token, gridSize);
  const bounds = sceneBounds(combat, gridSize);
  const isBlocked = movementBlockedEdges(
    combat,
    target,
    null,
    moverFootprint,
  );
  const path = posturePath(
    start,
    awayFrom,
    "retreat",
    distanceSquares,
    isBlocked,
    bounds,
    moverFootprint,
  );
  if (!path) return;

  const occupants = otherCombatantFootprints(combat, target, gridSize);
  const waypoint = walkPath(
    path,
    awayFrom,
    distanceSquares,
    0,
    occupants,
    moverFootprint,
  );
  if (!waypoint) return;
  await target.token.update({
    x: waypoint.gx * gridSize,
    y: waypoint.gy * gridSize,
  });
}
```

Update `strideByPosture` (`scripts/dungeon-combat.mjs:3205-3245`):

```js
export async function strideByPosture(combat, combatant, posture, target) {
  const gridSize = combat.scene?.grid?.size ?? 100;
  await snapTokenToGrid(combatant.token, gridSize);
  const gridDistanceFt = combat.scene?.grid?.distance ?? 5;
  const speedFt = combatant.actor?.system?.movement?.speeds?.land?.value ?? 0;
  const speedSquares = Math.floor(speedFt / gridDistanceFt);
  if (speedSquares <= 0 || !target) return;

  const me = combatant.token;
  const dest = target.token;
  const moverFootprint = footprint(me, gridSize);
  const start = tokenCell(me, gridSize);
  const targetCell = tokenCell(dest, gridSize);
  const bounds = sceneBounds(combat, gridSize);
  const isBlocked = movementBlockedEdges(
    combat,
    combatant,
    posture === "approach" ? targetCell : null,
    moverFootprint,
  );
  const path = posturePath(
    start,
    targetCell,
    posture,
    speedSquares,
    isBlocked,
    bounds,
    moverFootprint,
  );
  if (!path) return;

  const occupants = otherCombatantFootprints(combat, combatant, gridSize);
  const stopWithin = posture === "approach" ? MELEE_REACH_SQUARES : 0;
  const waypoint = walkPath(
    path,
    targetCell,
    speedSquares,
    stopWithin,
    occupants,
    moverFootprint,
  );
  if (!waypoint) return;
  await me.update({ x: waypoint.gx * gridSize, y: waypoint.gy * gridSize });
  await offerReactiveStrikesAgainst(combat, combatant);
}
```

`footprint` is already imported at `scripts/dungeon-combat.mjs:42`
(`import { footprint, overlaps } from "./placement.mjs";`) — no import
change needed.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/dungeon-combat-grid-snap.test.mjs`
Expected: PASS — all pre-existing tests (#86 snapping behavior) plus the 3
new footprint tests.

Then run the full suite to confirm nothing else regressed:

Run: `npx vitest run`
Expected: PASS across every test file (a token in other test files that
sets `width`/`height` explicitly is unaffected since those tests don't
touch this code path; every other test's tokens default to `width: 1,
height: 1` via the constructor default this task didn't change for tests
outside `dungeon-combat-grid-snap.test.mjs`).

- [ ] **Step 5: Commit**

```bash
git add scripts/dungeon-combat.mjs tests/dungeon-combat-grid-snap.test.mjs
git commit -m "$(cat <<'EOF'
feat(combat): thread real mover footprint through movement (#140)

cellOccupied, movementBlockedEdges, posturePath and walkPath all accept
a moverFootprint {gw,gh} (default {gw:1,gh:1}, a no-op for the default).
stepToward, pushTokenAway and strideByPosture compute their own mover's
real footprint via placement.mjs's footprint() and thread it through,
closing the gap where a Large+ creature's own movement was never
validated against its own size.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: `dungeon-follow-mechanics.mjs` — footprint-aware occupancy

**Files:**
- Modify: `scripts/dungeon-follow-mechanics.mjs` (`freeAdjacentCells` line
  49, `findFollowMove` line 82)
- Test: `tests/dungeon-follow-mechanics.test.mjs` (rewrite the
  `occupiedCells`-as-`Set<string>` call sites — see Interfaces)

**Interfaces:**
- Consumes: `findPath(..., footprint)` from Task 1. `overlaps(a, b)` —
  needs a new import from `./placement.mjs` (this module currently imports
  nothing from `placement.mjs`).
- Produces (BREAKING for this module's own callers — both handled in this
  task and Task 4): `findFollowMove(fromCell, leaderCell, occupiedFootprints, isBlocked, bounds, footprint = {gw:1,gh:1})`
  — `occupiedFootprints` is now an array of `{gx,gy,gw,gh}` objects, not a
  `Set<"gx,gy">`. This is a deliberate breaking signature change (not a new
  optional parameter) because the whole point is that occupancy needs real
  size data a bare cell-key Set cannot carry — `dungeon-follow.mjs` is this
  module's only real caller (per its own docblock) and is updated in Task 4
  to match.

- [ ] **Step 1: Write the failing tests**

Replace `tests/dungeon-follow-mechanics.test.mjs`'s `describe("findFollowMove", ...)`
block entirely (every existing test's third argument changes shape from a
`Set` of strings to an array of footprint objects — same scenarios,
updated representation) — replace lines 12-110 with:

```js
describe("findFollowMove", () => {
  it("returns already-near when within one tile of the leader", () => {
    const result = findFollowMove(
      { gx: 5, gy: 5 },
      { gx: 5, gy: 6 },
      [],
      noWalls(),
      null,
    );
    expect(result).toEqual({ status: "already-near" });
  });

  it("paths to a free tile adjacent to the leader when far away", () => {
    const result = findFollowMove(
      { gx: 0, gy: 0 },
      { gx: 5, gy: 5 },
      [],
      noWalls(),
      null,
    );
    expect(result.status).toBe("move");
    expect(
      Math.max(Math.abs(result.to.gx - 5), Math.abs(result.to.gy - 5)),
    ).toBe(1);
  });

  it("avoids an already-occupied adjacent cell", () => {
    const occupied = [
      { gx: 4, gy: 5, gw: 1, gh: 1 },
      { gx: 4, gy: 4, gw: 1, gh: 1 },
      { gx: 5, gy: 4, gw: 1, gh: 1 },
      { gx: 6, gy: 4, gw: 1, gh: 1 },
      { gx: 6, gy: 5, gw: 1, gh: 1 },
      { gx: 6, gy: 6, gw: 1, gh: 1 },
      { gx: 5, gy: 6, gw: 1, gh: 1 },
    ];
    const result = findFollowMove(
      { gx: 0, gy: 0 },
      { gx: 5, gy: 5 },
      occupied,
      noWalls(),
      null,
    );
    expect(result).toEqual({ status: "move", to: { gx: 4, gy: 6 } });
  });

  it("returns no-route when every adjacent cell is occupied", () => {
    const occupied = [
      { gx: 4, gy: 4, gw: 1, gh: 1 },
      { gx: 4, gy: 5, gw: 1, gh: 1 },
      { gx: 4, gy: 6, gw: 1, gh: 1 },
      { gx: 5, gy: 4, gw: 1, gh: 1 },
      { gx: 5, gy: 6, gw: 1, gh: 1 },
      { gx: 6, gy: 4, gw: 1, gh: 1 },
      { gx: 6, gy: 5, gw: 1, gh: 1 },
      { gx: 6, gy: 6, gw: 1, gh: 1 },
    ];
    const result = findFollowMove(
      { gx: 0, gy: 0 },
      { gx: 5, gy: 5 },
      occupied,
      noWalls(),
      null,
    );
    expect(result).toEqual({ status: "no-route" });
  });

  it("returns no-route when every path is wall-blocked", () => {
    const result = findFollowMove(
      { gx: 0, gy: 0 },
      { gx: 5, gy: 5 },
      [],
      () => true,
      null,
    );
    expect(result).toEqual({ status: "no-route" });
  });

  it("falls back to another free adjacent cell when the single closest one is a walled-off dead pocket (#87)", () => {
    const bounds = { gx0: 0, gy0: 0, gx1: 10, gy1: 10 };
    const isBlocked = (a, b) =>
      (a.gx === 4 && a.gy === 4) || (b.gx === 4 && b.gy === 4);

    const result = findFollowMove(
      { gx: 0, gy: 0 },
      { gx: 5, gy: 5 },
      [],
      isBlocked,
      bounds,
    );

    expect(result.status).toBe("move");
    expect(result.to).not.toEqual({ gx: 4, gy: 4 });
    expect(
      Math.max(Math.abs(result.to.gx - 5), Math.abs(result.to.gy - 5)),
    ).toBe(1);
  });

  // #140: a 2x2 follower must refuse a candidate adjacent cell its own
  // footprint wouldn't fit into cleanly (here, overlapping a 1x1 blocker
  // one square east of the otherwise-closest candidate).
  it("with a non-default footprint, refuses a candidate cell the mover's own footprint would overlap", () => {
    const occupied = [{ gx: 5, gy: 6, gw: 1, gh: 1 }]; // sits inside a 2x2 footprint anchored at (4,6) or (5,5) etc.
    const result = findFollowMove(
      { gx: 0, gy: 0 },
      { gx: 5, gy: 5 },
      occupied,
      noWalls(),
      null,
      { gw: 2, gh: 2 },
    );
    expect(result.status).toBe("move");
    // Every candidate whose own 2x2 block would overlap (5,6) must be
    // excluded -- confirm the chosen destination's own 2x2 footprint does
    // not cover (5,6).
    const overlapsBlocker =
      result.to.gx <= 5 &&
      result.to.gx + 2 > 5 &&
      result.to.gy <= 6 &&
      result.to.gy + 2 > 6;
    expect(overlapsBlocker).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/dungeon-follow-mechanics.test.mjs`
Expected: every test in this file FAILs or errors — `findFollowMove` still
expects a `Set` and calls `.has()` on it, which an array doesn't have
(`occupiedCells.has is not a function`).

- [ ] **Step 3: Convert `freeAdjacentCells`/`findFollowMove` to footprint-based occupancy**

Replace `scripts/dungeon-follow-mechanics.mjs`'s import line (line 10) and
add the `overlaps` import:

```js
import { findPath } from "./pathfinding.mjs";
import { overlaps } from "./placement.mjs";
```

Replace `freeAdjacentCells` (`scripts/dungeon-follow-mechanics.mjs:45-60`):

```js
/** Every free grid cell adjacent (incl. diagonally) to `leaderCell` where
 * the mover's own `footprint.gw × footprint.gh` block, anchored there,
 * doesn't overlap anything in `occupiedFootprints` — ordered closest-to-
 * `fromCell` first so multiple AI-controlled tokens spread out around the
 * leader instead of all aiming for the same cell. Empty if all 8 are
 * blocked. `footprint` defaults to a single square (#140: a no-op for
 * every pre-existing caller). */
function freeAdjacentCells(
  leaderCell,
  fromCell,
  occupiedFootprints,
  footprint = { gw: 1, gh: 1 },
) {
  const candidates = [];
  for (let dx = -1; dx <= 1; dx += 1) {
    for (let dy = -1; dy <= 1; dy += 1) {
      if (dx === 0 && dy === 0) continue;
      const cell = { gx: leaderCell.gx + dx, gy: leaderCell.gy + dy };
      const candidateFootprint = {
        gx: cell.gx,
        gy: cell.gy,
        gw: footprint.gw,
        gh: footprint.gh,
      };
      const blocked = occupiedFootprints.some((f) =>
        overlaps(candidateFootprint, f),
      );
      if (!blocked) candidates.push(cell);
    }
  }
  candidates.sort((a, b) => chebyshev(a, fromCell) - chebyshev(b, fromCell));
  return candidates;
}
```

Replace `findFollowMove` (`scripts/dungeon-follow-mechanics.mjs:62-97`,
keep its docblock, update the parameter name/type and thread `footprint`
through):

```js
export function findFollowMove(
  fromCell,
  leaderCell,
  occupiedFootprints,
  isBlocked,
  bounds,
  footprint = { gw: 1, gh: 1 },
) {
  if (chebyshev(fromCell, leaderCell) <= 1) return { status: "already-near" };

  const candidates = freeAdjacentCells(
    leaderCell,
    fromCell,
    occupiedFootprints,
    footprint,
  );
  for (const target of candidates) {
    const path = findPath(fromCell, target, isBlocked, bounds, 20000, footprint);
    if (path && path.length > 1) return { status: "move", to: target };
  }
  return { status: "no-route" };
}
```

Update the module's own top-of-file docblock comment
(`scripts/dungeon-follow-mechanics.mjs:1-9`) — it currently says
"dungeon-combat.mjs is the only caller" in `pathfinding.mjs`'s own
docblock (a separate, pre-existing staleness, out of scope here) but this
file's own docblock is accurate and doesn't need editing.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/dungeon-follow-mechanics.test.mjs`
Expected: PASS — all 7 tests (6 rewritten + 1 new footprint test).

- [ ] **Step 5: Commit**

```bash
git add scripts/dungeon-follow-mechanics.mjs tests/dungeon-follow-mechanics.test.mjs
git commit -m "$(cat <<'EOF'
feat(follow): findFollowMove takes real footprints, not cell keys (#140)

occupiedCells changes from a Set<"gx,gy"> of single reference cells to
an array of real {gx,gy,gw,gh} footprints, checked via placement.mjs's
overlaps() instead of Set membership -- matching dungeon-combat.mjs's
existing occupancy pattern rather than a second, footprint-blind one.
findFollowMove/freeAdjacentCells also accept the mover's own footprint,
threaded to findPath. dungeon-follow.mjs (this module's only caller) is
updated in the next commit.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: `dungeon-follow.mjs` — build real footprints, not cell keys

**Files:**
- Modify: `scripts/dungeon-follow.mjs` (`moveFollowersToward` lines 74-125,
  import block lines 14-22)
- Test: `tests/dungeon-follow.test.mjs`

**Interfaces:**
- Consumes: `findFollowMove(fromCell, leaderCell, occupiedFootprints, isBlocked, bounds, footprint)`
  from Task 3. `footprint(token, grid)` from `./placement.mjs` (new
  import — this file currently imports nothing from `placement.mjs`).
  `cellKey` remains imported from `./dungeon-follow-mechanics.mjs` (still
  used, just no longer for the occupancy Set itself — see below).
- Produces: no change to this module's own exports
  (`runFollowMoveNow`/`followLeaderIfDue`/`followLeaderOnDoorOpened`
  unchanged) — purely an internal rewrite of `moveFollowersToward`.

- [ ] **Step 1: Extend `makeToken` to accept a real size**

`tests/dungeon-follow.test.mjs`'s `makeToken` (lines 57-61) doesn't set
`width`/`height` at all today. Replace it:

```js
function makeToken({ id, x, y, actorId, width = 1, height = 1 }) {
  const token = { id, x, y, actor: { id: actorId }, width, height };
  token.update = vi.fn(async (changes) => Object.assign(token, changes));
  return token;
}
```

Every existing call site omits `width`/`height` and keeps defaulting to
`1, 1` — no other test in this file changes behavior.

- [ ] **Step 2: Write the failing test**

Add a new `describe` block at the end of `tests/dungeon-follow.test.mjs`,
inside the `runFollowMoveNow` describe or as its own top-level block
(match the file's existing top-level `describe("runFollowMoveNow (#65)", ...)`
pattern — add this as a new sibling top-level block after it):

```js
describe("moveFollowersToward footprint-awareness (#140)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  // A 2x2 follower's own footprint, anchored at (4,0) or (4,1) — the two
  // candidate cells among the leader's 8 adjacent cells that are closest
  // to a follower starting at (0,0) — would each overlap the leader's own
  // (5,1) square (a 1x1 footprint anchored at the same cells would not).
  // Only (4,2), one step farther, is genuinely free for a mover that size.
  it("a 2x2 follower avoids landing on a cell whose own footprint would overlap the leader's square", async () => {
    vi.useFakeTimers();
    const leader = makeToken({
      id: "t-leader",
      x: 5 * GRID,
      y: 1 * GRID,
      actorId: LEADER_ACTOR_ID,
    });
    const follower = makeToken({
      id: "t-follower",
      x: 0,
      y: 0,
      actorId: FOLLOWER_ACTOR_ID,
      width: 2,
      height: 2,
    });
    const scene = makeScene({ tokens: [leader, follower] });

    installFoundryStubs({
      dungeonRuns: {
        [SCENE_ID]: {
          hostUserId: HOST_USER_ID,
          aiControlledActorIds: [FOLLOWER_ACTOR_ID],
        },
      },
    });
    game.scenes = { get: (id) => (id === SCENE_ID ? scene : undefined) };

    runFollowMoveNow(SCENE_ID);
    await vi.advanceTimersByTimeAsync(300);

    expect(follower.update).toHaveBeenCalledTimes(1);
    const [{ x, y }] = follower.update.mock.calls[0];
    const gx = x / GRID;
    const gy = y / GRID;
    const overlapsLeader = gx <= 5 && gx + 2 > 5 && gy <= 1 && gy + 2 > 1;
    expect(overlapsLeader).toBe(false);
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run tests/dungeon-follow.test.mjs`
Expected: FAILs (today's `moveFollowersToward` builds `occupied` from
single reference cells regardless of any token's real size, so a 2×2
follower isn't excluded from a cell a 1×1 check would have allowed).

- [ ] **Step 4: Rewrite `moveFollowersToward`'s occupancy to real footprints**

Update the import block (`scripts/dungeon-follow.mjs:14-22`):

```js
import { getRunState } from "./dungeon-runner.mjs";
import { requestDungeonAction } from "./dungeon-remote.mjs";
import { blockedEdgesFromWalls } from "./pathfinding.mjs";
import { footprint, overlaps } from "./placement.mjs";
import {
  findFollowMove,
  tokenCell,
  sceneBounds,
} from "./dungeon-follow-mechanics.mjs";
```

(`cellKey` is dropped from this import — it's no longer used once
`occupied` stops being a `Set` of cell-key strings; confirm with `grep -n
cellKey scripts/dungeon-follow.mjs` after this edit that no other
reference remains before removing the import, since `sceneBounds` and
`tokenCell` are still needed unchanged.)

Replace `moveFollowersToward` (`scripts/dungeon-follow.mjs:74-125`):

```js
async function moveFollowersToward(scene, leaderToken, aiControlledIds) {
  if (hasActiveCombat(scene)) return;
  if (inFlightScenes.has(scene.id)) return;
  inFlightScenes.add(scene.id);
  try {
    const gridSize = scene.grid?.size ?? 100;
    const bounds = sceneBounds(scene, gridSize);
    const isBlocked = movementBlockedEdges(scene, gridSize);
    const leaderCell = tokenCell(leaderToken, gridSize);
    const occupied = scene.tokens.map((t) => footprint(t, gridSize));

    for (const actorId of aiControlledIds) {
      const token = scene.tokens.find((t) => t.actor?.id === actorId);
      if (!token) continue;
      // #86: correct a follower's own off-grid position (e.g. from a
      // manual, unsnapped drag in Foundry's own UI) before
      // findFollowMove's "already-near" status can skip straight past it
      // without ever calling `update()` at all -- mirrors
      // dungeon-combat.mjs's own `snapTokenToGrid`.
      const snappedX = Math.round(token.x / gridSize) * gridSize;
      const snappedY = Math.round(token.y / gridSize) * gridSize;
      if (token.x !== snappedX || token.y !== snappedY) {
        await token.update({ x: snappedX, y: snappedY });
      }
      const moverFootprint = footprint(token, gridSize);
      const fromCell = tokenCell(token, gridSize);
      const result = findFollowMove(
        fromCell,
        leaderCell,
        occupied,
        isBlocked,
        bounds,
        moverFootprint,
      );
      if (result.status === "already-near") continue;
      if (result.status === "no-route") {
        console.warn(
          `${MODULE_ID} | dungeon-follow: no route for actor ${actorId} to reach the leader.`,
        );
        continue;
      }
      const myIndex = occupied.findIndex(
        (f) =>
          f.gx === fromCell.gx &&
          f.gy === fromCell.gy &&
          f.gw === moverFootprint.gw &&
          f.gh === moverFootprint.gh,
      );
      if (myIndex !== -1) occupied.splice(myIndex, 1);
      occupied.push({
        gx: result.to.gx,
        gy: result.to.gy,
        gw: moverFootprint.gw,
        gh: moverFootprint.gh,
      });
      await token.update({
        x: result.to.gx * gridSize,
        y: result.to.gy * gridSize,
      });
    }
  } finally {
    inFlightScenes.delete(scene.id);
  }
}
```

(`overlaps` is imported for parity with `dungeon-combat.mjs`'s pattern
but not directly called in this function — it's `findFollowMove`'s own
internal, in Task 3 — so remove it from this file's import list if lint
flags an unused import; `footprint` is the one this file actually calls.)

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run tests/dungeon-follow.test.mjs`
Expected: PASS — all pre-existing tests plus the new footprint test.

Then run the full suite:

Run: `npx vitest run`
Expected: PASS across every file.

- [ ] **Step 6: Commit**

```bash
git add scripts/dungeon-follow.mjs tests/dungeon-follow.test.mjs
git commit -m "$(cat <<'EOF'
feat(follow): build real footprints for occupancy, not cell keys (#140)

occupied changes from a Set of every token's single reference cell to
an array of real {gx,gy,gw,gh} footprints via placement.mjs's
footprint(), matching findFollowMove's new signature (previous commit)
and dungeon-combat.mjs's existing occupancy pattern.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: explicit stuck-vs-no-route signal on the combat side

**Files:**
- Modify: `scripts/dungeon-combat.mjs` (`stepToward` line 2059,
  `strideByPosture` line 3205, `applyAgentDecision` line 4360,
  `playHeuristicTurn` line 2481)
- Modify: `lang/en.json` (new i18n key)
- Test: `tests/dungeon-combat-grid-snap.test.mjs` (extend)
- Test: create `tests/dungeon-combat-agent-move-stalled.test.mjs` — no
  existing test file calls `applyAgentDecision` at all (confirmed:
  `grep -rl applyAgentDecision tests/*.mjs` returns nothing); the closest
  precedent is `tests/dungeon-combat-agent-turn-line-of-sight.test.mjs`,
  which drives real `getPendingAgentTurn` end-to-end with plain-object
  `combat`/`combatant` mocks and no spellcasting — this task's new file
  follows that same pattern, adding only what a stride candidate needs.

**Interfaces:**
- Consumes: nothing new.
- Produces: `stepToward`/`strideByPosture` now return one of
  `"moved"`, `"already-there"`, `"no-speed"`, `"no-route"`, `"blocked"`
  (previously both returned `undefined`/`void`). `pushTokenAway` is
  **not** changed here — it has no chat-announcement caller to react to a
  status, and the design doc's (c) scope is specifically the AI turn
  loop's own "chose: Move toward X" visibility, which only ever wraps
  `strideByPosture` (via `applyAgentDecision`) and `stepToward` (via
  `playHeuristicTurn`'s non-agent path).

- [ ] **Step 1: Write the failing tests**

In `tests/dungeon-combat-grid-snap.test.mjs`, add to the
`describe("footprint-aware movement (#140)", ...)` block from Task 2:

```js
  it("stepToward returns 'no-route' when the target is fully walled off", async () => {
    installFoundryStubs();
    globalThis.CONST = {
      WALL_MOVEMENT_TYPES: { NONE: 0, NORMAL: 20 },
      WALL_DOOR_TYPES: { NONE: 0, DOOR: 1, SECRET: 2 },
      WALL_DOOR_STATES: { CLOSED: 0, OPEN: 1, LOCKED: 2 },
    };
    const mover = makeCombatant({ id: "mover", x: 0, y: 0, speedFt: 100 });
    const target = makeCombatant({
      id: "target",
      x: 5 * GRID_SIZE,
      y: 0,
    });
    const combat = makeCombat({ combatants: [mover, target] });
    // Wall off the target's own square on all four sides.
    const gx = 5;
    combat.scene.walls.contents = [
      { move: 20, door: 0, c: [gx * GRID_SIZE, 0, (gx + 1) * GRID_SIZE, 0] },
      {
        move: 20,
        door: 0,
        c: [gx * GRID_SIZE, GRID_SIZE, (gx + 1) * GRID_SIZE, GRID_SIZE],
      },
      { move: 20, door: 0, c: [gx * GRID_SIZE, 0, gx * GRID_SIZE, GRID_SIZE] },
      {
        move: 20,
        door: 0,
        c: [(gx + 1) * GRID_SIZE, 0, (gx + 1) * GRID_SIZE, GRID_SIZE],
      },
    ];

    const status = await stepToward(combat, mover, target, 10);

    expect(status).toBe("no-route");
    expect(mover.token.update).not.toHaveBeenCalled();
  });

  it("stepToward returns 'blocked' when a route exists but every landing cell is occupied", async () => {
    installFoundryStubs();
    const mover = makeCombatant({ id: "mover", x: 0, y: 0, speedFt: 30 });
    const blocker = makeCombatant({ id: "blocker", x: GRID_SIZE, y: 0 });
    const target = makeCombatant({
      id: "target",
      x: 2 * GRID_SIZE,
      y: 0,
    });
    const combat = makeCombat({ combatants: [mover, blocker, target] });

    // Mover's speed only reaches the blocker's own square (distance 1),
    // which is occupied and the only cell within its speed budget -- no
    // valid landing cell, but a route genuinely exists.
    const status = await stepToward(combat, mover, target, 2);

    expect(status).toBe("blocked");
    expect(mover.token.update).not.toHaveBeenCalled();
  });

  it("stepToward returns 'moved' on a normal successful move", async () => {
    installFoundryStubs();
    const mover = makeCombatant({ id: "mover", x: 0, y: 0, speedFt: 30 });
    const target = makeCombatant({
      id: "target",
      x: 5 * GRID_SIZE,
      y: 0,
    });
    const combat = makeCombat({ combatants: [mover, target] });

    const status = await stepToward(combat, mover, target, 10);

    expect(status).toBe("moved");
    expect(mover.token.update).toHaveBeenCalled();
  });

  it("stepToward returns 'already-there' when already within melee reach", async () => {
    installFoundryStubs();
    const mover = makeCombatant({ id: "mover", x: 0, y: 0 });
    const target = makeCombatant({ id: "target", x: GRID_SIZE, y: 0 });
    const combat = makeCombat({ combatants: [mover, target] });

    const status = await stepToward(combat, mover, target, 1);

    expect(status).toBe("already-there");
  });

  it("stepToward returns 'no-speed' when the mover has no speed", async () => {
    installFoundryStubs();
    const mover = makeCombatant({
      id: "mover",
      x: 0,
      y: 0,
      speedFt: 0,
    });
    const target = makeCombatant({
      id: "target",
      x: 5 * GRID_SIZE,
      y: 0,
    });
    const combat = makeCombat({ combatants: [mover, target] });

    const status = await stepToward(combat, mover, target, 10);

    expect(status).toBe("no-speed");
  });
```

Create `tests/dungeon-combat-agent-move-stalled.test.mjs`:

```js
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  applyAgentDecision,
  getPendingAgentTurn,
} from "../scripts/dungeon-combat.mjs";

// #140: applyAgentDecision has no existing test coverage at all (confirmed
// via `grep -rl applyAgentDecision tests/*.mjs` before writing this file).
// This drives it end-to-end -- real getPendingAgentTurn candidate
// generation, real applyAgentDecision execution -- the same style
// dungeon-combat-agent-turn-line-of-sight.test.mjs already uses for
// getPendingAgentTurn alone, extended with movement speed and a blocker
// token so a "stride:approach" candidate resolves to strideByPosture's new
// "blocked" status.

const GRID_SIZE = 100;
const GRID_DISTANCE_FT = 5;
const MODULE_ID = "pf2e-dungeon-crawl";

function makeToken({ x, y, disposition }) {
  const token = { x, y, disposition };
  token.update = vi.fn(async function (changes) {
    Object.assign(this, changes);
  });
  return token;
}

function makeCombatant({ id, gx, gy, disposition, speedFt = 30 } = {}) {
  const flags = { agentControlled: true };
  return {
    id,
    name: id,
    isDefeated: false,
    token: makeToken({ x: gx * GRID_SIZE, y: gy * GRID_SIZE, disposition }),
    getFlag: (_moduleId, key) => flags[key],
    actor: {
      system: {
        actions: [],
        attributes: { hp: { value: 20, max: 20 } },
        movement: { speeds: { land: { value: speedFt } } },
      },
    },
  };
}

function makeCombat({ attacker, opponent, blocker }) {
  const flags = { dungeonSlot: "slot-1" };
  return {
    id: "combat-1",
    round: 1,
    turn: 0,
    combatant: attacker,
    combatants: [attacker, opponent, blocker],
    getFlag: (_moduleId, key) => flags[key],
    setFlag: async (_moduleId, key, value) => {
      flags[key] = value;
    },
    scene: {
      grid: { size: GRID_SIZE, distance: GRID_DISTANCE_FT },
      walls: { contents: [] },
      regions: [],
    },
  };
}

beforeEach(() => {
  globalThis.CONST = {
    WALL_MOVEMENT_TYPES: { NONE: 0, NORMAL: 20 },
    WALL_DOOR_TYPES: { NONE: 0, DOOR: 1, SECRET: 2 },
    WALL_DOOR_STATES: { CLOSED: 0, OPEN: 1, LOCKED: 2 },
  };
  globalThis.foundry = { utils: {} };
  globalThis.ChatMessage = {
    create: vi.fn(async () => {}),
    getWhisperRecipients: () => [{ id: "gm1" }],
  };
  globalThis.game = { i18n: { format: (key) => key } };
});

describe("applyAgentDecision move-stalled chat card (#140)", () => {
  it("whispers a follow-up 'stalled' chat card when a stride candidate resolves to blocked", async () => {
    // Attacker at (0,0), a blocker one square east (the only cell within
    // reach of the melee-stop clamp), and the actual target two squares
    // east -- a route exists, but the sole landing cell short of melee
    // range is occupied, matching the "blocked" scenario in
    // dungeon-combat-grid-snap.test.mjs's stepToward tests exactly, just
    // reached here through strideByPosture/applyAgentDecision instead.
    const attacker = makeCombatant({
      id: "atk",
      gx: 0,
      gy: 0,
      disposition: -1,
    });
    const blocker = makeCombatant({
      id: "blocker",
      gx: 1,
      gy: 0,
      disposition: -1, // ally -- still occupies a landing cell either way
    });
    const opponent = makeCombatant({
      id: "opp",
      gx: 2,
      gy: 0,
      disposition: 1,
    });
    const combat = makeCombat({ attacker, opponent, blocker });

    const turn = await getPendingAgentTurn(combat);
    const candidate = turn.candidates.find((c) => c.id === "stride:approach:opp");
    expect(candidate).toBeDefined();

    await applyAgentDecision(combat, "atk", candidate.id);

    // Two chat cards: postAgentDecisionChat's pre-move announcement, then
    // the stall follow-up.
    expect(ChatMessage.create).toHaveBeenCalledTimes(2);
    expect(ChatMessage.create.mock.calls[1][0].content).toContain(
      "PF2EDC.Dungeon.Combat.AgentMoveStalled",
    );
    expect(attacker.token.update).not.toHaveBeenCalled();
  });

  it("does not whisper a stall card on a normal successful stride", async () => {
    const attacker = makeCombatant({
      id: "atk",
      gx: 0,
      gy: 0,
      disposition: -1,
    });
    const opponent = makeCombatant({
      id: "opp",
      gx: 5,
      gy: 0,
      disposition: 1,
    });
    const combat = makeCombat({
      attacker,
      opponent,
      blocker: makeCombatant({ id: "far", gx: 20, gy: 20, disposition: -1 }),
    });

    const turn = await getPendingAgentTurn(combat);
    const candidate = turn.candidates.find((c) => c.id === "stride:approach:opp");
    expect(candidate).toBeDefined();

    await applyAgentDecision(combat, "atk", candidate.id);

    expect(ChatMessage.create).toHaveBeenCalledTimes(1);
    expect(attacker.token.update).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/dungeon-combat-grid-snap.test.mjs`
Expected: FAIL — `stepToward` currently returns `undefined` for every
branch (`expect(status).toBe("no-route")` etc. all fail).

Run: `npx vitest run tests/dungeon-combat-agent-move-stalled.test.mjs`
Expected: FAIL — `applyAgentDecision` never calls a second `ChatMessage.create`
today, so `toHaveBeenCalledTimes(2)` fails in the first test.

- [ ] **Step 3: Implement the status returns and the stall chat card**

Update `stepToward` (`scripts/dungeon-combat.mjs`, the version from Task
2) to return a status at every branch:

```js
export async function stepToward(combat, combatant, target, distanceSquares) {
  const gridSize = combat.scene?.grid?.size ?? 100;
  await snapTokenToGrid(combatant.token, gridSize);
  if (distanceSquares <= MELEE_REACH_SQUARES) return "already-there";
  const gridDistanceFt = combat.scene?.grid?.distance ?? 5;
  const speedFt = combatant.actor?.system?.movement?.speeds?.land?.value ?? 0;
  const speedSquares = Math.floor(speedFt / gridDistanceFt);
  if (speedSquares <= 0) return "no-speed";

  const me = combatant.token;
  const dest = target.token;
  const moverFootprint = footprint(me, gridSize);
  const start = tokenCell(me, gridSize);
  const goal = tokenCell(dest, gridSize);
  const bounds = sceneBounds(combat, gridSize);
  const isBlocked = movementBlockedEdges(combat, combatant, goal, moverFootprint);
  const path = findPath(start, goal, isBlocked, bounds, 20000, moverFootprint);
  if (!path) return "no-route";

  const occupants = otherCombatantFootprints(combat, combatant, gridSize);
  const waypoint = walkPath(
    path,
    goal,
    speedSquares,
    MELEE_REACH_SQUARES,
    occupants,
    moverFootprint,
  );
  if (!waypoint) return "blocked";
  await me.update({ x: waypoint.gx * gridSize, y: waypoint.gy * gridSize });
  await offerReactiveStrikesAgainst(combat, combatant);
  return "moved";
}
```

Update `strideByPosture` the same way (same file, Task 2's version):

```js
export async function strideByPosture(combat, combatant, posture, target) {
  const gridSize = combat.scene?.grid?.size ?? 100;
  await snapTokenToGrid(combatant.token, gridSize);
  const gridDistanceFt = combat.scene?.grid?.distance ?? 5;
  const speedFt = combatant.actor?.system?.movement?.speeds?.land?.value ?? 0;
  const speedSquares = Math.floor(speedFt / gridDistanceFt);
  if (speedSquares <= 0 || !target) return "no-speed";

  const me = combatant.token;
  const dest = target.token;
  const moverFootprint = footprint(me, gridSize);
  const start = tokenCell(me, gridSize);
  const targetCell = tokenCell(dest, gridSize);
  const bounds = sceneBounds(combat, gridSize);
  const isBlocked = movementBlockedEdges(
    combat,
    combatant,
    posture === "approach" ? targetCell : null,
    moverFootprint,
  );
  const path = posturePath(
    start,
    targetCell,
    posture,
    speedSquares,
    isBlocked,
    bounds,
    moverFootprint,
  );
  if (!path) return "no-route";

  const occupants = otherCombatantFootprints(combat, combatant, gridSize);
  const stopWithin = posture === "approach" ? MELEE_REACH_SQUARES : 0;
  const waypoint = walkPath(
    path,
    targetCell,
    speedSquares,
    stopWithin,
    occupants,
    moverFootprint,
  );
  if (!waypoint) return "blocked";
  await me.update({ x: waypoint.gx * gridSize, y: waypoint.gy * gridSize });
  await offerReactiveStrikesAgainst(combat, combatant);
  return "moved";
}
```

Update `playHeuristicTurn` (`scripts/dungeon-combat.mjs:2481-2494`) — the
return value isn't otherwise consumed by this caller, so only the call
itself needs to keep working (no behavior change needed here beyond
confirming the new return type doesn't break anything — no edit required
to this function's own body; leave it exactly as-is).

Add a new whisper helper and wire it into `applyAgentDecision`
(`scripts/dungeon-combat.mjs:4360-4419`) — insert right after the
existing `postAgentDecisionChat`, and change the `"stride"` branch:

```js
/** Whispers the GM a follow-up chat card when an agent-controlled
 * combatant's chosen stride resolved to "blocked" (#140) -- a route
 * exists but every landing cell within reach was occupied, distinct from
 * a normal silent move or a genuinely unreachable target ("no-route",
 * not flagged here since that's the ordinary "nothing to do" case the
 * pre-move announcement's own summary already covers). Purely a
 * visibility improvement; no retry or behavior change. */
async function postMoveStalledChat(combatant, status) {
  if (status !== "blocked") return;
  const esc = (s) => foundry.utils.escapeHTML?.(String(s)) ?? String(s);
  const content = game.i18n.format(
    "PF2EDC.Dungeon.Combat.AgentMoveStalled",
    { name: esc(combatant.name) },
  );
  const gmIds = ChatMessage.getWhisperRecipients("GM").map((u) => u.id);
  await ChatMessage.create({ content, whisper: gmIds });
}
```

Change `applyAgentDecision`'s `"stride"` branch
(`scripts/dungeon-combat.mjs:4373-4395`):

```js
  if (candidate.type === "stride") {
    let target = candidate.targetId
      ? combatantOpponents(combat, combatant).find(
          (c) => c.id === candidate.targetId,
        )
      : null;
    if (candidate.posture === "reposition") {
      const gridSize = combat.scene?.grid?.size ?? 100;
      const hazard = nearestHazardousRegionPoint(
        combat.scene,
        combatant.token,
        gridSize,
      );
      target = hazard ? { token: { x: hazard.x, y: hazard.y } } : null;
    }
    const status = await strideByPosture(combat, combatant, candidate.posture, target);
    await postMoveStalledChat(combatant, status);
  } else if (candidate.type === "strike") {
```

Add the new i18n key to `lang/en.json`, immediately after the existing
`"PF2EDC.Dungeon.Combat.AgentDecisionChat"` entry:

```json
  "PF2EDC.Dungeon.Combat.AgentMoveStalled": "<p><strong>{name}</strong>'s move is blocked — a route exists, but every reachable square is occupied.</p>",
```

(confirm the surrounding JSON stays valid — read the existing
`lang/en.json` structure around that key before editing to match its
exact indentation/comma placement, since `Write`-replacing the whole file
isn't necessary, an `Edit` insert is).

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/dungeon-combat-grid-snap.test.mjs`
Expected: PASS — all tests including the 5 new status-return tests.

Run: `npx vitest run tests/dungeon-combat-agent-move-stalled.test.mjs`
Expected: PASS — both tests, including the new stall chat card test.

Then the full suite:

Run: `npx vitest run`
Expected: PASS across every file.

- [ ] **Step 5: Commit**

```bash
git add scripts/dungeon-combat.mjs lang/en.json tests/dungeon-combat-grid-snap.test.mjs tests/dungeon-combat-agent-move-stalled.test.mjs
git commit -m "$(cat <<'EOF'
feat(combat): distinguish blocked vs no-route movement stalls (#140)

stepToward/strideByPosture return a status ("moved", "already-there",
"no-speed", "no-route", "blocked") instead of void. applyAgentDecision
whispers the GM a follow-up chat card only on "blocked" -- a route
exists but every reachable landing cell is occupied, distinct from a
genuinely unreachable target or a normal silent move. Pure
visibility/diagnosability improvement, no change to whether a stuck
combatant actually moves.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## After all tasks: whole-branch review and wrap-up

- Dispatch the final code reviewer against the full branch diff (base:
  `main` at `ca9a0c8`, head: this branch's tip) before merging, per
  subagent-driven-development's own process.
- Bump `module.json`'s `version` field once for the whole branch (patch:
  `0.37.2` → `0.37.3`) as part of the merge, per this repo's CLAUDE.md.
- Update issue #140: move its label from `planned` (set when this plan
  was linked) to `in progress` at the start of execution, and to `done`
  (closing the issue) once merged — per CLAUDE.md's issue-lifecycle rule.
