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
- Produces: `attachHiddenPaths({ rooms, edges, seed })` → `{ rooms, edges, hiddenRooms: Set<string>, hiddenEdges: {[fromId]: string[]}, layoutEdges: {[roomId]: string[]}, hiddenIncomingByRoomId: {[targetId]: string[]} }`. `hiddenRooms` marks detour room ids (already present in `rooms`, just flagged); `hiddenEdges` lists shortcut/detour edges not present in the normal `edges` map (so normal traversal never sees them until revealed). `layoutEdges` is `edges` with each detour room appended as an extra child of its attaching room (NOT shortcuts, which target an already-positioned room) — Task 4/7/12 walk this instead of `edges` so detour rooms get a real rank/col and get eagerly built. `hiddenIncomingByRoomId` is the reverse of `hiddenEdges` (`targetId -> [fromId, ...]`) — Task 10/12 use it to reserve a second incoming face on a shortcut's target room.

**Face-budget constraint (the actual bug #156 is about):** a room has exactly 4 compass faces; one is reserved for its own real incoming edge, leaving at most 3 for outgoing (`exitFaceForIndex` only ever returns `south|east|west`). `EXIT_COUNT_WEIGHTS` already allows up to 3 real exits, which can fill all 3 — so a room can only take a hidden edge if it has a spare outgoing face (`edges[roomId].length <= 2`), and a shortcut's *target* room needs a spare face too, for the extra incoming door (`edges[targetId].length <= 2`). Previously `attachHiddenPaths` had no awareness of this ceiling at all and could (a) silently overflow a room's face budget by rolling a hidden path on every one of its real edges independently, and (b) attach a shortcut into a room with no free face to receive it. The fix below decides **once per candidate room** (not once per edge) and filters on spare capacity before attaching anything.

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
    // #93 pre-flight fix (found during Task 3's redo): attachHiddenPaths
    // mutates `rooms`/`edges` in place (splicing in detour rooms) — a
    // single buildRoomGraph() call shallow-spread into two
    // attachHiddenPaths() calls would hand the SECOND call an
    // already-mutated graph from the first, making them incomparable.
    // Build a fresh graph per call instead.
    const a = attachHiddenPaths({ ...buildRoomGraph({ seed: 'beta', roomCount: 10 }), seed: 'beta' });
    const b = attachHiddenPaths({ ...buildRoomGraph({ seed: 'beta', roomCount: 10 }), seed: 'beta' });
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

  it('never attaches more than one hidden edge to the same room, and never to a room with 3 real exits', () => {
    const graph = buildRoomGraph({ seed: 'delta', roomCount: 30 });
    const { edges, hiddenEdges } = attachHiddenPaths({ ...graph, seed: 'delta' });
    for (const [fromId, hidden] of Object.entries(hiddenEdges)) {
      expect(hidden.length).toBe(1);
      expect(edges[fromId].length).toBeLessThanOrEqual(2);
    }
  });

  it('never attaches a shortcut into a room with no spare incoming face', () => {
    const graph = buildRoomGraph({ seed: 'epsilon', roomCount: 30 });
    const { edges, hiddenEdges, hiddenRooms } = attachHiddenPaths({ ...graph, seed: 'epsilon' });
    for (const targets of Object.values(hiddenEdges)) {
      for (const targetId of targets) {
        if (hiddenRooms.has(targetId)) continue; // detour room, not a shortcut target
        expect(edges[targetId].length).toBeLessThanOrEqual(2);
      }
    }
  });

  it('layoutEdges includes every detour room as an extra child of its attaching room, and excludes shortcut targets', () => {
    const graph = buildRoomGraph({ seed: 'zeta', roomCount: 30 });
    const { edges, hiddenEdges, hiddenRooms, layoutEdges } = attachHiddenPaths({ ...graph, seed: 'zeta' });
    for (const [fromId, targets] of Object.entries(hiddenEdges)) {
      for (const targetId of targets) {
        if (hiddenRooms.has(targetId)) {
          expect(layoutEdges[fromId]).toEqual([...edges[fromId], targetId]);
        } else {
          expect(layoutEdges[fromId]).toEqual(edges[fromId]);
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
 * non-goal rooms (#93 — replaces runtime insert_after/remove_next
 * splicing; #156 — fixes the face-budget overflow and layout/build
 * unreachability the original version of this function had). A shortcut
 * edge skips the immediate next room on a branch; a detour room is spliced
 * hidden between two already-adjacent rooms. At most ONE hidden extra per
 * room, decided once per candidate room (not once per edge), and only
 * when the room (and, for a shortcut, its target) has a spare outgoing
 * face left after its real exits (`exitFaceForIndex` only has 3 slots:
 * south/east/west).
 *
 * What's actually hidden is the INCOMING connection, in `hiddenEdges`, not
 * a detour room's own outgoing edge: `edges[detour.id] = [toId]` (and
 * `layoutEdges[detour.id]`) is a real entry in the live map — a detour
 * room needs SOME recorded path onward, live, or it's a guaranteed dead
 * end the moment it's revealed (caught by pre-flight review; do not
 * remove that line believing it belongs in `hiddenEdges` instead — an
 * earlier implementer made exactly this mistake). Normal traversal still
 * never reaches `detour.id` regardless, since nothing in the live `edges`
 * graph points INTO it until an outcome reveal adds that incoming edge —
 * see dungeon-runner.mjs's revealTravelTimeEffect.
 */
export function attachHiddenPaths({ rooms, edges, seed }) {
  const hiddenRooms = new Set();
  const hiddenEdges = {};
  const hiddenIncomingByRoomId = {};
  const layoutEdges = Object.fromEntries(
    Object.entries(edges).map(([id, children]) => [id, [...children]]),
  );
  let detourSalt = 0;

  for (const [fromId, children] of Object.entries(edges)) {
    const fromRoom = rooms[fromId];
    if (!fromRoom || fromRoom.isGoal || fromId === 'room-entry') continue;
    if (children.length === 0 || children.length > 2) continue; // no spare face

    const r = splitmix32(seedFromString(`${seed}-hidden-${fromId}`))();
    if (r >= HIDDEN_PATH_CHANCE) continue;

    // Anchor on the room's first real child — deterministic, and this
    // function only needs *a* nearby room to build a shortcut/detour off
    // of, not a specific one.
    const toId = children[0];
    const toRoom = rooms[toId];
    if (!toRoom || toRoom.isGoal) continue;

    const wantsDetour = splitmix32(seedFromString(`${seed}-hidden-kind-${fromId}`))() < 0.5;
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
      layoutEdges[detour.id] = [toId];
      hiddenRooms.add(detour.id);
      hiddenEdges[fromId] = [detour.id];
      layoutEdges[fromId] = [...children, detour.id];
    } else {
      // A shortcut needs a room beyond `toId` to skip TO — only attach one
      // when `toId` itself has an onward edge to skip past, that target
      // isn't the goal (pre-flight fix: a shortcut's target is ONE HOP
      // PAST `toId` — `edges[toId][0]` — so `toRoom.isGoal` above does NOT
      // already cover this; a room adjacent to goal could otherwise
      // shortcut straight onto it), and the target has a spare incoming
      // face left (own real exit count <= 2, since it already uses one
      // face for its real incoming edge and needs one more for this
      // shortcut's second incoming door).
      const skipTarget = edges[toId]?.[0];
      const skipTargetRoom = skipTarget ? rooms[skipTarget] : null;
      if (!skipTarget || !skipTargetRoom || skipTargetRoom.isGoal) continue;
      if ((edges[skipTarget]?.length ?? 0) > 2) continue;
      hiddenEdges[fromId] = [skipTarget];
      (hiddenIncomingByRoomId[skipTarget] ??= []).push(fromId);
      // Shortcuts don't add a new node, so layoutEdges is untouched here —
      // the target's rank/col already comes from its real parent.
    }
  }

  return { rooms, edges, hiddenRooms, hiddenEdges, layoutEdges, hiddenIncomingByRoomId };
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

**#93 pre-flight fix — face allocation redesigned (incoming and outgoing now use structurally disjoint faces).** The original design computed a room's incoming face as `OPPOSITE[exitFaceForIndex(parentIndex)]` — north, west, or east depending on which numbered child this room is of its parent — while a room's own outgoing faces independently use `south`/`east`/`west` (`exitFaceForIndex` applied to ITS OWN children). These two computations are unrelated, so a room that's the 2nd or 3rd child of a branching parent (routine — roughly half of rooms have 2+ exits per `EXIT_COUNT_WEIGHTS`) gets `west` or `east` as its own incoming face, and if that same room also rolls its own 2-3 exits, one of them can land on that identical direction — two unrelated door systems (the parent's incoming connection, this room's own outgoing connection to a child) would build wall geometry on the same physical wall segment. Separately, a **merge room** (multiple tips forced together by Task 2's forced-merge algorithm — routine throughout the graph, not just the final goal; Task 4's own review sweep found ~1.45 merge rooms per generated graph) has more than one real parent in `edges`, but the original design only ever resolved ONE of them (`incomingFaceFor` returning the first match) — every OTHER real parent's branch would dead-end at a permanently sealed wall, since nothing ever built its side of the connection. Both problems share one root cause (the face-allocation model doesn't reserve incoming capacity correctly) and one fix: **incoming ALWAYS uses the room's north face, subdivided into one door slot per real incoming connection** (1 for a normal room, N for a merge room, or a normal room's real parent plus one more for a shortcut's hidden extra incoming — #156). Outgoing is unchanged (south/east/west, up to 3 real + 1 hidden, `exitFaceForIndex`). North is never used for outgoing, so incoming and outgoing can never collide, for any room, regardless of branching factor or parent-child index — structurally guaranteed, not merely by convention.

**Interfaces:**
- Consumes: `roomSizeAt(seed, roomId)` (existing, works unchanged with a string id in place of an integer slot), `computeRanks`/`computeColumns` (Task 4).
- Produces: `ROW_STRIDE`, `COLUMN_STRIDE` constants; `roomRect(seed, roomId, rank, col)` → `{gx, gy, gw, gh}`; `exitFaceForIndex(index)` → `'south' | 'east' | 'west'`; `OPPOSITE` (exported face-inversion map, still used by Task 6's corridor routing); `parentRoomIdsFor(layoutEdges, roomId)` → `string[]` (every real parent, in deterministic `Object.entries` order — empty for the entry room, length 1 for a normal room, length 2+ for a merge room; `layoutEdges` not bare `edges` so a detour room's one real parent link, which only exists as a `layoutEdges` entry, resolves too — #156); `incomingConnectionsFor(layoutEdges, roomId, hiddenIncomingByRoomId)` → `{sourceId, hidden}[]` (every incoming connection a room needs a door for, in slot order: real parents first via `parentRoomIdsFor`, then a shortcut's hidden extra incoming source if any); `northDoorSlots(rect, count)` → `{x1, y1, x2, y2}[]` (divides a room's north wall into `count` equal, contiguous, left-to-right door slots — one per entry `incomingConnectionsFor` returns); `roomEnclosureWalls(seed, roomId, { incomingCount, outgoingFaces }, rect)` (replaces the old `{hasOutgoing}` boolean signature AND the old singular `{incomingFace}` shape — **breaking change**, callers updated in Task 10; `incomingCount` is `incomingConnectionsFor(...).length`, 0 for the entry room).

- [ ] **Step 1: Write the failing tests**

```js
import { roomRect, exitFaceForIndex, roomEnclosureWalls, ROW_STRIDE, COLUMN_STRIDE, parentRoomIdsFor, incomingConnectionsFor, northDoorSlots } from '../scripts/dungeon-layout.mjs';

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

  it('excludes north (incoming) and every outgoing face', () => {
    const walls = roomEnclosureWalls('alpha', 'x', { incomingCount: 1, outgoingFaces: ['south', 'east'] }, rect);
    const dirs = walls.map((w) => w.dir);
    expect(dirs).not.toContain('north');
    expect(dirs).not.toContain('south');
    expect(dirs).not.toContain('east');
    expect(dirs).toContain('west');
  });

  it('the entry room (incomingCount 0) walls every side except its outgoing faces', () => {
    const walls = roomEnclosureWalls('alpha', 'room-entry', { incomingCount: 0, outgoingFaces: ['south'] }, rect);
    expect(walls.map((w) => w.dir)).toEqual(expect.arrayContaining(['north', 'east', 'west']));
  });

  it('a merge room with several real incoming connections still only excludes north ONCE (one shared face, subdivided into door slots later — not one excluded face per incoming connection, which would run out of faces past 3)', () => {
    const walls = roomEnclosureWalls('alpha', 'm', { incomingCount: 3, outgoingFaces: ['south'] }, rect);
    const dirs = walls.map((w) => w.dir);
    expect(dirs).not.toContain('north');
    expect(dirs).toContain('east');
    expect(dirs).toContain('west');
  });
});

describe('parentRoomIdsFor', () => {
  it('returns every real parent for a merge room, in deterministic order', () => {
    const layoutEdges = { 'room-entry': ['a', 'b'], a: ['m'], b: ['m'], m: [] };
    expect(parentRoomIdsFor(layoutEdges, 'm')).toEqual(['a', 'b']);
  });

  it('returns a single-element array for a normal (non-merge) room', () => {
    const layoutEdges = { 'room-entry': ['a'], a: [] };
    expect(parentRoomIdsFor(layoutEdges, 'a')).toEqual(['room-entry']);
  });

  it('returns an empty array for the entry room', () => {
    expect(parentRoomIdsFor({ 'room-entry': [] }, 'room-entry')).toEqual([]);
  });

  it('resolves a detour room\'s one real parent via layoutEdges (#156 — a plain edges lookup would find none)', () => {
    const layoutEdges = { 'room-entry': ['a'], a: ['b', 'room-detour-0'], b: [], 'room-detour-0': ['b'] };
    expect(parentRoomIdsFor(layoutEdges, 'room-detour-0')).toEqual(['a']);
  });
});

describe('incomingConnectionsFor', () => {
  it('lists real parents first (in parentRoomIdsFor order), then any hidden incoming source', () => {
    const layoutEdges = { 'room-entry': ['a', 'b'], a: ['m'], b: ['m'], m: [] };
    const hiddenIncomingByRoomId = { m: ['x'] };
    expect(incomingConnectionsFor(layoutEdges, 'm', hiddenIncomingByRoomId)).toEqual([
      { sourceId: 'a', hidden: false },
      { sourceId: 'b', hidden: false },
      { sourceId: 'x', hidden: true },
    ]);
  });

  it('a room with no hidden incoming just returns its real parent(s)', () => {
    const layoutEdges = { 'room-entry': ['a'], a: [] };
    expect(incomingConnectionsFor(layoutEdges, 'a')).toEqual([{ sourceId: 'room-entry', hidden: false }]);
  });
});

describe('northDoorSlots', () => {
  it('divides the north edge into count equal, contiguous, left-to-right slots', () => {
    const rect = { gx: 0, gy: 0, gw: 4, gh: 4 };
    const slots = northDoorSlots(rect, 2);
    expect(slots).toEqual([
      { x1: 0, y1: 0, x2: 2, y2: 0 },
      { x1: 2, y1: 0, x2: 4, y2: 0 },
    ]);
  });

  it('a single slot spans the whole north edge', () => {
    const rect = { gx: 0, gy: 0, gw: 4, gh: 4 };
    expect(northDoorSlots(rect, 1)).toEqual([{ x1: 0, y1: 0, x2: 4, y2: 0 }]);
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

// Still used by Task 6's corridor routing to determine a straight
// segment's opposite endpoint direction — unrelated to which face a
// room's OWN incoming/outgoing connections land on (see below, #93
// pre-flight fix: incoming and outgoing are now always on structurally
// disjoint faces, north vs. south/east/west, never computed via OPPOSITE
// of each other for a room's own enclosure).
export const OPPOSITE = { north: 'south', south: 'north', east: 'west', west: 'east' };

/**
 * Every real parent of `roomId` in `layoutEdges`, in deterministic
 * `Object.entries` order. Empty for the entry room. Usually length 1; a
 * merge room (multiple tips forced together by Task 2's forced-merge
 * algorithm — routine throughout the graph, not just the final goal) can
 * be longer. `layoutEdges` (not bare `edges`) so a detour room's one real
 * parent link — which only exists as a `layoutEdges` entry (#156) —
 * resolves too; `layoutEdges` equals `edges` for every non-detour room,
 * so every call site is safe to pass either.
 */
export function parentRoomIdsFor(layoutEdges, roomId) {
  if (roomId === 'room-entry') return [];
  const parents = [];
  for (const [parentId, children] of Object.entries(layoutEdges)) {
    if (children.includes(roomId)) parents.push(parentId);
  }
  return parents;
}

/**
 * Every incoming connection `roomId` needs its own door for, in slot
 * order — real parents first (`parentRoomIdsFor`, deterministic), then a
 * shortcut's hidden extra incoming source if any (`hiddenIncomingByRoomId`,
 * Task 3 — set only for a shortcut's target room; a detour room's one
 * incoming is already counted via its real `layoutEdges` parent link
 * above, never both). #93 pre-flight fix: this is the whole redesign in
 * one function — every entry this returns gets its own door slot on the
 * room's NORTH face (northDoorSlots, below), never a separate compass
 * direction. That's what actually guarantees a merge room gets a door
 * for EVERY real parent (previously only one was ever built, silently
 * dead-ending every other branch) and that incoming can never collide
 * with a room's own outgoing faces (south/east/west, always disjoint
 * from north).
 */
export function incomingConnectionsFor(layoutEdges, roomId, hiddenIncomingByRoomId = {}) {
  const real = parentRoomIdsFor(layoutEdges, roomId).map((sourceId) => ({ sourceId, hidden: false }));
  const hidden = (hiddenIncomingByRoomId[roomId] ?? []).map((sourceId) => ({ sourceId, hidden: true }));
  return [...real, ...hidden];
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
 * Divides a room's north wall into `count` equal, contiguous, left-to-
 * right door slots. Used for EVERY incoming connection — whether 1 for a
 * normal room, N for a merge room, or a normal room's real parent plus a
 * shortcut's extra hidden one (see `incomingConnectionsFor`, whose Nth
 * entry corresponds to this function's Nth slot).
 */
export function northDoorSlots(rect, count) {
  const { gx, gy, gw } = rect;
  const step = gw / count;
  return Array.from({ length: count }, (_, i) => ({
    x1: gx + i * step, y1: gy, x2: gx + (i + 1) * step, y2: gy,
  }));
}

/**
 * A room's own enclosing walls (#93 generalization). South/east/west stay
 * full-face, excluded per `outgoingFaces` (unchanged from before). North
 * is either a single solid wall (`incomingCount === 0`, the entry room)
 * or entirely excluded (`incomingCount > 0`) — its individual door slots
 * are built separately by the caller via `northDoorSlots`, one per real
 * connection-building step (needs the connecting room's rect, which this
 * function doesn't have), not here. `rect` is the room's own already-
 * computed `roomRect(...)` result — required, since rank/col (and so the
 * rect) aren't derivable from `roomId` alone the way the old slot-indexed
 * version could derive `slotRect` internally.
 */
export function roomEnclosureWalls(seed, roomId, { incomingCount = 0, outgoingFaces = [] }, rect) {
  const sides = roomSidesFor(rect);
  const walls = [];
  for (const face of ['south', 'east', 'west']) {
    if (!outgoingFaces.includes(face)) walls.push({ dir: face, ...sides[face] });
  }
  if (incomingCount === 0) walls.push({ dir: 'north', ...sides.north });
  return walls;
}
```

**Note for the implementer:** callers (Task 10) must pass the room's already-computed `roomRect(...)` result as the 4th argument — this is a breaking signature change from the old `roomEnclosureWalls(seed, slot, {hasOutgoing})`, so every existing call site is updated in this task, not left dual-supporting both shapes. `roomSidesFor` is exported as `roomSidesForRect` (Task 10's own note) for callers that need a specific face's coordinates directly, not just the enclosure-wall list.

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

**#93 pre-flight fix — routes to a specific door slot, not always the room's dead-center.** Task 5's redesign means a target room's incoming connection always lands on its north face, but potentially at ONE OF SEVERAL slots (`northDoorSlots`) when the room has more than one real parent (a merge room) or a hidden extra (a shortcut target). The original signature assumed a single, centered incoming point per room — generalized below to target a specific `toSlot`.

**Interfaces:**
- Consumes: `roomRect`, `northDoorSlots` (Task 5), existing `doorOffsetAt`, `corridorTileVariant` (unchanged in spirit, `doorOffsetAt`'s `slot` param renamed conceptually to a `(seed, roomId, face, role, roomSize)` key so two different exit faces on the same room never collide on the same offset).
- Produces: `buildEdgeCorridor(seed, fromRoomId, toRoomId, fromRect, toRect, exitFace, toSlot)` → `{ doorWall, revealDoorWall, plainWalls, corridorSegments }`. `toSlot` is the specific `{x1, y1, x2, y2}` entry from `northDoorSlots(toRect, incomingConnectionsFor(...).length)` this connection should land on (index-matched to `incomingConnectionsFor`'s own ordering — Task 10 threads this through). `corridorSegments` is an array of 1+ `{gx, gy, gw, gh}` rects (1 when `fromRect` and `toSlot` share a column, 2 — an L-shape — otherwise), replacing the old single `corridorRect`.

- [ ] **Step 1: Write the failing tests**

```js
import { roomRect, northDoorSlots, buildEdgeCorridor } from '../scripts/dungeon-layout.mjs';

describe('buildEdgeCorridor', () => {
  it('same-column rooms (straight south connection) produce one corridor segment', () => {
    const from = roomRect('alpha', 'a', 0, 0);
    const to = roomRect('alpha', 'b', 1, 0);
    const toSlot = northDoorSlots(to, 1)[0];
    const { corridorSegments } = buildEdgeCorridor('alpha', 'a', 'b', from, to, 'south', toSlot);
    expect(corridorSegments).toHaveLength(1);
  });

  it('different-column rooms produce an L-shaped (2-segment) corridor', () => {
    const from = roomRect('alpha', 'a', 0, 0);
    const to = roomRect('alpha', 'b', 1, 2);
    const toSlot = northDoorSlots(to, 1)[0];
    const { corridorSegments } = buildEdgeCorridor('alpha', 'a', 'b', from, to, 'south', toSlot);
    expect(corridorSegments).toHaveLength(2);
  });

  it('always returns a door wall and a reveal door wall', () => {
    const from = roomRect('alpha', 'a', 0, 0);
    const to = roomRect('alpha', 'b', 1, 1);
    const toSlot = northDoorSlots(to, 1)[0];
    const { doorWall, revealDoorWall } = buildEdgeCorridor('alpha', 'a', 'b', from, to, 'south', toSlot);
    expect(doorWall).toBeDefined();
    expect(revealDoorWall).toBeDefined();
  });

  it('two exits from the same room on different faces never share a door offset key', () => {
    const from = roomRect('alpha', 'a', 0, 0);
    const toSouth = roomRect('alpha', 'b', 1, 0);
    const toEast = roomRect('alpha', 'c', 0, 1);
    const south = buildEdgeCorridor('alpha', 'a', 'b', from, toSouth, 'south', northDoorSlots(toSouth, 1)[0]);
    const east = buildEdgeCorridor('alpha', 'a', 'c', from, toEast, 'east', northDoorSlots(toEast, 1)[0]);
    expect(south.doorWall).not.toEqual(east.doorWall);
  });

  it('#93 pre-flight fix regression — two different incoming connections to the same merge room land on distinct, non-overlapping door slots', () => {
    const parentA = roomRect('alpha', 'a', 0, 0);
    const parentB = roomRect('alpha', 'b', 0, 1);
    const merge = roomRect('alpha', 'm', 1, 0);
    const slots = northDoorSlots(merge, 2);
    const fromA = buildEdgeCorridor('alpha', 'a', 'm', parentA, merge, 'south', slots[0]);
    const fromB = buildEdgeCorridor('alpha', 'b', 'm', parentB, merge, 'south', slots[1]);
    expect(fromA.revealDoorWall).not.toEqual(fromB.revealDoorWall);
    // The two doors must not overlap — slot 0's door stays left of slot 1's.
    expect(Math.max(fromA.revealDoorWall.x1, fromA.revealDoorWall.x2))
      .toBeLessThanOrEqual(Math.min(fromB.revealDoorWall.x1, fromB.revealDoorWall.x2));
  });

  it('#93 pre-flight fix regression (Task 10 review) — a same-column connection\'s TARGET-side plainWalls never extend past its own slot into a sibling\'s (would otherwise wall off the sibling\'s door)', () => {
    const parentA = roomRect('alpha', 'a', 0, 0);
    const merge = roomRect('alpha', 'm', 1, 0); // same column as parentA -> sameColumn branch
    const slots = northDoorSlots(merge, 2);
    const fromA = buildEdgeCorridor('alpha', 'a', 'm', parentA, merge, 'south', slots[0]);
    // Only the walls ON THE TARGET'S OWN north face (y === corridorEndY,
    // i.e. merge.gy) are bounded by the target's slot — a connection's
    // SOURCE-side walls (at faceY, closing off parentA's own south face)
    // have nothing to do with the target's slot layout at all (parentA
    // has no siblings sharing ITS OWN south face), so they're
    // deliberately excluded from this assertion (#93 pre-flight fix,
    // round 2 — the original version of this test wrongly asserted
    // those too, and failed against an otherwise-correct fix).
    const targetSideWalls = fromA.plainWalls.filter((w) => w.y1 === merge.gy);
    for (const w of targetSideWalls) {
      expect(Math.max(w.x1, w.x2)).toBeLessThanOrEqual(slots[0].x2);
      expect(Math.min(w.x1, w.x2)).toBeGreaterThanOrEqual(slots[0].x1);
    }
  });

  it('#93 pre-flight fix regression (Task 10 review) — a same-column corridor reaches the target\'s REAL position, not a fixed CORRIDOR_LEN, when the source is more than one rank above the target', () => {
    const from = roomRect('alpha', 'a', 0, 0);
    // Simulate a merge room whose rank is 3 above one of its real parents
    // (computeRanks takes the MAX over all parents + 1 — a parent not on
    // the longest path can sit several ranks above the merge room).
    const to = roomRect('alpha', 'm', 3, 0);
    const toSlot = northDoorSlots(to, 1)[0];
    const { revealDoorWall, corridorSegments } = buildEdgeCorridor('alpha', 'a', 'm', from, to, 'south', toSlot);
    expect(revealDoorWall.y1).toBe(to.gy);
    expect(corridorSegments[0].gy + corridorSegments[0].gh).toBe(to.gy);
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
 * Edge geometry connecting fromRoomId's exitFace to a specific door slot
 * on toRoomId's north face (`toSlot`, from `northDoorSlots` — Task 5's
 * redesign means "incoming" is always north, but potentially one of
 * several slots when the target has more than one real parent or a
 * hidden extra). Generalizes the old buildConnectionGeometry (slot to
 * slot+1, always straight) to any two graph-positioned rects: same-column
 * rooms still get a single straight corridor; different-column rooms get
 * an L-shaped 2-segment corridor (first segment leaves fromRect on
 * exitFace, second segment approaches `toSlot`, joined by a single
 * corner).
 */
export function buildEdgeCorridor(seed, fromRoomId, toRoomId, fromRect, toRect, exitFace, toSlot) {
  const slotWidth = toSlot.x2 - toSlot.x1;
  const outgoingOffset = doorOffsetAt(seed, `${fromRoomId}-${exitFace}`, 'outgoing', fromRect.gw);
  const incomingOffset = doorOffsetAt(seed, `${toRoomId}-north-${toSlot.x1}`, 'incoming', slotWidth);

  const sameColumn = fromRect.gx === toRect.gx;
  if (exitFace === 'south' && sameColumn) {
    const faceY = fromRect.gy + fromRect.gh;
    // #93 pre-flight fix (found during Task 10's review): was
    // `faceY + CORRIDOR_LEN`, which only reached the target's actual
    // north edge when the source's room-size exactly filled one
    // ROW_STRIDE gap AND the two rooms were exactly one rank apart. A
    // merge room's rank is the MAX over all its real parents' ranks + 1
    // (computeRanks, Task 4) — a parent not on the longest path can sit
    // several ranks above the merge room, or roomSizeAt can roll a
    // smaller-than-max size, either of which left the corridor short of
    // the target (a door floating in empty space, not actually
    // connected). Use the target's real position directly instead.
    const corridorEndY = toRect.gy;
    const doorX0 = fromRect.gx + outgoingOffset;
    const doorX1 = doorX0 + DOOR_WIDTH;
    const gapX0 = toSlot.x1 + incomingOffset;
    const gapX1 = gapX0 + DOOR_WIDTH;
    const spanX0 = Math.min(doorX0, gapX0);
    const spanX1 = Math.max(doorX1, gapX1);
    return {
      doorWall: { x1: doorX0, y1: faceY, x2: doorX1, y2: faceY },
      revealDoorWall: { x1: gapX0, y1: corridorEndY, x2: gapX1, y2: corridorEndY },
      plainWalls: [
        { x1: fromRect.gx, y1: faceY, x2: doorX0, y2: faceY },
        { x1: doorX1, y1: faceY, x2: Math.max(fromRect.gx + fromRect.gw, spanX1), y2: faceY },
        // #93 pre-flight fix, round 2 (found during Task 6's own redo):
        // capped strictly at `toSlot.x1`/`toSlot.x2` — NEVER `spanX1`.
        // `spanX1` also folds in the SOURCE room's own door offset
        // (`doorX1`, bounded by the SOURCE's full width, not the
        // TARGET's narrower slot) — using it here (round 1's fix used
        // `Math.max(toSlot.x2, spanX1)`, which picks whichever is
        // LARGER) could still push this flanking wall past the slot
        // boundary into a sibling connection's own territory whenever
        // the source room is wider than one slot — routine for any
        // merge room with 2+ real parents. `gapX0`/`gapX1` are already
        // guaranteed within `[toSlot.x1, toSlot.x2]` (`incomingOffset`
        // is bounded by `slotWidth`), so these two walls need no
        // `Math.max`/`Math.min` at all — just the slot's own edges.
        { x1: toSlot.x1, y1: corridorEndY, x2: gapX0, y2: corridorEndY },
        { x1: gapX1, y1: corridorEndY, x2: toSlot.x2, y2: corridorEndY }
      ].filter((w) => w.x1 !== w.x2 || w.y1 !== w.y2),
      corridorSegments: [{ gx: spanX0, gy: faceY, gw: spanX1 - spanX0, gh: corridorEndY - faceY }]
    };
  }

  // Different column (or a non-south exit face): a straight leg out of
  // fromRect on exitFace, a corner, then a straight leg into `toSlot`.
  // Simpler than the same-column case's precise two-door offset
  // trimming — a candidate for a future refinement pass if a reviewer
  // finds the corner geometry too blocky in practice.
  const exitPoint = exitFace === 'east'
    ? { x: fromRect.gx + fromRect.gw, y: fromRect.gy + fromRect.gh / 2 }
    : exitFace === 'west'
    ? { x: fromRect.gx, y: fromRect.gy + fromRect.gh / 2 }
    : { x: fromRect.gx + fromRect.gw / 2, y: fromRect.gy + fromRect.gh };
  const entryPoint = { x: toSlot.x1 + slotWidth / 2, y: toSlot.y1 };
  const corner = { x: entryPoint.x, y: exitPoint.y };

  const doorWall = exitFace === 'south'
    ? { x1: exitPoint.x - DOOR_WIDTH / 2, y1: exitPoint.y, x2: exitPoint.x + DOOR_WIDTH / 2, y2: exitPoint.y }
    : { x1: exitPoint.x, y1: exitPoint.y - DOOR_WIDTH / 2, x2: exitPoint.x, y2: exitPoint.y + DOOR_WIDTH / 2 };
  const revealDoorWall = { x1: entryPoint.x - DOOR_WIDTH / 2, y1: entryPoint.y, x2: entryPoint.x + DOOR_WIDTH / 2, y2: entryPoint.y };

  // #93 pre-flight fix: flank the door WITHIN this connection's own
  // `toSlot` (was `plainWalls: []` — left the room's whole north face
  // open beyond just the door itself, and left nothing to separate this
  // slot from a sibling's). Mirrors the same-column branch's own
  // slot-constrained plainWalls above.
  const plainWalls = [
    { x1: toSlot.x1, y1: entryPoint.y, x2: entryPoint.x - DOOR_WIDTH / 2, y2: entryPoint.y },
    { x1: entryPoint.x + DOOR_WIDTH / 2, y1: entryPoint.y, x2: toSlot.x2, y2: entryPoint.y },
  ].filter((w) => w.x1 !== w.x2 || w.y1 !== w.y2);

  return {
    doorWall,
    revealDoorWall,
    plainWalls,
    corridorSegments: [
      { gx: Math.min(exitPoint.x, corner.x), gy: Math.min(exitPoint.y, corner.y), gw: Math.max(CORRIDOR_LEN, Math.abs(corner.x - exitPoint.x)), gh: CORRIDOR_LEN },
      { gx: Math.min(corner.x, entryPoint.x), gy: Math.min(corner.y, entryPoint.y), gw: CORRIDOR_LEN, gh: Math.max(CORRIDOR_LEN, Math.abs(entryPoint.y - corner.y)) }
    ]
  };
}
```

**Third pre-flight fix — `doorOffsetAt` itself needs a one-line bound fix (found during this task's own final review, a third independent pass after the two rounds above).** `doorOffsetAt` is pre-existing, shared code (`scripts/dungeon-layout.mjs`, reused unchanged per this task's own Interfaces line), never designed against a non-integer `roomSize` — every one of its OLD callers always passed an integer (`ROOM_SIZE_SMALL`/`ROOM_SIZE_LARGE`). This task is the first caller to pass `slotWidth` (`toSlot.x2 - toSlot.x1`, from `northDoorSlots(rect, count)` — Task 5), which is `rect.gw / count` and is **not** integer whenever `count` doesn't evenly divide the room's width (e.g. `ROOM_SIZE_SMALL = 6` with a routine 4-way merge-room split → `slotWidth = 1.5`). Confirmed by a 13,860-configuration sweep: `doorOffsetAt`'s existing formula —

```js
export function doorOffsetAt(seed, slot, role, roomSize) {
  const r = splitmix32(seedFromString(`${seed}-door-${role}-${slot}`))();
  const maxOffset = roomSize - DOOR_WIDTH;
  return Math.floor(r * (maxOffset + 1));
}
```

— only stays within `[0, maxOffset]` when `maxOffset` is itself an integer; for a fractional `roomSize` (hence fractional `maxOffset`), `Math.floor(r * (maxOffset + 1))` can round UP PAST `maxOffset` (e.g. `maxOffset = 0.5` can still return `1`), pushing a same-column connection's door position outside its own `toSlot` and into a sibling connection's slot — two adjacent doors physically overlapping. This is the exact "walls off / collides with a sibling's door" failure this whole redesign exists to prevent, arriving via the door's own position rather than a flanking wall. Fix (floors the bound itself, not the caller — zero behavior change for every existing integer-`roomSize` call site, since `Math.floor` of an already-integer value is a no-op):

```js
export function doorOffsetAt(seed, slot, role, roomSize) {
  const r = splitmix32(seedFromString(`${seed}-door-${role}-${slot}`))();
  const maxOffset = Math.floor(roomSize - DOOR_WIDTH);
  return Math.floor(r * (maxOffset + 1));
}
```

Add a regression test to `describe('buildEdgeCorridor', ...)` (in `tests/dungeon-layout.test.mjs`) targeting exactly the reproduced case — a room size that does NOT evenly divide by the split count:

```js
it('#93 pre-flight fix regression (this task\'s own final review) — a same-column room whose incoming-door count doesn\'t evenly divide its width still keeps every door within its own slot (doorOffsetAt must not exceed a fractional maxOffset)', () => {
  const parentA = roomRect('alpha', 'a', 0, 0);
  const parentB = roomRect('alpha', 'b', 0, 1);
  const merge = roomRect('alpha', 'm', 1, 0); // ROOM_SIZE_SMALL = 6, split 4 ways below -> slotWidth = 1.5
  const slots = northDoorSlots(merge, 4);
  for (let i = 0; i < slots.length; i += 1) {
    const from = i === 0 ? parentA : parentB; // exitFace/column irrelevant to this bug; same-column (i===0) is where it reproduces
    const { revealDoorWall } = buildEdgeCorridor('alpha', from === parentA ? 'a' : 'b', 'm', from, merge, 'south', slots[i]);
    expect(Math.min(revealDoorWall.x1, revealDoorWall.x2)).toBeGreaterThanOrEqual(slots[i].x1);
    expect(Math.max(revealDoorWall.x1, revealDoorWall.x2)).toBeLessThanOrEqual(slots[i].x2);
  }
});
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
- Consumes: `{rooms, edges, layoutEdges}` (Task 2/3 — `layoutEdges` per #156's fix includes detour rooms as extra children, so they get built too).
- Produces: `roomsToEagerlyBuild(state)` (same exported name, new graph-walk implementation, unconditional — no `hostUserId` gate, no ITEM-11 index-1 special case) → array of `{room, buildOrder}` in topological order (parents before children). `buildOrder` replaces the old `physicalSlot` name in this return shape (still a plain monotonic integer, same role); `commitEagerPhysicalSlots` (existing) keeps working unmodified against this shape since it only destructures `{room, physicalSlot}` — **rename the destructured field to `buildOrder` in both functions together** so the two stay in sync.

**#156 fix:** this walks `state.layoutEdges`, not `state.edges` — `layoutEdges` is `edges` plus each detour room appended as an extra child of its attaching room (Task 3). Walking `edges` alone never reaches a detour room (its only incoming connection is a hidden edge, not a normal one), so it would silently never get built. Shortcut targets need no special walk handling — they're already real rooms reachable via their own real parent in `edges`/`layoutEdges` alike.

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
    layoutEdges: { 'room-entry': ['a', 'b'], a: ['goal'], b: ['goal'], goal: [] },
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

  it('#156: a detour room reachable only via layoutEdges (not edges) is still built', () => {
    const state = graphState({
      rooms: {
        'room-entry': { id: 'room-entry', kind: 'safe_entry', isGoal: false },
        a: { id: 'a', kind: 'combat', isGoal: false },
        'room-detour-0': { id: 'room-detour-0', kind: 'trap', isGoal: false },
        goal: { id: 'goal', kind: 'combat', isGoal: true }
      },
      edges: { 'room-entry': ['a'], a: ['goal'], 'room-detour-0': ['goal'], goal: [] },
      layoutEdges: { 'room-entry': ['a'], a: ['goal', 'room-detour-0'], 'room-detour-0': ['goal'], goal: [] }
    });
    const built = roomsToEagerlyBuild(state);
    expect(built.map((e) => e.room.id)).toContain('room-detour-0');
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
  const { rooms, layoutEdges } = state;
  const order = [];
  const visited = new Set(['room-entry']);
  const indegree = {};
  for (const id of Object.keys(rooms)) indegree[id] = 0;
  for (const children of Object.values(layoutEdges)) {
    for (const childId of children) indegree[childId] += 1;
  }
  const queue = (layoutEdges['room-entry'] ?? []).slice();
  while (queue.length) {
    const id = queue.shift();
    if (visited.has(id)) continue;
    // Only ready once every parent has already been queued/visited — a
    // simple readiness re-check via indegree decrement per visit below.
    visited.add(id);
    order.push(rooms[id]);
    for (const childId of layoutEdges[id] ?? []) {
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
- Produces: `revealTravelTimeEffect({ edges, hiddenEdges }, roomId, effectKey)` (new, `dungeon-deck.mjs`) → `{ edges, hiddenEdges, revealedRoomId }` with the room's hidden path (if any) merged into the live `edges` and removed from `hiddenEdges`, or unchanged (and `revealedRoomId: null`) if there's nothing hidden to reveal. `revealedRoomId` (#156) is the target room id that just became live — `markRoomOutcome` forwards it so the scene layer (Task 9 addendum) knows which hidden door to unseal, without having to re-derive it from a `hiddenEdges` entry that's already been deleted by the time the scene-side step runs. `markRoomOutcome` (existing name, `dungeon-runner.mjs`) drops all `applySequenceMutation`/physical-slot-assignment logic and instead calls `revealTravelTimeEffect` when `effectKey` is `'reduced_travel_time'` or `'extra_travel_time'`. `depthBiasFor({rank, maxRank, isGoal})`/`lootGpForTreasureRoom({partyLevel, rank, maxRank, isGoal})`/`treasureRoomItemTableName({partyLevel, rank, maxRank, isGoal, rng})` (all three existing names, `dungeon-deck.mjs`, `physicalSlot`/`roomCount` renamed to `rank`/`maxRank` — #93 pre-flight fix, Step 3a; Task 10's own `depthBiasFor` call and Task 13's `applyRoomEffect`/`grantTreasureReward` call depend on this rename).

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
    return { edges, hiddenEdges, revealedRoomId: null };
  }
  const hidden = hiddenEdges[roomId];
  if (!hidden?.length) return { edges, hiddenEdges, revealedRoomId: null };
  const newHiddenEdges = { ...hiddenEdges };
  delete newHiddenEdges[roomId];
  return {
    edges: { ...edges, [roomId]: [...(edges[roomId] ?? []), ...hidden] },
    hiddenEdges: newHiddenEdges,
    revealedRoomId: hidden[0], // attachHiddenPaths (#156) guarantees at most one hidden target per room
  };
}
```

In `scripts/dungeon-runner.mjs`, replace the `mutation`/`rooms`/physical-slot-assignment block inside `markRoomOutcome` (the code between computing `effectKey`/`mutation` and building `newState`) with:

```js
  const { effectKey } =
    room.kind === "safe_rest"
      ? { effectKey: "rest_room_passed" }
      : getGenerator().resolveRoomOutcome(getGenerator().findOutcomeTemplate(room.outcomeSlotId), succeeded);

  const { edges, hiddenEdges, revealedRoomId } = getGenerator().revealTravelTimeEffect(
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
  return { state: newState, effectKey, revealedRoomId };
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

### Task 9 addendum (#156): scene-side unseal on reveal

`revealTravelTimeEffect` only merges data (`edges`/`hiddenEdges`). Per Task 10's build-time change, the actual door wall for a hidden edge already exists in the scene — built LOCKED and flagged `dungeonHiddenDoorForEdge` — so revealing it is a pure "flip the flag/state" scene update, never a build. This was the original plan's real gap (per #156): there was no step here at all.

**Files:**
- Modify: `scripts/dungeon-scene.mjs` (new function), `scripts/ui/dungeon-app.mjs` (new `applyRoomEffect` case)

**New function, `scripts/dungeon-scene.mjs`:**

**#93 fix (found during Task 11's own review, fix round 2 — this function originally promoted BOTH the gate and reveal walls to the same `dungeonDoorToRoomId` flag, which matched Task 11's ORIGINAL door-open trigger. Task 11's own fix round 1 moved that trigger to `dungeonRevealDoorForSlot` instead, which this function never wrote — silently breaking every hidden-door reveal. Fixed below by differentiating on the `dungeonHiddenDoorRole` flag Task 10's hidden branch now also writes.):**

```js
/**
 * #156: promote a hidden shortcut/detour door from sealed to normal, once
 * `revealTravelTimeEffect` (dungeon-runner.mjs) has merged its edge into
 * the live graph. Never builds anything — the door and its corridor were
 * already constructed (LOCKED, `dungeonHiddenDoorForEdge`-flagged) during
 * eager pregeneration (Task 10). Finds every wall flagged
 * `dungeonHiddenDoorForEdge` starting with `${roomId}->` (the doorWall on
 * the revealing room's own face, and its matching revealDoorWall on the
 * target's face both carry this prefix, per Task 10's addendum) and, per
 * wall, based on its `dungeonHiddenDoorRole` ('gate' vs 'reveal', Task 10):
 * - sets `ds: CONST.WALL_DOOR_STATES.CLOSED` (unlocked, same convention as
 *   `unlockDoorToSlot`) on both
 * - the 'gate' wall gets `dungeonDoorToRoomId` (matches a normal
 *   progress-gate door — not itself a reveal trigger)
 * - the 'reveal' wall gets `dungeonRevealDoorForSlot` (Task 11's actual
 *   door-open reveal trigger — without this, opening the now-unsealed
 *   door would never fire `handleDungeonDoorOpened`'s reveal/combat-
 *   start/advance sequence)
 * - both get `dungeonDoorFromRoomId: roomId` (matches the normal-door
 *   convention Task 10's own fix round 1 established, for consistency —
 *   nothing currently reads it off a promoted hidden door, but a future
 *   caller keying off both ends shouldn't find this door the one
 *   exception)
 */
export async function unsealHiddenDoorFromRoom(scene, roomId, targetRoomId) {
  const walls = scene.walls.filter(
    (w) => w.getFlag(MODULE_ID, "dungeonHiddenDoorForEdge") === `${roomId}->${targetRoomId}`,
  );
  for (const wall of walls) {
    const isReveal = wall.getFlag(MODULE_ID, "dungeonHiddenDoorRole") === "reveal";
    await wall.update({
      ds: CONST.WALL_DOOR_STATES.CLOSED,
      [`flags.${MODULE_ID}.${isReveal ? "dungeonRevealDoorForSlot" : "dungeonDoorToRoomId"}`]: targetRoomId,
      [`flags.${MODULE_ID}.dungeonDoorFromRoomId`]: roomId,
      [`flags.${MODULE_ID}.-=dungeonHiddenDoorForEdge`]: null,
      [`flags.${MODULE_ID}.-=dungeonHiddenDoorRole`]: null,
    });
  }
}
```

**`scripts/ui/dungeon-app.mjs`'s `applyRoomEffect`:** add a case (the old comment above the function claiming `reduced_travel_time`/`extra_travel_time` "never reach here" is now wrong post-#93/#156 — `markRoomOutcome` no longer intercepts them, so update that comment too):

```js
case "reduced_travel_time":
case "extra_travel_time": {
  if (revealedRoomId) {
    await unsealHiddenDoorFromRoom(scene, roomId, revealedRoomId);
  }
  return;
}
```

**Note for the implementer:** `markRoomOutcome` now returns `revealedRoomId` alongside `effectKey` (Task 9's main body, updated above) — thread it through `resolveCurrentRoom`'s existing `applyRoomEffect(effectKey, {...})` call the same way `roomId`/`physicalSlot`/etc. already are, rather than re-deriving it from `state.hiddenEdges[roomId]` inside `applyRoomEffect` (that entry is already deleted by the time this runs, since `applyRoomEffect` executes against the post-merge state).

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
same file and the same "slot → graph node" generalization. **#156**
layers its own hidden-edge geometry on top of this same combined
function. **A second pre-flight fix, on top of both:** the original
per-room "one incoming face" model (`incomingFace`/`parentRoomId`,
singular) couldn't represent a merge room's real multiple parents, or
a shortcut target's second hidden incoming, without collision risk
against a room's own outgoing faces — see Task 5's redesign
(`incomingConnectionsFor`/`northDoorSlots`, always north, subdivided).
This task now builds N incoming doors per room (N from
`incomingConnectionsFor`), not a hardcoded one or two.

**Files:**
- Modify: `scripts/dungeon-scene.mjs`, `scripts/dungeon-layout.mjs` (export `roomSidesFor` as `roomSidesForRect`), `scripts/dungeon-combat.mjs` (rename `startCombatForSlot`/`getCombatForSlot` — see Step 3d)
- Test: manual/live verification only (this file has no Foundry test harness, same existing boundary as `buildRoomAtSlot`/`buildConnectionGeometry` today — see the spec's Testing section).

**Interfaces:**
- Consumes: `roomRect`, `roomEnclosureWalls`, `exitFaceForIndex`, `parentRoomIdsFor`, `incomingConnectionsFor`, `northDoorSlots`, `ROW_STRIDE`, `COLUMN_STRIDE` (Task 5), `buildEdgeCorridor` (Task 6).
- Produces: `buildRoomAtGraphNode(scene, roomId, {rank, col, childIds, incomingConnections, hiddenChildId, isGoal, locationTag, artVariant, seed})` (replaces `buildRoomAtSlot`, this room's own enclosure walls/floor art/light only — creates them directly rather than returning them, also writes a `dungeonDoorToRoomId` flag onto each created real door/reveal-door wall — Task 11 reads it directly off the wall, no separate in-memory lookup needed — and returns `{rect, outgoingFaces, placeholderIdsByConnection}`, one placeholder-id list per entry in `incomingConnections`, deliberately NOT deleting any of them itself, deferring that to the caller for #110 ordering); `buildPopulateAndUnlockGraphNode(scene, state, room, {rank, col, childIds, hiddenChildId, unlock})` (replaces `buildPopulateAndUnlockRoom` — walls + every incoming connection's geometry (real AND hidden, one per `incomingConnectionsFor(state.layoutEdges, room.id, state.hiddenIncomingByRoomId)` entry) + content population + door unlock, the actual function Tasks 11/12/13 call; every real door/reveal-door wall carries BOTH `dungeonDoorToRoomId` (target) and `dungeonDoorFromRoomId` (source) — #93 pre-flight fix, a merge room's several real doors all share the same target id, so unlocking needs both ends to find the right one); `resizeSceneForLayout(scene, {maxRank, maxCol})` (new, replaces the per-room `ensureSceneCovers`/`requiredDimensions(maxSlot)` pair — called ONCE by Task 12 right after layout is computed, before any room builds, since the whole graph's extent is known up front under full pregeneration); `unlockDoorsFromRoom(scene, roomId, childIds, hiddenChildIds)` (new — unlocks every one of `roomId`'s outgoing doors whose target is in `childIds` but not in `hiddenChildIds`, via each door's own `dungeonDoorToRoomId`+`dungeonDoorFromRoomId` flag pair; used by Task 13's corrected trailing block instead of building a "next room"); `isSlotBuilt` (existing name, corrected body — #93 pre-flight fix, see Step 3e — the old slot-flag check never matches anything the new build functions write, which silently broke idempotency).

**#156 fix — hidden edges get real, sealed geometry at build time, not a runtime retrofit.** A room's hidden outgoing edge (`hiddenEdges[roomId]`, at most one — Task 3) reserves the face right after its real `childIds` and gets a placeholder/door exactly like a real edge, EXCEPT it's flagged `dungeonHiddenDoorForEdge` instead of `dungeonFrontierWallForEdge`/`dungeonDoorToRoomId`. That distinct flag is what keeps it sealed: the per-room-populated unlock step (`unlockDoorsFromRoom`, above) only ever matches the normal flag, so a `dungeonHiddenDoorForEdge`-flagged door is never touched by it and stays `LOCKED` until Task 9's reveal explicitly promotes it (the addendum above). A room's INCOMING side handles this uniformly now (Task 5's redesign): `incomingConnectionsFor` already marks each connection `{sourceId, hidden}` — a detour room's one real parent link comes back marked `hidden: true` by the caller (its sole connection IS the hidden path — see Step 3c), a shortcut target's extra connection from `hiddenIncomingByRoomId` comes back `hidden: true` directly from `incomingConnectionsFor` itself, and everything else is `hidden: false`. `hiddenChildId` (this room's own hidden OUTGOING target, if any — `hiddenEdges[roomId]?.[0]`) is unchanged from before: reserves and builds its placeholder face, same as a real child but hidden-flagged.

- [ ] **Step 1: Write the plan for manual verification**

No unit test — write out, in a comment block above `buildRoomAtGraphNode`, the exact live-verification checklist to run once implemented (mirrors the spec's Testing section): (a) a 1-exit room behaves identically to today's single-corridor case, content and all; (b) a 2-exit room gets two independently lockable doors on different faces, each leading to its own distinct populated child; (c) opening either door correctly supersedes only that door's own frontier placeholder, leaving the room's other still-unopened exit's placeholder untouched; (d) the real walls for a newly built connection are always created before the old frontier placeholder for that same face is deleted (never the reverse — the existing #110 fog-leak-avoidance ordering); (e) a trap/skill_challenge/puzzle/narrative/treasure room's own persisted state (`ensureTrapState`/`ensureSkillChallenge`/etc.) is attached exactly once per room, same as today; (f) **[#156]** a room with a hidden shortcut/detour edge still has that face solidly built (a real door wall, `ds: LOCKED`, flagged `dungeonHiddenDoorForEdge`) rather than left as a plain solid enclosure wall; (g) **[#156]** opening every one of a room's *normal* doors never reveals or unlocks its hidden door; (h) **[merge-door fix]** a merge room with 2+ real parents gets a working, independently openable door for EVERY one of them, all on its north face, none silently sealed; (i) **[merge-door fix]** a room that is the 2nd or 3rd child of a branching parent, and that itself branches into 2-3 children, never has its incoming door collide with one of its own outgoing doors (incoming is always north, outgoing is always south/east/west, by construction — confirm live that this is what's actually built, not just assumed).

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
  parentRoomIdsFor,
  incomingConnectionsFor,
  northDoorSlots,
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
  {
    rank, col, childIds = [], incomingConnections = [],
    hiddenChildId = null,
    isGoal = false, locationTag = null, artVariant = 0, seed = "",
  },
) {
  const rect = roomRect(seed, roomId, rank, col);

  const realOutgoingFaces = isGoal ? [] : childIds.map((_, i) => exitFaceForIndex(i));
  const hiddenFaceIndex = childIds.length; // reserved right after the real children
  const outgoingFaces = hiddenChildId ? [...realOutgoingFaces, exitFaceForIndex(hiddenFaceIndex)] : realOutgoingFaces;
  // #93 pre-flight fix: incoming is ALWAYS north now (Task 5's redesign),
  // subdivided into one door slot per `incomingConnections` entry — never
  // a variable compass direction, and never overlapping with outgoingFaces
  // (which never includes north) regardless of how many incoming
  // connections this room has or which index it was among its own
  // parent's children.
  const walls = roomEnclosureWalls(seed, roomId, { incomingCount: incomingConnections.length, outgoingFaces }, rect).map(
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

  // Supersede EACH incoming connection's own frontier placeholder (built
  // by ITS OWN source room when that room was built) — one lookup per
  // connection, keyed by the EXACT `sourceId->roomId` edge, not just an
  // endsWith suffix match: a merge room can have several placeholders all
  // ending with `->roomId`, one per real parent, and only an exact match
  // picks out the right one for THIS specific connection. Hidden
  // connections (shortcut extra, or a detour's one real parent link,
  // marked `hidden: true` by the caller — Step 3c) were flagged
  // `dungeonHiddenDoorForEdge` instead of `dungeonFrontierWallForEdge` by
  // their source room; everything else is looked up the same way.
  // Deleted only once the caller's OWN matching connection-wall creation
  // succeeds (#110 ordering) — never here.
  const placeholderIdsByConnection = incomingConnections.map(({ sourceId, hidden }) => {
    const flag = hidden ? "dungeonHiddenDoorForEdge" : "dungeonFrontierWallForEdge";
    return scene.walls
      .filter((w) => w.getFlag(MODULE_ID, flag) === `${sourceId}->${roomId}`)
      .map((w) => w.id);
  });

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
  // #156: the hidden outgoing placeholder, if any — same lifecycle as a
  // real frontier placeholder (superseded when the target room builds),
  // but flagged so the generic per-room-populated unlock step never
  // touches it.
  if (hiddenChildId) {
    const face = exitFaceForIndex(hiddenFaceIndex);
    const side = roomSidesForRect(rect)[face];
    walls.push(
      wallDoc(side, {
        ds: CONST.WALL_DOOR_STATES.LOCKED,
        flags: { [MODULE_ID]: { dungeonHiddenDoorForEdge: `${roomId}->${hiddenChildId}` } },
      }),
    );
  }

  // This room's OWN enclosure walls, created now — but NONE of
  // `placeholderIdsByConnection`'s lists are deleted here. #110's
  // ordering requires each placeholder to survive until ITS OWN real
  // connecting door exists, and those doors are built by the caller
  // (buildPopulateAndUnlockGraphNode, Step 3c below, which has the
  // source room rect(s) this function doesn't) — deleting a placeholder
  // here, before its door exists, would leave exactly the gap #110
  // fixed (a face with neither the placeholder nor real geometry).
  // Returned for the caller to delete, each list only once ITS OWN
  // matching connection-wall creation succeeds.
  if (walls.length) await scene.createEmbeddedDocuments("Wall", walls);

  // This room's own floor-art Tile + AmbientLight (ported unchanged from
  // the current buildRoomAtSlot, dungeon-scene.mjs:304-335 — read it
  // directly: `roomArtPath({locationTag, isGoal, artVariant})` for the
  // Tile texture at anchorX/Y:0 sized to `rect`, then `roomLightRadii(rect.gw)`
  // for one centered AmbientLight). Unlike the CORRIDOR tiles (which
  // depend on a parent and so belong in buildPopulateAndUnlockGraphNode
  // below, not here), this room's own art/light never depended on the
  // connecting door in the old code either — port it verbatim, with ONE
  // addition: flag the Tile document `{[MODULE_ID]: {dungeonRoomBuilt:
  // roomId}}`. #93 pre-flight fix (found by Task 10's own re-review, a
  // second Critical on top of the first): `isSlotBuilt` (Step 3e)
  // originally checked for a room's own frontier placeholders/enclosure
  // walls as its "already built" marker — but frontier placeholders are
  // exactly the walls each CHILD's own build later DELETES (#110
  // ordering), so under full eager pregeneration (parents built before
  // children, Task 12), by the time a room's own children are ALSO
  // built, none of those markers survive — `isSlotBuilt` would flip back
  // to `false` for an already-fully-built room, and Task 11's lazy
  // fallback would rebuild it: duplicate walls/tiles/lights, and a
  // second set of frontier placeholders laid directly over the room's
  // already-open, already-built exits, which nothing would ever delete
  // again. The room's own floor-art Tile is the one thing this function
  // creates exactly once and NEVER deletes or supersedes afterward — a
  // dedicated flag on it is a stable, permanent "this room was built"
  // marker, unlike any wall-based signal.

  return { rect, outgoingFaces, placeholderIdsByConnection };
}
```

**Design note:** `buildRoomAtGraphNode` creates its own enclosure walls, floor art, and light directly (self-contained, matching the original `buildRoomAtSlot`'s scope for a room's own geometry) — but does NOT delete any incoming connection's frontier placeholder itself, and does NOT yet know about any of the actual corridor connections (needs each source room's rect, which this function has no way to know). The corridor CONNECTION(s) — one per `incomingConnections` entry, real or hidden — are `buildPopulateAndUnlockGraphNode`'s own job (Step 3c) — it creates each connection's walls in its own `createEmbeddedDocuments` call, and only THEN deletes that connection's own matching placeholder-id list, preserving #110's exact creation-before-deletion ordering independently for every incoming connection this room has (a placeholder survives from before this room existed at all, through this room's own enclosure build, until the moment ITS OWN real connecting geometry actually replaces it).

- [ ] **Step 3c: Replace `buildPopulateAndUnlockRoom` with `buildPopulateAndUnlockGraphNode`**

This is the function every real caller (Tasks 11/12/13) actually calls — it wraps `buildRoomAtGraphNode`, adds the parent-connection geometry, then populates content and unlocks doors exactly like the original `buildPopulateAndUnlockRoom` did, keyed by `room.id` (string) everywhere the original used `physicalSlot` (integer) as the `dungeonSlot` flag value and the `populateSlot*`/`depthBiasFor` argument — **the flag NAME `dungeonSlot` is unchanged** (avoids touching `dungeon-combat.mjs` or its 4 existing test files, which only ever compare this flag's value for equality, never as a number), only what gets stored in it changes.

```js
export async function buildPopulateAndUnlockGraphNode(
  scene,
  state,
  room,
  { rank, col, childIds = [], hiddenChildId = null, unlock = true } = {},
) {
  const alreadyBuilt = isSlotBuilt(scene, room.id);
  const rect = roomRect(state.seed, room.id, rank, col);

  // #93 pre-flight fix (merge-door redesign): every real parent this room
  // has (usually 1, more for a merge room), plus a shortcut's hidden
  // extra incoming source if any. A detour room's one real parent link
  // (found via layoutEdges, since it only exists there) is marked hidden
  // here, not by incomingConnectionsFor itself — its sole connection IS
  // the hidden path, but Task 5's function has no notion of "detour" and
  // shouldn't need one; this caller already has `state.hiddenRooms`.
  const isDetour = state.hiddenRooms.includes(room.id);
  const incomingConnections = incomingConnectionsFor(state.layoutEdges, room.id, state.hiddenIncomingByRoomId)
    .map((conn) => (isDetour ? { ...conn, hidden: true } : conn));

  if (!alreadyBuilt) {
    // Creates this room's own enclosure walls + floor art + light
    // already (see Step 3b) — does NOT delete any incoming placeholder
    // yet (that's this function's own job, after each connection below).
    const { placeholderIdsByConnection } = await buildRoomAtGraphNode(
      scene,
      room.id,
      {
        rank, col, childIds, incomingConnections, hiddenChildId,
        isGoal: room.isGoal, locationTag: room.locationTag,
        artVariant: room.artVariant, seed: state.seed,
      },
    );

    const connectionWalls = [];
    const tiles = [];
    const placeholderIdsToDelete = [];
    // One door per incoming connection, all on this room's own north
    // face — northDoorSlots' Nth slot corresponds to incomingConnections'
    // Nth entry (same order, same length).
    const slots = incomingConnections.length ? northDoorSlots(rect, incomingConnections.length) : [];
    for (let i = 0; i < incomingConnections.length; i += 1) {
      const { sourceId, hidden } = incomingConnections[i];
      const toSlot = slots[i];
      const sourcePos = state.layoutPositionByRoomId[sourceId];
      const sourceRect = roomRect(state.seed, sourceId, sourcePos.rank, sourcePos.col);
      const sourceChildIds = state.edges[sourceId] ?? [];
      // Which face did the SOURCE room use to exit toward THIS room? For
      // a real connection, whichever index this room occupies among the
      // source's own real children. For a hidden connection (shortcut
      // extra, or a detour's one real parent link), the source's hidden
      // outgoing target is always reserved right after its real children
      // (`exitFaceForIndex(sourceChildIds.length)` — same convention
      // `buildRoomAtGraphNode`'s own `hiddenFaceIndex` uses for itself).
      const exitFaceFromSource = hidden
        ? exitFaceForIndex(sourceChildIds.length)
        : exitFaceForIndex(sourceChildIds.indexOf(room.id));
      const { doorWall, revealDoorWall, plainWalls, corridorSegments } =
        buildEdgeCorridor(state.seed, sourceId, room.id, sourceRect, rect, exitFaceFromSource, toSlot);
      if (hidden) {
        // #156: sealed until Task 9's reveal step explicitly promotes it
        // (both doorWall and revealDoorWall share the SAME
        // dungeonHiddenDoorForEdge value, matching
        // unsealHiddenDoorFromRoom's own lookup) — never added to
        // `dungeonDoorToRoomId`/`dungeonRevealDoorForSlot`, so a locked
        // hidden door can't resolve through handleDungeonDoorOpened
        // (Task 11) before that happens.
        //
        // #93 pre-flight fix (found during Task 11's own review, fix round
        // 2): also tagged `dungeonHiddenDoorRole` ('gate'/'reveal') on each
        // wall — the two are otherwise geometrically indistinguishable
        // once queried back by their shared dungeonHiddenDoorForEdge
        // value, and `unsealHiddenDoorFromRoom` (Task 9 addendum) needs to
        // know which one to promote to `dungeonDoorToRoomId` (the
        // progress-gate flag, never itself the reveal trigger) vs.
        // `dungeonRevealDoorForSlot` (Task 11's actual reveal-open
        // trigger, added in that task's own fix round 1) — without this,
        // a revealed hidden door would carry only `dungeonDoorToRoomId`
        // and Task 11's handler (which reads `dungeonRevealDoorForSlot`)
        // would silently never fire for it.
        connectionWalls.push(
          wallDoc(doorWall, { flags: { [MODULE_ID]: { dungeonHiddenDoorForEdge: `${sourceId}->${room.id}`, dungeonHiddenDoorRole: "gate" } }, ds: CONST.WALL_DOOR_STATES.LOCKED, door: CONST.WALL_DOOR_TYPES.DOOR }),
          wallDoc(revealDoorWall, { flags: { [MODULE_ID]: { dungeonHiddenDoorForEdge: `${sourceId}->${room.id}`, dungeonHiddenDoorRole: "reveal" } }, ds: CONST.WALL_DOOR_STATES.LOCKED, door: CONST.WALL_DOOR_TYPES.DOOR }),
          ...plainWalls.map((w) => wallDoc(w)),
        );
      } else {
        // #93 pre-flight fix (found during this task's own review): a
        // real door wall must carry BOTH ends of the edge, not just the
        // target. `dungeonDoorToRoomId` alone is what Task 11's
        // `handleDungeonDoorOpened` reads off ONE specific clicked wall
        // (fine, unambiguous there) — but a merge room has MULTIPLE real
        // doors all flagged `dungeonDoorToRoomId: room.id` (one per real
        // parent), and `unlockDoorsFromRoom` (Step 3f, below) needs to
        // find the ONE door belonging to a SPECIFIC source room, not
        // "whichever one Array.find happens across the whole scene."
        // Without `dungeonDoorFromRoomId`, resolving room A's own
        // outcome could unlock room B's door into the merge room instead
        // of A's — the exact "every parent but one dead-ends" bug this
        // whole redesign exists to fix, just moved from build-time to
        // unlock-time.
        connectionWalls.push(
          wallDoc(doorWall, { flags: { [MODULE_ID]: { dungeonDoorToRoomId: room.id, dungeonDoorFromRoomId: sourceId } }, ds: CONST.WALL_DOOR_STATES.LOCKED, door: CONST.WALL_DOOR_TYPES.DOOR }),
          wallDoc(revealDoorWall, { flags: { [MODULE_ID]: { dungeonRevealDoorForSlot: room.id, dungeonDoorFromRoomId: sourceId } }, ds: CONST.WALL_DOOR_STATES.CLOSED, door: CONST.WALL_DOOR_TYPES.DOOR }),
          ...plainWalls.map((w) => wallDoc(w)),
        );
      }
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
      // Run this once per connection loop iteration, same as the walls.
      placeholderIdsToDelete.push(...placeholderIdsByConnection[i]);
    }

    // #110 ordering: create every connection's geometry (and this room's
    // own tiles) BEFORE deleting any placeholder, so there is never a
    // frame where a shared wall is neither the placeholder nor the real
    // corridor/door.
    if (connectionWalls.length) await scene.createEmbeddedDocuments("Wall", connectionWalls);
    if (tiles.length) await scene.createEmbeddedDocuments("Tile", tiles);
    if (placeholderIdsToDelete.length) await scene.deleteEmbeddedDocuments("Wall", placeholderIdsToDelete);
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

- [ ] **Step 3e: `isSlotPopulated`/`unlockDoorToSlot`/`relockDoorToSlot` unchanged; `isSlotBuilt` needs a real body fix**

`isSlotPopulated`/`unlockDoorToSlot`/`relockDoorToSlot` don't need to change at all — they already take an opaque `slot` param and compare it via `===` against a flag value (`dungeonSlot`, still written by `populateSlotEncounter`/`populateSlotTrap` in Step 3d). Just confirm every CALLER now passes a `room.id` string where it used to pass an integer `physicalSlot`/`slot` (Step 3c/3d above already do this). Do not rename these three functions or their flags.

**`isSlotBuilt` is the one exception — #93 pre-flight fix, TWO rounds (both found by this task's own review — a Critical the first pass introduced was caught by the SAME review's own re-check of its own fix).**

Round 1's problem: the current body checks `w.getFlag(MODULE_ID, "dungeonDoorToSlot") === slot` — but `buildRoomAtGraphNode`/`buildPopulateAndUnlockGraphNode` never write a `dungeonDoorToSlot`-flagged wall anywhere (that flag belonged to the old slot system's own door-building code, not this task's). Left as originally drafted, `isSlotBuilt` returns `false` for EVERY room built via the new graph functions, always.

Round 2's problem: a wall-marker-based fix (checking `dungeonEnclosureWallForRoom`/`dungeonFrontierWallForEdge`/`dungeonHiddenDoorForEdge`) LOOKS complete but isn't — a room's own frontier placeholders are exactly the walls each of ITS OWN CHILDREN's build later deletes (#110 ordering, Step 3c). Under full eager pregeneration (parents built before children, Task 12), by the time a room's children are ALSO built, none of its own frontier-placeholder markers survive — `isSlotBuilt` would flip back to `false` for an already-fully-built room, exactly the same "not idempotent, Task 11 lazy fallback rebuilds it" failure round 1 was meant to fix, just delayed until the room's children finish building instead of happening immediately.

**Fix: use a dedicated marker that this function creates exactly once and NEVER deletes or supersedes — the room's own floor-art Tile (flagged `dungeonRoomBuilt: roomId`, Step 3b above), not any wall.**

```js
export function isSlotBuilt(scene, roomId) {
  return scene.tiles.some((t) => t.getFlag(MODULE_ID, "dungeonRoomBuilt") === roomId);
}
```

- [ ] **Step 3f: Add `unlockDoorsFromRoom` and `resizeSceneForLayout`**

```js
/** Unlocks every one of roomId's outgoing doors whose target is in
 * childIds but not in hiddenChildIds — #93: a graph room can have several
 * exits, all needing unlocking together once its own outcome resolves,
 * unlike the old single unlockDoorToSlot call. Each door was flagged
 * dungeonDoorToRoomId with its own target room id AND
 * dungeonDoorFromRoomId with its own source room id at build time
 * (buildPopulateAndUnlockGraphNode / Step 3c above).
 *
 * #93 pre-flight fix (found during this task's own review): matching on
 * `dungeonDoorToRoomId === targetId` ALONE is not enough — a merge
 * target can have several real doors, all flagged with the SAME target
 * id (one per real parent), so `Array.find` would return whichever one
 * happens to come first in the scene's wall list, not necessarily THIS
 * room's own door. Matching on both ends of the edge together is what
 * actually picks out the right one. */
export async function unlockDoorsFromRoom(scene, roomId, childIds, hiddenChildIds = []) {
  const targets = childIds.filter((id) => !hiddenChildIds.includes(id));
  for (const targetId of targets) {
    const wall = scene.walls.find(
      (w) =>
        w.getFlag(MODULE_ID, "dungeonDoorToRoomId") === targetId &&
        w.getFlag(MODULE_ID, "dungeonDoorFromRoomId") === roomId,
    );
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

**Placeholder lookup precision — a pre-existing bug avoided by the merge-door redesign, worth calling out explicitly.** An earlier draft of this task looked up a frontier placeholder via `.endsWith(`->${roomId}`)` — necessary once a room can have several placeholders all ending with `->roomId` (one per real parent), but ONLY correct if paired with an unambiguous way to pick out THIS connection's own one. Step 3b's `placeholderIdsByConnection` does this by exact match (`getFlag(...) === `${sourceId}->${roomId}``), keyed per connection — never fall back to a bare `endsWith` scan across all of a room's placeholders, since that can't distinguish which of a merge room's several parents a given placeholder belongs to.

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

**#93 pre-flight fix — this task's scope was under-drafted.** An earlier draft's `handleDungeonDoorOpened` only handled routing (resolve `roomId`, lazy-build, `advanceToRoom`) and silently dropped everything else the CURRENT function does: the `game.user.isGM` guard (this hook fires on every connected client), `playDoorSound`, `revealSlotTokens`, starting combat before the reveal gives it away, `focusCameraOnSlot`, the `{autoOpenTracker}` return contract another caller depends on, and — the real gap — the rest room's own auto-resolve (a rest room has nothing to Succeed/Fail, so it resolves itself immediately instead of leaving the party stuck with no button to press). Dispatched as originally drafted, this would have been a real feature regression, not just an incomplete diff. The corrected version below restores all of it, adapted to the room-id model.

**Interfaces:**
- Consumes: `advanceToRoom` (Task 8), `markRoomOutcome`/`unlockDoorsFromRoom` (Task 9/10 — the rest-room auto-resolve no longer builds anything ad hoc from inside the door handler; it ensures each child is built the same way Task 13's `resolveCurrentRoom` does, then unlocks the rest room's own outgoing doors), `dungeonRevealDoorForSlot` wall-flag lookup (Task 10 — see the trigger-door correction below), `buildPopulateAndUnlockGraphNode` (Task 10 — now resolves a room's own `incomingConnections` internally via `state.layoutEdges`/`state.hiddenIncomingByRoomId`/`state.hiddenRooms`, so this task's caller only needs `childIds`/`hiddenChildId`), `startCombatForRoom` (Task 10 Step 3d's rename of `startCombatForSlot`), a new `focusCameraOnRoom` (this task, see below).
- Produces: `handleDungeonDoorOpened(sceneId, wallId)` (existing name, new body) resolving `wallId` → the opened wall's `dungeonRevealDoorForSlot` flag → calls `advanceToRoom` with that specific child, instead of the old single `state.rooms[state.currentIndex + 1]` check. Keeps every other existing behavior (GM guard, sound, token reveal, combat start, camera focus, `{autoOpenTracker}` return, rest-room auto-resolve) intact under the new model.

**#93 fix round 1 (found by this task's own review) — two Critical/Important corrections to the reference code below, both crossing into Task 13's territory, ruled on and fixed here in the plan text before re-dispatch:**

1. **The door-open-time lazy fallback was dead code.** A room's incoming doors — BOTH the progress-gate `doorWall` (flagged `dungeonDoorToRoomId`) AND the reveal `revealDoorWall` (flagged `dungeonRevealDoorForSlot`) — are created inside that SAME room's own `buildPopulateAndUnlockGraphNode` call, in the same synchronous pass that also writes its `dungeonRoomBuilt` Tile flag (see Task 10's Step 3b/3e). So any door carrying either flag already implies `isSlotBuilt` is true for that room — a door for an unbuilt room can never exist for the player to click, and the guard `if (!isSlotBuilt(scene, roomId)) { ...build... }` inside the door handler could never fire. If eager pregeneration (Task 12) truly failed to build a room, its parent has only a plain, non-door frontier-placeholder wall on that face — nothing to open, no handler ever runs, and the party is stuck exactly as Review Focus item 1 warns against.

   **Fix:** move the "ensure this child is built" safety net from door-open time to room-OUTCOME-RESOLUTION time — the one place in the whole run where we already know we're about to unlock a specific set of children, before any door needs to exist yet. Concretely: immediately before calling `unlockDoorsFromRoom`, loop over every child id (real + hidden) and call the SAME idempotent `buildPopulateAndUnlockGraphNode(..., { unlock: false })` used by eager pregeneration, wrapped in try/catch. Since that function already internally no-ops the wall/tile creation when `isSlotBuilt` is already true but still separately checks/repairs `isSlotPopulated` for combat rooms, this single call is a true idempotent "ensure fully built and populated" step regardless of whether the room was never built, partially built, or already fully built — it costs nothing extra on the common (fully-built) path. This task applies the fix to the rest-room branch below; **Task 13's plan text is also fixed (see that task)** to apply the identical pattern in `resolveCurrentRoom`, since that is the resolution path for every OTHER room kind.

2. **The trigger door was wrong.** The reference code below resolved `roomId` off `dungeonDoorToRoomId` — the progress-gate `doorWall`, unlocked programmatically by `unlockDoorsFromRoom` (never manually "opened" by a player in the reveal sense). Per `buildEdgeCorridor`'s own docblock (`dungeon-layout.mjs`, Task 6): "*opening* [the `revealDoorWall`] is what reveals the next room and advances the tracker" — a deliberate two-door design (an always-closed-never-locked inner threshold the party opens themselves, reachable only once the outer gate has been unlocked and walked through). Resolving off the wrong door would fire the reveal/combat-start/camera-focus/advance sequence as soon as the outer gate unlocks, before the party has actually walked up and opened the room's real door — the exact "give away that a fight is coming" bug the function's own comment already warns against for combat timing specifically. **Fix:** resolve `roomId` from `wall.getFlag(MODULE_ID, "dungeonRevealDoorForSlot")` instead.

Both fixes are folded into the corrected Step 3 reference code below.

**#93 fix round 2 (found by this fix round's own re-review):** the `roomsBeingOpened` reentrancy-guard comment and `const` must go BEFORE the function's own existing JSDoc comment in the actual file (`scripts/dungeon-scene.mjs`), not between that JSDoc and the `export async function` line — round 1's diff inserted it in the middle, which detaches the JSDoc from the function it documents (IDE hovers/doc tooling would show it on the `const` instead). The Step 3 code block below already shows the correct order (guard comment+const, THEN the function, with its own inline comments — there was never a separate top-level JSDoc for this function to begin with, so this only matters for wherever round 1 physically placed its insertion in the file).

- [ ] **Step 1: Write the manual verification checklist**

(a) opening a 2-exit room's first door advances the party into that door's specific child, not the other exit's child; (b) opening the second door afterward (if the player backtracks — same undo-window semantics as today) resolves to the OTHER child correctly; (c) a room whose eager build failed (simulate by not pre-building it) still gets built on first door-open, and the party is not stuck; (d) a non-GM client opening a door does nothing (the hook fires client-side for everyone, only the GM acts); (e) a combat room's monsters stay hidden until the door is actually opened, then Combat starts; (f) opening a door into a rest room immediately resolves it (no Succeed/Fail prompt) and unlocks its own onward door(s), matching today's behavior; (g) the Dungeon Crawl tracker auto-opens for every non-combat room reveal (combat already surfaces via Foundry's native Combat Tracker).

- [ ] **Step 2: (N/A — no automated test to run first for this task)**

- [ ] **Step 3: Write the implementation**

```js
// Module-private reentrancy guard: `updateWall`'s door-open hook can in
// principle fire more than once for the same wall/room before the first
// call's advanceToRoom/markRoomOutcome round-trip settles (a fast
// close-then-reopen, or the hook double-firing) — without this, a second
// concurrent call would re-run token reveal/combat start/advance for a
// room already being handled. Declared once at module scope, alongside
// this function.
const roomsBeingOpened = new Set();

export async function handleDungeonDoorOpened(sceneId, wallId) {
  // Called directly from a global hook, which fires on every connected
  // client — only the GM's own client should act on it.
  if (!game.user.isGM) return { autoOpenTracker: false };
  const scene = game.scenes.get(sceneId);
  const wall = scene?.walls.get(wallId);
  // #93 fix round 1 (found by this task's own review): the REVEAL door
  // (`dungeonRevealDoorForSlot`) is the real "open it and see what's
  // inside" trigger — the progress-gate door (`dungeonDoorToRoomId`) only
  // ever gets unlocked programmatically by `unlockDoorsFromRoom`; resolving
  // off IT instead would fire the reveal as soon as a room's outcome
  // resolves, before the party has actually opened its real door. See
  // buildEdgeCorridor's docblock (dungeon-layout.mjs, Task 6).
  const roomId = wall?.getFlag(MODULE_ID, "dungeonRevealDoorForSlot");
  if (!roomId) return { autoOpenTracker: false };

  const state = getRunState(sceneId);
  if (!state || !(state.edges[state.currentRoomId] ?? []).includes(roomId))
    return { autoOpenTracker: false };

  if (roomsBeingOpened.has(roomId)) return { autoOpenTracker: false };
  roomsBeingOpened.add(roomId);
  try {
    // #93 fix round 1: no lazy-build fallback here anymore — see this
    // task's own "fix round 1" note above. By the time this room's reveal
    // door exists at all, that room's own build (Tile flag + both doors,
    // all written in the same buildPopulateAndUnlockGraphNode call) has
    // already completed; a door-open-time build-on-demand check here could
    // never fire. The real safety net for a room eager pregeneration
    // failed to build now lives at resolution time — see the rest-room
    // branch below, and Task 13's resolveCurrentRoom for every other kind.
    playDoorSound("open");
    const revealedTokenIds = await revealSlotTokens(scene, roomId);
    const room = state.rooms[roomId];
    // Started here, not at populate/build time — the room's monsters spawn
    // hidden, and starting Combat before the door is actually opened would
    // give away that a fight is coming.
    if (room?.kind === "combat") await startCombatForRoom(scene, roomId);
    const { ok, state: advancedState } = await advanceToRoom({
      sceneId,
      roomId,
      revealedTokenIds,
    });
    const { rank, col } = state.layoutPositionByRoomId[roomId];
    focusCameraOnRoom(scene, roomId, rank, col, state.seed);

    // A rest room (ITEM-5) is safe and has nothing to resolve — like the
    // entry, its own way forward opens immediately, no GM click required,
    // instead of leaving the party stuck with no Succeed/Fail button to
    // press. #93: under full pregeneration every room is ALREADY built
    // (Task 12's eager loop) in the common case — the ensure-built loop
    // below is the Review Focus item 1 safety net for the uncommon case
    // where it wasn't, not the normal path.
    if (room?.kind === "safe_rest" && ok) {
      const { state: resolvedState } = await markRoomOutcome({
        sceneId,
        succeeded: true,
      });
      const childIds = resolvedState.edges[roomId] ?? [];
      const hiddenChildIds = resolvedState.hiddenEdges[roomId] ?? [];
      // #93 fix round 1: ensure every child this room is about to unlock
      // a door to is actually built (and, for combat rooms, populated)
      // BEFORE unlocking — the one place a door is guaranteed not to
      // exist yet for the player to click, so it's the right place for
      // the fallback build, not the door-open handler itself.
      // buildPopulateAndUnlockGraphNode is already idempotent (checks
      // isSlotBuilt/isSlotPopulated internally), so calling it for an
      // already-fully-built child is a cheap no-op, not a duplicate build.
      for (const childId of [...childIds, ...hiddenChildIds]) {
        // #93 fix round 2 (found by this fix round's own re-review): the
        // {rank, col} lookup must sit INSIDE the try too — it's a plain
        // object-property read against `layoutPositionByRoomId`, same
        // risk class as the build call itself, and letting it throw
        // uncaught would abort the whole loop (skipping every remaining
        // child) and the notification, exactly the failure this try/catch
        // exists to contain.
        try {
          const child = resolvedState.rooms[childId];
          const { rank: childRank, col: childCol } = resolvedState.layoutPositionByRoomId[childId];
          await buildPopulateAndUnlockGraphNode(scene, resolvedState, child, {
            rank: childRank,
            col: childCol,
            childIds: resolvedState.edges[childId] ?? [],
            hiddenChildId: resolvedState.hiddenEdges[childId]?.[0] ?? null,
            unlock: false,
          });
        } catch (err) {
          console.error(`${MODULE_ID} | failed to build child room ${childId} before unlock`, err);
          ui.notifications?.error(
            game.i18n.localize("PF2EDC.Dungeon.RoomBuildFailedError"),
          );
        }
      }
      await unlockDoorsFromRoom(scene, roomId, childIds, hiddenChildIds);
    }

    return { autoOpenTracker: room?.kind !== "combat" };
  } finally {
    roomsBeingOpened.delete(roomId);
  }
}
```

Add a `PF2EDC.Dungeon.RoomBuildFailedError` localization key (same `lang/en.json` block the other `PF2EDC.Dungeon.*` strings live in — e.g. right beside `RerunEncounterHint`) with text along the lines of "Dungeon Crawl: failed to prepare the next room — see console for details."

**New helper, alongside `focusCameraOnSlot` (do not replace or delete it — the two other call sites in `scripts/ui/dungeon-app.mjs` are outside this task's file scope and still key off the old physical-slot model; whichever of Tasks 12/13 finishes migrating that file's own rendering context to room ids should repoint them at this new function too):**

```js
/** Graph-aware twin of focusCameraOnSlot — same camera-fit math, keyed by
 * roomRect(seed, roomId, rank, col) instead of slotRect(seed, slot), since
 * a room's position is no longer derivable from an integer alone. */
export function focusCameraOnRoom(scene, roomId, rank, col, seed) {
  if (canvas?.scene?.id !== scene.id) return;
  const rect = roomRect(seed, roomId, rank, col);
  const roomPixelSize = Math.max(toPixels(rect.gw), toPixels(rect.gh));
  const [screenWidth, screenHeight] = canvas.screenDimensions ?? [1000, 1000];
  const fitScale = Math.min(screenWidth, screenHeight) / (roomPixelSize * 1.3);
  const scale = Math.min(1.5, Math.max(0.3, fitScale));
  canvas.animatePan({
    x: toPixels(rect.gx + rect.gw / 2),
    y: toPixels(rect.gy + rect.gh / 2),
    scale,
    duration: 250,
  });
}
```

**Note for the implementer:** both `dungeonDoorToRoomId` (on the progress-gate `doorWall`) and `dungeonRevealDoorForSlot` (on the reveal `revealDoorWall`) are already written by Task 10's `buildPopulateAndUnlockGraphNode` (confirmed present at `scripts/dungeon-scene.mjs:1356` and the neighboring `revealDoorWall` line) — nothing to add here, just read the correct one (`dungeonRevealDoorForSlot`) off the wall that actually fired the hook. `revealSlotTokens`/`startCombatForRoom` (renamed from `startCombatForSlot`, Step 3d) already generalize cleanly: they take an opaque value compared by `===` against a flag, so passing a room id string where it used to get an integer works with no body changes. Do not read `isSlotBuilt` inside this function at all anymore — see this task's "fix round 1" note above for why that check moved to resolution time.

- [ ] **Step 4: Live verification**

Run the Step 1 checklist against a real Foundry world.

- [ ] **Step 5: Commit**

```bash
git add scripts/dungeon-scene.mjs
git commit -m "feat: resolve door-opens against a room's specific graph child, with lazy fallback"
```

---

## Task 12: Wire full pregeneration into `startDungeonRun`, remove ITEM-11 deferral, and migrate `state.rooms` to a real dict everywhere

**#93 pre-flight fix — this task's scope was massively under-drafted.** The original draft only rewrote `startDungeonRun` itself. Direct investigation (prompted by Task 11's review flagging that `state.rooms`/`layoutPositionByRoomId` "don't exist yet" against current code) found this task is the FIRST point in the whole plan where `state.rooms` actually becomes a dict keyed by room id for a real run (`createRun` still produces an array via the old `buildRoomSequence` generator, and nothing before this task ever overwrites that). That single shape change is load-bearing everywhere: **19 exported functions in `scripts/dungeon-runner.mjs`** (every `ensure*State`/`clear*State`/`apply*Customization`/`get*PendingCustomization`/`record*Attempt` reducer — none of them touched by any of Tasks 1-11) call `.find`/`.map` on `state.rooms`, which throws a `TypeError` the instant `state.rooms` is a plain object instead of an array. **Several functions in `scripts/ui/dungeon-app.mjs`** outside `startDungeonRun`/`resolveCurrentRoom` (`_prepareContext` — the tracker panel's own core render method — plus `_onRender`, `chooseNarrativeOption`, `resolveCombatRoomOutcome`, `startCombatRecoveryFor`, `recordSkillChallengeOutcome`, `recordPuzzleStageOutcome`, `#onAttemptSkillChallenge`, `#onAttemptPuzzleStage`) still read `state.rooms[state.currentIndex]`/`state.physicalSlotByRoomId[...]`, the old array/slot model. And `scripts/dungeon-scene.mjs`'s `undoRoomEntry` reads `entry.fromIndex`, a field `advanceToRoom` (Task 8) stopped writing when it introduced `lastAutoEntry.fromRoomId` instead — **already broken today**, independent of this task, confirmed by direct reading (not just theory). Dispatched as originally drafted, every one of these would have broken the instant a real graph-shaped run started — most severely, `_prepareContext` failing silently would have left the ENTIRE Dungeon Crawl tracker panel non-functional (no current room, no Succeed/Fail buttons) for every run created after this task landed, undetected until Task 15's final review or later. Fixed by expanding this task to cover the complete migration in one coherent pass, since it's all one conceptual change: "`state.rooms` is a dict now — every consumer must agree."

**Files:**
- Modify: `scripts/ui/dungeon-app.mjs`, `scripts/dungeon-runner.mjs`, `scripts/dungeon-scene.mjs`, `templates/dungeon-tracker.hbs`, `tests/dungeon-runner.test.mjs`
- Test: `tests/dungeon-runner.test.mjs` (existing fixtures for the 19 migrated reducers — fix any that still construct `state.rooms` as an array, same as Task 7's own precedent for `roomsToEagerlyBuild`'s tests); everything UI-facing is manual/live verification (these files drive Foundry directly).

**Interfaces:**
- Consumes: `buildRoomGraph`, `attachHiddenPaths` (Tasks 2-3), `computeRanks`/`computeColumns` (Task 4), `roomsToEagerlyBuild` (Task 7), `buildPopulateAndUnlockGraphNode`/`resizeSceneForLayout`/`unlockDoorsFromRoom`/`isSlotBuilt`/`isSlotPopulated`/`getCombatForRoom` (Task 10), `focusCameraOnRoom` (Task 11).
- Produces: `startDungeonRun` builds the whole graph for every run (drops the `if (state.hostUserId)` gate) and no longer skips a combat-kind room at generation-order position 1. Persists `state.maxRank` alongside `layoutPositionByRoomId` — Task 9's `depthBiasFor` rename and Task 13's `applyRoomEffect` call both read it. Every reducer in `dungeon-runner.mjs` and every remaining reader in `dungeon-app.mjs`/`dungeon-scene.mjs` now treats `state.rooms` as a dict (`state.rooms[roomId]`, never `.find`/`.map`). New helpers `relockDoorFromRoom`/`moveTokensToRoom`/`placePartyInRoom` (`dungeon-scene.mjs`) — room-id-keyed twins of `relockDoorToSlot`/`moveTokensToSlot`/`placePartyInSlot`, which this task deletes/stops calling respectively.

**#156 fix:** `computeRanks`/`computeColumns` must run over `layoutEdges` (Task 3's output, includes detour rooms), not `edges` — otherwise a detour room's `layoutPositionByRoomId` entry is `{rank: undefined, col: undefined}` and every downstream `roomRect` call for it produces garbage. `state.layoutEdges`/`state.hiddenIncomingByRoomId`/`state.hiddenRooms` are persisted on state precisely so `buildPopulateAndUnlockGraphNode` (Task 10) can resolve each room's own `incomingConnections` internally — this task's eager-build loop itself no longer computes any incoming-face/parent lookup at all.

**Scope ruling — what stays untouched on purpose:** `createRun` (`dungeon-runner.mjs`) still calls the old `getGenerator().buildRoomSequence(...)` and still sets `physicalSlotByRoomId`/`nextPhysicalSlot`/`currentIndex`/array-`rooms`/`edges` on the state it returns — wasteful (an entire discarded generation pass) but harmless, since `startDungeonRun`'s own code below immediately overwrites every field that matters and this task strips the stale legacy ones from the object it persists forward (see Step 3). Simplifying `createRun` itself is explicitly OUT of this task's scope (lower risk to leave a shipped, widely-used function alone) — ledgered as a deferred cleanup for whoever next touches it. Likewise `commitEagerPhysicalSlots`, `relockDoorToSlot`'s slot-based sibling functions `buildRoomAtSlot`/`buildPopulateAndUnlockRoom`/`unlockDoorToSlot` (and `isSlotBuilt`'s/`isSlotPopulated`'s remaining integer-slot callers inside them) are left defined but now fully uncalled from anywhere reachable — flagged for Task 15's final-review dead-code sweep, not deleted here, since none of them are load-bearing for this task's correctness and deleting them means also deleting their own test coverage, out of scope for an already-large task. `relockDoorToSlot`/`moveTokensToSlot` ARE deleted by this task (Step 5 below) — unlike the others, they have zero remaining callers anywhere, not even from another still-defined (if unreachable) function, so nothing is served by keeping them.

- [ ] **Step 1: Write the manual verification checklist**

(a) a GM-present run now pregenerates every room at scene creation, same as a GM-less run; (b) the "Populate Next Room" button and its `populateNextRoom` handler no longer appear/are removed from the app, including the template's own now-dead button markup; (c) a dungeon whose first generated room (after entry) is combat-kind is still fully built and playable immediately, with no manual population step required; (d) the tracker panel renders correctly for a fresh run — current room, Succeed/Fail buttons, room-progress counter — not a blank/broken panel; (e) the room-progress counter (`roomNumber`/`roomTotal`) advances correctly as the party moves through a branching path, still excluding the entry and any rest room from the count; (f) undoing the most recent room entry (the Undo button) correctly re-locks the door, re-hides the revealed room, and steps the party's tokens back to the previous room — for both a normal room and a room reached via a revealed hidden shortcut/detour; (g) a skill-challenge attempt, a puzzle-stage attempt, a trap resolution, a narrative continuation/choice, and a treasure claim all still correctly read and update their room's own persisted state (Victory Points, puzzle stage progress, etc.) after this task's `dungeon-runner.mjs` migration; (h) resolving a combat room's outcome (`resolveCombatRoomOutcome`) and the combat-recovery button (`startCombatRecoveryFor`) both still work against a room id.

- [ ] **Step 2: (N/A — no automated test for the UI-driving files; `tests/dungeon-runner.test.mjs` covers the pure-reducer migration in Step 4)**

- [ ] **Step 3: `startDungeonRun` — write the graph-generation and eager-build implementation**

In `scripts/ui/dungeon-app.mjs`'s `startDungeonRun` (around line 496-639): first change `const state = await createRun(...)` to `let state = await createRun(...)` (the code below reassigns `state`), then replace everything from the `createRun(...)` call's result through the end of the function:

```js
  const { rooms, edges } = getGenerator().buildRoomGraph({
    seed: state.seed,
    roomCount,
    puzzleSetpieceIds,
    trapSetpieceIds,
    narrativeSetpieceIds,
  });
  const { hiddenRooms, hiddenEdges, layoutEdges, hiddenIncomingByRoomId } =
    getGenerator().attachHiddenPaths({ rooms, edges, seed: state.seed });
  // #156: rank/col must come from layoutEdges (includes detour rooms), not
  // edges (visible-only) — computing over edges leaves every detour room's
  // rank/col undefined, since its only incoming connection is hidden.
  const ranks = computeRanks(layoutEdges, 'room-entry');
  const columns = computeColumns(layoutEdges, ranks, 'room-entry');
  const layoutPositionByRoomId = Object.fromEntries(
    Object.keys(rooms).map((id) => [id, { rank: ranks[id], col: columns[id] }]),
  );
  const maxRank = Math.max(...Object.values(ranks));
  const maxCol = Math.max(...Object.values(columns));

  // #93 pre-flight fix: strip the OLD array-model fields createRun still
  // sets (currentIndex/physicalSlotByRoomId/nextPhysicalSlot, from its own
  // now-fully-discarded buildRoomSequence() generation) rather than
  // carrying them forward stale — nothing reads them once this task's own
  // migration below lands, and leaving them in persisted state is
  // needlessly confusing for anyone debugging a run later.
  const { currentIndex: _oldIndex, physicalSlotByRoomId: _oldSlots, nextPhysicalSlot: _oldNext, ...stateWithoutLegacyFields } = state;
  state = {
    ...stateWithoutLegacyFields,
    rooms,
    edges,
    layoutEdges,
    hiddenRooms: [...hiddenRooms],
    hiddenEdges,
    hiddenIncomingByRoomId,
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
  // `unlock: false` except for 'room-entry' itself. #93 merge-door
  // redesign: buildPopulateAndUnlockGraphNode resolves each room's own
  // incoming connections (real parent(s), plus any hidden extra)
  // internally from `state` — this loop only threads its OWN outgoing
  // shape through, same as Task 11's lazy fallback, so both build paths
  // agree on a room's geometry by construction rather than duplicating
  // the same lookup twice. `roomsToEagerlyBuild` walks `layoutEdges`
  // (Task 7) so detour rooms are included.
  const eagerlyBuilt = roomsToEagerlyBuild(state);
  for (const { room, buildOrder } of eagerlyBuilt) {
    const { rank, col } = layoutPositionByRoomId[room.id];
    await buildPopulateAndUnlockGraphNode(scene, state, room, {
      rank,
      col,
      childIds: edges[room.id] ?? [],
      // This room's own hidden outgoing target (shortcut or detour), if
      // any — reserves and seals the extra face (#156).
      hiddenChildId: hiddenEdges[room.id]?.[0] ?? null,
      unlock: room.id === 'room-entry',
    });
  }
  // #93 pre-flight fix: commitEagerPhysicalSlots dropped entirely — it
  // only ever maintained physicalSlotByRoomId/nextPhysicalSlot, both fully
  // retired by this task's own migration (Step 4/6 below read state.rooms
  // directly by id; nothing reads a "physical slot" anymore).

  const partyMembers = (game.actors?.party?.members ?? []).filter(
    (m) => m.type === 'character',
  );
  const { rank: entryRank, col: entryCol } = layoutPositionByRoomId['room-entry'];
  await placePartyInRoom(scene, 'room-entry', entryRank, entryCol, partyMembers, state.seed);
  await scene.activate();
  unpauseIfGmLessRun(scene.id);
  await new Promise((r) => setTimeout(r, 400));
  focusCameraOnRoom(scene, 'room-entry', entryRank, entryCol, state.seed);
```

Delete `populateNextRoom` (dungeon-app.mjs:733) and its call site/UI button wiring (the `#onPopulateNext` handler and template button referencing it), per the confirmed removal of the ITEM-11 deferral.

Remove the now-unused imports `buildRoomAtSlot`, `unlockDoorToSlot`, `placePartyInSlot`, `buildPopulateAndUnlockRoom`, `focusCameraOnSlot`, `commitEagerPhysicalSlots`, `isSlotPopulated`, `isSlotBuilt` from `dungeon-app.mjs`'s import blocks (their only remaining call sites in this file are inside `populateNextRoom`, deleted by this step, and `_prepareContext`'s `nextRoomPending` computation, removed by Step 6 — confirm both are gone before removing these two imports, since Step 6 lands in the same task but a later step) and add `focusCameraOnRoom`, `placePartyInRoom` (both from `dungeon-scene.mjs`) in their place. Also add two NEW top-level imports this step's code needs that aren't in this file yet: `import { getGenerator } from "../generator-registry.mjs";` and `import { computeRanks, computeColumns } from "../dungeon-layout.mjs";` (confirmed neither is currently imported here — `getGenerator` is already used the same way by `dungeon-runner.mjs`/`encounter-generator.mjs`; `computeRanks`/`computeColumns` are `dungeon-layout.mjs:558`/`:595`).

**Note for the implementer:** `roomsToEagerlyBuild` already returns rooms in topological (parents-before-children) order over `layoutEdges` (Task 7), so by the time any room's `buildPopulateAndUnlockGraphNode` call runs, every one of its real parents (`parentRoomIdsFor`, resolved inside that function) already has its own `layoutPositionByRoomId` entry and has already been built by an earlier loop iteration.

- [ ] **Step 4: `scripts/dungeon-runner.mjs` — migrate every `state.rooms.find`/`.map` reducer to dict access**

19 exported functions read or write `state.rooms` as an array. Apply this EXACT mechanical transform to every one — do not skip any, and grep for `state.rooms.find\|state.rooms.map` in this file when done to confirm zero matches remain outside `createRun`/`roomsNeedingResync` (the two deliberately-untouched exceptions, see below).

**Pattern A — read-one-by-id-then-immutably-replace (17 functions):** `ensureSkillChallenge`, `clearSkillChallengeState`, `applySkillChallengeCustomization`, `recordSkillChallengeAttempt`, `ensurePuzzleState`, `clearPuzzleState`, `recordPuzzleStageAttempt`, `applyPuzzleCustomization`, `ensureTrapState`, `clearTrapState`, `applyTrapRoomState`, `ensureNarrativeState`, `clearNarrativeState`, `applyNarrativeCustomization`, `ensureTreasureState`, `clearTreasureState`, `applyTreasureCustomization`. Every one follows this exact shape (shown against `ensureTrapState`, the shortest — apply the identical transform to the other 16, each keeping its own field name(s) and other logic untouched):

```js
// OLD:
const room = state.rooms.find((r) => r.id === roomId);
if (!room || room.trap) return state;
const trap = { name, description };
const rooms = state.rooms.map((r) => (r.id === roomId ? { ...r, trap } : r));
const newState = { ...state, rooms };

// NEW:
const room = state.rooms[roomId];
if (!room || room.trap) return state;
const trap = { name, description };
const rooms = { ...state.rooms, [roomId]: { ...room, trap } };
const newState = { ...state, rooms };
```

That is: `state.rooms.find((r) => r.id === X)` → `state.rooms[X]`; `state.rooms.map((r) => (r.id === X ? {...r, ...changes} : r))` → `{ ...state.rooms, [X]: { ...room, ...changes } }` (reusing the already-looked-up `room` variable rather than re-reading `state.rooms[X]` a second time).

**Pattern B — read-only, predicate-based find, not tied to a known id (4 functions):** `getPendingSkillChallengeCustomization`, `getPendingPuzzleCustomization`, `getPendingNarrativeCustomization`, `getPendingTreasureCustomization`. Each does `state.rooms.find((r) => <predicate not keyed on a specific id>)` — since a plain object has no `.find`, wrap it: `state.rooms.find((r) => ...)` → `Object.values(state.rooms).find((r) => ...)`. No other change needed in these four.

**Deliberately NOT touched by this step:**
- `createRun` (still produces array-shaped `rooms` from `buildRoomSequence` — see this task's own Scope ruling above).
- `roomsNeedingResync` — already scheduled for outright deletion by Task 13 (dead code, do not fix it here only to have Task 13 delete it).
- `markRoomOutcome` (already correctly branches on `Array.isArray(state.rooms)` vs dict — no change needed, already handles both).

**Also in this same file, `advanceToRoom` and `undoLastRoomEntry`:** both still compute a `currentIndex`/`previousIndex` via an `Array.isArray(state.rooms)` backward-compat branch that falls through to `state.currentIndex + 1`/`- 1` (→ `NaN`) once `state.rooms` is always a dict — now fully dead computation, since nothing anywhere reads `state.currentIndex` after Step 6 below lands. Delete both functions' `Array.isArray`/`currentIndex`/`previousIndex` blocks entirely and stop writing `currentIndex` into either function's returned state.

Run the full `tests/dungeon-runner.test.mjs` suite after this step. Every one of the 19 migrated functions has existing test coverage with array-shaped `state.rooms` fixtures — update each failing fixture to the dict shape (`rooms: { roomId: {...} }` instead of `rooms: [{...}]`) rather than changing the functions' own logic further, same precedent Task 7 already established for `roomsToEagerlyBuild`'s own tests.

- [ ] **Step 5: `scripts/dungeon-scene.mjs` — fix `undoRoomEntry` (already broken today) and add room-id-keyed helpers**

`undoRoomEntry` currently reads `entry.fromIndex`, a field that has never existed on `lastAutoEntry` since Task 8 shipped (`advanceToRoom` writes `lastAutoEntry: {roomId, fromRoomId, toRoomId, revealedTokenIds}` — confirmed directly, no `fromIndex`). This means `undoRoomEntry` throws today, independent of this task, for ANY run — pre-existing, not introduced by #93, but this task is the right place to fix it since it also needs the same room-id-keyed door/token helpers this task is already adding.

Add two new helpers (room-id-keyed twins of `relockDoorToSlot`/`moveTokensToSlot`, same reasoning as Task 11's `focusCameraOnRoom`):

```js
/** Undo-only twin of unlockDoorsFromRoom: re-locks the progress-gate door
 * AND re-closes the reveal door between fromRoomId and toRoomId — a full
 * undo of both doors' state, not just the one a GM would think to check,
 * in case a player had already opened the second one too. Matches on both
 * ends of the edge together, same reasoning as unlockDoorsFromRoom's own
 * fix round 1 (a merge target's several doors all share the same
 * dungeonDoorToRoomId; only the fromRoomId/dungeonDoorFromRoomId pair picks
 * out the specific one this undo needs to reverse). */
export async function relockDoorFromRoom(scene, fromRoomId, toRoomId) {
  const wall = scene.walls.find(
    (w) =>
      w.getFlag(MODULE_ID, "dungeonDoorToRoomId") === toRoomId &&
      w.getFlag(MODULE_ID, "dungeonDoorFromRoomId") === fromRoomId,
  );
  if (wall) {
    await wall.update({ ds: CONST.WALL_DOOR_STATES.LOCKED });
    playDoorSound("lock");
  }
  const revealWall = scene.walls.find(
    (w) =>
      w.getFlag(MODULE_ID, "dungeonRevealDoorForSlot") === toRoomId &&
      w.getFlag(MODULE_ID, "dungeonDoorFromRoomId") === fromRoomId,
  );
  if (revealWall) await revealWall.update({ ds: CONST.WALL_DOOR_STATES.CLOSED });
}

/** Move already-placed tokens into roomId — for undo, stepping the party
 * back. Graph-aware twin of moveTokensToSlot, keyed by roomRect(seed,
 * roomId, rank, col) instead of slotRect(seed, slot), since a room's
 * position is no longer derivable from an integer alone. */
export async function moveTokensToRoom(scene, tokenIds, roomId, rank, col, seed) {
  if (!tokenIds?.length) return;
  const rect = roomRect(seed, roomId, rank, col);
  const updates = tokenIds.map((id, i) => ({
    _id: id,
    x: toPixels(rect.gx + (i % rect.gw)),
    y: toPixels(rect.gy + Math.floor(i / rect.gw)),
  }));
  await scene.updateEmbeddedDocuments("Token", updates);
}

/** Start-of-run: place the party's tokens inside roomId, removing any of
 * their tokens elsewhere in the world first. Graph-aware twin of
 * placePartyInSlot, keyed by roomRect instead of slotRect. */
export async function placePartyInRoom(scene, roomId, rank, col, partyMembers, seed) {
  const rect = roomRect(seed, roomId, rank, col);
  const occupied = [];
  const createdIds = [];
  for (const actor of partyMembers) {
    await removeActorTokensFromAllScenes(actor.id);
    const spot = freeSpotInRect({ occupied, rect, gw: 1, gh: 1 }) ?? {
      gx: rect.gx,
      gy: rect.gy,
      gw: 1,
      gh: 1,
    };
    occupied.push(spot);
    const td = await actor.getTokenDocument({
      x: toPixels(spot.gx),
      y: toPixels(spot.gy),
    });
    const [created] = await scene.createEmbeddedDocuments("Token", [
      td.toObject(),
    ]);
    createdIds.push(created.id);
  }
  return createdIds;
}
```

Replace `undoRoomEntry`'s body:

```js
export async function undoRoomEntry(sceneId) {
  const scene = game.scenes.get(sceneId);
  const state = getRunState(sceneId);
  if (!scene || !canUndoRoomEntry(state)) {
    ui.notifications.warn(
      game.i18n.localize("PF2EDC.Dungeon.AlreadyResolvedUndoWarning"),
    );
    return;
  }

  const entry = state.lastAutoEntry;
  await hideTokens(scene, entry.revealedTokenIds);
  await relockDoorFromRoom(scene, entry.fromRoomId, entry.roomId);

  const previousRoomId = entry.fromRoomId;
  const { rank, col } = state.layoutPositionByRoomId[previousRoomId];
  const partyIds = partyActorIds();
  const partyTokenIds = scene.tokens
    .filter((t) => partyIds.has(t.actor?.id))
    .map((t) => t.id);
  await moveTokensToRoom(scene, partyTokenIds, previousRoomId, rank, col, state.seed);

  await undoLastRoomEntry({ sceneId });
}
```

Delete `relockDoorToSlot` and `moveTokensToSlot` entirely — once this step lands they have zero remaining callers anywhere in the codebase (unlike `buildRoomAtSlot`/`buildPopulateAndUnlockRoom`/`unlockDoorToSlot`/`placePartyInSlot`/`focusCameraOnSlot`, which this task's Step 3 also stops calling but which stay defined for now, per this task's Scope ruling — those still reference each other internally; these two do not).

- [ ] **Step 6: `scripts/ui/dungeon-app.mjs` — migrate `_prepareContext`, `_onRender`, and the remaining small action handlers**

**`_prepareContext`** (around dungeon-app.mjs:843-1195), three changes:

1. Extend the stale-legacy-run detection gate (line ~858) to also catch a pre-#93 array-shaped run, same "clear and let the GM start fresh" handling it already uses for an even older shape:
```js
// #93: a run created before this update has state.rooms as an array with
// currentIndex/physicalSlotByRoomId — the old linear-sequence shape this
// app no longer understands. Same "clear and let the GM start fresh"
// handling the pre-existing Tier-1 check already uses for an even older
// shape, extended to also catch this one.
if (state && (!state.physicalSlotByRoomId || Array.isArray(state.rooms)) && game.user.isGM) {
```

2. Replace the current-room/next-room/slot block:
```js
// OLD:
const currentRoom = state.rooms[state.currentIndex] ?? null;
...
const nextRoom = state.rooms[state.currentIndex + 1] ?? null;
const nextSlot = nextRoom ? state.physicalSlotByRoomId[nextRoom.id] : null;
const nextRoomPending = !!(
  nextRoom &&
  nextRoom.kind === "combat" &&
  nextSlot != null &&
  !isSlotPopulated(scene, nextSlot)
);

const currentSlot = currentRoom
  ? state.physicalSlotByRoomId[currentRoom.id]
  : null;
const isCombatRoom = currentRoom?.kind === "combat" && !currentRoomResolved;
const isSafeEntry = currentRoom?.kind === "safe_entry";
const isSafeRest = currentRoom?.kind === "safe_rest";
const activeCombat =
  isCombatRoom && currentSlot != null
    ? getCombatForRoom(scene, currentSlot)
    : null;

// NEW:
const currentRoom = state.rooms[state.currentRoomId] ?? null;
...
// #93: no more "next room" concept in a branching graph (a room can have
// 2-3 children, not one) — and no more "pending" state at all, since full
// pregeneration means every room is already built+populated by the time
// its door can be opened (Task 10/11's #93 redesign). The whole
// ITEM-11/populateNextRoom feature this powered is deleted (Step 3).
const isCombatRoom = currentRoom?.kind === "combat" && !currentRoomResolved;
const isSafeEntry = currentRoom?.kind === "safe_entry";
const isSafeRest = currentRoom?.kind === "safe_rest";
const activeCombat =
  isCombatRoom && currentRoom ? getCombatForRoom(scene, currentRoom.id) : null;
```
(The `currentRoomResolved` line above this block is unchanged — it already reads `currentRoom?.id`, not an index.)

3. Replace the returned context object's `currentSlot`/`nextRoomPending`/`roomNumber`/`roomTotal` fields:
```js
// OLD (remove currentSlot and nextRoomPending entirely):
currentSlot,
...
roomNumber: state.rooms
  .slice(0, state.currentIndex + 1)
  .filter((r) => !UNCOUNTED_ROOM_KINDS.has(r.kind)).length,
roomTotal: state.rooms.filter((r) => !UNCOUNTED_ROOM_KINDS.has(r.kind))
  .length,
...
nextRoomPending,

// NEW:
currentRoomId: currentRoom?.id ?? null,
// Not rendered — just threaded to _onRender's own focusCameraOnRoom call,
// which needs the room's rank/col to know its actual position and size
// (ITEM-17) — a room's geometry is no longer derivable from an integer
// alone (#93).
currentRoomRank: currentRoom ? state.layoutPositionByRoomId[currentRoom.id]?.rank : null,
currentRoomCol: currentRoom ? state.layoutPositionByRoomId[currentRoom.id]?.col : null,
...
// #93: neither the entry nor a mid-dungeon rest room (ITEM-5) counts
// toward the room total — same exclusion as before, now counted via the
// party's actual traversal path (state.history plus the current room, if
// not yet resolved) instead of a linear array index, since a branching
// graph has no single "position N of the sequence" the way a linear
// dungeon did.
roomNumber: (currentRoomResolved
  ? state.history.map((h) => h.roomId)
  : [...state.history.map((h) => h.roomId), ...(currentRoom ? [currentRoom.id] : [])]
).filter((id) => !UNCOUNTED_ROOM_KINDS.has(state.rooms[id]?.kind)).length,
roomTotal: Object.values(state.rooms).filter(
  (r) => !UNCOUNTED_ROOM_KINDS.has(r.kind),
).length,
```
(Drop the `nextRoomPending` key from the return object entirely — nothing computes it anymore.)

**`_onRender`** — replace the camera-focus call:
```js
// OLD:
if (context.currentSlot != null && canvas?.scene?.id === context.sceneId) {
  focusCameraOnSlot(canvas.scene, context.currentSlot, context.seed);
}
// NEW:
if (context.currentRoomId != null && canvas?.scene?.id === context.sceneId) {
  focusCameraOnRoom(canvas.scene, context.currentRoomId, context.currentRoomRank, context.currentRoomCol, context.seed);
}
```

**Small action handlers**, each the same one-line fix (`state.rooms[state.currentIndex]` → `state.rooms[state.currentRoomId]`, and drop the `physicalSlotByRoomId` indirection in favor of the room id itself, which is what `dungeonSlot`-flag-based lookups already compare against directly per Task 10's established convention):

- `chooseNarrativeOption` (dungeon-app.mjs:730-737): `state?.rooms[state.currentIndex]?.narrative?.options[...]` → `state?.rooms[state.currentRoomId]?.narrative?.options[...]`.
- `resolveCombatRoomOutcome` (dungeon-app.mjs:739-752): replace `const currentRoom = state?.rooms[state.currentIndex]; const slot = currentRoom ? state.physicalSlotByRoomId[currentRoom.id] : null; if (slot == null) return; await resolveSlotCombat(scene, slot, ...)` with `const currentRoom = state?.rooms[state.currentRoomId]; if (!currentRoom) return; await resolveSlotCombat(scene, currentRoom.id, ...)` — `resolveSlotCombat`'s own `slot` param is unchanged in name (same `dungeonSlot`-flag-name-unchanged convention as Task 10) but now receives a room-id string, which its existing `===`-based flag comparison already handles correctly.
- `startCombatRecoveryFor` (dungeon-app.mjs:754-761): same transform — `const currentRoom = state?.rooms[state.currentRoomId]; if (!currentRoom) return; await startCombatForRoom(scene, currentRoom.id);`.
- `recordSkillChallengeOutcome` (dungeon-app.mjs:641-652): `newState?.rooms.find((r) => r.id === roomId)?.challenge` → `newState?.rooms[roomId]?.challenge`.
- `recordPuzzleStageOutcome` (dungeon-app.mjs:654-675): `newState?.rooms.find((r) => r.id === roomId)?.puzzle` → `newState?.rooms[roomId]?.puzzle`.
- `#onAttemptSkillChallenge` (dungeon-app.mjs:1299-1310ish): `state?.rooms[state.currentIndex]` → `state?.rooms[state.currentRoomId]`.
- `#onAttemptPuzzleStage` (dungeon-app.mjs:1350-1358): same.

`claimTreasureFor` is deliberately NOT touched here — it also calls `grantTreasureReward`, whose own `{physicalSlot, roomCount}` → `{rank, maxRank}` signature migration is Task 13's job (alongside `resolveCurrentRoom`'s identical call); fixing `claimTreasureFor` in lockstep with that signature change belongs in Task 13, not here — see that task's own updated scope.

- [ ] **Step 7: `templates/dungeon-tracker.hbs` — delete the dead ITEM-11 button markup**

Delete the `{{#if nextRoomPending}}...{{/if}}` block (lines 283-290, the `DoorLockedHint`/`PopulateNextButton` block) entirely — `nextRoomPending` no longer exists in the render context (Step 6), so this block can now never render; deleting it removes the dead markup and its reference to the now-deleted `populateNext` action rather than leaving it silently inert. The `{{#unless nextRoomPending}}` wrapper around the safe-room hint text (lines 58-64) can be simplified by removing the now-always-true `{{#unless}}`/`{{/unless}}` wrapper (keeping its inner `{{#if isSafeEntry}}...{{else}}...{{/if}}` content) — optional cleanup, not required for correctness, since an absent `nextRoomPending` already makes `{{#unless}}` a no-op that always renders its body, which is the desired behavior now.

- [ ] **Step 8: Live verification**

Run the Step 1 checklist against a real Foundry world, both as a GM-present and a GM-less (agent-hosted) run — pay particular attention to (d)/(f)/(g)/(h), the checklist items this task's expanded scope specifically exists to keep working.

- [ ] **Step 9: Commit**

```bash
git add scripts/ui/dungeon-app.mjs scripts/dungeon-runner.mjs scripts/dungeon-scene.mjs templates/dungeon-tracker.hbs tests/dungeon-runner.test.mjs
git commit -m "feat: pregenerate the full branching graph for every run, migrate state.rooms to a dict everywhere"
```

---

## Task 13: Simplify `resolveCurrentRoom` (drop mutation/resync logic)

**Files:**
- Modify: `scripts/ui/dungeon-app.mjs`, `scripts/dungeon-runner.mjs` (delete dead `roomsNeedingResync`)
- Test: `tests/dungeon-runner.test.mjs` (delete `roomsNeedingResync`'s own describe block); the rest is manual/live verification (this file drives Foundry UI directly, same existing boundary as the rest of `resolveCurrentRoom`).

**Interfaces:**
- Consumes: `markRoomOutcome` → `{state, effectKey}` (Task 9, already drops mutation logic internally), `unlockDoorsFromRoom` (Task 10), `buildPopulateAndUnlockGraphNode` (Task 10 — see the Task 11 fix-round-1 ensure-built pattern this task mirrors, below), `depthBiasFor`/`lootGpForTreasureRoom`/`treasureRoomItemTableName` rank/maxRank rename (Task 9's Step 3a), `state.maxRank` (Task 12).
- Produces: `resolveCurrentRoom` (existing name) no longer branches on `mutation && state.hostUserId`, calls no resync/reconciliation step, and does not build anything on the eager-pregeneration-succeeded path — it only unlocks the just-resolved room's own outgoing doors via `unlockDoorsFromRoom` (dead code per #62's now-superseded reconciliation mechanism, superseded again by full pregeneration). It DOES ensure each child is built first (see Step 3's ensure-built loop) — the same Review Focus item 1 safety net Task 11's door handler uses for rest rooms, applied here for every other room kind's outcome resolution. `roomsNeedingResync` (`dungeon-runner.mjs`) is deleted outright — nothing calls it once this task lands.

**#93 pre-flight fix (found during Task 11's own review, before this task was dispatched):** Task 11's review found the door-open-time lazy-build fallback for an eager-pregeneration failure was dead code — a room's doors can only exist once that room is already built, so "build it when the player clicks its door" can never trigger for a room that failed to build. The fix moved that safety net to resolution time instead. This task is the OTHER resolution path (every room kind besides the rest-room special case Task 11 already covers) and needs the identical "ensure each child is built before unlocking its door" step, folded into the Step 3 code below.

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
  const { state, effectKey, revealedRoomId } = await markRoomOutcome(
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
    // #93 pre-flight fix (found during Task 9's review): Task 9's own
    // `applyRoomEffect` addendum (its `reduced_travel_time`/
    // `extra_travel_time` case, dungeon-app.mjs) reads `scene` and
    // `revealedRoomId` off THIS call's params to call
    // `unsealHiddenDoorFromRoom` — an earlier draft of this task dropped
    // both here, which would have silently disconnected Task 9's unseal
    // step (a hidden door revealed by outcome would never actually
    // unlock in the scene, even though the data merge succeeded).
    await applyRoomEffect(effectKey, {
      scene,
      seed: preState.seed,
      roomId: currentRoom.id,
      rank: preState.layoutPositionByRoomId[currentRoom.id].rank,
      maxRank: preState.maxRank,
      isGoal: currentRoom.isGoal,
      revealedRoomId,
    });
  }
  // #93 pre-flight fix (found during Task 9's review): the CURRENT code
  // shows a GM hint (`RerunEncounterHint`) whenever the old `mutation`
  // field was `'rerun_encounter'` — the aid_or_ambush ruin outcome's own
  // signal to reroll the room's encounter. `mutation` is gone, but the
  // SAME outcome still comes through as `effectKey === 'encounter'`
  // (`dungeon-deck.mjs`'s only outcome template using that key — grep
  // confirms it's unambiguous), so re-key the hint off that instead of
  // silently dropping it. Left unaddressed, this specific ruin's "go
  // reroll the fight" GM nudge would quietly stop firing forever.
  if (effectKey === "encounter")
    ui.notifications.warn(
      game.i18n.localize("PF2EDC.Dungeon.RerunEncounterHint"),
    );
  // #93: full pregeneration means every room the party can reach is
  // already built (Task 12's eager-build loop) in the common case, and
  // any hidden path this outcome revealed was already merged into
  // `state.edges` inside markRoomOutcome (Task 9's revealTravelTimeEffect)
  // — resolving a room never rebuilds or reconciles physical slots. All
  // that's normally left is unlocking the resolved room's own outgoing
  // doors so the party can walk through them; the goal room has none.
  //
  // #93 pre-flight fix (found during Task 11's own review): the
  // ensure-built loop below is the Review Focus item 1 safety net for
  // the uncommon case where eager pregeneration failed for one of these
  // children — NOT the normal path. A child room's own doors (both the
  // progress-gate and reveal doors) only ever get created as part of
  // THAT room's own build, in the same call that marks it built — so a
  // door-open-time fallback (the original design) could never fire for a
  // room that truly failed to build; this is the one place we already
  // know which children are about to be unlockable, before any door
  // needs to exist for the player to click. buildPopulateAndUnlockGraphNode
  // is already idempotent (checks isSlotBuilt/isSlotPopulated internally),
  // so calling it for an already-fully-built child costs nothing beyond
  // that internal check — this is not a second build pass on the common
  // path, same reasoning as Task 11's identical rest-room-branch loop.
  if (currentRoom && !currentRoom.isGoal) {
    const childIds = state.edges[currentRoom.id] ?? [];
    const hiddenChildIds = state.hiddenEdges[currentRoom.id] ?? [];
    for (const childId of [...childIds, ...hiddenChildIds]) {
      const child = state.rooms[childId];
      const { rank: childRank, col: childCol } = state.layoutPositionByRoomId[childId];
      try {
        await buildPopulateAndUnlockGraphNode(scene, state, child, {
          rank: childRank,
          col: childCol,
          childIds: state.edges[childId] ?? [],
          hiddenChildId: state.hiddenEdges[childId]?.[0] ?? null,
          unlock: false,
        });
      } catch (err) {
        console.error(`${MODULE_ID} | failed to build child room ${childId} before unlock`, err);
        ui.notifications?.error(
          game.i18n.localize("PF2EDC.Dungeon.RoomBuildFailedError"),
        );
      }
    }
    await unlockDoorsFromRoom(scene, currentRoom.id, childIds, hiddenChildIds);
  }
  if (state?.completed) await sweepCompletedDungeonScene(scene);
}
```

Uses the same `PF2EDC.Dungeon.RoomBuildFailedError` localization key Task 11 adds — do not add it a second time; if Task 11 has already landed when this task is dispatched, the key already exists in `lang/en.json`.

Update `applyRoomEffect`'s own destructure (`dungeon-app.mjs:412-414`) from `{ seed, roomId, physicalSlot, roomCount, isGoal }` to `{ scene, seed, roomId, rank, maxRank, isGoal, revealedRoomId }` (adding `scene`/`revealedRoomId` — required by Task 9's already-landed `reduced_travel_time`/`extra_travel_time` case in this same function, which reads both), and its `treasure` case's call into `grantTreasureReward` (`dungeon-app.mjs:421-431`) from `{ physicalSlot, roomCount }` to `{ rank, maxRank }`. Update `grantTreasureReward`'s own destructure (`dungeon-app.mjs:370-372`) the same way, and its two calls into `lootGpForTreasureRoom`/`treasureRoomItemTableName` (`dungeon-app.mjs:374-379`, `392-398`) to pass `{ rank, maxRank, ... }` instead of `{ physicalSlot, roomCount, ... }` — both functions' own signatures already take `rank`/`maxRank` as of Task 9's Step 3a, so this is purely threading the renamed fields through, not a new rename.

**#93 pre-flight fix (found during Task 12's own pre-dispatch investigation):** `claimTreasureFor` (`dungeon-app.mjs`, a treasure room's own Claim button handler) is `grantTreasureReward`'s OTHER caller, and Task 12 deliberately left it untouched since it's tightly coupled to this exact signature change, not to Task 12's own `state.rooms`-is-a-dict theme. Fix it here, in lockstep with `grantTreasureReward`'s new `{rank, maxRank}` shape:

```js
// OLD:
export async function claimTreasureFor(sceneId) {
  const scene = game.scenes.get(sceneId);
  const state = scene ? getRunState(sceneId) : null;
  const currentRoom = state?.rooms[state.currentIndex];
  const physicalSlot = currentRoom
    ? state.physicalSlotByRoomId[currentRoom.id]
    : null;
  if (physicalSlot == null) return;
  if (game.actors.party) {
    const api = makeFoundryApi();
    const partyLevel = await api.partyLevel();
    const roomCount = state.rooms.length;
    const isGoal = currentRoom.isGoal;
    await grantTreasureReward(api, {
      partyLevel,
      physicalSlot,
      roomCount,
      isGoal,
    });
  }
  await resolveCurrentRoom(true, { scene });
}

// NEW:
export async function claimTreasureFor(sceneId) {
  const scene = game.scenes.get(sceneId);
  const state = scene ? getRunState(sceneId) : null;
  const currentRoom = state?.rooms[state.currentRoomId];
  if (!currentRoom) return;
  if (game.actors.party) {
    const api = makeFoundryApi();
    const partyLevel = await api.partyLevel();
    const { rank } = state.layoutPositionByRoomId[currentRoom.id];
    const isGoal = currentRoom.isGoal;
    await grantTreasureReward(api, {
      partyLevel,
      rank,
      maxRank: state.maxRank,
      isGoal,
    });
  }
  await resolveCurrentRoom(true, { scene });
}
```

Delete `roomsNeedingResync` entirely from `scripts/dungeon-runner.mjs` (its export, `dungeon-runner.mjs:390` onward through the end of its function body) and remove it from the `roomsNeedingResync` import in `scripts/ui/dungeon-app.mjs:13` (the whole import line, since nothing else in that block depended on it — verify no other name shares the line before deleting the line itself rather than just the one specifier). Delete its `describe("roomsNeedingResync", ...)` block from `tests/dungeon-runner.test.mjs:2095-2166` and remove `roomsNeedingResync` from that file's own import list (`tests/dungeon-runner.test.mjs:10`).

**Note for the implementer:** `openGoalRoomExit`, `clearSlotEncounter`, `clearSlotTrap`, `clearPuzzleState`, `clearSkillChallengeState`, `clearNarrativeState`, `clearTrapState`, `clearTreasureState` were only ever called from the deleted mutation-resync block within this function — leave their own definitions/exports alone (unused-but-kept, same as the other now-dead old-model functions Task 12 flagged for Task 15's cleanup sweep), just confirm `resolveCurrentRoom` itself no longer references any of them. `commitEagerPhysicalSlots` is ALSO now fully unused (Task 12 stopped calling it) — do not reference it here either. If any import in this file becomes unused after this deletion, remove that import too (this now includes `commitEagerPhysicalSlots`, if Task 12 hasn't already removed it from this file's imports by the time this task is dispatched). Add `buildPopulateAndUnlockGraphNode` to the existing `dungeon-scene.mjs` import block at `scripts/ui/dungeon-app.mjs:39-56` — `buildPopulateAndUnlockRoom` does NOT stay this time (Task 12 already removes it and every other old-physical-slot-path import from this file; confirm before adding anything that you're not re-adding an import Task 12 just deleted).

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
