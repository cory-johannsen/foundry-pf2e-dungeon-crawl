# AI Turn Card "Unknown Action" Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop the PF2E Automated Action Tracker logging the module's AI turn chat card as an "Unknown Action" (#1252).

**Architecture:** The tracker's `GenericActionDetector` matches chat content containing the literal `class="action-glyph"`. The card's `costGlyph` emits exactly that. Rename the class on the card to a module-owned `pf2edc-action-glyph`, copy the system's glyph CSS onto it, and add guard tests so the system class never returns to module-posted chat HTML.

**Tech Stack:** Foundry VTT v13 module, ES modules, Vitest, plain CSS.

**Spec:** `docs/superpowers/specs/2026-10-10-turn-card-tracker-unknown-action-design.md`

## Global Constraints

- Every merge to `main` bumps `module.json` `version` (currently `0.94.23`; patch bump, re-read `origin/main` at merge time, never reuse a number).
- The glyph digit is unchanged (the Pathfinder actions font maps `1`/`2`/`3` to icons).
- The digest (`scripts/ai-action-digest.mjs`), log window template (`templates/ai-action-log.hbs`) and the compendium parsers in `scripts/agent-candidates.mjs` keep the system `action-glyph` class.
- Out of scope (owner: skipped, no tickets): cleanup of already-logged entries, tracker self-check warning, upstream ignore-flag request.
- Worktree off `origin/main`; `npm ci`, never symlink `node_modules`.
- No `update-architecture-docs` run needed: no file imports change.

## Review Focus

- Card rows with missing/invalid/out-of-range cost (0, 4, `null`, `"2"`) render no glyph span at all (nothing to match).
- GM-only rows (`visibility: "gm"`), fallback rows, notes and rationale/details content never contain `class="action-glyph"` (details/notes may embed free text; the guard asserts on the whole card).
- A future chat poster re-introducing the literal in `scripts/` fails the static scan with a message naming the file.
- Digest rows (DOM-only) must not be posted to chat: no chat-posting site may import `renderDigestRowHtml`.
- Cards already posted in in-progress combats keep the old class (accepted; no rewrite).

---

### Task 1: Rename the card's glyph class and style it

**Files:**
- Modify: `scripts/agent-action-display.mjs:307-310`
- Modify: `styles/dungeon.css` (after the `.pf2edc-agent-turn .pf2edc-agent-action` rules, ~line 55-62)
- Modify: `tests/agent-action-display.test.mjs:242`

**Interfaces:**
- Produces: `costGlyph(cost)` (module-private) returns `<span class="pf2edc-action-glyph">${cost}</span> ` for integer 1..3, else `""`. `renderAgentTurnCardHtml` signature unchanged.

- [x] **Step 1: Update the existing assertion to the new class (failing test)**

In `tests/agent-action-display.test.mjs` line 242 replace
`expect(html).toContain('<span class="action-glyph">1</span>');` with
```js
    expect(html).toContain('<span class="pf2edc-action-glyph">1</span>');
    expect(html).not.toContain('class="action-glyph"');
```

- [x] **Step 2: Run to verify it fails** — `npx vitest run tests/agent-action-display.test.mjs` → FAIL on the new assertion.

- [x] **Step 3: Implement**

`scripts/agent-action-display.mjs`:
```js
// #1252: NOT the system's "action-glyph" class — the PF2E Automated Action
// Tracker logs any chat message containing class="action-glyph" as an
// "Unknown Action", so this card uses a module-owned class (styled to match
// in styles/dungeon.css).
function costGlyph(cost) {
  if (!Number.isInteger(cost) || cost < 1 || cost > 3) return "";
  return `<span class="pf2edc-action-glyph">${cost}</span> `;
}
```
`styles/dungeon.css`, directly after the `.pf2edc-agent-turn` action rules:
```css
/* #1252: module-owned copy of the system's .action-glyph rule (the system
   class on a chat card makes the Action Tracker log it as an action). */
.pf2edc-action-glyph {
  align-self: center;
  display: inline;
  font-family: "Pathfinder2eActions", sans-serif;
  font-weight: normal;
  letter-spacing: 0;
  margin: 0;
  padding: 0;
}
```

- [x] **Step 4: Run to verify it passes** — `npx vitest run tests/agent-action-display.test.mjs` → PASS.
- [x] **Step 5: Commit** — `git add scripts/agent-action-display.mjs styles/dungeon.css tests/agent-action-display.test.mjs && git commit -m "#1252: module-owned glyph class on the AI turn card"`

---

### Task 2: Regression guard tests

**Files:**
- Create: `tests/chat-action-glyph.test.mjs`

**Interfaces:**
- Consumes: `renderAgentTurnCardHtml({ round, records, combatantId })` from `scripts/agent-action-display.mjs`. Record shape: copy the `record(...)` helper at the top of `tests/agent-action-display.test.mjs` (read it first; reuse the same fields: `index, summary, cost, result:{text,tone}, visibility, rationale, gmNote, targetName, fallback`).

- [ ] **Step 1: Write the tests**

```js
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { renderAgentTurnCardHtml } from "../scripts/agent-action-display.mjs";

// Mirrors pf2e-auto-action-tracker v0.19.1 GenericActionDetector.isType's content test.
const trackerWouldLog = (html) => html.includes('class="action-glyph"');
const hasSystemGlyphClass = (html) => /class="[^"]*\baction-glyph\b[^"]*"/.test(html);

const base = { summary: "Strike", result: { text: "hit", tone: "success" } };
const records = [
  { ...base, index: 0, cost: 1 },
  { ...base, index: 1, cost: 2, targetName: "Goblin" },
  { ...base, index: 2, cost: 3, visibility: "gm", rationale: "closest", gmNote: "DC 20" },
  { ...base, index: 3, cost: 0 },
  { ...base, index: 4, cost: 4 },
  { ...base, index: 5, cost: null, fallback: true },
  { ...base, index: 6, cost: "2" },
];

describe("#1252 AI turn card vs the action tracker", () => {
  const html = renderAgentTurnCardHtml({ round: 1, records, combatantId: "c1" });

  it("the card never matches the tracker's action-glyph detector", () => {
    expect(trackerWouldLog(html)).toBe(false);
    expect(hasSystemGlyphClass(html)).toBe(false);
  });

  it("valid costs 1..3 use the module glyph class, invalid costs render no glyph", () => {
    expect(html.match(/pf2edc-action-glyph/g)).toHaveLength(3);
    expect(html).toContain('<span class="pf2edc-action-glyph">1</span>');
    expect(html).toContain('<span class="pf2edc-action-glyph">3</span>');
  });

  it("detector predicate does fire on the system class (guard is meaningful)", () => {
    expect(trackerWouldLog('<span class="action-glyph">1</span>')).toBe(true);
  });
});

describe("#1252 no system glyph class in module scripts that can reach chat", () => {
  // Files that legitimately contain the literal, each with the reason.
  const ALLOW = {
    "ai-action-digest.mjs": "DOM-only digest rows (Combat Tracker row / tooltip), never chat",
    "agent-candidates.mjs": "regexes parsing compendium description HTML",
  };
  const dir = new URL("../scripts/", import.meta.url).pathname;
  const walk = (d) =>
    readdirSync(d, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? walk(join(d, e.name)) : e.name.endsWith(".mjs") ? [join(d, e.name)] : [],
    );

  it("no non-allowlisted script contains the literal class=\"action-glyph\"", () => {
    const offenders = walk(dir)
      .filter((f) => readFileSync(f, "utf8").includes('class="action-glyph"'))
      .map((f) => f.slice(dir.length))
      .filter((rel) => !Object.keys(ALLOW).some((k) => rel === k || rel.endsWith(`/${k}`)));
    expect(offenders, `use a module-owned class in chat content (#1252); allowlist needs a reason`).toEqual([]);
  });

  it("no chat-posting script imports renderDigestRowHtml (DOM-only)", () => {
    const importers = walk(dir)
      .filter((f) => /import[^;]*renderDigestRowHtml/.test(readFileSync(f, "utf8")))
      .map((f) => f.slice(dir.length));
    expect(importers).toEqual(["ui/ai-action-detail.mjs"]);
  });
});
```
(If the `record` helper in `agent-action-display.test.mjs` shows `cost`/`result` live under different keys, adapt the three field names in `base`/`records` to match; the assertions stay the same.)

- [ ] **Step 2: Run** — `npx vitest run tests/chat-action-glyph.test.mjs` → PASS (Task 1 already done). Then temporarily revert Task 1's one-line class change (`git stash` is forbidden here — use `git diff` + manual edit, or `sed` on a scratch copy) to see the builder test FAIL, then restore. Skip if tedious; the third test in the first describe already proves the predicate is live.
- [ ] **Step 3: Full suite** — `npm test` → PASS.
- [ ] **Step 4: Commit** — `git add tests/chat-action-glyph.test.mjs && git commit -m "#1252: guard tests keep action-glyph out of chat HTML"`

---

### Task 3: Version bump and live verification

**Files:**
- Modify: `module.json` (patch bump from the current `origin/main` value)

- [ ] **Step 1:** Bump `module.json` `version`; `npm test` → PASS; commit `#1252: bump version`.
- [ ] **Step 2: Live verification** (copy `.env` into the worktree; check the live world's module version against the branch first). Start a combat with AI-controlled combatants and Auto Action Tracker active; after an AI turn read `combatant.flags["pf2e-auto-action-tracker"].log`:
  - no `unknown-action` entry; `actionsSpent` equals the real actions taken (a 3-action turn shows 3);
  - the turn card's cost glyphs still render as action icons (font loaded);
  - a human-controlled combatant is unchanged.
- [ ] **Step 3:** Open the PR (needs a playtest: after merge label `verification`, remove `claimed`/`in progress`, merge with explicit `--subject/--body`).

## Self-Review

Spec coverage: markup rename + CSS (Task 1); builder test, static scan (implemented as an allowlist scan over every `scripts/**/*.mjs`, a superset of the spec's "files with chat-posting calls" and simpler), digest isolation, mocked-tracker predicate test (Task 2); existing-test update (Task 1); live verification (Task 3). Out-of-scope items untouched. Types: `costGlyph`/`renderAgentTurnCardHtml` names consistent across tasks.
