// tests/dungeon-combat-npc-self-safety.test.mjs
import { describe, it, expect } from 'vitest';
import { __test__isUnsafeSelfEffectForNpc as isUnsafe } from '../scripts/dungeon-combat.mjs';

// #934: rule shapes mirror the installed system's real bestiary effects.
const ROUND = { unit: 'rounds', value: 1, expiry: 'turn-start', sustained: false };

describe('isUnsafeSelfEffectForNpc (#934)', () => {
  it("allows an inMemoryOnly GrantItem of a condition (Effect: Thesis Shield's Concealed)", () => {
    const rules = [
      { key: 'FlatModifier', selector: 'ac', type: 'circumstance', value: 2 },
      { key: 'GrantItem', inMemoryOnly: true, uuid: 'Compendium.pf2e.conditionitems.Item.DmAIPqOBomZ7H95W' },
    ];
    expect(isUnsafe(rules, ROUND)).toBe(false);
  });

  it('still excludes a GrantItem of a condition that is a real (not inMemoryOnly) item', () => {
    const rules = [{ key: 'GrantItem', uuid: 'Compendium.pf2e.conditionitems.Item.DmAIPqOBomZ7H95W', onDeleteActions: { grantee: 'restrict' } }];
    expect(isUnsafe(rules, ROUND)).toBe(true);
  });

  it('still excludes a GrantItem pointing anywhere other than conditionitems', () => {
    const rules = [{ key: 'GrantItem', inMemoryOnly: true, uuid: 'Compendium.pf2e.actionspf2e.Item.abc' }];
    expect(isUnsafe(rules, ROUND)).toBe(true);
  });

  it('still excludes an unresolved ChoiceSet (Invoke Rune) and a TokenMark (Hunt Prey)', () => {
    expect(isUnsafe([{ key: 'ChoiceSet', flag: 'rune' }], ROUND)).toBe(true);
    expect(isUnsafe([{ key: 'TokenMark', slug: 'prey' }], ROUND)).toBe(true);
  });

  it('excludes an hours/days duration (Nature\'s Infusion: 1 hour)', () => {
    expect(isUnsafe([{ key: 'TempHP', value: 15 }], { unit: 'hours', value: 1 })).toBe(true);
  });

  it('excludes a sustained effect (Droning Wings)', () => {
    expect(isUnsafe([{ key: 'Immunity', type: 'x' }], { unit: 'minutes', value: 1, sustained: true })).toBe(true);
  });

  it('excludes an unlimited duration unless the ability is a stance', () => {
    const rules = [{ key: 'Resistance', type: 'all', value: 10 }];
    const unlimited = { unit: 'unlimited', value: -1 };
    expect(isUnsafe(rules, unlimited)).toBe(true); // Harden Chitin
    expect(isUnsafe(rules, unlimited, { stance: true })).toBe(false); // a stance lasts the encounter
  });

  it('excludes an effect with no rules at all', () => {
    expect(isUnsafe([], ROUND)).toBe(true);
  });

  it('allows a plain timed modifier (Effect: Form a Phalanx)', () => {
    expect(isUnsafe([{ key: 'FlatModifier', selector: 'ac', type: 'circumstance', value: 2 }], ROUND)).toBe(false);
  });
});
