# Fix Macro Ownership Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A module-generated macro is always usable by the real GM, regardless of which connected client happened to create or sync it — today a macro created while the `foundry-rest` relay's own bot user is the active client ends up owned only by that bot account, invisible to everyone else.

**Architecture:** `ensureWorldMacros()` (`scripts/world-macros.mjs`) already has a working "detect a mismatch, update in place" mechanism for `name`/`command`/`img`. Extend the same mismatch check and the same create-time payload to also set and enforce a fixed `ownership.default`, so both new and already-existing generated macros self-heal to the correct ownership the next time this function runs (already called automatically on Foundry's own `"ready"` hook) — no separate migration script needed.

**Tech Stack:** Vanilla ES modules, Vitest.

**Spec:** None — bounded fix, no spec file. This plan implements GitHub issue #773 directly.

## Global Constraints

- Every merge to `main` bumps `module.json`'s `version` (CLAUDE.md). Bug fix: patch bump. Current version at plan-writing time is `0.60.8` — re-check immediately before committing, since concurrent sessions push to this repo.
- `scripts/world-macros.mjs` must never reference the Foundry global `CONST` at module-evaluation time — `MACRO_DEFS` and any new top-level constant are evaluated the instant `tests/world-macros.test.mjs` imports this file, before any test has a chance to stub Foundry globals (confirmed: `installFoundryStubs()` is called inside test bodies, never at module load). Use the literal numeric value (`3`, confirmed live via `CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER` on the real running world) directly, with a comment explaining why it's a literal and not a `CONST` reference.
- `name`/`command`/`img` mismatch-checking and update behavior is unchanged — this plan only adds one more field to the same existing check and the same existing update/create payloads.
- The fix must self-heal already-existing live macros (the two real ones confirmed this session, `k90U9AWIeHCos3Ib`/`qytN6XMol40PohtR`) automatically on the next `ensureWorldMacros()` run, via the same update-in-place mechanism — no separate one-off data-migration script.

## Review Focus

- **A macro that's already correct in every other way but has the wrong ownership must still get updated** (not silently skipped because `name`/`command`/`img` already match) — this is the exact bug being fixed. Covered by a new, dedicated test.
- **Correcting ownership must never touch `name`/`command`/`img`** on an otherwise-correct macro — the update payload should look identical to today's except for the added `ownership` field. Covered by the same new test's assertion on the full update payload shape.
- **An existing "up to date" test fixture must not spuriously start requiring an update** once ownership becomes a checked field — both pre-existing "up to date"/"force" tests need their fixtures updated to include the correct ownership, or they'd break (not because the fix is wrong, but because their fixtures would then represent a different, not-actually-up-to-date macro).
- **A freshly created macro must get the correct ownership from the start**, not rely on a second update cycle to fix it. Covered by extending the existing "creates every macro on a fresh world" test's assertions.
- **The multiple-generated-matches warning path** (when more than one generated macro matches a def) must still only ever update the first match, now also for ownership, not accidentally touch the others. Already covered by the existing test for that scenario, which needs no fixture changes (already simulates the buggy pre-fix ownership default, see Task 1 Step 1).

---

### Task 1: Extend `ensureWorldMacros` to set and enforce macro ownership

**Files:**
- Modify: `scripts/world-macros.mjs`
- Modify: `tests/world-macros.test.mjs`

**Interfaces:** None — no new exports, no signature changes to `ensureWorldMacros`/`MACRO_DEFS`.

- [x] **Step 1: Update the test helper's default to simulate today's real bug**

In `tests/world-macros.test.mjs`, change `makeMacro`'s signature from:

```js
function makeMacro({
  id,
  name,
  command,
  img,
  generated = false,
  extraFlags = {},
}) {
```

to:

```js
function makeMacro({
  id,
  name,
  command,
  img,
  generated = false,
  extraFlags = {},
  // #773: Foundry's own default for a document created with no explicit
  // ownership is "creator owns it, nobody else" -- {default: NONE (0)}.
  // Defaulting every test fixture to this exact shape means an existing
  // test that doesn't care about ownership still accurately represents
  // today's real bug, rather than accidentally pre-fixing itself.
  ownership = { default: 0 },
}) {
```

and its return object from:

```js
  return {
    id,
    name,
    command,
    img,
    flags,
    getFlag(scope, key) {
      return this.flags?.[scope]?.[key];
    },
  };
```

to:

```js
  return {
    id,
    name,
    command,
    img,
    flags,
    ownership,
    getFlag(scope, key) {
      return this.flags?.[scope]?.[key];
    },
  };
```

- [x] **Step 2: Fix the two "already up to date" fixtures, which would otherwise now spuriously need an update**

Change both the `"leaves a correctly-named, up-to-date generated macro alone"` test and the `"force:true updates every matching generated macro even when already in sync"` test's `upToDate` construction from:

```js
    const upToDate = MACRO_DEFS.map((def, i) =>
      makeMacro({
        id: `macro-${i}`,
        name: def.name,
        command: def.command,
        img: def.img,
        generated: true,
      }),
    );
```

to:

```js
    const upToDate = MACRO_DEFS.map((def, i) =>
      makeMacro({
        id: `macro-${i}`,
        name: def.name,
        command: def.command,
        img: def.img,
        generated: true,
        ownership: { default: 3 }, // #773: already correctly owned
      }),
    );
```

(This appears twice in the file — once per test. Apply the same change both times.)

- [x] **Step 3: Write the new failing tests**

Add this to the `describe("ensureWorldMacros", ...)` block, directly after the `"creates every macro on a fresh world with none of its own macros yet"` test:

```js
  it("creates every macro with ownership.default set so every connected user can run it (#773)", async () => {
    installFoundryStubs({ macros: [] });

    await ensureWorldMacros();

    const created = Macro.createDocuments.mock.calls[0][0];
    for (const c of created) {
      expect(c.ownership).toEqual({ default: 3 });
    }
  });
```

Add this to the same `describe` block, directly after the `"leaves a correctly-named, up-to-date generated macro alone"` test:

```js
  it("fixes an otherwise-correct generated macro's wrong ownership, without touching its name/command/img (#773)", async () => {
    const dungeonDef = MACRO_DEFS.find((d) =>
      d.command.includes(".openDungeon()"),
    );
    const encounterDef = MACRO_DEFS.find((d) =>
      d.command.includes(".generateEncounter()"),
    );
    // Both macros are otherwise perfectly correct (right name, right
    // command, right img) -- only ownership is wrong (makeMacro's own
    // default, simulating today's real bug: created while the
    // foundry-rest relay's own bot user was the active client).
    const dungeonMacro = makeMacro({
      id: "dungeon-1",
      name: dungeonDef.name,
      command: dungeonDef.command,
      img: dungeonDef.img,
      generated: true,
    });
    const encounterMacro = makeMacro({
      id: "encounter-1",
      name: encounterDef.name,
      command: encounterDef.command,
      img: encounterDef.img,
      generated: true,
    });
    installFoundryStubs({ macros: [dungeonMacro, encounterMacro] });

    const result = await ensureWorldMacros();

    expect(Macro.createDocuments).not.toHaveBeenCalled();
    expect(Macro.updateDocuments).toHaveBeenCalledTimes(1);
    const updated = Macro.updateDocuments.mock.calls[0][0];
    expect(updated).toHaveLength(2);
    for (const u of updated) {
      expect(u.ownership).toEqual({ default: 3 });
      // The name must be exactly what it already was -- this fix never
      // touches name/command/img on a macro whose only problem is
      // ownership.
    }
    expect(updated.find((u) => u._id === "dungeon-1").name).toBe(
      dungeonDef.name,
    );
    expect(updated.find((u) => u._id === "encounter-1").name).toBe(
      encounterDef.name,
    );
    expect(result).toEqual({ created: 0, updated: 1 });
  });
```

- [x] **Step 4: Run tests to verify they fail**

Run: `npx vitest run tests/world-macros.test.mjs -t "773"`
Expected: FAIL — the create-time test fails because `created[0].ownership` is `undefined`, not `{default: 3}`; the update-time test fails because `Macro.updateDocuments` is never called at all (today's code sees `name`/`command`/`img` all already matching and skips both macros entirely).

Also run the full file to confirm the two fixture-updated tests still pass on their own (they don't depend on the production fix, only on the test file's own changes):

Run: `npx vitest run tests/world-macros.test.mjs -t "up-to-date"`
Expected: PASS (these two were already correct fixtures before the production change; Step 2 just keeps them correct after it).

- [x] **Step 5: Make the production change**

In `scripts/world-macros.mjs`, add this constant directly after `const MODULE_ID = "pf2e-dungeon-crawl";`:

```js
// #773: a document created with no explicit `ownership` defaults to
// "creator owns it, nobody else" -- if ensureWorldMacros() happens to run
// on a client connected as the foundry-rest relay's own bot user (rather
// than the real GM's own browser), the resulting macro is invisible to
// everyone else. A literal number here, not CONST.DOCUMENT_OWNERSHIP_LEVELS
// (confirmed live this value is 3/OWNER) -- this file is imported by
// tests/world-macros.test.mjs before any Foundry global exists, so a
// CONST reference at module-evaluation time would throw.
const GENERATED_MACRO_OWNERSHIP = { default: 3 };
```

Change the `toUpdate.push`/mismatch-check block from:

```js
    const existing = matches[0];
    if (existing) {
      if (
        force ||
        existing.name !== def.name ||
        existing.command !== def.command ||
        existing.img !== def.img
      ) {
        toUpdate.push({
          _id: existing.id,
          name: def.name,
          command: def.command,
          img: def.img,
        });
      }
    } else {
      toCreate.push({
        name: def.name,
        type: "script",
        img: def.img,
        command: def.command,
        scope: "global",
        flags: { [MODULE_ID]: { generated: true } },
      });
    }
```

to:

```js
    const existing = matches[0];
    if (existing) {
      if (
        force ||
        existing.name !== def.name ||
        existing.command !== def.command ||
        existing.img !== def.img ||
        existing.ownership?.default !== GENERATED_MACRO_OWNERSHIP.default
      ) {
        toUpdate.push({
          _id: existing.id,
          name: def.name,
          command: def.command,
          img: def.img,
          ownership: GENERATED_MACRO_OWNERSHIP,
        });
      }
    } else {
      toCreate.push({
        name: def.name,
        type: "script",
        img: def.img,
        command: def.command,
        scope: "global",
        ownership: GENERATED_MACRO_OWNERSHIP,
        flags: { [MODULE_ID]: { generated: true } },
      });
    }
```

- [x] **Step 6: Run tests to verify they pass**

Run: `npx vitest run tests/world-macros.test.mjs -t "773"`
Expected: PASS, both new tests green.

- [x] **Step 7: Run the full test file to confirm no regression**

Run: `npx vitest run tests/world-macros.test.mjs`
Expected: PASS, every test in the file green — including every pre-existing rename/duplicate/force/multiple-matches test, whose own assertions only check a subset of each update payload's fields via `expect.objectContaining` (confirmed by reading the file: none of them assert the payload's *exact* full shape), so adding `ownership` to the real payload doesn't break them.

- [x] **Step 8: Commit**

```bash
git add scripts/world-macros.mjs tests/world-macros.test.mjs
git commit -m "fix(#773): set and self-heal generated macro ownership

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 2: Live-verify the self-heal and version bump

**Files:**
- Modify: `module.json`

**Interfaces:** None.

- [ ] **Step 1: Confirm current live ownership before the fix deploys**

```bash
echo 'return game.macros.contents.filter(m => m.getFlag("pf2e-dungeon-crawl", "generated") === true).map(m => ({id: m.id, name: m.name, ownership: m.ownership}));' | .claude/skills/foundry-rest/foundry-exec.sh
```

Expected (matching this session's own earlier findings): `k90U9AWIeHCos3Ib` shows `{default: 0, ...}`; re-confirm `qytN6XMol40PohtR`'s own current ownership too (not yet checked this session — it may already be fine, or share the same bug; either way this fix handles it uniformly).

- [ ] **Step 2: Trigger a re-sync and confirm the self-heal**

`ensureWorldMacros()` runs automatically on Foundry's own `"ready"` hook (confirmed current, `scripts/module.mjs`). Once this fix is deployed, reload the world (or wait for its next natural reload), then re-run the same query from Step 1.

Expected: both macros now show `ownership.default: 3`, with their `name`/`command`/`img` unchanged from before, and no new/duplicate macro created (confirm total count of generated macros is still exactly 2).

- [ ] **Step 3: Bump module.json's version**

Re-check the current version first (concurrent sessions push to this repo):

```bash
git fetch origin main -q && git log origin/main -1 --oneline && grep version module.json
```

Apply a patch bump (e.g. `0.60.8` → `0.60.9`, using whatever the fetch above shows as current).

- [ ] **Step 4: Commit**

```bash
git add module.json
git commit -m "chore: bump version for #773 macro ownership fix

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Self-Review

**1. Scope coverage:** #773's own two concrete asks — set an explicit ownership level on creation, and decide whether/how to self-heal existing macros — are both covered: the former by Task 1's `toCreate` change, the latter by extending the SAME mismatch-check so the already-existing update mechanism handles it automatically (confirmed in Task 2 live). No separate migration script needed, and the plan explains why.

**2. Placeholder scan:** No TBD/TODO, no "add appropriate handling." Every step has real, runnable code or an exact command.

**3. Type consistency:** `GENERATED_MACRO_OWNERSHIP = { default: 3 }` is defined once and referenced identically in both the `toCreate` and `toUpdate` payloads, and in the mismatch check. The literal `3` matches the real, live-confirmed value of `CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER` on the actual running world (confirmed this session, not assumed).

**4. Review Focus:** All five items (ownership-only mismatch still triggers an update, name/command/img untouched by that update, pre-existing "up to date" fixtures updated so they don't spuriously break, fresh creation gets correct ownership immediately, the multiple-matches warning path unaffected) each have a dedicated test or explicit reasoning for why no fixture change was needed. No gaps found.

---

Plan complete and saved to `docs/superpowers/plans/2026-10-05-fix-macro-ownership.md`. Please review the plan. Which execution approach would you prefer?

- **Subagent-driven** - A fresh subagent implements each task and a fresh reviewer checks it before the next one starts, then a whole-branch review at the end. Most thorough; costs a fresh context per task and per review.
- **Native** - I implement every task myself in this session, the way this harness runs work, then one fresh reviewer on the most capable model checks the whole branch. Cheapest and fastest; no independent review until the end. Runs well with a mid-tier session model, since the plan carries the design.

For this plan I recommend **Native**, because this is a small, self-contained extension of an already-proven mechanism with full unit-test coverage — there's no design surface for independent subagents to diverge on, and the live verification in Task 2 is the only genuinely novel risk, best done once carefully rather than twice. Does the plan capture what you want, and which approach should we use?
