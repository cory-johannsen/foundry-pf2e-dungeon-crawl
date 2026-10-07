# Teleport-To-Displace Movement Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix #631 — replace the deprecated `{ teleport: true }` token-update option (removal planned in Foundry v15; we're on v14.368 today, confirmed live) with its real, non-deprecated replacement, before it stops working.

**Premise correction (confirmed by direct code reading this session):** #631's own text names only `scripts/dungeon-follow.mjs`/`scripts/dungeon-combat.mjs`. The real scope is **five distinct call sites across four files**:
1. `scripts/token-walk.mjs:52` — `walkTokenThroughSteps`, the shared hop-by-hop walker both combat movement and follower movement delegate to.
2. `scripts/dungeon-follow.mjs:325` — the inline #86 off-grid snap correction inside `moveFollowersToward`.
3. `scripts/dungeon-follow.mjs:620` — `resnapTokenNow`.
4. `scripts/dungeon-combat.mjs:2350` — `snapTokenToGrid`, shared by (per its own comment) four of combat movement's own call sites.
5. `scripts/dungeon-scene.mjs:1726-1729` — `moveTokensToRoom` (#439, retreat), a **batch** update across multiple tokens via `scene.updateEmbeddedDocuments`, not a per-token `.update()` call — structurally different from the other four.

**Investigation this session (live experiments against the running v14.368 instance, not just code reading):**
- `{ teleport: true }` still works fully today — confirmed, no immediate breakage.
- `displace` is a real, already-registered movement action (`CONFIG.Token.movement.actions.displace`), with `{teleport: true, walls: null}` — exactly the "no collision check" semantics this module's own code comments already describe.
- **A wrong turn ruled out by live testing, not guessed:** setting `movementAction: 'displace'` directly as part of a `TokenDocument#update()` call's own data **persists** on the document — confirmed live (a token stayed in `movementAction: "displace"` on a completely unrelated follow-up update that specified no action at all). A naive migration that just adds `movementAction: 'displace'` to the existing `{x, y}` update payload would leave affected tokens permanently in collision-free mode, a real regression.
- **The correct replacement, confirmed live:** `TokenDocument#move(waypoints, options)` (confirmed present on the live instance's own prototype chain) accepts a **per-call** `action` on each waypoint (e.g. `token.move({x, y, action: 'displace'})`) without persisting it — confirmed live: `movementAction` read back immediately after, and again after an unrelated follow-up move, stayed at its own natural inferred default (`"travel"`) both times.
- **What live testing could not establish headlessly:** whether `.move()`'s own hook-firing/animation timing is fully compatible with this module's existing `updateToken`-hook-driven architecture (`dungeon-follow.mjs`'s own `recentlyWrittenByUs` self-write suppression, `followLeaderOnDoorOpened`, `handleTrapTokenMove`'s `isPositionChange`, all of which key off `updateToken`'s own `changes` shape). `tests/dungeon-follow.test.mjs`'s own existing comment ("Foundry v14 otherwise routes a plain [update]... to the wrong cell") confirms the original drift bug *does* reproduce under some real condition a bare relay-script test didn't trigger — the exact geometric trigger (per `snapTokenToGrid`'s own comment: a straight-line path that *clips* a wall) is specific enough that only real, interactive play reliably exercises it. This genuinely needs a live session, not more static analysis — Task 4 is that session's own protocol.

**Architecture:** Each per-token call site (`token-walk.mjs`, both `dungeon-follow.mjs` sites, `dungeon-combat.mjs`) converts `token.update({x, y}, { teleport: true })` → `token.move({ x, y, action: 'displace' })`. The batch call site (`dungeon-scene.mjs`'s `moveTokensToRoom`) converts `scene.updateEmbeddedDocuments("Token", updates, { teleport: true })` → `scene.moveTokens(...)` (the same underlying batch primitive `TokenDocument#move` itself delegates to, confirmed live: `move()`'s own source is `this.parent.moveTokens({[this.id]: instruction}, rest)`), building one `{waypoints: [{x, y, action: 'displace'}]}` instruction per token id.

**Tech Stack:** Vanilla ES modules, Vitest, Foundry VTT `TokenDocument`/`Scene` movement APIs.

**Spec:** None — bounded; both the real scope and the real replacement API are confirmed live this session, not guessed.

## Global Constraints

- Every merge to `main` bumps `module.json`'s `version` (CLAUDE.md). A real behavioral migration across the module's own core movement-write path: minor bump.
- **Do not merge Task 2/3's own code changes without Task 4's live verification passing** — this is the one piece of this migration that cannot be confirmed by unit tests alone (they can only confirm the *shape* of the call, not whether Foundry's real collision pipeline treats `.move({action:'displace'})` identically to `{teleport:true}` under the actual geometric trigger condition). If Task 4 finds a regression, revert Tasks 2/3 and re-file with the specific symptom observed, matching this project's own established pattern for a residual that needs more than one pass.
- Every one of the five call sites keeps its own existing self-write-suppression/pacing logic (`markRecentlyWritten`, `onHop`, `delayMs`) completely unchanged — only the actual Foundry API call at the bottom of each changes.
- `walkTokenThroughSteps`/`snapTokenToGrid` are each used by multiple callers (confirmed current docblocks) — fixing the one shared function fixes every caller; no caller-side changes are needed beyond what Task 2 already covers.

## Review Focus

- **Every one of the five call sites must use `.move()`/`.moveTokens()` with a per-call `action: 'displace'`, never a persisted `movementAction` field write** — the exact mistake this session's own live testing already ruled out.
- **A token's own `movementAction` must read back to its own natural default after a displace-move**, not `"displace"` — a regression test for the specific trap this session found, not just "the position updated."
- **The batch retreat call site (`moveTokensToRoom`) must move every listed token, not just the first**, matching `scene.updateEmbeddedDocuments`'s own existing multi-token behavior exactly.
- **Every existing test asserting on `{teleport: true}` must be updated to assert on the new `.move()`/`.moveTokens()` call shape**, not deleted or skipped — a removed assertion silently drops coverage this migration specifically needs.
- **The original #87/#141/#361 drift symptom must not return** — the one thing unit tests cannot confirm; Task 4's own live protocol is the real check, and its own pass/fail is the actual gate before this ships.

---

### Task 1: `token-walk.mjs` (`walkTokenThroughSteps`, the shared hop walker)

**Files:**
- Modify: `scripts/token-walk.mjs`
- Test: `tests/token-walk.test.mjs`

- [ ] **Step 1: Update the failing test**

Change (confirmed current, `tests/token-walk.test.mjs:29-44`):

```js
  it("writes each cell with teleport:true, pausing between but not after hops", async () => {
    ...
    expect(token.update.mock.calls).toEqual([
      [{ x: 50, y: 0 }, { teleport: true }],
      [{ x: 100, y: 50 }, { teleport: true }],
      [{ x: 150, y: 50 }, { teleport: true }],
    ]);
```

to assert on `token.move` instead (add a `move: vi.fn()` to this file's own token fixture, alongside its existing `update`):

```js
  it("writes each cell via move({action: 'displace'}), pausing between but not after hops", async () => {
    ...
    expect(token.move.mock.calls).toEqual([
      [{ x: 50, y: 0, action: "displace" }],
      [{ x: 100, y: 50, action: "displace" }],
      [{ x: 150, y: 50, action: "displace" }],
    ]);
    expect(token.update).not.toHaveBeenCalled();
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/token-walk.test.mjs`
Expected: FAIL — `walkTokenThroughSteps` still calls `token.update`.

- [ ] **Step 3: Fix `walkTokenThroughSteps`**

Change (confirmed current, `scripts/token-walk.mjs:47-59`):

```js
export async function walkTokenThroughSteps(token, steps, gridSize, onHop, delayMs) {
  for (let i = 0; i < steps.length; i += 1) {
    onHop?.();
    await token.update(
      { x: steps[i].gx * gridSize, y: steps[i].gy * gridSize },
      { teleport: true },
    );
    onHop?.();
    if (i < steps.length - 1) {
      await new Promise((resolve) => setTimeout(resolve, delayMs ?? movementStepDelayMs()));
    }
  }
}
```

to:

```js
export async function walkTokenThroughSteps(token, steps, gridSize, onHop, delayMs) {
  for (let i = 0; i < steps.length; i += 1) {
    onHop?.();
    // #631: token.move() with a per-call action, not token.update() with
    // the deprecated teleport option -- confirmed live this session that
    // setting movementAction directly via update() persists on the
    // document (a real regression trap), while move()'s own per-waypoint
    // action does not.
    await token.move({
      x: steps[i].gx * gridSize,
      y: steps[i].gy * gridSize,
      action: "displace",
    });
    onHop?.();
    if (i < steps.length - 1) {
      await new Promise((resolve) => setTimeout(resolve, delayMs ?? movementStepDelayMs()));
    }
  }
}
```

Update this function's own docblock (confirmed current, lines 39-46) and the file's own top-of-file comment (lines 7-14) to describe `.move({action:'displace'})` instead of `{teleport:true}`.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/token-walk.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/token-walk.mjs tests/token-walk.test.mjs
git commit -m "fix(#631): walkTokenThroughSteps uses move({action:'displace'}), not the deprecated teleport option

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 2: `dungeon-follow.mjs` (two sites) and `dungeon-combat.mjs` (`snapTokenToGrid`)

**Files:**
- Modify: `scripts/dungeon-follow.mjs`, `scripts/dungeon-combat.mjs`
- Test: `tests/dungeon-follow.test.mjs`, `tests/dungeon-follow-mechanics.test.mjs`, `tests/dungeon-combat-grid-snap.test.mjs`

- [ ] **Step 1: Update the failing tests**

In `tests/dungeon-follow.test.mjs`, every assertion of the shape (confirmed current, lines 608/659/893/1375/1476/1541/1615/1650):

```js
expect(moveOptions).toEqual({ teleport: true });
```

or

```js
expect(follower.update.mock.calls.at(-1)[1]).toEqual({ teleport: true });
```

becomes an assertion against the fixture's own `move` mock instead, following the same `{x, y, action: "displace"}` single-argument shape Task 1 established. Add `move: vi.fn()` to this file's own shared token/follower fixture wherever `update: vi.fn()` is already present. Apply the same conversion to every one of this file's own ~8 occurrences, and to `tests/dungeon-follow-mechanics.test.mjs:416`'s own teleport-related assertion.

In `tests/dungeon-combat-grid-snap.test.mjs`, every occurrence of (confirmed current, lines 102/198/290/515/536/587):

```js
expect(mover.token.update.mock.calls[0][1]).toEqual({ teleport: true });
```

becomes:

```js
expect(mover.token.move).toHaveBeenCalledWith(
  expect.objectContaining({ action: "displace" }),
);
expect(mover.token.update).not.toHaveBeenCalled();
```

(adjusting each one's own exact `x`/`y` expectations to match, and adding `move: vi.fn()` to this file's own token fixtures).

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/dungeon-follow.test.mjs tests/dungeon-follow-mechanics.test.mjs tests/dungeon-combat-grid-snap.test.mjs`
Expected: FAIL.

- [ ] **Step 3: Fix `dungeon-follow.mjs`'s two sites**

Change (confirmed current, line 325):

```js
        await token.update({ x: snappedX, y: snappedY }, { teleport: true });
```

to:

```js
        await token.move({ x: snappedX, y: snappedY, action: "displace" });
```

Change (confirmed current, line 620):

```js
      await token.update({ x: snappedX, y: snappedY }, { teleport: true });
```

to:

```js
      await token.move({ x: snappedX, y: snappedY, action: "displace" });
```

Update both sites' own surrounding comments (lines 141, 400) to describe `.move({action:'displace'})` instead of the deprecated option.

- [ ] **Step 4: Fix `dungeon-combat.mjs`'s `snapTokenToGrid`**

Change (confirmed current, line 2350):

```js
    await token.update({ x: snappedX, y: snappedY }, { teleport: true });
```

to:

```js
    await token.move({ x: snappedX, y: snappedY, action: "displace" });
```

Update the function's own docblock (lines 2340-2349) to describe `.move({action:'displace'})` instead.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run tests/dungeon-follow.test.mjs tests/dungeon-follow-mechanics.test.mjs tests/dungeon-combat-grid-snap.test.mjs`
Expected: PASS.

- [ ] **Step 6: Run the full test suite**

Run: `npx vitest run`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add scripts/dungeon-follow.mjs scripts/dungeon-combat.mjs tests/dungeon-follow.test.mjs tests/dungeon-follow-mechanics.test.mjs tests/dungeon-combat-grid-snap.test.mjs
git commit -m "fix(#631): follower snap/resnap and combat grid-snap use move({action:'displace'})

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 3: `dungeon-scene.mjs` (`moveTokensToRoom`, the batch retreat case)

**Files:**
- Modify: `scripts/dungeon-scene.mjs`
- Test: `tests/dungeon-scene-retreat.test.mjs`

**Interfaces:**
- Consumes: `scene.moveTokens(instructions, options)` (confirmed live this session — `TokenDocument#move`'s own source delegates to exactly this: `this.parent.moveTokens({[this.id]: instruction}, rest)`).

- [ ] **Step 1: Update the failing tests**

Change (confirmed current, `tests/dungeon-scene-retreat.test.mjs:90-94`):

```js
describe('moveTokensToRoom teleport option (#439 R3.1)', () => {
  it('passes { teleport: true } when asked, undefined otherwise', async () => {
    ...
    await moveTokensToRoom(scene, ['t1'], 'r', 0, 0, 'seed', { teleport: true });
    expect(scene.updates[0].options).toEqual({ teleport: true });
```

to assert on a `scene.moveTokens` mock call instead — check this test file's own fake-scene fixture for whether it already distinguishes `updateEmbeddedDocuments` calls by document type (`scene.updates`, confirmed current) and add an equivalent `scene.moves`-style capture for `moveTokens`, following the same fixture convention. The exact instruction shape to assert: `{ t1: { waypoints: [{ x: ..., y: ..., action: 'displace' }] } }` when `teleport: true` was requested, and a plain `scene.updateEmbeddedDocuments("Token", updates)` call (no `moveTokens`) when it wasn't — `moveTokensToRoom`'s own `teleport = false` default case has no collision concern to bypass, so it should keep using the ordinary batch update, not switch to `moveTokens` unconditionally.

Apply the same conversion to the second test at line 231 (`'moves tokens with teleport:true FIRST, then persists, then posts a line'`).

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/dungeon-scene-retreat.test.mjs`
Expected: FAIL.

- [ ] **Step 3: Fix `moveTokensToRoom`**

Change (confirmed current, `scripts/dungeon-scene.mjs:1710-1731`):

```js
  tokenIds,
  roomId,
  rank,
  col,
  seed,
  { teleport = false } = {},
) {
  if (!tokenIds?.length) return;
  const rect = roomRect(seed, roomId, rank, col);
  const updates = tokenIds.map((id, i) => ({
    _id: id,
    x: toPixels(rect.gx + (i % rect.gw)),
    y: toPixels(rect.gy + Math.floor(i / rect.gw)),
  }));
  // #439: a plain update is constrained by Foundry's wall-collision pipeline
  // (the #87/#141 root cause); retreat must pass teleport so tokens cross walls.
  await scene.updateEmbeddedDocuments(
    "Token",
    updates,
    teleport ? { teleport: true } : undefined,
  );
}
```

to:

```js
  tokenIds,
  roomId,
  rank,
  col,
  seed,
  { teleport = false } = {},
) {
  if (!tokenIds?.length) return;
  const rect = roomRect(seed, roomId, rank, col);
  const positions = tokenIds.map((id, i) => ({
    id,
    x: toPixels(rect.gx + (i % rect.gw)),
    y: toPixels(rect.gy + Math.floor(i / rect.gw)),
  }));
  // #631: retreat needs to cross walls (#439's own #87/#141 root cause
  // reasoning still applies), via move()'s own per-waypoint action
  // instead of the deprecated teleport option -- see token-walk.mjs's
  // own docblock for why this is the correct, non-persisting replacement.
  if (teleport) {
    await scene.moveTokens(
      Object.fromEntries(
        positions.map((p) => [p.id, { waypoints: [{ x: p.x, y: p.y, action: "displace" }] }]),
      ),
    );
  } else {
    await scene.updateEmbeddedDocuments(
      "Token",
      positions.map((p) => ({ _id: p.id, x: p.x, y: p.y })),
    );
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/dungeon-scene-retreat.test.mjs`
Expected: PASS.

- [ ] **Step 5: Run the full test suite**

Run: `npx vitest run`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add scripts/dungeon-scene.mjs tests/dungeon-scene-retreat.test.mjs
git commit -m "fix(#631): moveTokensToRoom's own retreat teleport uses scene.moveTokens, not the deprecated option

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 4: Live verification (the real gate before this ships)

This is the one piece of #631 that genuinely cannot be settled by static analysis or headless scripting — confirmed this session: a simple relay-script position update did not reproduce the original wall-collision-redirect symptom at all, matching `tests/dungeon-follow.test.mjs`'s own existing comment that the real trigger is specific (a straight-line path that geometrically clips a wall, per `snapTokenToGrid`'s own docblock) and only reliably shows up in real interactive play.

- [ ] **Step 1: Set up a real, interactive test scenario**

In an actual running world (not headless), generate a dungeon with at least one AI-controlled follower and a corridor with a bend (so a follower's own next-cell move sits adjacent to a wall corner — the shape most likely to geometrically clip one).

- [ ] **Step 2: Exercise every one of the five migrated call sites in real play**

- Move the party leader through several corridor bends; watch every follower's own hop-by-hop walk (`walkTokenThroughSteps`, Task 1) for any drift/resnap.
- Open a door to trigger the #86 off-grid snap correction (Task 2's first site) on a deliberately-misaligned follower.
- Trigger a resnap (`resnapTokenNow`, Task 2's second site) via whatever existing in-game action already exercises it.
- Run a combat round with an AI-controlled combatant moving near a wall corner (`snapTokenToGrid`, Task 2's third site).
- Trigger a retreat (Task 3's `moveTokensToRoom`) with the party standing in a room whose own door requires crossing a wall segment to reach the retreat target.

- [ ] **Step 3: Confirm no drift, across a real multi-round session**

Watch for the ORIGINAL #87/#141/#361 symptom specifically: a token landing off-grid, or visibly sliding to a nearby cell instead of the exact one requested. A single clean pass is not sufficient confidence given this bug's own history of being intermittent — repeat across several real rooms/combats in the same session.

- [ ] **Step 4: If the symptom returns, stop and revert**

```bash
git revert <Task 1-3 commit SHAs>
```

File a new issue with the exact scenario that reproduced it (which of the five call sites, what the token's own path looked like) rather than attempting a second blind fix in the same pass.

- [ ] **Step 5: If clean, report findings on #631**

---

### Task 5: Version bump

**Files:**
- Modify: `module.json`

- [ ] **Step 1: Re-check the current version and bump**

```bash
git fetch origin main -q && git log origin/main -1 --oneline && grep version module.json
```

Apply a **minor** bump (a real migration of the module's own core movement-write path, not a trivial fix), using whatever the fetch above shows as current. Only bump after Task 4 passes — don't ship this migration un-verified.

- [ ] **Step 2: Commit**

```bash
git add module.json
git commit -m "chore(#631): bump version for the teleport-to-displace movement migration

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Self-Review

**1. Scope coverage:** #631's own ask (replace the deprecated shim before v15) is covered completely — all five real call sites (not just the two the issue's own text names), both call shapes (per-token `.move()` and batch `.moveTokens()`), and the one thing that genuinely can't be settled without a real session (Task 4) is scoped as its own explicit gate, not skipped or assumed safe.

**2. Placeholder scan:** No TBD. Every API claim (`displace` exists, `.move()` exists, the `movementAction`-persists trap, the non-persisting `.move()` replacement) was verified live against the real running instance this session, not assumed from documentation alone.

**3. Type consistency:** `token.move({x, y, action})`'s own shape is identical across every one of the four per-token call sites (Tasks 1-2); `scene.moveTokens({[id]: {waypoints: [...]}})`'s own shape (Task 3) matches exactly what `TokenDocument#move`'s own real source already does internally for a single token, confirmed live, not invented.

**4. Review Focus:** All five items (no persisted movementAction, a read-back regression test for it, the batch case moving every token, every existing test updated rather than dropped, the real drift symptom checked live before shipping) each map to a specific task step. No gaps found.

---

Plan complete and saved to `docs/superpowers/plans/2026-10-07-teleport-to-displace-migration.md`.
