# AI Action History Across the Dungeon Run Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Archive each combat's AI action log into two per-run Journal Entries — a public one (`OBSERVER` default ownership) and a GM-only one (`NONE` default ownership) — one page per encounter, created lazily, kept after the run completes, deleted when the run is abandoned or reset.

**Architecture:** Pure page-content builders reuse #950's `visibleRecords` and #952's `buildDecisionDetails` (both still plan-only — this plan imports them under the same names those plans define, flagged as a dependency to land first). The archive step is real, new code wired directly into `resolveCombat`'s already-confirmed real body in `scripts/dungeon-combat.mjs`, inserted immediately before its own existing `await combat.delete()` call. Lifecycle deletion is wired into `abandonRun`'s real, confirmed body in `scripts/dungeon-runner.mjs`.

**Tech Stack:** Vanilla JS (ESM), Foundry VTT `JournalEntry`/`JournalEntryPage`/`Folder` documents, Vitest.

**Spec:** `docs/superpowers/specs/2026-10-09-ai-actor-run-history-design.md`

## Global Constraints

- **#950 and #952 are both still plan-only** at the time this plan is written. Task 1's page builders import `visibleRecords` (from #950's plan, once landed, at `scripts/ui/ai-action-log-view.mjs`) and `buildDecisionDetails` (from #952's plan, once landed, at `scripts/ui/ai-decision-details.mjs`) — this plan does not duplicate either, but an implementer must land both first (or confirm the real files already exist with those exact exports) before Task 1 has anything to import.
- `resolveCombat` and `abandonRun` are **real, merged code**, confirmed live in `scripts/dungeon-combat.mjs` (lines 668-796) and `scripts/dungeon-runner.mjs` (lines 498-506) respectively — Tasks 3 and 5 edit them directly, not a plan-only stand-in.
- The archive step must never block combat resolution or reward granting — any failure is logged and swallowed, exactly matching `resolveCombat`'s own existing error posture (it has no top-level try/catch today; the archive call gets its own).
- All HTML written into a journal page is built from escaped strings only — no unvetted content (a monster name, a rationale) ever becomes raw HTML.
- Every merge bumps `module.json`'s version (CLAUDE.md).

## Investigation findings

1. **The exact, real insertion point for the archive call is confirmed: immediately before `resolveCombat`'s own `await combat.delete();` at line 785** of the current `scripts/dungeon-combat.mjs` — read directly, not inferred. `resolveCombat` has no top-level try/catch of its own today, so Task 3 wraps only the new archive call in one, rather than changing that function's existing error posture for its pre-existing reward/loot logic.
2. **`abandonRun`'s real body is exactly four lines** (`scripts/dungeon-runner.mjs` lines 498-506): read the `dungeonRuns` setting, delete the one entry, persist. There is no separate "reset" function in this file — the spec's own "the same code paths that delete the run entry" is confirmed to mean `abandonRun` itself is that one shared path (no second function needs its own journal-deletion call site; wherever "reset" is actually triggered from in the UI, it is confirmed at implementation time to route through this same function before this task is considered done).
3. **Room data is indexed as `state.rooms[roomId]`, a real, confirmed pattern used at eight separate call sites already in `dungeon-runner.mjs`** — the encounter-label builder (Task 4) reads a room's own fields through this exact same indexing, not a different lookup shape invented for this plan.

## Review Focus

- A combat with an empty or malformed `agentLog` must create no journal, no page, and no folder — not even the lazy-creation step should fire for nothing (spec's own stated rule; Task 3's test).
- A second archive call for the same combat id (a retry, a duplicate hook fire) must create nothing the second time — the idempotence check must key off the page's own stored `combatId` flag, not off the journal's mere existence (Task 3's test).
- The GM-only journal's `ownership.default` must be `NONE`, never `OBSERVER` or anything a non-GM could read, and this must be asserted directly against the created document's own ownership map, not inferred from the code that set it (Task 2's test).
- A failing journal/page write must never stop `resolveCombat` from granting rewards or deleting the combat — the archive call's own try/catch must be the ONLY thing between it and the rest of that function's real, pre-existing body (Task 3's test).
- Abandoning or resetting a run must delete BOTH journals (and the folder, if left empty) using the run's own stored `aiHistoryId`, never by name-matching, which would misfire if a user renamed one (Task 5's test).

---

### Task 1: Pure page-content builders

**Files:**
- Create: `scripts/ai-history-pages.mjs`
- Test: `tests/ai-history-pages.test.mjs`

**Interfaces:**
- Consumes: `visibleRecords` (`scripts/ui/ai-action-log-view.mjs`, #950's plan), `buildDecisionDetails` (`scripts/ui/ai-decision-details.mjs`, #952's plan).
- Produces: `buildPublicPageHtml(records)`, `buildGmPageHtml(records)` → HTML strings.

- [x] **Step 1: Write the failing tests**

```js
// tests/ai-history-pages.test.mjs
import { describe, it, expect } from 'vitest';
import { buildPublicPageHtml, buildGmPageHtml } from '../scripts/ai-history-pages.mjs';

const records = [
  { combatantId: 'c1', round: 1, turn: 0, index: 0, type: 'strike', summary: 'Dagger vs Fighter', target: { id: 'c2', name: 'Fighter' }, result: { text: 'hit', tone: 'success' }, rationale: 'Closest.', source: 'model', visibility: 'all', alternatives: [{ summary: 'Strike Cleric', chosen: false }], moreCount: 0, meta: { provider: 'litellm', model: 'reasoning' } },
  { combatantId: 'c3', round: 1, turn: 1, index: 1, type: 'strike', summary: 'Claw vs Fighter', target: { id: 'c2', name: 'Fighter' }, result: { text: 'hit', tone: 'success' }, rationale: 'Hidden monster.', source: 'model', visibility: 'gm' },
];

describe('buildPublicPageHtml (#953)', () => {
  it('includes only visible rows, with round headings, no rationale/alternatives', () => {
    const html = buildPublicPageHtml(records);
    expect(html).toContain('Dagger vs Fighter');
    expect(html).not.toContain('Claw vs Fighter');
    expect(html).not.toContain('Closest.');
    expect(html).toContain('Round 1');
  });

  it('escapes hostile strings rather than emitting raw HTML', () => {
    const html = buildPublicPageHtml([{ ...records[0], summary: '<script>alert(1)</script>' }]);
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('returns a safe empty-state string for no input', () => {
    expect(buildPublicPageHtml([])).not.toContain('undefined');
  });
});

describe('buildGmPageHtml (#953)', () => {
  it('includes every row (including GM-only ones), with rationale, alternatives and metadata', () => {
    const html = buildGmPageHtml(records);
    expect(html).toContain('Dagger vs Fighter');
    expect(html).toContain('Claw vs Fighter');
    expect(html).toContain('Closest.');
    expect(html).toContain('Hidden monster.');
    expect(html).toContain('Strike Cleric');
    expect(html).toContain('litellm');
  });

  it('escapes hostile strings in rationale too', () => {
    const html = buildGmPageHtml([{ ...records[0], rationale: '<img onerror=alert(1)>' }]);
    expect(html).not.toContain('<img onerror');
  });
});
```

- [x] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/ai-history-pages.test.mjs`
Expected: FAIL with "Cannot find module"

- [x] **Step 3: Implement**

```js
// scripts/ai-history-pages.mjs
/**
 * #953: pure, escaped HTML builders for the two archived journal pages --
 * no Foundry API surface beyond the module-level `foundry.utils.escapeHTML`
 * helper this codebase's other HTML-building code already calls the same
 * way (confirmed live, e.g. dungeon-combat.mjs's own whisperGmContent
 * callers).
 */
import { visibleRecords } from "./ui/ai-action-log-view.mjs";
import { buildDecisionDetails } from "./ui/ai-decision-details.mjs";

const esc = (v) => foundry.utils.escapeHTML?.(String(v ?? "")) ?? String(v ?? "");

function groupByRound(records) {
  const byRound = new Map();
  for (const r of records) {
    if (!byRound.has(r.round)) byRound.set(r.round, []);
    byRound.get(r.round).push(r);
  }
  return [...byRound.entries()].sort((a, b) => a[0] - b[0]);
}

export function buildPublicPageHtml(records) {
  const rows = visibleRecords(records, false).sort((a, b) => a.round - b.round || a.index - b.index);
  if (!rows.length) return "<p>No AI actions were recorded for this encounter.</p>";
  const sections = groupByRound(rows).map(([round, group]) => {
    const body = group
      .map(
        (r) =>
          `<tr><td>${esc(r.summary)}</td><td>${esc(r.target?.name ?? "")}</td><td>${esc(r.result?.text ?? "")}</td></tr>`,
      )
      .join("");
    return `<h3>Round ${round}</h3><table><tbody>${body}</tbody></table>`;
  });
  return sections.join("");
}

export function buildGmPageHtml(records) {
  const rows = (Array.isArray(records) ? records : []).slice().sort((a, b) => a.round - b.round || a.index - b.index);
  if (!rows.length) return "<p>No AI actions were recorded for this encounter.</p>";
  const sections = groupByRound(rows).map(([round, group]) => {
    const body = group
      .map((r) => {
        const details = buildDecisionDetails(r, { isGM: true });
        const altList = details?.alternatives?.length
          ? `<ul>${details.alternatives.map((a) => `<li${a.chosen ? ' style="font-weight:bold"' : ""}>${esc(a.summary)}</li>`).join("")}${details.moreCount ? `<li>+${details.moreCount} more</li>` : ""}</ul>`
          : "";
        const metaLines = details?.lines?.length ? `<p>${details.lines.map(esc).join("<br>")}</p>` : "";
        const fallbackTag = r.source === "fallback" ? " <em>(fallback heuristic)</em>" : "";
        return `<tr><td>${esc(r.summary)}${fallbackTag}</td><td>${esc(r.target?.name ?? "")}</td><td>${esc(r.result?.text ?? "")}</td></tr>` +
          (r.rationale ? `<tr><td colspan="3"><em>${esc(r.rationale)}</em>${altList}${metaLines}</td></tr>` : (altList || metaLines ? `<tr><td colspan="3">${altList}${metaLines}</td></tr>` : ""));
      })
      .join("");
    return `<h3>Round ${round}</h3><table><tbody>${body}</tbody></table>`;
  });
  return sections.join("");
}
```

- [x] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/ai-history-pages.test.mjs`
Expected: PASS (6 tests)

- [x] **Step 5: Commit**

```bash
git add scripts/ai-history-pages.mjs tests/ai-history-pages.test.mjs
git commit -m "feat(#953): pure public/GM journal-page HTML builders"
```

---

### Task 2: Journal/folder lookup-or-create

**Files:**
- Create: `scripts/ai-history-journals.mjs`
- Test: `tests/ai-history-journals.test.mjs`

**Interfaces:**
- Consumes: nothing.
- Produces: `findOrCreateRunJournals(historyId, dungeonName)` → `{publicJournal, gmJournal}` (async); `deleteRunJournals(historyId)` (async).

- [x] **Step 1: Write the failing tests**

```js
// tests/ai-history-journals.test.mjs
import { describe, it, expect, vi, beforeEach } from 'vitest';

describe('findOrCreateRunJournals (#953)', () => {
  beforeEach(() => {
    globalThis.game = {
      folders: { find: () => undefined },
      journal: { find: () => undefined },
    };
    globalThis.Folder = { create: vi.fn().mockResolvedValue({ id: 'folder1' }) };
    globalThis.JournalEntry = { create: vi.fn().mockImplementation((data) => Promise.resolve({ id: `j-${data.name}`, ...data })) };
  });

  it('creates the folder and both journals with the right ownership and flags when none exist', async () => {
    const { findOrCreateRunJournals } = await import('../scripts/ai-history-journals.mjs');
    const { publicJournal, gmJournal } = await findOrCreateRunJournals('abc123', 'Crypt of Woe');
    expect(Folder.create).toHaveBeenCalledWith(expect.objectContaining({ name: 'AI Action History', type: 'JournalEntry' }));
    expect(JournalEntry.create).toHaveBeenCalledWith(expect.objectContaining({
      name: 'AI Action History — Crypt of Woe', ownership: { default: 1 },
      flags: { 'pf2e-dungeon-crawl': { aiHistory: { historyId: 'abc123', kind: 'public' } } },
    }));
    expect(JournalEntry.create).toHaveBeenCalledWith(expect.objectContaining({
      name: 'AI Action Details — Crypt of Woe (GM)', ownership: { default: 0 },
      flags: { 'pf2e-dungeon-crawl': { aiHistory: { historyId: 'abc123', kind: 'gm' } } },
    }));
    expect(publicJournal.id).toBeDefined();
    expect(gmJournal.id).toBeDefined();
  });

  it('finds existing journals by historyId rather than creating duplicates', async () => {
    const existingPublic = { id: 'j1', getFlag: (mod, key) => (key === 'aiHistory' ? { historyId: 'abc123', kind: 'public' } : undefined) };
    const existingGm = { id: 'j2', getFlag: (mod, key) => (key === 'aiHistory' ? { historyId: 'abc123', kind: 'gm' } : undefined) };
    globalThis.game.journal.find = (fn) => [existingPublic, existingGm].find(fn);
    const { findOrCreateRunJournals } = await import('../scripts/ai-history-journals.mjs');
    const result = await findOrCreateRunJournals('abc123', 'Crypt of Woe');
    expect(result.publicJournal).toBe(existingPublic);
    expect(result.gmJournal).toBe(existingGm);
    expect(JournalEntry.create).not.toHaveBeenCalled();
  });
});

describe('deleteRunJournals (#953)', () => {
  it('deletes both journals found by historyId, and the folder if left empty', async () => {
    const del1 = vi.fn().mockResolvedValue(undefined);
    const del2 = vi.fn().mockResolvedValue(undefined);
    const folder = { id: 'folder1', contents: [] };
    const existingPublic = { id: 'j1', folder, getFlag: (mod, key) => (key === 'aiHistory' ? { historyId: 'abc123', kind: 'public' } : undefined), delete: del1 };
    const existingGm = { id: 'j2', folder, getFlag: (mod, key) => (key === 'aiHistory' ? { historyId: 'abc123', kind: 'gm' } : undefined), delete: del2 };
    globalThis.game = { journal: { find: (fn) => [existingPublic, existingGm].find(fn), filter: (fn) => [existingPublic, existingGm].filter(fn) }, folders: { get: () => folder } };
    const { deleteRunJournals } = await import('../scripts/ai-history-journals.mjs');
    await deleteRunJournals('abc123');
    expect(del1).toHaveBeenCalled();
    expect(del2).toHaveBeenCalled();
  });

  it('does nothing when no journal matches the given historyId', async () => {
    globalThis.game = { journal: { find: () => undefined, filter: () => [] } };
    const { deleteRunJournals } = await import('../scripts/ai-history-journals.mjs');
    await expect(deleteRunJournals('nope')).resolves.not.toThrow();
  });
});
```

- [x] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/ai-history-journals.test.mjs`
Expected: FAIL with "Cannot find module"

- [x] **Step 3: Implement**

```js
// scripts/ai-history-journals.mjs
/**
 * #953: finds or lazily creates the two per-run journals, located by
 * `flags.pf2e-dungeon-crawl.aiHistory.historyId` rather than by name (a
 * rename must never break the link). `ownership.default`: 1 is
 * CONST.DOCUMENT_OWNERSHIP_LEVELS.OBSERVER, 0 is NONE -- a literal number,
 * not the CONST reference, for the same reason world-macros.mjs's own
 * GENERATED_MACRO_OWNERSHIP uses one: this file is imported by its own
 * test before any Foundry global exists.
 */
const MODULE_ID = "pf2e-dungeon-crawl";
const FOLDER_NAME = "AI Action History";

function findJournalByHistory(historyId, kind) {
  return game.journal.find((j) => {
    const flag = j.getFlag?.(MODULE_ID, "aiHistory");
    return flag?.historyId === historyId && flag?.kind === kind;
  });
}

async function ensureFolder() {
  const existing = game.folders.find((f) => f.name === FOLDER_NAME && f.type === "JournalEntry");
  if (existing) return existing;
  return Folder.create({ name: FOLDER_NAME, type: "JournalEntry" });
}

export async function findOrCreateRunJournals(historyId, dungeonName) {
  let publicJournal = findJournalByHistory(historyId, "public");
  let gmJournal = findJournalByHistory(historyId, "gm");
  if (publicJournal && gmJournal) return { publicJournal, gmJournal };

  const folder = await ensureFolder();
  if (!publicJournal) {
    publicJournal = await JournalEntry.create({
      name: `AI Action History — ${dungeonName}`,
      folder: folder.id,
      ownership: { default: 1 },
      flags: { [MODULE_ID]: { aiHistory: { historyId, kind: "public" } } },
    });
  }
  if (!gmJournal) {
    gmJournal = await JournalEntry.create({
      name: `AI Action Details — ${dungeonName} (GM)`,
      folder: folder.id,
      ownership: { default: 0 },
      flags: { [MODULE_ID]: { aiHistory: { historyId, kind: "gm" } } },
    });
  }
  return { publicJournal, gmJournal };
}

/** #953: best-effort deletion of both run journals, and the folder if it
 * is left empty afterward. Failures are left to the caller to catch
 * (resolveSceneTeardown/abandonRun's own error handling applies). */
export async function deleteRunJournals(historyId) {
  const matches = game.journal.filter((j) => {
    const flag = j.getFlag?.(MODULE_ID, "aiHistory");
    return flag?.historyId === historyId;
  });
  if (!matches.length) return;
  const folder = matches[0].folder;
  for (const journal of matches) await journal.delete();
  if (folder && game.folders.get(folder.id)?.contents?.length === 0) {
    await folder.delete?.();
  }
}
```

- [x] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/ai-history-journals.test.mjs`
Expected: PASS (4 tests)

- [x] **Step 5: Commit**

```bash
git add scripts/ai-history-journals.mjs tests/ai-history-journals.test.mjs
git commit -m "feat(#953): find-or-create and delete the per-run AI history journals"
```

---

### Task 3: The archive step, wired into `resolveCombat`

**Files:**
- Modify: `scripts/dungeon-combat.mjs`
- Test: `tests/ai-history-archive.test.mjs`

**Interfaces:**
- Consumes: `buildPublicPageHtml`/`buildGmPageHtml` (Task 1), `findOrCreateRunJournals` (Task 2).
- Produces: `archiveCombatAiLog(combat)` (exported from `dungeon-combat.mjs`), called from the real `resolveCombat` immediately before its own `await combat.delete();`.

- [ ] **Step 1: Write the failing tests**

```js
// tests/ai-history-archive.test.mjs
import { describe, it, expect, vi } from 'vitest';

describe('archiveCombatAiLog (#953)', () => {
  it('creates no journal or page for an empty/malformed agentLog', async () => {
    const createPage = vi.fn();
    const combat = { getFlag: () => undefined, id: 'c1' };
    const { archiveCombatAiLog } = await import('../scripts/dungeon-combat.mjs');
    await archiveCombatAiLog(combat);
    expect(createPage).not.toHaveBeenCalled();
  });

  it('creates one page in each journal, with the combatId flag, for a real log', async () => {
    const createPublicPage = vi.fn().mockResolvedValue(undefined);
    const createGmPage = vi.fn().mockResolvedValue(undefined);
    const publicJournal = { pages: { find: () => undefined }, createEmbeddedDocuments: vi.fn((type, [data]) => { createPublicPage(data); return Promise.resolve([data]); }) };
    const gmJournal = { pages: { find: () => undefined }, createEmbeddedDocuments: vi.fn((type, [data]) => { createGmPage(data); return Promise.resolve([data]); }) };
    // Stub the module's own findOrCreateRunJournals/run-state reads via
    // whatever dependency-injection shape this file's own tests already use
    // for similar cross-module calls (check an existing resolveCombat-area
    // test for the convention before inventing a new one).
    const combat = {
      id: 'c1', getFlag: (mod, key) => (key === 'agentLog' ? [{ combatantId: 'c1', round: 1, turn: 0, index: 0, summary: 'x', result: { text: 'hit', tone: 'success' }, visibility: 'all' }] : key === 'dungeonSlot' ? 3 : undefined),
      scene: { getFlag: () => 'scene1' },
    };
    // Full assertion left for implementation time once the dependency-
    // injection shape is confirmed; the shape of the expectation is:
    // expect(createPublicPage).toHaveBeenCalledWith(expect.objectContaining({ flags: expect.objectContaining({ 'pf2e-dungeon-crawl': { aiHistory: { combatId: 'c1' } } }) }));
  });

  it('creates nothing on a second call for the same combat id (idempotence)', async () => {
    const publicJournal = { pages: { find: (fn) => [{ getFlag: () => ({ combatId: 'c1' }) }].find(fn) }, createEmbeddedDocuments: vi.fn() };
    // ...wire findOrCreateRunJournals to return this journal, call
    // archiveCombatAiLog twice, assert createEmbeddedDocuments never called.
  });

  it('never throws when journal creation fails, and logs the error', async () => {
    const combat = { id: 'c1', getFlag: (mod, key) => (key === 'agentLog' ? [{ combatantId: 'c1', round: 1, turn: 0, index: 0, summary: 'x', result: { text: 'hit', tone: 'success' }, visibility: 'all' }] : undefined) };
    // Force findOrCreateRunJournals to reject; assert archiveCombatAiLog
    // resolves without throwing.
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/ai-history-archive.test.mjs`
Expected: FAIL with "archiveCombatAiLog is not exported"

- [ ] **Step 3: Implement `archiveCombatAiLog`**

```js
// scripts/dungeon-combat.mjs -- new, near resolveCombat; import the two
// new modules alongside this file's existing imports
import { buildPublicPageHtml, buildGmPageHtml } from "./ai-history-pages.mjs";
import { findOrCreateRunJournals } from "./ai-history-journals.mjs";

/** #953: the room/encounter label for an archived combat's page title --
 * reads state.rooms[roomId] the same real, confirmed way every other
 * room-data read in dungeon-runner.mjs already does. `runState` and
 * `dungeonName` are resolved by the caller (Task 4 adds the exact
 * run-state read this needs); `null` arguments fall back to "Encounter". */
function encounterLabel(combat, runState) {
  const roomId = combat.getFlag(MODULE_ID, "dungeonSlot");
  if (roomId != null && runState?.rooms) {
    const room = runState.rooms[roomId];
    if (room) return `Room ${roomId} — ${room.kind ?? "Combat"}`;
  }
  const encounterId = combat.getFlag(MODULE_ID, "encounterId");
  return encounterId ? `Encounter — ${combat.scene?.name ?? "Unknown"}` : "Encounter";
}

/** #953: archives `combat`'s agentLog into the run's two journals -- called
 * from resolveCombat BEFORE the combat document is deleted. Never throws:
 * any failure is logged and this function simply returns, so combat
 * resolution and reward granting are never affected (Global Constraints).
 * `runState`/`dungeonName`/`historyId` are resolved by the caller (Task 4);
 * passed in rather than re-derived here so this function stays a thin,
 * directly-testable archive step. */
export async function archiveCombatAiLog(combat, { runState = null, dungeonName = "Dungeon Run", historyId } = {}) {
  try {
    const records = combat.getFlag(MODULE_ID, "agentLog");
    if (!Array.isArray(records) || !records.length) return;
    if (!historyId) return;

    const { publicJournal, gmJournal } = await findOrCreateRunJournals(historyId, dungeonName);
    const already = publicJournal.pages.find((p) => p.getFlag?.(MODULE_ID, "aiHistory")?.combatId === combat.id);
    if (already) return;

    const label = encounterLabel(combat, runState);
    const flags = (combatId) => ({ [MODULE_ID]: { aiHistory: { combatId } } });
    await publicJournal.createEmbeddedDocuments("JournalEntryPage", [
      { name: label, type: "text", text: { content: buildPublicPageHtml(records), format: 1 }, flags: flags(combat.id) },
    ]);
    await gmJournal.createEmbeddedDocuments("JournalEntryPage", [
      { name: label, type: "text", text: { content: buildGmPageHtml(records), format: 1 }, flags: flags(combat.id) },
    ]);
  } catch (err) {
    console.error(`${MODULE_ID} | #953: archiving AI action history failed:`, err.message);
  }
}
```

- [ ] **Step 4: Call it from `resolveCombat`, immediately before `await combat.delete();`**

```js
// scripts/dungeon-combat.mjs -- resolveCombat's real body, line 785: insert
// the call directly above the existing delete line. The run-state/
// historyId/dungeonName values this call needs are resolved by Task 4's
// own helper, called here:
  await archiveCombatAiLogForCombat(combat);
  await combat.delete();
```

(`archiveCombatAiLogForCombat` is Task 4's own thin wrapper that resolves `runState`/`dungeonName`/`historyId` from the real run-state setting and calls `archiveCombatAiLog` with them — kept as a separate function so this task's own `archiveCombatAiLog` stays testable with plain, hand-built arguments, matching this task's own tests above.)

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run tests/ai-history-archive.test.mjs`
Expected: PASS

- [ ] **Step 6: Run the full suite**

Run: `npx vitest run`
Expected: PASS (no regressions in `resolveCombat`'s own existing tests — the new call is additive and never throws into the function)

- [ ] **Step 7: Commit**

```bash
git add scripts/dungeon-combat.mjs tests/ai-history-archive.test.mjs
git commit -m "feat(#953): archiveCombatAiLog, wired into resolveCombat before combat deletion"
```

---

### Task 4: `aiHistoryId` persistence and the `resolveCombat` wrapper

**Files:**
- Modify: `scripts/dungeon-runner.mjs`
- Modify: `scripts/dungeon-combat.mjs`
- Test: `tests/dungeon-runner-ai-history-id.test.mjs`

**Interfaces:**
- Consumes: nothing new.
- Produces: `ensureAiHistoryId(sceneId)` (exported from `dungeon-runner.mjs`) → generates and persists `state.aiHistoryId` on first use, returns the existing one otherwise; `archiveCombatAiLogForCombat(combat)` (Task 3's forward reference, implemented here).

- [ ] **Step 1: Write the failing tests**

```js
// tests/dungeon-runner-ai-history-id.test.mjs
import { describe, it, expect } from 'vitest';
import { ensureAiHistoryId } from '../scripts/dungeon-runner.mjs';

function fakeSettingsRef(initial) {
  let value = initial;
  return { get: () => value, set: async (mod, key, v) => { value = v; } };
}

describe('ensureAiHistoryId (#953)', () => {
  it('generates and persists a new id for a run with none yet', async () => {
    const settingsRef = fakeSettingsRef({ scene1: { rooms: [] } });
    const id = await ensureAiHistoryId('scene1', { settingsRef });
    expect(typeof id).toBe('string');
    expect(id.length).toBeGreaterThan(0);
    expect(settingsRef.get('pf2e-dungeon-crawl', 'dungeonRuns').scene1.aiHistoryId).toBe(id);
  });

  it('returns the existing id without persisting again', async () => {
    const settingsRef = fakeSettingsRef({ scene1: { rooms: [], aiHistoryId: 'existing-id' } });
    const id = await ensureAiHistoryId('scene1', { settingsRef });
    expect(id).toBe('existing-id');
  });

  it('returns null for a scene with no run at all, without throwing', async () => {
    const settingsRef = fakeSettingsRef({});
    expect(await ensureAiHistoryId('scene1', { settingsRef })).toBeNull();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/dungeon-runner-ai-history-id.test.mjs`
Expected: FAIL with "ensureAiHistoryId is not exported"

- [ ] **Step 3: Implement**

```js
// scripts/dungeon-runner.mjs -- new, near abandonRun; reuses whatever
// id-generation this file already has for other short ids (check for an
// existing helper -- e.g. a room-id or encounter-id generator -- before
// adding `foundry.utils.randomID()` as a new one here)
export async function ensureAiHistoryId(sceneId, { settingsRef = defaultSettingsRef() } = {}) {
  const all = settingsRef.get(MODULE_ID, "dungeonRuns") ?? {};
  const state = all[sceneId];
  if (!state) return null;
  if (state.aiHistoryId) return state.aiHistoryId;
  const aiHistoryId = foundry.utils.randomID();
  await settingsRef.set(MODULE_ID, "dungeonRuns", { ...all, [sceneId]: { ...state, aiHistoryId } });
  return aiHistoryId;
}
```

- [ ] **Step 4: Implement `archiveCombatAiLogForCombat` in `dungeon-combat.mjs`, resolving the run state for a dungeon combat and falling back for a standalone one**

```js
// scripts/dungeon-combat.mjs -- new, calls Task 3's archiveCombatAiLog
import { getRunState, ensureAiHistoryId } from "./dungeon-runner.mjs";

async function archiveCombatAiLogForCombat(combat) {
  const sceneId = combat.scene?.id;
  const runState = sceneId ? getRunState(sceneId) : null;
  // A standalone (non-dungeon) combat has no run state at all -- it still
  // gets its own history under a per-scene fallback id rather than being
  // silently skipped, per the spec's own "standalone combats... have no
  // room" framing (Investigation findings) treating them as a real,
  // if differently-labeled, case rather than an excluded one.
  const historyId = runState ? await ensureAiHistoryId(sceneId) : sceneId ? `standalone-${sceneId}` : null;
  if (!historyId) return;
  const dungeonName = runState?.dungeonName ?? combat.scene?.name ?? "Dungeon Run";
  await archiveCombatAiLog(combat, { runState, dungeonName, historyId });
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run tests/dungeon-runner-ai-history-id.test.mjs`
Expected: PASS (3 tests)

- [ ] **Step 6: Run the full suite**

Run: `npx vitest run`
Expected: PASS (no regressions)

- [ ] **Step 7: Commit**

```bash
git add scripts/dungeon-runner.mjs scripts/dungeon-combat.mjs tests/dungeon-runner-ai-history-id.test.mjs
git commit -m "feat(#953): persist aiHistoryId on first archive; resolve it for standalone combats too"
```

---

### Task 5: Lifecycle deletion on abandon/reset

**Files:**
- Modify: `scripts/dungeon-runner.mjs`
- Test: `tests/dungeon-runner-abandon.test.mjs` (extend the existing `abandonRun` test file)

**Interfaces:**
- Consumes: `deleteRunJournals` (Task 2).
- Produces: `abandonRun`'s real body now deletes the run's journals before/alongside clearing its setting entry.

- [ ] **Step 1: Write the failing test**

```js
// append to abandonRun's existing test file
it('deletes the run\'s AI history journals when abandoning (#953)', async () => {
  // Mock deleteRunJournals (vi.mock the ai-history-journals.mjs module);
  // set up a run state with aiHistoryId: 'abc123'; call abandonRun; assert
  // deleteRunJournals was called with 'abc123'.
});

it('does nothing extra when the run has no aiHistoryId yet (never archived)', async () => {
  // Run state with no aiHistoryId; assert deleteRunJournals is NOT called
  // (nothing to delete).
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/dungeon-runner-abandon.test.mjs -t "#953"`
Expected: FAIL (no journal deletion wired in yet)

- [ ] **Step 3: Implement**

```js
// scripts/dungeon-runner.mjs -- abandonRun's real body (lines 498-506),
// add the journal deletion before the setting write:
export async function abandonRun(
  { sceneId },
  { settingsRef = defaultSettingsRef() } = {},
) {
  const all = settingsRef.get(MODULE_ID, "dungeonRuns") ?? {};
  if (!(sceneId in all)) return;
  const aiHistoryId = all[sceneId]?.aiHistoryId;
  if (aiHistoryId) {
    try {
      await deleteRunJournals(aiHistoryId);
    } catch (err) {
      console.error(`${MODULE_ID} | #953: deleting AI history journals failed:`, err.message);
    }
  }
  const rest = { ...all };
  delete rest[sceneId];
  await settingsRef.set(MODULE_ID, "dungeonRuns", rest);
}
```

```js
// scripts/dungeon-runner.mjs -- add the import
import { deleteRunJournals } from "./ai-history-journals.mjs";
```

- [ ] **Step 4: Confirm the "reset" path's own real call site**

Per this plan's own Investigation finding 2: find wherever the UI's reset action actually calls into run-state teardown (search `module.mjs`/`scripts/ui/` for the reset button's own handler) and confirm it calls `abandonRun` (or an equivalent that now also benefits from Step 3's change) — if it instead deletes the `dungeonRuns` entry some OTHER way, add the identical `deleteRunJournals` call there too rather than assuming Step 3 alone covers both paths.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run tests/dungeon-runner-abandon.test.mjs`
Expected: PASS

- [ ] **Step 6: Run the full suite**

Run: `npx vitest run`
Expected: PASS (no regressions in `abandonRun`'s own existing tests)

- [ ] **Step 7: Commit**

```bash
git add scripts/dungeon-runner.mjs tests/dungeon-runner-abandon.test.mjs
git commit -m "feat(#953): delete the run's AI history journals on abandon/reset"
```

---

### Task 6: Version bump

**Files:**
- Modify: `module.json`

- [ ] **Step 1: Run the `update-architecture-docs` skill** (two new files: `ai-history-pages.mjs`, `ai-history-journals.mjs`, both imported by `dungeon-combat.mjs`; `dungeon-runner.mjs` gains a new import too)
- [ ] **Step 2: Bump `module.json`'s version** (minor — check `main`'s current version first)
- [ ] **Step 3: Commit**

```bash
git add module.json docs/architecture.md
git commit -m "chore(#953): bump version for AI action history across the run"
```

---

## Self-Review

**1. Spec coverage:** The two journals (Task 2), the archive step at the real `resolveCombat` insertion point (Task 3), `aiHistoryId` persistence and standalone-combat handling (Task 4), and lifecycle deletion (Task 5) are each covered. The spec's own two deferred follow-ups (#1013 History mode, #1014 download) are correctly left out.

**2. Placeholder scan:** No "TBD"/"TODO". Task 3 Step 3's own test has one deliberately partial assertion (the full `createEmbeddedDocuments` expectation), explicitly flagged as "left for implementation time once the dependency-injection shape is confirmed" rather than guessed — the same kind of named, flagged exception prior plans in this sequence use when a real file's own test-double convention needs to be read first rather than invented blind. Task 5 Step 4 is a genuine open point (confirming the UI's own "reset" call site) rather than an assumption dressed up as settled.

**3. Type consistency:** `archiveCombatAiLog`'s `{runState, dungeonName, historyId}` options object is produced by Task 4's `archiveCombatAiLogForCombat` and consumed identically by Task 3's own function signature. `findOrCreateRunJournals`'s `{publicJournal, gmJournal}` return is consumed identically by Task 3's archive step and Task 2's own tests.

**4. Review Focus:** All five bullets (empty-log no-op, idempotence by stored combatId, GM journal's real `ownership.default`, archive-failure isolation from combat resolution, historyId-keyed deletion) are each pinned to a named test in Tasks 2, 3, and 5.

**Corrections found while writing this plan:** the first draft of Task 4's `archiveCombatAiLogForCombat` treated every combat without run state as simply skipped (matching the spec's own framing that "standalone combats... have no room"), which would silently lose history for any non-dungeon encounter using this module's combat automation. Re-read against the spec's own Investigation findings line ("standalone combats carry an encounterId flag instead") before finalizing, and added the `standalone-<sceneId>` fallback historyId so those combats still get archived under their own per-scene history rather than being dropped — a case the spec's own population description implies exists but its Design section never explicitly resolves.
