// tests/self-effect-summary.test.mjs
import { describe, it, expect } from 'vitest';
import { summarizeEffect, effectDurationLabel, effectRelevanceTier } from '../scripts/self-effect-summary.mjs';

describe('summarizeEffect', () => {
  it('labels a FlatModifier by its own selector', () => {
    expect(summarizeEffect([{ key: 'FlatModifier', selector: 'ac' }])).toBe('+ac');
  });

  it('labels DamageDice, TempHP, Resistance, BaseSpeed, AdjustStrike with their fixed labels', () => {
    expect(summarizeEffect([{ key: 'DamageDice' }])).toBe('+damage dice');
    expect(summarizeEffect([{ key: 'TempHP' }])).toBe('temp HP');
    expect(summarizeEffect([{ key: 'Resistance', type: 'fire' }])).toBe('resist fire');
    expect(summarizeEffect([{ key: 'BaseSpeed' }])).toBe('+speed');
    expect(summarizeEffect([{ key: 'AdjustStrike' }])).toBe('strike adj');
  });

  it('combines multiple rule labels, deduplicated, in rule order', () => {
    expect(summarizeEffect([{ key: 'FlatModifier', selector: 'attack' }, { key: 'DamageDice' }])).toBe('+attack, +damage dice');
  });

  it('falls back to a generic label for an unrecognized rule key, never throwing', () => {
    expect(summarizeEffect([{ key: 'SomeBrandNewRuleKey' }])).toBe('SomeBrandNewRuleKey');
  });

  it('returns a fixed "(no mechanical rules)" label for an empty rules array', () => {
    expect(summarizeEffect([])).toBe('(no mechanical rules)');
  });
});

describe('effectDurationLabel', () => {
  it('labels unlimited and encounter-scoped durations by name', () => {
    expect(effectDurationLabel({ unit: 'unlimited' })).toBe('unlimited');
    expect(effectDurationLabel({ unit: 'encounter' })).toBe('until encounter ends');
  });

  it('labels a numbered duration with its own value and unit', () => {
    expect(effectDurationLabel({ value: 1, unit: 'rounds' })).toBe('1 rounds');
    expect(effectDurationLabel({ value: 10, unit: 'minutes' })).toBe('10 minutes');
  });

  it('labels a missing duration as unknown, never throwing', () => {
    expect(effectDurationLabel(null)).toBe('unknown');
    expect(effectDurationLabel(undefined)).toBe('unknown');
  });
});

describe('effectRelevanceTier', () => {
  it('ranks an attack/damage/speed modifier at tier 0', () => {
    expect(effectRelevanceTier([{ key: 'FlatModifier', selector: 'attack' }])).toBe(0);
    expect(effectRelevanceTier([{ key: 'DamageDice' }])).toBe(0);
    expect(effectRelevanceTier([{ key: 'BaseSpeed' }])).toBe(0);
  });

  it('ranks a resistance-only effect at tier 1', () => {
    expect(effectRelevanceTier([{ key: 'Resistance', type: 'fire' }])).toBe(1);
  });

  it('ranks everything else at tier 2', () => {
    expect(effectRelevanceTier([{ key: 'Sense' }])).toBe(2);
    expect(effectRelevanceTier([{ key: 'RollOption' }])).toBe(2);
  });

  it('ranks a mixed rule set by its most relevant rule (tier 0 beats tier 1 beats tier 2)', () => {
    expect(effectRelevanceTier([{ key: 'Resistance', type: 'fire' }, { key: 'DamageDice' }])).toBe(0);
    expect(effectRelevanceTier([{ key: 'Sense' }, { key: 'Resistance', type: 'fire' }])).toBe(1);
  });
});
