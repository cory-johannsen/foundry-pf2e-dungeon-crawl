// tests/dungeon-combat-feat-composite-vocabulary.test.mjs
import { describe, it, expect } from 'vitest';
import { computeCompositeVocabularyEntries } from '../scripts/dungeon-combat.mjs';

// #910: the curated composite-feat allowlist (Sudden Charge, Lunge, Twin
// Feint) -- each feat's own requirement checked against real strike data.

function weapon({ id = 'sword1', slug = 'longsword', category = 'martial', range = null, handsHeld = 1, carryType = 'held' } = {}) {
  return { id, slug, type: 'weapon', system: { category, range, equipped: { carryType, handsHeld }, traits: { value: [] } } };
}

function strike(item, { traits = [], ready = true } = {}) {
  return { type: 'strike', ready, item, slug: item.slug, label: item.slug, traits };
}

function feat({ id, slug, name, cost = 1, traits = [], frequency = null }) {
  return { id, slug, name, system: { actionType: { value: 'action' }, actions: { value: cost }, traits: { value: traits }, frequency } };
}

function mkActor({ feats = [], actions = [], speed = 25, type = 'character' } = {}) {
  return { type, itemTypes: { feat: feats }, system: { actions, movement: { speeds: { land: { value: speed } } } } };
}

const LUNGE = feat({ id: 'f1', slug: 'lunge', name: 'Lunge' });
const CHARGE = feat({ id: 'f2', slug: 'sudden-charge', name: 'Sudden Charge', cost: 2, traits: ['barbarian', 'fighter', 'flourish'] });
const TWIN = feat({ id: 'f3', slug: 'twin-feint', name: 'Twin Feint', cost: 2, traits: ['rogue'] });

const opp = (id, distanceSquares, hasLineOfSight = true) => ({ id, name: id, distanceSquares, hasLineOfSight });

describe('computeCompositeVocabularyEntries', () => {
  it('offers Lunge against an opponent exactly 5 ft beyond the melee weapon\'s reach', () => {
    const actor = mkActor({ feats: [LUNGE], actions: [strike(weapon())] });
    expect(computeCompositeVocabularyEntries(actor, [opp('near', 1), opp('lunge', 2), opp('far', 3)], 3)).toEqual([
      { itemId: 'f1', slug: 'lunge', name: 'Lunge', cost: 1, targetId: 'lunge', traits: [] },
    ]);
  });

  it('uses a reach weapon\'s own reach for Lunge (10 ft reach -> 15 ft lunge)', () => {
    const glaive = weapon({ id: 'glaive1', slug: 'glaive', handsHeld: 2 });
    const actor = mkActor({ feats: [LUNGE], actions: [strike(glaive, { traits: [{ name: 'reach-10' }] })] });
    expect(computeCompositeVocabularyEntries(actor, [opp('a', 2), opp('b', 3)], 3).map((e) => e.targetId)).toEqual(['b']);
  });

  it('does not offer Lunge without a ready melee weapon (ranged weapon, unarmed attack, or unready strike)', () => {
    const bow = weapon({ id: 'bow1', slug: 'shortbow', range: 60 });
    const fist = weapon({ id: 'fist', slug: 'fist', category: 'unarmed', carryType: 'worn', handsHeld: 0 });
    for (const actions of [[], [strike(bow)], [strike(fist)], [strike(weapon(), { ready: false })]]) {
      expect(computeCompositeVocabularyEntries(mkActor({ feats: [LUNGE], actions }), [opp('o', 2)], 3)).toEqual([]);
    }
  });

  it('does not offer Lunge against an opponent out of line of sight', () => {
    const actor = mkActor({ feats: [LUNGE], actions: [strike(weapon())] });
    expect(computeCompositeVocabularyEntries(actor, [opp('o', 2, false)], 3)).toEqual([]);
  });

  it('offers Sudden Charge against an opponent reachable after two Strides, not against one already in reach', () => {
    const actor = mkActor({ feats: [CHARGE], actions: [strike(weapon())], speed: 25 });
    // 25 ft speed = 5 squares per Stride, 10 over two; + 1 square reach.
    expect(computeCompositeVocabularyEntries(actor, [opp('adj', 1), opp('mid', 6), opp('edge', 11), opp('far', 12)], 3)).toEqual([
      { itemId: 'f2', slug: 'sudden-charge', name: 'Sudden Charge', cost: 2, targetId: 'mid', traits: ['flourish'] },
      { itemId: 'f2', slug: 'sudden-charge', name: 'Sudden Charge', cost: 2, targetId: 'edge', traits: ['flourish'] },
    ]);
  });

  it('lets Sudden Charge use an unarmed melee Strike', () => {
    const fist = weapon({ id: 'fist', slug: 'fist', category: 'unarmed', carryType: 'worn', handsHeld: 0 });
    const actor = mkActor({ feats: [CHARGE], actions: [strike(fist)] });
    expect(computeCompositeVocabularyEntries(actor, [opp('o', 4)], 3).length).toBe(1);
  });

  it('does not offer Sudden Charge when its cost exceeds actionsRemaining', () => {
    const actor = mkActor({ feats: [CHARGE], actions: [strike(weapon())] });
    expect(computeCompositeVocabularyEntries(actor, [opp('o', 4)], 1)).toEqual([]);
  });

  it('offers Twin Feint with two different one-handed held melee weapons, against an opponent in reach of both', () => {
    const sword = weapon({ id: 'sword1', slug: 'shortsword' });
    const dagger = weapon({ id: 'dagger1', slug: 'dagger' });
    const actor = mkActor({ feats: [TWIN], actions: [strike(sword), strike(dagger)] });
    expect(computeCompositeVocabularyEntries(actor, [opp('adj', 1), opp('far', 2)], 3)).toEqual([
      { itemId: 'f3', slug: 'twin-feint', name: 'Twin Feint', cost: 2, targetId: 'adj', traits: [] },
    ]);
  });

  it('does not offer Twin Feint with only one distinct weapon item', () => {
    const sword = weapon({ id: 'sword1', slug: 'shortsword' });
    const actor = mkActor({ feats: [TWIN], actions: [strike(sword), strike(sword)] });
    expect(computeCompositeVocabularyEntries(actor, [opp('adj', 1)], 3)).toEqual([]);
  });

  it('does not offer Twin Feint when a weapon is held two-handed or not held (fist)', () => {
    const greatsword = weapon({ id: 'gs', slug: 'greatsword', handsHeld: 2 });
    const dagger = weapon({ id: 'dagger1', slug: 'dagger' });
    const fist = weapon({ id: 'fist', slug: 'fist', category: 'unarmed', carryType: 'worn', handsHeld: 0 });
    expect(computeCompositeVocabularyEntries(mkActor({ feats: [TWIN], actions: [strike(greatsword), strike(dagger)] }), [opp('adj', 1)], 3)).toEqual([]);
    expect(computeCompositeVocabularyEntries(mkActor({ feats: [TWIN], actions: [strike(fist), strike(dagger)] }), [opp('adj', 1)], 3)).toEqual([]);
  });

  it('excludes a feat whose frequency is exhausted', () => {
    const limited = feat({ id: 'f1', slug: 'lunge', name: 'Lunge', frequency: { value: 0, max: 1, per: 'round' } });
    expect(computeCompositeVocabularyEntries(mkActor({ feats: [limited], actions: [strike(weapon())] }), [opp('o', 2)], 3)).toEqual([]);
  });

  it('returns an empty array for a non-character actor or an actor with none of the three feats', () => {
    expect(computeCompositeVocabularyEntries(mkActor({ feats: [LUNGE], actions: [strike(weapon())], type: 'npc' }), [opp('o', 2)], 3)).toEqual([]);
    expect(computeCompositeVocabularyEntries(mkActor({ actions: [strike(weapon())] }), [opp('o', 1)], 3)).toEqual([]);
  });
});
