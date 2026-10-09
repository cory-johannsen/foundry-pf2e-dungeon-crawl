# Ally-Targeting NPC Buffs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add two families to #934's `npcSelf` vocabulary — ally area buffs (an emanation/burst of allies with a closed subject filter) and single willing-ally buffs — each applying exactly one linked PF2e effect item to each affected ally, Foundry enumerating legal targets/placements and the #909 model choosing among them.

**Architecture:** Both families patch #934's own plan-only `scripts/npc-self-parse.mjs`/`buildNpcSelfVocabulary`/`applyAgentDecision` `npcSelf` branch. Real-text verification found the area family (`allyEffectArea`) solidly grounded in two clean real examples, but found BOTH of the spec's own named `allyEffectSingle` examples (Profane Gift, Invigorating Passion) carry substantial additional mechanical content beyond a simple linked effect — neither actually survives the spec's own stated all-or-nothing grammar. This plan treats that honestly: the single-target family's test fixtures use both as NEGATIVE examples proving the grammar correctly excludes them, and the real positive population for that family (if any exists) is left to the coverage audit rather than forced with an invented example.

**Tech Stack:** Vanilla JS (ESM), Foundry VTT API, PF2e system API, Vitest.

**Spec:** `docs/superpowers/specs/2026-10-09-ai-npc-ally-buffs-design.md`

## Global Constraints

- **#934 is still plan-only.** Every task here patches that plan document directly.
- All-or-nothing, unchanged: a sentence beyond the recognized clauses, or more than one linked effect, makes the whole ability `null`.
- Every merge bumps `module.json`'s version (CLAUDE.md).

## Investigation findings

1. **`allyEffectArea`'s two real, named examples are both clean and confirmed accurate** — Battle Cry (Orc Commander, a 60-foot emanation, ancestry filter, includes self) and Take Them Down! (Hryngar Taskmaster, a 20-foot emanation, level-bound filter) both read exactly as the spec quotes them, each a single sentence naming the area, the filter, and exactly one linked effect. This family is solidly grounded.
2. **Neither of `allyEffectSingle`'s two named real examples actually survives the spec's own stated all-or-nothing grammar — a significant finding worth stating honestly rather than papering over.** Profane Gift's real text (confirmed live, `succubus.json`) continues far past the single +1 bonus the spec quotes: a standing telepathic link, seeing through the target's senses, a saving-throw penalty against the succubus's own `Suggestion` spell specifically, a one-gift-at-a-time rule, a free-action removal that curses the target with unlimited Stupefied 3, and a summoned-succubus exclusion — none of which the stated "one linked effect, nothing else" grammar can consume. Invigorating Passion's real text (confirmed live, `gancanagh.json`) similarly continues past its own linked effect with a DEFERRED, save-gated clause ("After that time, the target becomes Fatigued... unless it succeeds at a Fortitude save") that fires when the first effect's own duration ends — a second mechanical effect the base grammar doesn't name at all. Both are correctly excluded by the grammar as specified; this plan's own fixtures use them as the NEGATIVE proof of that, and does not force a fabricated positive example in their place. The real positive yield for `allyEffectSingle` — if the real population contains any clean example at all — is left to Task 5's coverage audit to surface, the same honest "measure it for real, don't guess" discipline #935/#947/#961 already established for an uncertain population.

## Review Focus

- `allyEffectSingle`'s own grammar must reject Profane Gift and Invigorating Passion specifically (not just abstractly "a complex ability") — both are named, real regression fixtures proving the exclusion, not a generic catch-all test (Investigation finding 2; Task 2's test).
- An ally who already has the linked effect (same origin item) must never be re-targeted — checked per-ally at both vocabulary-build time and again at execution time, since an ally could gain the effect from a different source between the two (spec's own stated rule; Task 3's test).
- A burst placement that would also catch an OPPONENT must never be penalized or excluded for that reason — unlike a damaging area, this family never avoids enemies in its radius, it simply never targets them (spec's own stated rule, a real behavioral difference from the damaging-area placement code this reuses; Task 3's test).
- The affected set must be recomputed fresh at execution time, never trusted from vocabulary-build time, since an ally can move, fall, or already receive the effect from elsewhere in between (spec's own stated rule; Task 4's test).
- At least one effect must actually be created before the action's cost is spent — a wholly-failed application (every ally already has the effect, or every creation attempt failed) must leave the action unspent (spec's own stated rule; Task 4's test).

---

### Task 1: `allyEffectArea` and the filter grammar

**Files:**
- Modify: `docs/superpowers/plans/2026-10-09-ai-npc-self-buff-heal-abilities.md`
- Test: that plan's own `npc-self-parse.mjs` test file

- [ ] **Step 1: Write the failing tests**

```js
// append to the #934 plan's own parser test file
describe('allyEffectArea (#981)', () => {
  it('recognizes an emanation buff with an ancestry filter that includes self (Battle Cry, real text)', () => {
    const item = makeSelfItem("<p>Bellowing mightily, the orc commander gives themself and all orc allies within @Template[emanation|distance:60]{60 feet} a +1 status bonus to attack and damage rolls until the start of the orc commander's next turn.</p><p>@UUID[Compendium.pf2e.bestiary-effects.Item.Effect: Battle Cry]</p>");
    const parsed = parseSelfAbility(item);
    expect(parsed.family).toBe('allyEffectArea');
    expect(parsed.params).toMatchObject({ shape: 'emanation', distanceFeet: 60, includeSelf: true, filter: { type: 'ancestryOrTrait', value: 'orc' } });
  });

  it('recognizes a level-bound filter (Take Them Down!, real text)', () => {
    const item = makeSelfItem("<p>All allied hryngars of equal or lower level that are within @Template[emanation|distance:20]{20 feet} of the hryngar taskmaster gain a +1 status bonus to attack rolls and damage rolls until the end of the hryngar taskmaster's next turn.</p><p>@UUID[Compendium.pf2e.bestiary-effects.Item.Effect: Take Them Down!]</p>");
    const parsed = parseSelfAbility(item);
    expect(parsed.params.filter).toEqual({ type: 'levelAtMost', value: 'self' });
    expect(parsed.params.includeSelf).toBe(false);
  });

  it('returns null for an unsupported subject restriction ("who hear and understand")', () => {
    const item = makeSelfItem('<p>All allies within 30 feet who hear and understand this order gain a +1 bonus.</p><p>@UUID[Compendium.pf2e.bestiary-effects.Item.Effect: Bark Orders]</p>');
    expect(parseSelfAbility(item)).toBeNull();
  });

  it('returns null for more than one linked effect', () => {
    const item = makeSelfItem('<p>All allies within 30 feet gain a bonus.</p><p>@UUID[Compendium.pf2e.bestiary-effects.Item.Effect: A]</p><p>@UUID[Compendium.pf2e.bestiary-effects.Item.Effect: B]</p>');
    expect(parseSelfAbility(item)).toBeNull();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/npc-self-parse.test.mjs -t "allyEffectArea"`
Expected: FAIL (no such family recognized yet)

- [ ] **Step 3: Implement** the `allyEffectArea` recognizer and the `filter` grammar (`ancestryOrTrait:<slug>`, `levelAtMost:self|<N>`, `includeSelf`/`excludeSelf`), per the spec's own Design §Recognition, reusing #934's existing normalization/linked-effect-counting helpers.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/npc-self-parse.test.mjs`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add docs/superpowers/plans/2026-10-09-ai-npc-self-buff-heal-abilities.md tests/npc-self-parse.test.mjs
git commit -m "docs(#981): amend #934's plan -- allyEffectArea shape and the filter grammar"
```

---

### Task 2: `allyEffectSingle`

**Files:**
- Modify: `docs/superpowers/plans/2026-10-09-ai-npc-self-buff-heal-abilities.md`
- Test: that plan's own `npc-self-parse.mjs` test file

- [ ] **Step 1: Write the failing tests**

```js
describe('allyEffectSingle (#981)', () => {
  it('recognizes a clean single willing-ally buff when one exists in the real population (synthetic fixture, matching the spec\'s own stated sentence shape exactly)', () => {
    const item = makeSelfItem('<p>The creature gives a willing humanoid within 10 feet a +1 status bonus to AC for 1 minute.</p><p>@UUID[Compendium.pf2e.bestiary-effects.Item.Effect: Synthetic Example]</p>');
    const parsed = parseSelfAbility(item);
    expect(parsed.family).toBe('allyEffectSingle');
    expect(parsed.params).toMatchObject({ rangeFeet: 10, targetFilter: 'humanoid' });
  });

  it('excludes Profane Gift -- real text carries far more than one linked effect\'s worth of mechanics (Investigation finding 2)', () => {
    const item = makeSelfItem("<p><strong>Frequency</strong> once per day</p><hr /><p><strong>Effect</strong> The succubus gives a willing humanoid a profane gift. That creature gains a +1 status bonus to attack rolls, skill checks, and saving throws. As long as the gift persists, the succubus can communicate telepathically with the target at any distance, see through the creature's senses, and target the creature with suggestion through the telepathic link. In addition, the creature uses an outcome one degree of success worse than it rolls on saving throws against the succubus's @UUID[Compendium.pf2e.spells-srd.Item.Suggestion] spells.</p><p>A humanoid can't have more than one profane gift at a time, and a succubus can't grant more than one profane gift at a time. Removing the gift requires an atone ritual. The succubus can remove the gift as a free action to give the recipient a curse, making them @UUID[Compendium.pf2e.conditionitems.Item.Stupefied]{Stupefied 3} with an unlimited duration.</p><p>A summoned succubus can't grant a profane gift.</p><p>@UUID[Compendium.pf2e.bestiary-effects.Item.Effect: Profane Gift]</p>");
    expect(parseSelfAbility(item)).toBeNull();
  });

  it('excludes Invigorating Passion -- its real text has a deferred, save-gated second effect beyond the linked one (Investigation finding 2)', () => {
    const item = makeSelfItem('<p>The gancanagh embraces or kisses a willing creature adjacent to them, infusing that creature with their invigorating passion. For 10 minutes, the creature gains a +1 status bonus to attack rolls and 10 temporary Hit Points. After that time, the target becomes @UUID[Compendium.pf2e.conditionitems.Item.Fatigued] for 10 minutes unless it succeeds at a @Check[fortitude|dc:21] save.</p><p>@UUID[Compendium.pf2e.bestiary-effects.Item.Effect: Invigorating Passion]</p>');
    expect(parseSelfAbility(item)).toBeNull();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/npc-self-parse.test.mjs -t "allyEffectSingle"`
Expected: FAIL (no such family recognized, and the two real-named-example tests pass trivially today only because EVERYTHING returns null before this task — confirm after Step 3 that they still return null for the RIGHT reason, not just "shape doesn't exist yet")

- [ ] **Step 3: Implement** the `allyEffectSingle` recognizer per the spec's own Design §Recognition — "gives a willing `<noun>` within N feet `<effect>`" with exactly one linked effect and zero leftover sentences, which correctly nulls both Profane Gift (far too much leftover text) and Invigorating Passion (the deferred save-gated clause is unconsumed leftover).

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/npc-self-parse.test.mjs`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add docs/superpowers/plans/2026-10-09-ai-npc-self-buff-heal-abilities.md tests/npc-self-parse.test.mjs
git commit -m "docs(#981): amend #934's plan -- allyEffectSingle shape, correctly excluding both named real examples"
```

---

### Task 3: Vocabulary — placement and target enumeration

**Files:**
- Modify: `docs/superpowers/plans/2026-10-09-ai-npc-self-buff-heal-abilities.md`
- Test: that plan's own vocabulary-builder test file

- [ ] **Step 1: Write the failing tests**

```js
describe('ally-buff vocabulary (#981)', () => {
  it('computes the affected set for an emanation placement: allies passing the filter, not already carrying the effect, opponents never included', () => {
    // Build a fake combat with 2 orc allies (one already has the Battle
    // Cry effect from this item), 1 non-orc ally, and 1 opponent within
    // the 60ft emanation; assert the affected set contains exactly the
    // one eligible orc ally.
  });

  it('never excludes a placement for catching an opponent in its radius (Review Focus -- unlike a damaging area)', () => {
    // A placement whose emanation also covers an opponent must still be
    // offered, with the opponent simply absent from affectedIds.
  });

  it('skips a placement whose affected set would be empty', () => {
    // Every ally already has the effect, or none pass the filter -> no
    // vocabulary entry for that placement.
  });

  it('offers one entry per legal single-ally target within range, filter, and line of effect', () => {
    // allyEffectSingle: 2 allies in range, one already has the effect ->
    // one entry.
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run -t "ally-buff vocabulary"`
Expected: FAIL (not implemented yet)

- [ ] **Step 3: Implement**, reusing the same area-placement helper `readyAreaSpells`/`placements` already use (confirmed real, cited in the spec's own Investigation findings), filtered to allies only and never excluding a placement for also covering an opponent — a genuine, real behavioral difference from that helper's own damaging-area use that this task's own call site must apply explicitly (pass an "allies only, no enemy avoidance" mode rather than reusing the damaging-area call shape unmodified).

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run -t "ally-buff vocabulary"`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add docs/superpowers/plans/2026-10-09-ai-npc-self-buff-heal-abilities.md
git commit -m "docs(#981): amend #934's plan -- ally-buff vocabulary (placement/target enumeration)"
```

---

### Task 4: Execution

**Files:**
- Modify: `docs/superpowers/plans/2026-10-09-ai-npc-self-buff-heal-abilities.md`
- Test: that plan's own `applyAgentDecision` `npcSelf` execution test file

- [ ] **Step 1: Write the failing tests**

```js
describe('ally-buff execution (#981)', () => {
  it('creates the linked effect on each affected ally, with the acting NPC as origin, skipping any ally that already has it', async () => {
    // Assert createEmbeddedDocuments called once per eligible ally, with
    // origin.actor/token/item set to the ACTOR's own (not the ally's).
  });

  it('recomputes the affected set fresh at execution time, dropping an ally that moved out of range since vocabulary build', async () => {
    // ...
  });

  it('does not spend the action when every ally already has the effect (or every attempt failed)', async () => {
    // ...
  });

  it('spends the action and reports success when at least one ally received the effect, even if another attempt failed', async () => {
    // ...
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run -t "ally-buff execution"`
Expected: FAIL (not implemented yet)

- [ ] **Step 3: Implement**, reusing #934's own real `executeSelfOrLinkedEffect`-equivalent effect-creation shape (same origin-context merge, same `agentSelfEffect` tag) but targeting each ally in the recomputed affected set instead of the acting actor itself.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run -t "ally-buff execution"`
Expected: PASS

- [ ] **Step 5: Run the full suite**

Run: `npx vitest run`
Expected: PASS (no regressions in #934's own existing tests)

- [ ] **Step 6: Commit**

```bash
git add docs/superpowers/plans/2026-10-09-ai-npc-self-buff-heal-abilities.md
git commit -m "docs(#981): amend #934's plan -- ally-buff execution, reusing the self-effect creation shape"
```

---

### Task 5: Coverage audit and version bump

**Files:**
- Create: `tests/fixtures/npc-ally-buff-audit.json`
- Create: `tests/npc-ally-buff-coverage.test.mjs`
- Modify: `module.json`

- [ ] **Step 1: Generate the real-population fixture**, scanning the real compendium for ally-naming, non-Strike/save/movement NPC actions, recording `{creature, ability, family | notOffered, reason}` — run for real, not pre-guessed. This is the one place `allyEffectSingle`'s own real positive yield (Investigation finding 2's own open question) gets an honest, measured answer instead of an assumption.
- [ ] **Step 2: Write the ratchet test** (golden-row comparison + monotonic count, #935's pattern).
- [ ] **Step 3: Run the test suite**

Run: `npx vitest run tests/npc-ally-buff-coverage.test.mjs`
Expected: PASS

- [ ] **Step 4: Run the `update-architecture-docs` skill** (no new files — confirm no import-edge changes are missed)
- [ ] **Step 5: Bump `module.json`'s version** (minor — check `main`'s current version first)
- [ ] **Step 6: Commit**

```bash
git add tests/fixtures/npc-ally-buff-audit.json tests/npc-ally-buff-coverage.test.mjs module.json docs/architecture.md
git commit -m "test(#981): real-population coverage audit for ally buffs; chore: bump version"
```

---

## Self-Review

**1. Spec coverage:** Both families (Tasks 1-2), vocabulary (Task 3), execution (Task 4), and the audit/version bump (Task 5) are each covered. Heals (#1056/#1057) and corpse/summon/prose-only abilities are correctly left out.

**2. Placeholder scan:** No "TBD"/"TODO". Task 2's own positive fixture is explicitly labeled synthetic (matching the spec's own stated sentence shape exactly, since no real example this plan's own investigation checked actually qualifies) rather than presented as a real-text confirmation it is not — the honest gap is stated plainly, with the real answer deferred to Task 5's own measured audit.

**3. Type consistency:** `parseSelfAbility`'s `{family, params}` shape (Tasks 1-2) is consumed identically by the vocabulary builder (Task 3) and the executor (Task 4).

**4. Review Focus:** All five bullets (named-fixture exclusion proof, already-has-effect gating, no enemy-avoidance behavior, fresh-recompute at execution, at-least-one-success-before-spending) are each pinned to a named test in Tasks 2, 3, and 4.

**Corrections found while writing this plan:** the single most important correction in this plan was catching that NEITHER of the spec's own two named `allyEffectSingle` examples survives its own stated grammar — found by reading both real texts in full rather than trusting the spec's own short paraphrase of each, the same investigative discipline that has now surfaced an analogous "the spec's own example doesn't fit its own grammar" finding in nearly every issue this planning sequence has covered. This plan resolves it the same honest way each time: state the real texts plainly, exclude them correctly, and defer the real population answer to a measured audit rather than inventing a fit.
