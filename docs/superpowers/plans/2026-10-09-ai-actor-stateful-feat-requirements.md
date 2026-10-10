# Feat Requirements That Need Tracked State Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Track the three pieces of per-feature state (previous-action damage type/weapon, an oath-sworn-against target, an active planned course of action) that Hungry Blade, Enforce Oath, and Nothing Personal each require, and wire real predicate evaluation into #946's own still plan-only vocabulary builder — which, read closely, currently computes these predicates but never checks them against any state at all.

**Architecture:** This plan patches TWO plan-only sibling documents directly (#946's marked-target widening, #934's npcSelf requirements) rather than building a fourth, parallel predicate system — both already stub out overlapping `handFree`/`wielding`/`wearing`/`previousActionWasStrike` predicate shapes and both explicitly flag that whichever lands second should fold them together. Reading Enforce Oath's own real feat text, and the base Champion oath feats it depends on, found the spec's own "a creature category per oath feat, in a reviewed table" design doesn't match any of the four cited real oath feats — none of them name a trait-based target category at all; the oath is always a dynamic, witnessed-event designation against one specific creature, the same kind of in-play fact `courseOfAction` already is.

**Tech Stack:** Vanilla JS (ESM), Foundry VTT API, PF2e system API, Vitest.

**Spec:** `docs/superpowers/specs/2026-10-09-ai-actor-stateful-feat-requirements-design.md`

## Global Constraints

- Closed-world rule: a state predicate is true only if the module itself recorded the state; nothing is guessed or auto-declared (spec's own resolved decision).
- #946 and #934 are still plan-only; Tasks 2-3 patch both documents directly.
- Every merge bumps `module.json`'s version (CLAUDE.md).

## Investigation findings

1. **#946's own vocabulary-building loop (`computeTargetedSelfEffectVocabularyEntries`, that plan's Task 4) parses `requirement.predicates` but never evaluates them — a real gap in the sibling plan, not something #992 can simply "add predicates" onto without fixing first.** The per-opponent loop reads `requirement.needsSight`/`requirement.rangeFeet` and the mark-exclusivity rule, but the `predicates` array `parseMarkedTargetRequirement` returns (`handFree`/`wielding`/`wearing`/`previousActionWasStrike`) is never checked against the actor at all. Left as written, #946 would offer every marked-target feat whose requirement TEXT merely parses, regardless of whether the actor is actually in the required state. Task 3 patches this loop directly.
2. **`previousActionWasStrike` is already a stubbed predicate type in #946's plan, but as a bare boolean with no weapon/damage-type refinement — and #946's own recognizer regex, read against Hungry Blade's real text, would silently drop that refinement rather than reject it.** #946's parser matches on the substring `/\byour previous action was a strike\b/i`; Hungry Blade's real text ("Your previous action was a Strike with your spectral dagger that dealt spirit damage") contains that exact substring, so #946's own regex would match and emit a bare `{type: "previousActionWasStrike"}`, silently losing the weapon/damage qualifiers rather than rejecting the ability outright. Task 3 widens the SAME predicate type with optional `weaponSlug`/`damageType` fields captured from the trailing clause, rather than adding a second, parallel predicate name.
3. **The spec's own `swornOathAgainst`/`OATH_CATEGORY_BY_FEAT` design — a static table mapping an oath feat to a trait-based target category — does not match any of its own four cited oath feats, confirmed by reading all four real texts.** Vengeful Oath and Oath of the Avenger (the base Champion causes) are both witnessed-event designations: "When you see a creature harm an ally... you can invoke your oath against **that creature**" (Oath of the Avenger) — a specific creature, chosen in play, not a trait category. Sacred Wilds Oath (Spirit Warrior) is a protective edict toward nature spirits with no hostile-target category at all. Kaiju Defense Oath is keyed to creature SIZE ("at least 2 sizes larger than you"), not a trait. None of the four supports a static feat→trait lookup. Task 1 tracks `oathSwornAgainst` as dynamic, witnessed-event state — the same kind of in-play fact `courseOfAction` already is — rather than building a table that cannot correctly describe any of its own cited examples.
4. **No existing code tracks "has this opponent harmed an ally," the real trigger Oath of the Avenger's own text requires before a champion can invoke against a creature.** Task 1 adds this as a minimal, natural extension of the already-proven `applyDamage` call site (confirmed used throughout `scripts/dungeon-combat.mjs`): recording the attacking combatant's token uuid in a per-combat set the first time its damage lands on a party-side target, rather than inventing a parallel damage-observation subsystem.
5. **#934's plan already has a working predicate evaluator** (`evaluateSelfRequirements(predicates, actor, opponents)`, that plan's own code, covering `handFree`/`wielding`/`wearing`/`hasCondition`/`notHasCondition`/`enemyWithin`) that #946's own plan explicitly flags as needing to be folded together with its own duplicate predicate set once either lands. Task 2 does that folding now, in the one plan that actually needs both sets evaluated for real, rather than leaving the flagged duplication for a future, unscheduled cleanup.

## Review Focus

- The folded predicate evaluator (Task 2) must produce IDENTICAL results to #934's own existing `evaluateSelfRequirements` for every predicate type that plan already covers — this is a consolidation, not a rewrite, and a subtle behavior change here would silently affect #934's own `npcSelf` family too (Investigation finding 5; Task 2's test).
- `previousActionWasStrike`'s weapon/damage refinement (Investigation finding 2) must require BOTH qualifiers when both are stated in the text — a Strike with the spectral dagger that dealt a DIFFERENT damage type (e.g., it also deals piercing on a hit, but the spirit-damage rider didn't trigger) must not satisfy Hungry Blade's own requirement (spec's own stated text; Task 3's test).
- `oathSwornAgainst` must be checked against the SPECIFIC creature named by the Enforce Oath candidate's own target, not "any oath-sworn creature is currently visible somewhere" — Enforce Oath's real text selects "one creature," and offering it against a creature the actor hasn't actually invoked their oath against would violate the closed-world rule just as surely as the spec's own rejected "let the AI declare state it did not earn" alternative (Investigation finding 3; Task 4's test).
- `hasHarmedAlly` must be scoped per combat and cleared at combat end, matching every other tracked-state lifetime in this plan — a stale record from an earlier, unrelated encounter must never let an "Invoke Oath" opportunity persist into a new fight (Investigation finding 4; Task 1's test).
- `courseOfAction`'s "cleared when the feature's own ending event occurs" rule must still correctly report `false` for a Nothing Personal-dependent feat even when the underlying planning action was never actually executable by this build (spec's own stated "the state is never set" fallback; Task 1's test).

---

### Task 1: Tracked state

**Files:**
- Create: `scripts/agent-feature-state.mjs`
- Test: `tests/agent-feature-state.test.mjs`

**Interfaces:**
- Produces: `recordPreviousAction(combat, combatantId, {kind, weaponSlug?, damageTypes?})`, `getPreviousAction(combat, combatantId)` (returns `{kind: "other"}` for a new turn or no record); `setCourseOfAction(combat, combatantId, {active, source})`, `getCourseOfAction(combat, combatantId)`; `recordHarmToAlly(combat, attackerTokenUuid)`, `hasHarmedAlly(combat, tokenUuid)`; `setOathSwornAgainst(combat, combatantId, targetTokenUuid)`, `getOathSwornAgainst(combat, combatantId)`. All stored on `combat.getFlag(MODULE_ID, "agentFeatureState")`, cleared at combat end alongside `agentTurnState`.

- [ ] **Step 1: Write the failing tests**

```js
describe("previousAction (#992)", () => {
  it("records a strike's weapon slug and damage types dealt", async () => { /* ... */ });
  it("returns {kind: 'other'} for a combatant with no record, or at the start of a new turn (Review Focus pattern: fresh per turn)", async () => { /* ... */ });
});

describe("courseOfAction (#992)", () => {
  it("records active=true with a source when set, false when cleared", async () => { /* ... */ });
  it("reports false (never guessed true) when nothing was ever recorded", async () => { /* ... */ });
});

describe("hasHarmedAlly (#992, Investigation finding 4)", () => {
  it("records a hostile combatant's token uuid the first time its damage lands on a party-side target", async () => { /* ... */ });
  it("is scoped per combat and cleared at combat end (Review Focus)", async () => { /* ... */ });
});

describe("oathSwornAgainst (#992, Investigation finding 3)", () => {
  it("records the specific target token uuid a combatant invoked their oath against", async () => { /* ... */ });
  it("reports null when nothing was invoked", async () => { /* ... */ });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/agent-feature-state.test.mjs`
Expected: FAIL (module does not exist)

- [ ] **Step 3: Implement.** Wire `recordHarmToAlly` into the real, confirmed `applyDamage` call sites in `scripts/dungeon-combat.mjs` (every place this module applies damage from one combatant to another) — a one-line addition after a successful application, guarded so it never throws into the damage path itself. Wire `recordPreviousAction` into the end of each Strike-resolution path (`rollAndApplyStrikeAtVariant` and any other confirmed Strike executor), reading the damage types actually dealt from the roll result per #925's descriptor, and reset to `{kind: "other"}` at the start of each combatant's own turn (the same turn-start hook `initAgentTurnState` already runs from).

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/agent-feature-state.test.mjs`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add scripts/agent-feature-state.mjs scripts/dungeon-combat.mjs tests/agent-feature-state.test.mjs
git commit -m "feat(#992): track previousAction, courseOfAction, hasHarmedAlly, and oathSwornAgainst state"
```

---

### Task 2: The shared predicate evaluator

**Files:**
- Modify: `docs/superpowers/plans/2026-10-09-ai-npc-self-buff-heal-abilities.md` (export `evaluateSelfRequirements` rather than keeping it module-private, per Investigation finding 5)
- Create: `scripts/feat-requirement-predicates.mjs`
- Test: `tests/feat-requirement-predicates.test.mjs`

**Interfaces:**
- Produces: `evaluateRequirementPredicates(predicates, actor, opponents, combat, combatantId)` → `boolean`, covering `handFree`/`wielding`/`wearing`/`hasCondition`/`notHasCondition`/`enemyWithin` (ported unchanged from #934's own `evaluateSelfRequirements`) plus `previousActionWasStrike({weaponSlug?, damageType?})`, `courseOfActionActive()`, and `swornOathAgainst({targetTokenUuid})`.

- [ ] **Step 1: Write the failing tests**

```js
describe("evaluateRequirementPredicates, ported predicates (#992, Review Focus: identical to #934's own)", () => {
  it("matches #934's own handFree/wielding/wearing/hasCondition/notHasCondition/enemyWithin behavior exactly, including its error-swallowing (return false, never throw)", () => { /* ... */ });
});

describe("previousActionWasStrike with refinement (#992, Investigation finding 2, Review Focus)", () => {
  it("requires BOTH weaponSlug and damageType when both are stated -- a Strike with the right weapon but a different damage type does not match", () => { /* ... */ });
  it("a bare previousActionWasStrike (no refinement) matches any Strike, preserving #946's own existing behavior for feats without a qualifier", () => { /* ... */ });
});

describe("courseOfActionActive (#992)", () => {
  it("true only when getCourseOfAction reports active", () => { /* ... */ });
});

describe("swornOathAgainst (#992, Investigation finding 3, Review Focus)", () => {
  it("true only when getOathSwornAgainst's recorded target matches the predicate's own targetTokenUuid exactly", () => { /* ... */ });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/feat-requirement-predicates.test.mjs`
Expected: FAIL (module does not exist)

- [ ] **Step 3: Implement**, porting #934's own `evaluateSelfRequirements` body verbatim for the six predicate types it already covers (confirming no behavior drift), then adding the three new/refined ones using Task 1's state readers.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/feat-requirement-predicates.test.mjs`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add docs/superpowers/plans/2026-10-09-ai-npc-self-buff-heal-abilities.md scripts/feat-requirement-predicates.mjs tests/feat-requirement-predicates.test.mjs
git commit -m "feat(#992): fold #934's and #946's duplicate predicate sets into one shared evaluator"
```

---

### Task 3: Patch #946's plan — the missing evaluation step and the widened recognizer

**Files:**
- Modify: `docs/superpowers/plans/2026-10-09-ai-actor-marked-target-widening.md` (`parseMarkedTargetRequirement`, `computeTargetedSelfEffectVocabularyEntries`)
- Test: that plan's own parser and vocabulary test files

- [ ] **Step 1: Write the failing tests**

```js
describe("parseMarkedTargetRequirement, weapon/damage refinement (#992, Investigation finding 2)", () => {
  it("captures Hungry Blade's weapon and damage-type qualifiers onto the SAME previousActionWasStrike predicate type (real text)", () => {
    const requirement = parseMarkedTargetRequirement("<p><strong>Requirements</strong> Your previous action was a Strike with your spectral dagger that dealt spirit damage.</p>");
    expect(requirement.predicates).toContainEqual({ type: "previousActionWasStrike", weaponSlug: "spectral-dagger", damageType: "spirit" });
  });

  it("keeps the bare predicate for text with no weapon/damage qualifier, unchanged from #946's own original behavior", () => { /* ... */ });

  it("recognizes 'an active course of action planned' into courseOfActionActive (Nothing Personal, real text)", () => {
    const requirement = parseMarkedTargetRequirement("<p><strong>Requirements</strong> You have an active course of action planned.</p>");
    expect(requirement.predicates).toContainEqual({ type: "courseOfActionActive" });
  });

  it("recognizes 'a creature you've sworn an oath against' into swornOathAgainst (Enforce Oath, real text)", () => {
    const requirement = parseMarkedTargetRequirement("<p><strong>Requirements</strong> You can see a creature you've sworn an oath against.</p>");
    expect(requirement.predicates).toContainEqual({ type: "swornOathAgainst" });
  });
});

describe("computeTargetedSelfEffectVocabularyEntries actually evaluates predicates (#992, Investigation finding 1)", () => {
  it("drops an entry whose predicates are not currently satisfied (Review Focus: this is the fix for the real gap found this session)", async () => {
    // A feat parsed with {type: "previousActionWasStrike", weaponSlug:
    // "spectral-dagger", damageType: "spirit"} on an actor whose
    // getPreviousAction reports {kind: "other"} -> no entry offered.
  });
  it("offers the entry once the required state is actually recorded", async () => { /* ... */ });
  it("checks swornOathAgainst per-target, inside the per-opponent loop, not once for the whole feat (Review Focus)", async () => {
    // Two opponents visible; oathSwornAgainst names only one of them ->
    // exactly one entry, for that opponent.
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run -t "weapon/damage refinement"` and `-t "actually evaluates predicates"`
Expected: FAIL (the refinement isn't captured; the loop never checks predicates at all today)

- [ ] **Step 3: Implement.** Widen the recognizer's `previousActionWasStrike` match to optionally capture a trailing `with your <weapon>` and/or `that dealt <damage type> damage` clause onto the same predicate object; add the two new closed phrases for `courseOfActionActive`/`swornOathAgainst`. In the per-opponent loop, after the existing sight/range checks, add: for every predicate EXCEPT `swornOathAgainst`, call Task 2's `evaluateRequirementPredicates` once per feat (not per opponent, since these don't depend on the opponent); for `swornOathAgainst`, check it per opponent inside the loop (`getOathSwornAgainst(combat, combatant.id) === opponentTokenUuid`), since Enforce Oath's own target IS the oath-sworn creature, not a feat-level gate.

- [ ] **Step 4: Run the tests to verify they pass, then the full suite for that plan**

Run: `npx vitest run tests/dungeon-combat-targeted-feat-vocabulary.test.mjs` (or wherever #946's own tests live) plus the full suite.
Expected: PASS, including #922's own original Hunt Prey/Devise tests (neither carries a `predicates` entry today, so the new check is a no-op for them).

- [ ] **Step 5: Commit**

```bash
git add docs/superpowers/plans/2026-10-09-ai-actor-marked-target-widening.md
git commit -m "docs(#992): amend #946's plan -- widen previousActionWasStrike, add courseOfActionActive/swornOathAgainst, and fix the missing predicate-evaluation step"
```

---

### Task 4: The Invoke Oath opportunity

**Files:**
- Modify: `scripts/agent-candidates.mjs` (a new, lightweight candidate kind)
- Modify: `scripts/dungeon-combat.mjs` (vocabulary/execution wiring)
- Test: `tests/agent-candidates.test.mjs`, `tests/dungeon-combat-invoke-oath.test.mjs`

- [ ] **Step 1: Write the failing tests**

```js
describe("Invoke Oath candidate (#992, Investigation finding 3/4)", () => {
  it("is offered, cost 0, for a visible opponent recorded in hasHarmedAlly, when the actor has any champion oath feat", async () => { /* ... */ });
  it("is not offered for an opponent that has not yet harmed an ally", async () => { /* ... */ });
  it("is not offered again for a creature already oathSwornAgainst", async () => { /* ... */ });
  it("executing it sets oathSwornAgainst to the chosen target and spends no action (Review Focus: matches the real text's 'doesn't require an action')", async () => { /* ... */ });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/dungeon-combat-invoke-oath.test.mjs`
Expected: FAIL (not implemented yet)

- [ ] **Step 3: Implement**, gating on the actor having ANY feat in a small, reviewed `CHAMPION_OATH_FEATS` set (confirmed real slugs: `vengeful-oath`, `oath-of-the-avenger`, `sacred-wilds-oath`, `kaiju-defense-oath`, and any other oath-granting feat the audit in Task 5 finds) — the set only gates WHO can invoke an oath at all; it does not derive a trait category, consistent with Investigation finding 3.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/dungeon-combat-invoke-oath.test.mjs`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add scripts/agent-candidates.mjs scripts/dungeon-combat.mjs tests/agent-candidates.test.mjs tests/dungeon-combat-invoke-oath.test.mjs
git commit -m "feat(#992): a zero-cost Invoke Oath opportunity against a creature that has harmed an ally"
```

---

### Task 5: Requirement audit and version bump

**Files:**
- Create: `tools/audit-feat-requirements.mjs`
- Create: `tests/fixtures/stateful-feat-requirements-audit.json`
- Create: `tests/stateful-feat-requirements-coverage.test.mjs`
- Modify: `module.json`

- [ ] **Step 1: Run the audit** over #946's own `marked`-classified population, classifying each feat's requirement text as (a) already in #946's closed set, (b) now covered by one of this plan's state predicates, or (c) unsupported; confirm the full real list of Champion/archetype oath-granting feats for `CHAMPION_OATH_FEATS` (Task 4) rather than trusting the spec's own four cited examples as exhaustive.
- [ ] **Step 2: Write the ratchet test** (golden-row comparison + monotonic count, #935's pattern).
- [ ] **Step 3: Run the test suite**

Run: `npx vitest run tests/stateful-feat-requirements-coverage.test.mjs`
Expected: PASS

- [ ] **Step 4: Run the `update-architecture-docs` skill** (new files: `scripts/agent-feature-state.mjs`, `scripts/feat-requirement-predicates.mjs`, `tools/audit-feat-requirements.mjs`)
- [ ] **Step 5: Bump `module.json`'s version** (minor — check `main`'s current version first)
- [ ] **Step 6: Commit**

```bash
git add tools/audit-feat-requirements.mjs tests/fixtures/stateful-feat-requirements-audit.json tests/stateful-feat-requirements-coverage.test.mjs module.json docs/architecture.md
git commit -m "test(#992): requirement audit and coverage ratchet; chore: bump version"
```

---

## Self-Review

**1. Spec coverage:** Tracked state (Task 1), the shared predicate evaluator (Task 2), the three new/refined predicates wired into #946's own loop (Task 3), the dynamic oath-invocation mechanism (Task 4), and the audit/version bump (Task 5) each cover a spec section.

**2. Placeholder scan:** No "TBD"/"TODO". Task 5's own step explicitly treats the spec's cited oath-feat list as a starting point to verify, not a closed set to trust unchecked.

**3. Type consistency:** The `previousActionWasStrike`/`courseOfActionActive`/`swornOathAgainst` predicate shapes introduced in Task 3 are read identically by Task 2's evaluator; Task 1's state-reader function signatures (`getPreviousAction`, `getCourseOfAction`, `getOathSwornAgainst`, `hasHarmedAlly`) are called with the same arguments everywhere Tasks 2-4 use them.

**4. Review Focus:** All five bullets (evaluator parity with #934, both-qualifiers-required for Hungry Blade, per-target oath checking, per-combat `hasHarmedAlly` scoping, `courseOfAction`'s never-set fallback) are each pinned to a named test in Tasks 1-4.

**Corrections found while writing this plan:** by far the most consequential is Investigation finding 3 — the spec's own `OATH_CATEGORY_BY_FEAT` design doesn't match any of its own four cited real oath feats; all four are either witnessed-event designations against one specific creature or aren't about a hostile target category at all. Building the spec's static-table design as written would have produced a feature that silently never offers Enforce Oath correctly for any of the feats the spec itself used to justify it. The second is Investigation finding 1 — #946's own plan already parses the predicates this issue needs to add, but never evaluates any of them against live state at all; #992 cannot "add predicates" to a check that doesn't run, so this plan fixes that gap as a prerequisite rather than building on top of a check that silently does nothing.
