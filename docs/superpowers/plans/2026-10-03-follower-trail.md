# Follower Trail-Following Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Out-of-combat followers queue single-file along the leader's route instead of fanning out diagonally (#610 part 2).

**Architecture:** A pure `extendTrail` keeps a newest-first list of the leader's cells, rebuilt per leader move with the existing wall-aware `findPath`. A pure `findTrailMove` sends follower `i` to `trail[i+1]`, returning `null` whenever the old `findFollowMove` logic should decide instead. `dungeon-follow.mjs` owns the per-scene trail Map and wires both in; walking is part 1's `walkTokenThroughSteps`, unchanged.

**Tech Stack:** Foundry VTT v14 module, plain ESM, vitest.

**Spec:** `docs/superpowers/specs/2026-10-03-follower-trail-design.md`

## Global Constraints

- Every hop keeps `{ teleport: true }` (#87/#141/#361); do not touch `walkTokenThroughSteps`.
- Trail source is `findPath` reconstruction, not `_movement.waypoints`.
- Trail is newest-first; `trail[0]` is the leader's current cell; follower `i` (0-based, only followers that actually have a token) aims for `trail[i + 1]`.
- Fallback to `findFollowMove` when the trail is too short, stale, occupied, unreachable, or the follower is larger than 1x1.
- Max trail length = number of marching-order followers + 3.
- Bump `module.json` version (patch; `0.55.15` was the last used here — re-check `origin/main` and never reuse) and refresh `docs/architecture.md` via the `update-architecture-docs` skill (no new files, but run it).
- Spec amendments decided while planning: `extendTrail` takes no `fromCell` (it uses `trail[0]`); a leader walking back over its own route collapses the trail instead of duplicating cells; combat reset is lazy (trail deleted on the next position change seen during combat) rather than via a combat-start hook; run start/scene change self-heal because the first leader move after a stale trail either no-paths (reset) or only the cells nearest the leader survive trimming.

## Review Focus

- Leader teleports / no path to the new cell → trail resets to `[newCell]` (Task 1 test).
- Leader update that doesn't change its cell (rotation, same cell) → trail unchanged, no duplicate cells (Task 1 test).
- Leader walks back over its own route → trail collapses, no repeated cells that would make two followers aim at one cell (Task 1 test).
- Leader moves during combat, then combat ends → no bogus trail across the fight (Task 2 test).
- A follower token missing from the scene must not consume a trail slot (Task 2 test).
- Oversized (2x2) follower and an occupied trail cell fall back instead of stacking (Task 1 tests).

---

### Task 1: Pure trail logic

**Files:**
- Modify: `scripts/dungeon-follow-mechanics.mjs` (add two exports after `findFollowMove`)
- Test: `tests/dungeon-follow-mechanics.test.mjs`

**Interfaces:**
- Produces: `extendTrail(trail: {gx,gy}[], toCell: {gx,gy}, isBlocked, bounds, maxLen: number): {gx,gy}[]` and `findTrailMove(fromCell, trailCell: {gx,gy}|null, occupiedFootprints, isBlocked, bounds, footprint = {gw:1,gh:1}): null | {status:"already-near"} | {status:"move", to, steps}`.

- [ ] **Step 1: Write the failing tests** — append to `tests/dungeon-follow-mechanics.test.mjs` (add `extendTrail, findTrailMove` to the import list):

```js
describe("extendTrail (#610)", () => {
  it("starts a trail at the leader's cell when empty", () => {
    expect(extendTrail([], { gx: 2, gy: 2 }, noWalls(), null, 5)).toEqual([{ gx: 2, gy: 2 }]);
  });

  it("prepends the path cells newest-first for a straight run", () => {
    const t = extendTrail([{ gx: 2, gy: 2 }], { gx: 5, gy: 2 }, noWalls(), null, 10);
    expect(t).toEqual([
      { gx: 5, gy: 2 },
      { gx: 4, gy: 2 },
      { gx: 3, gy: 2 },
      { gx: 2, gy: 2 },
    ]);
  });

  it("routes around a wall using findPath", () => {
    // block the direct edge (2,2)->(3,2)
    const blocked = (a, b) => a.gx === 2 && a.gy === 2 && b.gx === 3 && b.gy === 2;
    const t = extendTrail([{ gx: 2, gy: 2 }], { gx: 3, gy: 2 }, blocked, null, 10);
    expect(t[0]).toEqual({ gx: 3, gy: 2 });
    expect(t.at(-1)).toEqual({ gx: 2, gy: 2 });
    expect(t.length).toBeGreaterThan(2);
  });

  it("resets to the new cell when no path exists (teleport)", () => {
    const wall = () => true;
    const t = extendTrail([{ gx: 0, gy: 0 }], { gx: 8, gy: 8 }, wall, null, 10);
    expect(t).toEqual([{ gx: 8, gy: 8 }]);
  });

  it("leaves the trail unchanged when the leader's cell did not change", () => {
    const trail = [{ gx: 4, gy: 2 }, { gx: 3, gy: 2 }];
    expect(extendTrail(trail, { gx: 4, gy: 2 }, noWalls(), null, 10)).toEqual(trail);
  });

  it("collapses the trail when the leader walks back over its own route", () => {
    const trail = [{ gx: 5, gy: 2 }, { gx: 4, gy: 2 }, { gx: 3, gy: 2 }, { gx: 2, gy: 2 }];
    const t = extendTrail(trail, { gx: 3, gy: 2 }, noWalls(), null, 10);
    expect(t).toEqual([{ gx: 3, gy: 2 }, { gx: 2, gy: 2 }]);
  });

  it("trims to maxLen keeping the newest cells", () => {
    const t = extendTrail([{ gx: 0, gy: 0 }], { gx: 9, gy: 0 }, noWalls(), null, 4);
    expect(t).toEqual([
      { gx: 9, gy: 0 },
      { gx: 8, gy: 0 },
      { gx: 7, gy: 0 },
      { gx: 6, gy: 0 },
    ]);
  });
});

describe("findTrailMove (#610)", () => {
  const one = { gw: 1, gh: 1 };

  it("returns null with no trail cell (caller falls back)", () => {
    expect(findTrailMove({ gx: 0, gy: 0 }, null, [], noWalls(), null, one)).toBeNull();
  });

  it("returns already-near when on or adjacent to the trail cell", () => {
    expect(findTrailMove({ gx: 4, gy: 3 }, { gx: 4, gy: 2 }, [], noWalls(), null, one)).toEqual({
      status: "already-near",
    });
  });

  it("returns the walk to the trail cell as steps", () => {
    const r = findTrailMove({ gx: 0, gy: 2 }, { gx: 4, gy: 2 }, [], noWalls(), null, one);
    expect(r.status).toBe("move");
    expect(r.to).toEqual({ gx: 4, gy: 2 });
    expect(r.steps.at(-1)).toEqual({ gx: 4, gy: 2 });
    expect(r.steps).not.toContainEqual({ gx: 0, gy: 2 });
  });

  it("returns null when the trail cell is occupied", () => {
    const occ = [{ gx: 4, gy: 2, gw: 1, gh: 1 }];
    expect(findTrailMove({ gx: 0, gy: 2 }, { gx: 4, gy: 2 }, occ, noWalls(), null, one)).toBeNull();
  });

  it("returns null for a follower larger than 1x1", () => {
    expect(
      findTrailMove({ gx: 0, gy: 2 }, { gx: 4, gy: 2 }, [], noWalls(), null, { gw: 2, gh: 2 }),
    ).toBeNull();
  });

  it("returns null when no path reaches the trail cell", () => {
    expect(findTrailMove({ gx: 0, gy: 2 }, { gx: 4, gy: 2 }, [], () => true, null, one)).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/dungeon-follow-mechanics.test.mjs`
Expected: FAIL — `extendTrail`/`findTrailMove` are not exported.

- [ ] **Step 3: Implement** — add after `findFollowMove` in `scripts/dungeon-follow-mechanics.mjs`:

```js
/** #610: the leader's recent route as a newest-first list of cells
 * (`trail[0]` is its current cell). Extended per leader move by running
 * the wall-aware `findPath` from the previous cell to the new one -- a
 * reconstruction, so it may differ slightly from the exact route a player
 * dragged. Unchanged cell -> unchanged trail; walking back over the
 * trail collapses it (no repeated cells); no path (teleport) or an empty
 * trail resets to `[toCell]`. Trimmed to `maxLen`, newest kept. */
export function extendTrail(trail, toCell, isBlocked, bounds, maxLen) {
  if (!trail.length) return [{ gx: toCell.gx, gy: toCell.gy }];
  if (trail[0].gx === toCell.gx && trail[0].gy === toCell.gy) return trail;
  const seen = trail.findIndex((c) => c.gx === toCell.gx && c.gy === toCell.gy);
  if (seen !== -1) return trail.slice(seen);
  const path = findPath(trail[0], toCell, isBlocked, bounds);
  if (!path || path.length < 2) return [{ gx: toCell.gx, gy: toCell.gy }];
  const fresh = path.slice(1).reverse();
  return [...fresh, ...trail].slice(0, maxLen);
}

/** #610: the move for a 1x1 follower to its assigned `trailCell`.
 * Returns `null` whenever the caller should fall back to `findFollowMove`
 * (no trail cell, follower larger than 1x1, destination occupied, or no
 * path). `{status:"already-near"}` when already on/adjacent to it. Same
 * result shape as `findFollowMove` otherwise. Occupancy handling mirrors
 * `findFollowMove`: non-passable footprints also block the path. */
export function findTrailMove(
  fromCell,
  trailCell,
  occupiedFootprints,
  isBlocked,
  bounds,
  footprint = { gw: 1, gh: 1 },
) {
  if (!trailCell || footprint.gw !== 1 || footprint.gh !== 1) return null;
  if (chebyshev(fromCell, trailCell) <= 1) return { status: "already-near" };
  if (occupiedFootprints.some((f) => cellInFootprint(trailCell, f))) return null;
  const blockers = occupiedFootprints.filter((f) => !f.passable);
  const pathBlocked = (a, b) =>
    isBlocked(a, b) || blockers.some((f) => cellInFootprint(b, f));
  const path = findPath(fromCell, trailCell, pathBlocked, bounds, 20000, footprint);
  if (!path || path.length < 2) return null;
  return { status: "move", to: trailCell, steps: path.slice(1) };
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run tests/dungeon-follow-mechanics.test.mjs`
Expected: PASS. If the wall-detour or reset test fails because of `findPath`'s default parameters, read `scripts/pathfinding.mjs`'s `findPath` signature and adjust only the test's blocker, not the implementation contract.

- [ ] **Step 5: Commit**

```bash
git add scripts/dungeon-follow-mechanics.mjs tests/dungeon-follow-mechanics.test.mjs
git commit -m "#610: extendTrail and findTrailMove (pure trail logic)

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

### Task 2: Wire the trail into the follow glue

**Files:**
- Modify: `scripts/dungeon-follow.mjs` (imports; trail Map near `pendingByScene`; `followLeaderIfDue`; `moveFollowersToward`)
- Test: `tests/dungeon-follow.test.mjs`

**Interfaces:**
- Consumes: `extendTrail`, `findTrailMove` from Task 1.
- Produces: `__clearLeaderTrailsForTests()`, `__getLeaderTrailForTests(sceneId)` (test-only exports, same style as `__clearRecentWritesForTests`).

- [ ] **Step 1: Write the failing tests** — in `tests/dungeon-follow.test.mjs`, add `__clearLeaderTrailsForTests, __getLeaderTrailForTests` to the import from `../scripts/dungeon-follow.mjs`, then add this describe before `describe("moveFollowersToward chain-following (#181)"`:

```js
describe("follower trail-following (#610)", () => {
  beforeEach(() => {
    __clearLeaderTrailsForTests();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function setup({ followers, leaderCell = { gx: 2, gy: 2 }, combats = [] }) {
    const leader = makeToken({
      id: "t-leader",
      x: leaderCell.gx * GRID,
      y: leaderCell.gy * GRID,
      actorId: LEADER_ACTOR_ID,
    });
    const tokens = [leader, ...followers];
    const scene = makeScene({ tokens });
    scene.width = 12 * GRID;
    scene.height = 12 * GRID;
    const ids = followers.map((f) => f.actor.id);
    installFoundryStubs({
      dungeonRuns: {
        [SCENE_ID]: { hostUserId: HOST_USER_ID, aiControlledActorIds: ids, marchingOrder: ids },
      },
    });
    game.scenes = { get: (id) => (id === SCENE_ID ? scene : undefined) };
    game.combats = combats;
    return { leader, scene };
  }

  async function moveLeader(leader, gx, gy) {
    await leader.update({ x: gx * GRID, y: gy * GRID });
    followLeaderIfDue(leader, { x: leader.x, y: leader.y });
  }

  const cellOf = (t) => ({ gx: t._source.x / GRID, gy: t._source.y / GRID });

  it("lines followers up along the leader's route, not the nearest free cell", async () => {
    vi.useFakeTimers();
    const a = makeToken({ id: "t-a", x: 6 * GRID, y: 6 * GRID, actorId: "actor-a" });
    const b = makeToken({ id: "t-b", x: 7 * GRID, y: 7 * GRID, actorId: "actor-b" });
    const { leader } = setup({ followers: [a, b] });
    followLeaderIfDue(leader, { x: leader.x, y: leader.y }); // seeds trail at (2,2)
    await moveLeader(leader, 6, 2);
    await settle();
    expect(cellOf(a)).toEqual({ gx: 5, gy: 2 });
    expect(cellOf(b)).toEqual({ gx: 4, gy: 2 });
  });

  it("does not record trail cells from a non-leader token's move", async () => {
    vi.useFakeTimers();
    const a = makeToken({ id: "t-a", x: 6 * GRID, y: 6 * GRID, actorId: "actor-a" });
    const { leader } = setup({ followers: [a] });
    followLeaderIfDue(leader, { x: leader.x, y: leader.y });
    await a.update({ x: 9 * GRID, y: 9 * GRID });
    followLeaderIfDue(a, { x: a.x, y: a.y });
    expect(__getLeaderTrailForTests(SCENE_ID)).toEqual([{ gx: 2, gy: 2 }]);
  });

  it("a follower with no token does not consume a trail slot", async () => {
    vi.useFakeTimers();
    const b = makeToken({ id: "t-b", x: 7 * GRID, y: 7 * GRID, actorId: "actor-b" });
    const { leader, scene } = setup({ followers: [b] });
    // marching order lists a ghost actor first; it has no token on the scene
    game.settings.get = (_m, key) =>
      key === "dungeonRuns"
        ? {
            [SCENE_ID]: {
              hostUserId: HOST_USER_ID,
              aiControlledActorIds: ["actor-ghost", "actor-b"],
              marchingOrder: ["actor-ghost", "actor-b"],
            },
          }
        : {};
    expect(scene.tokens.find((t) => t.actor?.id === "actor-ghost")).toBeUndefined();
    followLeaderIfDue(leader, { x: leader.x, y: leader.y });
    await moveLeader(leader, 6, 2);
    await settle();
    expect(cellOf(b)).toEqual({ gx: 5, gy: 2 });
  });

  it("drops the trail when a position change is seen during combat", async () => {
    vi.useFakeTimers();
    const a = makeToken({ id: "t-a", x: 6 * GRID, y: 6 * GRID, actorId: "actor-a" });
    const { leader } = setup({ followers: [a] });
    followLeaderIfDue(leader, { x: leader.x, y: leader.y });
    expect(__getLeaderTrailForTests(SCENE_ID)).toHaveLength(1);
    game.combats = [{ started: true, scene: { id: SCENE_ID } }];
    await moveLeader(leader, 6, 2);
    expect(__getLeaderTrailForTests(SCENE_ID)).toBeUndefined();
  });

  it("falls back to the old near-the-leader logic for a 2x2 follower", async () => {
    vi.useFakeTimers();
    const big = makeToken({ id: "t-big", x: 6 * GRID, y: 6 * GRID, actorId: "actor-a", width: 2, height: 2 });
    const { leader } = setup({ followers: [big] });
    followLeaderIfDue(leader, { x: leader.x, y: leader.y });
    await moveLeader(leader, 6, 2);
    await settle();
    expect(big.update).toHaveBeenCalled();
    const c = cellOf(big);
    expect(Math.max(Math.abs(c.gx - 6), Math.abs(c.gy - 2))).toBeLessThanOrEqual(3);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/dungeon-follow.test.mjs -t "trail-following"`
Expected: FAIL — the test-only exports don't exist yet.

- [ ] **Step 3: Implement** — in `scripts/dungeon-follow.mjs`:

1. Import: add `extendTrail, findTrailMove` to the `./dungeon-follow-mechanics.mjs` import list.
2. Near `const pendingByScene = new Map();` add:

```js
// #610: sceneId -> the leader's recent route, newest-first (see
// extendTrail). Lives on the GM client, the only one that moves followers.
const leaderTrails = new Map();
const TRAIL_EXTRA_CELLS = 3;

export function __clearLeaderTrailsForTests() {
  leaderTrails.clear();
}
export function __getLeaderTrailForTests(sceneId) {
  return leaderTrails.get(sceneId);
}

function recordLeaderMove(scene, leaderToken, followerCount) {
  const gridSize = scene.grid?.size ?? 100;
  const cell = tokenCell(sourcePosition(leaderToken), gridSize);
  leaderTrails.set(
    scene.id,
    extendTrail(
      leaderTrails.get(scene.id) ?? [],
      cell,
      movementBlockedEdges(scene, gridSize),
      sceneBounds(scene, gridSize),
      followerCount + TRAIL_EXTRA_CELLS,
    ),
  );
}
```

3. In `followLeaderIfDue`, replace `if (hasActiveCombat(scene)) return;` with:

```js
  if (hasActiveCombat(scene)) {
    // #610: a trail must not span a fight; the next leader move rebuilds it.
    leaderTrails.delete(scene.id);
    return;
  }
```
and replace the GM branch with:

```js
  if (game.user.isGM) {
    recordLeaderMove(scene, leaderToken, aiControlledIds.length);
    scheduleFollowMove(scene, leaderToken, aiControlledIds);
    return;
  }
```

4. In `moveFollowersToward`, after `let referenceCell = leaderCell;` add:

```js
    // #610: use the trail only while it still starts at the leader's real
    // cell (a door-open retry may run with a stale one).
    const storedTrail = leaderTrails.get(scene.id) ?? [];
    const trail =
      storedTrail[0] &&
      storedTrail[0].gx === leaderCell.gx &&
      storedTrail[0].gy === leaderCell.gy
        ? storedTrail
        : [];
    let slot = 0;
```
In the loop, right after `if (!token) continue;` add `slot += 1;`. Replace `const result = findFollowMove(` … call with:

```js
      const result =
        findTrailMove(
          fromCell,
          trail[slot] ?? null,
          occupied,
          isBlocked,
          bounds,
          moverFootprint,
        ) ??
        findFollowMove(
          fromCell,
          referenceCell,
          occupied,
          isBlocked,
          bounds,
          moverFootprint,
        );
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run tests/dungeon-follow.test.mjs tests/dungeon-follow-mechanics.test.mjs`
Expected: PASS, including every pre-existing follow test (their leaders never seed a trail, so `trail` is `[]` and behavior is unchanged).

- [ ] **Step 5: Commit**

```bash
git add scripts/dungeon-follow.mjs tests/dungeon-follow.test.mjs
git commit -m "#610: followers queue along the leader's trail

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

### Task 3: Docs, version, PR

**Files:**
- Modify: `docs/architecture.md` (Party-follow prose), `module.json` (version)

- [ ] **Step 1:** Run the `update-architecture-docs` skill. No new files or imports expected, so the graph should not change; add one sentence to the Party-follow paragraph: since #610 part 2, each follower aims for its slot on the leader's reconstructed trail, falling back to chain-following.
- [ ] **Step 2:** `git fetch`, rebase on `origin/main`, bump `module.json` `version` to one patch above `origin/main`'s (never reuse).
- [ ] **Step 3:** Run the full suite: `npm test` (takes ~5 minutes; run in the background and wait). Expected: all pass.
- [ ] **Step 4:** Push, open PR with `Refs #610` and no closing keyword (the issue stays open for a live playtest of a real multi-cell drag), automerge with an explicit `--subject/--body`.
- [ ] **Step 5:** Comment on #610 with terse status (PR ref, awaiting live playtest), and remove the `in progress` label.
