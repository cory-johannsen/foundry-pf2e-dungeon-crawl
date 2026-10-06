# Narrative Choice Button Sizing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix #829 — a narrative room's two choice buttons grow to fit their full label + consequence text instead of overflowing/overlapping at a fixed height.

**Root cause (confirmed live against the real client, not assumed):** `templates/dungeon-tracker.hbs`'s choice buttons (`.pf2edc-dungeon__narrative-options button`, confirmed current lines 211-219) already render the full text (`{{this.label}} — {{this.consequence}}`) — the markup is not truncating anything. `styles/dungeon.css` has no rule at all for this class (confirmed via grep), so the buttons fall back entirely to Foundry's own default button styling. Live-querying the real client's computed style for a button of this exact shape confirms the actual defaults: `height: 28px`, `min-height: 28px`, `display: flex`, `overflow: visible` (not `hidden`). Foundry's own fixed 28px button height doesn't grow for wrapped multi-line text, and because `overflow` is `visible` rather than `hidden`, the wrapped text isn't clipped so much as it spills outside the button's own 28px-tall visual box, overlapping whatever sits below it — exactly #829's own "text clipped/overflowing, can't be read" symptom.

**Architecture:** CSS-only fix, no markup or script changes. `.pf2edc-dungeon__narrative-options` gains a column flex layout (stacking the two choices, one per row, rather than Foundry's default side-by-side `inline-block` button flow for an unconstrained container); its own `button` children override Foundry's fixed `height`/`min-height` to `auto` and allow left-aligned, wrapped, multi-line text.

**Tech Stack:** CSS (`styles/dungeon.css`).

**Spec:** None — a small, fully-diagnosed CSS fix with a single correct resolution.

## Global Constraints

- Every merge to `main` bumps `module.json`'s `version` (CLAUDE.md). A small UI fix: patch bump. Re-check the current version immediately before committing, since concurrent sessions push to this repo.
- No change to `tools/agent-service/customization-generator.mjs` — the issue's own "where to look" section floats capping choice-text length as an alternative mitigation, but once a button genuinely grows to fit its content (this plan's fix), there is no length past which the text becomes unreadable; capping it would only ever remove real, generated flavor text for no remaining visual benefit.
- No change to `templates/dungeon-tracker.hbs` — the markup already renders the complete text; only the CSS governing how that markup is laid out needs to change.

## Review Focus

- **Both choice buttons must be fully readable for a long label + consequence string**, not just a short one — the whole point of the fix; a short-text regression test would miss the actual bug.
- **The fix must not depend on `overflow: hidden`/`text-overflow: ellipsis`** — those would hide the exact text #829 says must be readable; the fix is specifically to let the button grow, not to truncate more cleanly.
- **The two buttons should read as clearly separate choices once stacked**, not run together — a visible gap between them, not just a layout that happens not to overlap.
- **No other button elsewhere in the tracker should be affected** — the new rule must be scoped to `.pf2edc-dungeon__narrative-options button` specifically, not a bare `button` selector that would also change e.g. the marching-order controls' own already-fixed-size buttons (confirmed current, `styles/dungeon.css:15`).

---

### Task 1: Fix the button sizing

**Files:**
- Modify: `styles/dungeon.css`

No unit test: this is a pure CSS/visual fix with no logic to assert in Vitest — verified live (Step 2) per the issue's own "Verify live with long choice text" instruction.

- [ ] **Step 1: Add the CSS rule**

In `styles/dungeon.css`, add a new rule set (near the other `.pf2edc-dungeon__*` component rules, e.g. after the `.pf2edc-dungeon__marching-order-*` block):

```css
.pf2edc-dungeon__narrative-options { display: flex; flex-direction: column; gap: 0.4rem; }
.pf2edc-dungeon__narrative-options button {
  height: auto;
  min-height: 28px;
  white-space: normal;
  text-align: left;
  line-height: 1.3;
  padding: 0.4rem 0.6rem;
}
```

(`min-height: 28px` keeps parity with Foundry's own default single-line button height for a short choice that doesn't need to wrap at all; `height: auto` is what actually lets it grow for a longer one. `text-align: left` matches how this module's own other multi-line text blocks read, confirmed current — e.g. `.pf2edc-dungeon__narrative-reveal`/`.pf2edc-dungeon__narrative-npc` are plain `<p>` tags, left-aligned by default; a centered multi-line sentence inside a button reads noticeably worse than a left-aligned one.)

- [ ] **Step 2: Live-verify**

Reach a narrative room with the choice archetype (or use `tools/agent-service`'s own customization path to force a long label/consequence pair, matching #829's own repro) and confirm both buttons now show their complete text, each readable, with a visible gap between them, and no overlap with the room info text above or the footer below. Confirm an ordinary SHORT choice (a label/consequence pair that fits on one line) still looks correct — no unexpected extra height or awkward left-aligned single short word.

- [ ] **Step 3: Bump module.json's version**

Re-check the current version first (concurrent sessions push to this repo):

```bash
git fetch origin main -q && git log origin/main -1 --oneline && grep version module.json
```

Apply a **patch** bump (a UI fix), using whatever the fetch above shows as current.

- [ ] **Step 4: Commit**

```bash
git add styles/dungeon.css module.json
git commit -m "fix(#829): let narrative choice buttons grow to fit their text

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Self-Review

**1. Scope coverage:** #829's own "Expected" section ("both choices are fully readable — buttons grow to fit their text (wrap, auto height)") is met exactly: `height: auto` plus `white-space: normal` (already the default, confirmed live) is precisely "wrap, auto height." The issue's own alternative suggestion (capping generator text length) is explicitly addressed and declined with reasoning, not silently dropped.

**2. Placeholder scan:** No TBD/TODO. The CSS rule is the complete, real change.

**3. Type consistency:** N/A — CSS only, no function signatures.

**4. Review Focus:** All four items (long-text readability, no reliance on hiding/ellipsis, visibly separate stacked choices, scoped selector that doesn't touch unrelated buttons) are each addressed directly by the one rule added. No gaps found.

---

Plan complete and saved to `docs/superpowers/plans/2026-10-06-narrative-choice-button-sizing.md`.
