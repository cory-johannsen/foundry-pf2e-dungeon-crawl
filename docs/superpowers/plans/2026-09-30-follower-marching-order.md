# Follower Marching Order Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the party leader (or GM) set a priority/queue order for AI-controlled followers in a GM-less dungeon run, and change follow-the-leader movement so each follower targets whoever is immediately ahead of it in that order instead of always targeting the leader directly — fixing the live-reproduced bug where followers pile up and never advance through a corridor too narrow for more than one of them to be "near the leader" at once.

**Architecture:** A new `marchingOrder` field on the existing per-scene run-state object, reconciled against `aiControlledActorIds` by a pure function on every follow-move cycle so it can never drop a follower or crash. `moveFollowersToward`'s existing sequential loop gets one small change: track a `referenceCell` that starts as the leader's cell and updates to each follower's own (possibly unchanged) cell after every iteration, so position 2+ naturally chains behind whoever moved just before it. A new DungeonApp tracker section lets the leader/GM reorder followers with up/down buttons, routed through the existing GM-direct-vs-relay pattern this app already uses everywhere.

**Tech Stack:** Vanilla JS (ES modules), Foundry VTT ApplicationV2/Handlebars, Vitest.

**Spec:** `docs/superpowers/specs/2026-09-30-follower-marching-order-design.md`

## Global Constraints

- GM-less (player-led) runs only — no GM-hosted-run leader concept; the feature is inert (hidden) when `state.hostUserId` is null, matching follow-the-leader's own existing scope.
- No changes to combat movement (`scripts/dungeon-combat.mjs`) — this only touches `scripts/dungeon-follow.mjs`'s between-fights following.
- `marchingOrder` persists via the existing world-scoped `dungeonRuns` Foundry setting (`scripts/module.mjs`) — no new storage mechanism.
- Every mutating action still only ever runs on a genuinely GM-privileged client, relayed via the existing `requestDungeonAction`/`DUNGEON_ACTIONS` pattern (`scripts/dungeon-remote.mjs`) for a non-GM host — never write run state directly from a non-GM client.
- Version bump (`module.json`) required before merge, per this repo's own CLAUDE.md — a minor bump (new feature, not a routine fix). Check `origin/main`'s current version at execution time; never reuse a version number.
- `aiControlledActorIds` is computed once at `createRun` and never recomputed afterward in the current codebase (confirmed by reading every reference to it) — the reconciliation logic below is real, correct defensive robustness (handles a pre-#181 run, or any future world where `aiControlledActorIds` does change), but does not correspond to an actively-exercised scenario in today's code. Don't remove it on the assumption it's dead weight; don't oversell it as fixing a live dynamic-membership bug either.

## Review Focus

- A run with zero AI-controlled followers: `effectiveMarchingOrder` must return `[]` and `moveFollowersToward`'s loop must simply not execute — no crash, no follower left dangling. Explicit test added to Task 1.
- `setMarchingOrder` called with a list that's a valid permutation of a *stale* (no-longer-current) actor set — e.g. a client with outdated info reorders actors from a run that's since changed. Since `setMarchingOrder` re-reads `getRunState` fresh and validates against its own current `aiControlledActorIds`, a stale list fails the permutation check and throws — correctly rejected, no corruption. Explicit test added to Task 1 ("throws when given a list with an unknown actor id" already covers this exact shape).
- The marching-order UI section must not render (or must render inert) for a GM-hosted run (`state.hostUserId` null) — covered by the `isGmLessRun` context gate in Task 3, verified manually (listed explicitly in Task 3's own manual verification steps, since this codebase has no automated Foundry-UI-rendering tests to add one to).
- A single AI-controlled follower (marching order of length 1) must behave identically to pre-#181 leader-direct targeting — implicitly guaranteed by the chain-following algorithm itself (a length-1 chain never reaches the "target predecessor" branch) and confirmed by Task 2's own full-file regression run, which re-executes every pre-existing single-follower test unchanged.
- **Known, accepted limitation (not fixed by this plan):** two rapid up/down clicks on the same follower before the first `setMarchingOrder` call resolves can race — the second click's own reorder computation is based on a pre-first-click snapshot, so it could produce a stale-based (but still valid) reorder, effectively "losing" one of the two clicks rather than applying both. Low severity (a re-clickable UI hiccup, not data corruption — the result is always still a valid permutation) and disproportionate to fix with real optimistic locking for this feature's scope. Documented here rather than silently ignored.

---

### Task 1: Data model — marching-order storage and reconciliation

**Files:**
- Modify: `scripts/dungeon-runner.mjs`
- Test: `tests/dungeon-runner.test.mjs`

**Interfaces:**
- Produces: `effectiveMarchingOrder(run)` — pure function, exported. `run` is whatever `getRunState` returns (an object with `aiControlledActorIds: string[]` and optionally `marchingOrder: string[]`), or `null`. Returns `string[]` — the reconciled order to actually use for a follow-move cycle.
- Produces: `setMarchingOrder(sceneId, orderedActorIds, { settingsRef } = {})` — async, exported, mirrors the existing `setObjective` pattern. Returns the new persisted run state, or `null` if the scene has no run. Throws if `orderedActorIds` isn't exactly a permutation of the run's current `aiControlledActorIds`.
- Modifies: `createRun`'s own persisted state shape gains a `marchingOrder` field, initialized as a copy of `aiControlledActorIds` in the same order.
- Consumes: this file's own existing `getRunState`, `persist`, `defaultSettingsRef`, `computeAiControlledActorIds` — all unchanged.

- [ ] **Step 1: Write failing tests for `effectiveMarchingOrder`**

Add to `tests/dungeon-runner.test.mjs` (near the existing `describe("createRun / aiControlledActorIds (#20)", ...)` block — read that block first to match its existing style):

```js
describe("effectiveMarchingOrder (#181)", () => {
  it("returns the stored marchingOrder verbatim when it already matches aiControlledActorIds", () => {
    const run = {
      aiControlledActorIds: ["a", "b", "c"],
      marchingOrder: ["b", "a", "c"],
    };
    expect(effectiveMarchingOrder(run)).toEqual(["b", "a", "c"]);
  });

  it("appends an AI-controlled actor missing from the stored order, at the end", () => {
    const run = {
      aiControlledActorIds: ["a", "b", "c"],
      marchingOrder: ["b", "a"],
    };
    expect(effectiveMarchingOrder(run)).toEqual(["b", "a", "c"]);
  });

  it("drops a stored entry no longer in aiControlledActorIds", () => {
    const run = {
      aiControlledActorIds: ["a", "c"],
      marchingOrder: ["b", "a", "c"],
    };
    expect(effectiveMarchingOrder(run)).toEqual(["a", "c"]);
  });

  it("returns an empty array for a null run", () => {
    expect(effectiveMarchingOrder(null)).toEqual([]);
  });

  it("returns an empty array when the run has no AI-controlled actors at all", () => {
    const run = { aiControlledActorIds: [], marchingOrder: [] };
    expect(effectiveMarchingOrder(run)).toEqual([]);
  });

  it("returns aiControlledActorIds verbatim when marchingOrder is missing entirely (a pre-#181 run)", () => {
    const run = { aiControlledActorIds: ["a", "b"] };
    expect(effectiveMarchingOrder(run)).toEqual(["a", "b"]);
  });
});
```

Add `effectiveMarchingOrder` to this test file's existing import from `../scripts/dungeon-runner.mjs`.

- [ ] **Step 2: Run tests, verify they fail**

Run: `npx vitest run tests/dungeon-runner.test.mjs -t "effectiveMarchingOrder"`
Expected: FAIL — `effectiveMarchingOrder` is not exported / not a function.

- [ ] **Step 3: Implement `effectiveMarchingOrder`**

In `scripts/dungeon-runner.mjs`, insert this new exported function immediately after `computeAiControlledActorIds` (after its closing `}`, before the `persist` function):

```js
/** The marching order to actually use for a follow-move cycle (#181) — the
 * run's own stored `marchingOrder`, reconciled against its CURRENT
 * `aiControlledActorIds` so a stale/out-of-sync stored value (or a run
 * created before this field existed) can never drop a follower or crash:
 * every actor still AI-controlled keeps its relative position from the
 * stored order; any AI-controlled actor missing from the stored order
 * (never explicitly ordered yet) is appended at the end, lowest priority.
 * Pure function, no Foundry globals — `run` is whatever getRunState
 * returns, or null. */
export function effectiveMarchingOrder(run) {
  const aiIds = run?.aiControlledActorIds ?? [];
  const stored = run?.marchingOrder ?? [];
  const aiSet = new Set(aiIds);
  const reconciled = stored.filter((id) => aiSet.has(id));
  const reconciledSet = new Set(reconciled);
  for (const id of aiIds) {
    if (!reconciledSet.has(id)) reconciled.push(id);
  }
  return reconciled;
}
```

- [ ] **Step 4: Run tests, verify they pass**

Run: `npx vitest run tests/dungeon-runner.test.mjs -t "effectiveMarchingOrder"`
Expected: PASS (6 tests)

- [ ] **Step 5: Write a failing test for `createRun`'s new `marchingOrder` field**

Add to the existing `describe("createRun / aiControlledActorIds (#20)", ...)` block in `tests/dungeon-runner.test.mjs` — reuse that block's own existing `partyOwnershipRef` stub/fixture pattern rather than inventing a new shape; the test needs at minimum two offline-owned party actors so there's a real order to check:

```js
it("initializes marchingOrder as a copy of aiControlledActorIds, in the same order (#181)", async () => {
  const settingsRef = makeSettingsStub();
  // Reuse this describe block's own existing partyOwnershipRef fixture
  // (whatever it already uses to produce >=2 offline-owned actors) —
  // do not introduce a second, differently-shaped stub.
  await createRun(
    { sceneId: "scene-1", roomCount: 6 },
    { settingsRef, partyOwnershipRef },
  );
  const state = getRunState("scene-1", { settingsRef });
  expect(state.marchingOrder).toEqual(state.aiControlledActorIds);
});
```

- [ ] **Step 6: Run test, verify it fails**

Run: `npx vitest run tests/dungeon-runner.test.mjs -t "initializes marchingOrder"`
Expected: FAIL — `state.marchingOrder` is `undefined`.

- [ ] **Step 7: Implement — add `marchingOrder` to `createRun`'s state**

In `scripts/dungeon-runner.mjs`, in `createRun`, change:

```js
    aiControlledActorIds: computeAiControlledActorIds(partyOwnershipRef),
  };
  return persist(sceneId, state, settingsRef);
```

to:

```js
    aiControlledActorIds,
    // #181: the priority/queue order AI-controlled followers use for
    // follow-the-leader chain-following (dungeon-follow.mjs) — starts as
    // a copy of aiControlledActorIds; setMarchingOrder is the only other
    // writer.
    marchingOrder: [...aiControlledActorIds],
  };
  return persist(sceneId, state, settingsRef);
```

and add this line immediately before `const state = {`:

```js
  const aiControlledActorIds = computeAiControlledActorIds(partyOwnershipRef);
```

(This hoists the previously-inline call so both `aiControlledActorIds` and `marchingOrder` reference the same computed array without calling `computeAiControlledActorIds` twice.)

- [ ] **Step 8: Run test, verify it passes**

Run: `npx vitest run tests/dungeon-runner.test.mjs -t "initializes marchingOrder"`
Expected: PASS

- [ ] **Step 9: Write failing tests for `setMarchingOrder`**

Add to `tests/dungeon-runner.test.mjs`:

```js
describe("setMarchingOrder (#181)", () => {
  async function seedRunWithThreeFollowers(settingsRef) {
    await createRun(
      { sceneId: "scene-1", roomCount: 6 },
      {
        settingsRef,
        partyOwnershipRef: {
          partyActors: () => [
            { id: "actor-a", ownership: { "user-a": 3 } },
            { id: "actor-b", ownership: { "user-b": 3 } },
            { id: "actor-c", ownership: { "user-c": 3 } },
          ],
          isUserActive: () => false,
          isUserGm: () => false,
        },
      },
    );
  }

  it("persists a valid reordering", async () => {
    const settingsRef = makeSettingsStub();
    await seedRunWithThreeFollowers(settingsRef);
    await setMarchingOrder("scene-1", ["actor-c", "actor-a", "actor-b"], { settingsRef });
    const state = getRunState("scene-1", { settingsRef });
    expect(state.marchingOrder).toEqual(["actor-c", "actor-a", "actor-b"]);
  });

  it("returns null for a scene with no run", async () => {
    const settingsRef = makeSettingsStub();
    const result = await setMarchingOrder("nothing-here", ["a"], { settingsRef });
    expect(result).toBeNull();
  });

  it("throws when given a list that's missing an actor", async () => {
    const settingsRef = makeSettingsStub();
    await seedRunWithThreeFollowers(settingsRef);
    await expect(
      setMarchingOrder("scene-1", ["actor-a", "actor-b"], { settingsRef }),
    ).rejects.toThrow();
  });

  it("throws when given a list with a duplicate", async () => {
    const settingsRef = makeSettingsStub();
    await seedRunWithThreeFollowers(settingsRef);
    await expect(
      setMarchingOrder("scene-1", ["actor-a", "actor-a", "actor-b"], { settingsRef }),
    ).rejects.toThrow();
  });

  it("throws when given a list with an unknown actor id", async () => {
    const settingsRef = makeSettingsStub();
    await seedRunWithThreeFollowers(settingsRef);
    await expect(
      setMarchingOrder("scene-1", ["actor-a", "actor-b", "actor-nonexistent"], { settingsRef }),
    ).rejects.toThrow();
  });
});
```

Add `setMarchingOrder` to this test file's existing import from `../scripts/dungeon-runner.mjs`.

- [ ] **Step 10: Run tests, verify they fail**

Run: `npx vitest run tests/dungeon-runner.test.mjs -t "setMarchingOrder"`
Expected: FAIL — `setMarchingOrder` is not exported / not a function.

- [ ] **Step 11: Implement `setMarchingOrder`**

In `scripts/dungeon-runner.mjs`, add this new exported function immediately after `setObjective`:

```js
/**
 * Sets this run's own marching-order priority sequence for its
 * AI-controlled followers (#181) — `orderedActorIds` must be exactly a
 * permutation of the run's CURRENT `aiControlledActorIds` (same actors,
 * no duplicates, nothing missing); throws otherwise so a caller bug
 * surfaces immediately instead of silently corrupting run state. A no-op
 * (returns null) if the scene has no run.
 */
export async function setMarchingOrder(
  sceneId,
  orderedActorIds,
  { settingsRef = defaultSettingsRef() } = {},
) {
  const state = getRunState(sceneId, { settingsRef });
  if (!state) return null;
  const current = new Set(state.aiControlledActorIds ?? []);
  const given = new Set(orderedActorIds);
  const isValidPermutation =
    orderedActorIds.length === current.size &&
    given.size === orderedActorIds.length &&
    [...current].every((id) => given.has(id));
  if (!isValidPermutation) {
    throw new Error(
      "pf2e-dungeon-crawl | setMarchingOrder: orderedActorIds must be exactly a permutation of the run's current aiControlledActorIds",
    );
  }
  const newState = { ...state, marchingOrder: [...orderedActorIds] };
  await persist(sceneId, newState, settingsRef);
  return newState;
}
```

- [ ] **Step 12: Run tests, verify they pass**

Run: `npx vitest run tests/dungeon-runner.test.mjs -t "setMarchingOrder"`
Expected: PASS (5 tests)

- [ ] **Step 13: Run the full `dungeon-runner.test.mjs` file**

Run: `npx vitest run tests/dungeon-runner.test.mjs`
Expected: every test passes, including every pre-existing one.

- [ ] **Step 14: Commit**

```bash
git add scripts/dungeon-runner.mjs tests/dungeon-runner.test.mjs
git commit -m "feat(#181): add marching-order data model (effectiveMarchingOrder, setMarchingOrder)"
```

---

### Task 2: Chain-following algorithm

**Files:**
- Modify: `scripts/dungeon-follow.mjs`
- Test: `tests/dungeon-follow.test.mjs`

**Interfaces:**
- Consumes: `effectiveMarchingOrder(run)` from Task 1 (`scripts/dungeon-runner.mjs`).
- `moveFollowersToward(scene, leaderToken, aiControlledIds)`'s own signature is UNCHANGED — its three callers now pass the marching-order-reconciled array instead of the raw `run.aiControlledActorIds`.

- [ ] **Step 1: Write a failing integration test for chain-following**

Add to `tests/dungeon-follow.test.mjs`, as a new describe block. Read this file's own existing `installFoundryStubs`/`makeToken`/`makeScene`/wall-blocking conventions first (see the existing test `"falls back to another free adjacent cell when the single closest one is a walled-off dead pocket"` — if that test is actually in `dungeon-follow-mechanics.test.mjs` rather than this file, use whatever wall/`isBlocked` construction THIS file's own existing tests already use instead, e.g. `makeDoorWall` or a raw walls array passed to `makeScene`):

```js
describe("moveFollowersToward chain-following (#181)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  // The actual live-reproduced bug this fixes: in a 1-wide corridor, every
  // follower searching for a cell "near the leader" can only ever find one
  // reachable candidate (whoever's already closest occupies the only
  // passage cell) — the rest jitter in place forever. Chain-following
  // fixes this by having each follower target whoever is immediately
  // ahead of it in marching order instead of the leader directly, so they
  // naturally queue up single-file.
  it("queues followers single-file through a 1-wide corridor, in marching order", async () => {
    vi.useFakeTimers();
    const leader = makeToken({
      id: "t-leader",
      x: 0,
      y: 10 * GRID,
      actorId: LEADER_ACTOR_ID,
    });
    const followerA = makeToken({ id: "t-a", x: 0, y: 0, actorId: "actor-a" });
    const followerB = makeToken({ id: "t-b", x: 0, y: 0, actorId: "actor-b" });
    const followerC = makeToken({ id: "t-c", x: 0, y: 0, actorId: "actor-c" });
    const scene = makeScene({ tokens: [leader, followerA, followerB, followerC] });
    // Force single-file movement: block every edge that isn't strictly
    // along column gx=0 (adapt to this file's own existing isBlocked/wall
    // wiring — movementBlockedEdges in dungeon-follow.mjs is what actually
    // consumes scene.walls via blockedEdgesFromWalls, so the walls array
    // passed to makeScene needs two long parallel walls flanking x=0 the
    // whole way from y=0 to y=10*GRID).
    scene.walls.contents = [
      { move: 20, door: 0, c: [-GRID / 2, -GRID, -GRID / 2, 11 * GRID] },
      { move: 20, door: 0, c: [GRID / 2, -GRID, GRID / 2, 11 * GRID] },
    ];
    globalThis.CONST = {
      WALL_MOVEMENT_TYPES: { NONE: 0, NORMAL: 20 },
      WALL_DOOR_TYPES: { NONE: 0, DOOR: 1, SECRET: 2 },
      WALL_DOOR_STATES: { CLOSED: 0, OPEN: 1, LOCKED: 2 },
    };

    installFoundryStubs({
      dungeonRuns: {
        [SCENE_ID]: {
          hostUserId: HOST_USER_ID,
          aiControlledActorIds: ["actor-a", "actor-b", "actor-c"],
          marchingOrder: ["actor-a", "actor-b", "actor-c"],
        },
      },
    });
    game.scenes = { get: (id) => (id === SCENE_ID ? scene : undefined) };

    // Several follow-cycles, mirroring a real leader advancing repeatedly.
    for (let i = 0; i < 4; i += 1) {
      runFollowMoveNow(SCENE_ID);
      await vi.advanceTimersByTimeAsync(300);
    }

    // All three made real progress toward the leader (not stuck at y=0),
    // and critically, in marching order: A closest to the leader, then B,
    // then C behind B.
    expect(followerA.y).toBeGreaterThan(0);
    expect(followerB.y).toBeGreaterThan(0);
    expect(followerC.y).toBeGreaterThan(0);
    expect(followerA.y).toBeGreaterThanOrEqual(followerB.y);
    expect(followerB.y).toBeGreaterThanOrEqual(followerC.y);
  });

  // Review Focus: zero AI-controlled followers must not crash.
  it("does nothing when there are no AI-controlled followers", async () => {
    vi.useFakeTimers();
    const leader = makeToken({ id: "t-leader", x: 0, y: 0, actorId: LEADER_ACTOR_ID });
    const scene = makeScene({ tokens: [leader] });
    installFoundryStubs({
      dungeonRuns: {
        [SCENE_ID]: { hostUserId: HOST_USER_ID, aiControlledActorIds: [], marchingOrder: [] },
      },
    });
    game.scenes = { get: (id) => (id === SCENE_ID ? scene : undefined) };

    expect(() => runFollowMoveNow(SCENE_ID)).not.toThrow();
    await vi.advanceTimersByTimeAsync(300);
  });
});
```

- [ ] **Step 2: Run the new tests, verify the first one fails against current code**

Run: `npx vitest run tests/dungeon-follow.test.mjs -t "chain-following"`
Expected: the "queues followers single-file" test FAILS (`followerB.y`/`followerC.y` stay at or near 0, since today every follower searches near the leader directly and only the closest ever finds a route past the others). The "does nothing when there are no AI-controlled followers" test should already PASS (it's a pre-existing safe case, included here as a Review Focus regression guard, not a new behavior).

- [ ] **Step 3: Implement chain-following in `moveFollowersToward`**

In `scripts/dungeon-follow.mjs`, change (inside `moveFollowersToward`):

```js
    const leaderCell = tokenCell(leaderToken, gridSize);
    const occupied = scene.tokens.map((t) => footprint(t, gridSize));

    for (const actorId of aiControlledIds) {
```

to:

```js
    const leaderCell = tokenCell(leaderToken, gridSize);
    const occupied = scene.tokens.map((t) => footprint(t, gridSize));

    // #181: chain-following — the first follower in marching order
    // targets the leader, exactly as before; every follower after it
    // targets whoever is immediately ahead of it in the order, using that
    // predecessor's CURRENT cell (updated below after each iteration) —
    // not the leader directly. This is what actually lets followers queue
    // single-file through a corridor too narrow for more than one of them
    // to be "near the leader" at once, instead of every follower
    // independently failing to path past whoever's already closest.
    let referenceCell = leaderCell;
    for (const actorId of aiControlledIds) {
```

and change:

```js
      const result = findFollowMove(
        fromCell,
        leaderCell,
        occupied,
        isBlocked,
        bounds,
        moverFootprint,
      );
      if (result.status === "already-near" || result.status === "no-route") {
        if (myFootprint) occupied.push(myFootprint);
        if (result.status === "no-route") {
          console.warn(
            `${MODULE_ID} | dungeon-follow: no route for actor ${actorId} to reach the leader.`,
          );
        }
        continue;
      }
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
```

to:

```js
      const result = findFollowMove(
        fromCell,
        referenceCell,
        occupied,
        isBlocked,
        bounds,
        moverFootprint,
      );
      if (result.status === "already-near" || result.status === "no-route") {
        if (myFootprint) occupied.push(myFootprint);
        if (result.status === "no-route") {
          console.warn(
            `${MODULE_ID} | dungeon-follow: no route for actor ${actorId} to reach the leader.`,
          );
        }
        // #181: this follower didn't move — the next one in the chain
        // still targets wherever it currently is.
        referenceCell = fromCell;
        continue;
      }
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
      referenceCell = result.to;
    }
```

- [ ] **Step 4: Update the three callers to pass the marching-order-reconciled list**

In `scripts/dungeon-follow.mjs`, change:

```js
import { getRunState } from "./dungeon-runner.mjs";
```

to:

```js
import { getRunState, effectiveMarchingOrder } from "./dungeon-runner.mjs";
```

Then, in each of `runFollowMoveNow`, `followLeaderIfDue`, and `followLeaderOnDoorOpened`, change the line:

```js
  const aiControlledIds = run?.aiControlledActorIds ?? [];
```

to:

```js
  const aiControlledIds = effectiveMarchingOrder(run);
```

These three call sites are not textually identical in their surrounding lines — each needs its own targeted edit. Verify with `grep -n "aiControlledActorIds ?? \[\]" scripts/dungeon-follow.mjs` before and after: it should find 3 matches before this step and 0 after.

- [ ] **Step 5: Run the new tests, verify they pass**

Run: `npx vitest run tests/dungeon-follow.test.mjs -t "chain-following"`
Expected: PASS (2 tests)

- [ ] **Step 6: Run the full `dungeon-follow.test.mjs` and `dungeon-follow-mechanics.test.mjs` files**

Run: `npx vitest run tests/dungeon-follow.test.mjs tests/dungeon-follow-mechanics.test.mjs`
Expected: every test passes, including every pre-existing one — in particular, every existing single-follower test still passes unchanged, since a marching order of length 1 never reaches the "target predecessor" branch (`referenceCell` starts as `leaderCell` and there's no second follower to ever see it change).

- [ ] **Step 7: Run the full project test suite**

Run: `npx vitest run`
Expected: all tests pass.

- [ ] **Step 8: Commit**

```bash
git add scripts/dungeon-follow.mjs tests/dungeon-follow.test.mjs
git commit -m "feat(#181): chain-following -- followers queue behind whoever's ahead of them in marching order"
```

---

### Task 3: UI, GM-less relay wiring, and version bump

**Files:**
- Modify: `scripts/ui/dungeon-app.mjs`
- Modify: `templates/dungeon-tracker.hbs`
- Modify: `scripts/dungeon-remote.mjs`
- Modify: `lang/en.json`
- Modify: `module.json`

**Interfaces:**
- Consumes: `effectiveMarchingOrder`, `setMarchingOrder` (Task 1, `scripts/dungeon-runner.mjs`).
- Consumes: `requestDungeonAction` (`scripts/dungeon-remote.mjs`, already imported in `dungeon-app.mjs`).

This task has no new automated tests — Foundry ApplicationV2 rendering and Handlebars templates are never unit-tested anywhere in this codebase (confirmed: no test file renders an actual `.hbs` template, and `dungeon-app.mjs`'s own existing action handlers have no dedicated test file either). Verification is manual, described in Step 6.

- [ ] **Step 1: Add `setMarchingOrder` to the GM-less relay's action table**

In `scripts/dungeon-remote.mjs`, change:

```js
import { getRunState, findActiveHostedRun } from "./dungeon-runner.mjs";
```

to:

```js
import { getRunState, findActiveHostedRun, setMarchingOrder } from "./dungeon-runner.mjs";
```

Then add a new entry to `DUNGEON_ACTIONS` (after the existing `resnapToken` entry):

```js
  // #181: a non-GM host reordering their own AI-controlled followers.
  setMarchingOrder: (args) =>
    setMarchingOrder(args.sceneId, args.orderedActorIds),
```

No new authorization code is needed — `isAuthorizedRequest` (`scripts/dungeon-permissions.mjs`) already requires `requestingUserId === run.hostUserId` for every action except `startRun`, which already covers this one correctly.

- [ ] **Step 2: Add marching-order data to `DungeonApp`'s context**

In `scripts/ui/dungeon-app.mjs`, find the existing import from `../dungeon-runner.mjs` (the one that includes `setObjective`) and add `effectiveMarchingOrder` and `setMarchingOrder` to it.

In `_prepareContext`, immediately before the final `return { hasScene: true, hasRun: true, ... }` statement, add:

```js
    const marchingOrderIds = effectiveMarchingOrder(state);
    const marchingOrder = marchingOrderIds.map((actorId, index) => ({
      actorId,
      name: game.actors.get(actorId)?.name ?? "?",
      isFirst: index === 0,
      isLast: index === marchingOrderIds.length - 1,
    }));
```

Then add these two fields inside that returned object (alongside the existing `partyMembers` field):

```js
      // #181: only meaningful for a GM-less (player-led) run — follow-
      // the-leader itself is inactive otherwise (state.hostUserId null),
      // so there's no leader to march behind.
      isGmLessRun: !!state.hostUserId,
      marchingOrder,
```

- [ ] **Step 3: Add the action handlers**

In `scripts/ui/dungeon-app.mjs`, add two new static methods inside the `DungeonApp` class (near `#onClaimTreasure`):

```js
  /**
   * Moves one AI-controlled follower earlier in the run's own marching
   * order (#181) — swaps it with whoever's currently just ahead of it. A
   * no-op if it's already first. Routed the same isGM-direct-vs-relayed
   * way every other mutating action in this app already is.
   */
  static async #onMoveMarchingOrderUp(event, target) {
    const sceneId = canvas?.scene?.id;
    const actorId = target?.dataset?.actorId;
    if (!sceneId || !actorId) return;
    const state = getRunState(sceneId);
    if (!state) return;
    const order = effectiveMarchingOrder(state);
    const index = order.indexOf(actorId);
    if (index <= 0) return;
    const reordered = [...order];
    [reordered[index - 1], reordered[index]] = [reordered[index], reordered[index - 1]];
    if (game.user.isGM) {
      await setMarchingOrder(sceneId, reordered);
    } else {
      await requestDungeonAction("setMarchingOrder", {
        sceneId,
        orderedActorIds: reordered,
      });
    }
    this.render();
  }

  /**
   * Moves one AI-controlled follower later in the run's own marching
   * order (#181) — the mirror of #onMoveMarchingOrderUp.
   */
  static async #onMoveMarchingOrderDown(event, target) {
    const sceneId = canvas?.scene?.id;
    const actorId = target?.dataset?.actorId;
    if (!sceneId || !actorId) return;
    const state = getRunState(sceneId);
    if (!state) return;
    const order = effectiveMarchingOrder(state);
    const index = order.indexOf(actorId);
    if (index === -1 || index >= order.length - 1) return;
    const reordered = [...order];
    [reordered[index], reordered[index + 1]] = [reordered[index + 1], reordered[index]];
    if (game.user.isGM) {
      await setMarchingOrder(sceneId, reordered);
    } else {
      await requestDungeonAction("setMarchingOrder", {
        sceneId,
        orderedActorIds: reordered,
      });
    }
    this.render();
  }
```

- [ ] **Step 4: Wire the new actions into `DEFAULT_OPTIONS.actions`**

In `scripts/ui/dungeon-app.mjs`, add to the existing `actions: { ... }` object inside `static DEFAULT_OPTIONS`:

```js
      moveMarchingOrderUp: DungeonApp.#onMoveMarchingOrderUp,
      moveMarchingOrderDown: DungeonApp.#onMoveMarchingOrderDown,
```

- [ ] **Step 5: Add the template section and localization string**

In `lang/en.json`, find the `"PF2EDC"` → `"Dungeon"` object (near existing keys like `"Narrative"`) and add:

```json
"MarchingOrder": {
  "Title": "Marching Order"
},
```

(Match this file's own existing nesting/comma style exactly — read the surrounding `"Dungeon"` object first.)

In `templates/dungeon-tracker.hbs`, add a new section gated on `isGmLessRun` and `interactive` — insert it right after the existing `{{#if objective}}...{{/if}}` block near the top of the template (marching order is a similarly run-wide, always-relevant-once-a-run-exists concern, not tied to any one room kind):

```handlebars
{{#if isGmLessRun}}
  {{#if interactive}}
    <div class="pf2edc-dungeon__marching-order">
      <h3>{{localize "PF2EDC.Dungeon.MarchingOrder.Title"}}</h3>
      <ol>
        {{#each marchingOrder}}
          <li>
            {{this.name}}
            <button
              type="button"
              data-action="moveMarchingOrderUp"
              data-actor-id="{{this.actorId}}"
              {{#if this.isFirst}}disabled{{/if}}
            >&uarr;</button>
            <button
              type="button"
              data-action="moveMarchingOrderDown"
              data-actor-id="{{this.actorId}}"
              {{#if this.isLast}}disabled{{/if}}
            >&darr;</button>
          </li>
        {{/each}}
      </ol>
    </div>
  {{/if}}
{{/if}}
```

- [ ] **Step 6: Manual verification against a real Foundry world**

No automated test covers Foundry UI rendering in this codebase — verify live instead:

1. Start (or use an existing) GM-less dungeon run with at least 2 AI-controlled followers.
2. Open the DungeonApp tracker as the host (or GM). Confirm the new "Marching Order" section lists the AI-controlled followers by name.
3. Click an up/down arrow; confirm the list reorders and the change persists across a re-render (close and reopen the tracker, or reload the page).
4. As a DIFFERENT connected client that is neither the host nor GM, confirm the section is absent.
5. On a run where `hostUserId` is null (a normal GM-hosted run), confirm the section is absent even for the GM (Review Focus item: `isGmLessRun` gate).
6. Walk the leader through a narrow corridor with 3+ AI-controlled followers in a deliberately chosen order; confirm they queue up in that order — the actual feature payoff, the same scenario Task 2's automated test already covers at the pure-logic level, now confirmed end-to-end live.
7. Final-review finding (#365): with the party mid-transit through a 1-wide corridor, click an up/down arrow to reorder two followers. `findFollowMove`'s pathfinding is token-occupancy-blind (pre-existing, not introduced by this feature — see `dungeon-follow.mjs`'s chain-following comment), so this can briefly send a follower's path through another token's square, including the leader's. Confirm this is the worst observed symptom (a follower settles back into correct order within a cycle or two) and not something worse (a crash, a permanently stuck follower, or a follower leaving the corridor's bounds).

- [ ] **Step 7: Bump the module version**

Check `origin/main`'s current version first (it may have moved since this plan was written):

```bash
git fetch origin
git log origin/main -1 --oneline
grep '"version"' module.json
```

Bump `module.json`'s `version` field with a MINOR bump (new feature, not a routine fix, per this repo's own CLAUDE.md) from whatever `origin/main` actually shows at execution time. Never reuse a version number.

- [ ] **Step 8: Run the full project test suite**

Run: `npx vitest run`
Expected: all tests pass.

- [ ] **Step 9: Commit**

```bash
git add scripts/ui/dungeon-app.mjs templates/dungeon-tracker.hbs scripts/dungeon-remote.mjs lang/en.json module.json
git commit -m "feat(#181): marching-order UI in the DungeonApp tracker, GM-less relay wiring, version bump"
```
