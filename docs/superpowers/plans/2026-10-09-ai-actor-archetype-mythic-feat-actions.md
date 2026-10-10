# Archetype and Mythic Targeted Feat Actions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a ranked audit of archetype and mythic targeted feats, and widen #947's `parseTargetedFeat` to also accept an owner-approved allowlist of slugs that genuinely parse through its existing shapes — nothing new is parsed, no overrides, no mythic-point-spending feats.

**Architecture:** This plan patches #947's still plan-only `parseTargetedFeat` with one additional allowlist check, and adds a small audit tool. Spot-checking six of the spec's own named "obvious candidates" against the real compendium found that most do not actually survive #947's own narrow "shapes only" rule the way the spec's casual framing suggests — several need a bespoke override (out of scope here, filed as #1118) or spend Mythic Points (explicitly excluded), and one isn't even a single-target action. The audit tool is built to measure the real eligible population rather than assume the spec's own named examples qualify.

**Tech Stack:** Vanilla JS (ESM), Foundry VTT API, Vitest.

**Spec:** `docs/superpowers/specs/2026-10-09-ai-actor-archetype-mythic-feat-actions-design.md`

## Global Constraints

- Reviewed allowlist, shapes only — no new overrides in this spec (filed as #1118); mythic-point-spending feats are out (filed as #1117) (spec's own resolved decisions).
- An archetype feat already on a character sheet needs no further prerequisite check — that's the sheet's job (spec's own resolved decision 4).
- #947 is still plan-only; Task 2 patches it directly.
- Every merge bumps `module.json`'s version (CLAUDE.md).

## Investigation findings

1. **Spot-checking six of the spec's own named "obvious candidates" against the real compendium found most do not actually qualify under this issue's own narrow rule — a finding the audit tool must surface for real, not assume away.** Scout's Charge ("Stride, Feint... and then make a Strike") is a three-sub-action compound activity none of #947's four shapes (`strikePlus`, `rollVsTargetDefense`, `targetEffect`, and the fourth per that plan's own finding) can parse — it needs a bespoke override, filed to #1118, not this issue's allowlist. Lassoing Lash (a Grapple check with degree-scaled forced movement and a critical-failure Prone rider) and Boaster's Challenge (a three-skill choice with proficiency-scaled bonuses and a separate witness-side DC penalty) are both similarly bespoke. Command Attention is an aura/fortune-effect buff, not a single-target action at all. Fated Duel and Imprison Foe both explicitly "Spend a/1 Mythic Point," correctly excluded by the spec's own mythic-point gate. None of these six should end up in `ARCHETYPE_MYTHIC_ALLOWLIST`, and Task 1's audit must classify all six as `partial`/`unsupported` (or mythic-excluded) for real, not `parses` — a test asserting this for these six specific, named slugs is the concrete regression guard against the audit tool silently rubber-stamping the spec's own casual list.
2. **The real mythic-point phrasing varies between feats, confirmed on two real items** — Fated Duel: "Spend a Mythic Point"; Imprison Foe: "Spend 1 Mythic Point" — the exclusion check (Design §Gates) must match both the bare and numbered forms, not just one literal phrase.
3. **`parseTargetedFeat`'s real class-trait gate (`scripts/feat-action-shapes.mjs`, #947's plan) is a single, well-isolated line** (`if (!traits.some((t) => FEAT_ACTION_CLASS_SET.has(t))) return null;`), confirmed to run AFTER the override-table check and BEFORE the shape-recognition body — the allowlist check slots in as a second, equivalent OR-condition at the exact same point, not a structural change to the function.

## Review Focus

- The audit's `parses` classification must mean "parses through #947's existing shapes as written today," never "would parse if a shape were extended" — extending a shape to fit one more archetype feat is new parsing work this spec explicitly excludes (spec's own stated rule; Task 1's test).
- The mythic-point exclusion must fire on the feat's own body text, not merely its `mythic` trait — a mythic feat that happens not to spend points (the spec's own stated possibility: "mythic feats that do not spend points may be allowlisted") must still be eligible (spec's own stated rule; Task 2's test).
- An allowlist slug must be checked against the audit fixture's own `parses` classification by a dedicated completeness test, not just trusted — if a later compendium change turns an allowlisted feat's text into something that would now fail the parse, that test must fail loudly rather than silently keep offering a feat whose real mechanics changed (spec's own stated rule; Task 2's test).
- Vocabulary gating for an allowlisted feat must still run every one of #947's other existing checks (cost, frequency, requirement predicates, flourish/finisher) unchanged — the allowlist only widens WHICH feats are considered, never which gates apply to them (spec's own "all other gates... apply unchanged" rule; Task 3's test).
- If the audit finds zero slugs that genuinely qualify, that is a legitimate, honest outcome of this plan, not a sign the plan is incomplete — Task 3's coverage test must pass with an empty allowlist just as validly as with a populated one.

---

### Task 1: The audit tool

**Files:**
- Create: `tools/audit-archetype-feats.mjs`
- Create: `tests/fixtures/archetype-mythic-feat-audit.json`
- Test: `tests/archetype-mythic-audit.test.mjs`

- [ ] **Step 1: Write the failing tests**

```js
describe("audit-archetype-feats (#998)", () => {
  it("classifies Scout's Charge, Lassoing Lash, Boaster's Challenge, Command Attention as partial/unsupported, never parses (Investigation finding 1, Review Focus)", () => {
    const rows = runAudit(fixtureCompendium());
    for (const slug of ["scouts-charge", "lassoing-lash", "boasters-challenge", "command-attention"]) {
      expect(rows.find((r) => r.slug === slug)?.outcome).not.toBe("parses");
    }
  });

  it("excludes Fated Duel and Imprison Foe as mythic-point-spending regardless of shape-parseability (Investigation finding 2)", () => {
    const rows = runAudit(fixtureCompendium());
    for (const slug of ["fated-duel", "imprison-foe"]) {
      expect(rows.find((r) => r.slug === slug)?.outcome).toBe("mythicPointExcluded");
    }
  });

  it("matches both the bare and numbered Mythic Point phrasing (Investigation finding 2, Review Focus)", () => {
    expect(spendsMythicPoints("Spend a Mythic Point, and choose one opponent...")).toBe(true);
    expect(spendsMythicPoints("Spend 1 Mythic Point to force a creature...")).toBe(true);
    expect(spendsMythicPoints("You call out a foe, causing them to become flustered...")).toBe(false);
  });

  it("ranks rows deterministically by likely AI value (cost, range, effect)", () => { /* ... */ });

  it("emits a row for every one of the roughly 68 archetype/mythic targeted feats the real compendium contains, confirming the spec's own count for real rather than re-citing it unchecked", () => { /* ... */ });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/archetype-mythic-audit.test.mjs`
Expected: FAIL (tool does not exist)

- [ ] **Step 3: Implement**, running #947's own real `parseTargetedFeat` (shapes only, no allowlist check yet) against every archetype/mythic-trait item in the compendium with no `selfEffect`, classifying each row `parses`/`partial`/`unsupported`/`mythicPointExcluded` (checked before shape-parsing, since a point-spending feat is excluded regardless of whether its text would otherwise parse), and writing the ranked report to the fixture.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/archetype-mythic-audit.test.mjs`
Expected: PASS

- [ ] **Step 5: Propose the allowlist** from the fixture's own `parses` rows (per this task's own run, likely a short list given Investigation finding 1 — report the real count plainly rather than assuming the spec's ~20) as a comment attached to the issue for the owner's approval, separate from writing `ARCHETYPE_MYTHIC_ALLOWLIST` itself (Task 2).
- [ ] **Step 6: Commit**

```bash
git add tools/audit-archetype-feats.mjs tests/fixtures/archetype-mythic-feat-audit.json tests/archetype-mythic-audit.test.mjs
git commit -m "feat(#998): archetype/mythic feat-action audit, classifying the real population for the owner's allowlist review"
```

---

### Task 2: The allowlist and the widened gate

**Files:**
- Create: `scripts/feat-action-allowlist.mjs`
- Modify: `docs/superpowers/plans/2026-10-09-ai-actor-targeted-feat-actions-no-selfeffect.md` (`parseTargetedFeat`'s class-trait gate)
- Test: `tests/feat-action-allowlist.test.mjs`, that plan's own parser test file

- [ ] **Step 1: Write the failing tests**

```js
describe("ARCHETYPE_MYTHIC_ALLOWLIST (#998)", () => {
  it("every allowlisted slug is classified parses in the audit fixture (Review Focus)", () => {
    const audit = JSON.parse(fs.readFileSync("tests/fixtures/archetype-mythic-feat-audit.json"));
    for (const slug of ARCHETYPE_MYTHIC_ALLOWLIST) {
      expect(audit.find((r) => r.slug === slug)?.outcome).toBe("parses");
    }
  });
});

describe("parseTargetedFeat, allowlist widening (#998)", () => {
  it("accepts an allowlisted archetype-trait feat even though archetype is not in FEAT_ACTION_CLASS_SET", () => { /* ... */ });
  it("still rejects a non-allowlisted archetype feat", () => { /* ... */ });
  it("unchanged for every class-trait feat already covered by FEAT_ACTION_CLASS_SET", () => { /* regression */ });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/feat-action-allowlist.test.mjs`
Expected: FAIL (module/gate don't exist yet)

- [ ] **Step 3: Implement.** Populate `ARCHETYPE_MYTHIC_ALLOWLIST` from the owner-approved slugs (Task 1, Step 5). Widen `parseTargetedFeat`'s gate to `if (!traits.some((t) => FEAT_ACTION_CLASS_SET.has(t)) && !ARCHETYPE_MYTHIC_ALLOWLIST.has(item.slug)) return null;`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/feat-action-allowlist.test.mjs`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add scripts/feat-action-allowlist.mjs docs/superpowers/plans/2026-10-09-ai-actor-targeted-feat-actions-no-selfeffect.md tests/feat-action-allowlist.test.mjs
git commit -m "docs(#998): amend #947's plan -- ARCHETYPE_MYTHIC_ALLOWLIST widening parseTargetedFeat's gate"
```

---

### Task 3: Vocabulary regression and version bump

**Files:**
- Test: that plan's own `dungeon-combat-targeted-action-vocabulary.test.mjs`
- Modify: `module.json`

- [ ] **Step 1: Write the failing test**

```js
it("offers an allowlisted archetype feat to an actor that owns it, with every #947 gate (cost, frequency, requirements, flourish/finisher) still enforced unchanged, and not to an actor that doesn't own it (#998, Review Focus)", async () => { /* ... */ });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run -t "offers an allowlisted archetype feat"`
Expected: FAIL (no allowlisted feat flows through today)

- [ ] **Step 3: Confirm** — no implementation change is needed here; this task verifies Task 2's widening composes correctly with #947's own existing, unmodified vocabulary/execution code.
- [ ] **Step 4: Run the test, then the full suite**

Run: `npx vitest run`
Expected: PASS, no regressions in #947's own existing class-set feats.

- [ ] **Step 5: Bump `module.json`'s version** (minor — check `main`'s current version first)
- [ ] **Step 6: Commit**

```bash
git add module.json
git commit -m "test(#998): vocabulary regression for allowlisted archetype/mythic feats; chore: bump version"
```

---

## Self-Review

**1. Spec coverage:** The audit (Task 1), the allowlist and gate widening (Task 2), and the vocabulary regression/version bump (Task 3) each cover a spec section. Overrides (#1118) and mythic-point tracking (#1117) stay explicitly out of scope.

**2. Placeholder scan:** No "TBD"/"TODO". Task 1's own Step 5 explicitly treats the allowlist's real size as unknown until the audit runs, rather than pre-populating it from the spec's own casual "~20" estimate.

**3. Type consistency:** `ARCHETYPE_MYTHIC_ALLOWLIST`'s membership (Task 2) is checked against the exact same `outcome: "parses"` classification Task 1's audit fixture produces, by the same completeness test.

**4. Review Focus:** All four bullets (parses-today-only, mythic-trait-vs-mythic-point-text distinction, allowlist-fixture completeness, unchanged downstream gating) are each pinned to a named test in Tasks 1-3; the fifth (a possibly-empty allowlist being a legitimate outcome) is stated as an explicit, non-blocking expectation rather than a test.

**Corrections found while writing this plan:** the most consequential is Investigation finding 1 — spot-checking six of the spec's own named "obvious candidates" found that most don't actually qualify under this issue's own narrow "shapes only, no overrides, no mythic points" rule: one needs a three-step compound-action override, two more need bespoke overrides, one isn't a single-target action at all, and two spend Mythic Points. This doesn't change the plan's own architecture, but it does mean the audit tool (Task 1) must measure the real eligible population honestly rather than assume the spec's own casual list is already pre-vetted — exactly the discipline the audit is there to provide.
