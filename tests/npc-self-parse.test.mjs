// tests/npc-self-parse.test.mjs
import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import { parseSelfAbility, parseRequirementClause, describeNpcSelfAbility } from '../scripts/npc-self-parse.mjs';

// #934: every item below is REAL compiled bestiary text -- read from the
// installed pf2e system's packs (the same id-form `@UUID[...]{Label}` text a
// live world serves), via the coverage slice fixture, or inline (copied
// verbatim) for the few out-of-slice items (no selfEffect, link or heal).
const { entries } = JSON.parse(
  readFileSync(new URL('./fixtures/npc-self-ability-slice.json', import.meta.url), 'utf8'),
);
function real(actor, name) {
  const entry = entries.find((e) => e.actor === actor && e.name === name);
  if (!entry) throw new Error(`fixture has no ${actor}: ${name}`);
  return entry.item;
}

describe('parseSelfAbility -- selfEffectAction (#934)', () => {
  it('recognizes Form a Phalanx (structural selfEffect, no requirements)', () => {
    const parsed = parseSelfAbility(real('Skeleton Infantry', 'Form a Phalanx'));
    expect(parsed).toMatchObject({ family: 'selfEffectAction', cost: 1, requirements: [], frequency: null, conditions: [] });
    expect(parsed.params.effectUuid).toBe('Compendium.pf2e.bestiary-effects.Item.l62iAFL3EO7wSsLL');
  });

  it("recognizes Thesis Shield and reports the Concealed condition its prose names (for the GrantItem check)", () => {
    const parsed = parseSelfAbility(real('Zhuraita', 'Thesis Shield'));
    expect(parsed).toMatchObject({ family: 'selfEffectAction', cost: 1, conditions: ['concealed'] });
  });

  it('recognizes Reef Armor (two actions, once per day)', () => {
    const parsed = parseSelfAbility(real('Coral Dragon (Ancient)', 'Reef Armor'));
    expect(parsed).toMatchObject({ family: 'selfEffectAction', cost: 2, frequency: { max: 1, per: 'day' } });
  });

  it('recognizes a wielding requirement (Spear Parry: "is wielding a longspear")', () => {
    expect(parseSelfAbility(real('Kholo Pragmatist', 'Spear Parry')).requirements).toEqual([{ type: 'wielding', name: 'longspear' }]);
  });

  it('excludes the selfEffect-less spellcaster Reef Armor (no link, no heal -- unmodeled prose)', () => {
    // Coral Archdragon (Spellcaster), verbatim -- byte-identical prose to the
    // selfEffect variant, but no selfEffect field and no link.
    const item = {
      type: 'action',
      system: {
        actionType: { value: 'action' }, actions: { value: 2 }, traits: { value: ['primal'] },
        frequency: { max: 1, per: 'day' }, selfEffect: null,
        description: { value: '<p><strong>Frequency</strong> once per day</p><hr /><p><strong>Effect</strong> The dragon encases themself in an shell of protective coral, gaining 80 temporary Hit Points and resistance 15 to piercing and slashing damage until the temporary Hit Points are depleted. The effect lasts for 1 minute, until destroyed, or until the dragon Dismisses the effect.</p>' },
      },
    };
    expect(parseSelfAbility(item)).toBeNull();
  });

  it('excludes a polymorph transformation even with a selfEffect (Crystalline Dust Form)', () => {
    expect(parseSelfAbility(real('Axiomite', 'Crystalline Dust Form'))).toBeNull();
  });

  it('excludes a selfEffect action with an inline save/damage/template (Invoke Rune)', () => {
    expect(parseSelfAbility(real('Rune Giant', 'Invoke Rune'))).toBeNull();
  });

  it('excludes a requirement outside the closed set (Revealing Hypothesis: "hits a creature with its thesis")', () => {
    expect(parseSelfAbility(real('Zhuraita', 'Revealing Hypothesis'))).toBeNull();
  });

  it('excludes a selfEffect whose prose makes Strikes the effect does not (Defensive Assault)', () => {
    expect(parseSelfAbility(real('Urushil', 'Defensive Assault'))).toBeNull();
  });

  it('excludes a selfEffect whose prose protects allies (Hobgoblin Phalanx -- self-only slice)', () => {
    expect(parseSelfAbility(real('Hobgoblin Veteran Regiment', 'Hobgoblin Phalanx'))).toBeNull();
  });

  it('excludes a triggered free action (Blood Soak, redcap brigade)', () => {
    expect(parseSelfAbility(real('Redcap Brigade', 'Blood Soak'))).toBeNull();
  });

  it('excludes an unmodeled "until it next takes a move action" ending (Harden Chitin)', () => {
    expect(parseSelfAbility(real('Zecui Horde', 'Harden Chitin'))).toBeNull();
  });
});

describe('parseSelfAbility -- linkedEffectSelf (#934)', () => {
  it('recognizes a prose self-buff with exactly one linked bestiary effect (Raise Guard)', () => {
    const parsed = parseSelfAbility(real('Swordkeeper', 'Raise Guard'));
    expect(parsed).toMatchObject({ family: 'linkedEffectSelf', cost: 1, requirements: [] });
    // The compiled id-form uuid is carried verbatim, never rebuilt from the label.
    expect(parsed.params.effectUuid).toBe('Compendium.pf2e.bestiary-effects.Item.LohrnRXCQ0yVt8MK');
  });

  it('excludes Revert Form -- its "is in an assumed form" requirement (inForm) is not in the closed set', () => {
    expect(parseSelfAbility(real('Danrasteian The Magnificent', 'Revert Form'))).toBeNull();
  });

  it('excludes a corpse requirement written as plain Effect prose (Blood Soak, redcap)', () => {
    expect(parseSelfAbility(real('Redcap', 'Blood Soak'))).toBeNull();
  });

  it("excludes a link to a character's effect (the ragewight's Rage -> the barbarian's Effect: Rage)", () => {
    expect(parseSelfAbility(real('Ragewight (3-4)', 'Rage'))).toBeNull();
  });

  it('excludes prose that also Strikes (Defensive Slam: "Strikes once and gains")', () => {
    expect(parseSelfAbility(real('Angazhani', 'Defensive Slam'))).toBeNull();
  });

  it('excludes a buff for another creature (Commanding Shout buffs the infantry troop)', () => {
    expect(parseSelfAbility(real('Vofnir', 'Commanding Shout'))).toBeNull();
  });
});

describe('parseSelfAbility -- selfHeal (#934)', () => {
  it('recognizes Feed on Fear with the enemyWithin / fear-effect disjunction (Monster Core will-o\'-wisp)', () => {
    const parsed = parseSelfAbility(real("Will-o'-Wisp", 'Feed on Fear'));
    expect(parsed).toMatchObject({ family: 'selfHeal', cost: 1, crossRecharge: null, glowRider: true, params: { formula: '2d4' } });
    expect(parsed.requirements).toEqual([{ type: 'enemyWithin', feet: 15, conditions: ['fear-effect', 'dying'] }]);
  });

  it('recognizes the range-after-condition phrasing and the "only once per round" restatement (Will-o\'-the-Deep)', () => {
    const parsed = parseSelfAbility(real("Will-o'-the-Deep", 'Feed on Fear'));
    expect(parsed.family).toBe('selfHeal');
    expect(parsed.requirements).toEqual([{ type: 'enemyWithin', feet: 15, conditions: ['fear-effect', 'dying'] }]);
  });

  it("recognizes the voidglutton's 25-foot frightened/dying variant and its cross-ability recharge on Consume Light", () => {
    const parsed = parseSelfAbility(real('Voidglutton', 'Feed on Fear'));
    expect(parsed.requirements).toEqual([{ type: 'enemyWithin', feet: 25, conditions: ['fear-effect', 'frightened', 'dying'] }]);
    expect(parsed.crossRecharge).toEqual({ name: 'Consume Light', formula: '1d4' });
    expect(parsed.rechargeFormula).toBeNull();
    expect(parsed.params.formula).toBe('3d4');
  });

  it('recognizes an unconditional flat heal (Self-Repair) and a "restores ... to itself" heal (Abyssal Healing)', () => {
    expect(parseSelfAbility(real('Adamant Sentinel', 'Self-Repair'))).toMatchObject({ family: 'selfHeal', params: { formula: '30' } });
    expect(parseSelfAbility(real('Quasit', 'Abyssal Healing'))).toMatchObject({ family: 'selfHeal', frequency: { max: 1, per: 'round' } });
  });

  it('reads the ability\'s OWN recharge rider as its recharge formula (Vine Splint)', () => {
    expect(parseSelfAbility(real('Canopy Elder', 'Vine Splint'))).toMatchObject({ family: 'selfHeal', rechargeFormula: '1d4', crossRecharge: null, params: { formula: '40' } });
  });

  it('recognizes a handFree requirement (Patch and Set)', () => {
    expect(parseSelfAbility(real('Warmonger', 'Patch and Set')).requirements).toEqual([{ type: 'handFree' }]);
  });

  it('excludes a self-or-ally heal (Dero Medicine)', () => {
    expect(parseSelfAbility(real('Dero Stalker', 'Dero Medicine'))).toBeNull();
  });

  it('excludes corpse-gated heals (Consume Flesh, Collect Brain)', () => {
    expect(parseSelfAbility(real('Augrael', 'Consume Flesh'))).toBeNull();
    expect(parseSelfAbility(real('Jah-Tohl', 'Collect Brain'))).toBeNull();
  });

  it('excludes a heal gated on a previous Strike (Suck Blood: "last action was a successful proboscis Strike")', () => {
    expect(parseSelfAbility(real('Giant Flea', 'Suck Blood'))).toBeNull();
  });

  it('excludes a heal with an @actor formula (Undying Myth) and a triggered heal', () => {
    expect(parseSelfAbility(real('Oliphaunt of Jandelay', 'Undying Myth'))).toBeNull();
  });

  it('excludes a heal with a conditional, resource-spending rider (Recalibrate permanently deactivates an attack)', () => {
    expect(parseSelfAbility(real('Clockwork Amalgam', 'Recalibrate'))).toBeNull();
  });
});

describe('parseSelfAbility -- out-of-slice real text (#934)', () => {
  it('excludes prose with no selfEffect, link or heal (Broadcast Stance)', () => {
    const item = {
      type: 'action',
      system: {
        actionType: { value: 'action' }, actions: { value: 1 }, traits: { value: ['mental', 'occult', 'stance'] },
        description: { value: '<p><strong>Requirements</strong> the gosreg is in its natural form</p>\n<hr />\n<p><strong>Effect</strong> The gosreg secures its limbs into the ground as its brain-like head crackles with psychic energy.</p>' },
      },
    };
    expect(parseSelfAbility(item)).toBeNull();
  });

  it('excludes passive and reaction action types regardless of shape', () => {
    const base = real('Skeleton Infantry', 'Form a Phalanx');
    for (const actionType of ['passive', 'reaction']) {
      expect(parseSelfAbility({ ...base, system: { ...base.system, actionType: { value: actionType } } })).toBeNull();
    }
  });

  it('never throws on malformed items', () => {
    expect(parseSelfAbility(null)).toBeNull();
    expect(parseSelfAbility({ type: 'action', system: null })).toBeNull();
  });
});

describe('parseRequirementClause (#934)', () => {
  it('recognizes handFree', () => {
    expect(parseRequirementClause('The warmonger has a hand free')).toEqual({ type: 'handFree' });
  });
  it('recognizes wearing / wielding with an item name', () => {
    expect(parseRequirementClause('The dero is wearing a cytillesh toolkit')).toEqual({ type: 'wearing', name: 'cytillesh toolkit' });
    expect(parseRequirementClause('You are wielding a shield')).toEqual({ type: 'wielding', name: 'shield' });
  });
  it('recognizes hasCondition / notHasCondition on the creature itself', () => {
    expect(parseRequirementClause('The vanara disciple is Prone')).toEqual({ type: 'hasCondition', slug: 'prone' });
    expect(parseRequirementClause("The tripkee fiend keeper isn't stupefied")).toEqual({ type: 'notHasCondition', slug: 'stupefied' });
  });
  it('rejects an unmodeled form-state clause (no inForm predicate)', () => {
    expect(parseRequirementClause('The ugothol is in an assumed form')).toBeNull();
    expect(parseRequirementClause('the gosreg is in its natural form')).toBeNull();
  });
  it('rejects corpse / destroyed-creature clauses', () => {
    expect(parseRequirementClause('The ghoul is adjacent to the corpse of a creature that died within the last hour')).toBeNull();
    expect(parseRequirementClause('Augrael is adjacent to the corpse of an undead creature that was destroyed within the last hour')).toBeNull();
  });
  it('rejects an enemy clause with an unmodeled state', () => {
    expect(parseRequirementClause('An enemy within 30 feet is taking persistent bleed damage')).toBeNull();
  });
});

describe('describeNpcSelfAbility (#934)', () => {
  it('summarizes an effect family from the effect summary and duration when given', () => {
    const descriptor = parseSelfAbility(real('Skeleton Infantry', 'Form a Phalanx'));
    expect(describeNpcSelfAbility(descriptor)).toBe('self-buff (effect)');
    expect(describeNpcSelfAbility(descriptor, { effectSummary: '+ac', durationLabel: '1 rounds' })).toBe('self-buff: +ac; lasts 1 rounds');
  });
  it('summarizes a heal with its formula and HP percentage', () => {
    const descriptor = parseSelfAbility(real("Will-o'-Wisp", 'Feed on Fear'));
    expect(describeNpcSelfAbility(descriptor)).toBe('heals itself 2d4 HP');
    expect(describeNpcSelfAbility(descriptor, { hpFraction: 0.25 })).toBe('heals itself 2d4 HP (now at 25% HP)');
  });
});
