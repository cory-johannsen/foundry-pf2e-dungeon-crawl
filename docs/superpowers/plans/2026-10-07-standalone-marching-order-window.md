# Standalone Marching Order Window Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix #852 — marching order is currently only reachable by opening the Dungeon Tracker, and the tracker no longer auto-opens (#771/#845). Give it its own small, standalone window any connected user (GM or player) can open directly, without the tracker.

**Scope decision (resolved this session via AskUserQuestion):** Entry point is a **scene control button** only (not a macro, token HUD button, or party-sheet entry — all mentioned in the issue's own text as "e.g."/"and/or" alternatives, none mandated). This matches this codebase's own existing, idiomatic pattern for exactly this kind of always-reachable module UI — `scripts/module.mjs`'s own `Hooks.on("getSceneControlButtons", ...)` already adds one button this way (the agent-loop-status button, confirmed current, lines 669-686).

**Scope decision (direct from the issue's own text, no ambiguity):** The new window is available whenever a dungeon run is active, **regardless of GM-less status** — the *existing* tracker-embedded marching-order section is gated on `isGmLessRun` (confirmed current, `templates/dungeon-tracker.hbs:30-32`), but #852's own text asks for it "available whenever a dungeon run is active" and "usable by players (not just the GM)" with no GM-less qualifier. The new standalone window drops that gate.

**Disposition for the tracker's own copy:** Removed (the issue's own "remove or leave a link" choice) — the marching-order section and its two actions are deleted from `dungeon-tracker.hbs`/`scripts/ui/dungeon-app.mjs` once the new app owns this functionality, rather than keeping a second, now-redundant copy of the same UI alive in two places.

**Architecture:** A new `MarchingOrderApp` (`scripts/ui/marching-order-app.mjs`), mirroring `SoundPreviewApp`'s own established lightweight pattern (confirmed current, `scripts/ui/sound-preview-app.mjs` — a small `HandlebarsApplicationMixin(ApplicationV2)` class, one template part, a couple of static action handlers) rather than `DungeonApp`'s own much larger shape. It reuses the exact same data (`effectiveMarchingOrder`, `setMarchingOrder`) and the exact same GM-direct-vs-relay branching (`requestDungeonAction`) `DungeonApp`'s own `#onMoveMarchingOrderUp`/`#onMoveMarchingOrderDown` already use today — relocated, not reinvented, since they're being deleted from `DungeonApp` in the same pass. A new scene control button opens it; a small addition to the existing `updateSetting`/`createSetting` reactive-refresh wiring (`scripts/module.mjs`'s own `onDungeonRunsSettingChanged`, confirmed current) keeps an open instance in sync when the order changes from a different client or from automatic follow-the-leader reordering.

**Tech Stack:** Vanilla ES modules, Handlebars, Foundry VTT `ApplicationV2`.

**Spec:** None — bounded; every piece this plan touches (the data layer, the relay mechanism, the lightweight-app pattern, the scene-control-button pattern) already exists in this repo, confirmed by direct reading this session.

## Global Constraints

- Every merge to `main` bumps `module.json`'s `version` (CLAUDE.md). A real new UI surface plus removal of an old one: minor bump.
- `effectiveMarchingOrder`/`setMarchingOrder` (confirmed current, `scripts/dungeon-runner.mjs:93`/`724`) are **unchanged** — this plan only changes who calls them and from where.
- `requestDungeonAction`'s own relay mechanism (confirmed current, `scripts/dungeon-remote.mjs:137`) and its server-side `"setMarchingOrder"` handler are **unchanged and already wired** — no new relay action is added; the new app calls the exact same action name the tracker already does.
- Respect #109's existing GM-direct-vs-relay branching exactly as `DungeonApp`'s own code already does it (`if (game.user.isGM) { await setMarchingOrder(...) } else { await requestDungeonAction("setMarchingOrder", ...) }`) — never a new, parallel permission check.
- The new window must not assume a dungeon run is active — Foundry builds scene controls once per canvas-ready/scene-change cycle, not reactively per run-start/run-end, so the button itself is unconditionally visible; the app's own `_prepareContext()` handles "no active run" as a real, rendered empty state, not a hidden button.

## Review Focus

- **A player (non-GM) must be able to open the window and successfully reorder followers** — the issue's own primary ask; the relay path must be exercised by an actual non-GM test case, not just assumed because `DungeonApp`'s own code already has it.
- **The window must reflect a marching-order change made from a different client** (another player, or the automatic follow-the-leader reconciliation in `effectiveMarchingOrder`) — the new reactive-refresh wiring, not just the initial render.
- **Opening the window with no active dungeon run on the viewed scene must show a clear empty state, not an error or a blank window.**
- **The tracker itself must have zero remaining trace of marching order** (no dead markup, no orphaned `moveMarchingOrderUp`/`moveMarchingOrderDown` action handlers) — a half-removed old UI is worse than leaving it in place.
- **Follow-the-leader behavior itself (`scripts/dungeon-follow.mjs`) must be completely unaffected** — this plan only changes *how the order is viewed/edited*, never how it's consumed by the auto-follow logic.

---

### Task 1: `MarchingOrderApp`

**Files:**
- Create: `scripts/ui/marching-order-app.mjs`
- Create: `templates/marching-order-app.hbs`
- Test: `tests/marching-order-app.test.mjs`

**Interfaces:**
- Consumes: `getRunState`, `effectiveMarchingOrder`, `setMarchingOrder` (`scripts/dungeon-runner.mjs`); `requestDungeonAction` (`scripts/dungeon-remote.mjs`) — all confirmed current, unchanged signatures.
- Produces: `export class MarchingOrderApp extends HandlebarsApplicationMixin(ApplicationV2)`.

- [x] **Step 1: Check for an existing test convention for a similarly-shaped small app**

```bash
find tests -iname "*sound-preview*" -o -iname "*marching*"
```

If `tests/sound-preview-app.test.mjs` (or similar) exists, follow its exact mocking conventions for `ApplicationV2`/`HandlebarsApplicationMixin`/`foundry.applications.api`. Otherwise, write the test using the same lightweight global-stubbing approach this session's own earlier plans used for Foundry-dependent code (a plain object standing in for `foundry.applications.api.ApplicationV2`/`HandlebarsApplicationMixin`, `game`, etc.).

- [x] **Step 2: Write the failing tests**

```js
import { describe, it, expect, vi, beforeEach } from "vitest";

function installFoundryStubs() {
  globalThis.foundry = {
    applications: {
      api: {
        ApplicationV2: class {},
        HandlebarsApplicationMixin: (Base) => class extends Base {
          render() {}
        },
      },
    },
  };
}

describe("#852 MarchingOrderApp", () => {
  beforeEach(() => {
    installFoundryStubs();
  });

  it("builds context with the run's effective marching order, named and flagged first/last", async () => {
    const { MarchingOrderApp } = await import("../scripts/ui/marching-order-app.mjs");
    globalThis.canvas = { scene: { id: "scene1" } };
    globalThis.game = {
      actors: { get: (id) => ({ name: `Actor-${id}` }) },
      user: { isGM: true },
    };
    vi.doMock("../scripts/dungeon-runner.mjs", () => ({
      getRunState: () => ({ aiControlledActorIds: ["a", "b"], marchingOrder: ["a", "b"] }),
      effectiveMarchingOrder: (run) => run.marchingOrder,
      setMarchingOrder: vi.fn(),
    }));
    const app = new MarchingOrderApp();
    const ctx = await app._prepareContext();
    expect(ctx.marchingOrder).toEqual([
      { actorId: "a", name: "Actor-a", isFirst: true, isLast: false },
      { actorId: "b", name: "Actor-b", isFirst: false, isLast: true },
    ]);
    expect(ctx.hasRun).toBe(true);
  });

  it("reports no active run when the viewed scene has none", async () => {
    const { MarchingOrderApp } = await import("../scripts/ui/marching-order-app.mjs");
    globalThis.canvas = { scene: { id: "scene1" } };
    globalThis.game = { actors: { get: () => null }, user: { isGM: true } };
    vi.doMock("../scripts/dungeon-runner.mjs", () => ({
      getRunState: () => null,
      effectiveMarchingOrder: () => [],
      setMarchingOrder: vi.fn(),
    }));
    const app = new MarchingOrderApp();
    const ctx = await app._prepareContext();
    expect(ctx.hasRun).toBe(false);
    expect(ctx.marchingOrder).toEqual([]);
  });
});
```

(Adjust the exact mocking mechanism once written against this file's own real import shape — `vi.doMock` requires the module under test to import `dungeon-runner.mjs` fresh after the mock is registered; use dynamic `import()` after `vi.doMock` the way Vitest's own docs describe, or switch to `vi.mock` with a top-level factory if this codebase's other tests already establish that convention — check an existing test of a module that imports `dungeon-runner.mjs` for the real pattern before finalizing.)

- [x] **Step 3: Run the tests to verify they fail**

Run: `npx vitest run tests/marching-order-app.test.mjs`
Expected: FAIL — `scripts/ui/marching-order-app.mjs` does not exist yet.

- [x] **Step 4: Write `scripts/ui/marching-order-app.mjs`**

```js
import { getRunState, effectiveMarchingOrder, setMarchingOrder } from "../dungeon-runner.mjs";
import { requestDungeonAction } from "../dungeon-remote.mjs";

const MODULE_ID = "pf2e-dungeon-crawl";
const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

/**
 * #852: a small, standalone window for viewing/editing the current dungeon
 * run's marching order -- usable by the GM or any player, reachable without
 * opening the Dungeon Tracker (which no longer auto-opens, #771/#845).
 * Mirrors SoundPreviewApp's own lightweight ApplicationV2 shape
 * (scripts/ui/sound-preview-app.mjs) rather than DungeonApp's much larger
 * one. The move-up/move-down logic is relocated from DungeonApp's own
 * (now-removed) #onMoveMarchingOrderUp/#onMoveMarchingOrderDown, unchanged.
 */
export class MarchingOrderApp extends HandlebarsApplicationMixin(ApplicationV2) {
  static DEFAULT_OPTIONS = {
    id: "pf2edc-marching-order-app",
    tag: "section",
    window: { title: "PF2EDC.MarchingOrder.Title", icon: "fa-solid fa-arrows-up-down" },
    position: { width: 320, height: "auto" },
    actions: {
      moveUp: MarchingOrderApp.#onMoveUp,
      moveDown: MarchingOrderApp.#onMoveDown,
    },
  };

  static PARTS = {
    main: { template: `modules/${MODULE_ID}/templates/marching-order-app.hbs` },
  };

  async _prepareContext() {
    const sceneId = canvas?.scene?.id;
    const state = sceneId ? getRunState(sceneId) : null;
    if (!state) return { hasRun: false, marchingOrder: [] };
    const ids = effectiveMarchingOrder(state);
    return {
      hasRun: true,
      marchingOrder: ids.map((actorId, index) => ({
        actorId,
        name: game.actors.get(actorId)?.name ?? "?",
        isFirst: index === 0,
        isLast: index === ids.length - 1,
      })),
    };
  }

  static async #onMoveUp(event, target) {
    await MarchingOrderApp.#move(this, target, -1);
  }

  static async #onMoveDown(event, target) {
    await MarchingOrderApp.#move(this, target, 1);
  }

  static async #move(app, target, delta) {
    const sceneId = canvas?.scene?.id;
    const actorId = target?.dataset?.actorId;
    if (!sceneId || !actorId) return;
    const state = getRunState(sceneId);
    if (!state) return;
    const order = effectiveMarchingOrder(state);
    const index = order.indexOf(actorId);
    const swapWith = index + delta;
    if (index === -1 || swapWith < 0 || swapWith >= order.length) return;
    const reordered = [...order];
    [reordered[index], reordered[swapWith]] = [reordered[swapWith], reordered[index]];
    if (game.user.isGM) {
      await setMarchingOrder(sceneId, reordered);
    } else {
      await requestDungeonAction("setMarchingOrder", { sceneId, orderedActorIds: reordered });
    }
    app.render();
  }
}
```

Note `#move`'s `this` binding: Foundry's own action-dispatcher binds static action handlers with `this` set to the application instance (the same convention `DungeonApp`'s own static handlers already rely on, confirmed current throughout that file) — `#onMoveUp`/`#onMoveDown` pass `this` through to `#move` explicitly, the same pattern `DungeonApp`'s own `#onDeclareVictory`/`#declareOutcome` pair already uses (confirmed current, `scripts/ui/dungeon-app.mjs:1742-1744`).

- [x] **Step 5: Write `templates/marching-order-app.hbs`**

```handlebars
<section class="pf2edc-marching-order-app">
  {{#if hasRun}}
    <ol class="pf2edc-dungeon__marching-order-list">
      {{#each marchingOrder}}
        <li class="pf2edc-dungeon__marching-order-row">
          <span class="pf2edc-dungeon__marching-order-name">{{this.name}}</span>
          <span class="pf2edc-dungeon__marching-order-controls">
            <button type="button" data-action="moveUp" data-actor-id="{{this.actorId}}" {{#if this.isFirst}}disabled{{/if}}>&uarr;</button>
            <button type="button" data-action="moveDown" data-actor-id="{{this.actorId}}" {{#if this.isLast}}disabled{{/if}}>&darr;</button>
          </span>
        </li>
      {{/each}}
    </ol>
  {{else}}
    <p>{{localize "PF2EDC.MarchingOrder.NoActiveRun"}}</p>
  {{/if}}
</section>
```

Add the new `PF2EDC.MarchingOrder.Title`/`PF2EDC.MarchingOrder.NoActiveRun` keys to `lang/en.json`, alongside the existing `PF2EDC.Dungeon.MarchingOrder.Title` key (confirmed current, `templates/dungeon-tracker.hbs:34` references it — check `lang/en.json` for its exact string and reuse the same wording for the new `Title` key rather than inventing new copy).

- [x] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run tests/marching-order-app.test.mjs`
Expected: PASS.

- [x] **Step 7: Commit**

```bash
git add scripts/ui/marching-order-app.mjs templates/marching-order-app.hbs tests/marching-order-app.test.mjs lang/en.json
git commit -m "feat(#852): standalone marching-order window

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 2: Scene control button, and keeping it in sync with remote changes

**Files:**
- Modify: `scripts/module.mjs`

**Interfaces:**
- Consumes: `MarchingOrderApp` (Task 1).

- [x] **Step 1: Add the import**

```js
import { MarchingOrderApp } from "./ui/marching-order-app.mjs";
```

- [x] **Step 2: Extend the existing scene-control hook**

Change (confirmed current, `scripts/module.mjs:669-686`):

```js
Hooks.on("getSceneControlButtons", (controls) => {
  const tokenControl =
    controls.find?.((c) => c.name === "token") ?? controls.token;
  if (!tokenControl) return;
  const agentLoopButton = {
    name: "pf2edc-agent-loop-status",
    title: game.i18n.localize("PF2EDC.SceneControl.AgentLoopStatusLabel"),
    icon: "fa-solid fa-robot",
    visible: game.user.isGM,
    button: true,
    onClick: () => game.modules.get(MODULE_ID).api.postAgentLoopStatus(),
  };
  if (Array.isArray(tokenControl.tools)) {
    tokenControl.tools.push(agentLoopButton);
  } else if (tokenControl.tools && typeof tokenControl.tools === "object") {
    tokenControl.tools["pf2edc-agent-loop-status"] = agentLoopButton;
  }
});
```

to:

```js
Hooks.on("getSceneControlButtons", (controls) => {
  const tokenControl =
    controls.find?.((c) => c.name === "token") ?? controls.token;
  if (!tokenControl) return;
  const agentLoopButton = {
    name: "pf2edc-agent-loop-status",
    title: game.i18n.localize("PF2EDC.SceneControl.AgentLoopStatusLabel"),
    icon: "fa-solid fa-robot",
    visible: game.user.isGM,
    button: true,
    onClick: () => game.modules.get(MODULE_ID).api.postAgentLoopStatus(),
  };
  // #852: visible to every connected user, not just the GM -- a player
  // needs to reach marching order without the tracker (which no longer
  // auto-opens, #771/#845). Always shown rather than gated on "is a run
  // active right now": scene controls are built once per canvas-ready/
  // scene-change cycle, not reactively per run-start/run-end; the app's
  // own _prepareContext handles "no active run" as a real empty state.
  const marchingOrderButton = {
    name: "pf2edc-marching-order",
    title: game.i18n.localize("PF2EDC.SceneControl.MarchingOrderLabel"),
    icon: "fa-solid fa-arrows-up-down",
    visible: true,
    button: true,
    onClick: () => new MarchingOrderApp().render(true),
  };
  if (Array.isArray(tokenControl.tools)) {
    tokenControl.tools.push(agentLoopButton, marchingOrderButton);
  } else if (tokenControl.tools && typeof tokenControl.tools === "object") {
    tokenControl.tools["pf2edc-agent-loop-status"] = agentLoopButton;
    tokenControl.tools["pf2edc-marching-order"] = marchingOrderButton;
  }
});
```

Add the new `PF2EDC.SceneControl.MarchingOrderLabel` key to `lang/en.json`, alongside the existing `PF2EDC.SceneControl.AgentLoopStatusLabel` key.

- [x] **Step 3: Keep an open window in sync with a remote marching-order change**

Change (confirmed current, `scripts/module.mjs:579-585`):

```js
function onDungeonRunsSettingChanged(setting) {
  if (setting.key !== `${MODULE_ID}.dungeonRuns`) return;
  syncGmLessDungeonBroadcast();
}
Hooks.on("updateSetting", onDungeonRunsSettingChanged);
Hooks.on("createSetting", onDungeonRunsSettingChanged);
Hooks.on("canvasReady", syncGmLessDungeonBroadcast);
```

to:

```js
function onDungeonRunsSettingChanged(setting) {
  if (setting.key !== `${MODULE_ID}.dungeonRuns`) return;
  syncGmLessDungeonBroadcast();
  // #852: an open marching-order window reflects a change made from a
  // different client, or an automatic follow-the-leader reconciliation
  // (effectiveMarchingOrder) -- re-rendered on every client that has it
  // open, GM-less or not (unlike syncGmLessDungeonBroadcast, which only
  // concerns the GM-less tracker broadcast).
  const marchingOrderApp = foundry.applications.instances.get("pf2edc-marching-order-app");
  marchingOrderApp?.render();
}
Hooks.on("updateSetting", onDungeonRunsSettingChanged);
Hooks.on("createSetting", onDungeonRunsSettingChanged);
Hooks.on("canvasReady", syncGmLessDungeonBroadcast);
```

- [x] **Step 4: Run the full test suite**

Run: `npx vitest run`
Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add scripts/module.mjs lang/en.json
git commit -m "feat(#852): scene control button opens the marching-order window, stays in sync remotely

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 3: Remove marching order from the tracker

**Files:**
- Modify: `templates/dungeon-tracker.hbs`
- Modify: `scripts/ui/dungeon-app.mjs`
- Test: whatever existing test(s) currently exercise `DungeonApp`'s own marching-order context/actions (`grep -rln "marchingOrder\|MoveMarchingOrder" tests/`)

- [x] **Step 1: Find and update existing tests that will break**

```bash
grep -rln "marchingOrder\|MarchingOrder" tests/
```

Remove or update any assertion in `DungeonApp`'s own test file(s) that currently checks for marching-order context fields or the `moveMarchingOrderUp`/`moveMarchingOrderDown` actions — those are moving to `MarchingOrderApp`'s own test file (Task 1), not staying here.

- [x] **Step 2: Remove the markup**

Delete the `{{#if marchingOrder.length}}...{{/if}}` block from `templates/dungeon-tracker.hbs` (confirmed current, lines 32-55 — read the file fresh to get the exact closing-tag line number, since concurrent sessions may have touched this file since this plan was written).

- [x] **Step 3: Remove the dead code from `scripts/ui/dungeon-app.mjs`**

Remove: the `marchingOrderIds`/`marchingOrder` context-building block (confirmed current, lines 1258-1264), the `marchingOrder` key in whatever object `_prepareContext` returns (confirmed current, line 1364), the `moveMarchingOrderUp: DungeonApp.#onMoveMarchingOrderUp`/`moveMarchingOrderDown: DungeonApp.#onMoveMarchingOrderDown` entries in `static DEFAULT_OPTIONS.actions` (confirmed current, lines 1003-1004), and the `#onMoveMarchingOrderUp`/`#onMoveMarchingOrderDown` static methods themselves (confirmed current, lines 1687-1733). Also remove the now-unused `effectiveMarchingOrder`/`setMarchingOrder` imports from this file if nothing else in it still uses them (`grep -n "effectiveMarchingOrder\|setMarchingOrder" scripts/ui/dungeon-app.mjs` after the removal to confirm).

- [x] **Step 4: Run the full test suite**

Run: `npx vitest run`
Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add templates/dungeon-tracker.hbs scripts/ui/dungeon-app.mjs tests/
git commit -m "refactor(#852): remove marching order from the Dungeon Tracker (moved to its own window)

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 4: Live verification

- [ ] **Step 1: Verify as GM**

Open a dungeon run, click the new scene control button, confirm the window opens, shows the real marching order, and move-up/move-down work and persist.

- [ ] **Step 2: Verify as a player**

From a non-GM client, open the same window via the same scene control button, reorder a follower, and confirm it relays correctly (via `requestDungeonAction`) and the change is visible to the GM's own client too.

- [ ] **Step 3: Verify the empty state**

With no dungeon run active on the viewed scene, open the window and confirm the empty-state message shows instead of an error or blank content.

- [ ] **Step 4: Report findings on the issue**

---

### Task 5: Version bump

**Files:**
- Modify: `module.json`

- [x] **Step 1: Re-check the current version and bump**

```bash
git fetch origin main -q && git log origin/main -1 --oneline && grep version module.json
```

Apply a **minor** bump (a real new UI surface plus removal of an old one), using whatever the fetch above shows as current.

- [x] **Step 2: Commit**

```bash
git add module.json
git commit -m "chore(#852): bump version for the standalone marching-order window

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Self-Review

**1. Scope coverage:** #852's own "Expected" list is covered: a standalone small window (Task 1), reachable without the tracker via a scene control button (Task 2), usable by players via the same relay mechanism the tracker already used (Task 1's `#move`), available whenever a run is active with no GM-less restriction (the dropped `isGmLessRun` gate), the tracker no longer hosting it (Task 3, "remove" chosen), follow-the-leader behavior untouched (confirmed: `dungeon-follow.mjs` is never modified by this plan).

**2. Placeholder scan:** No TBD. Every file/line reference is confirmed current as of this session's own reading; the one genuinely uncertain mechanic (exact Vitest mocking convention for a module that imports `dungeon-runner.mjs`) is flagged explicitly as "check an existing test... before finalizing," not silently guessed.

**3. Type consistency:** `MarchingOrderApp`'s own `_prepareContext()` return shape (`{hasRun, marchingOrder}`) and its `marchingOrder` entry shape (`{actorId, name, isFirst, isLast}`) exactly match `DungeonApp`'s own prior shape (confirmed current, lines 1259-1264) — the template consuming it is a straightforward port, not a redesign.

**4. Review Focus:** All five items (player can actually relay a reorder, remote changes reflect live, a clean empty state, zero dead tracker code, follow-the-leader untouched) each map to a specific task or test. No gaps found.

---

Plan complete and saved to `docs/superpowers/plans/2026-10-07-standalone-marching-order-window.md`.
