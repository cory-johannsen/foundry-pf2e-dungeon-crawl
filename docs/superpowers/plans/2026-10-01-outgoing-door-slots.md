# Outgoing Door Slots Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** No corridor of any real or hidden edge is ever drawn inside its own source room, by choosing each edge's exit face from the target's direction and letting one face carry several doors.

**Architecture:** A new pure function `outgoingDoorPlan` (scripts/dungeon-layout.mjs) is the single source of truth for every outgoing door: face (`south` for any target not in a higher column, `east` for a higher-column target), slot, and door position. Every consumer (enclosure walls, margin openings, placeholders, `buildEdgeCorridor`) reads it. A persisted `layoutVersion` (absent = 1) gates the new behavior so existing runs keep today's geometry. Single-door faces stay byte-identical to today.

**Tech Stack:** Node ES modules, vitest (`npm test` = `vitest run`), Foundry VTT module.

**Spec:** `docs/superpowers/specs/2026-10-01-outgoing-door-slots-design.md` (decisions section is authoritative: west dropped, existing runs ignored, no merged corridor floors, target-room overlap ratcheted and fixed under #416).

## Global Constraints

- `module.json` `version` bumped on every merged PR; fetch `origin/main` first, never reuse a number (CLAUDE.md). Patch bump per chunk.
- Commit messages end with `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`; PR bodies end with `🤖 Generated with [Claude Code](https://claude.com/claude-code)`.
- PR bodies and commits say `Refs #415` only: no `Fixes`/`Closes`/`Resolves` anywhere. Do not close #415 (user verifies live).
- Automerge each PR: `gh pr merge <n> --squash --subject "<title>" --body "Refs #415"`.
- Run the `update-architecture-docs` skill in any chunk that adds, removes or rewires a `scripts/` file's imports (expected: none; this plan only adds exports to existing files and a test helper).
- Issue labels: `planned` while this plan is unstarted; the executor applies `in progress` when it begins coding, removes it when done.
- Never symlink `node_modules` into a worktree (`npm ci`); copy `.env` from the main checkout into new worktrees.
- Outgoing faces are only `south` and `east`; `north`/`west` are never assigned. `DOOR_WIDTH = 1`, `CORRIDOR_LEN = 1`, even columns, `ROW_STRIDE = COLUMN_STRIDE = 13`.
- `buildEdgeCorridor`'s existing signature must stay valid: new behavior is opt-in through an optional trailing parameter, because `tests/dungeon-layout.test.mjs` (~4,000 lines) calls it directly.
- Gap-START door semantics (#324): a door span is `[p, p + DOOR_WIDTH)`, one whole cell, `p` an integer.

## Review Focus

- A room with three outgoing edges (max seen) on a 6-wide face: three doors, one cell each, slots 2 wide; none may overlap or fall outside the face. Test: plan invariants sweep (Task 2.3).
- A source with two lower-column targets: corridors cannot stay separate in the 1-deep margin row (spec Open question 5). Expected: a measured lane-conflict ratchet, not a silent pass (Task 1.2, Chunk 5).
- A hidden edge from a room that also has a real south edge: both on south, two doors, hidden placeholder must be `LOCKED` and cover only its own span (Task 4.2).
- `edges` key order or hidden-list order reshuffled: identical plan (Task 2.3).
- A merge room (several incoming slots) reached from a source with several outgoing doors: door and incoming slot independent, no wall covers either (buildability test, Task 4.3).
- A run persisted before this change (no `layoutVersion`): untouched geometry (Task 4.1).

---

## Chunk 1 (PR A): sweep harness and ratchets, no behavior change

### Task 1.1: Shared sweep helper mirroring the scene

**Files:**
- Create: `tests/helpers/layout-sweep.mjs`
- Test: `tests/layout-sweep-helper.test.mjs`

**Interfaces:**
- Produces: `rectsOverlap(a, b)`, `buildSweepLayout(i)` returning `{ seed, rooms, edges, hiddenEdges, hiddenRooms, layoutEdges, hiddenIncomingByRoomId, pos, occ, rect, incFace }`, `legacyExitSelector(layout, conn)` returning `{ face, exitDoor: undefined }`, and `forEachEdge(seedCount, exitSelector, visit)` calling `visit({ layout, sourceId, toId, hidden, face, exitDoor, toSlot, result, segments })`. `exitSelector(layout, conn)` receives `conn = { sourceId, toId, hidden }`.

- [ ] **Step 1: Write the failing test**

```js
// tests/layout-sweep-helper.test.mjs
import { describe, it, expect } from 'vitest';
import { forEachEdge, legacyExitSelector, rectsOverlap } from './helpers/layout-sweep.mjs';

describe('layout sweep helper', () => {
  it('visits real and hidden edges with a result and segments', () => {
    let n = 0; let hidden = 0;
    forEachEdge(20, legacyExitSelector, ({ result, segments, hidden: h }) => {
      n += 1; if (h) hidden += 1;
      expect(result.corridorSegments.length).toBeGreaterThan(0);
      expect(segments.length).toBeGreaterThanOrEqual(result.corridorSegments.length);
    });
    expect(n).toBeGreaterThan(50);
    expect(hidden).toBeGreaterThan(0);
  });
  it('rectsOverlap is strict', () => {
    expect(rectsOverlap({ gx: 0, gy: 0, gw: 2, gh: 2 }, { gx: 2, gy: 0, gw: 2, gh: 2 })).toBe(false);
    expect(rectsOverlap({ gx: 0, gy: 0, gw: 2, gh: 2 }, { gx: 1, gy: 1, gw: 2, gh: 2 })).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/layout-sweep-helper.test.mjs`
Expected: FAIL, cannot resolve `./helpers/layout-sweep.mjs`.

- [ ] **Step 3: Write the helper**

```js
// tests/helpers/layout-sweep.mjs
// Mirrors buildPopulateAndUnlockGraphNode (scripts/dungeon-scene.mjs ~1128-1230)
// and the precompute in scripts/ui/dungeon-app.mjs (~500-530), so a sweep sees
// exactly what a real run builds. The older #174 sweeps do NOT: they skip
// hidden edges, exclude an edge's own endpoints and use one north slot.
import { buildRoomGraph, attachHiddenPaths } from '../../scripts/dungeon-deck.mjs';
import {
  computeRanks, computeColumns, roomRect, incomingFaceFor, parentRoomIdsFor,
  incomingConnectionsFor, findPriorityCollision, assignDoorSlotsWithPriority,
  exitFaceForIndex, buildEdgeCorridor,
} from '../../scripts/dungeon-layout.mjs';

export function rectsOverlap(a, b) {
  return a.gx < b.gx + b.gw && a.gx + a.gw > b.gx && a.gy < b.gy + b.gh && a.gy + a.gh > b.gy;
}

export function buildSweepLayout(i) {
  const seed = `sweep-${i}`;
  const roomCount = 6 + (i % 15);
  const { rooms, edges } = buildRoomGraph({ seed, roomCount });
  const { layoutEdges, hiddenIncomingByRoomId, hiddenEdges, hiddenRooms } = attachHiddenPaths({ rooms, edges, seed });
  const ranks = computeRanks(layoutEdges, 'room-entry');
  const cols = computeColumns(layoutEdges, ranks, 'room-entry');
  const ids = Object.keys(rooms);
  const pos = Object.fromEntries(ids.map((id) => [id, { rank: ranks[id], col: cols[id] }]));
  const occ = Object.fromEntries(Object.entries(pos).map(([id, p]) => [`${p.rank},${p.col}`, id]));
  const rect = Object.fromEntries(ids.map((id) => [id, roomRect(seed, id, pos[id].rank, pos[id].col)]));
  const incFace = Object.fromEntries(ids.map((id) => [id, incomingFaceFor(
    id, pos, occ,
    new Set([...parentRoomIdsFor(layoutEdges, id), ...(hiddenIncomingByRoomId[id] ?? [])]),
  )]));
  return { seed, rooms, edges, hiddenEdges: hiddenEdges ?? {}, hiddenRooms: hiddenRooms ?? [], layoutEdges, hiddenIncomingByRoomId, pos, occ, rect, incFace };
}

/** Today's selection: face by child index (dungeon-scene.mjs ~1219). */
export function legacyExitSelector(layout, { sourceId, toId, hidden }) {
  const kids = layout.edges[sourceId] ?? [];
  const sf = layout.incFace[sourceId];
  const face = hidden ? exitFaceForIndex(kids.length, sf) : exitFaceForIndex(kids.indexOf(toId), sf);
  return { face, exitDoor: undefined };
}

export function forEachEdge(seedCount, exitSelector, visit) {
  for (let i = 0; i < seedCount; i += 1) {
    const layout = buildSweepLayout(i);
    const { seed, pos, occ, rect, incFace, layoutEdges, hiddenIncomingByRoomId, hiddenRooms } = layout;
    for (const toId of Object.keys(layout.rooms)) {
      const isDetour = hiddenRooms.includes(toId);
      const conns = incomingConnectionsFor(layoutEdges, toId, hiddenIncomingByRoomId)
        .map((c) => (isDetour ? { ...c, hidden: true } : c));
      if (!conns.length) continue;
      const face = incFace[toId];
      const collision = findPriorityCollision(seed, toId, pos[toId].rank, pos[toId].col, conns, pos, occ, face);
      const slots = assignDoorSlotsWithPriority(seed, rect[toId], conns, face, collision);
      conns.forEach(({ sourceId, hidden }, k) => {
        const sel = exitSelector(layout, { sourceId, toId, hidden });
        if (sel.face == null) return; // legacy index past the candidate list; not a built edge
        const result = buildEdgeCorridor(
          seed, sourceId, toId, rect[sourceId], rect[toId], pos[sourceId], pos[toId],
          sel.face, slots[k], occ, face, sel.exitDoor,
        );
        const segments = [...result.corridorSegments, ...result.transitCells.flatMap((c) => c.corridorSegments)];
        visit({ layout, sourceId, toId, hidden, face: sel.face, exitDoor: sel.exitDoor, toSlot: slots[k], result, segments });
      });
    }
  }
}
```

(The trailing `sel.exitDoor` argument is ignored by today's `buildEdgeCorridor`; Chunk 3 makes it real.)

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/layout-sweep-helper.test.mjs`
Expected: PASS. If `attachHiddenPaths` does not return `hiddenEdges`/`hiddenRooms` under those names, fix the destructure (dungeon-app.mjs ~500 shows the real names).

- [ ] **Step 5: Commit**

```bash
git add tests/helpers/layout-sweep.mjs tests/layout-sweep-helper.test.mjs
git commit -m "test(#415): scene-mirroring layout sweep helper

Refs #415

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

### Task 1.2: Source-overlap, target-overlap and lane-conflict ratchets

**Files:**
- Create: `tests/dungeon-layout-endpoints.test.mjs`

**Interfaces:**
- Consumes: Task 1.1 exports.
- Produces: exported-by-convention constants `SOURCE_OVERLAP_CEILING`, `TARGET_OVERLAP_CEILING`, `LANE_CONFLICT_CEILING` in this test file; later chunks lower them (Chunk 4 sets the source one to 0).

- [ ] **Step 1: Write the failing test (zero source overlap)**

```js
// tests/dungeon-layout-endpoints.test.mjs
import { describe, it, expect } from 'vitest';
import { forEachEdge, legacyExitSelector, rectsOverlap } from './helpers/layout-sweep.mjs';

const SEEDS = 500;
const SOURCE_OVERLAP_CEILING = 0; // goal; Step 3 sets the measured value

function measure(selector) {
  const m = { edges: 0, source: 0, target: 0, lane: 0, bySource: new Map() };
  forEachEdge(SEEDS, selector, ({ layout, sourceId, toId, segments }) => {
    m.edges += 1;
    if (segments.some((s) => rectsOverlap(s, layout.rect[sourceId]))) m.source += 1;
    if (segments.some((s) => rectsOverlap(s, layout.rect[toId]))) m.target += 1;
    const key = `${layout.seed}|${sourceId}`;
    if (!m.bySource.has(key)) m.bySource.set(key, []);
    m.bySource.get(key).push(segments);
  });
  for (const lists of m.bySource.values()) {
    for (let a = 0; a < lists.length; a += 1) {
      for (let b = a + 1; b < lists.length; b += 1) {
        if (lists[a].some((x) => lists[b].some((y) => rectsOverlap(x, y)))) m.lane += 1;
      }
    }
  }
  return m;
}

describe('corridors never lie inside their own endpoints (#415)', () => {
  const legacy = measure(legacyExitSelector);
  it('sweep is non-vacuous', () => { expect(legacy.edges).toBeGreaterThan(8000); });
  it('no corridor segment of any real or hidden edge overlaps its own SOURCE room', () => {
    expect(legacy.source).toBeLessThanOrEqual(SOURCE_OVERLAP_CEILING);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/dungeon-layout-endpoints.test.mjs`
Expected: FAIL on the SOURCE test, about 678 (matches the investigation; record the exact number printed by the failure).

- [ ] **Step 3: Turn the failure into measured ratchets**

Replace `SOURCE_OVERLAP_CEILING = 0` with the exact failing number from Step 2, and add (numbers measured by one run of `console.log(legacy.target, legacy.lane)` printed once, then removed):

```js
const TARGET_OVERLAP_CEILING = /* measured, ~2046; fixed under #416 */ 0;
const LANE_CONFLICT_CEILING = /* measured pair count */ 0;
```

with tests `expect(legacy.target).toBeLessThanOrEqual(TARGET_OVERLAP_CEILING)` and `expect(legacy.lane).toBeLessThanOrEqual(LANE_CONFLICT_CEILING)`, each with a comment `// ratchet: may only fall` and a pointer to #416 / spec Open question 5. The literal `0` placeholders above must be replaced by the measured integers before committing.

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/dungeon-layout-endpoints.test.mjs && npm test`
Expected: PASS, full suite green.

- [ ] **Step 5: Version bump, commit, PR**

Bump `module.json` patch (check `git fetch origin && git show origin/main:module.json | grep version` first).

```bash
git add tests/dungeon-layout-endpoints.test.mjs module.json
git commit -m "test(#415): ratchet corridor-overlap sweep over real and hidden edges

Refs #415

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
gh pr create --title "test(#415): endpoint overlap sweep ratchets" --body "Refs #415

🤖 Generated with [Claude Code](https://claude.com/claude-code)"
gh pr merge <n> --squash --subject "test(#415): endpoint overlap sweep ratchets" --body "Refs #415"
```

---

## Chunk 2 (PR B): pure door plan, unused by the scene

### Task 2.1: `outgoingSlotsForFace`

**Files:**
- Modify: `scripts/dungeon-layout.mjs` (add export after `doorSlotsForFace`, ~line 234)
- Test: `tests/dungeon-layout.test.mjs` (append a describe; imports at the top already include `doorSlotsForFace`, add the new names)

**Interfaces:**
- Produces: `outgoingSlotsForFace(rect, count, face)` -> `Array<{x1,y1,x2,y2}>`; `face` is `'south'` or `'east'` (throws otherwise).

- [ ] **Step 1: Write the failing test**

```js
describe('outgoingSlotsForFace (#415)', () => {
  const rect = { gx: 300, gy: 13, gw: 6, gh: 6 };
  it('splits the south face left to right', () => {
    expect(outgoingSlotsForFace(rect, 3, 'south')).toEqual([
      { x1: 300, y1: 19, x2: 302, y2: 19 },
      { x1: 302, y1: 19, x2: 304, y2: 19 },
      { x1: 304, y1: 19, x2: 306, y2: 19 },
    ]);
  });
  it('splits the east face top to bottom', () => {
    expect(outgoingSlotsForFace(rect, 2, 'east')).toEqual([
      { x1: 306, y1: 13, x2: 306, y2: 16 },
      { x1: 306, y1: 16, x2: 306, y2: 19 },
    ]);
  });
  it('rejects faces that are never outgoing', () => {
    expect(() => outgoingSlotsForFace(rect, 1, 'west')).toThrow();
    expect(() => outgoingSlotsForFace(rect, 1, 'north')).toThrow();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/dungeon-layout.test.mjs -t "outgoingSlotsForFace"`
Expected: FAIL, `outgoingSlotsForFace is not a function`.

- [ ] **Step 3: Implement**

```js
/** Outgoing counterpart of doorSlotsForFace (#415): equal contiguous slots
 * along a room's south (left to right) or east (top to bottom) face. West and
 * north are never outgoing faces. */
export function outgoingSlotsForFace(rect, count, face) {
  const { gx, gy, gw, gh } = rect;
  if (face === 'east') {
    const step = gh / count;
    return Array.from({ length: count }, (_, i) => ({
      x1: gx + gw, y1: gy + i * step, x2: gx + gw, y2: gy + (i + 1) * step,
    }));
  }
  if (face === 'south') {
    const step = gw / count;
    return Array.from({ length: count }, (_, i) => ({
      x1: gx + i * step, y1: gy + gh, x2: gx + (i + 1) * step, y2: gy + gh,
    }));
  }
  throw new Error(`outgoingSlotsForFace: unsupported face ${face}`);
}
```

- [ ] **Step 4: Run to verify it passes**, then **Step 5: commit** (`feat(#415): outgoingSlotsForFace`, same trailer; no PR yet, Chunk 2 ships as one PR).

### Task 2.2: `outgoingDoorPlan`

**Files:**
- Modify: `scripts/dungeon-layout.mjs` (after `outgoingSlotsForFace`; uses the file's own `clampDoorStart`, `DOOR_WIDTH`)
- Test: `tests/dungeon-layout.test.mjs`

**Interfaces:**
- Consumes: `outgoingSlotsForFace`.
- Produces: `outgoingDoorPlan(rect, pos, { realChildIds, hiddenChildIds }, positionByRoomId)` -> `Map<targetId, { face, slotIndex, slot, doorCount, exitPoint, doorSpan }>`. `exitPoint`/`doorSpan` are `null` when the face has exactly one door (legacy path decides; byte-identical). `exitPoint` is gap-START `{x,y}`; `doorSpan` is `{x1,y1,x2,y2}` one cell long. `seed`/`roomId` are not needed: the plan uses no seeded values (spec: no new seeded values).

- [ ] **Step 1: Write the failing tests**

```js
describe('outgoingDoorPlan (#415)', () => {
  const rect = { gx: 300, gy: 13, gw: 6, gh: 6 };
  const pos = { rank: 1, col: 0 };
  const P = (rank, col) => ({ rank, col });
  it('uses south for same-column and lower-column targets, east for higher-column', () => {
    const plan = outgoingDoorPlan(rect, { rank: 1, col: 2 }, { realChildIds: ['a', 'b'], hiddenChildIds: [] },
      { a: P(2, 2), b: P(3, 4) });
    expect(plan.get('a').face).toBe('south');
    expect(plan.get('b').face).toBe('east');
  });
  it('never assigns west or north', () => {
    const ids = ['a', 'b', 'c'];
    const plan = outgoingDoorPlan(rect, pos, { realChildIds: ids, hiddenChildIds: [] },
      { a: P(2, 0), b: P(2, 2), c: P(3, 4) });
    for (const e of plan.values()) expect(['south', 'east']).toContain(e.face);
  });
  it('single door on a face leaves exitPoint null (legacy, byte-identical)', () => {
    const plan = outgoingDoorPlan(rect, pos, { realChildIds: ['a'], hiddenChildIds: [] }, { a: P(2, 0) });
    expect(plan.get('a')).toMatchObject({ face: 'south', doorCount: 1, exitPoint: null, doorSpan: null });
  });
  it('two south doors get disjoint one-cell spans inside their slots, sorted by target column', () => {
    const plan = outgoingDoorPlan(rect, { rank: 1, col: 2 }, { realChildIds: ['far', 'same'], hiddenChildIds: [] },
      { far: P(3, 0), same: P(3, 2) });
    const far = plan.get('far'); const same = plan.get('same');
    expect(far.slotIndex).toBe(0); expect(same.slotIndex).toBe(1);
    expect(far.doorSpan.x2 - far.doorSpan.x1).toBe(1);
    expect(far.doorSpan.x2).toBeLessThanOrEqual(same.doorSpan.x1);
    for (const e of [far, same]) {
      expect(e.doorSpan.x1).toBeGreaterThanOrEqual(e.slot.x1);
      expect(e.doorSpan.x2).toBeLessThanOrEqual(e.slot.x2);
      expect(e.exitPoint).toEqual({ x: e.doorSpan.x1, y: rect.gy + rect.gh });
    }
  });
  it('is independent of child-list order', () => {
    const t = { a: P(3, 0), b: P(3, 2), c: P(4, 4) };
    const one = outgoingDoorPlan(rect, { rank: 1, col: 2 }, { realChildIds: ['a', 'b', 'c'], hiddenChildIds: [] }, t);
    const two = outgoingDoorPlan(rect, { rank: 1, col: 2 }, { realChildIds: ['c', 'b', 'a'], hiddenChildIds: [] }, t);
    expect([...one.entries()].sort()).toEqual([...two.entries()].sort());
  });
});
```

- [ ] **Step 2: Run to verify it fails** (`-t "outgoingDoorPlan"`), expected `not a function`.

- [ ] **Step 3: Implement**

```js
function compareTargets(a, b) {
  return (a.tp.col - b.tp.col) || (a.tp.rank - b.tp.rank) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

/** #415: the single source of truth for a room's outgoing doors. Face by target
 * direction (east only for a higher-column target; south otherwise, which is
 * always valid because its horizontal leg runs along the source's own south
 * margin), slots by a total order independent of build/iteration order. No
 * seeded values: byte-stable for existing seeds. */
export function outgoingDoorPlan(rect, pos, { realChildIds = [], hiddenChildIds = [] }, positionByRoomId) {
  const byFace = { south: [], east: [] };
  for (const id of [...realChildIds, ...hiddenChildIds]) {
    const tp = positionByRoomId[id];
    byFace[tp.col > pos.col ? 'east' : 'south'].push({ id, tp });
  }
  const plan = new Map();
  for (const face of ['south', 'east']) {
    // south: ascending target column (left door to the left-most target);
    // east: descending, so the nearest target takes the lowest door and legs nest.
    const list = byFace[face].slice().sort(face === 'south' ? compareTargets : (a, b) => compareTargets(b, a));
    const slots = list.length ? outgoingSlotsForFace(rect, list.length, face) : [];
    list.forEach(({ id }, slotIndex) => {
      const slot = slots[slotIndex];
      let exitPoint = null;
      let doorSpan = null;
      if (list.length > 1) {
        if (face === 'south') {
          const x = clampDoorStart(slot.x1, slot.x2, slot.x1 + (slot.x2 - slot.x1) / 2 - DOOR_WIDTH);
          exitPoint = { x, y: slot.y1 };
          doorSpan = { x1: x, y1: slot.y1, x2: x + DOOR_WIDTH, y2: slot.y1 };
        } else {
          const y = clampDoorStart(slot.y1, slot.y2, slot.y1 + (slot.y2 - slot.y1) / 2 - DOOR_WIDTH);
          exitPoint = { x: slot.x1, y };
          doorSpan = { x1: slot.x1, y1: y, x2: slot.x1, y2: y + DOOR_WIDTH };
        }
      }
      plan.set(id, { face, slotIndex, slot, doorCount: list.length, exitPoint, doorSpan });
    });
  }
  return plan;
}
```

- [ ] **Step 4: Run to verify it passes**, then **Step 5: commit** (`feat(#415): outgoingDoorPlan`).

### Task 2.3: Plan invariants over the sweep and ratchet inputs

**Files:**
- Modify: `tests/dungeon-layout-endpoints.test.mjs`

**Interfaces:**
- Consumes: `outgoingDoorPlan`, `buildSweepLayout`.
- Produces: `planSelector(layout, conn)` exported from `tests/helpers/layout-sweep.mjs` (add to that file) returning `{ face, exitDoor }` where `exitDoor = entry.exitPoint ? entry : undefined`; used by Chunk 4.

- [ ] **Step 1: Add the failing tests**

```js
import { buildSweepLayout } from './helpers/layout-sweep.mjs';
import { outgoingDoorPlan } from '../scripts/dungeon-layout.mjs';

describe('outgoingDoorPlan invariants over the sweep (#415)', () => {
  it('faces are south/east only, east only for higher-column targets, spans disjoint and in-slot, at most size/DOOR_WIDTH doors', () => {
    let rooms = 0; let maxDoors = 0;
    for (let i = 0; i < 500; i += 1) {
      const L = buildSweepLayout(i);
      for (const sourceId of Object.keys(L.rooms)) {
        const real = L.edges[sourceId] ?? [];
        const hidden = (L.hiddenEdges[sourceId] ?? []).slice(0, 1);
        if (!real.length && !hidden.length) continue;
        rooms += 1;
        const plan = outgoingDoorPlan(L.rect[sourceId], L.pos[sourceId], { realChildIds: real, hiddenChildIds: hidden }, L.pos);
        const spans = { south: [], east: [] };
        for (const [id, e] of plan) {
          expect(['south', 'east']).toContain(e.face);
          if (e.face === 'east') expect(L.pos[id].col).toBeGreaterThan(L.pos[sourceId].col);
          maxDoors = Math.max(maxDoors, e.doorCount);
          expect(e.doorCount).toBeLessThanOrEqual(L.rect[sourceId].gw);
          if (e.doorSpan) {
            expect(Number.isInteger(e.exitPoint.x) && Number.isInteger(e.exitPoint.y)).toBe(true);
            spans[e.face].push(e.doorSpan);
          }
        }
        for (const face of ['south', 'east']) {
          const s = spans[face].map((d) => (face === 'south' ? [d.x1, d.x2] : [d.y1, d.y2])).sort((a, b) => a[0] - b[0]);
          for (let k = 1; k < s.length; k += 1) expect(s[k][0]).toBeGreaterThanOrEqual(s[k - 1][1]);
        }
      }
    }
    expect(rooms).toBeGreaterThan(3000);
    expect(maxDoors).toBeGreaterThan(1);
  });
});
```

- [ ] **Step 2: Run** (`npx vitest run tests/dungeon-layout-endpoints.test.mjs`). Expected FAIL only if an invariant is violated; if it passes immediately, add a deliberate break (change `> pos.col` to `>= pos.col` locally), confirm it fails, revert. A new test that never failed proves nothing.
- [ ] **Step 3: If it fails for a real reason (e.g. max out-degree larger than 3, non-integer door), fix `outgoingDoorPlan` and note the finding in the spec Risks.** Add `planSelector` to the helper:

```js
import { outgoingDoorPlan } from '../../scripts/dungeon-layout.mjs';
export function planSelector(layout, { sourceId, toId }) {
  const real = layout.edges[sourceId] ?? [];
  const hidden = (layout.hiddenEdges[sourceId] ?? []).slice(0, 1);
  const plan = outgoingDoorPlan(layout.rect[sourceId], layout.pos[sourceId], { realChildIds: real, hiddenChildIds: hidden }, layout.pos);
  const entry = plan.get(toId);
  return { face: entry.face, exitDoor: entry.exitPoint ? entry : undefined };
}
```

- [ ] **Step 4: `npm test` green.**
- [ ] **Step 5: Version bump, PR, automerge** (title `feat(#415): pure outgoing door plan`; same commands as Task 1.2).

---

## Chunk 3 (PR C): corridor, margin and enclosure geometry accept the plan (still unused by the scene)

### Task 3.1: `buildEdgeCorridor` honors `exitDoor` in every branch

**Files:**
- Modify: `scripts/dungeon-layout.mjs` (`buildEdgeCorridor`: signature line 472; same-column south branch `doorX0` ~656 and its first two `plainWalls` ~830-831; same-rank east branch `doorY0` ~985 and its first two `plainWalls` ~1087-1088; multi-cell `exitPoint`/`sourceFaceCapWalls` ~496/615; corner branch `exitPoint` ~1163/`sourceFaceCapWalls` ~1185)
- Test: `tests/dungeon-layout.test.mjs`

**Interfaces:**
- Consumes: plan entries from Task 2.2.
- Produces: `buildEdgeCorridor(..., incomingFace = 'north', exitDoor)`; `exitDoor = { exitPoint: {x,y}, doorSpan }` (a plan entry works as is). When `exitDoor` is given: the door sits at `exitDoor.exitPoint`, and the source-face cap walls are NOT returned (the source's own build seals its face, Task 4.2). When absent: unchanged.

- [ ] **Step 1: Write failing tests**, one per branch, using small hand-built fixtures:

```js
describe('buildEdgeCorridor exitDoor (#415)', () => {
  const seed = 'door-slot-seed';
  const from = { gx: 300, gy: 13, gw: 6, gh: 6 };
  const slot = { x1: 300, y1: 39, x2: 306, y2: 39 };
  it('same-column south: door at the planned x, no source-face caps', () => {
    const to = { gx: 300, gy: 26, gw: 6, gh: 6 };
    const target = { x1: 300, y1: 26, x2: 306, y2: 26 };
    const exitDoor = { exitPoint: { x: 302, y: 19 }, doorSpan: { x1: 302, y1: 19, x2: 303, y2: 19 } };
    const r = buildEdgeCorridor(seed, 'a', 'b', from, to, { rank: 1, col: 0 }, { rank: 2, col: 0 }, 'south', target, { '1,0': 'a', '2,0': 'b' }, 'north', exitDoor);
    expect(r.doorWall).toEqual({ x1: 302, y1: 19, x2: 303, y2: 19 });
    expect(r.plainWalls.some((w) => w.y1 === 19 && w.y2 === 19)).toBe(false);
  });
  it('corner branch (lower-column target): leg 1 starts at the planned door and never enters the source', () => {
    const to = { gx: 300, gy: 52, gw: 6, gh: 6 };
    const fromE = { gx: 326, gy: 13, gw: 6, gh: 6 };
    const target = { x1: 300, y1: 52, x2: 306, y2: 52 };
    const exitDoor = { exitPoint: { x: 328, y: 19 }, doorSpan: { x1: 328, y1: 19, x2: 329, y2: 19 } };
    const r = buildEdgeCorridor(seed, 'a', 'b', fromE, to, { rank: 1, col: 2 }, { rank: 4, col: 0 }, 'south', target, { '1,2': 'a', '4,0': 'b' }, 'north', exitDoor);
    expect(r.doorWall.x1).toBe(328);
    for (const s of r.corridorSegments) expect(s.gy + s.gh <= fromE.gy || s.gy >= fromE.gy + fromE.gh).toBe(true); // not strictly inside
  });
  it('east same-rank branch honors the planned row', () => {
    const fromR = { gx: 300, gy: 0, gw: 12, gh: 12 };
    const to = { gx: 326, gy: 0, gw: 6, gh: 6 };
    const target = { x1: 326, y1: 0, x2: 326, y2: 6 };
    const exitDoor = { exitPoint: { x: 312, y: 3 }, doorSpan: { x1: 312, y1: 3, x2: 312, y2: 4 } };
    const r = buildEdgeCorridor(seed, 'a', 'b', fromR, to, { rank: 0, col: 0 }, { rank: 0, col: 2 }, 'east', target, { '0,0': 'a', '0,2': 'b' }, 'west', exitDoor);
    expect(r.doorWall).toEqual({ x1: 312, y1: 3, x2: 312, y2: 4 });
  });
  it('without exitDoor the result is unchanged (existing behavior)', () => {
    const to = { gx: 300, gy: 26, gw: 6, gh: 6 };
    const target = { x1: 300, y1: 26, x2: 306, y2: 26 };
    const a = buildEdgeCorridor(seed, 'a', 'b', from, to, { rank: 1, col: 0 }, { rank: 2, col: 0 }, 'south', target, { '1,0': 'a', '2,0': 'b' });
    const b = buildEdgeCorridor(seed, 'a', 'b', from, to, { rank: 1, col: 0 }, { rank: 2, col: 0 }, 'south', target, { '1,0': 'a', '2,0': 'b' }, 'north', undefined);
    expect(b).toEqual(a);
  });
});
```

Also add a multi-cell case (a source with a blocked column forcing `path.length > 2`): build occupancy so `findCorridorPath` returns a chain (copy the occupancy fixture from the existing `#225` multi-cell tests in this file, search `transitCells.length` in `tests/dungeon-layout.test.mjs`), and assert `doorWall.x1 === exitDoor.exitPoint.x` and `chainStart` agrees: `result.transitCells[0].entryPoint.x === exitDoor.exitPoint.x`.

- [ ] **Step 2: Run to verify failures** (door positions differ / caps present).
- [ ] **Step 3: Implement.** Exact edits:
  - signature: `..., occupiedCells, incomingFace = 'north', exitDoor)`.
  - south fast path: `const doorX0 = exitDoor ? exitDoor.exitPoint.x : fromRect.gx + outgoingOffset;`; wrap its first two `plainWalls` entries (the `faceY` caps, lines ~830-831) in `...(exitDoor ? [] : [ ...both... ])`.
  - east fast path: `const doorY0 = exitDoor ? exitDoor.exitPoint.y : fromRect.gy + outgoingOffset;` and the first two `faceX` entries (~1087-1088) likewise.
  - multi-cell and corner `exitPoint`: `const exitPoint = exitDoor?.exitPoint ?? ( ...existing ternary... );` and `...(exitDoor ? [] : sourceFaceCapWalls(fromRect, exitFace, exitPoint))`.
  - JSDoc: document the new parameter at the function's docblock.
- [ ] **Step 4: Run the new tests, then `npm test`** (the ~4,000-line suite must stay green: this proves the absent-`exitDoor` path is untouched).
- [ ] **Step 5: Commit** (`feat(#415): buildEdgeCorridor accepts a planned exit door`).

### Task 3.2: `outgoingMarginOffset`, `roomEnclosureWalls`, collision scans accept the plan

**Files:**
- Modify: `scripts/dungeon-layout.mjs` (`outgoingMarginOffset` ~1256; `roomEnclosureWalls` ~262; `findPriorityCollision` ~1394; `pendingForeignMarginOpenings` ~1566)
- Test: `tests/dungeon-layout.test.mjs`

**Interfaces:**
- `outgoingMarginOffset(seed, fromRoomId, toRoomId, exitFace, fromRect, fromPos, toPos, occupiedCells, incomingFace = 'north', exitDoor)`: with `exitDoor`, offset-based case reads the corridor segment as today (with `exitDoor` passed through to `buildEdgeCorridor`); otherwise returns `{ offset: <exitPoint.x - fromRect.gx (south) or exitPoint.y - fromRect.gy (east)>, width: DOOR_WIDTH }`.
- `roomEnclosureWalls(seed, roomId, { incomingCount, incomingFace, outgoingFaces, doorSpansByFace = {} }, rect)`: a face in `outgoingFaces` that also has `doorSpansByFace[face]` (array of `{x1,y1,x2,y2}` sorted along the face) contributes solid walls for every gap between spans (including the two ends); a face without spans behaves as today (fully open).
- `findPriorityCollision(..., incomingFace, planFor)` and `pendingForeignMarginOpenings(..., hiddenIncomingByRoomId = {}, planFor)`: optional trailing `planFor(sourceId)` returning the source's plan `Map` (or `null` for legacy). When present they take `exitFace` from `planFor(sourceId).get(childId).face` instead of `exitFaceForIndex(index, ...)` and pass the entry as `exitDoor` to `buildEdgeCorridor`. `pendingForeignMarginOpenings` additionally iterates `hiddenEdges` children when `planFor` is present (it ignores hidden edges today): add an optional `hiddenEdges = {}` argument right before `planFor`.

- [ ] **Step 1: Failing tests.**
  - `roomEnclosureWalls`: rect 6x6 at (300,13), `outgoingFaces: ['south']`, `doorSpansByFace: { south: [{x1:301,y1:19,x2:302,y2:19},{x1:304,y1:19,x2:305,y2:19}] }` expects south walls `[300..301]`, `[302..304]`, `[305..306]` at y=19 (3 segments, each with `dir: 'south'`), and the other faces as today.
  - `outgoingMarginOffset` with `exitDoor.exitPoint.x = 304` on a non-aligned (corner) edge returns `{ offset: 4, width: 1 }`.
  - `pendingForeignMarginOpenings`/`findPriorityCollision`: reuse the existing dogleg fixtures in this file (search `dogleg-repro-seed-0`) with `planFor` returning a one-entry plan that reproduces the legacy face, assert identical output to calling without `planFor`.
- [ ] **Step 2: Run to verify failures. Step 3: Implement** as specified (the plan-aware branch is guarded by `planFor`/`exitDoor` being truthy, so every existing call is unchanged). **Step 4:** targeted tests then `npm test`. **Step 5:** commit.

### Task 3.3: Chunk 3 PR

- [ ] Run `npm test`; confirm `git diff --stat` touches only `scripts/dungeon-layout.mjs` and tests (no import changes, so `update-architecture-docs` is not needed; say so in the PR body).
- [ ] Bump `module.json`; PR `feat(#415): corridor and margin geometry accept a planned exit door`, automerge.

---

## Chunk 4 (PR D): scene wiring, `layoutVersion`, property test to zero

### Task 4.1: `layoutVersion` stamp and gate

**Files:**
- Modify: `scripts/ui/dungeon-app.mjs` (state object ~541: add `layoutVersion: 2`); `scripts/dungeon-scene.mjs` (read `state.layoutVersion ?? 1`)
- Test: `tests/dungeon-scene.test.mjs` (find the existing `buildRoomAtGraphNode` tests; follow their fake-scene pattern)

**Interfaces:**
- Produces: `buildRoomAtGraphNode(..., { ..., layoutVersion = 1 })` and `buildPopulateAndUnlockGraphNode` threading `state.layoutVersion ?? 1`. Version 1 takes exactly today's code path.

- [ ] **Step 1: Failing test:** a run state without `layoutVersion` builds a room with a hidden child exactly as before (assert the placeholder walls equal a recorded legacy fixture: full-face placeholder on `east`); a state with `layoutVersion: 2` and the same room builds the hidden placeholder on the plan's face. (The second assertion fails until Task 4.2.)
- [ ] **Steps 2-5:** thread the field; commit.

### Task 4.2: Scene consumes the plan (version 2)

**Files:**
- Modify: `scripts/dungeon-scene.mjs` (~405-415, ~467-487, ~530-556, ~1218-1226)
- Test: `tests/dungeon-scene.test.mjs`

**Interfaces:**
- Consumes: `outgoingDoorPlan`, Chunk 3 parameters.
- Produces: in `buildRoomAtGraphNode`, when `layoutVersion === 2`: `plan = outgoingDoorPlan(rect, {rank,col}, { realChildIds: childIds, hiddenChildIds: hiddenChildId ? [hiddenChildId] : [] }, layoutPositionByRoomId)`; `outgoingFaces = [...new Set([...plan.values()].map(e => e.face))]` (isGoal: `[]`); `doorSpansByFace` from multi-door entries sorted along the face; margin openings one per planned door via `outgoingMarginOffset(..., entry.doorCount > 1 ? entry : undefined)`; frontier/hidden placeholders use `entry.doorSpan` when `doorCount > 1`, else the full face as today; `childIdByFace` is not used in version 2. In `buildPopulateAndUnlockGraphNode` (~1219): `exitFaceFromSource = planOf(sourceId).get(room.id).face` and `buildEdgeCorridor(..., incomingFace, entry.exitPoint ? entry : undefined)`, where `planOf(sourceId)` builds the plan from `state.edges[sourceId]`, `state.hiddenEdges[sourceId]?.[0]`, `state.layoutPositionByRoomId`. Pass `planFor` to `findPriorityCollision`/`pendingForeignMarginOpenings` (`state.hiddenEdges` as the hidden arg).

- [ ] **Step 1: Failing scene tests** (fake scene as in neighbours): (a) source with real south child + hidden child whose target is a lower column: both on `south`, two door spans, enclosure south walls leave exactly two gaps, hidden placeholder is `LOCKED` with `dungeonHiddenDoorForEdge` and spans one cell; (b) after the second room (the hidden target) builds, `plainWalls` contains no wall on the source face line outside the door spans (caps came from the source); (c) a `layoutVersion` 1 state keeps the legacy east placeholder.
- [ ] **Step 2-4:** run to fail, implement, run to pass; **Step 5:** commit.

### Task 4.3: Property test goes to zero, plus buildability

**Files:**
- Modify: `tests/dungeon-layout-endpoints.test.mjs`

- [ ] **Step 1: Failing tests.** Add `describe('version 2 plan selection')` using `planSelector`: `expect(measure(planSelector).source).toBe(0)`; set `SOURCE_OVERLAP_CEILING = 0` for the legacy-selector test is NOT valid (legacy remains broken by design), so change that test to document the legacy number as a version-1 reference `expect(legacy.source).toBeGreaterThan(0)`. Add the buildability sweep: for every edge under `planSelector`, (i) the source's enclosure plus margin walls leave no gap other than planned door spans on its outgoing faces (build with `roomEnclosureWalls` + `cellMarginWalls` exactly as Task 4.2 does and check each planned door's cell is the only uncovered cell on its face), (ii) no returned `plainWalls`/`doorWall` of any edge covers another edge's door span on the same source (segment-vs-span overlap test; wall touching a span end is allowed), (iii) target-overlap and lane-conflict ratchets still hold (`<=` measured values from Chunk 1, now measured under `planSelector`; lower them to the new measured values).
- [ ] **Step 2: Run:** source test FAILS if any edge still overlaps; investigate each remaining class (spec Risks: 24 south edges with source overlap of unknown cause). Fix at the root if it is the same shape (planned door not honored in some branch); if it is a different mechanism, record it in the spec Risks and ratchet it with a filed issue, do not widen scope silently.
- [ ] **Step 3-4:** make green; `npm test`.
- [ ] **Step 5: Docs and PR.** Run `update-architecture-docs` only if imports changed (expected: dungeon-scene.mjs gains `outgoingDoorPlan` from the already-imported dungeon-layout.mjs, so no new edge). Bump `module.json`; PR `feat(#415): exit faces by target direction with per-face door slots (new runs)`; automerge with `--body "Refs #415"`. Do NOT close #415; comment on it that live verification needs a NEW run (version 1 runs are unchanged).

---

## Chunk 5 (PR E): lane conflicts, Option C (avoid at hidden-shortcut generation)

**Decision (user, Open question 5): Option C.** Do not keep a hidden shortcut that would share an outgoing face with another of its source's edges. Real edges are never dropped; detour rooms are never dropped (they are layout nodes: dropping one moves columns). Measured before the rule (v2, 500 seeds, 329 conflicting pairs): real+shortcut 174, detour+real 67, real+real 88. Only the 174 shortcut pairs are avoidable; the rest are the documented residual.

**Shape.** Shortcuts add no layout node, so deciding after the layout is known changes nothing else: `attachHiddenPaths` stays as is (version 1 byte-identical, no new import in `dungeon-deck.mjs`), and a new pure `pruneConflictingShortcuts` in `dungeon-layout.mjs` runs in `dungeon-app.mjs` between the rank/column computation and the incoming-face computation, only when `layoutVersion >= 2` (new runs). Deterministic: a pure function of the graph and positions.

### Task 5.1: sweep helper builds the version the selector asks for
- [ ] `buildSweepLayout(i, { restRoom, layoutVersion = 1 })`; when `layoutVersion >= 2` apply `pruneConflictingShortcuts` to `hiddenEdges`/`hiddenIncomingByRoomId` before `incFace`. `planSelector.layoutVersion = 2`; `forEachEdge` passes `exitSelector.layoutVersion ?? 1`. The two direct `buildSweepLayout(i)` calls in the v2 invariant/buildability tests pass `{ layoutVersion: 2 }`. The digest test (version 1) must stay green untouched.

### Task 5.2: failing tests first
- [ ] Unit tests in `tests/dungeon-layout.test.mjs` for `pruneConflictingShortcuts`: drops a shortcut sharing a face with a real child; keeps a shortcut on a free face; never touches detour edges or real edges; leaves inputs unmutated; `hiddenIncomingByRoomId` loses the dropped source; deterministic (same result twice).
- [ ] Lower `LANE_CONFLICT_CEILING` to the expected value (329 minus the 174 shortcut pairs, 155), and add a "no real/detour edge is lost" sweep check: every edge in `layoutEdges` and `edges` survives pruning, goal still reachable. Run: fails.

### Task 5.3: implement and ratchet
- [ ] Implement `pruneConflictingShortcuts` (same face rule as `outgoingDoorPlan`: east iff target column is higher, else south); call it in `dungeon-app.mjs` under `layoutVersion` 2. Make green, ratchet `LANE_CONFLICT_CEILING` to the measured value, `npm test`.
- [ ] Report the residual (real+real and detour+real) with its cause: both edges of the pair are mandatory, and their lanes share the 1-deep south margin row / the east gutter.
- [ ] Bump `module.json`; PR `feat(#415): drop hidden shortcuts that would share a face lane (new runs)`, body `Refs #415`.

---

## Self-Review notes

- Spec coverage: problem/sweep (Chunk 1), faces and slots (Chunk 2), `buildEdgeCorridor` all branches, `outgoingMarginOffset`, `roomEnclosureWalls`, `findPriorityCollision`, `pendingForeignMarginOpenings` incl. hidden (Chunk 3), `dungeon-scene.mjs` ~405-556 and ~1220, migration gate, property test as acceptance, containment buildability (Chunk 4), Decision 3 / Open question 5 (Chunks 1 and 5). Target-room overlap is ratcheted only, per Decision 4.
- Type consistency: plan entry `{ face, slotIndex, slot, doorCount, exitPoint, doorSpan }` is used identically in Tasks 2.2, 2.3, 3.1, 3.2, 4.2; `exitDoor` accepts a plan entry; `planFor(sourceId)` returns that `Map`.
- Known simplification to revisit in review: single-door faces keep the legacy path (no `exitDoor`), so a version-2 room's single-door face is still sealed by the child's `sourceFaceCapWalls`, and multi-door faces are sealed by the source. The two never mix on one face because `doorCount` is per face.
