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

## Self-Review Notes

- **Spec coverage:** Detection mechanism (Task 2, Step 1-2) — covered, and corrected from the spec's placeholder guess (`!game.users.get(hostUserId)?.isGM`) to the actually-established `state.hostUserId` truthiness check, confirmed against `unpauseIfGmLessRun` and `encounter-generator.mjs`'s `skipPreview`. Eager base-sequence build (Task 1 + Task 2) — covered. Mutations untouched — no task touches `dungeon-deck.mjs`/`applySequenceMutation`, satisfying this by omission. Combat-room-at-index-1 deferral preserved — covered by `roomsToEagerlyBuild`'s own logic and Task 1's dedicated test for it, plus the non-index-1 case explicitly tested too so the exception can't accidentally widen to "skip all combat rooms."
- **Placeholder scan:** no TBD/TODO; every code step has real, complete code; the live-verification step gives concrete commands and an explicit disclosed-fallback path rather than "test appropriately."
- **Type consistency:** `roomsToEagerlyBuild(state)` returns `{ room, physicalSlot }` in both its definition (Task 1) and its consumption (Task 2's destructuring loop) — consistent. `buildPopulateAndUnlockRoom(scene, state, room, physicalSlot)`'s call shape in Task 2 matches its real signature read directly from `dungeon-scene.mjs:753-758`.
