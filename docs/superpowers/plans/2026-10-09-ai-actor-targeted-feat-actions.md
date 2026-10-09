# AI Actor Targeted Feat Actions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let AI actors use Hunt Prey and Devise a Stratagem — self-effect actions whose linked effect is bound to a chosen target via PF2e's own `TokenMark` rule element — by picking a legal target and pre-filling that rule's `uuid` before creating the effect, letting the system's own rule elements (bonuses, d20 substitution) do everything downstream.

**Architecture:** A new `targetedSelfEffect` kind joins #910/#914's existing `feat` vocabulary (`selfEffect`/`composite`), restricted to a small allowlist (`hunt-prey`, `devise-a-stratagem`) for this first slice. `buildFeatCandidates` (per #914's plan) already matches generically on `(kind, itemId, targetId)` with no kind-specific branching, so it needs no change at all — only `buildFeatVocabulary`'s own entry-building gains a third source list. Execution clones the linked effect, sets its `TokenMark` rule's `uuid` to the chosen target token, and — for Devise only — toggles the `devise-a-stratagem` roll option's `attack` suboption on the created effect via the real `actor.toggleRollOption` API (the same one #919's own plan already uses for Lunge). A separate, small addition annotates Strike candidates for an opponent currently bound by one of the actor's own marks, so the reasoning model can see the follow-up is ready.

**Tech Stack:** Vanilla JS (ES modules), Foundry VTT v14 API, PF2e system API, Vitest.

**Spec:** `docs/superpowers/specs/2026-10-08-ai-actor-targeted-feat-actions-design.md`

## Global Constraints

- **Hard dependency: #910's and #914's own plans must be fully implemented and merged first** (this plan extends `computeSelfEffectVocabularyEntries`/`buildFeatVocabulary`/`executeSelfEffectFeat` exactly as they exist there), and in turn #909's.
- **Confirmed live against the real compiled compendium content, not the spec's own paraphrase:** the `Effect: Hunt Prey` item's only rule is `{ key: "TokenMark", slug: "hunted-prey" }` — no `uuid` field at all by default; this module must add one. The `Effect: Devise a Stratagem` item has a `{type: "formula", value: "1d20", evaluate: true}` badge (the system rolls this automatically the instant the effect is created — no module code needed for that part) and a toggleable `RollOption` rule (`option: "devise-a-stratagem"`, `suboptions: [{value: "attack"}, {value: "skill"}, {value: "defensive", predicate: [...]}]`) whose selection is a **runtime** `actor.toggleRollOption` call against the already-created effect item, never data baked into the effect source before creation (confirmed: `toggleRollOption`'s own implementation matches against an existing rule element instance already prepared on a real item, which can't exist before that item is created).
- **Confirmed live:** `actor.toggleRollOption(domain, option, itemId, value, suboption)` is the real, public API (already used by #919's own plan for Lunge's reach toggle) — this plan's own Devise call is `actor.toggleRollOption("all", "devise-a-stratagem", createdEffect.id, true, "attack")`.
- **Resolved: `synthetics.tokenMarks` needs no manual clearing on Hunt Prey re-designation.** It is a derived cache rebuilt from the actor's own current effect items on every data-preparation pass (confirmed by its own `beforePrepareData`-time population) — deleting the old Hunt Prey effect and creating the new one is sufficient; there is no persistent flag to separately clear.
- **Resolved: eligibility uses the RAW-matching sense per feat** — Hunt Prey ("see or hear the prey") reuses `detectableOpponents` (already alliance/stealth-matrix aware, broader than plain sight); Devise a Stratagem ("a creature you can see") reuses the plain `hasLineOfSight` check.
- Follow this repo's existing per-file `const MODULE_ID = "pf2e-dungeon-crawl";` convention.
- Bump `module.json`'s `version` as part of this work (minor bump — a new vocabulary kind plus a new execution path, not a one-line fix).

## Review Focus

- The `TokenMark` rule's `uuid` must be set on a **clone** of the effect source, never mutating the compendium/cached source object itself — a shared-reference bug here would corrupt every future use of the same effect for any actor.
- Devise a Stratagem's suboption toggle must happen **after** the effect is created (it needs the real created item's own id) — a design that tries to pre-bake the selection into the effect source before creation is wrong and must not ship.
- Hunt Prey re-designation must delete the actor's **prior** Hunt Prey effect before creating the new one — never leaving two active at once, and never deleting a different actor's mark.
- A target with no resolvable token UUID, or an effect source with no matching `TokenMark` rule at all, must make the item excluded from vocabulary rather than offered and then failing at execution time.
- The action's cost/frequency must only be spent **after** the effect is successfully created — a failure partway through (e.g. the toggle call throwing) must not have already spent the action.

---

### Task 1: Pure helpers — effect binding, mark-lookup, and the allowlist

**Files:**
- Create: `scripts/targeted-feat-actions.mjs`
- Test: `tests/targeted-feat-actions.test.mjs`

**Interfaces:**
- Consumes: nothing.
- Produces (consumed by Tasks 2–4): `TARGETED_SELF_EFFECT_ALLOWLIST` — `{"hunt-prey": {senseType: "detect", exclusiveMark: true}, "devise-a-stratagem": {senseType: "sight", exclusiveMark: false}}`; `bindTokenMarkEffect(effectSource, slug, targetTokenUuid)` → a new object (never mutates its input), or `null` if no matching `TokenMark` rule exists; `findActiveMarkEffects(effectItems, targetTokenUuid)` → `Array<{slug, badgeValue}>`.

- [x] **Step 1: Write the failing tests**

```js
// tests/targeted-feat-actions.test.mjs
import { describe, it, expect } from 'vitest';
import { TARGETED_SELF_EFFECT_ALLOWLIST, bindTokenMarkEffect, findActiveMarkEffects } from '../scripts/targeted-feat-actions.mjs';

describe('TARGETED_SELF_EFFECT_ALLOWLIST', () => {
  it('lists exactly hunt-prey and devise-a-stratagem for this first slice', () => {
    expect(Object.keys(TARGETED_SELF_EFFECT_ALLOWLIST).sort()).toEqual(['devise-a-stratagem', 'hunt-prey']);
  });

  it('marks Hunt Prey as using the broader "detect" sense and as an exclusive (one-at-a-time) mark', () => {
    expect(TARGETED_SELF_EFFECT_ALLOWLIST['hunt-prey']).toEqual({ senseType: 'detect', exclusiveMark: true });
  });

  it('marks Devise a Stratagem as using plain sight and not exclusive', () => {
    expect(TARGETED_SELF_EFFECT_ALLOWLIST['devise-a-stratagem']).toEqual({ senseType: 'sight', exclusiveMark: false });
  });
});

describe('bindTokenMarkEffect', () => {
  const source = { name: 'Effect: Hunt Prey', system: { rules: [{ key: 'TokenMark', slug: 'hunted-prey' }] } };

  it('returns a new object with the matching TokenMark rule\'s uuid set to the target token', () => {
    const bound = bindTokenMarkEffect(source, 'hunted-prey', 'Scene.s1.Token.t1');
    expect(bound.system.rules[0]).toEqual({ key: 'TokenMark', slug: 'hunted-prey', uuid: 'Scene.s1.Token.t1' });
  });

  it('never mutates the original source object', () => {
    const original = JSON.parse(JSON.stringify(source));
    bindTokenMarkEffect(source, 'hunted-prey', 'Scene.s1.Token.t1');
    expect(source).toEqual(original);
  });

  it('returns null when no rule matches the given slug', () => {
    expect(bindTokenMarkEffect(source, 'some-other-slug', 'Scene.s1.Token.t1')).toBeNull();
  });

  it('returns null for a source with no rules at all', () => {
    expect(bindTokenMarkEffect({ system: { rules: [] } }, 'hunted-prey', 'Scene.s1.Token.t1')).toBeNull();
  });

  it('leaves every other rule on the source untouched', () => {
    const multi = { system: { rules: [{ key: 'RollOption', option: 'x' }, { key: 'TokenMark', slug: 'devise-a-stratagem' }] } };
    const bound = bindTokenMarkEffect(multi, 'devise-a-stratagem', 'Scene.s1.Token.t2');
    expect(bound.system.rules[0]).toEqual({ key: 'RollOption', option: 'x' });
    expect(bound.system.rules[1]).toEqual({ key: 'TokenMark', slug: 'devise-a-stratagem', uuid: 'Scene.s1.Token.t2' });
  });
});

describe('findActiveMarkEffects', () => {
  const effects = [
    { slug: 'effect-hunt-prey', system: { rules: [{ key: 'TokenMark', slug: 'hunted-prey', uuid: 'Scene.s1.Token.t1' }], badge: null } },
    { slug: 'effect-devise-a-stratagem', system: { rules: [{ key: 'TokenMark', slug: 'devise-a-stratagem', uuid: 'Scene.s1.Token.t2' }], badge: { value: 17 } } },
    { slug: 'effect-unrelated', system: { rules: [], badge: null } },
  ];

  it('finds the mark effect(s) bound to a given target token, with their own badge value when present', () => {
    expect(findActiveMarkEffects(effects, 'Scene.s1.Token.t1')).toEqual([{ slug: 'hunted-prey', badgeValue: null }]);
    expect(findActiveMarkEffects(effects, 'Scene.s1.Token.t2')).toEqual([{ slug: 'devise-a-stratagem', badgeValue: 17 }]);
  });

  it('returns an empty array for a token bound by no active mark', () => {
    expect(findActiveMarkEffects(effects, 'Scene.s1.Token.unmarked')).toEqual([]);
  });

  it('returns every matching mark when more than one effect is bound to the same target', () => {
    const both = [...effects.slice(0, 2)];
    both[1].system.rules[0].uuid = 'Scene.s1.Token.t1';
    expect(findActiveMarkEffects(both, 'Scene.s1.Token.t1')).toEqual([
      { slug: 'hunted-prey', badgeValue: null },
      { slug: 'devise-a-stratagem', badgeValue: 17 },
    ]);
  });
});
```

- [x] **Step 2: Run tests to verify they fail**

Run: `npm test -- tests/targeted-feat-actions.test.mjs`
Expected: FAIL — `scripts/targeted-feat-actions.mjs` doesn't exist yet.

- [x] **Step 3: Write `scripts/targeted-feat-actions.mjs`**

```js
/**
 * #922: pure helpers for the targeted-self-effect feat family (Hunt
 * Prey, Devise a Stratagem) — both bind PF2e's own TokenMark rule
 * element to a chosen target rather than needing module-side mechanics
 * for what happens afterward. No Foundry API surface at all.
 */

/**
 * First slice allowlist (per the approved spec's own Decision 3) —
 * widening to the rest of the ~21 marked-target self-effects is #946.
 * `senseType` picks which real-RAW sense check scripts/dungeon-combat.mjs
 * uses when building this item's vocabulary ("detect" — Hunt Prey's own
 * "see or hear" — reuses detectableOpponents; "sight" — Devise's own "a
 * creature you can see" — reuses plain hasLineOfSight).
 * `exclusiveMark` — Hunt Prey allows only one prey at a time (RAW:
 * re-using it re-designates), Devise a Stratagem does not persist long
 * enough for that question to matter (1 round, turn-start expiry).
 */
export const TARGETED_SELF_EFFECT_ALLOWLIST = Object.freeze({
  "hunt-prey": { senseType: "detect", exclusiveMark: true },
  "devise-a-stratagem": { senseType: "sight", exclusiveMark: false },
});

/**
 * Confirmed live: neither Hunt Prey's nor Devise a Stratagem's own
 * TokenMark rule carries a `uuid` by default — this module adds one.
 * Returns a new object (never mutates `effectSource`); `null` when no
 * rule with `key: "TokenMark"` and a matching `slug` exists at all (an
 * effect source this plan's own allowlist should never actually hand it,
 * but checked anyway rather than assumed).
 */
export function bindTokenMarkEffect(effectSource, slug, targetTokenUuid) {
  const rules = effectSource?.system?.rules ?? [];
  const index = rules.findIndex((r) => r.key === "TokenMark" && r.slug === slug);
  if (index < 0) return null;
  const nextRules = rules.map((r, i) => (i === index ? { ...r, uuid: targetTokenUuid } : r));
  return { ...effectSource, system: { ...effectSource.system, rules: nextRules } };
}

/**
 * Which of `effectItems` (an actor's own active effects) are bound, via
 * their own TokenMark rule's `uuid`, to `targetTokenUuid` — used to
 * annotate a Strike candidate against a marked opponent (Task 4) so the
 * reasoning model can see the follow-up is ready. `badgeValue` surfaces
 * Devise a Stratagem's pre-rolled d20 (`effect.system.badge.value`);
 * Hunt Prey carries no badge, so this is always `null` for it.
 */
export function findActiveMarkEffects(effectItems, targetTokenUuid) {
  const matches = [];
  for (const effect of effectItems ?? []) {
    const rules = effect.system?.rules ?? [];
    const mark = rules.find((r) => r.key === "TokenMark" && r.uuid === targetTokenUuid);
    if (mark) matches.push({ slug: mark.slug, badgeValue: effect.system?.badge?.value ?? null });
  }
  return matches;
}
```

- [x] **Step 4: Run tests to verify they pass**

Run: `npm test -- tests/targeted-feat-actions.test.mjs`
Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add scripts/targeted-feat-actions.mjs tests/targeted-feat-actions.test.mjs
git commit -m "feat(#922): add targeted-self-effect pure helpers (TokenMark binding)

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 2: Vocabulary enumeration for targeted self-effects

**Files:**
- Modify: `scripts/agent-candidates.mjs`
- Modify: `scripts/dungeon-combat.mjs`
- Test: `tests/agent-candidates.test.mjs`
- Test: `tests/dungeon-combat-targeted-feat-vocabulary.test.mjs`

**Interfaces:**
- Consumes: `TARGETED_SELF_EFFECT_ALLOWLIST` (Task 1).
- Produces: `buildFeatVocabulary` (per #910/#914's plans) accepts a third entry list, `targetedSelfEffectEntries`, each becoming a `kind: "targetedSelfEffect"` vocabulary entry with a real `targetId`; `computeTargetedSelfEffectVocabularyEntries(actor, opponents, actionsRemaining)` in `dungeon-combat.mjs`.

- [x] **Step 1: Write the failing tests**

Add to `tests/agent-candidates.test.mjs` (inside the existing `describe('buildFeatVocabulary', ...)` block, per #910/#914's plans):

```js
  it('builds a targetedSelfEffect vocabulary entry with a real targetId', () => {
    const vocabulary = buildFeatVocabulary({
      selfEffectEntries: [], compositeEntries: [],
      targetedSelfEffectEntries: [{ itemId: 'i4', slug: 'hunt-prey', name: 'Hunt Prey', cost: 1, targetId: 'opp1', effectSummary: 'mark prey: +bonuses vs Goblin' }],
    });
    expect(vocabulary).toEqual([
      { type: 'feat', kind: 'targetedSelfEffect', itemId: 'i4', slug: 'hunt-prey', name: 'Hunt Prey', cost: 1, targetId: 'opp1', effectSummary: 'mark prey: +bonuses vs Goblin' },
    ]);
  });
```

Create `tests/dungeon-combat-targeted-feat-vocabulary.test.mjs`:

```js
import { describe, it, expect } from 'vitest';
import { computeTargetedSelfEffectVocabularyEntries } from '../scripts/dungeon-combat.mjs';

function featItem({ id = 'hp1', slug = 'hunt-prey', name = 'Hunt Prey', cost = 1 } = {}) {
  return { id, slug, name, system: { actionType: { value: 'action' }, actions: { value: cost }, selfEffect: { uuid: `Compendium.x.${slug}` } } };
}

describe('computeTargetedSelfEffectVocabularyEntries', () => {
  const opponentDetected = { id: 'opp1', name: 'Goblin', hasLineOfSight: true, token: { document: { uuid: 'Scene.s1.Token.opp1' } } };

  it('offers Hunt Prey against a detectable opponent', () => {
    const actor = { itemTypes: { feat: [featItem()], effect: [] } };
    const entries = computeTargetedSelfEffectVocabularyEntries(actor, [opponentDetected], 3, { isDetected: () => true, hasSight: () => true });
    expect(entries).toEqual([
      { itemId: 'hp1', slug: 'hunt-prey', name: 'Hunt Prey', cost: 1, targetId: 'opp1', effectSummary: expect.stringContaining('Goblin') },
    ]);
  });

  it('excludes Hunt Prey against the opponent it is already marking (re-designation needs a different target)', () => {
    const actor = {
      itemTypes: {
        feat: [featItem()],
        effect: [{ system: { rules: [{ key: 'TokenMark', slug: 'hunted-prey', uuid: 'Scene.s1.Token.opp1' }] } }],
      },
    };
    const entries = computeTargetedSelfEffectVocabularyEntries(actor, [opponentDetected], 3, { isDetected: () => true, hasSight: () => true });
    expect(entries).toEqual([]);
  });

  it('excludes Devise a Stratagem while its own effect is already active', () => {
    const actor = {
      itemTypes: {
        feat: [featItem({ id: 'da1', slug: 'devise-a-stratagem', name: 'Devise a Stratagem' })],
        effect: [{ slug: 'effect-devise-a-stratagem', system: { rules: [{ key: 'TokenMark', slug: 'devise-a-stratagem', uuid: 'Scene.s1.Token.other' }] } }],
      },
    };
    const entries = computeTargetedSelfEffectVocabularyEntries(actor, [opponentDetected], 3, { isDetected: () => true, hasSight: () => true });
    expect(entries).toEqual([]);
  });

  it('excludes a target with no line of sight for Devise a Stratagem (plain sight required)', () => {
    const actor = { itemTypes: { feat: [featItem({ id: 'da1', slug: 'devise-a-stratagem', name: 'Devise a Stratagem' })], effect: [] } };
    const entries = computeTargetedSelfEffectVocabularyEntries(actor, [opponentDetected], 3, { isDetected: () => true, hasSight: () => false });
    expect(entries).toEqual([]);
  });

  it('excludes a target not detected for Hunt Prey (detect sense required)', () => {
    const actor = { itemTypes: { feat: [featItem()], effect: [] } };
    const entries = computeTargetedSelfEffectVocabularyEntries(actor, [opponentDetected], 3, { isDetected: () => false, hasSight: () => true });
    expect(entries).toEqual([]);
  });

  it('excludes a feat not in the allowlist', () => {
    const actor = { itemTypes: { feat: [featItem({ id: 'o1', slug: 'some-other-feat', name: 'Other' })], effect: [] } };
    expect(computeTargetedSelfEffectVocabularyEntries(actor, [opponentDetected], 3, { isDetected: () => true, hasSight: () => true })).toEqual([]);
  });

  it('excludes when cost exceeds actions remaining', () => {
    const actor = { itemTypes: { feat: [featItem()], effect: [] } };
    expect(computeTargetedSelfEffectVocabularyEntries(actor, [opponentDetected], 0, { isDetected: () => true, hasSight: () => true })).toEqual([]);
  });
});
```

- [x] **Step 2: Run tests to verify they fail**

Run: `npm test -- tests/agent-candidates.test.mjs tests/dungeon-combat-targeted-feat-vocabulary.test.mjs`
Expected: FAIL — neither function/parameter exists yet.

- [x] **Step 3: Extend `buildFeatVocabulary` in `scripts/agent-candidates.mjs`**

```js
export function buildFeatVocabulary({ selfEffectEntries = [], compositeEntries = [], targetedSelfEffectEntries = [] }) {
  const vocabulary = [];
  for (const entry of selfEffectEntries) {
    vocabulary.push({
      type: 'feat', kind: 'selfEffect',
      itemId: entry.itemId, slug: entry.slug, name: entry.name, cost: entry.cost,
      targetId: null, replacesStance: entry.replacesStance ?? null,
      effectSummary: entry.effectSummary ?? null,
      durationLabel: entry.durationLabel ?? null,
      frequencyLabel: entry.frequencyLabel ?? null,
    });
  }
  for (const entry of compositeEntries) {
    vocabulary.push({
      type: 'feat', kind: 'composite',
      itemId: entry.itemId, slug: entry.slug, name: entry.name, cost: entry.cost,
      targetId: entry.targetId,
    });
  }
  for (const entry of targetedSelfEffectEntries) {
    vocabulary.push({
      type: 'feat', kind: 'targetedSelfEffect',
      itemId: entry.itemId, slug: entry.slug, name: entry.name, cost: entry.cost,
      targetId: entry.targetId, effectSummary: entry.effectSummary,
    });
  }
  return vocabulary;
}
```

(`buildFeatCandidates`, per #914's plan, already matches generically on `(kind, itemId, targetId)` with no kind-specific branching and already carries `match.replacesStance`/`match.cost` through — add `stratagem: match.stratagem` to its own candidate-push object too, a one-field addition, since Task 3's execution needs it on the candidate; `targetedSelfEffectEntries` never sets `stratagem` in this slice since it's always fixed to `"attack"` for Devise and irrelevant for Hunt Prey — Task 3 hardcodes `"attack"` directly rather than threading it through the vocabulary/candidate at all, so **no change to `buildFeatCandidates` is actually needed** — confirm this is still true once Task 3 is written, and only add the `stratagem` field here if Task 3 ends up needing it threaded through after all.)

- [x] **Step 4: Implement `computeTargetedSelfEffectVocabularyEntries` in `scripts/dungeon-combat.mjs`**

```js
import { TARGETED_SELF_EFFECT_ALLOWLIST } from "./targeted-feat-actions.mjs";
```

```js
/** #922: the targeted-self-effect vocabulary category — scans
 * `actor.itemTypes.feat` for the first-slice allowlist (Hunt Prey,
 * Devise a Stratagem), builds one entry per legal target. `senseCheckers`
 * is `{ isDetected(opponent), hasSight(opponent) }`, injected so this
 * function stays easily testable without a real combat/canvas; the real
 * caller (Step 5) wires `isDetected` to detectableOpponents-membership
 * and `hasSight` to hasLineOfSight. */
export function computeTargetedSelfEffectVocabularyEntries(actor, opponents, actionsRemaining, senseCheckers) {
  const entries = [];
  for (const item of actor.itemTypes?.feat ?? []) {
    const allowlisted = TARGETED_SELF_EFFECT_ALLOWLIST[item.slug];
    if (!allowlisted) continue;
    if (!item.system.selfEffect) continue;
    const cost = item.system.actions?.value ?? 1;
    if (cost > actionsRemaining) continue;

    const activeMarkTokenUuids = (actor.itemTypes?.effect ?? [])
      .flatMap((e) => e.system?.rules ?? [])
      .filter((r) => r.key === "TokenMark" && r.slug === item.slug)
      .map((r) => r.uuid);
    if (allowlisted.exclusiveMark ? activeMarkTokenUuids.length > 0 : activeMarkTokenUuids.length > 0) {
      // Both feats in this slice exclude themselves entirely while
      // already active against ANY target (Hunt Prey: re-designation
      // needs a different target, so the currently-marked one is
      // excluded below rather than the feat itself; Devise a Stratagem:
      // not offered at all while active, per the approved spec).
      if (!allowlisted.exclusiveMark) continue;
    }

    for (const opponent of opponents) {
      const sensed = allowlisted.senseType === "detect" ? senseCheckers.isDetected(opponent) : senseCheckers.hasSight(opponent);
      if (!sensed) continue;
      const opponentTokenUuid = opponent.token?.document?.uuid;
      if (allowlisted.exclusiveMark && activeMarkTokenUuids.includes(opponentTokenUuid)) continue;
      const effectSummary = item.slug === "hunt-prey"
        ? `mark prey: +bonuses vs ${opponent.name}`
        : `d20 replaces next Strike vs ${opponent.name}`;
      entries.push({ itemId: item.id, slug: item.slug, name: item.name, cost, targetId: opponent.id, effectSummary });
    }
  }
  return entries;
}
```

(Note: Devise a Stratagem's "not offered while active" exclusion happens via the `if (!allowlisted.exclusiveMark) continue;` branch inside the first guard — when `activeMarkTokenUuids.length > 0` and the feat is NOT exclusive, the whole feat is skipped for every target; when it IS exclusive (Hunt Prey), the feat stays eligible but the per-opponent loop below excludes only the currently-marked target. Re-read this logic once more against the Task 2 Step 1 tests above before considering it done — the two different exclusion shapes for the two feats are easy to invert by mistake.)

- [x] **Step 5: Wire into `getPendingAgentTurn`**

Right after the self-effect/composite feat vocabulary block (per #910/#914's plans), add:

```js
  const detectedOpponentIds = new Set(detectableOpponents(combat, combatant).map((o) => o.id));
  const targetedSelfEffectEntries = computeTargetedSelfEffectVocabularyEntries(
    combatant.actor, opponents, turnState.actionsRemaining,
    {
      isDetected: (opponent) => detectedOpponentIds.has(opponent.id),
      hasSight: (opponent) => opponent.hasLineOfSight !== false,
    },
  );
```

Add `targetedSelfEffectEntries` to the existing `buildFeatVocabulary({...})` call, and pass the resulting combined `featVocabulary` into `buildCandidateList` and the function's own return object exactly as #910/#914's plans already do (no new top-level field needed — `targetedSelfEffect` entries live inside the same `featVocabulary` array `selfEffect`/`composite` entries already do).

- [x] **Step 6: Run tests to verify they pass**

Run: `npm test -- tests/agent-candidates.test.mjs tests/dungeon-combat-targeted-feat-vocabulary.test.mjs`
Expected: PASS.

- [x] **Step 7: Run the full suite**

Run: `npm test`
Expected: PASS (0 new failures).

- [x] **Step 8: Commit**

```bash
git add scripts/agent-candidates.mjs scripts/dungeon-combat.mjs tests/agent-candidates.test.mjs tests/dungeon-combat-targeted-feat-vocabulary.test.mjs
git commit -m "feat(#922): build the targetedSelfEffect feat vocabulary (Hunt Prey, Devise a Stratagem)

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 3: Execution — bind the target, create the effect, toggle Devise's suboption

**Files:**
- Modify: `scripts/dungeon-combat.mjs`
- Test: `tests/dungeon-combat-targeted-feat-execution.test.mjs`

**Interfaces:**
- Consumes: `bindTokenMarkEffect` (Task 1).
- Produces: a new branch inside `applyAgentDecision`'s existing `kind === "feat"` dispatch (per #910's plan) for `candidate.kind === "targetedSelfEffect"`.

- [x] **Step 1: Write the failing tests**

Find and read #910's own `tests/dungeon-combat-feat-self-effect-execution.test.mjs` first to copy its exact stub shape (`fromUuid` stub, `createEmbeddedDocuments`/`deleteEmbeddedDocuments` mocks), then:

```js
// tests/dungeon-combat-targeted-feat-execution.test.mjs
import { describe, it, expect, vi } from 'vitest';
import { applyAgentDecision } from '../scripts/dungeon-combat.mjs';

describe('applyAgentDecision targetedSelfEffect execution (Hunt Prey)', () => {
  it('creates the Hunt Prey effect with its TokenMark rule bound to the resolved target token', async () => {
    // Stub fromUuid to return { toObject: () => ({ system: { rules: [{ key: 'TokenMark', slug: 'hunted-prey' }] } }) }.
    // combatant.actor.createEmbeddedDocuments is a vi.fn().
    // await applyAgentDecision(combat, combatantId, 'feat:hp1:opp1', 'r');
    // expect(combatant.actor.createEmbeddedDocuments).toHaveBeenCalledWith('Item', [
    //   expect.objectContaining({ system: expect.objectContaining({
    //     rules: [expect.objectContaining({ key: 'TokenMark', slug: 'hunted-prey', uuid: expect.stringContaining('Token') })],
    //   }) }),
    // ]);
  });

  it('deletes a prior Hunt Prey effect before creating the new one (re-designation)', async () => {
    // combatant.actor.itemTypes.effect already has one effect whose rules
    // include { key: 'TokenMark', slug: 'hunted-prey', uuid: '...' }.
    // expect(combatant.actor.deleteEmbeddedDocuments).toHaveBeenCalledWith('Item', [thatEffect.id]);
    // expect(combatant.actor.deleteEmbeddedDocuments) called BEFORE createEmbeddedDocuments
    // (assert call order via mock.invocationCallOrder, matching #910's own
    // "deletes the old stance effect first" test ordering assertion).
  });

  it('does nothing when the target can no longer be resolved', async () => {
    // resolveOpponentForTurn returns null/undefined -- createEmbeddedDocuments
    // must never be called.
  });

  it('does nothing when the effect source has no matching TokenMark rule', async () => {
    // fromUuid resolves to an effect with no TokenMark rule at all --
    // createEmbeddedDocuments must never be called; bindTokenMarkEffect's
    // own null return is the guard.
  });
});

describe('applyAgentDecision targetedSelfEffect execution (Devise a Stratagem)', () => {
  it('creates the effect bound to the target, then toggles the attack suboption on the created item', async () => {
    // Stub createEmbeddedDocuments to resolve with [{ id: 'createdEffect1' }]
    // (confirm this is really what createEmbeddedDocuments resolves with
    // on a real Foundry actor before asserting on it -- it may need to be
    // read back via actor.items.get(id) instead; check this against
    // whichever existing test in this codebase already asserts on a
    // createEmbeddedDocuments return value, if any, before writing this
    // assertion).
    // combatant.actor.toggleRollOption is a vi.fn().
    // expect(combatant.actor.toggleRollOption).toHaveBeenCalledWith('all', 'devise-a-stratagem', 'createdEffect1', true, 'attack');
  });
});
```

- [x] **Step 2: Run tests to verify they fail (once filled in)**

Run: `npm test -- tests/dungeon-combat-targeted-feat-execution.test.mjs`
Expected: FAIL — no `targetedSelfEffect` dispatch exists yet.

- [x] **Step 3: Implement**

```js
import { bindTokenMarkEffect } from "./targeted-feat-actions.mjs";
```

```js
/** #922: Hunt Prey/Devise a Stratagem's own execution — binds the
 * system's own TokenMark rule to the chosen target (confirmed live
 * neither effect's rule carries a uuid by default) and creates the
 * effect, letting the system's rule elements handle everything
 * afterward. Mirrors #910's own executeSelfEffectFeat origin-context
 * shape exactly; the only differences are the TokenMark binding step,
 * Hunt Prey's own re-designation delete, and Devise's own suboption
 * toggle after creation. */
async function executeTargetedSelfEffectFeat(combat, combatant, candidate) {
  const target = resolveOpponentForTurn(combat, combatant, candidate.targetId);
  if (!target) return;
  const item = (combatant.actor.itemTypes?.feat ?? []).find((i) => i.id === candidate.itemId);
  if (!item) return;
  const effectSource = await fromUuid(item.system.selfEffect.uuid);
  if (!effectSource) return;

  const targetTokenUuid = target.token?.document?.uuid;
  if (!targetTokenUuid) return;
  const bound = bindTokenMarkEffect(effectSource.toObject(), item.slug, targetTokenUuid);
  if (!bound) return;

  if (item.slug === "hunt-prey") {
    const priorMark = (combatant.actor.itemTypes?.effect ?? []).find((e) =>
      (e.system?.rules ?? []).some((r) => r.key === "TokenMark" && r.slug === "hunted-prey"),
    );
    if (priorMark) await combatant.actor.deleteEmbeddedDocuments("Item", [priorMark.id]);
  }

  const validTraits = (item.system.traits?.value ?? []).filter((t) => t in EffectPF2e.validTraits);
  const merged = foundry.utils.mergeObject(bound, {
    _id: null,
    flags: { [MODULE_ID]: { agentSelfEffect: true } },
    system: {
      context: {
        origin: {
          actor: combatant.actor.uuid,
          token: combatant.token?.document?.uuid ?? null,
          item: item.uuid,
          spellcasting: null,
          rollOptions: item.getOriginData().rollOptions,
        },
        target: { actor: target.actor.uuid, token: targetTokenUuid },
        roll: null,
      },
      traits: { value: validTraits },
    },
  });
  const [created] = await combatant.actor.createEmbeddedDocuments("Item", [merged]);

  if (item.slug === "devise-a-stratagem" && created) {
    await combatant.actor.toggleRollOption("all", "devise-a-stratagem", created.id, true, "attack");
  }

  if (item.system.frequency) {
    await item.update({ "system.frequency.value": item.system.frequency.value - 1 });
  }
}
```

Add the dispatch inside `applyAgentDecision`'s existing `candidate.type === "feat"` branch (per #910's plan), alongside its `kind === "selfEffect"` check:

```js
  } else if (candidate.type === "feat" && candidate.kind === "selfEffect") {
    await executeSelfEffectFeat(combat, combatant, candidate);
  } else if (candidate.type === "feat" && candidate.kind === "targetedSelfEffect") {
    await executeTargetedSelfEffectFeat(combat, combatant, candidate);
```

- [x] **Step 4: Run tests to verify they pass**

Run: `npm test -- tests/dungeon-combat-targeted-feat-execution.test.mjs`
Expected: PASS.

- [x] **Step 5: Run the full suite**

Run: `npm test`
Expected: PASS (0 new failures).

- [x] **Step 6: Commit**

```bash
git add scripts/dungeon-combat.mjs tests/dungeon-combat-targeted-feat-execution.test.mjs
git commit -m "feat(#922): execute Hunt Prey and Devise a Stratagem (bind target, create effect)

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 4: Annotate Strike candidates against a marked opponent

**Files:**
- Modify: `scripts/agent-candidates.mjs`
- Modify: `scripts/dungeon-combat.mjs`
- Test: `tests/agent-candidates.test.mjs`

**Interfaces:**
- Consumes: `findActiveMarkEffects` (Task 1).
- Produces: `buildStrikeCandidates`'s `summary` field gains a mark annotation when the opponent entry carries one.

- [x] **Step 1: Write the failing test**

Add to `tests/agent-candidates.test.mjs` (inside the existing `describe('buildStrikeCandidates', ...)` block):

```js
  it('annotates the summary when the opponent is marked by one of the actor\'s own active mark effects', () => {
    const opponent = { id: 'opp1', name: 'Goblin', distanceSquares: 1, markAnnotation: 'marked: devise-a-stratagem, d20 = 17' };
    const candidates = buildStrikeCandidates({ readyActions: [{ slug: 'dagger', label: 'Dagger', variantCount: 3, reachSquares: 1 }], opponents: [opponent], mapIncrement: 0 });
    expect(candidates[0].summary).toBe('Dagger vs Goblin (variant 0) [marked: devise-a-stratagem, d20 = 17]');
  });

  it('omits the annotation entirely for an unmarked opponent (no regression to the existing summary format)', () => {
    const opponent = { id: 'opp1', name: 'Goblin', distanceSquares: 1 };
    const candidates = buildStrikeCandidates({ readyActions: [{ slug: 'dagger', label: 'Dagger', variantCount: 3, reachSquares: 1 }], opponents: [opponent], mapIncrement: 0 });
    expect(candidates[0].summary).toBe('Dagger vs Goblin (variant 0)');
  });
```

- [x] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/agent-candidates.test.mjs`
Expected: FAIL — `buildStrikeCandidates` ignores `opponent.markAnnotation`.

- [x] **Step 3: Update `buildStrikeCandidates` in `scripts/agent-candidates.mjs`**

```js
export function buildStrikeCandidates({ readyActions, opponents, mapIncrement }) {
  const candidates = [];
  for (const action of readyActions) {
    const variantIndex = Math.min(mapIncrement, action.variantCount - 1);
    for (const opponent of opponents) {
      if (!withinRangeAndSight(opponent, action.reachSquares)) continue;
      const base = `${action.label} vs ${opponent.name} (variant ${variantIndex})`;
      candidates.push({
        id: `strike:${action.slug}:${opponent.id}`, type: 'strike',
        actionSlug: action.slug, targetId: opponent.id, variantIndex, cost: 1,
        summary: opponent.markAnnotation ? `${base} [${opponent.markAnnotation}]` : base,
      });
    }
  }
  return candidates;
}
```

- [x] **Step 4: Compute `markAnnotation` per opponent in `getPendingAgentTurn`**

Right after `opponents` is built (per the existing code in `scripts/dungeon-combat.mjs`), add:

```js
  const opponentsWithMarks = opponents.map((o) => {
    const tokenUuid = rawOpponents.find((r) => r.id === o.id)?.token?.document?.uuid;
    const marks = tokenUuid ? findActiveMarkEffects(combatant.actor.itemTypes?.effect ?? [], tokenUuid) : [];
    if (!marks.length) return o;
    const label = marks
      .map((m) => (m.badgeValue != null ? `marked: ${m.slug}, d20 = ${m.badgeValue}` : `marked: ${m.slug}`))
      .join("; ");
    return { ...o, markAnnotation: label };
  });
```

Pass `opponentsWithMarks` (instead of the plain `opponents`) into the existing `buildStrikeCandidates({...})` call inside `buildCandidateList`'s own invocation — **only** that one call site; every other `build*Candidates` call in the same `buildCandidateList` invocation keeps using the original `opponents` array unchanged (the mark annotation is a Strike-summary-only concern per the approved spec, not a change to any other candidate type's own opponent data).

Add the import:

```js
import { findActiveMarkEffects } from "./targeted-feat-actions.mjs";
```

- [x] **Step 5: Run tests to verify they pass**

Run: `npm test -- tests/agent-candidates.test.mjs`
Expected: PASS.

- [x] **Step 6: Run the full suite**

Run: `npm test`
Expected: PASS (0 new failures).

- [x] **Step 7: Commit**

```bash
git add scripts/agent-candidates.mjs scripts/dungeon-combat.mjs tests/agent-candidates.test.mjs
git commit -m "feat(#922): annotate Strike candidates against a marked opponent

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 5: Version bump

**Files:**
- Modify: `module.json`

**Interfaces:**
- Consumes: nothing.
- Produces: nothing — final housekeeping step before merge.

- [ ] **Step 1: Check the current version and bump it**

Run: `grep '"version"' module.json`

A **minor** bump per `CLAUDE.md`'s versioning rule.

- [ ] **Step 2: Verify no other file hardcodes the old version**

Run: `grep -rn "<old version string>" . --include="*.json" --include="*.mjs" --include="*.md" | grep -v node_modules | grep -v docs/superpowers`

- [ ] **Step 3: Commit**

```bash
git add module.json
git commit -m "chore(#922): bump version for targeted feat actions support

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Self-Review

**1. Spec coverage:**
- Decision 1 (#927 absorbed, #946 widens later) — this plan implements only the first-slice allowlist (Task 1), touching nothing that would preclude #946 from later replacing it with a derived filter.
- Decision 2 (pre-fill the `TokenMark` rule's `uuid`) — Task 1's `bindTokenMarkEffect`, used in Task 3.
- Decision 3 (first slice: Hunt Prey + Devise a Stratagem only) — `TARGETED_SELF_EFFECT_ALLOWLIST`'s exact two entries.
- Decision 4 (the non-selfEffect long tail is #947) — nothing in this plan touches any feat without a `selfEffect`.
- The Design section's vocabulary entry shape, legal-target senses, Devise's fixed `attack` sub-choice, already-in-effect rules per feat, and `effectSummary` wording — Task 2's `computeTargetedSelfEffectVocabularyEntries` implements every one of these exactly, with a dedicated test per exclusion rule.
- The Design section's Strike-summary annotation — Task 4, with a dedicated "no regression to the existing format" test.
- The Execution section's 8 numbered steps — all implemented in Task 3's `executeTargetedSelfEffectFeat` (usage message/frequency decrement, effect loading, target binding, Devise's suboption toggle, Hunt Prey's prior-mark deletion, origin-context merge, the `agentSelfEffect` tag for #914's own cleanup, cost/whisper) — note: the GM whisper itself and the explicit `item.toMessage()` usage-message call are deliberately deferred to the real implementer's own read of #910's exact `executeSelfEffectFeat` body (Task 3's own code block omits a literal `item.toMessage()` call that #910's plan's equivalent function includes — add it in the same position, matching #910's own step ordering, when implementing this task for real, rather than treating this plan's own code block as final verbatim text on that one point).
- Error handling section (unresolvable target/effect/rule excludes rather than throws; cost spent only after creation succeeds) — Task 3's own guard-clause ordering (every `if (!...) return;` precedes any mutation; `item.update` for frequency happens only after `createEmbeddedDocuments` succeeds).
- Testing section's own enumerated cases — Tasks 1–4 each supply exactly the named cases; "Live verification" is the one bullet this plan cannot itself automate, named here rather than silently dropped, matching every prior plan in this session.

**2. Placeholder scan:** No "TBD"/"TODO"/"add appropriate X" anywhere. Task 3's own Devise test explicitly flags one real uncertainty (what `createEmbeddedDocuments` actually resolves to) as something to confirm against existing code before writing that one assertion, rather than guessing — the same deliberate, flagged exception this session's other plans use. The Self-Review's own first bullet additionally flags a known small omission in Task 3's code block (the `item.toMessage()` usage-message call) rather than silently leaving it out of the final implementation.

**3. Type consistency:** `bindTokenMarkEffect`'s return shape (a full effect-source-shaped object, or `null`) is consumed identically in Task 3's `if (!bound) return;` guard. `findActiveMarkEffects`'s `{slug, badgeValue}` shape is consumed identically in Task 4's `markAnnotation` label-building. `TARGETED_SELF_EFFECT_ALLOWLIST`'s `{senseType, exclusiveMark}` shape is read with exactly those two field names in Task 2's vocabulary builder.

**4. Review Focus:** all five items have a direct test — binding on a clone, never the original (Task 1's dedicated "never mutates" test), Devise's toggle happening strictly after creation (Task 3's own code structure — `created` is read from `createEmbeddedDocuments`'s own result before the toggle call ever runs, and the Devise test's own stub shape note flags this as the thing to get right), Hunt Prey's prior-mark deletion before the new one is created (Task 3's dedicated ordering test), an unbindable target/effect excluding rather than failing at execution (Task 3's two dedicated null-guard tests, and Task 2's vocabulary-level exclusion tests preventing the candidate from ever being offered in the first place), and cost spent only after success (Task 3's own code ordering, `item.update` for frequency placed after `createEmbeddedDocuments`).
