# Resnap/Animation Race Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop `resnapDriftedTokens` (#141's own self-heal hook) from racing and cancelling a token's own legitimate, still-animating `token.update()` move — the confirmed root cause of AI-controlled followers stacking on the same grid cell (#87).

**Architecture:** `resnapTokenNow` (`scripts/dungeon-follow.mjs`) — the single choke point both the GM-direct and relayed resnap paths already funnel through — polls Foundry's own `token.object.animationContexts` (confirmed live: non-empty mid-slide, empty once settled) before deciding whether a correction is needed, instead of reacting to the first fractional position it sees. A module-scoped reentrancy guard stops the same token from being corrected by multiple overlapping calls at once. Zero changes to `resnapDriftedTokens` itself or to `dungeon-combat.mjs` — both are protected automatically since they already funnel through the same choke point.

**Tech Stack:** Vanilla JS (Foundry VTT ESM module), Vitest for tests.

**Spec:** docs/superpowers/specs/2026-09-30-resnap-animation-race-design.md

## Global Constraints

- Never pass an `animation`/`duration` option to any `token.update()` call anywhere in this codebase — #352/#361's history (a reverted fix that crashed Foundry's own core movement API this way) rules this out. This fix only ever *reads* Foundry's own animation state, never writes to it.
- Covers both follow-movement (`scripts/dungeon-follow.mjs`) and combat-movement (`scripts/dungeon-combat.mjs`) exposure via the shared `resnapTokenNow`/`resnapDriftedTokens` choke point — no changes to `scripts/dungeon-combat.mjs` itself are needed or in scope.
- Does not attempt to fix the separate, already-known #141 self-interruption drift symptom (a token's own move racing a *later* move of itself) — a different mechanism, out of scope here.
- Live verification against a real Foundry world is required before this ships — not just automated tests. This issue family has already had two fixes ship, pass every automated and scripted-update test, and still get reverted after failing under real native movement (#352/#361).
- Version bump: PATCH (a targeted bug fix, not a new feature or architecture change), per this repo's own CLAUDE.md.

## Review Focus

- Combat-time movement (`stepToward`/`pushTokenAway`/`strideByPosture`) relies on the exact same `resnapTokenNow` choke point as follow-movement, so it gets no dedicated `dungeon-combat.mjs`-level test — Task 1's own `resnapTokenNow`-level tests call it generically (not via `moveFollowersToward`), which is what actually proves the mechanism is invocation-path-agnostic. Task 1's "defers while animating" test states this explicitly in its own comment.
- A token that's deleted from the scene while a correction is deferred mid-poll must not throw or hang — Task 1.
- Two *different* tokens animating concurrently must each get their own independent, non-blocking correction — the reentrancy guard is keyed per-token, not global — Task 1.
- A genuinely-drifted (never-animating) token must still resnap immediately with zero added delay, exactly matching today's behavior — already covered by this file's two pre-existing `resnapTokenNow` tests, unchanged.
- The live-reported symptom itself (a follower's legitimate move getting cancelled by a racing resnap) must be provably reproducible as a *failing* test against pre-fix source and passing against the fix — Task 2, explicitly re-verified against pre-fix code by the task reviewer, the same way #181's own Task 2 test was verified (see that plan's ledger).

---

### Task 1: Poll-before-correct + reentrancy guard in `resnapTokenNow`

**Files:**
- Modify: `scripts/dungeon-follow.mjs:25` (constants), `:337-347` (`resnapTokenNow`)
- Test: `tests/dungeon-follow.test.mjs:59-63` (`makeToken`), `:783-823` (`resnapTokenNow` describe block)

**Interfaces:**
- Consumes: nothing new from other tasks.
- Produces: `makeToken({..., animationContexts})` — new optional param, defaults to `new Map()`, assembled onto a new `token.object = { animationContexts }` the fixture doesn't have today. Task 2 consumes this directly (constructs a token, then mutates its `token.object.animationContexts` and overrides `token.update` itself).
- Produces: `resnapTokenNow(sceneId, tokenId)` — same signature and same external behavior for an already-settled token (zero behavior change for the common case); now also correctly defers for a still-animating token, and de-duplicates concurrent calls for the same token id.

Read `scripts/dungeon-follow.mjs:337-402` and `tests/dungeon-follow.test.mjs:1-63` and `:783-955` yourself before starting — this brief gives you the exact code, but seeing the current file in full context matters for placement.

- [ ] **Step 1: Update `makeToken` to model a token's animation state, and update two pre-existing tests to `await` their call**

In `tests/dungeon-follow.test.mjs`, replace the current `makeToken`:

```js
function makeToken({ id, x, y, actorId, width = 1, height = 1 }) {
  const token = { id, x, y, actor: { id: actorId }, width, height };
  token.update = vi.fn(async (changes) => Object.assign(token, changes));
  return token;
}
```

with:

```js
function makeToken({
  id,
  x,
  y,
  actorId,
  width = 1,
  height = 1,
  animationContexts = new Map(),
}) {
  const token = {
    id,
    x,
    y,
    actor: { id: actorId },
    width,
    height,
    object: { animationContexts },
  };
  token.update = vi.fn(async (changes) => Object.assign(token, changes));
  return token;
}
```

Every existing caller that doesn't pass `animationContexts` gets an empty `Map` by default — "never animating," matching today's behavior exactly.

Two existing tests in this file call `resnapTokenNow`/`resnapDriftedTokens` *without* awaiting, relying on the fact that today's implementation calls `token.update()` synchronously before its first real `await`. Task 1's own new reentrancy guard (Step 3, below) makes its cleanup (`finally { resnapInFlight.delete(tokenId) }`) run only *after* that `await` resolves — and both of these two tests reuse the token id `"t-drifted"`, so a left-over guard entry from the first could silently cause the second (in a different `describe` block, running later) to skip its own correction. Fix this now, before the guard exists, so it's a no-op change against current behavior (the function is already `async`; adding `await` to an already-async call changes nothing on its own).

Change (around line 784):

```js
  it("snaps an off-grid token back to the nearest grid cell", () => {
    const token = makeToken({
      id: "t-drifted",
      x: 5.49 * GRID,
      y: 3.49 * GRID,
      actorId: "some-actor",
    });
    const scene = makeScene({ tokens: [token] });
    installFoundryStubs();
    game.scenes = { get: (id) => (id === SCENE_ID ? scene : undefined) };

    resnapTokenNow(SCENE_ID, "t-drifted");

    expect(token.update).toHaveBeenCalledTimes(1);
    expect(token.update).toHaveBeenCalledWith({ x: 5 * GRID, y: 3 * GRID });
  });
```

to:

```js
  it("snaps an off-grid token back to the nearest grid cell", async () => {
    const token = makeToken({
      id: "t-drifted",
      x: 5.49 * GRID,
      y: 3.49 * GRID,
      actorId: "some-actor",
    });
    const scene = makeScene({ tokens: [token] });
    installFoundryStubs();
    game.scenes = { get: (id) => (id === SCENE_ID ? scene : undefined) };

    await resnapTokenNow(SCENE_ID, "t-drifted");

    expect(token.update).toHaveBeenCalledTimes(1);
    expect(token.update).toHaveBeenCalledWith({ x: 5 * GRID, y: 3 * GRID });
  });
```

And change (around line 830, in the `resnapDriftedTokens` describe block):

```js
  it("snaps an off-grid token directly on a GM client, on a dungeon-run-managed scene", () => {
    const token = makeToken({
      id: "t-drifted",
      x: 5.49 * GRID,
      y: 3.49 * GRID,
      actorId: "some-actor",
    });
    const scene = makeScene({ tokens: [token] });
    installFoundryStubs({
      dungeonRuns: {
        [SCENE_ID]: { hostUserId: HOST_USER_ID, aiControlledActorIds: [] },
      },
    });
    game.scenes = { get: (id) => (id === SCENE_ID ? scene : undefined) };

    resnapDriftedTokens(token, { x: token.x, y: token.y });

    expect(token.update).toHaveBeenCalledTimes(1);
    expect(token.update).toHaveBeenCalledWith({ x: 5 * GRID, y: 3 * GRID });
    expect(requestDungeonAction).not.toHaveBeenCalled();
  });
```

to:

```js
  it("snaps an off-grid token directly on a GM client, on a dungeon-run-managed scene", async () => {
    const token = makeToken({
      id: "t-drifted",
      x: 5.49 * GRID,
      y: 3.49 * GRID,
      actorId: "some-actor",
    });
    const scene = makeScene({ tokens: [token] });
    installFoundryStubs({
      dungeonRuns: {
        [SCENE_ID]: { hostUserId: HOST_USER_ID, aiControlledActorIds: [] },
      },
    });
    game.scenes = { get: (id) => (id === SCENE_ID ? scene : undefined) };

    await resnapDriftedTokens(token, { x: token.x, y: token.y });

    expect(token.update).toHaveBeenCalledTimes(1);
    expect(token.update).toHaveBeenCalledWith({ x: 5 * GRID, y: 3 * GRID });
    expect(requestDungeonAction).not.toHaveBeenCalled();
  });
```

Leave every other existing test in both describe blocks exactly as-is — none of the others reach the `await token.update(...)` branch (they either no-op before it, or go through the relay path which doesn't call `resnapTokenNow` in-process), so they have no reentrancy-guard hazard.

- [ ] **Step 2: Write the new failing tests**

Add these four tests inside the existing `describe("resnapTokenNow (#141)", ...)` block (after the three existing `it`s, before the closing `});` at line 823):

```js
  it("defers correcting a token while it's still mid-animation, then corrects once settled (#87)", async () => {
    vi.useFakeTimers();
    const animationContexts = new Map([["move", {}]]);
    const token = makeToken({
      id: "t-animating",
      x: 5.49 * GRID,
      y: 3.49 * GRID,
      actorId: "some-actor",
      animationContexts,
    });
    const scene = makeScene({ tokens: [token] });
    installFoundryStubs();
    game.scenes = { get: (id) => (id === SCENE_ID ? scene : undefined) };

    const promise = resnapTokenNow(SCENE_ID, "t-animating");

    // Still animating -- no correction yet, even though the position is
    // currently off-grid (exactly the #87 race: a mid-flight fractional
    // position must never be judged as "drifted").
    expect(token.update).not.toHaveBeenCalled();

    // The animation genuinely finishes.
    animationContexts.clear();
    await vi.advanceTimersByTimeAsync(100);
    await promise;

    expect(token.update).toHaveBeenCalledTimes(1);
    expect(token.update).toHaveBeenCalledWith({ x: 5 * GRID, y: 3 * GRID });
    vi.useRealTimers();
  });

  it("corrects anyway once the defensive cap elapses, even if still animating (#87)", async () => {
    vi.useFakeTimers();
    const animationContexts = new Map([["move", {}]]);
    const token = makeToken({
      id: "t-stuck-animating",
      x: 5.49 * GRID,
      y: 3.49 * GRID,
      actorId: "some-actor",
      animationContexts,
    });
    const scene = makeScene({ tokens: [token] });
    installFoundryStubs();
    game.scenes = { get: (id) => (id === SCENE_ID ? scene : undefined) };

    const promise = resnapTokenNow(SCENE_ID, "t-stuck-animating");
    // animationContexts is deliberately never cleared -- simulates the
    // defensive cap's own fallback path, not the normal settle path.
    await vi.advanceTimersByTimeAsync(3100);
    await promise;

    expect(token.update).toHaveBeenCalledTimes(1);
    expect(token.update).toHaveBeenCalledWith({ x: 5 * GRID, y: 3 * GRID });
    vi.useRealTimers();
  });

  it("does not start a second correction for a token that already has one pending (#87)", async () => {
    vi.useFakeTimers();
    const animationContexts = new Map([["move", {}]]);
    const token = makeToken({
      id: "t-reentrant",
      x: 5.49 * GRID,
      y: 3.49 * GRID,
      actorId: "some-actor",
      animationContexts,
    });
    const scene = makeScene({ tokens: [token] });
    installFoundryStubs();
    game.scenes = { get: (id) => (id === SCENE_ID ? scene : undefined) };

    const first = resnapTokenNow(SCENE_ID, "t-reentrant");
    const second = resnapTokenNow(SCENE_ID, "t-reentrant");

    animationContexts.clear();
    await vi.advanceTimersByTimeAsync(100);
    await Promise.all([first, second]);

    expect(token.update).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it("corrects two different animating tokens independently, not serialized by each other (#87)", async () => {
    vi.useFakeTimers();
    const contextsA = new Map([["move", {}]]);
    const contextsB = new Map([["move", {}]]);
    const tokenA = makeToken({
      id: "t-a",
      x: 5.49 * GRID,
      y: 0,
      actorId: "actor-a",
      animationContexts: contextsA,
    });
    const tokenB = makeToken({
      id: "t-b",
      x: 2.49 * GRID,
      y: 0,
      actorId: "actor-b",
      animationContexts: contextsB,
    });
    const scene = makeScene({ tokens: [tokenA, tokenB] });
    installFoundryStubs();
    game.scenes = { get: (id) => (id === SCENE_ID ? scene : undefined) };

    const promiseA = resnapTokenNow(SCENE_ID, "t-a");
    const promiseB = resnapTokenNow(SCENE_ID, "t-b");

    // B settles well before A -- must not wait on A's own guard entry.
    contextsB.clear();
    await vi.advanceTimersByTimeAsync(100);
    await promiseB;
    expect(tokenB.update).toHaveBeenCalledTimes(1);
    expect(tokenA.update).not.toHaveBeenCalled();

    contextsA.clear();
    await vi.advanceTimersByTimeAsync(100);
    await promiseA;
    expect(tokenA.update).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it("no-ops if the token is deleted from the scene while a correction is deferred (#87)", async () => {
    vi.useFakeTimers();
    const animationContexts = new Map([["move", {}]]);
    const token = makeToken({
      id: "t-deleted-mid-wait",
      x: 5.49 * GRID,
      y: 3.49 * GRID,
      actorId: "some-actor",
      animationContexts,
    });
    const scene = makeScene({ tokens: [token] });
    installFoundryStubs();
    game.scenes = { get: (id) => (id === SCENE_ID ? scene : undefined) };

    const promise = resnapTokenNow(SCENE_ID, "t-deleted-mid-wait");

    // The token is removed from the scene before the animation settles.
    scene.tokens = [];
    animationContexts.clear();
    await vi.advanceTimersByTimeAsync(100);

    await expect(promise).resolves.not.toThrow();
    expect(token.update).not.toHaveBeenCalled();
    vi.useRealTimers();
  });
```

- [ ] **Step 3: Run tests to verify the new ones fail**

Run: `npx vitest run tests/dungeon-follow.test.mjs -t "#87"`
Expected: the five new tests FAIL (current `resnapTokenNow` has no animation-awareness or reentrancy guard at all, so it corrects immediately every time and `token.update` assertions before the animation "settles" don't match). The two tests changed in Step 1 should still PASS unchanged.

- [ ] **Step 4: Implement**

In `scripts/dungeon-follow.mjs`, add these two constants right after the existing `FOLLOW_DEBOUNCE_MS = 250;` and its following `#361` comment block (after line 40, before `const pendingByScene = new Map();`):

```js
// #87: resnapTokenNow must never read a token's position while Foundry's
// own animated slide is still interpolating it -- confirmed live
// (2026-09-30, v14.368) that a still-fractional, mid-flight position can
// get rounded back to the token's STARTING cell, silently cancelling a
// legitimate, still-in-progress move. RESNAP_POLL_MS/RESNAP_MAX_WAIT_MS
// are starting values verified against this session's own live capture
// (the redundant-write storm converged within ~150ms); tune during live
// verification if needed, not treated as final here.
const RESNAP_POLL_MS = 100;
const RESNAP_MAX_WAIT_MS = 3000;
const resnapInFlight = new Set(); // tokenId -> a correction is already pending
```

Then add this helper function right before `resnapTokenNow` (before line 337):

```js
/** Whether `token` is currently mid-flight of Foundry's own animated
 * slide -- confirmed live (2026-09-30, v14.368) that
 * `token.object.animationContexts` is a real Map, non-empty while
 * animating and empty once settled. Not in Foundry's public API docs, so
 * treated as a confirmed-live-but-undocumented signal, the same category
 * as this module's existing reliance on `_movement.method`/`waypoints`
 * (`isPositionChange`, above). Optional-chains to `undefined` if
 * `token.object` doesn't exist (an older Foundry version, a system
 * override, or a token not yet rendered on canvas) -- treated the same
 * as "not animating," a deliberate graceful degradation to the
 * immediate-correction behavior this function had before #87, rather
 * than a new failure mode. */
function isAnimating(token) {
  return (token.object?.animationContexts?.size ?? 0) > 0;
}
```

Then replace `resnapTokenNow` itself:

```js
export async function resnapTokenNow(sceneId, tokenId) {
  const scene = game.scenes.get(sceneId);
  const token = scene?.tokens.find((t) => t.id === tokenId);
  if (!token) return;
  const gridSize = scene.grid?.size ?? 100;
  const snappedX = Math.round(token.x / gridSize) * gridSize;
  const snappedY = Math.round(token.y / gridSize) * gridSize;
  if (token.x !== snappedX || token.y !== snappedY) {
    await token.update({ x: snappedX, y: snappedY });
  }
}
```

with:

```js
export async function resnapTokenNow(sceneId, tokenId) {
  // #87: a second call for a token that already has a correction pending
  // must not start a parallel poll loop -- the live capture that found
  // this bug showed 6+ overlapping resnap attempts for the same token
  // within ~150ms (both the GM-direct and relayed paths reacting
  // independently), despite this function's own prior doc comment
  // claiming no guard was needed.
  if (resnapInFlight.has(tokenId)) return;
  resnapInFlight.add(tokenId);
  try {
    const deadline = Date.now() + RESNAP_MAX_WAIT_MS;
    let scene = game.scenes.get(sceneId);
    let token = scene?.tokens.find((t) => t.id === tokenId);
    if (!token) return;
    while (isAnimating(token) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, RESNAP_POLL_MS));
      scene = game.scenes.get(sceneId);
      token = scene?.tokens.find((t) => t.id === tokenId);
      if (!token) return;
    }
    // The loop's own exit check (isAnimating false, or deadline passed)
    // and this read/decision happen in the same synchronous continuation
    // -- no `await` between them -- so a new move starting in that exact
    // gap can't get judged against a stale reading.
    const gridSize = scene.grid?.size ?? 100;
    const snappedX = Math.round(token.x / gridSize) * gridSize;
    const snappedY = Math.round(token.y / gridSize) * gridSize;
    if (token.x !== snappedX || token.y !== snappedY) {
      await token.update({ x: snappedX, y: snappedY });
    }
  } finally {
    resnapInFlight.delete(tokenId);
  }
}
```

`resnapDriftedTokens` itself needs no changes — it already funnels both its GM-direct and relayed paths through `resnapTokenNow`.

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run tests/dungeon-follow.test.mjs`
Expected: every test in the file passes, including every pre-existing one.

- [ ] **Step 6: Commit**

```bash
git add scripts/dungeon-follow.mjs tests/dungeon-follow.test.mjs
git commit -m "fix(#87): resnapTokenNow waits for Foundry's own animation to settle before correcting"
```

---

### Task 2: Regression test — a follower's in-flight move survives a racing resnap

**Files:**
- Test: `tests/dungeon-follow.test.mjs` (new `describe` block)

**Interfaces:**
- Consumes: `makeToken`'s new `animationContexts` param and `token.object.animationContexts` shape (Task 1); `resnapDriftedTokens`, `runFollowMoveNow` (both already imported at the top of this test file).
- Produces: nothing other tasks depend on.

This is the test that proves the *actual reported bug* is fixed — Task 1's own tests exercise `resnapTokenNow` in isolation; this one drives it through the real `moveFollowersToward` code path (via `runFollowMoveNow`) the way it happens live. Deliberately uses a single follower, not #181's own multi-follower chain — the race itself doesn't need a second follower to occur (chain-following is what made the *symptom* — two followers stacking — visible and reported; the underlying race is more general).

- [ ] **Step 1: Write the failing test**

Add this new `describe` block to `tests/dungeon-follow.test.mjs`, after the existing `describe("resnapDriftedTokens (#141)", ...)` block closes (after line 955):

```js
describe("moveFollowersToward + resnapDriftedTokens interaction (#87)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  // The actual live-reported bug (#87, 2026-09-30): resnapDriftedTokens
  // used to read a follower's position WHILE its own legitimate
  // moveFollowersToward move was still mid-animation, round the
  // still-fractional position back toward the follower's STARTING cell,
  // and silently cancel the move -- confirmed live via a monkeypatched
  // TokenDocument.update() call-stack capture (see #87's comment
  // history). This produced the originally-reported symptom (two
  // AI-controlled followers stacking on the same cell -- #181's own
  // chain-following is what made it visible). Reproduced here at the
  // single-follower level, since the race itself doesn't need a second
  // follower to occur.
  it("does not let resnapDriftedTokens cancel a follower's own in-flight move", async () => {
    vi.useFakeTimers();
    const leader = makeToken({ id: "t-leader", x: 3 * GRID, y: 0, actorId: LEADER_ACTOR_ID });
    const follower = makeToken({ id: "t-f", x: 0, y: 0, actorId: "actor-f" });
    // Simulates Foundry's own animated slide: the instant the real
    // moveFollowersToward move is issued, animationContexts becomes
    // non-empty and the position only partially advances toward the
    // real destination (stays fractional/off-grid) -- the exact
    // live-confirmed shape of the #87 race, not yet the final position.
    follower.update = vi.fn(async (changes) => {
      follower.object.animationContexts.set("move", {});
      follower.__destination = { x: changes.x, y: changes.y };
      follower.x = follower.x + (changes.x - follower.x) * 0.2;
      follower.y = follower.y + (changes.y - follower.y) * 0.2;
    });
    const scene = makeScene({ tokens: [leader, follower] });

    installFoundryStubs({
      dungeonRuns: {
        [SCENE_ID]: {
          hostUserId: HOST_USER_ID,
          aiControlledActorIds: ["actor-f"],
          marchingOrder: ["actor-f"],
        },
      },
    });
    game.scenes = { get: (id) => (id === SCENE_ID ? scene : undefined) };

    runFollowMoveNow(SCENE_ID);
    await vi.advanceTimersByTimeAsync(300);

    expect(follower.update).toHaveBeenCalledTimes(1);
    const destination = follower.__destination;

    // Simulate Foundry's updateToken hook firing reactively while the
    // follower is still mid-flight -- exactly the moment the pre-fix
    // code would round it back to the follower's STARTING cell and
    // cancel its own legitimate move.
    const resnapPromise = resnapDriftedTokens(follower, { x: follower.x, y: follower.y });

    // Not reverted while still animating: no second update() call yet.
    expect(follower.update).toHaveBeenCalledTimes(1);

    // The animation genuinely finishes: Foundry lands the token at its
    // real destination and animationContexts empties.
    follower.object.animationContexts.clear();
    Object.assign(follower, destination);
    await vi.advanceTimersByTimeAsync(150);
    await resnapPromise;

    // Still only the one legitimate update() call -- the deferred
    // resnap found the token already grid-aligned at its real
    // destination and correctly left it alone.
    expect(follower.update).toHaveBeenCalledTimes(1);
    expect(follower.x).toBe(destination.x);
    expect(follower.y).toBe(destination.y);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/dungeon-follow.test.mjs -t "does not let resnapDriftedTokens cancel"`
Expected: FAILS against the Task-1-fixed code too if Task 1 isn't complete yet — run this only after Task 1's Step 6 commit lands. Against Task 1's own fixed `resnapTokenNow`, this should already PASS once written, since Task 1 already implements the mechanism this test exercises. If it doesn't pass immediately, that's a real integration gap between Task 1's unit-level fix and the real `moveFollowersToward` code path — investigate before moving on, don't adjust the test to force a pass.

- [ ] **Step 3: Verify it would have failed against pre-fix code**

This is the step that actually proves this is a meaningful regression test, not just a test that happens to pass. Temporarily check out the pre-Task-1 version of `scripts/dungeon-follow.mjs` into a scratch copy (don't modify the working tree):

```bash
git show HEAD~1:scripts/dungeon-follow.mjs > /tmp/dungeon-follow-pre-fix.mjs
```

(Adjust `HEAD~1` if other commits landed in between — it must point at the commit immediately before Task 1's Step 6 commit.) Temporarily swap it in, run the new test, confirm it FAILS, then restore the real file:

```bash
cp scripts/dungeon-follow.mjs /tmp/dungeon-follow-real.mjs
cp /tmp/dungeon-follow-pre-fix.mjs scripts/dungeon-follow.mjs
npx vitest run tests/dungeon-follow.test.mjs -t "does not let resnapDriftedTokens cancel"
cp /tmp/dungeon-follow-real.mjs scripts/dungeon-follow.mjs
```

Expected: the middle command FAILS (pre-fix `resnapTokenNow` corrects immediately, calling `token.update` a second time with the follower's starting coordinates — this test's `expect(follower.update).toHaveBeenCalledTimes(1)` assertion right after the simulated `resnapDriftedTokens` call catches exactly that). Record the actual failure output in your task report — the task reviewer will re-verify this independently, the same way #181's own Task 2 test was verified this exact way.

- [ ] **Step 4: Run the full test suite**

Run: `npx vitest run`
Expected: every test passes.

- [ ] **Step 5: Commit**

```bash
git add tests/dungeon-follow.test.mjs
git commit -m "test(#87): regression test -- resnapDriftedTokens must not cancel a follower's in-flight move"
```

---

### Task 3: Version bump and live verification

**Files:**
- Modify: `module.json`

**Interfaces:**
- Consumes: nothing.
- Produces: nothing other tasks depend on.

- [ ] **Step 1: Check `origin/main`'s current version**

```bash
git fetch origin
git log origin/main -1 --oneline
grep '"version"' module.json
```

- [ ] **Step 2: Bump the version**

Bump `module.json`'s `version` field with a PATCH bump (targeted bug fix, per this repo's own CLAUDE.md) from whatever `origin/main` actually shows at execution time. Never reuse a version number.

- [ ] **Step 3: Confirm no `token.update()` call anywhere gained an animation option**

Run: `grep -n "animation" scripts/dungeon-follow.mjs scripts/dungeon-combat.mjs`
Expected: no match touches a `token.update()`/`me.update()`/`target.token.update()` call's own options object — this fix only ever reads `token.object.animationContexts`, never writes an `animation`/`duration` option, per this plan's own Global Constraints and #352/#361's history. If this grep finds one, stop and investigate before proceeding — that would mean a change slipped in outside what Tasks 1-2 specify.

- [ ] **Step 4: Run the full test suite**

Run: `npx vitest run`
Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add module.json
git commit -m "chore(#87): bump version"
```

- [ ] **Step 6: Live verification against a real Foundry world (controller-only — not for an implementer subagent)**

No automated test can confirm real Foundry animation timing behaves as this fix assumes — this issue family has already had two fixes ship, pass every automated and scripted-update test, and still get reverted after failing under real native movement (#352/#361). This step is the controller's own responsibility, coordinated live with the user via the foundry-rest skill, the same diagnostic technique this session used to find the bug in the first place:

1. Reproduce this session's exact narrow-corridor marching scenario (4 AI-controlled followers, chain-following, #181) across several follow-cycles; confirm no two followers ever land on the same cell.
2. Confirm a genuinely drifted token (a manual, unsnapped drag in Foundry's own UI) still self-heals within a reasonable time.
3. Confirm combat movement (`stepToward`/`strideByPosture` mid-fight) completes cleanly and isn't snapped back mid-animation.
4. Watch actual `updateToken` traffic during a single leader move (the same monkeypatched-`update()` capture technique used to find this bug) to confirm the redundant-write storm is gone — a small, bounded number of writes for one logical move, not 6+.
5. If steps 1-4 reveal `RESNAP_POLL_MS`/`RESNAP_MAX_WAIT_MS` need adjusting, tune them in a follow-up commit and re-verify rather than treating the values from Task 1 as final.
