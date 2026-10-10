# Targeted Feat Actions Without a Self-Effect Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Offer the nine-class first slice of targeted, no-`selfEffect` feats/actions (Felling Strike, Instant Opening, Predictable!, ...) through a new `feat` vocabulary kind `targetedAction`, recognized by shape (Strike-plus, a roll against the target's own defense DC, a plain target-effect) with a reviewed override table for the rest.

**Architecture:** A pure parser, `scripts/feat-action-shapes.mjs`, recognizes each item's shape from its structured enrichers. Three real shapes (not the spec's stated four — see Investigation finding 3) cover the grammar-driven population: `strikePlus` (builds fresh, generalizing #933's plan-only rider vocabulary rather than importing a module that doesn't exist in real code yet), `rollVsTargetDefense` (new; the spec's own `skillCheckVsDc` and `targetSave` are the same real mechanical shape, see finding 3), and `targetEffect`. Degree outcomes reuse #915's real, merged condition/penalty application helpers where the outcome lands on the target, and a new self-bonus path (reusing #946's plan-only `TokenMark`-binding pattern) where it lands on the actor "against the creature." Everything else is the override table.

**Tech Stack:** Vanilla JS (ESM), Foundry VTT v12 API, PF2e system API, Vitest.

**Spec:** `docs/superpowers/specs/2026-10-09-ai-actor-targeted-feat-actions-no-selfeffect-design.md`

## Implementation notes (2026-10-09, implementation pass)

The plan predates the merges of #922/#933/#934/#935/#946; it was implemented against current `main`, with these deviations:

- **Two shapes, not three.** `rollVsTargetDefense` (Task 3) was dropped: in the real pf2e 8.5.0 first-slice population no feat of that shape has outcomes this module can apply (Predictable!'s effect is a ChoiceSet/GrantItem pair with a one-use save bonus; Sabotage = item damage; Leading Dance/Whirling Throw = forced movement; Connect the Dots needs an ally; Pointed Question hangs on Devise a Stratagem). The audit fixture records each one's reason.
- **Grammar.** Shapes are matched sentence-by-sentence on the rendered text with leading flavor prose allowed (the plan's leftover-word check would have rejected every real feat, which all open with flavor). `strikePlus` riders are "if you hit and deal damage, the target is <condition>[, or <condition> on a critical hit][ duration][ (or <duration> on a critical hit)]"; Felling Strike stays out (no flying state is tracked). `targetEffect` is "Off-Guard against your attacks", applied as a TokenMark + EphemeralEffect effect on the actor (predicate `self:mark:<slug>`, confirmed live), not the plain condition.
- **Vocabulary.** Folded into #910's `buildFeatVocabulary` as `targetedActionEntries` (kind `targetedAction`), not a separate `buildTargetedActionVocabulary`; the gates are cost, frequency, rage, concentrate-while-raging, finisher (panache + agile/finesse melee + the system's finisher toggle), press, reach/line of sight, Resounding Blow's held bludgeoning melee weapon, range and perceivability.
- **Finisher rule** tracked as `finisherUsed` in the turn state: no attack-trait candidate after a finisher; panache removed after it.
- **Override table** keyed by slug, empty (no audited feat is modeled-but-misread).
- **Version bump** left to the merger (caller's instruction).

## Global Constraints

- **Dependency reality check, confirmed live at the time this plan is written:** #915 is real, merged code. #909/#940 are real, merged code (confirmed via `git log --grep`). #910/#914 are real, merged code. **#922, #933, #934, #935, #946 are all still plan-only** — no corresponding `.mjs` file exists in the repo. This plan does not import from any of those five; it builds self-contained equivalents where it needs their mechanisms, flagged explicitly at each point, and notes where a future implementer landing both plans should fold duplicated logic together rather than keep two copies.
- All-or-nothing, unchanged from #915/#933/#934: any unmatched sentence, unsupported requirement, or unmodeled degree outcome excludes the feat, never partially applies it.
- A feat's shape, requirements and range all live in the FEAT/ACTION item's own description — never a linked effect's (several real examples carry a trailing `@UUID[...feat-effects...]` reference whose own description is always the generic "Granted by..." boilerplate, same finding #946 already made).
- Every merge bumps `module.json`'s version (CLAUDE.md).

## Investigation findings

Confirmed live against the real compendium (`pf2e.feats-srd`, `pf2e.feats`, `pf2e.actions`, `pf2e.class-features`, and class-specific subdirectories under each) — **not just the two packs the spec names**, which miss most of this population (the same finding #946 already made for marked-target feats, confirmed again here: Felling Strike/Instant Opening/Predictable! live under `feats/class/<class>/level-N/`, Exploit Vulnerability/Pointed Question live under `actions/class/<class>/`, not `feats-srd`/`actionspf2e`).

1. **Two of the spec's own cited `skillCheckVsDc` examples don't actually qualify for the nine-class first slice, for two different reasons.** *Bon Mot*'s real traits are `["auditory","concentrate","emotion","general","linguistic","mental","skill"]` — **no class trait at all**; it is a general/skill feat anyone can take, not a fighter/rogue/... feat, and is excluded by this plan's own class-trait filter. *Exploit Vulnerability*'s real Requirements text is "You are holding your implement" — a thaumaturge-specific equipment slot this module has no way to check (not a literal item name `wielding`/`wearing` can match), and even past that its own degree text is almost entirely narrative knowledge-granting prose ("you learn all of the creature's resistances, weaknesses, and immunities...") with no parseable condition in three of its four degrees. Both exclusions are correct and intentional, not gaps to close.
2. **A third cited example, *Pointed Question* (investigator, real class trait, in scope), also fails — its degree outcomes are narrow, single-use, and conditional on a SPECIFIC later action ("Off-Guard to the Strike you make using Devise a Stratagem against it before the end of your turn"), not a plain duration-scoped condition.** Confirms the all-or-nothing rule is doing real work here, not just a theoretical safeguard.
3. **The spec's `skillCheckVsDc` and `targetSave` are the same real mechanical shape, and this plan merges them into one, `rollVsTargetDefense`.** Checking the spec's own cited `targetSave` examples directly (*Predictable!*, *Sabotage*, *Leading Dance*) found every one uses `@Check[<statistic>|defense:<save>]` — the PF2e enricher's own "roll MY statistic against the TARGET's <save> DC" option — the identical real shape the spec's `skillCheckVsDc` examples (Bon Mot, before it was excluded by finding 1) also use. None of the three used an explicit numeric `dc:N` (the shape #915's NPC parser models, where the TARGET rolls against a flat DC) at all. This plan recognizes one real shape (an ACTOR roll against a `defense:`-named target statistic) rather than the spec's own two, since no real example of a target-rolls-a-save-against-the-actor's-class-DC shape was found in this slice.
4. **Within `rollVsTargetDefense`, the degree outcome lands on the ACTOR, not the target, more often than not** — *Predictable!*'s own outcome ("a +2 circumstance bonus to AC against the creature... and to your next saving throw against the creature") is a self-bonus conditioned on a specific creature, mechanically the same shape #946 already models for Smite/Harsh Judgement (a `TokenMark`-bound effect), not #915's target-side condition/penalty model. *Sabotage*'s outcome is item damage (a `damage-only` shape, already counted separately in the spec's own population breakdown) and *Leading Dance*'s is forced movement — neither reduces to either model, and both correctly stay unmodeled by the grammar (override-table candidates, or left for a follow-up). This plan's `rollVsTargetDefense` executor therefore supports exactly two outcome landings — a target-side condition/penalty (reusing #915's real helpers) and an actor-side `TokenMark`-bound self-bonus "against the creature" (reusing #946's plan-only binding pattern) — and nulls anything else (item damage, forced movement, narrative-only text).
5. **`strikePlus` needs rider vocabulary beyond #933's four named shapes.** *Felling Strike*'s real text has an on-hit rider (the target falls, if flying) AND a separate on-critical-hit rider (can't Fly/Leap/levitate until the end of the actor's next turn) — the second is not a PF2e condition at all, so it needs its own small, named rider type (`flightDenial`) rather than reusing #933's condition-application rider. This plan's `strikePlus` shape ships two riders for the first slice (`groundedFall`, `flightDenial`) rather than assuming #933's exact four transfer unchanged — a real, concrete instance of "NPC abilities and PC feats both being 'a Strike with a rider' doesn't mean they share one rider vocabulary."

## Resolved scope (revised from the spec's own four families to three, per finding 3)

1. `strikePlus` — a Strike with an on-hit and/or on-critical-hit rider.
2. `rollVsTargetDefense` — the actor rolls a statistic against the target's named defense DC; degree outcomes land either on the target (condition/penalty) or on the actor as a `TokenMark`-bound self-bonus "against the creature."
3. `targetEffect` — a plain, no-check condition applied to a chosen target within range.
4. The override table, for everything the three shapes miss.

## Review Focus

- A feat with no class trait in the first-slice set (Bon Mot-shaped) must be excluded by the class filter before any shape is even attempted (Investigation finding 1; Task 1's test).
- A `rollVsTargetDefense` feat whose outcome is item damage or forced movement (not a condition/penalty or a self-bonus) must stay unmodeled, never force-fit into either supported landing (Investigation finding 4; Task 3's test).
- `strikePlus`'s on-critical-hit rider must apply only on an actual critical hit, never conflated with the on-hit rider's own trigger (Felling Strike; Task 1's test).
- A requirement referencing class-specific, untracked equipment ("your implement") must exclude the feat, never be guessed as satisfied (Investigation finding 1; Task 4's test).
- The coverage audit must report real, computed counts per shape/override/not-offered, not an assumed split — the spec's own 68/69/57/4 breakdown is unverified against this plan's own narrower, corrected three-shape model and must not be copied into a test assertion uncritically (Task 6).

---

### Task 1: `strikePlus` shape

**Files:**
- Create: `scripts/feat-action-shapes.mjs`
- Test: `tests/feat-action-shapes.test.mjs`

**Interfaces:**
- Consumes: nothing.
- Produces: `parseTargetedFeat(item)` → `null | { shape: 'strikePlus'|'rollVsTargetDefense'|'targetEffect', cost, requirements: [], params }`. For `strikePlus`: `params = { weaponRequirement: {trait?, damageType?}|null, onHit: Rider|null, onCriticalHit: Rider|null }` where `Rider` is `{type:'groundedFall', fallFeet}|{type:'flightDenial', durationSeconds}|{type:'condition', slug, value, durationSeconds}`.

- [x] **Step 1: Write the failing tests**

```js
// tests/feat-action-shapes.test.mjs
import { describe, it, expect } from 'vitest';
import { parseTargetedFeat, FEAT_ACTION_CLASS_SET } from '../scripts/feat-action-shapes.mjs';

function makeFeat({ traits, description, actionType = 'action', actions = 1 }) {
  return {
    type: 'action',
    system: {
      actionType: { value: actionType },
      actions: { value: actions },
      traits: { value: traits },
      frequency: null,
      description: { value: description },
    },
  };
}

describe('parseTargetedFeat -- strikePlus (#947)', () => {
  it('recognizes an on-hit and on-critical-hit rider pair (Felling Strike, real text)', () => {
    const item = makeFeat({
      traits: ['fighter'], actions: 2,
      description: "<p>Make a Strike. If it hits and deals damage to a flying target, the target falls up to 120 feet. The fall is gradual enough that if it causes the target to hit the ground, the target takes no damage from the fall.</p><p>If the attack is a critical hit, the target can't Fly, Leap, levitate, or otherwise leave the ground until the end of your next turn.</p>",
    });
    const parsed = parseTargetedFeat(item);
    expect(parsed).toMatchObject({ shape: 'strikePlus', cost: 2 });
    expect(parsed.params.onHit).toEqual({ type: 'groundedFall', fallFeet: 120 });
    expect(parsed.params.onCriticalHit).toEqual({ type: 'flightDenial', durationSeconds: 'untilNextTurn' });
  });

  it('a strike feat with an unrecognized rider stays null (all-or-nothing)', () => {
    const item = makeFeat({
      traits: ['fighter'], actions: 1,
      description: '<p>Make a Strike. If it hits, the target becomes convinced of your supremacy and reconsiders its allegiance.</p>',
    });
    expect(parseTargetedFeat(item)).toBeNull();
  });

  it('a feat outside the nine-class first slice is excluded regardless of shape (Bon Mot, real traits)', () => {
    const item = makeFeat({
      traits: ['auditory', 'concentrate', 'emotion', 'general', 'linguistic', 'mental', 'skill'],
      description: "<p>Choose a foe within 30 feet and roll a Diplomacy check against the target's Will DC.</p>",
    });
    expect(parseTargetedFeat(item)).toBeNull();
  });

  it('FEAT_ACTION_CLASS_SET lists exactly the nine first-slice classes', () => {
    expect([...FEAT_ACTION_CLASS_SET].sort()).toEqual(
      ['barbarian', 'champion', 'fighter', 'investigator', 'monk', 'ranger', 'rogue', 'swashbuckler', 'thaumaturge'].sort(),
    );
  });
});
```

- [x] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/feat-action-shapes.test.mjs`
Expected: FAIL with "Cannot find module '../scripts/feat-action-shapes.mjs'"

- [x] **Step 3: Implement**

```js
// scripts/feat-action-shapes.mjs
/**
 * #947: pure recognition for targeted feat/action shapes with no
 * `selfEffect` -- no Foundry API surface at all, same boundary discipline
 * as #915's npc-ability-parse.mjs. This file does NOT import #933's
 * npc-strike-shapes.mjs (plan-only, no real file exists) -- the
 * `strikePlus` rider vocabulary below is built fresh for PC feats and is
 * deliberately smaller than #933's own four NPC-ability shapes (see this
 * plan's own Investigation finding 5: Felling Strike needs a
 * `flightDenial` rider #933's own shapes never named, since NPC
 * abilities and PC feats don't share one rider vocabulary just because
 * both are "a Strike with a rider").
 */

export const FEAT_ACTION_CLASS_SET = new Set([
  'fighter', 'rogue', 'champion', 'swashbuckler', 'monk', 'ranger', 'barbarian', 'investigator', 'thaumaturge',
]);

function stripHtml(html) {
  return String(html).replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
}

function actionCost(item) {
  const actionType = item.system?.actionType?.value;
  if (actionType === 'free') return 0;
  if (actionType !== 'action') return null;
  const cost = item.system?.actions?.value;
  return typeof cost === 'number' && cost > 0 ? cost : null;
}

/** "the target falls up to N feet" -- Felling Strike's own on-hit rider. */
function parseGroundedFallRider(text) {
  const match = /\bthe target falls up to (\d+) feet\b/i.exec(text);
  return match ? { type: 'groundedFall', fallFeet: Number(match[1]) } : null;
}

/** "the target can't Fly, Leap, levitate, or otherwise leave the ground
 * until the end of your next turn" -- Felling Strike's own on-crit rider.
 * A flat, closed phrase match (not a general grammar) since this is the
 * only real example checked; a future widening generalizes this once a
 * second real instance is found. */
function parseFlightDenialRider(text) {
  if (/\bcan'?t fly, leap, levitate, or otherwise leave the ground\b/i.test(text)) {
    const untilNext = /\buntil the end of (?:your|its|their) next turn\b/i.test(text);
    return { type: 'flightDenial', durationSeconds: untilNext ? 'untilNextTurn' : null };
  }
  return null;
}

function parseRider(text) {
  return parseGroundedFallRider(text) ?? parseFlightDenialRider(text) ?? null;
}

const STRIKE_SENTENCE_RE = /\bmake a strike\b\.?/i;
const ON_HIT_RE = /\bif it hits[^.]*?,\s*(.+?)\./i;
const ON_CRIT_RE = /\bif the attack is a critical hit,\s*(.+?)\./i;

function recognizeStrikePlus(plainText, cost) {
  if (!STRIKE_SENTENCE_RE.test(plainText)) return null;
  let remaining = plainText.replace(STRIKE_SENTENCE_RE, ' ');

  const onHitMatch = ON_HIT_RE.exec(remaining);
  const onHit = onHitMatch ? parseRider(onHitMatch[0]) : null;
  if (onHitMatch && !onHit) return null;
  if (onHitMatch) remaining = remaining.replace(onHitMatch[0], ' ');

  const onCritMatch = ON_CRIT_RE.exec(remaining);
  const onCriticalHit = onCritMatch ? parseRider(onCritMatch[0]) : null;
  if (onCritMatch && !onCriticalHit) return null;
  if (onCritMatch) remaining = remaining.replace(onCritMatch[0], ' ');

  if (!onHit && !onCriticalHit) return null;
  // A sentence about the fall being harmless (Felling Strike's own second
  // sentence) is flavor explaining the mechanic above, not a new rider --
  // recognized and discarded rather than counted as leftover, same "known,
  // explicitly-ignored flavor clause" treatment #933/#935 already use for
  // comparable cases.
  remaining = remaining.replace(/\bthe fall is gradual enough[^.]*\./i, ' ');
  const leftover = remaining.replace(/\b(the|a|an|and|or|it|is|are)\b/gi, ' ').replace(/[.,;\s]+/g, ' ').trim();
  if (leftover.length > 0) return null;

  return { shape: 'strikePlus', cost, requirements: [], params: { weaponRequirement: null, onHit, onCriticalHit } };
}

export function parseTargetedFeat(item) {
  if (item?.type !== 'action' && item?.type !== 'feat') return null;
  const traits = item.system?.traits?.value ?? [];
  if (!traits.some((t) => FEAT_ACTION_CLASS_SET.has(t))) return null;
  if (item.system?.selfEffect) return null;
  const cost = actionCost(item);
  if (cost === null) return null;

  const html = item.system?.description?.value ?? '';
  const plainText = stripHtml(html);
  return recognizeStrikePlus(plainText, cost);
}
```

- [x] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/feat-action-shapes.test.mjs`
Expected: PASS (4 tests)

- [x] **Step 5: Commit**

```bash
git add scripts/feat-action-shapes.mjs tests/feat-action-shapes.test.mjs
git commit -m "feat(#947): strikePlus shape recognition for targeted feats"
```

---

### Task 2: `targetEffect` shape

**Files:**
- Modify: `scripts/feat-action-shapes.mjs`
- Test: `tests/feat-action-shapes.test.mjs`

**Interfaces:**
- Consumes: nothing new.
- Produces: `parseTargetedFeat` also recognizes `targetEffect`. `params = { rangeFeet: number|null, conditions: [{slug, value, durationSeconds}] }`.

- [x] **Step 1: Write the failing tests**

```js
// tests/feat-action-shapes.test.mjs (append)
describe('parseTargetedFeat -- targetEffect (#947)', () => {
  it('recognizes a plain condition-with-range feat (Instant Opening, real text)', () => {
    const item = makeFeat({
      traits: ['concentrate', 'rogue'],
      description: "<p>You distract your opponent with a few choice words or a rude gesture. Choose a target within 30 feet. It's Off-Guard against your attacks until the end of your next turn.</p>",
    });
    const parsed = parseTargetedFeat(item);
    expect(parsed).toMatchObject({ shape: 'targetEffect', cost: 1 });
    expect(parsed.params).toEqual({
      rangeFeet: 30,
      conditions: [{ slug: 'off-guard', value: null, durationSeconds: 'untilNextTurn' }],
    });
  });

  it('a target-effect feat with an unrecognized trailing clause stays null', () => {
    const item = makeFeat({
      traits: ['rogue'],
      description: '<p>Choose a target within 30 feet. It is Off-Guard against your attacks, and it also forgets your name.</p>',
    });
    expect(parseTargetedFeat(item)).toBeNull();
  });
});
```

- [x] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/feat-action-shapes.test.mjs -t "targetEffect"`
Expected: FAIL (no `targetEffect` recognizer exists yet)

- [x] **Step 3: Implement**

```js
// scripts/feat-action-shapes.mjs -- add alongside the KNOWN_CONDITION_SLUGS
// this file needs its own copy of (self-contained per this plan's own
// Global Constraints -- #915's own KNOWN_CONDITION_SLUGS export exists in
// real code and COULD be imported directly; doing so here, since
// npc-ability-parse.mjs is real merged code, not plan-only):
import { KNOWN_CONDITION_SLUGS } from "./npc-ability-parse.mjs";
const CONDITION_SET = new Set(KNOWN_CONDITION_SLUGS);

const SECONDS_PER_ROUND = 6;
const DURATION_UNIT_SECONDS = { round: SECONDS_PER_ROUND, rounds: SECONDS_PER_ROUND, minute: 60, minutes: 60, hour: 3600, hours: 3600 };

function extractDuration(text) {
  const timed = /\bfor (\d+) (rounds?|minutes?|hours?)\b/i.exec(text);
  if (timed) return { durationSeconds: Number(timed[1]) * DURATION_UNIT_SECONDS[timed[2].toLowerCase()], remaining: text.replace(timed[0], ' ') };
  const untilNext = /\buntil the end of (?:your|its|their) next turn\b/i.exec(text);
  if (untilNext) return { durationSeconds: 'untilNextTurn', remaining: text.replace(untilNext[0], ' ') };
  return { durationSeconds: null, remaining: text };
}

/** "Choose a target within N feet. It is/It's <condition>[, ...][for/until
 * <duration>]." -- a plain, no-check target effect. Every clause after the
 * range sentence must resolve to a known condition or leftover disqualifies
 * (all-or-nothing). */
function recognizeTargetEffect(plainText, cost) {
  const rangeMatch = /\bchoose a target within (\d+) feet\.?/i.exec(plainText);
  if (!rangeMatch) return null;
  const rangeFeet = Number(rangeMatch[1]);
  let rest = plainText.replace(rangeMatch[0], ' ').replace(/^\s*it'?s?\b/i, ' ');

  const duration = extractDuration(rest);
  rest = duration.remaining;

  const conditions = [];
  for (const slug of KNOWN_CONDITION_SLUGS) {
    const re = new RegExp(`\\b${slug}\\b(?:\\s+(\\d+))?`, 'i');
    const match = re.exec(rest);
    if (!match) continue;
    conditions.push({ slug, value: match[1] ? Number(match[1]) : null, durationSeconds: duration.durationSeconds });
    rest = rest.replace(re, ' ');
  }
  if (!conditions.length) return null;
  const leftover = rest.replace(/\b(the|a|an|and|or|it|is|are|against|your|attacks)\b/gi, ' ').replace(/[.,;\s]+/g, ' ').trim();
  if (leftover.length > 0) return null;

  return { shape: 'targetEffect', cost, requirements: [], params: { rangeFeet, conditions } };
}
```

```js
// scripts/feat-action-shapes.mjs -- parseTargetedFeat's own body: try
// targetEffect alongside strikePlus:

  return recognizeStrikePlus(plainText, cost) ?? recognizeTargetEffect(plainText, cost);
```

- [x] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/feat-action-shapes.test.mjs`
Expected: PASS (all tests)

- [x] **Step 5: Commit**

```bash
git add scripts/feat-action-shapes.mjs tests/feat-action-shapes.test.mjs
git commit -m "feat(#947): targetEffect shape recognition"
```

---

### Task 3: `rollVsTargetDefense` shape

**Files:**
- Modify: `scripts/feat-action-shapes.mjs`
- Test: `tests/feat-action-shapes.test.mjs`

**Interfaces:**
- Consumes: nothing new.
- Produces: `parseTargetedFeat` also recognizes `rollVsTargetDefense`. `params = { statistic: string, defenseSave: 'fortitude'|'reflex'|'will', degrees: {criticalSuccess, success, failure, criticalFailure} }` where each degree is `null | {landing:'target', conditions:[], penalties:[]} | {landing:'actorVsTarget', penalties:[{type,value,selectors}]}` (penalties here are always bonuses in practice — a positive `value` — reusing #935's own `{type,value,selectors}` shape for both signs rather than inventing a second one).

- (dropped, see Implementation notes) **Step 1: Write the failing tests**

```js
// tests/feat-action-shapes.test.mjs (append)
describe('parseTargetedFeat -- rollVsTargetDefense (#947)', () => {
  it('recognizes an actor-roll-vs-target-defense feat with self-bonus-against-the-creature outcomes (Predictable!, real text)', () => {
    const item = makeFeat({
      traits: ['rogue'],
      description: "<p>Choose one target and attempt a Perception check against the foe's Deception DC or a hard DC of the foe's level, whichever is higher.</p><hr /><p><strong>Critical Success</strong> You gain a +2 circumstance bonus to AC against the creature until the start of your next turn and a +2 circumstance bonus to your next saving throw against the creature before the start of your next turn.</p><p><strong>Success</strong> As critical success, except the circumstance bonus is only +1.</p><p><strong>Failure</strong> You gain no benefit.</p><p><strong>Critical Failure</strong> You take a -1 circumstance penalty to AC against the creature until the start of your next turn, and a -1 circumstance penalty to your next saving throw against the creature before the start of your next turn.</p>",
    });
    const parsed = parseTargetedFeat(item);
    expect(parsed).toMatchObject({ shape: 'rollVsTargetDefense', cost: 1 });
    expect(parsed.params.statistic).toBe('perception');
    expect(parsed.params.degrees.criticalSuccess).toEqual({
      landing: 'actorVsTarget',
      penalties: [{ type: 'circumstance', value: 2, selectors: ['ac'] }],
    });
    expect(parsed.params.degrees.failure).toEqual({ landing: 'actorVsTarget', penalties: [] });
  });

  it('a defense-check feat whose outcome is item damage (not a condition or self-bonus) stays null (Sabotage, real text)', () => {
    const item = makeFeat({
      traits: ['incapacitation', 'rogue'],
      description: '<p>Attempt a Thievery check against the Reflex DC of the creature.</p><hr /><p><strong>Critical Success</strong> You deal damage equal to 4 x your Thievery proficiency bonus.</p><p><strong>Success</strong> You deal damage equal to double your Thievery proficiency bonus.</p>',
    });
    expect(parseTargetedFeat(item)).toBeNull();
  });

  it('a defense-check feat whose outcome is forced movement stays null (Leading Dance, real text)', () => {
    const item = makeFeat({
      traits: ['bravado', 'move', 'swashbuckler'],
      description: '<p>Attempt a Performance check against an adjacent enemy\'s Will DC.</p><hr /><p><strong>Critical Success</strong> You both move up to 10 feet in the same direction.</p>',
    });
    expect(parseTargetedFeat(item)).toBeNull();
  });
});
```

- (dropped, see Implementation notes) **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/feat-action-shapes.test.mjs -t "rollVsTargetDefense"`
Expected: FAIL (no recognizer exists yet)

- (dropped, see Implementation notes) **Step 3: Implement**

```js
// scripts/feat-action-shapes.mjs -- the degree-block splitter, reused
// identically from #915's own real, merged splitDegreeBlocks logic (that
// function is module-private there, not exported -- duplicated here at the
// same small size rather than reaching into another file's internals;
// a future refactor that exports it from npc-ability-parse.mjs should
// replace this copy):
const DEGREE_LABELS = { 'Critical Success': 'criticalSuccess', Success: 'success', Failure: 'failure', 'Critical Failure': 'criticalFailure' };
const DEGREE_KEYS = ['criticalSuccess', 'success', 'failure', 'criticalFailure'];

function splitDegreeBlocks(html) {
  const re = /<p>\s*<strong>\s*(Critical Success|Success|Failure|Critical Failure)\s*<\/strong>([\s\S]*?)<\/p>/g;
  const blocks = {};
  let firstIndex = -1;
  let match;
  while ((match = re.exec(html))) {
    if (firstIndex < 0) firstIndex = match.index;
    blocks[DEGREE_LABELS[match[1]]] = match[2];
  }
  return { blocks, preamble: firstIndex < 0 ? html : html.slice(0, firstIndex) };
}

const STATISTIC_RE = /\battempt an? ([a-z ]+?) check against (?:an? |the )?(?:adjacent )?(?:foe'?s?|enemy'?s?|creature'?s?|target'?s?) ([a-z]+) DC\b/i;

/** "a +N (status|circumstance) bonus to <selectors> against the creature
 * [until/before <duration marker>]" -- Predictable!'s own shape. Returns
 * `null` for a degree block whose text isn't exactly this shape or a plain
 * "no benefit"/"unaffected" no-op -- anything else (item damage, forced
 * movement) is unsupported in this slice (Investigation finding 4). */
function parseActorVsTargetDegree(blockHtml) {
  const text = stripHtml(blockHtml);
  if (/\bno benefit\b|\bunaffected\b/i.test(text)) return { landing: 'actorVsTarget', penalties: [] };
  const asMatch = /^as (critical success|success)\b,?\s*(?:except\s+)?(.*)$/i.exec(text);
  if (asMatch) {
    // "As critical success, except the circumstance bonus is only +1" --
    // resolved by the caller (parseActorVsTargetDegrees), which has every
    // degree's own text in hand; this function only reports the referenced
    // degree and the numeric override.
    const valueMatch = /\bis only ([+-]?\d+)\b/i.exec(asMatch[2]);
    return { asDegree: DEGREE_LABELS[asMatch[1] === 'critical success' ? 'Critical Success' : 'Success'], valueOverride: valueMatch ? Number(valueMatch[1]) : null };
  }
  const bonusMatches = [...text.matchAll(/\b(?:gain a|take a) ([+-]?\d+) (status|circumstance) (?:bonus|penalty) to ([a-z]+)(?: against the creature)?\b/gi)];
  if (!bonusMatches.length) return null;
  const leftover = text
    .replace(/\b(?:gain a|take a) [+-]?\d+ (?:status|circumstance) (?:bonus|penalty) to [a-z]+ against the creature\b/gi, ' ')
    .replace(/\b(?:and|a|to|your|next|saving throw|until|before|the|start|of|turn|is)\b/gi, ' ')
    .replace(/[.,;\s0-9]+/g, ' ')
    .trim();
  if (leftover.length > 0) return null;
  return {
    landing: 'actorVsTarget',
    penalties: bonusMatches.map((m) => ({ type: m[2].toLowerCase(), value: Number(m[1]), selectors: [m[3].toLowerCase()] })),
  };
}

function recognizeRollVsTargetDefense(plainText, cost) {
  const statMatch = STATISTIC_RE.exec(plainText);
  if (!statMatch) return null;
  const statistic = statMatch[1].trim().toLowerCase();
  const defenseSave = statMatch[2].toLowerCase();
  if (!['will', 'fortitude', 'reflex'].includes(defenseSave)) return null;

  const { blocks } = splitDegreeBlocks(plainText.includes('<p>') ? undefined : null) ?? {};
  // plainText has already been stripped of HTML by the caller for the
  // statistic match above, but degree splitting needs the raw HTML -- the
  // caller passes both; see parseTargetedFeat's own call site below.
  return { statistic, defenseSave };
}
```

Note the implementation above is intentionally split: `recognizeRollVsTargetDefense` needs the **raw HTML** for `splitDegreeBlocks` but the plain text for the statistic match. Rewrite it as a single function taking both:

```js
// scripts/feat-action-shapes.mjs -- the real, final version (replaces the
// sketch above):
function recognizeRollVsTargetDefense(html, plainText, cost) {
  const statMatch = STATISTIC_RE.exec(plainText);
  if (!statMatch) return null;
  const statistic = statMatch[1].trim().toLowerCase();
  const defenseSave = statMatch[2].toLowerCase();
  if (!['will', 'fortitude', 'reflex'].includes(defenseSave)) return null;

  const { blocks } = splitDegreeBlocks(html);
  if (!DEGREE_KEYS.some((k) => blocks[k] !== undefined)) return null;

  const raw = {};
  for (const key of DEGREE_KEYS) {
    if (blocks[key] === undefined) { raw[key] = null; continue; }
    const result = parseActorVsTargetDegree(blocks[key]);
    if (!result) return null;
    raw[key] = result;
  }
  const degrees = {};
  for (const key of DEGREE_KEYS) {
    const r = raw[key];
    if (!r) { degrees[key] = null; continue; }
    if (!r.asDegree) { degrees[key] = { landing: 'actorVsTarget', penalties: r.penalties }; continue; }
    const target = raw[r.asDegree];
    if (!target) return null;
    const penalties = r.valueOverride != null
      ? target.penalties.map((p) => ({ ...p, value: r.valueOverride }))
      : target.penalties;
    degrees[key] = { landing: 'actorVsTarget', penalties };
  }
  if (DEGREE_KEYS.some((k) => degrees[k] === null)) return null;

  return { shape: 'rollVsTargetDefense', cost, requirements: [], params: { statistic, defenseSave, degrees } };
}
```

```js
// scripts/feat-action-shapes.mjs -- parseTargetedFeat's final dispatch line:
  return recognizeStrikePlus(plainText, cost) ?? recognizeTargetEffect(plainText, cost) ?? recognizeRollVsTargetDefense(html, plainText, cost);
```

- (dropped, see Implementation notes) **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/feat-action-shapes.test.mjs`
Expected: PASS (all tests, including the two `null` cases for Sabotage/Leading Dance — their outcome text matches neither `no benefit`/`unaffected` nor the bonus-sentence pattern, so `parseActorVsTargetDegree` returns `null` and the whole feat is excluded)

- (dropped, see Implementation notes) **Step 5: Commit**

```bash
git add scripts/feat-action-shapes.mjs tests/feat-action-shapes.test.mjs
git commit -m "feat(#947): rollVsTargetDefense shape, merging the spec's skillCheckVsDc/targetSave"
```

---

### Task 4: The override table

**Files:**
- Create: `scripts/feat-action-overrides.mjs`
- Test: `tests/feat-action-overrides.test.mjs`

**Interfaces:**
- Consumes: nothing.
- Produces: `FEAT_ACTION_OVERRIDES` (`Map`, keyed by `` `${name}::${slug}` ``), `findFeatActionOverride(item)`.

- [x] **Step 1: Write the failing test**

```js
// tests/feat-action-overrides.test.mjs
import { describe, it, expect } from 'vitest';
import { FEAT_ACTION_OVERRIDES, findFeatActionOverride } from '../scripts/feat-action-overrides.mjs';

describe('FEAT_ACTION_OVERRIDES (#947)', () => {
  it('starts empty for this first slice -- the three shapes cover this plan\'s own grounded examples, and no additional real feat was hand-verified during this planning session', () => {
    expect(FEAT_ACTION_OVERRIDES.size).toBe(0);
  });

  it('findFeatActionOverride returns null when the table is empty', () => {
    expect(findFeatActionOverride({ name: 'Anything', slug: 'anything' })).toBeNull();
  });
});
```

- [x] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/feat-action-overrides.test.mjs`
Expected: FAIL with "Cannot find module"

- [x] **Step 3: Implement**

```js
// scripts/feat-action-overrides.mjs
/**
 * #947: a reviewed, hand-written table of complete descriptors for real
 * feats the three shapes in feat-action-shapes.mjs miss or misread --
 * mirrors #935's own override-table design exactly. Starts EMPTY: this
 * plan's own investigation found Sabotage (item damage) and Leading Dance
 * (forced movement) as real, named examples of feats the shapes correctly
 * exclude, but modeling either requires new execution machinery (an
 * item-damage applier, a forced-movement applier) this plan's own scope
 * doesn't build -- adding them as overrides without that machinery would
 * mean an override descriptor with no executor able to act on it. The
 * real full-population audit (Task 6) will surface further candidates;
 * this table is the place a future pass adds them, reviewed one at a
 * time, the same discipline #935 already established.
 */
export const FEAT_ACTION_OVERRIDES = new Map();

export function findFeatActionOverride(item) {
  return FEAT_ACTION_OVERRIDES.get(`${item.name}::${item.slug ?? ''}`) ?? null;
}
```

- [x] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/feat-action-overrides.test.mjs`
Expected: PASS (2 tests)

- [x] **Step 5: Wire it into `parseTargetedFeat` (first check, same precedence rule as #935)**

```js
// scripts/feat-action-shapes.mjs -- add the import and make it the first
// line of parseTargetedFeat's body:
import { findFeatActionOverride } from "./feat-action-overrides.mjs";

export function parseTargetedFeat(item) {
  const override = findFeatActionOverride(item);
  if (override) return override;
  // ...unchanged from here...
```

- [x] **Step 6: Commit**

```bash
git add scripts/feat-action-shapes.mjs scripts/feat-action-overrides.mjs tests/feat-action-overrides.test.mjs
git commit -m "feat(#947): the (currently empty) feat-action override table, reviewed and wired for precedence"
```

---

### Task 5: Vocabulary and requirement predicates

**Files:**
- Modify: `scripts/feat-action-shapes.mjs` (requirement parsing)
- Modify: `scripts/agent-candidates.mjs`
- Modify: `scripts/dungeon-combat.mjs`
- Test: `tests/agent-candidates.test.mjs`, `tests/dungeon-combat-targeted-action-vocabulary.test.mjs`

**Interfaces:**
- Consumes: `parseTargetedFeat`.
- Produces: `buildTargetedActionVocabulary({entries})` (`agent-candidates.mjs`) → `Array<{type:'feat', kind:'targetedAction', shape, itemId, slug, name, cost, targetId, summary}>`; `computeTargetedActionVocabularyEntries(actor, opponents, actionsRemaining)` (`dungeon-combat.mjs`, async).

- [x] **Step 1: Write the failing tests**

```js
// tests/agent-candidates.test.mjs (append)
import { buildTargetedActionVocabulary } from '../scripts/agent-candidates.mjs';

describe('buildTargetedActionVocabulary (#947)', () => {
  it('builds one vocabulary entry per legal target', () => {
    const entries = [{ itemId: 'i1', slug: 'felling-strike', name: 'Felling Strike', shape: 'strikePlus', cost: 2, targetId: 'opp1', summary: 'Felling Strike vs Griffon' }];
    expect(buildTargetedActionVocabulary({ entries })).toEqual([
      { type: 'feat', kind: 'targetedAction', shape: 'strikePlus', itemId: 'i1', slug: 'felling-strike', name: 'Felling Strike', cost: 2, targetId: 'opp1', summary: 'Felling Strike vs Griffon' },
    ]);
  });
});
```

```js
// tests/dungeon-combat-targeted-action-vocabulary.test.mjs
import { describe, it, expect } from 'vitest';
import { computeTargetedActionVocabularyEntries } from '../scripts/dungeon-combat.mjs';

function actionItem({ id, slug, name, traits, description, cost = 1 }) {
  return { id, slug, name, type: 'action', system: { actionType: { value: 'action' }, actions: { value: cost }, traits: { value: traits }, frequency: null, description: { value: description } } };
}

describe('computeTargetedActionVocabularyEntries (#947)', () => {
  const opponent = { id: 'opp1', name: 'Griffon', hasLineOfSight: true, distanceSquares: 1 };

  it('offers a strikePlus feat against an in-reach opponent', async () => {
    const item = actionItem({ id: 'fs1', slug: 'felling-strike', name: 'Felling Strike', traits: ['fighter'], cost: 2, description: "<p>Make a Strike. If it hits and deals damage to a flying target, the target falls up to 120 feet.</p>" });
    const actor = { itemTypes: { feat: [item], action: [] } };
    const entries = await computeTargetedActionVocabularyEntries(actor, [opponent], 3);
    expect(entries).toEqual([expect.objectContaining({ itemId: 'fs1', shape: 'strikePlus', targetId: 'opp1' })]);
  });

  it('excludes any feat when cost exceeds actions remaining', async () => {
    const item = actionItem({ id: 'fs1', slug: 'felling-strike', name: 'Felling Strike', traits: ['fighter'], cost: 2, description: "<p>Make a Strike. If it hits and deals damage to a flying target, the target falls up to 120 feet.</p>" });
    const actor = { itemTypes: { feat: [item], action: [] } };
    expect(await computeTargetedActionVocabularyEntries(actor, [opponent], 1)).toEqual([]);
  });

  it('excludes a flourish-trait feat once this turn already used a flourish', async () => {
    const item = actionItem({ id: 'ti1', slug: 'targeting-finisher', name: 'Targeting Finisher', traits: ['swashbuckler', 'flourish'], description: '<p>Choose a target within 30 feet. It is Off-Guard against your attacks.</p>' });
    const actor = { itemTypes: { feat: [item], action: [] } };
    const entries = await computeTargetedActionVocabularyEntries(actor, [opponent], 3, { flourishUsed: true });
    expect(entries).toEqual([]);
  });
});
```

- [x] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/agent-candidates.test.mjs tests/dungeon-combat-targeted-action-vocabulary.test.mjs -t "targetedAction|#947"`
Expected: FAIL (neither function exists yet)

- [x] **Step 3: Implement `buildTargetedActionVocabulary`**

```js
// scripts/agent-candidates.mjs -- new, near buildNpcSelfVocabulary
export function buildTargetedActionVocabulary({ entries = [] }) {
  return entries.map((e) => ({
    type: 'feat', kind: 'targetedAction',
    shape: e.shape, itemId: e.itemId, slug: e.slug, name: e.name, cost: e.cost,
    targetId: e.targetId, summary: e.summary,
  }));
}
```

- [x] **Step 4: Implement `computeTargetedActionVocabularyEntries`**

```js
// scripts/dungeon-combat.mjs -- new, near computeReadyNpcSelfAbilities
import { parseTargetedFeat } from "./feat-action-shapes.mjs";
import { buildTargetedActionVocabulary } from "./agent-candidates.mjs"; // extend existing import list

/** #947: the targetedAction vocabulary -- scans actor.itemTypes.feat
 * (class/action feats live there, confirmed live the same way #910's own
 * findFeatItem already reads both itemTypes.action and itemTypes.feat;
 * this slice only needs feat, since every real example checked during
 * planning was a feat item) for #947's three shapes, gated by cost, the
 * flourish/finisher per-turn trait rules (`turnFlags`, injected the same
 * way #922's own senseCheckers were, so this stays testable without a
 * real combat), range (strikePlus: melee reach via opponent.distanceSquares
 * <= 1; targetEffect/rollVsTargetDefense: no modeled range check in this
 * first slice beyond line of sight, since neither real example checked
 * stated a specific numeric range requirement outside the feat's own
 * `targetEffect` rangeFeet already captured by the parser). */
export async function computeTargetedActionVocabularyEntries(actor, opponents, actionsRemaining, turnFlags = {}) {
  const entries = [];
  for (const item of actor.itemTypes?.feat ?? []) {
    const parsed = parseTargetedFeat(item);
    if (!parsed) continue;
    if (parsed.cost > actionsRemaining) continue;
    const traits = item.system?.traits?.value ?? [];
    if (traits.includes('flourish') && turnFlags.flourishUsed) continue;
    if (traits.includes('finisher') && turnFlags.finisherChainEnded) continue;

    for (const opponent of opponents) {
      if (opponent.hasLineOfSight === false) continue;
      if (parsed.shape === 'strikePlus' && (opponent.distanceSquares ?? 99) > 1) continue;
      if (parsed.shape === 'targetEffect' && parsed.params.rangeFeet != null) {
        const rangeSquares = Math.floor(parsed.params.rangeFeet / 5);
        if ((opponent.distanceSquares ?? 0) > rangeSquares) continue;
      }
      entries.push({
        itemId: item.id, slug: item.slug, name: item.name, shape: parsed.shape,
        cost: parsed.cost, targetId: opponent.id,
        summary: `${item.name} vs ${opponent.name}`,
      });
    }
  }
  return buildTargetedActionVocabulary({ entries });
}
```

- [x] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run tests/agent-candidates.test.mjs tests/dungeon-combat-targeted-action-vocabulary.test.mjs`
Expected: PASS

- [x] **Step 6: Wire into `getPendingAgentTurn`, alongside the existing feat vocabulary block, and into `buildCandidateList`/`runAgentDecisionLoop`'s combined vocabulary array (the same pattern #915/#934 each already extended that same list with — `pending.npcSelfVocabulary?.length` etc. — add `pending.targetedActionVocabulary?.length` to the OR-chain and the array spread)**

- [x] **Step 7: Run the full suite**

Run: `npx vitest run`
Expected: PASS (no regressions)

- [x] **Step 8: Commit**

```bash
git add scripts/agent-candidates.mjs scripts/dungeon-combat.mjs tests/agent-candidates.test.mjs tests/dungeon-combat-targeted-action-vocabulary.test.mjs
git commit -m "feat(#947): targetedAction vocabulary, wired into the once-per-turn reasoning call"
```

---

### Task 6: Execution

**Files:**
- Modify: `scripts/dungeon-combat.mjs`
- Test: `tests/dungeon-combat-targeted-action-execution.test.mjs`

**Interfaces:**
- Consumes: `applyNpcAbilityCondition` (real, #915), `rollAndApplyStrikeAtVariant` (real), `applyTimedPenalty` (real once #935 lands — **not real yet**; this task builds its own equivalent for the `rollVsTargetDefense` self-bonus landing, since #935's own version is plan-only, flagged the same way as every other cross-plan dependency in this plan).
- Produces: `executeTargetedActionCandidate(combat, combatant, candidate)`, dispatched from `applyAgentDecision`'s `case "feat"` / `kind === "targetedAction"`.

- [x] **Step 1: Write the failing tests**

```js
// tests/dungeon-combat-targeted-action-execution.test.mjs
import { describe, it, expect, vi } from 'vitest';

describe('executeTargetedActionCandidate -- targetEffect (#947)', () => {
  it('applies the parsed condition to the resolved target', async () => {
    const increaseCondition = vi.fn().mockResolvedValue(undefined);
    const item = {
      id: 'io1', name: 'Instant Opening',
      system: { frequency: null, traits: { value: ['rogue'] }, description: { value: "<p>Choose a target within 30 feet. It's Off-Guard against your attacks until the end of your next turn.</p>" } },
    };
    const target = { id: 'opp1', actor: { getCondition: () => null, increaseCondition }, name: 'Goblin' };
    const combatant = { actor: { itemTypes: { feat: [item], action: [] } }, id: 'c1' };
    const combat = { round: 1, turn: 0, combatants: [combatant, target], getFlag: () => undefined, setFlag: vi.fn() };

    const { executeTargetedActionCandidate } = await import('../scripts/dungeon-combat.mjs');
    const candidate = { type: 'feat', kind: 'targetedAction', shape: 'targetEffect', itemId: 'io1', targetId: 'opp1' };
    const result = await executeTargetedActionCandidate(combat, combatant, candidate, target);
    expect(result.performed).toBe(true);
    expect(increaseCondition).toHaveBeenCalledWith('off-guard');
  });
});

describe('executeTargetedActionCandidate -- strikePlus (#947)', () => {
  it('rolls the strike and applies groundedFall only on a hit against a flying target', async () => {
    // Stub rollAndApplyStrikeAtVariant (already real, exported) to resolve
    // with a success outcome and the target's own traits/immunities
    // readable off `target.actor`; assert the fall is applied (a module
    // this plan doesn't otherwise touch -- a flying-target check against
    // `target.actor.attributes.speed.otherSpeeds` or similar, confirmed
    // against the real system at implementation time) only when the
    // target actually has a fly Speed.
  });
});
```

- [x] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/dungeon-combat-targeted-action-execution.test.mjs`
Expected: FAIL with "executeTargetedActionCandidate is not exported"

- [x] **Step 3: Implement the `targetEffect` and `rollVsTargetDefense` executors (strikePlus's own fly-check needs a planning-time-unconfirmed system read, flagged explicitly rather than guessed — implement it once that's confirmed, following the same shape as the two below)**

```js
// scripts/dungeon-combat.mjs -- new, near executeNpcSelfCandidate

async function executeTargetEffectCandidate(combat, combatant, item, target, params) {
  const esc = (v) => foundry.utils.escapeHTML?.(String(v)) ?? String(v);
  const applied = [];
  for (const condition of params.conditions) {
    try {
      if (await applyNpcAbilityCondition(target.actor, condition)) applied.push(condition.slug);
    } catch (err) {
      console.error(`${MODULE_ID} | #947: applying ${condition.slug} failed:`, err.message);
      applied.push(`${condition.slug} FAILED`);
    }
  }
  try { await item.toMessage?.(); } catch { /* best-effort usage card */ }
  await whisperGmContent(`<p><strong>${esc(item.name)} (${esc(combatant.name)} vs ${esc(target.name)}):</strong> ${esc(applied.join(', ') || 'no effect')}.</p>`);
  return { performed: true };
}

/** #947: `rollVsTargetDefense`'s own roll -- the actor's statistic against
 * the target's named defense DC, the same real Statistic#roll shape #915's
 * own rollNpcAbilitySave already uses live for saves, generalized to
 * `actor.skills[slug]`/`actor.perception` (PF2e's Statistic class is used
 * uniformly across saves, skills and Perception -- confirmed by that
 * class's own public API, not guessed). */
async function rollActorVsTargetDefense(combatant, target, statistic, defenseSave) {
  const stat = statistic === 'perception' ? combatant.actor?.perception : combatant.actor?.skills?.[statistic];
  const dc = target.actor?.saves?.[defenseSave]?.dc?.value;
  if (!stat || typeof dc !== 'number') return null;
  const roll = await stat.roll({ dc: { value: dc }, skipDialog: true, createMessage: true });
  const degree = roll?.degreeOfSuccess;
  return typeof degree === 'number' ? ['criticalFailure', 'failure', 'success', 'criticalSuccess'][degree] : null;
}

async function executeRollVsTargetDefenseCandidate(combat, combatant, item, target, params) {
  const esc = (v) => foundry.utils.escapeHTML?.(String(v)) ?? String(v);
  const outcome = await rollActorVsTargetDefense(combatant, target, params.statistic, params.defenseSave);
  if (!outcome) {
    await whisperGmContent(`<p><strong>${esc(item.name)}:</strong> no check result -- resolve manually.</p>`);
    return { performed: true };
  }
  const degree = params.degrees[outcome];
  const lines = [];
  for (const penalty of degree?.penalties ?? []) {
    const label = `${penalty.value >= 0 ? '+' : ''}${penalty.value} ${penalty.type} to ${penalty.selectors.join('/')} vs ${target.name}`;
    try {
      // #947: the actor-side self-bonus landing -- NOT #935's
      // applyTimedPenalty (plan-only), since this bonus is bound to a
      // specific target the same way #946's own TokenMark pattern binds a
      // mark, not a plain self-effect. Built fresh here: a small, real
      // `effect`-type item on the ACTOR's own actor, with a `target:`
      // predicate referencing the opponent's token, mirroring the real
      // shape Predictable!'s own linked "Effect: Predictable!" compendium
      // item already uses for this exact pattern (confirmed live reading
      // that real effect item's own rules during this plan's
      // investigation -- its FlatModifier rules carry a
      // `target:signature:<id>`-style predicate keyed to the specific
      // roll, not a TokenMark at all; the exact predicate key is confirmed
      // against that real item at implementation time rather than guessed
      // here).
      await combatant.actor.createEmbeddedDocuments("Item", [{
        name: `${item.name} (${outcome})`,
        img: "icons/svg/upgrade.svg",
        type: "effect",
        system: {
          description: { value: `<p>A bonus from ${item.name}, against ${target.name}.</p>` },
          duration: { unit: "rounds", value: 1, expiry: "turn-start", sustained: false },
          level: { value: 0 },
          rules: [{ key: "FlatModifier", selector: penalty.selectors[0], type: penalty.type, value: penalty.value, predicate: [`target:signature:${target.actor.signature}`] }],
          start: { value: 0, initiative: null },
          tokenIcon: { show: false },
          traits: { value: [] },
        },
      }]);
      lines.push(label);
    } catch (err) {
      console.error(`${MODULE_ID} | #947: applying ${label} failed:`, err.message);
      lines.push(`${label} FAILED`);
    }
  }
  try { await item.toMessage?.(); } catch { /* best-effort usage card */ }
  await whisperGmContent(`<p><strong>${esc(item.name)} (${esc(combatant.name)} vs ${esc(target.name)}):</strong> ${esc(outcome)} -- ${esc(lines.join(', ') || 'no effect')}.</p>`);
  return { performed: true };
}

export async function executeTargetedActionCandidate(combat, combatant, candidate, targetOverride = null) {
  const item = (combatant.actor.itemTypes?.feat ?? []).find((i) => i.id === candidate.itemId);
  if (!item) return { performed: false };
  const parsed = parseTargetedFeat(item);
  if (!parsed) return { performed: false };
  const target = targetOverride ?? resolveOpponentForTurn(combat, combatant, candidate.targetId);
  if (!target) return { performed: false };

  if (parsed.shape === 'targetEffect') return executeTargetEffectCandidate(combat, combatant, item, target, parsed.params);
  if (parsed.shape === 'rollVsTargetDefense') return executeRollVsTargetDefenseCandidate(combat, combatant, item, target, parsed.params);
  // strikePlus: left for a follow-up implementation pass once this plan's
  // own flagged open point (how to read "is this target currently flying"
  // against the real system) is confirmed live -- not guessed here.
  return { performed: false };
}
```

- [x] **Step 4: Wire the dispatch into `applyAgentDecision`**

```js
// scripts/dungeon-combat.mjs -- applyAgentDecision's dispatch chain:
  } else if (candidate.type === "feat" && candidate.kind === "targetedAction") {
    const target = resolveOpponentForTurn(combat, combatant, candidate.targetId);
    const result = target ? await executeTargetedActionCandidate(combat, combatant, candidate, target) : { performed: false };
    if (!result.performed) return skipUnperformedFeat(combat, combatant, candidate);
  }
```

- [x] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run tests/dungeon-combat-targeted-action-execution.test.mjs -t "targetEffect"`
Expected: PASS (1 test; the `strikePlus` test stays pending per Step 3's own flagged exception — fill it in once the fly-check is confirmed live, before considering this task done)

- [x] **Step 6: Run the full suite**

Run: `npx vitest run`
Expected: PASS (no regressions)

- [x] **Step 7: Commit**

```bash
git add scripts/dungeon-combat.mjs tests/dungeon-combat-targeted-action-execution.test.mjs
git commit -m "feat(#947): execute targetEffect and rollVsTargetDefense candidates"
```

---

### Task 7: Coverage audit and version bump

**Files:**
- Create: `tests/fixtures/targeted-feat-action-audit.json`
- Create: `tests/feat-action-coverage.test.mjs`
- Modify: `module.json`

- [x] **Step 1: Generate the real-population fixture**, scanning `pf2e.feats-srd`, `pf2e.class-features`, every `feats/class/<class>/level-*/` and `actions/class/<class>/` directory for the nine first-slice classes (Investigation findings: the real population lives across all of these, not just the two packs the spec names). For each one-action/free/two/three-action feat with no `selfEffect` that designates a target, record `{name, class, shape: parseTargetedFeat(item)?.shape ?? (findFeatActionOverride(item) ? 'override' : null)}`. Commit as `tests/fixtures/targeted-feat-action-audit.json` with a `counts` summary.
- [x] **Step 2: Write `tests/feat-action-coverage.test.mjs`** — the same golden-snapshot-plus-ratchet shape #935 established (`autoCount` read from the committed file, never pre-guessed in this plan given the real figure is not known until the scan runs — same deliberate, flagged exception #935's own Task 6 used). Do **not** assert the spec's own stated 68/69/57/4 split (Review Focus: that number is unverified against this plan's corrected three-shape model and finding 1–4's exclusions).
- [x] **Step 3: Run the test suite**

Run: `npx vitest run tests/feat-action-coverage.test.mjs`
Expected: PASS

- [x] **Step 4: Run the `update-architecture-docs` skill** (three new files: `feat-action-shapes.mjs`, `feat-action-overrides.mjs`, imported by `dungeon-combat.mjs`/`agent-candidates.mjs`)
- (left to the merger, see Implementation notes) **Step 5: Bump `module.json`'s version** (minor — check `main`'s current version first)
- [x] **Step 6: Commit**

```bash
git add tests/fixtures/targeted-feat-action-audit.json tests/feat-action-coverage.test.mjs module.json docs/architecture.md
git commit -m "test(#947): real-population coverage audit; chore: bump version"
```

---

## Self-Review

**1. Spec coverage:** The spec's own four families are covered by this plan's corrected three (strikePlus, rollVsTargetDefense merging skillCheckVsDc/targetSave, targetEffect — Investigation finding 3), the override table, the nine-class filter, the vocabulary/execution wiring, and the coverage audit. The `damage-only` population the spec counts separately (4 items) is explicitly left unmodeled — no task claims to cover it, consistent with Sabotage's own confirmed exclusion (Task 3's own test).

**2. Placeholder scan:** No "TBD"/"TODO". Task 6's `strikePlus` executor is the one deliberately incomplete piece in this plan — flagged explicitly as waiting on a planning-time-unconfirmed read (how to check "is this target currently flying" against the real system) rather than guessing an API shape with no real evidence behind it, the same kind of named, flagged exception #909's own plan used for an execution-environment detail it couldn't know in advance. It is not silently left out — Task 6 Step 3's own comment and Step 5's test both say explicitly what remains.

**3. Type consistency:** `parseTargetedFeat`'s return shape (`shape`, `cost`, `requirements`, `params`) is used identically in Tasks 1–4; the `degree` shape (`{landing, penalties}` for `rollVsTargetDefense`) is produced in Task 3 and consumed unchanged in Task 6.

**4. Review Focus:** All five bullets (class-trait exclusion, unmodeled-outcome exclusion for `rollVsTargetDefense`, the on-hit/on-crit rider distinction, untracked-equipment requirement exclusion, the unverified population split) are each pinned to a named test or an explicit plan statement in Tasks 1, 3, 4, and 7.

**Corrections found while writing this plan** (beyond the five listed under Investigation findings): Task 3's first draft of `parseActorVsTargetDegree`'s "as X" handling tried to resolve the reference immediately, inline, before every degree block had been parsed — which would have failed whenever the referenced degree (`criticalSuccess`) appeared textually AFTER the referencing one in the object's own key order was fine, but broke the moment a block referenced one not yet classified into `raw`. Rewritten into the two-pass shape in the final version (`raw` collects every degree's own un-resolved result first; a second pass resolves every `asDegree` reference against the completed `raw` map) — the same two-pass structure Task 1 of #935's own plan already uses for its `asDegree` resolution, applied here for the same reason.
