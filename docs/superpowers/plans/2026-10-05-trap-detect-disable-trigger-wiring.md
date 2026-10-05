# Trap Detect/Disable/Trigger Wiring Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire the real, already-written trap detect/disable/trigger engine (`rollTrapDetection`, `rollTrapDisableAttempt`, `triggerTrap` — all three currently dead code) to actual party movement, so a trap room becomes a genuine interactive hazard instead of pure GM narration.

**Architecture:** A new `updateToken` hook detects a party token approaching or stepping onto a trap's footprint and dispatches to the existing detect/trigger functions; all new interaction state lives as flags on the hazard actor, mirroring where the existing `trapDisabled` flag already lives. A new GM-only sidebar form (mirroring the pattern #611/#623 already established for puzzle/skill-challenge) lets the GM attempt a disable once a trap is detected.

**Tech Stack:** Vanilla ES modules, Vitest for the one pure geometry function, the `foundry-rest` skill for every Foundry-glue task.

**Spec:** None — bounded fix, approved in-chat design, no spec file. This plan implements GitHub issue #753 directly.

## Global Constraints

- Every merge to `main` bumps `module.json`'s `version` (CLAUDE.md). A new interaction mechanic: minor bump. Current version at plan-writing time is `0.60.1` — re-check immediately before committing, since concurrent sessions push to this repo.
- `rollTrapDetection`, `rollTrapDisableAttempt`, `triggerTrap`, `ensureTrapState`, and `room.trap`'s existing `{name, description}` shape are **not modified** — every existing function is reused exactly as it exists today; only new call sites and new actor flags are added.
- All new interaction state (`trapDetected`, `trapTriggered`) lives as flags on the hazard actor (`flags["pf2e-dungeon-crawl"]`), mirroring exactly where the pre-existing `trapDisabled` flag already lives.
- Trap-room *resolution* (the generic Succeed/Fail buttons) is unchanged — this plan only wires the mechanical engine and adds the disable-attempt UI, never touches how/when a trap room counts as done.
- Detection fires per-mover (the specific party actor whose token move triggered it), not a room-wide check — a deliberate, named simplification deferred to #755 ("verify trap detection matches PF2e's real Exploration rules"), not re-litigated here.
- The new disable-attempt UI is GM-only, matching #611/#623's own just-shipped convention.

## Review Focus

- **A trap already triggered once must never re-trigger** on a later, unrelated `updateToken` event (standing still, an animation tick, etc.) — covered by Task 1's pure-function test (overlap when already `triggered` still classifies as `"trigger"`, since the pure function doesn't know actor state; Task 2's glue is what must check the flag before acting) and Task 2's live "no double-fire" verification.
- **A disabled trap must never trigger even if walked onto** — `triggerTrap` itself already no-ops on `trapDisabled` (unmodified), but the new glue's own flag-setting logic must not mistakenly mark it `triggered` anyway (which would make a later, legitimate re-check skip for the wrong reason). Covered by Task 2's live "disabled trap walked onto" verification.
- **A trap must become visible once triggered even if it was never detected** — the "unhide on detect OR trigger, whichever first" rule. Covered by Task 2's live verification walking straight onto a never-approached trap.
- **The disable-attempt form must only ever act on a trap that's actually been detected** — an un-detected trap has no business being disable-attempted at all (nothing for the GM to see or act on). Covered by Task 3's template gating (`trap.detected`) and its own live verification.
- **A party actor who isn't a valid Stealth/skill roller (missing the chosen skill) must fail gracefully**, not throw — `rollTrapDisableAttempt` itself already returns `null` for a missing skill stat (unmodified), but the new UI handler must handle that `null` without erroring. Covered by Task 3's "no skill stat" verification.

---

### Task 1: Pure move classification

**Files:**
- Modify: `scripts/trap-mechanics.mjs` (add `classifyTrapMove`, directly after `trapDetectionDC`)
- Test: `tests/trap-mechanics.test.mjs` (confirm this file exists and follow its existing style; if no such file exists, create it mirroring `tests/cover-items.test.mjs`'s plain-Vitest style)

**Interfaces:**
- Produces: `export function classifyTrapMove(trapFootprint, moverFootprint): "trigger" | "detect" | "none"` — `trapFootprint`/`moverFootprint` are plain `{gx, gy, gw, gh}` objects (the same shape `scripts/placement.mjs`'s `footprint()` already produces). Consumed by Task 2.

- [x] **Step 1: Write the failing tests**

```js
import { describe, it, expect } from "vitest";
import { classifyTrapMove } from "../scripts/trap-mechanics.mjs";

describe("classifyTrapMove", () => {
  const trap = { gx: 5, gy: 5, gw: 1, gh: 1 };

  it("is 'trigger' when the mover's footprint overlaps the trap's own cell", () => {
    expect(classifyTrapMove(trap, { gx: 5, gy: 5, gw: 1, gh: 1 })).toBe("trigger");
  });

  it("is 'trigger' for a larger mover footprint that still overlaps", () => {
    expect(classifyTrapMove(trap, { gx: 4, gy: 5, gw: 2, gh: 1 })).toBe("trigger");
  });

  it("is 'detect' for a mover orthogonally adjacent (not overlapping)", () => {
    expect(classifyTrapMove(trap, { gx: 6, gy: 5, gw: 1, gh: 1 })).toBe("detect");
  });

  it("is 'detect' for a mover diagonally adjacent (not overlapping)", () => {
    expect(classifyTrapMove(trap, { gx: 6, gy: 6, gw: 1, gh: 1 })).toBe("detect");
  });

  it("is 'none' for a mover two squares away", () => {
    expect(classifyTrapMove(trap, { gx: 7, gy: 5, gw: 1, gh: 1 })).toBe("none");
  });

  it("is 'trigger' (not 'detect') when both overlap and would also count as adjacent", () => {
    // Overlap always wins over the weaker adjacency signal.
    expect(classifyTrapMove(trap, { gx: 5, gy: 5, gw: 2, gh: 2 })).toBe("trigger");
  });
});
```

- [x] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/trap-mechanics.test.mjs -t classifyTrapMove`
Expected: FAIL — `classifyTrapMove is not a function` (or an import error).

- [x] **Step 3: Write `classifyTrapMove`**

In `scripts/trap-mechanics.mjs`, insert directly after `trapDetectionDC`'s closing `}`:

```js
/** #753: what a party token's new position means for a not-yet-triggered
 * trap at `trapFootprint` -- "trigger" if the mover's own new footprint
 * actually overlaps the trap's (stepped onto it), "detect" if merely
 * Chebyshev-adjacent (one square away, including diagonally -- close
 * enough to notice without having walked onto it), otherwise "none".
 * Pure geometry only -- the caller (trap-combat.mjs) is responsible for
 * actually checking/setting trapDisabled/trapDetected/trapTriggered
 * actor flags; this function has no notion of trap state at all. */
export function classifyTrapMove(trapFootprint, moverFootprint) {
  const overlaps =
    trapFootprint.gx < moverFootprint.gx + moverFootprint.gw &&
    trapFootprint.gx + trapFootprint.gw > moverFootprint.gx &&
    trapFootprint.gy < moverFootprint.gy + moverFootprint.gh &&
    trapFootprint.gy + trapFootprint.gh > moverFootprint.gy;
  if (overlaps) return "trigger";

  const dx = Math.max(
    trapFootprint.gx - (moverFootprint.gx + moverFootprint.gw - 1),
    moverFootprint.gx - (trapFootprint.gx + trapFootprint.gw - 1),
    0,
  );
  const dy = Math.max(
    trapFootprint.gy - (moverFootprint.gy + moverFootprint.gh - 1),
    moverFootprint.gy - (trapFootprint.gy + trapFootprint.gh - 1),
    0,
  );
  return Math.max(dx, dy) <= 1 ? "detect" : "none";
}
```

- [x] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/trap-mechanics.test.mjs -t classifyTrapMove`
Expected: PASS, all 6 tests green.

- [x] **Step 5: Run the full test file to confirm no regression**

Run: `npx vitest run tests/trap-mechanics.test.mjs`
Expected: PASS, every existing test in this file (if any already existed) still green.

- [x] **Step 6: Commit**

```bash
git add scripts/trap-mechanics.mjs tests/trap-mechanics.test.mjs
git commit -m "feat(#753): add classifyTrapMove pure geometry classifier

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 2: Wire detection + trigger to real party movement

**Files:**
- Modify: `scripts/dungeon-follow.mjs` (export `isPositionChange`)
- Modify: `scripts/trap-combat.mjs` (new `handleTrapTokenMove`, directly after `triggerTrap`)
- Modify: `scripts/module.mjs` (new `Hooks.on("updateToken", handleTrapTokenMove)` registration)

**Interfaces:**
- Consumes: `classifyTrapMove` (Task 1), `footprint` (`./placement.mjs`, already exported), `isPositionChange` (`./dungeon-follow.mjs`, newly exported by this task), `rollTrapDetection`/`triggerTrap` (both pre-existing, unmodified).
- Produces: `export function handleTrapTokenMove(tokenDoc, changes)` — the hook target, registered in Task 2's own module.mjs change. Nothing later in this plan consumes it directly (Task 3's UI reads the same actor flags this task writes).

No unit test: real Foundry Token/Actor/Scene glue, the same category this codebase has consistently verified live rather than mocked (`followLeaderIfDue`/`resnapDriftedTokens`, the exact pattern this mirrors, have no unit tests of their own either). Verified live in Step 3.

- [x] **Step 1: Export `isPositionChange`**

In `scripts/dungeon-follow.mjs`, change:

```js
function isPositionChange(changes) {
```

to:

```js
export function isPositionChange(changes) {
```

- [x] **Step 2: Write `handleTrapTokenMove`**

Add this to `scripts/trap-combat.mjs`, importing what it needs at the top of the file:

```js
import { footprint } from "./placement.mjs";
import { classifyTrapMove } from "./trap-mechanics.mjs";
import { isPositionChange } from "./dungeon-follow.mjs";
```

Then, directly after `triggerTrap`'s closing `}`:

```js
/** Hook target for `updateToken` (module.mjs, #753). Checks every
 * not-yet-triggered trap hazard on this token's scene against the
 * mover's own new footprint: overlap triggers it (if not disabled),
 * adjacency detects it. The hazard token unhides the moment it's either
 * detected or triggered, whichever happens first. */
export async function handleTrapTokenMove(tokenDoc, changes) {
  if (!isPositionChange(changes)) return;
  if (!game.user.isGM) return;
  const scene = tokenDoc.parent;
  if (!scene) return;
  const moverFootprint = footprint(tokenDoc, scene.grid.size);

  const hazardTokens = scene.tokens.filter((t) =>
    t.getFlag(MODULE_ID, "trapHazard"),
  );
  for (const hazardToken of hazardTokens) {
    const hazardActor = hazardToken.actor;
    if (!hazardActor || hazardActor.getFlag(MODULE_ID, "trapTriggered")) continue;

    const trapFootprint = footprint(hazardToken, scene.grid.size);
    const classification = classifyTrapMove(trapFootprint, moverFootprint);
    if (classification === "none") continue;

    if (classification === "trigger") {
      if (!hazardActor.getFlag(MODULE_ID, "trapDisabled")) {
        await triggerTrap(hazardActor, { actor: tokenDoc.actor, token: tokenDoc.object });
      }
      await hazardActor.setFlag(MODULE_ID, "trapTriggered", true);
      if (hazardToken.hidden) await hazardToken.update({ hidden: false });
    } else if (!hazardActor.getFlag(MODULE_ID, "trapDetected")) {
      const seeker = tokenDoc.actor;
      if (!seeker) continue;
      const result = await rollTrapDetection(hazardActor, seeker);
      if (result.detected) {
        await hazardActor.setFlag(MODULE_ID, "trapDetected", true);
        if (hazardToken.hidden) await hazardToken.update({ hidden: false });
      }
    }
  }
}
```

Note `target.token` in the existing `triggerTrap(hazardActor, target)` signature expects a real Token *object* (the placeable), not a TokenDocument — `tokenDoc.object` (confirmed by `triggerTrap`'s own docblock: "a bare Actor resolves to `target: null`... needs that document to actually be a Token"). `tokenDoc` here is the Token*Document* the `updateToken` hook hands us; `tokenDoc.object` is its live placeable.

- [x] **Step 3: Register the hook**

In `scripts/module.mjs`, add directly after the existing `Hooks.on("updateToken", resnapDriftedTokens);`:

```js
/** #753: detect/trigger a trap when a party token approaches or steps
 * onto its footprint. */
Hooks.on("updateToken", handleTrapTokenMove);
```

Add `handleTrapTokenMove` to the existing import from `./trap-combat.mjs` (check the current import list with `grep -n "from \"./trap-combat.mjs\"" scripts/module.mjs` first — add it to whatever's already there, or add a new import line if none exists yet).

- [x] **Step 4: Live-verify with `foundry-rest`** (deferred to controller per R6)

With a real dungeon run that has a trap room built (confirm via `scene.tokens.filter(t => t.getFlag("pf2e-dungeon-crawl", "trapHazard"))`), move a party token one square adjacent to the trap's own cell (not onto it), then confirm:

```bash
echo 'const hazard = canvas.scene.tokens.find(t => t.getFlag("pf2e-dungeon-crawl", "trapHazard")); return { detected: hazard?.actor?.getFlag("pf2e-dungeon-crawl", "trapDetected") ?? false, hidden: hazard?.hidden };' | .claude/skills/foundry-rest/foundry-exec.sh
```

Expected (assuming the detection roll succeeds — re-roll by moving away and back if it doesn't, Perception rolls aren't guaranteed): `detected: true`, `hidden: false`.

Then move the SAME party token onto the trap's own cell and confirm:

```bash
echo 'const hazard = canvas.scene.tokens.find(t => t.getFlag("pf2e-dungeon-crawl", "trapHazard")); return { triggered: hazard?.actor?.getFlag("pf2e-dungeon-crawl", "trapTriggered") ?? false };' | .claude/skills/foundry-rest/foundry-exec.sh
```

Expected: `triggered: true`. Then move the token off and back onto the same cell again (or just update its own x/y to the same value, forcing another `updateToken` event) and confirm no new attack-roll chat message was created the second time (no double-fire) — check `game.messages.contents.at(-1)` didn't change.

- [x] **Step 5: Commit**

```bash
git add scripts/dungeon-follow.mjs scripts/trap-combat.mjs scripts/module.mjs
git commit -m "feat(#753): wire trap detection and trigger to real party movement

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 3: GM-only disable-attempt UI

**Files:**
- Modify: `scripts/trap-combat.mjs` (new `attemptTrapDisableForScene`)
- Modify: `scripts/ui/dungeon-app.mjs` (new `#onAttemptTrapDisable` action, `_prepareContext` extension)
- Modify: `scripts/dungeon-remote.mjs` (new `attemptTrapDisable` registry entry)
- Modify: `templates/dungeon-tracker.hbs` (new `{{else if isTrapRoom}}` branch)
- Modify: `lang/en.json` (new keys)

**Interfaces:**
- Consumes: `rollTrapDisableAttempt`, `classifyTrap` (both pre-existing, unmodified).
- Produces: `export async function attemptTrapDisableForScene(sceneId, actorId, skill)` in `trap-combat.mjs` — the one shared function both the direct-GM path and the relay path call, mirroring `claimTreasureFor(sceneId)`'s own shape.

No unit test: UI/template glue (no `.hbs`-testing harness anywhere in this codebase). Verified live in Step 5.

- [x] **Step 1: Write `attemptTrapDisableForScene`**

Add to `scripts/trap-combat.mjs`, directly after `handleTrapTokenMove`:

```js
/** Shared entry point for a GM's disable attempt (#753) — finds the
 * scene's own live, not-yet-triggered trap hazard and rolls against it.
 * The one function both the direct-GM UI path and the relay path call,
 * mirroring claimTreasureFor(sceneId)'s own shape. */
export async function attemptTrapDisableForScene(sceneId, actorId, skill) {
  const scene = game.scenes.get(sceneId);
  const hazardToken = scene?.tokens.find(
    (t) =>
      t.getFlag(MODULE_ID, "trapHazard") &&
      !t.actor?.getFlag(MODULE_ID, "trapTriggered"),
  );
  const hazardActor = hazardToken?.actor;
  const actor = actorId ? game.actors.get(actorId) : null;
  if (!hazardActor || !actor) return null;
  return rollTrapDisableAttempt(hazardActor, actor, skill);
}
```

- [x] **Step 2: Extend `_prepareContext` and add the action handler**

In `scripts/ui/dungeon-app.mjs`, add `classifyTrap` to the existing import from `../trap-combat.mjs` (check the current import list with `grep -n "from \"../trap-combat.mjs\"" scripts/ui/dungeon-app.mjs` first — add it to whatever's already imported there, or add a new import line if none exists yet; also add `attemptTrapDisableForScene`).

Change the existing trap-context block from:

```js
    const isTrapRoom = currentRoom?.kind === "trap" && !currentRoomResolved;
    let trap = null;
    if (isTrapRoom && currentRoom.trap) {
      const raw = currentRoom.trap;
      trap = { name: raw.name, description: raw.description };
    }
```

to:

```js
    const isTrapRoom = currentRoom?.kind === "trap" && !currentRoomResolved;
    let trap = null;
    if (isTrapRoom && currentRoom.trap) {
      const raw = currentRoom.trap;
      const hazardToken = scene.tokens.find(
        (t) =>
          t.getFlag(MODULE_ID, "trapHazard") &&
          !t.actor?.getFlag(MODULE_ID, "trapTriggered"),
      );
      const hazardActor = hazardToken?.actor;
      trap = {
        name: raw.name,
        description: raw.description,
        detected: hazardActor?.getFlag(MODULE_ID, "trapDetected") ?? false,
        disableChecks: hazardActor ? classifyTrap(hazardActor).disableChecks : [],
      };
    }
```

Add this new action handler, directly after `#onAttemptPuzzleStage`'s closing `}`:

```js
  /** A GM's disable attempt against this room's own detected trap hazard
   * (#753). A no-op if the form has no actor/skill selected. */
  static async #onAttemptTrapDisable() {
    const sceneId = canvas?.scene?.id;
    if (!sceneId) return;
    const form = this.element.querySelector(".pf2edc-dungeon__trap-disable-form");
    const actorId = form?.querySelector('[name="actorId"]')?.value;
    const skill = form?.querySelector('[name="skill"]')?.value;
    if (!actorId || !skill) return;

    if (game.user.isGM) {
      await attemptTrapDisableForScene(sceneId, actorId, skill);
    } else {
      await requestDungeonAction("attemptTrapDisable", { sceneId, actorId, skill });
    }
    this.render();
  }
```

Add `attemptTrapDisable: DungeonApp.#onAttemptTrapDisable,` to the class's existing `static DEFAULT_OPTIONS.actions` object (alongside `attemptPuzzleStage`/`attemptSkillChallenge`).

- [x] **Step 3: Register the remote action**

In `scripts/dungeon-remote.mjs`, add `attemptTrapDisableForScene` to the existing import from `./trap-combat.mjs` (or add a new import line), then add this entry to the action registry, directly after the existing `claimTreasure` entry:

```js
  attemptTrapDisable: (args) =>
    attemptTrapDisableForScene(args.sceneId, args.actorId, args.skill),
```

- [x] **Step 4: Add the template branch and lang keys**

In `templates/dungeon-tracker.hbs`, add a new branch directly after the existing `{{else if isPuzzleRoom}}...{{/if}}` block's own content, before whichever `{{else if ...}}`/`{{else}}` comes next (re-locate the exact surrounding structure fresh before editing):

```handlebars
          {{else if isTrapRoom}}
            <div class="pf2edc-dungeon__trap">
              {{#if isGM}}
                {{#if trap.detected}}
                  <form class="pf2edc-dungeon__trap-disable-form">
                    <label>
                      {{localize "PF2EDC.Dungeon.Trap.WhoLabel"}}
                      <select name="actorId">
                        {{#each partyMembers}}
                          <option value="{{this.id}}">{{this.name}}</option>
                        {{/each}}
                      </select>
                    </label>
                    <label>
                      {{localize "PF2EDC.Dungeon.Trap.SkillLabel"}}
                      <select name="skill">
                        {{#each trap.disableChecks}}
                          <option value="{{this.skill}}">{{this.label}}</option>
                        {{/each}}
                      </select>
                    </label>
                    <button type="button" data-action="attemptTrapDisable">{{localize
                        "PF2EDC.Dungeon.Trap.DisableButton"
                      }}</button>
                  </form>
                {{else}}
                  <p class="hint">{{localize "PF2EDC.Dungeon.Trap.NotDetectedHint"}}</p>
                {{/if}}
              {{/if}}
            </div>
```

Add to `lang/en.json` (placed alphabetically near the existing `PF2EDC.Dungeon.Trap.*` keys — re-check the file fresh for the exact current surrounding keys before inserting):

```json
"PF2EDC.Dungeon.Trap.DisableButton": "Attempt Disable",
"PF2EDC.Dungeon.Trap.NotDetectedHint": "Nothing detected yet.",
"PF2EDC.Dungeon.Trap.SkillLabel": "Skill",
"PF2EDC.Dungeon.Trap.WhoLabel": "Who attempts?",
```

- [x] **Step 5: Live-verify with `foundry-rest`** (deferred to controller per R6)

With a trap already detected (per Task 2's own live verification), open `DungeonApp` as the GM and confirm the disable form renders with the trap's real parsed disable-check options in the skill dropdown. Submit it with a party actor who genuinely has that skill and confirm either a success (hazard actor's `trapDisabled` flag becomes `true`) or failure chat message appears. Separately, confirm submitting with a party actor who does NOT have the chosen skill statistic at all does not throw (the form simply has no visible effect — `rollTrapDisableAttempt` returns `null` for a missing skill stat, unmodified).

- [x] **Step 6: Commit**

```bash
git add scripts/trap-combat.mjs scripts/ui/dungeon-app.mjs scripts/dungeon-remote.mjs templates/dungeon-tracker.hbs lang/en.json
git commit -m "feat(#753): add GM-only trap disable-attempt UI

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 4: Full end-to-end verification and version bump

**Files:**
- Modify: `module.json`

**Interfaces:** None — final integration verification.

- [ ] **Step 1: Full scenario walkthrough**

With a fresh trap room:
1. Confirm its hazard token starts `hidden: true`, no flags set.
2. Approach (adjacent, not onto) — confirm detection fires and the token becomes visible (Task 2's own verification already covers this in isolation; this step confirms it still holds end to end alongside Task 3's UI changes).
3. As the GM, attempt a disable via the new sidebar form and succeed (re-roll with a different/better-skilled actor if the first attempt fails, or accept a failure and continue to step 4 to also verify the triggered-despite-a-failed-attempt path).
4. If disabled: walk onto the trap's cell and confirm NO attack roll/damage occurs (`triggerTrap`'s own pre-existing `trapDisabled` no-op, confirmed still correctly reached). If not disabled (a failed attempt): walk onto it and confirm the attack DOES occur.
5. Confirm `trapTriggered` is now `true` and a second stationary `updateToken` event doesn't fire a second attack.

- [ ] **Step 2: Bump module.json's version**

Re-check the current version first (concurrent sessions push to this repo):

```bash
git fetch origin main -q && git log origin/main -1 --oneline && grep version module.json
```

Apply a **minor** bump (new interaction mechanic), e.g. `0.60.1` → `0.61.0`, using whatever the fetch above shows as current.

- [ ] **Step 3: Commit**

```bash
git add module.json
git commit -m "chore: bump version for #753 trap detect/disable/trigger wiring

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Self-Review

**1. Scope coverage:** The three previously-dead functions (`rollTrapDetection`, `rollTrapDisableAttempt`, `triggerTrap`) are each wired exactly once: detection and trigger in Task 2, disable in Task 3. The corrected scope (all three, not just `triggerTrap`) is fully covered. Trap-room resolution is explicitly confirmed unchanged. No gaps found.

**2. Placeholder scan:** No TBD/TODO, no "add appropriate handling" steps. Task 2/3's live-verification steps each include a real contingency note (re-roll if a Perception/skill check doesn't cooperate) rather than assuming a guaranteed outcome — that's test-execution guidance, not a placeholder for missing code.

**3. Type consistency:** `classifyTrapMove(trapFootprint, moverFootprint): "trigger"|"detect"|"none"` (Task 1) is invoked with the identical argument order and footprint shape in Task 2's `handleTrapTokenMove`. `attemptTrapDisableForScene(sceneId, actorId, skill)` (Task 3) is invoked with the identical argument order in both the direct-GM call and the `dungeon-remote.mjs` registry entry. The three new actor flag names (`trapDetected`, `trapTriggered`, and the pre-existing `trapDisabled`) are used identically across Task 2 (writer) and Task 3 (reader).

**4. Review Focus:** All five items (no re-trigger, disabled-trap-walked-onto stays silent, unhide-on-either-event, disable-form only acts on a detected trap, missing-skill-stat fails gracefully) each have a dedicated test or explicit live-verification step. No gaps found.

---

Plan complete and saved to `docs/superpowers/plans/2026-10-05-trap-detect-disable-trigger-wiring.md`. Please review the plan. Which execution approach would you prefer?

- **Subagent-driven** - A fresh subagent implements each task and a fresh reviewer checks it before the next one starts, then a whole-branch review at the end. Most thorough; costs a fresh context per task and per review.
- **Native** - I implement every task myself in this session, the way this harness runs work, then one fresh reviewer on the most capable model checks the whole branch. Cheapest and fastest; no independent review until the end. Runs well with a mid-tier session model, since the plan carries the design.

For this plan I recommend **Subagent-driven**, because Tasks 2 and 3 introduce real new Foundry-document-mutating glue with no unit-test harness to catch a mistake mechanically (the double-fire guard and the disabled-trap-stays-silent behavior in particular are easy to get subtly wrong), and a fresh reviewer checking Task 2's actual live results before Task 3 builds the UI on top of them is worth the extra cost here. Does the plan capture what you want, and which approach should we use?
