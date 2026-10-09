// tests/self-effect-denylist.test.mjs
import { describe, it, expect } from 'vitest';
import { SELF_EFFECT_DENYLIST } from '../scripts/self-effect-denylist.mjs';

describe('SELF_EFFECT_DENYLIST', () => {
  it('contains exactly the 10 slugs the owner reviewed and approved during this plan\'s own writing', () => {
    expect([...SELF_EFFECT_DENYLIST].sort()).toEqual(
      [
        'consolidated-overlay-panopticon',
        'dissolutions-sight',
        'echoes-in-stone',
        'meddling-futures',
        'radiant-circuitry',
        'reckless-abandon',
        'repel-ambient-magic',
        'shadow-sight',
        'tap-the-past',
        'wish-for-luck',
      ].sort(),
    );
  });
});
