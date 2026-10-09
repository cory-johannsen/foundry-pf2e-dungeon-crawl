// tests/dungeon-combat-feat-self-effect-vocabulary.test.mjs
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { computeSelfEffectVocabularyEntries } from '../scripts/dungeon-combat.mjs';

// #910: the self-effect feat category (stances + Rage) -- eligibility is
// computed deterministically from real item data.

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

const effects = {
  [RAGE_EFFECT]: { slug: 'effect-rage' },
  'Compendium.pf2e.feat-effects.Item.gorilla': { slug: 'stance-gorilla-stance' },
  'Compendium.pf2e.feat-effects.Item.crane': { slug: 'stance-crane-stance' },
};

beforeEach(() => {
  globalThis.fromUuid = vi.fn(async (uuid) => effects[uuid] ?? null);
});

describe('computeSelfEffectVocabularyEntries', () => {
  it('includes Rage (not a stance-trait item) when its effect is not already active', async () => {
    const entries = await computeSelfEffectVocabularyEntries(mkActor({ action: [actionItem()] }), 3);
    expect(entries).toEqual([{ itemId: 'rage1', slug: 'rage', name: 'Rage', cost: 1, replacesStance: null, traits: [] }]);
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

  it('excludes a non-stance, non-Rage self-effect item (wider scope is #914)', async () => {
    const actor = mkActor({ feat: [actionItem({ id: 'x', slug: 'some-buff' })] });
    expect(await computeSelfEffectVocabularyEntries(actor, 3)).toEqual([]);
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
    expect(entries).toEqual([{ itemId: 'gorilla1', slug: 'gorilla-stance', name: 'Gorilla Stance', cost: 1, replacesStance: null, traits: ['stance'] }]);
  });

  it('flags replacesStance when the actor is already in a different stance (origin item has the stance trait)', async () => {
    globalThis.fromUuid.mockImplementation(async (uuid) => {
      if (uuid === 'Actor.a1.Item.crane-feat') return { system: { traits: { value: ['stance'] } } };
      return effects[uuid] ?? null;
    });
    const stanceItem = actionItem({ id: 'gorilla1', slug: 'gorilla-stance', name: 'Gorilla Stance', traits: ['stance'], selfEffectUuid: 'Compendium.pf2e.feat-effects.Item.gorilla' });
    const activeCrane = { id: 'effect-crane-id', slug: 'stance-crane-stance', system: { traits: { value: [] }, context: { origin: { item: 'Actor.a1.Item.crane-feat' } } } };
    const entries = await computeSelfEffectVocabularyEntries(mkActor({ feat: [stanceItem], effect: [activeCrane] }), 3);
    expect(entries).toEqual([{ itemId: 'gorilla1', slug: 'gorilla-stance', name: 'Gorilla Stance', cost: 1, replacesStance: 'effect-crane-id', traits: ['stance'] }]);
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
