# Self-Effects With Choices or Granted Items Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bring five previously-excluded feat effects (Unfazed Assessment, Hunt Runelord, Come and Get Me, Divine Weapon, Intensified Element Stance) into AI reach by resolving their `ChoiceSet`s to a model-chosen legal value and letting their `GrantItem` (Off-Guard specifically) through, instead of excluding every effect that carries either rule.

**Architecture:** This plan patches REAL, merged code (#910/#914/#922), not a plan-only document. Reading the real item data for all five feats found every one of their action items has an EMPTY `system.rules` — the ChoiceSet/GrantItem always lives on the linked effect — so the existing `hasUnresolvedChoiceSet(item)` gate (which checks the action item) is a complete no-op for this family; the real blocking gate is `isUnsafeSelfEffect` (for the four plain self-effects) and the targeted-self-effect allowlist's simple absence (for Unfazed Assessment). Reading Unfazed Assessment's own real feat text also found the spec's own characterization of its mechanic is wrong: it is not a stored "Recall Knowledge result" lookup, but a live Perception check against the target's Will DC rolled by this very action.

**Tech Stack:** Vanilla JS (ESM), Foundry VTT API, PF2e system API, Vitest.

**Spec:** `docs/superpowers/specs/2026-10-09-ai-actor-choice-and-granted-item-effects-design.md`

## Global Constraints

- The model chooses among legal options; no random or heuristic choice resolution (spec's own resolved decision).
- All numbers come from the effects' own rule elements; the module only supplies the choice (spec's own resolved decision).
- Every merge bumps `module.json`'s version (CLAUDE.md).

## Investigation findings

1. **`hasUnresolvedChoiceSet(item)` (`scripts/dungeon-combat.mjs:3425`) checks the ACTION item's own `system.rules` — confirmed empty (`[]`) on all five real action items** (`unfazed-assessment.json`, `hunt-runelord.json`, `come-and-get-me.json`, `divine-weapon.json`, `intensified-element-stance.json`). Every ChoiceSet/GrantItem this spec targets lives on the LINKED EFFECT instead, so this function never has and never will flag any of these five — it is not the gate to patch. The real blocking gate for the four plain self-effects is `isUnsafeSelfEffect(rules, duration)` (`scripts/dungeon-combat.mjs:3371`, confirmed called from the filter-based `computeSelfEffectVocabularyEntries` at line 3480, which scans every one of the actor's own feat/action items with a `selfEffect` pointer rather than an allowlist); for Unfazed Assessment it is simpler still — it is not in `TARGETED_SELF_EFFECT_ALLOWLIST` (`scripts/targeted-feat-actions.mjs:33`) at all today, alongside `hunt-prey` and `devise-a-stratagem`.
2. **Unfazed Assessment's real mechanic, read directly from its own feat text, is not what the spec describes.** The spec's Investigation findings call it "a ChoiceSet bonus (1/2)... the bonus is '+2 for a critical success, +1 for a success' of the Recall Knowledge that is the feat's prerequisite" — but the real text (`feats/archetype/zephyr-guard/unfazed-assessment.json`) reads: "Choose a creature within 30 feet who you're aware of, and attempt a Perception check against that target's Will DC. If you succeed, you size up their fighting style, gaining a +1 circumstance bonus to AC and saving throws against that creature's attacks (or a +2 circumstance bonus for a critical success)." There is no separate Recall Knowledge prerequisite or stored result to read — the feat itself rolls a Perception check against the target's Will DC at the moment it's used, and this codebase has no Recall Knowledge mechanic anywhere to have supplied the spec's assumed stored value even if one were wanted (confirmed: no file references "recall knowledge" in any form). Task 3 corrects this: the executor rolls the actor's own Perception check against the target's Will DC (the same confirmed-live `statistic.roll({dc: {value}})` pattern this module's save/skill executors already use elsewhere), aborts with no effect on a failure or worse (matching the real text's own "if you succeed"), and sets the ChoiceSet's `bonus` value from the roll's own degree (1 for success, 2 for critical success).
3. **`isUnsafeSelfEffect` needs two distinct, narrow widenings, not a blanket removal of its ChoiceSet/GrantItem checks.** A ChoiceSet is safe to let through only when this plan's new resolver can interpret its shape (static labeled choices, or the `ownedItems`/`predicate`/`types` object form Divine Weapon uses — both confirmed real); an uninterpretable ChoiceSet must keep the effect excluded exactly as today. A GrantItem is safe to let through only when its own `uuid` is specifically `Compendium.pf2e.conditionitems.Item.Off-Guard` (confirmed the exact real uuid on Come and Get Me's effect) — every other GrantItem stays excluded, per the spec's own "only Off-Guard is audited here" decision.
4. **Intensified Element Stance's ChoiceSet stores a damage-type string as its value, not the element name** (confirmed real: `{label: "PF2E.TraitEarth", predicate: ["prepare-elemental-medicine:earth"], value: "acid"}` and so on for fire→fire, metal→electricity, water→sonic, wood→cold) — the vocabulary's own per-element entries must display the element (what the player-facing choice is actually about) while writing the corresponding damage-type string into `flags.pf2e.rulesSelections.damageType` (what the rule element actually reads).
5. **Divine Weapon's and Come and Get Me's real rule shapes match the spec's claims exactly**: Divine Weapon's ChoiceSet is the `{choices: {ownedItems: true, predicate: ["item:equipped"], types: ["weapon"]}}` object form, and Come and Get Me's effect carries exactly one `GrantItem` (Off-Guard, `allowDuplicate: false`) plus one `EphemeralEffect`, consistent with "rely on the system's parent-deletion handling."

## Review Focus

- An uninterpretable ChoiceSet shape (anything other than the two confirmed-real forms) must keep excluding its effect exactly as `isUnsafeSelfEffect` does today — the widening in Task 1/2 must never become a blanket "any ChoiceSet is fine now" regression (Investigation finding 3; Task 2's test).
- A GrantItem whose `uuid` is anything other than the real Off-Guard condition uuid must still exclude its effect — this is a narrow, named allowance, not a general "GrantItem is fine" relaxation (Investigation finding 3; Task 2's test).
- Unfazed Assessment's Perception check must be rolled against the TARGET's own current Will DC, re-read at execution time, not a value cached from vocabulary-build time — a target whose Will save has changed (a debuff, a buffed defense) between the two must be checked against its real, current DC (spec's own general "no stale state" pattern established throughout this planning arc; Task 3's test).
- A failed (or critical-failed) Unfazed Assessment check must still spend the action and cost — PF2e's own rule is "you attempt a check," not "you get a free retry on failure" — but must create no effect at all (Investigation finding 2; Task 3's test).
- The combat-end sweep for orphaned granted items must only ever touch an item whose `flags.pf2e.grantedBy` points at an id that genuinely no longer exists on that same actor — it must never remove a granted item whose granting effect is merely on a DIFFERENT actor's own item list with a coincidentally-matching id (spec's own implied scoping; Task 4's test).

---

### Task 1: The choice resolver

**Files:**
- Create: `scripts/feat-effect-choices.mjs`
- Test: `tests/feat-effect-choices.test.mjs`

**Interfaces:**
- Produces: `legalChoices(effectSource, actor)` → `[{flag, options: [{value, label}]}] | null` (`null` when any `ChoiceSet` on the effect is uninterpretable).

- [ ] **Step 1: Write the failing tests**

```js
describe("legalChoices (#991)", () => {
  it("resolves Hunt Runelord's static 7-school ChoiceSet with no predicate filtering", () => {
    const result = legalChoices(huntRunelordEffectSource(), actorStub());
    expect(result).toEqual([{ flag: undefined, options: expect.arrayContaining([{ value: "envy", label: expect.any(String) }]) }]);
    // Hunt Runelord's own ChoiceSet carries no explicit `flag` field (real
    // data) -- confirm during implementation whether the system defaults
    // it to the rollOption name ("thassilonian-school") and resolve
    // against that real default rather than assuming `flag` is always set.
  });

  it("filters Intensified Element Stance's choices by the actor's own prepare-elemental-medicine roll options, mapping element labels to their real damage-type values (Investigation finding 4)", () => {
    const actor = actorStub({ rollOptions: ["prepare-elemental-medicine:fire", "prepare-elemental-medicine:water"] });
    const result = legalChoices(intensifiedElementStanceEffectSource(), actor);
    expect(result[0].options).toEqual(expect.arrayContaining([{ value: "fire", label: expect.stringContaining("Fire") }, { value: "sonic", label: expect.stringContaining("Water") }]));
    expect(result[0].options).not.toEqual(expect.arrayContaining([{ value: "acid", label: expect.anything() }]));
  });

  it("resolves Divine Weapon's ownedItems/predicate/types ChoiceSet against the actor's own equipped weapons", () => {
    const actor = actorStub({ items: [{ id: "w1", type: "weapon", system: { equipped: { value: true } } }, { id: "w2", type: "weapon", system: { equipped: { value: false } } }] });
    const result = legalChoices(divineWeaponEffectSource(), actor);
    expect(result[0].options.map((o) => o.value)).toEqual(["w1"]);
  });

  it("returns null for a ChoiceSet shape it cannot interpret (Review Focus)", () => {
    const result = legalChoices({ system: { rules: [{ key: "ChoiceSet", flag: "x", choices: "not-an-array-or-object" }] } }, actorStub());
    expect(result).toBeNull();
  });

  it("returns an empty array for an effect with no ChoiceSet at all (Come and Get Me)", () => {
    expect(legalChoices(comeAndGetMeEffectSource(), actorStub())).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/feat-effect-choices.test.mjs`
Expected: FAIL (module does not exist)

- [ ] **Step 3: Implement**, confirming during implementation exactly how Hunt Runelord's ChoiceSet (no explicit `flag` field in the real data) is keyed by the real system — read `RollOptionRuleElement`'s/`ChoiceSetRuleElement`'s own default-flag behavior in the installed `pf2e.mjs` rather than guessing.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/feat-effect-choices.test.mjs`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add scripts/feat-effect-choices.mjs tests/feat-effect-choices.test.mjs
git commit -m "feat(#991): legalChoices resolver for static, predicate-filtered, and ownedItems ChoiceSets"
```

---

### Task 2: Widen the plain self-effect gate (Hunt Runelord, Divine Weapon, Intensified Element Stance, Come and Get Me)

**Files:**
- Modify: `scripts/dungeon-combat.mjs` (`isUnsafeSelfEffect`, `computeSelfEffectVocabularyEntries`, the self-effect creation step)
- Test: `tests/dungeon-combat-self-effect-vocabulary.test.mjs` (or wherever `isUnsafeSelfEffect`/`computeSelfEffectVocabularyEntries` are currently tested — confirm the real file first)

- [ ] **Step 1: Write the failing tests**

```js
describe("isUnsafeSelfEffect widening (#991, Investigation finding 3, Review Focus)", () => {
  it("no longer flags a ChoiceSet that legalChoices can interpret", () => { /* ... */ });
  it("still flags an uninterpretable ChoiceSet", () => { /* ... */ });
  it("no longer flags a GrantItem whose uuid is the real Off-Guard condition", () => { /* ... */ });
  it("still flags any other GrantItem", () => { /* ... */ });
});

describe("computeSelfEffectVocabularyEntries, choice-bearing feats (#991)", () => {
  it("offers one entry per school for Hunt Runelord when a frightened or frightenable foe exists", async () => { /* ... */ });
  it("offers one entry per prepared element for Intensified Element Stance, respecting #914's one-stance-at-a-time rule", async () => { /* ... */ });
  it("offers one entry per equipped weapon for Divine Weapon, only when the actor has a Strike candidate with that weapon this turn", async () => { /* ... */ });
  it("offers Come and Get Me under the normal #914 gates with a summary naming the Off-Guard downside", async () => { /* ... */ });
});

describe("self-effect creation with a choice (#991)", () => {
  it("writes flags.pf2e.rulesSelections[flag] = value on the source before createEmbeddedDocuments", async () => { /* ... */ });
  it("writes the equipped weapon's own item id for Divine Weapon's ownedItems choice", async () => { /* ... */ });
  it("aborts without spending the action when the chosen weapon was unequipped between candidate build and execution (Error handling)", async () => { /* ... */ });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run -t "isUnsafeSelfEffect widening"` and the self-effect vocabulary/execution suites.
Expected: FAIL (every ChoiceSet/GrantItem effect is still excluded outright today)

- [ ] **Step 3: Implement.** `isUnsafeSelfEffect` calls `legalChoices` for a `ChoiceSet` rule (unsafe only if it returns `null`) and checks a `GrantItem` rule's own `uuid` against the real Off-Guard compendium uuid (unsafe for anything else). `computeSelfEffectVocabularyEntries` multiplies an entry per legal choice option (capped at 8 per feat per the spec, dropped by the existing `effectRelevanceTier` scoring beyond the cap) and carries `choice: {flag, value, label}` on each entry; the creation step writes `flags.pf2e.rulesSelections[choice.flag] = choice.value` on the effect source before `createEmbeddedDocuments`.

- [ ] **Step 4: Run the tests to verify they pass, then the full suite**

Run: `npx vitest run` (the full self-effect vocabulary/execution suites)
Expected: PASS, no regressions in Rage/other existing plain self-effects.

- [ ] **Step 5: Commit**

```bash
git add scripts/dungeon-combat.mjs tests/dungeon-combat-self-effect-vocabulary.test.mjs
git commit -m "feat(#991): widen isUnsafeSelfEffect for interpretable ChoiceSets and the Off-Guard GrantItem; one entry per legal choice"
```

---

### Task 3: Unfazed Assessment — the real Perception-vs-Will-DC mechanic

**Files:**
- Modify: `scripts/targeted-feat-actions.mjs` (`TARGETED_SELF_EFFECT_ALLOWLIST`)
- Modify: `scripts/dungeon-combat.mjs` (`computeTargetedSelfEffectVocabularyEntries`, `executeTargetedSelfEffectFeat`)
- Test: `tests/targeted-feat-actions.test.mjs`, `tests/dungeon-combat-targeted-feat-execution.test.mjs`

- [ ] **Step 1: Write the failing tests**

```js
describe("Unfazed Assessment vocabulary (#991, Investigation finding 2)", () => {
  it("is offered against any legal, visible target -- no stored check-result precondition, since none exists", async () => { /* ... */ });
});

describe("Unfazed Assessment execution (#991, Investigation finding 2, Review Focus)", () => {
  it("rolls the actor's Perception check against the target's CURRENT Will DC, read fresh at execution time", async () => { /* ... */ });
  it("on success, sets the ChoiceSet bonus to 1 and creates the effect; on critical success, sets it to 2", async () => { /* ... */ });
  it("on failure or critical failure, spends the action but creates no effect", async () => { /* ... */ });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run -t "Unfazed Assessment"`
Expected: FAIL (not in the allowlist, no execution path)

- [ ] **Step 3: Implement.** Add `"unfazed-assessment": Object.freeze({markSlug: "unfazed-assessment", requiresSight: true, exclusiveMark: false, perceptionCheck: true})` to `TARGETED_SELF_EFFECT_ALLOWLIST`. In `executeTargetedSelfEffectFeat`, when `config.perceptionCheck`, roll `actor.perception.roll({dc: {value: target.actor.saves.will.dc.value}, createMessage: true})` (confirmed-live pattern this module's other statistic-vs-DC rolls already use) before binding/creating the effect; on a failure or worse, return `{performed: true, effectApplied: false}` (action spent, no effect) rather than aborting unspent, since the real text says the actor "attempts" the check regardless of outcome; on success/critical success, set `flags.pf2e.rulesSelections.bonus` to `1`/`2` via the same `legalChoices`-shaped write Task 2 introduced, then proceed with the existing TokenMark-bind-and-create flow.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run -t "Unfazed Assessment"`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add scripts/targeted-feat-actions.mjs scripts/dungeon-combat.mjs tests/targeted-feat-actions.test.mjs tests/dungeon-combat-targeted-feat-execution.test.mjs
git commit -m "feat(#991): Unfazed Assessment -- the real Perception-vs-Will-DC check, not a nonexistent stored Recall Knowledge result"
```

---

### Task 4: Granted-item combat-end sweep

**Files:**
- Modify: `scripts/dungeon-combat.mjs` (#914's existing combat-end cleanup pass)
- Test: the real test file covering #914's `cleanupAgentSelfEffects`-equivalent sweep (confirm its name first)

- [ ] **Step 1: Write the failing tests**

```js
describe("orphaned granted-item sweep (#991)", () => {
  it("deletes an item on an actor whose flags.pf2e.grantedBy points at an item id no longer on that SAME actor (Review Focus)", async () => { /* ... */ });
  it("leaves a granted item whose granting effect is still present", async () => { /* ... */ });
  it("never removes an item just because another actor happens to have a same-id item (Review Focus)", async () => { /* ... */ });
  it("a sweep error on one actor never blocks the rest of combat-end cleanup", async () => { /* ... */ });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run -t "orphaned granted-item sweep"`
Expected: FAIL (not implemented yet)

- [ ] **Step 3: Implement**, running this sweep immediately after #914's own existing combat-end effect cleanup, scoped per-actor (never cross-actor).

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run -t "orphaned granted-item sweep"`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add scripts/dungeon-combat.mjs
git commit -m "feat(#991): sweep orphaned GrantItem items at combat end, scoped per actor"
```

---

### Task 5: Coverage audit and version bump

**Files:**
- Create: `tests/fixtures/choice-granted-item-effects-audit.json`
- Create: `tests/choice-granted-item-effects-coverage.test.mjs`
- Modify: `module.json`

- [ ] **Step 1: Generate the fixture**, classifying the five in-scope effects as supported, and spot-checking a sample of the spec's own cited "~45 other ChoiceSet effects" to confirm they remain correctly excluded (an uninterpretable shape, or a non-Off-Guard GrantItem) rather than accidentally let through by this plan's widening.
- [ ] **Step 2: Write the ratchet test** (golden-row comparison + monotonic count, #935's pattern).
- [ ] **Step 3: Run the test suite**

Run: `npx vitest run tests/choice-granted-item-effects-coverage.test.mjs`
Expected: PASS

- [ ] **Step 4: Run the `update-architecture-docs` skill** (new file: `scripts/feat-effect-choices.mjs`)
- [ ] **Step 5: Bump `module.json`'s version** (minor — check `main`'s current version first)
- [ ] **Step 6: Commit**

```bash
git add tests/fixtures/choice-granted-item-effects-audit.json tests/choice-granted-item-effects-coverage.test.mjs module.json docs/architecture.md
git commit -m "test(#991): coverage audit for the five choice/granted-item effects; chore: bump version"
```

---

## Self-Review

**1. Spec coverage:** The choice resolver (Task 1), the plain self-effect widening (Task 2), Unfazed Assessment's corrected mechanic (Task 3), the granted-item sweep (Task 4), and the audit/version bump (Task 5) each cover a spec section. The ~45 other ChoiceSet effects remain explicitly out of scope, verified rather than assumed (Task 5).

**2. Placeholder scan:** No "TBD"/"TODO". Task 1's own step explicitly flags one real detail (Hunt Runelord's ChoiceSet default-flag behavior) as needing confirmation against the real `pf2e.mjs` during implementation, rather than guessing it into the design.

**3. Type consistency:** `legalChoices`'s return shape (Task 1) is consumed identically by `isUnsafeSelfEffect`'s safety check and `computeSelfEffectVocabularyEntries`'s entry multiplication (Task 2); the `choice: {flag, value, label}` field introduced in Task 2 is written the same way by Task 3's corrected Unfazed Assessment path.

**4. Review Focus:** All five bullets (no blanket ChoiceSet/GrantItem relaxation, fresh Will-DC read, failure-still-spends-the-action, per-actor-scoped sweep) are each pinned to a named test in Tasks 2, 3, and 4.

**Corrections found while writing this plan:** the most consequential, by a wide margin, is Investigation finding 2 — Unfazed Assessment's own real feat text describes a completely different mechanic (a live Perception check against the target's Will DC) than the spec's own characterization (a stored "Recall Knowledge result" this codebase has no mechanism to have ever recorded). Building the spec's own design as written would have produced a feature with no real data path to read from. The second is Investigation finding 1 — `hasUnresolvedChoiceSet`, the function named throughout the spec's own Investigation findings as the relevant existing gate, turns out to check the wrong item entirely (the action, which is always empty for this family) for all five feats; the real gate is `isUnsafeSelfEffect` and the targeted-effect allowlist's simple absence.
