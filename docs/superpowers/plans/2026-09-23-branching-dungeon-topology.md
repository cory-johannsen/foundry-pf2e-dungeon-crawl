# Branching Dungeon Topology Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the linear, one-exit-per-room dungeon sequence with a branching graph topology — every non-entry, non-goal room can have up to 3 exits, the goal room always has exactly one entrance, the whole graph pregenerates at scene creation for every run (not just GM-less), and the GM Accept/Reroll approval gate is removed.

**Architecture:** `dungeon-deck.mjs` generates a seeded DAG (rooms + edges) instead of a flat sequence, using a frontier-walk-with-forced-merges algorithm that guarantees a single-entrance goal. `dungeon-layout.mjs` positions that graph with a rank-based tree layout (uniform grid cells per topological rank/column — a deliberate simplification of true variable-width packing, still satisfying no-overlap and centered-over-children) and generalizes the existing wall/door/corridor geometry from "slot to slot+1" to "room to any of its children." `dungeon-runner.mjs`/`dungeon-app.mjs`/`dungeon-scene.mjs` replace the `rooms` array + `currentIndex` model with `rooms` (dict) + `edges` (adjacency) + `currentRoomId`, build the entire graph eagerly for every run, and resolve door-opens against a room's specific chosen child instead of a single fixed successor. `encounter-generator.mjs` drops its Accept/Reroll dialog outright.

**Tech Stack:** Vanilla JS (ESM), Vitest for pure-logic tests, Foundry VTT client APIs (untested directly, verified via live verification per this codebase's existing convention for `dungeon-scene.mjs`).

**Spec:** `docs/superpowers/specs/2026-09-23-branching-dungeon-topology-design.md`

## Global Constraints

- Branch degree: a non-entry, non-goal room has 1-3 exits total (0-2 "extra" beyond the first), via a new `EXIT_COUNT_WEIGHTS` table — frequent branching, per the approved spec.
- The goal room always has exactly one incoming edge, regardless of `roomCount` or how branching rolled — guaranteed by generation, not by later validation/rejection.
- The entry room (index/id `room-entry`) is unchanged: always `kind: 'safe_entry'`, never counted toward `roomCount`, exactly one node, no incoming edges.
- Full pregeneration applies to **every** run, GM-present and GM-less alike — no `state.hostUserId` gate on eager building.
- The Accept/Reroll approval dialog (`showEncounterPreview`) is deleted outright — no remaining code path reaches it.
- The ITEM-11 first-combat-room manual deferral (`populateNextRoom` / "Populate Next Room" button) is removed.
- `reduced_travel_time` and `extra_travel_time` never build or splice anything at runtime — they only reveal (unlock) a shortcut edge or detour room that generation already built, sealed, ahead of the party's current position.
- A hidden shortcut/detour reveal only ever affects rooms **not yet** in `state.history` — never rebuilds or tears down anything already visited.
- When superseding a frontier-placeholder wall with real connection geometry, always create the new real wall(s) before deleting the placeholder (never the reverse) — this is the existing #110 fog-leak-avoidance ordering in `buildRoomAtSlot`, and it must carry over to the multi-exit generalization.
- Every new pure function (`dungeon-deck.mjs`, `dungeon-layout.mjs`, the pure helpers in `dungeon-runner.mjs`) must be deterministic for a given seed — same seed, same output, every time.

## Review Focus

- **`roomCount` at its minimum (2).** The forced-merge algorithm must still produce a valid single-entrance-goal graph when there's no room for real branching at all — the degenerate case shouldn't throw or produce a goal with zero or multiple parents.
- **A room rolls 3 exits when very few rooms remain in the budget.** Generation must still terminate and converge to one goal parent, not overshoot `roomCount` or leave a tip permanently dangling.
- **Two hidden hazards attached to the same branch (a shortcut and a detour both pregenerated near each other).** Revealing one must never corrupt or desync the other's target rooms/edges.
- **A player opens a door into a room that failed to build during eager pregeneration.** The lazy fallback build-on-reach must engage exactly once and not silently leave the room half-built if the fallback itself fails.
- **A room with 3 exits where two of its children are later merge targets for other branches.** `doorToRoomId` must resolve each of that room's three doors to the correct distinct child even though those children have other parents too.

---

## Task 1: Exit-count weights and seeded picker

**Files:**
- Modify: `scripts/dungeon-deck.mjs`
- Test: `tests/dungeon-deck.test.mjs`

**Interfaces:**
- Produces: `EXIT_COUNT_WEIGHTS` (array of `{count, weight}`), `exitCountAt(seed, roomId)` → integer in `[1,3]`.

- [ ] **Step 1: Write the failing test**

```js
import { EXIT_COUNT_WEIGHTS, exitCountAt } from '../scripts/dungeon-deck.mjs';

describe('exitCountAt', () => {
  it('always returns a count between 1 and 3', () => {
    for (let i = 0; i < 200; i += 1) {
      const count = exitCountAt('alpha', `room-${i}`);
      expect(count).toBeGreaterThanOrEqual(1);
      expect(count).toBeLessThanOrEqual(3);
    }
  });

  it('is deterministic for the same seed and room id', () => {
    expect(exitCountAt('alpha', 'room-3')).toBe(exitCountAt('alpha', 'room-3'));
  });

  it('skews toward 1-2 exits over 3, per EXIT_COUNT_WEIGHTS', () => {
    const counts = { 1: 0, 2: 0, 3: 0 };
    for (let i = 0; i < 1000; i += 1) counts[exitCountAt('alpha', `room-${i}`)] += 1;
    expect(counts[3]).toBeLessThan(counts[1]);
    expect(counts[3]).toBeLessThan(counts[2]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/dungeon-deck.test.mjs -t exitCountAt`
Expected: FAIL with "exitCountAt is not a function" (or similar import error)

- [ ] **Step 3: Write minimal implementation**

Add to `scripts/dungeon-deck.mjs`, near `ROOM_KIND_WEIGHTS`:

```js
// Frequent branching, capped at 2 extra exits (3 total) — confirmed with
// Cory during #93's design. Skewed toward 1-2 so most rooms still read as
// a single path and full 3-way branches stay a genuine event.
export const EXIT_COUNT_WEIGHTS = [
  { count: 1, weight: 5 },
  { count: 2, weight: 4 },
  { count: 3, weight: 1 }
];

/** Deterministic per-room exit count (1-3), same seeded-per-salt pattern as roomKindAt. */
export function exitCountAt(seed, roomId) {
  return pickAt(seed, `exits-${roomId}`, EXIT_COUNT_WEIGHTS).count;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/dungeon-deck.test.mjs -t exitCountAt`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add scripts/dungeon-deck.mjs tests/dungeon-deck.test.mjs
git commit -m "feat: add EXIT_COUNT_WEIGHTS and exitCountAt for branching topology"
```

---

## Task 2: `buildRoomGraph` — seeded branching generation with forced merges

**Files:**
- Modify: `scripts/dungeon-deck.mjs`
- Test: `tests/dungeon-deck.test.mjs`

**Interfaces:**
- Consumes: `exitCountAt(seed, roomId)` (Task 1), existing `roomKindAt`, `setpieceAt`, `outcomeSlotAt`, `locationTagAt`, `roomArtVariantAt` (unchanged signatures).
- Produces: `buildRoomGraph({ seed, roomCount, puzzleSetpieceIds, trapSetpieceIds, narrativeSetpieceIds })` → `{ rooms: {[id]: RoomNode}, edges: {[id]: string[]} }`. `RoomNode` keeps the same shape `buildRoomSequence` produced per room (`id, kind, isGoal, setpieceId, outcomeSlotId, locationTag, artVariant`), plus `rank` is NOT set here (Task 4 computes layout separately). The entry room's id stays `'room-entry'`; the goal room is the unique room with `isGoal: true`.

- [ ] **Step 1: Write the failing tests**

```js
import { buildRoomGraph } from '../scripts/dungeon-deck.mjs';

function parentsOf(edges, roomId) {
  return Object.entries(edges)
    .filter(([, children]) => children.includes(roomId))
    .map(([parent]) => parent);
}

describe('buildRoomGraph', () => {
  it('at the minimum roomCount (2), still produces a single-entrance goal', () => {
    const { rooms, edges } = buildRoomGraph({ seed: 'alpha', roomCount: 2 });
    const goal = Object.values(rooms).find((r) => r.isGoal);
    expect(goal).toBeDefined();
    expect(parentsOf(edges, goal.id)).toHaveLength(1);
  });

  it('the entry room has no incoming edges and is never the goal', () => {
    const { rooms, edges } = buildRoomGraph({ seed: 'alpha', roomCount: 8 });
    expect(parentsOf(edges, 'room-entry')).toHaveLength(0);
    expect(rooms['room-entry'].isGoal).toBe(false);
    expect(rooms['room-entry'].kind).toBe('safe_entry');
  });

  it('every non-entry, non-goal room has 1-3 outgoing edges', () => {
    const { rooms, edges } = buildRoomGraph({ seed: 'gamma', roomCount: 20 });
    for (const room of Object.values(rooms)) {
      if (room.id === 'room-entry' || room.isGoal) continue;
      expect(edges[room.id]?.length).toBeGreaterThanOrEqual(1);
      expect(edges[room.id]?.length).toBeLessThanOrEqual(3);
    }
  });

  it('the goal room always has exactly one incoming edge, even under heavy branching', () => {
    for (const seed of ['a', 'b', 'c', 'd', 'e']) {
      const { rooms, edges } = buildRoomGraph({ seed, roomCount: 25 });
      const goal = Object.values(rooms).find((r) => r.isGoal);
      expect(parentsOf(edges, goal.id)).toHaveLength(1);
    }
  });

  it('the goal room has exactly one incoming edge across a wide seed/roomCount sweep, including near-budget-exhaustion 3-exit rolls (#93 pre-flight fix regression — concrete repros before the fix: seed-0@3, seed-1@26)', () => {
    for (let n = 0; n < 60; n += 1) {
      const seed = `seed-${n}`;
      for (const roomCount of [2, 3, 4, 5, 6, 8, 12, 20, 26, 40]) {
        const { rooms, edges } = buildRoomGraph({ seed, roomCount });
        const goal = Object.values(rooms).find((r) => r.isGoal);
        expect(parentsOf(edges, goal.id)).toHaveLength(1);
      }
    }
  });

  it('is a DAG — no room is reachable from itself', () => {
    const { rooms, edges } = buildRoomGraph({ seed: 'delta', roomCount: 15 });
    for (const startId of Object.keys(rooms)) {
      const seen = new Set();
      const stack = [...(edges[startId] ?? [])];
      while (stack.length) {
        const id = stack.pop();
        expect(id).not.toBe(startId);
        if (seen.has(id)) continue;
        seen.add(id);
        stack.push(...(edges[id] ?? []));
      }
    }
  });

  it('is deterministic for the same seed', () => {
    const a = buildRoomGraph({ seed: 'alpha', roomCount: 10 });
    const b = buildRoomGraph({ seed: 'alpha', roomCount: 10 });
    expect(a).toEqual(b);
  });

  it('rejects a roomCount below 2', () => {
    expect(() => buildRoomGraph({ seed: 'alpha', roomCount: 1 })).toThrow();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/dungeon-deck.test.mjs -t buildRoomGraph`
Expected: FAIL — `buildRoomGraph is not a function`

- [ ] **Step 3: Write minimal implementation**

Add to `scripts/dungeon-deck.mjs`:

```js
/**
 * Build a fresh branching room graph (#93). Unlike buildRoomSequence, this
 * has no single fixed "next room" — each non-goal, non-entry room rolls its
 * own exit count (exitCountAt) and grows one child per exit. To guarantee
 * the goal room ends up with exactly one incoming edge no matter how much
 * branching happened, generation tracks "open tips" (leaf rooms still
 * awaiting children) and forces merges — routing 2+ open tips into the SAME
 * next room — once the remaining room budget can no longer afford to keep
 * every tip open through to its own goal connection.
 */
export function buildRoomGraph({
  seed,
  roomCount,
  puzzleSetpieceIds = [],
  trapSetpieceIds = [],
  narrativeSetpieceIds = []
}) {
  if (!Number.isInteger(roomCount) || roomCount < 2) {
    throw new Error('roomCount must be an integer of at least 2 (rooms plus a goal room)');
  }

  const rooms = {};
  const edges = {};
  let puzzleOccurrence = 0;
  let trapOccurrence = 0;
  let narrativeOccurrence = 0;
  let built = 0; // non-entry, non-goal rooms built so far

  const entry = {
    id: 'room-entry', kind: 'safe_entry', isGoal: false, setpieceId: null, outcomeSlotId: null,
    locationTag: locationTagAt(seed, 'entry'), artVariant: roomArtVariantAt(seed, 'entry')
  };
  rooms[entry.id] = entry;
  edges[entry.id] = [];

  function makeRoom(salt) {
    const kind = roomKindAt(seed, salt);
    const setpieceId =
      kind === 'puzzle' ? setpieceAt(seed, puzzleOccurrence++, puzzleSetpieceIds, 'puzzle-setpiece-order')
      : kind === 'trap' ? setpieceAt(seed, trapOccurrence++, trapSetpieceIds, 'trap-setpiece-order')
      : kind === 'narrative' ? setpieceAt(seed, narrativeOccurrence++, narrativeSetpieceIds, 'narrative-setpiece-order')
      : null;
    const outcomeSlot = outcomeSlotAt(seed, salt);
    const room = {
      id: `room-${salt}`, kind, isGoal: false, setpieceId, outcomeSlotId: outcomeSlot.id,
      locationTag: locationTagAt(seed, salt), artVariant: roomArtVariantAt(seed, salt)
    };
    rooms[room.id] = room;
    edges[room.id] = [];
    return room;
  }

  // Open tips grow the graph breadth-first; each pop may add 1-3 children.
  let tips = [entry.id];
  while (built < roomCount - 1) {
    // Forced merge: once every remaining tip would need its own room just
    // to reach the goal, and the budget can't afford one room per tip PLUS
    // the goal, collapse all open tips onto a single new shared room before
    // continuing — this is what guarantees exactly one goal parent.
    const remaining = roomCount - 1 - built;
    if (tips.length > 1 && remaining <= tips.length) {
      const merged = makeRoom(`merge-${built}`);
      built += 1;
      for (const tipId of tips) edges[tipId].push(merged.id);
      tips = [merged.id];
      continue;
    }

    const tipId = tips.shift();
    // #93 pre-flight fix (Task 2 review found this empirically: capping
    // exitCount only by total remaining budget lets a single tip's own
    // branching alone consume the whole budget while OTHER already-open
    // tips (still sitting in `tips` below) never get a chance to reach
    // this loop's own merge check again — the loop then exits with every
    // one of them wired straight to goal, violating "goal always has
    // exactly one incoming edge" in ~22% of (seed, roomCount) pairs
    // (confirmed by sweep: e.g. seed='seed-0', roomCount=3 -> 2 goal
    // parents; seed='seed-1', roomCount=26 -> 4 goal parents). The fix:
    // cap exitCount so that AFTER this tip's children are created, the
    // loop's own invariant (remaining budget >= open tip count) still
    // holds for every tip still waiting — otherTips is `tips.length`
    // right after the shift above, i.e. every OTHER currently-open tip
    // that isn't the one being processed right now.
    const otherTips = tips.length;
    const avail = roomCount - 1 - built;
    const maxExitCount = Math.max(1, Math.floor((avail - otherTips) / 2));
    const exitCount = Math.min(exitCountAt(seed, tipId), maxExitCount);
    const nextTips = [];
    for (let i = 0; i < Math.max(1, exitCount); i += 1) {
      if (built >= roomCount - 1) break;
      const child = makeRoom(`${tipId}-${i}`);
      built += 1;
      edges[tipId].push(child.id);
      nextTips.push(child.id);
    }
    tips.push(...nextTips);
  }

  // Every remaining open tip becomes the goal's parent — force-merge to one
  // if more than one tip is still open (mirrors the loop's own merge step).
  const goal = {
    id: 'room-goal', kind: 'combat', isGoal: true, setpieceId: null, outcomeSlotId: null,
    locationTag: locationTagAt(seed, 'goal'), artVariant: roomArtVariantAt(seed, 'goal')
  };
  rooms[goal.id] = goal;
  edges[goal.id] = [];
  for (const tipId of tips) edges[tipId].push(goal.id);

  return { rooms, edges };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/dungeon-deck.test.mjs -t buildRoomGraph`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add scripts/dungeon-deck.mjs tests/dungeon-deck.test.mjs
git commit -m "feat: add buildRoomGraph with forced-merge single-entrance goal guarantee"
```

---

## Task 3: Hidden shortcut/detour generation

**Files:**
- Modify: `scripts/dungeon-deck.mjs`
- Test: `tests/dungeon-deck.test.mjs`

**Interfaces:**
- Consumes: the `{rooms, edges}` shape from Task 2's `buildRoomGraph`.
- Produces: `attachHiddenPaths({ rooms, edges, seed })` → `{ rooms, edges, hiddenRooms: Set<string>, hiddenEdges: {[fromId]: string[]} }`. `hiddenRooms` marks detour room ids (already present in `rooms`, just flagged); `hiddenEdges` lists shortcut/detour edges not present in the normal `edges` map (so normal traversal/layout never sees them until revealed).

**Known limitation (tracked separately, not this task's scope — issue #156):** neither a detour room's geometry nor a shortcut's connecting door is ever built, eagerly or on reveal, anywhere in this plan (Tasks 4/7/9/12's graph walks all traverse `edges` only, never `hiddenEdges`/`hiddenRooms`). A `reduced_travel_time`/`extra_travel_time` outcome (Task 9) will merge the edge into live `edges` and `unlockDoorsFromRoom` (Task 10) will silently no-op — no door or room appears. This is a real, deliberately deferred gap: fixing it needs an on-the-fly layout-position assignment plus a lazy build for the detour case, and a "retrofit a door into an already-solid wall face" operation for the shortcut case, neither of which is small enough to fold into this pass. #93 ships with hidden paths inert but harmless; #156 tracks making them actually walkable.

- [ ] **Step 1: Write the failing tests**

```js
import { buildRoomGraph, attachHiddenPaths } from '../scripts/dungeon-deck.mjs';

describe('attachHiddenPaths', () => {
  it('never attaches a hidden shortcut/detour touching the entry or goal room', () => {
    const graph = buildRoomGraph({ seed: 'alpha', roomCount: 12 });
    const { hiddenEdges, hiddenRooms } = attachHiddenPaths({ ...graph, seed: 'alpha' });
    expect(hiddenEdges['room-entry']).toBeUndefined();
    const goalId = Object.values(graph.rooms).find((r) => r.isGoal).id;
    expect(hiddenEdges[goalId]).toBeUndefined();
    for (const roomId of hiddenRooms) expect(graph.rooms[roomId].isGoal).toBe(false);
  });

  it('never attaches a hidden shortcut/detour TARGETING the goal room — a shortcut skips ONE HOP past toId, which can itself be adjacent to goal, even though toId itself is never goal (#93 pre-flight fix regression)', () => {
    for (let n = 0; n < 40; n += 1) {
      const seed = `hidden-goal-target-${n}`;
      for (const roomCount of [3, 4, 5, 6, 8, 12, 20]) {
        const graph = buildRoomGraph({ seed, roomCount });
        const goalId = Object.values(graph.rooms).find((r) => r.isGoal).id;
        const { hiddenEdges } = attachHiddenPaths({ ...graph, seed });
        for (const targets of Object.values(hiddenEdges)) {
          expect(targets).not.toContain(goalId);
        }
      }
    }
  });

  it('is deterministic for the same seed', () => {
    const graph = buildRoomGraph({ seed: 'beta', roomCount: 10 });
    const a = attachHiddenPaths({ ...graph, seed: 'beta' });
    const b = attachHiddenPaths({ ...graph, seed: 'beta' });
    expect([...a.hiddenRooms]).toEqual([...b.hiddenRooms]);
    expect(a.hiddenEdges).toEqual(b.hiddenEdges);
  });

  it('every room that already existed before the call keeps its own edges array untouched (#93 pre-flight fix — this must NOT deep-equal the whole edges object: attaching a detour legitimately ADDS a new key for the new detour room itself, per its own outgoing edge below)', () => {
    const graph = buildRoomGraph({ seed: 'gamma', roomCount: 14 });
    const before = JSON.parse(JSON.stringify(graph.edges));
    const { edges } = attachHiddenPaths({ ...graph, seed: 'gamma' });
    for (const roomId of Object.keys(before)) {
      expect(edges[roomId]).toEqual(before[roomId]);
    }
  });

  it('every detour room has a discoverable outgoing path to its toId (#93 pre-flight fix regression — a detour with no recorded edge anywhere is a guaranteed dead end the moment it is revealed)', () => {
    for (let n = 0; n < 40; n += 1) {
      const seed = `detour-reachable-${n}`;
      for (const roomCount of [4, 6, 8, 12, 16, 20]) {
        const graph = buildRoomGraph({ seed, roomCount });
        const { edges, hiddenRooms } = attachHiddenPaths({ ...graph, seed });
        for (const detourId of hiddenRooms) {
          expect(Array.isArray(edges[detourId]) && edges[detourId].length > 0).toBe(true);
        }
      }
    }
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/dungeon-deck.test.mjs -t attachHiddenPaths`
Expected: FAIL — `attachHiddenPaths is not a function`

- [ ] **Step 3: Write minimal implementation**

Add to `scripts/dungeon-deck.mjs`:

```js
// Tunable — how often a branch edge gets an optional pregenerated hidden
// extra (a shortcut past the next room, or a detour room spliced in front
// of it). Neither counts against roomCount, same treatment as the
// mid-dungeon rest room.
export const HIDDEN_PATH_CHANCE = 0.2;

/**
 * Attach pregenerated-but-hidden shortcuts/detours to a graph's non-entry,
 * non-goal edges (#93 — replaces runtime insert_after/remove_next
 * splicing). A shortcut edge skips the immediate next room on a branch; a
 * detour room is spliced hidden between two already-adjacent rooms.
 *
 * What's actually hidden is the INCOMING connection, in `hiddenEdges`, not
 * a detour room's own outgoing edge: `edges[detour.id] = [toId]` is a real
 * entry in the live `edges` map (a detour room needs SOME recorded path
 * onward, live or it's a guaranteed dead end the moment it's revealed —
 * caught by pre-flight review, do not remove this line believing it
 * belongs in `hiddenEdges` instead). Normal traversal still never reaches
 * `detour.id` regardless, since nothing in the live graph points INTO it
 * until an outcome reveal adds that incoming edge — see
 * dungeon-runner.mjs's revealTravelTimeEffect.
 */
// #93 pre-flight fix: two different children of the same fromId can
// independently roll a shortcut landing on the same downstream skipTarget
// (confirmed by review sweep, ~0.7% of graphs) — dedup so `hiddenEdges`
// never carries a repeated target, which would otherwise skew a future
// pick-one-to-reveal selection toward that duplicate.
function pushHiddenTarget(hiddenEdges, fromId, targetId) {
  const bucket = (hiddenEdges[fromId] ??= []);
  if (!bucket.includes(targetId)) bucket.push(targetId);
}

export function attachHiddenPaths({ rooms, edges, seed }) {
  const hiddenRooms = new Set();
  const hiddenEdges = {};
  let detourSalt = 0;
  // #93 pre-flight fix: a shortcut's `skipTarget` is ONE HOP PAST `toId`
  // (`edges[toId][0]`), not `toId` itself — the `toRoom.isGoal` guard
  // below only excludes `toId` from being the goal, it says nothing
  // about what `toId` points to. A room whose own single child IS the
  // goal (any room adjacent to it) would otherwise let a shortcut land
  // directly on the goal room, giving it a second incoming edge on
  // reveal and violating "the goal room always has exactly one incoming
  // edge... regardless of how branching rolled" (Global Constraints).
  const goalId = Object.values(rooms).find((r) => r.isGoal)?.id;

  for (const [fromId, children] of Object.entries(edges)) {
    const fromRoom = rooms[fromId];
    if (!fromRoom || fromRoom.isGoal || fromId === 'room-entry') continue;
    for (const toId of children) {
      const toRoom = rooms[toId];
      if (!toRoom || toRoom.isGoal) continue;
      const r = splitmix32(seedFromString(`${seed}-hidden-${fromId}-${toId}`))();
      if (r >= HIDDEN_PATH_CHANCE) continue;

      const wantsDetour = splitmix32(seedFromString(`${seed}-hidden-kind-${fromId}-${toId}`))() < 0.5;
      if (wantsDetour) {
        const detour = {
          id: `room-detour-${detourSalt}`, kind: roomKindAt(seed, `detour-${detourSalt}`),
          isGoal: false, setpieceId: null, outcomeSlotId: null,
          locationTag: locationTagAt(seed, `detour-${detourSalt}`),
          artVariant: roomArtVariantAt(seed, `detour-${detourSalt}`)
        };
        detourSalt += 1;
        rooms[detour.id] = detour;
        edges[detour.id] = [toId];
        hiddenRooms.add(detour.id);
        pushHiddenTarget(hiddenEdges, fromId, detour.id);
      } else {
        // A shortcut needs a room beyond `toId` to skip TO — only attach
        // one when `toId` itself has an onward edge to skip past, and
        // never when that onward edge is the goal room itself.
        const skipTarget = edges[toId]?.[0];
        if (!skipTarget || skipTarget === goalId) continue;
        pushHiddenTarget(hiddenEdges, fromId, skipTarget);
      }
    }
  }

  return { rooms, edges, hiddenRooms, hiddenEdges };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/dungeon-deck.test.mjs -t attachHiddenPaths`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add scripts/dungeon-deck.mjs tests/dungeon-deck.test.mjs
git commit -m "feat: attach pregenerated hidden shortcuts/detours to branch edges"
```

---

## Task 4: Rank/column tree-layout pass

**Files:**
- Modify: `scripts/dungeon-layout.mjs`
- Test: `tests/dungeon-layout.test.mjs`

**Interfaces:**
- Consumes: `{rooms, edges}` graph shape (Task 2/3, entry id `'room-entry'`).
- Produces: `computeRanks(edges, entryId)` → `{[roomId]: number}`; `computeColumns(edges, ranks, entryId)` → `{[roomId]: number}` (integer column index within its rank, not pixels).

- [ ] **Step 1: Write the failing tests**

```js
import { computeRanks, computeColumns } from '../scripts/dungeon-layout.mjs';
import { buildRoomGraph } from '../scripts/dungeon-deck.mjs';

describe('computeRanks', () => {
  it('entry is rank 0; a straight chain increments by 1', () => {
    const edges = { 'room-entry': ['a'], a: ['b'], b: ['c'], c: [] };
    const ranks = computeRanks(edges, 'room-entry');
    expect(ranks['room-entry']).toBe(0);
    expect(ranks.a).toBe(1);
    expect(ranks.b).toBe(2);
    expect(ranks.c).toBe(3);
  });

  it('a merge room takes the max rank over all its parents', () => {
    const edges = { 'room-entry': ['a', 'b'], a: ['m'], b: ['x', 'm'], x: ['m'], m: [] };
    const ranks = computeRanks(edges, 'room-entry');
    // a=1, b=1, x=2 (via b), m must be max(rank(a)+1, rank(b)+1, rank(x)+1) = 3
    expect(ranks.m).toBe(3);
  });
});

describe('computeColumns', () => {
  it('two siblings at the same rank get distinct columns', () => {
    const edges = { 'room-entry': ['a', 'b'], a: [], b: [] };
    const ranks = computeRanks(edges, 'room-entry');
    const cols = computeColumns(edges, ranks, 'room-entry');
    expect(cols.a).not.toBe(cols.b);
  });

  it('a single child is centered under a single parent (same column)', () => {
    const edges = { 'room-entry': ['a'], a: ['b'], b: [] };
    const ranks = computeRanks(edges, 'room-entry');
    const cols = computeColumns(edges, ranks, 'room-entry');
    expect(cols.a).toBe(cols['room-entry']);
    expect(cols.b).toBe(cols.a);
  });

  it('is deterministic and assigns every room a column', () => {
    const edges = { 'room-entry': ['a', 'b'], a: ['c'], b: ['c'], c: [] };
    const ranks = computeRanks(edges, 'room-entry');
    const cols = computeColumns(edges, ranks, 'room-entry');
    for (const id of Object.keys(edges)) expect(typeof cols[id]).toBe('number');
  });

  it('a diamond (two parents converging on the same child) still gives the two parents distinct columns (#93 pre-flight fix regression — the original centering design collapsed both onto the shared child\'s column, which roomRect would then place at the exact same grid cell)', () => {
    const edges = { 'room-entry': ['a', 'b'], a: ['c'], b: ['c'], c: [] };
    const ranks = computeRanks(edges, 'room-entry');
    const cols = computeColumns(edges, ranks, 'room-entry');
    expect(cols.a).not.toBe(cols.b);
  });

  it('no two rooms at the same rank ever share a column, across a wide sweep of generated graphs (the real invariant roomRect depends on to avoid overlapping rooms)', () => {
    for (let n = 0; n < 40; n += 1) {
      const seed = `layout-${n}`;
      for (const roomCount of [3, 4, 6, 8, 12, 16, 24]) {
        const { rooms, edges } = buildRoomGraph({ seed, roomCount });
        const ranks = computeRanks(edges, 'room-entry');
        const cols = computeColumns(edges, ranks, 'room-entry');
        const seenByRank = {};
        for (const roomId of Object.keys(rooms)) {
          const key = ranks[roomId];
          const col = cols[roomId];
          seenByRank[key] ??= new Set();
          expect(seenByRank[key].has(col)).toBe(false);
          seenByRank[key].add(col);
        }
      }
    }
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/dungeon-layout.test.mjs -t "computeRanks|computeColumns"`
Expected: FAIL — not a function

- [ ] **Step 3: Write minimal implementation**

Add to `scripts/dungeon-layout.mjs`:

```js
/** Topological rank (longest path from entryId) for every room in edges. */
export function computeRanks(edges, entryId) {
  const ranks = { [entryId]: 0 };
  // Kahn-style relaxation: repeatedly push rank = max(parent ranks) + 1
  // until stable — simpler than a strict topo-sort given this graph's
  // small size, and just as correct for a DAG.
  let changed = true;
  while (changed) {
    changed = false;
    for (const [fromId, children] of Object.entries(edges)) {
      if (!(fromId in ranks)) continue;
      for (const childId of children) {
        const candidate = ranks[fromId] + 1;
        if (!(childId in ranks) || ranks[childId] < candidate) {
          ranks[childId] = candidate;
          changed = true;
        }
      }
    }
  }
  return ranks;
}

/**
 * Column index (integer, per-rank left-to-right order) via a single DFS
 * pass from entryId — #93 pre-flight fix (see the note below the
 * function for what the original bottom-up-width/top-down-centering
 * design got wrong and why it was replaced). Every room is visited
 * exactly once (first parent to reach it wins, matching the design's
 * "merge rooms placed once, whichever parent reaches them first"
 * intent); each NEW room claims the next unused column at its own rank
 * via a monotonic per-rank counter, which is what actually guarantees
 * two different rooms at the same rank can never collide on a column —
 * `ranks` (pre-computed by computeRanks, already correctly reflecting a
 * merge room's longest-path rank) is looked up directly, not re-derived
 * from DFS depth, so a merge room still lands at its correct rank
 * regardless of which parent's branch reaches it first.
 */
export function computeColumns(edges, ranks, entryId) {
  const columns = {};
  const nextColByRank = {};
  const visited = new Set();

  function visit(roomId) {
    if (visited.has(roomId)) return;
    visited.add(roomId);
    const rank = ranks[roomId];
    const col = nextColByRank[rank] ?? 0;
    columns[roomId] = col;
    nextColByRank[rank] = col + 1;
    for (const childId of edges[roomId] ?? []) visit(childId);
  }
  visit(entryId);
  return columns;
}
```

**Why the original design was replaced (found during pre-flight review, before dispatch — Task 2 and Task 3's reviews both found similar "looks fine, isn't" bugs in this same plan's reference code, so this function got the same scrutiny before being handed to an implementer):** the original bottom-up-width/top-down-centering version computed each room's column as the AVERAGE of its children's columns — including children it merely referenced but didn't itself place (a merge room already positioned under an earlier sibling branch). For the extremely common diamond shape `entry -> [a, b]`, `a -> c`, `b -> c` (routine under Task 2's forced-merge algorithm, not a rare edge case), the original algorithm placed `a` and `b` — two DIFFERENT, SIMULTANEOUSLY-EXISTING rooms at the SAME rank — at the exact same column, because `b`'s only child `c` was already placed (under `a`'s branch) and `b`'s own column collapsed onto `c`'s column instead of respecting its own reserved offset. Since `roomRect(seed, roomId, rank, col)` (Task 5) computes a room's grid position purely from `(rank, col)`, two rooms sharing both would compute the SAME rect — a literal physical overlap of their walls, floor tiles, and content in the built Foundry scene. The replacement drops the "centered over children" visual niceness (not tested by, or required by, anything in this plan) in favor of the load-bearing correctness guarantee: no two rooms at the same rank ever share a column. `buildEdgeCorridor` (Task 6) already handles connecting rooms whose columns aren't adjacent via an L-shaped 2-segment corridor, so nothing downstream assumes parent/child columns are close together.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/dungeon-layout.test.mjs -t "computeRanks|computeColumns"`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add scripts/dungeon-layout.mjs tests/dungeon-layout.test.mjs
git commit -m "feat: add rank/column tree-layout pass for branching graphs"
```

---

## Task 5: Graph-based room rect and multi-exit enclosure walls

**Files:**
- Modify: `scripts/dungeon-layout.mjs`
- Test: `tests/dungeon-layout.test.mjs`

**Interfaces:**
- Consumes: `roomSizeAt(seed, roomId)` (existing, works unchanged with a string id in place of an integer slot), `computeRanks`/`computeColumns` (Task 4).
- Produces: `ROW_STRIDE`, `COLUMN_STRIDE` constants; `roomRect(seed, roomId, rank, col)` → `{gx, gy, gw, gh}`; `exitFaceForIndex(index)` → `'south' | 'east' | 'west'`; `roomEnclosureWalls(seed, roomId, { incomingFace, outgoingFaces }, rect)` (replaces the old `{hasOutgoing}` boolean signature — **breaking change**, callers updated in Task 10); `OPPOSITE` (exported face-inversion map); `incomingFaceFor(edges, roomId)` and `parentRoomIdFor(edges, roomId)` (both new, share one parent lookup, used together by Tasks 11/12).

- [ ] **Step 1: Write the failing tests**

```js
import { roomRect, exitFaceForIndex, roomEnclosureWalls, ROW_STRIDE, COLUMN_STRIDE } from '../scripts/dungeon-layout.mjs';

describe('roomRect', () => {
  it('is a pure function of (seed, roomId, rank, col)', () => {
    const a = roomRect('alpha', 'room-3', 2, 1);
    const b = roomRect('alpha', 'room-3', 2, 1);
    expect(a).toEqual(b);
  });

  it('increasing rank moves gy forward by at least ROW_STRIDE', () => {
    const a = roomRect('alpha', 'x', 0, 0);
    const b = roomRect('alpha', 'x', 1, 0);
    expect(b.gy - a.gy).toBeGreaterThanOrEqual(ROW_STRIDE - 1);
  });

  it('increasing col moves gx forward by at least COLUMN_STRIDE', () => {
    const a = roomRect('alpha', 'x', 0, 0);
    const b = roomRect('alpha', 'x', 0, 1);
    expect(b.gx - a.gx).toBeGreaterThanOrEqual(COLUMN_STRIDE - 1);
  });
});

describe('exitFaceForIndex', () => {
  it('assigns distinct faces to up to 3 exits', () => {
    expect(exitFaceForIndex(0)).toBe('south');
    expect(exitFaceForIndex(1)).toBe('east');
    expect(exitFaceForIndex(2)).toBe('west');
  });
});

describe('roomEnclosureWalls (multi-exit)', () => {
  // #93 pre-flight fix: roomEnclosureWalls' real Step-3 implementation
  // takes `rect` as a mandatory 4th argument (documented in this task's
  // own "Note for the implementer" and matching Task 10's real call
  // site) -- the Interfaces section's 3-arg summary above was incomplete.
  // Omitting it here would throw ("Cannot destructure property 'gx' of
  // undefined") rather than fail cleanly. A plain, arbitrary valid rect
  // is enough since these tests only assert on `.dir`, never coordinates.
  const rect = { gx: 0, gy: 0, gw: 4, gh: 4 };

  it('excludes the incoming face and every outgoing face', () => {
    const walls = roomEnclosureWalls('alpha', 'x', { incomingFace: 'north', outgoingFaces: ['south', 'east'] }, rect);
    const dirs = walls.map((w) => w.dir);
    expect(dirs).not.toContain('north');
    expect(dirs).not.toContain('south');
    expect(dirs).not.toContain('east');
    expect(dirs).toContain('west');
  });

  it('the entry room (no incomingFace) walls every side except its outgoing faces', () => {
    const walls = roomEnclosureWalls('alpha', 'room-entry', { incomingFace: null, outgoingFaces: ['south'] }, rect);
    expect(walls.map((w) => w.dir)).toEqual(expect.arrayContaining(['north', 'east', 'west']));
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/dungeon-layout.test.mjs -t "roomRect|exitFaceForIndex|multi-exit"`
Expected: FAIL

- [ ] **Step 3: Write minimal implementation**

Replace `slotRowCol`/`connectionDirection`/`slotRect`/`roomSides`/`roomEnclosureWalls`/`outgoingFaceWall` in `scripts/dungeon-layout.mjs` with:

```js
// Uniform grid cell strides — a deliberate simplification of a fully
// variable-width tree layout (see the design spec): every column is wide
// enough for the largest room, every rank tall enough for the tallest, so
// no two rooms ever overlap regardless of their individual roomSizeAt
// roll, and a room is still visually centered over its children via
// computeColumns' own column averaging.
export const ROW_STRIDE = ROOM_SIZE_LARGE + CORRIDOR_LEN;
export const COLUMN_STRIDE = ROOM_SIZE_LARGE + CORRIDOR_LEN;

/** A room's footprint, positioned by its graph rank/column instead of a linear slot. */
export function roomRect(seed, roomId, rank, col) {
  const size = roomSizeAt(seed, roomId);
  return {
    gx: INITIAL_GX + col * COLUMN_STRIDE,
    gy: rank * ROW_STRIDE,
    gw: size,
    gh: size
  };
}

/** Deterministic compass face for a room's Nth exit (0-2), always distinct. */
export function exitFaceForIndex(index) {
  return ['south', 'east', 'west'][index];
}

// #93 pre-flight fix: exported (not just module-internal) so Task 10's
// buildPopulateAndUnlockGraphNode (dungeon-scene.mjs) can derive a room's
// exit-face-toward-a-specific-child directly as OPPOSITE[childsIncomingFace]
// instead of re-deriving it a second, less direct way.
export const OPPOSITE = { north: 'south', south: 'north', east: 'west', west: 'east' };

/**
 * The compass face on `roomId` where its one incoming connection arrives —
 * derived from whichever parent's `childIds` includes it, and at which
 * index (exitFaceForIndex, then OPPOSITE). Returns null for the entry room
 * (no parent) and throws if `roomId` has no parent in `edges` and isn't the
 * entry — every other room in a valid graph has exactly one parent by
 * construction (buildRoomGraph never gives a non-entry room two parents
 * outside a forced merge, and a merge room's OWN incoming face still comes
 * from a single position in the layout — see computeColumns' "placed under
 * whichever parent reaches it first" rule, which is also the parent this
 * function must agree with).
 */
export function incomingFaceFor(edges, roomId) {
  if (roomId === 'room-entry') return null;
  for (const [parentId, children] of Object.entries(edges)) {
    const index = children.indexOf(roomId);
    if (index !== -1) return OPPOSITE[exitFaceForIndex(index)];
  }
  throw new Error(`no parent found for room ${roomId}`);
}

/**
 * The id of `roomId`'s one parent in `edges` — same lookup as
 * `incomingFaceFor`, returning the parent id instead of the face. Every
 * caller that needs `buildPopulateAndUnlockGraphNode`'s `parentRoomId` and
 * `incomingFace` together (Tasks 11, 12) calls both against the same
 * `edges` so the two agree by construction. Returns null for the entry
 * room, throws under the same conditions `incomingFaceFor` does.
 */
export function parentRoomIdFor(edges, roomId) {
  if (roomId === 'room-entry') return null;
  for (const [parentId, children] of Object.entries(edges)) {
    if (children.includes(roomId)) return parentId;
  }
  throw new Error(`no parent found for room ${roomId}`);
}

function roomSidesFor(rect) {
  const { gx, gy, gw, gh } = rect;
  return {
    north: { x1: gx, y1: gy, x2: gx + gw, y2: gy },
    south: { x1: gx, y1: gy + gh, x2: gx + gw, y2: gy + gh },
    west: { x1: gx, y1: gy, x2: gx, y2: gy + gh },
    east: { x1: gx + gw, y1: gy, x2: gx + gw, y2: gy + gh }
  };
}

/**
 * A room's own enclosing walls (#93 generalization), excluding its one
 * incoming face and every one of its (possibly several) outgoing faces —
 * each excluded face gets real connection/frontier geometry from
 * buildEdgeCorridor / dungeon-scene.mjs's build step instead. `rect` is
 * the room's own already-computed `roomRect(...)` result — required,
 * since rank/col (and so the rect) aren't derivable from `roomId` alone
 * the way the old slot-indexed version could derive `slotRect` internally.
 */
export function roomEnclosureWalls(seed, roomId, { incomingFace, outgoingFaces }, rect) {
  const excluded = new Set(outgoingFaces);
  if (incomingFace) excluded.add(incomingFace);
  return Object.entries(roomSidesFor(rect))
    .filter(([dir]) => !excluded.has(dir))
    .map(([dir, c]) => ({ dir, ...c }));
}
```

**Note for the implementer:** callers (Task 10) must pass the room's already-computed `roomRect(...)` result as the 4th argument — this is a breaking signature change from the old `roomEnclosureWalls(seed, slot, {hasOutgoing})`, so every existing call site is updated in this task, not left dual-supporting both shapes.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/dungeon-layout.test.mjs`
Expected: PASS. Fix up any other existing tests in `tests/dungeon-layout.test.mjs` that reference the now-removed `slotRowCol`/`connectionDirection`/`slotRect`/`outgoingFaceWall`/`doorOffsetAt(seed, slot, ...)` — delete those obsolete tests as part of this step (superseded by Task 4/5/6's new tests), noting in the commit message that they're removed, not just failing.

- [ ] **Step 5: Commit**

```bash
git add scripts/dungeon-layout.mjs tests/dungeon-layout.test.mjs
git commit -m "feat: replace linear slot geometry with graph rank/column room rects"
```

---

## Task 6: Multi-segment edge corridor geometry

**Files:**
- Modify: `scripts/dungeon-layout.mjs`
- Test: `tests/dungeon-layout.test.mjs`

**Interfaces:**
- Consumes: `roomRect` (Task 5), existing `doorOffsetAt`, `corridorTileVariant` (unchanged in spirit, `doorOffsetAt`'s `slot` param renamed conceptually to a `(seed, roomId, face, role, roomSize)` key so two different exit faces on the same room never collide on the same offset).
- Produces: `buildEdgeCorridor(seed, fromRoomId, toRoomId, fromRect, toRect, exitFace)` → `{ doorWall, revealDoorWall, plainWalls, corridorSegments }`. `corridorSegments` is an array of 1+ `{gx, gy, gw, gh}` rects (1 when `fromRect`/`toRect` share a column, 2 — an L-shape — otherwise), replacing the old single `corridorRect`.

- [ ] **Step 1: Write the failing tests**

```js
import { roomRect, buildEdgeCorridor } from '../scripts/dungeon-layout.mjs';

describe('buildEdgeCorridor', () => {
  it('same-column rooms (straight south connection) produce one corridor segment', () => {
    const from = roomRect('alpha', 'a', 0, 0);
    const to = roomRect('alpha', 'b', 1, 0);
    const { corridorSegments } = buildEdgeCorridor('alpha', 'a', 'b', from, to, 'south');
    expect(corridorSegments).toHaveLength(1);
  });

  it('different-column rooms produce an L-shaped (2-segment) corridor', () => {
    const from = roomRect('alpha', 'a', 0, 0);
    const to = roomRect('alpha', 'b', 1, 2);
    const { corridorSegments } = buildEdgeCorridor('alpha', 'a', 'b', from, to, 'south');
    expect(corridorSegments).toHaveLength(2);
  });

  it('always returns a door wall and a reveal door wall', () => {
    const from = roomRect('alpha', 'a', 0, 0);
    const to = roomRect('alpha', 'b', 1, 1);
    const { doorWall, revealDoorWall } = buildEdgeCorridor('alpha', 'a', 'b', from, to, 'south');
    expect(doorWall).toBeDefined();
    expect(revealDoorWall).toBeDefined();
  });

  it('two exits from the same room on different faces never share a door offset key', () => {
    const from = roomRect('alpha', 'a', 0, 0);
    const toSouth = roomRect('alpha', 'b', 1, 0);
    const toEast = roomRect('alpha', 'c', 0, 1);
    const south = buildEdgeCorridor('alpha', 'a', 'b', from, toSouth, 'south');
    const east = buildEdgeCorridor('alpha', 'a', 'c', from, toEast, 'east');
    expect(south.doorWall).not.toEqual(east.doorWall);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/dungeon-layout.test.mjs -t buildEdgeCorridor`
Expected: FAIL

- [ ] **Step 3: Write minimal implementation**

Add to `scripts/dungeon-layout.mjs` (reuses `doorOffsetAt`'s existing signature, now keyed by `roomId-face` instead of a bare slot, and `CORRIDOR_LEN`/`DOOR_WIDTH`):

```js
/**
 * Edge geometry connecting fromRoomId's exitFace to toRoomId's incoming
 * face (always the opposite compass direction). Generalizes the old
 * buildConnectionGeometry (slot to slot+1, always straight) to any two
 * graph-positioned rects: same-column rooms still get the old single
 * straight corridor; different-column rooms get an L-shaped 2-segment
 * corridor (first segment leaves fromRect on exitFace, second segment
 * approaches toRect on its incoming face, joined by a single corner).
 */
export function buildEdgeCorridor(seed, fromRoomId, toRoomId, fromRect, toRect, exitFace) {
  const incomingFace = OPPOSITE[exitFace];
  const outgoingOffset = doorOffsetAt(seed, `${fromRoomId}-${exitFace}`, 'outgoing', fromRect.gw);
  const incomingOffset = doorOffsetAt(seed, `${toRoomId}-${incomingFace}`, 'incoming', toRect.gw);

  const sameColumn = fromRect.gx === toRect.gx;
  if (exitFace === 'south' && sameColumn) {
    const faceY = fromRect.gy + fromRect.gh;
    const corridorEndY = faceY + CORRIDOR_LEN;
    const doorX0 = fromRect.gx + outgoingOffset;
    const doorX1 = doorX0 + DOOR_WIDTH;
    const gapX0 = toRect.gx + incomingOffset;
    const gapX1 = gapX0 + DOOR_WIDTH;
    const spanX0 = Math.min(doorX0, gapX0);
    const spanX1 = Math.max(doorX1, gapX1);
    return {
      doorWall: { x1: doorX0, y1: faceY, x2: doorX1, y2: faceY },
      revealDoorWall: { x1: gapX0, y1: corridorEndY, x2: gapX1, y2: corridorEndY },
      plainWalls: [
        { x1: fromRect.gx, y1: faceY, x2: doorX0, y2: faceY },
        { x1: doorX1, y1: faceY, x2: Math.max(fromRect.gx + fromRect.gw, spanX1), y2: faceY },
        { x1: toRect.gx, y1: corridorEndY, x2: gapX0, y2: corridorEndY },
        { x1: gapX1, y1: corridorEndY, x2: Math.max(toRect.gx + toRect.gw, spanX1), y2: corridorEndY }
      ].filter((w) => w.x1 !== w.x2 || w.y1 !== w.y2),
      corridorSegments: [{ gx: spanX0, gy: faceY, gw: spanX1 - spanX0, gh: CORRIDOR_LEN }]
    };
  }

  // Different column (or a non-south exit face): a straight leg out of
  // fromRect on exitFace, a corner, then a straight leg into toRect on its
  // incoming face. Simpler than the same-column case's precise two-door
  // offset trimming — a candidate for a future refinement pass if a
  // reviewer finds the corner geometry too blocky in practice.
  const exitPoint = exitFace === 'east'
    ? { x: fromRect.gx + fromRect.gw, y: fromRect.gy + fromRect.gh / 2 }
    : exitFace === 'west'
    ? { x: fromRect.gx, y: fromRect.gy + fromRect.gh / 2 }
    : { x: fromRect.gx + fromRect.gw / 2, y: fromRect.gy + fromRect.gh };
  const entryPoint = { x: toRect.gx + toRect.gw / 2, y: toRect.gy };
  const corner = { x: entryPoint.x, y: exitPoint.y };

  const doorWall = exitFace === 'south'
    ? { x1: exitPoint.x - DOOR_WIDTH / 2, y1: exitPoint.y, x2: exitPoint.x + DOOR_WIDTH / 2, y2: exitPoint.y }
    : { x1: exitPoint.x, y1: exitPoint.y - DOOR_WIDTH / 2, x2: exitPoint.x, y2: exitPoint.y + DOOR_WIDTH / 2 };
  const revealDoorWall = { x1: entryPoint.x - DOOR_WIDTH / 2, y1: entryPoint.y, x2: entryPoint.x + DOOR_WIDTH / 2, y2: entryPoint.y };

  return {
    doorWall,
    revealDoorWall,
    plainWalls: [],
    corridorSegments: [
      { gx: Math.min(exitPoint.x, corner.x), gy: Math.min(exitPoint.y, corner.y), gw: Math.max(CORRIDOR_LEN, Math.abs(corner.x - exitPoint.x)), gh: CORRIDOR_LEN },
      { gx: Math.min(corner.x, entryPoint.x), gy: Math.min(corner.y, entryPoint.y), gw: CORRIDOR_LEN, gh: Math.max(CORRIDOR_LEN, Math.abs(entryPoint.y - corner.y)) }
    ]
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/dungeon-layout.test.mjs -t buildEdgeCorridor`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add scripts/dungeon-layout.mjs tests/dungeon-layout.test.mjs
git commit -m "feat: add buildEdgeCorridor for straight and L-shaped graph edges"
```

---

## Task 7: Graph-shaped run state and topological eager build

**Files:**
- Modify: `scripts/dungeon-runner.mjs`
- Test: `tests/dungeon-runner.test.mjs`

**Interfaces:**
- Consumes: `{rooms, edges}` (Task 2/3).
- Produces: `roomsToEagerlyBuild(state)` (same exported name, new graph-walk implementation, unconditional — no `hostUserId` gate, no ITEM-11 index-1 special case) → array of `{room, buildOrder}` in topological order (parents before children). `buildOrder` replaces the old `physicalSlot` name in this return shape (still a plain monotonic integer, same role); `commitEagerPhysicalSlots` (existing) keeps working unmodified against this shape since it only destructures `{room, physicalSlot}` — **rename the destructured field to `buildOrder` in both functions together** so the two stay in sync.

- [ ] **Step 1: Write the failing tests**

```js
import { roomsToEagerlyBuild } from '../scripts/dungeon-runner.mjs';

function graphState(overrides = {}) {
  return {
    rooms: {
      'room-entry': { id: 'room-entry', kind: 'safe_entry', isGoal: false },
      a: { id: 'a', kind: 'combat', isGoal: false },
      b: { id: 'b', kind: 'trap', isGoal: false },
      goal: { id: 'goal', kind: 'combat', isGoal: true }
    },
    edges: { 'room-entry': ['a', 'b'], a: ['goal'], b: ['goal'], goal: [] },
    hostUserId: null,
    ...overrides
  };
}

describe('roomsToEagerlyBuild (graph)', () => {
  it('builds every room except the entry, regardless of hostUserId', () => {
    const withHost = roomsToEagerlyBuild(graphState({ hostUserId: 'u1' }));
    const withoutHost = roomsToEagerlyBuild(graphState({ hostUserId: null }));
    expect(withHost.map((e) => e.room.id).sort()).toEqual(['a', 'b', 'goal']);
    expect(withoutHost.map((e) => e.room.id).sort()).toEqual(['a', 'b', 'goal']);
  });

  it('every room appears after all of its parents (topological order)', () => {
    const built = roomsToEagerlyBuild(graphState());
    const order = built.map((e) => e.room.id);
    expect(order.indexOf('a')).toBeLessThan(order.indexOf('goal'));
    expect(order.indexOf('b')).toBeLessThan(order.indexOf('goal'));
  });

  it('a combat room at generation-order position 1 is still eagerly built (ITEM-11 deferral removed)', () => {
    const built = roomsToEagerlyBuild(graphState());
    expect(built.some((e) => e.room.id === 'a' && e.room.kind === 'combat')).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/dungeon-runner.test.mjs -t "roomsToEagerlyBuild"`
Expected: FAIL (existing implementation still assumes `state.rooms` is an array)

- [ ] **Step 3: Write minimal implementation**

Replace the existing `roomsToEagerlyBuild` in `scripts/dungeon-runner.mjs`:

```js
/**
 * Every room #93's full-graph pregeneration should build eagerly at run
 * start, as `{room, buildOrder}` pairs in topological order (a room always
 * appears after every one of its parents) — every room except the entry
 * (built separately by startDungeonRun itself). Unconditional: applies to
 * every run, GM-present or GM-less alike (no more hostUserId gate), and no
 * longer special-cases a combat room at generation-order position 1 — the
 * ITEM-11 manual deferral is removed, since per-door lazy building and the
 * Accept/Reroll dialog it paced around are both gone.
 */
export function roomsToEagerlyBuild(state) {
  const { rooms, edges } = state;
  const order = [];
  const visited = new Set(['room-entry']);
  const indegree = {};
  for (const id of Object.keys(rooms)) indegree[id] = 0;
  for (const children of Object.values(edges)) {
    for (const childId of children) indegree[childId] += 1;
  }
  const queue = (edges['room-entry'] ?? []).slice();
  while (queue.length) {
    const id = queue.shift();
    if (visited.has(id)) continue;
    // Only ready once every parent has already been queued/visited — a
    // simple readiness re-check via indegree decrement per visit below.
    visited.add(id);
    order.push(rooms[id]);
    for (const childId of edges[id] ?? []) {
      indegree[childId] -= 1;
      if (indegree[childId] <= 0 && !visited.has(childId)) queue.push(childId);
    }
  }
  return order.map((room, i) => ({ room, buildOrder: i }));
}
```

**Note for the implementer:** update `commitEagerPhysicalSlots`'s destructuring (`for (const { room, physicalSlot } of eagerlyBuilt)`) to `{ room, buildOrder }`, and rename its internal `nextPhysicalSlot` bookkeeping usage to consume `buildOrder` in place of `physicalSlot` — the field's role (a monotonic build-order/identity token) is unchanged, only the name, to stop implying a linear array position.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/dungeon-runner.test.mjs -t "roomsToEagerlyBuild"`
Expected: PASS. Run the full `dungeon-runner.test.mjs` file too and fix any other test in it that still constructs `state.rooms` as an array — update those fixtures to the graph shape as part of this step.

- [ ] **Step 5: Commit**

```bash
git add scripts/dungeon-runner.mjs tests/dungeon-runner.test.mjs
git commit -m "feat: make roomsToEagerlyBuild a topological graph walk, unconditional"
```

---

## Task 8: Graph-aware `advanceToRoom`

**Files:**
- Modify: `scripts/dungeon-runner.mjs`
- Test: `tests/dungeon-runner.test.mjs`

**Interfaces:**
- Consumes: `state.edges`, `state.currentRoomId` (replaces `state.currentIndex`).
- Produces: `advanceToRoom({sceneId, roomId, revealedTokenIds})` — same exported signature, now accepts `roomId` as any child of the current room (not just a fixed successor).

- [ ] **Step 1: Write the failing test**

```js
import { advanceToRoom } from '../scripts/dungeon-runner.mjs';
import * as settings from '../scripts/dungeon-runner.mjs'; // adjust to this repo's existing settingsRef test double pattern

// Uses this file's existing fake settingsRef/getRunState test harness — see
// the surrounding describe blocks in tests/dungeon-runner.test.mjs for the
// established fixture helpers (fakeSettingsRef, seedRunState, etc.) and
// reuse them rather than reinventing a second one here.

describe('advanceToRoom (graph)', () => {
  it('accepts any of the current room\'s children, not just a fixed "index + 1" successor', async () => {
    // Arrange a run state at a 2-exit room with children 'east-room' and
    // 'south-room' via this file's existing seedRunState-style helper,
    // asserting the party can move into either.
  });

  it('rejects a roomId that is not one of the current room\'s children', async () => {
    // Same arrangement; assert advanceToRoom returns { ok: false } for an
    // unrelated room id.
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/dungeon-runner.test.mjs -t "advanceToRoom (graph)"`
Expected: FAIL

- [ ] **Step 3: Write minimal implementation**

Replace `advanceToRoom` in `scripts/dungeon-runner.mjs`:

```js
export async function advanceToRoom(
  { sceneId, roomId, revealedTokenIds = [] },
  { settingsRef = defaultSettingsRef() } = {},
) {
  const state = getRunState(sceneId, { settingsRef });
  if (!state) return { ok: false, state: null };
  const children = state.edges[state.currentRoomId] ?? [];
  if (!children.includes(roomId)) return { ok: false, state };

  const newState = {
    ...state,
    currentRoomId: roomId,
    lastAutoEntry: {
      roomId,
      fromRoomId: state.currentRoomId,
      toRoomId: roomId,
      revealedTokenIds,
    },
  };
  await persist(sceneId, newState, settingsRef);
  return { ok: true, state: newState };
}
```

**Note for the implementer:** `canUndoRoomEntry` reads `state.lastAutoEntry.roomId` only, so it's unaffected by the `fromIndex`/`toIndex` → `fromRoomId`/`toRoomId` rename — verify this by re-running its existing tests unmodified after this change; if anything else in the file destructures `lastAutoEntry.fromIndex`/`.toIndex`, update it to the new field names in this same task.

**#93 pre-flight fix — a real gap, not covered by the note above:**
`undoLastRoomEntry` (`dungeon-runner.mjs`, current implementation below)
reads `undone.fromIndex` and writes `currentIndex: undone.fromIndex` — it
must be updated in this same task, or undo silently breaks (references an
undefined field, never actually restores the room):

```js
export async function undoLastRoomEntry(
  { sceneId },
  { settingsRef = defaultSettingsRef() } = {},
) {
  const state = getRunState(sceneId, { settingsRef });
  if (!state || !canUndoRoomEntry(state))
    return { ok: false, state: state ?? null, undone: null };

  const undone = state.lastAutoEntry;
  const newState = {
    ...state,
    currentRoomId: undone.fromRoomId,
    lastAutoEntry: null,
  };
  await persist(sceneId, newState, settingsRef);
  return { ok: true, state: newState, undone };
}
```

Add a test for this alongside the two above: arrange a state whose
`lastAutoEntry` is `{roomId: 'b', fromRoomId: 'a', toRoomId: 'b'}` and
`currentRoomId: 'b'`, call `undoLastRoomEntry`, assert the returned
state's `currentRoomId` is `'a'`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/dungeon-runner.test.mjs -t "advanceToRoom"`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add scripts/dungeon-runner.mjs tests/dungeon-runner.test.mjs
git commit -m "feat: make advanceToRoom accept any of the current room's graph children"
```

---

## Task 9: Graph-aware `markRoomOutcome` with hidden-path reveal

**Files:**
- Modify: `scripts/dungeon-runner.mjs`, `scripts/dungeon-deck.mjs`
- Test: `tests/dungeon-runner.test.mjs`, `tests/dungeon-deck.test.mjs`

**Interfaces:**
- Consumes: `state.rooms`/`state.edges`/`state.currentRoomId` (graph shape), `state.hiddenEdges`/`state.hiddenRooms` (Task 3's shape, carried on run state).
- Produces: `revealTravelTimeEffect({ edges, hiddenEdges }, roomId, effectKey)` (new, `dungeon-deck.mjs`) → `{ edges, hiddenEdges }` with the room's hidden path (if any) merged into the live `edges` and removed from `hiddenEdges`, or unchanged if there's nothing hidden to reveal. `markRoomOutcome` (existing name, `dungeon-runner.mjs`) drops all `applySequenceMutation`/physical-slot-assignment logic and instead calls `revealTravelTimeEffect` when `effectKey` is `'reduced_travel_time'` or `'extra_travel_time'`. `depthBiasFor({rank, maxRank, isGoal})`/`lootGpForTreasureRoom({partyLevel, rank, maxRank, isGoal})`/`treasureRoomItemTableName({partyLevel, rank, maxRank, isGoal, rng})` (all three existing names, `dungeon-deck.mjs`, `physicalSlot`/`roomCount` renamed to `rank`/`maxRank` — #93 pre-flight fix, Step 3a; Task 10's own `depthBiasFor` call and Task 13's `applyRoomEffect`/`grantTreasureReward` call depend on this rename).

- [ ] **Step 1: Write the failing tests**

```js
// tests/dungeon-deck.test.mjs
import { revealTravelTimeEffect } from '../scripts/dungeon-deck.mjs';

describe('revealTravelTimeEffect', () => {
  it('merges a room\'s hidden edge into the live edges and removes it from hiddenEdges', () => {
    const state = { edges: { a: ['b'] }, hiddenEdges: { a: ['shortcut-target'] } };
    const result = revealTravelTimeEffect(state, 'a', 'reduced_travel_time');
    expect(result.edges.a).toEqual(expect.arrayContaining(['b', 'shortcut-target']));
    expect(result.hiddenEdges.a).toBeUndefined();
  });

  it('is a no-op when the room has no hidden edge', () => {
    const state = { edges: { a: ['b'] }, hiddenEdges: {} };
    const result = revealTravelTimeEffect(state, 'a', 'extra_travel_time');
    expect(result).toEqual(state);
  });
});
```

```js
// tests/dungeon-runner.test.mjs
describe('markRoomOutcome (graph)', () => {
  it('never mutates state.rooms/state.edges shape via splicing — only reveals hidden paths', async () => {
    // Arrange a run state (via this file's existing seedRunState-style
    // helper) at a non-goal room with a hiddenEdges entry and
    // outcomeSlotId resolving to 'reduced_travel_time' on success; assert
    // after markRoomOutcome({sceneId, succeeded: true}) that the room's
    // hidden edge is now live in state.edges and absent from
    // state.hiddenEdges, and that state.rooms is untouched (same object
    // keys/values as before, no rooms added or removed).
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/dungeon-deck.test.mjs tests/dungeon-runner.test.mjs -t "revealTravelTimeEffect|markRoomOutcome \\(graph\\)"`
Expected: FAIL

- [ ] **Step 3: Write minimal implementation**

Add to `scripts/dungeon-deck.mjs`:

```js
/**
 * Resolve a reduced_travel_time/extra_travel_time outcome against a
 * pregenerated graph (#93) — reveals whatever hidden shortcut/detour edge
 * generation attached to `roomId` (attachHiddenPaths), if any. Never
 * builds or removes a room; the target was already constructed at
 * scene-creation time. A no-op if nothing was hidden there.
 */
// Data-only reveal — see #156, filed during #93 pre-flight review: no
// door/room geometry is built for the revealed edge anywhere in this
// plan yet. Deliberately deferred; do not block this task on it.
export function revealTravelTimeEffect({ edges, hiddenEdges }, roomId, effectKey) {
  if (effectKey !== 'reduced_travel_time' && effectKey !== 'extra_travel_time') {
    return { edges, hiddenEdges };
  }
  const hidden = hiddenEdges[roomId];
  if (!hidden?.length) return { edges, hiddenEdges };
  const newHiddenEdges = { ...hiddenEdges };
  delete newHiddenEdges[roomId];
  return {
    edges: { ...edges, [roomId]: [...(edges[roomId] ?? []), ...hidden] },
    hiddenEdges: newHiddenEdges
  };
}
```

In `scripts/dungeon-runner.mjs`, replace the `mutation`/`rooms`/physical-slot-assignment block inside `markRoomOutcome` (the code between computing `effectKey`/`mutation` and building `newState`) with:

```js
  const { effectKey } =
    room.kind === "safe_rest"
      ? { effectKey: "rest_room_passed" }
      : getGenerator().resolveRoomOutcome(getGenerator().findOutcomeTemplate(room.outcomeSlotId), succeeded);

  const { edges, hiddenEdges } = getGenerator().revealTravelTimeEffect(
    { edges: state.edges, hiddenEdges: state.hiddenEdges },
    room.id,
    effectKey,
  );

  const newState = {
    ...state,
    edges,
    hiddenEdges,
    history: [...state.history, { ...base, effectKey }],
  };
  await persist(sceneId, newState, settingsRef);
  return { state: newState, effectKey };
```

**Note for the implementer:** the function's earlier lines (`const room = state.rooms[state.currentIndex]` and the double-resolution guard checking `state.history`) must be updated too — `room = state.rooms[state.currentRoomId]`. `getGenerator()` is this file's existing indirection for swapping the sequence generator module in tests; confirm `revealTravelTimeEffect` is added to whatever object `getGenerator()` returns (mirroring how `resolveRoomOutcome`/`findOutcomeTemplate`/`applySequenceMutation` are already exposed there) and remove `applySequenceMutation` from that surface since nothing calls it anymore after this task. For type consistency, also trim `mutation`/`nextRoomId`/`nextPhysicalSlot` from every early-return object earlier in the function (the `!state || state.completed` guard, the double-resolution guard, and the missing-outcome-slot guard) so every return path from `markRoomOutcome` shares the same `{state, effectKey}` shape — a caller destructuring `.mutation` off any return path should get `undefined`, not have some paths carry a stale `null` for a field that no longer means anything.

- [ ] **Step 3a: #93 pre-flight fix — rename `depthBiasFor`'s `physicalSlot`/`roomCount` to `rank`/`maxRank`**

`depthBiasFor` (`scripts/dungeon-deck.mjs:88-92`) computes a room's difficulty/reward ramp from `physicalSlot / (roomCount - 1)` — both parameters are pure linear-sequence concepts that don't exist once rooms are graph nodes with a `rank`/`col` position instead of an array index. Left unrenamed, Task 10's Step 3c combat branch (which passes `rank`/`state.maxRank`, since this task lands before Task 10) would be silently passing its arguments into a `physicalSlot`/`roomCount`-shaped destructure, leaving the real `physicalSlot` field `undefined` and `fraction` computing as `NaN` — a dungeon-wide silent break of encounter difficulty AND treasure-room loot/item-tier scaling, not a localized bug. Fix the source of the mismatch instead of the call sites papering over it:

```js
export function depthBiasFor({ rank, maxRank, isGoal }) {
  if (isGoal) return MAX_DEPTH_BIAS;
  const fraction = rank / Math.max(1, maxRank);
  return Math.round(fraction * MAX_DEPTH_BIAS);
}
```

`maxRank` is the graph's own deepest rank (computed once by Task 12 via `computeRanks` and stored on `state.maxRank` — see Task 12's Step 3), replacing `roomCount - 1`'s role as the normalization denominator; `rank` replaces `physicalSlot` directly (both start at the entry room's own rank/slot and increase with depth, so the ramp's shape is unchanged, just re-keyed).

This same file's two `physicalSlot`-shaped dependents take the identical rename, since both just forward the field straight into `depthBiasFor`:

```js
export function lootGpForTreasureRoom({ partyLevel, rank, maxRank, isGoal }) {
  const bias = depthBiasFor({ rank, maxRank, isGoal });
  return Math.round(partyLevel * TREASURE_GP_PER_LEVEL * (1 + bias / MAX_DEPTH_BIAS));
}

export function treasureRoomItemTableName({ partyLevel, rank, maxRank, isGoal, rng }) {
  const gp = lootGpForTreasureRoom({ partyLevel, rank, maxRank, isGoal });
  const category = pickWeightedCategory(TREASURE_ROOM_CATEGORY_WEIGHTS, rng());
  return category === 'valuable'
    ? valuableTierForBudget(gp * ITEM_PRICE_BUDGET_FRACTION)
    : nthLevelTableName(category, partyLevel);
}
```

Update every existing test in `tests/dungeon-deck.test.mjs` that constructs a `{physicalSlot, roomCount, ...}` args object for `depthBiasFor`/`lootGpForTreasureRoom`/`treasureRoomItemTableName` (lines 298, 302-303, 310, 318, 363, 369, 373-374, 379-380, 388, 396, 429 as of this plan's writing — re-grep, since Task numbering elsewhere in this plan may shift exact line numbers before this task runs) to pass `{rank, maxRank, ...}` instead, preserving each test's original intent (e.g. `physicalSlot: 0, roomCount: 8` → `rank: 0, maxRank: 7`; `physicalSlot: 19, roomCount: 20` → `rank: 19, maxRank: 19`; the ratio `physicalSlot / (roomCount - 1)` and `rank / maxRank` must land on the same fraction for each converted case).

`applyRoomEffect`/`grantTreasureReward` in `scripts/ui/dungeon-app.mjs` (the treasure-room caller) are updated by Task 13, which already touches that file and now has this rename as a dependency.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/dungeon-deck.test.mjs tests/dungeon-runner.test.mjs`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add scripts/dungeon-deck.mjs scripts/dungeon-runner.mjs tests/dungeon-deck.test.mjs tests/dungeon-runner.test.mjs
git commit -m "feat: redefine travel-time outcomes as hidden-path reveals, not runtime splices"
```

---

## Task 10: Multi-exit room build, content population, and frontier placeholders (`dungeon-scene.mjs`)

**#93 pre-flight fix — this task's scope was expanded during plan review.**
The original version only replaced `buildRoomAtSlot` (walls/geometry). Live
verification against the actual current codebase (not just the 2-day-old
plan text) found that `buildRoomAtSlot` is never called by itself in
practice — every real caller goes through `buildPopulateAndUnlockRoom`
(`dungeon-scene.mjs:850`), which ALSO populates each room's content
(encounter/trap/puzzle/skill-challenge/narrative/treasure) and unlocks its
door, all keyed by the same `physicalSlot`/`dungeonSlot` flag the geometry
functions used. The original plan left this entire function — and the
`dungeonSlot`-flag-keyed helpers it calls (`populateSlotEncounter`,
`populateSlotTrap`, `unlockDoorToSlot`, `isSlotPopulated`, `isSlotBuilt`)
— completely unaddressed. Dispatched as originally written, Tasks 10/12
would have built a dungeon of empty, permanently-locked rooms. This
corrected version covers the whole thing in one task, since it's all the
same file and the same "slot → graph node" generalization.

**Files:**
- Modify: `scripts/dungeon-scene.mjs`, `scripts/dungeon-layout.mjs` (export `roomSidesFor` as `roomSidesForRect`), `scripts/dungeon-combat.mjs` (rename `startCombatForSlot`/`getCombatForSlot` — see Step 3d)
- Test: manual/live verification only (this file has no Foundry test harness, same existing boundary as `buildRoomAtSlot`/`buildConnectionGeometry` today — see the spec's Testing section).

**Interfaces:**
- Consumes: `roomRect`, `roomEnclosureWalls`, `exitFaceForIndex`, `incomingFaceFor`, `parentRoomIdFor`, `OPPOSITE`, `ROW_STRIDE`, `COLUMN_STRIDE` (Task 5), `buildEdgeCorridor` (Task 6).
- Produces: `buildRoomAtGraphNode(scene, roomId, {rank, col, incomingFace, childIds, isGoal, locationTag, artVariant, seed})` (replaces `buildRoomAtSlot`, this room's own enclosure walls/floor art/light only — creates them directly rather than returning them, also writes a `dungeonDoorToRoomId` flag onto each created door/reveal-door wall — Task 11 reads it directly off the wall, no separate in-memory lookup needed — and returns `{rect, outgoingFaces, placeholderIds}`, deliberately NOT deleting `placeholderIds` itself, deferring that to the caller for #110 ordering); `buildPopulateAndUnlockGraphNode(scene, state, room, {rank, col, incomingFace, childIds, parentRoomId, unlock})` (replaces `buildPopulateAndUnlockRoom` — walls + parent-connection geometry + content population + door unlock, the actual function Tasks 11/12/13 call; `parentRoomId` comes from `parentRoomIdFor(edges, room.id)`, resolved by the caller against the same `edges` used for `incomingFace`); `resizeSceneForLayout(scene, {maxRank, maxCol})` (new, replaces the per-room `ensureSceneCovers`/`requiredDimensions(maxSlot)` pair — called ONCE by Task 12 right after layout is computed, before any room builds, since the whole graph's extent is known up front under full pregeneration); `unlockDoorsFromRoom(scene, roomId, childIds, hiddenChildIds)` (new — unlocks every one of `roomId`'s outgoing doors whose target is in `childIds` but not in `hiddenChildIds`, via each door's own `dungeonDoorToRoomId` flag; used by Task 13's corrected trailing block instead of building a "next room").

- [ ] **Step 1: Write the plan for manual verification**

No unit test — write out, in a comment block above `buildRoomAtGraphNode`, the exact live-verification checklist to run once implemented (mirrors the spec's Testing section): (a) a 1-exit room behaves identically to today's single-corridor case, content and all; (b) a 2-exit room gets two independently lockable doors on different faces, each leading to its own distinct populated child; (c) opening either door correctly supersedes only that door's own frontier placeholder, leaving the room's other still-unopened exit's placeholder untouched; (d) the real walls for a newly built connection are always created before the old frontier placeholder for that same face is deleted (never the reverse — the existing #110 fog-leak-avoidance ordering); (e) a trap/skill_challenge/puzzle/narrative/treasure room's own persisted state (`ensureTrapState`/`ensureSkillChallenge`/etc.) is attached exactly once per room, same as today.

- [ ] **Step 2: (N/A — no automated test to run first for this task)**

- [ ] **Step 3a: Update this file's own import block**

`dungeon-scene.mjs` currently imports `slotRect, slotRowCol, buildConnectionGeometry, outgoingFaceWall, connectionDirection` from `dungeon-layout.mjs` — all deleted by Tasks 5/6. Replace that import block with:

```js
import {
  ROOM_SIZE_LARGE,
  ROW_STRIDE,
  COLUMN_STRIDE,
  INITIAL_GX,
  roomRect,
  roomEnclosureWalls,
  roomSidesForRect,
  exitFaceForIndex,
  incomingFaceFor,
  parentRoomIdFor,
  OPPOSITE,
  buildEdgeCorridor,
  corridorTileVariant,
} from "./dungeon-layout.mjs";
```

(`ROOMS_PER_ROW`/`CORRIDOR_LEN` drop out of this file's own use — `CORRIDOR_LEN` stays needed only inside `dungeon-layout.mjs` itself, already covered by Tasks 5/6's own imports there.)

- [ ] **Step 3b: Replace `buildRoomAtSlot` with `buildRoomAtGraphNode`**

```js
export async function buildRoomAtGraphNode(
  scene,
  roomId,
  { rank, col, incomingFace = null, childIds = [], isGoal = false, locationTag = null, artVariant = 0, seed = "" },
) {
  const rect = roomRect(seed, roomId, rank, col);

  const outgoingFaces = isGoal ? [] : childIds.map((_, i) => exitFaceForIndex(i));
  const walls = roomEnclosureWalls(seed, roomId, { incomingFace, outgoingFaces }, rect).map(
    (side) =>
      wallDoc(side, {
        flags: {
          [MODULE_ID]: {
            dungeonEnclosureWallForRoom: roomId,
            dungeonEnclosureWallDirection: side.dir,
          },
        },
      }),
  );

  // Supersede the parent's frontier placeholder for THIS incoming edge
  // (looked up now, deleted only after the real geometry below is
  // created — #110's creation-before-deletion ordering, generalized from
  // "the one placeholder for slot - 1" to "the placeholder for this
  // specific incoming edge").
  const placeholderIds = incomingFace
    ? scene.walls
        .filter((w) => w.getFlag(MODULE_ID, "dungeonFrontierWallForEdge")?.endsWith(`->${roomId}`))
        .map((w) => w.id)
    : [];

  // One frontier placeholder per outgoing face — findable/superseded later
  // by whichever child builds next on that face.
  for (let i = 0; i < childIds.length; i += 1) {
    const face = exitFaceForIndex(i);
    const side = roomSidesForRect(rect)[face];
    walls.push(
      wallDoc(side, {
        flags: { [MODULE_ID]: { dungeonFrontierWallForEdge: `${roomId}->${childIds[i]}` } },
      }),
    );
  }

  // This room's OWN enclosure walls, created now — but the frontier
  // placeholder they supersede is NOT deleted here. #110's ordering
  // requires the placeholder to survive until the REAL connecting door
  // exists, and that door is built by the caller (buildPopulateAndUnlockGraphNode,
  // Step 3c below, which has the parent's rect this function doesn't) —
  // deleting the placeholder here, before that door exists, would leave
  // exactly the gap #110 fixed (a face with neither the placeholder nor
  // real geometry). `placeholderIds` is returned for the caller to delete
  // only once ITS OWN connection-wall creation succeeds.
  if (walls.length) await scene.createEmbeddedDocuments("Wall", walls);

  // This room's own floor-art Tile + AmbientLight (ported unchanged from
  // the current buildRoomAtSlot, dungeon-scene.mjs:304-335 — read it
  // directly: `roomArtPath({locationTag, isGoal, artVariant})` for the
  // Tile texture at anchorX/Y:0 sized to `rect`, then `roomLightRadii(rect.gw)`
  // for one centered AmbientLight). Unlike the CORRIDOR tiles (which
  // depend on a parent and so belong in buildPopulateAndUnlockGraphNode
  // below, not here), this room's own art/light never depended on the
  // connecting door in the old code either — port it verbatim; no flag
  // value needs to change here (art/light documents carry no
  // dungeonSlot-style flag today), only the `rect` source.

  return { rect, outgoingFaces, placeholderIds };
}
```

**Design note:** `buildRoomAtGraphNode` creates its own enclosure walls, floor art, and light directly (self-contained, matching the original `buildRoomAtSlot`'s scope for a room's own geometry) — but does NOT delete the parent's frontier placeholder itself, and does NOT yet know about the corridor connection (needs the parent's rect, which this function has no way to know). The corridor CONNECTION to a parent (door/reveal-door/corridor walls+tiles) is `buildPopulateAndUnlockGraphNode`'s own job (Step 3c) — it creates the connection walls in a SECOND `createEmbeddedDocuments` call, and only THEN deletes the `placeholderIds` this function returned, preserving #110's exact creation-before-deletion ordering (placeholder survives from before this room existed at all, through this room's own enclosure build, until the moment real connecting geometry actually replaces it).

- [ ] **Step 3c: Replace `buildPopulateAndUnlockRoom` with `buildPopulateAndUnlockGraphNode`**

This is the function every real caller (Tasks 11/12/13) actually calls — it wraps `buildRoomAtGraphNode`, adds the parent-connection geometry, then populates content and unlocks doors exactly like the original `buildPopulateAndUnlockRoom` did, keyed by `room.id` (string) everywhere the original used `physicalSlot` (integer) as the `dungeonSlot` flag value and the `populateSlot*`/`depthBiasFor` argument — **the flag NAME `dungeonSlot` is unchanged** (avoids touching `dungeon-combat.mjs` or its 4 existing test files, which only ever compare this flag's value for equality, never as a number), only what gets stored in it changes.

```js
export async function buildPopulateAndUnlockGraphNode(
  scene,
  state,
  room,
  { rank, col, incomingFace = null, childIds = [], parentRoomId = null, unlock = true } = {},
) {
  const alreadyBuilt = isSlotBuilt(scene, room.id);
  const rect = roomRect(state.seed, room.id, rank, col);

  if (!alreadyBuilt) {
    // Creates this room's own enclosure walls + floor art + light
    // already (see Step 3b) — does NOT delete the parent's placeholder
    // yet (that's this function's own job, after the connection below).
    const { placeholderIds } = await buildRoomAtGraphNode(
      scene,
      room.id,
      {
        rank, col, incomingFace, childIds,
        isGoal: room.isGoal, locationTag: room.locationTag,
        artVariant: room.artVariant, seed: state.seed,
      },
    );

    const connectionWalls = [];
    const tiles = [];
    if (incomingFace && parentRoomId) {
      const parentPos = state.layoutPositionByRoomId[parentRoomId];
      const parentRect = roomRect(state.seed, parentRoomId, parentPos.rank, parentPos.col);
      // The parent's own exit face toward THIS room is the opposite of
      // this room's incoming face (OPPOSITE is bidirectional/self-inverse
      // — Task 5's own exported constant, dungeon-layout.mjs).
      const exitFaceFromParent = OPPOSITE[incomingFace];
      const { doorWall, revealDoorWall, plainWalls, corridorSegments } =
        buildEdgeCorridor(state.seed, parentRoomId, room.id, parentRect, rect, exitFaceFromParent);
      connectionWalls.push(
        wallDoc(doorWall, { flags: { [MODULE_ID]: { dungeonDoorToRoomId: room.id } }, ds: CONST.WALL_DOOR_STATES.LOCKED, door: CONST.WALL_DOOR_TYPES.DOOR }),
        wallDoc(revealDoorWall, { flags: { [MODULE_ID]: { dungeonRevealDoorForSlot: room.id } }, ds: CONST.WALL_DOOR_STATES.CLOSED, door: CONST.WALL_DOOR_TYPES.DOOR }),
        ...plainWalls.map((w) => wallDoc(w)),
      );
      // Port the corridor floor-tile loop from the CURRENT
      // buildRoomAtSlot (dungeon-scene.mjs:219-266, read it directly —
      // it's the exact tile-placement logic to adapt, including WHY
      // anchorX/Y stays at Foundry's default center for rotated tiles)
      // unchanged in spirit, just run once per corridorSegments entry
      // instead of once for a single corridorRect (a straight edge has
      // 1 segment, an L-shaped edge has 2 — Task 6). For each segment:
      // `vertical = segment.gh >= segment.gw`, `length = vertical ?
      // segment.gh : segment.gw`, then the same
      // `corridorTileVariant(i, length, vertical)` per-tile loop the
      // current code already has, offset by `segment.gx`/`segment.gy`
      // instead of `corridorRect.gx`/`corridorRect.gy`, pushing into
      // this same `tiles` array (push the resulting Tile data objects,
      // not TileDocuments — same shape `buildRoomAtSlot` builds today).
    }

    // #110 ordering: create the new connection geometry (and this room's
    // own tiles) BEFORE deleting the parent's frontier placeholder, so
    // there is never a frame where the shared wall is neither the
    // placeholder nor the real corridor/door.
    if (connectionWalls.length) await scene.createEmbeddedDocuments("Wall", connectionWalls);
    if (tiles.length) await scene.createEmbeddedDocuments("Tile", tiles);
    if (placeholderIds.length) await scene.deleteEmbeddedDocuments("Wall", placeholderIds);
  }

  if (room.kind === "combat") {
    if (!isSlotPopulated(scene, room.id)) {
      await populateSlotEncounter(scene, room.id, {
        rect,
        prefillTraits: state.traits,
        prefillExcludeTraits: state.excludeTraits,
        levelOffsetBias: depthBiasFor({ rank, maxRank: state.maxRank, isGoal: room.isGoal }),
        locationTag: room.locationTag,
        seed: state.seed,
      });
    }
    if (unlock && isSlotPopulated(scene, room.id)) await unlockDoorsFromRoom(scene, room.id, childIds, state.hiddenEdges[room.id] ?? []);
  } else {
    // ... every other room.kind branch (skill_challenge / trap / puzzle /
    // narrative / treasure) is UNCHANGED from the current
    // buildPopulateAndUnlockRoom body (dungeon-scene.mjs:885-991) — copy
    // it verbatim, replacing every `physicalSlot` argument to
    // populateSlotTrap/depthBiasFor with `room.id`/`rank` respectively
    // (see Step 3e), and the final `if (unlock) await
    // unlockDoorToSlot(scene, physicalSlot);` with `if (unlock) await
    // unlockDoorsFromRoom(scene, room.id, childIds, state.hiddenEdges[room.id] ?? []);`.
  }
}
```

- [ ] **Step 3d: Generalize `populateSlotEncounter`/`populateSlotTrap` to accept `rect` directly**

Both currently call the now-deleted `slotRect(seed, slot)` internally. Change their signatures to accept `rect` as a param instead of computing it (drop the internal `slotRect` call in each; every other line is unchanged, just replace `slot` params with `roomId` where they're used purely as the `dungeonSlot`/`trapCustomization.roomId` flag value, not for geometry):

```js
export async function populateSlotEncounter(scene, roomId, { rect, prefillTraits = [], prefillExcludeTraits = [], hidden = true, levelOffsetBias = 0, locationTag = null, seed = "" } = {}) {
  await generateEncounter({
    prefillTraits, prefillExcludeTraits, levelOffsetBias, locationTag,
    skipThemeDialog: true, scene,
    originArea: { x: toPixels(rect.gx), y: toPixels(rect.gy), width: toPixels(rect.gw), height: toPixels(rect.gh) },
    forceHidden: hidden,
    extraFlags: { [MODULE_ID]: { dungeonSlot: roomId } },
  });
}
```

(Same treatment for `populateSlotTrap`: add a `rect` param, drop its internal `slotRect(seed, slot)` call, keep everything else — including its own `roomId` param, which it already threads through unchanged into `trapCustomization`/`ensureTrapState`.)

Rename `startCombatForSlot`/`getCombatForSlot` (`dungeon-combat.mjs`) to `startCombatForRoom`/`getCombatForRoom` for clarity — purely a name change (both are already generic `(scene, value)` pass-throughs to `startCombat`/a flag-equality lookup, never doing arithmetic on the value), 4 call sites total, all inside `dungeon-scene.mjs`/`ui/dungeon-app.mjs` (both already being touched by this plan).

- [ ] **Step 3e: `isSlotBuilt`/`isSlotPopulated`/`unlockDoorToSlot`/`relockDoorToSlot` — flag value type only, names unchanged**

These four functions' bodies don't need to change at all — they already take an opaque `slot` param and compare it via `===` against a flag value. Just confirm every CALLER now passes a `room.id` string where it used to pass an integer `physicalSlot`/`slot` (Step 3c/3d above already do this). Do not rename these four functions or their flags.

- [ ] **Step 3f: Add `unlockDoorsFromRoom` and `resizeSceneForLayout`**

```js
/** Unlocks every one of roomId's outgoing doors whose target is in
 * childIds but not in hiddenChildIds — #93: a graph room can have several
 * exits, all needing unlocking together once its own outcome resolves,
 * unlike the old single unlockDoorToSlot call. Each door was flagged
 * dungeonDoorToRoomId with its own target room id at build time
 * (buildPopulateAndUnlockGraphNode / Step 3c above). */
export async function unlockDoorsFromRoom(scene, roomId, childIds, hiddenChildIds = []) {
  const targets = childIds.filter((id) => !hiddenChildIds.includes(id));
  for (const targetId of targets) {
    const wall = scene.walls.find((w) => w.getFlag(MODULE_ID, "dungeonDoorToRoomId") === targetId);
    if (wall) {
      await wall.update({ ds: CONST.WALL_DOOR_STATES.CLOSED });
      playDoorSound("unlock");
    }
  }
}

/** Resizes the scene ONCE for the whole graph's known extent — #93:
 * replaces the old per-room ensureSceneCovers/requiredDimensions(maxSlot)
 * pair, which depended on the deleted slotRowCol. Under full
 * pregeneration the graph's max rank/col is known before any room
 * builds, so there's no need to incrementally grow the canvas per room
 * anymore; called once by Task 12's startDungeonRun wiring right after
 * layoutPositionByRoomId is computed. */
export async function resizeSceneForLayout(scene, { maxRank, maxCol }) {
  const width = toPixels(INITIAL_GX + (maxCol + 1) * COLUMN_STRIDE + MARGIN_ROOMS);
  const height = toPixels((maxRank + 1) * ROW_STRIDE + MARGIN_ROOMS);
  const nextWidth = Math.max(scene.width ?? 0, width);
  const nextHeight = Math.max(scene.height ?? 0, height);
  if (nextWidth > (scene.width ?? 0) || nextHeight > (scene.height ?? 0)) {
    await scene.update({ width: nextWidth, height: nextHeight });
  }
}
```

Delete `requiredDimensions`/`ensureSceneCovers` entirely (both superseded). `createDungeonScene`'s own initial sizing call (`...requiredDimensions(ROOMS_PER_ROW)`) becomes a fixed conservative default sized for just the entry room, e.g. `...{ width: toPixels(INITIAL_GX + COLUMN_STRIDE + MARGIN_ROOMS), height: toPixels(ROW_STRIDE + MARGIN_ROOMS) }` — `resizeSceneForLayout` corrects it to the real full size moments later in `startDungeonRun`, before any room past the entry builds.

- [ ] **Step 4: Live verification**

Run the checklist written in Step 1 against a real Foundry world (same existing convention noted in `dungeon-scene.mjs`'s other functions) before committing. This task can only be meaningfully live-verified together with Task 12's wiring (nothing calls `buildPopulateAndUnlockGraphNode` until then) — it's fine to write Task 10's code now and defer live verification to Task 12's own Step 4, noting that explicitly in this task's commit message rather than skipping verification silently.

- [ ] **Step 5: Commit**

```bash
git add scripts/dungeon-scene.mjs scripts/dungeon-layout.mjs scripts/dungeon-combat.mjs
git commit -m "feat: build+populate+unlock multi-exit graph rooms with per-edge frontier placeholders"
```

---

## Task 11: Graph-aware door handling and lazy fallback build

**Files:**
- Modify: `scripts/dungeon-scene.mjs`
- Test: manual/live verification (same boundary as Task 10).

**Interfaces:**
- Consumes: `advanceToRoom` (Task 8), `doorToRoomId` lookup (Task 10), `buildPopulateAndUnlockGraphNode` (Task 10), `incomingFaceFor`/`parentRoomIdFor` (Task 5).
- Produces: `handleDungeonDoorOpened(sceneId, wallId)` (existing name, new body) resolving `wallId` → `doorToRoomId[wallId]` → calls `advanceToRoom` with that specific child, instead of the old single `state.rooms[state.currentIndex + 1]` check. Adds the Review Focus lazy-fallback build: if the resolved room's content isn't present yet (eager pregeneration failed for it), build AND populate it on demand before revealing (a walls-only fallback would leave the party in an empty, permanently-locked room — see Task 10's Step 3c split).

- [ ] **Step 1: Write the manual verification checklist**

(a) opening a 2-exit room's first door advances the party into that door's specific child, not the other exit's child; (b) opening the second door afterward (if the player backtracks — same undo-window semantics as today) resolves to the OTHER child correctly; (c) a room whose eager build failed (simulate by not pre-building it) still gets built on first door-open, and the party is not stuck.

- [ ] **Step 2: (N/A — no automated test to run first for this task)**

- [ ] **Step 3: Write the implementation**

```js
export async function handleDungeonDoorOpened(sceneId, wallId) {
  const scene = game.scenes.get(sceneId);
  const wall = scene?.walls.get(wallId);
  const roomId = wall?.getFlag(MODULE_ID, "dungeonDoorToRoomId");
  if (!roomId) return;

  const state = getRunState(sceneId);
  if (!state || !(state.edges[state.currentRoomId] ?? []).includes(roomId)) return;

  // Lazy fallback (#93 error handling): if eager pregeneration somehow
  // failed for this room, build AND populate it now rather than leaving
  // the party stuck in an empty, permanently-locked room — the same
  // idempotent build+populate step the eager pass already used
  // (buildPopulateAndUnlockGraphNode, not the walls-only
  // buildRoomAtGraphNode — see Task 10's Step 3c). `unlock: false`
  // because this room itself has not been resolved yet — its own
  // outgoing doors unlock only when its outcome resolves (Task 13).
  if (!isSlotBuilt(scene, roomId)) {
    const room = state.rooms[roomId];
    const { rank, col } = state.layoutPositionByRoomId[roomId];
    await buildPopulateAndUnlockGraphNode(scene, state, room, {
      rank,
      col,
      incomingFace: incomingFaceFor(state.edges, roomId),
      childIds: state.edges[roomId] ?? [],
      parentRoomId: parentRoomIdFor(state.edges, roomId),
      unlock: false,
    });
  }

  await advanceToRoom({ sceneId, roomId, revealedTokenIds: [] });
}
```

**Note for the implementer:** `wall.getFlag(MODULE_ID, "dungeonDoorToRoomId")` must be set when each door wall is created in Task 10 (add it alongside the existing `dungeonDoorToSlot`-style flag, now storing the target room id directly rather than a slot number — simplest possible `doorToRoomId` lookup, keyed by wall flag rather than a separately-threaded map, avoiding new state). `isSlotBuilt` (unchanged name — Step 3e) already generalizes cleanly: it takes an opaque `slot` param and compares it by `===` against a flag value, so passing a room id string where it used to get an integer works with no body changes.

- [ ] **Step 4: Live verification**

Run the Step 1 checklist against a real Foundry world.

- [ ] **Step 5: Commit**

```bash
git add scripts/dungeon-scene.mjs
git commit -m "feat: resolve door-opens against a room's specific graph child, with lazy fallback"
```

---

## Task 12: Wire full pregeneration into `startDungeonRun`, remove ITEM-11 deferral

**Files:**
- Modify: `scripts/ui/dungeon-app.mjs`
- Test: manual/live verification (this file drives Foundry UI directly).

**Interfaces:**
- Consumes: `buildRoomGraph`, `attachHiddenPaths` (Tasks 2-3), `computeRanks`/`computeColumns` (Task 4), `incomingFaceFor`/`parentRoomIdFor` (Task 5), `roomsToEagerlyBuild`/`commitEagerPhysicalSlots` (Task 7), `buildPopulateAndUnlockGraphNode`/`resizeSceneForLayout`/`unlockDoorsFromRoom` (Task 10).
- Produces: `startDungeonRun` builds the whole graph for every run (drops the `if (state.hostUserId)` gate at dungeon-app.mjs:556) and no longer skips a combat-kind room at generation-order position 1. Persists `state.maxRank` (the graph's deepest rank, from `computeRanks`) alongside `layoutPositionByRoomId` — Task 9's `depthBiasFor` rename and Task 13's `applyRoomEffect` call both read it.

- [ ] **Step 1: Write the manual verification checklist**

(a) a GM-present run now pregenerates every room at scene creation, same as a GM-less run; (b) the "Populate Next Room" button and its `populateNextRoom` handler no longer appear/are removed from the app; (c) a dungeon whose first generated room (after entry) is combat-kind is still fully built and playable immediately, with no manual population step required.

- [ ] **Step 2: (N/A — no automated test for this UI-driving file)**

- [ ] **Step 3: Write the implementation**

In `scripts/ui/dungeon-app.mjs`'s `startDungeonRun` (around line 496-583):

```js
  const { rooms, edges } = getGenerator().buildRoomGraph({
    seed: state.seed,
    roomCount,
    puzzleSetpieceIds,
    trapSetpieceIds,
    narrativeSetpieceIds,
  });
  const { hiddenRooms, hiddenEdges } = getGenerator().attachHiddenPaths({ rooms, edges, seed: state.seed });
  const ranks = computeRanks(edges, 'room-entry');
  const columns = computeColumns(edges, ranks, 'room-entry');
  const layoutPositionByRoomId = Object.fromEntries(
    Object.keys(rooms).map((id) => [id, { rank: ranks[id], col: columns[id] }]),
  );
  const maxRank = Math.max(...Object.values(ranks));
  const maxCol = Math.max(...Object.values(columns));

  state = {
    ...state,
    rooms,
    edges,
    hiddenRooms: [...hiddenRooms],
    hiddenEdges,
    layoutPositionByRoomId,
    maxRank,
    currentRoomId: 'room-entry',
    history: [],
  };

  // #93: the whole graph's extent is known up front under full
  // pregeneration — resize once, before any room is built, instead of
  // the old per-room ensureSceneCovers/requiredDimensions growth.
  await resizeSceneForLayout(scene, { maxRank, maxCol });

  // #93: full pregeneration for every run, GM-present or GM-less alike —
  // no more hostUserId gate, no more ITEM-11 first-combat-room deferral.
  // Only the entry room's own outgoing doors unlock immediately; every
  // other room stays locked until its own outcome resolves (Task 13's
  // unlockDoorsFromRoom call) — so this loop always passes
  // `unlock: false` except for 'room-entry' itself.
  const eagerlyBuilt = roomsToEagerlyBuild(state);
  for (const { room, buildOrder } of eagerlyBuilt) {
    const { rank, col } = layoutPositionByRoomId[room.id];
    await buildPopulateAndUnlockGraphNode(scene, state, room, {
      rank,
      col,
      incomingFace: incomingFaceFor(edges, room.id),
      childIds: edges[room.id] ?? [],
      parentRoomId: parentRoomIdFor(edges, room.id),
      unlock: room.id === 'room-entry',
    });
  }
  await commitEagerPhysicalSlots(scene.id, eagerlyBuilt);
```

Delete `populateNextRoom` (dungeon-app.mjs:733) and its call site/UI button wiring (the `#onPopulateNext` handler and template button referencing it), per the confirmed removal of the ITEM-11 deferral.

**Note for the implementer:** `incomingFaceFor`/`parentRoomIdFor` are Task 5's shared helpers (`dungeon-layout.mjs`) — the same pair Task 11's lazy fallback uses, so both call sites agree on the same parent/face resolution. `roomsToEagerlyBuild` already returns rooms in topological (parents-before-children) order (Task 7), so by the time any room's `buildPopulateAndUnlockGraphNode` call runs, `parentRoomIdFor`'s result for that room already has its own `layoutPositionByRoomId` entry and (if non-entry) has already been built by an earlier loop iteration — required, since the parent's rect is read via `state.layoutPositionByRoomId[parentRoomId]` inside Step 3c.

- [ ] **Step 4: Live verification**

Run the Step 1 checklist against a real Foundry world, both as a GM-present and a GM-less (agent-hosted) run.

- [ ] **Step 5: Commit**

```bash
git add scripts/ui/dungeon-app.mjs
git commit -m "feat: pregenerate the full branching graph for every run, drop ITEM-11 deferral"
```

---

## Task 13: Simplify `resolveCurrentRoom` (drop mutation/resync logic)

**Files:**
- Modify: `scripts/ui/dungeon-app.mjs`, `scripts/dungeon-runner.mjs` (delete dead `roomsNeedingResync`)
- Test: `tests/dungeon-runner.test.mjs` (delete `roomsNeedingResync`'s own describe block); the rest is manual/live verification (this file drives Foundry UI directly, same existing boundary as the rest of `resolveCurrentRoom`).

**Interfaces:**
- Consumes: `markRoomOutcome` → `{state, effectKey}` (Task 9, already drops mutation logic internally), `unlockDoorsFromRoom` (Task 10), `depthBiasFor`/`lootGpForTreasureRoom`/`treasureRoomItemTableName` rank/maxRank rename (Task 9's Step 3a), `state.maxRank` (Task 12).
- Produces: `resolveCurrentRoom` (existing name) no longer branches on `mutation && state.hostUserId`, calls no resync/reconciliation step, and builds nothing — it only unlocks the just-resolved room's own outgoing doors via `unlockDoorsFromRoom` (dead code per #62's now-superseded reconciliation mechanism, superseded again by full pregeneration). `roomsNeedingResync` (`dungeon-runner.mjs`) is deleted outright — nothing calls it once this task lands.

- [ ] **Step 1: Write the manual verification checklist**

(a) resolving a room whose outcome is `reduced_travel_time`/`extra_travel_time` no longer triggers any teardown/rebuild of already-built rooms — the party simply sees a newly unlocked door where the hidden path was revealed; (b) resolving every other outcome kind behaves exactly as before (unaffected by this change); (c) a trap room's XP grant on success still fires (uses the resolved room's own `dungeonSlot`-flagged trap token, now keyed by room id rather than integer slot); (d) a treasure room's coin/item grant still scales with depth — a treasure room near the entry grants noticeably less than one near the goal, confirming the `depthBiasFor` rank/maxRank rename (Task 9 Step 3a) reached this call site correctly; (e) resolving the goal room does not attempt to unlock any doors (it has none) and still sweeps the completed scene.

- [ ] **Step 2: (N/A — manual verification file, `roomsNeedingResync`'s test deletion has no new assertions to fail first)**

- [ ] **Step 3: Write the implementation**

Replace `resolveCurrentRoom` (`scripts/ui/dungeon-app.mjs:134-348`) in full:

```js
export async function resolveCurrentRoom(succeeded, { scene } = {}) {
  if (!scene) return;
  const setpieces = await loadDungeonSetpieces();
  // Captured before markRoomOutcome runs — both the XP grant below and
  // applyRoomEffect's treasure-gp calc need the room that was just
  // resolved, keyed by id now that state.rooms is a dict (#93).
  const preState = getRunState(scene.id);
  const currentRoom = preState?.rooms[preState.currentRoomId];
  // #93: the dungeonSlot flag's NAME is unchanged (dungeon-combat.mjs and
  // its tests only ever compare it for equality — see Task 10's design
  // note); its VALUE is now the room's own string id instead of an
  // integer physical slot.
  if (succeeded && currentRoom?.kind === "trap") {
    const trapToken = scene.tokens.find(
      (t) =>
        t.getFlag(MODULE_ID, "trapHazard") &&
        t.getFlag(MODULE_ID, "dungeonSlot") === currentRoom.id,
    );
    const trapLevel = trapToken?.actor?.system?.details?.level?.value;
    const levelOffset =
      trapLevel != null ? trapLevel - (await makeFoundryApi().partyLevel()) : 0;
    await makeFoundryApi().grantPartyXp(xpFor(levelOffset));
  }
  const { state, effectKey } = await markRoomOutcome(
    { sceneId: scene.id, succeeded },
    {
      puzzleSetpieceIds: setpieces
        .filter((s) => s.kind === "puzzle")
        .map((s) => s.id),
      trapSetpieceIds: setpieces
        .filter((s) => s.kind === "trap")
        .map((s) => s.id),
      narrativeSetpieceIds: setpieces
        .filter((s) => s.kind === "narrative")
        .map((s) => s.id),
      treasureSetpieceIds: setpieces
        .filter((s) => s.kind === "treasure")
        .map((s) => s.id),
    },
  );
  if (currentRoom && effectKey) {
    await applyRoomEffect(effectKey, {
      seed: preState.seed,
      roomId: currentRoom.id,
      rank: preState.layoutPositionByRoomId[currentRoom.id].rank,
      maxRank: preState.maxRank,
      isGoal: currentRoom.isGoal,
    });
  }
  // #93: full pregeneration means every room the party can reach is
  // already built (Task 12's eager-build loop) and any hidden path this
  // outcome revealed was already merged into `state.edges` inside
  // markRoomOutcome (Task 9's revealTravelTimeEffect) — resolving a room
  // never builds, rebuilds, or reconciles physical slots. All that's
  // left is unlocking the resolved room's own outgoing doors so the
  // party can walk through them; the goal room has none.
  if (currentRoom && !currentRoom.isGoal) {
    await unlockDoorsFromRoom(
      scene,
      currentRoom.id,
      state.edges[currentRoom.id] ?? [],
      state.hiddenEdges[currentRoom.id] ?? [],
    );
  }
  if (state?.completed) await sweepCompletedDungeonScene(scene);
}
```

Update `applyRoomEffect`'s own destructure (`dungeon-app.mjs:412-414`) from `{ seed, roomId, physicalSlot, roomCount, isGoal }` to `{ seed, roomId, rank, maxRank, isGoal }`, and its `treasure` case's call into `grantTreasureReward` (`dungeon-app.mjs:421-431`) from `{ physicalSlot, roomCount }` to `{ rank, maxRank }`. Update `grantTreasureReward`'s own destructure (`dungeon-app.mjs:370-372`) the same way, and its two calls into `lootGpForTreasureRoom`/`treasureRoomItemTableName` (`dungeon-app.mjs:374-379`, `392-398`) to pass `{ rank, maxRank, ... }` instead of `{ physicalSlot, roomCount, ... }` — both functions' own signatures already take `rank`/`maxRank` as of Task 9's Step 3a, so this is purely threading the renamed fields through, not a new rename.

Delete `roomsNeedingResync` entirely from `scripts/dungeon-runner.mjs` (its export, `dungeon-runner.mjs:390` onward through the end of its function body) and remove it from the `roomsNeedingResync` import in `scripts/ui/dungeon-app.mjs:13` (the whole import line, since nothing else in that block depended on it — verify no other name shares the line before deleting the line itself rather than just the one specifier). Delete its `describe("roomsNeedingResync", ...)` block from `tests/dungeon-runner.test.mjs:2095-2166` and remove `roomsNeedingResync` from that file's own import list (`tests/dungeon-runner.test.mjs:10`).

**Note for the implementer:** `openGoalRoomExit`, `clearSlotEncounter`, `clearSlotTrap`, `clearPuzzleState`, `clearSkillChallengeState`, `clearNarrativeState`, `clearTrapState`, `clearTreasureState`, and `commitEagerPhysicalSlots` were only ever called from the deleted mutation-resync block within this function — leave their own definitions/exports alone (they're still used elsewhere, e.g. `commitEagerPhysicalSlots` by Task 12's eager-build loop), just confirm `resolveCurrentRoom` itself no longer references any of them. If any import in this file becomes unused after this deletion, remove that import too.

- [ ] **Step 4: Run tests, then live verification**

Run: `npx vitest run tests/dungeon-runner.test.mjs`
Expected: PASS (with `roomsNeedingResync`'s own describe block gone, not skipped)

Then run the Step 1 checklist against a real Foundry world.

- [ ] **Step 5: Commit**

```bash
git add scripts/ui/dungeon-app.mjs scripts/dungeon-runner.mjs tests/dungeon-runner.test.mjs
git commit -m "refactor: simplify resolveCurrentRoom to unlock-only under full pregeneration, delete dead roomsNeedingResync"
```

---

## Task 14: Delete the Accept/Reroll approval dialog

**Files:**
- Modify: `scripts/encounter-generator.mjs`
- Test: `tests/encounter-generator.test.mjs` (adjust existing tests referencing `skipPreview`/Accept/Reroll)

**Interfaces:**
- Consumes: nothing new.
- Produces: `generateEncounter` (existing name) always proceeds straight through, no `showEncounterPreview` call, no `skipPreview` branch.

- [ ] **Step 1: Write the failing test**

```js
import { generateEncounter } from '../scripts/encounter-generator.mjs';

describe('generateEncounter (no approval gate)', () => {
  it('never prompts for Accept/Reroll, even for a GM-present run', async () => {
    let dialogShown = false;
    // Arrange a run object with hostUserId: null (GM-present) using this
    // file's existing test fixtures/mocks; stub/spy on whatever global
    // dialog API showEncounterPreview used (e.g. `Dialog`/`foundry.applications`)
    // and assert it's never invoked.
    const result = await generateEncounter({ /* existing fixture args, hostUserId: null */ });
    expect(dialogShown).toBe(false);
    expect(result).toBeDefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/encounter-generator.test.mjs -t "no approval gate"`
Expected: FAIL if a stubbed dialog spy is still invoked by the current `skipPreview = Boolean(run?.hostUserId)` branch for a `hostUserId: null` fixture.

- [ ] **Step 3: Write minimal implementation**

In `scripts/encounter-generator.mjs`: delete `showEncounterPreview` entirely (its Accept/Reroll button wiring, dialog construction) and the `skipPreview`/`const action = skipPreview ? "accept" : await showEncounterPreview(roster)` line inside `generateEncounter` — replace with the roster simply being accepted unconditionally:

```js
  // #93: the Accept/Reroll approval gate is removed outright — every run
  // pregenerates in bulk, and a synchronous per-room human approval can't
  // work against that. The roster generated above is always accepted.
```

(i.e., delete the `action`/preview branching and whatever downstream code keyed off `action === 'accept'` vs `'reroll'`, keeping only the accept path's existing logic.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/encounter-generator.test.mjs`
Expected: PASS. Delete/update any other existing test in this file that exercised Reroll behavior or asserted `skipPreview`'s conditional — those code paths no longer exist.

- [ ] **Step 5: Commit**

```bash
git add scripts/encounter-generator.mjs tests/encounter-generator.test.mjs
git commit -m "feat: remove Accept/Reroll approval gate entirely (#93)"
```

---

## Task 15: Final whole-branch review pass

**Files:** none (verification-only task)

**Interfaces:** none — this task re-reads every file touched by Tasks 1-14 as a whole, the same "final review" step #62's own plan used to catch the two false-premise gaps its per-task reviews missed individually.

- [ ] **Step 1: Run the full test suite**

Run: `npx vitest run`
Expected: all tests pass, no regressions in files this plan didn't intend to touch.

- [ ] **Step 2: Re-read every changed file's diff against the spec's Architecture section**

Specifically check, per the spec's own emphasis (informed by #62's history of exactly this kind of gap): does any code path still assume a room has at most one outgoing edge? Does any code path still assume `state.rooms` is an array or `state.currentIndex` is a valid concept anywhere outside this plan's already-updated call sites (grep for `currentIndex`, `\.rooms\[`, `physicalSlot` outside `buildOrder`-renamed contexts)? Does the goal-room single-entrance guarantee actually hold when combined with hidden-path reveals (a revealed shortcut/detour could theoretically route an extra edge toward the goal if `attachHiddenPaths`/`revealTravelTimeEffect` were ever misapplied to the goal's parent — confirm Task 3/9's exclusions hold)?

- [ ] **Step 3: Live-verify the full flow end to end**

Start a GM-present run and a GM-less (agent-hosted) run against a real Foundry world; walk a branching path in each, including at least one 2-exit and one merge room, and trigger at least one `reduced_travel_time`/`extra_travel_time` outcome to confirm the hidden-path reveal works live, not just in unit tests.

- [ ] **Step 4: Fix anything found, one commit per fix**

Follow this repo's existing convention (see #62's PR history) of a focused commit per finding rather than one giant fixup.

- [ ] **Step 5: Open the PR**

```bash
git push -u origin <branch-name>
gh pr create --title "Branching dungeon topology, full pregeneration, remove GM approval (#93)" --body "..."
```

Bump `module.json`'s version per this repo's CLAUDE.md (minor bump — this is an architecture-level change, not a routine fix), then follow the repo's automerge convention.
