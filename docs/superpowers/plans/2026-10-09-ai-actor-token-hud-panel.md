# AI Actors: Token HUD Panel for Recent Actions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a collapsible **AI actions** section to Foundry's right-click Token HUD for AI-controlled combatants, listing up to the 5 most recent actions (current round, then previous round, newest first) with GM-only rationale beneath each row, and a link that opens the #950 log window pre-filtered to that combatant — reusing #951's digest and row template, never re-deriving them.

**Architecture:** A pure windowing function (`hudPanelRows`) and a DOM-insertion function (`renderTokenHudAiPanel`) are added directly to `scripts/module.mjs`, alongside #951's own `renderTrackerDigestInto`/`renderHoverOverlay` — the established precedent for this exact shape of work (a hook-driven digest render into Foundry-supplied DOM, not a standalone Application), rather than the spec's own suggested new `scripts/ui/token-hud-ai-panel.mjs` file. A `renderTokenHUD` hook wires it in, resolving `app.object.document.combatant` (confirmed live against the running world) to find the AI-controlled combatant for the token being right-clicked.

**Tech Stack:** Vanilla JS (ESM), Foundry VTT v14 `ApplicationV2` Token HUD, DOM, Vitest + `jsdom`.

**Spec:** `docs/superpowers/specs/2026-10-09-ai-actor-token-hud-panel-design.md`

## Global Constraints

- **#951 and #950 are both still plan-only** at the time this plan is written. Task 1 amends #951's own plan directly (the established "patch an in-flight sibling plan" pattern #951 itself used on #950, and #950 used on #925) rather than writing a second spec or duplicating logic in a new location.
- This surface is read-only display — it never writes to the Combat document, mirroring #951's own stated constraint.
- The panel must be idempotent across the Token HUD's own repeated renders (reposition, re-open) — remove any prior `.pf2edc-ai-hud` before inserting a fresh one.
- Every merge bumps `module.json`'s version (CLAUDE.md) — minor, matching #951's own category for this kind of UI-feature addition.

## Investigation findings

Confirmed live against the running world (Foundry **14.368**, via the `foundry-rest` skill) rather than assumed from the spec's own prose:

1. **`BasePlaceableHUD.prototype.object` is a real getter** (confirmed by walking `canvas.tokens.hud`'s prototype chain: `TokenHUD` → `HandlebarsApplication` → `BasePlaceableHUD` — `object` is defined on `BasePlaceableHUD`). So in a `renderTokenHUD` hook, `app.object` is the Token placeable and `app.object.document` is its `TokenDocument` — confirms the spec's own claimed resolution path.
2. **`TokenDocument.prototype.combatant` is a real getter** (confirmed: `Object.getOwnPropertyDescriptor(CONFIG.Token.documentClass.prototype, "combatant").get` exists). `app.object.document.combatant` resolves directly to the Combatant for the active combat — no manual `combat.combatants.find(...)` search needed.
3. **No registered hook ties `updateCombat` to a `TokenHUD` re-render** in this installed version — `Hooks.events` has no entries for `updateCombat` or `renderTokenHUD` in a fresh world state, so core's own behavior (if any) for refreshing an *open* HUD when the combat document changes isn't hook-mediated and can't be confirmed by introspection alone. Rather than assume core already does this, Task 2 adds an explicit `updateCombat` listener that re-renders the panel directly when its HUD is open (mirrors #951's own Task 4, which flagged an analogous open question about its coordinate-conversion API and resolved it the same way: write the explicit handling rather than assume).
4. **Correction to the spec's own suggested file path:** the spec names a new `scripts/ui/token-hud-ai-panel.mjs` for the hook. #951 is the nearest real precedent for this exact shape of work, and it put its own equivalent functions directly in `scripts/module.mjs` — confirmed by grep that every `Hooks.on` registration in this codebase lives in `module.mjs`, and no file under `scripts/ui/` registers its own hooks (those files hold class-based Applications — `DungeonApp`, `MarchingOrderApp` — with templates, a different shape of UI than a hook-driven DOM patch). This plan follows that established precedent instead of introducing a new file.
5. **The spec's own `rows = [...currentRound, ...previousRound]` is not actually newest-first as written** — #951's `buildCombatantDigest` stores both arrays oldest-first (sorted ascending by `index`), so a literal concatenation interleaves wrong: it would read current-round-oldest → current-round-newest → previous-round-oldest → previous-round-newest, not newest-first overall. `hudPanelRows` (Task 2) reverses each half before concatenating.

## Review Focus

- A human-controlled combatant (no `agentControlled` flag) must get no section at all, even if the `agentLog` happens to contain stale/malformed records naming that combatant id — a defense-in-depth check independent of digest nullness (Task 2's test).
- The panel must never duplicate across repeated `renderTokenHUD` firings for the same token (Task 2's test).
- The newest-first ordering across current + previous round must reverse each half, not concatenate the digest's own oldest-first arrays directly (Task 2's test; a genuine correction to the spec's own stated rule, see Investigation finding 5).
- Default-collapsed state must omit the row list and the log link from the DOM entirely, not just hide them visually — matching #951's own established "nothing in the DOM when collapsed" convention for the tracker row (Task 2's test).
- A malformed `agentLog` flag (not an array) must degrade to no section, never throw (Task 2's test).

---

### Task 1: Patch #951's plan — share the row template, fix a test-environment gap

**Files:**
- Modify: `docs/superpowers/plans/2026-10-09-ai-actor-tracker-and-hover-detail.md`

- [ ] **Step 1: Extract `renderDigestRowHtml` from Task 3's inline closure**

In that plan's Task 2 (`buildCombatantDigest`'s own implementation in `scripts/ai-action-digest.mjs`), add a second export right after `buildCombatantDigest`:

```js
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

Add a test for it alongside `buildCombatantDigest`'s own tests in that plan's Task 2 test block (bringing that file's test count from 6 to 7):

```js
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

In that plan's Task 3 (`renderTrackerDigestInto`'s implementation in `scripts/module.mjs`), replace the local closure:

```js
const rowHtml = (r) => `<li class="pf2edc-tone-${r.result?.tone ?? "neutral"}">${r.summary} (${r.result?.text ?? ""})${isGM && r.rationale ? `<div class="pf2edc-ai-rationale">${r.rationale}</div>` : ""}${isGM && r.source === "fallback" ? ' <span class="pf2edc-ai-fallback">(fallback heuristic)</span>' : ""}</li>`;
```

with:

```js
const rowHtml = (r) => renderDigestRowHtml(r, isGM);
```

and update that task's own import line to `import { buildCombatantDigest, renderDigestRowHtml } from "./ai-action-digest.mjs";`.

- [ ] **Step 2: Fix the test-environment gap in Task 3 and Task 4**

That plan's Task 3 and Task 4 test blocks both read/write `document.body`, `document.createElement`, `document.getElementById`, etc., and one of them claims "this repo's existing DOM-touching tests... use real jsdom via vitest's own config." Confirmed directly (reading `vitest.config.mjs` and `package.json` in this repo): the configured environment is `'node'`, no `jsdom`/`happy-dom` package is installed, and no existing test file touches the real `document`/`window` globals — that claim does not hold, and both tasks' tests would fail outright with "document is not defined" as written.

Add, as a new first step of that plan's Task 3 (renumbering its existing Steps 1–8 to 2–9):

> **Step 1: Add the `jsdom` devDependency**
>
> ```bash
> npm install --save-dev jsdom
> ```
>
> Each DOM-touching test file opts in per-file with a leading pragma comment, `// @vitest-environment jsdom`, rather than switching the whole suite's default environment.

Add `// @vitest-environment jsdom` as the first line of both that plan's Task 3 test block (`tests/ai-action-tracker-detail.test.mjs`) and Task 4 test block (`tests/ai-action-hover-tooltip.test.mjs`), and remove Task 3's now-inaccurate "confirm that config applies..." comment. Add `package.json package-lock.json` to Task 3's (now Step 9) commit.

- [ ] **Step 3: Commit the amendment**

```bash
git add docs/superpowers/plans/2026-10-09-ai-actor-tracker-and-hover-detail.md
git commit -m "docs(#951): amend plan -- share renderDigestRowHtml with #1006, add jsdom for DOM tests"
```

---

### Task 2: Token HUD panel

**Files:**
- Modify: `scripts/module.mjs`
- Modify: `lang/en.json`
- Test: `tests/ai-action-hud-panel.test.mjs`

**Interfaces:**
- Consumes: `buildCombatantDigest`, `renderDigestRowHtml` (both from `scripts/ai-action-digest.mjs`, the latter per Task 1's amendment); `game.modules.get("pf2e-dungeon-crawl").api.openAiActionLog` (#950's plan, Task 5).
- Produces: `hudPanelRows(digest)` and `renderTokenHudAiPanel(rootElement, combat, combatant, isGM, expandedIds)`, both exported from `scripts/module.mjs` for direct testing; a `renderTokenHUD` hook handler.

- [ ] **Step 1: Write the failing tests**

```js
// @vitest-environment jsdom
// tests/ai-action-hud-panel.test.mjs
import { describe, it, expect, vi, beforeEach } from 'vitest';

function makeHudRoot() {
  document.body.innerHTML = '<div class="hud"></div>';
  return document.body.querySelector('.hud');
}

function combatantStub({ id = 'c1', agentControlled = true } = {}) {
  return { id, getFlag: (mod, key) => (key === 'agentControlled' ? agentControlled : undefined) };
}

beforeEach(() => {
  globalThis.game = {
    i18n: { localize: (key) => key },
    modules: { get: () => ({ api: { openAiActionLog: vi.fn() } }) },
  };
});

describe('hudPanelRows (#1006)', () => {
  it('returns [] for a digest with no last action', async () => {
    const { hudPanelRows } = await import('../scripts/module.mjs');
    expect(hudPanelRows({ last: null, currentRound: [], previousRound: [], stale: false })).toEqual([]);
  });

  it('orders rows newest-first across current and previous round', async () => {
    const { hudPanelRows } = await import('../scripts/module.mjs');
    const currentRound = [{ summary: 'c-old' }, { summary: 'c-mid' }, { summary: 'c-new' }];
    const previousRound = [{ summary: 'p-old' }, { summary: 'p-new' }];
    const digest = { last: { summary: 'c-new' }, currentRound, previousRound, stale: false };
    expect(hudPanelRows(digest).map((r) => r.summary)).toEqual(['c-new', 'c-mid', 'c-old', 'p-new', 'p-old']);
  });

  it('truncates to the 5 most recent rows', async () => {
    const { hudPanelRows } = await import('../scripts/module.mjs');
    const currentRound = Array.from({ length: 4 }, (_, i) => ({ summary: `c${i}` }));
    const previousRound = Array.from({ length: 4 }, (_, i) => ({ summary: `p${i}` }));
    const digest = { last: { summary: 'c3' }, currentRound, previousRound, stale: false };
    expect(hudPanelRows(digest)).toHaveLength(5);
  });
});

describe('renderTokenHudAiPanel (#1006)', () => {
  it('adds no section for a combatant without the agentControlled flag', async () => {
    const { renderTokenHudAiPanel } = await import('../scripts/module.mjs');
    const root = makeHudRoot();
    const combat = { round: 1, getFlag: () => [{ combatantId: 'c1', round: 1, turn: 0, index: 0, summary: 'x', result: { text: 'hit', tone: 'success' }, visibility: 'all' }] };
    renderTokenHudAiPanel(root, combat, combatantStub({ agentControlled: false }), true, new Set());
    expect(root.querySelector('.pf2edc-ai-hud')).toBeNull();
  });

  it('adds no section for an AI-controlled combatant with no digest data', async () => {
    const { renderTokenHudAiPanel } = await import('../scripts/module.mjs');
    const root = makeHudRoot();
    const combat = { round: 1, getFlag: () => [] };
    renderTokenHudAiPanel(root, combat, combatantStub(), true, new Set());
    expect(root.querySelector('.pf2edc-ai-hud')).toBeNull();
  });

  it('adds a collapsed section (toggle only, no rows or link) by default', async () => {
    const { renderTokenHudAiPanel } = await import('../scripts/module.mjs');
    const root = makeHudRoot();
    const combat = { round: 1, getFlag: () => [{ combatantId: 'c1', round: 1, turn: 0, index: 0, summary: 'x', result: { text: 'hit', tone: 'success' }, visibility: 'all' }] };
    renderTokenHudAiPanel(root, combat, combatantStub(), true, new Set());
    const section = root.querySelector('.pf2edc-ai-hud');
    expect(section).toBeTruthy();
    expect(section.querySelector('ol')).toBeNull();
    expect(section.querySelector('[data-action="openAiActionLog"]')).toBeNull();
  });

  it('shows the row list and open-log link when expanded', async () => {
    const { renderTokenHudAiPanel } = await import('../scripts/module.mjs');
    const root = makeHudRoot();
    const combat = { round: 1, getFlag: () => [{ combatantId: 'c1', round: 1, turn: 0, index: 0, summary: 'x', result: { text: 'hit', tone: 'success' }, visibility: 'all' }] };
    renderTokenHudAiPanel(root, combat, combatantStub(), true, new Set(['c1']));
    const section = root.querySelector('.pf2edc-ai-hud');
    expect(section.querySelectorAll('ol li')).toHaveLength(1);
    expect(section.querySelector('[data-action="openAiActionLog"]')?.dataset.combatantId).toBe('c1');
  });

  it('is idempotent across repeated renders', async () => {
    const { renderTokenHudAiPanel } = await import('../scripts/module.mjs');
    const root = makeHudRoot();
    const combat = { round: 1, getFlag: () => [{ combatantId: 'c1', round: 1, turn: 0, index: 0, summary: 'x', result: { text: 'hit', tone: 'success' }, visibility: 'all' }] };
    renderTokenHudAiPanel(root, combat, combatantStub(), true, new Set());
    renderTokenHudAiPanel(root, combat, combatantStub(), true, new Set());
    expect(root.querySelectorAll('.pf2edc-ai-hud')).toHaveLength(1);
  });

  it('prefixes the newest row "(last round)" when the digest is stale', async () => {
    const { renderTokenHudAiPanel } = await import('../scripts/module.mjs');
    const root = makeHudRoot();
    const combat = { round: 5, getFlag: () => [{ combatantId: 'c1', round: 1, turn: 0, index: 0, summary: 'x', result: { text: 'hit', tone: 'success' }, visibility: 'all' }] };
    renderTokenHudAiPanel(root, combat, combatantStub(), true, new Set(['c1']));
    expect(root.querySelector('.pf2edc-ai-hud li').textContent).toContain('(last round)');
  });

  it('treats a malformed agentLog flag as empty (no section, no throw)', async () => {
    const { renderTokenHudAiPanel } = await import('../scripts/module.mjs');
    const root = makeHudRoot();
    const combat = { round: 1, getFlag: () => 'not-an-array' };
    expect(() => renderTokenHudAiPanel(root, combat, combatantStub(), true, new Set())).not.toThrow();
    expect(root.querySelector('.pf2edc-ai-hud')).toBeNull();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/ai-action-hud-panel.test.mjs`
Expected: FAIL with "hudPanelRows is not exported" / "renderTokenHudAiPanel is not exported"

- [ ] **Step 3: Add the `OpenLink` localization key (if not already present from #950)**

In `lang/en.json`, add (keeping the file's existing alphabetical-ish grouping by prefix):

```json
"PF2EDC.AiActionLog.OpenLink": "Open in log",
```

This is the exact key #950's own plan (Task 5) already uses on its chat-card link; reuse it rather than defining a second one.

- [ ] **Step 4: Implement**

```js
// scripts/module.mjs -- new, near #951's own renderTrackerDigestInto/renderHoverOverlay

/** #1006: combatant ids whose Token HUD "AI actions" section is expanded
 * -- a module-level Set, mirroring #951's own expandedTrackerRows;
 * cleared on combat deletion (Step 5's hook). */
const expandedHudPanels = new Set();

/** #1006: windows a #951 digest down to the up-to-5 most recent rows,
 * newest first, spanning the current round then the previous round.
 * buildCombatantDigest's own currentRound/previousRound are each stored
 * oldest-first (sorted ascending by index), so each half is reversed
 * before concatenating -- a literal concatenation would NOT be
 * newest-first overall. */
export function hudPanelRows(digest) {
  if (!digest?.last) return [];
  return [...[...digest.currentRound].reverse(), ...[...digest.previousRound].reverse()].slice(0, 5);
}

/** #1006: inserts/refreshes the collapsible "AI actions" section into a
 * Token HUD's root element, for an AI-controlled combatant with digest
 * data only. Removes any existing section first (idempotent across the
 * HUD's own repeated renders) and leaves none at all for a human
 * combatant, a combatant with no records, or malformed log data.
 * Exported for direct testing against a plain DOM fragment. */
export function renderTokenHudAiPanel(rootElement, combat, combatant, isGM, expandedIds) {
  rootElement.querySelector(".pf2edc-ai-hud")?.remove();
  if (!combatant?.getFlag?.("pf2e-dungeon-crawl", "agentControlled")) return;

  const records = combat?.getFlag?.("pf2e-dungeon-crawl", "agentLog");
  const digest = buildCombatantDigest(records, { combatantId: combatant.id, round: combat?.round ?? 0, isGM });
  if (!digest.last) return;

  const expanded = expandedIds.has(combatant.id);
  const section = document.createElement("section");
  section.className = "pf2edc-ai-hud";

  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.dataset.action = "toggle";
  toggle.setAttribute("aria-expanded", String(expanded));
  toggle.textContent = `AI actions ${expanded ? "▴" : "▾"}`;
  toggle.addEventListener("click", () => {
    if (expanded) expandedIds.delete(combatant.id);
    else expandedIds.add(combatant.id);
    renderTokenHudAiPanel(rootElement, combat, combatant, isGM, expandedIds);
  });
  section.appendChild(toggle);

  if (expanded) {
    const rows = hudPanelRows(digest);
    const list = document.createElement("ol");
    list.innerHTML = rows
      .map((r, i) => renderDigestRowHtml(i === 0 && digest.stale ? { ...r, summary: `(last round) ${r.summary}` } : r, isGM))
      .join("");
    section.appendChild(list);

    const link = document.createElement("a");
    link.href = "#";
    link.dataset.action = "openAiActionLog";
    link.dataset.combatantId = combatant.id;
    link.textContent = game.i18n.localize("PF2EDC.AiActionLog.OpenLink");
    link.addEventListener("click", (event) => {
      event.preventDefault();
      game.modules.get("pf2e-dungeon-crawl").api.openAiActionLog?.({ combatantId: combatant.id });
    });
    section.appendChild(link);
  }

  rootElement.appendChild(section);
}
```

- [ ] **Step 5: Register the `renderTokenHUD` hook and supporting cleanup**

```js
// scripts/module.mjs -- new Hooks.on registrations, near #951's own
// renderCombatTracker/hoverToken registrations:
Hooks.on("renderTokenHUD", (app, html) => {
  const root = html instanceof HTMLElement ? html : html?.[0];
  const combatant = app.object?.document?.combatant;
  if (!root) return;
  if (!combatant) return root.querySelector(".pf2edc-ai-hud")?.remove();
  renderTokenHudAiPanel(root, combatant.parent, combatant, game.user.isGM, expandedHudPanels);
});
Hooks.on("updateCombat", () => {
  const hud = canvas?.tokens?.hud;
  if (hud?.rendered && hud.object?.document?.combatant) hud.render();
});
Hooks.on("deleteCombat", () => expandedHudPanels.clear());
```

The `updateCombat` listener re-renders the open HUD directly (Investigation finding 3: no existing hook already does this), which in turn fires `renderTokenHUD` again and refreshes the panel from the live `agentLog` flag.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run tests/ai-action-hud-panel.test.mjs`
Expected: PASS (9 tests)

- [ ] **Step 7: Run the full suite**

Run: `npx vitest run`
Expected: PASS (no regressions)

- [ ] **Step 8: Commit**

```bash
git add scripts/module.mjs lang/en.json tests/ai-action-hud-panel.test.mjs
git commit -m "feat(#1006): Token HUD AI-actions panel"
```

---

### Task 3: Styling, architecture docs, version bump

**Files:**
- Modify: `styles/ai-action-detail.css` (created by #951's plan; if #951 has not been implemented yet when this task starts, create it first with #951's own Task 5 content, then append)
- Modify: `module.json`
- Modify: `docs/architecture.md`

- [ ] **Step 1: Add the panel styles**

```css
/* styles/ai-action-detail.css -- append */
.pf2edc-ai-hud {
  max-width: 100%;
  font-size: 0.8em;
}
.pf2edc-ai-hud button[data-action="toggle"] {
  width: 100%;
  text-align: left;
  background: none;
  border: none;
  cursor: pointer;
  color: inherit;
}
.pf2edc-ai-hud ol {
  max-height: 14em;
  overflow-y: auto;
  margin: 0.2em 0;
  padding-left: 1.2em;
}
.pf2edc-ai-hud a[data-action="openAiActionLog"] {
  display: block;
  font-size: 0.9em;
  text-align: right;
}
```

- [ ] **Step 2: Run the `update-architecture-docs` skill**

New hooks (`renderTokenHUD`, an additional `updateCombat` listener) and new exports (`hudPanelRows`, `renderTokenHudAiPanel`) were added to `scripts/module.mjs`; no new file was created. Run the skill to confirm `docs/architecture.md` still describes `module.mjs`'s hook surface accurately, and commit any update it produces alongside this task's own commit.

- [ ] **Step 3: Bump `module.json`'s version**

Check `main`'s current version at merge time and apply a minor bump (new user-facing UI surface, matching #951's own category) — do not reuse a version number already used by another merged PR.

- [ ] **Step 4: Commit**

```bash
git add styles/ai-action-detail.css module.json docs/architecture.md
git commit -m "chore(#1006): Token HUD panel styling; bump version"
```

---

## Self-Review

**1. Spec coverage:** The collapsible section (Task 2), reuse of #951's digest and row template rather than re-deriving them (Task 1 + Task 2's `renderDigestRowHtml` import), the "open in log" link via #950's own `api.openAiActionLog` (Task 2), the stale "(last round)" prefix (Task 2), and styling (Task 3) are each covered. The spec's "same digest and row template fragment as the tracker's expanded list" requirement is delivered by patching #951's plan (Task 1) to export `renderDigestRowHtml`, rather than duplicating that markup a third time.

**2. Placeholder scan:** No "TBD"/"TODO". Investigation finding 3 (no hook ties `updateCombat` to an open HUD's re-render) is resolved with an explicit, fully-specified listener in Task 2 Step 5, not left as an assumption.

**3. Type consistency:** `buildCombatantDigest`'s `{last, currentRound, previousRound, stale}` shape (defined in #951's plan) is consumed identically by `hudPanelRows` and `renderTokenHudAiPanel`. `renderDigestRowHtml(record, isGM)`'s signature (defined in #951's plan, Task 1's amendment here) is called identically in both #951's own tracker list and this plan's panel.

**4. Review Focus:** All five bullets (human-combatant exclusion, re-render idempotence, newest-first ordering across reversed halves, collapsed-state DOM omission, malformed-log safety) are each pinned to a named test in Task 2.

**Corrections found while writing this plan:** (1) the spec's own suggested file (`scripts/ui/token-hud-ai-panel.mjs`) doesn't match this codebase's established convention — fixed by following #951's own precedent of keeping hook-driven DOM-patch functions in `scripts/module.mjs` (Investigation finding 4). (2) The spec's own `rows = [...currentRound, ...previousRound]` is not actually newest-first given how `buildCombatantDigest` orders its two arrays — fixed in `hudPanelRows` by reversing each half first (Investigation finding 5). (3) While patching #951's plan for the row-template extraction, found and fixed a second, unrelated defect in that same plan: its Task 3/4 test blocks assume a `jsdom` test environment that does not exist in this repo's actual `vitest.config.mjs` (`'node'`) or `package.json` — fixed via Task 1 Step 2, so #951's own plan is implementable as written once this plan's amendment lands.
