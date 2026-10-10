# Remaining Bespoke Save Abilities Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `randomTable` shape to #935's save descriptor for "roll a die, apply the matching ordered-list outcome" abilities (Draxie Dust), apply spell-outcome entries only when the spell-effects pack has an effect item for them, and extend #935's audit with a ranked inventory of the whole unparsed remainder for owner-approved override entries.

**Architecture:** The `randomTable` shape patches #935's parser directly; each list entry resolves through #935's/#987's own existing outcome grammars (not a fourth, separate grammar). Execution reuses the real, single degree-outcome dispatcher #935/#987 already funnel every other kind through, rather than the spec's own two function names that don't exist in either plan.

**Tech Stack:** Vanilla JS (ESM), Foundry VTT API, PF2e system API, Vitest.

**Spec:** `docs/superpowers/specs/2026-10-09-ai-npc-remaining-save-abilities-design.md`

## Global Constraints

- #935 and #987 are still plan-only; all three tasks here patch #935's document directly (and, by extension, pick up #987's own additions to it).
- All-or-nothing: any list entry that doesn't parse, or a die/list-count mismatch, keeps the whole ability `reportOnly` (spec's own stated rule).
- An outcome of the form "takes the effects of the `<spell>` spell" is applied only when the spell-effects pack has a matching effect item; otherwise the ability is not offered (owner's resolved policy).
- Every merge bumps `module.json`'s version (CLAUDE.md).

## Investigation findings

1. **The spec's own execution step cites two helper names, `applyTimedCondition` and `applyOutcomeEffects`, that do not exist under those names in either #935's or #987's plan — found by checking both plans directly rather than trusting the spec's shorthand.** Neither function appears anywhere in #935's merged plan text; `applyOutcomeEffects` does not appear in #987's plan either (that plan, written earlier in this same session, split the seven new outcome kinds across `applyNpcAbilityDegree`'s own `effects` loop (rule-element kinds) and separate turn-boundary hook files (action loss, forced movement, suffocation), with no single unifying dispatcher function). The real, single integration point every degree-level outcome already funnels through is `applyNpcAbilityDegree` itself (#935's plan, its `conditions`/`penalties`/`effects` loops) — Task 2 builds the rolled random-table entry's outcome into a synthetic degree-shaped object and dispatches it through that same real function, rather than calling either invented name.
2. **Draxie Dust's real text matches the spec's quote exactly, and the spell-effects pack really has no Charm or no Sleep effect item** (confirmed live: searching `spell-effects/` for either name finds only the unrelated `spell-effect-charming-push.json`) — the spec's own "Draxie Dust, as written, would not be offered today" conclusion holds up under direct verification, not just the spec's own say-so.
3. **Hallucinogenic Cloud's exclusion from the random-table shape is correct, confirmed by reading its full real text rather than trusting the spec's terse one-line reason.** It does carry a die roll and a matching ordered list, structurally close to Draxie Dust's own pattern — but the roll recurs **every round** a creature remains hallucinating (tied to an ongoing, sustained cloud effect with its own new save each round), not **once per use** the way Draxie Dust's grammar assumes. This is a genuinely different mechanic (a sustained, recurring-roll effect), correctly left to the sustained-effects follow-up (#1102) rather than forced into this issue's single-roll `randomTable` shape.

## Review Focus

- A `spellEffect` entry's resolvability must be checked against the real spell-effects pack index at vocabulary-build time, not assumed from a cached "it worked once" result — a later compendium update could add or remove an effect item for a given spell, and a stale assumption would either wrongly withhold an ability that's now fixed or wrongly offer one that's now broken (spec's own implied rule; Task 1's test).
- The die roll must happen exactly once per use, before any save, even when the area affects zero creatures — the ability's own text doesn't make the roll conditional on anyone being present, so skipping it when the template is empty would under-model a mechanic the real text states unconditionally (spec's own stated sequencing; Task 2's test).
- A list whose entry count doesn't match the die's face count must be rejected outright, not truncated or padded — a 1d4 ability with only 3 list items is a sign the parse itself is wrong, not a prompt to guess the 4th (spec's own stated rule; Task 1's test).
- The remainder inventory's shape classification must be computed from the SAME real population the audit scans, not re-derived from the spec's own quoted counts — the spec's own figures (88/68/67/53/23/3) are a snapshot from when the spec was written, and the real compendium (or this module's own earlier-landed #986/#987 coverage) may have already reclassified some of them (spec's own implied caveat: "the classification is an input... not a promise of coverage"; Task 3's test).
- An override entry's fixture hash must be checked against the entry's own creature's real current text at the SAME granularity #984 established (disabling only that one entry on a mismatch, never the whole table) — Task 3 reuses #984's own mechanism rather than restating it.

---

### Task 1: Recognition — the `randomTable` shape

**Files:**
- Modify: `docs/superpowers/plans/2026-10-09-ai-npc-save-outcome-coverage.md` (`parseSaveAbility`)
- Test: that plan's own parser test file

- [ ] **Step 1: Write the failing tests**

```js
describe("randomTable recognition (#988)", () => {
  it("recognizes Draxie Dust -- a d4 roll sentence plus a matching 4-item ordered list (real text)", () => {
    const item = makeSaveItem({
      checkParams: "will|dc:17",
      blocks: "", // no Success/Failure blocks -- the binary "or be affected" form
      description: '<p>The draxie breathes magical dust in a @Template[cone|distance:15]. Roll [[/r 1d4]] to determine the effect. Each creature in the area must succeed at a @Check[will|dc:17] save or be affected.</p><p>The draxie can\'t use Draxie Dust again for [[/gmr 1d4 #Recharge Draxie Dust]]{1d4 rounds}.</p><ol><li>The target takes the effects of the @UUID[Compendium.pf2e.spells-srd.Item.Charm] spell.</li><li>The target loses its last 5 minutes of memory.</li><li>The target takes the effects of a @UUID[Compendium.pf2e.spells-srd.Item.Sleep] spell.</li><li>For 1 minute, the target is in a state of euphoria that makes it Stupefied 2 and Slowed 1.</li></ol>',
    });
    const parsed = parseSaveAbility(item);
    expect(parsed.random.die).toBe(4);
    expect(parsed.random.entries).toHaveLength(4);
    expect(parsed.random.entries[1].outcome).toMatchObject({ kind: "memoryLoss", scope: "lastMinutes:5" });
    expect(parsed.random.entries[3].outcome.conditions).toEqual([{ slug: "stupefied", value: 2 }, { slug: "slowed", value: 1 }]);
  });

  it("marks a spellEffect entry unresolvable when the spell-effects pack has no matching item (Investigation finding 2)", () => {
    const parsed = parseSaveAbility(draxieDustItem());
    expect(parsed.random.entries[0].outcome).toMatchObject({ kind: "spellEffect", spellUuid: expect.stringContaining("Charm"), resolvable: false });
  });

  it("rejects a die/list-count mismatch (Review Focus)", () => {
    const item = makeSaveItem({ description: "<p>Roll [[/r 1d4]] to determine the effect.</p><ol><li>A</li><li>B</li><li>C</li></ol>" });
    expect(parseSaveAbility(item).random).toBeUndefined();
  });

  it("does not recognize Hallucinogenic Cloud as a randomTable -- its roll recurs per round, not once per use (Investigation finding 3)", () => {
    const item = makeSaveItem({ description: hallucinogenicCloudRealText });
    expect(parseSaveAbility(item).random).toBeUndefined();
  });

  it("keeps the whole ability reportOnly when any one list entry fails to parse", () => { /* ... */ });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run -t "randomTable recognition"`
Expected: FAIL (field doesn't exist yet)

- [ ] **Step 3: Implement**, requiring exactly one `Roll [[/r 1dN]] to determine the effect` sentence and an `<ol>` of exactly `N` items (a mismatched count or a non-adjacent roll/list pair means `random` is not set, leaving the ability to fall through to #935's existing parsing/`reportOnly`); each entry's text is handed to #935's/#987's existing outcome-sentence parsers (reused, not duplicated) with one addition — an unresolved `@UUID[Compendium.pf2e.spells-srd.Item.<Name>]` that doesn't match a known outcome pattern becomes `{kind: "spellEffect", spellUuid, resolvable}`, where `resolvable` is looked up against a cached index of the `spell-effects` pack's own item names (confirmed real at 517 entries) built once per session, not per parse call.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run -t "randomTable recognition"`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add docs/superpowers/plans/2026-10-09-ai-npc-save-outcome-coverage.md
git commit -m "docs(#988): amend #935's plan -- the randomTable shape and spell-effect resolvability"
```

---

### Task 2: Execution

**Files:**
- Modify: `docs/superpowers/plans/2026-10-09-ai-npc-save-outcome-coverage.md` (the save-ability executor, around `applyNpcAbilityDegree`)
- Test: that plan's own executor test file

- [ ] **Step 1: Write the failing tests**

```js
describe("randomTable execution (#988)", () => {
  it("rolls the die exactly once per use, publicly, before any save, even when the area affects no one (Review Focus)", async () => { /* ... */ });
  it("applies the rolled entry's outcome to each creature that fails its save, via the same applyNpcAbilityDegree dispatch every other outcome kind uses (Investigation finding 1)", async () => { /* ... */ });
  it("a creature that succeeds its save is unaffected; a critical failure behaves as a plain failure unless the text states otherwise", async () => { /* ... */ });
  it("an unresolvable spellEffect ability is not offered at all -- the vocabulary builder excludes it before execution is ever reached", async () => { /* ... */ });
  it("a Roll failure leaves the action unspent and reports to the GM", async () => { /* ... */ });
  it("reports the die result, each target's save result, and what was applied through #925's result descriptor", async () => { /* ... */ });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run -t "randomTable execution"`
Expected: FAIL (not implemented yet)

- [ ] **Step 3: Implement**: spend the cost, record the recharge formula exactly as the ability states (confirmed real pattern from `setAbilityRecharge`, already used elsewhere in this file); roll `new Roll("1d" + random.die)`, post it with the ability name as flavor; for each creature in the template's affected set (reusing #915's area-membership helper), roll its save, and on a failure, build a synthetic degree object (`{conditions: entry.outcome.conditions ?? [], effects: entry.outcome.kind ? [entry.outcome] : []}`) and dispatch it through `applyNpcAbilityDegree`'s own real conditions/effects loops exactly as #987's rule-element kinds already do, rather than inventing a parallel application path.

- [ ] **Step 4: Run the tests to verify they pass, then the full save-outcome-coverage suite**

Run: `npx vitest run -t "randomTable execution"` then the full suite for that plan.
Expected: PASS, no regressions in #935's/#987's own existing executor tests.

- [ ] **Step 5: Commit**

```bash
git add docs/superpowers/plans/2026-10-09-ai-npc-save-outcome-coverage.md
git commit -m "docs(#988): amend #935's plan -- randomTable execution via the real applyNpcAbilityDegree dispatch"
```

---

### Task 3: The remainder inventory, override entries, and version bump

**Files:**
- Create/modify: the save-outcome-coverage ratchet's golden fixture and test (#935's established pattern)
- Modify: `module.json`

- [ ] **Step 1: Generate the remainder inventory**, scanning the real, current population (not the spec's own point-in-time counts, per Investigation finding/Review Focus) of still-`reportOnly`/not-offered save abilities, classifying each `{ability, creatureCount, shape, blockedBy}` and ranking by creature count.
- [ ] **Step 2: Propose the owner-approved override batch** from the inventory's highest-count, authorable-with-existing-primitives entries, as a list attached to the issue for approval -- separate from this plan's own shipped `randomTable` shape, per the spec's own decision process (the #935/#984 pattern).
- [ ] **Step 3: Write/extend the ratchet test** (golden-row comparison + monotonic auto-count, #935's pattern) covering the `randomTable` shape and the approved override entries.
- [ ] **Step 4: Run the test suite**

Run: `npx vitest run` (the full save-outcome-coverage suite)
Expected: PASS

- [ ] **Step 5: Run the `update-architecture-docs` skill** (no new files — confirm no import-edge changes are missed)
- [ ] **Step 6: Bump `module.json`'s version** (minor — check `main`'s current version first)
- [ ] **Step 7: Commit**

```bash
git add module.json docs/architecture.md
git commit -m "test(#988): remainder inventory and ratchet for randomTable + override entries; chore: bump version"
```

---

## Self-Review

**1. Spec coverage:** The `randomTable` shape (Task 1), execution (Task 2), and the remainder inventory/override process (Task 3) each cover a spec section. The four deferred follow-ups (#1102-#1105) are explicitly excluded, not silently handled.

**2. Placeholder scan:** No "TBD"/"TODO". Task 1's and 2's test lists name exactly what each asserts, grounded in the real Draxie Dust/Hallucinogenic Cloud texts quoted in Investigation findings 2-3.

**3. Type consistency:** `random: {die, entries: [{index, text, outcome}]}` (Task 1) is read identically by Task 2's executor; the `outcome` shape within each entry reuses #935's/#987's own existing per-kind shapes unchanged, never a fourth parallel shape.

**4. Review Focus:** All four bullets (fresh resolvability check, unconditional once-per-use roll, strict die/list-count rejection, inventory computed from the real current population) are each pinned to a named test in Tasks 1-3.

**Corrections found while writing this plan:** the most consequential is Investigation finding 1 — the spec's own execution step cites `applyTimedCondition` and `applyOutcomeEffects`, neither of which exists in either upstream plan; checked directly against both rather than assumed, and corrected to dispatch through the one real function (`applyNpcAbilityDegree`) every other outcome kind in this planning arc already uses. The second is confirming, not correcting: Hallucinogenic Cloud's exclusion (Investigation finding 3) holds up under a full read of its real text, worth stating plainly rather than silently trusting the spec's own terse one-line reason.
