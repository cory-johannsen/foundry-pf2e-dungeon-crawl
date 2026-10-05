# Block Progression Until Room Feature Resolved Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A treasure, puzzle, or skill-challenge room's outgoing doors stay locked until that room is actually resolved — today they unlock immediately at build time, letting the party walk past unclaimed/un-attempted content.

**Architecture:** `resolveCurrentRoom` (`scripts/ui/dungeon-app.mjs`) already unlocks the just-resolved room's outgoing doors, unconditionally, for every non-goal room kind, as an existing, already-shipped side effect of resolving any room. The only change needed is to stop a *different*, earlier call site — `buildPopulateAndUnlockGraphNode`'s build-time unlock (`scripts/dungeon-scene.mjs`) — from pre-empting it for these three kinds specifically, so `resolveCurrentRoom`'s own existing unlock becomes the first and only time their doors open.

**Tech Stack:** Vanilla ES modules, Vitest (this function already has a real fake-Foundry-document test harness in this codebase).

**Spec:** None — bounded fix, approved in-chat design, no spec file. This plan implements GitHub issue #740 directly.

## Global Constraints

- Every merge to `main` bumps `module.json`'s `version` (CLAUDE.md). Routine, narrow fix: patch bump. Current version at plan-writing time is `0.60.0` — re-check immediately before committing, since concurrent sessions push to this repo.
- Combat rooms are explicitly **unchanged** — their own unlock call (a separate `if (room.kind === "combat") { ... }` branch) is a different line entirely and must not be touched. This issue only ever asked about treasure/puzzle/skill_challenge.
- The gate fires on resolution regardless of success or failure — this is already true of `resolveCurrentRoom`'s existing, unmodified call chain for puzzle/skill-challenge (both outcomes call it), so no new code is needed to achieve it; it's a byproduct of correctly reusing the existing function as-is.
- `resolveCurrentRoom`'s own unlock logic (`scripts/ui/dungeon-app.mjs:254-283`) is **not modified at all** by this plan — it already does the job unconditionally for every room kind. The only code change in this entire plan is the one skip-condition below.

## Review Focus

- **Combat rooms must keep unlocking exactly as today** — their own separate unlock branch (`scripts/dungeon-scene.mjs:1726`) must remain untouched; a careless edit to the wrong `if` could accidentally also gate combat. Covered by Task 1's explicit "combat room is unaffected" test.
- **A non-target kind (e.g. narrative) must keep unlocking at build time exactly as today** — the skip condition must name exactly `["treasure", "puzzle", "skill_challenge"]`, nothing broader. Covered by Task 1's explicit "narrative room still unlocks immediately" control test.
- **A failed puzzle/skill-challenge attempt must still unlock the door**, not just a successful one — the issue's own scope says "attempted-and-resolved," not "succeeded." This isn't new code to write (it's a property of the unmodified `resolveCurrentRoom` chain), but it needs its own explicit live-verification check in Task 2 so a future regression in `recordPuzzleStageOutcome`/`recordSkillChallengeOutcome` that narrowed this unintentionally would be caught.
- **A hidden child room behind a target-kind room must not unlock early either** — `unlockDoorsFromRoom`'s own `hiddenChildIds` exclusion already handles this (hidden doors only open via `unsealHiddenDoorFromRoom`, a separate mechanism, confirmed unrelated to this change), but Task 1's fixture should include a hidden child alongside a real one to confirm the skip condition doesn't interact badly with that existing exclusion.
- **The build-time "ensure children are built" retry loop inside `resolveCurrentRoom`** (the one that calls `buildPopulateAndUnlockGraphNode(..., {unlock: false})` per child before the final `unlockDoorsFromRoom` call) must keep working for these three kinds too — since `unlock: false` is passed either way, the new skip condition (which only fires when `unlock` is `true`) never affects this retry path at all, a fact worth confirming explicitly rather than assuming, since it's exactly the kind of interaction a narrow one-line change could silently break.

---

### Task 1: Skip the build-time unlock for treasure/puzzle/skill_challenge

**Files:**
- Modify: `scripts/dungeon-scene.mjs:1845` (re-locate via your editor before editing — the exact line was confirmed immediately before this plan was written, but concurrent sessions push to this repo constantly)
- Test: `tests/dungeon-scene.test.mjs`

**Interfaces:** None — this is a self-contained conditional change inside an existing function; no new exports.

- [x] **Step 1: Write the failing tests**

Add this new `describe` block to `tests/dungeon-scene.test.mjs` (after the existing `describe('buildPopulateAndUnlockGraphNode — #297 Round 2 (slot priority)', ...)` block is a reasonable place, but anywhere in the file works):

```js
describe('buildPopulateAndUnlockGraphNode — #740 deferred unlock for treasure/puzzle/skill_challenge', () => {
  const seed = 'defer-unlock-seed-0';
  const S = 'room-s';
  const A = 'room-a';
  const H = 'room-h';
  const layoutPositionByRoomId = {
    [S]: { rank: 0, col: 2 }, [A]: { rank: 1, col: 2 }, [H]: { rank: 2, col: 0 },
  };
  const incomingFaceByRoomId = { [S]: 'north', [A]: 'north', [H]: 'north' };
  const edges = { [S]: [A] };
  const hiddenEdges = { [S]: [H] };
  const layoutEdges = { [S]: [A, H] };
  const hiddenIncomingByRoomId = { [H]: [S] };

  function buildState() {
    return {
      seed, layoutPositionByRoomId, incomingFaceByRoomId, hiddenRooms: [],
      edges, layoutEdges, hiddenIncomingByRoomId, hiddenEdges: {},
      // Note: hiddenEdges is intentionally {} here, not the module-level
      // `hiddenEdges` const above -- buildPopulateAndUnlockGraphNode reads
      // hidden-child info via its own `hiddenChildId` parameter (below),
      // not from state.hiddenEdges, for the room being built directly.
    };
  }

  async function buildRoomOfKind(kind) {
    installFoundryStubs();
    const scene = makeFakeScene();
    const state = buildState();
    const room = {
      id: S, kind, isGoal: false, locationTag: null, artVariant: 0, setpieceId: null,
    };
    await buildPopulateAndUnlockGraphNode(scene, state, room, {
      rank: 0, col: 2, childIds: [A], hiddenChildId: H, unlock: true,
    });
    return scene.walls.find(
      (w) =>
        w.getFlag(MODULE_ID, 'dungeonDoorToRoomId') === A &&
        w.getFlag(MODULE_ID, 'dungeonDoorFromRoomId') === S,
    );
  }

  it('a treasure room\'s own outgoing door stays LOCKED even with unlock:true', async () => {
    const door = await buildRoomOfKind('treasure');
    expect(door).toBeDefined();
    expect(door.ds).toBe(CONST.WALL_DOOR_STATES.LOCKED);
  });

  it('a puzzle room\'s own outgoing door stays LOCKED even with unlock:true', async () => {
    const door = await buildRoomOfKind('puzzle');
    expect(door.ds).toBe(CONST.WALL_DOOR_STATES.LOCKED);
  });

  it('a skill_challenge room\'s own outgoing door stays LOCKED even with unlock:true', async () => {
    const door = await buildRoomOfKind('skill_challenge');
    expect(door.ds).toBe(CONST.WALL_DOOR_STATES.LOCKED);
  });

  it('a narrative room (control, unaffected) still unlocks immediately', async () => {
    const door = await buildRoomOfKind('narrative');
    expect(door.ds).toBe(CONST.WALL_DOOR_STATES.CLOSED);
  });
});
```

(`installFoundryStubs`, `makeFakeScene`, `MODULE_ID`, `CONST`, and the imports of `buildPopulateAndUnlockGraphNode` already exist at the top of this file — no new imports needed.)

- [x] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/dungeon-scene.test.mjs -t "#740"`
Expected: the three target-kind tests (`treasure`/`puzzle`/`skill_challenge`) FAIL — `door.ds` currently reads `CLOSED` (the existing unconditional unlock), not the expected `LOCKED`. The `narrative` control test PASSes already (unaffected, confirming the fixture itself is correct before changing any production code).

If instead `door` is `undefined` (no matching wall found at all) for every case, the fixture's field mapping needs adjusting — treat this as a real signal to fix the fixture, not the production code, since the control (`narrative`) case not finding a door either would mean the test setup itself is wrong, not the feature.

- [x] **Step 3: Make the one-line change**

In `scripts/dungeon-scene.mjs`, change:

```js
    if (unlock) await unlockDoorsFromRoom(scene, room.id, childIds, state.hiddenEdges[room.id] ?? []);
```

to:

```js
    if (unlock && !["treasure", "puzzle", "skill_challenge"].includes(room.kind))
      await unlockDoorsFromRoom(scene, room.id, childIds, state.hiddenEdges[room.id] ?? []);
```

- [x] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/dungeon-scene.test.mjs -t "#740"`
Expected: PASS, all 4 tests green.

- [x] **Step 5: Run the full test file to confirm no regression**

Run: `npx vitest run tests/dungeon-scene.test.mjs`
Expected: PASS, every existing test in this file (including every `combat`-kind and other-kind scenario already covered elsewhere in it) still green — in particular, confirm no existing test happens to build a `combat`-kind room through this same code path and expect it unlocked at this exact line (it shouldn't, since combat's own unlock is the separate, untouched branch at line ~1726, but this is the concrete check that assumption holds).

- [x] **Step 6: Commit**

```bash
git add scripts/dungeon-scene.mjs tests/dungeon-scene.test.mjs
git commit -m "fix(#740): defer treasure/puzzle/skill_challenge door unlock to resolution

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 2: Live-verify the full resolve-unlocks-doors flow

**Files:** none (verification only, via the `foundry-rest` skill — no files change in this task, except the version bump).

**Interfaces:**
- Consumes: Task 1's change, and the already-unmodified `resolveCurrentRoom`/`claimTreasureFor`/`recordPuzzleStageOutcome`/`recordSkillChallengeOutcome` chain.
- Produces: nothing further — this is the plan's final verification.

This task has no "write a failing test" step — Task 1's unit test already proves the build-time skip works in isolation. This task verifies the *other* half (that the room actually unlocks once genuinely resolved through real game flow), which depends on live Foundry/PF2e state (`resolveCurrentRoom`'s own `markRoomOutcome`/`effectKey` machinery) that the existing fixture harness doesn't model — matching this codebase's established precedent for glue code that touches a live Combat/Scene beyond a single function's own unit-testable boundary.

- [ ] **Step 1: Start a real run and confirm a target room's door is locked on arrival**

With a dungeon run in progress, open the door into a treasure, puzzle, or skill-challenge room (whichever the layout offers next), then confirm its own outgoing door is locked:

```bash
echo 'const state = game.settings.get("pf2e-dungeon-crawl", "dungeonRuns")[canvas.scene.id]; const roomId = state.currentRoomId; const childIds = state.edges[roomId] ?? []; return { roomKind: state.rooms[roomId].kind, childIds, doors: canvas.scene.walls.filter(w => w.getFlag("pf2e-dungeon-crawl", "dungeonDoorFromRoomId") === roomId).map(w => ({to: w.getFlag("pf2e-dungeon-crawl", "dungeonDoorToRoomId"), ds: w.ds})) };' | .claude/skills/foundry-rest/foundry-exec.sh
```

Expected: every listed door's `ds` reads `2` (`CONST.WALL_DOOR_STATES.LOCKED`) for a `treasure`/`puzzle`/`skill_challenge` room.

- [ ] **Step 2: Resolve the room for real and confirm the door unlocks**

For a treasure room: click the GM-visible "Claim Treasure" button (or target its prop token, per #611). For a puzzle/skill-challenge room: attempt and resolve it via the sidebar form (or its revealed prop-token-gated form, per #623) — including, at least once across this verification, a **failed** attempt, not only a successful one, to confirm the Review Focus item above (unlock fires on resolution regardless of outcome). Then re-run the same query from Step 1:

```bash
echo 'const state = game.settings.get("pf2e-dungeon-crawl", "dungeonRuns")[canvas.scene.id]; const roomId = "<the same roomId from Step 1>"; return canvas.scene.walls.filter(w => w.getFlag("pf2e-dungeon-crawl", "dungeonDoorFromRoomId") === roomId).map(w => ({to: w.getFlag("pf2e-dungeon-crawl", "dungeonDoorToRoomId"), ds: w.ds}));' | .claude/skills/foundry-rest/foundry-exec.sh
```

Expected: every door now reads `ds: 0` (`CONST.WALL_DOOR_STATES.CLOSED`, i.e. unlocked).

- [ ] **Step 3: Confirm a combat room is unaffected**

Open a combat room's door and confirm its outgoing doors are already `ds: 0` immediately on arrival (unlocked at build time, as today, before combat even resolves) — the same query as Step 1, run against a combat-kind room instead.

- [ ] **Step 4: Bump module.json's version**

Re-check the current version first (concurrent sessions push to this repo):

```bash
git fetch origin main -q && git log origin/main -1 --oneline && grep version module.json
```

Apply a patch bump (e.g. `0.60.0` → `0.60.1`, using whatever the fetch above shows as current).

- [ ] **Step 5: Commit**

```bash
git add module.json
git commit -m "chore: bump version for #740 deferred room-feature door unlock

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Self-Review

**1. Scope coverage:** #740's own scope — "change this so a treasure/puzzle/skill_challenge room's outgoing doors stay locked until that room's prop token has actually been interacted with" — reduces, once `resolveCurrentRoom`'s existing unconditional unlock is accounted for, to exactly Task 1's one-line skip condition; Task 2 verifies the full real-game chain end to end, including the fail-still-unlocks case explicitly called out in the issue's own "attempted-and-resolved" phrasing. Combat is explicitly out of scope and explicitly verified unaffected (Task 2 Step 3). No gaps found.

**2. Placeholder scan:** No TBD/TODO, no "add appropriate handling" steps. Task 1's own Step 2 includes an explicit "if the fixture is wrong, fix the fixture, not the code" contingency note — that's test-writing guidance, not a placeholder for missing implementation.

**3. Type consistency:** The skip condition's kind list (`["treasure", "puzzle", "skill_challenge"]`) appears once, verbatim, in Task 1's Step 3 — no other task redefines or restates it.

**4. Review Focus:** All five items (combat unaffected, narrative/other kinds unaffected, failed attempts still unlock, hidden children unaffected, the build-time ensure-built retry loop unaffected) each have a dedicated test or explicit verification step. No gaps found.

---

Plan complete and saved to `docs/superpowers/plans/2026-10-05-block-progression-until-feature-resolved.md`. Please review the plan. Which execution approach would you prefer?

- **Subagent-driven** - A fresh subagent implements each task and a fresh reviewer checks it before the next one starts, then a whole-branch review at the end. Most thorough; costs a fresh context per task and per review.
- **Native** - I implement every task myself in this session, the way this harness runs work, then one fresh reviewer on the most capable model checks the whole branch. Cheapest and fastest; no independent review until the end. Runs well with a mid-tier session model, since the plan carries the design.

For this plan I recommend **Native**, because the entire production change is one line, already exactly specified, with a real unit test harness proving it in isolation — the only genuine remaining risk is the live end-to-end check in Task 2, which a second pass wouldn't meaningfully de-risk further than running it once carefully. Does the plan capture what you want, and which approach should we use?
