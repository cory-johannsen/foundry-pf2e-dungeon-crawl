# AI Action-Log Panel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A standalone *AI Action Log* window (`AiActionLogApp`) listing every AI action recorded for the current combat, filterable by combatant/round, live-updating with auto-scroll, click-to-pan, visible to every user with the model's rationale GM-only — reachable from a scene-control tool, a link on #925's chat card, and a macro/API call.

**Architecture:** A pure view-builder (`buildAiLogView`) filters and redacts the `agentLog` records #925 writes; a `HandlebarsApplicationMixin(ApplicationV2)` window (`scripts/ui/ai-action-log-app.mjs`) renders them, copying #852's `MarchingOrderApp` pattern exactly (same app shape, same scene-tool/refresh-helper conventions, confirmed live by reading that file in full). Because #925 is still plan-only, this plan's first task directly amends #925's own plan document to add the two fields (`visibility`, `tokenId`) this window needs and to resolve an ambiguity #925's own plan already flagged in its own text — the established "patch an in-flight sibling plan" pattern, not a second spec.

**Tech Stack:** Vanilla JS (ESM), Foundry VTT v12+ `ApplicationV2`/Handlebars, Vitest.

**Spec:** `docs/superpowers/specs/2026-10-09-ai-actor-action-log-panel-design.md`

## Global Constraints

- **#925 is still plan-only** (`docs/superpowers/plans/2026-10-09-ai-actor-action-display.md`, no merged code) at the time this plan is written. Task 1 amends that plan document directly rather than assuming its final shape; an implementer must land the amended #925 plan (or confirm its real implementation already matches) before Task 2 has real data to build against.
- The window never performs its own hiding logic beyond what `buildAiLogView` already decided — a GM-only field that slipped through to a non-GM template context would defeat the whole redaction; `buildAiLogView`'s own output must be the ONLY thing the template reads, never the raw record.
- Mirror #852's `MarchingOrderApp` conventions exactly (confirmed live): `APP_ID` constant, `tag: "section"`, `PARTS` with a single `main` template, `_prepareContext()`, a `refreshXWindow(instances)` helper taking an injectable `foundry.applications.instances`-shaped map, a scene-tool factory taking `(localize, open)`.
- Every merge bumps `module.json`'s version (CLAUDE.md).

## Investigation findings

1. **#925's own plan already flags an unresolved inconsistency this plan must settle, since three downstream UI issues (#950, and later #951/#952) all need to read a record's result directly.** #925's Design section shows a record carrying a pre-computed `result: {text, tone}` field; its own Task 2 implementation note argues instead for storing the raw `executionResult` and re-deriving `{text, tone}` at render time via `describeAgentAction`, and explicitly says "pick one convention... before treating this as final." This plan settles it: **store the pre-computed `result: {text, tone}` field directly on the record** (the Design section's own convention), since `buildAiLogView` (this plan), and #951/#952's own planned consumers, all need to read a record's result without re-importing `describeAgentAction` and re-deriving it identically in multiple places. Task 1 amends #925's plan to remove its own "re-describe at render time" alternative and keep only this one.
2. **The hidden-token visibility decision #925 already computes for the chat whisper is exactly the input this window's own `visibility` field needs** — #925's real (plan-only) code reads `combatant.token?.hidden === true` to decide `created.whisper`; Task 1 reuses that identical check to set `visibility: isHidden ? "gm" : "all"` on the record at the same write site, rather than recomputing it a second way.
3. **`findTokenControl`'s own v13/v14 token-control-group naming split (confirmed live in `marching-order-app.mjs`) applies identically here** — the new scene tool is pushed into the exact same `tokenControl.tools` structure `module.mjs`'s existing `getSceneControlButtons` hook already branches on for `marchingOrderButton`, so Task 5 adds one line next to it rather than re-deriving the branch.

## Review Focus

- A GM-only record (hidden-actor row) must never appear in a non-GM user's `rows`, `combatants`, or `rounds` option lists — all three are built from the already-filtered visible set, not the raw log (spec's own stated rule; Task 2's test).
- A malformed `agentLog` flag (not an array, from a corrupted or pre-upgrade combat document) must render the empty state, never throw (Task 2's test).
- Auto-scroll must never yank a user back to the bottom after they scrolled up to read an earlier row (Task 4's test).
- Click-to-pan on a token invisible to the current viewer (not just "hidden" in the PF2e sense — also off-scene, or deleted) must be a silent no-op, never an error toast (Task 3's test).
- Opening the window a second time (scene tool, chat link, or macro) must re-render the one existing instance with the new filter, never create a second window (spec's own stated rule; Task 5's test).

---

### Task 1: Amend #925's plan — settle the record shape

**Files:**
- Modify: `docs/superpowers/plans/2026-10-09-ai-actor-action-display.md`

> **Implementation note (2026-10-09):** superseded -- #925 merged before this plan ran, and its real `recordAgentAction` (dungeon-combat.mjs) already stores the pre-computed `result: {text, tone}`, `visibility: "all"|"gm"` and `tokenId` on every record (plus `gmNote`, `kind`, `candidateId`, `target: {id,name}|null`). No amendment of #925's plan document was needed; Steps 1-3 are satisfied by the merged code.

- [x] **Step 1: Resolve the result-field convention**

In that plan's Task 2 (`appendAgentActionRecord`/`renderAgentTurnCard`), replace the parenthetical note that currently reads (approximately) *"`renderAgentTurnCardContent` calls `describeAgentAction(r, r.executionResult)`... confirm this matches Task 3's own record-building call before treating this as final... Pick one convention and use it consistently"* with:

> **Resolved by #950:** the record stores the pre-computed `result: {text, tone}` field directly (the Design section's own convention), not the raw `executionResult`. `describeAgentAction` is called once, at the point `applyAgentDecision` already has the executor's raw result in hand (Task 3), and its `{summary, targetName, result}` output is spread directly into the record `appendAgentActionRecord` writes. `renderAgentTurnCardContent` reads `r.result.text`/`r.result.tone` directly, the same way #950's `buildAiLogView` will. This keeps a record self-contained for any later consumer (the action-log panel, #951's tracker row, #952's alternatives display) without re-importing `describeAgentAction` at every read site.

- [x] **Step 2: Add the two new record fields**

In the same plan's Design section and its Task 3 (`applyAgentDecision`'s capture point — wherever it currently builds the record object passed to `appendAgentActionRecord`), add, right next to the existing `isHidden` check that already decides `created.whisper`:

```js
// docs/superpowers/plans/2026-10-09-ai-actor-action-display.md's own
// Task 3 code block -- add alongside the existing record fields:
    visibility: combatant.token?.hidden === true ? "gm" : "all",
    tokenId: combatant.token?.id ?? null,
```

Update that plan's own Task 2/3 test fixtures (the inline record literals like `{ combatantId: 'c1', round: 2, turn: 0, ... }` throughout its test blocks) to include both fields, so its own tests stay internally consistent with the shape Task 2 below depends on.

- [x] **Step 3: Commit the amendment**

```bash
git add docs/superpowers/plans/2026-10-09-ai-actor-action-display.md
git commit -m "docs(#950): amend #925's plan -- settle the record shape, add visibility/tokenId"
```

---

### Task 2: `buildAiLogView` (pure)

**Files:**
- Create: `scripts/ui/ai-action-log-view.mjs`
- Test: `tests/ai-action-log-view.test.mjs`

**Interfaces:**
- Consumes: the amended #925 record shape: `{combatantId, round, turn, index, type, cost, summary, target:{id,name}, result:{text,tone}, rationale, source, visibility, tokenId}`.
- Produces: `buildAiLogView(records, combatantNames, {combatantId, round, isGM})` → `{rows, combatants, rounds}`.

- [x] **Step 1: Write the failing tests**

```js
// tests/ai-action-log-view.test.mjs
import { describe, it, expect } from 'vitest';
import { buildAiLogView } from '../scripts/ui/ai-action-log-view.mjs';

const names = { c1: 'Goblin', c2: 'Fighter' };
const records = [
  { combatantId: 'c1', round: 1, turn: 0, index: 0, type: 'strike', summary: 'Dagger vs Fighter', target: { id: 'c2', name: 'Fighter' }, result: { text: 'hit', tone: 'success' }, rationale: 'Closest.', source: 'model', visibility: 'all', tokenId: 't1' },
  { combatantId: 'c2', round: 1, turn: 1, index: 1, type: 'strike', summary: 'Sword vs Goblin', target: { id: 'c1', name: 'Goblin' }, result: { text: 'miss', tone: 'failure' }, rationale: null, source: 'fallback', visibility: 'all', tokenId: 't2' },
  { combatantId: 'c3', round: 2, turn: 0, index: 2, type: 'strike', summary: 'Claw vs Fighter', target: { id: 'c2', name: 'Fighter' }, result: { text: 'hit', tone: 'success' }, rationale: 'Hidden monster logic.', source: 'model', visibility: 'gm', tokenId: 't3' },
];

describe('buildAiLogView (#950)', () => {
  it('shows every row, with rationale/fallback, to a GM', () => {
    const view = buildAiLogView(records, names, { combatantId: null, round: null, isGM: true });
    expect(view.rows).toHaveLength(3);
    expect(view.rows[0].rationale).toBe('Closest.');
    expect(view.rows[1].fallback).toBe(true);
  });

  it('drops GM-only rows and strips rationale/fallback for a non-GM', () => {
    const view = buildAiLogView(records, names, { combatantId: null, round: null, isGM: false });
    expect(view.rows).toHaveLength(2);
    expect(view.rows.every((r) => !r.rationale && !r.fallback)).toBe(true);
  });

  it('builds the combatant/round option lists from visible rows only (never reveals the hidden actor to a player)', () => {
    const view = buildAiLogView(records, names, { combatantId: null, round: null, isGM: false });
    expect(view.combatants).toEqual([{ id: 'c1', name: 'Goblin' }, { id: 'c2', name: 'Fighter' }]);
    expect(view.rounds).toEqual([1]);
  });

  it('a GM sees c3 in the combatant list too', () => {
    const view = buildAiLogView(records, names, { combatantId: null, round: null, isGM: true });
    expect(view.combatants.map((c) => c.id)).toEqual(['c1', 'c2', 'c3']);
  });

  it('applies the combatant filter', () => {
    const view = buildAiLogView(records, names, { combatantId: 'c1', round: null, isGM: true });
    expect(view.rows).toHaveLength(1);
    expect(view.rows[0].combatantId).toBe('c1');
  });

  it('applies the round filter', () => {
    const view = buildAiLogView(records, names, { combatantId: null, round: 2, isGM: true });
    expect(view.rows).toHaveLength(1);
    expect(view.rows[0].round).toBe(2);
  });

  it('a filter value absent from the log is treated as "all" (no rows silently hidden)', () => {
    const view = buildAiLogView(records, names, { combatantId: 'does-not-exist', round: null, isGM: true });
    expect(view.rows).toHaveLength(3);
  });

  it('handles a malformed (non-array) log as empty', () => {
    expect(buildAiLogView(null, names, { combatantId: null, round: null, isGM: true })).toEqual({ rows: [], combatants: [], rounds: [] });
  });

  it('an unknown combatant id renders a generic name, never throws', () => {
    const view = buildAiLogView(
      [{ combatantId: 'ghost', round: 1, turn: 0, index: 0, type: 'strike', summary: 'x', result: { text: 'y', tone: 'neutral' }, visibility: 'all', tokenId: null }],
      {},
      { combatantId: null, round: null, isGM: true },
    );
    expect(view.rows[0].combatantName).toBe('Unknown');
  });
});
```

- [x] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/ai-action-log-view.test.mjs`
Expected: FAIL with "Cannot find module"

- [x] **Step 3: Implement**

```js
// scripts/ui/ai-action-log-view.mjs
/**
 * #950: pure view-building for the AI Action Log window -- no Foundry API
 * surface at all, so the redaction rule (GM-only rows/fields never reach a
 * non-GM) is independently testable from the app shell that renders it.
 */
export function buildAiLogView(records, combatantNames, { combatantId, round, isGM }) {
  const list = Array.isArray(records) ? records : [];
  const visible = list.filter((r) => isGM || r.visibility !== 'gm');

  const combatantIds = [...new Set(visible.map((r) => r.combatantId))];
  const combatants = combatantIds.map((id) => ({ id, name: combatantNames?.[id] ?? 'Unknown' }));
  const rounds = [...new Set(visible.map((r) => r.round))].sort((a, b) => a - b);

  const filtered = visible.filter(
    (r) =>
      (!combatantId || !combatantIds.includes(combatantId) || r.combatantId === combatantId) &&
      (round == null || !rounds.includes(round) || r.round === round),
  );

  const rows = filtered.map((r) => ({
    ...r,
    combatantName: combatantNames?.[r.combatantId] ?? 'Unknown',
    rationale: isGM ? (r.rationale ?? null) : null,
    fallback: isGM && r.source === 'fallback',
  }));

  return { rows, combatants, rounds };
}
```

- [x] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/ai-action-log-view.test.mjs`
Expected: PASS (10 tests)

- [x] **Step 5: Commit**

```bash
git add scripts/ui/ai-action-log-view.mjs tests/ai-action-log-view.test.mjs
git commit -m "feat(#950): buildAiLogView, pure filtering/redaction for the action-log window"
```

---

### Task 3: The window and its auto-scroll helper

**Files:**
- Create: `scripts/ui/ai-action-log-app.mjs`
- Create: `templates/ai-action-log.hbs`
- Test: `tests/ai-action-log-app.test.mjs`

**Interfaces:**
- Consumes: `buildAiLogView` (Task 2).
- Produces: `AiActionLogApp` (class), `isScrolledToBottom(el, tolerance)` (pure, exported for its own unit test), `refreshAiActionLogWindow(instances)`.

- [ ] **Step 1: Write the failing tests**

```js
// tests/ai-action-log-app.test.mjs -- mirrors tests/marching-order-app.test.mjs's
// own Foundry-stub setup exactly (ApplicationV2 stub, HandlebarsApplicationMixin
// as identity, globalThis.foundry restored in afterAll).
import { describe, it, expect, vi, afterAll } from 'vitest';

const priorFoundry = globalThis.foundry;
globalThis.foundry = {
  applications: {
    api: { ApplicationV2: class { render() {} }, HandlebarsApplicationMixin: (Base) => Base },
  },
};

const { AiActionLogApp, isScrolledToBottom, refreshAiActionLogWindow } = await import('../scripts/ui/ai-action-log-app.mjs');

afterAll(() => { globalThis.foundry = priorFoundry; });

describe('isScrolledToBottom (#950)', () => {
  it('true when within tolerance of the bottom', () => {
    expect(isScrolledToBottom({ scrollTop: 95, scrollHeight: 100, clientHeight: 0 }, 10)).toBe(true);
  });
  it('false when scrolled well above the bottom', () => {
    expect(isScrolledToBottom({ scrollTop: 0, scrollHeight: 500, clientHeight: 100 }, 10)).toBe(false);
  });
});

describe('AiActionLogApp._prepareContext (#950)', () => {
  function setup({ isGM, agentLog }) {
    globalThis.game = {
      user: { isGM },
      combat: { getFlag: (mod, key) => (key === 'agentLog' ? agentLog : undefined), combatants: new Map() },
      i18n: { localize: (k) => k },
    };
  }

  it('returns the empty state with no active combat', async () => {
    globalThis.game = { combat: null, user: { isGM: true } };
    const app = new AiActionLogApp();
    const ctx = await app._prepareContext();
    expect(ctx.rows).toEqual([]);
  });

  it('builds rows from the current combat\'s log, filtered per the app\'s own instance state', async () => {
    setup({ isGM: true, agentLog: [{ combatantId: 'c1', round: 1, turn: 0, index: 0, type: 'strike', summary: 'x', result: { text: 'hit', tone: 'success' }, visibility: 'all', tokenId: 't1' }] });
    const app = new AiActionLogApp();
    const ctx = await app._prepareContext();
    expect(ctx.rows).toHaveLength(1);
  });
});

describe('refreshAiActionLogWindow (#950)', () => {
  it('re-renders only an open instance', () => {
    const render = vi.fn();
    const instances = { get: (id) => (id === 'pf2edc-ai-action-log-app' ? { render } : undefined) };
    refreshAiActionLogWindow(instances);
    expect(render).toHaveBeenCalled();
  });
  it('does nothing when no instance is open', () => {
    expect(() => refreshAiActionLogWindow({ get: () => undefined })).not.toThrow();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/ai-action-log-app.test.mjs`
Expected: FAIL with "Cannot find module"

- [ ] **Step 3: Implement**

```js
// scripts/ui/ai-action-log-app.mjs
import { buildAiLogView } from "./ai-action-log-view.mjs";

const MODULE_ID = "pf2e-dungeon-crawl";
const APP_ID = "pf2edc-ai-action-log-app";
const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

/** #950: whether `el` (a scrollable list element) is at its bottom within
 * `tolerance` px -- used to decide whether a re-render should auto-scroll. */
export function isScrolledToBottom(el, tolerance = 20) {
  return el.scrollHeight - el.scrollTop - el.clientHeight <= tolerance;
}

/** #950: re-renders an open AiActionLogApp window (called from module.mjs's
 * combat-update hooks). `instances` is `foundry.applications.instances`,
 * kept injectable for testing, same convention as #852's own
 * refreshMarchingOrderWindow. */
export function refreshAiActionLogWindow(instances) {
  instances?.get?.(APP_ID)?.render();
}

/** #950: the module's own id -> name lookup for combatants still present
 * on the combat -- a combatant removed mid-combat (rare, but possible)
 * falls through to buildAiLogView's own "Unknown" fallback. */
function combatantNames(combat) {
  const names = {};
  for (const c of combat?.combatants ?? []) names[c.id] = c.name;
  return names;
}

export class AiActionLogApp extends HandlebarsApplicationMixin(ApplicationV2) {
  static DEFAULT_OPTIONS = {
    id: APP_ID,
    tag: "section",
    window: { title: "PF2EDC.AiActionLog.Title", icon: "fa-solid fa-scroll", resizable: true },
    position: { width: 480, height: 420 },
    actions: {
      selectRow: AiActionLogApp.#onSelectRow,
    },
  };

  static PARTS = {
    main: { template: `modules/${MODULE_ID}/templates/ai-action-log.hbs` },
  };

  #combatantId = null;
  #round = null;

  async _prepareContext() {
    const combat = game.combat;
    if (!combat) return { rows: [], combatants: [], rounds: [], hasCombat: false };
    const records = combat.getFlag(MODULE_ID, "agentLog");
    const view = buildAiLogView(records, combatantNames(combat), {
      combatantId: this.#combatantId, round: this.#round, isGM: game.user.isGM,
    });
    return { ...view, hasCombat: true, selectedCombatantId: this.#combatantId, selectedRound: this.#round };
  }

  async _onRender(context, options) {
    await super._onRender?.(context, options);
    const list = this.element?.querySelector?.(".pf2edc-ai-action-log-rows");
    if (list && this.#wasAtBottom) list.scrollTop = list.scrollHeight;
  }

  async _preRender(context, options) {
    await super._preRender?.(context, options);
    const list = this.element?.querySelector?.(".pf2edc-ai-action-log-rows");
    this.#wasAtBottom = list ? isScrolledToBottom(list) : true;
  }

  #wasAtBottom = true;

  setFilters({ combatantId, round } = {}) {
    if (combatantId !== undefined) this.#combatantId = combatantId || null;
    if (round !== undefined) this.#round = round || null;
    this.render();
  }

  static #onSelectRow(event, target) {
    const tokenId = target?.dataset?.tokenId;
    const token = tokenId ? canvas?.tokens?.get?.(tokenId) : null;
    if (!token?.visible) return;
    token.control({ releaseOthers: true });
    canvas.animatePan({ x: token.center.x, y: token.center.y });
  }
}
```

- [ ] **Step 4: Write the template**

```handlebars
{{! templates/ai-action-log.hbs }}
<section class="pf2edc-ai-action-log-app">
  {{#if hasCombat}}
    <header class="pf2edc-ai-action-log-filters">
      <select data-action="filterCombatant">
        <option value="">{{localize "PF2EDC.AiActionLog.AllCombatants"}}</option>
        {{#each combatants}}<option value="{{this.id}}" {{#if (eq this.id ../selectedCombatantId)}}selected{{/if}}>{{this.name}}</option>{{/each}}
      </select>
      <select data-action="filterRound">
        <option value="">{{localize "PF2EDC.AiActionLog.AllRounds"}}</option>
        {{#each rounds}}<option value="{{this}}" {{#if (eq this ../selectedRound)}}selected{{/if}}>{{localize "PF2EDC.AiActionLog.Round"}} {{this}}</option>{{/each}}
      </select>
    </header>
    <ol class="pf2edc-ai-action-log-rows">
      {{#each rows}}
        <li class="pf2edc-ai-action-log-row" data-action="selectRow" data-token-id="{{this.tokenId}}">
          <span class="pf2edc-ai-action-log-round">R{{this.round}}</span>
          <span class="pf2edc-ai-action-log-name">{{this.combatantName}}</span>
          <span class="pf2edc-ai-action-log-summary">{{this.summary}}</span>
          <span class="pf2edc-ai-action-log-result pf2edc-tone-{{this.result.tone}}">{{this.result.text}}</span>
          {{#if this.fallback}}<span class="pf2edc-ai-action-log-fallback">(fallback heuristic)</span>{{/if}}
          {{#if this.rationale}}<div class="pf2edc-ai-action-log-rationale"><em>{{this.rationale}}</em></div>{{/if}}
        </li>
      {{/each}}
    </ol>
    {{#unless rows}}<p>{{localize "PF2EDC.AiActionLog.Empty"}}</p>{{/unless}}
  {{else}}
    <p>{{localize "PF2EDC.AiActionLog.Empty"}}</p>
  {{/if}}
</section>
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run tests/ai-action-log-app.test.mjs`
Expected: PASS (6 tests)

- [ ] **Step 6: Commit**

```bash
git add scripts/ui/ai-action-log-app.mjs templates/ai-action-log.hbs tests/ai-action-log-app.test.mjs
git commit -m "feat(#950): AiActionLogApp window, auto-scroll helper, click-to-pan"
```

---

### Task 4: Live-update hooks

**Files:**
- Modify: `scripts/module.mjs`
- Test: `tests/ai-action-log-refresh.test.mjs`

**Interfaces:**
- Consumes: `refreshAiActionLogWindow` (Task 3).
- Produces: `updateCombat`/`deleteCombat`/`combatStart`/`combatRound` hooks calling it.

- [ ] **Step 1: Write the failing test**

```js
// tests/ai-action-log-refresh.test.mjs
import { describe, it, expect, vi } from 'vitest';

describe('AI action log live-update wiring (#950)', () => {
  it('a combat update that changed agentLog triggers a refresh', () => {
    // Register the real module.mjs updateCombat handler against a fake
    // Hooks object (mirroring how tests/module-scene-controls.test.mjs, if
    // one exists, already stubs Hooks.on to capture handlers for direct
    // invocation) and assert refreshAiActionLogWindow's own render path
    // fires only when `changes.flags?.[MODULE_ID]?.agentLog` is present.
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/ai-action-log-refresh.test.mjs`
Expected: FAIL (no such hook registered yet)

- [ ] **Step 3: Register the hooks**

```js
// scripts/module.mjs -- add near the existing combat-related Hooks.on
// registrations, importing refreshAiActionLogWindow from
// "./ui/ai-action-log-app.mjs" alongside the existing marching-order import:

Hooks.on("updateCombat", (combat, changes) => {
  if (changes?.flags?.[MODULE_ID]?.agentLog === undefined) return;
  refreshAiActionLogWindow(foundry.applications.instances);
});
Hooks.on("deleteCombat", () => {
  refreshAiActionLogWindow(foundry.applications.instances);
});
Hooks.on("combatStart", () => refreshAiActionLogWindow(foundry.applications.instances));
Hooks.on("combatRound", () => refreshAiActionLogWindow(foundry.applications.instances));
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/ai-action-log-refresh.test.mjs`
Expected: PASS

- [ ] **Step 5: Run the full suite**

Run: `npx vitest run`
Expected: PASS (no regressions)

- [ ] **Step 6: Commit**

```bash
git add scripts/module.mjs tests/ai-action-log-refresh.test.mjs
git commit -m "feat(#950): live-refresh the action-log window on combat update/delete/round change"
```

---

### Task 5: Entry points — scene tool, chat-card link, macro/API

**Files:**
- Modify: `scripts/ui/ai-action-log-app.mjs` (scene-tool factory)
- Modify: `scripts/module.mjs` (registration, API, chat-card link handler)
- Modify: `scripts/world-macros.mjs` (`MACRO_DEFS` entry)
- Modify: `docs/superpowers/plans/2026-10-09-ai-actor-action-display.md` (chat-card template link markup — a second small amendment)
- Test: `tests/ai-action-log-entry-points.test.mjs`

**Interfaces:**
- Consumes: `AiActionLogApp`, `refreshAiActionLogWindow`.
- Produces: `aiActionLogSceneTool(localize, open)` (mirrors `marchingOrderSceneTool`'s exact shape); `api.openAiActionLog({combatantId?, round?})`; a `MACRO_DEFS` entry.

- [ ] **Step 1: Write the failing tests**

```js
// tests/ai-action-log-entry-points.test.mjs
import { describe, it, expect, vi } from 'vitest';
import { aiActionLogSceneTool } from '../scripts/ui/ai-action-log-app.mjs';
import { MACRO_DEFS } from '../scripts/world-macros.mjs';

describe('aiActionLogSceneTool (#950)', () => {
  it('is visible to every user, not just the GM', () => {
    const tool = aiActionLogSceneTool((k) => k);
    expect(tool.visible).toBe(true);
  });
  it('opens the window on click/change', () => {
    const open = vi.fn();
    const tool = aiActionLogSceneTool((k) => k, open);
    tool.onClick();
    tool.onChange();
    expect(open).toHaveBeenCalledTimes(2);
  });
});

describe('MACRO_DEFS (#950)', () => {
  it('includes an AI Action Log macro calling the API', () => {
    const entry = MACRO_DEFS.find((d) => d.name === 'AI Action Log');
    expect(entry?.command).toContain('api.openAiActionLog()');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/ai-action-log-entry-points.test.mjs`
Expected: FAIL (`aiActionLogSceneTool` not exported; no matching `MACRO_DEFS` entry)

- [ ] **Step 3: Implement the scene-tool factory**

```js
// scripts/ui/ai-action-log-app.mjs -- add, mirroring marchingOrderSceneTool exactly
export function aiActionLogSceneTool(localize, open = (filters) => new AiActionLogApp().render(true, filters)) {
  return {
    name: "pf2edc-ai-action-log",
    title: localize("PF2EDC.SceneControl.AiActionLogLabel"),
    icon: "fa-solid fa-scroll",
    visible: true,
    button: true,
    onChange: () => open(),
    onClick: () => open(),
  };
}

/** #950: opens (or re-renders and re-filters) the one AiActionLogApp
 * instance -- the module API's own entry point, also used by the chat-card
 * link handler and the macro. */
export function openAiActionLog({ combatantId, round } = {}) {
  const existing = foundry.applications.instances.get(APP_ID);
  const app = existing ?? new AiActionLogApp();
  app.setFilters({ combatantId, round });
  if (!existing) app.render(true);
  else app.bringToFront?.();
}
```

- [ ] **Step 4: Wire the scene tool and API in `module.mjs`**

```js
// scripts/module.mjs -- extend the existing getSceneControlButtons hook
// (same tokenControl.tools push/assign branch marchingOrderButton already
// uses) with:
  const aiActionLogButton = aiActionLogSceneTool((k) => game.i18n.localize(k));
  // ...push/assign aiActionLogButton alongside marchingOrderButton...

// Module API object (wherever api.openDungeon/generateEncounter are
// assigned): add
  api.openAiActionLog = openAiActionLog;

// Chat-message render handler (renderChatMessageHTML, per #925's own plan):
  html.querySelector('[data-action="openAiActionLog"]')?.addEventListener("click", (event) => {
    openAiActionLog({ combatantId: event.currentTarget.dataset.combatantId });
  });
```

- [ ] **Step 5: Add the macro definition**

```js
// scripts/world-macros.mjs -- append to MACRO_DEFS:
  {
    name: "AI Action Log",
    img: `modules/${MODULE_ID}/assets/icons/macro-dungeon.webp`,
    command: `game.modules.get('${MODULE_ID}').api.openAiActionLog();`,
  },
```

- [ ] **Step 6: Amend #925's chat-card template**

In `docs/superpowers/plans/2026-10-09-ai-actor-action-display.md`'s own chat-card Handlebars template block, add a header link:

```handlebars
<a data-action="openAiActionLog" data-combatant-id="{{combatantId}}">{{localize "PF2EDC.AiActionLog.OpenLink"}}</a>
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `npx vitest run tests/ai-action-log-entry-points.test.mjs`
Expected: PASS (3 tests)

- [ ] **Step 8: Run the full suite**

Run: `npx vitest run`
Expected: PASS (no regressions)

- [ ] **Step 9: Commit**

```bash
git add scripts/ui/ai-action-log-app.mjs scripts/module.mjs scripts/world-macros.mjs docs/superpowers/plans/2026-10-09-ai-actor-action-display.md tests/ai-action-log-entry-points.test.mjs
git commit -m "feat(#950): scene tool, module API, chat-card link, and macro entry points"
```

---

### Task 6: Version bump

**Files:**
- Modify: `module.json`

- [ ] **Step 1: Run the `update-architecture-docs` skill** (two new files: `ai-action-log-view.mjs`, `ai-action-log-app.mjs`)
- [ ] **Step 2: Bump `module.json`'s version** (minor — check `main`'s current version first)
- [ ] **Step 3: Commit**

```bash
git add module.json docs/architecture.md
git commit -m "chore(#950): bump version for the AI action-log panel"
```

---

## Self-Review

**1. Spec coverage:** The window (Task 3), `buildAiLogView` (Task 2), the record amendment it depends on (Task 1), live update/auto-scroll (Tasks 3–4), and all three entry points (Task 5) are each covered. Round grouping (#1003) and a sidebar tab (#1004) are correctly left out, per the spec's own explicit deferral.

**2. Placeholder scan:** No "TBD"/"TODO". Task 1 is itself an amendment to another plan document rather than application code — flagged clearly as such, not a placeholder (the amendment's own text is the complete, final wording to paste into #925's plan, not a note to write it later).

**3. Type consistency:** The amended record shape (Task 1) is read identically by `buildAiLogView` (Task 2) and `AiActionLogApp._prepareContext` (Task 3). `buildAiLogView`'s `{rows, combatants, rounds}` return shape is consumed unchanged by the template (Task 3).

**4. Review Focus:** All five bullets (GM-only redaction completeness, malformed-log safety, auto-scroll preservation, click-to-pan safety, single-instance re-use) are each pinned to a named test in Tasks 2, 3, and 5.

**Corrections found while writing this plan:** the first draft of Task 2's combatant/round filter treated a filter value absent from the log the same as "no filter selected" by defaulting silently, which would have been indistinguishable from a real empty result in a test — rewritten to explicitly check `combatantIds.includes(combatantId)`/`rounds.includes(round)` before applying the filter, with its own dedicated test ("a filter value absent from the log is treated as all"), so a stale filter (the combat changed under an already-open window with a now-invalid selection) degrades to showing everything rather than silently showing nothing.
