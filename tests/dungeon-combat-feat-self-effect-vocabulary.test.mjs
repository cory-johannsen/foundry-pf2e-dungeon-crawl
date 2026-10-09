// tests/dungeon-combat-feat-self-effect-vocabulary.test.mjs
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { computeSelfEffectVocabularyEntries } from '../scripts/dungeon-combat.mjs';

// #910/#914: the self-effect feat category -- eligibility is computed
// deterministically from real item data and the linked effect's own rule
// elements/duration (#914 replaced #910's stances+Rage allowlist).

const RAGE_EFFECT = 'Compendium.pf2e.feat-effects.Item.z3uyCMBddrPK5umr';

function actionItem({
  id = 'rage1',
  slug = 'rage',
  name = 'Rage',
  traits = [],
  actionType = 'action',
  cost = 1,
  selfEffectUuid = RAGE_EFFECT,
  frequencyValue = null,
  rules = [],
  rulesSelections = {},
} = {}) {
  return {
    id,
    uuid: `Actor.a1.Item.${id}`,
    slug,
    name,
    system: {
      actionType: { value: actionType },
      actions: { value: actionType === 'action' ? cost : null },
      selfEffect: selfEffectUuid ? { uuid: selfEffectUuid, name: 'Effect' } : null,
      frequency: frequencyValue === null ? null : { value: frequencyValue, max: 1, per: 'day' },
      traits: { value: traits },
      rules,
    },
    flags: { pf2e: { rulesSelections } },
  };
}

function mkActor({ action = [], feat = [], effect = [], type = 'character', conditions = [] } = {}) {
  return { type, conditions, itemTypes: { action, feat, effect } };
}

// Rule keys/duration mirror the installed system's real effects (Effect:
// Rage = ActiveEffectLike x2, TempHP, RollOption; 1 minute).
const RAGE_RULES = [
  { key: 'ActiveEffectLike', path: 'system.attributes.ac.modifiers', mode: 'add' },
  { key: 'ActiveEffectLike', path: 'flags.pf2e.rage', mode: 'override' },
  { key: 'TempHP', value: '@actor.level + @actor.abilities.con.mod' },
  { key: 'RollOption', domain: 'all', option: 'rage' },
];
const STANCE_RULES = [{ key: 'Strike', label: 'Gorilla Slam' }];
const effects = {
  [RAGE_EFFECT]: { slug: 'effect-rage', system: { rules: RAGE_RULES, duration: { value: 1, unit: 'minutes' } } },
  'Compendium.pf2e.feat-effects.Item.gorilla': { slug: 'stance-gorilla-stance', system: { rules: STANCE_RULES, duration: { value: -1, unit: 'encounter' } } },
  'Compendium.pf2e.feat-effects.Item.crane': { slug: 'stance-crane-stance', system: { rules: STANCE_RULES, duration: { value: -1, unit: 'encounter' } } },
  'Compendium.pf2e.feat-effects.Item.some-buff': { slug: 'effect-some-buff', system: { rules: [{ key: 'FlatModifier', selector: 'ac' }], duration: { value: 1, unit: 'rounds' } } },
};
const RAGE_FIELDS = { effectSummary: 'modifiers mod, rage mod, temp HP, option', durationLabel: '1 minutes', frequencyLabel: null };
const GORILLA_FIELDS = { effectSummary: 'grants strike: Gorilla Slam', durationLabel: 'until encounter ends', frequencyLabel: null };

beforeEach(() => {
  globalThis.fromUuid = vi.fn(async (uuid) => effects[uuid] ?? null);
});

describe('computeSelfEffectVocabularyEntries', () => {
  it('includes Rage (not a stance-trait item) when its effect is not already active', async () => {
    const entries = await computeSelfEffectVocabularyEntries(mkActor({ action: [actionItem()] }), 3);
    expect(entries).toEqual([{ itemId: 'rage1', slug: 'rage', name: 'Rage', cost: 1, replacesStance: null, traits: [], ...RAGE_FIELDS }]);
  });

  it('excludes Rage when an effect created from that item is already active (origin.item uuid)', async () => {
    const active = { id: 'e1', slug: 'something-else', system: { traits: { value: [] }, context: { origin: { item: 'Actor.a1.Item.rage1' } } } };
    const entries = await computeSelfEffectVocabularyEntries(mkActor({ action: [actionItem()], effect: [active] }), 3);
    expect(entries).toEqual([]);
  });

  it('excludes Rage when the same linked effect is already active from any other source (slug match)', async () => {
    const active = { id: 'e1', slug: 'effect-rage', system: { traits: { value: [] }, context: null } };
    const entries = await computeSelfEffectVocabularyEntries(mkActor({ action: [actionItem()], effect: [active] }), 3);
    expect(entries).toEqual([]);
  });

  it('excludes Rage while the actor is Fatigued (Rage requirement)', async () => {
    const actor = mkActor({ action: [actionItem()], conditions: [{ slug: 'fatigued' }] });
    expect(await computeSelfEffectVocabularyEntries(actor, 3)).toEqual([]);
  });

  it('excludes everything for a non-character actor (NPC abilities are #915)', async () => {
    const actor = mkActor({ action: [actionItem()], type: 'npc' });
    expect(await computeSelfEffectVocabularyEntries(actor, 3)).toEqual([]);
  });

  it('includes a non-stance, non-Rage self-effect item whose effect passes the #914 checks', async () => {
    const actor = mkActor({ feat: [actionItem({ id: 'x', slug: 'some-buff', name: 'Some Buff', selfEffectUuid: 'Compendium.pf2e.feat-effects.Item.some-buff' })] });
    expect(await computeSelfEffectVocabularyEntries(actor, 3)).toEqual([
      { itemId: 'x', slug: 'some-buff', name: 'Some Buff', cost: 1, replacesStance: null, traits: [], effectSummary: '+ac', durationLabel: '1 rounds', frequencyLabel: null },
    ]);
  });

  it('excludes passive and reaction items', async () => {
    const actor = mkActor({ action: [actionItem({ actionType: 'passive' }), actionItem({ id: 'r2', actionType: 'reaction' })] });
    expect(await computeSelfEffectVocabularyEntries(actor, 3)).toEqual([]);
  });

  it('excludes an item with no selfEffect at all', async () => {
    const actor = mkActor({ action: [actionItem({ selfEffectUuid: null })] });
    expect(await computeSelfEffectVocabularyEntries(actor, 3)).toEqual([]);
  });

  it('excludes an item whose selfEffect uuid no longer resolves', async () => {
    const actor = mkActor({ action: [actionItem({ selfEffectUuid: 'Compendium.pf2e.feat-effects.Item.gone' })] });
    expect(await computeSelfEffectVocabularyEntries(actor, 3)).toEqual([]);
  });

  it('excludes an item whose frequency is exhausted', async () => {
    const actor = mkActor({ action: [actionItem({ frequencyValue: 0 })] });
    expect(await computeSelfEffectVocabularyEntries(actor, 3)).toEqual([]);
  });

  it('excludes an item whose cost exceeds the actions remaining this turn', async () => {
    const actor = mkActor({ action: [actionItem({ cost: 2 })] });
    expect(await computeSelfEffectVocabularyEntries(actor, 1)).toEqual([]);
  });

  it('treats a free action as costing 0 actions', async () => {
    const stance = actionItem({ id: 's1', slug: 'free-stance', traits: ['stance'], actionType: 'free', selfEffectUuid: 'Compendium.pf2e.feat-effects.Item.gorilla' });
    const entries = await computeSelfEffectVocabularyEntries(mkActor({ feat: [stance] }), 0);
    expect(entries.map((e) => [e.itemId, e.cost])).toEqual([['s1', 0]]);
  });

  it('excludes exploration/downtime items', async () => {
    const stance = actionItem({ id: 's1', slug: 'x-stance', traits: ['stance', 'exploration'], selfEffectUuid: 'Compendium.pf2e.feat-effects.Item.gorilla' });
    expect(await computeSelfEffectVocabularyEntries(mkActor({ feat: [stance] }), 3)).toEqual([]);
  });

  it('excludes an item with an unresolved ChoiceSet rule, but keeps one whose choice is already made', async () => {
    const choice = { key: 'ChoiceSet', flag: 'damage', choices: [{ value: 'fire' }] };
    const unresolved = actionItem({ rules: [choice] });
    expect(await computeSelfEffectVocabularyEntries(mkActor({ action: [unresolved] }), 3)).toEqual([]);
    const resolved = actionItem({ rules: [choice], rulesSelections: { damage: 'fire' } });
    expect((await computeSelfEffectVocabularyEntries(mkActor({ action: [resolved] }), 3)).length).toBe(1);
  });

  it('includes a stance-trait item when the actor has no active stance', async () => {
    const stanceItem = actionItem({ id: 'gorilla1', slug: 'gorilla-stance', name: 'Gorilla Stance', traits: ['stance'], selfEffectUuid: 'Compendium.pf2e.feat-effects.Item.gorilla' });
    const entries = await computeSelfEffectVocabularyEntries(mkActor({ feat: [stanceItem] }), 3);
    expect(entries).toEqual([{ itemId: 'gorilla1', slug: 'gorilla-stance', name: 'Gorilla Stance', cost: 1, replacesStance: null, traits: ['stance'], ...GORILLA_FIELDS }]);
  });

  it('flags replacesStance when the actor is already in a different stance (origin item has the stance trait)', async () => {
    globalThis.fromUuid.mockImplementation(async (uuid) => {
      if (uuid === 'Actor.a1.Item.crane-feat') return { system: { traits: { value: ['stance'] } } };
      return effects[uuid] ?? null;
    });
    const stanceItem = actionItem({ id: 'gorilla1', slug: 'gorilla-stance', name: 'Gorilla Stance', traits: ['stance'], selfEffectUuid: 'Compendium.pf2e.feat-effects.Item.gorilla' });
    const activeCrane = { id: 'effect-crane-id', slug: 'stance-crane-stance', system: { traits: { value: [] }, context: { origin: { item: 'Actor.a1.Item.crane-feat' } } } };
    const entries = await computeSelfEffectVocabularyEntries(mkActor({ feat: [stanceItem], effect: [activeCrane] }), 3);
    expect(entries).toEqual([{ itemId: 'gorilla1', slug: 'gorilla-stance', name: 'Gorilla Stance', cost: 1, replacesStance: 'effect-crane-id', traits: ['stance'], ...GORILLA_FIELDS }]);
  });

  it('flags replacesStance from an active effect that itself carries the stance trait', async () => {
    const stanceItem = actionItem({ id: 'gorilla1', slug: 'gorilla-stance', traits: ['stance'], selfEffectUuid: 'Compendium.pf2e.feat-effects.Item.gorilla' });
    const activeCrane = { id: 'effect-crane-id', slug: 'stance-crane-stance', system: { traits: { value: ['stance'] }, context: null } };
    const entries = await computeSelfEffectVocabularyEntries(mkActor({ feat: [stanceItem], effect: [activeCrane] }), 3);
    expect(entries[0].replacesStance).toBe('effect-crane-id');
  });

  it('never flags replacesStance for Rage (not a stance)', async () => {
    const activeCrane = { id: 'effect-crane-id', slug: 'stance-crane-stance', system: { traits: { value: ['stance'] }, context: null } };
    const entries = await computeSelfEffectVocabularyEntries(mkActor({ action: [actionItem()], effect: [activeCrane] }), 3);
    expect(entries[0].replacesStance).toBe(null);
  });

  it('excludes an item whose data throws when read, rather than defaulting it to available', async () => {
    const broken = actionItem();
    Object.defineProperty(broken.system, 'selfEffect', { get() { throw new Error('bad data'); } });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(await computeSelfEffectVocabularyEntries(mkActor({ action: [broken] }), 3)).toEqual([]);
  });
});

describe('computeSelfEffectVocabularyEntries (#914 derived filter)', () => {
  function selfEffectItem({ id, slug, name, traits = [], frequency = null } = {}) {
    return {
      id, slug, name,
      uuid: `Actor.a1.Item.${id}`,
      system: {
        actionType: { value: 'action' },
        actions: { value: 1 },
        selfEffect: { uuid: `Compendium.pf2e.feat-effects.Item.${slug}` },
        frequency,
        traits: { value: traits },
        rules: [],
      },
      flags: { pf2e: { rulesSelections: {} } },
    };
  }

  function installFromUuidStub(effectsByUuid) {
    globalThis.fromUuid = vi.fn(async (uuid) => effectsByUuid[uuid] ?? null);
  }

  function effectWith(rules, duration = { value: 1, unit: 'rounds' }) {
    return { slug: 'effect-x', system: { rules, duration } };
  }

  async function entriesFor(slug, rules, duration) {
    const item = selfEffectItem({ id: 'i', slug, name: slug });
    installFromUuidStub({ [`Compendium.pf2e.feat-effects.Item.${slug}`]: effectWith(rules, duration) });
    return computeSelfEffectVocabularyEntries(mkActor({ action: [item] }), 3);
  }

  it('includes a non-stance, non-Rage item whose effect has only safe rules, with its summary/duration/frequency labels', async () => {
    const item = selfEffectItem({ id: 'i1', slug: 'raise-a-shield', name: 'Raise a Shield', frequency: { value: 1, max: 1, per: 'PT1H' } });
    installFromUuidStub({
      'Compendium.pf2e.feat-effects.Item.raise-a-shield': {
        slug: 'effect-raised-shield',
        system: { rules: [{ key: 'ActiveEffectLike', path: 'system.attributes.ac.value' }], duration: { value: 1, unit: 'rounds' } },
      },
    });
    const entries = await computeSelfEffectVocabularyEntries(mkActor({ action: [item] }), 3);
    expect(entries).toEqual([
      { itemId: 'i1', slug: 'raise-a-shield', name: 'Raise a Shield', cost: 1, replacesStance: null, traits: [], effectSummary: 'value mod', durationLabel: '1 rounds', frequencyLabel: '1/hour' },
    ]);
  });

  it('excludes an item whose effect has an unresolved ChoiceSet', async () => {
    expect(await entriesFor('choice-feat', [{ key: 'ChoiceSet', flag: 'x', choices: [{ value: 'a' }] }])).toEqual([]);
  });

  it('excludes an item whose effect has a GrantItem rule', async () => {
    expect(await entriesFor('grant-feat', [{ key: 'GrantItem', uuid: 'Compendium.x' }])).toEqual([]);
  });

  it('excludes an item whose effect has a TokenMark rule', async () => {
    expect(await entriesFor('mark-feat', [{ key: 'TokenMark' }])).toEqual([]);
  });

  it('excludes an item whose effect rule predicate references a target: roll option', async () => {
    expect(await entriesFor('target-feat', [{ key: 'FlatModifier', selector: 'attack', predicate: ['target:undead'] }])).toEqual([]);
  });

  it('excludes an item whose effect rule references @target', async () => {
    expect(await entriesFor('at-target-feat', [{ key: 'FlatModifier', selector: 'attack', value: '@target.level' }])).toEqual([]);
  });

  it('excludes an item whose effect has no rules at all', async () => {
    expect(await entriesFor('empty-feat', [])).toEqual([]);
  });

  it('excludes an item whose effect lasts hours or days', async () => {
    expect(await entriesFor('long-feat', [{ key: 'FlatModifier', selector: 'ac' }], { value: 1, unit: 'hours' })).toEqual([]);
    expect(await entriesFor('longer-feat', [{ key: 'FlatModifier', selector: 'ac' }], { value: 1, unit: 'days' })).toEqual([]);
  });

  it('applies the effect-level checks to stances too (a stance whose effect has a ChoiceSet would open a dialog)', async () => {
    const item = selfEffectItem({ id: 's', slug: 'arcane-cascade', name: 'Arcane Cascade', traits: ['stance'] });
    installFromUuidStub({ 'Compendium.pf2e.feat-effects.Item.arcane-cascade': effectWith([{ key: 'ChoiceSet', flag: 'damageType', choices: [] }], { value: -1, unit: 'encounter' }) });
    expect(await computeSelfEffectVocabularyEntries(mkActor({ feat: [item] }), 3)).toEqual([]);
  });

  it('excludes a denylisted slug even though it passes every other check', async () => {
    expect(await entriesFor('repel-ambient-magic', [{ key: 'FlatModifier', selector: 'ac' }])).toEqual([]);
  });

  it('truncates to the 12 most relevant entries, tier 0 before tier 1 before tier 2, deterministically', async () => {
    const items = [];
    const effectsByUuid = {};
    const add = (slug, rules) => {
      items.push(selfEffectItem({ id: slug, slug, name: slug }));
      effectsByUuid[`Compendium.pf2e.feat-effects.Item.${slug}`] = { slug: `effect-${slug}`, system: { rules, duration: { value: 1, unit: 'rounds' } } };
    };
    // Interleaved so ordering is not just input order.
    for (let i = 0; i < 8; i += 1) {
      add(`tier2-${i}`, [{ key: 'Sense' }]);
      if (i < 3) add(`tier1-${i}`, [{ key: 'Resistance', type: 'fire' }]);
      add(`tier0-${i}`, [{ key: 'FlatModifier', selector: 'attack' }]);
    }
    installFromUuidStub(effectsByUuid);
    const actor = mkActor({ action: items });
    const entries = await computeSelfEffectVocabularyEntries(actor, 3);
    expect(entries.map((e) => e.slug)).toEqual([
      ...Array.from({ length: 8 }, (_, i) => `tier0-${i}`),
      'tier1-0', 'tier1-1', 'tier1-2',
      'tier2-0',
    ]);
    expect((await computeSelfEffectVocabularyEntries(actor, 3)).map((e) => e.slug)).toEqual(entries.map((e) => e.slug));
  });
});
