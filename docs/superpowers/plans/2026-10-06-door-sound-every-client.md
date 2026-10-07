# Door Sounds Play On Every Client Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Fix #868 — door open/lock/unlock sounds silently never play because they are only ever triggered by GM-gated code, and this table's actual GM side is mostly unattended (confirmed with the owner this session) — no continuously-connected GM client exists for the sound call to run on.

**Root cause (confirmed by direct code reading + live checks, this session, current `main`):** Every `playDoorSound(...)` call site in `scripts/dungeon-scene.mjs` sits either (a) inside `handleDungeonDoorOpened`, which starts with `if (!game.user.isGM) return` (confirmed current, line 2324), or (b) inside a state-mutation function (`relockDoorFromRoom`, `setGateDoorState`, `unlockDoorsFromRoom`) that is itself only ever invoked from GM-authoritative room-resolution code. Both require a client satisfying `game.user.isGM` to actually be connected and running that code at the moment the door event happens. Live-checked this session: `game.users.contents` shows two `isGM: true` accounts, and the real "Gamemaster" user is `active: false` during actual play — confirmed with the owner that the GM side runs mostly unattended. The low-level sound mechanism itself is not broken: `foundry.audio.AudioHelper.play(...)` was called live this session and returned a valid `Sound` with no errors. `#600` (the sound-preview-menu PR) only added new exports/a preview function to `dungeon-sound.mjs` and never touched any playback call site — ruled out as a regression cause.

**Scope decisions (confirmed with the owner this session):** No door-close sound is added — #868's own "if desired" close-sound ask is explicitly declined; stay scoped to restoring open/lock/unlock. Fix the actual regression: sound playback must not depend on which client happens to be running GM-authoritative state-mutation code.

**Architecture:** Door sounds already correspond to real, observable Wall document state transitions (`ds` → `OPEN`/`LOCKED`/`CLOSED`) that Foundry's own document sync already delivers to *every* connected client via the existing `updateWall` hook — the same hook `module.mjs` already uses to detect "open" (gated on `game.user.isGM` today). Moving sound selection to react to that hook, **unconditionally** (every client, not just the GM one), on all three transitions makes sound playback a pure, universal reaction to a state change that already reaches everyone — with zero dependency on a live GM session. Each client then plays its own copy locally (`broadcast: false`) rather than one GM client broadcasting to the rest, which both removes the single-point-of-failure and avoids the multiplied-echo problem a broadcast design would now cause once every client independently reacts.

**Tech Stack:** Vanilla ES modules, Vitest, Foundry VTT hooks.

**Spec:** None — bounded; the flow (the `updateWall` hook, `playDoorSound`, the wall flags each sound already keys off) already exists in this repo.

## Global Constraints

- Every merge to `main` bumps `module.json`'s `version` (CLAUDE.md). A contained bug fix: patch bump.
- No door-close sound, no new audio asset — the owner explicitly declined that scope this session.
- `playDoorSound`'s own existing `kind` → file mapping (`DUNGEON_SOUND_FILES`, confirmed current, `scripts/dungeon-sound.mjs:30-45`) is unchanged — only *when* and *on which client* it gets called changes.
- Every one of the five existing inline `playDoorSound(...)` call sites (`relockDoorFromRoom` line 1048, `setGateDoorState` line 1075, `unlockDoorsFromRoom` lines 2242/2254, `handleDungeonDoorOpened` lines 2343/2376/2393 — all confirmed current) is removed in the same pass that adds the reactive hook-driven replacement, never left alongside it — leaving both would double-fire on whichever client happens to be GM.
- `handleDungeonDoorOpened`'s own `if (!game.user.isGM) return` gate and everything else it does (room reveal, token spawn, combat start) is **unchanged** — only sound is pulled out from under that gate; every other GM-authoritative behavior stays exactly as GM-only as it already is.

## Review Focus

- **Every one of the three real sounds (open/lock/unlock) must fire on every connected client**, including a player's own browser, with no GM client connected at all — the actual regression this plan fixes.
- **No sound must play twice on one client** — switching from one-broadcaster to every-client-reacts requires `playDoorSound`'s own broadcast flag to flip to `false` for these calls; leaving it `true` would have every client both play locally AND receive every other client's own broadcast, multiplying playback by the number of connected clients.
- **A reveal door silently re-closing during an undo (`relockDoorFromRoom`'s own `revealWall` branch, confirmed current, no sound today) must stay silent** — the new reactive dispatcher must gate "unlock" on the progress-gate/stub-door flags specifically, never fire for a bare `dungeonRevealDoorForSlot`-only transition to `CLOSED`.
- **A GM manually clicking open/lock/unlock on an unrelated, non-dungeon wall must never play a sound** — the dispatcher must still require one of this module's own door flags present, not just a bare `ds` transition on any wall.
- **No other GM-gated behavior in `handleDungeonDoorOpened`/`unlockDoorsFromRoom`/`relockDoorFromRoom`/`setGateDoorState` changes** — this plan is sound-only; room reveal, token spawn, and combat start must still require a real GM-authoritative client, confirmed by the existing test suite staying green.

---

### Task 1: Pure door-sound-transition dispatcher

**Files:**
- Modify: `scripts/dungeon-sound.mjs` (new `doorSoundForWallTransition`, `playDoorSound`'s new `broadcast` option)
- Test: `tests/dungeon-sound-wall-transition.test.mjs`

**Interfaces:**
- Produces: `doorSoundForWallTransition(ds, flags): 'open' | 'lock' | 'unlock' | null` — `flags` is `{hasRevealFlag, hasStubFlag, hasGateFlag}`, plain booleans the caller extracts from the real wall's own `getFlag` calls (keeping this function Foundry-free and unit-testable, matching this file's own existing pure/glue split).
- Consumes: `CONST.WALL_DOOR_STATES` values, confirmed current `{CLOSED: 0, OPEN: 1, LOCKED: 2}`.

- [x] **Step 1: Write the failing tests**

```js
import { describe, it, expect } from "vitest";
import { doorSoundForWallTransition } from "../scripts/dungeon-sound.mjs";

const OPEN = 1, LOCKED = 2, CLOSED = 0;

describe("#868 doorSoundForWallTransition", () => {
  it("open: a reveal-door or stub-door transition to OPEN", () => {
    expect(doorSoundForWallTransition(OPEN, { hasRevealFlag: true, hasStubFlag: false, hasGateFlag: false })).toBe("open");
    expect(doorSoundForWallTransition(OPEN, { hasRevealFlag: false, hasStubFlag: true, hasGateFlag: false })).toBe("open");
  });

  it("lock: a progress-gate door transition to LOCKED", () => {
    expect(doorSoundForWallTransition(LOCKED, { hasRevealFlag: false, hasStubFlag: false, hasGateFlag: true })).toBe("lock");
  });

  it("unlock: a progress-gate OR stub door transition to CLOSED", () => {
    expect(doorSoundForWallTransition(CLOSED, { hasRevealFlag: false, hasStubFlag: false, hasGateFlag: true })).toBe("unlock");
    expect(doorSoundForWallTransition(CLOSED, { hasRevealFlag: false, hasStubFlag: true, hasGateFlag: false })).toBe("unlock");
  });

  it("stays silent for a bare reveal-door re-close (relockDoorFromRoom's own undo branch)", () => {
    expect(doorSoundForWallTransition(CLOSED, { hasRevealFlag: true, hasStubFlag: false, hasGateFlag: false })).toBeNull();
  });

  it("stays silent for a wall with none of this module's own door flags", () => {
    expect(doorSoundForWallTransition(OPEN, { hasRevealFlag: false, hasStubFlag: false, hasGateFlag: false })).toBeNull();
    expect(doorSoundForWallTransition(LOCKED, { hasRevealFlag: false, hasStubFlag: false, hasGateFlag: false })).toBeNull();
  });

  it("stays silent for an untracked ds value", () => {
    expect(doorSoundForWallTransition(undefined, { hasRevealFlag: true, hasStubFlag: false, hasGateFlag: false })).toBeNull();
  });
});
```

- [x] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/dungeon-sound-wall-transition.test.mjs`
Expected: FAIL — `doorSoundForWallTransition` does not exist yet.

- [x] **Step 3: Implement the dispatcher and the new `broadcast` option**

Add to `scripts/dungeon-sound.mjs`:

```js
/**
 * #868: which door sound (if any) a real Wall document's own `ds`
 * transition represents, from plain extracted flag booleans (kept
 * Foundry-free so this stays unit-testable, matching this file's own
 * existing pure/glue split). Driven reactively from every client's own
 * `updateWall` hook (module.mjs) rather than from inline calls inside
 * GM-only state-mutation code -- the actual fix for #868: a client no
 * longer needs to BE the one running that GM-authoritative code to hear
 * the sound, since every client sees the same resulting wall update.
 */
export function doorSoundForWallTransition(ds, { hasRevealFlag, hasStubFlag, hasGateFlag } = {}) {
  if (ds === 1 && (hasRevealFlag || hasStubFlag)) return "open"; // OPEN
  if (ds === 2 && hasGateFlag) return "lock"; // LOCKED
  if (ds === 0 && (hasGateFlag || hasStubFlag)) return "unlock"; // CLOSED
  return null;
}
```

Change `playDoorSound`'s own signature (confirmed current, `scripts/dungeon-sound.mjs:193-204`):

```js
export function playDoorSound(kind) {
  const key =
    kind === "open"
      ? "doorOpen"
      : kind === "lock"
        ? "doorLock"
        : kind === "unlock"
          ? "doorUnlock"
          : null;
  const p = key ? soundPath(key) : null;
  if (p) playSound(p);
}
```

to:

```js
export function playDoorSound(kind, { broadcast = true } = {}) {
  const key =
    kind === "open"
      ? "doorOpen"
      : kind === "lock"
        ? "doorLock"
        : kind === "unlock"
          ? "doorUnlock"
          : null;
  const p = key ? soundPath(key) : null;
  if (p) playSound(p, { broadcast });
}
```

(The default stays `true` — this function has no other caller after Task 2 removes the five inline ones, but changing its own default would be an unrelated, silent behavior change for any future caller that doesn't think to pass `broadcast: false`; Task 2's own new call site passes it explicitly instead.)

- [x] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/dungeon-sound-wall-transition.test.mjs`
Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add scripts/dungeon-sound.mjs tests/dungeon-sound-wall-transition.test.mjs
git commit -m "feat(#868): pure dispatcher for which door sound a wall transition represents

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 2: Wire every client to react to the hook, remove the GM-only inline calls

**Files:**
- Modify: `scripts/module.mjs` (the `updateWall` hook)
- Modify: `scripts/dungeon-scene.mjs` (remove the five inline `playDoorSound` calls)
- Test: `tests/dungeon-scene.test.mjs` or a new `tests/module-door-sound-hook.test.mjs` (see Step 1)

**Interfaces:**
- Consumes: `doorSoundForWallTransition` (Task 1).
- Produces: no change to `handleDungeonDoorOpened`/`unlockDoorsFromRoom`/`relockDoorFromRoom`/`setGateDoorState`'s own exported signatures — only their internal bodies lose the now-redundant sound calls.

- [x] **Step 1: Check whether module.mjs's `updateWall` hook already has test coverage**

```bash
grep -rln "updateWall" tests/
```

If a test already drives this hook directly, extend it. Otherwise, since `module.mjs`'s own top-level `Hooks.on(...)` registrations aren't usually unit-tested in this codebase (confirmed by this file's own lack of a dedicated test file), add coverage at the one level that *is* already tested and pure: `doorSoundForWallTransition` (Task 1) already covers the decision logic exhaustively. Add one integration-style test instead, exercising the real exported pieces together:

```js
import { describe, it, expect, vi } from "vitest";
import { doorSoundForWallTransition, playDoorSound } from "../scripts/dungeon-sound.mjs";

// #868: simulates module.mjs's own updateWall hook body (the reactive
// sound-only half added by this plan) without needing a full Foundry
// Hooks harness -- the hook itself is a thin, two-line call into these
// two already-tested exports.
function simulateUpdateWallSoundReaction(wall, changes) {
  if (changes.ds === undefined) return null;
  const sound = doorSoundForWallTransition(changes.ds, {
    hasRevealFlag: !!wall.getFlag("pf2e-dungeon-crawl", "dungeonRevealDoorForSlot"),
    hasStubFlag: !!wall.getFlag("pf2e-dungeon-crawl", "dungeonStubDoorFor"),
    hasGateFlag: !!wall.getFlag("pf2e-dungeon-crawl", "dungeonDoorToRoomId"),
  });
  if (sound) playDoorSound(sound, { broadcast: false });
  return sound;
}

function wall(flags) {
  return { getFlag: (_m, k) => flags[k] };
}

describe("#868 updateWall sound reaction (every client, no GM dependency)", () => {
  it("plays open for a reveal door, with broadcast disabled", () => {
    globalThis.foundry = { audio: { AudioHelper: { play: vi.fn(() => ({})) } } };
    const result = simulateUpdateWallSoundReaction(wall({ dungeonRevealDoorForSlot: "room1" }), { ds: 1 });
    expect(result).toBe("open");
    expect(globalThis.foundry.audio.AudioHelper.play).toHaveBeenCalledWith(
      expect.objectContaining({ src: expect.stringContaining("door-open") }),
      false,
    );
  });

  it("does nothing for a wall update with no ds change", () => {
    globalThis.foundry = { audio: { AudioHelper: { play: vi.fn(() => ({})) } } };
    const result = simulateUpdateWallSoundReaction(wall({ dungeonRevealDoorForSlot: "room1" }), {});
    expect(result).toBeNull();
    expect(globalThis.foundry.audio.AudioHelper.play).not.toHaveBeenCalled();
  });
});
```

- [x] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/module-door-sound-hook.test.mjs`
Expected: FAIL — `doorSoundForWallTransition`/`playDoorSound`'s new `broadcast` option exist from Task 1, but this is a fresh scenario check; confirm it fails for the right reason (none expected here, since Task 1 already shipped — if it already passes, this step confirms Task 1's own exports compose correctly and Step 2 is effectively a formality; note that in the plan's own record rather than skipping it).

- [x] **Step 3: Wire the hook in `module.mjs`**

Change (confirmed current, `scripts/module.mjs:351-359`):

```js
Hooks.on("updateWall", async (wall, changes) => {
  followLeaderOnDoorOpened(wall, changes);
  if (changes.ds !== CONST.WALL_DOOR_STATES.OPEN) return;
  const { autoOpenTracker } = await handleDungeonDoorOpened(
    wall.parent?.id,
    wall.id,
  );
  if (autoOpenTracker) openDungeonTrackerIfNotOpen();
});
```

to:

```js
Hooks.on("updateWall", async (wall, changes) => {
  followLeaderOnDoorOpened(wall, changes);
  // #868: every connected client plays its own door sound reactively,
  // from the real wall state Foundry's own document sync already
  // delivers to everyone -- no longer dependent on a GM client being
  // connected to run the state-mutation code below.
  if (changes.ds !== undefined) {
    const sound = doorSoundForWallTransition(changes.ds, {
      hasRevealFlag: !!wall.getFlag(MODULE_ID, "dungeonRevealDoorForSlot"),
      hasStubFlag: !!wall.getFlag(MODULE_ID, "dungeonStubDoorFor"),
      hasGateFlag: !!wall.getFlag(MODULE_ID, "dungeonDoorToRoomId"),
    });
    if (sound) playDoorSound(sound, { broadcast: false });
  }
  if (changes.ds !== CONST.WALL_DOOR_STATES.OPEN) return;
  const { autoOpenTracker } = await handleDungeonDoorOpened(
    wall.parent?.id,
    wall.id,
  );
  if (autoOpenTracker) openDungeonTrackerIfNotOpen();
});
```

Add `doorSoundForWallTransition` to this file's existing `playDoorSound` import from `./dungeon-sound.mjs` (check whether `module.mjs` already imports `playDoorSound` directly or only via `dungeon-scene.mjs`'s own re-export; import both exports directly from `./dungeon-sound.mjs` if not already present). Confirm `MODULE_ID` is already defined in `module.mjs` (it is, used throughout this file already).

- [x] **Step 4: Remove the five now-redundant inline calls in `scripts/dungeon-scene.mjs`**

Remove `playDoorSound("lock");` (line 1048, inside `relockDoorFromRoom`), `playDoorSound(sound);` (line 1075, inside `setGateDoorState`, including its now-unused `sound` parameter — update `relockSiblingDoors`/`reopenSiblingDoors`'s own calls into `setGateDoorState` to drop the now-dead `"lock"`/`"unlock"` argument), both `playDoorSound("unlock");` lines (2242, 2254, inside `unlockDoorsFromRoom`), and all three `playDoorSound("open");` lines (2343, 2376, 2393, inside `handleDungeonDoorOpened`) — confirmed current locations. Leave every other line of each function completely unchanged; these were always a single, isolated statement each, never entangled with the surrounding logic.

- [x] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run tests/module-door-sound-hook.test.mjs tests/dungeon-sound-wall-transition.test.mjs`
Expected: PASS.

- [x] **Step 6: Run the full test suite**

Run: `npx vitest run`
Expected: PASS — in particular every existing test touching `relockDoorFromRoom`/`setGateDoorState`/`unlockDoorsFromRoom`/`handleDungeonDoorOpened` stays green, since none of their own state-mutation behavior changed, only the now-removed sound side-effect.

- [x] **Step 7: Commit**

```bash
git add scripts/module.mjs scripts/dungeon-scene.mjs tests/module-door-sound-hook.test.mjs
git commit -m "fix(#868): door sounds react on every client, no GM session required

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 3: Live verification

This needs a real multi-client reproduction the planner's own one-shot script execution can't fully establish (confirmed this session: a single foundry-rest call can't simulate a real player's own browser tab independently).

- [ ] **Step 1: Verify with the GM side genuinely unattended**

With the "Gamemaster" user left inactive (matching real play, confirmed this session), have a player open a door naturally in their own browser session. Confirm the sound plays for that player's own client, with no GM tab open at all.

- [ ] **Step 2: Verify lock/unlock**

Trigger a real room resolution that locks a sibling door and unlocks a progress-gate door (normal play flow). Confirm both sounds play on a connected player client, still with no GM tab open.

- [ ] **Step 3: Confirm no double-play**

With two player clients connected to the same door-opening event, confirm each hears the sound exactly once (not twice from a leftover broadcast path).

- [ ] **Step 4: Report findings on the issue**

Record what was actually heard/observed as a comment on #868 before closing it.

---

### Task 4: Version bump

**Files:**
- Modify: `module.json`

- [x] **Step 1: Re-check the current version and bump**

```bash
git fetch origin main -q && git log origin/main -1 --oneline && grep version module.json
```

Apply a **patch** bump (a contained regression fix), using whatever the fetch above shows as current.

- [x] **Step 2: Commit**

```bash
git add module.json
git commit -m "chore(#868): bump version for the door-sound regression fix

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Self-Review

**1. Scope coverage:** #868's own ask (reproduce, bisect, fix, test) is covered: the regression's real cause is identified and confirmed live (GM-gated sound calls, an unattended GM side) rather than guessed; #600/#740 are checked and ruled out by their own diffs rather than assumed innocent; the fix (every client reacts) directly targets the confirmed cause; a per-transition test exists for every sound; the owner's own explicit "no close sound" decision is recorded and respected.

**2. Placeholder scan:** No TBD. Task 3's own live-verification steps are real, concrete actions for the implementer to perform (not something the planner could fully establish alone, same honest limitation #859/#860's own live-sweep steps already accepted).

**3. Type consistency:** `playDoorSound(kind, {broadcast})`'s new second parameter is additive and optional, defaulting to its own prior unconditional-`true` behavior — nothing outside this plan's own new call site is affected by the signature change.

**4. Review Focus:** All five items (every client hears every sound, no double-play once broadcast flips off, the undo-reclose case stays silent, an unrelated wall never makes noise, no other GM-gated behavior changes) each map to a specific test in Task 1 or Task 2, or an explicit Review Focus-level constraint. No gaps found.

---

Plan complete and saved to `docs/superpowers/plans/2026-10-06-door-sound-every-client.md`.
