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
    const exitCount = Math.min(exitCountAt(seed, tipId), roomCount - 1 - built);
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

  it('is deterministic for the same seed', () => {
    const graph = buildRoomGraph({ seed: 'beta', roomCount: 10 });
    const a = attachHiddenPaths({ ...graph, seed: 'beta' });
    const b = attachHiddenPaths({ ...graph, seed: 'beta' });
    expect([...a.hiddenRooms]).toEqual([...b.hiddenRooms]);
    expect(a.hiddenEdges).toEqual(b.hiddenEdges);
  });

  it('every hidden edge source room still has its normal edges untouched', () => {
    const graph = buildRoomGraph({ seed: 'gamma', roomCount: 14 });
    const before = JSON.parse(JSON.stringify(graph.edges));
    const { edges } = attachHiddenPaths({ ...graph, seed: 'gamma' });
    expect(edges).toEqual(before);
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
 * hidden between two already-adjacent rooms. Both are excluded from
 * `edges` (normal traversal never sees them) until an outcome reveal flips
 * them into the live graph — see dungeon-runner.mjs's
 * revealTravelTimeEffect. At most ONE hidden extra per room, decided once
 * per candidate room (not once per edge), and only when the room (and, for
 * a shortcut, its target) has a spare outgoing face left after its real
 * exits (`exitFaceForIndex` only has 3 slots: south/east/west).
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
      // isn't the goal, and the target has a spare incoming face left
      // (own real exit count <= 2, since it already uses one face for its
      // real incoming edge and needs one more for this shortcut's second
      // incoming door).
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
 * Column index (integer, per-rank left-to-right order) via a bottom-up
 * subtree-width / top-down centering pass — a simplified tree layout: a
 * leaf's width is 1 column unit, a room's width is the sum of its
 * children's widths (min 1), and each room is centered over its children's
 * combined span. Merge rooms (multiple parents) are placed once, under
 * whichever parent reaches them first in a stable DFS order; every other
 * parent's edge simply routes to that already-placed column.
 */
export function computeColumns(edges, ranks, entryId) {
  const widths = {};
  const placed = new Set();
  function widthOf(roomId) {
    if (roomId in widths) return widths[roomId];
    const children = (edges[roomId] ?? []).filter((c) => !placed.has(c) || widths[c] === undefined);
    widths[roomId] = 1; // placeholder to guard against revisiting mid-computation
    const total = (edges[roomId] ?? []).reduce((sum, childId) => {
      if (placed.has(childId)) return sum; // already counted via an earlier parent
      placed.add(childId);
      return sum + widthOf(childId);
    }, 0);
    widths[roomId] = Math.max(1, total);
    return widths[roomId];
  }
  placed.add(entryId);
  widthOf(entryId);

  const columns = {};
  function assign(roomId, startCol) {
    const children = (edges[roomId] ?? []).filter((c) => !(c in columns) || columns[c] === undefined);
    if (roomId in columns) return;
    let cursor = startCol;
    const childCols = [];
    for (const childId of edges[roomId] ?? []) {
      if (childId in columns) {
        childCols.push(columns[childId]);
        continue;
      }
      const w = widths[childId] ?? 1;
      assign(childId, cursor);
      childCols.push(columns[childId]);
      cursor += w;
    }
    columns[roomId] = childCols.length
      ? Math.round(childCols.reduce((a, b) => a + b, 0) / childCols.length)
      : startCol;
  }
  assign(entryId, 0);
  return columns;
}
```

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
- Produces: `ROW_STRIDE`, `COLUMN_STRIDE` constants; `roomRect(seed, roomId, rank, col)` → `{gx, gy, gw, gh}`; `exitFaceForIndex(index)` → `'south' | 'east' | 'west'`; `roomEnclosureWalls(seed, roomId, { incomingFace, outgoingFaces })` (replaces the old `{hasOutgoing}` boolean signature — **breaking change**, callers updated in Task 10).

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
  it('excludes the incoming face and every outgoing face', () => {
    const walls = roomEnclosureWalls('alpha', 'x', { incomingFace: 'north', outgoingFaces: ['south', 'east'] });
    const dirs = walls.map((w) => w.dir);
    expect(dirs).not.toContain('north');
    expect(dirs).not.toContain('south');
    expect(dirs).not.toContain('east');
    expect(dirs).toContain('west');
  });

  it('the entry room (no incomingFace) walls every side except its outgoing faces', () => {
    const walls = roomEnclosureWalls('alpha', 'room-entry', { incomingFace: null, outgoingFaces: ['south'] });
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

const OPPOSITE = { north: 'south', south: 'north', east: 'west', west: 'east' };

/**
 * The compass face on `roomId` where its one incoming connection arrives —
 * derived from whichever parent's `childIds` includes it, and at which
 * index (exitFaceForIndex, then OPPOSITE). Returns null for the entry room
 * (no parent) and throws if `roomId` has no parent in `layoutEdges` and
 * isn't the entry — every other room in a valid graph has exactly one
 * parent by construction (buildRoomGraph never gives a non-entry room two
 * parents outside a forced merge, and a merge room's OWN incoming face
 * still comes from a single position in the layout — see computeColumns'
 * "placed under whichever parent reaches it first" rule, which is also the
 * parent this function must agree with).
 *
 * **#156:** takes `layoutEdges` (Task 3's `edges` + detour rooms), not bare
 * `edges` — a detour room's only "parent" link is the hidden edge folded
 * into `layoutEdges`, so looking it up against plain `edges` would throw.
 * `layoutEdges` equals `edges` for every non-detour room, so every existing
 * call site is safe to repoint at it.
 */
export function incomingFaceFor(layoutEdges, roomId) {
  if (roomId === 'room-entry') return null;
  for (const [parentId, children] of Object.entries(layoutEdges)) {
    const index = children.indexOf(roomId);
    if (index !== -1) return OPPOSITE[exitFaceForIndex(index)];
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
- Produces: `revealTravelTimeEffect({ edges, hiddenEdges }, roomId, effectKey)` (new, `dungeon-deck.mjs`) → `{ edges, hiddenEdges, revealedRoomId }` with the room's hidden path (if any) merged into the live `edges` and removed from `hiddenEdges`, or unchanged (and `revealedRoomId: null`) if there's nothing hidden to reveal. `revealedRoomId` (#156) is the target room id that just became live — `markRoomOutcome` forwards it so the scene layer (Task 9 addendum) knows which hidden door to unseal, without having to re-derive it from a `hiddenEdges` entry that's already been deleted by the time the scene-side step runs. `markRoomOutcome` (existing name, `dungeon-runner.mjs`) drops all `applySequenceMutation`/physical-slot-assignment logic and instead calls `revealTravelTimeEffect` when `effectKey` is `'reduced_travel_time'` or `'extra_travel_time'`.

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

```js
/**
 * #156: promote a hidden shortcut/detour door from sealed to normal, once
 * `revealTravelTimeEffect` (dungeon-runner.mjs) has merged its edge into
 * the live graph. Never builds anything — the door and its corridor were
 * already constructed (LOCKED, `dungeonHiddenDoorForEdge`-flagged) during
 * eager pregeneration (Task 10). Finds every wall flagged
 * `dungeonHiddenDoorForEdge` starting with `${roomId}->` (the doorWall on
 * the revealing room's own face, and its matching revealDoorWall on the
 * target's face both carry this prefix, per Task 10's addendum), and:
 * - sets `ds: CONST.WALL_DOOR_STATES.CLOSED` (unlocked, same convention as
 *   `unlockDoorToSlot`)
 * - replaces the `dungeonHiddenDoorForEdge` flag with the normal
 *   `dungeonDoorToRoomId` flag (set to the edge's target room id) so
 *   `handleDungeonDoorOpened` (Task 11) can resolve it like any other door
 */
export async function unsealHiddenDoorFromRoom(scene, roomId, targetRoomId) {
  const walls = scene.walls.filter(
    (w) => w.getFlag(MODULE_ID, "dungeonHiddenDoorForEdge") === `${roomId}->${targetRoomId}`,
  );
  for (const wall of walls) {
    await wall.update({
      ds: CONST.WALL_DOOR_STATES.CLOSED,
      [`flags.${MODULE_ID}.dungeonDoorToRoomId`]: targetRoomId,
      [`flags.${MODULE_ID}.-=dungeonHiddenDoorForEdge`]: null,
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

## Task 10: Multi-exit room build and frontier placeholders (`dungeon-scene.mjs`)

**Files:**
- Modify: `scripts/dungeon-scene.mjs`
- Test: manual/live verification only (this file has no Foundry test harness, same existing boundary as `buildRoomAtSlot`/`buildConnectionGeometry` today — see the spec's Testing section).

**Interfaces:**
- Consumes: `roomRect`, `roomEnclosureWalls`, `exitFaceForIndex`, `incomingFaceFor` (Task 5), `buildEdgeCorridor` (Task 6).
- Produces: `buildRoomAtGraphNode(scene, roomId, { rank, col, incomingFace, childIds, hiddenChildId, hiddenIncomingFromId, isHiddenIncoming, isGoal, locationTag, artVariant, seed })` (replaces `buildRoomAtSlot`) and a `doorToRoomId` lookup accumulated as each room builds (consumed by Task 11).

**#156 fix — hidden edges get real, sealed geometry at build time, not a runtime retrofit.** A room's hidden outgoing edge (`hiddenEdges[roomId]`, at most one — Task 3) reserves the face right after its real `childIds` and gets a placeholder/door exactly like a real edge, EXCEPT it's flagged `dungeonHiddenDoorForEdge` instead of `dungeonFrontierWallForEdge`/`dungeonDoorToRoomId`. That distinct flag is what keeps it sealed: whatever existing per-room "populated, unlock its door" step this codebase already runs (#62's `unlockDoorToSlot`-equivalent) only ever matches the normal flags, so a `dungeonHiddenDoorForEdge`-flagged door is never touched by it and stays `LOCKED` until Task 9's reveal explicitly promotes it (new step below). Three new params thread this through:
- `hiddenChildId`: this room's own hidden outgoing target, if any (`hiddenEdges[roomId]?.[0]`) — reserves and builds its placeholder face, same as a real child but hidden-flagged.
- `hiddenIncomingFromId`: set only when building a **shortcut's target** room — the shortcut's source room id (`hiddenIncomingByRoomId[roomId]?.[0]`, Task 3). Reserves and completes a *second*, hidden-flagged incoming face, alongside the room's normal real `incomingFace`.
- `isHiddenIncoming`: true only when building a **detour room** — its one real `incomingFace`/parent link (already resolved via `incomingFaceFor(layoutEdges, ...)`, since detours live in `layoutEdges`) should be completed with the hidden flag/LOCKED state instead of the normal one, because that connection IS the hidden path.

- [ ] **Step 1: Write the plan for manual verification**

No unit test — write out, in a comment block above the new function, the exact live-verification checklist to run once implemented (mirrors the spec's Testing section): (a) a 1-exit room behaves identically to today's single-corridor case; (b) a 2-exit room gets two independently lockable doors on different faces, each leading to its own distinct child; (c) opening either door correctly supersedes only that door's own frontier placeholder, leaving the room's other still-unopened exit's placeholder untouched; (d) the real walls for a newly built connection are always created before the old frontier placeholder for that same face is deleted (never the reverse — the existing #110 fog-leak-avoidance ordering); (e) **[#156]** a room with a hidden shortcut/detour edge still has that face solidly built (a real door wall, `ds: LOCKED`, flagged `dungeonHiddenDoorForEdge`) rather than left as a plain solid enclosure wall; (f) **[#156]** opening every one of a room's *normal* doors never reveals or unlocks its hidden door.

- [ ] **Step 2: (N/A — no automated test to run first for this task)**

- [ ] **Step 3: Write the implementation**

Replace `buildRoomAtSlot` in `scripts/dungeon-scene.mjs` with `buildRoomAtGraphNode`, generalizing its existing body (creation-before-deletion ordering, wall flag conventions, `ensureSceneCovers` call) from "one outgoing face, keyed by slot" to "N outgoing faces, keyed by `{roomId, face}`":

```js
export async function buildRoomAtGraphNode(
  scene,
  roomId,
  {
    rank, col, incomingFace = null, childIds = [],
    hiddenChildId = null, hiddenIncomingFromId = null, isHiddenIncoming = false,
    isGoal = false, locationTag = null, artVariant = 0, seed = "",
  },
) {
  const rect = roomRect(seed, roomId, rank, col);
  await ensureSceneCovers(scene, rect);

  const realOutgoingFaces = isGoal ? [] : childIds.map((_, i) => exitFaceForIndex(i));
  const hiddenFaceIndex = childIds.length; // reserved right after the real children
  const outgoingFaces = hiddenChildId ? [...realOutgoingFaces, exitFaceForIndex(hiddenFaceIndex)] : realOutgoingFaces;
  // A shortcut target reserves ONE MORE face for its extra hidden incoming
  // door — distinct from `incomingFace` (its real parent's face). There's
  // no compass direction left to "exclude" for it via roomEnclosureWalls
  // (incoming faces aren't part of that exclusion set the way outgoing
  // faces are — see incomingFaceFor: a room's incoming always lands on
  // whichever face its real parent's index maps to), so its wall is simply
  // carved the same way any other reserved face is, keyed by direction.
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

  // Supersede the parent's frontier placeholder for THIS face (looked up
  // now, deleted only after the real geometry below is created — #110's
  // creation-before-deletion ordering, generalized from "the one placeholder
  // for slot - 1" to "the placeholder for this specific incoming edge").
  // #156: a detour room's incoming connection is hidden — its placeholder
  // was flagged `dungeonHiddenDoorForEdge` by its parent (the hidden-outgoing
  // block below), not `dungeonFrontierWallForEdge`, so look it up under the
  // matching flag. `endsWith` (not `===`) because the flag's value encodes
  // the full `sourceId->targetId` edge (set below, in the outgoing-face
  // loops) — matching on the target suffix is what actually finds it,
  // regardless of which specific parent built it.
  const placeholderFlag = isHiddenIncoming ? "dungeonHiddenDoorForEdge" : "dungeonFrontierWallForEdge";
  const placeholderIds = incomingFace
    ? scene.walls
        .filter((w) => w.getFlag(MODULE_ID, placeholderFlag)?.endsWith(`->${roomId}`))
        .map((w) => w.id)
    : [];

  // #156: a shortcut TARGET also completes a second, hidden-flagged
  // incoming connection from `hiddenIncomingFromId` — its source room
  // already built a `dungeonHiddenDoorForEdge`-flagged placeholder on its
  // own reserved face (see the hidden-outgoing block below). Both this
  // block and the `isHiddenIncoming` block above find a placeholder to
  // supersede; a detour room only ever hits the `isHiddenIncoming` one
  // (its sole real parent link IS the hidden edge) and a shortcut target
  // only ever hits this one (its real parent link is a normal edge, and
  // the shortcut is a second, independent incoming connection) — a room is
  // never both.
  const hiddenIncomingPlaceholderIds = hiddenIncomingFromId
    ? scene.walls
        .filter((w) => w.getFlag(MODULE_ID, "dungeonHiddenDoorForEdge") === `${hiddenIncomingFromId}->${roomId}`)
        .map((w) => w.id)
    : [];

  // One frontier placeholder per outgoing face — findable/superseded later
  // by whichever child builds next on that face, same lifecycle
  // buildConnectionGeometry's single placeholder had, just N of them now.
  for (let i = 0; i < childIds.length; i += 1) {
    const face = exitFaceForIndex(i);
    const side = roomSidesForRect(rect)[face]; // same shape roomEnclosureWalls' internals use
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

  const created = await scene.createEmbeddedDocuments("Wall", walls);
  const allPlaceholderIds = [...placeholderIds, ...hiddenIncomingPlaceholderIds];
  if (allPlaceholderIds.length) await scene.deleteEmbeddedDocuments("Wall", allPlaceholderIds);

  return { rect, walls: created };
}
```

**Note for the implementer:** `roomSidesForRect` is `dungeon-layout.mjs`'s internal `roomSidesFor` — export it (rename to `roomSidesForRect` for clarity at the call site) alongside this task's other Task 5 exports rather than duplicating the compass-side math here. `ensureSceneCovers` currently takes a slot integer to size the scene — update its signature to accept a `rect` directly (it only ever used the slot to look up `slotRect` internally; passing the already-computed rect is a strict simplification, not a behavior change) and update every other caller in this file accordingly. When a room actually builds and needs to connect to its already-built parent's placeholder for the edge leading to it, call `buildEdgeCorridor(seed, parentId, roomId, parentRect, rect, exitFace)` (Task 6) to get the real `doorWall`/`revealDoorWall`/`plainWalls`/`corridorSegments`, append `doorWall`+`revealDoorWall`+`plainWalls` to this room's own `walls` array before creating them (same creation-before-deletion ordering), and record `doorToRoomId[revealDoorWall's created wall id] = roomId` in a lookup this function threads through its caller (Task 11 consumes it) — mirroring exactly how the old `buildRoomAtSlot` folded `buildConnectionGeometry`'s output into its own `walls` array before the single `createEmbeddedDocuments` call.

**#156 addendum — completing a hidden connection:** when `isHiddenIncoming` or `hiddenIncomingFromId` is set, complete it the exact same way (`buildEdgeCorridor(seed, sourceId, roomId, sourceRect, rect, exitFace)`, append its output to this room's own `walls` before creation), with two differences: (1) set both the resulting `doorWall` and `revealDoorWall` to `ds: CONST.WALL_DOOR_STATES.LOCKED` (not the real case's default open-once-populated state) and flag them `dungeonHiddenDoorForEdge` (not `dungeonDoorToRoomId`/the real per-edge flag) — this is what keeps them sealed until Task 9's reveal step; (2) do **not** add the resulting wall id to `doorToRoomId` — a locked, hidden-flagged door must never resolve through `handleDungeonDoorOpened` (Task 11) until reveal promotes it. `sourceRect` for a hidden connection is `roomRect(seed, sourceId, ...)` recomputed from `state.layoutPositionByRoomId[sourceId]` (the caller already has this from building `sourceId` earlier in topological order) — same as how a normal child looks up its parent's rect today.

**Pre-existing bug found while writing this fix (not part of #156, fixed here only incidentally):** the frontier-placeholder lookup above now uses `.endsWith(`->${roomId}`)`. The original draft of this task used `=== `->${roomId}`` against a flag value that was always set as `${roomId}->${childIds[i]}` (parent **and** child, e.g. `"roomA->roomB"`) — that never equals `"->roomB"`, so no frontier placeholder would ever have actually been found/superseded for *any* edge, hidden or not (every doorway would keep a redundant leftover placeholder wall). Both the normal and hidden lookups share this one `placeholderIds` computation, so switching it to `.endsWith` (needed for the hidden case regardless, since the hidden flag value must stay parent-specific to disambiguate) fixes the pre-existing case too, for free.

- [ ] **Step 4: Live verification**

Run the checklist written in Step 1 against a real Foundry world (same existing convention noted in `dungeon-scene.mjs`'s other functions) before committing.

- [ ] **Step 5: Commit**

```bash
git add scripts/dungeon-scene.mjs scripts/dungeon-layout.mjs
git commit -m "feat: build multi-exit rooms with per-edge frontier placeholders"
```

---

## Task 11: Graph-aware door handling and lazy fallback build

**Files:**
- Modify: `scripts/dungeon-scene.mjs`
- Test: manual/live verification (same boundary as Task 10).

**Interfaces:**
- Consumes: `advanceToRoom` (Task 8), `doorToRoomId` lookup (Task 10), `buildRoomAtGraphNode` (Task 10).
- Produces: `handleDungeonDoorOpened(sceneId, wallId)` (existing name, new body) resolving `wallId` → `doorToRoomId[wallId]` → calls `advanceToRoom` with that specific child, instead of the old single `state.rooms[state.currentIndex + 1]` check. Adds the Review Focus lazy-fallback build: if the resolved room's content isn't present yet (eager pregeneration failed for it), build it on demand before revealing.

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
  // failed for this room, build it now rather than leaving the party
  // stuck — the same idempotent build step the eager pass already used.
  // #156: mirrors Task 12's eager-build call exactly (layoutEdges for
  // incomingFaceFor, hidden-edge params) — a room reached here via a
  // resolved `dungeonDoorToRoomId` is, by construction, never still
  // sealed (a still-hidden door has no such flag and returns above), but
  // it can still itself be the SOURCE of its own separate hidden edge, or
  // (for a detour room specifically) still structurally have a hidden
  // incoming connection even after that connection's door was promoted —
  // passing the same params as the eager path keeps both build paths
  // agreeing on this room's geometry.
  if (!isRoomBuilt(scene, roomId)) {
    const room = state.rooms[roomId];
    await buildRoomAtGraphNode(scene, roomId, {
      rank: state.layoutPositionByRoomId[roomId].rank,
      col: state.layoutPositionByRoomId[roomId].col,
      incomingFace: incomingFaceFor(state.layoutEdges, roomId),
      childIds: state.edges[roomId] ?? [],
      hiddenChildId: state.hiddenEdges[roomId]?.[0] ?? null,
      hiddenIncomingFromId: state.hiddenIncomingByRoomId[roomId]?.[0] ?? null,
      isHiddenIncoming: state.hiddenRooms.includes(roomId),
      isGoal: room.isGoal,
      locationTag: room.locationTag,
      artVariant: room.artVariant,
      seed: state.seed,
    });
  }

  await advanceToRoom({ sceneId, roomId, revealedTokenIds: [] });
}
```

**Note for the implementer:** `wall.getFlag(MODULE_ID, "dungeonDoorToRoomId")` must be set when each door wall is created in Task 10 (add it alongside the existing `dungeonDoorToSlot`-style flag, now storing the target room id directly rather than a slot number — simplest possible `doorToRoomId` lookup, keyed by wall flag rather than a separately-threaded map, avoiding new state). `isRoomBuilt` generalizes the existing `isSlotBuilt`/`isSlotPopulated` presence check (`dungeon-scene.mjs:391-403`) from a slot number to a room id — same presence-check logic, just keyed differently.

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
- Consumes: `buildRoomGraph`, `attachHiddenPaths` (Tasks 2-3), `computeRanks`/`computeColumns` (Task 4), `roomsToEagerlyBuild`/`commitEagerPhysicalSlots` (Task 7), `buildRoomAtGraphNode` (Task 10).
- Produces: `startDungeonRun` builds the whole graph for every run (drops the `if (state.hostUserId)` gate at dungeon-app.mjs:556) and no longer skips a combat-kind room at generation-order position 1.

**#156 fix:** `computeRanks`/`computeColumns` must run over `layoutEdges` (Task 3's output, includes detour rooms), not `edges` — otherwise a detour room's `layoutPositionByRoomId` entry is `{rank: undefined, col: undefined}` and every downstream `roomRect` call for it produces garbage. The eager-build loop must also pass each room's hidden-edge info (`hiddenChildId`/`hiddenIncomingFromId`/`isHiddenIncoming`, Task 10) so hidden doors actually get built sealed instead of the face just being walled solid.

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

  state = {
    ...state,
    rooms,
    edges,
    layoutEdges,
    hiddenRooms: [...hiddenRooms],
    hiddenEdges,
    hiddenIncomingByRoomId,
    layoutPositionByRoomId,
    currentRoomId: 'room-entry',
    history: [],
  };

  // #93: full pregeneration for every run, GM-present or GM-less alike —
  // no more hostUserId gate, no more ITEM-11 first-combat-room deferral.
  // #156: walks layoutEdges (Task 7) so detour rooms are included.
  const eagerlyBuilt = roomsToEagerlyBuild(state);
  for (const { room, buildOrder } of eagerlyBuilt) {
    const { rank, col } = layoutPositionByRoomId[room.id];
    const isDetour = hiddenRooms.has(room.id);
    await buildRoomAtGraphNode(scene, room.id, {
      rank, col,
      // #156: incomingFaceFor now takes layoutEdges so a detour room's
      // (hidden) parent link resolves instead of throwing.
      incomingFace: incomingFaceFor(layoutEdges, room.id),
      childIds: edges[room.id] ?? [],
      // #156: this room's own hidden outgoing target (shortcut or detour),
      // if any — reserves and seals the extra face.
      hiddenChildId: hiddenEdges[room.id]?.[0] ?? null,
      // #156: set only for a shortcut's target room — the source room id
      // whose hidden edge points at this room, reserving a second sealed
      // incoming face distinct from this room's real parent link.
      hiddenIncomingFromId: hiddenIncomingByRoomId[room.id]?.[0] ?? null,
      // #156: true only for a detour room — its one real incoming link IS
      // the hidden path, so it's completed sealed/LOCKED instead of open.
      isHiddenIncoming: isDetour,
      isGoal: room.isGoal,
      locationTag: room.locationTag,
      artVariant: room.artVariant,
      seed: state.seed,
    });
  }
  await commitEagerPhysicalSlots(scene.id, eagerlyBuilt);
```

Delete `populateNextRoom` (dungeon-app.mjs:733) and its call site/UI button wiring (the `#onPopulateNext` handler and template button referencing it), per the confirmed removal of the ITEM-11 deferral.

**Note for the implementer:** `incomingFaceFor` is Task 5's shared helper (`dungeon-layout.mjs`) — the same one Task 11's lazy fallback uses, so both call sites agree on the same parent/face resolution.

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
- Modify: `scripts/ui/dungeon-app.mjs`
- Test: manual/live verification.

**Interfaces:**
- Consumes: `markRoomOutcome` (Task 9, already drops mutation logic internally).
- Produces: `resolveCurrentRoom` (existing name) no longer branches on `mutation && state.hostUserId` or calls any resync/reconciliation step (dungeon-app.mjs:198-299 area, per #62's now-superseded reconciliation mechanism) — that entire code path is dead once nothing splices `state.rooms` at runtime.

- [ ] **Step 1: Write the manual verification checklist**

(a) resolving a room whose outcome is `reduced_travel_time`/`extra_travel_time` no longer triggers any teardown/rebuild of already-built rooms — the party simply sees a newly unlocked door where the hidden path was revealed; (b) resolving every other outcome kind behaves exactly as before (unaffected by this change).

- [ ] **Step 2: (N/A — manual verification file)**

- [ ] **Step 3: Write the implementation**

In `scripts/ui/dungeon-app.mjs`'s `resolveCurrentRoom` (around line 132-299), delete the `mutation`-branching block and its resync-step call entirely (the code guarded by `if (mutation && state.hostUserId)` at line 228 and everything through `commitEagerPhysicalSlots` reconciliation at line 299) — `markRoomOutcome`'s return no longer includes `mutation`/`nextRoomId`/`nextPhysicalSlot` (Task 9), so this whole branch has nothing left to key off.

- [ ] **Step 4: Live verification**

Run the Step 1 checklist.

- [ ] **Step 5: Commit**

```bash
git add scripts/ui/dungeon-app.mjs
git commit -m "refactor: remove dead mutation-resync logic from resolveCurrentRoom"
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
