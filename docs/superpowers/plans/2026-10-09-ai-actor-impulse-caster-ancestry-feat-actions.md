# Kineticist, Caster-Class, Ancestry and Skill Feat Actions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Generalize #998's audit tool and allowlist mechanism to cover kineticist impulses, caster-class feats, and ancestry/skill/general feats, with new exclusion reason codes for the two things these groups add that archetype/mythic feats didn't (spellshape and impulse/kinetic-aura state), and a second, separately-named allowlist widening #947's gate alongside #998's.

**Architecture:** This plan generalizes #998's own plan-only `tools/audit-archetype-feats.mjs` and `scripts/feat-action-allowlist.mjs` rather than building a parallel tool, per the spec's own explicit instruction. A spot-check of a representative feat from each new group found one genuinely useful negative example — Recollect Studies, an ancestry/skill-adjacent feat whose outcome is pure information disclosure with no roll and no mechanical effect at all — which none of #947's shapes can express, confirming the audit's `unsupported` classification needs to cover "no mechanical outcome" as its own case, not just "the text doesn't match a known pattern."

**Tech Stack:** Vanilla JS (ESM), Foundry VTT API, Vitest.

**Spec:** `docs/superpowers/specs/2026-10-09-ai-actor-impulse-caster-ancestry-feat-actions-design.md`

## Global Constraints

- Reviewed allowlist via shapes only, as #998 — nothing the shapes cannot fully consume is offered (spec's own resolved decision 2).
- No new state tracking in this spec — kinetic aura/gate and pending-spellshape state are filed to #1120 (spec's own resolved decision 3).
- Spellshape feats are excluded from the allowlist entirely until #1120, regardless of whether their own text would otherwise parse (spec's own resolved decision 4).
- #947 and #998 are still plan-only; Tasks 1-2 patch both documents directly.
- Every merge bumps `module.json`'s version (CLAUDE.md).

## Investigation findings

1. **Recollect Studies (a representative ancestry/skill-style feat) has no mechanical outcome at all — a genuinely different `unsupported` case from anything #998's own audit needed to classify.** Its real text ("You learn the resistances, immunities, or weaknesses of the creature... without needing to successfully Recall Knowledge") requires no roll and produces no condition, penalty, or damage — it is pure information disclosure once its own requirement is met. None of #947's shapes (`strikePlus`, `rollVsTargetDefense`, `targetEffect`) recognize a no-roll, no-effect outcome; `targetEffect`'s own recognizer specifically requires a `conditions` array to be present. Task 1's audit adds a distinct reason code, `noMechanicalOutcome`, rather than lumping this case under the generic `unsupported`, so the owner reviewing the allowlist proposal can see WHY a seemingly simple feat was excluded.
2. **The two new exclusion reason codes the spec calls for (`spellshape`, `impulse-state`) are each a clean, closed text/trait check, confirmed groundable without deeper mechanical investigation.** `spellshape` is a real PF2e item trait, checked directly on `item.system.traits.value` — no text parsing needed. `impulse-state` is the spec's own instruction to exclude "impulses whose text refers to the kinetic gate, a junction, an aura, or 'your kinetic aura'" — a closed phrase set, the same kind of text-presence check Task 1 of #998's own plan already used for its mythic-point exclusion (Investigation finding 2 of that plan), reused here rather than re-derived.
3. **#998's own `parseTargetedFeat` gate widening (that plan's Task 2) checks exactly one allowlist (`ARCHETYPE_MYTHIC_ALLOWLIST`) by name — this plan's own new, separately-named `FEAT_ALLOWLIST` needs its own OR-clause added to the SAME gate, not a second, parallel gate** — confirmed by reading #998's own patched code (`if (!traits.some(...) && !ARCHETYPE_MYTHIC_ALLOWLIST.has(item.slug)) return null;`). Task 2 widens this same line a second time, continuing the same "whichever sibling plan lands, the next one patches further" pattern this session has used repeatedly (e.g., #973's Terrain behavior, patched first by #984 and again by #986).

## Review Focus

- `noMechanicalOutcome` (Investigation finding 1) must be checked as its own classification before falling through to the shapes' own generic `null` return — a feat with no roll sentence and no condition/penalty/damage language should never be misclassified as `partial` (a shape that almost matched) when it is really a different kind of unsupported entirely (Investigation finding 1; Task 1's test).
- A spellshape-trait feat must be excluded even when its own text, considered alone, would otherwise parse cleanly through one of #947's shapes — the exclusion is unconditional, not a fallback for only the ones that fail to parse (spec's own resolved decision 4; Task 1's test).
- The impulse-state text check must match "your kinetic aura" and the bare "kinetic aura"/"junction"/"gate" phrasing wherever it appears in the item's body, not only in a `Requirements` block — several impulse feats fold the aura/gate reference into their main effect text rather than a separate requirements clause (spec's own stated population; Task 1's test).
- `FEAT_ALLOWLIST`'s own completeness test (every slug classified `parses` in its own group's fixture) must be checked per group, not globally — a kineticist slug accidentally validated against the ancestry-skill fixture (or vice versa) would pass even if it were never actually classified `parses` in its own real group's audit (Investigation finding 3; Task 2's test).
- Widening #947's gate a second time (Investigation finding 3) must not regress #998's own `ARCHETYPE_MYTHIC_ALLOWLIST` check — both allowlists must independently admit their own slugs, and neither must accidentally admit the other's (Task 2's test).

---

### Task 1: Generalize the audit tool

**Files:**
- Modify: `tools/audit-archetype-feats.mjs` (from #998's plan — generalize to accept a `group` parameter)
- Create: `tests/fixtures/kineticist-feat-audit.json`, `tests/fixtures/caster-feat-audit.json`, `tests/fixtures/ancestry-skill-feat-audit.json`
- Test: `tests/feat-population-audit.test.mjs`

- [ ] **Step 1: Write the failing tests**

```js
describe("generalized feat-population audit (#999)", () => {
  it("classifies Recollect Studies as noMechanicalOutcome, not a generic unsupported (Investigation finding 1, Review Focus)", () => {
    const rows = runAudit(fixtureCompendium(), "ancestry-skill");
    expect(rows.find((r) => r.slug === "recollect-studies")?.outcome).toBe("noMechanicalOutcome");
  });

  it("excludes any spellshape-trait feat unconditionally, even one whose text would otherwise parse (Review Focus)", () => {
    const rows = runAudit(fixtureCompendium({ spellshapeThatWouldOtherwiseParse: true }), "caster");
    expect(rows.find((r) => r.traits.includes("spellshape"))?.outcome).toBe("spellshape");
  });

  it("excludes an impulse whose text mentions 'your kinetic aura', 'junction', or 'gate' anywhere in the body, not only a Requirements block (Review Focus)", () => {
    const rows = runAudit(fixtureCompendium(), "kineticist");
    expect(rows.find((r) => /kinetic aura|junction|\bgate\b/i.test(r.rawText))?.outcome).toBe("impulse-state");
  });

  it("runs per group, producing a separate fixture and row set for kineticist/caster/ancestry-skill", () => { /* ... */ });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/feat-population-audit.test.mjs`
Expected: FAIL (the tool has no `group` parameter or new reason codes yet)

- [ ] **Step 3: Implement**, adding a `group` parameter to #998's own audit function, the `noMechanicalOutcome` classification (checked before the shape recognizers run: no roll sentence AND no condition/penalty/damage language in the degree blocks or inline text), the `spellshape` trait check (unconditional, before shape-parsing), and the `impulse-state` closed-phrase check (run against the full stripped body text, not only a `Requirements` block).

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/feat-population-audit.test.mjs`
Expected: PASS

- [ ] **Step 5: Propose the per-group allowlists** from each fixture's own `parses` rows as a comment attached to the issue for the owner's approval, same process as #998's own Task 1.
- [ ] **Step 6: Commit**

```bash
git add tools/audit-archetype-feats.mjs tests/fixtures/kineticist-feat-audit.json tests/fixtures/caster-feat-audit.json tests/fixtures/ancestry-skill-feat-audit.json tests/feat-population-audit.test.mjs
git commit -m "feat(#999): generalize #998's audit tool with group partitioning and the spellshape/impulse-state/noMechanicalOutcome reason codes"
```

---

### Task 2: `FEAT_ALLOWLIST` and the second gate widening

**Files:**
- Modify: `scripts/feat-action-allowlist.mjs` (from #998's plan)
- Modify: `docs/superpowers/plans/2026-10-09-ai-actor-targeted-feat-actions-no-selfeffect.md` (`parseTargetedFeat`'s gate, already once-widened by #998)
- Test: `tests/feat-action-allowlist.test.mjs`, that plan's own parser test file

- [ ] **Step 1: Write the failing tests**

```js
describe("FEAT_ALLOWLIST (#999)", () => {
  it("every kineticist-group slug is classified parses in the kineticist fixture specifically, not just any fixture (Review Focus)", () => {
    const kineticistAudit = JSON.parse(fs.readFileSync("tests/fixtures/kineticist-feat-audit.json"));
    for (const slug of FEAT_ALLOWLIST.kineticist) {
      expect(kineticistAudit.find((r) => r.slug === slug)?.outcome).toBe("parses");
    }
  });
  it("same completeness check for the caster and ancestry-skill groups, each against its own fixture", () => { /* ... */ });
});

describe("parseTargetedFeat, second gate widening (#999, Investigation finding 3)", () => {
  it("accepts a FEAT_ALLOWLIST slug even though it's neither a FEAT_ACTION_CLASS_SET trait nor an ARCHETYPE_MYTHIC_ALLOWLIST slug", () => { /* ... */ });
  it("ARCHETYPE_MYTHIC_ALLOWLIST's own #998 behavior is unchanged (Review Focus: neither allowlist admits the other's slugs)", () => { /* ... */ });
  it("still rejects a non-allowlisted, non-class-trait feat", () => { /* ... */ });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/feat-action-allowlist.test.mjs`
Expected: FAIL (`FEAT_ALLOWLIST` doesn't exist; the gate only checks one allowlist)

- [ ] **Step 3: Implement.** Add `FEAT_ALLOWLIST = { kineticist: new Set([...]), caster: new Set([...]), ancestrySkill: new Set([...]) }` (owner-approved slugs from Task 1, Step 5) to `scripts/feat-action-allowlist.mjs`, and widen #947's gate a second time: `if (!traits.some((t) => FEAT_ACTION_CLASS_SET.has(t)) && !ARCHETYPE_MYTHIC_ALLOWLIST.has(item.slug) && !isInFeatAllowlist(item.slug)) return null;`, where `isInFeatAllowlist` checks membership across all three `FEAT_ALLOWLIST` groups.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/feat-action-allowlist.test.mjs`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add scripts/feat-action-allowlist.mjs docs/superpowers/plans/2026-10-09-ai-actor-targeted-feat-actions-no-selfeffect.md tests/feat-action-allowlist.test.mjs
git commit -m "docs(#999): amend #947's plan -- FEAT_ALLOWLIST (kineticist/caster/ancestry-skill), second gate widening alongside #998's"
```

---

### Task 3: Vocabulary regression and version bump

**Files:**
- Test: #947's own `dungeon-combat-targeted-action-vocabulary.test.mjs`
- Modify: `module.json`

- [ ] **Step 1: Write the failing test**

```js
it("offers an allowlisted kineticist/caster/ancestry-skill feat to an owning actor only, with every #947 gate still enforced unchanged (#999, Review Focus: both allowlists compose correctly)", async () => {
  // An actor with one FEAT_ALLOWLIST feat and one ARCHETYPE_MYTHIC_ALLOWLIST
  // feat (#998) both offered; an actor with neither offered neither.
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run -t "offers an allowlisted kineticist"`
Expected: FAIL (no kineticist/caster/ancestry-skill feat flows through today)

- [ ] **Step 3: Confirm** — no implementation change needed; this verifies Task 2's second gate widening composes correctly with #998's first one and #947's own unmodified vocabulary/execution code.
- [ ] **Step 4: Run the test, then the full suite**

Run: `npx vitest run`
Expected: PASS, no regressions in #947's own class-set feats or #998's own archetype/mythic allowlist.

- [ ] **Step 5: Bump `module.json`'s version** (minor — check `main`'s current version first)
- [ ] **Step 6: Commit**

```bash
git add module.json
git commit -m "test(#999): vocabulary regression for FEAT_ALLOWLIST alongside #998's allowlist; chore: bump version"
```

---

## Self-Review

**1. Spec coverage:** The generalized audit (Task 1), `FEAT_ALLOWLIST` and the gate widening (Task 2), and the vocabulary regression/version bump (Task 3) each cover a spec section. Kinetic aura/gate and spellshape state tracking (#1120) stay explicitly out of scope — excluded by reason code, not silently handled.

**2. Placeholder scan:** No "TBD"/"TODO". Task 1's own Step 5 treats each group's allowlist contents as unknown until that group's audit runs, matching #998's own established practice.

**3. Type consistency:** `FEAT_ALLOWLIST`'s per-group shape (Task 2) is checked against the exact per-group fixture names Task 1 produces; the gate-widening expression in Task 2 extends #998's own exact line rather than replacing it.

**4. Review Focus:** All five bullets (`noMechanicalOutcome` as its own case, unconditional spellshape exclusion, body-wide impulse-state phrase matching, per-group fixture completeness, both allowlists composing without cross-admitting) are each pinned to a named test in Tasks 1-2.

**Corrections found while writing this plan:** the main finding is Investigation finding 1 — Recollect Studies, a seemingly simple ancestry/skill feat, has no mechanical outcome at all (pure information disclosure), a genuinely different unsupported case from anything #998's own audit needed to classify; naming it explicitly (`noMechanicalOutcome`) rather than lumping it under a generic `unsupported` gives the owner reviewing the allowlist proposal an honest, specific reason rather than an opaque rejection.
