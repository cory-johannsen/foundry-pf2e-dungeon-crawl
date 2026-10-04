# Rest Rooms Trigger Real PF2e Rest for the Night Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A `safe_rest` room actually triggers PF2e's own Rest for the Night action for the party (HP, spell slots, and other downtime recovery per PF2e's real rules) instead of just advancing the dungeon narratively with zero mechanical effect.

**Architecture:** One new small, exported, independently-testable helper (`restPartyForTheNight()`) wraps the real `game.pf2e.actions.restForTheNight({ actors, skipDialog: true })` call; one try/catch call to it is added to `handleDungeonDoorOpened`'s existing `safe_rest` branch (`scripts/dungeon-scene.mjs`) so a failure there can never block the room's existing unlock/progression behavior, matching this same function's existing per-child try/catch philosophy a few lines below it.

**Tech Stack:** Vanilla JS (`scripts/dungeon-scene.mjs`), vitest; the live PF2e system API call itself is verified against the real running world rather than guessed (see below), but isn't itself something this plan unit-tests (same precedent as this module's other hooks-wired, Foundry-API-touching code).

**Spec:** None — a bounded, single-integration-point change with no remaining open design question. The issue's own two flagged uncertainties are both resolved below, confirmed live rather than assumed:

- **Exact API shape:** confirmed live against the actual running world (PF2e system 8.5.0, via `foundry-rest`) — `game.pf2e.actions.restForTheNight` is a real `async function restForTheNight(e)` taking a single options object. Its body does `(Array.isArray(e.actors) ? e.actors : [e.actors]).filter((e) => e?.type === "character")`, so `actors` can be an array (or a single actor) and non-PC actors are filtered out internally — no need to pre-filter by type.
- **Automatic vs. confirm:** the live function body also has `if (!e.skipDialog && !await foundry.applications.api.DialogV2.confirm(...))` — `skipDialog: true` is a real, built-in option that bypasses the confirmation dialog entirely. This directly matches the room's own documented philosophy a few lines above the integration point: *"like the entry, its own way forward opens immediately, no GM click required"* — using the system's own flag, not a custom dialog this plan would otherwise have to build.

## Global Constraints

- `restPartyForTheNight()` must never throw out of `handleDungeonDoorOpened`'s `safe_rest` branch — a Rest for the Night failure must not prevent the room's existing door-unlock/progression behavior, the same "auxiliary failure never blocks progression" principle this function's own child-build loop a few lines below already follows (try/catch, log, notify, continue).
- `skipDialog: true` is required on every call — without it, a GM-less run (or any run where nobody is watching to click the confirmation dialog) would hang forever waiting for a dialog nobody can answer, exactly the "no GM click required" failure mode #93's own full-pregeneration work already eliminated elsewhere in this room-resolution flow.
- No change to `handleDungeonDoorOpened`'s existing `game.user.isGM` gate (line ~1776) or any of its other branches (stub doors, retreat, combat-room `startCombatForRoom`, the child-build loop, `announceNoWayForward`) — this plan adds one call inside the existing `safe_rest` branch and nothing else.

## Review Focus

- **An empty party** (no `game.actors?.party?.members`, or members that are all non-PC types once PF2e's own internal filter runs). PF2e's own `restForTheNight` already handles zero PC actors gracefully (`ui.notifications.error` + returns `[]`, does not throw) — Task 1's test confirms `restPartyForTheNight()` passes whatever member list it's given straight through rather than adding a redundant, differently-worded pre-check that could mask or duplicate PF2e's own messaging.
- **`restForTheNight` rejecting** (a real exception, not the graceful empty-party path above) — must be caught, logged, and notified without preventing the room's own `markRoomOutcome`/unlock flow from running. Task 2's test is the one place this is actually exercised against the real integration point.
- **A GM-less run with nobody watching for a confirmation dialog.** Already resolved by `skipDialog: true` (see Spec section above) — called out here so a reviewer checks the option is actually present in the final call, not just assumed from this plan's prose.
- **Calling `restForTheNight` with a single actor instead of an array**, since the live function accepts either shape (`Array.isArray(e.actors) ? e.actors : [e.actors]`) — Task 1's test passes an array (matching `game.actors.party.members`'s own real shape) so this plan doesn't accidentally rely on the single-actor fallback path untested.
- **This running more than once for the same room** if `handleDungeonDoorOpened` is ever re-entered for an already-resolved room. Not a new risk this plan introduces — `roomsBeingOpened.has(roomId)` (line ~1816) already guards the whole function against concurrent/duplicate entry before this plan's branch is ever reached — confirmed by inspection, not assumed, and not re-tested here since it's pre-existing, unchanged behavior.

---

## Task 1: `restPartyForTheNight()` helper

**Files:**
- Modify: `scripts/dungeon-scene.mjs`
- Test: `tests/dungeon-scene-rest-for-the-night.test.mjs` (new)

**Interfaces:**
- Produces: `restPartyForTheNight(): Promise<void>` (exported) — reads `game.actors?.party?.members ?? []` and calls `game.pf2e.actions.restForTheNight({ actors, skipDialog: true })`. Never throws — callers (Task 2) don't need their own try/catch around it, though Task 2 adds one anyway at the call site for defense-in-depth consistency with the surrounding function's own style. A no-op (never calls `restForTheNight` at all) when there are no party members.

- [x] **Step 1: Write the failing test**

Create `tests/dungeon-scene-rest-for-the-night.test.mjs`:

```js
import { describe, it, expect, vi } from "vitest";
import { restPartyForTheNight } from "../scripts/dungeon-scene.mjs";

function installGameStub({ partyMembers = [] } = {}) {
  globalThis.game = {
    actors: { party: { members: partyMembers } },
    pf2e: { actions: { restForTheNight: vi.fn().mockResolvedValue([]) } },
  };
}

describe("restPartyForTheNight", () => {
  it("calls PF2e's real Rest for the Night with the party and skipDialog: true", async () => {
    const members = [{ id: "pc1", type: "character" }, { id: "pc2", type: "character" }];
    installGameStub({ partyMembers: members });

    await restPartyForTheNight();

    expect(game.pf2e.actions.restForTheNight).toHaveBeenCalledWith({
      actors: members,
      skipDialog: true,
    });
  });

  it("does not call restForTheNight at all when there is no party", async () => {
    installGameStub({ partyMembers: [] });

    await restPartyForTheNight();

    expect(game.pf2e.actions.restForTheNight).not.toHaveBeenCalled();
  });

  it("propagates (does not swallow) a rejection from restForTheNight -- the caller is responsible for catching it", async () => {
    const members = [{ id: "pc1", type: "character" }];
    installGameStub({ partyMembers: members });
    game.pf2e.actions.restForTheNight.mockRejectedValue(new Error("boom"));

    await expect(restPartyForTheNight()).rejects.toThrow("boom");
  });
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/dungeon-scene-rest-for-the-night.test.mjs`
Expected: FAIL with "Cannot find module... restPartyForTheNight" (not exported yet)

- [x] **Step 3: Write the implementation**

In `scripts/dungeon-scene.mjs`, add near `partyActorIds()` (~line 1136):

```js
/** Triggers PF2e's own real Rest for the Night action (HP, spell slots,
 * and other downtime recovery per PF2e's actual rules) for every current
 * party member -- #613: a safe_rest room previously advanced the dungeon
 * narratively with zero mechanical effect. `skipDialog: true` bypasses
 * PF2e's own confirmation dialog -- required so a GM-less run (nobody
 * watching to click it) doesn't hang forever waiting for an answer
 * nobody can give, matching this room's existing "no GM click required"
 * auto-resolve philosophy. A no-op when there's no party to rest; does
 * NOT catch a rejection from restForTheNight itself -- the caller
 * decides how to handle that (see handleDungeonDoorOpened's own
 * try/catch around this call). */
export async function restPartyForTheNight() {
  const partyMembers = game.actors?.party?.members ?? [];
  if (partyMembers.length === 0) return;
  await game.pf2e.actions.restForTheNight({ actors: partyMembers, skipDialog: true });
}
```

- [x] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/dungeon-scene-rest-for-the-night.test.mjs`
Expected: PASS (all 3 tests)

- [x] **Step 5: Commit**

```bash
git add scripts/dungeon-scene.mjs tests/dungeon-scene-rest-for-the-night.test.mjs
git commit -m "Add restPartyForTheNight() helper calling PF2e's real Rest for the Night (#613)"
```

---

## Task 2: Wire it into the `safe_rest` auto-resolve branch

**Files:**
- Modify: `scripts/dungeon-scene.mjs:1864` (`handleDungeonDoorOpened`'s `safe_rest` branch)
- Modify: `lang/en.json`

**Interfaces:**
- Consumes: `restPartyForTheNight()` from Task 1.

- [x] **Step 1: Add the new lang key**

In `lang/en.json`, alongside the existing `"PF2EDC.Dungeon.RoomBuildFailedError"` key (~line 96), add:

```json
  "PF2EDC.Dungeon.RestForTheNightFailedError": "Dungeon Crawl: Rest for the Night failed to apply — see console for details.",
```

- [x] **Step 2: Add the call inside the `safe_rest` branch**

In `scripts/dungeon-scene.mjs`, inside `handleDungeonDoorOpened`'s `if (room?.kind === "safe_rest" && ok) {` block (~line 1864), as the very first statement (before the existing `markRoomOutcome` call):

```js
    if (room?.kind === "safe_rest" && ok) {
      try {
        await restPartyForTheNight();
      } catch (err) {
        console.error(`${MODULE_ID} | Rest for the Night failed`, err);
        ui.notifications?.error(
          game.i18n.localize("PF2EDC.Dungeon.RestForTheNightFailedError"),
        );
      }
      const { state: resolvedState } = await markRoomOutcome({
        sceneId,
        succeeded: true,
      });
      // ... rest of the existing branch, unchanged ...
```

- [x] **Step 3: Run the full test suite**

Run: `npx vitest run`
Expected: PASS — no existing test constructs a `room.kind === "safe_rest"` scenario and drives it through `handleDungeonDoorOpened` end-to-end (confirmed via `grep -rln "handleDungeonDoorOpened" tests/*.test.mjs`, which only finds `tests/dungeon-scene-retreat.test.mjs`, covering the stub-door/retreat branch, not this one), so nothing exercises this new call path in the automated suite yet — that's what Task 3's live verification is for.

- [x] **Step 4: Commit**

```bash
git add scripts/dungeon-scene.mjs lang/en.json
git commit -m "Trigger Rest for the Night when a safe_rest room resolves (#613)"
```

---

## Task 3: Live-verify against a real dungeon run

**Files:** None — this task only runs the shipped code against the live world and records the outcome.

**Interfaces:** None.

- [ ] **Step 1: Confirm the change is deployed**

Using the `foundry-rest` skill against the running dev world: confirm the deployed `scripts/dungeon-scene.mjs` contains `restPartyForTheNight` (e.g. `grep` the server-served file, or check `game.modules.get("pf2e-dungeon-crawl").version` against this change's own version bump).

- [ ] **Step 2: Drive a real dungeon run to a `safe_rest` room and open its door**

Either live in the actual running game, or via `foundry-rest` scripting a real run through to a rest room (reusing this repo's own existing patterns for driving a dungeon run programmatically, e.g. as `tests/dungeon-runner.test.mjs`'s own "advance to a safe_rest room" logic already does for test purposes, but against the live world instead of a unit-test fixture). Before opening the door, record each party actor's current HP (and any other value you expect Rest for the Night to change, e.g. a damaged/reduced resource) — Rest for the Night's own effects aren't restorable through this API (no `game.settings.set`, and actor HP changes are real document writes), so know what "worked" looks like before triggering it, not after.

- [ ] **Step 3: Confirm the real mechanical effect**

Open the rest room's reveal door (or call `handleDungeonDoorOpened` directly with that room's wall id) and confirm: PF2e's own Rest for the Night chat message appears (no confirmation dialog blocks it — `skipDialog: true` working as expected), and each party actor's HP/resources actually changed per PF2e's real downtime rules, not just the room narratively advancing as before.

- [ ] **Step 4: Report the outcome on issue #613**

Comment on #613 with what was actually observed (confirmed working live, or a real failure mode found) before removing its `assigned` label. Per this plan's own Review Focus and the project's established precedent (#141's own "don't close on scripted tests alone" lesson), this task's live confirmation is what the issue actually needs before being trusted done — the unit tests from Tasks 1-2 only prove the new code is wired correctly in isolation, not that it produces the right in-game effect.
