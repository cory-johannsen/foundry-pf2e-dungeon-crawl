# Click-to-Disable Traps Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A detected trap is disabled by clicking its token (like the treasure chest), not through a tracker form. The click prompts the player to choose which of their party characters attempts it and which of the trap's listed disable skills to use, then rolls under PF2e's disable rules. Prerequisite step of #754 (decouple traps from room kind): without it, the #753 tracker disable form (gated on `room.kind === "trap"`) would disappear once no room has that kind.

**Architecture:** Reuse the door-style standalone click control from #611/#623 (`syncRoomFeatureControls` in `scripts/module.mjs`) for trap hazard tokens that are visible (detected) and not spent. A non-GM client cannot read the hazard actor (ownership NONE is not sent to players), so everything the client needs is stored as flags on the hazard's TOKEN document at spawn/state-change time: `trapDisableChecks` (`[{skill, dc, label}]`) and `trapSpent` (boolean). The click opens a DialogV2 on the clicking player's own client; the chosen `{actorId, skill}` goes to the GM client through the existing relay action `attemptTrapDisable`, which re-authorizes (requester owns that actor and it is a party character), rolls via the existing `rollTrapDisableAttempt`, and applies PF2e outcomes.

**Tech Stack:** Vanilla ES modules, Vitest (text/unit tests, injected deps), DialogV2.

**Spec:** Approved in chat by the user on 2026-10-05 (no spec file): click-to-disable instead of tracker/window; players who own a party character may click (relayed to the GM client, like #611/#623); prompt = which owned party character + which disable skill (with DC); success/critical success disables; failure does nothing (may retry); critical failure triggers the trap on the attempting character; complex multi-success hazards are out of scope (treated as one success; note for #755); the #753 tracker disable form is removed.

## Global Constraints

- Every merge to `main` bumps `module.json`'s `version` (CLAUDE.md); this is a new interaction mechanic: minor bump above whatever `origin/main` has at commit time.
- `rollTrapDisableAttempt`, `rollTrapDetection`, `triggerTrap`, `classifyTrap`, `parseDisableChecks` keep their signatures and behavior. New behavior is added around them.
- A non-GM client can NOT read the hazard actor or its flags. Client code may only use token-document data (`tokenDoc.flags`, `tokenDoc.hidden`).
- Authorization: only the relayed `attemptTrapDisable` action widens (to active non-GM owners of a party character, via `canRelayRoomFeature`'s same notion); every other action keeps its host-only rule (regression-tested). The GM-side handler additionally verifies the requester owns the chosen actor (OWNER level 3) and that the actor is a party member (unless the requester is the GM/host calling directly).
- Never touch live Foundry in implementer tasks; the controller verifies live.
- Relay script filter bans certain words in live-check scripts only; irrelevant to repo code.

## Review Focus

- **A trap must be clickable only when detected/visible and not spent** (disabled or triggered) — an undetected (hidden) trap must have no click control at all, and a spent trap's control must disappear.
- **A player must not be able to roll as a character they don't own** — relay handler re-checks `requestingUserId` ownership of `actorId`.
- **Critical failure triggers the trap exactly once and marks it spent**, even if a walk-over trigger races; disable success marks it spent; failure leaves it clickable.
- **The click flow must not throw when the hazard has no `trapDisableChecks` flag** (traps spawned before this change): the click does nothing (or shows a localized "can't be disabled" notice), never errors.
- **The tracker must no longer offer a disable form** (removed), and nothing may reference the removed handler/keys.

---

### Task 1: Backend — token flags, authorization, PF2e outcomes

**Files:**
- Modify: `scripts/dungeon-scene.mjs` (`populateSlotTrap`: after spawn, set token flags `trapDisableChecks`)
- Modify: `scripts/trap-combat.mjs` (`attemptTrapDisableForScene`, `handleTrapTokenMove`, new `markTrapSpent`)
- Modify: `scripts/dungeon-permissions.mjs`, `scripts/dungeon-remote.mjs`
- Test: `tests/trap-token-move.test.mjs`, `tests/trap-disable-ui.test.mjs` (extend; rename/rewrite expectations as needed), `tests/dungeon-permissions.test.mjs` (or the existing permissions test file)

**Interfaces:**
- Produces: `isAuthorizedRequest("attemptTrapDisable", userId, run, { ownsPartyCharacter })` true for active non-GM party-character owners on a non-completed run; `userMayAttemptTrapDisable({ userId, isGM, isHost, actor })` pure in `dungeon-permissions.mjs`; token flags `trapDisableChecks`, `trapSpent`; `attemptTrapDisableForScene(sceneId, actorId, skill, deps)` now also takes `deps.requestingUserId` check and triggers on critical failure.

- [x] **Step 1: Failing tests** — permissions: relayed `attemptTrapDisable` authorized for a party-character owner and host, denied for a stranger / completed run; all other actions unchanged. `userMayAttemptTrapDisable`: owner of the actor (ownership >= 3) and actor is a party member → true; GM/host → true; non-owner → false; non-party actor → false. `attemptTrapDisableForScene`: critical failure triggers the trap once (injected `triggerTrap`), marks `trapTriggered` and token `trapSpent`; success marks `trapDisabled` and `trapSpent`; failure leaves both clear; null roll posts nothing; unauthorized requester → null and no roll. `handleTrapTokenMove` trigger path also sets token `trapSpent`.
- [x] **Step 2: Run tests, confirm they fail for the right reasons**
- [x] **Step 3: Implement.** `populateSlotTrap`: after the hazard token is created, `await token.setFlag(MODULE_ID, "trapDisableChecks", classifyTrap(actor).disableChecks.map(({skill, dc, label}) => ({skill, dc, label: label ?? skill})))` (find how the spawned token doc is obtained from `spawnCreatures`' return; if only ids are returned, look the token up by id on the scene). `markTrapSpent(hazardToken)` sets token flag `trapSpent: true`. Relay handler computes `ownsPartyCharacter` for BOTH `roomFeatureInteract` and `attemptTrapDisable`; `attemptTrapDisable` registry entry passes `args.requestingUserId` into `attemptTrapDisableForScene` which enforces `userMayAttemptTrapDisable` when the call came over the relay.
- [x] **Step 4: Run affected tests (trap*, dungeon-permissions*, dungeon-remote*, dungeon-scene*), confirm green**
- [x] **Step 5: Commit**

### Task 2: Client — click control and disable prompt

**Files:**
- Create: `scripts/ui/trap-disable-dialog.mjs` (`promptTrapDisable(checks, characters)` DialogV2 → `{actorId, skill}` or `null`; pure helper `buildTrapDisableChoices(checks, characters)` exported and unit-tested)
- Modify: `scripts/module.mjs` (extend the controls sync + token hooks)
- Modify: `lang/en.json` (prompt title, character label, skill label with DC, confirm, cancel, "cannot be disabled" notice)
- Test: `tests/trap-disable-dialog.test.mjs`, `tests/room-feature-click-binding.test.mjs` (extend)

**Interfaces:**
- Consumes: token flags from Task 1; relay action `attemptTrapDisable {sceneId, actorId, skill}`; `attemptTrapDisableForScene(sceneId, actorId, skill)` for a GM client.
- Produces: nothing consumed later.

- [x] **Step 1: Failing tests** — `buildTrapDisableChoices`: one option per check with skill label and DC; characters list as given; empty checks → `null`/empty (caller shows notice). Text tests: `syncRoomFeatureControls` also creates controls for tokens flagged `trapHazard` that are `!hidden` and not `trapSpent`; pointerdown primary button only; rebuild hooks fire for `trapHazard`/`trapSpent` token changes; no read of `doc.actor` for the trap path.
- [x] **Step 2: Run, confirm failure**
- [x] **Step 3: Implement.** Click: characters = party members (`game.actors.party.members`) of type `character` that `game.user` owns (`actor.isOwner`), GM: all of them. No characters → notice, stop. Checks from `doc.flags[MODULE_ID].trapDisableChecks`; missing/empty → localized notice, stop. After the prompt: GM client calls `attemptTrapDisableForScene` directly, others `requestDungeonAction("attemptTrapDisable", ...)`. Dialog shows skill + DC per option. Guard against double-open with an in-flight flag per token.
- [x] **Step 4: Run affected tests, confirm green**
- [x] **Step 5: Commit**

### Task 3: Remove the #753 tracker disable form

**Files:**
- Modify: `templates/dungeon-tracker.hbs`, `scripts/ui/dungeon-app.mjs`, `lang/en.json`, `tests/trap-disable-ui.test.mjs`

- [ ] **Step 1:** Delete the trap block in the template (`pf2edc-dungeon__trap` / disable form), the `#onAttemptTrapDisable` handler + its `actions` registration, the `trap.hasHazard/detected/disableChecks` context additions (keep `isTrapRoom`/`trap.name`/`trap.description` display behavior unchanged), and the now-unused lang keys (`DisableButton`, `NotDetectedHint`, `SkillLabel`, `WhoLabel`) — keep keys still used elsewhere (grep first).
- [ ] **Step 2:** Update tests: delete assertions for the removed form; add assertions that the removed strings/handler no longer appear.
- [ ] **Step 3:** Run affected tests (dungeon-app*, trap*, lang tests), confirm green.
- [ ] **Step 4:** Commit; bump `module.json` (minor) if not already bumped in this branch.
