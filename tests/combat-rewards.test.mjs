import { describe, it, expect } from 'vitest';
import { totalCombatXp, xpPerSurvivor } from '../scripts/combat-rewards.mjs';
import { xpFor } from '../scripts/encounter-roster.mjs';

describe('totalCombatXp', () => {
  it('sums xpFor(level - partyLevel) across every defeated hostile', () => {
    const partyLevel = 5;
    const levels = [3, 5, 7];
    const expected = levels.reduce((sum, lvl) => sum + xpFor(lvl - partyLevel), 0);
    expect(totalCombatXp(levels, partyLevel)).toBe(expected);
  });

  it('is 0 for no defeated hostiles', () => {
    expect(totalCombatXp([], 5)).toBe(0);
  });

  it('handles a single hostile at exactly party level', () => {
    expect(totalCombatXp([5], 5)).toBe(xpFor(0));
  });
});

describe('xpPerSurvivor', () => {
  it('divides and floors', () => {
    expect(xpPerSurvivor(100, 3)).toBe(33);
  });

  it('is 0 when there are no survivors', () => {
    expect(xpPerSurvivor(100, 0)).toBe(0);
  });

  it('is exact when it divides evenly', () => {
    expect(xpPerSurvivor(120, 4)).toBe(30);
  });
});
