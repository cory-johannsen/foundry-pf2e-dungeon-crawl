# Trap Room Auto-Resolve Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix #804 — a trap room's exits should unlock automatically once its trap reaches a terminal outcome (disabled, or triggered via critical failure or walk-over), the same way puzzle/skill-challenge/treasure rooms already auto-resolve from their own token-click interaction, instead of requiring the GM to separately click Succeed/Fail in the tracker.

**Architecture correction (investigated live against current code, not assumed from the issue text):** #804's own premise — "the success path already calls markRoomOutcome/resolveCurrentRoom; critical failure just never calls it" — does not match current reality. Reading `scripts/trap-combat.mjs`'s `attemptTrapDisableForScene` and `handleTrapTokenMove` in full, and every one of their callers (`scripts/module.mjs`, `scripts/dungeon-remote.mjs`), confirms **neither** path calls `resolveCurrentRoom`/`markRoomOutcome` today — a trap room, for every outcome equally, still requires the GM to manually click the tracker's generic Succeed/Fail buttons (`isTrapRoom` has no dedicated template block in `templates/dungeon-tracker.hbs`; it falls through to the same plain footer every other resolvable kind without its own UI uses). This is inconsistent with puzzle (`recordPuzzleStageOutcome`), skill-challenge (`recordSkillChallengeOutcome`), and treasure, which all call `resolveCurrentRoom` directly once their own mechanic concludes. The real fix (and the one #804's own "Fix" instruction describes in spirit) is to add that same auto-resolve call for all three trap terminal outcomes — not fix an asymmetry between two paths, since neither currently has it.

Also confirmed live: `room.kind === "trap"` is still a real, currently-generatable room kind today (`ROOM_KIND_WEIGHTS` in `scripts/dungeon-deck.mjs` still lists it) — #754's own "decouple traps from room kind" plan (merged as docs only, PR #784) has not yet been implemented in code, so a room with a trap hazard is still always, exclusively, kind `"trap"` (confirmed via `populateSlotTrap`'s own gating condition, `scripts/dungeon-scene.mjs:1810`). This plan's room-identity safety check (below) relies on that still-current 1:1 relationship.

**Avoiding an import cycle:** `scripts/trap-combat.mjs` must not import `resolveCurrentRoom` from `scripts/ui/dungeon-app.mjs` directly — `dungeon-app.mjs` already imports from `dungeon-scene.mjs`, which already imports `classifyTrap` from `trap-combat.mjs` (confirmed current, `scripts/dungeon-scene.mjs:91`), so a direct import would form a real three-file cycle (`trap-combat → dungeon-app → dungeon-scene → trap-combat`). This codebase's own established pattern for exactly this shape (see `dungeon-scene.mjs`'s own docblock: "this file deliberately never imports back into [module.mjs]") is to keep the lower-level file free of the cycle and let a caller higher up the chain — `module.mjs`/`dungeon-remote.mjs`, both of which already import `resolveCurrentRoom` — make the actual call. `trap-combat.mjs`'s own functions instead compute whether/how to resolve (using `getRunState`, which it already imports) and hand back a plain `{sceneId, succeeded}` descriptor, mirroring `handleDungeonDoorOpened`'s own `{autoOpenTracker}` return-value bridge pattern exactly.

**Tech Stack:** Vanilla ES modules, Vitest.

**Spec:** None — a bounded fix with a single correct resolution, now that live investigation has resolved the one real ambiguity (whether an existing success-path call needed fixing, versus adding the call to all three paths).

## Global Constraints

- Every merge to `main` bumps `module.json`'s `version` (CLAUDE.md). A real new behavior: minor bump. Re-check the current version immediately before committing, since concurrent sessions push to this repo.
- `trap-combat.mjs` gains **no new import** — it already imports `getRunState` from `dungeon-runner.mjs` (confirmed current, line 15), which is all the new logic needs.
- The auto-resolve only ever fires for the hazard's own room, and only when that room is genuinely the party's current room (`state.currentRoomId`) — a stray or stale hazard must never resolve the wrong room.
- A **non-critical** disable failure stays non-terminal (unchanged): the trap remains clickable, nothing resolves.
- An already-disabled trap's later walk-over "trigger" classification must not resolve the room a second time as failed — it was already resolved as succeeded when disabled (or, if somehow not, `markRoomOutcome`'s own existing duplicate-resolve guard makes a stray second call a safe no-op regardless).

## Review Focus

- **Disabling a trap must resolve the room as succeeded** — the issue's own stated expectation, and today's actual gap (not already working, confirmed above).
- **A critical-failure disable attempt must resolve the room as failed** — #804's explicit, named bug.
- **A walk-over trigger (no disable attempted at all) must also resolve the room as failed** — #804's own "Fix" section explicitly includes this third terminal path, not just the critical-failure one.
- **A hazard whose room is not the party's current room must never resolve anything** — the defensive check this plan adds; without it, a stale/offscreen trap event could incorrectly resolve whatever room the party happens to be in right now.
- **A plain (non-critical) disable failure must change nothing about room resolution** — it's retriable, not terminal; must not be mistaken for the critical-failure path.

---

### Task 1: Compute room-resolution in `trap-combat.mjs`

**Files:**
- Modify: `scripts/trap-combat.mjs` (`attemptTrapDisableForScene`, `handleTrapTokenMove`, new internal helper)
- Test: `tests/trap-disable-ui.test.mjs`, `tests/trap-token-move.test.mjs`

**Interfaces:**
- Produces: `attemptTrapDisableForScene(...)`'s existing return value gains an additional `roomResolution: {sceneId, succeeded}` field when a terminal outcome's room-identity check passes (absent otherwise — existing callers reading `result.disabled`/`result.outcome` are unaffected). `handleTrapTokenMove(...)` — which currently returns nothing in every path — now returns `{roomResolution: {sceneId, succeeded}}` when a walk-over trigger's room-identity check passes, `undefined` otherwise. Consumed by Task 2's callers.

- [ ] **Step 1: Write the failing tests**

Add to `tests/trap-disable-ui.test.mjs`, inside the existing `describe("#754 attemptTrapDisableForScene outcomes and authorization", ...)` block (reusing its own `hazardToken`/`flags`/`go` fixtures exactly):

```js
  it("#804: a successful disable resolves the room as succeeded when it's the current room", async () => {
    hazardToken.flags.dungeonSlot = "room1";
    const getRunState = vi.fn(() => ({ currentRoomId: "room1" }));
    const { out } = await go({ disabled: true, outcome: "success" }, { getRunState });
    expect(out.roomResolution).toEqual({ sceneId: "s1", succeeded: true });
  });

  it("#804: critical failure resolves the room as failed when it's the current room", async () => {
    hazardToken.flags.dungeonSlot = "room1";
    const getRunState = vi.fn(() => ({ currentRoomId: "room1" }));
    const { out } = await go({ disabled: false, outcome: "criticalFailure" }, { getRunState });
    expect(out.roomResolution).toEqual({ sceneId: "s1", succeeded: false });
  });

  it("#804: a plain failure never resolves the room", async () => {
    hazardToken.flags.dungeonSlot = "room1";
    const getRunState = vi.fn(() => ({ currentRoomId: "room1" }));
    const { out } = await go({ disabled: false, outcome: "failure" }, { getRunState });
    expect(out.roomResolution).toBeUndefined();
  });

  it("#804: never resolves when the hazard's room is not the current room", async () => {
    hazardToken.flags.dungeonSlot = "room1";
    const getRunState = vi.fn(() => ({ currentRoomId: "room-elsewhere" }));
    const { out } = await go({ disabled: true, outcome: "success" }, { getRunState });
    expect(out.roomResolution).toBeUndefined();
  });

  it("#804: never resolves when the hazard token has no dungeonSlot flag", async () => {
    const getRunState = vi.fn(() => ({ currentRoomId: "room1" }));
    const { out } = await go({ disabled: true, outcome: "success" }, { getRunState });
    expect(out.roomResolution).toBeUndefined();
    expect(getRunState).not.toHaveBeenCalled();
  });
```

Add to `tests/trap-token-move.test.mjs`, inside the existing `describe("handleTrapTokenMove", ...)` block (reusing its own `makeHazard`/`makeMover`/`base` fixtures exactly — note `makeMover`'s fake scene needs an `id` for this; add `scene.id = 's1';` right after its existing `scene.tokens.filter = ...` line, or pass it via a small inline override, whichever reads more naturally against the existing helper's own style):

```js
  it("#804: a fresh walk-over trigger resolves the room as failed when it's the current room", async () => {
    const h = makeHazard({ x: 100, y: 100 });
    h.flags.dungeonSlot = "room1";
    const getRunState = vi.fn(() => ({ currentRoomId: "room1" }));
    const result = await handleTrapTokenMove(makeMover([h]), MOVE, { ...base, getRunState });
    expect(result.roomResolution).toEqual({ sceneId: "s1", succeeded: false });
  });

  it("#804: an already-disabled trap's walk-over does not resolve the room", async () => {
    const h = makeHazard({ x: 100, y: 100, actorFlags: { trapDisabled: true } });
    h.flags.dungeonSlot = "room1";
    const getRunState = vi.fn(() => ({ currentRoomId: "room1" }));
    const result = await handleTrapTokenMove(makeMover([h]), MOVE, { ...base, getRunState });
    expect(result?.roomResolution).toBeUndefined();
  });

  it("#804: detection alone never resolves the room", async () => {
    const h = makeHazard({ x: 200, y: 100 });
    h.flags.dungeonSlot = "room1";
    const getRunState = vi.fn(() => ({ currentRoomId: "room1" }));
    const result = await handleTrapTokenMove(makeMover([h]), MOVE, { ...base, getRunState });
    expect(result?.roomResolution).toBeUndefined();
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/trap-disable-ui.test.mjs tests/trap-token-move.test.mjs -t "#804"`
Expected: FAIL — `roomResolution` is `undefined` on every result today (the feature doesn't exist yet), so the first two new assertions in each file fail; the negative-case assertions (never resolves) already pass today by coincidence (there's nothing to resolve yet) — that's fine, they'll stay green once the feature exists too, since they're testing the guard conditions.

- [ ] **Step 3: Add the shared helper and wire it in**

In `scripts/trap-combat.mjs`, add (near the top, after `isPartyActor`):

```js
/**
 * #804: whether/how a trap's terminal outcome (disabled, or triggered via
 * critical failure or walk-over) should auto-resolve its own room, matching
 * the auto-resolve puzzle/skill-challenge/treasure rooms already get from
 * their own token-click interaction (recordPuzzleStageOutcome/
 * recordSkillChallengeOutcome/claimTreasureFor) instead of leaving the GM
 * to separately click Succeed/Fail in the tracker.
 *
 * Deliberately returns a plain descriptor rather than calling
 * `resolveCurrentRoom` itself -- `scripts/ui/dungeon-app.mjs` already
 * imports from `dungeon-scene.mjs`, which already imports `classifyTrap`
 * from THIS file, so a direct import here would form a three-file import
 * cycle. The caller (module.mjs/dungeon-remote.mjs, both of which already
 * import `resolveCurrentRoom`) makes the actual call, mirroring
 * `handleDungeonDoorOpened`'s own `{autoOpenTracker}` bridge pattern.
 *
 * Only fires when the hazard's own room (its `dungeonSlot` token flag) is
 * genuinely the party's CURRENT room -- a stray or stale hazard must never
 * resolve whatever room the party happens to be in right now.
 */
function trapRoomResolution(sceneId, hazardToken, succeeded, deps = {}) {
  const getState = deps.getRunState ?? getRunState;
  const roomId = hazardToken.getFlag(MODULE_ID, "dungeonSlot");
  if (!roomId) return undefined;
  const state = getState(sceneId);
  if (state?.currentRoomId !== roomId) return undefined;
  return { sceneId, succeeded };
}
```

In `attemptTrapDisableForScene`, change the critical-failure block (currently):

```js
  if (result.outcome === "criticalFailure") {
    // Same in-flight lock as the walk-over trigger so the two can't both fire.
    if (trapChecksInFlight.has(hazardActor.id)) return result;
    if (hazardActor.getFlag(MODULE_ID, "trapTriggered")) return result;
    trapChecksInFlight.add(hazardActor.id);
    try {
      await hazardActor.setFlag(MODULE_ID, "trapTriggered", true);
      await markTrapSpent(hazardToken);
      await announce("PF2EDC.Dungeon.Trap.TriggeredChat", {
        name: actor.name,
        trap: hazardActor.name,
      });
      const attempterToken = trapScene.tokens.find(
        (t) => t.actor?.id === actor.id,
      );
      if (attempterToken?.object) {
        await trigger(hazardActor, { actor, token: attempterToken.object });
      }
    } finally {
      trapChecksInFlight.delete(hazardActor.id);
    }
    return result;
  }

  if (result.disabled) await markTrapSpent(hazardToken);
  await announce(
    result.disabled
      ? "PF2EDC.Dungeon.Trap.DisableSuccessChat"
      : "PF2EDC.Dungeon.Trap.DisableFailureChat",
    { name: actor.name, trap: hazardActor.name },
  );
  return result;
```

to:

```js
  if (result.outcome === "criticalFailure") {
    // Same in-flight lock as the walk-over trigger so the two can't both fire.
    if (trapChecksInFlight.has(hazardActor.id)) return result;
    if (hazardActor.getFlag(MODULE_ID, "trapTriggered")) return result;
    trapChecksInFlight.add(hazardActor.id);
    try {
      await hazardActor.setFlag(MODULE_ID, "trapTriggered", true);
      await markTrapSpent(hazardToken);
      await announce("PF2EDC.Dungeon.Trap.TriggeredChat", {
        name: actor.name,
        trap: hazardActor.name,
      });
      const attempterToken = trapScene.tokens.find(
        (t) => t.actor?.id === actor.id,
      );
      if (attempterToken?.object) {
        await trigger(hazardActor, { actor, token: attempterToken.object });
      }
    } finally {
      trapChecksInFlight.delete(hazardActor.id);
    }
    const roomResolution = trapRoomResolution(sceneId, hazardToken, false, deps);
    return roomResolution ? { ...result, roomResolution } : result;
  }

  if (result.disabled) await markTrapSpent(hazardToken);
  await announce(
    result.disabled
      ? "PF2EDC.Dungeon.Trap.DisableSuccessChat"
      : "PF2EDC.Dungeon.Trap.DisableFailureChat",
    { name: actor.name, trap: hazardActor.name },
  );
  if (result.disabled) {
    const roomResolution = trapRoomResolution(sceneId, hazardToken, true, deps);
    if (roomResolution) return { ...result, roomResolution };
  }
  return result;
```

In `handleTrapTokenMove`, change the trigger branch (currently):

```js
      if (classification === "trigger") {
        const disabled = hazardActor.getFlag(MODULE_ID, "trapDisabled");
        await hazardActor.setFlag(MODULE_ID, "trapTriggered", true);
        if (!disabled) {
          await announce("PF2EDC.Dungeon.Trap.TriggeredChat", {
            name: tokenDoc.name ?? tokenDoc.actor.name,
            trap: hazardActor.name,
          });
          await trigger(hazardActor, {
            actor: tokenDoc.actor,
            token: tokenDoc.object,
          });
        }
        await markTrapSpent(hazardToken);
        if (hazardToken.hidden) await hazardToken.update({ hidden: false });
      } else if (!hazardActor.getFlag(MODULE_ID, "trapDetected")) {
```

to:

```js
      if (classification === "trigger") {
        const disabled = hazardActor.getFlag(MODULE_ID, "trapDisabled");
        await hazardActor.setFlag(MODULE_ID, "trapTriggered", true);
        if (!disabled) {
          await announce("PF2EDC.Dungeon.Trap.TriggeredChat", {
            name: tokenDoc.name ?? tokenDoc.actor.name,
            trap: hazardActor.name,
          });
          await trigger(hazardActor, {
            actor: tokenDoc.actor,
            token: tokenDoc.object,
          });
          const resolution = trapRoomResolution(
            tokenDoc.parent?.id,
            hazardToken,
            false,
            deps,
          );
          if (resolution) roomResolution = resolution;
        }
        await markTrapSpent(hazardToken);
        if (hazardToken.hidden) await hazardToken.update({ hidden: false });
      } else if (!hazardActor.getFlag(MODULE_ID, "trapDetected")) {
```

Add `let roomResolution;` right after the function's existing `const announce = deps.announce ?? announceTrap;` line, and change the function's final line (currently just the closing brace after the `for` loop ends, with no return statement) to `return roomResolution ? { roomResolution } : undefined;` right before that closing brace.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/trap-disable-ui.test.mjs tests/trap-token-move.test.mjs -t "#804"`
Expected: PASS, all eight new cases green.

- [ ] **Step 5: Run both full test files to confirm no regression**

Run: `npx vitest run tests/trap-disable-ui.test.mjs tests/trap-token-move.test.mjs`
Expected: PASS — every pre-existing test stays green, since none of their fixtures set a `dungeonSlot` token flag, so `trapRoomResolution`'s own `if (!roomId) return undefined;` guard short-circuits before ever calling `getRunState` for any of them (confirmed: neither test file's module-level `vi.mock("../scripts/dungeon-runner.mjs", ...)` needs updating, since the default `getRunState` import is never reached by an existing fixture).

- [ ] **Step 6: Commit**

```bash
git add scripts/trap-combat.mjs tests/trap-disable-ui.test.mjs tests/trap-token-move.test.mjs
git commit -m "feat(#804): compute trap-terminal room auto-resolution

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 2: Wire the callers, live-verify, version bump

**Files:**
- Modify: `scripts/module.mjs` (the direct GM-call site and the `updateToken` hook registration)
- Modify: `scripts/dungeon-remote.mjs` (`attemptTrapDisable` registry entry)
- Test: `tests/trap-disable-ui.test.mjs` (update the one existing regex-based assertion the new async wrapper breaks)

**Interfaces:**
- Consumes: `attemptTrapDisableForScene(...)`'s and `handleTrapTokenMove(...)`'s new `roomResolution` field (Task 1).

- [ ] **Step 1: Update the one existing test the new wrapper shape breaks**

`tests/trap-disable-ui.test.mjs`'s `"dungeon-remote registers attemptTrapDisable routed to attemptTrapDisableForScene"` test (confirmed current, lines 50-57) regex-matches the exact current one-line arrow form, which Step 3 below changes. Replace its first assertion:

```js
    expect(remoteSource).toMatch(
      /attemptTrapDisable:\s*\(args\)\s*=>\s*attemptTrapDisableForScene\(args\.sceneId, args\.actorId, args\.skill, \{\s*requestingUserId: args\.requestingUserId,?\s*\}\)/,
    );
```

with:

```js
    expect(remoteSource).toMatch(
      /attemptTrapDisableForScene\(args\.sceneId, args\.actorId, args\.skill, \{\s*requestingUserId: args\.requestingUserId,?\s*\}\)/,
    );
    // #804: the relay handler must also apply the room auto-resolution
    // attemptTrapDisableForScene now hands back.
    expect(remoteSource).toMatch(/result\?\.roomResolution/);
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/trap-disable-ui.test.mjs -t "dungeon-remote registers attemptTrapDisable"`
Expected: FAIL — the new `roomResolution` assertion has nothing to match yet.

- [ ] **Step 3: Wire `dungeon-remote.mjs`**

Change (currently, lines 82-85):

```js
  attemptTrapDisable: (args) =>
    attemptTrapDisableForScene(args.sceneId, args.actorId, args.skill, {
      requestingUserId: args.requestingUserId,
    }),
```

to:

```js
  attemptTrapDisable: async (args) => {
    const result = await attemptTrapDisableForScene(args.sceneId, args.actorId, args.skill, {
      requestingUserId: args.requestingUserId,
    });
    if (result?.roomResolution) {
      await resolveCurrentRoom(result.roomResolution.succeeded, {
        scene: game.scenes.get(result.roomResolution.sceneId),
      });
    }
    return result;
  },
```

(`resolveCurrentRoom` is already imported in this file, confirmed current line 27 — no new import needed.)

- [ ] **Step 4: Wire `module.mjs`'s direct GM-call site**

Change (currently, confirmed current lines 430-431):

```js
    if (game.user.isGM) {
      await attemptTrapDisableForScene(sceneId, choice.actorId, choice.skill);
    } else {
```

to:

```js
    if (game.user.isGM) {
      const result = await attemptTrapDisableForScene(sceneId, choice.actorId, choice.skill);
      if (result?.roomResolution) {
        await resolveCurrentRoom(result.roomResolution.succeeded, {
          scene: game.scenes.get(result.roomResolution.sceneId),
        });
      }
    } else {
```

(`resolveCurrentRoom` is already imported in this file, confirmed current line 4 — no new import needed.)

- [ ] **Step 5: Wire `module.mjs`'s `updateToken` hook registration**

Change (confirmed current, line 605):

```js
Hooks.on("updateToken", (tokenDoc, changes) => handleTrapTokenMove(tokenDoc, changes));
```

to:

```js
Hooks.on("updateToken", async (tokenDoc, changes) => {
  const result = await handleTrapTokenMove(tokenDoc, changes);
  if (result?.roomResolution) {
    await resolveCurrentRoom(result.roomResolution.succeeded, {
      scene: game.scenes.get(result.roomResolution.sceneId),
    });
  }
});
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx vitest run tests/trap-disable-ui.test.mjs`
Expected: PASS, the updated test green.

- [ ] **Step 7: Run the full test suite to confirm no regression**

Run: `npx vitest run`
Expected: PASS.

- [ ] **Step 8: Live-verify via `foundry-rest`**

In a real dungeon run, generate (or locate) a trap room, open its door so the trap spawns, and run three scenarios, confirming the room's own outgoing door unlocks automatically after each (no manual Succeed/Fail click) and that the tracker is NOT left open requiring one:

1. Walk a party token into the trap's footprint to trigger it (no prior disable attempt) — confirm the room resolves failed and the door unlocks.
2. On a fresh trap room, successfully disable it via the click-to-disable dialog — confirm the room resolves succeeded and the door unlocks.
3. On a fresh trap room, force a critical-failure disable attempt (or repeat attempts until one lands) — confirm the room resolves failed and the door unlocks, and that the attempting character takes the trap's damage.

```bash
echo 'const state = await import("/modules/pf2e-dungeon-crawl/scripts/dungeon-runner.mjs").then(m => m.getRunState(canvas.scene.id)); return { currentRoomId: state?.currentRoomId, historyLength: state?.history?.length };' | .claude/skills/foundry-rest/foundry-exec.sh
```

Expected: `history` gains an entry for the trap room, and `currentRoomId` stays the trap room (unchanged until the party physically walks through the now-unlocked door) in all three cases.

- [ ] **Step 9: Bump module.json's version**

Re-check the current version first (concurrent sessions push to this repo):

```bash
git fetch origin main -q && git log origin/main -1 --oneline && grep version module.json
```

Apply a **minor** bump (a real behavioral change to room resolution), using whatever the fetch above shows as current.

- [ ] **Step 10: Commit**

```bash
git add scripts/module.mjs scripts/dungeon-remote.mjs module.json
git commit -m "feat(#804): auto-resolve a trap room's door on every terminal trap outcome

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Self-Review

**1. Scope coverage:** #804's own "Fix" instruction ("route every terminal trap outcome — disabled, triggered via crit fail, triggered via walk-over — through the same resolve-and-unlock path; add a test for the crit-fail case") is fully covered, and widened correctly once live investigation showed the premise's claimed existing success-path call doesn't actually exist: all three terminal paths gain the call, not just critical-failure, with tests for each plus the room-identity guard. No gaps found.

**2. Placeholder scan:** No TBD/TODO. Every code block is the complete real change.

**3. Type consistency:** `trapRoomResolution(sceneId, hazardToken, succeeded, deps)`'s signature and its `{sceneId, succeeded}` return shape are used identically across both of Task 1's call sites and consumed identically by all three of Task 2's callers (`result?.roomResolution`/`resolution.roomResolution` reads the same two fields everywhere).

**4. Review Focus:** All five items (disable success resolves succeeded, critical failure resolves failed, walk-over trigger resolves failed, room-identity guard prevents resolving the wrong room, a plain failure stays non-terminal) each have a dedicated test in Task 1. No gaps found.

---

Plan complete and saved to `docs/superpowers/plans/2026-10-05-trap-room-auto-resolve.md`.
