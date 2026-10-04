# Randomized/Invariant Testing for pathfinding.mjs, dungeon-follow-mechanics.mjs, placement.mjs, prng.mjs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add randomized/invariant-style test coverage to the four pure, Foundry-decoupled modules that currently have none (`pathfinding.mjs`, `dungeon-follow-mechanics.mjs`, `placement.mjs`) or no test file at all (`prng.mjs`), following this repo's own already-established hand-rolled-seeded-PRNG convention — no new library, no production code changes anywhere in this plan.

**Architecture:** Purely additive test work, one task per module, each independent of the others (no shared interfaces between tasks). `dungeon-deck.test.mjs`/`dungeon-layout.test.mjs`'s own randomized sweeps vary a *seed string* passed into an already-seeded production function (`buildRoomSequence`, etc.); the four modules here take no seed at all — they're pure functions over explicit inputs (grid cells, wall predicates, footprints) with no RNG inside them. So the sweep pattern here instead uses `scripts/prng.mjs`'s own `splitmix32(seedFromString(...))` directly *inside each test* to generate many distinct, reproducible randomized scenarios, then asserts an invariant on each one — same spirit (seeded, deterministic, large-N, invariant-checking) as the established convention, adapted to functions that don't take a seed of their own.

**Tech Stack:** Vanilla JS, vitest, `scripts/prng.mjs`'s `splitmix32`/`seedFromString` (no new dependency).

**Spec:** None — a bounded, test-only addition with no production-code design question; the issue's own "Correction" section already resolved the one real design question (hand-rolled seeded sweeps, not a `fast-check`-style library) before this plan was written.

## Global Constraints

- No production code changes anywhere in this plan — `scripts/pathfinding.mjs`, `scripts/dungeon-follow-mechanics.mjs`, `scripts/placement.mjs`, and `scripts/prng.mjs` are read, never modified.
- Every new randomized test must be reproducible on failure: use `splitmix32(seedFromString(...))` with a stable, printed-in-the-test seed label (e.g. `` `findPath-${trial}` ``) for every source of randomness — never `Math.random()` anywhere in this plan's new tests, so a failure is always re-runnable deterministically from the seed alone.
- Match each file's own existing quote-style convention exactly (`tests/pathfinding.test.mjs`/`tests/dungeon-follow-mechanics.test.mjs` use double quotes; `tests/placement.test.mjs` uses single quotes) — confirmed by reading each file before writing this plan, not assumed uniform across the suite.
- A randomized trial whose scenario produces a "no result" outcome (`findPath` returning `null`, `findFollowMove` returning `"no-route"`/`"already-near"`, `freeSpot`/`freeSpotInRect` returning `null`) is a valid outcome to skip (`continue`), not a test failure — these functions are explicitly documented to return null/a status-only result when nothing fits, and a property test's job is to check the invariant *holds whenever a real result comes back*, not to force every random scenario into producing one.

## Review Focus

- **A returned path/move whose own start or end doesn't match what was asked for.** It's possible to write a property test that only checks "no step is blocked" and never verifies the path actually starts and ends where requested — a subtly wrong implementation could satisfy the weaker check while still being broken. Task 2's `findPath` test and Task 3's `findFollowMove` test both assert the full start-to-end identity, not just the no-blocked-step property.
- **A property test that can never actually exercise the "found a result" branch** because its randomized scenario generator makes a real result statistically near-impossible (e.g. bounds too small, too many random obstacles). Each task's scenario generator is sized so a real result is the common case, not a rare fluke — called out explicitly in each task's own step rather than left to chance.
- **`splitmix32`'s own distribution being lopsided** (e.g. always biased toward one half of `[0, 1)`, or a short repeating cycle) would silently make *every other* new test's "randomization" far less random than it looks, undermining all three other tasks without any of them ever noticing. Task 1 checks this directly against `splitmix32` itself, before any other task's tests lean on it.
- **`shuffle` secretly mutating its input array** — every property test in Tasks 2-4 that builds a scenario array and might reuse or compare it afterward would get silently corrupted results if any helper mutated shared state; `shuffle` is the one function in these four modules that takes and returns an array, so Task 1 explicitly pins that it returns a new array rather than mutating in place.
- **A footprint-overlap check in Task 4 that only compares `{gx, gy}` and ignores `{gw, gh}`** — `placement.mjs`'s whole `overlaps()` contract is footprint-aware (width/height, not just position), and the issue exists partly because this nuance was never swept randomly. Task 4's generator randomizes footprint sizes (not just positions) for both the probe spot and the occupied obstacles, not just positions with implicit 1×1 size.

---

## Task 1: `tests/prng.test.mjs` (new)

**Files:**
- Create: `tests/prng.test.mjs`

**Interfaces:** None — this task only tests `scripts/prng.mjs`'s existing exports (`splitmix32`, `seedFromString`, `shuffle`); nothing else in this plan depends on it.

- [x] **Step 1: Write the test file**

```js
import { describe, it, expect } from "vitest";
import { splitmix32, seedFromString, shuffle } from "../scripts/prng.mjs";

describe("splitmix32", () => {
  it("is deterministic for a given seed", () => {
    const a = splitmix32(42);
    const b = splitmix32(42);
    const seqA = Array.from({ length: 20 }, () => a());
    const seqB = Array.from({ length: 20 }, () => b());
    expect(seqA).toEqual(seqB);
  });

  it("produces different sequences for different seeds", () => {
    const a = splitmix32(1);
    const b = splitmix32(2);
    const seqA = Array.from({ length: 10 }, () => a());
    const seqB = Array.from({ length: 10 }, () => b());
    expect(seqA).not.toEqual(seqB);
  });

  it("property: every output is within [0, 1) across many seeds and draws", () => {
    for (let seed = 0; seed < 50; seed += 1) {
      const rand = splitmix32(seed);
      for (let i = 0; i < 200; i += 1) {
        const value = rand();
        expect(value).toBeGreaterThanOrEqual(0);
        expect(value).toBeLessThan(1);
      }
    }
  });

  it("property: output distribution across many draws isn't lopsided toward one half", () => {
    const rand = splitmix32(777);
    let below = 0;
    const total = 20000;
    for (let i = 0; i < total; i += 1) if (rand() < 0.5) below += 1;
    // A genuinely broken generator (always low, or a short repeating cycle
    // biased to one half) would land far outside this band; a reasonable
    // PRNG lands close to 50/50 over this many draws.
    expect(below / total).toBeGreaterThan(0.47);
    expect(below / total).toBeLessThan(0.53);
  });
});

describe("seedFromString", () => {
  it("is deterministic for the same string", () => {
    expect(seedFromString("alpha")).toBe(seedFromString("alpha"));
  });

  it("produces 500 distinct seeds for 500 distinct strings (no collisions in a reasonable sample)", () => {
    const seeds = new Set();
    for (let i = 0; i < 500; i += 1) seeds.add(seedFromString(`seed-${i}`));
    expect(seeds.size).toBe(500);
  });

  it("always returns a value in the unsigned 32-bit range", () => {
    for (let i = 0; i < 100; i += 1) {
      const seed = seedFromString(`probe-${i}`);
      expect(seed).toBeGreaterThanOrEqual(0);
      expect(seed).toBeLessThanOrEqual(0xffffffff);
    }
  });
});

describe("shuffle", () => {
  it("returns a permutation of the input -- same elements, same length", () => {
    const rand = splitmix32(99);
    const input = Array.from({ length: 20 }, (_, i) => i);
    const result = shuffle(input, rand);
    expect(result).toHaveLength(input.length);
    expect([...result].sort((a, b) => a - b)).toEqual(input);
  });

  it("does not mutate the input array", () => {
    const rand = splitmix32(5);
    const input = [1, 2, 3, 4, 5];
    const copy = [...input];
    shuffle(input, rand);
    expect(input).toEqual(copy);
  });

  it("property: over many independent shuffles, the first element doesn't pile into one or two fixed final positions", () => {
    const size = 10;
    const input = Array.from({ length: size }, (_, i) => i);
    const landedPositions = new Set();
    for (let seed = 0; seed < 300; seed += 1) {
      const rand = splitmix32(seed);
      const result = shuffle(input, rand);
      landedPositions.add(result.indexOf(0));
    }
    // A broken shuffle (e.g. one that never moves the first element) would
    // show element 0 landing in only one or two of the 10 possible slots
    // across 300 independent trials; a healthy shuffle spreads it widely.
    expect(landedPositions.size).toBeGreaterThan(5);
  });
});
```

- [x] **Step 2: Run the test file**

Run: `npx vitest run tests/prng.test.mjs`
Expected: PASS (all tests) — this is pure new-coverage work against already-correct, unmodified production code, so there's no "make it fail first" step; the test should pass on the first run.

- [x] **Step 3: Commit**

```bash
git add tests/prng.test.mjs
git commit -m "Add randomized/invariant tests for prng.mjs (#295)"
```

---

## Task 2: `tests/pathfinding.test.mjs` — randomized invariants

**Files:**
- Modify: `tests/pathfinding.test.mjs`

**Interfaces:** None new — consumes the existing `findPath`, `blockedEdgesFromWalls`, `hasLineOfSight` exports already imported at the top of this file.

- [ ] **Step 1: Add the new property tests**

Append to `tests/pathfinding.test.mjs` (add the import alongside the existing ones at the top, and these new `describe` blocks at the end of the file):

```js
import { splitmix32, seedFromString } from "../scripts/prng.mjs";
```

```js
function edgeKey(a, b) {
  // Order-independent key for an undirected adjacency pair -- a wall
  // blocks movement both directions, so the key must not depend on which
  // of a/b is "first".
  const [lo, hi] = [`${a.gx},${a.gy}`, `${b.gx},${b.gy}`].sort();
  return `${lo}|${hi}`;
}

describe("findPath property tests", () => {
  it("property: a returned path never steps across a blocked edge, and always starts/ends exactly where asked", () => {
    const BOUNDS = { gx0: 0, gy0: 0, gx1: 9, gy1: 9 };
    const ADJACENT_DIRS = [{ dx: 1, dy: 0 }, { dx: 0, dy: 1 }, { dx: 1, dy: 1 }, { dx: 1, dy: -1 }];
    let foundAtLeastOnePath = false;
    for (let trial = 0; trial < 300; trial += 1) {
      const rand = splitmix32(seedFromString(`findPath-${trial}`));
      const randCell = () => ({ gx: Math.floor(rand() * 10), gy: Math.floor(rand() * 10) });
      // A random scattering of blocked edges -- sparse enough (60 out of a
      // ~300-edge-pair space on this 10x10 grid) that most trials still
      // find a real path, which is the common case this test needs to
      // actually exercise the "found a path" branch below.
      const blocked = new Set();
      for (let i = 0; i < 60; i += 1) {
        const a = randCell();
        const { dx, dy } = ADJACENT_DIRS[Math.floor(rand() * ADJACENT_DIRS.length)];
        blocked.add(edgeKey(a, { gx: a.gx + dx, gy: a.gy + dy }));
      }
      const isBlocked = (a, b) => blocked.has(edgeKey(a, b));
      const start = randCell();
      const goal = randCell();

      const path = findPath(start, goal, isBlocked, BOUNDS);
      if (!path) continue; // no-route is a valid outcome for a given trial

      foundAtLeastOnePath = true;
      expect(path[0]).toEqual(start);
      expect(path.at(-1)).toEqual(goal);
      for (let i = 1; i < path.length; i += 1) {
        expect(isBlocked(path[i - 1], path[i])).toBe(false);
      }
    }
    // Guards against the generator being accidentally too hostile to ever
    // produce a real path to check (see this plan's Review Focus).
    expect(foundAtLeastOnePath).toBe(true);
  });
});

describe("blockedEdgesFromWalls property tests", () => {
  it("property: the predicate it builds is symmetric -- a wall blocks movement both directions", () => {
    for (let trial = 0; trial < 200; trial += 1) {
      const rand = splitmix32(seedFromString(`blockedEdgesFromWalls-${trial}`));
      const GRID_SIZE = 100;
      const walls = Array.from({ length: 1 + Math.floor(rand() * 10) }, () => {
        const gx = Math.floor(rand() * 10);
        const gy = Math.floor(rand() * 10);
        return rand() < 0.5
          ? { x1: gx * GRID_SIZE, y1: gy * GRID_SIZE, x2: gx * GRID_SIZE, y2: (gy + 1) * GRID_SIZE }
          : { x1: gx * GRID_SIZE, y1: gy * GRID_SIZE, x2: (gx + 1) * GRID_SIZE, y2: gy * GRID_SIZE };
      });
      const isBlocked = blockedEdgesFromWalls(walls, GRID_SIZE);

      for (let i = 0; i < 50; i += 1) {
        const a = { gx: Math.floor(rand() * 10), gy: Math.floor(rand() * 10) };
        const dirs = [{ dx: 1, dy: 0 }, { dx: 0, dy: 1 }, { dx: 1, dy: 1 }, { dx: 1, dy: -1 }];
        const { dx, dy } = dirs[Math.floor(rand() * dirs.length)];
        const b = { gx: a.gx + dx, gy: a.gy + dy };
        expect(isBlocked(a, b)).toBe(isBlocked(b, a));
      }
    }
  });
});

describe("hasLineOfSight property tests", () => {
  it("property: always true over a fully open field (no walls), for any two points", () => {
    const openField = () => false;
    for (let trial = 0; trial < 200; trial += 1) {
      const rand = splitmix32(seedFromString(`hasLineOfSight-open-${trial}`));
      const start = { gx: Math.floor(rand() * 20) - 10, gy: Math.floor(rand() * 20) - 10 };
      const goal = { gx: Math.floor(rand() * 20) - 10, gy: Math.floor(rand() * 20) - 10 };
      expect(hasLineOfSight(start, goal, openField)).toBe(true);
    }
  });

  it("property: a wall directly on the one-step edge between two orthogonally adjacent cells always blocks line of sight between them", () => {
    // Orthogonal only, deliberately -- hasLineOfSight's diagonal-step check
    // (see its own docblock) never consults isBlocked(a, b) for the
    // diagonal pair itself, only the two flanking orthogonal edges around
    // the corner. Blocking the exact diagonal pair the way this test does
    // would not actually test anything for a diagonal start/goal; this
    // property is specifically about the orthogonal case, where
    // hasLineOfSight does check isBlocked(a, b) directly.
    const ORTHOGONAL_DIRS = [{ dx: 1, dy: 0 }, { dx: 0, dy: 1 }, { dx: -1, dy: 0 }, { dx: 0, dy: -1 }];
    for (let trial = 0; trial < 200; trial += 1) {
      const rand = splitmix32(seedFromString(`hasLineOfSight-blocked-${trial}`));
      const start = { gx: Math.floor(rand() * 10), gy: Math.floor(rand() * 10) };
      const { dx, dy } = ORTHOGONAL_DIRS[Math.floor(rand() * ORTHOGONAL_DIRS.length)];
      const goal = { gx: start.gx + dx, gy: start.gy + dy };
      const isBlocked = (a, b) => edgeKey(a, b) === edgeKey(start, goal);
      expect(hasLineOfSight(start, goal, isBlocked)).toBe(false);
    }
  });
});
```

- [ ] **Step 2: Run the test file**

Run: `npx vitest run tests/pathfinding.test.mjs`
Expected: PASS (every pre-existing test plus the new ones)

- [ ] **Step 3: Commit**

```bash
git add tests/pathfinding.test.mjs
git commit -m "Add randomized/invariant tests for pathfinding.mjs (#295)"
```

---

## Task 3: `tests/dungeon-follow-mechanics.test.mjs` — `findFollowMove` randomized invariant

**Files:**
- Modify: `tests/dungeon-follow-mechanics.test.mjs`

**Interfaces:** Consumes `overlaps` from `scripts/placement.mjs` (new import in this test file only — `findFollowMove` itself already imports and uses `overlaps` internally; this test imports it separately to check the invariant from the outside, not to reuse any internal state).

- [ ] **Step 1: Add the new property test**

Add the import at the top of `tests/dungeon-follow-mechanics.test.mjs`, alongside the existing ones:

```js
import { overlaps } from "../scripts/placement.mjs";
import { splitmix32, seedFromString } from "../scripts/prng.mjs";
```

Append this `describe` block to the end of the file:

```js
describe("findFollowMove property tests", () => {
  it("property: a 'move' result's target is never occupied, and its steps form a valid, unblocked path ending there", () => {
    const GRID = 12;
    const ADJACENT_DIRS = [{ dx: 1, dy: 0 }, { dx: 0, dy: 1 }, { dx: 1, dy: 1 }, { dx: 1, dy: -1 }];
    let foundAtLeastOneMove = false;
    for (let trial = 0; trial < 300; trial += 1) {
      const rand = splitmix32(seedFromString(`findFollowMove-${trial}`));
      const randCell = () => ({ gx: Math.floor(rand() * GRID), gy: Math.floor(rand() * GRID) });
      const leaderCell = randCell();
      const fromCell = randCell();
      // Sparse occupants and walls -- enough to exercise real contention
      // without making a "move" result the rare case (see Review Focus).
      const occupiedFootprints = Array.from({ length: Math.floor(rand() * 4) }, () => ({
        ...randCell(),
        gw: 1,
        gh: 1,
      }));
      const blocked = new Set();
      for (let i = 0; i < 20; i += 1) {
        const a = randCell();
        const { dx, dy } = ADJACENT_DIRS[Math.floor(rand() * ADJACENT_DIRS.length)];
        blocked.add(`${a.gx},${a.gy}|${a.gx + dx},${a.gy + dy}`);
      }
      const isBlocked = (a, b) => {
        const k1 = `${a.gx},${a.gy}|${b.gx},${b.gy}`;
        const k2 = `${b.gx},${b.gy}|${a.gx},${a.gy}`;
        return blocked.has(k1) || blocked.has(k2);
      };
      const bounds = { gx0: 0, gy0: 0, gx1: GRID - 1, gy1: GRID - 1 };

      const result = findFollowMove(fromCell, leaderCell, occupiedFootprints, isBlocked, bounds);
      if (result.status !== "move") continue; // already-near / no-route: nothing to check here

      foundAtLeastOneMove = true;
      const targetFootprint = { gx: result.to.gx, gy: result.to.gy, gw: 1, gh: 1 };
      for (const occ of occupiedFootprints) {
        expect(overlaps(targetFootprint, occ)).toBe(false);
      }

      expect(result.steps.at(-1)).toEqual(result.to);
      let prev = fromCell;
      for (const cell of result.steps) {
        const dx = Math.abs(cell.gx - prev.gx);
        const dy = Math.abs(cell.gy - prev.gy);
        expect(Math.max(dx, dy)).toBe(1);
        expect(isBlocked(prev, cell)).toBe(false);
        prev = cell;
      }
    }
    expect(foundAtLeastOneMove).toBe(true);
  });
});
```

- [ ] **Step 2: Run the test file**

Run: `npx vitest run tests/dungeon-follow-mechanics.test.mjs`
Expected: PASS (every pre-existing test plus the new one)

- [ ] **Step 3: Commit**

```bash
git add tests/dungeon-follow-mechanics.test.mjs
git commit -m "Add randomized/invariant test for findFollowMove (#295)"
```

---

## Task 4: `tests/placement.test.mjs` — `freeSpot`/`freeSpotInRect` randomized invariants

**Files:**
- Modify: `tests/placement.test.mjs`

**Interfaces:** None new — consumes the existing `overlaps`, `freeSpot`, `freeSpotInRect` exports already imported at the top of this file.

- [ ] **Step 1: Add the new property tests**

Add the import at the top of `tests/placement.test.mjs`, alongside the existing one:

```js
import { splitmix32, seedFromString } from '../scripts/prng.mjs';
```

Append these `describe` blocks to the end of the file (note: this file uses single quotes throughout, unlike `pathfinding.test.mjs`/`dungeon-follow-mechanics.test.mjs` — match it):

```js
describe('freeSpot property tests', () => {
  it('property: a returned spot never overlaps any occupied footprint, and keeps the requested size', () => {
    let foundAtLeastOneSpot = false;
    for (let trial = 0; trial < 300; trial += 1) {
      const rand = splitmix32(seedFromString(`freeSpot-${trial}`));
      const gx = Math.floor(rand() * 20) - 10;
      const gy = Math.floor(rand() * 20) - 10;
      const gw = 1 + Math.floor(rand() * 2);
      const gh = 1 + Math.floor(rand() * 2);
      // Occupants scattered near (gx, gy), sparse enough that most trials
      // still find a free spot -- the common case this test needs to
      // actually exercise.
      const occupied = Array.from({ length: Math.floor(rand() * 6) }, () => ({
        gx: gx + Math.floor(rand() * 7) - 3,
        gy: gy + Math.floor(rand() * 7) - 3,
        gw: 1 + Math.floor(rand() * 2),
        gh: 1 + Math.floor(rand() * 2),
      }));

      const spot = freeSpot({ occupied, gx, gy, gw, gh, maxRing: 8 });
      if (!spot) continue; // search-exhausted is a valid outcome

      foundAtLeastOneSpot = true;
      expect(spot.gw).toBe(gw);
      expect(spot.gh).toBe(gh);
      for (const occ of occupied) {
        expect(overlaps(spot, occ)).toBe(false);
      }
    }
    expect(foundAtLeastOneSpot).toBe(true);
  });
});

describe('freeSpotInRect property tests', () => {
  it('property: a returned spot never overlaps an occupied footprint and always stays fully within the rect', () => {
    let foundAtLeastOneSpot = false;
    for (let trial = 0; trial < 300; trial += 1) {
      const rand = splitmix32(seedFromString(`freeSpotInRect-${trial}`));
      const rect = {
        gx: Math.floor(rand() * 10),
        gy: Math.floor(rand() * 10),
        gw: 3 + Math.floor(rand() * 8),
        gh: 3 + Math.floor(rand() * 8),
      };
      const gw = 1 + Math.floor(rand() * 2);
      const gh = 1 + Math.floor(rand() * 2);
      const occupied = Array.from({ length: Math.floor(rand() * 5) }, () => ({
        gx: rect.gx + Math.floor(rand() * rect.gw),
        gy: rect.gy + Math.floor(rand() * rect.gh),
        gw: 1,
        gh: 1,
      }));

      const spot = freeSpotInRect({ occupied, rect, gw, gh });
      if (!spot) continue;

      foundAtLeastOneSpot = true;
      expect(spot.gx).toBeGreaterThanOrEqual(rect.gx);
      expect(spot.gy).toBeGreaterThanOrEqual(rect.gy);
      expect(spot.gx + gw).toBeLessThanOrEqual(rect.gx + rect.gw);
      expect(spot.gy + gh).toBeLessThanOrEqual(rect.gy + rect.gh);
      for (const occ of occupied) {
        expect(overlaps(spot, occ)).toBe(false);
      }
    }
    expect(foundAtLeastOneSpot).toBe(true);
  });
});
```

- [ ] **Step 2: Run the test file**

Run: `npx vitest run tests/placement.test.mjs`
Expected: PASS (every pre-existing test plus the two new ones)

- [ ] **Step 3: Run the full suite to confirm no regressions anywhere**

Run: `npx vitest run`
Expected: PASS — this plan never touches production code, so the only way this step could fail is a mistake in one of the four new/modified test files themselves.

- [ ] **Step 4: Commit**

```bash
git add tests/placement.test.mjs
git commit -m "Add randomized/invariant tests for freeSpot/freeSpotInRect (#295)"
```
