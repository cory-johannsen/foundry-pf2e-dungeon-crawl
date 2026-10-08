// tests/dungeon-combat-maneuver-vocabulary.test.mjs
import { describe, it, expect } from 'vitest';
import {
  computeManeuverAttackerProfile,
  sizeOkForManeuver,
  getDemoralizeImmunityUntil,
  setDemoralizeImmunityUntil,
  immuneToDemoralize,
} from '../scripts/dungeon-combat.mjs';

function combatStub(flags = {}) {
  const store = { ...flags };
  return {
    getFlag: (_m, key) => store[key],
    setFlag: async (_m, key, value) => {
      store[key] = value;
    },
  };
}

describe('computeManeuverAttackerProfile', () => {
  it('is eligible for all five maneuvers for an NPC with Athletics/Intimidation and no handsFree getter at all', () => {
    const actor = { skills: { athletics: {}, intimidation: {} }, itemTypes: { weapon: [] } };
    const profile = computeManeuverAttackerProfile(actor);
    expect(profile.trip.eligible).toBe(true);
    expect(profile.shove.eligible).toBe(true);
    expect(profile.grapple.eligible).toBe(true);
    expect(profile.disarm.eligible).toBe(true);
    expect(profile.demoralize.eligible).toBe(true);
  });

  it('is ineligible for the four Athletics maneuvers without the Athletics skill, but still eligible for Demoralize with Intimidation', () => {
    const actor = { skills: { intimidation: {} }, itemTypes: { weapon: [] } };
    const profile = computeManeuverAttackerProfile(actor);
    expect(profile.trip.eligible).toBe(false);
    expect(profile.demoralize.eligible).toBe(true);
  });

  it('is ineligible for Demoralize without the Intimidation skill', () => {
    const actor = { skills: { athletics: {} }, itemTypes: { weapon: [] } };
    expect(computeManeuverAttackerProfile(actor).demoralize.eligible).toBe(false);
  });

  it('is ineligible for Athletics maneuvers for a character actor (handsFree getter present) with no free hand and no matching weapon', () => {
    const actor = { skills: { athletics: {} }, handsFree: 0, itemTypes: { weapon: [] } };
    expect(computeManeuverAttackerProfile(actor).trip.eligible).toBe(false);
  });

  it('is eligible for a character actor with a free hand', () => {
    const actor = { skills: { athletics: {} }, handsFree: 1, itemTypes: { weapon: [] } };
    expect(computeManeuverAttackerProfile(actor).trip.eligible).toBe(true);
  });

  it('is eligible for a character actor with no free hand but a held weapon carrying the matching trait', () => {
    const actor = {
      skills: { athletics: {} },
      handsFree: 0,
      itemTypes: { weapon: [{ system: { equipped: { carryType: 'held' }, traits: { value: ['trip'] } } }] },
    };
    expect(computeManeuverAttackerProfile(actor).trip.eligible).toBe(true);
    expect(computeManeuverAttackerProfile(actor).shove.eligible).toBe(false);
  });

  it('uses melee reach for the four Athletics maneuvers and the fixed 30ft range for Demoralize', () => {
    const actor = { skills: { athletics: {}, intimidation: {} }, itemTypes: { weapon: [] } };
    const profile = computeManeuverAttackerProfile(actor);
    expect(profile.trip.reachSquares).toBe(1);
    expect(profile.demoralize.reachSquares).toBe(6);
  });
});

describe('sizeOkForManeuver', () => {
  it('allows a same-size target', () => {
    const med = { system: { traits: { size: { value: 'med' } } } };
    expect(sizeOkForManeuver(med, med)).toBe(true);
  });

  it('allows a target exactly one size larger', () => {
    const med = { system: { traits: { size: { value: 'med' } } } };
    const lg = { system: { traits: { size: { value: 'lg' } } } };
    expect(sizeOkForManeuver(med, lg)).toBe(true);
  });

  it('disallows a target more than one size larger', () => {
    const med = { system: { traits: { size: { value: 'med' } } } };
    const huge = { system: { traits: { size: { value: 'huge' } } } };
    expect(sizeOkForManeuver(med, huge)).toBe(false);
  });

  it('allows a smaller target regardless of the size gap', () => {
    const grg = { system: { traits: { size: { value: 'grg' } } } };
    const tiny = { system: { traits: { size: { value: 'tiny' } } } };
    expect(sizeOkForManeuver(grg, tiny)).toBe(true);
  });

  it('defaults to allowed when either actor has no readable size', () => {
    expect(sizeOkForManeuver({}, {})).toBe(true);
  });
});

describe('demoralize immunity tracking', () => {
  it('reads back 0 when nothing has been set yet', () => {
    const combat = combatStub();
    expect(getDemoralizeImmunityUntil(combat, 'atk1', 'opp1')).toBe(0);
  });

  it('round-trips a set value for the exact attacker/target pair', async () => {
    const combat = combatStub();
    await setDemoralizeImmunityUntil(combat, 'atk1', 'opp1', 1600);
    expect(getDemoralizeImmunityUntil(combat, 'atk1', 'opp1')).toBe(1600);
    expect(getDemoralizeImmunityUntil(combat, 'atk1', 'opp2')).toBe(0);
    expect(getDemoralizeImmunityUntil(combat, 'atk2', 'opp1')).toBe(0);
  });

  it('preserves an existing entry for a different attacker/target pair when adding a new one', async () => {
    const combat = combatStub();
    await setDemoralizeImmunityUntil(combat, 'atk1', 'opp1', 1600);
    await setDemoralizeImmunityUntil(combat, 'atk1', 'opp2', 1700);
    expect(getDemoralizeImmunityUntil(combat, 'atk1', 'opp1')).toBe(1600);
    expect(getDemoralizeImmunityUntil(combat, 'atk1', 'opp2')).toBe(1700);
  });
});

describe('immuneToDemoralize', () => {
  it('is true for a target immune to mental effects (e.g. a mindless creature)', () => {
    expect(immuneToDemoralize({ attributes: { immunities: [{ type: 'mental' }] } })).toBe(true);
  });

  it('is true for a target immune to fear effects or emotion', () => {
    expect(immuneToDemoralize({ attributes: { immunities: [{ type: 'fear-effects' }] } })).toBe(true);
    expect(immuneToDemoralize({ attributes: { immunities: [{ type: 'emotion' }] } })).toBe(true);
  });

  it('is false for a target with unrelated or no immunities', () => {
    expect(immuneToDemoralize({ attributes: { immunities: [{ type: 'fire' }] } })).toBe(false);
    expect(immuneToDemoralize({})).toBe(false);
  });
});
