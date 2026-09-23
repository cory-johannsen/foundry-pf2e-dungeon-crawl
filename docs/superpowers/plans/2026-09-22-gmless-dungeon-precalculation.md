# GM-less Dungeon Precalculation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** For a GM-less-hosted dungeon run, build every room's full Foundry-side content (walls, encounters, traps, puzzle state, treasure) at run start instead of one door at a time, so mid-run progression no longer depends on a live GM-privileged client being connected.

**Architecture:** A new pure function, `roomsToEagerlyBuild(state)`, computes which rooms to build eagerly (every room except the entry and an index-1 combat room, which keeps its existing manual-populate deferral). `startDungeonRun` branches on `state.hostUserId` (already the established "is this run GM-less" signal in this codebase — see `unpauseIfGmLessRun`, `dungeon-combat.mjs:209`, and `skipPreview` in `encounter-generator.mjs:201`) to either loop over that list (GM-less) or keep today's single-room build (GM-hosted, unchanged).

**Tech Stack:** Plain JS (ESM), Vitest for tests, Foundry VTT v13 module APIs (not touched directly by the new pure logic).

**Spec:** `docs/superpowers/specs/2026-09-22-gmless-dungeon-precalculation-design.md`

## Global Constraints

- Sequence mutations (`applySequenceMutation`/`markRoomOutcome`) are untouched — a mutation-inserted room still builds lazily, exactly as today. Do not modify `dungeon-deck.mjs` or the mutation-handling code in `dungeon-runner.mjs`.
- The first-room (index 1) combat-kind deferral (ITEM-11) is unchanged for both GM-hosted and GM-less runs — do not build a combat-kind room at index 1 eagerly.
- No new "GM-less mode" flag — detection is `state.hostUserId` being truthy, exactly the signal `unpauseIfGmLessRun` already uses.
- Every merge to `main` must bump `module.json`'s `version` field (currently `0.11.0` as of this plan being written — confirm the actual current value before bumping, other work may have moved it forward). Patch bump — this is additive, not an architecture change. Never reuse a version number.

---

## File Structure

- **Modify:** `scripts/dungeon-runner.mjs` — add `roomsToEagerlyBuild(state)`, a pure function alongside the existing `canUndoRoomEntry(state)` (same style: synchronous, takes `state` directly, no Foundry dependency).
- **Modify:** `tests/dungeon-runner.test.mjs` — add test coverage for `roomsToEagerlyBuild`.
- **Modify:** `scripts/ui/dungeon-app.mjs` — `startDungeonRun` (currently lines 325-393) branches on `state.hostUserId` to call the new function's result through the existing `buildPopulateAndUnlockRoom`, instead of only ever building room 1.

No new files. `dungeon-app.mjs` has no existing test file (it's Foundry-`Application`-coupled UI glue with no test harness anywhere in this codebase) — Task 2 below relies on the full existing suite (regression safety) plus live verification, not a new unit test, matching how this file's other Foundry-heavy functions are already verified in this codebase.

---

### Task 1: `roomsToEagerlyBuild` pure function

**Files:**
- Modify: `scripts/dungeon-runner.mjs` (add the function near `canUndoRoomEntry`, ~line 351, and add it to the file's exports)
- Test: `tests/dungeon-runner.test.mjs`

**Interfaces:**
- Produces: `export function roomsToEagerlyBuild(state)` — `state` is the same run-state shape `createRun`/`getRunState` already produce elsewhere in this file (has `.rooms`, an array of room objects each with at least a `.kind` string field). Returns an array of `{ room, physicalSlot }` objects, in ascending index order, `physicalSlot` being a plain number. Consumed by Task 2's `startDungeonRun`.

- [ ] **Step 1: Write the failing tests**

Add this import to the top of `tests/dungeon-runner.test.mjs`, in the existing `from "../scripts/dungeon-runner.mjs"` import block (alongside `canUndoRoomEntry` etc.):

```js
  roomsToEagerlyBuild,
```

Then add this test block anywhere after the existing `describe`/`it` blocks in the file (match the file's existing flat `it(...)` style — check the surrounding blocks for whether they're wrapped in a `describe`, and match that):

```js
it('roomsToEagerlyBuild returns every room after the entry, in order, as {room, physicalSlot} pairs', () => {
  const state = {
    rooms: [
      { id: 'r0', kind: 'narrative' },
      { id: 'r1', kind: 'narrative' },
      { id: 'r2', kind: 'trap' },
      { id: 'r3', kind: 'puzzle' },
    ],
  };
  expect(roomsToEagerlyBuild(state)).toEqual([
    { room: state.rooms[1], physicalSlot: 1 },
    { room: state.rooms[2], physicalSlot: 2 },
    { room: state.rooms[3], physicalSlot: 3 },
  ]);
});

it('roomsToEagerlyBuild skips a combat-kind room at index 1, keeping the manual-populate deferral (ITEM-11)', () => {
  const state = {
    rooms: [
      { id: 'r0', kind: 'narrative' },
      { id: 'r1', kind: 'combat' },
      { id: 'r2', kind: 'trap' },
    ],
  };
  expect(roomsToEagerlyBuild(state)).toEqual([
    { room: state.rooms[2], physicalSlot: 2 },
  ]);
});

it('roomsToEagerlyBuild does NOT skip a combat-kind room at any index other than 1', () => {
  const state = {
    rooms: [
      { id: 'r0', kind: 'narrative' },
      { id: 'r1', kind: 'trap' },
      { id: 'r2', kind: 'combat' },
      { id: 'r3', kind: 'puzzle' },
    ],
  };
  expect(roomsToEagerlyBuild(state)).toEqual([
    { room: state.rooms[1], physicalSlot: 1 },
    { room: state.rooms[2], physicalSlot: 2 },
    { room: state.rooms[3], physicalSlot: 3 },
  ]);
});

it('roomsToEagerlyBuild returns an empty array for a single-room (entry-only) dungeon', () => {
  const state = { rooms: [{ id: 'r0', kind: 'narrative' }] };
  expect(roomsToEagerlyBuild(state)).toEqual([]);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/dungeon-runner.test.mjs`
Expected: FAIL — `roomsToEagerlyBuild is not a function` (or a Vitest import error naming it undefined), since the function doesn't exist yet.

- [ ] **Step 3: Write the minimal implementation**

In `scripts/dungeon-runner.mjs`, add this function immediately after `canUndoRoomEntry` (currently ending at line 354):

```js
/**
 * Every room #62's GM-less precalculation should build eagerly at run
 * start, as `{room, physicalSlot}` pairs in build order — every room in
 * the base sequence except room 0 (the entry, built separately by
 * startDungeonRun itself) and a combat-kind room at index 1, which keeps
 * the existing manual "Populate Next Room" deferral (ITEM-11) regardless
 * of host. A room's index into `state.rooms` is its physical slot here —
 * this only ever runs once, before any door has been opened or any slot
 * reassigned, so slot-per-index always holds at this point.
 */
export function roomsToEagerlyBuild(state) {
  const result = [];
  for (let i = 1; i < state.rooms.length; i += 1) {
    const room = state.rooms[i];
    if (i === 1 && room.kind === "combat") continue;
    result.push({ room, physicalSlot: i });
  }
  return result;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/dungeon-runner.test.mjs`
Expected: PASS, all 4 new tests plus every pre-existing test in the file.

- [ ] **Step 5: Run the full suite to check for regressions**

Run: `npm test`
Expected: PASS, no change in failure count from baseline (this is a pure addition, nothing existing should be affected).

- [ ] **Step 6: Commit**

```bash
git add scripts/dungeon-runner.mjs tests/dungeon-runner.test.mjs
git commit -m "Add roomsToEagerlyBuild for GM-less dungeon precalculation (#62)

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 2: Wire eager building into `startDungeonRun`

**Files:**
- Modify: `scripts/ui/dungeon-app.mjs:325-393` (`startDungeonRun`)

**Interfaces:**
- Consumes: `roomsToEagerlyBuild(state)` from Task 1 (`scripts/dungeon-runner.mjs`) — array of `{ room, physicalSlot }`. Also consumes the already-existing, already-imported `buildPopulateAndUnlockRoom(scene, state, room, physicalSlot)` (`scripts/dungeon-scene.mjs:753`), unchanged.
- Produces: no new exports — `startDungeonRun`'s existing signature and external behavior for a GM-hosted run are unchanged; a GM-less-hosted run now has every eligible room built before the function returns instead of just room 1.

- [ ] **Step 1: Add the import**

In `scripts/ui/dungeon-app.mjs`, find the existing import from `../dungeon-runner.mjs` (near the top of the file):

```js
import {
  getRunState,
  createRun,
  markRoomOutcome,
  abandonRun,
  canUndoRoomEntry,
  recordSkillChallengeAttempt,
  setObjective,
  recordPuzzleStageAttempt,
} from "../dungeon-runner.mjs";
```

Add `roomsToEagerlyBuild` to that list:

```js
import {
  getRunState,
  createRun,
  markRoomOutcome,
  abandonRun,
  canUndoRoomEntry,
  recordSkillChallengeAttempt,
  setObjective,
  recordPuzzleStageAttempt,
  roomsToEagerlyBuild,
} from "../dungeon-runner.mjs";
```

- [ ] **Step 2: Replace the first-real-room build block**

In `startDungeonRun` (currently lines 368-374), replace:

```js
  // A combat first room's build+populate is deliberately deferred to the
  // next "Populate Next Room" action instead — see #onPopulateNext/
  // populateNextRoom below (ITEM-11).
  const firstRealRoom = state.rooms[1];
  if (firstRealRoom && firstRealRoom.kind !== "combat") {
    await buildPopulateAndUnlockRoom(scene, state, firstRealRoom, 1);
  }
```

with:

```js
  // #62: a GM-less-hosted run (state.hostUserId set — same signal
  // unpauseIfGmLessRun/encounter-generator.mjs's skipPreview already use)
  // builds every eligible room now, so room-to-room progression never
  // depends on a live GM-privileged client being connected later. A
  // GM-hosted run keeps the original one-room-ahead behavior unchanged.
  // Either way, a combat-kind room at index 1 keeps its existing manual
  // "Populate Next Room" deferral (ITEM-11) — see #onPopulateNext/
  // populateNextRoom below.
  if (state.hostUserId) {
    for (const { room, physicalSlot } of roomsToEagerlyBuild(state)) {
      await buildPopulateAndUnlockRoom(scene, state, room, physicalSlot);
    }
  } else {
    const firstRealRoom = state.rooms[1];
    if (firstRealRoom && firstRealRoom.kind !== "combat") {
      await buildPopulateAndUnlockRoom(scene, state, firstRealRoom, 1);
    }
  }
```

- [ ] **Step 3: Run the full suite to check for regressions**

Run: `npm test`
Expected: PASS, same count as Task 1's final run — this file has no existing direct test coverage, so this step is purely a regression check on everything else, not a check on this new branch's own correctness (Task 1's tests already cover the selection logic; this step only proves the wiring didn't break anything else that imports from `dungeon-app.mjs` or `dungeon-runner.mjs`).

- [ ] **Step 4: Run prettier check**

Run: `npx prettier --check scripts/ui/dungeon-app.mjs scripts/dungeon-runner.mjs`
Expected: clean on both files (if either already had pre-existing formatting debt on `main` before this change, verify with `git show main:scripts/ui/dungeon-app.mjs | npx prettier --check -` before treating a warning as introduced by this task).

- [ ] **Step 5: Attempt live verification against a running Foundry world**

Run (from the repo root, or the worktree root if executing in one):

```bash
.claude/skills/foundry-rest/foundry-exec.sh <<'EOF'
return { worldId: game.world.id, actorCount: game.actors.size };
EOF
```

If this fails with "no Foundry client registered with the relay," retry once after a few seconds; if still unreachable, the world isn't open in a browser — skip to Step 6 and note in the task's own completion report that live verification wasn't possible, same disclosed-fallback pattern used by #28/#36/#50's implementations.

If reachable, verify both branches live:
1. Start (or use an existing) GM-less-hosted run (a `hostUserId` set to a non-GM user's id) and confirm every room past the entry has real content (walls + `isSlotPopulated`/trap/puzzle state) immediately after `startDungeonRun` resolves, not just room 1 — e.g. `game.scenes.get(sceneId)` and check wall count / spawned tokens across all built slots, or inspect `getRunState(sceneId)` for whichever "is this slot built" signal `isSlotBuilt`/`isSlotPopulated` (`dungeon-scene.mjs`) actually expose.
2. Start (or use an existing) GM-hosted run and confirm only room 1 is built immediately (unchanged behavior) — same inspection, but past room 1 should show no content yet.
3. Confirm a combat-kind room at index 1 is still left unbuilt in both cases (GM-hosted and GM-less), per the ITEM-11 deferral.

- [ ] **Step 6: Commit**

```bash
git add scripts/ui/dungeon-app.mjs
git commit -m "Wire GM-less eager room precalculation into startDungeonRun (#62)

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Revision (2026-09-22): Tasks 3-6 added after final review

Tasks 1-2 above are DONE — commits `791c8fc`/`af80e24`/`0da6900` on branch
`worktree-agent-aa5921258df7bf67c`, both passed their own task reviews. The
final whole-branch review then found 3 Critical bugs stemming from a false
premise ("mutations only ever touch an unslotted room" stops being true once
a whole run is built eagerly) — full trace in
`.superpowers/sdd/2026-09-22-gmless-dungeon-precalculation/final-review-fix-report.md`
in that worktree. See the revised design doc
(`docs/superpowers/specs/2026-09-22-gmless-dungeon-precalculation-design.md`)
for the full "Mutation reconciliation" section these tasks implement.

Global Constraints addition: **do not modify `applySequenceMutation`,
`markRoomOutcome`'s existing logic, `buildRoomAtSlot`,
`buildConnectionGeometry`, or anything in `dungeon-layout.mjs`** — every
task below is additive around this existing, correct code, never a change
to it. Run the `update-architecture-docs` skill once, after Task 6, since
these tasks add new exported functions and new cross-file calls (per this
repo's CLAUDE.md: run it in the same pass as any merge that rewires a
`scripts/` file's imports).

### Task 3: Idempotency guards, deferred unlock, and slot bookkeeping

**Files:**
- Modify: `scripts/dungeon-scene.mjs` (`buildPopulateAndUnlockRoom`, currently lines 753-870)
- Modify: `scripts/dungeon-runner.mjs` (new `commitEagerPhysicalSlots` export, placed after `roomsToEagerlyBuild`)
- Modify: `scripts/ui/dungeon-app.mjs` (`startDungeonRun`'s eager branch)
- Test: `tests/dungeon-runner.test.mjs`

**Interfaces:**
- Produces: `buildPopulateAndUnlockRoom(scene, state, room, physicalSlot, { unlock = true } = {})` — new 5th parameter, default preserves current behavior for every existing caller. `export async function commitEagerPhysicalSlots(sceneId, eagerlyBuilt, { settingsRef = defaultSettingsRef() } = {})` — `eagerlyBuilt` is exactly `roomsToEagerlyBuild(state)`'s return shape (`{room, physicalSlot}` pairs). Returns the persisted state (or the unchanged falsy `state` if no run exists for `sceneId`).
- Consumes: `isSlotBuilt`, `isSlotPopulated` (`dungeon-scene.mjs`, already exported), `getRunState`/`defaultSettingsRef` and the file-private `persist` helper (`dungeon-runner.mjs`, already in scope — do not export `persist`, call it the same way `createRun`/`markRoomOutcome` already do).

- [ ] **Step 1: Write the failing tests for `commitEagerPhysicalSlots`**

Add to `tests/dungeon-runner.test.mjs` (check how `createRun`'s or `markRoomOutcome`'s existing tests fake `settingsRef`/`getRunState` and match that exact pattern — do not invent a different mocking approach; add `commitEagerPhysicalSlots` to the file's existing import block from `../scripts/dungeon-runner.mjs`):

```js
describe('commitEagerPhysicalSlots', () => {
  it('merges eagerly-built slot assignments into physicalSlotByRoomId and advances nextPhysicalSlot past the highest committed slot', async () => {
    const settingsRef = makeSettingsStub();
    const created = await createRun(
      { sceneId: 's1', roomCount: 5, traits: [], excludeTraits: [] },
      { puzzleSetpieceIds: [], trapSetpieceIds: [], narrativeSetpieceIds: [] },
      { settingsRef },
    );
    const eagerlyBuilt = [
      { room: created.rooms[2], physicalSlot: 2 },
      { room: created.rooms[3], physicalSlot: 3 },
      { room: created.rooms[4], physicalSlot: 4 },
    ];
    const result = await commitEagerPhysicalSlots('s1', eagerlyBuilt, { settingsRef });
    expect(result.physicalSlotByRoomId[created.rooms[2].id]).toBe(2);
    expect(result.physicalSlotByRoomId[created.rooms[3].id]).toBe(3);
    expect(result.physicalSlotByRoomId[created.rooms[4].id]).toBe(4);
    expect(result.nextPhysicalSlot).toBe(5);
  });

  it('does not regress nextPhysicalSlot when called a second time with the same or a lower slot', async () => {
    const settingsRef = makeSettingsStub();
    const created = await createRun(
      { sceneId: 's2', roomCount: 3, traits: [], excludeTraits: [] },
      { puzzleSetpieceIds: [], trapSetpieceIds: [], narrativeSetpieceIds: [] },
      { settingsRef },
    );
    await commitEagerPhysicalSlots('s2', [{ room: created.rooms[2], physicalSlot: 2 }], { settingsRef });
    const result = await commitEagerPhysicalSlots('s2', [{ room: created.rooms[2], physicalSlot: 2 }], { settingsRef });
    expect(result.nextPhysicalSlot).toBe(3);
  });

  it('does not touch state.rooms, state.currentIndex, or any other field', async () => {
    const settingsRef = makeSettingsStub();
    const created = await createRun(
      { sceneId: 's3', roomCount: 3, traits: [], excludeTraits: [] },
      { puzzleSetpieceIds: [], trapSetpieceIds: [], narrativeSetpieceIds: [] },
      { settingsRef },
    );
    const result = await commitEagerPhysicalSlots('s3', [{ room: created.rooms[2], physicalSlot: 2 }], { settingsRef });
    expect(result.rooms).toEqual(created.rooms);
    expect(result.currentIndex).toBe(created.currentIndex);
  });
});
```

Check the actual return shape of `createRun` (read its current implementation, ~line 88) before trusting the field names above (`.rooms`, `.currentIndex`) — this plan text is based on reading it earlier in this session but confirm against the file as it stands when you start.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/dungeon-runner.test.mjs`
Expected: FAIL — `commitEagerPhysicalSlots is not a function`.

- [ ] **Step 3: Implement `commitEagerPhysicalSlots`**

In `scripts/dungeon-runner.mjs`, add after `roomsToEagerlyBuild`:

```js
/**
 * Persists the physical-slot assignments startDungeonRun's eager GM-less
 * build loop already made in memory (#62) — without this, the run's
 * tracked physicalSlotByRoomId/nextPhysicalSlot bookkeeping would never
 * learn those rooms were built, and markRoomOutcome's own reuse-or-allocate
 * logic (which already correctly handles "this room's slot may already be
 * assigned" for the lazy/mutation case) would reassign colliding slots via
 * its counter instead of reusing them. `eagerlyBuilt` is exactly what
 * roomsToEagerlyBuild(state) returned — {room, physicalSlot} pairs, any
 * order.
 */
export async function commitEagerPhysicalSlots(
  sceneId,
  eagerlyBuilt,
  { settingsRef = defaultSettingsRef() } = {},
) {
  const state = getRunState(sceneId, { settingsRef });
  if (!state) return state;
  const physicalSlotByRoomId = { ...state.physicalSlotByRoomId };
  let nextPhysicalSlot = state.nextPhysicalSlot;
  for (const { room, physicalSlot } of eagerlyBuilt) {
    physicalSlotByRoomId[room.id] = physicalSlot;
    nextPhysicalSlot = Math.max(nextPhysicalSlot, physicalSlot + 1);
  }
  const newState = { ...state, physicalSlotByRoomId, nextPhysicalSlot };
  return persist(sceneId, newState, settingsRef);
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/dungeon-runner.test.mjs`
Expected: PASS, all new tests plus every pre-existing test in the file.

- [ ] **Step 5: Add idempotency guards and the `unlock` option to `buildPopulateAndUnlockRoom`**

In `scripts/dungeon-scene.mjs`, change the function signature and body:

```js
export async function buildPopulateAndUnlockRoom(
  scene,
  state,
  room,
  physicalSlot,
  { unlock = true } = {},
) {
  if (!isSlotBuilt(scene, physicalSlot)) {
    await buildRoomAtSlot(scene, physicalSlot, {
      isGoal: room.isGoal,
      locationTag: room.locationTag,
      artVariant: room.artVariant,
      seed: state.seed,
    });
  }

  if (room.kind === "combat") {
    if (!isSlotPopulated(scene, physicalSlot)) {
      await populateSlotEncounter(scene, physicalSlot, {
        prefillTraits: state.traits,
        prefillExcludeTraits: state.excludeTraits,
        levelOffsetBias: depthBiasFor({
          physicalSlot,
          roomCount: state.rooms.length,
          isGoal: room.isGoal,
        }),
        locationTag: room.locationTag,
        seed: state.seed,
      });
    }
    // Only unlock once monsters are actually in place — a cancelled theme
    // dialog leaves the door locked rather than opening onto an empty room;
    // the GM retries via the "Populate Next Room" button.
    if (unlock && isSlotPopulated(scene, physicalSlot))
      await unlockDoorToSlot(scene, physicalSlot);
  } else {
    /* ...existing skill_challenge/puzzle/narrative ensure* calls, unchanged... */
    if (room.kind === "trap" && room.setpieceId && !isSlotPopulated(scene, physicalSlot)) {
      await populateSlotTrap(scene, physicalSlot, {
        partyLevel: await makeFoundryApi().partyLevel(),
        levelOffsetBias: depthBiasFor({
          physicalSlot,
          roomCount: state.rooms.length,
          isGoal: room.isGoal,
        }),
        locationTag: room.locationTag,
        seed: state.seed,
        roomId: room.id,
      });
    } else if (room.kind === "puzzle" && room.setpieceId) {
      /* ...unchanged... */
    }
    /* ...unchanged narrative block... */
    if (unlock) await unlockDoorToSlot(scene, physicalSlot);
  }
}
```

Read the function's current full body first (it has the `skill_challenge`/`puzzle`/`narrative` blocks between the trap check and the final unlock, already shown earlier in this plan's Task 1/2 exploration) and apply exactly these two changes to it — (a) the `isSlotBuilt`/`isSlotPopulated` guards around `buildRoomAtSlot`/`populateSlotEncounter`/`populateSlotTrap`, (b) the `unlock` parameter gating both unlock call sites — without altering the `skill_challenge`/`puzzle`/`narrative` blocks at all (their `ensure*` calls are already idempotent by their own docblocks, confirmed in this plan's research; do not add guards there, doing so would be redundant dead code).

- [ ] **Step 6: Use the fixes in `startDungeonRun`'s eager branch**

In `scripts/ui/dungeon-app.mjs`, add `commitEagerPhysicalSlots` to the existing `from "../dungeon-runner.mjs"` import block (alongside `roomsToEagerlyBuild`). Change the GM-less branch from:

```js
  if (state.hostUserId) {
    for (const { room, physicalSlot } of roomsToEagerlyBuild(state)) {
      await buildPopulateAndUnlockRoom(scene, state, room, physicalSlot);
    }
  } else {
```

to:

```js
  if (state.hostUserId) {
    const eagerlyBuilt = roomsToEagerlyBuild(state);
    for (const { room, physicalSlot } of eagerlyBuilt) {
      await buildPopulateAndUnlockRoom(scene, state, room, physicalSlot, {
        unlock: physicalSlot === 1,
      });
    }
    if (eagerlyBuilt.length) {
      await commitEagerPhysicalSlots(scene.id, eagerlyBuilt);
    }
  } else {
```

**This intentionally differs from the original fix brief's `unlock: false`** — that was tried and found to strand the party at slot 1 forever (nothing else ever unlocks it, since room 0 has no outcome slot and `markRoomOutcome` never runs for it). `unlock: physicalSlot === 1` matches what the GM-hosted branch already does for room 1 by default.

Also correct the comment directly above this block — it currently overstates what changed (claims the live-GM dependency is fully removed; Tasks 3-4-5-6 together are what actually removes it, this task alone only fixes double-build/slot-collision/premature-unlock). Keep it concise, matching the file's existing comment style.

- [ ] **Step 7: Run the full suite and format check**

Run: `npm test`
Expected: PASS, no regressions from the Task 1-2 baseline (36 files / 1553 tests), plus this task's new `commitEagerPhysicalSlots` tests.

Run: `npx prettier --check scripts/ui/dungeon-app.mjs scripts/dungeon-runner.mjs scripts/dungeon-scene.mjs tests/dungeon-runner.test.mjs`
Expected: clean on lines you touched (both `dungeon-app.mjs` and `dungeon-runner.mjs` have pre-existing formatting debt from before this branch — confirmed by Task 2's own report — don't fix debt outside your own changed lines).

- [ ] **Step 8: Commit**

```bash
git add scripts/dungeon-scene.mjs scripts/dungeon-runner.mjs scripts/ui/dungeon-app.mjs tests/dungeon-runner.test.mjs
git commit -m "Fix double-build, slot collision, and premature door-unlock in GM-less eager build (#62)

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 4: Per-content-type teardown functions

**Files:**
- Modify: `scripts/dungeon-scene.mjs` (new `clearSlotEncounter`, `clearSlotTrap`, near `populateSlotEncounter`/`populateSlotTrap`)
- Modify: `scripts/dungeon-runner.mjs` (new `clearPuzzleState`, `clearSkillChallengeState`, `clearNarrativeState`, near their `ensure*` counterparts)
- Test: `tests/dungeon-runner.test.mjs` (state-only teardown functions only — the two Foundry-heavy ones have no test harness available, same boundary as `dungeon-scene.mjs`'s other functions; verified via Task 6's live-verification step instead)

**Interfaces:**
- Produces: `async function clearSlotEncounter(scene, physicalSlot)` and `async function clearSlotTrap(scene, physicalSlot)` in `dungeon-scene.mjs` — delete every token (and, for a non-party actor, its Actor document, mirroring `sweepLooseNpcActors`'s existing token+actor deletion pattern) flagged `getFlag(MODULE_ID, "dungeonSlot") === physicalSlot`. `async function clearPuzzleState(sceneId, roomId, opts)`, `clearSkillChallengeState(sceneId, roomId, opts)`, `clearNarrativeState(sceneId, roomId, opts)` in `dungeon-runner.mjs` — each sets that room's corresponding state field (`puzzle`/`challenge`/`narrative` — confirm the exact field name each `ensure*` function reads/writes, e.g. `ensurePuzzleState` uses `room.puzzle`) back to `null` via the same `state.rooms.map(...)`/`persist` pattern `ensurePuzzleState` already uses, and is a no-op (still calls `persist` with the same state, or returns early — match whatever the `ensure*` functions' own no-op convention is) if that field is already `null`/absent.
- Consumes: `MODULE_ID` (`dungeon-scene.mjs`, already a module-level constant), `sweepLooseNpcActors`'s existing token/actor-deletion call shape (`scene.deleteEmbeddedDocuments("Token", ids)` / `Actor.deleteDocuments(ids)`) as the pattern to mirror, `getRunState`/`persist`/`defaultSettingsRef` (`dungeon-runner.mjs`, already in scope).

- [ ] **Step 1: Read the exact counterpart functions before writing teardown**

Read `populateSlotEncounter` and `populateSlotTrap` in full (`scripts/dungeon-scene.mjs`) to confirm exactly which flags/documents each creates (an encounter's tokens carry `getFlag(MODULE_ID, "dungeonSlot") === slot`; confirm whether a trap's spawned hazard actor carries the same flag or a different one — the file's own docblock for `populateSlotTrap`, already read during this plan's research, says it does via `extraFlags`, confirm the exact key). Read `ensurePuzzleState`, `ensureSkillChallenge`, `ensureNarrativeState` in full (`scripts/dungeon-runner.mjs`) to confirm the exact field name each one reads as its own "already attached" guard (`room.puzzle` for puzzle, confirm the other two) — your `clearX` functions must target exactly that same field.

- [ ] **Step 2: Write the failing tests for the two state-clearing functions with a test harness**

Add to `tests/dungeon-runner.test.mjs` (add `clearPuzzleState`, `clearSkillChallengeState`, `clearNarrativeState` to the existing import block):

```js
describe('clearPuzzleState', () => {
  it('clears an already-attached puzzle state back to null', async () => {
    const settingsRef = makeSettingsStub();
    const created = await createRun(
      { sceneId: 's4', roomCount: 3, traits: [], excludeTraits: [] },
      { puzzleSetpieceIds: [], trapSetpieceIds: [], narrativeSetpieceIds: [] },
      { settingsRef },
    );
    const roomId = created.rooms[2].id;
    await ensurePuzzleState('s4', roomId, { hintChecks: [] }, { settingsRef });
    const cleared = await clearPuzzleState('s4', roomId, { settingsRef });
    const room = cleared.rooms.find((r) => r.id === roomId);
    expect(room.puzzle).toBeFalsy();
  });

  it('is a no-op against a room with no puzzle state attached', async () => {
    const settingsRef = makeSettingsStub();
    const created = await createRun(
      { sceneId: 's5', roomCount: 3, traits: [], excludeTraits: [] },
      { puzzleSetpieceIds: [], trapSetpieceIds: [], narrativeSetpieceIds: [] },
      { settingsRef },
    );
    const roomId = created.rooms[2].id;
    const cleared = await clearPuzzleState('s5', roomId, { settingsRef });
    expect(cleared.rooms).toEqual(created.rooms);
  });
});
```

Write the equivalent pair of tests for `clearSkillChallengeState` and `clearNarrativeState`, using each one's own `ensure*` counterpart to attach state first (check each `ensure*` function's actual required options before calling it — `ensureSkillChallenge`/`ensureNarrativeState` likely need different fixture data than `ensurePuzzleState`'s `hintChecks`, confirm from Step 1's reading).

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx vitest run tests/dungeon-runner.test.mjs`
Expected: FAIL — the three new functions don't exist yet.

- [ ] **Step 4: Implement the three state-clearing functions**

In `scripts/dungeon-runner.mjs`, add each one immediately after its `ensure*` counterpart, matching that function's exact persistence pattern (read via Step 1) — for `clearPuzzleState`, this shape (adjust field name/pattern for the other two based on what Step 1 found):

```js
export async function clearPuzzleState(
  sceneId,
  roomId,
  { settingsRef = defaultSettingsRef() } = {},
) {
  const state = getRunState(sceneId, { settingsRef });
  if (!state) return state;
  const room = state.rooms.find((r) => r.id === roomId);
  if (!room || !room.puzzle) return state;
  const rooms = state.rooms.map((r) => (r.id === roomId ? { ...r, puzzle: null } : r));
  const newState = { ...state, rooms };
  return persist(sceneId, newState, settingsRef);
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run tests/dungeon-runner.test.mjs`
Expected: PASS, all new tests plus every pre-existing test.

- [ ] **Step 6: Implement the two Foundry-heavy teardown functions (no automated test — see Task 6's live verification)**

In `scripts/dungeon-scene.mjs`, add near `populateSlotEncounter`/`populateSlotTrap`:

```js
/** Removes every token (and, for a non-party actor, its Actor document too)
 * this slot's encounter spawned — the teardown counterpart to
 * populateSlotEncounter, needed when a mutation (#62) changes which logical
 * room a physical slot corresponds to. Mirrors sweepLooseNpcActors's own
 * token+actor deletion shape. A no-op if nothing is flagged for this slot. */
export async function clearSlotEncounter(scene, slot) {
  const tokens = scene.tokens.filter(
    (t) => t.getFlag(MODULE_ID, "dungeonSlot") === slot,
  );
  if (!tokens.length) return;
  const actorIds = tokens
    .map((t) => t.actor?.id)
    .filter((id) => id && !partyActorIds().includes(id));
  await scene.deleteEmbeddedDocuments("Token", tokens.map((t) => t.id));
  if (actorIds.length) await Actor.deleteDocuments(actorIds);
}

/** Teardown counterpart to populateSlotTrap — same shape as
 * clearSlotEncounter above, for the slot's spawned hazard actor. */
export async function clearSlotTrap(scene, slot) {
  await clearSlotEncounter(scene, slot);
}
```

Check whether `partyActorIds` is already imported/available in this file (it's used elsewhere in this codebase, e.g. `dungeon-combat.mjs`) before using it — if not available here, use whatever this file's own existing party-membership check already is (check how `placePartyInSlot`/other functions in this same file distinguish party tokens from spawned NPCs) rather than importing a new dependency; the point is only to avoid deleting a real party member's Actor document if a party token somehow ever carried a `dungeonSlot` flag (it shouldn't, but guard defensively rather than assume). If `clearSlotTrap` turns out to need genuinely different logic once you read `populateSlotTrap`'s actual spawn shape in full (Step 1), diverge from `clearSlotEncounter` as needed — don't force identical code if the underlying spawn isn't identical.

- [ ] **Step 7: Run the full suite and format check**

Run: `npm test`
Expected: PASS, no regressions, plus this task's new tests.

Run: `npx prettier --check scripts/dungeon-scene.mjs scripts/dungeon-runner.mjs tests/dungeon-runner.test.mjs`

- [ ] **Step 8: Commit**

```bash
git add scripts/dungeon-scene.mjs scripts/dungeon-runner.mjs tests/dungeon-runner.test.mjs
git commit -m "Add per-content-type teardown functions for mutation reconciliation (#62)

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 5: Pure re-sync slot-mapping computation

**Files:**
- Modify: `scripts/dungeon-runner.mjs` (new `roomsNeedingResync`, near `roomsToEagerlyBuild`)
- Test: `tests/dungeon-runner.test.mjs`

**Interfaces:**
- Produces: `export function roomsNeedingResync(state, previousPhysicalSlotByRoomId, mutationBoundaryIndex)` — pure function. `state` is the run state AFTER `applySequenceMutation` has already spliced `state.rooms` (i.e., call this after the mutation, not before). `previousPhysicalSlotByRoomId` is `state.physicalSlotByRoomId` as it stood BEFORE the mutation (the caller must snapshot it first). `mutationBoundaryIndex` is `state.currentIndex` (the mutation always splices at `currentIndex + 1`, per `applySequenceMutation`'s own behavior — confirmed in this plan's research). Returns `{ toRebuild: [{room, physicalSlot, previousRoomId}], toOrphan: [physicalSlot], toExtend: [{room, physicalSlot}] }`:
  - `toRebuild`: for every index from `mutationBoundaryIndex + 1` to `state.rooms.length - 1`, if `previousPhysicalSlotByRoomId` already had a DIFFERENT room's id recorded at that index's "natural" slot (slot === index, the same invariant `roomsToEagerlyBuild` uses), include `{room: state.rooms[index], physicalSlot: index, previousRoomId}` — `previousRoomId` is whatever room id used to be recorded at `previousPhysicalSlotByRoomId`'s matching slot (found by reverse lookup), or `null` if none did.
  - `toOrphan`: any physical slot number that appeared as a value in `previousPhysicalSlotByRoomId` but has no corresponding index in the new (shorter, after `remove_next`) `state.rooms` array — empty for `insert_after`.
  - `toExtend`: for `insert_after` only, the single `{room, physicalSlot}` pair for the new final index that now needs a slot number that never physically existed before (i.e., `physicalSlot >= ` every value previously in `previousPhysicalSlotByRoomId`) — empty for `remove_next`.
- Consumes: nothing beyond its own parameters — no Foundry dependency, no `settingsRef`, fully pure (matches this file's `roomsToEagerlyBuild`/`canUndoRoomEntry` style).

- [ ] **Step 1: Write the failing tests**

Add to `tests/dungeon-runner.test.mjs` (add `roomsNeedingResync` to the import block):

```js
describe('roomsNeedingResync', () => {
  it('remove_next: rooms after the mutation point that shifted to a new slot are flagged for rebuild, and the vacated trailing slot is orphaned', () => {
    // Pre-mutation: eager-built rooms 0-4 at slots 0-4 (physicalSlot === index).
    // remove_next spliced out the old index-2 room — state.rooms now has 4
    // entries where the old index-3 room is now at index 2, old index-4 is
    // now at index 3.
    const oldR2 = { id: 'r2-old' };
    const oldR3 = { id: 'r3-old' };
    const oldR4 = { id: 'r4-old' };
    const state = {
      currentIndex: 1,
      rooms: [
        { id: 'r0' },
        { id: 'r1' },
        oldR3, // now at index 2, was at slot 3
        oldR4, // now at index 3, was at slot 4
      ],
    };
    const previousPhysicalSlotByRoomId = {
      r0: 0,
      r1: 1,
      'r2-old': 2,
      'r3-old': 3,
      'r4-old': 4,
    };
    const result = roomsNeedingResync(state, previousPhysicalSlotByRoomId, 1);
    expect(result.toRebuild).toEqual([
      { room: oldR3, physicalSlot: 2, previousRoomId: 'r2-old' },
      { room: oldR4, physicalSlot: 3, previousRoomId: 'r3-old' },
    ]);
    expect(result.toOrphan).toEqual([4]);
    expect(result.toExtend).toEqual([]);
  });

  it('insert_after: rooms after the mutation point shift the other way, and one new slot is needed at the tail', () => {
    const newRoom = { id: 'r-new' };
    const oldR2 = { id: 'r2-old' };
    const oldR3 = { id: 'r3-old' };
    const state = {
      currentIndex: 1,
      rooms: [
        { id: 'r0' },
        { id: 'r1' },
        newRoom,   // inserted, now at index 2
        oldR2,     // now at index 3, was at slot 2
        oldR3,     // now at index 4, was at slot 3
      ],
    };
    const previousPhysicalSlotByRoomId = {
      r0: 0,
      r1: 1,
      'r2-old': 2,
      'r3-old': 3,
    };
    const result = roomsNeedingResync(state, previousPhysicalSlotByRoomId, 1);
    expect(result.toRebuild).toEqual([
      { room: newRoom, physicalSlot: 2, previousRoomId: 'r2-old' },
      { room: oldR2, physicalSlot: 3, previousRoomId: 'r3-old' },
      { room: oldR3, physicalSlot: 4, previousRoomId: null },
    ]);
    expect(result.toOrphan).toEqual([]);
    expect(result.toExtend).toEqual([{ room: oldR3, physicalSlot: 4 }]);
  });

  it('returns all-empty when nothing after the mutation point actually changed identity', () => {
    const state = {
      currentIndex: 1,
      rooms: [{ id: 'r0' }, { id: 'r1' }, { id: 'r2' }],
    };
    const previousPhysicalSlotByRoomId = { r0: 0, r1: 1, r2: 2 };
    const result = roomsNeedingResync(state, previousPhysicalSlotByRoomId, 1);
    expect(result).toEqual({ toRebuild: [], toOrphan: [], toExtend: [] });
  });
});
```

Note the `insert_after` fixture: `oldR3` shows up in BOTH `toRebuild` (its content needs rebuilding at its new slot 4) AND `toExtend` (slot 4 is also physically new) — a room can be in both lists at once when a slot is simultaneously "new" and "needs the right content," which is exactly the `insert_after` tail case. Implement against these exact fixtures; if your first implementation attempt doesn't produce exactly this shape, the test (not your instinct) is the source of truth for what "correct" means here — re-derive your logic until it matches, don't loosen the assertions.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/dungeon-runner.test.mjs`
Expected: FAIL — `roomsNeedingResync is not a function`.

- [ ] **Step 3: Implement `roomsNeedingResync`**

In `scripts/dungeon-runner.mjs`, add near `roomsToEagerlyBuild`:

```js
/**
 * What a GM-less-hosted run's already-eagerly-built physical slots need
 * after a Reward/Ruin sequence mutation (#62) — computed by comparing the
 * "natural" slot for each still-unplayed room (physicalSlot === its index
 * into the now-mutated state.rooms, the same invariant roomsToEagerlyBuild
 * used when it originally built everything) against what was actually
 * built there before the mutation. Geometry never needs to change (a pure
 * function of slot number, confirmed in the design doc) — only which
 * logical room's CONTENT occupies a slot does.
 */
export function roomsNeedingResync(state, previousPhysicalSlotByRoomId, mutationBoundaryIndex) {
  const previousRoomIdBySlot = {};
  for (const [roomId, slot] of Object.entries(previousPhysicalSlotByRoomId)) {
    previousRoomIdBySlot[slot] = roomId;
  }

  const toRebuild = [];
  const usedSlots = new Set();
  for (let i = mutationBoundaryIndex + 1; i < state.rooms.length; i += 1) {
    const room = state.rooms[i];
    const physicalSlot = i;
    usedSlots.add(physicalSlot);
    const previousRoomId = previousRoomIdBySlot[physicalSlot] ?? null;
    if (previousRoomId !== room.id) {
      toRebuild.push({ room, physicalSlot, previousRoomId });
    }
  }

  const maxPreviousSlot = Object.values(previousPhysicalSlotByRoomId).reduce(
    (max, slot) => Math.max(max, slot),
    -1,
  );
  const toOrphan = [];
  for (let slot = mutationBoundaryIndex + 1; slot <= maxPreviousSlot; slot += 1) {
    if (previousRoomIdBySlot[slot] != null && !usedSlots.has(slot)) {
      toOrphan.push(slot);
    }
  }

  const toExtend = toRebuild.filter(({ physicalSlot }) => physicalSlot > maxPreviousSlot);

  return { toRebuild, toOrphan, toExtend };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/dungeon-runner.test.mjs`
Expected: PASS, all new tests plus every pre-existing test. If they don't match exactly, debug against the fixtures in Step 1 — do not adjust the tests to match a wrong implementation.

- [ ] **Step 5: Run the full suite and format check**

Run: `npm test`
Run: `npx prettier --check scripts/dungeon-runner.mjs tests/dungeon-runner.test.mjs`

- [ ] **Step 6: Commit**

```bash
git add scripts/dungeon-runner.mjs tests/dungeon-runner.test.mjs
git commit -m "Add roomsNeedingResync pure slot-reconciliation logic (#62)

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 6: Wire mutation re-sync into `resolveCurrentRoom`

**Files:**
- Modify: `scripts/ui/dungeon-app.mjs` (`resolveCurrentRoom`, currently lines ~190-192 per this plan's earlier research — re-locate exactly, other tasks/merges may have shifted it)

**Interfaces:**
- Consumes: `roomsNeedingResync` (Task 5), `clearPuzzleState`/`clearSkillChallengeState`/`clearNarrativeState` (Task 4), `clearSlotEncounter`/`clearSlotTrap` (Task 4), `commitEagerPhysicalSlots` (Task 3), `buildPopulateAndUnlockRoom(scene, state, room, physicalSlot, {unlock})` (Task 3's updated signature). `markRoomOutcome`'s existing return shape `{state, effectKey, mutation, nextRoomId, nextPhysicalSlot}` — `mutation` is `"remove_next"`, `"insert_after"`, or `null`.
- Produces: no new exports — `resolveCurrentRoom`'s external behavior is unchanged for a GM-hosted run or any run where no mutation fires; a GM-less-hosted run where a mutation fires now has its eagerly-built tail correctly reconciled instead of physically stranding the party.

- [ ] **Step 1: Read `resolveCurrentRoom`'s current full body**

It's the function that calls `markRoomOutcome` and then `buildPopulateAndUnlockRoom` for whatever comes next (read it in full — Tasks 3/4/5 may have shifted its exact line numbers, and other work may have merged changes to it since this plan was first written; do not assume the line numbers cited elsewhere in this plan are still exact).

- [ ] **Step 2: Snapshot pre-mutation bookkeeping and call the re-sync step**

Immediately after the existing call to `markRoomOutcome` (capture `state.physicalSlotByRoomId` from the state BEFORE that call, as `previousPhysicalSlotByRoomId`) and only when the returned `mutation` is non-null AND `state.hostUserId` is set (a GM-hosted run never eagerly builds ahead, so it has nothing to reconcile — its existing one-room-ahead behavior already handles a mutation correctly, unchanged, exactly as it does today), add:

```js
if (mutation && newState.hostUserId) {
  const { toRebuild, toOrphan, toExtend } = roomsNeedingResync(
    newState,
    previousPhysicalSlotByRoomId,
    newState.currentIndex,
  );
  for (const { room, physicalSlot } of toRebuild) {
    await clearSlotEncounter(scene, physicalSlot);
    await clearSlotTrap(scene, physicalSlot);
    await clearPuzzleState(newState.sceneId ?? scene.id, room.id);
    await clearSkillChallengeState(newState.sceneId ?? scene.id, room.id);
    await clearNarrativeState(newState.sceneId ?? scene.id, room.id);
    await buildPopulateAndUnlockRoom(scene, newState, room, physicalSlot, {
      unlock: false,
    });
  }
  for (const physicalSlot of toOrphan) {
    await clearSlotEncounter(scene, physicalSlot);
    await clearSlotTrap(scene, physicalSlot);
  }
  if (toRebuild.length) {
    await commitEagerPhysicalSlots(
      scene.id,
      toRebuild.map(({ room, physicalSlot }) => ({ room, physicalSlot })),
    );
  }
}
```

Adjust variable names (`newState`, `scene`, whatever `markRoomOutcome`'s call site currently names its own local variables) to match what Step 1's actual read found — the shape above is the logic, not a literal drop-in given this plan can't see the exact current local-variable names. Note `toExtend` needs no separate handling beyond what the `toRebuild` loop already does — per Task 5's own test, an extended slot always also appears in `toRebuild` (it needs the right content AND is physically new), so `buildPopulateAndUnlockRoom`'s existing `isSlotBuilt` guard (Task 3) correctly does a real build for it and a no-op-build-then-repopulate for every other `toRebuild` entry.

Call each `clear*` defensively (all four content-clear calls, even though only one will ever find something to clear per room, since a room's kind determines which single content type it actually has) — matches how `buildPopulateAndUnlockRoom` itself already checks `room.kind` conditionally elsewhere; check whether it's cleaner to gate each `clear*` call on the OLD room's kind (whatever `previousRoomId` mapped to) rather than call all four unconditionally — the `clear*` functions are no-ops when there's nothing to clear (Task 4), so either approach is correct, but gating on kind avoids pointless calls. Use your judgment on which reads better in context; either is an acceptable implementation.

- [ ] **Step 3: Run the full suite and format check**

Run: `npm test`
Run: `npx prettier --check scripts/ui/dungeon-app.mjs`

- [ ] **Step 4: Attempt live verification**

```bash
.claude/skills/foundry-rest/foundry-exec.sh <<'EOF'
return { worldId: game.world.id, actorCount: game.actors.size };
EOF
```

If reachable (the controller confirmed unreachable 3 times already this session — likely still unreachable, that's expected, not a new problem): start a GM-less run, force a `reduced_travel_time`/`extra_travel_time` outcome (check `dungeon-deck.mjs`'s outcome-slot-templates for how to target one deterministically via seed, or just resolve rooms until one fires), and confirm the party can physically walk from their current room all the way to whatever room is now logically next, with correct content at each slot along the way. If unreachable, disclose it in the PR and rely on Task 5's unit coverage plus this task's own hand-trace in Step 5 below.

- [ ] **Step 5: Self-review — hand-trace both mutation scenarios against the actual diff**

Write out, referencing exact line numbers in your own diff: (a) a `remove_next` firing when the current room resolves in a GM-less run where every room was eagerly built — confirm `roomsNeedingResync` is called with the correct pre-mutation snapshot, confirm the orphaned slot's teardown runs, confirm `commitEagerPhysicalSlots` persists the corrected mapping; (b) an `insert_after` firing — confirm the new tail slot gets a real `buildRoomAtSlot` call (not just a guard-skipped no-op) via `toExtend` also appearing in `toRebuild`. Include this trace in your task report.

- [ ] **Step 6: Commit**

```bash
git add scripts/ui/dungeon-app.mjs
git commit -m "Reconcile eagerly-built physical slots when a sequence mutation fires (#62)

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Revision 2 (2026-09-22, later the same day): Task 7 added after a second final-review stop

Tasks 1-6 above are DONE and independently verified correct (commits
through `61ce825` on branch `worktree-agent-aa5921258df7bf67c`). The final
whole-branch review found one more Critical bug, rooted in the same class
of false premise as the first (a design-doc claim that turned out to be
true-but-incomplete), not implementer error. Full trace: the controller's
own stop report in this session, and the revised design doc's "Second gap"
paragraph (`docs/superpowers/specs/2026-09-22-gmless-dungeon-precalculation-design.md`).

Global Constraints update: **the prior blanket ban on touching
`buildRoomAtSlot`/`dungeon-layout.mjs` is lifted, narrowly** — Task 7 may
add wall *flags* (metadata) to `roomEnclosureWalls`'s consumption in
`buildRoomAtSlot`. It may NOT change any geometry-shape function's actual
output — `roomSizeAt`, `slotRowCol`, `slotRect`, `roomSides`,
`outgoingFaceWall`, `doorOffsetAt`, `buildConnectionGeometry`,
`connectionDirection` all keep returning exactly what they return today,
for the same inputs. `applySequenceMutation` (`dungeon-deck.mjs`) remains
untouched, same as before.

### Task 7: Goal-room outgoing-connection retrofit

**Files:**
- Modify: `scripts/dungeon-scene.mjs` (`buildRoomAtSlot`'s wall creation, currently lines 177-267 per this plan's Task 3 changes — re-verify exact lines, other work may have shifted them; new `openGoalRoomExit` function near it)
- Modify: `scripts/ui/dungeon-app.mjs` (`resolveCurrentRoom`'s re-sync wiring from Task 6)
- Test: no automated test possible for the Foundry-heavy pieces (same boundary as the rest of `dungeon-scene.mjs`) — verified via live verification + hand-trace, per Step 4-5 below

**Interfaces:**
- Consumes: `connectionDirection(slot)`, `outgoingFaceWall(seed, slot)` (`dungeon-layout.mjs`, already exported, unchanged). `roomsNeedingResync`'s `toRebuild` entries (`{room, physicalSlot, previousRoomId}`, Task 5) and whatever pre-mutation snapshot Task 6 already captures.
- Produces: `async function openGoalRoomExit(scene, slot, seed)` in `dungeon-scene.mjs` — no return value needed (matches this file's other void-returning mutation helpers like `unlockDoorToSlot`).

- [ ] **Step 1: Read the current exact code before editing**

Read `buildRoomAtSlot`'s full current body (`scripts/dungeon-scene.mjs`) and confirm: (a) the exact line where `roomEnclosureWalls(...).map((side) => wallDoc(side))` builds the regular enclosure walls (no flags today), (b) the exact shape of the `if (!isGoal) { ... }` frontier-placeholder block (already read once during this plan's research — reconfirm it hasn't shifted), (c) `wallDoc`'s own signature (used throughout this file already, confirm it accepts a `flags` option the same way the door-wall calls in the `if (slot > 0)` block already use it).

- [ ] **Step 2: Tag enclosure walls with slot + direction**

Change:

```js
const walls = roomEnclosureWalls(seed, slot, { hasOutgoing: !isGoal }).map(
  (side) => wallDoc(side),
);
```

to:

```js
const walls = roomEnclosureWalls(seed, slot, { hasOutgoing: !isGoal }).map(
  (side) =>
    wallDoc(side, {
      flags: {
        [MODULE_ID]: {
          dungeonEnclosureWallForSlot: slot,
          dungeonEnclosureWallDirection: side.dir,
        },
      },
    }),
);
```

Confirm `side.dir` is the actual field name `roomEnclosureWalls`'s returned objects carry (it should be, per `roomEnclosureWalls`'s own `.map(([dir, c]) => ({ dir, ...c }))` — re-confirm against the real code from Step 1, don't assume).

- [ ] **Step 3: Implement `openGoalRoomExit`**

Add near `buildRoomAtSlot` in `scripts/dungeon-scene.mjs`:

```js
/**
 * Retrofits a slot originally built as the goal room (isGoal: true,
 * hasOutgoing: false, no frontier placeholder) into a normal room with a
 * real outgoing connection — needed when a sequence mutation (#62) shifts
 * the goal to a new slot and a non-goal room ends up occupying this one.
 * Finds and deletes the one enclosure wall on this slot's own connection
 * direction (flagged by buildRoomAtSlot's own wall creation above), then
 * creates the same frontier-placeholder wall a normal non-goal room gets
 * from the start (buildRoomAtSlot's `if (!isGoal)` block) — after this,
 * the existing, unmodified supersede-on-next-build logic in buildRoomAtSlot
 * (the `if (slot > 0)` block) already knows how to find and replace a
 * dungeonFrontierWallForSlot-flagged wall once the chain extends past it.
 */
export async function openGoalRoomExit(scene, slot, seed) {
  const dir = connectionDirection(slot);
  const staleWallIds = scene.walls
    .filter(
      (w) =>
        w.getFlag(MODULE_ID, "dungeonEnclosureWallForSlot") === slot &&
        w.getFlag(MODULE_ID, "dungeonEnclosureWallDirection") === dir,
    )
    .map((w) => w.id);
  if (!staleWallIds.length) return;
  await scene.createEmbeddedDocuments("Wall", [
    wallDoc(outgoingFaceWall(seed, slot), {
      flags: { [MODULE_ID]: { dungeonFrontierWallForSlot: slot } },
    }),
  ]);
  await scene.deleteEmbeddedDocuments("Wall", staleWallIds);
}
```

Note the create-then-delete order (matches the existing `if (slot > 0)` block's own comment about why — never delete before the replacement exists, to avoid a real vision/light-leak window). Confirm `connectionDirection` and `outgoingFaceWall` are already imported into this file from `dungeon-layout.mjs` (they're used elsewhere in this file already, per this plan's earlier research) — add them to the import if not.

- [ ] **Step 4: Wire it into Task 6's re-sync step**

Read Task 6's current code in `resolveCurrentRoom` (`scripts/ui/dungeon-app.mjs`) — the loop over `toRebuild` entries. Before that loop's existing `buildPopulateAndUnlockRoom` call for a given entry, add a check: if this entry's slot was previously the goal room's slot, call `openGoalRoomExit` first.

You need to know whether `physicalSlot` was previously the goal's slot. The cleanest signal: capture, alongside the `previousPhysicalSlotByRoomId` snapshot Task 6 already takes before the mutation, which room id was flagged `isGoal` in the pre-mutation `state.rooms` (there is always exactly one). Then for each `toRebuild` entry, check whether its `previousRoomId` matches that captured goal-room id:

```js
const previousGoalRoomId = newState.rooms.find((r) => r.isGoal)?.id;
// ...capture this from `state` BEFORE markRoomOutcome mutates it, same
// timing as previousPhysicalSlotByRoomId — re-derive the exact variable
// names from your own Step 1 read of the current code, this is the logic,
// not a literal drop-in.
```

Wait — re-derive this carefully: the goal room's identity doesn't change across a mutation (`applySequenceMutation` never touches it, confirmed in the design doc), so `previousGoalRoomId` can be found from either the pre- or post-mutation `state.rooms` — they're the same room either way. What changes is which SLOT that room now occupies (a fresh one, via `toExtend`). So the actual check for `openGoalRoomExit` is simpler than the draft above: for each `toRebuild` entry, call `openGoalRoomExit(scene, physicalSlot, state.seed)` if `entry.previousRoomId === previousGoalRoomId` — i.e., if the room that USED TO occupy this slot (before re-sync) was the goal. Use `roomsNeedingResync`'s own `previousRoomId` field (Task 5) for this, not a fresh lookup.

```js
for (const { room, physicalSlot, previousRoomId } of toRebuild) {
  if (previousRoomId === previousGoalRoomId) {
    await openGoalRoomExit(scene, physicalSlot, newState.seed);
  }
  await clearSlotEncounter(scene, physicalSlot);
  /* ...rest of Task 6's existing per-entry teardown+rebuild, unchanged... */
}
```

Adjust variable names to match Task 6's actual current code (re-read via Step 1's own instruction — do not assume the names above are exactly what's there).

- [ ] **Step 5: Run the full suite and format check**

Run: `npm test`
Expected: PASS, no regressions from the Task 1-6 baseline.

Run: `npx prettier --check scripts/dungeon-scene.mjs scripts/ui/dungeon-app.mjs`

- [ ] **Step 6: Attempt live verification**

Same command/fallback as every prior task:

```bash
.claude/skills/foundry-rest/foundry-exec.sh <<'EOF'
return { worldId: game.world.id, actorCount: game.actors.size };
EOF
```

If reachable: start a GM-less run, force an `insert_after` (via `extra_travel_time`), and confirm the party can walk from the old goal's slot, through the newly-opened connection, to the new goal slot — no locked/missing wall, no vision leak. If unreachable (expected — every attempt across three sessions has failed so far), disclose it and rely on Step 7's hand-trace.

- [ ] **Step 7: Self-review — hand-trace the exact scenario that broke this the first time**

Write out, referencing exact line numbers in your own diff: an `insert_after` firing when the room immediately before the (old) goal resolves — confirm `openGoalRoomExit` is called for the slot the goal used to occupy, confirm it finds exactly one stale wall (the one on `connectionDirection(slot)`), confirm the replacement frontier-placeholder wall has the correct coordinates (matches `outgoingFaceWall(seed, slot)`, the same function a normal room's own build would have used), and confirm the NEW goal slot (via `toExtend`, already built by Task 6's existing code) gets real `isGoal: true` / `hasOutgoing: false` geometry, unaffected by any of this. Include this trace in your task report — this is exactly the class of bug that slipped through twice already, so don't skip it.

- [ ] **Step 8: Update issue #62 and run `update-architecture-docs`**

Post a progress comment on #62 marking Task 7 done. Run the `update-architecture-docs` skill once (per this repo's CLAUDE.md, required whenever a merge rewires `scripts/` imports — Tasks 3-7 together add several new cross-file exports).

- [ ] **Step 9: Bump version and commit**

Check `module.json`'s current version in your worktree (never reuse a prior number — other work keeps merging). Patch bump.

```bash
git add scripts/dungeon-scene.mjs scripts/ui/dungeon-app.mjs module.json docs/architecture.md
git commit -m "Retrofit a relocated goal room's outgoing connection after a mutation (#62)

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Revision 3 (2026-09-22, same day): Task 8 added after a third final-review stop

Tasks 1-7 above are DONE and independently verified correct (commits through
`580c25e` on branch `worktree-agent-aa5921258df7bf67c`). Task 7's own
adversarial final-review pass found a fourth instance of the same bug
class — this one in the original Task 1 `roomsToEagerlyBuild` logic, not
in any of the mutation-reconciliation work, and not requiring a mutation
to trigger at all.

**The bug:** a GM-less run whose room at index 1 happens to be combat-kind
(the pre-existing ITEM-11 deferral, decided purely by the seeded room-kind
draw) permanently strands the party. `roomsToEagerlyBuild` skips slot 1
(deferred to "Populate Next Room") but still eagerly builds slot 2. Slot 2's
build (`buildRoomAtSlot`'s `if (slot > 0)` block) unconditionally pours the
real door connecting slot 1→2 onto slot 1's own outgoing face — before slot
1 itself has been built at all. When slot 1 is later built (via "Populate
Next Room"), its own `if (!isGoal)` frontier-placeholder block
unconditionally creates a NEW placeholder wall directly over that
already-real door, with no way to ever be superseded, because the
supersede-on-next-build logic only runs when the NEXT slot gets built —
and slot 2 is already built and will never be built again.

**The fix (confirmed independently against the source, not just reported):**
guard the frontier-placeholder creation with `isSlotBuilt`, the exact same
idempotency-guard function Task 3 already established — if the next slot
already exists, a placeholder would immediately be wrong (the real
connection is already there), so skip creating one.

Global Constraints addition: this task edits `buildRoomAtSlot`'s existing
`if (!isGoal)` block directly (a conditional guard around an existing
`walls.push(...)` call) — still no change to any geometry-shape function's
actual output for the cases where the guard doesn't fire.

### Task 8: Skip the frontier placeholder when the next slot is already built

**Files:**
- Modify: `scripts/dungeon-scene.mjs` (`buildRoomAtSlot`'s `if (!isGoal)` block)
- Test: no automated test possible (same Foundry-heavy boundary as Tasks 3/7) — verified via live verification + hand-trace

**Interfaces:**
- Consumes: `isSlotBuilt(scene, slot)` (`dungeon-scene.mjs`, already exported, unchanged).
- Produces: no new exports — `buildRoomAtSlot`'s external behavior is unchanged for every case except "the next slot already exists," which is the exact case that was broken.

- [ ] **Step 1: Read the current exact code**

Re-read `buildRoomAtSlot`'s `if (!isGoal) { ... }` block in full (`scripts/dungeon-scene.mjs`) — confirm it hasn't shifted since Task 7's own edits.

- [ ] **Step 2: Add the guard**

Change:

```js
  if (!isGoal) {
    // Frontier placeholder (ITEM-20): ...
    walls.push(
      wallDoc(outgoingFaceWall(seed, slot), {
        flags: { [MODULE_ID]: { dungeonFrontierWallForSlot: slot } },
      }),
    );
  }
```

to:

```js
  if (!isGoal && !isSlotBuilt(scene, slot + 1)) {
    // Frontier placeholder (ITEM-20): this room has no outgoing connection
    // built yet, so without a wall here it's open on that entire face
    // until the next room is built — vision, light, and movement all leak
    // straight across the rest of the scene's pre-sized canvas. Deleted
    // and replaced by the real door/opening geometry above the moment
    // that next room actually gets built. Skipped entirely if the next
    // slot is ALREADY built (#62) — an eager GM-less build can build a
    // higher-numbered slot before this one (e.g. a deferred combat room
    // at slot 1 built after slot 2 already exists), in which case the
    // real connection already exists and a placeholder here would
    // immediately be stale, permanently overlaying a door that will never
    // get superseded (nothing triggers supersede-on-next-build for an
    // already-built next slot).
    walls.push(
      wallDoc(outgoingFaceWall(seed, slot), {
        flags: { [MODULE_ID]: { dungeonFrontierWallForSlot: slot } },
      }),
    );
  }
```

- [ ] **Step 3: Run the full suite and format check**

Run: `npm test`
Expected: PASS, no regressions from the Task 1-7 baseline (39 files / 1680 tests).

Run: `npx prettier --check scripts/dungeon-scene.mjs`

- [ ] **Step 4: Attempt live verification**

Same command/fallback as every prior task. If reachable: start a GM-less run seeded so room 1 is combat-kind, resolve room 0 (auto-advances), confirm slot 2 (and beyond) built correctly, then use "Populate Next Room" to build slot 1 and confirm the slot 1↔2 door is the original real one (not overwritten), and the party can walk through normally. If unreachable (check whether `FOUNDRY_REST_API_KEY` is actually configured in your worktree this time — the prior session flagged a harder failure mode than "relay unreachable"; if it's a missing/misconfigured key rather than an unreachable world, say so explicitly, it's a different problem than the "world not open in a browser" case every prior session hit), disclose whichever it is and rely on Step 5.

- [ ] **Step 5: Self-review — hand-trace the exact scenario that broke this**

Write out, referencing exact line numbers in your own diff: a GM-less run where `roomsToEagerlyBuild` skips slot 1 (combat-kind) and builds slot 2 first — confirm slot 2's build creates the real slot-1↔2 door via `buildConnectionGeometry(1, seed)`. Then confirm that when slot 1 is later built via "Populate Next Room," `isSlotBuilt(scene, 2)` correctly returns true, the guard skips the placeholder, and slot 1's own enclosure walls (from `roomEnclosureWalls`, which already excludes the outgoing-direction face when `hasOutgoing` is true) leave that face correctly open onto the already-real connection with no stale wall on top of it. Include this trace in your task report.

- [ ] **Step 6: Update issue #62**

Post a progress comment marking Task 8 done.

- [ ] **Step 7: Bump version and commit**

Check `module.json`'s current version (never reuse a prior number).

```bash
git add scripts/dungeon-scene.mjs module.json
git commit -m "Skip the frontier-placeholder wall when the next slot is already built (#62)

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

- [ ] **Step 8: Final whole-branch review, then PR**

Dispatch the final whole-branch review covering all 8 tasks together (per the subagent-driven-development skill's own process — most capable model). Point it explicitly at the pattern this whole plan has now hit three times (an ascending-build-order assumption breaking in a spot none of the prior passes checked) and ask it to look adversarially for a fifth instance, the same way Task 7's own review was asked to. If clean (or findings are fixed/parked-with-ruling per the skill's own breaker process), open the PR (body ending "Closes #62", standard attribution) and STOP — do not merge or enable automerge, same reasoning as every prior task in this plan. Leave `in progress` on #62 until it's merged.

If this review finds yet another gap in the same class: stop and report with full independent verification, exactly as the last three times — do not attempt a fifth fix without going back to Cory first.

---

## Self-Review Notes

**Tasks 1-2 (original):**
- **Spec coverage:** Detection mechanism (Task 2, Step 1-2) — covered, and corrected from the spec's placeholder guess (`!game.users.get(hostUserId)?.isGM`) to the actually-established `state.hostUserId` truthiness check, confirmed against `unpauseIfGmLessRun` and `encounter-generator.mjs`'s `skipPreview`. Eager base-sequence build (Task 1 + Task 2) — covered. Combat-room-at-index-1 deferral preserved — covered by `roomsToEagerlyBuild`'s own logic and Task 1's dedicated test for it, plus the non-index-1 case explicitly tested too so the exception can't accidentally widen to "skip all combat rooms."
- **Placeholder scan:** no TBD/TODO; every code step has real, complete code; the live-verification step gives concrete commands and an explicit disclosed-fallback path rather than "test appropriately."
- **Type consistency:** `roomsToEagerlyBuild(state)` returns `{ room, physicalSlot }` in both its definition (Task 1) and its consumption (Task 2's destructuring loop) — consistent. `buildPopulateAndUnlockRoom(scene, state, room, physicalSlot)`'s call shape in Task 2 matches its real signature read directly from `dungeon-scene.mjs:753-758`.

**Tasks 3-6 (this revision), re-reviewed against the revised spec:**
- **Spec coverage:** the `unlock` option and `commitEagerPhysicalSlots` — covered (Task 3), correcting the original fix brief's `unlock: false` bug found by the prior fix-implementer. Per-content-type teardown — covered (Task 4), all 5 content types named in the design doc's "Mutation reconciliation" section have a task step. Re-sync computation and wiring — covered (Task 5 + Task 6), both `remove_next` and `insert_after` explicitly tested and wired. Error-handling requirement (teardown+rebuild one slot at a time, not the whole range up front) — covered by Task 6's per-entry loop structure (each `toRebuild` entry's clear+rebuild happens together, before moving to the next entry).
- **Placeholder scan:** Task 4's `clearSlotTrap` body explicitly says "if it needs genuinely different logic... diverge" rather than mandating identical code sight-unseen — this is a judgment call for the implementer to make after reading the real `populateSlotTrap`, not a placeholder; the plan is explicit that verifying this is a required step, not an optional one.
- **Type consistency:** `roomsNeedingResync`'s return shape (`{toRebuild, toOrphan, toExtend}`, each a real array with named fields) is used identically in its own tests (Task 5) and in Task 6's consumption of it. `commitEagerPhysicalSlots(sceneId, eagerlyBuilt, opts)`'s `eagerlyBuilt` parameter shape (`{room, physicalSlot}` pairs) matches both Task 3's own call site (passing `roomsToEagerlyBuild`'s output) and Task 6's call site (passing `toRebuild` mapped down to just `{room, physicalSlot}`).
- **Cross-task risk flagged, not hidden:** Task 6 explicitly tells its implementer not to trust this plan's own cited line numbers for `resolveCurrentRoom` and to re-read the actual current file — by the time Task 6 runs, Tasks 3-5 (and possibly other unrelated merged work) will have shifted it. This is a deliberate acknowledgment that a plan spanning 6 tasks across a file under concurrent development can't pin exact line numbers reliably that far ahead; the interfaces (function signatures) are pinned instead, which is what actually matters for correctness.
