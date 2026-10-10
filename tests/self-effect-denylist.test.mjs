// tests/self-effect-denylist.test.mjs
import { describe, it, expect } from 'vitest';
import { SELF_EFFECT_DENYLIST } from '../scripts/self-effect-denylist.mjs';

describe('SELF_EFFECT_DENYLIST', () => {
  // #914's 10 owner-reviewed slugs, plus #946's eye-of-the-arclords (its
  // afterwards-dazzled drawback isn't part of its linked effect).
  it('contains exactly the 10 slugs the owner reviewed for #914 plus #946\'s eye-of-the-arclords', () => {
    expect([...SELF_EFFECT_DENYLIST].sort()).toEqual(
      [
        'consolidated-overlay-panopticon',
        'dissolutions-sight',
        'echoes-in-stone',
        'eye-of-the-arclords',
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
