# AI Actor Feat/Class-Action Modeling Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give AI-controlled combatants two kinds of feat/class actions — self-effect actions (stances + Rage) and a curated composite-action allowlist (Sudden Charge, Lunge, Twin Feint) — generated through #909's existing reasoning-model pipeline as a second, parallel vocabulary category.

**Architecture:** Foundry deterministically enumerates a `featVocabulary` (self-effect items filtered to the stance trait or Rage, plus composite-feat eligibility against the actor's real ready strikes/opponents) alongside #909's existing `maneuverVocabulary`. `runAgentDecisionLoop`'s once-per-turn fetch sends both combined into one `/v1/combat-candidates` call; the single returned `picks` array is read back by both `buildManeuverCandidates` (filtering `type === 'maneuver'`) and the new `buildFeatCandidates` (filtering `type === 'feat'`) — no new turn-state field, no second fetch. Execution adds a new `else if (candidate.type === "feat")` branch to `applyAgentDecision`, dispatching to self-effect application (create the linked effect directly, reproducing the logic behind PF2e's own chat-card button) or one of three hand-written composite executors built from this file's own existing `strideByPosture`/strike-rolling primitives.

**Tech Stack:** Vanilla JS (ES modules), Foundry VTT v14 API, PF2e system API, litellm, Vitest.

**Spec:** `docs/superpowers/specs/2026-10-08-ai-actor-feat-actions-design.md`

## Global Constraints

- **Hard dependency: #909's own plan (`docs/superpowers/plans/2026-10-08-ai-actor-maneuvers.md`) must be fully implemented and merged before this plan's tasks begin.** Confirmed live as of this plan's writing: `scripts/agent-candidates.mjs`'s `buildCandidateList` still has its pre-#909 signature — none of `maneuverVocabulary`, `maneuverPicks`, `fetchCombatCandidates`, or `/v1/combat-candidates` exist in the codebase yet. Every task below assumes those #909 deliverables already exist exactly as that plan describes them; if any task's "Modify" line doesn't match what's actually in the file, #909 hasn't landed yet and this plan cannot proceed.
- **Confirmed by reading the installed PF2e system directly, not assumed:** `createUseActionMessage` (the function behind PF2e's own "Use" button on a self-effect action) never applies the effect itself — it only decrements `system.frequency.value` and posts a chat card. The actual effect-application logic lives in a separate UI click handler (`#onClickApplyEffect`), which is not a public API; this plan reproduces its exact logic rather than calling it.
- **"Power Attack" does not exist as a player-character feat in this installed PF2e system** (confirmed: searched every item compendium; the only "Power Attack" item is an NPC/monster special ability in `pf2e.bestiary-ability-glossary-srd`, flagged on #915 for that ticket's own future scope). The composite allowlist in this plan is **three** feats — Sudden Charge, Lunge, Twin Feint — not four.
- **Self-effect scope is narrowed to stances + Rage only**, per the spec's resolved Decision 1/2 — not every item carrying a `selfEffect`. Widening this is #914's own scope, not touched here.
- **Twin Feint's "two melee weapons, each in a different hand" prerequisite is approximated as "two ready melee strike actions from two different weapon items"** — this plan does not verify literal hand assignment (no public API surface for that was found during investigation), matching this codebase's own existing precedent (#909's `hasFreeHandOrManeuverWeapon` makes an identical class of approximation for NPCs).
- Grid distance is 5 ft/cell; Lunge's reach bonus is 1 square (5 ft).
- `actor.toggleRollOption(domain, option, itemId, value)` is the confirmed, real API for Lunge's toggleable reach bonus (confirmed live: Lunge's own rule elements are `{key: "RollOption", option: "lunge", toggleable: true}` plus an `ActiveEffectLike` adding 5 ft to `system.attributes.reach.base` predicated on that same roll option, with no explicit `domain`, meaning the default domain `"all"` applies).
- `actor.decreaseCondition(slug, { forceRemove: true })` is the confirmed, real API for removing a condition outright (used to clear Off-Guard after Twin Feint's second strike).
- Follow this repo's existing per-file `const MODULE_ID = "pf2e-dungeon-crawl";` convention — no shared constants module exists.
- Bump `module.json`'s `version` as part of this work (minor bump — a new vocabulary category plus three new execution paths — check the current value at the final task, do not assume it is still whatever it was when this plan was written).

## Review Focus

- An actor with no eligible self-effect item and no eligible composite feat this turn must produce an empty `featVocabulary` and never crash on an empty array, mirroring #909's own empty-vocabulary handling exactly.
- A self-effect action whose linked effect is **already active** on the actor (e.g. already Raging) must be excluded from the vocabulary, not re-offered every turn — this is the one safety property that stops the AI from spamming its own buff.
- A stance-trait self-effect item, when the actor is **already in a different stance**, must still be offered (to allow switching stances) but flagged so execution removes the old stance's effect first — never leaving two stance effects active at once.
- Twin Feint/Sudden Charge/Lunge must each be excluded when their own real prerequisite isn't met (no second distinct melee weapon; no opponent in the relevant distance band) — never offered unconditionally just because the actor has the feat item.
- A reasoning-model pick whose `(type, kind, itemId, targetId)` doesn't match a real vocabulary entry must be dropped silently, exactly #909's own referential-integrity convention — this applies equally to the new dynamic per-request schema enum (Review Focus item: a model proposing a slug that *was* valid in a different request but isn't in *this* request's vocabulary must still be rejected).

---

### Task 1: Agent-service schema — dynamic per-request enum

**Files:**
- Modify: `tools/agent-service/candidate-generator.mjs`
- Test: `tests/agent-service-candidate-generator.test.mjs`

**Interfaces:**
- Consumes: nothing new.
- Produces: `generateCombatCandidates`'s request schema now constrains `type`/`slug` to whatever `(type, slug)` pairs are actually present in that call's own `vocabulary` argument, rather than a fixed five-maneuver enum — consumed by every later task that sends a combined `vocabulary` through this function.

- [x] **Step 1: Write the failing test**

Add to `tests/agent-service-candidate-generator.test.mjs` (alongside its existing `describe("generateCombatCandidates", ...)` block from #909's own plan):

```js
it("builds the slug enum dynamically from the vocabulary actually sent, not a fixed list", async () => {
  const vocab = [
    { type: "maneuver", slug: "trip", targetId: "opp1" },
    { type: "feat", slug: "rage", targetId: null },
  ];
  const fetchImpl = fakeFetch({ picks: [] });
  await generateCombatCandidates(context, vocab, { ...OPTS, fetchImpl });
  const body = JSON.parse(fetchImpl.mock.calls[0][1].body);
  const slugProp = body.tools[0].function.parameters.properties.picks.items.properties.slug;
  expect(slugProp.enum).toEqual(["trip", "rage"]);
  const typeProp = body.tools[0].function.parameters.properties.picks.items.properties.type;
  expect(typeProp.enum).toEqual(["maneuver", "feat"]);
});

it("dedupes repeated slugs/types across multiple vocabulary entries", async () => {
  const vocab = [
    { type: "maneuver", slug: "trip", targetId: "opp1" },
    { type: "maneuver", slug: "trip", targetId: "opp2" },
  ];
  const fetchImpl = fakeFetch({ picks: [] });
  await generateCombatCandidates(context, vocab, { ...OPTS, fetchImpl });
  const body = JSON.parse(fetchImpl.mock.calls[0][1].body);
  expect(body.tools[0].function.parameters.properties.picks.items.properties.slug.enum).toEqual(["trip"]);
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/agent-service-candidate-generator.test.mjs`
Expected: FAIL — the current (#909) `SCHEMA` constant hardcodes a fixed 5-slug enum, not a dynamic one.

- [x] **Step 3: Replace the static `SCHEMA` constant with a per-request builder**

In `tools/agent-service/candidate-generator.mjs`, replace the module-level `const SCHEMA = {...}` with a function:

```js
function buildSchema(vocabulary) {
  const types = [...new Set(vocabulary.map((v) => v.type))];
  const slugs = [...new Set(vocabulary.map((v) => v.slug))];
  return {
    type: "object",
    properties: {
      picks: {
        type: "array",
        items: {
          type: "object",
          properties: {
            type: { type: "string", enum: types },
            slug: { type: "string", enum: slugs },
            targetId: { type: ["string", "null"] },
            rationale: { type: "string", description: "One short sentence explaining the pick." },
          },
          required: ["type", "slug", "targetId", "rationale"],
        },
      },
    },
    required: ["picks"],
  };
}
```

Update `generateCombatCandidates`'s body to call `buildSchema(vocabulary)` instead of referencing the removed `SCHEMA` constant, in its `tools[0].function.parameters` field.

(Note: `targetId` is now typed `["string", "null"]` rather than plain `"string"` — #909's maneuver picks always carry a real target id, but #910's self-effect/stance picks are self-targeted and must send `targetId: null`; this widening is required for the new category and has no effect on maneuver picks, which still send a real string.)

- [x] **Step 4: Run tests to verify they pass**

Run: `npm test -- tests/agent-service-candidate-generator.test.mjs`
Expected: PASS, including every pre-existing #909 test in this file (they only ever assert `tool_choice`/`messages`/response-parsing, never the exact enum contents, so the schema's internal shape change doesn't break them — confirm this by reading the file's existing tests before this step if any assertion does inspect `parameters` directly, and adjust it to the new dynamic shape rather than leaving it asserting the old fixed one).

- [x] **Step 5: Commit**

```bash
git add tools/agent-service/candidate-generator.mjs tests/agent-service-candidate-generator.test.mjs
git commit -m "feat(#910): build the combat-candidates schema's enum dynamically per request

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 2: Pure feat vocabulary/candidate builders

**Files:**
- Modify: `scripts/agent-candidates.mjs`
- Test: `tests/agent-candidates.test.mjs`

**Interfaces:**
- Consumes: nothing from this plan's other tasks.
- Produces (consumed by Task 4/5): `buildFeatVocabulary({ selfEffectEntries, compositeEntries })` → `Array<{type: 'feat', kind, itemId, slug, name, cost, targetId, replacesStance?}>`; `buildFeatCandidates({ featVocabulary, picks })` → `Array<{id, type: 'feat', kind, itemId, slug, targetId, cost, replacesStance, summary}>`.

- [x] **Step 1: Write the failing tests**

Add to `tests/agent-candidates.test.mjs` (add `buildFeatVocabulary, buildFeatCandidates` to the file's existing import list):

```js
describe('buildFeatVocabulary', () => {
  it('builds a self-effect vocabulary entry with targetId null', () => {
    const vocabulary = buildFeatVocabulary({
      selfEffectEntries: [{ itemId: 'i1', slug: 'rage', name: 'Rage', cost: 1, replacesStance: null }],
      compositeEntries: [],
    });
    expect(vocabulary).toEqual([
      { type: 'feat', kind: 'selfEffect', itemId: 'i1', slug: 'rage', name: 'Rage', cost: 1, targetId: null, replacesStance: null },
    ]);
  });

  it('builds a composite vocabulary entry with a real targetId', () => {
    const vocabulary = buildFeatVocabulary({
      selfEffectEntries: [],
      compositeEntries: [{ itemId: 'i2', slug: 'lunge', name: 'Lunge', cost: 1, targetId: 'opp1' }],
    });
    expect(vocabulary).toEqual([
      { type: 'feat', kind: 'composite', itemId: 'i2', slug: 'lunge', name: 'Lunge', cost: 1, targetId: 'opp1' },
    ]);
  });

  it('combines both kinds and returns an empty array for no eligible entries at all', () => {
    expect(buildFeatVocabulary({ selfEffectEntries: [], compositeEntries: [] })).toEqual([]);
  });

  it('carries replacesStance through for a stance that would replace an active one', () => {
    const vocabulary = buildFeatVocabulary({
      selfEffectEntries: [{ itemId: 'i3', slug: 'gorilla-stance', name: 'Gorilla Stance', cost: 1, replacesStance: 'effect1' }],
      compositeEntries: [],
    });
    expect(vocabulary[0].replacesStance).toBe('effect1');
  });
});

describe('buildFeatCandidates', () => {
  const featVocabulary = [
    { type: 'feat', kind: 'selfEffect', itemId: 'i1', slug: 'rage', name: 'Rage', cost: 1, targetId: null, replacesStance: null },
    { type: 'feat', kind: 'composite', itemId: 'i2', slug: 'lunge', name: 'Lunge', cost: 1, targetId: 'opp1' },
  ];

  it('builds a candidate for a matching self-effect pick, with the rationale in its summary', () => {
    const candidates = buildFeatCandidates({
      featVocabulary,
      picks: [{ type: 'feat', kind: 'selfEffect', itemId: 'i1', targetId: null, rationale: 'Open raged.' }],
    });
    expect(candidates).toEqual([
      { id: 'feat:i1', type: 'feat', kind: 'selfEffect', itemId: 'i1', slug: 'rage', targetId: null, cost: 1, replacesStance: null, summary: 'Rage — Open raged.' },
    ]);
  });

  it('builds a candidate for a matching composite pick, keyed by itemId and targetId', () => {
    const candidates = buildFeatCandidates({
      featVocabulary,
      picks: [{ type: 'feat', kind: 'composite', itemId: 'i2', targetId: 'opp1', rationale: 'Extend reach.' }],
    });
    expect(candidates).toEqual([
      { id: 'feat:i2:opp1', type: 'feat', kind: 'composite', itemId: 'i2', slug: 'lunge', targetId: 'opp1', cost: 1, replacesStance: undefined, summary: 'Lunge — Extend reach.' },
    ]);
  });

  it('drops a pick whose kind does not match the vocabulary entry for that itemId', () => {
    const candidates = buildFeatCandidates({
      featVocabulary,
      picks: [{ type: 'feat', kind: 'composite', itemId: 'i1', targetId: null, rationale: 'x' }],
    });
    expect(candidates).toEqual([]);
  });

  it('drops a pick whose targetId does not match the vocabulary entry', () => {
    const candidates = buildFeatCandidates({
      featVocabulary,
      picks: [{ type: 'feat', kind: 'composite', itemId: 'i2', targetId: 'opp-not-offered', rationale: 'x' }],
    });
    expect(candidates).toEqual([]);
  });

  it('ignores a non-feat pick entirely (leaves it for buildManeuverCandidates)', () => {
    const candidates = buildFeatCandidates({
      featVocabulary,
      picks: [{ type: 'maneuver', slug: 'trip', targetId: 'opp1', rationale: 'x' }],
    });
    expect(candidates).toEqual([]);
  });

  it('returns an empty array when picks is null (not yet fetched this turn)', () => {
    expect(buildFeatCandidates({ featVocabulary, picks: null })).toEqual([]);
  });
});
```

(The `replacesStance: undefined` in the composite-pick expectation above is intentional — a composite vocabulary entry never carries `replacesStance` at all, so the spread used in the implementation below never sets that key for it; adjust the implementation in Step 3 so this is exactly what it produces, rather than adjusting the test to hide a real inconsistency.)

- [x] **Step 2: Run tests to verify they fail**

Run: `npm test -- tests/agent-candidates.test.mjs`
Expected: FAIL — `buildFeatVocabulary`/`buildFeatCandidates` don't exist yet.

- [x] **Step 3: Implement in `scripts/agent-candidates.mjs`**

Add after the maneuver builders (per #909's plan, i.e. after `buildManeuverCandidates`):

```js
/**
 * #910: a feat/class-action vocabulary entry, built from two already-
 * eligibility-filtered plain-object lists dungeon-combat.mjs computes from
 * real actor/item data (this file has no Foundry API surface at all) —
 * selfEffectEntries (stance-trait or Rage items with a usable selfEffect)
 * and compositeEntries (the curated Sudden Charge/Lunge/Twin Feint
 * allowlist, each already matched to a real opponent). Self-effect
 * entries are always self-targeted (targetId: null); composite entries
 * always carry a real opponent id.
 */
export function buildFeatVocabulary({ selfEffectEntries = [], compositeEntries = [] }) {
  const vocabulary = [];
  for (const entry of selfEffectEntries) {
    vocabulary.push({
      type: 'feat', kind: 'selfEffect',
      itemId: entry.itemId, slug: entry.slug, name: entry.name, cost: entry.cost,
      targetId: null, replacesStance: entry.replacesStance ?? null,
    });
  }
  for (const entry of compositeEntries) {
    vocabulary.push({
      type: 'feat', kind: 'composite',
      itemId: entry.itemId, slug: entry.slug, name: entry.name, cost: entry.cost,
      targetId: entry.targetId,
    });
  }
  return vocabulary;
}

/**
 * Validates `picks` (the agent service's combined maneuver+feat response,
 * persisted once per turn in agentTurnState's existing maneuverPicks field
 * per #909 — no new turn-state field for this category) against
 * `featVocabulary`, ignoring any pick whose `type` isn't `'feat'` (those
 * belong to buildManeuverCandidates instead). Matches on
 * (kind, itemId, targetId) — the authoritative referential-integrity
 * check this pipeline relies on, mirroring buildManeuverCandidates
 * exactly for this category.
 */
export function buildFeatCandidates({ featVocabulary = [], picks = null }) {
  if (!picks) return [];
  const candidates = [];
  for (const pick of picks) {
    if (pick.type !== 'feat') continue;
    const match = featVocabulary.find(
      (v) => v.kind === pick.kind && v.itemId === pick.itemId && v.targetId === (pick.targetId ?? null),
    );
    if (!match) continue;
    const summary = pick.rationale ? `${match.name} — ${pick.rationale}` : match.name;
    candidates.push({
      id: match.targetId ? `feat:${match.itemId}:${match.targetId}` : `feat:${match.itemId}`,
      type: 'feat', kind: match.kind, itemId: match.itemId, slug: match.slug, targetId: match.targetId,
      cost: match.cost, replacesStance: match.replacesStance, summary,
    });
  }
  return candidates;
}
```

Wire into `buildCandidateList` (per #909's plan, add one more parameter and splice point):

```js
export function buildCandidateList({ /* ...#909's existing params..., */ maneuverVocabulary = [], maneuverPicks = null, featVocabulary = [] }) {
  if (turnState.actionsRemaining <= 0) return [endTurnCandidate()];
  return [
    ...buildMovementCandidates({ opponents, hazard, hasRangedOrReach }),
    ...buildStrikeCandidates({ readyActions, opponents, mapIncrement: turnState.mapIncrement }),
    ...buildManeuverCandidates({ maneuverVocabulary, maneuverPicks, opponents }),
    ...buildFeatCandidates({ featVocabulary, picks: maneuverPicks }),
    /* ...#909's existing spell/seek/endTurn splice points, unchanged... */
  ];
}
```

(The full parameter list and the rest of the splice order are exactly what #909's own plan already specifies — only the two new items shown above, `featVocabulary = []` in the signature and the `buildFeatCandidates` splice line right after `buildManeuverCandidates`'s, are new. Do not re-type the other ~15 existing parameters/splice lines from memory; open the file and add only these two things to what's already there once #909 has landed.)

- [x] **Step 4: Run tests to verify they pass**

Run: `npm test -- tests/agent-candidates.test.mjs`
Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add scripts/agent-candidates.mjs tests/agent-candidates.test.mjs
git commit -m "feat(#910): add feat vocabulary/candidate builders to agent-candidates

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 3: Self-effect eligibility (stance/Rage filter, already-active check, stance replacement)

**Files:**
- Modify: `scripts/dungeon-combat.mjs`
- Test: `tests/dungeon-combat-feat-self-effect-vocabulary.test.mjs`

**Interfaces:**
- Consumes: nothing from this plan's other tasks.
- Produces (consumed by Task 5): `async function computeSelfEffectVocabularyEntries(actor, actionsRemaining)` → `Promise<Array<{itemId, slug, name, cost, replacesStance}>>`.

- [ ] **Step 1: Write the failing tests**

```js
// tests/dungeon-combat-feat-self-effect-vocabulary.test.mjs
import { describe, it, expect, vi } from 'vitest';
import { computeSelfEffectVocabularyEntries } from '../scripts/dungeon-combat.mjs';

function actionItem({ id = 'rage1', slug = 'rage', traits = [], actionType = 'action', cost = 1, selfEffectUuid = 'Compendium.pf2e.feat-effects.Item.rage', frequencyValue = null, rules = [] } = {}) {
  return {
    id, slug, name: 'Rage',
    system: {
      actionType: { value: actionType },
      actions: { value: cost },
      selfEffect: selfEffectUuid ? { uuid: selfEffectUuid, name: 'Effect: Rage' } : null,
      frequency: frequencyValue === null ? null : { value: frequencyValue },
      traits: { value: traits },
      rules,
    },
    flags: { pf2e: { rulesSelections: {} } },
  };
}

function installFromUuidStub(effectsByUuid) {
  globalThis.fromUuid = vi.fn(async (uuid) => effectsByUuid[uuid] ?? null);
}

describe('computeSelfEffectVocabularyEntries', () => {
  it('includes Rage (not a stance-trait item) when its effect is not already active', async () => {
    installFromUuidStub({ 'Compendium.pf2e.feat-effects.Item.rage': { slug: 'effect-rage' } });
    const actor = { itemTypes: { action: [actionItem()], feat: [], effect: [] } };
    const entries = await computeSelfEffectVocabularyEntries(actor, 3);
    expect(entries).toEqual([{ itemId: 'rage1', slug: 'rage', name: 'Rage', cost: 1, replacesStance: null }]);
  });

  it('excludes Rage when its effect is already active (matched by origin.item uuid)', async () => {
    installFromUuidStub({ 'Compendium.pf2e.feat-effects.Item.rage': { slug: 'effect-rage' } });
    const actor = {
      itemTypes: {
        action: [actionItem()], feat: [],
        effect: [{ slug: 'effect-rage', system: { context: { origin: { item: 'Compendium.pf2e.feat-effects.Item.rage' } } } }],
      },
    };
    // The active effect's own origin.item must match the ACTION item's own
    // uuid (actor-owned items carry a real uuid, e.g. "Actor.x.Item.rage1")
    // -- this stub uses the compendium uuid directly for simplicity since
    // the match logic only ever compares against item.uuid, whatever that
    // resolves to; set actionItem's own .uuid to the same value the
    // effect's origin.item carries for this test.
    actor.itemTypes.action[0].uuid = 'Compendium.pf2e.feat-effects.Item.rage';
    const entries = await computeSelfEffectVocabularyEntries(actor, 3);
    expect(entries).toEqual([]);
  });

  it('excludes an item whose actionType is passive', async () => {
    const actor = { itemTypes: { action: [actionItem({ actionType: 'passive' })], feat: [], effect: [] } };
    expect(await computeSelfEffectVocabularyEntries(actor, 3)).toEqual([]);
  });

  it('excludes an item with no selfEffect at all', async () => {
    const actor = { itemTypes: { action: [actionItem({ selfEffectUuid: null })], feat: [], effect: [] } };
    expect(await computeSelfEffectVocabularyEntries(actor, 3)).toEqual([]);
  });

  it('excludes an item whose frequency is exhausted', async () => {
    installFromUuidStub({ 'Compendium.pf2e.feat-effects.Item.rage': { slug: 'effect-rage' } });
    const actor = { itemTypes: { action: [actionItem({ frequencyValue: 0 })], feat: [], effect: [] } };
    expect(await computeSelfEffectVocabularyEntries(actor, 3)).toEqual([]);
  });

  it('excludes an item whose cost exceeds the actions remaining this turn', async () => {
    installFromUuidStub({ 'Compendium.pf2e.feat-effects.Item.rage': { slug: 'effect-rage' } });
    const actor = { itemTypes: { action: [actionItem({ cost: 2 })], feat: [], effect: [] } };
    expect(await computeSelfEffectVocabularyEntries(actor, 1)).toEqual([]);
  });

  it('excludes an item with an unresolved ChoiceSet rule', async () => {
    installFromUuidStub({ 'Compendium.pf2e.feat-effects.Item.rage': { slug: 'effect-rage' } });
    const item = actionItem({ rules: [{ key: 'ChoiceSet', flag: 'damage', choices: [{ value: 'fire' }] }] });
    const actor = { itemTypes: { action: [item], feat: [], effect: [] } };
    expect(await computeSelfEffectVocabularyEntries(actor, 3)).toEqual([]);
  });

  it('includes a stance-trait item neither in effect nor replacing anything, when the actor has no active stance', async () => {
    installFromUuidStub({ 'Compendium.pf2e.feat-effects.Item.gorilla': { slug: 'effect-gorilla-stance' } });
    const stanceItem = actionItem({ id: 'gorilla1', slug: 'gorilla-stance', traits: ['stance'], selfEffectUuid: 'Compendium.pf2e.feat-effects.Item.gorilla' });
    const actor = { itemTypes: { action: [stanceItem], feat: [], effect: [] } };
    const entries = await computeSelfEffectVocabularyEntries(actor, 3);
    expect(entries).toEqual([{ itemId: 'gorilla1', slug: 'gorilla-stance', name: 'Rage', cost: 1, replacesStance: null }]);
  });

  it('flags replacesStance when the actor is already in a different stance', async () => {
    installFromUuidStub({
      'Compendium.pf2e.feat-effects.Item.gorilla': { slug: 'effect-gorilla-stance' },
      'Compendium.pf2e.feat-effects.Item.crane': { slug: 'effect-crane-stance' },
    });
    globalThis.fromUuid.mockImplementation(async (uuid) => {
      if (uuid === 'Compendium.pf2e.feat-effects.Item.gorilla') return { slug: 'effect-gorilla-stance' };
      if (uuid === 'Compendium.pf2e.feat-effects.Item.crane') return { slug: 'effect-crane-stance' };
      if (uuid === 'Actor.x.Item.crane-feat') return { system: { traits: { value: ['stance'] } } };
      return null;
    });
    const stanceItem = actionItem({ id: 'gorilla1', slug: 'gorilla-stance', traits: ['stance'], selfEffectUuid: 'Compendium.pf2e.feat-effects.Item.gorilla' });
    const activeCraneEffect = { id: 'effect-crane-id', slug: 'effect-crane-stance', system: { context: { origin: { item: 'Actor.x.Item.crane-feat' } } } };
    const actor = { itemTypes: { action: [stanceItem], feat: [], effect: [activeCraneEffect] } };
    const entries = await computeSelfEffectVocabularyEntries(actor, 3);
    expect(entries).toEqual([{ itemId: 'gorilla1', slug: 'gorilla-stance', name: 'Rage', cost: 1, replacesStance: 'effect-crane-id' }]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- tests/dungeon-combat-feat-self-effect-vocabulary.test.mjs`
Expected: FAIL — `computeSelfEffectVocabularyEntries` doesn't exist yet.

- [ ] **Step 3: Implement in `scripts/dungeon-combat.mjs`**

Add near the Task 5 maneuver eligibility helpers (per #909's plan, i.e. near `computeManeuverAttackerProfile`):

```js
const SELF_EFFECT_SLUGS = new Set(["rage"]);

/** #910: a PF2e `ChoiceSet` rule left unresolved on this item — matches
 * choice-set.mjs's own detection shape (`key === 'ChoiceSet'`, a string
 * `flag`, a non-empty `choices` array), checked against the item's own
 * resolved `flags.pf2e.rulesSelections` rather than resolving it (this
 * module never invents a choice for an AI actor's own feat). */
function hasUnresolvedChoiceSet(item) {
  const rules = item.system?.rules ?? [];
  return rules.some(
    (r) =>
      r.key === "ChoiceSet" &&
      typeof r.flag === "string" &&
      Array.isArray(r.choices) &&
      r.choices.length &&
      item.flags?.pf2e?.rulesSelections?.[r.flag] === undefined,
  );
}

/** #910: whether `actor` already has an active effect that was created
 * from `item` -- reproducing the exact origin-tracking shape PF2e's own
 * self-effect chat-card handler writes (`system.context.origin.item` is
 * set to the triggering action/feat item's own uuid when the effect is
 * created, confirmed by reading that handler directly) -- not a slug
 * comparison, which would conflate two different items that happen to
 * link the same effect. */
function actorAlreadyHasEffectFrom(actor, item) {
  return (actor.itemTypes?.effect ?? []).some(
    (e) => e.system?.context?.origin?.item === item.uuid,
  );
}

/** #910: if `actor` has a DIFFERENT active stance effect right now (an
 * effect whose own origin item carries the 'stance' trait), returns that
 * effect's own id so execution can remove it before applying the new
 * one -- PF2e RAW: entering a stance always replaces any stance already
 * active, never stacks. Returns null when no other stance is active. */
async function findActiveStanceEffectId(actor) {
  for (const effect of actor.itemTypes?.effect ?? []) {
    const originItemUuid = effect.system?.context?.origin?.item;
    if (!originItemUuid) continue;
    const originItem = await fromUuid(originItemUuid);
    if (originItem?.system?.traits?.value?.includes("stance")) return effect.id;
  }
  return null;
}

/** #910: the self-effect vocabulary category (stances + Rage only, per
 * this feature's spec) -- scans both itemTypes.action and itemTypes.feat
 * (PF2e's own self-effect marker lives on both, confirmed by the
 * installed system's own iteration over `[...itemTypes.action,
 * ...itemTypes.feat]`). */
export async function computeSelfEffectVocabularyEntries(actor, actionsRemaining) {
  const entries = [];
  const candidates = [...(actor.itemTypes?.action ?? []), ...(actor.itemTypes?.feat ?? [])];
  for (const item of candidates) {
    if (item.system.actionType?.value === "passive") continue;
    if (!item.system.selfEffect) continue;
    const isStance = (item.system.traits?.value ?? []).includes("stance");
    if (!isStance && !SELF_EFFECT_SLUGS.has(item.slug)) continue;
    const cost = item.system.actions?.value ?? 1;
    if (cost > actionsRemaining) continue;
    const frequencyValue = item.system.frequency?.value;
    if (typeof frequencyValue === "number" && frequencyValue <= 0) continue;
    if (hasUnresolvedChoiceSet(item)) continue;
    const effect = await fromUuid(item.system.selfEffect.uuid);
    if (!effect) continue;
    if (actorAlreadyHasEffectFrom(actor, item)) continue;
    const replacesStance = isStance ? await findActiveStanceEffectId(actor) : null;
    entries.push({ itemId: item.id, slug: item.slug, name: item.name, cost, replacesStance });
  }
  return entries;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- tests/dungeon-combat-feat-self-effect-vocabulary.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/dungeon-combat.mjs tests/dungeon-combat-feat-self-effect-vocabulary.test.mjs
git commit -m "feat(#910): add self-effect feat eligibility (stances + Rage)

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 4: Composite feat eligibility (Sudden Charge, Lunge, Twin Feint)

**Files:**
- Modify: `scripts/dungeon-combat.mjs`
- Test: `tests/dungeon-combat-feat-composite-vocabulary.test.mjs`

**Interfaces:**
- Consumes: `AGENT_MELEE_REACH_SQUARES` (already imported per #909's plan).
- Produces (consumed by Task 5): `function computeCompositeVocabularyEntries(actor, opponents, actionsRemaining)` → `Array<{itemId, slug, name, cost, targetId}>`.

- [ ] **Step 1: Write the failing tests**

```js
// tests/dungeon-combat-feat-composite-vocabulary.test.mjs
import { describe, it, expect } from 'vitest';
import { computeCompositeVocabularyEntries } from '../scripts/dungeon-combat.mjs';

function meleeStrikeAction({ item = { id: 'sword1', slug: 'longsword', system: { traits: { value: ['versatile-p'] } } } } = {}) {
  return { type: 'strike', ready: true, item, slug: item.slug, label: item.slug };
}

function feat({ id, slug, name, cost = 1 }) {
  return { id, slug, name, system: { actions: { value: cost } } };
}

describe('computeCompositeVocabularyEntries', () => {
  const opponentAdjacent = { id: 'opp1', name: 'Goblin', distanceSquares: 1, hasLineOfSight: true };
  const opponentAtLungeRange = { id: 'opp2', name: 'Orc', distanceSquares: 2, hasLineOfSight: true };
  const opponentFar = { id: 'opp3', name: 'Archer', distanceSquares: 5, hasLineOfSight: true };

  it('offers Lunge against an opponent exactly one square beyond melee reach, when wielding a melee weapon', () => {
    const actor = { itemTypes: { feat: [feat({ id: 'f1', slug: 'lunge', name: 'Lunge' })] }, system: { actions: [meleeStrikeAction()] } };
    const entries = computeCompositeVocabularyEntries(actor, [opponentAtLungeRange], 3);
    expect(entries).toEqual([{ itemId: 'f1', slug: 'lunge', name: 'Lunge', cost: 1, targetId: 'opp2' }]);
  });

  it('does not offer Lunge against an already-adjacent opponent (no reach extension needed)', () => {
    const actor = { itemTypes: { feat: [feat({ id: 'f1', slug: 'lunge', name: 'Lunge' })] }, system: { actions: [meleeStrikeAction()] } };
    const entries = computeCompositeVocabularyEntries(actor, [opponentAdjacent], 3);
    expect(entries).toEqual([]);
  });

  it('does not offer Lunge without a melee strike action ready', () => {
    const actor = { itemTypes: { feat: [feat({ id: 'f1', slug: 'lunge', name: 'Lunge' })] }, system: { actions: [] } };
    expect(computeCompositeVocabularyEntries(actor, [opponentAtLungeRange], 3)).toEqual([]);
  });

  it('offers Sudden Charge against a far opponent within double speed, not against an adjacent one', () => {
    const actor = {
      itemTypes: { feat: [feat({ id: 'f2', slug: 'sudden-charge', name: 'Sudden Charge', cost: 2 })] },
      system: { actions: [meleeStrikeAction()], movement: { speeds: { land: { value: 25 } } } },
    };
    const entries = computeCompositeVocabularyEntries(actor, [opponentFar], 3);
    expect(entries).toEqual([{ itemId: 'f2', slug: 'sudden-charge', name: 'Sudden Charge', cost: 2, targetId: 'opp3' }]);
    expect(computeCompositeVocabularyEntries(actor, [opponentAdjacent], 3)).toEqual([]);
  });

  it('does not offer Sudden Charge when its cost exceeds actionsRemaining', () => {
    const actor = {
      itemTypes: { feat: [feat({ id: 'f2', slug: 'sudden-charge', name: 'Sudden Charge', cost: 2 })] },
      system: { actions: [meleeStrikeAction()], movement: { speeds: { land: { value: 25 } } } },
    };
    expect(computeCompositeVocabularyEntries(actor, [opponentFar], 1)).toEqual([]);
  });

  it('offers Twin Feint only with two ready melee strikes from different weapon items, against an adjacent opponent', () => {
    const sword = { id: 'sword1', slug: 'longsword', system: { traits: { value: [] } } };
    const dagger = { id: 'dagger1', slug: 'dagger', system: { traits: { value: [] } } };
    const actor = {
      itemTypes: { feat: [feat({ id: 'f3', slug: 'twin-feint', name: 'Twin Feint', cost: 2 })] },
      system: { actions: [meleeStrikeAction({ item: sword }), meleeStrikeAction({ item: dagger })] },
    };
    const entries = computeCompositeVocabularyEntries(actor, [opponentAdjacent], 3);
    expect(entries).toEqual([{ itemId: 'f3', slug: 'twin-feint', name: 'Twin Feint', cost: 2, targetId: 'opp1' }]);
  });

  it('does not offer Twin Feint with only one distinct weapon (two variants of the same item)', () => {
    const sword = { id: 'sword1', slug: 'longsword', system: { traits: { value: [] } } };
    const actor = {
      itemTypes: { feat: [feat({ id: 'f3', slug: 'twin-feint', name: 'Twin Feint', cost: 2 })] },
      system: { actions: [meleeStrikeAction({ item: sword }), meleeStrikeAction({ item: sword })] },
    };
    expect(computeCompositeVocabularyEntries(actor, [opponentAdjacent], 3)).toEqual([]);
  });

  it('excludes a ranged strike action from counting toward any composite prerequisite', () => {
    const bow = { id: 'bow1', slug: 'shortbow', system: { traits: { value: ['range-increment-60'] } } };
    const actor = { itemTypes: { feat: [feat({ id: 'f1', slug: 'lunge', name: 'Lunge' })] }, system: { actions: [meleeStrikeAction({ item: bow })] } };
    // A ranged weapon item's own strike action never counts as "wielding a
    // melee weapon" for Lunge's requirement -- confirm with the real
    // traits-based ranged check this task's implementation uses (see Step 3).
    expect(computeCompositeVocabularyEntries(actor, [opponentAtLungeRange], 3)).toEqual([]);
  });

  it('returns an empty array for an actor with none of the three composite feats', () => {
    const actor = { itemTypes: { feat: [] }, system: { actions: [meleeStrikeAction()] } };
    expect(computeCompositeVocabularyEntries(actor, [opponentAdjacent], 3)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- tests/dungeon-combat-feat-composite-vocabulary.test.mjs`
Expected: FAIL — `computeCompositeVocabularyEntries` doesn't exist yet.

- [ ] **Step 3: Implement in `scripts/dungeon-combat.mjs`**

Add alongside Task 3's helpers:

```js
/** A weapon item's own `range-increment-*` trait is this codebase's only
 * reliable "is this a ranged weapon" signal on a bare item (no dedicated
 * boolean field) -- reused here rather than invented, matching how
 * `hasRangedOrReach` elsewhere in this file already treats reach/range
 * strikes as a single "not purely melee" category. */
function isMeleeWeaponItem(item) {
  return !(item?.system?.traits?.value ?? []).some((t) => t.startsWith("range-increment"));
}

function readyMeleeStrikeActions(actor) {
  return (actor.system?.actions ?? []).filter(
    (a) => a.type === "strike" && a.ready !== false && isMeleeWeaponItem(a.item),
  );
}

const COMPOSITE_FEAT_SLUGS = new Set(["sudden-charge", "lunge", "twin-feint"]);

/** #910: the curated composite-feat allowlist's own eligibility, entirely
 * deterministic (no LLM input) -- each feat's real PF2e prerequisite,
 * confirmed live against the installed system's own feat text, not
 * approximated beyond the one documented exception in this plan's Global
 * Constraints (Twin Feint's "two different weapon items" stand-in for
 * literal hand assignment). */
export function computeCompositeVocabularyEntries(actor, opponents, actionsRemaining) {
  const entries = [];
  const feats = (actor.itemTypes?.feat ?? []).filter((f) => COMPOSITE_FEAT_SLUGS.has(f.slug));
  const meleeActions = readyMeleeStrikeActions(actor);

  for (const feat of feats) {
    const cost = feat.system.actions?.value ?? 1;
    if (cost > actionsRemaining) continue;

    if (feat.slug === "lunge") {
      if (meleeActions.length === 0) continue;
      for (const opponent of opponents) {
        if (opponent.distanceSquares === AGENT_MELEE_REACH_SQUARES + 1 && opponent.hasLineOfSight !== false) {
          entries.push({ itemId: feat.id, slug: feat.slug, name: feat.name, cost, targetId: opponent.id });
        }
      }
    } else if (feat.slug === "sudden-charge") {
      if (meleeActions.length === 0) continue;
      const speedFt = actor.system?.movement?.speeds?.land?.value ?? 0;
      const doubleSpeedSquares = Math.floor((speedFt * 2) / 5);
      for (const opponent of opponents) {
        if (
          opponent.distanceSquares > AGENT_MELEE_REACH_SQUARES &&
          opponent.distanceSquares <= doubleSpeedSquares &&
          opponent.hasLineOfSight !== false
        ) {
          entries.push({ itemId: feat.id, slug: feat.slug, name: feat.name, cost, targetId: opponent.id });
        }
      }
    } else if (feat.slug === "twin-feint") {
      const distinctWeaponItemIds = new Set(meleeActions.map((a) => a.item?.id));
      if (distinctWeaponItemIds.size < 2) continue;
      for (const opponent of opponents) {
        if (opponent.distanceSquares <= AGENT_MELEE_REACH_SQUARES && opponent.hasLineOfSight !== false) {
          entries.push({ itemId: feat.id, slug: feat.slug, name: feat.name, cost, targetId: opponent.id });
        }
      }
    }
  }
  return entries;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- tests/dungeon-combat-feat-composite-vocabulary.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/dungeon-combat.mjs tests/dungeon-combat-feat-composite-vocabulary.test.mjs
git commit -m "feat(#910): add composite feat eligibility (Sudden Charge, Lunge, Twin Feint)

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 5: Wire `featVocabulary` into `getPendingAgentTurn` and the once-per-turn fetch

**Files:**
- Modify: `scripts/dungeon-combat.mjs`
- Test: `tests/dungeon-combat-agent-feat-pending.test.mjs`

**Interfaces:**
- Consumes: `computeSelfEffectVocabularyEntries` (Task 3), `computeCompositeVocabularyEntries` (Task 4), `buildFeatVocabulary` (Task 2).
- Produces: `getPendingAgentTurn`'s return value now also carries `featVocabulary`; `runAgentDecisionLoop`'s fetch gate now also fires on a non-empty `featVocabulary`, sending both vocabularies combined in one call.

- [ ] **Step 1: Write the failing test**

Mirror #909's own Task 6 approach exactly: find and read whichever existing test already exercises `getPendingAgentTurn` end to end (`grep -rl "getPendingAgentTurn(" tests/*.mjs`), copy its combat/combatant/actor stub shape, and write:

```js
// tests/dungeon-combat-agent-feat-pending.test.mjs
import { describe, it, expect } from 'vitest';
import { getPendingAgentTurn } from '../scripts/dungeon-combat.mjs';

describe('getPendingAgentTurn feat vocabulary', () => {
  it('includes an eligible self-effect item in featVocabulary', async () => {
    // Build the stub (copied shape) with an actor whose itemTypes.action
    // includes a Rage-shaped action item (selfEffect set, not already
    // active). Stub globalThis.fromUuid to resolve that effect.
    // const pending = await getPendingAgentTurn(combat);
    // expect(pending.featVocabulary).toContainEqual(
    //   expect.objectContaining({ type: 'feat', kind: 'selfEffect', slug: 'rage' }),
    // );
  });

  it('returns an empty featVocabulary for an actor with no eligible self-effect or composite feat', async () => {
    // same stub, actor with no such items -- expect([]).
  });
});
```

(As with #909's own Task 6, the bodies above intentionally stay commented/pseudocoded pending the real stub shape — fill in and uncomment before running.)

- [ ] **Step 2: Run test to verify it fails (once filled in)**

Run: `npm test -- tests/dungeon-combat-agent-feat-pending.test.mjs`
Expected: FAIL — `pending.featVocabulary` is `undefined`.

- [ ] **Step 3: Build the combined feat vocabulary inside `getPendingAgentTurn`**

Right after the maneuver vocabulary block (per #909's plan), add:

```js
  const selfEffectEntries = await computeSelfEffectVocabularyEntries(combatant.actor, turnState.actionsRemaining);
  const compositeEntries = computeCompositeVocabularyEntries(combatant.actor, opponents, turnState.actionsRemaining);
  const featVocabulary = buildFeatVocabulary({ selfEffectEntries, compositeEntries });
```

(`opponents` here is the same already-built serialized opponent list `buildManeuverVocabulary`'s own call site uses, which already carries `distanceSquares`/`hasLineOfSight`/`id`/`name` — `computeCompositeVocabularyEntries` needs exactly that shape, confirmed by Task 4's own test fixtures.)

Pass `featVocabulary` into the existing `buildCandidateList({...})` call (one more property) and add it to the function's final return object, alongside `maneuverVocabulary`:

```js
  return {
    combatId: combat.id,
    combatantId: combatant.id,
    context: buildDecisionContext({ self, opponents, allies, candidates, roundNumber: combat.round }),
    candidates,
    maneuverVocabulary,
    featVocabulary,
  };
```

- [ ] **Step 4: Widen `runAgentDecisionLoop`'s fetch gate to cover feat vocabulary too**

In `runAgentDecisionLoop` (per #909's plan), change:

```js
    if (pending.maneuverVocabulary?.length) {
```

to:

```js
    if (pending.maneuverVocabulary?.length || pending.featVocabulary?.length) {
```

and change the `vocabulary` sent to `fetchCandidates` from `pending.maneuverVocabulary` alone to the combined array:

```js
          const response = await fetchCandidates({
            baseUrl,
            apiKey,
            context: pending.context,
            vocabulary: [...pending.maneuverVocabulary, ...pending.featVocabulary],
          });
```

No other change to this function is needed — the persisted `maneuverPicks` field (per #909's plan) already holds whatever `picks` the combined response returns, and `buildFeatCandidates` (Task 2) already reads that same field, filtering by `type === 'feat'`.

- [ ] **Step 5: Fill in and run the Task 5 test, confirm it passes**

Run: `npm test -- tests/dungeon-combat-agent-feat-pending.test.mjs`
Expected: PASS.

- [ ] **Step 6: Run the full suite**

Run: `npm test`
Expected: PASS (0 new failures). As with #909's own Task 6, check every pre-existing test asserting `getPendingAgentTurn`'s exact whole-object return shape via `toEqual` and add `featVocabulary: [...]` to each expected object (`grep -rln "getPendingAgentTurn(" tests/*.mjs`).

- [ ] **Step 7: Commit**

```bash
git add scripts/dungeon-combat.mjs tests/dungeon-combat-agent-feat-pending.test.mjs
git commit -m "feat(#910): build combined feat vocabulary and widen the once-per-turn fetch gate

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 6: Execute a self-effect feat candidate

**Files:**
- Modify: `scripts/dungeon-combat.mjs`
- Test: `tests/dungeon-combat-feat-self-effect-execution.test.mjs`

**Interfaces:**
- Consumes: nothing new.
- Produces: `executeSelfEffectFeat(combat, combatant, candidate)`, dispatched from a new branch in `applyAgentDecision`.

- [ ] **Step 1: Write the failing tests**

Find and read an existing `applyAgentDecision` test first (`grep -rl "applyAgentDecision(" tests/*.mjs`) to copy its stub shape, then:

```js
// tests/dungeon-combat-feat-self-effect-execution.test.mjs
import { describe, it, expect, vi } from 'vitest';
import { applyAgentDecision } from '../scripts/dungeon-combat.mjs';

describe('applyAgentDecision self-effect feat execution', () => {
  it('creates the linked effect on the actor, with the real origin-context shape PF2e itself writes', async () => {
    // combatant.actor has the Rage action item (id 'rage1', uuid
    // 'Actor.combatant1.Item.rage1', system.selfEffect.uuid pointing at a
    // stubbed fromUuid effect, system.traits.value: [], no frequency).
    // Stub fromUuid to return an EffectPF2e-like object whose .toObject()
    // returns a plain effect source. Stub
    // combatant.actor.createEmbeddedDocuments.
    // await applyAgentDecision(combat, combatantId, 'feat:rage1', 'r');
    // expect(combatant.actor.createEmbeddedDocuments).toHaveBeenCalledWith('Item', [
    //   expect.objectContaining({
    //     _id: null,
    //     system: expect.objectContaining({
    //       context: expect.objectContaining({
    //         origin: expect.objectContaining({ actor: combatant.actor.uuid, item: 'Actor.combatant1.Item.rage1' }),
    //       }),
    //     }),
    //   }),
    // ]);
  });

  it('decrements the action item\'s own frequency.value when present', async () => {
    // same shape, item.system.frequency = { value: 1 }; after execution,
    // expect item.update to have been called with
    // { 'system.frequency.value': 0 }.
  });

  it('deletes the old stance effect first when replacesStance is set on the candidate', async () => {
    // candidate carries replacesStance: 'old-effect-id'; expect
    // combatant.actor.deleteEmbeddedDocuments('Item', ['old-effect-id'])
    // to have been called before createEmbeddedDocuments.
  });

  it('does nothing when the action/feat item can no longer be found', async () => {
    // actor.itemTypes.action/feat don't contain a matching itemId --
    // createEmbeddedDocuments must never be called.
  });

  it('does nothing when the selfEffect UUID no longer resolves', async () => {
    // fromUuid stubbed to return null -- createEmbeddedDocuments must
    // never be called.
  });
});
```

- [ ] **Step 2: Run tests to verify they fail (once filled in)**

Run: `npm test -- tests/dungeon-combat-feat-self-effect-execution.test.mjs`
Expected: FAIL — `applyAgentDecision` has no `feat` branch yet.

- [ ] **Step 3: Implement `executeSelfEffectFeat` and wire the branch**

Add near `executeManeuverCandidate` (per #909's plan):

```js
/** #910: reproduces the installed PF2e system's own `#onClickApplyEffect`
 * chat-card handler exactly (confirmed by reading it directly) -- that
 * handler is a UI event listener, not a public API, so this function
 * merges the same origin-context shape by hand rather than calling it. */
async function executeSelfEffectFeat(combat, combatant, candidate) {
  const item = [...(combatant.actor.itemTypes?.action ?? []), ...(combatant.actor.itemTypes?.feat ?? [])].find(
    (i) => i.id === candidate.itemId,
  );
  if (!item) return;
  const effect = await fromUuid(item.system.selfEffect.uuid);
  if (!effect) return;

  if (candidate.replacesStance) {
    await combatant.actor.deleteEmbeddedDocuments("Item", [candidate.replacesStance]);
  }

  const validTraits = (item.system.traits?.value ?? []).filter((t) => t in EffectPF2e.validTraits);
  const merged = foundry.utils.mergeObject(effect.toObject(), {
    _id: null,
    system: {
      context: {
        origin: {
          actor: combatant.actor.uuid,
          token: combatant.token?.document?.uuid ?? null,
          item: item.uuid,
          spellcasting: null,
          rollOptions: item.getOriginData().rollOptions,
        },
        target: { actor: combatant.actor.uuid, token: combatant.token?.document?.uuid ?? null },
        roll: null,
      },
      traits: { value: validTraits },
    },
  });
  await combatant.actor.createEmbeddedDocuments("Item", [merged]);

  if (item.system.frequency) {
    await item.update({ "system.frequency.value": item.system.frequency.value - 1 });
  }
}
```

Add the dispatching branch inside `applyAgentDecision` (alongside the existing `maneuver` branch per #909's plan):

```js
  } else if (candidate.type === "feat" && candidate.kind === "selfEffect") {
    await executeSelfEffectFeat(combat, combatant, candidate);
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- tests/dungeon-combat-feat-self-effect-execution.test.mjs`
Expected: PASS.

- [ ] **Step 5: Run the full suite**

Run: `npm test`
Expected: PASS (0 new failures).

- [ ] **Step 6: Commit**

```bash
git add scripts/dungeon-combat.mjs tests/dungeon-combat-feat-self-effect-execution.test.mjs
git commit -m "feat(#910): execute self-effect feat candidates (create the linked effect)

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 7: Execute Lunge

**Files:**
- Modify: `scripts/dungeon-combat.mjs`
- Test: `tests/dungeon-combat-feat-lunge-execution.test.mjs`

**Interfaces:**
- Consumes: `resolveOpponentForTurn` (module-private), `rollAndApplyStrikeAtVariant` (module-private), `readyMeleeStrikeActions` (Task 4).
- Produces: `executeLunge(combat, combatant, candidate)`, dispatched from `applyAgentDecision`.

- [ ] **Step 1: Write the failing tests**

```js
// tests/dungeon-combat-feat-lunge-execution.test.mjs
import { describe, it, expect, vi } from 'vitest';
import { applyAgentDecision } from '../scripts/dungeon-combat.mjs';

describe('applyAgentDecision Lunge execution', () => {
  it('toggles the lunge roll option on, strikes with the ready melee weapon, then toggles it back off', async () => {
    // combatant.actor.toggleRollOption is a vi.fn(); game.pf2e not needed
    // here (Lunge is a plain Strike, not a game.pf2e.actions.* macro).
    // await applyAgentDecision(combat, combatantId, 'feat:lunge1:opp1', 'r');
    // expect(combatant.actor.toggleRollOption).toHaveBeenNthCalledWith(1, 'all', 'lunge', 'lunge1', true);
    // expect(combatant.actor.toggleRollOption).toHaveBeenNthCalledWith(2, 'all', 'lunge', 'lunge1', false);
  });

  it('does nothing when the target no longer exists', async () => {
    // resolveOpponentForTurn returns null -- toggleRollOption must never
    // be called.
  });
});
```

- [ ] **Step 2: Run test to verify it fails (once filled in)**

Run: `npm test -- tests/dungeon-combat-feat-lunge-execution.test.mjs`
Expected: FAIL — no `feat`/`composite`/`lunge` dispatch exists yet.

- [ ] **Step 3: Implement `executeLunge` and wire the dispatch**

```js
/** #910: Lunge is a plain Strike with its own reach bonus toggled on for
 * the duration of that one Strike -- confirmed live, Lunge's own rule
 * elements are a toggleable RollOption plus an ActiveEffectLike adding 5ft
 * to reach predicated on it, with no explicit domain (defaults to "all"). */
async function executeLunge(combat, combatant, candidate, target) {
  const action = (combatant.actor?.system?.actions ?? []).find(
    (a) => a.type === "strike" && a.ready !== false && isMeleeWeaponItem(a.item),
  );
  if (!action) return;
  const actionSlug = action.item?.slug ?? action.slug ?? action.label;
  await combatant.actor.toggleRollOption("all", "lunge", candidate.itemId, true);
  await rollAndApplyStrikeAtVariant(combat, combatant, target, actionSlug, 0);
  await combatant.actor.toggleRollOption("all", "lunge", candidate.itemId, false);
}
```

Add the `composite` dispatch branch in `applyAgentDecision` (immediately after the `selfEffect` branch from Task 6):

```js
  } else if (candidate.type === "feat" && candidate.kind === "composite") {
    const target = resolveOpponentForTurn(combat, combatant, candidate.targetId);
    if (!target) return;
    if (candidate.slug === "lunge") {
      await executeLunge(combat, combatant, candidate, target);
    } else if (candidate.slug === "sudden-charge") {
      await executeSuddenCharge(combat, combatant, candidate, target);
    } else if (candidate.slug === "twin-feint") {
      await executeTwinFeint(combat, combatant, candidate, target);
    }
```

(`executeSuddenCharge`/`executeTwinFeint` are added in Tasks 8/9 — this branch references them ahead of their own definitions purely in source order; place this dispatch branch's own code after all three executor functions are defined, or declare them with `function` hoisting as this file already does elsewhere for its other helpers, so the branch compiles regardless of which task lands first in a differently-ordered execution.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- tests/dungeon-combat-feat-lunge-execution.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/dungeon-combat.mjs tests/dungeon-combat-feat-lunge-execution.test.mjs
git commit -m "feat(#910): execute Lunge (toggle reach, strike, untoggle)

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 8: Execute Sudden Charge

**Files:**
- Modify: `scripts/dungeon-combat.mjs`
- Test: `tests/dungeon-combat-feat-sudden-charge-execution.test.mjs`

**Interfaces:**
- Consumes: `strideByPosture` (exported, per #909's plan reuse), `resolveOpponentForTurn`, `rollAndApplyStrikeAtVariant`, `strikeInReach` (module-private, already used by the existing `strike` branch).
- Produces: `executeSuddenCharge(combat, combatant, candidate, target)`.

- [ ] **Step 1: Write the failing tests**

```js
// tests/dungeon-combat-feat-sudden-charge-execution.test.mjs
import { describe, it, expect, vi } from 'vitest';
import { applyAgentDecision } from '../scripts/dungeon-combat.mjs';

describe('applyAgentDecision Sudden Charge execution', () => {
  it('strides twice toward the target, then strikes if now within melee reach', async () => {
    // Stub strideByPosture-driven movement so the combatant ends up
    // adjacent to the target after two strides (use the same
    // combat/combatant/target stub shape an existing stride+strike test
    // already uses). Confirm the strike actually executes (damage/roll
    // call happens) once in melee reach.
  });

  it('does not strike if still out of melee reach after both strides (e.g. boxed in by walls)', async () => {
    // Same shape, but movement blocked -- confirm no strike-roll call
    // happens.
  });

  it('does nothing when the target no longer exists', async () => {
    // resolveOpponentForTurn returns null -- strideByPosture must never
    // be called.
  });
});
```

- [ ] **Step 2: Run test to verify it fails (once filled in)**

Run: `npm test -- tests/dungeon-combat-feat-sudden-charge-execution.test.mjs`
Expected: FAIL — `executeSuddenCharge` doesn't exist yet.

- [ ] **Step 3: Implement `executeSuddenCharge`**

```js
/** #910: PF2e RAW text: "Stride twice. If you end your movement within
 * melee reach of at least one enemy, you can make a melee Strike against
 * that enemy." -- reuses strideByPosture's own existing 'approach' posture
 * twice (it already stops within melee reach on its own, so calling it a
 * second time when the first already reached the target is a safe no-op),
 * then strikeInReach's own existing check (used identically by the plain
 * 'strike' branch) gates whether the Strike actually happens. */
async function executeSuddenCharge(combat, combatant, candidate, target) {
  await strideByPosture(combat, combatant, "approach", target);
  await strideByPosture(combat, combatant, "approach", target);

  const action = (combatant.actor?.system?.actions ?? []).find(
    (a) => a.type === "strike" && a.ready !== false && isMeleeWeaponItem(a.item),
  );
  if (!action) return;
  const gridSize = combat.scene?.grid?.size ?? 100;
  const gridDistanceFt = combat.scene?.grid?.distance ?? 5;
  const check = strikeInReach(combatant, target, action, gridSize, gridDistanceFt);
  if (!check?.inReach) return;
  const actionSlug = action.item?.slug ?? action.slug ?? action.label;
  await rollAndApplyStrikeAtVariant(combat, combatant, target, actionSlug, 0);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- tests/dungeon-combat-feat-sudden-charge-execution.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/dungeon-combat.mjs tests/dungeon-combat-feat-sudden-charge-execution.test.mjs
git commit -m "feat(#910): execute Sudden Charge (stride twice, strike if in reach)

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 9: Execute Twin Feint

**Files:**
- Modify: `scripts/dungeon-combat.mjs`
- Test: `tests/dungeon-combat-feat-twin-feint-execution.test.mjs`

**Interfaces:**
- Consumes: `rollAndApplyStrikeAtVariant`, `readyMeleeStrikeActions` (Task 4).
- Produces: `executeTwinFeint(combat, combatant, candidate, target)`.

- [ ] **Step 1: Write the failing tests**

```js
// tests/dungeon-combat-feat-twin-feint-execution.test.mjs
import { describe, it, expect, vi } from 'vitest';
import { applyAgentDecision } from '../scripts/dungeon-combat.mjs';

describe('applyAgentDecision Twin Feint execution', () => {
  it('strikes once with each of the two distinct melee weapons, applying Off-Guard between them and removing it afterward', async () => {
    // target.actor.increaseCondition / decreaseCondition are vi.fn()s.
    // await applyAgentDecision(combat, combatantId, 'feat:twin1:opp1', 'r');
    // expect(target.actor.increaseCondition).toHaveBeenCalledWith('off-guard');
    // expect(target.actor.decreaseCondition).toHaveBeenCalledWith('off-guard', { forceRemove: true });
    // (and confirm two distinct strike-roll calls happened, one per weapon slug)
  });

  it('does nothing when fewer than two distinct melee weapons are ready at execution time', async () => {
    // actor now has only one ready melee strike action (e.g. the other
    // weapon was lost/unequipped between candidate generation and
    // execution) -- increaseCondition must never be called.
  });
});
```

- [ ] **Step 2: Run test to verify it fails (once filled in)**

Run: `npm test -- tests/dungeon-combat-feat-twin-feint-execution.test.mjs`
Expected: FAIL — `executeTwinFeint` doesn't exist yet.

- [ ] **Step 3: Implement `executeTwinFeint`**

```js
/** #910: neither Twin Feint's own rule elements (confirmed live: empty)
 * nor PF2e's system automate "the target is automatically Off-Guard
 * against the second attack" -- applied by hand, then removed afterward
 * (it only ever applies to this one pair of Strikes, never persists). */
async function executeTwinFeint(combat, combatant, candidate, target) {
  const actions = readyMeleeStrikeActions(combatant.actor);
  const distinctByItemId = [...new Map(actions.map((a) => [a.item?.id, a])).values()];
  if (distinctByItemId.length < 2) return;
  const [first, second] = distinctByItemId;
  const firstSlug = first.item?.slug ?? first.slug ?? first.label;
  const secondSlug = second.item?.slug ?? second.slug ?? second.label;

  await rollAndApplyStrikeAtVariant(combat, combatant, target, firstSlug, 0);
  await target.actor.increaseCondition("off-guard");
  await rollAndApplyStrikeAtVariant(combat, combatant, target, secondSlug, 0);
  await target.actor.decreaseCondition("off-guard", { forceRemove: true });
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- tests/dungeon-combat-feat-twin-feint-execution.test.mjs`
Expected: PASS.

- [ ] **Step 5: Run the full suite once, now that all three composite executors and the dispatch branch from Task 7 are in place together**

Run: `npm test`
Expected: PASS (0 new failures).

- [ ] **Step 6: Commit**

```bash
git add scripts/dungeon-combat.mjs tests/dungeon-combat-feat-twin-feint-execution.test.mjs
git commit -m "feat(#910): execute Twin Feint (two strikes, hand-applied Off-Guard)

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 10: Version bump

**Files:**
- Modify: `module.json`

**Interfaces:**
- Consumes: nothing.
- Produces: nothing — final housekeeping step before merge.

- [ ] **Step 1: Check the current version and bump it**

Run: `grep '"version"' module.json`

This adds a second vocabulary category plus three new execution paths on top of #909's own subsystem — per `CLAUDE.md`'s versioning rule this is a **minor** bump: `x.Y.0` → `x.Y+1.0`. Do not reuse a version number already used by a prior merge (in particular, #909's own plan will already have consumed one minor bump by the time this plan executes — confirm the real current value live rather than assuming).

- [ ] **Step 2: Verify no other file hardcodes the old version**

Run: `grep -rn "<old version string>" . --include="*.json" --include="*.mjs" --include="*.md" | grep -v node_modules | grep -v docs/superpowers`

- [ ] **Step 3: Commit**

```bash
git add module.json
git commit -m "chore(#910): bump version for feat/class-action modeling

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Self-Review

**1. Spec coverage:**
- Decision 1 (self-effect scope = stances + Rage, composite allowlist, no "all feats") — Task 3's `SELF_EFFECT_SLUGS`/stance-trait filter and Task 4's `COMPOSITE_FEAT_SLUGS`.
- Decision 2 (reuse #909's pipeline, `type: "feat"` entries) — Task 2's `buildFeatVocabulary`/`buildFeatCandidates`.
- Decision 3 (Foundry decides legality, model only chooses) — Tasks 3/4 are entirely deterministic; Task 2's `buildFeatCandidates` is the only validation gate on the model's output.
- Decision 4 (self-effect generic, composite curated allowlist) — Task 3 vs. Task 4's split, and Tasks 7/8/9's three hand-written executors.
- Decision 5 (frequency/stance from real data, never approximated) — Task 3's `frequencyValue <= 0` check and `findActiveStanceEffectId`/`replacesStance` wiring, executed in Task 6.
- Decision 6 (reactions/triggers stay out) — nothing in this plan touches reaction-type items at all; Task 3/4 both filter to `actionType !== 'passive'` and the three named composite slugs only, never reaction items.
- The Eligibility filter section's exact clauses (cost vs. remaining actions, frequency, already-active, excluded `ChoiceSet`, stance replacement) — every clause has its own dedicated Task 3 test.
- The Composite allowlist table (Sudden Charge/Lunge/Twin Feint, their costs/executors) — Tasks 7/8/9, with the real RAW text each one was built from quoted in this plan's own investigation (carried over from the design session).
- The self-effect execution sequence (origin-context merge, frequency decrement, stance deletion) — Task 6, built directly from the installed system's own `#onClickApplyEffect` handler.
- Error handling section (no-op on vanished item/target/UUID, dropped mismatched picks) — a dedicated test in Tasks 3, 6, 7, 8, and 9 each.
- Testing section (pure vocabulary/candidate tests, mocked-execution tests per kind) — Tasks 2–9 each supply exactly this.

**2. Placeholder scan:** No "TBD"/"TODO"/"add appropriate X" anywhere. Tasks 5, 6, 7, and 8 each leave their test *stub shape* to be copied from an existing test the implementer must find first (named explicitly which `grep` to run) — called out here deliberately, same as #909's own plan did for its own Tasks 6/8, for the same reason: the mechanical stub-building boilerplate is unsafe to guess without risking a stale shape, while every assertion itself is written out in full.

**3. Type consistency:** `buildFeatVocabulary`'s `{type, kind, itemId, slug, name, cost, targetId, replacesStance}` shape is produced once (Task 2) and consumed identically everywhere (Task 2's own `buildFeatCandidates`, Task 5's wiring, Task 6/7/8/9's `candidate.itemId`/`candidate.replacesStance`/`candidate.targetId` reads). `computeSelfEffectVocabularyEntries`'s `{itemId, slug, name, cost, replacesStance}` and `computeCompositeVocabularyEntries`'s `{itemId, slug, name, cost, targetId}` both match exactly what `buildFeatVocabulary` destructures from `selfEffectEntries`/`compositeEntries`. `candidate.kind` (`"selfEffect"` | `"composite"`) is the single dispatch key `applyAgentDecision`'s two new branches (Task 6, Task 7) both switch on, consistently.

**4. Review Focus:** all five items have a direct test — empty vocabulary (Task 3's "returns an empty array" cases, Task 4's "returns an empty array for an actor with none of the three composite feats", Task 5's dedicated empty-vocabulary test), already-active self-effect exclusion (Task 3's "excludes Rage when its effect is already active"), stance-replacement flagging (Task 3's "flags replacesStance" test, applied in Task 6's "deletes the old stance effect first" test), each composite feat's own real prerequisite gating (every "does not offer X without/against Y" test in Task 4), and a vocabulary-mismatched pick being dropped (Task 2's three dedicated "drops a pick..." tests).
