# Magus and Gunslinger Feat Actions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the magus and gunslinger classes AI access to their feats by tracking two new pieces of state this module currently has no record of at all — a Spellstrike charge, and per-weapon firearm/crossbow loaded state — then adding both classes to #947's `FEAT_ACTION_CLASS_SET` with Spellstrike and reload themselves offered as candidates.

**Architecture:** This plan patches THREE still plan-only sibling documents (#947's shapes/override table, #934's/#992's now-shared requirement-predicate evaluator) rather than inventing a fourth predicate location. Live verification against the installed system found the spec's own biggest architectural claim is not just accurate but more absolute than stated: `Spellstrike` appears nowhere at all in the installed `pf2e.mjs` — the system has no dedicated Spellstrike activity code whatsoever, confirming this state must be entirely module-owned. The spec also cites `twoHanded`/`wieldingTrait` predicates that, like several other specs planned this session, don't actually exist in any upstream plan.

**Tech Stack:** Vanilla JS (ESM), Foundry VTT API, PF2e system API, Vitest.

**Spec:** `docs/superpowers/specs/2026-10-09-ai-actor-magus-gunslinger-feat-actions-design.md`

## Global Constraints

- Closed-world rule (as #992): unknown state is false, the feat is not offered.
- #947, #934/#992's shared evaluator are still plan-only; Tasks 2, 4, and 6 patch those documents directly.
- Shapes first, overrides for the rest, as #947 (spec's own resolved decision 4).
- Every merge bumps `module.json`'s version (CLAUDE.md).

## Investigation findings

1. **The installed system has literally no Spellstrike code at all — not merely "descriptive," as the spec says, but entirely absent.** Searching the full installed `pf2e.mjs` for the string `Spellstrike` returns zero matches; the real `class-features/spellstrike.json` item grants only a plain compendium action activity (`GrantItem` → `Compendium.pf2e.actionspf2e.Item.Spellstrike`) with no rule element tracking a charge, a stored spell, or anything else. This confirms the spec's own architecture choice (module-owned state) is not just the right call but the only possible one — there is no partial system mechanism to build on top of.
2. **`system.ammo` on a raw compendium weapon item carries no live `.value` field at all — confirmed on the real Flintlock Pistol** (`{baseType, builtIn, capacity}`, no `value`). This matches the pattern already confirmed earlier in this same planning arc (#979's armor-hardness investigation): a compendium source item's derived fields are filled in only by the system's own data preparation on a LIVE, actor-owned instance. Task 5's ammo reads must always go through a live, equipped weapon item on the actual actor, never a bare compendium reference, exactly as #979 already established for armor.
3. **The spec cites `#934's twoHanded/wieldingTrait predicates` — neither exists in any upstream plan, confirmed by grepping #934's, #946's, and #947's plan documents directly.** This is the same kind of citation gap found repeatedly elsewhere this session (#984's `applyTimedCondition`, #987's `applyTimedEffect`, #988's `applyOutcomeEffects`). #992's plan (written earlier in this same session) already consolidated #934's and #946's duplicate predicate sets into one shared module, `scripts/feat-requirement-predicates.mjs` — Task 2 adds the needed wielding predicates and Spellstrike predicates there, continuing that consolidation rather than opening a fourth location for predicate logic.
4. **Spell Swipe's own real text (`feats/class/magus/level-8/spell-swipe.json`) is genuinely bespoke** — "roll separate Strikes to attack two creatures... counts as two attacks for your multiple attack penalty, but the penalty doesn't increase until after you make both attacks... If you're using a weapon that has the sweep trait, its circumstance bonus applies against both targets" — confirming the spec's own call to put Spellstrike-variant feats in the override table rather than force them through a generic shape.
5. **The real Spellstrike class feature text's own "Requirements: Your Spellstrike is charged" phrasing (confirmed on Spell Swipe) matches the spec's proposed `spellstrikeCharged()` predicate exactly** — no correction needed for this specific phrase.

## Review Focus

- A Spellstrike charge recorded against one spell must not silently satisfy a feat that names a specific trait, save type, or attack-roll requirement for a DIFFERENT spell — `spellstrikeChargedWith({trait?, save?, attack?})` must check the actual stored spell's own real traits/save/attack-roll flag, not just "is anything charged" (spec's own stated predicate shape; Task 2's test).
- Ammo state must be re-read from the live, equipped weapon at EXECUTION time, not trusted from vocabulary-build time — a weapon that was loaded when candidates were built but got unloaded (fired by a prior action this same turn, in a multi-action sequence) must still correctly block a second Strike (Investigation finding 2; Task 5's test).
- A reload candidate must never be offered for a weapon that is already fully loaded, and must respect the weapon's own real `reload` cost (not a flat guess) — a weapon with `reload: "2"` must cost 2 actions to reload, not #947's usual single-action default (spec's own stated rule; Task 5's test).
- Spell Swipe's own "the penalty doesn't increase until after you make both attacks" MAP rule must be modeled correctly in its override entry — a naive implementation that increases MAP after the FIRST of the two Strikes would make the second Strike weaker than the real rule allows (Investigation finding 4; Task 4's test).
- `FEAT_ACTION_CLASS_SET`'s widening to include `magus`/`gunslinger` must not accidentally let through a feat from either class whose requirement text falls outside the closed set (e.g., a feat with a trigger condition this plan doesn't track) — the shape/override classification, not mere class membership, must still gate every entry (spec's own "shapes first, overrides for the rest" rule; Task 6's test).

---

### Task 1: Spellstrike state

**Files:**
- Modify: `scripts/agent-feature-state.mjs` (from #992's plan)
- Test: `tests/agent-feature-state.test.mjs`

**Interfaces:**
- Produces: `setSpellstrikeCharge(combat, combatantId, {spellId, spellRank, recharged})`, `getSpellstrikeCharge(combat, combatantId)` → `{charged: boolean, spellId?, spellRank?, castRound?, castTurn?}`, `clearSpellstrikeCharge(combat, combatantId)`.

- [ ] **Step 1: Write the failing tests**

```js
describe("Spellstrike charge state (#997)", () => {
  it("records charged=true with the stored spell's id and rank when set", async () => { /* ... */ });
  it("reports charged=false when nothing was ever recorded (closed-world)", async () => { /* ... */ });
  it("clears when the stored Strike is made", async () => { /* ... */ });
  it("expires at the end of the magus's own turn per RAW, even if never spent", async () => { /* ... */ });
  it("is cleared at combat end alongside the rest of agentFeatureState", async () => { /* ... */ });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/agent-feature-state.test.mjs -t "Spellstrike charge"`
Expected: FAIL (functions don't exist yet)

- [ ] **Step 3: Implement**, storing the record under `agentFeatureState.spellstrike` per combatant (the same flag and lifetime #992's plan already established for `previousAction`/`courseOfAction`), with the turn-end expiry hooked into the same turn-boundary point #992's own `previousAction` reset already uses.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/agent-feature-state.test.mjs`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add scripts/agent-feature-state.mjs tests/agent-feature-state.test.mjs
git commit -m "feat(#997): track a magus's Spellstrike charge, set/spent/expired/cleared"
```

---

### Task 2: Spellstrike and firearm predicates

**Files:**
- Modify: `scripts/feat-requirement-predicates.mjs` (from #992's plan)
- Test: `tests/feat-requirement-predicates.test.mjs`

**Interfaces:**
- Produces: adds `spellstrikeCharged()`, `spellstrikeChargedWith({trait?, save?, attack?})`, `wieldingFirearm()`, `wieldingCrossbow()`, `twoHandedFirearm()` to `evaluateRequirementPredicates`.

- [ ] **Step 1: Write the failing tests**

```js
describe("spellstrikeCharged / spellstrikeChargedWith (#997, Review Focus)", () => {
  it("spellstrikeCharged is true only when getSpellstrikeCharge reports charged", () => { /* ... */ });
  it("spellstrikeChargedWith checks the ACTUAL stored spell's own traits/save/attack-roll flag, not just that something is charged", async () => {
    // charged with a Fireball-shaped spell (attack-roll: false, save:
    // "reflex") -> spellstrikeChargedWith({attack: true}) is false.
  });
});

describe("firearm wielding predicates (#997, Investigation finding 3)", () => {
  it("wieldingFirearm/wieldingCrossbow check the actor's currently wielded weapon's own group", () => { /* ... */ });
  it("twoHandedFirearm requires both wieldingFirearm and the weapon's own two-hand usage", () => { /* ... */ });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/feat-requirement-predicates.test.mjs -t "spellstrikeCharged"` and `-t "firearm wielding"`
Expected: FAIL (predicates don't exist yet)

- [ ] **Step 3: Implement**, reading the wielded weapon's own real `system.group`/`system.usage.value` fields (confirmed real shape from the Flintlock Pistol: `usage.value === "held-in-one-hand"`) for the wielding checks, and Task 1's `getSpellstrikeCharge` plus a stored-spell lookup for the Spellstrike checks.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/feat-requirement-predicates.test.mjs`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add scripts/feat-requirement-predicates.mjs tests/feat-requirement-predicates.test.mjs
git commit -m "feat(#997): spellstrikeCharged(With)/wieldingFirearm/wieldingCrossbow/twoHandedFirearm predicates"
```

---

### Task 3: Spellstrike as a candidate

**Files:**
- Modify: `scripts/agent-candidates.mjs` (new `spellstrike` feat kind)
- Modify: `scripts/dungeon-combat.mjs` (vocabulary/execution wiring)
- Test: `tests/agent-candidates.test.mjs`, `tests/dungeon-combat-spellstrike.test.mjs`

- [ ] **Step 1: Write the failing tests**

```js
describe("Spellstrike vocabulary (#997)", () => {
  it("offers one entry per (weapon, spell, target) for a legal melee Strike, a one-action attack-roll or save spell with a single target, and a target in reach with line of sight", async () => { /* ... */ });
  it("excludes a spell on the reviewed exclusion list", async () => { /* ... */ });
});

describe("Spellstrike execution (#997)", () => {
  it("spends the spell slot (or cantrip use), makes the Strike, and applies the spell's effect on a hit via the existing spell executor (#909)", async () => { /* ... */ });
  it("counts MAP once for the combined activity, not once for the Strike and once for the spell", async () => { /* ... */ });
  it("records spellstrike.charged = false after the stored Strike is made, unless a conflux/feat in play says otherwise", async () => { /* ... */ });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/dungeon-combat-spellstrike.test.mjs`
Expected: FAIL (not implemented yet)

- [ ] **Step 3: Implement**, reusing the existing spell-casting executor (#909) for slot use, rank and damage, and the existing Strike executor for the attack roll, per PF2e's own real Spellstrike rules text (One Target, Reach, Ancillary Effects, Variable Actions — all confirmed real and quoted in Investigation finding 1's source item).

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/agent-candidates.test.mjs tests/dungeon-combat-spellstrike.test.mjs`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add scripts/agent-candidates.mjs scripts/dungeon-combat.mjs tests/agent-candidates.test.mjs tests/dungeon-combat-spellstrike.test.mjs
git commit -m "feat(#997): Spellstrike as an AI candidate, reusing the existing spell and Strike executors"
```

---

### Task 4: Magus feat coverage

**Files:**
- Modify: `docs/superpowers/plans/2026-10-09-ai-actor-targeted-feat-actions-no-selfeffect.md` (`FEAT_ACTION_CLASS_SET`, `FEAT_ACTION_OVERRIDES`)
- Test: that plan's own override-table test file

- [ ] **Step 1: Write the failing tests**

```js
describe("magus FEAT_ACTION_CLASS_SET and overrides (#997)", () => {
  it("adds magus to FEAT_ACTION_CLASS_SET", () => { /* ... */ });
  it("Spell Swipe's override models two Strikes with a single shared MAP increase after both (Investigation finding 4, Review Focus)", async () => { /* ... */ });
  it("Distracting/Shattering/Devastating/Lunging/Meteoric Spellstrike each have a reviewed override naming the base spellstrike entry plus the modifier, with a fixture hash against the real item text", () => { /* ... */ });
  it("charge-dependent feats (Spell Swipe, Cascading Ray, Arcane Shroud, Whirlwind Spell) require spellstrikeCharged and are hidden when uncharged", async () => { /* ... */ });
  it("Rapid Recharge/Maelstrom Flow/Sustaining Steel set spellstrike.charged through their own descriptor", async () => { /* ... */ });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run -t "magus FEAT_ACTION_CLASS_SET"`
Expected: FAIL (magus not in the class set; no overrides exist)

- [ ] **Step 3: Implement**, adding `magus` to `FEAT_ACTION_CLASS_SET` and writing the reviewed override entries per Investigation finding 4's own confirmed-complex Spell Swipe text and the real text of each other named feat (read during implementation, not guessed).

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run -t "magus FEAT_ACTION_CLASS_SET"`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add docs/superpowers/plans/2026-10-09-ai-actor-targeted-feat-actions-no-selfeffect.md
git commit -m "docs(#997): amend #947's plan -- magus added to the class set, Spellstrike-variant and charge-dependent feat overrides"
```

---

### Task 5: Firearm/ammo state and reload candidates

**Files:**
- Create: `scripts/firearm-state.mjs`
- Modify: `scripts/agent-candidates.mjs` (new `reload` feat kind)
- Modify: `scripts/dungeon-combat.mjs` (vocabulary/execution wiring, the Strike candidate builder's existing unloaded-weapon check)
- Test: `tests/firearm-state.test.mjs`, `tests/dungeon-combat-reload.test.mjs`

- [ ] **Step 1: Write the failing tests**

```js
describe("ammoLoaded (#997, Investigation finding 2, Review Focus)", () => {
  it("reads system.ammo.value from the LIVE, equipped weapon item on the actor, never from a bare compendium reference", () => { /* ... */ });
  it("a capacity weapon's current chamber reads the same way", () => { /* ... */ });
});

describe("reload candidates (#997, Review Focus)", () => {
  it("is offered only when the wielded weapon is unloaded and the actor can afford its own real reload cost", async () => {
    // A weapon with reload: "2" costs 2 actions, not a flat 1.
  });
  it("the gunslinger free-reload feats (Risky Reload, Ostentatious Reload, Running Reload, ...) appear as their own targetedAction entries with the feat's own real cost/trigger text", async () => { /* ... */ });
});

describe("reload execution (#997)", () => {
  it("increments system.ammo.value and consumes an ammo item when the weapon isn't builtIn", async () => { /* ... */ });
  it("re-checks the weapon's current ammo at execution time, aborting if it was already reloaded or the weapon changed (Review Focus)", async () => { /* ... */ });
});

describe("Strike candidates respect ammo (#997)", () => {
  it("extends the existing unloaded-firearm Strike exclusion to capacity weapons", async () => { /* ... */ });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/firearm-state.test.mjs tests/dungeon-combat-reload.test.mjs`
Expected: FAIL (module/candidates don't exist yet)

- [ ] **Step 3: Implement**, reading `weapon.system.ammo.value`/`.capacity`/`.builtIn` directly off the actor's own equipped item (never a `fromUuid` compendium lookup), and the weapon's own real `system.reload.value` for the action cost.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/firearm-state.test.mjs tests/dungeon-combat-reload.test.mjs`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add scripts/firearm-state.mjs scripts/agent-candidates.mjs scripts/dungeon-combat.mjs tests/firearm-state.test.mjs tests/dungeon-combat-reload.test.mjs
git commit -m "feat(#997): firearm ammo state read from live items, reload candidates at the weapon's own real cost"
```

---

### Task 6: Gunslinger feat coverage

**Files:**
- Modify: `docs/superpowers/plans/2026-10-09-ai-actor-targeted-feat-actions-no-selfeffect.md` (`FEAT_ACTION_CLASS_SET`, `strikePlus` generalized to ranged weapons, `FEAT_ACTION_OVERRIDES`)
- Test: that plan's own shape/override test files

- [ ] **Step 1: Write the failing tests**

```js
describe("gunslinger FEAT_ACTION_CLASS_SET and strikePlus for ranged weapons (#997)", () => {
  it("adds gunslinger to FEAT_ACTION_CLASS_SET", () => { /* ... */ });
  it("flourish-trait gunslinger feats (Risky Reload, Cauterize, Called Shot, Triggerbrand Salvo, Bullet Split) check notUsedFlourishThisTurn, unchanged from #947's own existing turn-state check", async () => { /* ... */ });
  it("press-trait feats require previousActionWasStrike (#946/#992), reusing the shared evaluator from Task 2", async () => { /* ... */ });
  it("Phalanx Breaker, Dazzling Bullet, Paired Shots, Penetrating Fire, Twin Shot Knockdown parse through strikePlus generalized to range increment/ammo cost/reload interaction", async () => { /* ... */ });
  it("Scatter Blast and Trick Shot (bespoke text) go through the override table instead, with a fixture hash", async () => { /* ... */ });
  it("every ranged strikePlus/override entry's execution spends ammo, aborting if the weapon runs out mid-resolution (Review Focus, consistent with Task 5)", async () => { /* ... */ });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run -t "gunslinger FEAT_ACTION_CLASS_SET"`
Expected: FAIL (gunslinger not in the class set; strikePlus isn't generalized to ranged weapons)

- [ ] **Step 3: Implement**, adding `gunslinger` to `FEAT_ACTION_CLASS_SET`, generalizing `strikePlus`'s weapon requirement to accept a ranged weapon with its own range increment/ammo considerations, and writing the override entries for the bespoke-text feats (confirmed during implementation against each real item, not guessed).

- [ ] **Step 4: Run the tests to verify they pass, then the full suite**

Run: `npx vitest run` (the full #947 plan's own test files, plus Tasks 1-5's)
Expected: PASS, no regressions in the nine-class first slice's own existing melee `strikePlus` feats.

- [ ] **Step 5: Commit**

```bash
git add docs/superpowers/plans/2026-10-09-ai-actor-targeted-feat-actions-no-selfeffect.md
git commit -m "docs(#997): amend #947's plan -- gunslinger added to the class set, ranged strikePlus, flourish/press chains, and overrides"
```

---

### Task 7: Coverage audit and version bump

**Files:**
- Create: `tests/fixtures/magus-gunslinger-audit.json`
- Create: `tests/magus-gunslinger-coverage.test.mjs`
- Modify: `module.json`

- [ ] **Step 1: Generate the real-population fixture**, scanning the real compendium for the ~19 magus and ~40 gunslinger activatable, no-`selfEffect` feats/actions the spec's own Investigation findings counted, confirming that count for real and classifying each as shape-covered, override-covered, or unsupported.
- [ ] **Step 2: Write the ratchet test** (golden-row comparison + monotonic count, #935's pattern).
- [ ] **Step 3: Run the test suite**

Run: `npx vitest run tests/magus-gunslinger-coverage.test.mjs`
Expected: PASS

- [ ] **Step 4: Run the `update-architecture-docs` skill** (new files: `scripts/firearm-state.mjs`)
- [ ] **Step 5: Bump `module.json`'s version** (minor — check `main`'s current version first)
- [ ] **Step 6: Commit**

```bash
git add tests/fixtures/magus-gunslinger-audit.json tests/magus-gunslinger-coverage.test.mjs module.json docs/architecture.md
git commit -m "test(#997): coverage audit for magus and gunslinger feats; chore: bump version"
```

---

## Self-Review

**1. Spec coverage:** Spellstrike state (Task 1), the new predicates (Task 2), Spellstrike as a candidate (Task 3), magus feat coverage (Task 4), firearm/ammo state and reload (Task 5), gunslinger feat coverage (Task 6), and the audit/version bump (Task 7) each cover a spec section. Non-magus Spellstrike users (#998) and human-player reload/Spellstrike stay explicitly out of scope.

**2. Placeholder scan:** No "TBD"/"TODO". Tasks 4 and 6's own override steps explicitly say "confirmed during implementation against each real item, not guessed" for the long tail, consistent with how #984's/#987's own similarly large plans handled their own long tails — an honest deferral of specific override text, not of the design itself.

**3. Type consistency:** The Spellstrike charge record (Task 1) is read identically by Task 2's predicates and Task 3's candidate/executor; the ammo-reading convention established in Task 5 (always a live item, never a compendium reference) is restated and relied on by Task 6's ranged `strikePlus` execution.

**4. Review Focus:** All five bullets (spell-specific charge matching, fresh ammo reads at execution time, real per-weapon reload cost, Spell Swipe's deferred MAP increase, shape/override gating surviving the class-set widening) are each pinned to a named test in Tasks 2, 4, 5, and 6.

**Corrections found while writing this plan:** the most consequential is Investigation finding 1 — confirming the system has not merely thin but ZERO Spellstrike code anywhere, which forecloses any temptation to look for a partial system mechanism to extend rather than building the state fully module-owned. The second is Investigation finding 3 — the spec cites predicates (`twoHanded`/`wieldingTrait`) that don't exist in any upstream plan, the same citation gap found repeatedly elsewhere this session; resolved by extending #992's own newly-consolidated shared predicate module rather than opening a fourth location for this logic.
