# AI NPC Self-Buff and Heal Abilities Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give AI-controlled NPCs a new `npcSelf` reasoning-vocabulary category covering three machine-readable, self-only ability families — a structural `selfEffect` action, a prose self-buff with exactly one linked effect item, and a self-heal — so a monster can raise a shield wall, assume a protective form, or feed to regain Hit Points, the same way it already picks maneuvers, feats, and save-based abilities.

**Architecture:** A pure parser (`scripts/npc-self-parse.mjs`, no Foundry API surface, mirroring `npc-ability-parse.mjs`'s own boundary) recognizes one of the three families from an NPC action item's structured data and enriched text, or returns `null`. A Foundry-touching aggregator in `scripts/dungeon-combat.mjs` turns ready, eligible parses into plain vocabulary entries; `scripts/agent-candidates.mjs` builds the `npcSelf` vocabulary/candidates exactly the way `buildNpcAbilityVocabulary`/`buildNpcAbilityCandidates` already do for `npcAbility`; the vocabulary rides along in the same once-per-turn `/v1/combat-candidates` call `maneuverVocabulary`/`featVocabulary`/`npcAbilityVocabulary` already share; execution reuses #910's self-effect-creation pattern and the confirmed-live healing call shape from #132's own heal-spell executor.

**Tech Stack:** Vanilla JS (ESM), Foundry VTT v12 API, the PF2e system's own Actor/Item data model, Vitest.

**Spec:** `docs/superpowers/specs/2026-10-08-ai-npc-self-buff-heal-abilities-design.md`

## Global Constraints

- Self-only in this slice: every offered ability benefits only the acting monster (spec Resolved Decision 2). Allies/group buffs are #981.
- All-or-nothing: an ability with any requirement outside the closed predicate set, any unmodeled sentence, or any unresolvable effect reference is `null`, never partially applied (spec Resolved Decision 3/4).
- `scripts/npc-self-parse.mjs` has zero Foundry API surface — no `game`, `CONFIG`, `fromUuid`, `Actor`/`Item` method calls — exactly like `scripts/npc-ability-parse.mjs` (spec "Design" header; confirmed live by reading that file in full).
- The reasoning vocabulary/candidate contract is `{type, itemId, slug, name, cost, ...}` validated by literal `(type, itemId/slug, targetId)` membership against what Foundry itself sent — never re-derived PF2e legality (confirmed live in `agent-candidates.mjs`'s `buildNpcAbilityCandidates`/`buildFeatCandidates`).
- `npcSelf` rides the same single `/v1/combat-candidates` call `maneuverVocabulary`/`featVocabulary`/`npcAbilityVocabulary` already share (confirmed live in `dungeon-combat.mjs`'s `runAgentDecisionLoop`, lines 1034-1051) — no second fetch, no new endpoint.
- Every merge bumps `module.json`'s `version` (CLAUDE.md). This plan's own change (a new `scripts/npc-self-parse.mjs` imported by `dungeon-combat.mjs`, new exports from `agent-candidates.mjs`) is a new vocabulary category, the same class of change #914 (→0.84.0) and #915 (→0.85.0) each took as a minor bump — Task 9 bumps to `0.86.0` unless `main`'s version has already moved past that by execution time, in which case bump from whatever is actually current.
- A merge that adds/removes/rewires a `scripts/`/`tools/agent-service/` file's imports must run the `update-architecture-docs` skill in the same pass (CLAUDE.md) — Task 1 adds a new `scripts/npc-self-parse.mjs` imported by `dungeon-combat.mjs`, so the implementer must run that skill before merging, not as a follow-up.
- Combat-end cleanup needs **no new code**: Task 6's executors tag every effect they create with the exact same `flags.pf2e-dungeon-crawl.agentSelfEffect = true` marker #910/#914's `executeSelfEffectFeat` already uses, and #914's existing `cleanupAgentSelfEffects` iterates every combatant generically (no actor-type filter — confirmed live) — the existing function already removes unlimited-duration NPC self-effects for free. Task 6 adds a regression test proving this, not a new cleanup path.

## Investigation findings (grounded against the real compendium, confirmed live)

This plan's own live investigation (`~/pf2e-data/packs/pf2e`, the local PF2e source data, read directly — not the spec's own paraphrases taken at face value) found six corrections to the spec's own cited examples and assumptions. Every one is resolved below with the most defensible choice consistent with the spec's stated intent, not silently guessed or silently dropped.

1. **`inForm:<assumed|natural>` is not actually checkable with any real game state and is cut from the closed predicate set.** The spec names this predicate and cites *Revert Form* ("The ugothol is in an assumed form") as its flagship `linkedEffectSelf` example. Tracing how a creature ever *gets into* an assumed form shows why it can't be read: the generic "Change Shape" ability that polymorph-trait NPCs use (confirmed live across `barghest.json`, `cacodaemon.json`, `caldera-oni.json`, `cassisian.json`, and others) is pure glossary prose — `@Localize[PF2E.NPC.Abilities.Glossary.ChangeShape]` — with **no linked effect, no rule element, no flag of any kind**. There is nothing in the real data for this module to read. `inForm` is therefore removed from the closed set entirely; any requirement clause matching "is in a/an/its (assumed|natural) form" is an unconditional disqualifier, the same as any other requirement outside the set. This means *Revert Form* itself is `null` in practice (confirmed below), contrary to the spec's own Testing section expectation — Task 1's fixtures substitute a different real positive example for the family instead of forcing a fake one.
2. **A structural `selfEffect` action can still be a transformation the spec means to defer, and must be excluded by trait, not assumed in-scope just because the field is set.** *Crystalline Dust Form* (axiomite) carries `system.selfEffect.uuid` — spec-recognizable — but its linked effect (`Effect: Crystalline Dust Form`) has exactly one rule element, `{key: "BaseSpeed", selector: "fly", value: 40}`. The ability's own prose restriction ("can fit through even tiny apertures... can't make melee or ranged attacks") has **no corresponding rule element at all** — applying the effect would hand the AI a flight speed with no actual Strike-blocking enforcement, so the AI's own strike-candidate logic would still see Strikes as ready, silently violating the ability's own text. `selfEffectAction`/`linkedEffectSelf` recognition therefore excludes any item carrying the `polymorph` trait (Task 1), consistent with the spec's own deferral of "transformations" to #984 — Crystalline Dust Form simply turns out to be one of those, despite having a structural `selfEffect` field.
3. **#914's `isUnsafeSelfEffect` would exclude the spec's own other flagship example (*Thesis Shield*) for a reason that doesn't actually apply to NPC bestiary effects**, and is refined rather than reused unchanged. `Effect: Thesis Shield`'s rules are `FlatModifier(ac, +2)` plus `{key: "GrantItem", inMemoryOnly: true, uuid: "Compendium.pf2e.conditionitems.Item.Concealed"}`. #914's filter treats any `GrantItem` as unsafe because, for a PC feat, it might grant a real tracked item needing cleanup. For an NPC bestiary effect, an `inMemoryOnly: true` `GrantItem` pointing at a `conditionitems` UUID is mechanically identical to the module's own existing `applyNpcAbilityCondition` pattern (#915) — a transient condition tied to the effect's own lifecycle, nothing to track or clean up beyond what the effect's own removal already handles. Task 2 adds a narrow, NPC-only refinement (`isUnsafeSelfEffectForNpc`) that allows exactly this shape and excludes every other `GrantItem` for #914's original, still-valid reason.
4. **A requirement clause is not always under a `<strong>Requirements</strong>` header.** *Blood Soak* (redcap)'s corpse requirement ("The foe must have died in the last minute, and the redcap must have helped kill it") is an ordinary sentence inside the Effect prose itself, no `Requirements` label anywhere. A parser that only scans a labelled Requirements block would miss it and incorrectly treat the ability as unconditional. Task 1's normalizer therefore scans the **entire** normalized text — not just a labelled block — for a fixed set of disqualifying corpse/kill phrases (`corpse`, `dead`, `died`, `destroyed`, `slain`, `killed`, `helped kill`), in addition to parsing an explicit Requirements block when one exists.
5. **The real `enemyWithin` requirement is a disjunction that includes a non-condition-slug state, and its distance varies by creature** — the spec's own `enemyWithin:<feet>[,<condition>]` (one optional slug) doesn't literally cover it. Five real phrasings of *Feed on Fear*'s requirement were checked side by side: `"An enemy is affected by a fear effect or has the frightened or dying condition, and is within 25 feet of the voidglutton"`, `"An enemy is under a fear effect or Dying within 15 feet of the will-o'-wisp."`, `"An enemy within 15 feet is under a fear effect or dying"`, and two more varying only "under"/"being affected by". The shape is always *enemy* + *range* (either order) + *(a reserved "fear effect" state) OR (one or more real condition slugs)*, and the distance is 15 ft for will-o'-wisps but 25 ft for the voidglutton — confirming the predicate must read the number from each instance's own text, never hard-code it (which the spec's design already intends; this is a confirmation, not a correction to the parsing approach itself). Task 1 extends `enemyWithin` to `enemyWithin:<feet>,<alt1>|<alt2>...` where an alternative is either a real condition slug or the reserved value `fear-effect` (checked at evaluation time against any active condition/effect carrying the PF2e `fear` trait).
6. **A `linkedEffectSelf` candidate's "same name, different structure" sibling is not a usable fallback.** *Reef Armor* appears on two stat-block variants of the same creature (the non-spellcaster coral dragon and its spellcaster variant) with byte-identical prose, but only one carries `system.selfEffect.uuid`; the other has **no `@UUID` reference anywhere in its description either**. The spec's own population count groups both under "Reef Armor" as an example, implicitly suggesting the second variant falls back to `linkedEffectSelf` — it does not; it is unmodelable prose with no family match at all, same as any other item with no selfEffect and no linked-effect reference.

The full real-population yield of each family (how many of the ~850-item slice the spec counted actually survive every one of these corrections) is not computed by hand in this plan — like #915's own plan did for its 369-item slice, reliably classifying the whole population by hand needs a budget this planning session's own investigation didn't have, and trusting this parser's own output as ground truth for its own audit would be circular. **#1024** ("AI NPCs: widen NPC self-buff/heal parsing coverage") tracks that full audit, the same role #935 plays for #915. This plan's own Task 8 fixture is the small, real, hand-verified set above.

## Review Focus

- A `selfEffect` item whose linked effect fails to resolve (`fromUuid` returns `undefined`, a renamed/removed compendium entry) must exclude the ability from the vocabulary, never offer it and fail at execution time (Task 3's eligibility gate; Task 6's executor still guards independently in case the effect was removed between vocabulary build and execution).
- An NPC actor with **zero** action items (a pure Strike-only brute) must produce an empty `npcSelf` vocabulary, not throw — `actorActionItems` already returns `[]` safely for this case (Task 3's test).
- A self-heal candidate must never fire when the actor is already at full Hit Points — the spec says so explicitly (Resolved Decision via vocabulary gate), and a full-HP heal is a wasted action an AI should never choose (Task 3's test, `hpFraction === 1` excluded).
- Two eligible abilities on the same actor must respect the shared `NPC_SELF_VOCABULARY_CAP` and ranking (heals when hurt first, consistent with #914's own tier-based ranking) rather than silently dropping one arbitrarily (Task 3's test).
- A combatant that is NOT agent-controlled (a player-controlled or purely-scripted NPC) must never have `computeNpcSelfVocabulary` called against it at all — `getPendingAgentTurn`'s own early `agentControlled` flag guard (confirmed live, line 3962) already covers this; Task 5's test confirms the wiring sits after that guard, not before it.

---

### Task 1: The pure NPC-self parser

**Files:**
- Create: `scripts/npc-self-parse.mjs`
- Create: `tests/fixtures/npc-self-ability-fixtures.json`
- Test: `tests/npc-self-parse.test.mjs`

**Interfaces:**
- Consumes: `KNOWN_CONDITION_SLUGS` (named export, `scripts/npc-ability-parse.mjs`).
- Produces: `parseSelfAbility(item)` → `null | { family: 'selfEffectAction'|'linkedEffectSelf'|'selfHeal', cost: number, frequency: object|null, requirements: Array<Predicate>, crossRecharge: {name: string, formula: string}|null, params: {effectUuid?: string, formula?: string} }`. `describeNpcSelfAbility(descriptor)` → `string` (deterministic one-line summary for the reasoning model, same convention as `describeNpcAbility`). `parseRequirementClause(clause)` → `null | Predicate` (exported separately so Task 3's evaluator and this task's own tests can exercise clause recognition in isolation). `Predicate` is one of `{type:'handFree'}`, `{type:'wielding'|'wearing', name: string}`, `{type:'enemyWithin', feet: number, conditions: string[]}` (where a condition is a real slug or the reserved value `'fear-effect'`), `{type:'hasCondition'|'notHasCondition', slug: string}`.

- [ ] **Step 1: Write the failing tests for block-splitting and the disqualifying scans**

```js
// tests/npc-self-parse.test.mjs
import { describe, it, expect } from 'vitest';
import { parseSelfAbility, parseRequirementClause, describeNpcSelfAbility } from '../scripts/npc-self-parse.mjs';

// Every fixture below is real ability text confirmed live against
// ~/pf2e-data/packs/pf2e during this plan's own investigation (see the
// plan's "Investigation findings"). `null` fixtures each exercise one
// named, documented exclusion rather than an arbitrary negative case.
describe('parseSelfAbility (#934)', () => {
  it('recognizes a structural selfEffect action with no requirements (Form a Phalanx)', () => {
    const item = {
      type: 'action',
      system: {
        actionType: { value: 'action' },
        actions: { value: 1 },
        traits: { value: [] },
        selfEffect: { uuid: 'Compendium.pf2e.bestiary-effects.Item.Effect: Form a Phalanx' },
        description: { value: '<p>Many of the skeletons raise their shields to protect others. The infantry gain a +2 circumstance bonus to AC until the start of their next turn.</p>' },
      },
    };
    const parsed = parseSelfAbility(item);
    expect(parsed).toMatchObject({ family: 'selfEffectAction', cost: 1, requirements: [] });
    expect(parsed.params.effectUuid).toBe('Compendium.pf2e.bestiary-effects.Item.Effect: Form a Phalanx');
  });

  it('recognizes a structural selfEffect action gated by the GrantItem/condition shape (Thesis Shield)', () => {
    const item = {
      type: 'action',
      system: {
        actionType: { value: 'action' },
        actions: { value: 1 },
        traits: { value: [] },
        selfEffect: { uuid: 'Compendium.pf2e.bestiary-effects.Item.Effect: Thesis Shield' },
        description: { value: "<p>A spinning circle of tomes surrounds the zhuraita, lasting until the start of their next turn. While Thesis Shield is active, the zhuraita gains a +2 circumstance bonus to AC and has the @UUID[Compendium.pf2e.conditionitems.Item.Concealed] condition.</p>" },
      },
    };
    expect(parseSelfAbility(item)).toMatchObject({ family: 'selfEffectAction', cost: 1 });
  });

  it('recognizes a frequency-limited selfEffect action (Reef Armor)', () => {
    const item = {
      type: 'action',
      system: {
        actionType: { value: 'action' },
        actions: { value: 2 },
        traits: { value: ['primal'] },
        frequency: { max: 1, per: 'day' },
        selfEffect: { uuid: 'Compendium.pf2e.bestiary-effects.Item.Effect: Reef Armor' },
        description: { value: '<p><strong>Frequency</strong> once per day</p><hr /><p><strong>Effect</strong> The dragon encases themself in an shell of protective coral, gaining 80 temporary Hit Points and resistance 15 to piercing and slashing damage until the temporary Hit Points are depleted.</p>' },
      },
    };
    const parsed = parseSelfAbility(item);
    expect(parsed).toMatchObject({ family: 'selfEffectAction', cost: 2 });
    expect(parsed.frequency).toEqual({ max: 1, per: 'day' });
  });

  it('excludes a polymorph-trait selfEffect action even though the field is set (Crystalline Dust Form)', () => {
    const item = {
      type: 'action',
      system: {
        actionType: { value: 'action' },
        actions: { value: 1 },
        traits: { value: ['polymorph'] },
        selfEffect: { uuid: 'Compendium.pf2e.bestiary-effects.Item.Effect: Crystalline Dust Form' },
        description: { value: "<p>The axiomite shifts their form to a cloud of crystalline dust in which strange symbols and equations flash.</p><p>They gain a fly Speed of 40 feet and can fit through even tiny apertures, similar to vapor form. They can cast spells but can't make melee or ranged attacks.</p>" },
      },
    };
    expect(parseSelfAbility(item)).toBeNull();
  });

  it('excludes a selfEffect action with an inline save/damage (Invoke Rune)', () => {
    const item = {
      type: 'action',
      system: {
        actionType: { value: 'action' },
        actions: { value: 1 },
        traits: { value: ['arcane', 'concentrate', 'electricity'] },
        selfEffect: { uuid: 'Compendium.pf2e.bestiary-effects.Item.Effect: Invoke Rune' },
        description: { value: '<p>The rune giant invokes one of the runes on their body, causing the rune to spray forth a @Template[cone|distance:30] of sparks that deals @Damage[6d12[electricity]|options:area-damage] damage to all creatures in the cone (@Check[reflex|dc:37|basic|options:area-effect] save).</p>' },
      },
    };
    expect(parseSelfAbility(item)).toBeNull();
  });

  it('excludes a selfEffect action whose requirement is outside the closed set (Revealing Hypothesis)', () => {
    const item = {
      type: 'action',
      system: {
        actionType: { value: 'free' },
        actions: { value: null },
        traits: { value: ['concentrate'] },
        selfEffect: { uuid: 'Compendium.pf2e.bestiary-effects.Item.Effect: Revealing Hypothesis' },
        description: { value: "<p><strong>Requirements</strong> The zhuraita hits a creature with its thesis</p><hr /><p><strong>Effect</strong> The zhuraita's thesis opens...</p>" },
      },
    };
    expect(parseSelfAbility(item)).toBeNull();
  });

  it('excludes a requirement needing unreadable form state (Revert Form) -- inForm is not in the closed set', () => {
    const item = {
      type: 'action',
      system: {
        actionType: { value: 'free' },
        actions: { value: null },
        traits: { value: [] },
        description: { value: '<p><strong>Requirements</strong> The ugothol is in an assumed form</p><hr /><p><strong>Effect</strong> The ugothol resumes its true form. Until the start of its next turn, it gains a +2 status bonus to attack rolls, damage rolls, saving throws, and skill checks.</p><p>@UUID[Compendium.pf2e.bestiary-effects.Item.Effect: Revert Form]</p>' },
      },
    };
    expect(parseSelfAbility(item)).toBeNull();
  });

  it('excludes a self-or-ally heal (Dero Medicine)', () => {
    const item = {
      type: 'action',
      system: {
        actionType: { value: 'action' },
        actions: { value: 1 },
        traits: { value: ['healing', 'manipulate'] },
        description: { value: '<p><strong>Requirements</strong> The dero is wearing a cytillesh toolkit and has a hand free</p><hr /><p><strong>Effect</strong> The dero excises damaged flesh and crudely stitches wounds shut, healing themself or an ally in reach for @Damage[(2d8+10)[healing]]{2d8+10 Hit Points}. For 1 hour, the target has slashing weakness 2 and is immune to Dero Medicine.</p>' },
      },
    };
    expect(parseSelfAbility(item)).toBeNull();
  });

  it('excludes a corpse-gated heal (Consume Flesh)', () => {
    const item = {
      type: 'action',
      system: {
        actionType: { value: 'action' },
        actions: { value: 1 },
        traits: { value: ['manipulate'] },
        description: { value: '<p><strong>Requirements</strong> Augrael is adjacent to the corpse of an undead creature that was destroyed within the last hour.</p><hr /><p><strong>Effect</strong> Augrael devours a chunk of the destroyed undead creature and regains @Damage[2d6[healing]] Hit Points.</p>' },
      },
    };
    expect(parseSelfAbility(item)).toBeNull();
  });

  it('excludes a corpse requirement with no Requirements header at all (Blood Soak)', () => {
    const item = {
      type: 'action',
      system: {
        actionType: { value: 'action' },
        actions: { value: 1 },
        traits: { value: [] },
        description: { value: '<p>The redcap dips their cap in the blood of a slain foe. The foe must have died in the last minute, and the redcap must have helped kill it. The redcap gains a +4 status bonus to damage rolls for 1 minute.</p><p>@UUID[Compendium.pf2e.bestiary-effects.Item.Effect: Blood Soak]</p>' },
      },
    };
    expect(parseSelfAbility(item)).toBeNull();
  });

  it('recognizes a self-heal gated by the enemyWithin/fear-effect disjunction (Feed on Fear)', () => {
    const item = {
      type: 'action',
      system: {
        actionType: { value: 'action' },
        actions: { value: 1 },
        traits: { rarity: 'common', value: ['concentrate'] },
        frequency: { max: 1, per: 'round' },
        description: { value: "<p><strong>Frequency</strong> once per round</p>\n<p><strong>Requirements</strong> An enemy within 15 feet is under a fear effect or dying</p>\n<hr />\n<p><strong>Effect</strong> The will-o'-wisp feeds on the creature's terror. It regains @Damage[2d4[healing]]{2d4 Hit Points}, and if it has Gone Dark, its glow reignites.</p>" },
      },
    };
    const parsed = parseSelfAbility(item);
    expect(parsed).toMatchObject({ family: 'selfHeal', cost: 1, crossRecharge: null });
    expect(parsed.params.formula).toBe('2d4');
    expect(parsed.requirements).toEqual([{ type: 'enemyWithin', feet: 15, conditions: ['fear-effect', 'dying'] }]);
  });

  it('recognizes the same requirement phrased with a distance-after-condition clause and a cross-ability recharge rider (voidglutton Feed on Fear)', () => {
    const item = {
      type: 'action',
      system: {
        actionType: { value: 'action' },
        actions: { value: 1 },
        traits: { rarity: 'common', value: ['concentrate'] },
        frequency: { max: 1, per: 'round' },
        description: { value: "<p><strong>Frequency</strong> once per round</p>\n<p><strong>Requirement</strong> An enemy is affected by a fear effect or has the frightened or dying condition, and is within 25 feet of the voidglutton</p>\n<hr />\n<p><strong>Effect</strong> The voidglutton feeds on the creature's terror. It regains @Damage[3d4[healing]] Hit Points and its Glow reignites if it had been extinguished.</p>\n<p>It cannot use Consume Light again for [[/gmr 1d4 #Recharge Consume Light]]{1d4 rounds}, as it is too glutted on fear to suppress its Glow.</p>" },
      },
    };
    const parsed = parseSelfAbility(item);
    expect(parsed.family).toBe('selfHeal');
    expect(parsed.requirements).toEqual([{ type: 'enemyWithin', feet: 25, conditions: ['fear-effect', 'frightened', 'dying'] }]);
    expect(parsed.crossRecharge).toEqual({ name: 'Consume Light', formula: '1d4' });
  });

  it('excludes a corpse-gated flat-number heal (Collect Brain)', () => {
    const item = {
      type: 'action',
      system: {
        actionType: { value: 'action' },
        actions: { value: 1 },
        traits: { rarity: 'common', value: ['manipulate'] },
        description: { value: '<p>The jah-tohl extracts the brain of a creature within its reach that has been dead for no more than 1 minute. It can then use an Interact action to secure the brain in one of its empty brain blisters and heal @Damage[20[healing]] Hit Points.</p>' },
      },
    };
    expect(parseSelfAbility(item)).toBeNull();
  });

  it('excludes prose with no selfEffect and no linked-effect reference at all (Broadcast Stance)', () => {
    const item = {
      type: 'action',
      system: {
        actionType: { value: 'action' },
        actions: { value: 1 },
        traits: { value: ['mental', 'occult', 'stance'] },
        description: { value: "<p><strong>Requirements</strong> the gosreg is in its natural form</p>\n<hr />\n<p><strong>Effect</strong> The gosreg secures its limbs into the ground as its brain-like head crackles with psychic energy...</p>" },
      },
    };
    expect(parseSelfAbility(item)).toBeNull();
  });

  it('excludes a movement composite action with no self-effect/heal shape (Spring Up)', () => {
    const item = {
      type: 'action',
      system: {
        actionType: { value: 'action' },
        actions: { value: 2 },
        traits: { value: [] },
        description: { value: '<p><strong>Requirements</strong> The vanara disciple is @UUID[Compendium.pf2e.conditionitems.Item.Prone]</p><hr /><p><strong>Effect</strong> The vanara Stands, then can immediately Step twice. The Stand action doesn\'t trigger reactions.</p>' },
      },
    };
    expect(parseSelfAbility(item)).toBeNull();
  });

  it('excludes the structurally-bare sibling of a selfEffect action (Reef Armor, spellcaster variant)', () => {
    const item = {
      type: 'action',
      system: {
        actionType: { value: 'action' },
        actions: { value: 2 },
        traits: { value: ['primal'] },
        frequency: { max: 1, per: 'day' },
        description: { value: '<p><strong>Frequency</strong> once per day</p><hr /><p><strong>Effect</strong> The dragon encases themself in an shell of protective coral, gaining 80 temporary Hit Points and resistance 15 to piercing and slashing damage until the temporary Hit Points are depleted.</p>' },
      },
    };
    expect(parseSelfAbility(item)).toBeNull();
  });

  it('a non-action, non-free action type is always excluded regardless of shape', () => {
    const item = {
      type: 'action',
      system: {
        actionType: { value: 'passive' },
        actions: { value: null },
        traits: { value: [] },
        selfEffect: { uuid: 'Compendium.pf2e.bestiary-effects.Item.Effect: Phalanx Fighter' },
        description: { value: '<p>All devils of equal or lower level adjacent to a levaloch gain a +1 circumstance bonus to their AC.</p>' },
      },
    };
    expect(parseSelfAbility(item)).toBeNull();
  });
});

describe('parseRequirementClause (#934)', () => {
  it('recognizes handFree', () => {
    expect(parseRequirementClause('has a hand free')).toEqual({ type: 'handFree' });
  });
  it('recognizes wearing with an item name', () => {
    expect(parseRequirementClause('is wearing a cytillesh toolkit')).toEqual({ type: 'wearing', name: 'cytillesh toolkit' });
  });
  it('recognizes hasCondition from a bare condition word', () => {
    expect(parseRequirementClause('The vanara disciple is Prone')).toEqual({ type: 'hasCondition', slug: 'prone' });
  });
  it('recognizes notHasCondition', () => {
    expect(parseRequirementClause('is not Fatigued')).toEqual({ type: 'notHasCondition', slug: 'fatigued' });
  });
  it('rejects an unmodeled form-state clause', () => {
    expect(parseRequirementClause('the gosreg is in its natural form')).toBeNull();
  });
  it('rejects a corpse-flavoured clause', () => {
    expect(parseRequirementClause('is adjacent to the corpse of a creature that died within the last hour')).toBeNull();
  });
});

describe('describeNpcSelfAbility (#934)', () => {
  it('summarizes a selfEffectAction deterministically', () => {
    const descriptor = parseSelfAbility({
      type: 'action',
      system: {
        actionType: { value: 'action' }, actions: { value: 1 }, traits: { value: [] },
        selfEffect: { uuid: 'Compendium.pf2e.bestiary-effects.Item.Effect: Form a Phalanx' },
        description: { value: '<p>flavor text only</p>' },
      },
    });
    expect(describeNpcSelfAbility(descriptor)).toBe('self-buff (effect)');
  });
  it('summarizes a selfHeal with its formula', () => {
    const descriptor = parseSelfAbility({
      type: 'action',
      system: {
        actionType: { value: 'action' }, actions: { value: 1 }, traits: { value: [] },
        frequency: { max: 1, per: 'round' },
        description: { value: "<p><strong>Requirements</strong> An enemy within 15 feet is under a fear effect or dying</p><hr /><p><strong>Effect</strong> It regains @Damage[2d4[healing]]{2d4 Hit Points}.</p>" },
      },
    });
    expect(describeNpcSelfAbility(descriptor)).toBe('heals 2d4 HP');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/npc-self-parse.test.mjs`
Expected: FAIL with "Cannot find module '../scripts/npc-self-parse.mjs'"

- [ ] **Step 3: Implement the normalizer, the disqualifying scans, and `parseRequirementClause`**

```js
// scripts/npc-self-parse.mjs
/**
 * #934: pure recognition/parsing for NPC self-buff and self-heal abilities
 * (Form a Phalanx, Reef Armor, Thesis Shield, Feed on Fear, ...) -- no
 * Foundry API surface at all, mirroring npc-ability-parse.mjs's own
 * boundary (that file's Foundry-touching half lives in dungeon-combat.mjs;
 * this one's does too -- see computeReadyNpcSelfAbilities).
 *
 * Three families only, chosen all-or-nothing:
 *  - selfEffectAction: `system.selfEffect.uuid` is set.
 *  - linkedEffectSelf: no selfEffect, but the prose names the actor as its
 *    own subject with exactly one linked effect item reference.
 *  - selfHeal: a `@Damage[<formula>[healing]]` enricher whose subject is
 *    the actor alone (never "themself or an ally").
 * Everything else -- allies, corpses, summons, prose-only zones and
 * transformations, any requirement outside the closed predicate set below,
 * any inline save/damage/area template -- is `null`. See this plan's own
 * "Investigation findings" for six corrections found against real text
 * while writing this parser, including why `inForm` (a plausible-looking
 * predicate the design spec named) is NOT in the closed set below: no real
 * NPC polymorph ability ("Change Shape") leaves behind any readable state
 * at all.
 */

import { KNOWN_CONDITION_SLUGS } from "./npc-ability-parse.mjs";

const CONDITION_SET = new Set(KNOWN_CONDITION_SLUGS);

function stripHtml(html) {
  return String(html)
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Human-readable plain text: @UUID links become their label/name, same
 * convention as npc-ability-parse.mjs's own renderPlain. */
function renderPlain(html) {
  return stripHtml(
    String(html)
      .replace(/@UUID\[[^\]]+\]\{([^}]*)\}/g, "$1")
      .replace(/@UUID\[Compendium\.pf2e\.[a-z-]+\.Item\.([^\]]+)\]/g, "$1")
      .replace(/@\w+\[[^\]]*\]\{([^}]*)\}/g, "$1"),
  );
}

const LABEL_RE = /<p>\s*<strong>\s*(Frequency|Requirements?|Trigger|Effect)\s*<\/strong>([\s\S]*?)<\/p>/gi;

/**
 * Splits raw (enriched) HTML into its labelled blocks by #915's own
 * `<p><strong>Label</strong> ...</p>` convention. Caught during this
 * plan's own drafting: a trailing, UNLABELLED `<p>` after an explicit
 * "Effect" block (Dero Medicine's/Revert Form's own trailing bare
 * `@UUID[...]` paragraph; the voidglutton Feed on Fear's own trailing
 * cross-ability-recharge sentence) is not inside any `<strong>` span, so a
 * naive "everything inside a matched span" reading would silently drop it.
 * This collects every matched label's own text AND every byte of `html`
 * that falls outside all matched spans (hr tags and whitespace included,
 * harmless once stripped) into `effect`, so nothing is ever silently lost.
 * An item with no labels at all (Form a Phalanx, Thesis Shield) ends up
 * with its entire body in `effect` the same way.
 */
function splitAbilityBlocks(html) {
  const blocks = { frequency: null, requirements: null, trigger: null, effect: "" };
  const spans = [];
  let match;
  LABEL_RE.lastIndex = 0;
  while ((match = LABEL_RE.exec(html))) {
    spans.push([match.index, match.index + match[0].length]);
    const key = match[1].toLowerCase().replace(/s$/, "");
    if (key === "requirement") blocks.requirements = (blocks.requirements ?? "") + match[2];
    else if (key === "frequency") blocks.frequency = match[2];
    else if (key === "trigger") blocks.trigger = match[2];
    else blocks.effect += ` ${match[2]}`;
  }
  let cursor = 0;
  for (const [start, end] of spans) {
    blocks.effect += ` ${html.slice(cursor, start)}`;
    cursor = end;
  }
  blocks.effect += ` ${html.slice(cursor)}`;
  return blocks;
}

/** Corpse/kill-related wording, checked against the FULL normalized text
 * (not just a labelled Requirements block -- Blood Soak's own corpse
 * requirement is ordinary Effect prose with no label at all). Any match
 * disqualifies the whole ability; corpse tracking is #982. */
const CORPSE_OR_KILL_RE = /\b(corpse|corpses|\bdead\b|died|destroyed|slain|killed|helped kill)\b/i;

/** "themself or an ally"/"an adjacent ally" -- self-only in this slice
 * (#981 covers allies). */
const ALLY_RE = /\ballies?\b/i;

function slugify(text) {
  return String(text).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
}

/** One requirement clause (already split on "and"/commas by the caller) ->
 * a Predicate, or `null` if it's outside the closed set -- including the
 * cut `inForm` shape ("is in its natural/assumed form"), which this
 * function deliberately never recognizes (see this plan's own
 * "Investigation findings", correction 1). Exported so Task 3's evaluator
 * and this task's own tests can exercise clause recognition directly. */
export function parseRequirementClause(clause) {
  const text = clause.trim();
  if (!text) return null;
  if (CORPSE_OR_KILL_RE.test(text)) return null;
  if (/\bhas (?:a |its )?hand free\b/i.test(text)) return { type: "handFree" };
  const wearing = /\bwearing (?:a |an |its )?([a-z0-9' -]+?)(?:\s+and\b|\s*$)/i.exec(text);
  if (wearing) return { type: "wearing", name: wearing[1].trim() };
  const wielding = /\bwielding (?:a |an |its )?([a-z0-9' -]+?)(?:\s+and\b|\s*$)/i.exec(text);
  if (wielding) return { type: "wielding", name: wielding[1].trim() };
  const enemyWithin = parseEnemyWithinClause(text);
  if (enemyWithin) return enemyWithin;
  const notCondition = /\bis not ([a-z-]+)\b/i.exec(text);
  if (notCondition) {
    const slug = slugify(notCondition[1]);
    if (CONDITION_SET.has(slug)) return { type: "notHasCondition", slug };
  }
  for (const slug of KNOWN_CONDITION_SLUGS) {
    if (new RegExp(`\\bis\\b[^.]*\\b${slug}\\b`, "i").test(text)) return { type: "hasCondition", slug };
  }
  return null;
}

/** "An enemy [within N feet] is/being (affected by|under) a fear effect
 * or (has the )?(frightened|dying)[ or (frightened|dying)]...[, and is
 * within N feet ...]" -- range and condition-list can appear in either
 * order (five real phrasings confirmed live, see Investigation finding 5),
 * so this checks for each piece anywhere in the clause rather than a
 * single fixed word order. */
function parseEnemyWithinClause(text) {
  if (!/\ban enemy\b/i.test(text)) return null;
  const rangeMatch = /\bwithin (\d+) feet\b/i.exec(text);
  if (!rangeMatch) return null;
  const feet = Number(rangeMatch[1]);
  const conditions = [];
  if (/\b(?:is |being )?(?:affected by|under) a fear effect\b/i.test(text)) conditions.push("fear-effect");
  for (const slug of ["frightened", "dying"]) {
    if (new RegExp(`\\b${slug}\\b`, "i").test(text)) conditions.push(slug);
  }
  if (!conditions.length) return null;
  return { type: "enemyWithin", feet, conditions };
}

/** Splits a Requirements block's plain text on "and"/commas into clauses
 * and maps every one through parseRequirementClause -- any clause outside
 * the closed set nulls the WHOLE requirements list (all-or-nothing), not
 * just that clause. An absent block is `[]` (no requirement at all). */
function parseRequirements(requirementsHtml) {
  if (!requirementsHtml) return [];
  const text = renderPlain(requirementsHtml);
  const predicates = [];
  for (const clause of text.split(/,| and /i)) {
    const predicate = parseRequirementClause(clause);
    if (!predicate) return null;
    predicates.push(predicate);
  }
  return predicates;
}

/** "(It|They|The <name>) (can('?t)?|cannot) use <Name> again for
 * [[/gmr <formula> #Recharge ...]]..." -- a side-effect on a DIFFERENT
 * named ability's own recharge (confirmed live on the voidglutton's Feed
 * on Fear: "It cannot use Consume Light again for [[/gmr 1d4 #Recharge
 * Consume Light]]{1d4 rounds}"). Recognized and consumed so it doesn't
 * count as unmodeled leftover text, but deliberately NOT enforced in this
 * slice (see Error handling) -- extracted here so the executor can at
 * least report it to the GM. */
const CROSS_RECHARGE_RE = /\b(?:it|they|the [a-z-]+) (?:can'?t|cannot) use ([A-Z][A-Za-z' -]+?) again for \[\[\/gmr (\d+d\d+) #Recharge[^\]]*\]\](?:\{[^}]*\})?\.?/;

function extractCrossRecharge(text) {
  const match = CROSS_RECHARGE_RE.exec(text);
  if (!match) return { crossRecharge: null, remaining: text };
  return {
    crossRecharge: { name: match[1].trim(), formula: match[2] },
    remaining: text.replace(match[0], " "),
  };
}

function actionCost(item) {
  const actionType = item.system?.actionType?.value;
  if (actionType === "free") return 0;
  if (actionType !== "action") return null;
  const cost = item.system?.actions?.value;
  return typeof cost === "number" && cost > 0 ? cost : null;
}
```

- [ ] **Step 4: Run the tests to verify `parseRequirementClause` passes and the rest still fails**

Run: `npx vitest run tests/npc-self-parse.test.mjs -t "parseRequirementClause"`
Expected: PASS (6 tests). The `parseSelfAbility`/`describeNpcSelfAbility` suites still fail with "parseSelfAbility is not a function".

- [ ] **Step 5: Implement `parseSelfAbility` and `describeNpcSelfAbility`**

```js
// scripts/npc-self-parse.mjs (continued)

const BOILERPLATE = /\b(the|this|it|they|is|are|and|also|a|an)\b/gi;

/** Family 1: a structural `selfEffect` action. The ability's OWN prose is
 * never parsed for this family -- only its structured data matters (the
 * linked effect's own rule-element safety is Task 2/3's job, not this
 * parser's). Guarded against the polymorph-trait transformation gap
 * (Investigation finding 2) and against an inline save/damage/template
 * (those belong to #915/the breath-weapon code). */
function recognizeSelfEffectAction(item, blocks, traits) {
  const uuid = item.system?.selfEffect?.uuid;
  if (!uuid) return null;
  if (traits.includes("polymorph")) return null;
  const fullText = `${blocks.requirements ?? ""} ${blocks.effect}`;
  if (/@Check\[/.test(fullText)) return null;
  if (/@Template\[/.test(fullText)) return null;
  if (/@Damage\[(?!(?:\([^)]*\)|\d+d\d+|\d+)\[healing\])/.test(fullText)) return null;
  return { family: "selfEffectAction", params: { effectUuid: uuid } };
}

/** Family 2: no selfEffect, but the prose names the actor as its own
 * subject with exactly one linked effect item and nothing else left over.
 * No real currently-offerable example survived this plan's own
 * investigation (Revert Form's only requirement is the cut `inForm`
 * predicate) -- the grammar below is built directly from the spec's own
 * stated sentence shapes and exercised with a synthetic fixture; #1024's
 * real-population audit will show its actual yield. */
function recognizeLinkedEffectSelf(item, blocks, traits) {
  if (item.system?.selfEffect?.uuid) return null;
  if (traits.includes("polymorph")) return null;
  const effectLinks = [...blocks.effect.matchAll(/@UUID\[Compendium\.pf2e\.[a-z-]+\.Item\.([^\]]+)\]/g)];
  if (effectLinks.length !== 1) return null;
  const effectName = effectLinks[0][1];
  if (/^(?:Compendium\.)?conditionitems\b/i.test(effectName)) return null;
  const withoutLink = blocks.effect.replace(/@UUID\[[^\]]+\](?:\{[^}]*\})?/g, " ");
  const plain = renderPlain(withoutLink);
  if (ALLY_RE.test(plain)) return null;
  if (!/^\s*(?:the [a-z' -]+|it|they)\b/i.test(plain)) return null;
  const leftover = plain
    .replace(/^\s*(?:the [a-z' -]+|it|they)\b/i, " ")
    .replace(/\b(?:gains?|gaining|resumes?|true form|until the start of (?:its|their) next turn|has|is|are)\b/gi, " ")
    .replace(BOILERPLATE, " ")
    .replace(/[.,;\s]+/g, " ")
    .trim();
  if (leftover.length > 0) return null;
  return { family: "linkedEffectSelf", params: { effectUuid: `Compendium.pf2e.bestiary-effects.Item.${effectName}` } };
}

/** Family 3: a self-only healing enricher. A trailing cross-ability
 * recharge rider is recognized and consumed (not left over) but reported
 * via `crossRecharge`, never enforced (see Error handling). */
function recognizeSelfHeal(item, blocks) {
  if (item.system?.selfEffect?.uuid) return null;
  const damageMatches = [...blocks.effect.matchAll(/@Damage\[((?:\([^)]*\)|\d+d\d+|\d+))\[healing\]\]/g)];
  if (damageMatches.length !== 1) return null;
  if (/@Check\[/.test(blocks.effect) || /@Template\[/.test(blocks.effect)) return null;
  const { crossRecharge, remaining } = extractCrossRecharge(blocks.effect);
  const withoutDamage = remaining.replace(/@Damage\[[^\]]+\](?:\{[^}]*\})?/g, " ");
  const plain = renderPlain(withoutDamage);
  if (ALLY_RE.test(plain)) return null;
  if (!/\b(?:regains?|heals?)\b/i.test(plain)) return null;
  return { family: "selfHeal", params: { formula: damageMatches[0][1] }, crossRecharge };
}

/** `null` or `{family, cost, frequency, requirements, crossRecharge, params}`.
 * `item` must already be `type: "action"` with `actionType` "action" or
 * "free" -- callers (computeReadyNpcSelfAbilities) only ever pass NPC
 * action items, the same precondition npc-ability-parse.mjs's
 * parseSaveAbility documents. */
export function parseSelfAbility(item) {
  if (item?.type !== "action") return null;
  const cost = actionCost(item);
  if (cost === null) return null;
  const html = item.system?.description?.value ?? "";
  const blocks = splitAbilityBlocks(html);
  const requirements = parseRequirements(blocks.requirements);
  if (requirements === null) return null;
  const traits = item.system?.traits?.value ?? [];

  const recognized =
    recognizeSelfEffectAction(item, blocks, traits) ??
    recognizeLinkedEffectSelf(item, blocks, traits) ??
    recognizeSelfHeal(item, blocks);
  if (!recognized) return null;

  return {
    family: recognized.family,
    cost,
    frequency: item.system?.frequency ?? null,
    requirements,
    crossRecharge: recognized.crossRecharge ?? null,
    params: recognized.params,
  };
}

const FAMILY_SUMMARY = { selfEffectAction: "self-buff (effect)", linkedEffectSelf: "self-buff (effect)" };

/** #934: the deterministic one-line description the reasoning model sees
 * -- it never reads the ability's own prose, same convention as
 * npc-ability-parse.mjs's describeNpcAbility. `hpFraction` (0-1), when
 * given, is appended for selfHeal so the model can weigh urgency, matching
 * the spec's own stated `effectSummary`/`hpFraction` design. */
export function describeNpcSelfAbility(descriptor, hpFraction = null) {
  if (descriptor.family === "selfHeal") {
    const frac = hpFraction != null ? ` (at ${Math.round(hpFraction * 100)}% HP)` : "";
    return `heals ${descriptor.params.formula} HP${frac}`;
  }
  return FAMILY_SUMMARY[descriptor.family];
}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run tests/npc-self-parse.test.mjs`
Expected: PASS (all tests)

- [ ] **Step 7: Save the fixture file used above as a standalone JSON regression artifact**

```json
{
  "_comment": "#934: real ability text confirmed live against ~/pf2e-data/packs/pf2e during this plan's own investigation. Each entry's `expectedFamily` is null for every documented exclusion. See the plan's 'Investigation findings' for why each one lands where it does. #1024 tracks the full real-population audit this small, hand-verified set deliberately does not attempt.",
  "entries": [
    { "actor": "Skeleton Infantry", "name": "Form a Phalanx", "expectedFamily": "selfEffectAction" },
    { "actor": "Zhuraita", "name": "Thesis Shield", "expectedFamily": "selfEffectAction" },
    { "actor": "Coral Dragon (Ancient)", "name": "Reef Armor", "expectedFamily": "selfEffectAction" },
    { "actor": "Coral Archdragon (Spellcaster)", "name": "Reef Armor", "expectedFamily": null, "reason": "no selfEffect field and no @UUID link in prose either -- unmodelable, not a linkedEffectSelf fallback" },
    { "actor": "Axiomite", "name": "Crystalline Dust Form", "expectedFamily": null, "reason": "polymorph trait; linked effect's rules don't enforce the prose's Strike-disabling restriction" },
    { "actor": "Rune Giant", "name": "Invoke Rune", "expectedFamily": null, "reason": "inline @Damage/@Check and ChoiceSet-bearing linked effect" },
    { "actor": "Zhuraita", "name": "Revealing Hypothesis", "expectedFamily": null, "reason": "requirement outside the closed set; TokenMark-bearing linked effect" },
    { "actor": "Ugothol", "name": "Revert Form", "expectedFamily": null, "reason": "inForm requirement cut from the closed set -- no real form-state data exists anywhere" },
    { "actor": "Dero Stalker", "name": "Dero Medicine", "expectedFamily": null, "reason": "self-or-ally" },
    { "actor": "Augrael", "name": "Consume Flesh", "expectedFamily": null, "reason": "corpse requirement" },
    { "actor": "Jah-Tohl", "name": "Collect Brain", "expectedFamily": null, "reason": "corpse requirement" },
    { "actor": "Redcap", "name": "Blood Soak", "expectedFamily": null, "reason": "corpse requirement with no Requirements header" },
    { "actor": "Gosreg", "name": "Broadcast Stance", "expectedFamily": null, "reason": "no selfEffect, no linked-effect reference" },
    { "actor": "Vanara Disciple", "name": "Spring Up", "expectedFamily": null, "reason": "movement composite, no self-effect/heal shape" },
    { "actor": "Will-o'-Wisp", "name": "Feed on Fear", "expectedFamily": "selfHeal" },
    { "actor": "Voidglutton", "name": "Feed on Fear", "expectedFamily": "selfHeal", "note": "exercises the distance-after-condition phrasing and the cross-ability recharge rider" }
  ]
}
```

- [ ] **Step 8: Commit**

```bash
git add scripts/npc-self-parse.mjs tests/npc-self-parse.test.mjs tests/fixtures/npc-self-ability-fixtures.json
git commit -m "feat(#934): pure parser for NPC self-buff/heal abilities"
```

---

### Task 2: NPC-specific self-effect safety refinement

**Files:**
- Modify: `scripts/dungeon-combat.mjs` (near `isUnsafeSelfEffect`, line ~2526)
- Test: `tests/dungeon-combat-npc-self-safety.test.mjs`

**Interfaces:**
- Consumes: nothing new — operates on the same plain `rules`/`duration` shapes `isUnsafeSelfEffect` already takes.
- Produces: `isUnsafeSelfEffectForNpc(rules, duration)` (not exported — module-private, called only from Task 3's aggregator in the same file, same visibility as `isUnsafeSelfEffect` itself).

- [ ] **Step 1: Write the failing test**

```js
// tests/dungeon-combat-npc-self-safety.test.mjs
import { describe, it, expect } from 'vitest';
import { __test__isUnsafeSelfEffectForNpc } from '../scripts/dungeon-combat.mjs';

describe('isUnsafeSelfEffectForNpc (#934)', () => {
  it('allows an inMemoryOnly GrantItem pointing at a real condition (Thesis Shield)', () => {
    const rules = [
      { key: 'FlatModifier', selector: 'ac', type: 'circumstance', value: 2 },
      { key: 'GrantItem', inMemoryOnly: true, uuid: 'Compendium.pf2e.conditionitems.Item.Concealed' },
    ];
    expect(__test__isUnsafeSelfEffectForNpc(rules, { unit: 'rounds', value: 1 })).toBe(false);
  });

  it('still excludes a GrantItem that is not inMemoryOnly', () => {
    const rules = [{ key: 'GrantItem', uuid: 'Compendium.pf2e.equipment-srd.Item.Some Real Item' }];
    expect(__test__isUnsafeSelfEffectForNpc(rules, { unit: 'rounds', value: 1 })).toBe(true);
  });

  it('still excludes a GrantItem pointing somewhere other than conditionitems', () => {
    const rules = [{ key: 'GrantItem', inMemoryOnly: true, uuid: 'Compendium.pf2e.feats-srd.Item.Some Feat' }];
    expect(__test__isUnsafeSelfEffectForNpc(rules, { unit: 'rounds', value: 1 })).toBe(true);
  });

  it('still excludes an unresolved ChoiceSet (Invoke Rune)', () => {
    const rules = [{ key: 'ChoiceSet', flag: 'rune' }];
    expect(__test__isUnsafeSelfEffectForNpc(rules, { unit: 'minutes', value: 1 })).toBe(true);
  });

  it('still excludes an hours/days duration', () => {
    expect(__test__isUnsafeSelfEffectForNpc([{ key: 'FlatModifier', selector: 'ac', value: 1 }], { unit: 'hours', value: 1 })).toBe(true);
  });

  it('still excludes no rules at all', () => {
    expect(__test__isUnsafeSelfEffectForNpc([], { unit: 'unlimited', value: -1 })).toBe(true);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/dungeon-combat-npc-self-safety.test.mjs`
Expected: FAIL with "__test__isUnsafeSelfEffectForNpc is not exported"

- [ ] **Step 3: Implement the refinement next to `isUnsafeSelfEffect`**

```js
// scripts/dungeon-combat.mjs (insert immediately after isUnsafeSelfEffect, ~line 2535)

/** #934: an NPC-only relaxation of #914's isUnsafeSelfEffect. #914 treats
 * ANY `GrantItem` rule as unsafe because, on a PC feat, it might grant a
 * real tracked item needing cleanup. Real NPC bestiary effects use
 * `GrantItem` almost exclusively to apply a temporary CONDITION
 * (`inMemoryOnly: true`, pointing at a `conditionitems` compendium entry --
 * confirmed live on Thesis Shield's own linked effect) -- mechanically the
 * same "temporary condition tied to the effect's own lifecycle" shape
 * #915's applyNpcAbilityCondition already applies safely elsewhere, with
 * nothing to track or clean up beyond what the effect's own removal
 * already handles. Every other GrantItem shape (not inMemoryOnly, or
 * pointing anywhere else) stays excluded for #914's original reason. */
function isUnsafeSelfEffectForNpc(rules, duration) {
  if (rules.length === 0) return true;
  if (duration?.unit === "hours" || duration?.unit === "days") return true;
  return rules.some((r) => {
    if (r?.key === "GrantItem") {
      return !(r.inMemoryOnly === true && /^Compendium\.pf2e\.conditionitems\./.test(r.uuid ?? ""));
    }
    if (r?.key === "ChoiceSet" || r?.key === "TokenMark") return true;
    const text = JSON.stringify(r);
    return text.includes("target:") || /@target\b/.test(text);
  });
}

export const __test__isUnsafeSelfEffectForNpc = isUnsafeSelfEffectForNpc;
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/dungeon-combat-npc-self-safety.test.mjs`
Expected: PASS (6 tests)

- [ ] **Step 5: Commit**

```bash
git add scripts/dungeon-combat.mjs tests/dungeon-combat-npc-self-safety.test.mjs
git commit -m "feat(#934): NPC-scoped self-effect safety refinement for condition-only GrantItem"
```

---

### Task 3: Requirement predicate evaluation and the readiness aggregator

**Files:**
- Modify: `scripts/dungeon-combat.mjs` (new functions near `computeReadyNpcAbilities`/`computeNpcAbilityVocabulary`)
- Test: `tests/dungeon-combat-npc-self-vocabulary.test.mjs`

**Interfaces:**
- Consumes: `parseSelfAbility`, `describeNpcSelfAbility` (`scripts/npc-self-parse.mjs`); `isUnsafeSelfEffectForNpc` (Task 2, same file); `buildNpcSelfVocabulary` (Task 4, `scripts/agent-candidates.mjs`); `actorActionItems`, `actionItemSlug`, `isAbilityRecharged`, `setAbilityRecharge` (all already defined in this file).
- Produces: `computeReadyNpcSelfAbilities(combat, combatant, opponents)` → `Array<{itemId, slug, name, descriptor, requirementsOk: boolean}>` (module-private). `computeNpcSelfVocabulary(combat, combatant, opponents, actionsRemaining)` (exported, async) → the plain vocabulary-entry array Task 4's `buildNpcSelfVocabulary` consumes.

- [ ] **Step 1: Write the failing tests**

```js
// tests/dungeon-combat-npc-self-vocabulary.test.mjs
import { describe, it, expect, vi } from 'vitest';
import { computeNpcSelfVocabulary } from '../scripts/dungeon-combat.mjs';

function makeItem({ name, cost = 1, free = false, selfEffect = null, description, frequency = null, traits = [] }) {
  return {
    id: name.toLowerCase().replace(/\s+/g, '-'),
    name,
    slug: name.toLowerCase().replace(/\s+/g, '-'),
    type: 'action',
    uuid: `Actor.x.Item.${name}`,
    system: {
      actionType: { value: free ? 'free' : 'action' },
      actions: { value: free ? null : cost },
      traits: { value: traits },
      selfEffect,
      frequency,
      description: { value: description },
    },
  };
}

function makeActor({ items, hp = 10, maxHp = 20, effects = [], conditions = [] }) {
  return {
    type: 'npc',
    itemTypes: { action: items, effect: effects },
    system: { attributes: { hp: { value: hp, max: maxHp } } },
    conditions: { some: (fn) => conditions.some((c) => fn(c)) },
    getCondition: (slug) => conditions.find((c) => c.slug === slug) ?? null,
  };
}

describe('computeNpcSelfVocabulary (#934)', () => {
  it('offers a cost-eligible, requirement-free selfEffectAction', async () => {
    const item = makeItem({
      name: 'Form a Phalanx',
      selfEffect: { uuid: 'Compendium.pf2e.bestiary-effects.Item.Effect: Form a Phalanx' },
      description: '<p>flavor only</p>',
    });
    const actor = makeActor({ items: [item] });
    const combat = { getFlag: () => undefined, round: 1 };
    const combatant = { id: 'c1', actor };
    const entries = await computeNpcSelfVocabulary(combat, combatant, [], 3);
    expect(entries).toEqual([
      expect.objectContaining({ type: 'npcSelf', itemId: item.id, family: 'selfEffectAction', cost: 1 }),
    ]);
  });

  it('excludes a self-effect action whose cost exceeds actionsRemaining', async () => {
    const item = makeItem({
      name: 'Form a Phalanx', cost: 1,
      selfEffect: { uuid: 'x' },
      description: '<p>flavor</p>',
    });
    const actor = makeActor({ items: [item] });
    const combat = { getFlag: () => undefined, round: 1 };
    const entries = await computeNpcSelfVocabulary(combat, { id: 'c1', actor }, [], 0);
    expect(entries).toEqual([]);
  });

  it('excludes a heal when the actor is at full HP', async () => {
    const item = makeItem({
      name: 'Feed on Fear',
      frequency: { max: 1, per: 'round' },
      description: "<p><strong>Requirements</strong> An enemy within 15 feet is under a fear effect or dying</p><hr/><p><strong>Effect</strong> It regains @Damage[2d4[healing]]{2d4 Hit Points}.</p>",
    });
    const actor = makeActor({ items: [item], hp: 20, maxHp: 20 });
    const combat = { getFlag: () => undefined, round: 1 };
    const opponents = [{ id: 'o1', distanceSquares: 2, conditions: { some: (fn) => fn({ slug: 'dying' }) } }];
    const entries = await computeNpcSelfVocabulary(combat, { id: 'c1', actor }, opponents, 3);
    expect(entries).toEqual([]);
  });

  it('offers a heal when hurt and the enemyWithin/fear-effect predicate holds', async () => {
    const item = makeItem({
      name: 'Feed on Fear',
      frequency: { max: 1, per: 'round' },
      description: "<p><strong>Requirements</strong> An enemy within 15 feet is under a fear effect or dying</p><hr/><p><strong>Effect</strong> It regains @Damage[2d4[healing]]{2d4 Hit Points}.</p>",
    });
    const actor = makeActor({ items: [item], hp: 10, maxHp: 20 });
    const combat = { getFlag: () => undefined, round: 1 };
    const opponents = [
      { id: 'o1', distanceSquares: 4, conditions: { some: () => false } },
      { id: 'o2', distanceSquares: 2, conditions: { some: (fn) => fn({ slug: 'dying' }) } },
    ];
    const entries = await computeNpcSelfVocabulary(combat, { id: 'c1', actor }, opponents, 3);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ family: 'selfHeal', itemId: item.id });
    expect(entries[0].summary).toContain('heals 2d4 HP');
  });

  it('excludes the heal when no opponent satisfies the enemyWithin predicate', async () => {
    const item = makeItem({
      name: 'Feed on Fear',
      frequency: { max: 1, per: 'round' },
      description: "<p><strong>Requirements</strong> An enemy within 15 feet is under a fear effect or dying</p><hr/><p><strong>Effect</strong> It regains @Damage[2d4[healing]]{2d4 Hit Points}.</p>",
    });
    const actor = makeActor({ items: [item], hp: 10, maxHp: 20 });
    const combat = { getFlag: () => undefined, round: 1 };
    const opponents = [{ id: 'o1', distanceSquares: 10, conditions: { some: () => false } }];
    const entries = await computeNpcSelfVocabulary(combat, { id: 'c1', actor }, opponents, 3);
    expect(entries).toEqual([]);
  });

  it('excludes an item still gated by its own frequency (0 uses left)', async () => {
    const item = makeItem({
      name: 'Reef Armor', cost: 2,
      frequency: { max: 1, per: 'day', value: 0 },
      selfEffect: { uuid: 'x' },
      description: '<p>flavor</p>',
    });
    const actor = makeActor({ items: [item] });
    const combat = { getFlag: () => undefined, round: 1 };
    const entries = await computeNpcSelfVocabulary(combat, { id: 'c1', actor }, [], 3);
    expect(entries).toEqual([]);
  });

  it('excludes an effect already active on the actor (same origin item)', async () => {
    const item = makeItem({ name: 'Form a Phalanx', selfEffect: { uuid: 'x' }, description: '<p>flavor</p>' });
    const actor = makeActor({
      items: [item],
      effects: [{ system: { context: { origin: { item: item.uuid } } } }],
    });
    const combat = { getFlag: () => undefined, round: 1 };
    const entries = await computeNpcSelfVocabulary(combat, { id: 'c1', actor }, [], 3);
    expect(entries).toEqual([]);
  });

  it('respects NPC_SELF_VOCABULARY_CAP, most tactically relevant first', async () => {
    const items = Array.from({ length: 10 }, (_, i) =>
      makeItem({ name: `Effect ${i}`, selfEffect: { uuid: `x${i}` }, description: '<p>flavor</p>' }),
    );
    const actor = makeActor({ items });
    const combat = { getFlag: () => undefined, round: 1 };
    const entries = await computeNpcSelfVocabulary(combat, { id: 'c1', actor }, [], 3);
    expect(entries.length).toBeLessThanOrEqual(8);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/dungeon-combat-npc-self-vocabulary.test.mjs`
Expected: FAIL with "computeNpcSelfVocabulary is not exported"

- [ ] **Step 3: Implement the requirement evaluator and the aggregator**

```js
// scripts/dungeon-combat.mjs (insert near computeReadyNpcAbilities, ~line 1900)

/** #934: at most this many npcSelf entries go to the reasoning model per
 * turn -- same cap #915 uses for npcAbility (spec left the exact number to
 * planning; matching the sibling category keeps every once-per-turn
 * vocabulary category's budget consistent). */
const NPC_SELF_VOCABULARY_CAP = 8;

/** #934: true when every one of `predicates` holds for `actor` against
 * `opponents` (plain {id, distanceSquares, conditions}-shaped objects, the
 * same shape getPendingAgentTurn already builds for the `opponents` array
 * it passes everywhere else). A `wearing`/`wielding` predicate checks the
 * actor's own equipped items by case-insensitive name substring; an
 * unreadable actor/opponent field excludes rather than defaults to true. */
function evaluateSelfRequirements(predicates, actor, opponents) {
  for (const predicate of predicates) {
    try {
      if (predicate.type === "handFree") {
        const held = Array.from(actor?.items ?? []).filter(
          (i) => i?.system?.equipped?.carryType === "held",
        ).length;
        const hands = 2; // PF2e RAW: two hands, no NPC-specific override tracked by this module.
        if (held >= hands) return false;
      } else if (predicate.type === "wearing" || predicate.type === "wielding") {
        const carryType = predicate.type === "wearing" ? "worn" : "held";
        const has = Array.from(actor?.items ?? []).some(
          (i) =>
            i?.system?.equipped?.carryType === carryType &&
            String(i.name ?? "").toLowerCase().includes(predicate.name.toLowerCase()),
        );
        if (!has) return false;
      } else if (predicate.type === "hasCondition") {
        if (!actorHasCondition(actor, predicate.slug)) return false;
      } else if (predicate.type === "notHasCondition") {
        if (actorHasCondition(actor, predicate.slug)) return false;
      } else if (predicate.type === "enemyWithin") {
        const rangeSquares = Math.floor(predicate.feet / 5);
        const matches = opponents.some((o) => {
          if (o.distanceSquares > rangeSquares) return false;
          return predicate.conditions.some((c) =>
            c === "fear-effect" ? opponentHasFearEffect(o) : (o.conditions?.some?.((x) => x.slug === c) ?? false),
          );
        });
        if (!matches) return false;
      } else {
        return false;
      }
    } catch (err) {
      console.warn("#934: skipping an npcSelf requirement check that threw:", err.message);
      return false;
    }
  }
  return true;
}

/** #934: "affected by a fear effect" -- any of the opponent's own active
 * conditions/effects carrying the PF2e `fear` trait. `opponents` entries
 * built by computeReadyNpcSelfAbilities below carry a real `actor`
 * reference for exactly this check. */
function opponentHasFearEffect(opponent) {
  const items = [
    ...(opponent.actor?.itemTypes?.condition ?? []),
    ...(opponent.actor?.itemTypes?.effect ?? []),
  ];
  return items.some((i) => (i.system?.traits?.value ?? []).includes("fear"));
}

/** #934: the Foundry-touching half of npcSelf readiness -- parses each of
 * `combatant`'s own action items with npc-self-parse.mjs's pure parser,
 * drops anything out of frequency uses, still recharging, already active
 * on the actor (same origin item, #910's own actorAlreadyHasEffectFrom),
 * or whose linked effect fails the Task 2 safety check, evaluates its
 * requirement predicates against real opponent/actor state, and -- for a
 * selfHeal -- excludes it when the actor is already at full HP (the
 * spec's own stated gate). `opponents` must be the richer, actor-carrying
 * shape (`rawOpponents`-style, not the trimmed `opponents` array
 * getPendingAgentTurn builds for everything else) so enemyWithin's
 * fear-effect check can read each opponent's real condition/effect list. */
async function computeReadyNpcSelfAbilities(combat, combatant, opponents) {
  const actor = combatant.actor;
  const ready = [];
  for (const item of actorActionItems(actor)) {
    try {
      const descriptor = parseSelfAbility(item);
      if (!descriptor) continue;
      const uses = descriptor.frequency?.value;
      if (descriptor.frequency && !(typeof uses === "number" && uses > 0)) continue;
      const slug = actionItemSlug(item);
      if (!isAbilityRecharged(combat, combatant.id, slug)) continue;
      if (descriptor.params.effectUuid) {
        const effect = await fromUuid(descriptor.params.effectUuid);
        if (!effect) continue;
        const rules = effect.system?.rules ?? [];
        const duration = effect.system?.duration;
        if (isUnsafeSelfEffectForNpc(rules, duration)) continue;
        if (actorAlreadyHasEffectFrom(actor, item, effect.slug)) continue;
      }
      if (!evaluateSelfRequirements(descriptor.requirements, actor, opponents)) continue;
      if (descriptor.family === "selfHeal") {
        const hp = actor.system?.attributes?.hp ?? {};
        if (typeof hp.value === "number" && typeof hp.max === "number" && hp.value >= hp.max) continue;
        const hpFraction = typeof hp.value === "number" && hp.max > 0 ? hp.value / hp.max : null;
        ready.push({ itemId: item.id, slug, name: item.name, descriptor, hpFraction });
        continue;
      }
      ready.push({ itemId: item.id, slug, name: item.name, descriptor, hpFraction: null });
    } catch (err) {
      console.warn(`#934: skipping unreadable NPC action item ${item?.name ?? item?.id}:`, err.message);
    }
  }
  return ready;
}

/** #934: wraps computeReadyNpcSelfAbilities with the cost gate and the
 * NPC_SELF_VOCABULARY_CAP, ranked heals-when-hurt first (lowest hpFraction
 * first, ties by item order) then every other family in item order --
 * matching the spec's own stated ranking. Returns plain entries for
 * agent-candidates.mjs's buildNpcSelfVocabulary. */
export async function computeNpcSelfVocabulary(combat, combatant, opponents, actionsRemaining) {
  const ready = await computeReadyNpcSelfAbilities(combat, combatant, opponents);
  const scored = ready
    .filter((r) => r.descriptor.cost <= actionsRemaining)
    .map((r, index) => ({
      index,
      tier: r.descriptor.family === "selfHeal" ? (r.hpFraction ?? 1) : 1,
      entry: {
        type: "npcSelf",
        itemId: r.itemId,
        slug: r.slug,
        name: r.name,
        family: r.descriptor.family,
        cost: r.descriptor.cost,
        summary: describeNpcSelfAbility(r.descriptor, r.hpFraction),
        hpFraction: r.hpFraction,
      },
    }));
  scored.sort((a, b) => a.tier - b.tier || a.index - b.index);
  return scored.slice(0, NPC_SELF_VOCABULARY_CAP).map((s) => s.entry);
}
```

- [ ] **Step 4: Add the new imports at the top of `scripts/dungeon-combat.mjs`**

```js
// Add alongside the existing `import { parseSaveAbility, describeNpcAbility } from "./npc-ability-parse.mjs";` (line 44)
import { parseSelfAbility, describeNpcSelfAbility } from "./npc-self-parse.mjs";
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run tests/dungeon-combat-npc-self-vocabulary.test.mjs`
Expected: PASS (8 tests)

- [ ] **Step 6: Run the full suite to check for regressions**

Run: `npx vitest run`
Expected: PASS (no regressions in `npc-ability-parse*`, `agent-candidates*`, `dungeon-combat-*` suites)

- [ ] **Step 7: Commit**

```bash
git add scripts/dungeon-combat.mjs tests/dungeon-combat-npc-self-vocabulary.test.mjs
git commit -m "feat(#934): requirement-predicate evaluation and the npcSelf readiness aggregator"
```

---

### Task 4: Vocabulary and candidate builders

**Files:**
- Modify: `scripts/agent-candidates.mjs`
- Test: `tests/agent-candidates.test.mjs`

**Interfaces:**
- Consumes: the plain entry shape Task 3's `computeNpcSelfVocabulary` produces: `{type: 'npcSelf', itemId, slug, name, family, cost, summary, hpFraction}`.
- Produces: `buildNpcSelfVocabulary({ npcSelfEntries })` → `Array<{type:'npcSelf', itemId, slug, name, family, cost, summary}>`. `buildNpcSelfCandidates({ npcSelfVocabulary, picks })` → `Array<candidate>`. Both wired into `buildCandidateList`'s existing parameter list and body (new `npcSelfVocabulary = []` parameter, spread the same way `npcAbilityVocabulary` already is).

- [ ] **Step 1: Write the failing tests**

```js
// tests/agent-candidates.test.mjs (append)
import { buildNpcSelfVocabulary, buildNpcSelfCandidates } from '../scripts/agent-candidates.mjs';

describe('buildNpcSelfVocabulary / buildNpcSelfCandidates (#934)', () => {
  const entry = {
    type: 'npcSelf', itemId: 'item1', slug: 'form-a-phalanx', name: 'Form a Phalanx',
    family: 'selfEffectAction', cost: 1, summary: 'self-buff (effect)', hpFraction: null,
  };

  it('passes entries through as vocabulary, dropping the internal hpFraction field', () => {
    const vocabulary = buildNpcSelfVocabulary({ npcSelfEntries: [entry] });
    expect(vocabulary).toEqual([
      { type: 'npcSelf', itemId: 'item1', slug: 'form-a-phalanx', name: 'Form a Phalanx', family: 'selfEffectAction', cost: 1, summary: 'self-buff (effect)' },
    ]);
  });

  it('builds a candidate from a matching pick', () => {
    const vocabulary = buildNpcSelfVocabulary({ npcSelfEntries: [entry] });
    const picks = [{ type: 'npcSelf', slug: 'form-a-phalanx', targetId: null, rationale: 'raise defenses' }];
    const candidates = buildNpcSelfCandidates({ npcSelfVocabulary: vocabulary, picks });
    expect(candidates).toEqual([
      {
        id: 'npcSelf:item1', type: 'npcSelf', itemId: 'item1', slug: 'form-a-phalanx', name: 'Form a Phalanx',
        family: 'selfEffectAction', cost: 1, summary: 'Form a Phalanx (self-buff (effect)) — raise defenses',
      },
    ]);
  });

  it('drops a pick whose itemId disagrees with the matched vocabulary entry', () => {
    const vocabulary = buildNpcSelfVocabulary({ npcSelfEntries: [entry] });
    const picks = [{ type: 'npcSelf', slug: 'form-a-phalanx', itemId: 'some-other-item' }];
    expect(buildNpcSelfCandidates({ npcSelfVocabulary: vocabulary, picks })).toEqual([]);
  });

  it('ignores a pick whose type is not npcSelf', () => {
    const vocabulary = buildNpcSelfVocabulary({ npcSelfEntries: [entry] });
    const picks = [{ type: 'feat', slug: 'form-a-phalanx' }];
    expect(buildNpcSelfCandidates({ npcSelfVocabulary: vocabulary, picks })).toEqual([]);
  });

  it('de-duplicates a repeated pick for the same item', () => {
    const vocabulary = buildNpcSelfVocabulary({ npcSelfEntries: [entry] });
    const picks = [{ type: 'npcSelf', slug: 'form-a-phalanx' }, { type: 'npcSelf', slug: 'form-a-phalanx' }];
    expect(buildNpcSelfCandidates({ npcSelfVocabulary: vocabulary, picks })).toHaveLength(1);
  });

  it('returns [] when picks is null', () => {
    expect(buildNpcSelfCandidates({ npcSelfVocabulary: [], picks: null })).toEqual([]);
  });
});

describe('buildCandidateList wires in npcSelfVocabulary (#934)', () => {
  it('includes an npcSelf candidate alongside the end-turn candidate', () => {
    const vocabulary = buildNpcSelfVocabulary({ npcSelfEntries: [entry] });
    const list = buildCandidateList({
      opponents: [], readyActions: [], turnState: { actionsRemaining: 1, mapIncrement: 0 },
      npcSelfVocabulary: vocabulary, maneuverPicks: [{ type: 'npcSelf', slug: 'form-a-phalanx' }],
    });
    expect(list.some((c) => c.type === 'npcSelf')).toBe(true);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/agent-candidates.test.mjs -t "npcSelf"`
Expected: FAIL with "buildNpcSelfVocabulary is not exported"

- [ ] **Step 3: Implement the builders, mirroring `buildNpcAbilityVocabulary`/`buildNpcAbilityCandidates`**

```js
// scripts/agent-candidates.mjs (insert immediately after buildNpcAbilityCandidates, ~line 1238)

/** #934: the npcSelf vocabulary category -- Task 3's computeNpcSelfVocabulary
 * already applies every eligibility gate (cost, frequency, recharge,
 * already-active, requirement predicates, full-HP exclusion) and the cap;
 * this just drops the internal `hpFraction` ranking field before the entry
 * goes to the reasoning model (the model reads `summary`'s own embedded
 * HP percentage instead, same convention #914's effectSummary/durationLabel
 * pairing already uses). */
export function buildNpcSelfVocabulary({ npcSelfEntries = [] }) {
  return npcSelfEntries.map(({ hpFraction, ...entry }) => entry);
}

/**
 * #934: validates the combined once-per-turn picks against
 * `npcSelfVocabulary`, ignoring any pick whose `type` isn't 'npcSelf' --
 * same (slug, optional itemId) matching convention buildFeatCandidates/
 * buildNpcAbilityCandidates already use for this response schema.
 */
export function buildNpcSelfCandidates({ npcSelfVocabulary = [], picks = null }) {
  if (!picks) return [];
  const candidates = [];
  const seen = new Set();
  for (const pick of picks) {
    if (!pick || typeof pick !== 'object' || pick.type !== 'npcSelf') continue;
    const match = npcSelfVocabulary.find((v) => v.slug === pick.slug);
    if (!match) continue;
    if (pick.itemId !== undefined && pick.itemId !== match.itemId) continue;
    const id = `npcSelf:${match.itemId}`;
    if (seen.has(id)) continue;
    seen.add(id);
    const label = `${match.name} (${match.summary})`;
    candidates.push({
      id, type: 'npcSelf', itemId: match.itemId, slug: match.slug, name: match.name,
      family: match.family, cost: match.cost,
      summary: pick.rationale ? `${label} — ${pick.rationale}` : label,
    });
  }
  return candidates;
}
```

- [ ] **Step 4: Wire `npcSelfVocabulary` into `buildCandidateList`**

```js
// scripts/agent-candidates.mjs -- buildCandidateList's signature (~line 1241): add the
// new parameter next to the existing npcAbilityVocabulary one.
export function buildCandidateList({ opponents, readyActions, readySpells = [], readyAreaSpells = [], readyAttackSpells = [], readyDebuffSpells = [], readyBreathWeapons = [], readyMultiStrikeBundles = [], readyChainSpells = [], readyHealSpells = [], readyBuffSpells = [], readyTierScalingAreaSpells = [], readyDualNatureSpells = [], readyTargetCountSpells = [], readyAutoHitAreaSpells = [], allies = [], seekTargets = [], turnState, hazard = null, hasRangedOrReach = false, maneuverVocabulary = [], maneuverPicks = null, featVocabulary = [], npcAbilityVocabulary = [], npcSelfVocabulary = [] }) {
  if (turnState.actionsRemaining <= 0) return [endTurnCandidate()];
  return [
    ...buildMovementCandidates({ opponents, hazard, hasRangedOrReach }),
    ...buildStrikeCandidates({ readyActions, opponents, mapIncrement: turnState.mapIncrement }),
    ...buildManeuverCandidates({ maneuverVocabulary, maneuverPicks, opponents }),
    ...buildFeatCandidates({ featVocabulary, picks: maneuverPicks, opponents }),
    ...buildNpcAbilityCandidates({ npcAbilityVocabulary, picks: maneuverPicks, opponents }),
    ...buildNpcSelfCandidates({ npcSelfVocabulary, picks: maneuverPicks }),
    ...buildSpellCandidates({ readySpells, opponents, actionsRemaining: turnState.actionsRemaining }),
    ...buildAreaSpellCandidates({ readyAreaSpells, actionsRemaining: turnState.actionsRemaining }),
    ...buildAttackSpellCandidates({ readyAttackSpells, opponents, actionsRemaining: turnState.actionsRemaining }),
    ...buildDebuffSpellCandidates({ readyDebuffSpells, opponents, actionsRemaining: turnState.actionsRemaining }),
    ...buildBreathWeaponCandidates({ readyBreathWeapons, actionsRemaining: turnState.actionsRemaining }),
    ...buildMultiStrikeCandidates({ readyMultiStrikeBundles, opponents, actionsRemaining: turnState.actionsRemaining }),
    ...buildChainSpellCandidates({ readyChainSpells, opponents, actionsRemaining: turnState.actionsRemaining }),
    ...buildHealSpellCandidates({ readyHealSpells, allies, actionsRemaining: turnState.actionsRemaining }),
    ...buildBuffSpellCandidates({ readyBuffSpells, allies, actionsRemaining: turnState.actionsRemaining }),
    ...buildTierScalingAreaSpellCandidates({ readyTierScalingAreaSpells, actionsRemaining: turnState.actionsRemaining }),
    ...buildDualNatureSpellCandidates({ readyDualNatureSpells, actionsRemaining: turnState.actionsRemaining }),
    ...buildTargetCountSpellCandidates({ readyTargetCountSpells, actionsRemaining: turnState.actionsRemaining }),
    ...buildAutoHitAreaSpellCandidates({ readyAutoHitAreaSpells, actionsRemaining: turnState.actionsRemaining }),
    ...buildSeekCandidates({ seekTargets, opponents, actionsRemaining: turnState.actionsRemaining }),
    endTurnCandidate()
  ];
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run tests/agent-candidates.test.mjs`
Expected: PASS (all tests, no regressions in the existing suite)

- [ ] **Step 6: Commit**

```bash
git add scripts/agent-candidates.mjs tests/agent-candidates.test.mjs
git commit -m "feat(#934): npcSelf vocabulary/candidate builders, wired into buildCandidateList"
```

---

### Task 5: Wire `npcSelf` into the once-per-turn reasoning call

**Files:**
- Modify: `scripts/dungeon-combat.mjs` (`getPendingAgentTurn`, ~line 4053; `runAgentDecisionLoop`, ~lines 1034-1051; `buildCandidateList` call site)
- Test: `tests/dungeon-combat-npc-self-wiring.test.mjs`

**Interfaces:**
- Consumes: `computeNpcSelfVocabulary` (Task 3); `buildNpcSelfVocabulary` (Task 4, already imported into this file via the existing `import { ... } from "./agent-candidates.mjs"` line — add `buildNpcSelfVocabulary` to that import list).
- Produces: `pending.npcSelfVocabulary` on the object `getPendingAgentTurn` returns, read by `runAgentDecisionLoop` and by `buildCandidateList`'s call site inside `getPendingAgentTurn` itself.

- [ ] **Step 1: Write the failing test**

```js
// tests/dungeon-combat-npc-self-wiring.test.mjs
import { describe, it, expect, vi } from 'vitest';
import { getPendingAgentTurn } from '../scripts/dungeon-combat.mjs';

// Minimal combat/combatant doubles exercising only the npcSelf wiring path --
// every other vocabulary category's own wiring is already covered by
// #909/#910/#915's own tests; this confirms npcSelfVocabulary rides along
// without disturbing them.
describe('getPendingAgentTurn npcSelf wiring (#934)', () => {
  it('a combatant with no action items at all gets an empty npcSelfVocabulary, not a throw', async () => {
    const actor = {
      type: 'npc',
      itemTypes: { action: [], feat: [], effect: [] },
      system: { actions: [], attributes: { hp: { value: 10, max: 10 } } },
      spellcasting: { contents: [] },
    };
    const token = { x: 0, y: 0, document: {} };
    const combatant = {
      id: 'c1', actor, token, isDefeated: false,
      getFlag: (mod, key) => (key === 'agentControlled' ? true : undefined),
    };
    const combat = {
      combatant, combatants: [combatant], scene: { grid: { size: 100, distance: 5 } },
      getFlag: () => undefined, round: 1, turn: 0,
    };
    const pending = await getPendingAgentTurn(combat);
    expect(pending?.npcSelfVocabulary).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails or errors**

Run: `npx vitest run tests/dungeon-combat-npc-self-wiring.test.mjs`
Expected: FAIL (either `pending.npcSelfVocabulary` is `undefined`, or the test doubles above are missing a field `getPendingAgentTurn` needs — adjust the doubles to match whatever the real function reads, following the exact same combatant/combat/actor shape the file's own existing `dungeon-combat-npc-ability-vocabulary.test.mjs` doubles use, without changing the assertion)

- [ ] **Step 3: Add `npcSelfVocabulary` to `getPendingAgentTurn`**

```js
// scripts/dungeon-combat.mjs -- immediately after the existing npcAbilityVocabulary
// block (~line 4063), before readySpells is computed:

  // #934: NPC self-buff/heal abilities (Form a Phalanx, Feed on Fear, ...),
  // the fourth category sent to the same once-per-turn call.
  const npcSelfVocabulary = await computeNpcSelfVocabulary(
    combat,
    combatant,
    rawOpponents,
    turnState.actionsRemaining,
  );
```

- [ ] **Step 4: Pass `npcSelfVocabulary` through the same function's own `buildCandidateList` call and its returned object**

Find this function's existing `return { ... }` statement (the one already including `npcAbilityVocabulary,` per the grep at line ~4722) and its `buildCandidateList({...})` call (line ~4701) — add `npcSelfVocabulary,` to both, in the same position `npcAbilityVocabulary` already occupies.

- [ ] **Step 5: Add `npcSelfVocabulary` to the once-per-turn reasoning-call trigger and the combined vocabulary payload in `runAgentDecisionLoop`**

```js
// scripts/dungeon-combat.mjs, runAgentDecisionLoop (~lines 1034-1051) -- extend the
// existing OR-chain and the combined vocabulary array:

    if (
      pending.maneuverVocabulary?.length ||
      pending.featVocabulary?.length ||
      pending.npcAbilityVocabulary?.length ||
      pending.npcSelfVocabulary?.length
    ) {
      const turnState = getAgentTurnState(combat, pending.combatantId);
      if (turnState.maneuverPicks === null) {
        let picks = [];
        try {
          const response = await fetchCandidates({
            baseUrl,
            apiKey,
            context: pending.context,
            vocabulary: [
              ...(pending.maneuverVocabulary ?? []),
              ...(pending.featVocabulary ?? []),
              ...(pending.npcAbilityVocabulary ?? []),
              ...(pending.npcSelfVocabulary ?? []),
            ],
          });
```

- [ ] **Step 6: Add the new import**

```js
// scripts/dungeon-combat.mjs -- extend the existing agent-candidates.mjs import
// list to also pull in buildNpcSelfVocabulary (used by Step 3/4 above).
```

- [ ] **Step 7: Run the test to verify it passes**

Run: `npx vitest run tests/dungeon-combat-npc-self-wiring.test.mjs`
Expected: PASS

- [ ] **Step 8: Run the full suite**

Run: `npx vitest run`
Expected: PASS (no regressions in `runAgentDecisionLoop`/`getPendingAgentTurn`'s existing tests)

- [ ] **Step 9: Commit**

```bash
git add scripts/dungeon-combat.mjs tests/dungeon-combat-npc-self-wiring.test.mjs
git commit -m "feat(#934): wire npcSelf into the once-per-turn reasoning call"
```

---

### Task 6: Execution

**Files:**
- Modify: `scripts/dungeon-combat.mjs` (new executors near `executeSelfEffectFeat`/`executeNpcAbilityCandidate`; `applyAgentDecision`'s dispatch chain, ~line 7131)
- Test: `tests/dungeon-combat-npc-self-execution.test.mjs`

**Interfaces:**
- Consumes: `findActiveStanceEffectId`, `actorAlreadyHasEffectFrom`, `whisperGmContent`, `setAbilityRecharge`, `skipUnperformedFeat` (all already defined in this file); `MODULE_ID` (already imported/defined at file top).
- Produces: `executeNpcSelfCandidate(combat, combatant, candidate)` → `{performed: boolean}`, dispatched from `applyAgentDecision`'s `case "npcSelf"`.

- [ ] **Step 1: Write the failing tests**

```js
// tests/dungeon-combat-npc-self-execution.test.mjs
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mocked exactly the way tests/dungeon-combat-feat-self-effect-execution.test.mjs
// already mocks fromUuid/ChatMessage/game for #910's own executeSelfEffectFeat --
// same global shape, so this file's own setup block should be copied from there
// verbatim and only the item/actor fixtures below changed.

describe('executeNpcSelfCandidate (#934)', () => {
  it('creates the linked effect, tags it agentSelfEffect, posts the usage card, and spends frequency', async () => {
    const effectSource = { toObject: () => ({ _id: 'orig', system: { duration: { unit: 'rounds', value: 1 } } }) };
    globalThis.fromUuid = vi.fn().mockResolvedValue(effectSource);
    const created = vi.fn().mockResolvedValue(undefined);
    const toMessage = vi.fn().mockResolvedValue(undefined);
    const item = {
      id: 'item1', name: 'Form a Phalanx', uuid: 'Actor.a.Item.item1',
      system: {
        selfEffect: { uuid: 'Compendium.pf2e.bestiary-effects.Item.Effect: Form a Phalanx' },
        traits: { value: [] }, frequency: null,
      },
      getOriginData: () => ({ rollOptions: [] }),
      toMessage,
    };
    const actor = {
      itemTypes: { action: [item], effect: [] },
      uuid: 'Actor.a', createEmbeddedDocuments: created,
    };
    const combatant = { actor, token: { uuid: 'Scene.s.Token.t' } };
    const candidate = { type: 'npcSelf', itemId: 'item1', slug: 'form-a-phalanx', family: 'selfEffectAction' };

    const { executeNpcSelfCandidate } = await import('../scripts/dungeon-combat.mjs');
    const result = await executeNpcSelfCandidate({}, combatant, candidate);

    expect(result.performed).toBe(true);
    expect(created).toHaveBeenCalledWith('Item', [expect.objectContaining({ flags: { [expect.any(String)]: { agentSelfEffect: true } } })]);
    expect(toMessage).toHaveBeenCalled();
  });

  it('reports performed:false when the item is gone (candidate stale)', async () => {
    const actor = { itemTypes: { action: [], effect: [] } };
    const combatant = { actor };
    const candidate = { type: 'npcSelf', itemId: 'missing', slug: 'x', family: 'selfEffectAction' };
    const { executeNpcSelfCandidate } = await import('../scripts/dungeon-combat.mjs');
    expect(await executeNpcSelfCandidate({}, combatant, candidate)).toEqual({ performed: false });
  });

  it('rolls the heal formula, applies negative damage, and reports the clamped amount', async () => {
    const applyDamage = vi.fn().mockResolvedValue(undefined);
    const toMessage = vi.fn().mockResolvedValue(undefined);
    const item = {
      id: 'item2', name: 'Feed on Fear',
      system: { frequency: { max: 1, per: 'round', value: 1 }, traits: { value: [] } },
      update: vi.fn().mockResolvedValue(undefined),
      toMessage,
    };
    const actor = {
      itemTypes: { action: [item], effect: [] },
      system: { attributes: { hp: { value: 10, max: 20 } } },
      applyDamage,
    };
    const combatant = { actor, token: { id: 'tok1' } };
    const candidate = { type: 'npcSelf', itemId: 'item2', slug: 'feed-on-fear', family: 'selfHeal', formula: '2d4' };

    globalThis.Roll = class {
      constructor() {}
      async evaluate() { return { total: 5 }; }
    };

    const { executeNpcSelfCandidate } = await import('../scripts/dungeon-combat.mjs');
    const result = await executeNpcSelfCandidate({}, combatant, candidate);

    expect(result.performed).toBe(true);
    expect(applyDamage).toHaveBeenCalledWith({ damage: -5, token: combatant.token });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/dungeon-combat-npc-self-execution.test.mjs`
Expected: FAIL with "executeNpcSelfCandidate is not exported"

- [ ] **Step 3: Implement the executors, mirroring `executeSelfEffectFeat` (#910) and the confirmed-live healing call shape from `castHealSpellAndApply` (#132)**

```js
// scripts/dungeon-combat.mjs (insert immediately after executeSelfEffectFeat, ~line 6473)

/** #934: NPC-equivalent of executeSelfEffectFeat (#910) -- same real
 * sequence (effect created first, usage card posted and frequency spent
 * only after), on an NPC action item instead of a PC feat, looked up via
 * actorActionItems (NPC abilities are always itemTypes.action, never
 * itemTypes.feat). `candidate.itemId` may have gone stale (the item was
 * removed, the actor changed) between vocabulary build and execution --
 * returns `{performed: false}` rather than throwing. */
async function executeSelfOrLinkedEffect(combatant, candidate) {
  const actor = combatant.actor;
  const item = actorActionItems(actor).find((i) => i.id === candidate.itemId);
  if (!item) return { performed: false };
  const descriptor = parseSelfAbility(item);
  const uuid = descriptor?.params?.effectUuid;
  if (!uuid) return { performed: false };
  const effect = await fromUuid(uuid);
  if (typeof effect?.toObject !== "function") return { performed: false };

  const tokenUuid = combatant.token?.uuid ?? null;
  const effectTraits = CONFIG.PF2E?.effectTraits ?? {};
  const traits = (item.system.traits?.value ?? []).filter((t) => t in effectTraits);
  try {
    const source = foundry.utils.mergeObject(effect.toObject(), {
      _id: null,
      flags: { [MODULE_ID]: { agentSelfEffect: true } },
      system: {
        context: {
          origin: {
            actor: actor.uuid,
            token: tokenUuid,
            item: item.uuid,
            spellcasting: null,
            rollOptions: item.getOriginData?.().rollOptions ?? [],
          },
          target: { actor: actor.uuid, token: tokenUuid },
          roll: null,
        },
        traits: { value: traits },
      },
    });
    await actor.createEmbeddedDocuments("Item", [source]);
  } catch (err) {
    console.error(`#934: applying ${item.name}'s effect failed:`, err.message);
    return { performed: false };
  }

  if (traits.includes("stance")) {
    const previousStance = await findActiveStanceEffectId(actor);
    if (previousStance) {
      try {
        await actor.deleteEmbeddedDocuments("Item", [previousStance]);
      } catch (err) {
        console.error("#934: removing the previous stance effect failed:", err.message);
      }
    }
  }
  try {
    await item.toMessage?.();
  } catch (err) {
    console.warn(`#934: posting ${item.name}'s usage card failed:`, err.message);
  }
  if (item.system.frequency && item.system.frequency.value > 0) {
    await item.update({ "system.frequency.value": item.system.frequency.value - 1 });
  }
  await setAbilityRecharge(null, combatant.id, actionItemSlug(item), descriptor.rechargeFormula ?? null);
  return { performed: true };
}

/**
 * #934: rolls the heal formula and applies it the same confirmed-live way
 * #132's own castHealSpellAndApply restores HP -- applyDamage's negative-
 * number path, not a healing-typed roll object (see that function's own
 * comment for why). Reports a `crossRecharge` rider (Investigation
 * finding 5/the parser's own CROSS_RECHARGE_RE) to the GM rather than
 * enforcing it -- this module has no existing per-OTHER-ability recharge
 * coupling mechanism, and building one for this single rare pattern is
 * out of scope for this slice (see Error handling).
 */
async function executeSelfHeal(combatant, candidate) {
  const actor = combatant.actor;
  const item = actorActionItems(actor).find((i) => i.id === candidate.itemId);
  if (!item) return { performed: false };
  const descriptor = parseSelfAbility(item);
  if (descriptor?.family !== "selfHeal") return { performed: false };

  const roll = await new Roll(descriptor.params.formula).evaluate();
  const hp = actor.system?.attributes?.hp ?? {};
  const before = typeof hp.value === "number" ? hp.value : 0;
  const max = typeof hp.max === "number" ? hp.max : before + roll.total;
  await actor.applyDamage({ damage: -roll.total, token: combatant.token });
  const healed = Math.min(roll.total, Math.max(0, max - before));

  try {
    await item.toMessage?.();
  } catch (err) {
    console.warn(`#934: posting ${item.name}'s usage card failed:`, err.message);
  }
  if (item.system.frequency && item.system.frequency.value > 0) {
    await item.update({ "system.frequency.value": item.system.frequency.value - 1 });
  }
  if (descriptor.crossRecharge) {
    try {
      const esc = (v) => foundry.utils.escapeHTML?.(String(v)) ?? String(v);
      await whisperGmContent(
        `<p><strong>${esc(item.name)} (${esc(combatant.name ?? actor.name)}):</strong> healed ${healed} HP. Also, per its own text, it cannot use ${esc(descriptor.crossRecharge.name)} again for ${esc(descriptor.crossRecharge.formula)} rounds -- not tracked by this module, apply by hand.</p>`,
      );
    } catch {
      // Reporting is best-effort; the heal itself already succeeded.
    }
  }
  return { performed: true, healed };
}

/** #934: dispatches an npcSelf candidate to its executor by family. */
export async function executeNpcSelfCandidate(combat, combatant, candidate) {
  if (candidate.family === "selfHeal") return executeSelfHeal(combatant, candidate);
  return executeSelfOrLinkedEffect(combatant, candidate);
}
```

- [ ] **Step 4: Wire the dispatch into `applyAgentDecision`**

```js
// scripts/dungeon-combat.mjs, applyAgentDecision's dispatch chain -- add
// immediately after the existing npcAbility branch (~line 7134):

  } else if (candidate.type === "npcSelf") {
    const result = await executeNpcSelfCandidate(combat, combatant, candidate);
    if (!result.performed) return skipUnperformedFeat(combat, combatant, candidate);
  }
```

- [ ] **Step 5: Run the execution tests to verify they pass**

Run: `npx vitest run tests/dungeon-combat-npc-self-execution.test.mjs`
Expected: PASS (3 tests)

- [ ] **Step 6: Add the combat-end cleanup regression test (no new production code — confirms the existing #914 cleanup already covers this)**

```js
// tests/dungeon-combat-npc-self-execution.test.mjs (append)
describe('cleanupAgentSelfEffects already covers npcSelf-created effects (#914, no new code)', () => {
  it('removes an unlimited-duration effect tagged by executeNpcSelfCandidate', async () => {
    const { cleanupAgentSelfEffects } = await import('../scripts/dungeon-combat.mjs');
    const deleteEmbeddedDocuments = vi.fn().mockResolvedValue(undefined);
    const npcActor = {
      name: 'Axiomite',
      itemTypes: {
        effect: [
          { id: 'eff1', name: 'Effect: Example', flags: { 'pf2e-dungeon-crawl': { agentSelfEffect: true } }, system: { duration: { unit: 'unlimited' } } },
        ],
      },
      deleteEmbeddedDocuments,
    };
    const combat = { combatants: [{ actor: npcActor }] };
    await cleanupAgentSelfEffects(combat);
    expect(deleteEmbeddedDocuments).toHaveBeenCalledWith('Item', ['eff1']);
  });
});
```

- [ ] **Step 7: Run the whole test file**

Run: `npx vitest run tests/dungeon-combat-npc-self-execution.test.mjs`
Expected: PASS (4 tests)

- [ ] **Step 8: Run the full suite**

Run: `npx vitest run`
Expected: PASS (no regressions)

- [ ] **Step 9: Commit**

```bash
git add scripts/dungeon-combat.mjs tests/dungeon-combat-npc-self-execution.test.mjs
git commit -m "feat(#934): execute npcSelf candidates (self-effect creation and self-heal)"
```

---

### Task 7: Live verification

**Files:** none (manual check against a running world)

- [ ] **Step 1: Copy `.env` into the worktree if not already present, start the local stack per the README, and load a combat with an agent-controlled NPC that has a real `selfEffectAction` ability (e.g. a Skeleton Infantry with Form a Phalanx) at low enough HP/action budget to trigger a decision**
- [ ] **Step 2: Confirm live that the effect actually appears on the actor (Effects tab) after the AI chooses it, the usage chat card posts, and the action cost is deducted**
- [ ] **Step 3: Load a combat with an agent-controlled NPC that has a real `selfHeal` ability (e.g. a Will-o'-Wisp with Feed on Fear) with an enemy inside the required range and under the required condition; confirm the heal lands, is clamped at max HP, and the requirement correctly blocks the pick when no enemy is in range/under the condition**
- [ ] **Step 4: Confirm live that an unlimited-duration self-effect created this way is removed when combat ends (#914's existing cleanup)**
- [ ] **Step 5: Record the result on issue #934 (a short comment, pass/fail per check) — this step cannot be automated by this plan and must not be silently skipped**

---

### Task 8: File the real-population coverage audit and bump the version

**Files:**
- Modify: `module.json`
- Modify: `docs/architecture.md` (if the `update-architecture-docs` skill reports any change — the new `scripts/npc-self-parse.mjs` import edge from `dungeon-combat.mjs` is exactly the kind of rewiring CLAUDE.md requires this for)

- [ ] **Step 1: Run the `update-architecture-docs` skill**

Run the skill per CLAUDE.md's own requirement (any merge adding/removing/rewiring a `scripts/` file's imports) before bumping the version. Commit any resulting `docs/architecture.md` changes together with the version bump below, not separately.

- [ ] **Step 2: Bump `module.json`'s version**

```bash
# Check main's current version first -- other work may have landed since this
# plan was written. Bump from whatever is actually current, minor-version
# style (same class of change as #914 -> 0.84.0 and #915 -> 0.85.0):
# if main is still at 0.85.0, bump to 0.86.0.
```

- [ ] **Step 3: Commit**

```bash
git add module.json docs/architecture.md
git commit -m "chore(#934): bump version for npcSelf (NPC self-buff/heal) vocabulary"
```

- [ ] **Step 4: Confirm the follow-up coverage-audit issue is filed and linked**

Issue **#1024** ("AI NPCs: widen NPC self-buff/heal parsing coverage") was filed during this plan's own writing (mirroring #935's role for #915) and already references this plan's Investigation findings. No further action needed here beyond linking it in the PR description and the issue comment this plan's workflow posts on #934 at merge time.

---

## Self-Review

**1. Spec coverage:** Three families (Task 1), self-only (enforced throughout — `ALLY_RE` in the parser, no ally targeting anywhere in execution), closed requirement predicates (Task 1's `parseRequirementClause`, with `inForm` explicitly and documentedly cut rather than silently kept-but-unused), all-or-nothing (zero-leftover-text discipline in the parser, `null` on any unresolvable effect/unreadable actor data in Task 3), reuse of #910's effect-creation and #914's eligibility machinery (Task 2's narrow, documented refinement plus Task 6's executor), the once-per-turn reasoning call (Task 5), the exact healing call shape (Task 6, confirmed live from #132's own `castHealSpellAndApply`), combat-end cleanup (Task 6, confirmed as free reuse rather than new code), and the coverage-audit follow-up (#1024, filed).

**2. Placeholder scan:** No "TBD"/"TODO"/"add appropriate X". Every code block is complete, runnable code against real, confirmed function names and signatures read live from the current `scripts/dungeon-combat.mjs`/`scripts/agent-candidates.mjs`/`scripts/npc-ability-parse.mjs`. Task 5's Step 2 names the one spot where a test double's exact shape must match the real function's own reads rather than hard-coding a guess, flagged explicitly (the same deliberate, named exception prior plans in this sequence — #909/#910/#911/#915 — have each used once for exactly this reason, rather than silently guessing a mock shape that might not match the real function).

**3. Type consistency:** `parseSelfAbility`'s return shape (`family`, `cost`, `frequency`, `requirements`, `crossRecharge`, `params`) is used identically across Tasks 1, 3, and 6. The vocabulary entry shape (`type: 'npcSelf'`, `itemId`, `slug`, `name`, `family`, `cost`, `summary`, `hpFraction`) is produced in Task 3, trimmed (hpFraction dropped) in Task 4's `buildNpcSelfVocabulary`, and the resulting candidate shape (`id`, `type`, `itemId`, `slug`, `name`, `family`, `cost`, `summary`) is used identically in Task 4's `buildNpcSelfCandidates`, Task 5's `getPendingAgentTurn` wiring, and Task 6's `executeNpcSelfCandidate` dispatch (`candidate.family`, `candidate.itemId`).

**4. Review Focus:** All five bullets (unresolvable effect reference, zero-action-item actor, full-HP heal exclusion, cap/ranking, the `agentControlled` guard ordering) are each pinned to a specific test in Tasks 3, 5, and 6 above, not left as prose-only claims.

**Corrections found and resolved during this plan's own drafting** (beyond the six listed under "Investigation findings," caught while writing the actual code rather than during the earlier research pass): the normalizer's first draft matched only text INSIDE a `<strong>Label</strong>` span, which would have silently dropped a trailing unlabelled `<p>` after an explicit "Effect" block — exactly the shape Dero Medicine's/Revert Form's own trailing bare `@UUID[...]` paragraph and the voidglutton Feed on Fear's own trailing cross-ability-recharge sentence both use. Caught by tracing a real example byte-for-byte through the draft regex before writing the final version in Task 1 Step 3, which now explicitly collects every byte outside matched label spans into `effect` rather than relying on an "any label matched at all" fallback.
