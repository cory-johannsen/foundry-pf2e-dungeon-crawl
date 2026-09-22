import { describe, it, expect } from 'vitest';
import {
  isTreasureEligible,
  TREASURE_ELIGIBLE_TRAITS,
  LOOTABLE_ITEM_TYPES,
  rollNpcTreasure,
  TREASURE_GP_PER_LEVEL,
  ITEM_CHANCE,
  ITEM_PRICE_BUDGET_FRACTION,
  NPC_TREASURE_CATEGORY_WEIGHTS,
  nthLevelTableName,
  VALUABLE_TIERS,
  valuableTierForBudget,
  pickWeightedCategory,
} from '../scripts/treasure.mjs';

// A queue-based rng stub for tests that need controlled successive values
// (rollNpcTreasure calls rng() twice: once for the ITEM_CHANCE gate, once
// for the category pick) — the existing alwaysRoll/neverRoll constants only
// cover single-call cases.
function sequenceRng(values) {
  let i = 0;
  return () => values[i++ % values.length];
}

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
  const alwaysRoll = () => 0; // < any chance/threshold — always takes the branch
  const neverRoll = () => 0.999999; // > any chance/threshold — never takes it

  it('follows the documented gp-per-level formula', () => {
    const result = rollNpcTreasure({ level: 4, rng: neverRoll });
    expect(result.gp).toBe(Math.round(4 * TREASURE_GP_PER_LEVEL));
  });

  it('is 0 gp for level 0', () => {
    const result = rollNpcTreasure({ level: 0, rng: neverRoll });
    expect(result.gp).toBe(0);
  });

  it('never goes negative for a below-zero level input', () => {
    const result = rollNpcTreasure({ level: -1, rng: neverRoll });
    expect(result.gp).toBe(0);
  });

  it('never rolls a table draw when rng exceeds ITEM_CHANCE', () => {
    const result = rollNpcTreasure({ level: 5, rng: neverRoll });
    expect(result.tableName).toBeNull();
  });

  it('rolls a tableName when rng favors the ITEM_CHANCE gate', () => {
    const result = rollNpcTreasure({ level: 5, rng: alwaysRoll });
    expect(typeof result.tableName).toBe('string');
  });

  it('picks the consumable table when the category roll is low', () => {
    const result = rollNpcTreasure({ level: 5, rng: sequenceRng([0, 0]) });
    expect(result.tableName).toBe(nthLevelTableName('consumable', 5));
  });

  it('picks the permanent-item table when the category roll is mid-range', () => {
    const result = rollNpcTreasure({ level: 5, rng: sequenceRng([0, 0.7]) });
    expect(result.tableName).toBe(nthLevelTableName('permanent', 5));
  });

  it('picks a valuable tier table when the category roll is high', () => {
    const result = rollNpcTreasure({ level: 5, rng: sequenceRng([0, 0.9]) });
    const gp = Math.round(5 * TREASURE_GP_PER_LEVEL);
    expect(result.tableName).toBe(valuableTierForBudget(gp * ITEM_PRICE_BUDGET_FRACTION));
    expect(VALUABLE_TIERS.some((t) => t.name === result.tableName)).toBe(true);
  });
});

describe('nthLevelTableName', () => {
  it('uses the 1st/2nd/3rd-Level Consumables naming for levels 1-3', () => {
    expect(nthLevelTableName('consumable', 1)).toBe('1st-Level Consumables');
    expect(nthLevelTableName('consumable', 2)).toBe('2nd-Level Consumables');
    expect(nthLevelTableName('consumable', 3)).toBe('3rd-Level Consumables');
  });

  it('uses the Nth-Level Consumables Items naming for levels 4-19', () => {
    expect(nthLevelTableName('consumable', 4)).toBe('4th-Level Consumables Items');
    expect(nthLevelTableName('consumable', 19)).toBe('19th-Level Consumables Items');
  });

  it('uses the singular 20th-Level Consumable Items naming for level 20', () => {
    expect(nthLevelTableName('consumable', 20)).toBe('20th-Level Consumable Items');
  });

  it('uses the consistent Nth-Level Permanent Items naming for every level', () => {
    expect(nthLevelTableName('permanent', 1)).toBe('1st-Level Permanent Items');
    expect(nthLevelTableName('permanent', 20)).toBe('20th-Level Permanent Items');
  });

  it('clamps an out-of-range level into [1, 20]', () => {
    expect(nthLevelTableName('consumable', 0)).toBe('1st-Level Consumables');
    expect(nthLevelTableName('consumable', 25)).toBe('20th-Level Consumable Items');
  });
});

describe('valuableTierForBudget', () => {
  it('returns the cheapest tier when the budget is below all of them', () => {
    expect(valuableTierForBudget(0)).toBe(VALUABLE_TIERS[0].name);
  });

  it('returns a tier whose price the budget exactly matches', () => {
    expect(valuableTierForBudget(0.5)).toBe('Lesser Semiprecious Stones');
  });

  it('returns the lower tier when the budget falls between two tiers', () => {
    // Between Lesser Semiprecious Stones (0.5) and Minor Art Object (2)
    expect(valuableTierForBudget(1)).toBe('Lesser Semiprecious Stones');
  });

  it('returns the priciest tier for a very large budget', () => {
    expect(valuableTierForBudget(1_000_000)).toBe('Major Art Object');
  });
});

describe('pickWeightedCategory', () => {
  it('is present and used for NPC treasure category selection', () => {
    expect(NPC_TREASURE_CATEGORY_WEIGHTS.map((w) => w.category)).toEqual([
      'consumable',
      'permanent',
      'valuable',
    ]);
  });

  it('returns the first category at r=0', () => {
    const weights = [
      { category: 'a', weight: 1 },
      { category: 'b', weight: 1 },
    ];
    expect(pickWeightedCategory(weights, 0)).toBe('a');
  });

  it('returns the last category as r approaches 1', () => {
    const weights = [
      { category: 'a', weight: 1 },
      { category: 'b', weight: 1 },
    ];
    expect(pickWeightedCategory(weights, 0.999999)).toBe('b');
  });

  it('lands in the expected band for a mid-range r', () => {
    const weights = [
      { category: 'a', weight: 1 },
      { category: 'b', weight: 1 },
    ];
    expect(pickWeightedCategory(weights, 0.3)).toBe('a');
    expect(pickWeightedCategory(weights, 0.7)).toBe('b');
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
