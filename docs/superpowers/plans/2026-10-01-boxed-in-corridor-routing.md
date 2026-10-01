# Boxed-in Corridor Routing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** No corridor of any real or hidden edge is drawn through a room that is neither its source nor its target, no wall cuts another edge's corridor floor, and an edge that truly cannot be routed becomes a safe dead-end stub instead of a line through a room.

**Architecture:** Measure first (a shared sweep harness plus a flood-fill oracle, ratcheted at today's numbers). Then fix shared transit cells with a pure whole-layout lane plan, fix west-incoming target geometry, route the corner branch through occupied cells' margin lanes (generalizing #297's dogleg), and finally add a `stubEdges` plan for the edges that cannot be routed and may safely be dead ends. Everything that changes geometry or progression is behind run-state `layoutVersion` 3 (absent/1/2 keep today's behavior byte-for-byte).

**Tech Stack:** Node ES modules, vitest (`npm test` = `vitest run`), Foundry VTT module.

**Spec:** `docs/superpowers/specs/2026-10-01-boxed-in-corridor-routing-design.md` (its "Decisions" section is authoritative).

## Global Constraints

- `module.json` `version` bumped on every merged PR: `git fetch origin` and read `origin/main:module.json` first, add one patch, never reuse a number (CLAUDE.md). Chunks 1b and 4 may be minor bumps.
- Commit messages end with `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`; PR bodies end with `🤖 Generated with [Claude Code](https://claude.com/claude-code)`.
- PR bodies and commits say `Refs #427` only. No `Fixes`/`Closes`/`Resolves`. Do not close #427 (the user verifies live). Merge with `gh pr merge <n> --squash --subject "<title>" --body "Refs #427"`.
- Run the `update-architecture-docs` skill in any chunk that adds, removes or rewires a `scripts/` file's imports (expected: none; chunks add exports to existing files and test helpers).
- Issue labels: `planned` until the executor starts coding; the executor then applies `in progress` and removes `planned`, and removes `in progress` when paused or done. Update the #427 progress table in the same turn the state changes, terse (N/M and PR numbers only).
- Never symlink `node_modules` into a worktree (`npm ci`); copy `.env` from the main checkout into a new worktree before any live test.
- Every ratchet may only fall. A phase that raises any ratchet is not mergeable (spec K1).
- Dimensions: `ROOM_SIZE_SMALL = 6`, `ROOM_SIZE_LARGE = 12`, `DOOR_WIDTH = 1`, `CORRIDOR_LEN = 1`, `ROW_STRIDE = COLUMN_STRIDE = 13`. Door spans are gap-START: `[p, p + DOOR_WIDTH)`, `p` an integer (#324).
- layoutVersion: `state.layoutVersion ?? 1`; version 2 is live (#415); this plan adds 3 for new runs only (spec Decision 4). Existing runs keep their geometry.
- Corridors of different targets never share floor and never touch without a wall on the shared boundary (spec Decision 2). Same-target corridors stay separate lanes (Decision 3).
- Target-room overlap ratchets count depth >= 2 only (an overlap area of 2 or more cells; the one-cell door tile in the rim is intended, Decision 5). Baseline 170.
- `buildEdgeCorridor`'s existing signature stays valid; new behavior is an optional trailing parameter (`tests/dungeon-layout.test.mjs` calls it directly).
- Sweep: 500 seeds via `tests/helpers/layout-sweep.mjs`, rest room spliced, real + hidden edges.

Baselines (spec, measured 2026-10-01 on main 0.54.49): 9,930 edges; null-path 2,470; intermediate-room overlap 1,316 (0 on found paths); multi-cell edges 2,077; shared transit cells 1,257 of 4,546; edges with a floor cut by another edge's flank 526 (861 occurrences); different-edge floor intersections 510; target door covered 0; deep (>= 2 cell) target overlap 170; source overlap 0; lane conflicts 329 (#415 ceiling).

## Review Focus

- A stub on a source whose only real child is that edge soft-locks the party (the run only moves forward): `planStubs` must refuse it; test with a fixture where the source has one child (Task 5.1).
- A merge room whose every incoming edge is null must keep at least one connecting edge: `planStubs` may never stub the last routable parent (Task 5.1).
- A hidden shortcut stub, once revealed, must not become a progression edge (`revealTravelTimeEffect`): test that `state.edges` is unchanged after reveal (Task 5.3).
- Shuffled edge/room order must yield identical lane plan and `stubEdges` (Tasks 1.2, 5.1).
- A run persisted before this change (layoutVersion 1 or 2, no `stubEdges`) must build byte-identical geometry (Tasks 1.3, 5.4).
- Eight corridors through one 13-wide border: the lane planner must report infeasible, never overlap (Task 1.2).

---

## Chunk 0 (PR A): measurement harness, ratchets, live check. No behavior change.

### Task 0.1: Sweep helper accepts an `incomingFace` override

**Files:**
- Modify: `tests/helpers/layout-sweep.mjs` (`buildSweepLayout`, around line 20-40)
- Test: `tests/layout-sweep-helper.test.mjs`

**Interfaces:**
- Produces: `buildSweepLayout(i, { restRoom = true, incomingFace } = {})` where `incomingFace(roomId, layout)` returns `'north'|'west'`; the returned `incFace` is built from it. Default unchanged.

- [ ] **Step 1: Write the failing test** (append to `tests/layout-sweep-helper.test.mjs`)

```js
it('incomingFace override replaces the incoming face of every room', () => {
  const forced = buildSweepLayout(3, { incomingFace: () => 'west' });
  expect(Object.values(forced.incFace).every((f) => f === 'west')).toBe(true);
  const dflt = buildSweepLayout(3);
  expect(Object.values(dflt.incFace).some((f) => f === 'north')).toBe(true);
});
```

- [ ] **Step 2: Run** `npx vitest run tests/layout-sweep-helper.test.mjs` - expect FAIL (override ignored).

- [ ] **Step 3: Implement.** In `buildSweepLayout`, change the signature to `(i, { restRoom = true, incomingFace } = {})`. After the existing `incFace` computation, construct the layout object without `incFace` first, then:

```js
const layout = { seed, rooms, edges, hiddenEdges: hiddenEdges ?? {}, hiddenRooms: [...(hiddenRooms ?? [])],
  layoutEdges, hiddenIncomingByRoomId, pos, occ, rect, incFace };
if (incomingFace) {
  for (const id of ids) layout.incFace[id] = incomingFace(id, layout);
}
return layout;
```

- [ ] **Step 4: Run** the same file - expect PASS.
- [ ] **Step 5: Commit** `test(#427): sweep helper incomingFace override`.

### Task 0.2: `measureBuildability(layout)` and baseline ratchets

**Files:**
- Create: `tests/helpers/buildability.mjs`
- Create: `tests/dungeon-layout-buildability.test.mjs`

**Interfaces:**
- Consumes: `buildSweepLayout`, `planSelector` (`tests/helpers/layout-sweep.mjs`); `buildEdgeCorridor`, `findCorridorPath`, `findPriorityCollision`, `assignDoorSlotsWithPriority`, `incomingConnectionsFor`, `cellBounds`, `transitCellContainmentWalls` (`scripts/dungeon-layout.mjs`).
- Produces: `measureBuildability(layout) -> { edges, nullPath, interOverlap, interOverlapFound, targetOverlapDeep, multi, sharedCells, cutOccurrences, cutEdges, floorCrossings, targetDoorCovered, chainMismatch, sourceOverlap }` (all counts), plus `visits` is not returned (counts only). `sumMeasures(a, b)` adds two such objects.

- [ ] **Step 1: Write the failing test**

```js
// tests/dungeon-layout-buildability.test.mjs
import { describe, it, expect } from 'vitest';
import { buildSweepLayout } from './helpers/layout-sweep.mjs';
import { measureBuildability, sumMeasures } from './helpers/buildability.mjs';

const SEEDS = 500;
// Ratchets, measured on main 0.54.49. They may only fall.
const NULL_PATH_CEILING = 2470;
const INTERMEDIATE_OVERLAP_CEILING = 1316;
const SHARED_CELL_CUT_EDGES_CEILING = 526;
const SHARED_CELL_CUT_OCCURRENCES_CEILING = 861;
const FLOOR_CROSSING_CEILING = 510;
const DEEP_TARGET_OVERLAP_CEILING = 170;

describe('layoutVersion 2 buildability baseline (#427)', () => {
  const total = Array.from({ length: SEEDS }, (_, i) => measureBuildability(buildSweepLayout(i))).reduce(sumMeasures);
  it('is non-vacuous and exact on the invariants that already hold', () => {
    expect(total.edges).toBeGreaterThan(9000);
    expect(total.interOverlapFound).toBe(0);
    expect(total.targetDoorCovered).toBe(0);
    expect(total.chainMismatch).toBe(0);
    expect(total.sourceOverlap).toBe(0);
  });
  it('ratchets do not rise', () => {
    expect(total.nullPath).toBeLessThanOrEqual(NULL_PATH_CEILING);
    expect(total.interOverlap).toBeLessThanOrEqual(INTERMEDIATE_OVERLAP_CEILING);
    expect(total.cutEdges).toBeLessThanOrEqual(SHARED_CELL_CUT_EDGES_CEILING);
    expect(total.cutOccurrences).toBeLessThanOrEqual(SHARED_CELL_CUT_OCCURRENCES_CEILING);
    expect(total.floorCrossings).toBeLessThanOrEqual(FLOOR_CROSSING_CEILING);
    expect(total.targetOverlapDeep).toBeLessThanOrEqual(DEEP_TARGET_OVERLAP_CEILING);
  });
});
```

- [ ] **Step 2: Run** `npx vitest run tests/dungeon-layout-buildability.test.mjs` - FAIL (module missing).

- [ ] **Step 3: Implement `tests/helpers/buildability.mjs`.** Port the logic of the spec's measurement scripts; exact code:

```js
import {
  buildEdgeCorridor, findCorridorPath, findPriorityCollision, assignDoorSlotsWithPriority,
  incomingConnectionsFor, cellBounds, transitCellContainmentWalls,
} from '../../scripts/dungeon-layout.mjs';
import { planSelector } from './layout-sweep.mjs';

const area = (a, b) => Math.max(0, Math.min(a.gx + a.gw, b.gx + b.gw) - Math.max(a.gx, b.gx))
  * Math.max(0, Math.min(a.gy + a.gh, b.gy + b.gh) - Math.max(a.gy, b.gy));
const overlap = (a, b) => area(a, b) > 0;
const cuts = (w, f) => (w.y1 === w.y2
  ? f.gy < w.y1 && w.y1 < f.gy + f.gh && Math.max(Math.min(w.x1, w.x2), f.gx) < Math.min(Math.max(w.x1, w.x2), f.gx + f.gw)
  : f.gx < w.x1 && w.x1 < f.gx + f.gw && Math.max(Math.min(w.y1, w.y2), f.gy) < Math.min(Math.max(w.y1, w.y2), f.gy + f.gh));

export const ZERO = () => ({ edges: 0, nullPath: 0, interOverlap: 0, interOverlapFound: 0, targetOverlapDeep: 0,
  multi: 0, sharedCells: 0, cutOccurrences: 0, cutEdges: 0, floorCrossings: 0, targetDoorCovered: 0,
  chainMismatch: 0, sourceOverlap: 0 });
export const sumMeasures = (a, b) => Object.fromEntries(Object.keys(a).map((k) => [k, a[k] + b[k]]));

/** Mirrors the scene's per-room build (door slots with priority, planned exit doors). */
export function measureBuildability(layout) {
  const m = ZERO();
  const { seed, rooms, layoutEdges, hiddenIncomingByRoomId, hiddenRooms, pos, occ, rect, incFace } = layout;
  const planFor = planSelector.planFor(layout);
  const cellUse = new Map();
  for (const toId of Object.keys(rooms)) {
    const isDetour = hiddenRooms.includes(toId);
    const conns = incomingConnectionsFor(layoutEdges, toId, hiddenIncomingByRoomId)
      .map((c) => (isDetour ? { ...c, hidden: true } : c));
    if (!conns.length) continue;
    const face = incFace[toId];
    const collision = findPriorityCollision(seed, toId, pos[toId].rank, pos[toId].col, conns, pos, occ, face, planFor);
    const slots = assignDoorSlotsWithPriority(seed, rect[toId], conns, face, collision);
    conns.forEach(({ sourceId }, k) => {
      const sel = planSelector(layout, { sourceId, toId });
      const res = buildEdgeCorridor(seed, sourceId, toId, rect[sourceId], rect[toId], pos[sourceId], pos[toId],
        sel.face, slots[k], occ, face, sel.exitDoor);
      const segs = [...res.corridorSegments, ...res.transitCells.flatMap((c) => c.corridorSegments)];
      const path = findCorridorPath(pos[sourceId], pos[toId], occ,
        { fromRoomId: sourceId, toRoomId: toId, incomingFace: face, exitFace: sel.face });
      m.edges += 1;
      if (!path) m.nullPath += 1;
      const inter = Object.entries(rect).some(([id, r]) => id !== sourceId && id !== toId && segs.some((s) => overlap(s, r)));
      if (inter) { m.interOverlap += 1; if (path) m.interOverlapFound += 1; }
      if (segs.some((s) => area(s, rect[toId]) >= 2)) m.targetOverlapDeep += 1;
      if (segs.some((s) => overlap(s, rect[sourceId]))) m.sourceOverlap += 1;
      if (res.transitCells.length) {
        m.multi += 1;
        for (let i = 0; i + 1 < res.transitCells.length; i += 1) {
          const a = res.transitCells[i].exitPoint; const b = res.transitCells[i + 1].entryPoint;
          if (a.x !== b.x || a.y !== b.y) m.chainMismatch += 1;
        }
        const last = res.transitCells.at(-1);
        const bounds = cellBounds(last.rank, last.col);
        const walls = transitCellContainmentWalls(last.rank, last.col, [{ side: last.exitSide, point: last.exitPoint }])
          .filter((w) => w.dir === last.exitSide);
        const horiz = last.exitSide === 'north' || last.exitSide === 'south';
        const cs = horiz ? bounds.gx : bounds.gy; const ce = horiz ? bounds.gx + bounds.gw : bounds.gy + bounds.gh;
        const bw = walls.find((w) => (horiz ? w.x1 : w.y1) === cs); const aw = walls.find((w) => (horiz ? w.x2 : w.y2) === ce);
        const gs = bw ? (horiz ? bw.x2 : bw.y2) : cs; const ge = aw ? (horiz ? aw.x1 : aw.y1) : ce;
        const [ds, de] = horiz ? [res.revealDoorWall.x1, res.revealDoorWall.x2] : [res.revealDoorWall.y1, res.revealDoorWall.y2];
        if (Math.abs(gs - Math.min(ds, de)) > 1e-9 || Math.abs(ge - Math.max(ds, de)) > 1e-9) m.targetDoorCovered += 1;
        for (const c of res.transitCells) {
          const key = `${c.rank},${c.col}`;
          if (!cellUse.has(key)) cellUse.set(key, []);
          cellUse.get(key).push({ id: `${sourceId}->${toId}`, c });
        }
      }
    });
  }
  const cutEdges = new Set();
  for (const [key, uses] of cellUse) {
    const [rank, col] = key.split(',').map(Number);
    const walls = [
      ...transitCellContainmentWalls(rank, col, uses.flatMap(({ c }) => [
        { side: c.entrySide, point: c.entryPoint }, { side: c.exitSide, point: c.exitPoint }])),
      ...uses.flatMap(({ c }) => c.plainWalls ?? []),
    ];
    if (uses.length > 1) m.sharedCells += 1;
    for (const { id, c } of uses) {
      if (c.corridorSegments.some((f) => walls.some((w) => cuts(w, f)))) { cutEdges.add(id); m.cutOccurrences += 1; }
    }
    for (let a = 0; a < uses.length; a += 1) for (let b = a + 1; b < uses.length; b += 1) {
      if (uses[a].id !== uses[b].id
        && uses[a].c.corridorSegments.some((x) => uses[b].c.corridorSegments.some((y) => overlap(x, y)))) m.floorCrossings += 1;
    }
  }
  m.cutEdges = cutEdges.size;
  return m;
}
```

Note `cutEdges` is a per-seed set, so summing across seeds is correct (edge ids repeat across seeds but are counted per seed).

- [ ] **Step 4: Run** the new test file - expect PASS with the baseline numbers. If a measured value is above its ceiling, the helper differs from the spec's script: reconcile (do not raise the ceiling) before continuing. Expected exact values: nullPath 2470, interOverlap 1316, cutEdges 526, cutOccurrences 861, floorCrossings 510, targetOverlapDeep 170.
- [ ] **Step 5: Commit** `test(#427): buildability measurement and baseline ratchets`.

### Task 0.3: Flood-fill oracle

**Files:**
- Create: `tests/helpers/floor-oracle.mjs`
- Test: `tests/floor-oracle.test.mjs`

**Interfaces:**
- Produces: `buildFloorModel(floors, walls) -> { reach(startCell) -> Set<string> }` where `floors` is `[{gx,gy,gw,gh}]` (unit cells covered), `walls` is `[{x1,y1,x2,y2}]` axis-aligned on integer coordinates, a cell key is `"x,y"`; `reach` flood-fills over floor cells, crossing from cell to a 4-neighbour only if no wall lies on their shared unit edge. Doors are treated as passable (callers pass only solid walls).

- [ ] **Step 1: Write the failing tests**

```js
import { describe, it, expect } from 'vitest';
import { buildFloorModel } from './helpers/floor-oracle.mjs';

describe('floor oracle', () => {
  const floors = [{ gx: 0, gy: 0, gw: 3, gh: 1 }];
  it('reaches along an open strip', () => {
    expect([...buildFloorModel(floors, []).reach('0,0')].sort()).toEqual(['0,0', '1,0', '2,0']);
  });
  it('a wall on a shared unit edge splits the strip', () => {
    const walls = [{ x1: 1, y1: 0, x2: 1, y2: 1 }];
    expect([...buildFloorModel(floors, walls).reach('0,0')]).toEqual(['0,0']);
  });
  it('a wall along the strip edge does not block it', () => {
    const walls = [{ x1: 0, y1: 0, x2: 3, y2: 0 }];
    expect(buildFloorModel(floors, walls).reach('0,0').size).toBe(3);
  });
});
```

- [ ] **Step 2: Run** `npx vitest run tests/floor-oracle.test.mjs` - FAIL.
- [ ] **Step 3: Implement**

```js
// tests/helpers/floor-oracle.mjs
export function buildFloorModel(floors, walls) {
  const cells = new Set();
  for (const f of floors) for (let x = f.gx; x < f.gx + f.gw; x += 1) for (let y = f.gy; y < f.gy + f.gh; y += 1) cells.add(`${x},${y}`);
  // vertical wall unit edges at x between cells (x-1,y) and (x,y); horizontal at y between (x,y-1) and (x,y)
  const vWall = new Set(); const hWall = new Set();
  for (const w of walls) {
    if (w.x1 === w.x2) for (let y = Math.min(w.y1, w.y2); y < Math.max(w.y1, w.y2); y += 1) vWall.add(`${w.x1},${y}`);
    else for (let x = Math.min(w.x1, w.x2); x < Math.max(w.x1, w.x2); x += 1) hWall.add(`${x},${w.y1}`);
  }
  const blocked = (ax, ay, bx, by) => (ax !== bx ? vWall.has(`${Math.max(ax, bx)},${ay}`) : hWall.has(`${ax},${Math.max(ay, by)}`));
  return {
    reach(start) {
      const seen = new Set([start]); const q = [start];
      while (q.length) {
        const [x, y] = q.shift().split(',').map(Number);
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const k = `${x + dx},${y + dy}`;
          if (seen.has(k) || !cells.has(k) || blocked(x, y, x + dx, y + dy)) continue;
          seen.add(k); q.push(k);
        }
      }
      return seen;
    },
  };
}
```

- [ ] **Step 4: Run** - PASS.
- [ ] **Step 5: Commit** `test(#427): flood-fill floor oracle`.

### Task 0.4: Oracle-based cut check agrees with the geometric check

**Files:** Modify `tests/dungeon-layout-buildability.test.mjs`.

- [ ] **Step 1: Test.** For seed `sweep-10` (index 10), assemble, per transit cell `(0,2)`, the floors of both crossings and the cell's walls (containment from union openings plus every crossing's `plainWalls`), and assert the oracle's `reach` from the start of edge B's floor does NOT reach B's far end (the cut is real under the model), pinning that the two methods agree on the known sample. Expected today: B is severed. After Chunk 1b the same test (flipped under a v3 plan) must show it connected; leave a `// flips in Chunk 1b` comment naming it.
- [ ] **Step 2-4:** write, run (FAIL on the assertion shape until written correctly), pass.
- [ ] **Step 5: Commit** `test(#427): oracle confirms the known cut`.

### Task 0.5: Live check of a cut floor (authorized, user Q8)

**Files:** none (a note on #427). Use the `foundry-rest` skill.

- [ ] **Step 1:** Copy `.env` into the worktree. Compare the live world's module version with this branch's `module.json` (memory: stale Foundry version trap).
- [ ] **Step 2: Prefer read-only.** Find (offline) a layoutVersion 2 run seed containing the Task 0.4 shape, or use the user's existing v2 scene `vPjL50w7nUMOZIT3` and search its `Wall` documents for a transit cell crossed by two edges (`dungeonTransitCellMarginForCell` flags plus tiles with `dungeonTransitCellCrossing` for the same cell key). Then, via the REST relay or a script macro on the canvas, query collision without creating anything: `CONFIG.Canvas.polygonBackends.move.testCollision(a, b, { type: "move", mode: "any" })` between two points on one corridor floor that straddle the other edge's flank wall. Record: collision true or false, the wall ids hit.
- [ ] **Step 3: Only if the read-only query cannot answer,** create a throwaway scene (`Scene.create({ name: "tmp-427-livecheck" })`), copy only the needed walls and one token into it, run the test, then delete the scene. Verify cleanup: `game.scenes.getName("tmp-427-livecheck")` is `undefined` and the real scene's wall/tile/token counts equal their before-counts. Never move tokens in the real scene.
- [ ] **Step 4:** Post on #427: the exact queries run, results, and "changed nothing" or the exact list of created and deleted documents. If the result contradicts the oracle (cut not blocking), spec K5 applies: fix the oracle model before Chunk 1b.

**Result (done 2026-10-01, read-only, nothing created or changed).** Live world: Foundry 14.368, module 0.54.49 (older than this branch). The user's scene `vPjL50w7nUMOZIT3` IS the `sweep-10` layout (its cell r0c2 holds edge A's west->south vertical lane with the same plain flank walls at x=326/327 as the sweep). Edge B's crossing is not built there yet (its rooms are not revealed), so the cut itself could not be exercised end to end. Instead `CONFIG.Canvas.polygonBackends.{move,sight}.testCollision(a, b, { type, mode })` was run on the scene's own walls (grid 100): (1) along A's lane `(326.5,3.5)->(326.5,11.5)`: no collision (move and sight); (2) across A's x=327 flank at B's row `(326.5,10.5)->(327.5,10.5)`: collision at x=327 (move and sight); (3) across both flanks `(325.5,10.5)->(327.5,10.5)`: collisions at x=326 and x=327; (4) open air control: none. So a flank wall lying inside another edge's floor blocks walking and sight, and walls along a lane's own boundary do not: the oracle's wall model holds (K5 not triggered). B's own flank cutting A (y=10, y=11) is the same wall type, not separately exercised.

### Task 0.6: Version bump, PR

- [ ] `git fetch origin`; set `module.json` to origin's version + one patch; `npm test` all green; commit; open PR "test(#427): buildability ratchets and oracle" with `Refs #427`; automerge with explicit `--subject/--body`. Update the #427 progress table.

---

## Chunk 1 (PRs B and C): shared transit-cell lane plan (layoutVersion 3)

### Task 1.1 (PR B): Lane feasibility prototype, no behavior

**Files:**
- Create: `tests/helpers/lane-prototype.mjs`
- Test: `tests/dungeon-layout-lanes-prototype.test.mjs`

**Interfaces:**
- Produces: `crossingsByCell(layout) -> Map<"rank,col", [{ edgeId, toId, entrySide, exitSide, entryPoint, exitPoint }]>` (the pinned crossings exactly as `buildEdgeCorridor` builds them today) and `assignableWithoutCrossing(crossings) -> boolean` (true if some choice of interior offsets, keeping each crossing's pinned end points fixed, leaves no two different-target floors intersecting).

- [ ] **Step 1: Test** that records, for the 500-seed sweep, how many of the 510 intersections are resolvable by interior offsets alone, and ratchets: `expect(unresolvable).toBeLessThanOrEqual(K2_ALLOWANCE)` where `K2_ALLOWANCE = Math.floor(0.02 * 2077)` (41). First run prints the number; this task's deliverable is that number written into spec Risks and the issue.
- [ ] **Step 2:** FAIL (module missing). **Step 3:** implement `crossingsByCell` by calling the same code path as `measureBuildability` (reuse its visit loop; extract it to a shared `visitEdges(layout, cb)` in `tests/helpers/buildability.mjs` and have both use it). Implement `assignableWithoutCrossing` as a backtracking search over per-border offsets in `[0, 12]` with floors as 1-wide strips (straight or L per `transitCellCrossing`'s shape rule), pruning when two different-target floors intersect.
- [ ] **Step 4:** run; record the number. **Step 5:** commit; version bump; PR; automerge.
- **Decision rule:** if unresolvable > 41 (K2), stop and report to the user (Q2/Q3 are already decided: reroute or accept; ask which for the excess).

### Task 1.2 (PR C): `transitLanePlan` pure function

**Files:**
- Modify: `scripts/dungeon-layout.mjs` (new export after `transitCellCrossing`)
- Test: `tests/dungeon-layout.test.mjs` (new `describe('transitLanePlan (#427)')`)

**Interfaces:**
- Consumes: `findCorridorPath`, `cellBounds`, `incomingConnectionsFor`, `outgoingDoorPlan`.
- Produces: `transitLanePlan({ seed, positionByRoomId, occupiedCells, layoutEdges, hiddenIncomingByRoomId, incomingFaceByRoomId, planFor, slotsForRoom }) -> { lanes: Map<edgeId, Map<"rank,col", { entryPoint, exitPoint }>>, infeasible: [edgeId] }`. `edgeId` is `${fromRoomId}->${toRoomId}`. Canonical processing order: target rank, target id, source id. Pinned: each edge's first entry and last exit stay at the real doors; only interior points move. A cell border is 13 units; crossings on one border get distinct integer offsets; adjacent lanes may share a boundary.

- [ ] **Step 1: Tests**
  1. Two edges through one cell on parallel straight paths get distinct offsets and never intersect.
  2. Two edges whose sides force a crossing (north-south and west-east) land in `infeasible` (never merged).
  3. Order independence: reversing the key order of `layoutEdges` (and of the room map) yields a deep-equal plan.
  4. Capacity: 14 straight crossings through one cell report the excess as infeasible without overlap.
  5. Sweep: over 500 seeds, for every non-infeasible crossing in every cell, no two different-target floors intersect and no flank wall lies inside any floor (use `measureBuildability`'s `cuts` logic on lane output).
- [ ] **Step 2:** FAIL. **Step 3:** implement per the interface; no scene use yet. Straight vs L shape comes from entry/exit sides as `transitCellCrossing` decides.
- [ ] **Step 4:** PASS. **Step 5:** commit.

### Task 1.3: `buildEdgeCorridor` accepts `lanes`, scene uses it under v3

**Files:**
- Modify: `scripts/dungeon-layout.mjs` (`buildEdgeCorridor` trailing param `lanes`; pass `forcedEntryPoint`/`forcedExitPoint` to `transitCellContainmentWalls`/`transitCellCrossing` from `lanes.get(edgeId)`)
- Modify: `scripts/dungeon-scene.mjs` (`buildPopulateAndUnlockGraphNode`: compute the plan once from state when `layoutVersion >= 3`, pass the edge's lanes; `buildTransitCellIfNeeded` unchanged: it already unions openings)
- Modify: `scripts/ui/dungeon-app.mjs` (stamp `layoutVersion: 3`)
- Modify: `tests/dungeon-layout-default-identical.test.mjs` (digest for v1/v2 must not change)

**Interfaces:** `buildEdgeCorridor(..., incomingFace, exitDoorArg, lanes)`; `lanes` is the per-edge Map from Task 1.2 or undefined (byte-identical to today).

- [ ] **Step 1: Tests.** (a) Without `lanes` the result is deep-equal to today's for the whole 500-seed sweep (snapshot digest in `dungeon-layout-default-identical.test.mjs`). (b) With the plan, `measureBuildability` on a `lanes`-aware sweep gives `cutOccurrences === 0`, `floorCrossings` equal to the number of `infeasible` pairs (expected 0 different-target after rerouting, below), `targetDoorCovered === 0`, `chainMismatch === 0`, `nullPath <= NULL_PATH_CEILING + 41`. (c) Flip the Task 0.4 sample: edge B is now connected in the oracle.
- [ ] **Step 2:** FAIL. **Step 3:** implement. For `infeasible` edges: block the offending cell for the later edge (canonical order) in `occupiedCells` and re-run `findCorridorPath`, once; if still infeasible the edge keeps its documented residual geometry and is counted in a ratcheted `LANE_INFEASIBLE_CEILING` (set to the measured value).
- [ ] **Step 4:** full `npm test`; PASS. **Step 5:** `module.json` minor bump; commit; PR; automerge; update the #427 table. A new run is required to verify live.

---

## Chunk 2 (PR D): west-incoming target geometry

### Task 2.1: Covered west doors and deep overlaps, test first

**Files:**
- Modify: `scripts/dungeon-layout.mjs` (`buildEdgeCorridor` west-incoming corner and multi-cell branches; `cornerConnector` degenerate leg)
- Test: `tests/dungeon-layout-buildability.test.mjs`

- [ ] **Step 1: Tests.** Using the sweep helper override `incomingFace: (id, layout) => west-or-north-by-pathaware` (a test-local function: choose the face with fewer `findCorridorPath` nulls over the room's incoming connections, tie north), assert under `lanes`: `targetDoorCovered === 0` (today 7: `sweep-25` `room-room-room-entry-0-0 -> room-merge-9`, `sweep-59`, `sweep-177`) and `targetOverlapDeep <= 170` (today 562 under this override). Also assert today's default faces: `targetOverlapDeep` falls from 170 toward 0 (ratchet at the new measured value; target 0).
- [ ] **Step 2:** FAIL. **Step 3:** fix the geometry so the last transit cell's gap equals the west door span and the final connector never extends past the rim. Gate behind `layoutVersion >= 3` via the optional-parameter pattern (a `geometryVersion` field on the options object, default 2).
- [ ] **Step 4:** PASS, full suite. **Step 5:** version bump; commit; PR; automerge. Fold the west-incoming part of #416 here and comment on #416.

### Task 2.2: Decision gate (measurement, no PR)

- [ ] Re-run Task 0.2's measurement with the `pathaware` override on v3 geometry. Record nulls, intermediate overlaps, cuts, doors, deep overlaps on #427. Rule (spec K3): if intermediate overlaps do not fall by >= 15% (about 200) with every other ratchet held, mark Chunk 3 dropped.

---

## Chunk 3 (PR E, optional): path-aware `incomingFaceForV3`

Only if Task 2.2 passes.

### Task 3.1: `incomingFaceForV3`

**Files:** Modify `scripts/dungeon-layout.mjs` (new export; `incomingFaceFor` untouched), `scripts/ui/dungeon-app.mjs` (use it when stamping v3), tests.

**Interfaces:** `incomingFaceForV3(roomId, layout) -> 'north'|'west'`: for each face run `findCorridorPath` over the room's `incomingConnectionsFor` entries with that face; fewer nulls wins, tie north.

- [ ] Tests: tie keeps north; a room whose only unreachable-north edges are reachable via west picks west; pure and order-independent; sweep: nulls <= 1,794 and every Chunk 1-2 ratchet unchanged. Implement, run, version bump, PR.

---

## Chunk 4 (PRs F1-F3): margin-lane pass-through for the corner branch

Spec Phase 4. Each sub-PR keeps every ratchet.

### Task 4.1 (PR F1): `occupiedCellPassage` pure function

**Files:** Modify `scripts/dungeon-layout.mjs`; tests in `tests/dungeon-layout.test.mjs`.

**Interfaces:** `occupiedCellPassage(rect, rank, col, outgoingPlanForRoom, { entrySide, exitSide }) -> { floor: [{gx,gy,gw,gh}], openings: { east?: [...], south?: [...] } } | null` using the room's east strip (x from `rect.gx + rect.gw`) for north/south passes and its south margin row for east/west passes; null when `outgoingDoorPlan` doors cross the needed stretch.

- [ ] Tests: SMALL and LARGE rooms (strip width 7 and 1), a room with an east door on the needed row returns null, a free room returns a lane that never overlaps `rect` and stays inside the cell. Implement; PASS; commit.

### Task 4.2 (PR F1): BFS may enter an occupied cell through a passage

**Files:** Modify `findCorridorPath` (new optional `{ passage }` callback in its options; default keeps today's blocked behavior).

- [ ] Tests: the `sweep-0` repro (`room-room-entry-1 -> room-merge-3`) finds a path through the co-parent's cell; found paths on the sweep still show 0 intermediate-room overlap. Implement; PASS.

### Task 4.3 (PR F2): geometry and containment

**Files:** `scripts/dungeon-layout.mjs` (`buildEdgeCorridor` assembles passages into the chain; `pendingForeignMarginOpenings` uses the real lane, not the list-order slot, spec/#297 Finding C); `scripts/dungeon-scene.mjs` (margin walls via `cellMarginWalls` second opening).

- [ ] Tests: for every sweep edge routed through a passage, `INTERMEDIATE_OVERLAP_CEILING` falls; oracle: connected, no co-parent door sealed (the #297 Round 1 failure; assert 0 over the sweep), no different-target floor connected, no leak. Implement; PASS; `K4` check (> 10% of the 1,316 undisposed means stop and report).

### Task 4.4 (PR F3): ratchet down, document residual

- [ ] Lower `INTERMEDIATE_OVERLAP_CEILING` to the measured value; list the residual edges (no free lane) in a test fixture file `tests/fixtures/boxed-in-residual.json` so Chunk 5 consumes the exact set. Version bump; PR.

---

## Chunk 5 (PRs G1-G3): dead-end stub (user Decision 6)

**Dependency split (user Decision 9).** Chunks 0-4 and Chunk 5 as written below (non-sole-child stubs, about 464 edges today) do NOT depend on #439. A sole-child source (1,952 null edges) becomes stub-eligible only once the retreat feature #439 (a way back to the last fork) has landed; that is Chunk 6 below and must not start before #439 is merged and live-verified. Until then `planStubs` is called with `retreatAvailable: false` and the eligibility rule is exactly as in the spec.

Stub decisions (user, Decisions 10-12): the stub door is locked and unlocked exactly like a real door, indistinguishable from one, with no extra check, skill roll or time cost; false shortcuts (a revealed hidden door leading to a stub) are allowed; flavor is collapsed rubble, `dungeonStubFlavor` is always `'rubble'`, and the end cap uses the rubble corridor-cap tile from #438. Until #438 ships the existing corridor tile is the placeholder: reference the asset through one constant (`STUB_CAP_TILE`) so swapping it is a one-line change.

Spec section "Dead-end stub". Behind layoutVersion 3.

### Task 5.1 (PR G1): `planStubs` pure function

**Files:** Modify `scripts/dungeon-layout.mjs`; tests in `tests/dungeon-layout.test.mjs`.

**Interfaces:** `planStubs({ rooms, edges, layoutEdges, hiddenEdges, hiddenIncomingByRoomId, nullEdges, retreatAvailable = false }) -> { stubEdges: { [sourceId]: [targetId] } }` where `retreatAvailable` (true only after #439) makes rule 2 hold for a sole-child source, and `nullEdges` is the list of `{ sourceId, toId, hidden }` that remain unroutable. Canonical order: target rank, target id, source id. A candidate is stubbed only if (1) the target keeps >= 1 non-stub routable incoming edge, (2) the source keeps another non-stub real child or the edge is hidden, (3) after stubbing, BFS over non-stub `edges` from `room-entry` reaches every room and every non-goal room has a non-stub forward edge.

- [ ] **Step 1: Tests**
```js
it('never stubs the only child of a source while retreat is unavailable (soft-lock)', () => {
  const edges = { 'room-entry': ['a'], a: ['m'], b: ['m'], m: [] }; // a is sole-child parent
  const { stubEdges } = planStubs({ rooms, edges, layoutEdges: edges, hiddenEdges: {}, hiddenIncomingByRoomId: {},
    nullEdges: [{ sourceId: 'a', toId: 'm', hidden: false }] });
  expect(stubEdges).toEqual({});
});
it('stubs that same sole-child source when retreatAvailable is true (#439 landed), still keeping the target reachable', () => {
  /* same fixture plus a second routable parent of m (b -> m non-null); expect stubEdges to equal { a: ['m'] } */
});
it('stubs a hidden shortcut whose source has real children', () => { /* source with 2 real children + hidden edge to m; m has another routable parent -> stubbed */ });
it('never stubs the last routable parent of a target', () => { /* both parents null: first (canonical) stays connecting, second may stub only if rules 2-3 hold */ });
it('is order independent', () => { /* reverse key order of edges/rooms: deep-equal result */ });
it('sweep: on all 500 seeds the goal is reachable over non-stub edges and no room is stranded', () => {});
it('sweep: eligible count is at most 464 on the baseline null set', () => {});
```
Fill the fixtures with concrete room maps (each `rooms` entry `{ id, kind: 'combat' }`; goal `{ id: 'room-goal', isGoal: true }`).
- [ ] **Step 2:** FAIL. **Step 3:** implement (graph BFS, canonical order, no randomness). **Step 4:** PASS. **Step 5:** commit; version bump; PR G1.

### Task 5.2 (PR G1): stub geometry, pure

**Files:** Modify `scripts/dungeon-layout.mjs`; tests.

**Interfaces:** `stubGeometry(seed, sourceId, targetId, sourceRect, sourcePos, doorSpan, siblingFloors) -> { floor: [{gx,gy,gw,gh}], walls: [{x1,y1,x2,y2}], flavor: 'rubble', length }`. Floor is the door-cell tile directly below the south-face `doorSpan` plus up to 3 horizontal cells in the margin row toward the target's side, ending at least one cell short of the cell boundary, never intersecting `siblingFloors`; end cap and flank walls; `length` in 1..4; flavor (always 'rubble') and length from `splitmix32(seedFromString(`${seed}-stub-${sourceId}->${targetId}`))`.

- [ ] Tests: sweep over all planned stubs: floor inside the source cell and its margin row, no overlap with ANY room rect (including intermediate rooms and the source interior), no edge-adjacency to another floor without a wall (`floor-oracle`), deterministic under shuffled sibling order, length in range, `siblingFloors` respected (shortens to 1). Implement; PASS; commit.

### Task 5.3 (PR G2): progression filters and state

**Files:** `scripts/ui/dungeon-app.mjs` (precompute: derive `nullEdges`, call `planStubs`, store `stubEdges`, remove stub edges from the stored `edges` but not `layoutEdges`, v3 only); `scripts/dungeon-layout.mjs` (`incomingConnectionsFor(layoutEdges, roomId, hiddenIncomingByRoomId, stubEdges = {})` filters stubs); `scripts/dungeon-deck.mjs` (`revealTravelTimeEffect` skips stub targets); `scripts/dungeon-scene.mjs` (`outgoingPlanFromState` includes stub children for door slots; `unlockDoorsFromRoom` also unlocks `dungeonStubDoorFor` doors).

- [ ] **Step 1: Tests.** `incomingConnectionsFor` with `stubEdges` drops the stub source (and without the 4th argument is unchanged); `revealTravelTimeEffect` leaves `edges` untouched for a stub target and still returns `revealedRoomId: null`; `advanceToRoom` refuses a stub child; `roomsToEagerlyBuild` order is identical with and without stubs (layoutEdges unchanged); a v1/v2 state round-trips byte-identical.
- [ ] **Step 2-4:** FAIL, implement, PASS. **Step 5:** commit; version bump; PR G2.

### Task 5.4 (PR G3): scene build of the stub

**Files:** `scripts/dungeon-scene.mjs` (`buildRoomAtGraphNode`: for each `stubEdges[roomId]` build `stubGeometry` walls and floor tiles after the room's real edges, a door wall, locked at build and unlocked by the source's resolution exactly like a real door (no extra check, roll or time cost; same look as a real door), with flags `{ dungeonStubDoorFor: targetId, dungeonDoorFromRoomId: roomId, dungeonStubFlavor }`; `handleDungeonDoorOpened`: when a `dungeonStubDoorFor` door opens, post the flavor chat line once and return `{ autoOpenTracker: false }`); art: the cap tile is the #438 rubble tile via the `STUB_CAP_TILE` constant; until #438 ships it points at the existing corridor tile (placeholder).

- [ ] **Step 1: Tests** (existing scene test style in `tests/dungeon-scene.test.mjs`): a source with a stub gets the door wall with the three flags, the end-cap walls, and tiles; the door is locked at build and CLOSED after `unlockDoorsFromRoom`, with the same door type/art as a real door, and opening it triggers no roll or time cost; opening it never calls `advanceToRoom` or reveals tokens; a layoutVersion 2 state builds no stub.
- [ ] **Step 2-4:** FAIL, implement, PASS, full suite. **Step 5:** `update-architecture-docs` only if imports changed; minor version bump; PR G3; comment that a NEW run is required to see a stub and that live verification (a stub door opens to a dead end, party still progresses via the other child) is the user's.

### Task 5.5: Whole-sweep acceptance

- [ ] Add to the buildability test: for all 500 seeds, K6 invariants (goal reachable over non-stub edges, no stranded room), 0 stub/room overlaps, `stubbedEdges <= 464` before Chunk 4 and the measured value after it. Commit with the last PR.

---

## Chunk 6 (PR H): sole-child stubs, gated on #439

**Do not start until #439 (retreat to the last fork) is merged and live-verified by the user.**

### Task 6.1: Enable `retreatAvailable`

**Files:** Modify `scripts/ui/dungeon-app.mjs` (pass `retreatAvailable: true` to `planStubs` under the run-state flag or layoutVersion that #439's merged spec defines; read it and use it, do not invent one); tests in `tests/dungeon-layout.test.mjs` and the Task 5.5 acceptance sweep.

- [ ] **Step 1: Tests.** With `retreatAvailable: true`, the 500-seed sweep stubs the previously-ineligible sole-child edges that satisfy rules 1 and 3, the K6 invariants still hold (goal reachable over non-stub edges plus retreat as #439 defines it; no room unreachable), stub/room overlap is 0, and the residual direct-line edge count falls (new ratchet at the measured value). A run without the flag behaves exactly as Chunk 5.
- [ ] **Step 2-4:** FAIL, implement, PASS, full suite. **Step 5:** version bump; commit; PR H; automerge; update the #427 table.

---

## Self-Review

- Spec coverage: Phase 0 (0.1-0.5), 1a/1b (1.1-1.3), 2 (2.1), gate (2.2), 3 (3.1), 4 (4.1-4.4), 5 stub (5.1-5.5), layoutVersion gate (1.3, 5.3, 5.4), containment and property tests (0.2, 0.3, 1.2, 4.3, 5.2), kill criteria K1-K6 as stop rules inside the tasks, interactions with #415 Chunk 5 and #416 (Chunk 2 folds the west part of #416; Chunk 5 of #415 is independent and should land before Chunk 1b, re-measure baselines then).
- Known depth difference: Chunks 0 and 5 give full test and code; Chunks 1-4 give interfaces, exact tests to write and decision rules, with detailed geometry deliberately derived from the Task 1.1 measurement and a short design note at the start of each Chunk 4 sub-PR (spec says Phase 4 gets "its own plan first"). If Task 1.1 exceeds K2 or Task 2.2 fails, stop and report; do not improvise past a kill criterion.
- Type consistency: `edgeId` is `${fromRoomId}->${toRoomId}` everywhere; `stubEdges` is `{ [sourceId]: [targetId] }`; `lanes` is `Map<edgeId, Map<"rank,col", { entryPoint, exitPoint }>>`.
