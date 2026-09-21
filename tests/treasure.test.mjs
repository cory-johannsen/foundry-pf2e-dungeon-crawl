import { describe, it, expect } from 'vitest';
import {
  isTreasureEligible,
  TREASURE_ELIGIBLE_TRAITS,
  LOOTABLE_ITEM_TYPES,
  rollNpcTreasure,
  TREASURE_GP_PER_LEVEL,
  ITEM_CHANCE,
  ITEM_PRICE_BUDGET_FRACTION,
} from '../scripts/treasure.mjs';

describe('isTreasureEligible', () => {
  it('is true for a humanoid', () => {
    expect(isTreasureEligible(['humanoid', 'human'])).toBe(true);
  });

  it('is true for each eligible trait on its own', () => {
    for (const trait of TREASURE_ELIGIBLE_TRAITS) {
      expect(isTreasureEligible([trait])).toBe(true);
    }
  });

  it('is false for an animal with no eligible trait', () => {
    expect(isTreasureEligible(['animal', 'beast'])).toBe(false);
  });

  it('is false for no traits at all', () => {
    expect(isTreasureEligible([])).toBe(false);
    expect(isTreasureEligible(undefined)).toBe(false);
  });
});

describe('rollNpcTreasure', () => {
  const fakeIndex = [
    { id: 'cheap-dagger', pack: 'pf2e.equipment-srd', level: 0, priceGp: 2 },
    { id: 'mid-sword', pack: 'pf2e.equipment-srd', level: 3, priceGp: 30 },
    { id: 'pricey-wand', pack: 'pf2e.equipment-srd', level: 10, priceGp: 500 },
  ];
  const alwaysRoll = () => 0; // < any chance/threshold — always takes the branch
  const neverRoll = () => 0.999999; // > any chance/threshold — never takes it

  it('follows the documented gp-per-level formula', () => {
    const result = rollNpcTreasure({ level: 4, index: [], rng: neverRoll });
    expect(result.gp).toBe(Math.round(4 * TREASURE_GP_PER_LEVEL));
  });

  it('is 0 gp for level 0', () => {
    const result = rollNpcTreasure({ level: 0, index: [], rng: neverRoll });
    expect(result.gp).toBe(0);
  });

  it('never goes negative for a below-zero level input', () => {
    const result = rollNpcTreasure({ level: -1, index: [], rng: neverRoll });
    expect(result.gp).toBe(0);
  });

  it('never rolls an item when rng exceeds ITEM_CHANCE', () => {
    const result = rollNpcTreasure({ level: 5, index: fakeIndex, rng: neverRoll });
    expect(result.itemRef).toBeNull();
  });

  it('rolls an item within the level/price budget when rng favors it', () => {
    const result = rollNpcTreasure({ level: 5, index: fakeIndex, rng: alwaysRoll });
    expect(result.itemRef).not.toBeNull();
    expect(result.itemRef.id).toBe('cheap-dagger');
  });

  it('never selects an item above the level or price ceiling', () => {
    // level 1 with a small gp budget should never reach the level-10, 500gp wand
    const result = rollNpcTreasure({ level: 1, index: fakeIndex, rng: alwaysRoll });
    expect(result.itemRef?.id).not.toBe('pricey-wand');
  });

  it('is null when no candidate in the index fits the budget', () => {
    const result = rollNpcTreasure({
      level: 0,
      index: [{ id: 'too-pricey', pack: 'pf2e.equipment-srd', level: 0, priceGp: 999 }],
      rng: alwaysRoll,
    });
    expect(result.itemRef).toBeNull();
  });
});

describe('LOOTABLE_ITEM_TYPES', () => {
  it('includes the core tangible item types', () => {
    for (const t of ['weapon', 'armor', 'equipment', 'consumable', 'treasure']) {
      expect(LOOTABLE_ITEM_TYPES).toContain(t);
    }
  });

  it('excludes creature-feature item types', () => {
    for (const t of ['spell', 'spellcastingEntry', 'melee', 'action', 'lore', 'feat']) {
      expect(LOOTABLE_ITEM_TYPES).not.toContain(t);
    }
  });
});
