# Boxed-in Corridor Routing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** No corridor of any real or hidden edge is drawn through a room that is neither its source nor its target, no wall cuts another edge's corridor floor, and an edge that truly cannot be routed becomes a safe dead-end stub instead of a line through a room, wherever that is achievable; the remainder is counted, ratcheted and listed.

**Architecture:** Measure first (a shared sweep harness plus a flood-fill oracle, ratcheted at today's numbers; done). Then, in the order the user chose (2026-10-01): (Chunk 2) a planarity-consistent incoming door order and one-tile **passage lanes** for the edges whose fallback line overlaps an intermediate room, with walls derived from the lane (generalizing #297's dogleg; see the margin-lane design note); (Chunk 3) a pure whole-layout topology-aware router that gives found edges non-crossing lanes, run after Chunk 2 so the edges it cannot place join the passage targets; (Chunk 4) west-incoming target geometry and the `pathaware` decision gate; (Chunk 5, optional) the path-aware west face; (Chunk 6) a `stubEdges` plan for edges that cannot be routed and may safely be dead ends; (Chunk 7) sole-child stubs, gated on #439. Everything that changes geometry or progression is behind run-state `layoutVersion` 3 (absent/1/2 keep today's behavior byte-for-byte).

**Tech Stack:** Node ES modules, vitest (`npm test` = `vitest run`), Foundry VTT module.

**Specs:** `docs/superpowers/specs/2026-10-01-boxed-in-corridor-routing-design.md` (its "Decisions" section is authoritative); `docs/superpowers/specs/2026-10-01-topology-aware-corridor-routing-design.md` (the router); `docs/superpowers/specs/2026-10-01-margin-lane-passage-design.md` (Phase 4, Chunk 2).

## Chunk order, dependencies and re-measurement

Reordered 2026-10-01 after user decisions Q-A (yes), Q-B (skip the joint rip-up experiment: old Task 1.4 dropped), Q-C (router after Phase 4).

| Chunk | Content | Was | Depends on | Re-measures on v3 geometry |
| --- | --- | --- | --- | --- |
| 0 | Harness, ratchets, oracle, live check | 0 | none | n/a (v2) |
| 1 | Prototypes, decision gate, Phase 4 design note | 1.1-1.4 | 0 | n/a (v2) |
| 2 | Phase 4: `incomingDoorOrder`, passage lane planner, (gate), scene wiring, v3 stamp | 4 (moved up) | 0, 1 | baselines for v3 start here; wiring (2.4-2.5) waits for the user gate 2.3 |
| 3 | Topology-aware router, `lanes`/`blockedCells`, combined ratchet | 1.5, 1.6 | 2 | passage served count, unresolvable count (U), cut ratchets to 0 |
| 4 | West-incoming target geometry; `pathaware` decision gate | 2 | 3 | west-face numbers, gate |
| 5 | Path-aware west face (optional) | 3 | 4 gate passes | gate rule K3 |
| 6 | Dead-end stubs | 5 | 2, 3 (eligible set measured on their output) | eligible count on null union U minus passage-served |
| 7 | Sole-child stubs | 6 | 6, #439 merged and live-verified | residual count |

Old to new task numbers: 1.5 to 3.1, 1.6 to 3.2, 2.1/2.2 to 4.1/4.2, 3.1 to 5.1, old Chunk 4 (4.1-4.4) is replaced by Chunk 2 (2.1-2.5, with the user decision gate at 2.3), 5.x to 6.x, 6.1 to 7.1. Comments on #427 and the version history refer to the old numbers; the table is the key.

## Global Constraints

- `module.json` `version` bumped on every merged PR: `git fetch origin` and read `origin/main:module.json` first, add one patch, never reuse a number (CLAUDE.md). Chunks 2 and 3 may be minor bumps.
- Commit messages end with `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`; PR bodies end with `🤖 Generated with [Claude Code](https://claude.com/claude-code)`.
- PR bodies and commits say `Refs #427` only. No `Fixes`/`Closes`/`Resolves`. Do not close #427 (the user verifies live). Merge with `gh pr merge <n> --squash --subject "<title>" --body "Refs #427"`.
- Run the `update-architecture-docs` skill in any chunk that adds, removes or rewires a `scripts/` file's imports (expected: none; chunks add exports to existing files and test helpers). Every PR below has an explicit docs step: either "ran update-architecture-docs" or "no import change, skill not needed" in the PR body.
- Issue labels: `planned` until the executor starts coding; the executor then applies `in progress` and removes `planned`, and removes `in progress` when paused or done. Update the #427 progress table in the same turn the state changes, terse (N/M and PR numbers only).
- Never symlink `node_modules` into a worktree (`npm ci`); copy `.env` from the main checkout into a new worktree before any live test.
- Every ratchet may only fall. A phase that raises any ratchet is not mergeable (spec K1). v3 ratchets start from the v2 values; any v3 baseline that differs from v2 must be stated and justified in the PR (the margin-lane note lists the ones it expects).
- Dimensions: `ROOM_SIZE_SMALL = 6`, `ROOM_SIZE_LARGE = 12`, `DOOR_WIDTH = 1`, `CORRIDOR_LEN = 1`, `ROW_STRIDE = COLUMN_STRIDE = 13`. Door spans are gap-START: `[p, p + DOOR_WIDTH)`, `p` an integer (#324).
- layoutVersion: `state.layoutVersion ?? 1`; version 2 is live (#415); this plan adds 3 for new runs only (spec Decision 4), stamped by the first Chunk 2 PR that changes geometry (Task 2.1). Existing runs keep their geometry. Later chunks that change v3 geometry accept the mixed-geometry risk noted in the margin-lane note (Q-E in the note) unless the user rules otherwise.
- Corridors of different targets never share floor and never touch without a wall on the shared boundary (spec Decision 2). Same-target corridors stay separate lanes (Decision 3).
- Target-room overlap ratchets count depth >= 2 only (an overlap area of 2 or more cells; the one-cell door tile in the rim is intended, Decision 5). Baseline 160 on today's main (170 when the spec was written).
- `buildEdgeCorridor`'s existing signature stays valid; new behavior is an optional trailing parameter (`tests/dungeon-layout.test.mjs` calls it directly).
- Sweep: 500 seeds via `tests/helpers/layout-sweep.mjs`, rest room spliced, real + hidden edges.
- Test first: every task below writes the failing test, runs it and sees it fail before the implementation step.

Baselines (re-measured 2026-10-01 on main 0.54.71, v2): 9,498 edges; null-path 2,052; intermediate-room overlap 1,132 (0 on found paths); multi-cell edges 2,063; shared transit cells 1,213; edges with a floor cut by another edge's flank 501 (814 occurrences); different-edge floor intersections 484; target door covered 0; deep (>= 2 cell) target overlap 160; source overlap 0; chain mismatch 0; lane conflicts 329 (#415 ceiling). (The spec's 9,930 / 2,470 / 1,316 / 2,077 / 526 / 861 / 510 / 170 were measured before #415 Chunk 5 pruned hidden shortcuts and #450's rebuild of the measurement helper.)

## Review Focus

- A stub on a source whose only real child is that edge soft-locks the party (the run only moves forward): `planStubs` must refuse it; test with a fixture where the source has one child (Task 6.1).
- A merge room whose every incoming edge is null must keep at least one connecting edge: `planStubs` may never stub the last routable parent (Task 6.1).
- A hidden shortcut stub, once revealed, must not become a progression edge (`revealTravelTimeEffect`): test that `state.edges` is unchanged after reveal (Task 6.3).
- Shuffled edge/room order must yield identical `incomingDoorOrder`, lane plan, router output and `stubEdges` (Tasks 2.1, 2.2, 3.1, 6.1).
- A run persisted before this change (layoutVersion 1 or 2, no `stubEdges`) must build byte-identical geometry (Tasks 2.4, 3.2, 6.4).
- A passage lane found by the search must be buildable: floor, flank walls, cell-border openings and door mouths all come from `passageLaneGeometry`, and the flood-fill oracle (not the router) is the acceptance check: 0 sealed doors, 0 cross-target connections, 0 leaks (Tasks 2.2, 2.4). This is the `trunkLaneCorridorSegments` and #297 Round 1 failure class.
- The lane planner's trigger (`needsPassage`) and its wall consumers share one helper; the scene's per-build plan equals the pure planner's on every seed (Tasks 2.2, 2.4, kill criterion K13).
- Eight corridors through one 13-wide border: the router's lane allocation must report infeasible, never overlap (Task 3.1).
- Unresolvable edges (no non-crossing route) must be handled exactly as null-class edges in v3 (Q-A, Tasks 3.2, 6.1), never drawn through shared floor (Task 3.1), and must be offered to the passage planner (Task 3.2).
- Re-routed edges must not change door slots or foreign margin openings silently: the slot/margin functions assume plain-occupancy paths (Task 3.1 open question; in v3 `incomingDoorOrder` and the lane planner replace the priority-swap path).

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

- [ ] **Step 1: Test.** For seed `sweep-10` (index 10), assemble, per transit cell `(0,2)`, the floors of both crossings and the cell's walls (containment from union openings plus every crossing's `plainWalls`), and assert the oracle's `reach` from the start of edge B's floor does NOT reach B's far end (the cut is real under the model), pinning that the two methods agree on the known sample. Expected today: B is severed. After Task 3.2 (router PR 3.2) the same test (flipped under a v3 plan) must show it connected; leave a `// flips in Task 3.2` (Task 3.2) comment naming it.
- [ ] **Step 2-4:** write, run (FAIL on the assertion shape until written correctly), pass.
- [ ] **Step 5: Commit** `test(#427): oracle confirms the known cut`.

### Task 0.5: Live check of a cut floor (authorized, user Q8)

**Files:** none (a note on #427). Use the `foundry-rest` skill.

- [ ] **Step 1:** Copy `.env` into the worktree. Compare the live world's module version with this branch's `module.json` (memory: stale Foundry version trap).
- [ ] **Step 2: Prefer read-only.** Find (offline) a layoutVersion 2 run seed containing the Task 0.4 shape, or use the user's existing v2 scene `vPjL50w7nUMOZIT3` and search its `Wall` documents for a transit cell crossed by two edges (`dungeonTransitCellMarginForCell` flags plus tiles with `dungeonTransitCellCrossing` for the same cell key). Then, via the REST relay or a script macro on the canvas, query collision without creating anything: `CONFIG.Canvas.polygonBackends.move.testCollision(a, b, { type: "move", mode: "any" })` between two points on one corridor floor that straddle the other edge's flank wall. Record: collision true or false, the wall ids hit.
- [ ] **Step 3: Only if the read-only query cannot answer,** create a throwaway scene (`Scene.create({ name: "tmp-427-livecheck" })`), copy only the needed walls and one token into it, run the test, then delete the scene. Verify cleanup: `game.scenes.getName("tmp-427-livecheck")` is `undefined` and the real scene's wall/tile/token counts equal their before-counts. Never move tokens in the real scene.
- [ ] **Step 4:** Post on #427: the exact queries run, results, and "changed nothing" or the exact list of created and deleted documents. If the result contradicts the oracle (cut not blocking), spec K5 applies: fix the oracle model before Task 3.2.

**Result (done 2026-10-01, read-only, nothing created or changed).** Live world: Foundry 14.368, module 0.54.49 (older than this branch). The user's scene `vPjL50w7nUMOZIT3` IS the `sweep-10` layout (its cell r0c2 holds edge A's west->south vertical lane with the same plain flank walls at x=326/327 as the sweep). Edge B's crossing is not built there yet (its rooms are not revealed), so the cut itself could not be exercised end to end. Instead `CONFIG.Canvas.polygonBackends.{move,sight}.testCollision(a, b, { type, mode })` was run on the scene's own walls (grid 100): (1) along A's lane `(326.5,3.5)->(326.5,11.5)`: no collision (move and sight); (2) across A's x=327 flank at B's row `(326.5,10.5)->(327.5,10.5)`: collision at x=327 (move and sight); (3) across both flanks `(325.5,10.5)->(327.5,10.5)`: collisions at x=326 and x=327; (4) open air control: none. So a flank wall lying inside another edge's floor blocks walking and sight, and walls along a lane's own boundary do not: the oracle's wall model holds (K5 not triggered). B's own flank cutting A (y=10, y=11) is the same wall type, not separately exercised.

### Task 0.6: Version bump, PR

- [ ] `git fetch origin`; set `module.json` to origin's version + one patch; `npm test` all green; commit; open PR "test(#427): buildability ratchets and oracle" with `Refs #427`; automerge with explicit `--subject/--body`. Update the #427 progress table.

---


---

## Chunk 1: prototypes, decision gate, Phase 4 design (DONE except 1.5's merge)

### Task 1.1 (PR B, DONE #450): lane feasibility prototype, K2 measured (tripped)

`tests/helpers/lane-prototype.mjs` (`edgeChains`, `makePlacer`, `assignLanes`) and its test. 204 of 2,063 multi-cell edges unresolvable against an allowance of 41.

### Task 1.2 (PR B', DONE): topology-aware router prototype, K2' measured (tripped)

`tests/helpers/topology-router.mjs`, `tests/dungeon-layout-topology-prototype.test.mjs`, the topology design note. 1,842 placed on their shortest path, 36 placed after re-routing, 185 unresolvable (9.0%), 0 crossings and 0 cuts among placed edges, +1.4% path length.

### Task 1.3 (decision gate, DONE 2026-10-01): Q-A, Q-B, Q-C recorded

- [x] Q-A yes: v3 treats unresolvable edges as null-class (combined boxed-in ratchet = null union unresolvable, starting 2,052 + 185 = 2,237 on the v2 sweep once the router ships).
- [x] Q-B skip: the joint rip-up experiment (old Task 1.4, K2'') is **dropped**; do not run it.
- [x] Q-C: the router ships AFTER Phase 4 (Chunk 3 follows Chunk 2).

### Task 1.4 (DROPPED, Q-B): joint rip-up-and-reroute prototype (K2'')

Not run. The user chose to skip it on 2026-10-01. Do not revive it without a new decision; the measured order sensitivity (a few percent of the unresolvable count) never suggested it would reach the allowance.

### Task 1.5 (docs PR, this PR): Phase 4 design note, passage prototype, plan reorder

**Files:** `docs/superpowers/specs/2026-10-01-margin-lane-passage-design.md`, this plan, `tests/helpers/passage-prototype.mjs`, `tests/dungeon-layout-passage-prototype.test.mjs`, `slotOrder`/`unresolvableIds` options on the existing test helpers (defaults unchanged).

- [x] Measure on 500 seeds, record the numbers in the note, bump `module.json`, one docs PR with `Refs #427`, set label `planned` after merge.

---

## Chunk 2: Phase 4, incoming door order and passage lanes (layoutVersion 3)

Design: `docs/superpowers/specs/2026-10-01-margin-lane-passage-design.md` (read it first, including its kill criteria K9-K13). Depends on Chunks 0 and 1. Every PR holds every v2 ratchet; the lane PRs ratchet the new passage numbers. The numbers in the tasks are the prototype's 500-seed upper bounds (note section 4); the real values replace them in the PR that first measures them. **The prototype says the lane half serves only about 17.5% of the overlap edges (193 of 1,101; 98% of the rest are sole-child), so Chunk 2 is split by a user decision gate (Task 2.3): Tasks 2.1-2.2 are cheap and measurable, Tasks 2.4-2.5 (scene wiring, the risky part) wait for the answer.**

### Task 2.1 (PR 2.1): `incomingDoorOrder` and the layoutVersion 3 stamp

**Files:** Modify `scripts/dungeon-layout.mjs` (new export `incomingDoorOrder`), `scripts/dungeon-scene.mjs` and `scripts/dungeon-layout.mjs` call sites that assign incoming door slots (`buildPopulateAndUnlockGraphNode`, `pendingForeignMarginOpenings`): under `layoutVersion >= 3` sort the incoming connections with `incomingDoorOrder` and skip `findPriorityCollision`/`assignDoorSlotsWithPriority`'s swap; `scripts/ui/dungeon-app.mjs` (stamp `layoutVersion: 3`); Test: `tests/dungeon-layout.test.mjs`, `tests/dungeon-layout-default-identical.test.mjs`, `tests/dungeon-layout-buildability.test.mjs`.

**Interfaces:** `incomingDoorOrder(connections, positionByRoomId, face) -> connections'` (new array, inputs unmutated): north face by source column ascending, ties by rank DESCENDING (nearer first); west face by source rank ascending, ties by column ascending; hidden last; source id as the last tie-break. Pure, no randomness.

- [ ] **Step 1: Tests (write, run, see them fail).** (a) The sweep-0 repro: the second parent east of the merge room gets the slot east of its co-parent's. (b) Shuffled input gives the identical order. (c) Hidden connections sort last. (d) A same-column farther source takes the east slot (the #297 dogleg's priority). (e) v1/v2: without the `layoutVersion >= 3` path the digest test is unchanged. (f) Sweep, v3 order, before any lane: every v2 ratchet in `tests/dungeon-layout-buildability.test.mjs` holds (K9). Measured by the prototype with the rank-descending tie-break: interOverlap 1,132 to 1,101, nullPath 2,052, cutOccurrences 814 to 819 (+5, K1 violation to resolve), cutEdges 501 to 500; with the rank-ascending tie-break: 1,115, cutOccurrences 814. Choose the variant that holds all ratchets; if neither does, stop (K9) and report.
- [ ] **Step 2:** run, expect FAIL. **Step 3:** implement. **Step 4:** PASS, full `npm test`. **Step 5:** `module.json` patch bump (check `origin/main` first); `update-architecture-docs` only if imports changed (expected none); commit; PR; automerge; update the #427 table. A NEW run is needed to see the order live; the user verifies.

### Task 2.2 (PR 2.2): `planPassageLanes` and `passageLaneGeometry`, pure

**Files:** Modify `scripts/dungeon-layout.mjs` (new exports `needsPassage`, `mouthTile`, `planPassageLanes`, `passageLaneGeometry`); Test: `tests/dungeon-layout.test.mjs`, `tests/dungeon-layout-buildability.test.mjs`, new `tests/fixtures/boxed-in-residual.json` written by a script or the test (not hand-edited).

**Interfaces:**
- `needsPassage({ nullPath, fallbackOverlapsOtherRoom, unresolvable }) -> boolean`, the single trigger; null path and (fallback overlaps a room other than source/target, or the router marked it unresolvable).
- `mouthTile(doorWall, face) -> { x, y }`: the unit tile just outside a door (south: below, north: above, east: right, west: left).
- `planPassageLanes({ seed, positionByRoomId, rectByRoomId, occupiedCells, edgeGeometry, targets }) -> Map<edgeId, { tiles, floors, walls, openingsByCell, doorMouths }>` where `edgeGeometry` is every non-target edge's built floors and mouths (as `visitEdges` produces) and `targets` is the list of passage targets in canonical order (target rank, target id, source id). Dijkstra over unit tiles, 4-neighbour, 1 per step plus 3 per turn, fixed neighbour order, bounded to the source/target cell box plus one cell, cost cap 400; obstacles are room tiles, other floors, other mouths and placed lanes.
- `passageLaneGeometry(tiles) -> { floors, walls, openingsByCell }`: floor rects (maximal runs), flank walls (every floor boundary not shared with the lane's own next/previous tile or one of its two doors), one opening per cell border crossed.

- [ ] **Step 1: Tests.** (a) A straight and an L-shaped tile list give the expected floors, walls and openings (hand-traced fixture). (b) `needsPassage` truth table. (c) The sweep-0 repro (`room-room-entry-1` to `room-merge-3`, positions verified to reproduce) gets a lane that ends exactly on its slot's mouth tile and never enters a room. (d) Order independence: reversed edge and room key order give a deep-equal plan; two builds equal. (e) Capacity: three targets needing one margin rail serve the first and report the others residual, never overlapping. (f) **Oracle**: for every served lane over 100 seeds, build floors and walls (`passageLaneGeometry` plus `cellMarginWalls`/`transitCellContainmentWalls` over the union of openings), run `buildFloorModel` and assert: lane connected door to door; no room tile, other edge's floor or other mouth reachable from it; no door sealed; no wall inside any floor. (g) Sweep ratchets on 500 seeds (set at the measured values, ceilings fall): `PASSAGE_SERVED_FLOOR`, `PASSAGE_RESIDUAL_CEILING`, intermediate overlap, lane length at most 1.15 times Manhattan, oracle counts 0. Prototype upper bound (500 seeds, approach order, overlap class only, unserved fallback lines respected): 193 served of 1,101, 908 residual, 96% of the residual blocked by other corridors' floors; K10 requires at least 145 served and every ratchet held.
- [ ] **Step 2:** FAIL. **Step 3:** implement (promote the prototype's Dijkstra; drop `relax`/cause waterfall). **Step 4:** PASS, full suite; K10/K12/K13 checks. **Step 5:** patch bump, `update-architecture-docs` only if imports changed (expected none), commit, PR, automerge, update the table.

### Task 2.3 (decision gate, no PR, USER DECISION): wire the lanes or stop

Run after Task 2.2 merges and before any scene wiring. The pure planner and the oracle now give the REAL (not
prototype) served count on the same 500 seeds, with real walls checked by the oracle.

- [ ] Record on #427: real served count vs the prototype's 193 of 1,101 (K10 floor: 145), residual count and
  causes, oracle results, and the sole-child fraction of the residual.
- [ ] **Stop and ask the user** (Q-D option B): wire the lanes now (Tasks 2.4-2.5), or wait until #439 lets stubs remove
  fallback lines (the prototype's upper bound with no fallback line is 468 of 1,101, 42.5%), or skip the lane
  wiring entirely. Do not start Task 2.4 without that answer.
- [ ] If K10 trips (served below 145, any ratchet rises, any oracle failure), stop and report; the fallback is to keep
  Task 2.1 (if K9 holds), leave the planner as a test-only helper, and mark the lane idea residual (the edges stay on
  the fallback line, v2 behaviour).

---

### Task 2.4 (PR 2.4): `passage` argument to `buildEdgeCorridor`, scene wiring, containment

**Files:** Modify `scripts/dungeon-layout.mjs` (`buildEdgeCorridor` trailing optional `passage`; `pendingForeignMarginOpenings` v3 variant reading `openingsByCell`), `scripts/dungeon-scene.mjs` (`buildPopulateAndUnlockGraphNode`: compute the whole-layout lane plan once per build pass from `state`, memoised on seed and layout digest, under `layoutVersion >= 3`; margin walls for occupied cells and transit-cell openings for empty ones from `openingsByCell`; a lane-less passage target keeps the existing fallback line); Test: `tests/dungeon-layout-default-identical.test.mjs` (v1/v2 digests unchanged), `tests/dungeon-scene.test.mjs`, the buildability sweep.

- [ ] **Step 1: Tests.** (a) Without `passage` the result deep-equals today's across the 500-seed sweep. (b) v3 sweep with lanes: every served lane passes the Task 2.2 oracle on the SCENE-built walls (not only the pure geometry); 0 sealed co-parent doors (the #297 Round 1 failure, was 375/380); every v2 ratchet holds; intermediate overlap falls by exactly the served overlap count; combined boxed-in count not above 2,052. (c) The scene's per-build lane plan equals the pure planner's on every seed (K13), built in topological room order and in reversed order. (d) A v2 state builds no lane and byte-identical geometry. (e) A layoutVersion 3 state with a served lane: the margin wall of the passed room has the extra opening, the empty cell it crosses has the extra opening, the lane's flank walls exist, and a token path (`findPath` over built walls) from the source door reaches the target door.
- [ ] **Step 2:** FAIL. **Step 3:** implement. **Step 4:** full `npm test`. **Step 5:** `module.json` minor bump (check `origin/main` first); run `update-architecture-docs` if any `scripts/` import changed; commit; PR; automerge; update the table. A NEW run is required to see a lane. Live check (user's): build a run from a seed whose layout contains a served lane (any `sweep-N` seed that the prototype serves; list two in the PR) and confirm a token can walk the lane and cannot leave it (K11 if the oracle disagrees).

### Task 2.5 (PR 2.5): ratchet down and write the residual set

- [ ] Lower `INTERMEDIATE_OVERLAP_CEILING` (v3) to the measured value; write `tests/fixtures/boxed-in-residual.json` (edge ids, source sole-child flag, cause: floors, mouths, order) so Chunk 6 consumes the exact set; patch bump; PR; automerge. Record the residual count and the stub-eligible subset on #427.

## Chunk 3: topology-aware router and lane plan (layoutVersion 3)

Design: `docs/superpowers/specs/2026-10-01-topology-aware-corridor-routing-design.md`. Depends on Chunk 2. **Re-measure first** on v3 geometry (incoming door order, passage lanes): the router prototype's 185 unresolvable edges were measured on v2; record the v3 count, how many the passage planner serves (they are routed after the router, as the last chords), and the combined boxed-in count (null union unresolvable minus lane-served). The v3 stamp already exists (Task 2.1); this chunk does not stamp.

Ratchets never loosen. The v3 ratchet for null paths is the combined boxed-in count (null union unresolvable); v1/v2 ratchets stay.

### Task 3.1 (PR 3.1): pure `routeEdgesTopologyAware` in `scripts/dungeon-layout.mjs`

**Files:** Modify `scripts/dungeon-layout.mjs` (new exports after `transitCellCrossing`; optional `blockedCells`
option on `findCorridorPath`, default unchanged); Test: `tests/dungeon-layout.test.mjs` (new
`describe('routeEdgesTopologyAware (#427)')`).

**Interfaces:**
- Consumes: `buildEdgeCorridor`, `findCorridorPath`, `cellBounds`, `incomingConnectionsFor`, `outgoingDoorPlan`.
- Produces: `routeEdgesTopologyAware({ seed, positionByRoomId, occupiedCells, layoutEdges, hiddenIncomingByRoomId,
  incomingFaceByRoomId, planFor, slotsForRoom, maxTries = 40 }) -> { lanes: Map<edgeId, Map<"rank,col", { entryPoint,
  exitPoint }>>, blockedByEdge: Map<edgeId, string[]>, unresolvable: [edgeId] }`. `edgeId` is `${from}->${to}`.
  Canonical order: target rank, target id, source id. Door ends pinned. Border capacity 13 lanes.

- [ ] **Step 1: Tests (write, run, see them fail).**
  1. Two parallel pinned straight edges through one cell get distinct offsets, never intersect.
  2. A cell-local N-S vs W-E pair: the later edge is re-routed or reported unresolvable, never merged.
  3. The sweep-10 pair (A west to south over r0c1+r0c2, B south to east): not both placed on shortest paths; the
     result is deterministic.
  4. Order independence: reverse the key order of `layoutEdges` and the room map; the result deep-equals.
  5. Capacity: 14 straight crossings through one border report the excess unresolvable, without overlap.
  6. Sweep (500 seeds, v2 inputs): every placed edge has 0 floor crossings and 0 cut occurrences by the real
     wall/floor check (`measureBuildability`'s `cuts`/overlap logic on the lane output); unresolvable count equals the
     prototype's 185 (+/- the section 3 unknown, K8: more than 25% above stops the chunk); extra path length under
     3% (K7); found-path intermediate overlap 0.
- [ ] **Step 2:** run, expect FAIL. **Step 3:** implement (promote the prototype's placer and blocked-cell search;
  pure, no scene use). **Step 4:** PASS, full `npm test`. **Step 5:** `module.json` patch bump (check origin/main
  first, never reuse); commit; PR; automerge; update the #427 table.
- **Open question to settle in this PR, with a measurement:** slot/margin functions (`findPriorityCollision`,
  `assignDoorSlotsWithPriority`, `outgoingMarginOffset`, `pendingForeignMarginOpenings`) call `findCorridorPath` on
  plain occupancy. Measure on the sweep how many re-routed edges change first or last hop face; if any, either
  restrict re-routes to keep both hops (re-measure U) or re-derive slots after routing. Record the choice and the
  numbers in the design note.

### Task 3.2 (PR 3.2): `lanes`/`blockedCells` on `buildEdgeCorridor`, scene wiring, layoutVersion 3

**Files:**
- Modify: `scripts/dungeon-layout.mjs` (`buildEdgeCorridor` trailing optional `routing` parameter `{ lanes, blockedCells }`:
  occupied cells plus `blockedCells` go to `findCorridorPath`; `lanes.get(edgeId)` supplies `forcedEntryPoint`/
  `forcedExitPoint` per cell)
- Modify: `scripts/dungeon-scene.mjs` (`buildPopulateAndUnlockGraphNode`: compute the routing once from state when
  `layoutVersion >= 3`; unresolvable edges follow the existing null-path fallback, Q-A)
- Modify: `scripts/ui/dungeon-app.mjs` (stamp `layoutVersion: 3`; add a test for the stamp if feasible)
- Modify: `tests/dungeon-layout-default-identical.test.mjs` (the v1/v2 digests must NOT change)

- [ ] **Step 1: Tests (write, run, see them fail).** (a) Without `routing` the result deep-equals today's across
  the 500-seed sweep (digests unchanged). (b) v3 sweep with routing: `cutEdges`, `cutOccurrences`, `floorCrossings`
  ratchets drop to 0 for placed edges (ratchet them at the measured value; residual edges, if any, counted in a
  `LANE_RESIDUAL_CEILING`); the combined boxed-in ratchet (null union unresolvable) is set at the measured value and
  may only fall; `targetDoorCovered`, `chainMismatch`, `sourceOverlap` stay 0; deep target overlap stays <= 160;
  intermediate overlap on found paths 0. (c) The two oracle tests marked "flips in Task 3.2" in
  `tests/dungeon-layout-buildability.test.mjs` flip to "connected" under a v3 plan. (d) Buildability sweep: no new
  door or wall leaks (oracle). (e) A layoutVersion-3 stamp test where feasible.
- [ ] **Step 2:** FAIL. **Step 3:** implement. **Step 4:** full `npm test`. **Step 5:** `module.json` minor bump
  (check origin/main first); `update-architecture-docs` if any `scripts/` import changed (expected none); commit;
  PR; automerge; update the #427 table. A NEW run is required to verify live.

---


- [ ] **Task 3.2 addition (Q-A, passage targets):** the router's `unresolvable` list is handed to the Chunk 2 lane planner as extra passage targets (`needsPassage` gains `unresolvable`); the lane planner runs after the router on the router's floors. Test: every unresolvable edge is either served a lane or counted in the combined boxed-in ratchet; no unresolvable edge is drawn through shared floor.

---


## Chunk 4 (PR 4.1): west-incoming target geometry

Depends on Task 3.2 (router PR 3.2) merged (it runs under the v3 router/`lanes`). The router changes the set of found paths, so re-measure the west-face numbers (7 covered doors, deep overlaps) on v3 geometry at the start of the chunk before trusting the figures below.

### Task 4.1: Covered west doors and deep overlaps, test first

**Files:**
- Modify: `scripts/dungeon-layout.mjs` (`buildEdgeCorridor` west-incoming corner and multi-cell branches; `cornerConnector` degenerate leg)
- Test: `tests/dungeon-layout-buildability.test.mjs`

- [ ] **Step 1: Tests.** Using the sweep helper override `incomingFace: (id, layout) => west-or-north-by-pathaware` (a test-local function: choose the face with fewer `findCorridorPath` nulls over the room's incoming connections, tie north), assert under `lanes`: `targetDoorCovered === 0` (today 7: `sweep-25` `room-room-room-entry-0-0 -> room-merge-9`, `sweep-59`, `sweep-177`) and `targetOverlapDeep <= 170` (today 562 under this override). Also assert today's default faces: `targetOverlapDeep` falls from 170 toward 0 (ratchet at the new measured value; target 0).
- [ ] **Step 2:** FAIL. **Step 3:** fix the geometry so the last transit cell's gap equals the west door span and the final connector never extends past the rim. Gate behind `layoutVersion >= 3` via the optional-parameter pattern (a `geometryVersion` field on the options object, default 2).
- [ ] **Step 4:** PASS, full suite. **Step 5:** version bump; commit; PR; automerge. Fold the west-incoming part of #416 here and comment on #416.

### Task 4.2: Decision gate (measurement, no PR)

- [ ] Re-run Task 0.2's measurement with the `pathaware` override on v3 geometry. Record nulls, intermediate overlaps, cuts, doors, deep overlaps on #427. Rule (spec K3): if intermediate overlaps do not fall by >= 15% (about 200) with every other ratchet held, mark Chunk 5 dropped.

---


## Chunk 5 (PR 5.1, optional): path-aware `incomingFaceForV3`

Only if Task 4.2 passes.

### Task 5.1: `incomingFaceForV3`

**Files:** Modify `scripts/dungeon-layout.mjs` (new export; `incomingFaceFor` untouched), `scripts/ui/dungeon-app.mjs` (use it when stamping v3), tests.

**Interfaces:** `incomingFaceForV3(roomId, layout) -> 'north'|'west'`: for each face run `findCorridorPath` over the room's `incomingConnectionsFor` entries with that face; fewer nulls wins, tie north.

- [ ] Tests: tie keeps north; a room whose only unreachable-north edges are reachable via west picks west; pure and order-independent; sweep: nulls <= 1,794 and every Chunk 2-4 ratchet unchanged. Implement, run, version bump, PR.

---


## Chunk 6 (PRs 6.1-6.3): dead-end stub (user Decision 6)

**Router interaction.** `planStubs`' `nullEdges` input is null-path edges union the router's `unresolvable` edges (Q-A); re-measure the eligible count (464 today, null set only) on that union at the start of this chunk and keep the K6 invariants unchanged.

**Dependency split (user Decision 9).** Chunks 0-5 and Chunk 6 as written below (non-sole-child stubs, about 464 edges today) do NOT depend on #439. A sole-child source (1,952 null edges) becomes stub-eligible only once the retreat feature #439 (a way back to the last fork) has landed; that is Chunk 7 below and must not start before #439 is merged and live-verified. Until then `planStubs` is called with `retreatAvailable: false` and the eligibility rule is exactly as in the spec.

Stub decisions (user, Decisions 10-12): the stub door is locked and unlocked exactly like a real door, indistinguishable from one, with no extra check, skill roll or time cost; false shortcuts (a revealed hidden door leading to a stub) are allowed; flavor is collapsed rubble, `dungeonStubFlavor` is always `'rubble'`, and the end cap uses the rubble corridor-cap tile from #438. Until #438 ships the existing corridor tile is the placeholder: reference the asset through one constant (`STUB_CAP_TILE`) so swapping it is a one-line change.

Spec section "Dead-end stub". Behind layoutVersion 3.

### Task 6.1 (PR 6.1): `planStubs` pure function

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
- [ ] **Step 2:** FAIL. **Step 3:** implement (graph BFS, canonical order, no randomness). **Step 4:** PASS. **Step 5:** commit; version bump; PR 6.1.

### Task 6.2 (PR 6.1): stub geometry, pure

**Files:** Modify `scripts/dungeon-layout.mjs`; tests.

**Interfaces:** `stubGeometry(seed, sourceId, targetId, sourceRect, sourcePos, doorSpan, siblingFloors) -> { floor: [{gx,gy,gw,gh}], walls: [{x1,y1,x2,y2}], flavor: 'rubble', length }`. Floor is the door-cell tile directly below the south-face `doorSpan` plus up to 3 horizontal cells in the margin row toward the target's side, ending at least one cell short of the cell boundary, never intersecting `siblingFloors`; end cap and flank walls; `length` in 1..4; flavor (always 'rubble') and length from `splitmix32(seedFromString(`${seed}-stub-${sourceId}->${targetId}`))`.

- [ ] Tests: sweep over all planned stubs: floor inside the source cell and its margin row, no overlap with ANY room rect (including intermediate rooms and the source interior), no edge-adjacency to another floor without a wall (`floor-oracle`), deterministic under shuffled sibling order, length in range, `siblingFloors` respected (shortens to 1). Implement; PASS; commit.

### Task 6.3 (PR 6.2): progression filters and state

**Files:** `scripts/ui/dungeon-app.mjs` (precompute: derive `nullEdges`, call `planStubs`, store `stubEdges`, remove stub edges from the stored `edges` but not `layoutEdges`, v3 only); `scripts/dungeon-layout.mjs` (`incomingConnectionsFor(layoutEdges, roomId, hiddenIncomingByRoomId, stubEdges = {})` filters stubs); `scripts/dungeon-deck.mjs` (`revealTravelTimeEffect` skips stub targets); `scripts/dungeon-scene.mjs` (`outgoingPlanFromState` includes stub children for door slots; `unlockDoorsFromRoom` also unlocks `dungeonStubDoorFor` doors).

- [ ] **Step 1: Tests.** `incomingConnectionsFor` with `stubEdges` drops the stub source (and without the 4th argument is unchanged); `revealTravelTimeEffect` leaves `edges` untouched for a stub target and still returns `revealedRoomId: null`; `advanceToRoom` refuses a stub child; `roomsToEagerlyBuild` order is identical with and without stubs (layoutEdges unchanged); a v1/v2 state round-trips byte-identical.
- [ ] **Step 2-4:** FAIL, implement, PASS. **Step 5:** commit; version bump; PR 6.2.

### Task 6.4 (PR 6.3): scene build of the stub

**Files:** `scripts/dungeon-scene.mjs` (`buildRoomAtGraphNode`: for each `stubEdges[roomId]` build `stubGeometry` walls and floor tiles after the room's real edges, a door wall, locked at build and unlocked by the source's resolution exactly like a real door (no extra check, roll or time cost; same look as a real door), with flags `{ dungeonStubDoorFor: targetId, dungeonDoorFromRoomId: roomId, dungeonStubFlavor }`; `handleDungeonDoorOpened`: when a `dungeonStubDoorFor` door opens, post the flavor chat line once and return `{ autoOpenTracker: false }`); art: the cap tile is the #438 rubble tile via the `STUB_CAP_TILE` constant; until #438 ships it points at the existing corridor tile (placeholder).

- [ ] **Step 1: Tests** (existing scene test style in `tests/dungeon-scene.test.mjs`): a source with a stub gets the door wall with the three flags, the end-cap walls, and tiles; the door is locked at build and CLOSED after `unlockDoorsFromRoom`, with the same door type/art as a real door, and opening it triggers no roll or time cost; opening it never calls `advanceToRoom` or reveals tokens; a layoutVersion 2 state builds no stub.
- [ ] **Step 2-4:** FAIL, implement, PASS, full suite. **Step 5:** `update-architecture-docs` only if imports changed; minor version bump; PR 6.3; comment that a NEW run is required to see a stub and that live verification (a stub door opens to a dead end, party still progresses via the other child) is the user's.

### Task 6.5: Whole-sweep acceptance

- [ ] Add to the buildability test: for all 500 seeds, K6 invariants (goal reachable over non-stub edges, no stranded room), 0 stub/room overlaps, `stubbedEdges <= 464` before Chunk 2 and the measured value after it. Commit with the last PR.

---


## Chunk 7 (PR 7.1): sole-child stubs, gated on #439

**Do not start until #439 (retreat to the last fork) is merged and live-verified by the user.**

### Task 7.1: Enable `retreatAvailable`

**Files:** Modify `scripts/ui/dungeon-app.mjs` (pass `retreatAvailable: true` to `planStubs` under the run-state flag or layoutVersion that #439's merged spec defines; read it and use it, do not invent one); tests in `tests/dungeon-layout.test.mjs` and the Task 6.5 acceptance sweep.

- [ ] **Step 1: Tests.** With `retreatAvailable: true`, the 500-seed sweep stubs the previously-ineligible sole-child edges that satisfy rules 1 and 3, the K6 invariants still hold (goal reachable over non-stub edges plus retreat as #439 defines it; no room unreachable), stub/room overlap is 0, and the residual direct-line edge count falls (new ratchet at the measured value). A run without the flag behaves exactly as Chunk 6.
- [ ] **Step 2-4:** FAIL, implement, PASS, full suite. **Step 5:** version bump; commit; PR 7.1; automerge; update the #427 table.

---

