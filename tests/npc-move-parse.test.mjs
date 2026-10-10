// tests/npc-move-parse.test.mjs
import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import { parseMovementAbility, npcMoveBudget, describeNpcMove } from '../scripts/npc-move-parse.mjs';

// #932: every description below is real, unedited compendium text (pf2e
// 8.5.0 source data), read from the coverage slice fixture.
const { entries } = JSON.parse(
  readFileSync(new URL('./fixtures/npc-move-ability-slice.json', import.meta.url), 'utf8'),
);
const item = (actor, name) => {
  const entry = entries.find((e) => e.actor === actor && e.name === name);
  if (!entry) throw new Error(`fixture has no ${actor}: ${name}`);
  return entry.item;
};
const parse = (actor, name) => parseMovementAbility(item(actor, name));

describe('parseMovementAbility (#932)', () => {
  it('Gallop: two Strides, each with a +10-foot circumstance bonus', () => {
    const d = parse('Riding Horse', 'Gallop');
    expect(d.cost).toBe(2);
    expect(d.plan).toMatchObject({
      kind: 'move', modes: ['land'], speedFactor: 1, repeat: 2, bonusFeet: 10, bonusType: 'circumstance',
      strike: null, suppressReactions: false, straightLine: false,
    });
  });

  it("the pegasus' Gallop: two move actions, each a Stride or a Fly, +20 feet", () => {
    expect(parse('Pegasus', 'Gallop').plan).toMatchObject({ modes: ['land', 'fly'], repeat: 2, bonusFeet: 20 });
  });

  it('Speed Surge: Strides or Flies twice, keeping its structured frequency', () => {
    const d = parse('Flame Drake', 'Speed Surge');
    expect(d.plan).toMatchObject({ kind: 'move', modes: ['land', 'fly'], repeat: 2, bonusFeet: 0 });
    expect(d.frequency).toMatchObject({ max: 3, per: 'day' });
    expect(parse('Sea Drake', 'Speed Surge').plan.modes).toEqual(['land', 'fly', 'swim']);
  });

  it("Swift Leap: a jump of half the creature's Speed that triggers no reactions", () => {
    expect(parse('Ghoul', 'Swift Leap').plan).toMatchObject({
      kind: 'move', modes: ['land'], speedFactor: 0.5, repeat: 1, jump: true, suppressReactions: true, strike: null,
    });
  });

  it('Swoop: a Fly with one Strike at any point during the movement, limb alternatives kept', () => {
    expect(parse('Giant Dragonfly', 'Swoop').plan).toMatchObject({
      modes: ['fly'], strike: { limbs: ['mandible'], timing: 'any' },
    });
    expect(parse('Quetzalcoatlus', 'Swoop').plan.strike.limbs).toEqual(['beak', 'talon']);
  });

  it('Eagle Dive: double fly Speed in a straight line, then a talon Strike; the descent is only a note', () => {
    expect(parse('Giant Eagle', 'Eagle Dive').plan).toMatchObject({
      modes: ['fly'], speedFactor: 2, straightLine: true, elevationNote: 'descending at least 10 feet',
      strike: { limbs: ['talon'], timing: 'end' },
    });
  });

  it('Rush: a Stride with a +10-foot bonus (separate sentence) and a Strike at the end', () => {
    expect(parse('Cave Bear', 'Rush').plan).toMatchObject({
      modes: ['land'], repeat: 1, bonusFeet: 10, strike: { limbs: [], timing: 'end' },
    });
  });

  it("Sudden Charge's conditional Strike sentence is a Strike at the end of the movement", () => {
    expect(parse('Kishi', 'Sudden Charge').plan).toMatchObject({
      repeat: 2, strike: { limbs: [], timing: 'end' },
    });
  });

  it("Phase Jump: a teleport; the airborne/falling clause changes nothing (no elevation)", () => {
    const d = parse('Phase Dragon (Young)', 'Phase Jump');
    expect(d.plan).toEqual({ kind: 'teleport', teleportFeet: 60, suppressReactions: false });
    expect(d.frequency).toMatchObject({ max: 1, per: 'round' });
  });

  it('Jaunt: a teleport to a location it can see, with its recharge formula', () => {
    const d = parse('Poracha', 'Jaunt');
    expect(d.plan.teleportFeet).toBe(40);
    expect(d.rechargeFormula).toBe('1d4');
  });

  it('Reposition: "teleports into an unoccupied space it can see within 50 feet"', () => {
    expect(parse('Amalgamite', 'Reposition').plan).toMatchObject({ kind: 'teleport', teleportFeet: 50 });
  });

  it("does not offer Pounce (its hidden-until-the-Strike clause isn't modeled)", () => {
    expect(parse('Leopard', 'Pounce')).toBeNull();
  });

  it('does not offer either Breach (no stated jump distance / vertical leap and splash-back)', () => {
    expect(parse('Great White Shark', 'Breach')).toBeNull();
    const simple = { type: 'action', system: { actionType: { value: 'action' }, actions: { value: 1 }, description: { value: '<p>The ossuary warden Leaps and makes a Strike at the end of that movement.</p>' } } };
    expect(parseMovementAbility(simple)).toBeNull();
  });

  it('does not offer Flying Strafe (two Strikes against different creatures)', () => {
    expect(parse('Roc', 'Flying Strafe')).toBeNull();
  });

  it('does not offer an ability gated by Requirements (Scamper)', () => {
    expect(parse('Kobold Scout', 'Scamper')).toBeNull();
  });

  it('does not offer Change Shape', () => {
    for (const e of entries.filter((x) => x.name === 'Change Shape')) {
      expect(parseMovementAbility(e.item)).toBeNull();
    }
  });

  it('never reads a second action as the subject ("Raises a Shield and Strides twice")', () => {
    const shielded = { type: 'action', system: { actionType: { value: 'action' }, actions: { value: 2 }, description: { value: '<p>The dwarf warrior Raises a Shield and Strides twice.</p>' } } };
    expect(parseMovementAbility(shielded)).toBeNull();
  });

  it('ignores reactions and unbounded free actions', () => {
    const reaction = { ...item('Ghoul', 'Swift Leap'), system: { ...item('Ghoul', 'Swift Leap').system, actionType: { value: 'reaction' } } };
    expect(parseMovementAbility(reaction)).toBeNull();
    const free = { ...item('Ghoul', 'Swift Leap'), system: { ...item('Ghoul', 'Swift Leap').system, actionType: { value: 'free' }, frequency: null } };
    expect(parseMovementAbility(free)).toBeNull();
  });

  it('never throws on malformed input', () => {
    for (const bad of [null, {}, { system: {} }, { system: { description: {} } }, { system: { description: { value: 42 } } }]) {
      expect(() => parseMovementAbility(bad)).not.toThrow();
      expect(parseMovementAbility(bad)).toBeNull();
    }
  });
});

describe('npcMoveBudget (#932)', () => {
  it('applies a Speed bonus to each separate move and floors each move to squares', () => {
    const gallop = parse('Riding Horse', 'Gallop').plan;
    // (40 + 10) ft = 10 squares per Stride, twice.
    expect(npcMoveBudget(gallop, { land: 40 }, 5)).toEqual({ mode: 'land', squares: 20, feet: 100 });
  });

  it('halves the Speed for Swift Leap (25 ft -> 12.5 ft -> 2 squares)', () => {
    expect(npcMoveBudget(parse('Ghoul', 'Swift Leap').plan, { land: 25 }, 5)).toMatchObject({ squares: 2 });
  });

  it('uses the best usable Speed among the modes, and none when the mover has none of them', () => {
    const surge = parse('Flame Drake', 'Speed Surge').plan;
    expect(npcMoveBudget(surge, { land: 25, fly: 100 }, 5)).toMatchObject({ mode: 'fly', squares: 40 });
    const swoop = parse('Giant Dragonfly', 'Swoop').plan;
    expect(npcMoveBudget(swoop, { land: 20 }, 5)).toBeNull();
  });

  it('doubles for "up to double its fly Speed"', () => {
    expect(npcMoveBudget(parse('Giant Eagle', 'Eagle Dive').plan, { land: 10, fly: 60 }, 5)).toMatchObject({ mode: 'fly', squares: 24 });
  });

  it('returns null for a teleport', () => {
    expect(npcMoveBudget(parse('Poracha', 'Jaunt').plan, { land: 30 }, 5)).toBeNull();
  });
});

describe('describeNpcMove (#932)', () => {
  it('describes a move without the prose', () => {
    const gallop = parse('Riding Horse', 'Gallop').plan;
    expect(describeNpcMove(gallop, { mode: 'land', feet: 100, posture: 'approach', targetName: 'Goblin' }))
      .toBe('Stride twice, 100 ft in all toward Goblin; can trigger reactions');
    expect(describeNpcMove(parse('Ghoul', 'Swift Leap').plan, { mode: 'land', feet: 10, posture: 'retreat', targetName: 'Fighter' }))
      .toBe('Leap, 10 ft in all away from Fighter; no reactions');
  });

  it('describes a teleport and a move-plus-Strike', () => {
    expect(describeNpcMove(parse('Poracha', 'Jaunt').plan, { posture: 'next-to', targetName: 'Cleric' }))
      .toBe('teleport up to 40 ft, next to Cleric; no reactions');
    expect(describeNpcMove(parse('Giant Eagle', 'Eagle Dive').plan, { mode: 'fly', feet: 120, posture: 'approach', targetName: 'Rogue' }))
      .toBe('Fly, 120 ft in all, straight line toward Rogue, then talon Strike; can trigger reactions');
  });
});
