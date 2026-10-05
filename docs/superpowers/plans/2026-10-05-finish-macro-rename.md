# Finish Macro Rename Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Drop the remaining "PF2EDC:" prefix from this module's own "Generate Encounter" macro, closing out #96's own deliberate deferral.

**Architecture:** A one-line `MACRO_DEFS` rename, relying entirely on the already-correct, already-tested rename-in-place mechanism in `scripts/world-macros.mjs`.

**Tech Stack:** Vanilla ES modules, Vitest, the `foundry-rest` skill for live verification.

**Spec:** None — bounded, trivial fix. This plan implements GitHub issue #770 directly, scoped down after investigation (see the issue's own comment thread: the reported "DOMMT: Dungeon Crawl" macro belongs to a different, separately-installed module and is not a bug in this module's own rename logic).

## Global Constraints

- Every merge to `main` bumps `module.json`'s `version` (CLAUDE.md). Trivial display-name fix: patch bump. Current version at plan-writing time is `0.60.7` — re-check immediately before committing, since concurrent sessions push to this repo.
- No change to `findGeneratedMatches`/`ensureWorldMacros`'s own matching logic — confirmed live and by the existing test suite that it already works correctly; this plan only changes a display-name string.
- This module's own macros are identified solely by `flags["pf2e-dungeon-crawl"].generated === true` plus a matching `command` — never by name. A macro belonging to another module (even one that happens to call into this module's API) is never touched.

## Review Focus

- **The rename must happen in place, not create a duplicate** — already proven by this file's own existing "PF2EDC: Dungeon Crawl" stale-rename test; this plan's new test confirms the identical mechanism for the *other* macro def too, since no existing test exercises a stale `"PF2EDC: Generate Encounter"` specifically.
- Every other Review Focus candidate (legacy/unflagged macro matching, cross-module macro collisions) was investigated this session and found not applicable — there is no second bug here, confirmed live against the real world's macro directory.

---

### Task 1: Rename the macro def, with full test coverage

**Files:**
- Modify: `scripts/world-macros.mjs` (the `MACRO_DEFS` entry's `name` field)
- Modify: `tests/world-macros.test.mjs` (update one existing assertion, add one new test)

**Interfaces:** None — no new exports, no signature changes.

- [ ] **Step 1: Write the failing test**

In `tests/world-macros.test.mjs`, change the existing test:

```js
  it("leaves the generate-encounter macro's name untouched (out of #96's scope)", () => {
    const encounterDef = MACRO_DEFS.find((d) =>
      d.command.includes(".generateEncounter()"),
    );
    expect(encounterDef.name).toBe("PF2EDC: Generate Encounter");
  });
```

to:

```js
  it("names the generate-encounter macro plainly, with no PF2EDC prefix (#770)", () => {
    const encounterDef = MACRO_DEFS.find((d) =>
      d.command.includes(".generateEncounter()"),
    );
    expect(encounterDef.name).toBe("Generate Encounter");
  });
```

Add this new test to the `describe("ensureWorldMacros", ...)` block, directly after the existing `'renames an existing generated macro still called "PF2EDC: Dungeon Crawl" in place'` test:

```js
  it('renames an existing generated macro still called "PF2EDC: Generate Encounter" in place, without creating a duplicate (#770)', async () => {
    const encounterDef = MACRO_DEFS.find((d) =>
      d.command.includes(".generateEncounter()"),
    );
    const stale = makeMacro({
      id: "stale-encounter",
      name: "PF2EDC: Generate Encounter",
      command: encounterDef.command,
      img: encounterDef.img,
      generated: true,
    });
    const dungeonDef = MACRO_DEFS.find((d) =>
      d.command.includes(".openDungeon()"),
    );
    const dungeonMacro = makeMacro({
      id: "dungeon-1",
      name: dungeonDef.name,
      command: dungeonDef.command,
      img: dungeonDef.img,
      generated: true,
    });
    installFoundryStubs({ macros: [stale, dungeonMacro] });

    const result = await ensureWorldMacros();

    expect(Macro.createDocuments).not.toHaveBeenCalled();
    expect(Macro.updateDocuments).toHaveBeenCalledTimes(1);
    const updated = Macro.updateDocuments.mock.calls[0][0];
    expect(updated).toEqual([
      expect.objectContaining({ _id: "stale-encounter", name: "Generate Encounter" }),
    ]);
    expect(result).toEqual({ created: 0, updated: 1 });
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/world-macros.test.mjs -t "770"`
Expected: FAIL — the renamed assertion expects `"Generate Encounter"` but `MACRO_DEFS` still has `"PF2EDC: Generate Encounter"`; the new rename-in-place test fails the same way.

- [ ] **Step 3: Make the rename**

In `scripts/world-macros.mjs`, change:

```js
export const MACRO_DEFS = [
  {
    name: "PF2EDC: Generate Encounter",
```

to:

```js
export const MACRO_DEFS = [
  {
    name: "Generate Encounter",
```

Also update the file's own top comment, which currently reads:

```js
// #96: dropped the "DOMMT:"/"PF2EDC:" prefix from the dungeon-crawl macro's
// display name. Scoped to just this one macro — "PF2EDC: Generate Encounter"
// keeps its prefix for now.
```

to:

```js
// #96/#770: dropped the "DOMMT:"/"PF2EDC:" prefix from both macros' display
// names. (#770 also investigated a reported "DOMMT: Dungeon Crawl" macro
// surviving in a live world — it belongs to a different, separately
// installed module (deck-of-many-more-things), flagged under its own
// namespace, not a bug in this module's own rename-in-place logic below.)
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/world-macros.test.mjs -t "770"`
Expected: PASS, both tests green.

- [ ] **Step 5: Run the full test file to confirm no regression**

Run: `npx vitest run tests/world-macros.test.mjs`
Expected: PASS, every existing test (including every stale-rename/duplicate/force scenario) still green.

- [ ] **Step 6: Commit**

```bash
git add scripts/world-macros.mjs tests/world-macros.test.mjs
git commit -m "fix(#770): rename the remaining PF2EDC-prefixed macro

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 2: Live-verify and version bump

**Files:**
- Modify: `module.json`

**Interfaces:** None.

- [ ] **Step 1: Trigger a re-sync in the live world**

`ensureWorldMacros()` already runs automatically on Foundry's own `"ready"` hook (confirmed current, `scripts/module.mjs:317`) — once this module's updated code is deployed/reloaded into the running world, the next world load re-runs it with no manual trigger needed. If the world is already open and won't naturally reload soon, ask the GM to reload it (F5 in the browser), or confirm via whatever this project's own deploy-and-reload convention already is.

- [ ] **Step 2: Confirm the live rename**

```bash
echo 'return game.macros.contents.filter(m => m.getFlag("pf2e-dungeon-crawl", "generated") === true).map(m => ({id: m.id, name: m.name}));' | .claude/skills/foundry-rest/foundry-exec.sh
```

Expected: exactly two macros, `"Dungeon Crawl"` and `"Generate Encounter"` — the same two ids as before (`qytN6XMol40PohtR` and `k90U9AWIeHCos3Ib`, confirmed this session), just the second one's `name` changed, no new macro created. Also confirm the unrelated `deck-of-many-more-things`-owned `"DOMMT: Dungeon Crawl"` macro (id `SMvjmSXTWqbF9nBk`, confirmed this session) is untouched:

```bash
echo 'const m = game.macros.get("SMvjmSXTWqbF9nBk"); return m ? {name: m.name, flags: m.flags} : "not found";' | .claude/skills/foundry-rest/foundry-exec.sh
```

Expected: unchanged — still named `"DOMMT: Dungeon Crawl"`, still flagged only under `deck-of-many-more-things`.

- [ ] **Step 3: Bump module.json's version**

Re-check the current version first (concurrent sessions push to this repo):

```bash
git fetch origin main -q && git log origin/main -1 --oneline && grep version module.json
```

Apply a patch bump (e.g. `0.60.7` → `0.60.8`, using whatever the fetch above shows as current).

- [ ] **Step 4: Commit**

```bash
git add module.json
git commit -m "chore: bump version for #770 macro rename

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Self-Review

**1. Scope coverage:** The issue's one remaining valid ask (rename `"PF2EDC: Generate Encounter"`) is fully covered by Task 1; the issue's other two asks (extend rename-in-place matching, add legacy-case tests) were investigated and found not applicable — recorded on the issue itself, not silently dropped.

**2. Placeholder scan:** No TBD/TODO, no "add appropriate handling." Every step has real code or an exact command.

**3. Type consistency:** No new functions/types introduced — a single string literal changes in one place (`MACRO_DEFS`), referenced identically in both the updated and new test.

**4. Review Focus:** The one real risk (rename-in-place vs. duplicate-creation) has a dedicated new test mirroring the file's own already-proven pattern. The other candidate risks (legacy matching, cross-module collision) were investigated and confirmed not applicable this session — recorded as such rather than left as an unexamined gap.

---

Plan complete and saved to `docs/superpowers/plans/2026-10-05-finish-macro-rename.md`. Please review the plan. Which execution approach would you prefer?

- **Subagent-driven** - A fresh subagent implements each task and a fresh reviewer checks it before the next one starts, then a whole-branch review at the end. Most thorough; costs a fresh context per task and per review.
- **Native** - I implement every task myself in this session, the way this harness runs work, then one fresh reviewer on the most capable model checks the whole branch. Cheapest and fastest; no independent review until the end. Runs well with a mid-tier session model, since the plan carries the design.

For this plan I recommend **Native**, because this is a one-line string change with an existing, already-proven test mechanism — there's no design surface for independent subagents to diverge on. Does the plan capture what you want, and which approach should we use?
