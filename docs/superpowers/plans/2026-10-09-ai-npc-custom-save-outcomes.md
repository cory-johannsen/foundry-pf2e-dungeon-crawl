# Custom Save-Ability Outcomes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add seven new save-outcome kinds to #935's per-degree outcome model (action loss, next-roll modifiers, damage-rule curses, forced movement, suffocation, resistance/weakness edits, memory loss), built as PF2e effect items with rule elements wherever the system can express them, and module hooks only where it cannot.

**Architecture:** A shared, generalized effect-synthesis helper (needed by both this issue and #984, whose own plan already calls for it) replaces #935's narrower, FlatModifier-only one. Grammar extensions patch #935's recognizer directly. Live verification against the spec's own cited worked examples found that its single richest example — Mask of Fate — needs a second rule-element mechanism (`RollTwice`) beyond what the spec's own `nextRollModifier` shape states, confirmed by reading the real item text rather than the spec's partial quote of it.

**Tech Stack:** Vanilla JS (ESM), Foundry VTT API, PF2e system API, Vitest.

**Spec:** `docs/superpowers/specs/2026-10-09-ai-npc-custom-save-outcomes-design.md`

## Global Constraints

- #935 is still plan-only; Tasks 1-3 patch that document directly.
- All-or-nothing: a degree parses completely or the whole ability is `reportOnly` (#935's own rule, unchanged).
- AI-controlled targets are enforced automatically; human-driven characters get a reminder only (spec's own resolved decision).
- Every merge bumps `module.json`'s version (CLAUDE.md).

## Investigation findings

1. **#935's own real timed-effect helper, `applyTimedPenalty(target, penalty, originItem)`, is hardcoded to one `FlatModifier` rule per selector — it cannot build the `removeAfterRoll` FlatModifier, `DamageAlteration`, or `Resistance`/`Weakness`/`Immunity` rule elements this spec's own `nextRollModifier`/`damageTypeCurse`/`traitEdit` kinds need, confirmed by reading its real implementation rather than the spec's "#935's `applyTimedEffect` helper" shorthand (no function by that name exists).** Its real effect-item shape (confirmed in #935's plan: `{name, img, type:"effect", system:{description, duration, level, rules, start, tokenIcon, traits, context}}`) generalizes cleanly to an arbitrary `rules[]` array, though. **This same generalization is already called for by #984's own plan** (Task 5: "export `createTimedEffectFromRules`... for the `applyEffect` primitive to call"), written and merged earlier in this same planning session, before either #984 or #987 has actually been implemented. Task 1 here writes the concrete generalization both issues need; whichever of #984/#987 is implemented first builds `createTimedEffectFromRules`, and the other's worker finds it already in place and only needs to confirm it still fits.
2. **Mask of Fate — the spec's own primary cited `nextRollModifier` example — only has its Success outcome covered by the stated grammar; its Failure and Critical Failure outcomes use a different real mechanic the spec's own `nextRollModifier` params cannot express, found by reading the full real text rather than the spec's partial quote of only the Success clause.** The real item (`divine-warden-of-pharasma.json`) reads: Success — "a –1 status penalty to the next saving throw... within the next minute against a divine effect from a divine warden of Pharasma or worshipper of Pharasma" (fits `nextRollModifier` as stated); Failure — "For the next saving throw... it rolls twice and takes the worse result" (not a flat value at all — the real, confirmed rule element for this is `RollTwice` (`pf2e.mjs`'s rule-element registry: `RollTwice: RollTwiceRuleElement`), not `FlatModifier`); Critical Failure — the same "roll twice, take worse," but scoped to "all applicable saving throws," not just the next one (an unbounded-count variant `nextRollModifier`'s single-next-roll, `removeAfterRoll`-based design cannot express either). Task 2 adds a sibling kind, `rollTwiceModifier` (`mode: "worse"|"better"`, `scope: "nextOne"|"allWithinWindow"`, `windowSeconds`, `predicate?`), recognized by the same grammar extension, so Mask of Fate's own full text is modeled rather than silently falling to `reportOnly` despite being the spec's own flagship example.
3. **`Effect: Remaining Air`'s real schema (`other-effects/effect-remaining-air.json`) confirms the spec's own "what rule elements cannot do" claim exactly, and gives the concrete field this plan's hook must write.** The item sets `flags.system.remainingAir.rounds` to `5 + @actor.abilities.con.mod` via an `ActiveEffectLike` rule, then overrides the effect's own `badge-max` to that value via an `ItemAlteration` rule — but nothing in the item decrements the running count or triggers Unconscious/suffocation; those are left to a GM's own judgment in actual tabletop play, exactly the gap the spec says module hooks must fill. The counter itself lives at `system.badge.value` (a Foundry "counter"-type badge), which Task 6's hook decrements directly via `item.update({"system.badge.value": next})`.
4. **Do a Jig!, All Becomes Flame, and Drown all match the spec's quotes exactly** (confirmed live: `gnome-bard.json`, `cinder-dragon-ancient.json`, `sarglagon.json`) — no correction needed for any of the three.
5. **`removeAfterRoll`, `DamageAlteration`, `Resistance`, `Weakness`, and `Immunity` are all confirmed real, registered rule elements** (`pf2e.mjs`'s rule-element registry and `FlatModifierRuleElement`'s own schema) — the spec's rule-element claims for `nextRollModifier`, `damageTypeCurse`, and `traitEdit` are all accurate as stated, aside from finding 2's addition.

## Review Focus

- A `removeAfterRoll` modifier must be consumed by the FIRST matching roll within its window, not every roll — a modifier that lingers past its one intended use would silently keep applying a penalty the real rule says is single-use (spec's own stated rule; Task 3's test).
- Mask of Fate's own Critical Failure ("all applicable saving throws," not just the next one) must not expire after one save — `rollTwiceModifier`'s `scope: "allWithinWindow"` must keep applying until `windowSeconds` elapses, not be removed by the first roll the way `scope: "nextOne"` is (Investigation finding 2; Task 2's and Task 3's tests).
- `wasteActions`/`restrictActions` enforcement must read whether the TARGET (not the caster) is AI-controlled at the moment the target's own turn starts, not at the moment the ability was used — a human player could gain control of a previously-AI combatant between the ability landing and that combatant's next turn in an unusual session configuration (spec's own stated distinction; Task 4's test).
- The suffocation Fortitude save's DC and damage must both escalate together on each subsequent check ("the DC increases by 5 and the damage by 1d10," Investigation finding 3's real rule text) — a hook that escalates one but not the other would quietly under- or over-punish a long suffocation sequence (spec's own cited real rule; Task 6's test).
- A forced move that is blocked immediately (the destination's very first square is a wall or an occupied cell) must report zero distance moved, not be mistaken for "the push failed" — the real difference between "moved 0 of N feet" and an error matters for the GM report (spec's own stated rule; Task 5's test).

---

### Task 1: Generalize the timed-effect helper

**Files:**
- Modify: `docs/superpowers/plans/2026-10-09-ai-npc-save-outcome-coverage.md` (`applyTimedPenalty`'s own code block)
- Test: that plan's own executor test file

- [ ] **Step 1: Write the failing tests**

```js
describe("createTimedEffectFromRules (#987, shared with #984's Investigation finding 4)", () => {
  it("creates an effect item with the given name/img and one rule per entry in rules[]", async () => {
    const createEmbeddedDocuments = vi.fn();
    const target = { actor: { createEmbeddedDocuments } };
    await createTimedEffectFromRules(target, [{ key: "FlatModifier", selector: "will", type: "status", value: -1 }], 60, { name: "Mask of Fate", uuid: "Item.x" }, { name: "Mask of Fate (penalty)" });
    expect(createEmbeddedDocuments).toHaveBeenCalledWith("Item", [expect.objectContaining({
      name: "Mask of Fate (penalty)", type: "effect",
      system: expect.objectContaining({ rules: [{ key: "FlatModifier", selector: "will", type: "status", value: -1 }] }),
    })]);
  });

  it("applyTimedPenalty now delegates to it with its existing one-rule-per-selector shape (regression)", async () => { /* ... */ });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run -t "createTimedEffectFromRules"`
Expected: FAIL (function does not exist)

- [ ] **Step 3: Implement**, extracting `applyTimedPenalty`'s own real effect-item construction (confirmed shape in Investigation finding 1) into `createTimedEffectFromRules(target, rules, durationSeconds, originItem, { name, img } = {})`, defaulting `name`/`img` to `applyTimedPenalty`'s own existing values so its call site needs no change beyond delegating. Export it.

- [ ] **Step 4: Run the tests to verify they pass, then the full `npc-ability` suite**

Run: `npx vitest run -t "createTimedEffectFromRules"` then the full save-outcome-coverage test file.
Expected: PASS, `applyTimedPenalty`'s own existing tests unchanged.

- [ ] **Step 5: Commit**

```bash
git add docs/superpowers/plans/2026-10-09-ai-npc-save-outcome-coverage.md
git commit -m "docs(#987): amend #935's plan -- generalize applyTimedPenalty into createTimedEffectFromRules"
```

---

### Task 2: Grammar extensions

**Files:**
- Modify: `docs/superpowers/plans/2026-10-09-ai-npc-save-outcome-coverage.md` (`parseDegreeBlock`/`extractPenalty`-equivalent recognizers)
- Test: that plan's own parser test file

- [ ] **Step 1: Write the failing tests**

```js
describe("new outcome grammar (#987)", () => {
  it("recognizes wasteActions (Do a Jig!, real text)", () => {
    const parsed = parseDegreeBlock("<p>The target must waste 1 action on its next turn dancing.</p>");
    expect(parsed.effects).toContainEqual({ kind: "wasteActions", n: 1, window: "nextTurn" });
  });

  it("recognizes restrictActions (Drown, real text)", () => {
    const parsed = parseDegreeBlock("<p>The target is holding its breath. The only action it can take is to attempt a Fortitude save against Drown to expel the water, which is a single action.</p>");
    expect(parsed.effects).toContainEqual(expect.objectContaining({ kind: "restrictActions", onlyActions: [{ type: "save", save: "fortitude" }], endsOn: "saveSuccess" }));
  });

  it("recognizes nextRollModifier for a flat value (Mask of Fate Success, real text)", () => {
    const parsed = parseDegreeBlock("<p>The target takes a –1 status penalty to the next saving throw it attempts within the next minute against a divine effect from a divine warden of Pharasma or worshipper of Pharasma.</p>");
    expect(parsed.effects).toContainEqual(expect.objectContaining({ kind: "nextRollModifier", selector: "saving-throw", type: "status", value: -1, windowSeconds: 60 }));
  });

  it("recognizes rollTwiceModifier, scope nextOne (Mask of Fate Failure, real text, Investigation finding 2)", () => {
    const parsed = parseDegreeBlock("<p>For the next saving throw the target attempts within the next minute against a divine effect from a divine warden of Pharasma or worshipper of Pharasma, it rolls twice and takes the worse result.</p>");
    expect(parsed.effects).toContainEqual(expect.objectContaining({ kind: "rollTwiceModifier", mode: "worse", scope: "nextOne", windowSeconds: 60 }));
  });

  it("recognizes rollTwiceModifier, scope allWithinWindow (Mask of Fate Critical Failure, real text, Investigation finding 2)", () => {
    const parsed = parseDegreeBlock("<p>As failure, but the misfortune effect applies to all applicable saving throws.</p>", { asDegree: "failure" });
    expect(parsed.effects).toContainEqual(expect.objectContaining({ kind: "rollTwiceModifier", scope: "allWithinWindow" }));
  });

  it("recognizes damageTypeCurse with suppressible (All Becomes Flame, real text)", () => {
    const parsed = parseDegreeBlock("<p>The creature is cursed for 1 round. While cursed, any damage the cursed creature would deal by any means becomes fire damage, regardless of the original damage type. The cursed creature can temporarily suppress the curse for 1 round as an action.</p>");
    expect(parsed.effects).toContainEqual(expect.objectContaining({ kind: "damageTypeCurse", to: "fire", durationSeconds: 6, suppressible: true }));
  });

  it("recognizes breath (Drown Failure/Critical Failure, real text)", () => {
    const failure = parseDegreeBlock("<p>The target is holding its breath. The only action it can take is to attempt a Fortitude save against Drown to expel the water, which is a single action.</p>");
    expect(failure.effects).toContainEqual(expect.objectContaining({ kind: "breath", holdBreath: true }));
    const critFailure = parseDegreeBlock("<p>The target falls Unconscious and begins suffocating. If the target succeeds at its Fortitude save while suffocating, it coughs up the water and can breathe again.</p>");
    expect(critFailure.effects).toContainEqual(expect.objectContaining({ kind: "breath", suffocating: true, escape: { save: "fortitude", dc: null } }));
  });

  it("recognizes memoryLoss (Extract Memory, real text)", () => {
    const parsed = parseDegreeBlock("<p>The creature loses the target memory.</p>");
    expect(parsed.effects).toContainEqual({ kind: "memoryLoss", scope: "targetMemory" });
  });

  it("recognizes traitEdit and forcedMove per the spec's own grammar", () => { /* ... */ });

  it("keeps an ability reportOnly when a sentence matches none of the new patterns", () => { /* ... */ });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run -t "new outcome grammar"`
Expected: FAIL (patterns don't exist yet)

- [ ] **Step 3: Implement** the eight closed sentence patterns from the spec's own Design §Grammar extensions, plus the `rollTwiceModifier` pattern from Investigation finding 2 (`"it rolls twice and takes the worse result"` → `mode: "worse"`; `"applies to all applicable saving throws"` on an `asDegree` block → `scope: "allWithinWindow"` carried over from the referenced degree's own `windowSeconds`/`predicate`). Any sentence matching none of these, nor #935's existing condition/penalty/immunity patterns, keeps the ability `reportOnly`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run -t "new outcome grammar"`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add docs/superpowers/plans/2026-10-09-ai-npc-save-outcome-coverage.md
git commit -m "docs(#987): amend #935's plan -- the seven new outcome grammars plus rollTwiceModifier"
```

---

### Task 3: Rule-element outcome executors

**Files:**
- Modify: `docs/superpowers/plans/2026-10-09-ai-npc-save-outcome-coverage.md` (`applyNpcAbilityDegree`'s `effects` loop)
- Test: that plan's own executor test file

- [ ] **Step 1: Write the failing tests**

```js
describe("rule-element outcome executors (#987)", () => {
  it("nextRollModifier creates a FlatModifier with removeAfterRoll: true via createTimedEffectFromRules", async () => { /* ... */ });
  it("rollTwiceModifier scope nextOne creates a RollTwice rule with removeAfterRoll: true (Review Focus: scope allWithinWindow does NOT set removeAfterRoll)", async () => { /* ... */ });
  it("damageTypeCurse creates a DamageAlteration (mode: override, property: damage-type) effect, duration from durationSeconds, tagged suppressible in its flags when stated", async () => { /* ... */ });
  it("traitEdit creates one Resistance/Weakness/Immunity rule per listed entry", async () => { /* ... */ });
  it("every rule-element effect is agent-tagged so unlimited-duration ones are removed at combat end (#914)", async () => { /* ... */ });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run -t "rule-element outcome executors"`
Expected: FAIL (not implemented yet)

- [ ] **Step 3: Implement**, calling Task 1's `createTimedEffectFromRules` for each of the four rule-element kinds with the real rule-element shapes confirmed in Investigation finding 5.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run -t "rule-element outcome executors"`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add docs/superpowers/plans/2026-10-09-ai-npc-save-outcome-coverage.md
git commit -m "docs(#987): amend #935's plan -- rule-element executors for nextRollModifier/rollTwiceModifier/damageTypeCurse/traitEdit"
```

---

### Task 4: Action loss and restriction hooks

**Files:**
- Create: `scripts/save-outcome-hooks.mjs`
- Test: `tests/save-outcome-hooks.wasteRestrict.test.mjs`

**Interfaces:**
- Produces: `onCombatantTurnStart(combat, combatant)` (partial — Tasks 5-6 extend it further) handling `wasteActions`/`restrictActions` marker effects.

- [ ] **Step 1: Write the failing tests**

```js
describe("wasteActions enforcement (#987, Review Focus: re-check AI control at the target's own turn start)", () => {
  it("reduces an AI-controlled combatant's turnState.actionsRemaining by n, clamped at 0, and consumes the marker effect", async () => { /* ... */ });
  it("posts a reminder and consumes the marker for a human-driven combatant, without touching actionsRemaining", async () => { /* ... */ });
  it("checks agentControlled at the target's OWN turn start, not at the time the ability was used", async () => {
    // Marker created while the target was AI-controlled; by the time its
    // turn starts, a human has taken control (agentControlled flag
    // flipped) -> the reminder path runs, not the automatic deduction.
  });
});

describe("restrictActions enforcement (#987)", () => {
  it("filters an AI-controlled target's own candidate list down to the single permitted escape-save candidate", async () => { /* ... */ });
  it("the escape save, on success, removes the restriction effect", async () => { /* ... */ });
  it("falls back to the normal candidate list if the effect marker is unreadable (Error handling)", async () => { /* ... */ });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/save-outcome-hooks.wasteRestrict.test.mjs`
Expected: FAIL (module does not exist)

- [ ] **Step 3: Implement**, hooking the same real turn-change point #984's own Task 3 (`scheduleConditionRemoval`) reads from (confirm its exact call site first, since both plans now hook the same turn boundary — reuse the identical hook registration rather than adding a second one).

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/save-outcome-hooks.wasteRestrict.test.mjs`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add scripts/save-outcome-hooks.mjs tests/save-outcome-hooks.wasteRestrict.test.mjs
git commit -m "feat(#987): wasteActions/restrictActions enforcement and human reminders"
```

---

### Task 5: Forced movement

**Files:**
- Modify: `scripts/dungeon-combat.mjs` (new `pullTokenToward`/`moveTokenBy`, alongside the confirmed-real `pushTokenAway` at line 3624)
- Test: `tests/dungeon-combat.forced-move.test.mjs`

- [ ] **Step 1: Write the failing tests**

```js
describe("pullTokenToward / moveTokenBy (#987)", () => {
  it("pulls the target toward the source up to the given distance, wall/occupancy-aware", async () => { /* ... */ });
  it("stops at the last legal cell and reports the actual distance moved when blocked immediately (Review Focus: 0 feet moved is not an error)", async () => { /* ... */ });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/dungeon-combat.forced-move.test.mjs`
Expected: FAIL (functions don't exist)

- [ ] **Step 3: Implement**, reusing `pushTokenAway`'s own real wall/occupancy-aware stepping logic (confirmed real at `scripts/dungeon-combat.mjs:3624`) with the direction reversed for `pullTokenToward` and parameterized for `moveTokenBy`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/dungeon-combat.forced-move.test.mjs`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add scripts/dungeon-combat.mjs tests/dungeon-combat.forced-move.test.mjs
git commit -m "feat(#987): pullTokenToward/moveTokenBy for the forcedMove outcome kind"
```

---

### Task 6: Suffocation and breath-holding

**Files:**
- Modify: `scripts/save-outcome-hooks.mjs` (turn-end hook)
- Test: `tests/save-outcome-hooks.breath.test.mjs`

- [ ] **Step 1: Write the failing tests**

```js
describe("breath/suffocation turn-end hook (#987, Investigation finding 3)", () => {
  it("creates Effect: Remaining Air with badge.max = 5 + Con mod when a creature first starts holding its breath", async () => { /* ... */ });
  it("decrements system.badge.value by 1 at end of turn, or 2 if the creature attacked or cast a spell this turn", async () => { /* ... */ });
  it("applies Unconscious and marks suffocating when the badge reaches 0", async () => { /* ... */ });
  it("rolls an escalating Fortitude save each subsequent check -- DC +5 and damage +1d10 together each time (Review Focus)", async () => { /* ... */ });
  it("a critical failure on the suffocation save is fatal", async () => { /* ... */ });
  it("a successful escape save (the ability's own expel-water action) ends suffocation and removes the air-tracking effect", async () => { /* ... */ });
  it("whileGrabbed ties the effect's life to the grabbed/restrained condition -- removed when neither applies", async () => { /* ... */ });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/save-outcome-hooks.breath.test.mjs`
Expected: FAIL (not implemented yet)

- [ ] **Step 3: Implement**, creating/updating the real `Effect: Remaining Air` item (Investigation finding 3's confirmed schema) and the Fortitude-save progression per the real Drowning and Suffocating rule text quoted in the spec's own Investigation findings.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/save-outcome-hooks.breath.test.mjs`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add scripts/save-outcome-hooks.mjs tests/save-outcome-hooks.breath.test.mjs
git commit -m "feat(#987): suffocation turn-end hook using the real Effect: Remaining Air item"
```

---

### Task 7: Memory loss

**Files:**
- Modify: `docs/superpowers/plans/2026-10-09-ai-npc-save-outcome-coverage.md` (`applyNpcAbilityDegree`'s `effects` loop)
- Test: that plan's own executor test file

- [ ] **Step 1: Write the failing tests**

```js
describe("memoryLoss executor (#987)", () => {
  it("creates a descriptive effect item with no rules and whispers the GM the lost memory's scope", async () => { /* ... */ });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run -t "memoryLoss executor"`
Expected: FAIL (not implemented yet)

- [ ] **Step 3: Implement.**

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run -t "memoryLoss executor"`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add docs/superpowers/plans/2026-10-09-ai-npc-save-outcome-coverage.md
git commit -m "docs(#987): amend #935's plan -- memoryLoss executor"
```

---

### Task 8: Coverage audit and version bump

**Files:**
- Create/modify: the save-outcome-coverage ratchet's golden fixture and test (per #935's own established pattern)
- Modify: `module.json`

- [ ] **Step 1: Regenerate the coverage audit** over the ~139-ability remainder the spec's own Investigation findings counted, adding one counter per new outcome kind (including the new `rollTwiceModifier` kind from Investigation finding 2) and confirming that count for real.
- [ ] **Step 2: Write/extend the ratchet test** (golden-row comparison + monotonic auto-count, #935's own pattern).
- [ ] **Step 3: Run the test suite**

Run: `npx vitest run` (the full save-outcome-coverage suite)
Expected: PASS, no regressions — abilities that were already `auto` under #935 stay `auto` with identical results.

- [ ] **Step 4: Run the `update-architecture-docs` skill** (new file: `scripts/save-outcome-hooks.mjs`)
- [ ] **Step 5: Bump `module.json`'s version** (minor — check `main`'s current version first)
- [ ] **Step 6: Commit**

```bash
git add module.json docs/architecture.md
git commit -m "test(#987): coverage audit for the seven new outcome kinds; chore: bump version"
```

---

## Self-Review

**1. Spec coverage:** All seven outcome families (Tasks 2-7), the shared effect-synthesis generalization (Task 1), and the audit/version bump (Task 8) each cover a spec section. The four deferred follow-ups (#1094-#1097) are explicitly excluded, not silently handled.

**2. Placeholder scan:** No "TBD"/"TODO". Task 2's and 6's test lists name exactly what each asserts, including the real texts they're grounded in.

**3. Type consistency:** `OutcomeEffect`'s `kind`-discriminated shape (Task 2) is read identically by Task 3's rule-element executors and Tasks 4-7's hook/executor implementations; `createTimedEffectFromRules`'s signature (Task 1) matches what Task 3 calls.

**4. Review Focus:** All five bullets (single-use consumption, the unbounded `allWithinWindow` scope, turn-start AI-control re-check, paired DC/damage escalation, zero-distance-is-not-an-error reporting) are each pinned to a named test in Tasks 2-6.

**Corrections found while writing this plan:** the most consequential is Investigation finding 2 — Mask of Fate, the spec's own flagship `nextRollModifier` example, only has its Success outcome covered by the stated grammar; its Failure and Critical Failure outcomes need the real `RollTwice` rule element and an unbounded-scope variant the spec never names, caught by reading the full real text rather than the spec's own partial quote of just the Success clause. The second is Investigation finding 1 — recognizing that #984's own already-merged plan calls for the exact same generalization this issue needs, so this plan builds it once, concretely, rather than risking two independent, possibly-divergent patches to the same sibling plan.
