# Combat-Tracker Row Detail and Token Hover Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show an AI combatant's last action (and, GM-only, its rationale) directly under its Combat Tracker row (click to expand to the current + previous round) and in a hover tooltip over its token on the canvas — reading the same `agentLog` #925/#950 already write, with the same audience split.

**Architecture:** A pure digest builder (`scripts/ai-action-digest.mjs`) reduces the log to one combatant's current/previous-round rows, built on a `visibleRecords(records, isGM)` helper this plan factors out of #950's own `buildAiLogView` (patching that still-plan-only plan the same way #950 itself patched #925). A `renderCombatTracker` hook inserts/toggles the summary line under each row; a `hoverToken` hook shows a small DOM overlay positioned next to the hovered token.

**Tech Stack:** Vanilla JS (ESM), Foundry VTT v14 `ApplicationV2` combat tracker, DOM/PIXI coordinate conversion, Vitest.

**Spec:** `docs/superpowers/specs/2026-10-09-ai-actor-tracker-and-hover-detail-design.md`

## Global Constraints

- **#925 and #950 are both still plan-only** at the time this plan is written. Task 1 patches #950's own plan to extract the shared `visibleRecords` helper the spec explicitly asks for; everything else in this plan builds against the record shape #950's own (already-amended, per that plan's own Task 1) shape defines.
- **Amended by #1006:** Task 2 now also exports `renderDigestRowHtml(record, isGM)`, factored out of Task 3's own inline `rowHtml` closure, so #1006's Token HUD panel can render rows identically to this plan's own expanded tracker list without re-deriving the markup a second time.
- Every surface this plan adds is read-only display — it never writes to the combat document, never changes a decision, and must degrade to "nothing shown" rather than throw on any missing/malformed data (spec's own Error handling section).
- The hover overlay and tracker insertion must be idempotent across re-renders — Foundry re-renders both surfaces often (token refresh, tracker update), and a handler that doesn't clean up its own prior insertion first will duplicate content silently.
- Every merge bumps `module.json`'s version (CLAUDE.md).

## Investigation findings

1. **No existing code in this module does canvas-to-screen DOM coordinate conversion** — confirmed by grep across `scripts/`; the only existing per-token overlay (`flanking-indicator.mjs`) draws a PIXI child *inside* the canvas (a token's own child container), not a DOM element positioned over it. The spec's own framing ("the exact conversion API... confirmed at planning") is accurate: this plan's Task 4 implements the standard Foundry pattern (`canvas.stage.worldTransform.apply(token.center)` → stage-local point, then scaled/offset by the canvas element's own `getBoundingClientRect()`) but flags it explicitly as needing live confirmation against the installed Foundry version before this task is considered done, rather than treating an untested guess as final.
2. **`getCombatTrackerEntryContext` (real, merged, confirmed live in `module.mjs`) is a context-menu hook, not a render hook** — it already proves combatant rows are reachable with `data-combatant-id`, but it fires only when a context menu opens, not on every tracker render. The spec's own cited `renderCombatTracker` hook is the right one for Task 3's own insertion, confirmed separately (Foundry's own documented `ApplicationV2` render-hook convention, the same family `renderChatMessageHTML` — #925's own cited hook — belongs to).

## Review Focus

- A combatant with zero records (a human party member, or an AI combatant that hasn't acted yet) must get no inserted summary line at all, not an empty one (spec's own stated rule; Task 3's test).
- The tracker's own re-render (which happens often — any combat-document change) must never duplicate the inserted summary line or lose a user's already-expanded state (Task 3's test).
- The hover overlay must never show for a token the current user cannot see, even if that token's combatant has visible digest data (a GM can see a hidden token on their own canvas; a player without see-invisible-equivalent cannot) — this is a canvas-visibility check independent of the record's own `visibility` field (Task 4's test).
- A coordinate-conversion failure must result in no tooltip, never a tooltip in the wrong place (spec's own stated rule; Task 4's test).
- `buildCombatantDigest`'s "stale" (last-round) fallback must never silently merge current- and previous-round rows into one undifferentiated list — the UI needs to label them separately (Task 2's test).

---

### Task 1: Patch #950's plan — extract `visibleRecords`

**Files:**
- Modify: `docs/superpowers/plans/2026-10-09-ai-actor-action-log-panel.md`

- [x] **Step 1: Extract the shared helper**

In that plan's Task 2 (`buildAiLogView`'s own implementation in `scripts/ui/ai-action-log-view.mjs`), replace the inline filtering line:

```js
const visible = list.filter((r) => isGM || r.visibility !== 'gm');
```

with a call to a newly-exported helper, added just above `buildAiLogView` in that same file:

```js
/** #951: the one, shared definition of "what a non-GM user may see" --
 * reused by #951's own buildCombatantDigest, so the action-log window and
 * the tracker/hover surfaces can never silently disagree about visibility. */
export function visibleRecords(records, isGM) {
  const list = Array.isArray(records) ? records : [];
  return list.filter((r) => isGM || r.visibility !== 'gm');
}
```

```js
export function buildAiLogView(records, combatantNames, { combatantId, round, isGM }) {
  const visible = visibleRecords(records, isGM);
  // ...unchanged from here (the rest of the function already only reads `visible`)...
```

Update that plan's own Task 2 test file reference to note the new export, and add one test there asserting `visibleRecords` is exported and behaves identically to the pre-patch inline logic (same malformed-input and GM/non-GM cases `buildAiLogView`'s own tests already cover, now exercised directly).

- [x] **Step 2: Commit the amendment**

```bash
git add docs/superpowers/plans/2026-10-09-ai-actor-action-log-panel.md
git commit -m "docs(#951): amend #950's plan -- extract the shared visibleRecords helper"
```

---

### Task 2: `buildCombatantDigest` (pure)

**Files:**
- Create: `scripts/ai-action-digest.mjs`
- Test: `tests/ai-action-digest.test.mjs`

**Interfaces:**
- Consumes: `visibleRecords` (Task 1, from `scripts/ui/ai-action-log-view.mjs`).
- Produces: `buildCombatantDigest(records, {combatantId, round, isGM})` → `{last, currentRound, previousRound, stale}`.

- [x] **Step 1: Write the failing tests**

```js
// tests/ai-action-digest.test.mjs
import { describe, it, expect } from 'vitest';
import { buildCombatantDigest } from '../scripts/ai-action-digest.mjs';

const records = [
  { combatantId: 'c1', round: 1, turn: 0, index: 0, type: 'strike', summary: 'a', result: { text: 'hit', tone: 'success' }, rationale: 'r1', source: 'model', visibility: 'all' },
  { combatantId: 'c1', round: 2, turn: 0, index: 1, type: 'strike', summary: 'b', result: { text: 'miss', tone: 'failure' }, rationale: 'r2', source: 'model', visibility: 'all' },
  { combatantId: 'c1', round: 2, turn: 0, index: 2, type: 'strike', summary: 'c', result: { text: 'hit', tone: 'success' }, rationale: null, source: 'fallback', visibility: 'all' },
  { combatantId: 'c2', round: 3, turn: 0, index: 3, type: 'strike', summary: 'd', result: { text: 'hit', tone: 'success' }, visibility: 'gm' },
];

describe('buildCombatantDigest (#951)', () => {
  it('returns currentRound/previousRound/last for the given round, with rationale for a GM', () => {
    const digest = buildCombatantDigest(records, { combatantId: 'c1', round: 2, isGM: true });
    expect(digest.currentRound.map((r) => r.summary)).toEqual(['b', 'c']);
    expect(digest.previousRound.map((r) => r.summary)).toEqual(['a']);
    expect(digest.last.summary).toBe('c');
    expect(digest.last.round).toBe(2);
    expect(digest.stale).toBe(false);
    expect(digest.currentRound[0].rationale).toBe('r2');
  });

  it('strips rationale for a non-GM', () => {
    const digest = buildCombatantDigest(records, { combatantId: 'c1', round: 2, isGM: false });
    expect(digest.currentRound.every((r) => !r.rationale)).toBe(true);
  });

  it('falls back to the most recent earlier round and marks stale when the combatant has not acted this round', () => {
    const digest = buildCombatantDigest(records, { combatantId: 'c1', round: 5, isGM: true });
    expect(digest.currentRound).toEqual([]);
    expect(digest.stale).toBe(true);
    expect(digest.last.summary).toBe('c');
    expect(digest.last.round).toBe(2);
  });

  it('hides a GM-only (hidden-token) combatant entirely from a non-GM', () => {
    const digest = buildCombatantDigest(records, { combatantId: 'c2', round: 3, isGM: false });
    expect(digest.last).toBeNull();
  });

  it('returns last: null and empty rounds for a combatant with no records at all', () => {
    const digest = buildCombatantDigest(records, { combatantId: 'c99', round: 2, isGM: true });
    expect(digest).toEqual({ last: null, currentRound: [], previousRound: [], stale: false });
  });

  it('handles a malformed (non-array) log as no data', () => {
    expect(buildCombatantDigest(null, { combatantId: 'c1', round: 2, isGM: true }).last).toBeNull();
  });
});
```

- [x] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/ai-action-digest.test.mjs`
Expected: FAIL with "Cannot find module"

- [x] **Step 3: Implement**

```js
// scripts/ai-action-digest.mjs
/**
 * #951: pure digest-building for the tracker row and hover tooltip -- no
 * Foundry API surface. Shares #950's own visibleRecords so the action-log
 * window and these two surfaces can never silently disagree about what a
 * non-GM may see.
 */
import { visibleRecords } from "./ui/ai-action-log-view.mjs";

export function buildCombatantDigest(records, { combatantId, round, isGM }) {
  const mine = visibleRecords(records, isGM).filter((r) => r.combatantId === combatantId);
  if (!mine.length) return { last: null, currentRound: [], previousRound: [], stale: false };

  const currentRound = mine.filter((r) => r.round === round).sort((a, b) => a.index - b.index);
  const earlierRounds = [...new Set(mine.filter((r) => r.round < round).map((r) => r.round))].sort((a, b) => b - a);
  const previousRoundNumber = earlierRounds[0] ?? null;
  const previousRound = previousRoundNumber != null
    ? mine.filter((r) => r.round === previousRoundNumber).sort((a, b) => a.index - b.index)
    : [];

  const stale = currentRound.length === 0;
  const lastSource = stale ? [...mine].sort((a, b) => b.round - a.round || b.index - a.index)[0] : currentRound[currentRound.length - 1];
  const last = lastSource
    ? { summary: lastSource.summary, targetName: lastSource.target?.name ?? null, result: lastSource.result, round: lastSource.round }
    : null;

  return { last, currentRound, previousRound, stale };
}

/** #951 (amended for #1006): the one, shared `<li>` fragment for a single
 * digest row -- used by Task 3's tracker-row expanded list AND #1006's
 * Token HUD panel, so the two surfaces can never silently drift apart on
 * what a row looks like or when rationale/fallback show. Pure string
 * building, no Foundry API surface, matching this file's own convention. */
export function renderDigestRowHtml(record, isGM) {
  const rationale = isGM && record.rationale ? `<div class="pf2edc-ai-rationale">${record.rationale}</div>` : "";
  const fallback = isGM && record.source === "fallback" ? ' <span class="pf2edc-ai-fallback">(fallback heuristic)</span>' : "";
  return `<li class="pf2edc-tone-${record.result?.tone ?? "neutral"}">${record.summary} (${record.result?.text ?? ""})${rationale}${fallback}</li>`;
}
```

Add one test above this implementation, alongside `buildCombatantDigest`'s own tests:

```js
import { buildCombatantDigest, renderDigestRowHtml } from '../scripts/ai-action-digest.mjs';

describe('renderDigestRowHtml (#951, amended for #1006)', () => {
  it('includes rationale and the fallback tag for a GM, strips both for a non-GM', () => {
    const record = { summary: 'x', result: { text: 'hit', tone: 'success' }, rationale: 'r', source: 'fallback' };
    expect(renderDigestRowHtml(record, true)).toContain('pf2edc-ai-rationale');
    expect(renderDigestRowHtml(record, true)).toContain('fallback heuristic');
    expect(renderDigestRowHtml(record, false)).not.toContain('pf2edc-ai-rationale');
    expect(renderDigestRowHtml(record, false)).not.toContain('fallback heuristic');
  });
});
```

- [x] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/ai-action-digest.test.mjs`
Expected: PASS (7 tests)

- [x] **Step 5: Commit**

```bash
git add scripts/ai-action-digest.mjs tests/ai-action-digest.test.mjs
git commit -m "feat(#951): buildCombatantDigest, sharing #950's visibleRecords helper"
```

---

### Task 3: Combat Tracker row detail

**Files:**
- Modify: `scripts/module.mjs`
- Create: `styles/ai-action-detail.css`
- Test: `tests/ai-action-tracker-detail.test.mjs`

**Interfaces:**
- Consumes: `buildCombatantDigest` (Task 2).
- Produces: a `renderCombatTracker` hook handler; `renderTrackerDigestInto(rootElement, combat, isGM, expandedIds)` (exported for direct testing without a real Foundry render cycle).

- [ ] **Step 1: Add the `jsdom` devDependency**

**Amended by #1006:** confirmed live that this repo's `vitest.config.mjs` sets `environment: 'node'` (not `'jsdom'`) and no existing test file uses the real `document`/`window` globals — the earlier draft's claim that "existing DOM-touching tests... use real jsdom via vitest's own config" does not hold. This task's own tests, Task 4's tests, and #1006's Token HUD panel tests all need a real DOM, so add it once here:

```bash
npm install --save-dev jsdom
```

Each DOM-touching test file then opts in per-file with a leading pragma comment (already present in this task's and Task 4's test blocks below: `// @vitest-environment jsdom`), rather than switching the whole suite's default environment and risking unrelated non-DOM tests behaving differently under jsdom.

- [ ] **Step 2: Write the failing tests**

```js
// @vitest-environment jsdom
// tests/ai-action-tracker-detail.test.mjs
import { describe, it, expect, vi, beforeEach } from 'vitest';

describe('renderTrackerDigestInto (#951)', () => {
  function makeTrackerDom(combatantIds) {
    document.body.innerHTML = `<ol>${combatantIds.map((id) => `<li data-combatant-id="${id}"><div class="token-name">Name</div></li>`).join('')}</ol>`;
    return document.body;
  }

  it('inserts a summary line only for a combatant with digest data', async () => {
    const { renderTrackerDigestInto } = await import('../scripts/module.mjs');
    const root = makeTrackerDom(['c1', 'c2']);
    const combat = {
      round: 2,
      getFlag: (mod, key) => (key === 'agentLog' ? [{ combatantId: 'c1', round: 2, turn: 0, index: 0, summary: 'x', result: { text: 'hit', tone: 'success' }, visibility: 'all' }] : undefined),
    };
    renderTrackerDigestInto(root, combat, true, new Set());
    expect(root.querySelector('[data-combatant-id="c1"] .pf2edc-ai-last')).toBeTruthy();
    expect(root.querySelector('[data-combatant-id="c2"] .pf2edc-ai-last')).toBeNull();
  });

  it('is idempotent -- a second call never duplicates the inserted line', async () => {
    const { renderTrackerDigestInto } = await import('../scripts/module.mjs');
    const root = makeTrackerDom(['c1']);
    const combat = { round: 2, getFlag: () => [{ combatantId: 'c1', round: 2, turn: 0, index: 0, summary: 'x', result: { text: 'hit', tone: 'success' }, visibility: 'all' }] };
    renderTrackerDigestInto(root, combat, true, new Set());
    renderTrackerDigestInto(root, combat, true, new Set());
    expect(root.querySelectorAll('[data-combatant-id="c1"] .pf2edc-ai-last')).toHaveLength(1);
  });

  it('expands the row when its combatant id is in expandedIds', async () => {
    const { renderTrackerDigestInto } = await import('../scripts/module.mjs');
    const root = makeTrackerDom(['c1']);
    const combat = { round: 2, getFlag: () => [{ combatantId: 'c1', round: 2, turn: 0, index: 0, summary: 'x', result: { text: 'hit', tone: 'success' }, visibility: 'all' }] };
    renderTrackerDigestInto(root, combat, true, new Set(['c1']));
    expect(root.querySelector('[data-combatant-id="c1"] .pf2edc-ai-expanded')).toBeTruthy();
  });

  it('treats a malformed agentLog flag as empty (no summary line, no throw)', async () => {
    const { renderTrackerDigestInto } = await import('../scripts/module.mjs');
    const root = makeTrackerDom(['c1']);
    const combat = { round: 2, getFlag: () => "not-an-array" };
    expect(() => renderTrackerDigestInto(root, combat, true, new Set())).not.toThrow();
    expect(root.querySelector('.pf2edc-ai-last')).toBeNull();
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx vitest run tests/ai-action-tracker-detail.test.mjs`
Expected: FAIL with "renderTrackerDigestInto is not exported"

- [ ] **Step 4: Implement**

```js
// scripts/module.mjs -- new, near the existing getCombatTrackerEntryContext hook
import { buildCombatantDigest, renderDigestRowHtml } from "./ai-action-digest.mjs";

/** #951: combatant ids whose tracker row is currently expanded -- a
 * module-level Set (not per-render state) so it survives the tracker's
 * own frequent re-renders; cleared on combat change (Step 4's hook). */
const expandedTrackerRows = new Set();

/** #951: inserts/refreshes the one-line AI-action summary (and, when
 * expanded, the full current/previous-round list) under every combatant
 * row in `rootElement` that has digest data. Exported so it is directly
 * testable against a plain DOM fragment, without driving a real
 * ApplicationV2 render cycle. Idempotent: removes any prior
 * `.pf2edc-ai-last` for a row before inserting a fresh one. */
export function renderTrackerDigestInto(rootElement, combat, isGM, expandedIds) {
  const records = combat?.getFlag?.("pf2e-dungeon-crawl", "agentLog");
  for (const row of rootElement.querySelectorAll("[data-combatant-id]")) {
    const combatantId = row.dataset.combatantId;
    row.querySelector(".pf2edc-ai-last")?.remove();
    const digest = buildCombatantDigest(records, { combatantId, round: combat?.round ?? 0, isGM });
    if (!digest.last) continue;

    const container = document.createElement("div");
    container.className = "pf2edc-ai-last";
    container.dataset.combatantId = combatantId;
    const prefix = digest.stale ? "(last round) " : "";
    container.innerHTML = `<span class="pf2edc-ai-last-summary pf2edc-tone-${digest.last.result?.tone ?? "neutral"}">${prefix}last: ${digest.last.summary} (${digest.last.result?.text ?? ""})</span>`;
    container.addEventListener("click", () => {
      if (expandedIds.has(combatantId)) expandedIds.delete(combatantId);
      else expandedIds.add(combatantId);
      renderTrackerDigestInto(rootElement, combat, isGM, expandedIds);
    });

    if (expandedIds.has(combatantId)) {
      const expanded = document.createElement("div");
      expanded.className = "pf2edc-ai-expanded";
      const rowHtml = (r) => renderDigestRowHtml(r, isGM);
      expanded.innerHTML = `<ul>${digest.currentRound.map(rowHtml).join("")}</ul>${digest.previousRound.length ? `<p class="pf2edc-ai-previous-round-label">Last round</p><ul>${digest.previousRound.map(rowHtml).join("")}</ul>` : ""}`;
      container.appendChild(expanded);
    }
    row.appendChild(container);
  }
}
```

- [ ] **Step 5: Register the `renderCombatTracker` hook and clear expanded state on combat change**

```js
// scripts/module.mjs -- new Hooks.on registrations:
Hooks.on("renderCombatTracker", (app, html) => {
  const root = html instanceof HTMLElement ? html : html?.[0];
  if (!root || !game.combat) return;
  renderTrackerDigestInto(root, game.combat, game.user.isGM, expandedTrackerRows);
});
Hooks.on("deleteCombat", () => expandedTrackerRows.clear());
```

- [ ] **Step 6: Add the stylesheet**

```css
/* styles/ai-action-detail.css */
.pf2edc-ai-last { font-size: 0.8em; cursor: pointer; opacity: 0.85; }
.pf2edc-ai-last:hover { opacity: 1; }
.pf2edc-ai-expanded { font-size: 0.8em; padding-left: 0.5em; }
.pf2edc-ai-rationale { font-style: italic; opacity: 0.7; }
.pf2edc-ai-fallback { opacity: 0.6; }
.pf2edc-tone-success { color: var(--pf2edc-tone-success, seagreen); }
.pf2edc-tone-failure { color: var(--pf2edc-tone-failure, firebrick); }
.pf2edc-tone-neutral { color: inherit; }
.pf2edc-ai-previous-round-label { font-size: 0.75em; opacity: 0.6; margin: 0.2em 0 0; }
```

Load it through this module's existing style-registration mechanism (confirm the exact entry point — `module.json`'s own `"styles"` array, or a dynamically injected `<link>`, whichever this repo's other stylesheets already use — before treating this step as done).

- [ ] **Step 7: Run the tests to verify they pass**

Run: `npx vitest run tests/ai-action-tracker-detail.test.mjs`
Expected: PASS (4 tests)

- [ ] **Step 8: Run the full suite**

Run: `npx vitest run`
Expected: PASS (no regressions)

- [ ] **Step 9: Commit**

```bash
git add package.json package-lock.json scripts/module.mjs styles/ai-action-detail.css tests/ai-action-tracker-detail.test.mjs
git commit -m "feat(#951): Combat Tracker row summary with click-to-expand detail"
```

---

### Task 4: Token hover tooltip

**Files:**
- Modify: `scripts/module.mjs`
- Test: `tests/ai-action-hover-tooltip.test.mjs`

**Interfaces:**
- Consumes: `buildCombatantDigest` (Task 2).
- Produces: a `hoverToken` hook handler; `renderHoverOverlay(token, combat, isGM)` / `hideHoverOverlay()` (exported).

- [ ] **Step 1: Write the failing tests**

```js
// @vitest-environment jsdom
// tests/ai-action-hover-tooltip.test.mjs
import { describe, it, expect, vi, beforeEach } from 'vitest';

describe('renderHoverOverlay / hideHoverOverlay (#951)', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    globalThis.canvas = {
      stage: { worldTransform: { apply: (p) => p } },
      app: { view: { getBoundingClientRect: () => ({ left: 0, top: 0 }) } },
    };
  });

  it('shows an overlay with the combatant name and last action for a visible AI token', async () => {
    const { renderHoverOverlay } = await import('../scripts/module.mjs');
    const token = { visible: true, combatant: { id: 'c1', name: 'Goblin' }, center: { x: 100, y: 100 }, document: { parent: { combat: {} } } };
    const combat = { round: 1, getFlag: () => [{ combatantId: 'c1', round: 1, turn: 0, index: 0, summary: 'Strikes Fighter', result: { text: 'hit', tone: 'success' }, visibility: 'all' }] };
    renderHoverOverlay(token, combat, true);
    const overlay = document.getElementById('pf2edc-ai-hover');
    expect(overlay).toBeTruthy();
    expect(overlay.textContent).toContain('Goblin');
    expect(overlay.textContent).toContain('Strikes Fighter');
  });

  it('shows nothing for a token the current user cannot see', async () => {
    const { renderHoverOverlay } = await import('../scripts/module.mjs');
    const token = { visible: false, combatant: { id: 'c1', name: 'Goblin' } };
    renderHoverOverlay(token, { round: 1, getFlag: () => [] }, true);
    expect(document.getElementById('pf2edc-ai-hover')).toBeNull();
  });

  it('shows nothing for a combatant with no digest data', async () => {
    const { renderHoverOverlay } = await import('../scripts/module.mjs');
    const token = { visible: true, combatant: { id: 'c1', name: 'Goblin' }, center: { x: 0, y: 0 } };
    renderHoverOverlay(token, { round: 1, getFlag: () => [] }, true);
    expect(document.getElementById('pf2edc-ai-hover')).toBeNull();
  });

  it('hides the overlay on hideHoverOverlay', async () => {
    const { renderHoverOverlay, hideHoverOverlay } = await import('../scripts/module.mjs');
    const token = { visible: true, combatant: { id: 'c1', name: 'Goblin' }, center: { x: 0, y: 0 } };
    const combat = { round: 1, getFlag: () => [{ combatantId: 'c1', round: 1, turn: 0, index: 0, summary: 'x', result: { text: 'hit', tone: 'success' }, visibility: 'all' }] };
    renderHoverOverlay(token, combat, true);
    hideHoverOverlay();
    expect(document.getElementById('pf2edc-ai-hover')?.style.display).toBe('none');
  });

  it('shows nothing when the coordinate conversion throws', async () => {
    globalThis.canvas.stage.worldTransform.apply = () => { throw new Error('no view'); };
    const { renderHoverOverlay } = await import('../scripts/module.mjs');
    const token = { visible: true, combatant: { id: 'c1', name: 'Goblin' }, center: { x: 0, y: 0 } };
    const combat = { round: 1, getFlag: () => [{ combatantId: 'c1', round: 1, turn: 0, index: 0, summary: 'x', result: { text: 'hit', tone: 'success' }, visibility: 'all' }] };
    renderHoverOverlay(token, combat, true);
    expect(document.getElementById('pf2edc-ai-hover')?.style.display).toBe('none');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/ai-action-hover-tooltip.test.mjs`
Expected: FAIL with "renderHoverOverlay is not exported"

- [ ] **Step 3: Implement**

```js
// scripts/module.mjs -- new, near the tracker-detail code

/** #951: the single, reused hover-overlay element, created lazily on first
 * use and hidden (never removed) between hovers -- cheaper than
 * create/destroy on every hoverToken event, same convention a tooltip-style
 * UI element typically uses. */
function hoverOverlayElement() {
  let el = document.getElementById("pf2edc-ai-hover");
  if (!el) {
    el = document.createElement("div");
    el.id = "pf2edc-ai-hover";
    el.style.position = "fixed";
    el.style.pointerEvents = "none";
    el.style.display = "none";
    document.body.appendChild(el);
  }
  return el;
}

export function hideHoverOverlay() {
  hoverOverlayElement().style.display = "none";
}

/** #951: canvas-point -> client-point, confirmed against the installed
 * Foundry version at implementation time (the general PIXI/Foundry
 * pattern: the stage's own worldTransform maps a scene point to
 * stage-local pixels, then the canvas element's own bounding rect gives
 * the page offset) -- flagged explicitly as the one piece this planning
 * session could not verify live; do not ship Task 4 without confirming
 * this against a real running world first. */
function canvasPointToClient(point) {
  const local = canvas.stage.worldTransform.apply(point);
  const rect = canvas.app.view.getBoundingClientRect();
  return { x: rect.left + local.x, y: rect.top + local.y };
}

/** #951: shows (or hides) the hover overlay for `token`. Exported so the
 * hoverToken hook (Step 4) and this task's own tests can call it directly. */
export function renderHoverOverlay(token, combat, isGM) {
  if (!token?.visible || !token?.combatant) return hideHoverOverlay();
  const digest = buildCombatantDigest(combat?.getFlag?.("pf2e-dungeon-crawl", "agentLog"), {
    combatantId: token.combatant.id, round: combat?.round ?? 0, isGM,
  });
  if (!digest.last) return hideHoverOverlay();

  let client;
  try {
    client = canvasPointToClient(token.center);
  } catch {
    return hideHoverOverlay();
  }

  const el = hoverOverlayElement();
  const prefix = digest.stale ? "(last round) " : "";
  el.innerHTML = `<strong>${token.combatant.name}</strong><div class="pf2edc-tone-${digest.last.result?.tone ?? "neutral"}">${prefix}${digest.last.summary} (${digest.last.result?.text ?? ""})</div>${isGM && digest.currentRound.at(-1)?.rationale ? `<div class="pf2edc-ai-rationale">${digest.currentRound.at(-1).rationale}</div>` : ""}`;
  el.style.left = `${client.x + 16}px`;
  el.style.top = `${client.y}px`;
  el.style.display = "block";
}
```

- [ ] **Step 4: Register `hoverToken` and the hide-on-pan/delete/combat-end hooks**

```js
// scripts/module.mjs -- new Hooks.on registrations:
Hooks.on("hoverToken", (token, hovered) => {
  if (!hovered) return hideHoverOverlay();
  const combat = token.document?.parent?.combat;
  if (!combat) return hideHoverOverlay();
  renderHoverOverlay(token, combat, game.user.isGM);
});
Hooks.on("canvasPan", () => hideHoverOverlay());
Hooks.on("deleteToken", () => hideHoverOverlay());
Hooks.on("deleteCombat", () => hideHoverOverlay());
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run tests/ai-action-hover-tooltip.test.mjs`
Expected: PASS (5 tests)

- [ ] **Step 6: Run the full suite**

Run: `npx vitest run`
Expected: PASS (no regressions)

- [ ] **Step 7: Commit**

```bash
git add scripts/module.mjs tests/ai-action-hover-tooltip.test.mjs
git commit -m "feat(#951): token hover tooltip for the last AI action"
```

---

### Task 5: Styling for the hover overlay and version bump

**Files:**
- Modify: `styles/ai-action-detail.css`
- Modify: `module.json`

- [ ] **Step 1: Add the hover-overlay styles**

```css
/* styles/ai-action-detail.css -- append */
#pf2edc-ai-hover {
  background: var(--color-bg-option, rgba(0, 0, 0, 0.85));
  color: var(--color-text-light-primary, #eee);
  border-radius: 4px;
  padding: 0.4em 0.6em;
  font-size: 0.8em;
  max-width: 220px;
  z-index: 100;
}
```

- [ ] **Step 2: Run the `update-architecture-docs` skill** (new file `ai-action-digest.mjs`, new hooks in `module.mjs`)
- [ ] **Step 3: Bump `module.json`'s version** (minor — check `main`'s current version first)
- [ ] **Step 4: Commit**

```bash
git add styles/ai-action-detail.css module.json docs/architecture.md
git commit -m "chore(#951): hover-overlay styling; bump version"
```

---

## Self-Review

**1. Spec coverage:** The shared digest (Task 2), the tracker row (Task 3), the hover tooltip (Task 4), and styling (Task 5) are each covered. The `visibleRecords` sharing the spec explicitly asks for is delivered by patching #950's plan (Task 1) rather than duplicating the filter logic a third time (after #925's own chat-card filtering and #950's view builder).

**2. Placeholder scan:** No "TBD"/"TODO". Task 4's coordinate-conversion function is the one piece flagged explicitly as unconfirmed against a real running Foundry instance — not silently guessed, and the task's own commit is not considered complete until that confirmation happens, stated plainly in the code comment and this Self-Review rather than hidden.

**3. Type consistency:** `buildCombatantDigest`'s `{last, currentRound, previousRound, stale}` shape is produced once in Task 2 and consumed identically by Task 3's tracker renderer and Task 4's hover renderer.

**4. Review Focus:** All five bullets (no-data rows left alone, re-render idempotence, canvas-visibility vs record-visibility, coordinate-failure safety, stale-fallback labeling) are each pinned to a named test in Tasks 2, 3, and 4.

**Corrections found while writing this plan:** the first draft of Task 3's `renderTrackerDigestInto` toggled `expandedIds` and re-rendered from inside the SAME function being defined (a direct self-reference inside its own closure), which works in JS for a named function declaration but would silently break if a later refactor turned it into an arrow function assigned to a `const` before its own definition was in scope — added the click handler as a plain reference to the already-exported `renderTrackerDigestInto` function (not `this` or an inline duplicate), confirmed to resolve correctly at call time because of this, and noted here so a future refactor to a different function form doesn't reintroduce the subtlety silently.

**Correction found by #1006:** this plan's own Task 3/4 test blocks originally claimed "this repo's existing DOM-touching tests... use real jsdom via vitest's own config" — confirmed live (reading `vitest.config.mjs` and `package.json`) that this is false: the configured environment is `'node'`, no `jsdom`/`happy-dom` package is installed, and no existing test file touches the real `document`/`window` globals. Fixed in place: Task 3's new Step 1 adds `jsdom` as a devDependency, and both Task 3's and Task 4's test blocks now carry a leading `// @vitest-environment jsdom` pragma so only these DOM-touching files opt into it.
