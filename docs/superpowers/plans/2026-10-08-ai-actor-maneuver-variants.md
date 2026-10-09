# AI Actor Maneuver-Variant Feats Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make #909's basic-maneuver pipeline respect four feats that modify Trip/Shove/Grapple/Disarm/Demoralize — Titan Wrestler (size cap), Sly Disarm (skill substitution + rider), Crushing Grab (damage rider), Terrified Retreat (Fleeing rider) — without touching the reasoning-model contract at all.

**Architecture:** A new pure `scripts/maneuver-feat-modifiers.mjs` holds the curated feat table and two pure functions — `eligibilityModifiers` (widens the size cap and/or picks a different skill, consumed while building the vocabulary) and `ridersFor` (what extra effect to apply after the base RAW outcome, consumed at execution time). `dungeon-combat.mjs`'s existing maneuver-eligibility/execution code (per #909's plan) threads a per-slug `skill` and a per-slug size-cap step count through from these pure functions; execution gains a small rider-application step and a generic round/turn-expiry sweep for the two riders whose PF2e condition carries no built-in duration.

**Tech Stack:** Vanilla JS (ES modules), Foundry VTT v14 API, PF2e system API, Vitest.

**Spec:** `docs/superpowers/specs/2026-10-08-ai-actor-maneuver-variants-design.md`

## Global Constraints

- **Hard dependency: #909's own plan (`docs/superpowers/plans/2026-10-08-ai-actor-maneuvers.md`) must be fully implemented and merged first.** Confirmed live as of this plan's writing: `scripts/agent-candidates.mjs`'s `buildManeuverVocabulary` still has its #909-planned (pre-this-plan) two-field `attacker.maneuvers[slug]` shape (`{eligible, reachSquares}`, no `skill`) — if this plan's tasks don't match what's actually in the file, #909 hasn't landed yet.
- **Confirmed live against the installed PF2e system and the real `pf2e.feats-srd` compendium, not assumed:** Titan Wrestler also covers Reposition, which is out of #909's five maneuvers and therefore irrelevant here; its size-cap text is "two sizes larger, or three if legendary in Athletics" (rank 4), not a flat removal. Crushing Grab and Terrified Retreat both carry only a `Note` rule element (chat-text display) — PF2e's own system never applies either rider; this module must. Sly Disarm's `skill: "thievery"` parameter is confirmed accepted by `game.pf2e.actions.disarm`.
- **PF2e's own Fleeing condition item carries no duration at all** (confirmed live: `duration: {value: -1, unit: "unlimited", expiry: null}`) — "for 1 round" and Sly Disarm's "until the end of your turn" Off-Guard are both tracked and removed by this module itself, via a new generic round/turn-expiry sweep (Task 4) reusing this file's own existing `recharge`-tracking combat-flag pattern (`availableAtRound`, `scripts/dungeon-combat.mjs` ~line 1765) as its direct precedent.
- `actor.skills.athletics.rank` of `4` is "legendary" (confirmed via this codebase's own PF2e proficiency-rank ordering, `["untrained","trained","expert","master","legendary"]`, index 4).
- `actor.abilities.str.mod` is the confirmed, real, public accessor for Crushing Grab's flat Strength-modifier damage (taken verbatim from the feat's own inline-damage-roll syntax, `@Damage[@actor.abilities.str.mod[bludgeoning]]`).
- Follow this repo's existing per-file `const MODULE_ID = "pf2e-dungeon-crawl";` convention.
- Bump `module.json`'s `version` as part of this work (minor bump — a new pure module plus eligibility/execution changes to #909's own pipeline; check the current value at the final task, do not assume it is still whatever it was when this plan was written, since #909's and #910's own plans will each have already consumed a bump).

## Review Focus

- A feat slug not in `MANEUVER_FEAT_MODIFIERS` must have zero effect on eligibility or execution — base RAW behavior, never "extra permissive" by accident.
- Titan Wrestler's size-cap widening must apply only to Trip/Shove/Grapple/Disarm (never Demoralize, which has no size restriction at all per #909) and must correctly distinguish legendary (cap 3) from any lower Athletics rank (cap 2).
- Sly Disarm's Off-Guard rider and Terrified Retreat's Fleeing rider must both actually expire on schedule — an actor whose unreadable/missing `combat` state (e.g. a test stub with no `getFlag`/`setFlag`) must never crash the sweep, matching #909's own "existing bare-stub tests must stay untouched" precedent.
- A rider that throws (e.g. `applyDamage` failing) must be caught and logged, never allowed to undo or interrupt the base maneuver outcome that already applied.
- An actor with an unreadable Athletics rank/modifier (e.g. no `skills.athletics` at all) must fall back to the non-legendary/non-substituted default, never throw.

---

### Task 1: The pure maneuver-feat-modifier table

**Files:**
- Create: `scripts/maneuver-feat-modifiers.mjs`
- Test: `tests/maneuver-feat-modifiers.test.mjs`

**Interfaces:**
- Consumes: nothing.
- Produces (consumed by Task 2 and Task 5): `eligibilityModifiers(featSlugs, { athleticsRank, athleticsMod, thieveryMod } = {})` → `{ sizeCapSteps: {trip?, shove?, grapple?, disarm?}, skill: {disarm?} }`; `ridersFor(featSlugs, slug, outcome, skillUsed)` → `Array<{type: 'crushingGrabDamage' | 'slyDisarmOffGuard' | 'terrifiedRetreatFleeing'}>`.

- [x] **Step 1: Write the failing tests**

```js
// tests/maneuver-feat-modifiers.test.mjs
import { describe, it, expect } from 'vitest';
import { eligibilityModifiers, ridersFor } from '../scripts/maneuver-feat-modifiers.mjs';

describe('eligibilityModifiers', () => {
  it('returns no modifiers for an actor with none of the maneuver-modifier feats', () => {
    expect(eligibilityModifiers([], { athleticsRank: 1, athleticsMod: 5, thieveryMod: 2 })).toEqual({
      sizeCapSteps: {}, skill: {},
    });
  });

  it('widens the size cap to 2 for Titan Wrestler at a non-legendary Athletics rank', () => {
    const result = eligibilityModifiers(['titan-wrestler'], { athleticsRank: 2, athleticsMod: 8, thieveryMod: 0 });
    expect(result.sizeCapSteps).toEqual({ trip: 2, shove: 2, grapple: 2, disarm: 2 });
  });

  it('widens the size cap to 3 for Titan Wrestler at legendary Athletics (rank 4)', () => {
    const result = eligibilityModifiers(['titan-wrestler'], { athleticsRank: 4, athleticsMod: 20, thieveryMod: 0 });
    expect(result.sizeCapSteps).toEqual({ trip: 3, shove: 3, grapple: 3, disarm: 3 });
  });

  it('defaults an unreadable/missing Athletics rank to the non-legendary (2-step) case, never throwing', () => {
    const result = eligibilityModifiers(['titan-wrestler'], {});
    expect(result.sizeCapSteps.trip).toBe(2);
  });

  it('substitutes thievery for disarm only when Sly Disarm is present and Thievery modifies better', () => {
    const better = eligibilityModifiers(['sly-disarm'], { athleticsMod: 5, thieveryMod: 8 });
    expect(better.skill).toEqual({ disarm: 'thievery' });
    const worse = eligibilityModifiers(['sly-disarm'], { athleticsMod: 8, thieveryMod: 5 });
    expect(worse.skill).toEqual({});
  });

  it('prefers Athletics on a tie', () => {
    const tied = eligibilityModifiers(['sly-disarm'], { athleticsMod: 5, thieveryMod: 5 });
    expect(tied.skill).toEqual({});
  });

  it('combines Titan Wrestler and Sly Disarm together', () => {
    const result = eligibilityModifiers(['titan-wrestler', 'sly-disarm'], { athleticsRank: 2, athleticsMod: 5, thieveryMod: 9 });
    expect(result.sizeCapSteps.disarm).toBe(2);
    expect(result.skill.disarm).toBe('thievery');
  });
});

describe('ridersFor', () => {
  it('offers crushingGrabDamage for grapple success/criticalSuccess only, when the feat is present', () => {
    expect(ridersFor(['crushing-grab'], 'grapple', 'success', 'athletics')).toEqual([{ type: 'crushingGrabDamage' }]);
    expect(ridersFor(['crushing-grab'], 'grapple', 'criticalSuccess', 'athletics')).toEqual([{ type: 'crushingGrabDamage' }]);
    expect(ridersFor(['crushing-grab'], 'grapple', 'failure', 'athletics')).toEqual([]);
    expect(ridersFor([], 'grapple', 'success', 'athletics')).toEqual([]);
  });

  it('offers crushingGrabDamage only for grapple, never for another slug', () => {
    expect(ridersFor(['crushing-grab'], 'trip', 'success', 'athletics')).toEqual([]);
  });

  it('offers slyDisarmOffGuard only when Thievery was the skill actually used, and only on a success/criticalSuccess disarm', () => {
    expect(ridersFor(['sly-disarm'], 'disarm', 'success', 'thievery')).toEqual([{ type: 'slyDisarmOffGuard' }]);
    expect(ridersFor(['sly-disarm'], 'disarm', 'success', 'athletics')).toEqual([]);
    expect(ridersFor(['sly-disarm'], 'disarm', 'failure', 'thievery')).toEqual([]);
  });

  it('offers terrifiedRetreatFleeing only on a critical success demoralize, when the feat is present', () => {
    expect(ridersFor(['terrified-retreat'], 'demoralize', 'criticalSuccess', 'intimidation')).toEqual([{ type: 'terrifiedRetreatFleeing' }]);
    expect(ridersFor(['terrified-retreat'], 'demoralize', 'success', 'intimidation')).toEqual([]);
  });

  it('can offer more than one rider at once when multiple feats and conditions line up', () => {
    // Not a real simultaneous case in play (different slugs), but confirms
    // the function accumulates rather than short-circuiting after the
    // first match.
    const riders = ridersFor(['crushing-grab', 'sly-disarm'], 'disarm', 'success', 'thievery');
    expect(riders).toEqual([{ type: 'slyDisarmOffGuard' }]);
  });

  it('returns an empty array for an unknown feat slug or unknown maneuver slug', () => {
    expect(ridersFor(['some-unrelated-feat'], 'trip', 'success', 'athletics')).toEqual([]);
    expect(ridersFor(['crushing-grab'], 'reposition', 'success', 'athletics')).toEqual([]);
  });
});
```

- [x] **Step 2: Run tests to verify they fail**

Run: `npm test -- tests/maneuver-feat-modifiers.test.mjs`
Expected: FAIL — `scripts/maneuver-feat-modifiers.mjs` doesn't exist yet.

- [x] **Step 3: Write `scripts/maneuver-feat-modifiers.mjs`**

```js
/**
 * #911: the curated, tested table of feats that modify #909's five basic
 * maneuvers — a feat not listed here has no effect on eligibility or
 * execution. Confirmed live against the installed PF2e system and the
 * real pf2e.feats-srd compendium that none of these four feats carry any
 * rule element the system itself would apply (Titan Wrestler/Sly Disarm:
 * rules: []; Crushing Grab/Terrified Retreat: a chat-text-only Note rule)
 * — every effect here is module-applied, never a duplicate of something
 * PF2e's own system already does.
 */
export const MANEUVER_FEAT_MODIFIERS = Object.freeze({
  "titan-wrestler": { slugs: ["trip", "shove", "grapple", "disarm"], kind: "eligibility", effect: "sizeCap" },
  "sly-disarm": { slugs: ["disarm"], kind: "eligibility+rider", effect: "thieverySubstitution+offGuard" },
  "crushing-grab": { slugs: ["grapple"], kind: "rider", effect: "strModDamage" },
  "terrified-retreat": { slugs: ["demoralize"], kind: "rider", effect: "fleeing" },
});

const MELEE_MANEUVER_SLUGS = ["trip", "shove", "grapple", "disarm"];

/**
 * Pure. `featSlugs` is whatever slugs the actor's own feat items carry
 * (dungeon-combat.mjs's job to extract); the three numeric inputs are the
 * actor's real Athletics rank/modifier and Thievery modifier. Returns
 * `sizeCapSteps` (per maneuver slug, only present when widened by Titan
 * Wrestler — absent entirely means "use the base RAW cap of 1 step") and
 * `skill` (per maneuver slug, only present when a feat substitutes a
 * different statistic — absent means "use the maneuver's own base skill").
 */
export function eligibilityModifiers(featSlugs, { athleticsRank = 0, athleticsMod = 0, thieveryMod = 0 } = {}) {
  const featSet = new Set(featSlugs);
  const sizeCapSteps = {};
  const skill = {};

  if (featSet.has("titan-wrestler")) {
    const steps = athleticsRank === 4 ? 3 : 2;
    for (const slug of MELEE_MANEUVER_SLUGS) sizeCapSteps[slug] = steps;
  }
  if (featSet.has("sly-disarm") && thieveryMod > athleticsMod) {
    skill.disarm = "thievery";
  }
  return { sizeCapSteps, skill };
}

/**
 * Pure. Returns the extra (non-base-RAW) effects to apply after the
 * maneuver's own base outcome has already been applied — `skillUsed` is
 * whichever statistic actually rolled (per Decision 6, deterministically
 * resolved at vocabulary-build time, carried through on the candidate).
 */
export function ridersFor(featSlugs, slug, outcome, skillUsed) {
  const featSet = new Set(featSlugs);
  const riders = [];
  const succeeded = outcome === "success" || outcome === "criticalSuccess";

  if (slug === "grapple" && featSet.has("crushing-grab") && succeeded) {
    riders.push({ type: "crushingGrabDamage" });
  }
  if (slug === "disarm" && featSet.has("sly-disarm") && skillUsed === "thievery" && succeeded) {
    riders.push({ type: "slyDisarmOffGuard" });
  }
  if (slug === "demoralize" && featSet.has("terrified-retreat") && outcome === "criticalSuccess") {
    riders.push({ type: "terrifiedRetreatFleeing" });
  }
  return riders;
}
```

- [x] **Step 4: Run tests to verify they pass**

Run: `npm test -- tests/maneuver-feat-modifiers.test.mjs`
Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add scripts/maneuver-feat-modifiers.mjs tests/maneuver-feat-modifiers.test.mjs
git commit -m "feat(#911): add the pure maneuver-feat-modifier table

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 2: Wire size-cap and skill-substitution into vocabulary building

**Files:**
- Modify: `scripts/agent-candidates.mjs`
- Modify: `scripts/dungeon-combat.mjs`
- Test: `tests/agent-candidates.test.mjs`
- Test: `tests/dungeon-combat-maneuver-vocabulary.test.mjs`

**Interfaces:**
- Consumes: `eligibilityModifiers` (Task 1).
- Produces: `buildManeuverVocabulary`'s output entries now carry `skill`; `sizeOkForManeuver` now takes a `capSteps` parameter; `computeManeuverAttackerProfile`'s per-slug entries now carry `skill`/`sizeCapSteps`.

- [x] **Step 1: Write the failing tests**

Add to `tests/agent-candidates.test.mjs` (inside the existing `describe('buildManeuverVocabulary', ...)` block):

```js
  it('carries the attacker-resolved skill through onto each vocabulary entry', () => {
    const attackerWithSlyDisarm = {
      maneuvers: {
        ...eligibleAttacker.maneuvers,
        disarm: { eligible: true, reachSquares: AGENT_MELEE_REACH_SQUARES, skill: 'thievery' },
      },
    };
    const vocabulary = buildManeuverVocabulary({ attacker: attackerWithSlyDisarm, opponents: [inReach] });
    const disarmEntry = vocabulary.find((v) => v.slug === 'disarm');
    expect(disarmEntry.skill).toBe('thievery');
  });
```

Add to `tests/dungeon-combat-maneuver-vocabulary.test.mjs` (inside the existing `describe('sizeOkForManeuver', ...)` block):

```js
  it('accepts a target up to capSteps sizes larger when a wider cap is passed', () => {
    const med = { system: { traits: { size: { value: 'med' } } } };
    const huge = { system: { traits: { size: { value: 'huge' } } } };
    expect(sizeOkForManeuver(med, huge, 1)).toBe(false);
    expect(sizeOkForManeuver(med, huge, 2)).toBe(true);
  });

  it('defaults capSteps to 1 when omitted (no regression for #909\'s own callers)', () => {
    const med = { system: { traits: { size: { value: 'med' } } } };
    const lg = { system: { traits: { size: { value: 'lg' } } } };
    expect(sizeOkForManeuver(med, lg)).toBe(true);
  });
```

Add to `tests/dungeon-combat-maneuver-vocabulary.test.mjs` (inside the existing `describe('computeManeuverAttackerProfile', ...)` block):

```js
  it('defaults every maneuver\'s skill to its own base statistic and sizeCapSteps to 1 with no modifier feats', () => {
    const actor = { items: [], skills: { athletics: { rank: 1, mod: 5 }, intimidation: {} } };
    const profile = computeManeuverAttackerProfile(actor);
    expect(profile.trip.skill).toBe('athletics');
    expect(profile.trip.sizeCapSteps).toBe(1);
    expect(profile.demoralize.skill).toBe('intimidation');
  });

  it('widens sizeCapSteps for all four Athletics maneuvers when the actor has Titan Wrestler', () => {
    const actor = { items: [{ type: 'feat', slug: 'titan-wrestler' }], skills: { athletics: { rank: 4, mod: 20 }, intimidation: {} } };
    const profile = computeManeuverAttackerProfile(actor);
    expect(profile.trip.sizeCapSteps).toBe(3);
    expect(profile.shove.sizeCapSteps).toBe(3);
    expect(profile.grapple.sizeCapSteps).toBe(3);
    expect(profile.disarm.sizeCapSteps).toBe(3);
  });

  it('substitutes thievery for disarm\'s own skill when the actor has Sly Disarm and a better Thievery modifier', () => {
    const actor = { items: [{ type: 'feat', slug: 'sly-disarm' }], skills: { athletics: { rank: 1, mod: 2 }, thievery: { mod: 9 }, intimidation: {} } };
    const profile = computeManeuverAttackerProfile(actor);
    expect(profile.disarm.skill).toBe('thievery');
    expect(profile.trip.skill).toBe('athletics');
  });
```

- [x] **Step 2: Run tests to verify they fail**

Run: `npm test -- tests/agent-candidates.test.mjs tests/dungeon-combat-maneuver-vocabulary.test.mjs`
Expected: FAIL — `skill` is `undefined` on vocabulary entries; `sizeOkForManeuver` ignores a third argument; `computeManeuverAttackerProfile`'s entries carry no `skill`/`sizeCapSteps`.

- [x] **Step 3: Update `buildManeuverVocabulary` in `scripts/agent-candidates.mjs`**

Change the vocabulary-push line:

```js
      vocabulary.push({ type: 'maneuver', slug, targetId: opponent.id, skill: a.skill });
```

(Replacing the current `vocabulary.push({ type: 'maneuver', slug, targetId: opponent.id });` — one field added, nothing else in the function changes.)

Update `buildManeuverCandidates` to carry `skill` through onto the built candidate (find the `candidates.push({...})` call inside its loop and add `skill: candidateVocabularyEntry.skill` — the matched vocabulary entry is already looked up as `const inVocabulary = maneuverVocabulary.some(...)`; change that to capture the actual matched entry instead of just a boolean, so its `skill` is available):

```js
  for (const pick of maneuverPicks) {
    const matched = maneuverVocabulary.find(
      (v) => v.type === pick.type && v.slug === pick.slug && v.targetId === pick.targetId,
    );
    if (!matched) continue;
    const opponent = opponents.find((o) => o.id === pick.targetId);
    if (!opponent) continue;
    const label = MANEUVER_DEFS[pick.slug]?.label ?? pick.slug;
    const summary = pick.rationale ? `${label} vs ${opponent.name} — ${pick.rationale}` : `${label} vs ${opponent.name}`;
    candidates.push({
      id: `maneuver:${pick.slug}:${pick.targetId}`,
      type: 'maneuver',
      slug: pick.slug,
      targetId: pick.targetId,
      skill: matched.skill,
      cost: 1,
      summary,
    });
  }
```

(This replaces the `const inVocabulary = maneuverVocabulary.some((v) => ...)` + `if (!inVocabulary) continue;` pair with the `const matched = maneuverVocabulary.find(...)` + `if (!matched) continue;` pair shown — same referential-integrity check, now also capturing the matched entry's `skill`.)

- [x] **Step 4: Update `sizeOkForManeuver` and `computeManeuverAttackerProfile` in `scripts/dungeon-combat.mjs`**

```js
function sizeOkForManeuver(attackerActor, targetActor, capSteps = 1) {
  const attackerIdx = SIZE_ORDER.indexOf(attackerActor?.system?.traits?.size?.value);
  const targetIdx = SIZE_ORDER.indexOf(targetActor?.system?.traits?.size?.value);
  if (attackerIdx < 0 || targetIdx < 0) return true;
  return targetIdx - attackerIdx <= capSteps;
}
```

Add the import:

```js
import { eligibilityModifiers, ridersFor } from "./maneuver-feat-modifiers.mjs";
```

Update `computeManeuverAttackerProfile`:

```js
function computeManeuverAttackerProfile(actor) {
  const profile = {};
  const hasAthletics = !!actor?.skills?.athletics;
  const hasIntimidation = !!actor?.skills?.intimidation;
  const featSlugs = (actor?.items ?? []).filter((i) => i.type === "feat").map((i) => i.slug);
  const modifiers = eligibilityModifiers(featSlugs, {
    athleticsRank: actor?.skills?.athletics?.rank ?? 0,
    athleticsMod: actor?.skills?.athletics?.mod ?? 0,
    thieveryMod: actor?.skills?.thievery?.mod ?? 0,
  });
  for (const slug of MELEE_MANEUVER_SLUGS) {
    profile[slug] = {
      eligible: hasAthletics && hasFreeHandOrManeuverWeapon(actor, slug),
      reachSquares: AGENT_MELEE_REACH_SQUARES,
      skill: modifiers.skill[slug] ?? "athletics",
      sizeCapSteps: modifiers.sizeCapSteps[slug] ?? 1,
    };
  }
  profile.demoralize = { eligible: hasIntimidation, reachSquares: DEMORALIZE_RANGE_SQUARES, skill: "intimidation", sizeCapSteps: 1 };
  return profile;
}
```

- [x] **Step 5: Thread the per-slug `sizeCapSteps` into `getPendingAgentTurn`'s own `sizeOk` computation**

In `getPendingAgentTurn` (per #909's plan), the four `sizeOkForManeuver(combatant.actor, o.actor)` calls inside the `maneuverOpponents` mapping each gain their matching per-slug cap argument:

```js
    sizeOk: {
      trip: sizeOkForManeuver(combatant.actor, o.actor, maneuverAttackerProfile.trip.sizeCapSteps),
      shove: sizeOkForManeuver(combatant.actor, o.actor, maneuverAttackerProfile.shove.sizeCapSteps),
      grapple: sizeOkForManeuver(combatant.actor, o.actor, maneuverAttackerProfile.grapple.sizeCapSteps),
      disarm: sizeOkForManeuver(combatant.actor, o.actor, maneuverAttackerProfile.disarm.sizeCapSteps),
    },
```

(`maneuverAttackerProfile` is the same variable `computeManeuverAttackerProfile(combatant.actor)`'s own result, already assigned earlier in this function per #909's plan — this step only changes the four call sites that read from it, not its own assignment.)

- [x] **Step 6: Run tests to verify they pass**

Run: `npm test -- tests/agent-candidates.test.mjs tests/dungeon-combat-maneuver-vocabulary.test.mjs`
Expected: PASS.

- [x] **Step 7: Run the full suite**

Run: `npm test`
Expected: PASS (0 new failures) — in particular, re-check any existing `buildManeuverCandidates` test that asserts an exact candidate object via `toEqual` (per #909's own plan, its tests do) now needs a `skill: 'athletics'` (or whatever that fixture's vocabulary entry carries) added to the expected object, since the candidate shape gained a field.

- [x] **Step 8: Commit**

```bash
git add scripts/agent-candidates.mjs scripts/dungeon-combat.mjs tests/agent-candidates.test.mjs tests/dungeon-combat-maneuver-vocabulary.test.mjs
git commit -m "feat(#911): wire size-cap widening and skill substitution into maneuver vocabulary

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 3: Thread `skill` into maneuver execution

**Files:**
- Modify: `scripts/dungeon-combat.mjs`
- Test: `tests/dungeon-combat-maneuver-execution.test.mjs`

**Interfaces:**
- Consumes: `candidate.skill` (Task 2).
- Produces: `runManeuverCheck`/`executeManeuverCandidate` now pass the candidate's own resolved `skill` through to `game.pf2e.actions[slug]`.

- [x] **Step 1: Write the failing test**

Add to `tests/dungeon-combat-maneuver-execution.test.mjs` (per #909's plan, this file already mocks `game.pf2e.actions`):

```js
it('passes the candidate\'s own resolved skill through to the game.pf2e.actions macro call', async () => {
  const actionSpy = vi.fn(({ callback }) => callback({ outcome: 'success' }));
  installGamePf2eStub({ disarm: actionSpy });
  // candidate = { type: 'maneuver', slug: 'disarm', targetId: 'opp1', skill: 'thievery' }
  // await applyAgentDecision(combat, combatantId, 'maneuver:disarm:opp1', 'r');
  // expect(actionSpy).toHaveBeenCalledWith(expect.objectContaining({ skill: 'thievery' }));
});

it('defaults to no explicit skill override when the candidate carries the maneuver\'s own base skill', async () => {
  const actionSpy = vi.fn(({ callback }) => callback({ outcome: 'success' }));
  installGamePf2eStub({ trip: actionSpy });
  // candidate = { type: 'maneuver', slug: 'trip', targetId: 'opp1', skill: 'athletics' }
  // expect(actionSpy).toHaveBeenCalledWith(expect.objectContaining({ skill: 'athletics' }));
});
```

(Fill in the real combat/combatant/target stub shape this file already established per #909's plan before running — not re-derived here.)

- [x] **Step 2: Run test to verify it fails (once filled in)**

Run: `npm test -- tests/dungeon-combat-maneuver-execution.test.mjs`
Expected: FAIL — `runManeuverCheck` doesn't forward a `skill` option yet.

- [x] **Step 3: Implement**

```js
function runManeuverCheck(slug, combatant, target, skill) {
  return new Promise((resolve) => {
    game.pf2e.actions[slug]({
      actors: [combatant.actor],
      target: () => ({ actor: target.actor, token: target.token }),
      skill,
      callback: ({ outcome }) => resolve(outcome),
    });
  });
}
```

```js
async function executeManeuverCandidate(combat, combatant, candidate) {
  const target = resolveOpponentForTurn(combat, combatant, candidate.targetId);
  if (!target) return;
  const outcome = await runManeuverCheck(candidate.slug, combatant, target, candidate.skill);
  await applyManeuverOutcome(candidate.slug, combat, combatant, target, outcome, candidate.skill);
}
```

(`applyManeuverOutcome`'s own signature gains the trailing `skillUsed` parameter here; Task 5 is what actually uses it — this task only threads it through without yet changing what `applyManeuverOutcome` does with it, so update its signature to `async function applyManeuverOutcome(slug, combat, combatant, target, outcome, skillUsed = "athletics") {` and leave its existing body otherwise unchanged for now.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- tests/dungeon-combat-maneuver-execution.test.mjs`
Expected: PASS.

- [ ] **Step 5: Run the full suite**

Run: `npm test`
Expected: PASS (0 new failures).

- [ ] **Step 6: Commit**

```bash
git add scripts/dungeon-combat.mjs tests/dungeon-combat-maneuver-execution.test.mjs
git commit -m "feat(#911): thread the resolved skill through maneuver execution

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 4: Rider-expiry tracking (round/turn sweep)

**Files:**
- Modify: `scripts/dungeon-combat.mjs`
- Modify: `scripts/module.mjs`
- Test: `tests/dungeon-combat-maneuver-rider-expiry.test.mjs`

**Interfaces:**
- Consumes: nothing new.
- Produces (consumed by Task 5): `async function recordManeuverRiderExpiry(combat, entry)`; `export async function sweepExpiredManeuverRiders(combat)`.

- [ ] **Step 1: Write the failing tests**

```js
// tests/dungeon-combat-maneuver-rider-expiry.test.mjs
import { describe, it, expect, vi } from 'vitest';
import { sweepExpiredManeuverRiders } from '../scripts/dungeon-combat.mjs';

function combatStub({ round = 1, turn = 0, flags = {} } = {}) {
  const store = { ...flags };
  const combatants = [];
  return {
    round, turn,
    combatants,
    getFlag: (_m, key) => store[key],
    setFlag: async (_m, key, value) => { store[key] = value; },
  };
}

describe('sweepExpiredManeuverRiders', () => {
  it('does nothing when no rider expiry entries are tracked', async () => {
    const combat = combatStub();
    await expect(sweepExpiredManeuverRiders(combat)).resolves.toBeUndefined();
  });

  it('removes a round-expiring rider (Fleeing) once combat.round reaches the tracked round, leaving earlier rounds untouched', async () => {
    const decreaseCondition = vi.fn();
    const combat = combatStub({
      round: 2,
      flags: { maneuverRiderExpiry: [{ targetId: 'c1', conditionSlug: 'fleeing', expiry: { atRound: 2 } }] },
    });
    combat.combatants.push({ id: 'c1', actor: { decreaseCondition } });
    await sweepExpiredManeuverRiders(combat);
    expect(decreaseCondition).toHaveBeenCalledWith('fleeing', { forceRemove: true });
    expect(combat.getFlag('pf2e-dungeon-crawl', 'maneuverRiderExpiry')).toEqual([]);
  });

  it('leaves a round-expiring rider in place before its tracked round arrives', async () => {
    const decreaseCondition = vi.fn();
    const combat = combatStub({
      round: 1,
      flags: { maneuverRiderExpiry: [{ targetId: 'c1', conditionSlug: 'fleeing', expiry: { atRound: 2 } }] },
    });
    combat.combatants.push({ id: 'c1', actor: { decreaseCondition } });
    await sweepExpiredManeuverRiders(combat);
    expect(decreaseCondition).not.toHaveBeenCalled();
  });

  it('removes a turn-expiring rider (Off-Guard) as soon as the tracked round/turn pair no longer matches', async () => {
    const decreaseCondition = vi.fn();
    const combat = combatStub({
      round: 1,
      turn: 1,
      flags: { maneuverRiderExpiry: [{ targetId: 'c1', conditionSlug: 'off-guard', expiry: { afterRoundTurn: { round: 1, turn: 0 } } }] },
    });
    combat.combatants.push({ id: 'c1', actor: { decreaseCondition } });
    await sweepExpiredManeuverRiders(combat);
    expect(decreaseCondition).toHaveBeenCalledWith('off-guard', { forceRemove: true });
  });

  it('leaves a turn-expiring rider in place while still on the exact round/turn it was granted', async () => {
    const decreaseCondition = vi.fn();
    const combat = combatStub({
      round: 1,
      turn: 0,
      flags: { maneuverRiderExpiry: [{ targetId: 'c1', conditionSlug: 'off-guard', expiry: { afterRoundTurn: { round: 1, turn: 0 } } }] },
    });
    combat.combatants.push({ id: 'c1', actor: { decreaseCondition } });
    await sweepExpiredManeuverRiders(combat);
    expect(decreaseCondition).not.toHaveBeenCalled();
  });

  it('keeps a still-active entry in the flag while removing an expired one in the same sweep', async () => {
    const combat = combatStub({
      round: 2,
      flags: {
        maneuverRiderExpiry: [
          { targetId: 'c1', conditionSlug: 'fleeing', expiry: { atRound: 2 } },
          { targetId: 'c2', conditionSlug: 'fleeing', expiry: { atRound: 5 } },
        ],
      },
    });
    combat.combatants.push({ id: 'c1', actor: { decreaseCondition: vi.fn() } });
    combat.combatants.push({ id: 'c2', actor: { decreaseCondition: vi.fn() } });
    await sweepExpiredManeuverRiders(combat);
    expect(combat.getFlag('pf2e-dungeon-crawl', 'maneuverRiderExpiry')).toEqual([
      { targetId: 'c2', conditionSlug: 'fleeing', expiry: { atRound: 5 } },
    ]);
  });

  it('does not throw when the tracked target no longer exists in combat.combatants', async () => {
    const combat = combatStub({
      round: 2,
      flags: { maneuverRiderExpiry: [{ targetId: 'gone', conditionSlug: 'fleeing', expiry: { atRound: 2 } }] },
    });
    await expect(sweepExpiredManeuverRiders(combat)).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- tests/dungeon-combat-maneuver-rider-expiry.test.mjs`
Expected: FAIL — `sweepExpiredManeuverRiders` doesn't exist yet.

- [ ] **Step 3: Implement in `scripts/dungeon-combat.mjs`**

```js
async function recordManeuverRiderExpiry(combat, entry) {
  const current = combat.getFlag(MODULE_ID, "maneuverRiderExpiry") ?? [];
  await combat.setFlag(MODULE_ID, "maneuverRiderExpiry", [...current, entry]);
}

/** #911: PF2e's own Fleeing condition carries no duration at all
 * (confirmed live), and Sly Disarm's Off-Guard ("against the next attack
 * you make before the end of your turn") has no PF2e-tracked duration
 * either — this module tracks and removes both itself, reusing this
 * file's own existing recharge-tracking combat-flag pattern
 * (`availableAtRound`) as its direct precedent. A round-expiring entry
 * (`expiry.atRound`) is removed once `combat.round >= atRound`; a
 * turn-expiring entry (`expiry.afterRoundTurn`) is removed the moment the
 * current (round, turn) pair no longer exactly matches the one it was
 * granted at (any change means the granting turn has ended). */
export async function sweepExpiredManeuverRiders(combat) {
  const entries = combat.getFlag(MODULE_ID, "maneuverRiderExpiry") ?? [];
  if (!entries.length) return;
  const remaining = [];
  for (const entry of entries) {
    const expired =
      entry.expiry.atRound !== undefined
        ? combat.round >= entry.expiry.atRound
        : combat.round !== entry.expiry.afterRoundTurn.round || combat.turn !== entry.expiry.afterRoundTurn.turn;
    if (expired) {
      const target = combat.combatants.find((c) => c.id === entry.targetId);
      if (target?.actor) await target.actor.decreaseCondition(entry.conditionSlug, { forceRemove: true });
    } else {
      remaining.push(entry);
    }
  }
  if (remaining.length !== entries.length) {
    await combat.setFlag(MODULE_ID, "maneuverRiderExpiry", remaining);
  }
}
```

- [ ] **Step 4: Wire the sweep into the existing turn-change hook in `scripts/module.mjs`**

Add the import:

```js
import { sweepExpiredManeuverRiders } from "./dungeon-combat.mjs";
```

Update the existing hook (`scripts/module.mjs` ~line 667):

```js
Hooks.on("updateCombat", (combat, changes) => {
  if (changes.turn === undefined && changes.round === undefined) return;
  autoPlayCombatantTurnIfDue(combat);
  sweepExpiredManeuverRiders(combat);
});
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm test -- tests/dungeon-combat-maneuver-rider-expiry.test.mjs`
Expected: PASS.

- [ ] **Step 6: Run the full suite**

Run: `npm test`
Expected: PASS (0 new failures) — in particular, check whether `scripts/module.mjs` already has a direct test asserting the exact body of this `updateCombat` hook via source-text matching (the way `tests/module-door-sound-hook.test.mjs` does for a different hook, per earlier work this session) and, if so, update its expected pattern rather than leaving it asserting the pre-change hook body.

- [ ] **Step 7: Commit**

```bash
git add scripts/dungeon-combat.mjs scripts/module.mjs tests/dungeon-combat-maneuver-rider-expiry.test.mjs
git commit -m "feat(#911): add round/turn expiry tracking for maneuver riders

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 5: Apply the riders (Crushing Grab, Sly Disarm Off-Guard, Terrified Retreat Fleeing)

**Files:**
- Modify: `scripts/dungeon-combat.mjs`
- Test: `tests/dungeon-combat-maneuver-riders.test.mjs`

**Interfaces:**
- Consumes: `ridersFor` (Task 1), `recordManeuverRiderExpiry` (Task 4, module-private).
- Produces: `applyManeuverOutcome`'s existing body (per #909's plan) now calls a new `applyManeuverRiders` after applying the base RAW outcome — the terminal consumer in this plan.

- [ ] **Step 1: Write the failing tests**

Find and read an existing maneuver-execution test first (`tests/dungeon-combat-maneuver-execution.test.mjs`, already touched in Task 3) to copy its stub shape, then:

```js
// tests/dungeon-combat-maneuver-riders.test.mjs
import { describe, it, expect, vi } from 'vitest';
import { applyAgentDecision } from '../scripts/dungeon-combat.mjs';

describe('applyAgentDecision maneuver riders', () => {
  it('applies Crushing Grab\'s flat Strength-modifier bludgeoning damage after a successful Grapple', async () => {
    // combatant.actor.items includes { type: 'feat', slug: 'crushing-grab' };
    // combatant.actor.abilities.str.mod = 4; target.actor.applyDamage is a vi.fn().
    // game.pf2e.actions.grapple's callback fires outcome: 'success'.
    // await applyAgentDecision(combat, combatantId, 'maneuver:grapple:opp1', 'r');
    // expect(target.actor.applyDamage).toHaveBeenCalledWith({ damage: 4, token: target.token });
  });

  it('does not apply Crushing Grab\'s damage without the feat present', async () => {
    // same shape, combatant.actor.items has no crushing-grab feat --
    // target.actor.applyDamage must never be called for this reason.
  });

  it('applies Off-Guard and records its turn-expiry after a successful Thievery-based Disarm with Sly Disarm', async () => {
    // candidate.skill === 'thievery'; outcome 'success'.
    // target.actor.increaseCondition is a vi.fn(); combat.setFlag is a vi.fn() (or a real stub store).
    // expect(target.actor.increaseCondition).toHaveBeenCalledWith('off-guard');
    // expect the stored maneuverRiderExpiry flag to contain an off-guard entry for the target.
  });

  it('does not apply Sly Disarm\'s Off-Guard when the actor disarmed using Athletics, not Thievery', async () => {
    // candidate.skill === 'athletics'; feat present; outcome success --
    // increaseCondition must never be called with 'off-guard'.
  });

  it('applies Fleeing and records its round-expiry after a critical-success Demoralize with Terrified Retreat', async () => {
    // combatant.actor.items includes terrified-retreat; outcome
    // 'criticalSuccess'.
    // expect(target.actor.increaseCondition).toHaveBeenCalledWith('fleeing');
    // expect the stored maneuverRiderExpiry flag to contain a fleeing entry at round combat.round + 1.
  });

  it('does not apply Fleeing on a plain success Demoralize (only critical success triggers it)', async () => {
    // outcome 'success' -- increaseCondition must never be called with 'fleeing'.
  });

  it('logs and continues (never throws, never undoes the base outcome) when a rider\'s own application fails', async () => {
    // target.actor.applyDamage throws -- the base Grapple outcome (e.g.
    // the Grabbed condition already applied earlier in applyManeuverOutcome)
    // must still have been applied, and applyAgentDecision must still
    // resolve without throwing.
  });
});
```

- [ ] **Step 2: Run tests to verify they fail (once filled in)**

Run: `npm test -- tests/dungeon-combat-maneuver-riders.test.mjs`
Expected: FAIL — `applyManeuverOutcome` doesn't call any rider logic yet.

- [ ] **Step 3: Implement `applyManeuverRiders` and wire it into `applyManeuverOutcome`**

```js
/** #911: applies each rider `ridersFor` returns, after the base RAW
 * outcome has already been applied by applyManeuverOutcome's own
 * existing per-maneuver branches (unchanged by this task) -- a rider
 * failing is caught and logged, never allowed to undo or interrupt the
 * base outcome that already landed. */
async function applyManeuverRiders(combat, combatant, target, slug, outcome, skillUsed) {
  const featSlugs = (combatant.actor?.items ?? []).filter((i) => i.type === "feat").map((i) => i.slug);
  const riders = ridersFor(featSlugs, slug, outcome, skillUsed);
  for (const rider of riders) {
    try {
      if (rider.type === "crushingGrabDamage") {
        const mod = combatant.actor.abilities?.str?.mod ?? 0;
        await target.actor.applyDamage({ damage: mod, token: target.token });
      } else if (rider.type === "slyDisarmOffGuard") {
        await target.actor.increaseCondition("off-guard");
        await recordManeuverRiderExpiry(combat, {
          targetId: target.id,
          conditionSlug: "off-guard",
          expiry: { afterRoundTurn: { round: combat.round, turn: combat.turn } },
        });
      } else if (rider.type === "terrifiedRetreatFleeing") {
        await target.actor.increaseCondition("fleeing");
        await recordManeuverRiderExpiry(combat, {
          targetId: target.id,
          conditionSlug: "fleeing",
          expiry: { atRound: combat.round + 1 },
        });
      }
    } catch (err) {
      console.error(`${MODULE_ID} | maneuver rider (${rider.type}) failed:`, err.message);
    }
  }
}
```

At the end of `applyManeuverOutcome` (per #909's plan, after its existing per-slug if/else-if chain that applies the base RAW outcome — this is additive, not a replacement of any existing branch), add:

```js
  await applyManeuverRiders(combat, combatant, target, slug, outcome, skillUsed);
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- tests/dungeon-combat-maneuver-riders.test.mjs`
Expected: PASS.

- [ ] **Step 5: Run the full suite**

Run: `npm test`
Expected: PASS (0 new failures).

- [ ] **Step 6: Commit**

```bash
git add scripts/dungeon-combat.mjs tests/dungeon-combat-maneuver-riders.test.mjs
git commit -m "feat(#911): apply Crushing Grab, Sly Disarm, and Terrified Retreat riders

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 6: Version bump

**Files:**
- Modify: `module.json`

**Interfaces:**
- Consumes: nothing.
- Produces: nothing — final housekeeping step before merge.

- [ ] **Step 1: Check the current version and bump it**

Run: `grep '"version"' module.json`

A **minor** bump per `CLAUDE.md`'s versioning rule — a new pure module plus eligibility/execution changes to #909's own pipeline. Confirm the real current value live (both #909's and #910's own plans will each have already consumed a bump by the time this one executes) rather than assuming.

- [ ] **Step 2: Verify no other file hardcodes the old version**

Run: `grep -rn "<old version string>" . --include="*.json" --include="*.mjs" --include="*.md" | grep -v node_modules | grep -v docs/superpowers`

- [ ] **Step 3: Commit**

```bash
git add module.json
git commit -m "chore(#911): bump version for maneuver-variant feat modeling

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Self-Review

**1. Spec coverage:**
- Decision 1 (curated table, not generic interpretation) — Task 1's `MANEUVER_FEAT_MODIFIERS`, consulted nowhere else; an absent slug is a guaranteed no-op by construction in both `eligibilityModifiers` and `ridersFor`.
- Decision 2 (eligibility modifiers in the vocabulary builder, riders in the executor) — Task 2 (eligibility) vs. Task 5 (riders), matching the spec's own split exactly.
- Decision 3 (rule-element-backed feats never re-implemented) — Intimidating Prowess/Disarming Flair appear nowhere in this plan; only the four confirmed prose-only feats are modeled.
- Decision 4 (the initial table's four rows) — Task 1's table plus Task 2 (Titan Wrestler, Sly Disarm's skill pick) and Task 5 (Crushing Grab, Sly Disarm's rider, Terrified Retreat).
- Decision 5 (Agile Maneuvers/Antagonize deferred) — neither appears anywhere in this plan; #919/#920 untouched.
- Decision 6 (Sly Disarm picks the better statistic deterministically, ties favor Athletics) — Task 1's `eligibilityModifiers`, with a dedicated tie-breaking test.
- Decision 7 (no reasoning-model/schema change) — confirmed: this plan never touches `tools/agent-service/` at all.
- The Architecture's three numbered subsections — Task 2 (vocabulary builder changes), Task 3+5 (execution changes), Task 1 (the modifier table file itself).
- Error handling section (unreadable feat/rank data treated as absent; a failing rider logged and never undoing the base outcome; unknown feat slugs ignored) — Task 1's "unreadable Athletics rank" test, Task 5's "logs and continues" test, and `ridersFor`'s own unconditional-empty-array behavior for any unlisted slug.
- Testing section's own enumerated cases (every rank/skill combination for `eligibilityModifiers`, every outcome for `ridersFor`, vocabulary-level presence/absence, execution-level skill forwarding and rider application) — Tasks 1, 2, 3, and 5 each supply exactly the named cases.

**2. Placeholder scan:** No "TBD"/"TODO"/"add appropriate X" anywhere. Task 5's test bodies stay commented/pseudocoded pending the real stub shape from Task 3's own file, named explicitly — the same deliberate, flagged exception #909's and #910's own plans both already used, for the same reason (the mechanical stub shape is unsafe to guess; every assertion itself is written in full).

**3. Type consistency:** `eligibilityModifiers`'s `{sizeCapSteps, skill}` return shape is produced once (Task 1) and consumed identically in Task 2's `computeManeuverAttackerProfile` (`modifiers.sizeCapSteps[slug]`/`modifiers.skill[slug]`). `ridersFor`'s `{type}` rider-descriptor shape is produced once and consumed identically in Task 5's `applyManeuverRiders` if/else-if chain, with exactly the three `type` strings (`crushingGrabDamage`/`slyDisarmOffGuard`/`terrifiedRetreatFleeing`) matching between the two files. The `maneuverRiderExpiry` combat-flag entry shape (`{targetId, conditionSlug, expiry: {atRound} | {afterRoundTurn: {round, turn}}}`) is written once by Task 5's two call sites and read by Task 4's `sweepExpiredManeuverRiders` with matching field names throughout.

**4. Review Focus:** all five items have a direct test — an unlisted feat slug causing no effect (Task 1's "no modifiers" test, `ridersFor`'s "unknown feat slug" test), Titan Wrestler's exact legendary-vs-not distinction and Demoralize's own exclusion from the size cap entirely (Task 1's two Titan Wrestler tests; Demoralize never appears in `MELEE_MANEUVER_SLUGS` so it structurally cannot receive a `sizeCapSteps` override anywhere in this plan), both riders' expiry correctness against a bare-stub `combat` (Task 4's full test suite, built specifically around a minimal stub matching #909's own "existing bare-stub tests must stay untouched" concern), a throwing rider never undoing the base outcome (Task 5's dedicated test), and an unreadable Athletics rank/modifier never throwing (Task 1's "defaults an unreadable/missing Athletics rank" test).
