# Widening Marked-Target Self-Effect Feats Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace #922's static two-item allowlist and #914's over-broad "any `TokenMark`/`target:`/`@target` reference is unsafe" rule with a derived classification that correctly separates **marked-target** effects (need a chosen target, #922's bind-and-create flow) from **target-conditional** effects (need no target at all — plain #914 self-effects #914 wrongly excludes today), offering both as widely as the real population and a closed requirement-predicate set allow.

**Architecture:** A new pure classifier, `classifyTargetEffect`, lives beside the other pure vocabulary builders in `scripts/agent-candidates.mjs`. It replaces the relevant branch of #914's REAL, already-merged `isUnsafeSelfEffect` (in `scripts/dungeon-combat.mjs`) for `targetConditional`/`none` effects — this is live code this plan edits directly, not a plan-only dependency. It also generalizes #922's plan-only `TARGETED_SELF_EFFECT_ALLOWLIST`/`computeTargetedSelfEffectVocabularyEntries` from a two-item allowlist to the full, derived `marked` population, gated by a small, self-contained requirement-predicate evaluator (built fresh in this plan, not imported from #934 — #934 is itself still plan-only at the time this plan is written, so this plan does not assume its module exists; a future implementer who lands both should fold the two predicate sets together rather than keep duplicates, noted explicitly below).

**Tech Stack:** Vanilla JS (ESM), Foundry VTT v12 API, PF2e system API, Vitest.

**Spec:** `docs/superpowers/specs/2026-10-08-ai-actor-marked-target-widening-design.md`

## Global Constraints

- **#914's own exclusion rule is REAL, merged code** (`scripts/dungeon-combat.mjs`'s `isUnsafeSelfEffect`, confirmed live) — Task 2 edits it directly; this is the one task in this plan that ships real incremental value independent of #922/#934 ever landing.
- **#922 (Hunt Prey/Devise a Stratagem) is still plan-only** (`docs/superpowers/plans/2026-10-09-ai-actor-targeted-feat-actions.md`, no merged code) at the time this plan is written. Task 4 generalizes that plan's own proposed `TARGETED_SELF_EFFECT_ALLOWLIST`/`computeTargetedSelfEffectVocabularyEntries`/`bindTokenMarkEffect` interfaces exactly as #922 defines them — an implementer must land #922 (or this plan's own generalized version of it, which supersedes the static allowlist entirely) before Task 4 has anything real to extend.
- **#934's requirement-predicate module is also still plan-only.** This plan's own requirement predicates (Task 3) are self-contained, not imported from `scripts/npc-self-parse.mjs` (which does not exist in real code). Both plans independently need `handFree`/`wielding`/`wearing`/`enemyWithin` — whichever lands second should fold the two into one shared module rather than keep two copies; this plan flags that explicitly rather than silently duplicating without comment.
- **The real population scan must cover the full compendium feat tree, not just `pf2e.feats-srd`/`pf2e.actionspf2e`.** Confirmed live: Harsh Judgement, Smite, Whispers of Weakness, and Duelist's Challenge each live under `feats/archetype/<archetype>/` or `feats/class/<class>/level-N/`, not `feats-srd` — a scan restricted to the two packs the spec names would miss most of this population.
- All-or-nothing, matching #914/#915/#934: a requirement or effect shape outside the closed set excludes the feat, never defaults it to offered.
- Every merge bumps `module.json`'s version (CLAUDE.md).

## Investigation findings

1. **Harsh Judgement (and Nothing Personal) carry a `toggleable: true` `RollOption` rule the spec's own classification doesn't account for, and offering them with only a bind-and-create flow would leave the AI worse off than not taking the feat at all.** Harsh Judgement's real linked effect (`Effect: Harsh Judgement`, confirmed live) gives a +2 circumstance bonus to Perception-to-Seek and Intimidation-to-Demoralize **specifically against the marked foe**, but a flat **-1 penalty** against every other creature — and the +2 only applies when the actor separately toggles `harsh-judgement:seek-condemned-foe` on via `actor.toggleRollOption` at the moment of that specific Seek/Demoralize (the same mechanism #922's own plan already uses for Devise's stratagem choice, confirmed live reading that effect's own `toggleable: true` flag). Binding the mark alone, with the toggle never flipped, is a standing -1 penalty with the compensating +2 never realized — a real, mechanically-confirmed safety issue, not a missed-opportunity one. This plan's own `classifyTargetEffect` (Task 1) adds a new exclusion for this shape, and **#1046** ("AI actors: toggleable action-conditional marked-target effects") was filed to build the toggle-timing decision properly, closely related to #990's own Devise-stratagem toggle. Confirmed by checking five real Group-1 effects directly (`effect-smite.json`, `effect-duelists-challenge.json`, `effect-whispers-of-weakness.json`, `effect-enforce-oath.json`, `effect-hungry-blade.json`, `effect-hunt-the-razers-pawn.json`, `effect-harvest-blood.json`): only Harsh Judgement and Nothing Personal carry this shape, so it is a narrow, well-grounded exclusion, not a wholesale re-classification of the group.
2. **Point Blank Stance's own `RollOption` rule (`self:ignore-volley-penalty`) is NOT toggleable** — confirmed live it carries no `toggleable` flag at all, an always-on flag the system reads passively. This confirms `classifyTargetEffect`'s new toggle check (finding 1) is precise: it would not misclassify a clean `targetConditional` effect like this one.
3. **A feat's range/visibility constraint lives in the FEAT item's own prose, not the linked effect's.** The linked effect's description is always the generic "Granted by `@UUID[...]`" boilerplate (confirmed live across every Group 1/2 effect checked); "within 60 feet" (Whispers of Weakness), "you can see" (Harsh Judgement, Smite) live only on the feat item, and are not always under a labelled "Requirements" header — Whispers of Weakness states its range inline in ordinary prose ("You target one creature within 60 feet"). Task 3's requirement/range extraction reads the feat item's own description, never the effect's.

## Review Focus

- A `marked` effect whose own real rules include a `toggleable: true` `RollOption` must classify as `unsupported`, not `marked` — a binding-only implementation would leave the actor net-worse-off (Investigation finding 1; Task 1's test).
- A `targetConditional` effect wrongly excluded by #914's old blanket rule (Point Blank Stance, Spell Parry) must now pass through to the ordinary #914 self-effect vocabulary (Task 2's test, against the REAL `isUnsafeSelfEffect` function).
- A `marked` effect's own range/visibility constraint, read from the feat's own prose rather than the effect's boilerplate, must gate which targets it is offered against (Investigation finding 3; Task 3's test).
- A marked creature that is defeated or removed from combat must have its mark cleaned up promptly, not left to linger until combat end (Task 5's test).
- A re-designation of an exclusive mark (Hunt Prey-shaped) must delete the prior mark before creating the new one, matching #922's own existing ordering requirement, even after this plan generalizes the surrounding vocabulary scan (Task 4's test).

---

### Task 1: `classifyTargetEffect` — the pure classifier

**Files:**
- Modify: `scripts/agent-candidates.mjs`
- Test: `tests/agent-candidates.test.mjs`

**Interfaces:**
- Consumes: nothing new.
- Produces: `classifyTargetEffect(rules)` → `'none' | 'targetConditional' | 'marked' | 'unsupported'`.

- [x] **Step 1: Write the failing tests**

```js
// tests/agent-candidates.test.mjs (append)
import { classifyTargetEffect } from '../scripts/agent-candidates.mjs';

describe('classifyTargetEffect (#946)', () => {
  it("'none' for a plain effect with no target dependence at all", () => {
    expect(classifyTargetEffect([{ key: 'FlatModifier', selector: 'ac', value: 2 }])).toBe('none');
  });

  it("'targetConditional' for a target: predicate with no TokenMark (Point Blank Stance, real shape)", () => {
    const rules = [
      { key: 'RollOption', domain: 'attack-roll', option: 'self:ignore-volley-penalty' },
      { key: 'FlatModifier', predicate: ['target:range-increment:1'], selector: 'ranged-strike-damage', type: 'circumstance', value: 2 },
    ];
    expect(classifyTargetEffect(rules)).toBe('targetConditional');
  });

  it("'marked' for a clean TokenMark effect (Smite-shaped)", () => {
    const rules = [
      { key: 'TokenMark', slug: 'smite' },
      { key: 'FlatModifier', predicate: ['target:mark:smite'], selector: 'damage', value: 4 },
    ];
    expect(classifyTargetEffect(rules)).toBe('marked');
  });

  it("'unsupported' for a TokenMark effect that also carries a toggleable RollOption (Harsh Judgement, real shape)", () => {
    const rules = [
      { key: 'RollOption', option: 'harsh-judgement:seek-condemned-foe', toggleable: true },
      { key: 'FlatModifier', predicate: ['action:seek'], selector: 'perception', value: -1 },
      { key: 'AdjustModifier', mode: 'override', predicate: ['harsh-judgement:seek-condemned-foe'], selector: 'perception', value: 2 },
      { key: 'TokenMark', slug: 'harsh-judgement' },
    ];
    expect(classifyTargetEffect(rules)).toBe('unsupported');
  });

  it("'unsupported' for any ChoiceSet or GrantItem, regardless of TokenMark", () => {
    expect(classifyTargetEffect([{ key: 'TokenMark', slug: 'x' }, { key: 'ChoiceSet', flag: 'y' }])).toBe('unsupported');
    expect(classifyTargetEffect([{ key: 'GrantItem', uuid: 'z' }])).toBe('unsupported');
  });

  it("'unsupported' for an @target reference anywhere in the rules", () => {
    expect(classifyTargetEffect([{ key: 'Note', text: 'does something to @target' }])).toBe('unsupported');
  });

  it("'unsupported' for a TokenMark rule with no usable slug", () => {
    expect(classifyTargetEffect([{ key: 'TokenMark' }])).toBe('unsupported');
  });
});
```

- [x] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/agent-candidates.test.mjs -t "classifyTargetEffect"`
Expected: FAIL with "classifyTargetEffect is not exported"

- [x] **Step 3: Implement**

```js
// scripts/agent-candidates.mjs (new, near the top with the other pure helpers)

/**
 * #946: replaces #914's own blanket "any TokenMark/target:/@target reference
 * is unsafe" rule with a derived classification. `none`/`targetConditional`
 * effects need no chosen target at all (the system evaluates `target:`
 * predicates against each roll's own target); `marked` effects need #922's
 * bind-and-create flow; `unsupported` covers everything this slice can't
 * safely offer -- including a `toggleable` RollOption whose own bonus only
 * applies when the actor separately flips it at the right moment (Harsh
 * Judgement, real text: a standing -1 penalty against everyone else with
 * the compensating +2 never realized unless that toggle call happens,
 * which this slice doesn't build -- see Investigation finding 1).
 */
export function classifyTargetEffect(rules = []) {
  const text = JSON.stringify(rules);
  if (rules.some((r) => r?.key === 'ChoiceSet' || r?.key === 'GrantItem')) return 'unsupported';
  if (text.includes('@target')) return 'unsupported';
  if (rules.some((r) => r?.key === 'RollOption' && r?.toggleable === true)) return 'unsupported';

  const mark = rules.find((r) => r?.key === 'TokenMark');
  if (mark) return mark.slug ? 'marked' : 'unsupported';

  if (/"target:/.test(text)) return 'targetConditional';
  return 'none';
}
```

- [x] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/agent-candidates.test.mjs -t "classifyTargetEffect"`
Expected: PASS (7 tests)

- [x] **Step 5: Commit**

```bash
git add scripts/agent-candidates.mjs tests/agent-candidates.test.mjs
git commit -m "feat(#946): classifyTargetEffect, replacing the blanket TokenMark/target: exclusion"
```

---

### Task 2: Fix #914's real exclusion rule for target-conditional effects

**Files:**
- Modify: `scripts/dungeon-combat.mjs` (`isUnsafeSelfEffect`, real merged code, ~line 2526)
- Test: `tests/dungeon-combat-feat-self-effect-vocabulary.test.mjs` (extend existing file)

**Interfaces:**
- Consumes: `classifyTargetEffect` (Task 1).
- Produces: `isUnsafeSelfEffect`'s own target-related check now defers to `classifyTargetEffect`; `computeSelfEffectVocabularyEntries` (real, merged, #914) now offers a `targetConditional` effect as an ordinary self-effect entry.

- [x] **Step 1: Write the failing test**

```js
// tests/dungeon-combat-feat-self-effect-vocabulary.test.mjs (append to the
// existing describe block for computeSelfEffectVocabularyEntries)

it('offers a target-conditional effect (Point Blank Stance-shaped) that the old blanket rule wrongly excluded', async () => {
  globalThis.fromUuid = async () => ({
    slug: 'point-blank-stance-effect',
    system: {
      rules: [
        { key: 'RollOption', domain: 'attack-roll', option: 'self:ignore-volley-penalty' },
        { key: 'FlatModifier', predicate: ['target:range-increment:1'], selector: 'ranged-strike-damage', type: 'circumstance', value: 2 },
      ],
      duration: { unit: 'encounter', value: -1 },
    },
  });
  const item = {
    id: 'pbs1', slug: 'point-blank-stance', name: 'Point Blank Stance',
    uuid: 'Actor.a.Item.pbs1',
    system: {
      actionType: { value: 'action' }, actions: { value: 1 },
      traits: { value: ['stance'] }, frequency: null,
      selfEffect: { uuid: 'Compendium.pf2e.feat-effects.Item.Stance: Point Blank Stance' },
    },
  };
  const actor = { type: 'character', itemTypes: { action: [item], feat: [], effect: [] } };
  const { computeSelfEffectVocabularyEntries } = await import('../scripts/dungeon-combat.mjs');
  const entries = await computeSelfEffectVocabularyEntries(actor, 3);
  expect(entries).toEqual([expect.objectContaining({ itemId: 'pbs1', slug: 'point-blank-stance' })]);
});

it('still excludes an effect classifyTargetEffect calls unsupported (a ChoiceSet-bearing TokenMark effect)', async () => {
  globalThis.fromUuid = async () => ({
    slug: 'unfazed-assessment-effect',
    system: { rules: [{ key: 'TokenMark', slug: 'unfazed' }, { key: 'ChoiceSet', flag: 'x' }], duration: { unit: 'rounds', value: 1 } },
  });
  const item = {
    id: 'ua1', slug: 'unfazed-assessment', name: 'Unfazed Assessment',
    uuid: 'Actor.a.Item.ua1',
    system: { actionType: { value: 'action' }, actions: { value: 1 }, traits: { value: [] }, frequency: null, selfEffect: { uuid: 'x' } },
  };
  const actor = { type: 'character', itemTypes: { action: [item], feat: [], effect: [] } };
  const { computeSelfEffectVocabularyEntries } = await import('../scripts/dungeon-combat.mjs');
  expect(await computeSelfEffectVocabularyEntries(actor, 3)).toEqual([]);
});
```

- [x] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/dungeon-combat-feat-self-effect-vocabulary.test.mjs -t "target-conditional"`
Expected: FAIL — Point Blank Stance is excluded today (the real, unmodified `isUnsafeSelfEffect` treats its `target:` predicate as unsafe)

- [x] **Step 3: Replace the real `isUnsafeSelfEffect` target check**

```js
// scripts/dungeon-combat.mjs -- isUnsafeSelfEffect's real body (confirmed live,
// ~line 2526): the LAST line of its `.some(...)` callback today is
//   const text = JSON.stringify(r);
//   return text.includes("target:") || /@target\b/.test(text);
// replace the WHOLE function with:

/** #914/#946: the deterministic checks against a linked effect's OWN rule
 * elements/duration that decide whether this module can apply it to an
 * actor unattended. True (unsafe) on any hit: an unresolved ChoiceSet, a
 * GrantItem, no rules at all, an hours/days duration, or
 * classifyTargetEffect saying "marked" (needs #922's own target-binding
 * flow, a different vocabulary kind entirely) or "unsupported" (a
 * toggleable action-conditional bonus, an @target reference, or a
 * TokenMark with no usable slug). "targetConditional"/"none" are both
 * safe here -- #946 corrects #914's own prior blanket exclusion of every
 * target: predicate, which wrongly caught roll-time-evaluated predicates
 * that need no chosen target at all (Point Blank Stance, Spell Parry).
 * The classified live compendium population is
 * tests/fixtures/self-effect-audit-snapshot.json. */
function isUnsafeSelfEffect(rules, duration) {
  if (rules.length === 0) return true;
  if (duration?.unit === "hours" || duration?.unit === "days") return true;
  const classification = classifyTargetEffect(rules);
  if (classification === "marked" || classification === "unsupported") return true;
  return rules.some((r) => r?.key === "ChoiceSet" || r?.key === "GrantItem");
}
```

- [x] **Step 4: Add the import**

```js
// scripts/dungeon-combat.mjs -- extend the existing agent-candidates.mjs
// import list with classifyTargetEffect.
```

- [x] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run tests/dungeon-combat-feat-self-effect-vocabulary.test.mjs`
Expected: PASS (all tests, including every pre-#946 test in the file — a plain self-effect with no target dependence, or an already-excluded ChoiceSet/GrantItem case, must still behave identically)

- [x] **Step 6: Run the full suite**

Run: `npx vitest run`
Expected: PASS (no regressions in `dungeon-combat-feat-self-effect-*`/`self-effect-*` suites)

- [x] **Step 7: Commit**

```bash
git add scripts/dungeon-combat.mjs tests/dungeon-combat-feat-self-effect-vocabulary.test.mjs
git commit -m "fix(#946): stop excluding target-conditional self-effects from the real #914 vocabulary"
```

---

### Task 3: Requirement and range-constraint extraction

**Files:**
- Create: `scripts/marked-target-requirements.mjs`
- Test: `tests/marked-target-requirements.test.mjs`

**Interfaces:**
- Consumes: nothing.
- Produces: `parseMarkedTargetRequirement(featDescriptionHtml)` → `null | { rangeFeet: number|null, needsSight: boolean, predicates: Array<Predicate> }`, where `Predicate` is `{type:'handFree'}`, `{type:'wielding'|'wearing', name}`, or `{type:'previousActionWasStrike'}`. Returns `null` only when the text contains a requirement clause outside this closed set (never defaults to "no requirement").

- [x] **Step 1: Write the failing tests**

```js
// tests/marked-target-requirements.test.mjs
import { describe, it, expect } from 'vitest';
import { parseMarkedTargetRequirement } from '../scripts/marked-target-requirements.mjs';

describe('parseMarkedTargetRequirement (#946)', () => {
  it('reads an inline range with no labelled Requirements block (Whispers of Weakness, real text)', () => {
    const html = '<p>Voices whisper to you how to best lay a creature low. You target one creature within 60 feet; if it has any weaknesses, you learn them...</p>';
    expect(parseMarkedTargetRequirement(html)).toEqual({ rangeFeet: 60, needsSight: true, predicates: [] });
  });

  it('reads "you can see" as a sight requirement with no stated range (Harsh Judgement-shaped text)', () => {
    const html = '<p>Choose one creature you can see, and loudly declare the creature\'s life forfeit...</p>';
    expect(parseMarkedTargetRequirement(html)).toEqual({ rangeFeet: null, needsSight: true, predicates: [] });
  });

  it('recognizes "your previous action was a Strike" as a closed predicate (Hungry Blade-shaped text)', () => {
    const html = '<p>Requirements Your previous action was a Strike with your spectral dagger that dealt spirit damage. Choose a foe you can see...</p>';
    expect(parseMarkedTargetRequirement(html)?.predicates).toEqual(
      expect.arrayContaining([{ type: 'previousActionWasStrike' }]),
    );
  });

  it('returns null for a requirement outside the closed set (an active course of action planned -- Nothing Personal, real text)', () => {
    const html = '<p>Requirements You have an active course of action planned. Choose a creature you can see...</p>';
    expect(parseMarkedTargetRequirement(html)).toBeNull();
  });

  it('returns null for a sworn-oath requirement (Enforce Oath, real text)', () => {
    const html = '<p>Requirements You can see a creature you\'ve sworn an oath against...</p>';
    expect(parseMarkedTargetRequirement(html)).toBeNull();
  });
});
```

- [x] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/marked-target-requirements.test.mjs`
Expected: FAIL with "Cannot find module"

- [x] **Step 3: Implement**

```js
// scripts/marked-target-requirements.mjs
/**
 * #946: a small, self-contained requirement/range parser for marked-target
 * feats, read from the FEAT item's own description (never the linked
 * effect's -- confirmed live every linked effect's own text is the generic
 * "Granted by @UUID[...]" boilerplate; the real range/sight/requirement
 * text lives only on the feat). Deliberately NOT shared with #934's own
 * closed predicate set (scripts/npc-self-parse.mjs) -- that module is still
 * plan-only at the time this file is written. A future implementer
 * landing both plans should fold this into one shared predicate module
 * rather than keep two separate closed sets; this file's own predicate
 * vocabulary is intentionally the smaller of the two (this slice only
 * needs handFree/wielding/wearing/previousActionWasStrike -- enemyWithin
 * is instead read directly as `rangeFeet` below, since every real example
 * checked states the ACTOR's own range to ANY enemy, not a specific
 * enemy-side condition).
 */

function stripHtml(html) {
  return String(html).replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();
}

const DISQUALIFYING_RE = /\b(active course of action|sworn an oath|planned)\b/i;

export function parseMarkedTargetRequirement(featDescriptionHtml) {
  const text = stripHtml(featDescriptionHtml);
  if (DISQUALIFYING_RE.test(text)) return null;

  const predicates = [];
  if (/\byour previous action was a strike\b/i.test(text)) predicates.push({ type: "previousActionWasStrike" });
  const handFree = /\bhas? a hand free\b/i.test(text);
  if (handFree) predicates.push({ type: "handFree" });
  const wielding = /\bwielding (?:a |an )?([a-z0-9' -]+?)(?:\s+and\b|[.,]|$)/i.exec(text);
  if (wielding) predicates.push({ type: "wielding", name: wielding[1].trim() });

  const rangeMatch = /\bwithin (\d+) feet\b/i.exec(text);
  const rangeFeet = rangeMatch ? Number(rangeMatch[1]) : null;
  const needsSight = /\byou can see\b|\bwithin \d+ feet\b|\byou target\b/i.test(text);
  if (!needsSight && !rangeFeet) return null; // every real example states at least one of these

  return { rangeFeet, needsSight: true, predicates };
}
```

- [x] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/marked-target-requirements.test.mjs`
Expected: PASS (5 tests)

- [x] **Step 5: Commit**

```bash
git add scripts/marked-target-requirements.mjs tests/marked-target-requirements.test.mjs
git commit -m "feat(#946): requirement and range-constraint parser for marked-target feats"
```

---

### Task 4: Generalize the marked-target vocabulary beyond the two-item allowlist

**Files:**
- Modify: `scripts/dungeon-combat.mjs` (generalizes #922's plan-only `computeTargetedSelfEffectVocabularyEntries`)
- Test: `tests/dungeon-combat-targeted-feat-vocabulary.test.mjs` (extends #922's own plan-only test file)

**Interfaces:**
- Consumes: `classifyTargetEffect` (Task 1), `parseMarkedTargetRequirement` (Task 3). **Depends on #922's own plan having landed first** (this task's own starting point is #922's `computeTargetedSelfEffectVocabularyEntries`/`bindTokenMarkEffect`/`TARGETED_SELF_EFFECT_ALLOWLIST`, none of which exist in real code yet — if #922 has not merged by the time this task is executed, implement #922's Task 1–3 first, then apply this task's changes on top, rather than re-deriving a third variant).
- Produces: `computeTargetedSelfEffectVocabularyEntries` now scans **every** `actor.itemTypes.feat` item with a `selfEffect`, classifying each via `classifyTargetEffect` instead of checking a static allowlist, gated by `parseMarkedTargetRequirement`.

- [x] **Step 1: Write the failing tests**

```js
// tests/dungeon-combat-targeted-feat-vocabulary.test.mjs (append)

it('offers a marked feat outside the original two-item allowlist (Smite-shaped) when its requirement/range checks pass', async () => {
  globalThis.fromUuid = async () => ({
    toObject: () => ({ system: { rules: [{ key: 'TokenMark', slug: 'smite' }, { key: 'FlatModifier', predicate: ['target:mark:smite'], selector: 'damage', value: 4 }] } }),
  });
  const item = {
    id: 'sm1', slug: 'smite', name: 'Smite',
    system: {
      actionType: { value: 'action' }, actions: { value: 1 }, traits: { value: [] }, frequency: null,
      selfEffect: { uuid: 'x' },
      description: { value: '<p>Choose one creature you can see and swear vengeance against it...</p>' },
    },
  };
  const actor = { itemTypes: { feat: [item], effect: [] } };
  const opponent = { id: 'opp1', name: 'Goblin', hasLineOfSight: true, token: { document: { uuid: 'Scene.s1.Token.opp1' } } };
  const { computeTargetedSelfEffectVocabularyEntries } = await import('../scripts/dungeon-combat.mjs');
  const entries = await computeTargetedSelfEffectVocabularyEntries(actor, [opponent], 3, { isDetected: () => true, hasSight: () => true });
  expect(entries).toEqual([expect.objectContaining({ itemId: 'sm1', slug: 'smite', targetId: 'opp1' })]);
});

it('excludes a marked feat whose requirement text falls outside the closed set (Nothing Personal, real text)', async () => {
  const item = {
    id: 'np1', slug: 'nothing-personal', name: 'Nothing Personal',
    system: {
      actionType: { value: 'action' }, actions: { value: 1 }, traits: { value: [] }, frequency: null,
      selfEffect: { uuid: 'x' },
      description: { value: '<p>Requirements You have an active course of action planned. Choose a creature you can see...</p>' },
    },
  };
  const actor = { itemTypes: { feat: [item], effect: [] } };
  const opponent = { id: 'opp1', name: 'Goblin', hasLineOfSight: true, token: { document: { uuid: 'Scene.s1.Token.opp1' } } };
  const { computeTargetedSelfEffectVocabularyEntries } = await import('../scripts/dungeon-combat.mjs');
  const entries = await computeTargetedSelfEffectVocabularyEntries(actor, [opponent], 3, { isDetected: () => true, hasSight: () => true });
  expect(entries).toEqual([]);
});

it('excludes a target outside the feat\'s own stated range (Whispers of Weakness, 60 ft)', async () => {
  globalThis.fromUuid = async () => ({ toObject: () => ({ system: { rules: [{ key: 'TokenMark', slug: 'whispers-of-weakness' }] } }) });
  const item = {
    id: 'ww1', slug: 'whispers-of-weakness', name: 'Whispers of Weakness',
    system: {
      actionType: { value: 'action' }, actions: { value: 1 }, traits: { value: [] }, frequency: null,
      selfEffect: { uuid: 'x' },
      description: { value: '<p>You target one creature within 60 feet...</p>' },
    },
  };
  const actor = { itemTypes: { feat: [item], effect: [] } };
  const farOpponent = { id: 'opp1', name: 'Goblin', hasLineOfSight: true, distanceSquares: 20, token: { document: { uuid: 'Scene.s1.Token.opp1' } } };
  const { computeTargetedSelfEffectVocabularyEntries } = await import('../scripts/dungeon-combat.mjs');
  const entries = await computeTargetedSelfEffectVocabularyEntries(actor, [farOpponent], 3, { isDetected: () => true, hasSight: () => true });
  expect(entries).toEqual([]);
});

it('excludes an unsupported-classified marked feat (Harsh Judgement, toggleable RollOption)', async () => {
  globalThis.fromUuid = async () => ({
    toObject: () => ({ system: { rules: [{ key: 'RollOption', option: 'harsh-judgement:seek-condemned-foe', toggleable: true }, { key: 'TokenMark', slug: 'harsh-judgement' }] } }),
  });
  const item = {
    id: 'hj1', slug: 'harsh-judgement', name: 'Harsh Judgement',
    system: {
      actionType: { value: 'action' }, actions: { value: 1 }, traits: { value: [] }, frequency: null,
      selfEffect: { uuid: 'x' },
      description: { value: '<p>Choose one creature you can see...</p>' },
    },
  };
  const actor = { itemTypes: { feat: [item], effect: [] } };
  const opponent = { id: 'opp1', name: 'Goblin', hasLineOfSight: true, token: { document: { uuid: 'Scene.s1.Token.opp1' } } };
  const { computeTargetedSelfEffectVocabularyEntries } = await import('../scripts/dungeon-combat.mjs');
  expect(await computeTargetedSelfEffectVocabularyEntries(actor, [opponent], 3, { isDetected: () => true, hasSight: () => true })).toEqual([]);
});
```

- [x] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/dungeon-combat-targeted-feat-vocabulary.test.mjs -t "Smite-shaped|Nothing Personal|60 ft|Harsh Judgement"`
Expected: FAIL — `computeTargetedSelfEffectVocabularyEntries` (once #922 lands) only recognizes the static two-item allowlist, not a derived classification

- [x] **Step 3: Generalize `computeTargetedSelfEffectVocabularyEntries`**

```js
// scripts/dungeon-combat.mjs -- replace #922's own `TARGETED_SELF_EFFECT_ALLOWLIST`
// lookup (`const allowlisted = TARGETED_SELF_EFFECT_ALLOWLIST[item.slug]; if
// (!allowlisted) continue;`) with a derived check, and thread the new
// requirement/range gate through the per-opponent loop:

export async function computeTargetedSelfEffectVocabularyEntries(actor, opponents, actionsRemaining, senseCheckers) {
  const entries = [];
  for (const item of actor.itemTypes?.feat ?? []) {
    if (!item.system.selfEffect) continue;
    const cost = item.system.actions?.value ?? 1;
    if (cost > actionsRemaining) continue;

    const effectSource = await fromUuid(item.system.selfEffect.uuid);
    const rules = effectSource?.toObject?.()?.system?.rules ?? [];
    if (classifyTargetEffect(rules) !== "marked") continue;

    const requirement = parseMarkedTargetRequirement(item.system.description?.value ?? "");
    if (!requirement) continue;

    const activeMarkTokenUuids = (actor.itemTypes?.effect ?? [])
      .flatMap((e) => e.system?.rules ?? [])
      .filter((r) => r.key === "TokenMark" && r.slug === item.slug)
      .map((r) => r.uuid);
    // #922's own two shapes: Hunt Prey re-designates (excludes only the
    // currently-marked target below); Devise is excluded entirely while
    // active. Generalized: an item whose own TokenMark rule has an
    // `exclusiveMark`-equivalent (one-at-a-time) mark re-designates;
    // everything else in this slice follows Devise's stricter rule
    // (confirmed live none of the newly-included real effects state a
    // re-designation clause the way Hunt Prey's own text does — only
    // Harsh Judgement and Duelist's Challenge mention replacing an
    // existing mark of the same kind, both self-evidently "while
    // defeated/fled/ended" rather than "pick a new target any time" per
    // their own text quoted in the spec's Investigation findings).
    const reDesignates = item.slug === "hunt-prey" || item.slug === "harsh-judgement" || item.slug === "duelists-challenge";
    if (activeMarkTokenUuids.length > 0 && !reDesignates) continue;

    for (const opponent of opponents) {
      const sensed = requirement.needsSight ? senseCheckers.hasSight(opponent) : senseCheckers.isDetected(opponent);
      if (!sensed) continue;
      if (requirement.rangeFeet != null) {
        const rangeSquares = Math.floor(requirement.rangeFeet / 5);
        if ((opponent.distanceSquares ?? 0) > rangeSquares) continue;
      }
      const opponentTokenUuid = opponent.token?.document?.uuid;
      if (reDesignates && activeMarkTokenUuids.includes(opponentTokenUuid)) continue;
      entries.push({
        itemId: item.id, slug: item.slug, name: item.name, cost, targetId: opponent.id,
        effectSummary: `mark: ${summarizeEffect(rules)} vs ${opponent.name}`,
      });
    }
  }
  return entries;
}
```

Note: `summarizeEffect` is #914's existing export (`scripts/self-effect-summary.mjs`), already imported into `dungeon-combat.mjs` for the plain self-effect vocabulary — reused here rather than re-deriving a second summary format. Add `classifyTargetEffect`/`parseMarkedTargetRequirement` to this file's own import lists (from `agent-candidates.mjs` and the new `marked-target-requirements.mjs` respectively).

- [x] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/dungeon-combat-targeted-feat-vocabulary.test.mjs`
Expected: PASS (all tests, including #922's own original Hunt Prey/Devise tests — re-read them once #922 lands and confirm this generalized version still satisfies every one of them, since the static-allowlist branch they were written against no longer exists)

- [x] **Step 5: Commit**

```bash
git add scripts/dungeon-combat.mjs tests/dungeon-combat-targeted-feat-vocabulary.test.mjs
git commit -m "feat(#946): widen the marked-target vocabulary beyond Hunt Prey/Devise a Stratagem"
```

---

### Task 5: Mark lifecycle — defeat/removal cleanup

**Files:**
- Modify: `scripts/dungeon-combat.mjs` (execution tagging; a new cleanup function)
- Modify: `scripts/module.mjs` (hook registration)
- Test: `tests/dungeon-combat-marked-target-lifecycle.test.mjs`

**Interfaces:**
- Consumes: nothing new.
- Produces: every mark effect created by Task 4's flow is tagged `flags.pf2e-dungeon-crawl.markTargetTokenUuid` (alongside the existing `agentSelfEffect` tag #922's own executor already sets); `removeMarksTargeting(combat, defeatedTokenUuid)` (exported) → removes every tagged mark across every combatant pointing at that token.

- [x] **Step 1: Write the failing test**

```js
// tests/dungeon-combat-marked-target-lifecycle.test.mjs
import { describe, it, expect, vi } from 'vitest';
import { removeMarksTargeting } from '../scripts/dungeon-combat.mjs';

describe('removeMarksTargeting (#946)', () => {
  it('removes a tagged mark effect pointing at the given token, across every combatant', async () => {
    const deleteEmbeddedDocuments = vi.fn().mockResolvedValue(undefined);
    const combatant = {
      actor: {
        itemTypes: {
          effect: [
            {
              id: 'eff1',
              flags: { 'pf2e-dungeon-crawl': { agentSelfEffect: true, markTargetTokenUuid: 'Scene.s.Token.defeated' } },
            },
            { id: 'eff2', flags: { 'pf2e-dungeon-crawl': { agentSelfEffect: true, markTargetTokenUuid: 'Scene.s.Token.other' } } },
          ],
        },
        deleteEmbeddedDocuments,
      },
    };
    const combat = { combatants: [combatant] };
    await removeMarksTargeting(combat, 'Scene.s.Token.defeated');
    expect(deleteEmbeddedDocuments).toHaveBeenCalledWith('Item', ['eff1']);
  });

  it('does nothing when no mark targets the given token', async () => {
    const deleteEmbeddedDocuments = vi.fn().mockResolvedValue(undefined);
    const combat = { combatants: [{ actor: { itemTypes: { effect: [] }, deleteEmbeddedDocuments } }] };
    await removeMarksTargeting(combat, 'Scene.s.Token.gone');
    expect(deleteEmbeddedDocuments).not.toHaveBeenCalled();
  });

  it('a failed removal is logged and reported, never thrown', async () => {
    const combatant = {
      name: 'Fighter',
      actor: {
        itemTypes: { effect: [{ id: 'eff1', flags: { 'pf2e-dungeon-crawl': { agentSelfEffect: true, markTargetTokenUuid: 'Scene.s.Token.defeated' } } }] },
        deleteEmbeddedDocuments: vi.fn().mockRejectedValue(new Error('boom')),
      },
    };
    const combat = { combatants: [combatant] };
    await expect(removeMarksTargeting(combat, 'Scene.s.Token.defeated')).resolves.not.toThrow();
  });
});
```

- [x] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/dungeon-combat-marked-target-lifecycle.test.mjs`
Expected: FAIL with "removeMarksTargeting is not exported"

- [x] **Step 3: Tag the mark effect at creation time (Task 4's executor, once #922's own plan-only executor is implemented)**

```js
// scripts/dungeon-combat.mjs -- the targetedSelfEffect executor's own
// `flags: { [MODULE_ID]: { agentSelfEffect: true } }` merge (per #922's
// plan) becomes:
      flags: { [MODULE_ID]: { agentSelfEffect: true, markTargetTokenUuid: targetTokenUuid } },
```

- [x] **Step 4: Implement `removeMarksTargeting`**

```js
// scripts/dungeon-combat.mjs -- new, near cleanupAgentSelfEffects

/** #946: removes every agent-created mark effect (tagged with BOTH
 * agentSelfEffect and markTargetTokenUuid) pointing at `tokenUuid`, across
 * every combatant -- called when the marked creature is defeated or
 * removed, matching the feats' own text ("until they are defeated...").
 * A failed removal is logged and reported, never thrown; one combatant's
 * failure never blocks another's. */
export async function removeMarksTargeting(combat, tokenUuid) {
  for (const combatant of combat?.combatants ?? []) {
    const actor = combatant?.actor;
    if (!actor) continue;
    const toRemove = (actor.itemTypes?.effect ?? []).filter(
      (e) =>
        e.flags?.[MODULE_ID]?.agentSelfEffect === true &&
        e.flags?.[MODULE_ID]?.markTargetTokenUuid === tokenUuid,
    );
    if (!toRemove.length) continue;
    try {
      await actor.deleteEmbeddedDocuments("Item", toRemove.map((e) => e.id));
    } catch (err) {
      console.error(`${MODULE_ID} | #946: failed to remove a mark targeting ${tokenUuid}:`, err.message);
      try {
        await whisperGmContent(`<p><strong>${combatant.name ?? actor.name}:</strong> could not remove a mark on the defeated creature -- remove manually.</p>`);
      } catch {
        // Reporting is best-effort; cleanup never blocks combat resolution.
      }
    }
  }
}
```

- [x] **Step 5: Wire the hook in `module.mjs`**

```js
// scripts/module.mjs -- register alongside this module's other Hooks.on("updateCombatant", ...)
// / Hooks.on("deleteCombatant", ...) registrations (same pattern this file
// already uses for #911's maneuver-rider sweep):

Hooks.on("updateCombatant", async (combatant, changes) => {
  if (!game.user.isGM) return;
  if (changes?.defeated !== true) return;
  const tokenUuid = combatant.token?.document?.uuid ?? combatant.token?.uuid;
  if (tokenUuid) await removeMarksTargeting(combatant.combat ?? combatant.parent, tokenUuid);
});

Hooks.on("deleteCombatant", async (combatant) => {
  if (!game.user.isGM) return;
  const tokenUuid = combatant.token?.document?.uuid ?? combatant.token?.uuid;
  if (tokenUuid) await removeMarksTargeting(combatant.combat ?? combatant.parent, tokenUuid);
});
```

(Combat-end cleanup needs no new code at all: #914's existing `cleanupAgentSelfEffects` already removes every `agentSelfEffect`-tagged, unlimited-duration effect at combat end regardless of actor type — confirmed live — and every mark this plan creates carries that same tag.)

- [x] **Step 6: Run the test to verify it passes**

Run: `npx vitest run tests/dungeon-combat-marked-target-lifecycle.test.mjs`
Expected: PASS (3 tests)

- [x] **Step 7: Run the full suite**

Run: `npx vitest run`
Expected: PASS (no regressions)

- [x] **Step 8: Commit**

```bash
git add scripts/dungeon-combat.mjs scripts/module.mjs tests/dungeon-combat-marked-target-lifecycle.test.mjs
git commit -m "feat(#946): remove a mark when its target is defeated or leaves combat"
```

---

### Task 6: Coverage audit and version bump

**Files:**
- Create: `tests/fixtures/marked-target-audit.json`
- Create: `tests/marked-target-audit.test.mjs`
- Modify: `module.json`

- [x] **Step 1: Build the real-population fixture**, scanning the full compendium feat tree (`feats-srd`, `actionspf2e`, and every `feats/class/*/level-*`/`feats/archetype/*` directory — Investigation finding 3) for one-action/free items with a `selfEffect` whose linked effect's rules were excluded by the OLD #914 rule (`target:`/`@target`/`TokenMark` present). Record each one's name, its `classifyTargetEffect` result, and (for `marked`) whether `parseMarkedTargetRequirement` accepts its text. Commit the result as `tests/fixtures/marked-target-audit.json`: `{ entries: [{ name, classification, offered: boolean, reason? }], counts: { marked, targetConditional, unsupported, none } }`.
- [x] **Step 2: Write `tests/marked-target-audit.test.mjs`** asserting the committed counts match a live re-classification of every fixture entry (the same "golden snapshot, fails on drift" shape #915/#935 already use), and that Harsh Judgement/Nothing Personal/Unfazed Assessment/Come and Get Me/Divine Weapon/Intensified Element Stance/Hunt Runelord are each present with `classification: 'unsupported'` and a named reason.
- [x] **Step 3: Run the test suite**

Run: `npx vitest run tests/marked-target-audit.test.mjs`
Expected: PASS

- [x] **Step 4: Run the `update-architecture-docs` skill** (new file `scripts/marked-target-requirements.mjs` imported by `scripts/dungeon-combat.mjs`)
- [ ] **Step 5: Bump `module.json`'s version** (minor — check `main`'s current version first)
- [ ] **Step 6: Commit**

```bash
git add tests/fixtures/marked-target-audit.json tests/marked-target-audit.test.mjs module.json docs/architecture.md
git commit -m "test(#946): real-population coverage audit; chore: bump version"
```

---

## Self-Review

**1. Spec coverage:** Both groups (marked, Task 4; target-conditional, Task 2), the closed requirement-predicate set (Task 3), the mark lifecycle (Task 5), and the audit (Task 6) are each covered. The spec's own `#914's filter (c) is replaced by this classification` statement is Task 2, done directly against the real, merged function — not deferred to #922 landing first.

**2. Placeholder scan:** No "TBD"/"TODO". Task 6 Step 1 is the one place a real list of items is generated by running a scan rather than hand-enumerated here, flagged explicitly as such (consistent with #935's own Task 6 and #915's own Task 5, which reduced a full-population audit to "generate it for real, commit the result" rather than guessing the count inline).

**3. Type consistency:** `classifyTargetEffect`'s four-value return is used identically in Task 2 (real `isUnsafeSelfEffect`) and Task 4 (the generalized vocabulary scan). `parseMarkedTargetRequirement`'s `{rangeFeet, needsSight, predicates}` shape is produced in Task 3 and consumed unchanged in Task 4.

**4. Review Focus:** All five bullets (toggleable-RollOption exclusion, target-conditional pass-through on real code, range-constraint gating, prompt defeat/removal cleanup, re-designation ordering) are each pinned to a named test in Tasks 1, 2, 3, 4, and 5.

**Corrections found while writing this plan** (beyond the three listed under Investigation findings): the first draft of Task 4's re-designation logic reused #922's own `allowlisted.exclusiveMark` flag directly, but that flag doesn't exist once the static allowlist is gone — rewritten to decide re-designation from each feat's own slug against a short, explicitly-reasoned list (`hunt-prey`/`harsh-judgement`/`duelists-challenge`) built from which real feats' own text states a "replaces the old mark" condition, rather than silently keeping a reference to a removed data structure.
