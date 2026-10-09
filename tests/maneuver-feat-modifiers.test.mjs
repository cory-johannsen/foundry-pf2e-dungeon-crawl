// tests/maneuver-feat-modifiers.test.mjs
import { describe, it, expect } from 'vitest';
import { MANEUVER_FEAT_MODIFIERS, eligibilityModifiers, ridersFor, maneuverMapPenalty } from '../scripts/maneuver-feat-modifiers.mjs';

describe('MANEUVER_FEAT_MODIFIERS', () => {
  it('lists exactly the four curated prose-only feats (#911 initial table)', () => {
    expect(Object.keys(MANEUVER_FEAT_MODIFIERS).sort()).toEqual(
      ['crushing-grab', 'sly-disarm', 'terrified-retreat', 'titan-wrestler'],
    );
  });
});

describe('eligibilityModifiers', () => {
  it('returns no modifiers for an actor with none of the maneuver-modifier feats', () => {
    expect(eligibilityModifiers([], { athleticsRank: 1, athleticsMod: 5, thieveryMod: 2 })).toEqual({
      sizeCapSteps: {}, skill: {},
    });
  });

  it('widens the size cap to 2 for Titan Wrestler at a non-legendary Athletics rank', () => {
    const result = eligibilityModifiers(['titan-wrestler'], { athleticsRank: 2, athleticsMod: 8, thieveryMod: 0 });
    expect(result.sizeCapSteps).toEqual({ trip: 2, shove: 2, grapple: 2, disarm: 2 });
  });

  it('widens the size cap to 3 for Titan Wrestler at legendary Athletics (rank 4)', () => {
    const result = eligibilityModifiers(['titan-wrestler'], { athleticsRank: 4, athleticsMod: 20, thieveryMod: 0 });
    expect(result.sizeCapSteps).toEqual({ trip: 3, shove: 3, grapple: 3, disarm: 3 });
  });

  it('never widens Demoralize (it has no size restriction at all)', () => {
    const result = eligibilityModifiers(['titan-wrestler'], { athleticsRank: 4 });
    expect('demoralize' in result.sizeCapSteps).toBe(false);
  });

  it('defaults an unreadable/missing Athletics rank to the non-legendary (2-step) case, never throwing', () => {
    const result = eligibilityModifiers(['titan-wrestler'], {});
    expect(result.sizeCapSteps.trip).toBe(2);
    expect(eligibilityModifiers(['titan-wrestler']).sizeCapSteps.trip).toBe(2);
    expect(eligibilityModifiers(['titan-wrestler'], { athleticsRank: 'legendary' }).sizeCapSteps.trip).toBe(2);
  });

  it('substitutes thievery for disarm only when Sly Disarm is present and Thievery modifies better', () => {
    const better = eligibilityModifiers(['sly-disarm'], { athleticsMod: 5, thieveryMod: 8 });
    expect(better.skill).toEqual({ disarm: 'thievery' });
    const worse = eligibilityModifiers(['sly-disarm'], { athleticsMod: 8, thieveryMod: 5 });
    expect(worse.skill).toEqual({});
    expect(eligibilityModifiers([], { athleticsMod: 0, thieveryMod: 9 }).skill).toEqual({});
  });

  it('prefers Athletics on a tie', () => {
    const tied = eligibilityModifiers(['sly-disarm'], { athleticsMod: 5, thieveryMod: 5 });
    expect(tied.skill).toEqual({});
  });

  it('never substitutes when the Thievery modifier is unreadable', () => {
    expect(eligibilityModifiers(['sly-disarm'], { athleticsMod: 5 }).skill).toEqual({});
    expect(eligibilityModifiers(['sly-disarm'], { athleticsMod: 5, thieveryMod: NaN }).skill).toEqual({});
  });

  it('combines Titan Wrestler and Sly Disarm together', () => {
    const result = eligibilityModifiers(['titan-wrestler', 'sly-disarm'], { athleticsRank: 2, athleticsMod: 5, thieveryMod: 9 });
    expect(result.sizeCapSteps.disarm).toBe(2);
    expect(result.skill.disarm).toBe('thievery');
  });

  it('ignores unknown feat slugs and non-array input', () => {
    expect(eligibilityModifiers(['some-unrelated-feat'], { athleticsRank: 4 })).toEqual({ sizeCapSteps: {}, skill: {} });
    expect(eligibilityModifiers(undefined)).toEqual({ sizeCapSteps: {}, skill: {} });
  });
});

describe('ridersFor', () => {
  it('offers crushingGrabDamage for grapple success/criticalSuccess only, when the feat is present', () => {
    expect(ridersFor(['crushing-grab'], 'grapple', 'success', 'athletics')).toEqual([{ type: 'crushingGrabDamage' }]);
    expect(ridersFor(['crushing-grab'], 'grapple', 'criticalSuccess', 'athletics')).toEqual([{ type: 'crushingGrabDamage' }]);
    expect(ridersFor(['crushing-grab'], 'grapple', 'failure', 'athletics')).toEqual([]);
    expect(ridersFor(['crushing-grab'], 'grapple', 'criticalFailure', 'athletics')).toEqual([]);
    expect(ridersFor([], 'grapple', 'success', 'athletics')).toEqual([]);
  });

  it('offers crushingGrabDamage only for grapple, never for another slug', () => {
    expect(ridersFor(['crushing-grab'], 'trip', 'success', 'athletics')).toEqual([]);
  });

  it('offers slyDisarmOffGuard only when Thievery was the skill actually used, and only on a success/criticalSuccess disarm', () => {
    expect(ridersFor(['sly-disarm'], 'disarm', 'success', 'thievery')).toEqual([{ type: 'slyDisarmOffGuard' }]);
    expect(ridersFor(['sly-disarm'], 'disarm', 'criticalSuccess', 'thievery')).toEqual([{ type: 'slyDisarmOffGuard' }]);
    expect(ridersFor(['sly-disarm'], 'disarm', 'success', 'athletics')).toEqual([]);
    expect(ridersFor(['sly-disarm'], 'disarm', 'failure', 'thievery')).toEqual([]);
  });

  it('offers terrifiedRetreatFleeing only on a critical success demoralize against a lower-level target', () => {
    const levels = { actorLevel: 7, targetLevel: 5 };
    expect(ridersFor(['terrified-retreat'], 'demoralize', 'criticalSuccess', 'intimidation', levels)).toEqual([{ type: 'terrifiedRetreatFleeing' }]);
    expect(ridersFor(['terrified-retreat'], 'demoralize', 'success', 'intimidation', levels)).toEqual([]);
    expect(ridersFor([], 'demoralize', 'criticalSuccess', 'intimidation', levels)).toEqual([]);
  });

  it('withholds Fleeing when the target is not lower level than the actor, or a level is unreadable', () => {
    const r = (ctx) => ridersFor(['terrified-retreat'], 'demoralize', 'criticalSuccess', 'intimidation', ctx);
    expect(r({ actorLevel: 7, targetLevel: 7 })).toEqual([]);
    expect(r({ actorLevel: 7, targetLevel: 9 })).toEqual([]);
    expect(r({ actorLevel: 7 })).toEqual([]);
    expect(r(undefined)).toEqual([]);
  });

  it('accumulates rather than short-circuiting after the first match', () => {
    const riders = ridersFor(['crushing-grab', 'sly-disarm'], 'disarm', 'success', 'thievery');
    expect(riders).toEqual([{ type: 'slyDisarmOffGuard' }]);
  });

  it('returns an empty array for an unknown feat slug or unknown maneuver slug', () => {
    expect(ridersFor(['some-unrelated-feat'], 'trip', 'success', 'athletics')).toEqual([]);
    expect(ridersFor(['crushing-grab'], 'reposition', 'success', 'athletics')).toEqual([]);
    expect(ridersFor(undefined, 'grapple', 'success', 'athletics')).toEqual([]);
  });
});

describe('maneuverMapPenalty (#919)', () => {
  it('is 0 on the first attack regardless of everything else', () => {
    expect(maneuverMapPenalty({ attackNumber: 1, weaponIsAgile: true, featSlugs: ['agile-maneuvers'], hasPanache: true })).toBe(0);
    expect(maneuverMapPenalty({ attackNumber: 1, weaponIsAgile: false })).toBe(0);
  });

  it("matches #940's baseline with no Agile Maneuvers: -5/-10 standard, -4/-8 agile weapon", () => {
    expect(maneuverMapPenalty({ attackNumber: 2, weaponIsAgile: false, featSlugs: [] })).toBe(-5);
    expect(maneuverMapPenalty({ attackNumber: 2, weaponIsAgile: true, featSlugs: [] })).toBe(-4);
    expect(maneuverMapPenalty({ attackNumber: 3, weaponIsAgile: false, featSlugs: [] })).toBe(-10);
    expect(maneuverMapPenalty({ attackNumber: 3, weaponIsAgile: true, featSlugs: [] })).toBe(-8);
    expect(maneuverMapPenalty({ attackNumber: 5, weaponIsAgile: false, featSlugs: [] })).toBe(-10);
  });

  it('applies the flat -4/-8 Agile Maneuvers value when the weapon is not agile', () => {
    expect(maneuverMapPenalty({ attackNumber: 2, weaponIsAgile: false, featSlugs: ['agile-maneuvers'] })).toBe(-4);
    expect(maneuverMapPenalty({ attackNumber: 3, weaponIsAgile: false, featSlugs: ['agile-maneuvers'] })).toBe(-8);
    expect(maneuverMapPenalty({ attackNumber: 4, weaponIsAgile: false, featSlugs: ['agile-maneuvers'] })).toBe(-8);
  });

  it('applies -4/-8 when the weapon IS agile but Panache is not active', () => {
    expect(maneuverMapPenalty({ attackNumber: 2, weaponIsAgile: true, featSlugs: ['agile-maneuvers'], hasPanache: false })).toBe(-4);
    expect(maneuverMapPenalty({ attackNumber: 3, weaponIsAgile: true, featSlugs: ['agile-maneuvers'], hasPanache: false })).toBe(-8);
  });

  it('applies -4/-8, not -3/-6, when Panache is active but the weapon is not agile', () => {
    expect(maneuverMapPenalty({ attackNumber: 2, weaponIsAgile: false, featSlugs: ['agile-maneuvers'], hasPanache: true })).toBe(-4);
    expect(maneuverMapPenalty({ attackNumber: 3, weaponIsAgile: false, featSlugs: ['agile-maneuvers'], hasPanache: true })).toBe(-8);
  });

  it('applies -3/-6 only when the weapon is agile AND Panache is active', () => {
    expect(maneuverMapPenalty({ attackNumber: 2, weaponIsAgile: true, featSlugs: ['agile-maneuvers'], hasPanache: true })).toBe(-3);
    expect(maneuverMapPenalty({ attackNumber: 3, weaponIsAgile: true, featSlugs: ['agile-maneuvers'], hasPanache: true })).toBe(-6);
  });

  it('Panache without the feat changes nothing', () => {
    expect(maneuverMapPenalty({ attackNumber: 2, weaponIsAgile: true, featSlugs: [], hasPanache: true })).toBe(-4);
  });

  it('the feat never makes the penalty worse than the baseline, for every combination', () => {
    for (const attackNumber of [1, 2, 3, 4]) {
      for (const weaponIsAgile of [false, true]) {
        for (const hasPanache of [false, true]) {
          const base = maneuverMapPenalty({ attackNumber, weaponIsAgile, featSlugs: [], hasPanache });
          const feat = maneuverMapPenalty({ attackNumber, weaponIsAgile, featSlugs: ['agile-maneuvers'], hasPanache });
          expect(feat).toBeGreaterThanOrEqual(base);
        }
      }
    }
  });

  it('ignores an unrelated feat slug, applying only the baseline', () => {
    expect(maneuverMapPenalty({ attackNumber: 2, weaponIsAgile: false, featSlugs: ['some-other-feat'] })).toBe(-5);
  });

  it('defaults featSlugs/hasPanache and tolerates non-array featSlugs, falling back to baseline', () => {
    expect(maneuverMapPenalty({ attackNumber: 2, weaponIsAgile: false })).toBe(-5);
    expect(maneuverMapPenalty({ attackNumber: 2, weaponIsAgile: false, featSlugs: null })).toBe(-5);
    expect(maneuverMapPenalty({ attackNumber: 3, weaponIsAgile: true, featSlugs: 'agile-maneuvers' })).toBe(-8);
  });
});
