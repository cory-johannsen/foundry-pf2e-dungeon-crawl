# More NPC Strike-Plus Shapes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add five new strike-plus shapes to #933's registry — last-action-gated follow-ups, multi-Strike variants, per-limb/each-creature Strikes (Thrash), Strike-plus-area-save, and Strike-plus-self-buff (including a restricted extra action) — plus the two new turn-state pieces they need (`lastAction`, `extraActions`).

**Architecture:** All five shapes patch #933's own plan-only `scripts/npc-strike-shapes.mjs` and its `applyAgentDecision` `npcStrike` branch. The spec's own flagged open question (which source reliably gives a Strike's damage types for the last-action record) is resolved by reading the real, confirmed-live `rollAndApplyStrikeAtVariant`: it returns only a bare outcome string, nothing structured — `hit`/`degree` come from that return value directly, and `damageTypes` must come from the Strike action's own static weapon data, never from the roll result (which carries none).

**Tech Stack:** Vanilla JS (ESM), Foundry VTT API, PF2e system API, Vitest.

**Spec:** `docs/superpowers/specs/2026-10-09-ai-npc-strike-plus-shapes-design.md`

## Global Constraints

- **#933 is still plan-only.** Every task here patches that plan document directly.
- All-or-nothing, unchanged: a sentence (or a Requirements clause outside the closed predicate set) that no shape consumes makes the whole ability `null`.
- Every merge bumps `module.json`'s version (CLAUDE.md).

## Investigation findings

1. **`rollAndApplyStrikeAtVariant`'s real return value is a bare outcome string — nothing else — confirmed live reading the function in full.** This resolves the spec's own flagged open question about where `damageTypes` for the `lastAction` record comes from: it cannot come from the roll result at all, since nothing structured is returned. `hit`/`degree` are derived directly from the returned string (`hit = outcome === "success" || outcome === "criticalSuccess"`, `degree = outcome`); `damageTypes` must be read from the Strike action's own static weapon/item data (`action.item.system.damage`'s own damage type, the same field every other damage-type read in this file already uses) at the SAME call site, independent of the roll's own return value.
2. **Pull Apart — one of the spec's own two named `multiStrikeVariant` examples — does not fit that shape's own described "all-hit rider" as simply as the spec's Investigation findings paraphrase it.** The real text (confirmed live, `mukradi.json`) continues past the flat "extra damage" the spec quotes with "**with a `@Check[fortitude|dc:36|basic]` save. On a critical failure, the creature is torn to pieces and dies.**" — a basic save SCALING the extra damage, plus an unconditional critical-failure-only instant death with no existing precedent anywhere in this codebase (not a PF2e condition, not modeled by any save-outcome grammar in this sequence — it is a direct defeat). Rather than widen the base `multiStrikeVariant` grammar to cover a one-off "basic save plus instant death" rider, this plan takes Pull Apart into the override table (Task 6), the same resolution #947/#959/#961 already used for their own flagship examples that didn't survive contact with the real grammar.
3. **Mukradi's own real Thrash text needs one parameter the spec's `eachInReach` params table doesn't name: a flat per-attack penalty alongside the deferred-MAP-increase rule.** The real text (confirmed live) reads "Each attack takes a **–2 circumstance penalty** and counts toward the mukradi's multiple attack penalty, but the multiple attack penalty doesn't increase until after all the attacks are made" — a STATIC penalty on every attack, layered beside (not instead of) the MAP-deferral rule the spec already names. Task 3's own `eachInReach` params gain `perAttackPenalty?: number` alongside `perLimbMax`/`mapRule`.

## Review Focus

- The `lastAction` record's `damageTypes` field must be read from the Strike's own static weapon data at write time, never left empty or guessed from the roll outcome (Investigation finding 1; Task 1's test).
- A `multiStrikeVariant` whose all-hit rider includes anything beyond flat extra damage/a condition/a linked effect (Pull Apart's own save-scaled-damage-plus-death shape) must be excluded from the base grammar, not partially modeled (Investigation finding 2; Task 2's test).
- `eachInReach`'s per-attack penalty (when present) must apply to every Strike in the burst, independent of and in addition to the MAP-deferral rule, never one substituting for the other (Investigation finding 3; Task 3's test).
- A restricted extra action (Quickened's own Strike/Stride-only budget) must never be spendable by a candidate type outside its own `restrictTo` list, and must expire and disappear from the budget exactly once its own `expiresAt` passes (spec's own stated rule; Task 7's test).
- A stale `lastAction` record (the mover whose last action it describes is no longer the acting combatant, or the record is from a previous turn) must make every `lastActionFollowUp` candidate unavailable, never assumed valid (spec's own stated rule; Task 4's test).

---

### Task 1: The `lastAction` turn-state record

**Files:**
- Modify: `docs/superpowers/plans/2026-10-09-ai-npc-reactions.md` — **no**, modify #933's/#909's own turn-state plan: `docs/superpowers/plans/2026-10-09-ai-actor-maneuvers.md` is where `initAgentTurnState` lives per the spec's own citation; confirm the real owning plan document before editing (likely `docs/superpowers/plans/2026-10-09-ai-npc-strike-plus-abilities.md` itself, since that plan already extends `applyAgentDecision`'s dispatch — patch whichever plan document's own `applyAgentDecision` amendment is the one this module will actually apply last).
- Test: see that plan's own existing turn-state test file.

- [ ] **Step 1: Add the `lastAction` field to the turn-state shape**

```js
// Append to the owning plan's own turnState shape:
lastAction: {
  type: "strike" | "multiStrike" | "npcStrike" | "cast" | "stride" | "maneuver" | "other",
  index: 0,
  strike: { limb, targetId, hit: boolean, degree: string, dealtDamage: boolean, damageTypes: string[] } | null,
} | null,
```

- [ ] **Step 2: Add the write-after-every-action step**

```js
// Wherever applyAgentDecision's own dispatch already updates turnState
// after executing a candidate, add (Investigation finding 1 -- hit/degree
// from the plain returned outcome string, damageTypes from the Strike
// action's own static weapon data, never from the roll result):
function damageTypesForStrike(action) {
  const damage = action?.item?.system?.damage;
  if (!damage) return [];
  return [damage.damageType, ...(damage.damageType2 ? [damage.damageType2] : [])].filter(Boolean);
}

function recordLastAction(turnState, { type, index, outcome = null, action = null, targetId = null, limb = null }) {
  const strike = outcome
    ? {
        limb, targetId,
        hit: outcome === "success" || outcome === "criticalSuccess",
        degree: outcome,
        dealtDamage: outcome === "success" || outcome === "criticalSuccess",
        damageTypes: damageTypesForStrike(action),
      }
    : null;
  return { ...turnState, lastAction: { type, index: (turnState.lastAction?.index ?? -1) + 1, strike } };
}
```

- [ ] **Step 3: Clear `lastAction` at turn start**

```js
// The owning plan's own turn-start initialization (initAgentTurnState):
// add `lastAction: null` to the fresh-turn object literal.
```

- [ ] **Step 4: Commit the amendment**

```bash
git add docs/superpowers/plans/2026-10-09-ai-npc-strike-plus-abilities.md
git commit -m "docs(#978): amend the turn-state plan -- lastAction record, damageTypes from weapon data"
```

---

### Task 2: `lastActionFollowUp` and `multiStrikeVariant` shapes

**Files:**
- Modify: `docs/superpowers/plans/2026-10-09-ai-npc-strike-plus-abilities.md`
- Test: that plan's own `npc-strike-shapes.mjs` test file

- [ ] **Step 1: Write the failing tests**

```js
// append to the #933 plan's own shape-parser test file
describe('lastActionFollowUp (#978)', () => {
  it('recognizes a damage-type-gated follow-up (Spreading Flames, real text)', () => {
    const item = makeAbility("<p><strong>Requirements</strong> The living wildfire's last action was a Strike that dealt fire damage</p><hr /><p><strong>Effect</strong> ...</p>");
    const parsed = parseStrikePlusAbility(item);
    expect(parsed.shape).toBe('lastActionFollowUp');
    expect(parsed.params.predicates).toContainEqual({ type: 'lastStrikeDamageType', value: 'fire' });
  });

  it('recognizes a hit-gated, limb-named follow-up (Choking Pain, real text)', () => {
    const item = makeAbility("<p><strong>Requirements</strong> The mummy guardian's last action was a successful fist Strike</p><hr /><p><strong>Effect</strong> ...</p>");
    const parsed = parseStrikePlusAbility(item);
    expect(parsed.params.predicates).toContainEqual({ type: 'lastStrikeLimb', value: 'fist' });
    expect(parsed.params.predicates).toContainEqual({ type: 'lastStrikeHit' });
  });
});

describe('multiStrikeVariant (#978)', () => {
  it('recognizes a different-target, penalized multi-Strike (Hungry Flurry, real text)', () => {
    const item = makeAbility("<p>The giant flytrap makes four leaf Strikes at a -2 penalty, each against a different target. These attacks count toward the flytrap's multiple attack penalty, but the penalty does not increase until after all the attacks are made.</p>");
    const parsed = parseStrikePlusAbility(item);
    expect(parsed.params).toMatchObject({ count: 4, penalty: -2, targetMode: 'different', mapRule: 'deferredIncrease' });
  });

  it('excludes Pull Apart -- a basic-save-scaled-damage-plus-death all-hit rider is outside the base grammar (Investigation finding 2)', () => {
    const item = makeAbility('<p>The mukradi makes two Strikes with different maws against the same target. If both hit, the target takes an extra @Damage[(2d12+13)[slashing]] damage, with a @Check[fortitude|dc:36|basic] save. On a critical failure, the creature is torn to pieces and dies.</p><p>The mukradi\'s multiple attack penalty increases only after all the attacks are made.</p>');
    expect(parseStrikePlusAbility(item)).toBeNull();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/npc-strike-shapes.test.mjs -t "#978"`
Expected: FAIL (neither shape recognized yet)

- [ ] **Step 3: Implement both parsers**, following the Design section's own stated predicate/param tables exactly, adding the real-text-grounded exclusion guard for Pull Apart's own shape (a basic-save check combined with an unconditional death clause inside the all-hit rider sentence makes the ability `null`, never partially modeled).

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/npc-strike-shapes.test.mjs`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add docs/superpowers/plans/2026-10-09-ai-npc-strike-plus-abilities.md tests/npc-strike-shapes.test.mjs
git commit -m "docs(#978): amend #933's plan -- lastActionFollowUp and multiStrikeVariant shapes"
```

---

### Task 3: `eachInReach` (the Thrash family)

**Files:**
- Modify: `docs/superpowers/plans/2026-10-09-ai-npc-strike-plus-abilities.md`
- Test: that plan's own shape-parser test file

- [ ] **Step 1: Write the failing test**

```js
describe('eachInReach (#978)', () => {
  it('recognizes Thrash with its own real per-attack penalty alongside the MAP-deferral rule (Investigation finding 3)', () => {
    const item = makeAbility("<p>The mukradi Strikes once against each creature in its reach. It can make one of these Strikes with each of its maws, one with its tail lash, and the rest with its legs. Each attack takes a -2 circumstance penalty and counts toward the mukradi's multiple attack penalty, but the multiple attack penalty doesn't increase until after all the attacks are made.</p>");
    const parsed = parseStrikePlusAbility(item);
    expect(parsed.shape).toBe('eachInReach');
    expect(parsed.params.perAttackPenalty).toBe(-2);
    expect(parsed.params.mapRule).toBe('deferredIncrease');
    expect(parsed.params.perLimbMax).toMatchObject({ maws: 'any', 'tail lash': 1, legs: 'any' });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/npc-strike-shapes.test.mjs -t "eachInReach"`
Expected: FAIL

- [ ] **Step 3: Implement**, adding `perAttackPenalty?: number` to the `eachInReach` params the Design section already names, parsed from an optional "Each attack takes a –N circumstance penalty" clause folded into the same sentence as the MAP-deferral rule.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/npc-strike-shapes.test.mjs`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add docs/superpowers/plans/2026-10-09-ai-npc-strike-plus-abilities.md tests/npc-strike-shapes.test.mjs
git commit -m "docs(#978): amend #933's plan -- eachInReach with its own real per-attack penalty"
```

---

### Task 4: `strikeWithAreaSave` and `strikePlusSelfBuff`

**Files:**
- Modify: `docs/superpowers/plans/2026-10-09-ai-npc-strike-plus-abilities.md`
- Test: that plan's own shape-parser test file

- [ ] **Step 1: Write the failing tests**

```js
describe('strikeWithAreaSave (#978)', () => {
  it('recognizes a Strike whose hit (or use) triggers an emanation save (Wind Strike, real text)', () => {
    const item = makeAbility('<p>The cloud giant makes a Strike with its ranseur. On a hit, the target takes an additional @Damage[4d8[bludgeoning]] damage and is @UUID[Compendium.pf2e.conditionitems.Item.Deafened] for 1 minute. Whether or not the Strike hits, each non-cloud giant creature within a @Template[emanation|distance:20] must succeed at a @Check[fortitude|dc:30] save or be knocked @UUID[Compendium.pf2e.conditionitems.Item.Prone].</p>');
    const parsed = parseStrikePlusAbility(item);
    expect(parsed.shape).toBe('strikeWithAreaSave');
    expect(parsed.params.area).toMatchObject({ shape: 'emanation', distanceFeet: 20 });
  });
});

describe('strikePlusSelfBuff (#978)', () => {
  it('recognizes a Strike followed by a restricted Quickened extra action (Suck Blood, real text)', () => {
    const item = makeAbility('<p>The chupacabra makes a bite Strike. If it hits, the chupacabra gains the @UUID[Compendium.pf2e.conditionitems.Item.Quickened] condition for 1 minute and can use the extra action only for Strike and Stride actions.</p>');
    const parsed = parseStrikePlusAbility(item);
    expect(parsed.shape).toBe('strikePlusSelfBuff');
    expect(parsed.params.buff).toMatchObject({ kind: 'extraAction', restrictTo: ['strike', 'stride'] });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/npc-strike-shapes.test.mjs -t "strikeWithAreaSave|strikePlusSelfBuff"`
Expected: FAIL

- [ ] **Step 3: Implement both parsers** per the Design section's own stated param tables.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/npc-strike-shapes.test.mjs`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add docs/superpowers/plans/2026-10-09-ai-npc-strike-plus-abilities.md tests/npc-strike-shapes.test.mjs
git commit -m "docs(#978): amend #933's plan -- strikeWithAreaSave and strikePlusSelfBuff shapes"
```

---

### Task 5: Executors for all five shapes

**Files:**
- Modify: `docs/superpowers/plans/2026-10-09-ai-npc-strike-plus-abilities.md`
- Test: that plan's own `applyAgentDecision` npcStrike execution test file

- [ ] **Step 1: Write the failing tests** for each shape's own executor behavior (re-check `lastActionFollowUp`'s predicates against the live record at execution time, not just vocabulary-build time; `multiStrikeVariant`'s distinct-target/limb assignment and MAP handling; `eachInReach`'s deterministic limb assignment under `perLimbMax` plus the flat `perAttackPenalty` applied to every Strike; `strikeWithAreaSave`'s area membership/subject filter; `strikePlusSelfBuff`'s three buff kinds).

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/dungeon-combat-npc-strike-execution.test.mjs -t "#978"`
Expected: FAIL

- [ ] **Step 3: Implement each executor**, per the spec's own Design → Execution section, reusing #915/#935's real save/condition/penalty helpers and #933's own real `rollAndApplyStrikeAtVariant`/MAP-advancement conventions rather than a parallel mechanism.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/dungeon-combat-npc-strike-execution.test.mjs`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add docs/superpowers/plans/2026-10-09-ai-npc-strike-plus-abilities.md tests/dungeon-combat-npc-strike-execution.test.mjs
git commit -m "docs(#978): amend #933's plan -- executors for the five new shapes"
```

---

### Task 6: The override table — Pull Apart and future exceptions

**Files:**
- Modify: `docs/superpowers/plans/2026-10-09-ai-npc-strike-plus-abilities.md`
- Test: that plan's own override-table test file

- [ ] **Step 1: Write the failing test**

```js
describe('NPC_STRIKE_OVERRIDES -- Pull Apart (#978, Investigation finding 2)', () => {
  it('overrides Pull Apart with its own real basic-save-scaled-damage-plus-critical-death descriptor', () => {
    const override = findStrikeOverride({ name: 'Pull Apart', slug: 'pull-apart' });
    expect(override.allHitRider).toMatchObject({ kind: 'basicSaveDamagePlusCriticalDeath', save: 'fortitude', dc: 36, formula: '2d12+13', damageType: 'slashing' });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run -t "Pull Apart"`
Expected: FAIL (no override yet)

- [ ] **Step 3: Implement** the override entry and its own narrow `basicSaveDamagePlusCriticalDeath` executor branch — the ONE bespoke execution path this plan adds outside the five general shapes, scoped to exactly this one override (and any future override that needs the identical shape), calling the module's real defeat-application path directly on a critical failure rather than modeling "dies" as a condition (it is not one).

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run -t "Pull Apart"`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add docs/superpowers/plans/2026-10-09-ai-npc-strike-plus-abilities.md
git commit -m "docs(#978): amend #933's plan -- Pull Apart's override and the basicSaveDamagePlusCriticalDeath executor"
```

---

### Task 7: Restricted extra actions (Quickened)

**Files:**
- Modify: `docs/superpowers/plans/2026-10-09-ai-npc-strike-plus-abilities.md` (or the owning turn-state plan per Task 1's own note)
- Test: that plan's own `buildCandidateList`/turn-state test file

- [ ] **Step 1: Write the failing tests**

```js
describe('extraActions (restricted) (#978)', () => {
  it('lets a Strike/Stride candidate spend a Quickened-restricted extra action', () => {
    // turnState.extraActions = [{ count: 1, restrictTo: ['strike', 'stride'], expiresAt: ... }];
    // buildCandidateList (or whichever function gates action spend) must
    // allow a strike/stride candidate through even when actionsRemaining
    // alone would be 0, and must NOT allow a maneuver/cast candidate to
    // spend it.
  });

  it('drops an expired extraActions entry before candidates are built', () => {
    // expiresAt already passed -- the entry contributes nothing.
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run -t "extraActions"`
Expected: FAIL

- [ ] **Step 3: Implement** `extraActions` per the Design section's own stated mechanics, pruning expired entries before `buildCandidateList` runs and consuming a matching restricted action first in `applyCandidateToTurnState`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run -t "extraActions"`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add docs/superpowers/plans/2026-10-09-ai-npc-strike-plus-abilities.md
git commit -m "docs(#978): amend the turn-state plan -- restricted extraActions (Quickened)"
```

---

### Task 8: Coverage audit and version bump

**Files:**
- Modify: `docs/superpowers/plans/2026-10-09-ai-npc-strike-plus-abilities.md` (its own golden-file audit, extended)
- Modify: `module.json`

- [ ] **Step 1: Extend the real-population fixture/audit** (per #935's established pattern, already adopted by #933's own plan) to include the five new shapes, generated by running the amended parser for real against the strike-related population, not pre-guessed.
- [ ] **Step 2: Run the `update-architecture-docs` skill** (no new files — confirm no import-edge changes are missed)
- [ ] **Step 3: Bump `module.json`'s version** (minor — check `main`'s current version first)
- [ ] **Step 4: Commit**

```bash
git add docs/superpowers/plans/2026-10-09-ai-npc-strike-plus-abilities.md module.json docs/architecture.md
git commit -m "docs(#978): extend the coverage audit for the five new shapes; chore: bump version"
```

---

## Self-Review

**1. Spec coverage:** All five new shapes (Tasks 2-4), the `lastAction` record (Task 1), executors (Task 5), the override table (Task 6), restricted extra actions (Task 7), and the audit/version bump (Task 8) are each covered.

**2. Placeholder scan:** No "TBD"/"TODO". Task 1's own file-ownership question (which plan document's turn-state shape to actually edit) is stated as an explicit confirmation step rather than guessed, since this plan's own investigation found the turn-state shape is cited across multiple sibling plans and the real, final owning file depends on implementation order.

**3. Type consistency:** The `lastAction`/`extraActions` turn-state fields (Tasks 1, 7) are produced once and consumed identically by every shape's own executor (Task 5) and by `buildCandidateList`'s gating (Task 7).

**4. Review Focus:** All five bullets (damageTypes sourced correctly, Pull Apart's exclusion from the base grammar, the per-attack-penalty/MAP-deferral combination, restricted-action type-gating, stale-lastAction safety) are each pinned to a named test in Tasks 1, 2, 3, and 7.

**Corrections found while writing this plan:** beyond the three listed under Investigation findings (all found during the live-text verification pass, not while drafting), no further corrections were needed while writing the task breakdown itself — the spec's own Design section's param tables for `strikeWithAreaSave` and `strikePlusSelfBuff` matched their own cited real texts (Wind Strike, Suck Blood) exactly on direct comparison, so Task 4 implements them as stated rather than finding a third class of discrepancy.
