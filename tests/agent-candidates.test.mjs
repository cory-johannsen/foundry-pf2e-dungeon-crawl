// tests/agent-candidates.test.mjs
import { describe, it, expect } from 'vitest';
import {
  initAgentTurnState, buildMovementCandidates, buildStrikeCandidates, buildSpellCandidates,
  buildAreaSpellCandidates, buildAttackSpellCandidates, buildDebuffSpellCandidates,
  parseConditionsByOutcome, hasSpellUsesRemaining,
  parseBreathWeaponEffect, buildBreathWeaponCandidates,
  parseMultiStrikeBundle, buildMultiStrikeCandidates,
  parseChainHopDistance, buildChainSpellCandidates,
  buildHealSpellCandidates,
  parseSpellEffectUuid, buildBuffSpellCandidates,
  parseReactiveStrikeWeaponRestriction,
  parseAreaSpellTierOverrides, buildTierScalingAreaSpellCandidates, endTurnCandidate,
  parseActionGlyphTiers, buildDualNatureSpellCandidates,
  parseTargetCountFormula, buildTargetCountSpellCandidates,
  parseAutoHitAreaTiers, buildAutoHitAreaSpellCandidates,
  buildCandidateList, applyCandidateToTurnState, buildDecisionContext,
  MAX_ACTIONS_PER_TURN, AGENT_MELEE_REACH_SQUARES
} from '../scripts/agent-candidates.mjs';

describe('initAgentTurnState', () => {
  it('starts with a full action budget and no MAP penalty', () => {
    expect(initAgentTurnState()).toEqual({ actionsRemaining: MAX_ACTIONS_PER_TURN, mapIncrement: 0 });
  });
});

describe('buildMovementCandidates', () => {
  const opponentFar = { id: 'opp1', name: 'Fighter', distanceSquares: 3 };
  const opponentAdjacent = { id: 'opp2', name: 'Cleric', distanceSquares: 1 };

  it('offers approach for an opponent beyond melee reach', () => {
    const candidates = buildMovementCandidates({ opponents: [opponentFar], hazard: null, hasRangedOrReach: false });
    expect(candidates).toEqual([
      { id: 'stride:approach:opp1', type: 'stride', posture: 'approach', targetId: 'opp1', cost: 1, summary: 'Move toward Fighter' }
    ]);
  });

  it('does not offer approach for an opponent already at melee reach', () => {
    const candidates = buildMovementCandidates({ opponents: [opponentAdjacent], hazard: null, hasRangedOrReach: false });
    expect(candidates).toEqual([]);
  });

  it('offers retreat for a nearby opponent only when the combatant has ranged/reach', () => {
    const withoutRanged = buildMovementCandidates({ opponents: [opponentAdjacent], hazard: null, hasRangedOrReach: false });
    expect(withoutRanged).toEqual([]);

    const withRanged = buildMovementCandidates({ opponents: [opponentAdjacent], hazard: null, hasRangedOrReach: true });
    expect(withRanged).toEqual([
      { id: 'stride:retreat:opp2', type: 'stride', posture: 'retreat', targetId: 'opp2', cost: 1, summary: 'Move away from Cleric' }
    ]);
  });

  it('does not offer retreat for an opponent already far away, even with ranged/reach', () => {
    const candidates = buildMovementCandidates({ opponents: [opponentFar], hazard: null, hasRangedOrReach: true });
    expect(candidates).toEqual([
      { id: 'stride:approach:opp1', type: 'stride', posture: 'approach', targetId: 'opp1', cost: 1, summary: 'Move toward Fighter' }
    ]);
  });

  it('offers reposition when a hazard is within 1 square, and not otherwise', () => {
    const near = buildMovementCandidates({ opponents: [], hazard: { distanceSquares: 1 }, hasRangedOrReach: false });
    expect(near).toEqual([
      { id: 'stride:reposition', type: 'stride', posture: 'reposition', targetId: null, cost: 1, summary: 'Move away from the nearby hazard' }
    ]);

    const far = buildMovementCandidates({ opponents: [], hazard: { distanceSquares: 2 }, hasRangedOrReach: false });
    expect(far).toEqual([]);

    const none = buildMovementCandidates({ opponents: [], hazard: null, hasRangedOrReach: false });
    expect(none).toEqual([]);
  });
});

describe('buildStrikeCandidates', () => {
  const claw = { slug: 'claw', label: 'Claw', variantCount: 3, reachSquares: AGENT_MELEE_REACH_SQUARES };
  const opponentAdjacent = { id: 'opp1', name: 'Fighter', distanceSquares: 1 };
  const opponentFar = { id: 'opp2', name: 'Cleric', distanceSquares: 3 };

  it('offers a strike against every opponent within reach, at the current MAP variant', () => {
    const candidates = buildStrikeCandidates({ readyActions: [claw], opponents: [opponentAdjacent, opponentFar], mapIncrement: 0 });
    expect(candidates).toEqual([
      { id: 'strike:claw:opp1', type: 'strike', actionSlug: 'claw', targetId: 'opp1', variantIndex: 0, cost: 1, summary: 'Claw vs Fighter (variant 0)' }
    ]);
  });

  it('clamps the variant index to the action\'s own variant count', () => {
    const candidates = buildStrikeCandidates({ readyActions: [claw], opponents: [opponentAdjacent], mapIncrement: 5 });
    expect(candidates[0].variantIndex).toBe(2); // claw.variantCount - 1
  });

  it('respects a reach greater than melee', () => {
    const tentacle = { slug: 'tentacle', label: 'Tentacle', variantCount: 3, reachSquares: 4 };
    const candidates = buildStrikeCandidates({ readyActions: [tentacle], opponents: [opponentFar], mapIncrement: 0 });
    expect(candidates).toEqual([
      { id: 'strike:tentacle:opp2', type: 'strike', actionSlug: 'tentacle', targetId: 'opp2', variantIndex: 0, cost: 1, summary: 'Tentacle vs Cleric (variant 0)' }
    ]);
  });
});

describe('buildSpellCandidates', () => {
  const spiritBlast = { id: 'sp1', slug: 'spirit-blast', label: 'Spirit Blast', cost: 2, rangeSquares: 6, save: 'fortitude', basic: true, entryId: 'entry1' };
  const opponentInRange = { id: 'opp1', name: 'Fighter', distanceSquares: 5 };
  const opponentOutOfRange = { id: 'opp2', name: 'Cleric', distanceSquares: 10 };

  it('offers a cast against every opponent within range when enough actions remain', () => {
    const candidates = buildSpellCandidates({ readySpells: [spiritBlast], opponents: [opponentInRange, opponentOutOfRange], actionsRemaining: 3 });
    expect(candidates).toEqual([
      { id: 'cast:spirit-blast:opp1', type: 'cast', spellId: 'sp1', entryId: 'entry1', targetId: 'opp1', cost: 2, save: 'fortitude', basic: true, summary: 'Spirit Blast vs Fighter' }
    ]);
  });

  it('omits a spell whose cost exceeds the actions remaining', () => {
    const candidates = buildSpellCandidates({ readySpells: [spiritBlast], opponents: [opponentInRange], actionsRemaining: 1 });
    expect(candidates).toEqual([]);
  });

  it('omits an opponent outside the spell\'s range', () => {
    const candidates = buildSpellCandidates({ readySpells: [spiritBlast], opponents: [opponentOutOfRange], actionsRemaining: 3 });
    expect(candidates).toEqual([]);
  });
});

describe('buildAreaSpellCandidates', () => {
  const opp1 = { id: 'opp1', name: 'Fighter' };
  const opp2 = { id: 'opp2', name: 'Cleric' };
  const opp3 = { id: 'opp3', name: 'Rogue' };

  const quench = {
    id: 'sp1', slug: 'quench', label: 'Quench', cost: 2, save: 'fortitude', basic: true, entryId: 'entry1',
    placements: [
      { centerType: 'opponent', centerId: 'opp1', affected: [opp1, opp2] },
      { centerType: 'opponent', centerId: 'opp3', affected: [opp3] }
    ]
  };

  it('offers one candidate per spell, centered on whichever placement catches the most opponents', () => {
    const candidates = buildAreaSpellCandidates({ readyAreaSpells: [quench], actionsRemaining: 3 });
    expect(candidates).toEqual([
      {
        id: 'castArea:quench:opponent:opp1', type: 'castArea',
        spellId: 'sp1', entryId: 'entry1', cost: 2, save: 'fortitude', basic: true,
        centerType: 'opponent', centerId: 'opp1', affectedIds: ['opp1', 'opp2'], affectedAllyIds: [],
        summary: 'Quench (hits Fighter, Cleric)'
      }
    ]);
  });

  it('omits a spell whose cost exceeds the actions remaining', () => {
    const candidates = buildAreaSpellCandidates({ readyAreaSpells: [quench], actionsRemaining: 1 });
    expect(candidates).toEqual([]);
  });

  it('omits a spell where every placement catches zero opponents', () => {
    const allyOnly = { ...quench, placements: [{ centerType: 'self', centerId: null, affected: [] }] };
    const candidates = buildAreaSpellCandidates({ readyAreaSpells: [allyOnly], actionsRemaining: 3 });
    expect(candidates).toEqual([]);
  });

  it('offers a self-centered candidate for an emanation, with no centerId', () => {
    const wails = {
      id: 'sp2', slug: 'wails-of-the-damned', label: 'Wails of the Damned', cost: 2, save: 'fortitude', basic: false, entryId: 'entry1',
      placements: [{ centerType: 'self', centerId: null, affected: [opp1] }]
    };
    const candidates = buildAreaSpellCandidates({ readyAreaSpells: [wails], actionsRemaining: 3 });
    expect(candidates).toEqual([
      {
        id: 'castArea:wails-of-the-damned:self', type: 'castArea',
        spellId: 'sp2', entryId: 'entry1', cost: 2, save: 'fortitude', basic: false,
        centerType: 'self', centerId: null, affectedIds: ['opp1'], affectedAllyIds: [],
        summary: 'Wails of the Damned (hits Fighter)'
      }
    ]);
  });

  it('prefers the placement hitting fewer allies when enemy counts are tied (#126)', () => {
    const ally1 = { id: 'ally1', name: 'Cleric-Ally' };
    const tiedOnEnemies = {
      ...quench,
      placements: [
        { centerType: 'opponent', centerId: 'opp1', affected: [opp1, opp2], affectedAllies: [ally1] },
        { centerType: 'opponent', centerId: 'opp3', affected: [opp1, opp3], affectedAllies: [] }
      ]
    };
    const candidates = buildAreaSpellCandidates({ readyAreaSpells: [tiedOnEnemies], actionsRemaining: 3 });
    expect(candidates).toEqual([
      {
        id: 'castArea:quench:opponent:opp3', type: 'castArea',
        spellId: 'sp1', entryId: 'entry1', cost: 2, save: 'fortitude', basic: true,
        centerType: 'opponent', centerId: 'opp3', affectedIds: ['opp1', 'opp3'], affectedAllyIds: [],
        summary: 'Quench (hits Fighter, Rogue)'
      }
    ]);
  });

  it('still prefers more enemies hit even if that placement also hits more allies (#126, lexicographic not net score)', () => {
    const ally1 = { id: 'ally1', name: 'Cleric-Ally' };
    const ally2 = { id: 'ally2', name: 'Wizard-Ally' };
    const moreEnemiesMoreAllies = {
      ...quench,
      placements: [
        { centerType: 'opponent', centerId: 'opp1', affected: [opp1, opp2], affectedAllies: [ally1, ally2] },
        { centerType: 'opponent', centerId: 'opp3', affected: [opp3], affectedAllies: [] }
      ]
    };
    const candidates = buildAreaSpellCandidates({ readyAreaSpells: [moreEnemiesMoreAllies], actionsRemaining: 3 });
    expect(candidates[0].centerId).toBe('opp1');
    expect(candidates[0].affectedAllyIds).toEqual(['ally1', 'ally2']);
  });
});

describe('parseAreaSpellTierOverrides', () => {
  it('parses a real tier-scaling spell description (Wronged Monk\'s Wrath-shaped)', () => {
    const description = "<p>You unleash your ki as a powerful storm of force and lightning, dealing 2d6 force damage and 2d12 electricity damage to creatures in the area.</p> <p>If you use 2 actions to cast the spell, increase the size of the emanation to 10 feet and the damage to 3d6 force damage and 3d12 electricity damage.</p> <p>If you use 3 actions to cast the spell, increase the size of the emanation to 20 feet and the damage to 4d6 force damage and 4d12 electricity damage.</p> <hr /> <p><strong>Heightened (+2)</strong> The force damage increases by 1d6 and the electricity damage by 1d12, or 2d6 and 2d12 if you use 2 or 3 actions</p>";
    expect(parseAreaSpellTierOverrides(description)).toEqual({
      2: { cost: 2, radiusFeet: 10, damage: [{ formula: '3d6', type: 'force' }, { formula: '3d12', type: 'electricity' }] },
      3: { cost: 3, radiusFeet: 20, damage: [{ formula: '4d6', type: 'force' }, { formula: '4d12', type: 'electricity' }] }
    });
  });

  it('returns an empty object when there is no tier-override phrasing at all', () => {
    expect(parseAreaSpellTierOverrides('You deal 2d6 force damage to creatures in the area.')).toEqual({});
  });

  it('ignores a malformed tier clause missing a radius or damage', () => {
    const description = 'If you use 2 actions to cast the spell, nothing useful happens here.';
    expect(parseAreaSpellTierOverrides(description)).toEqual({});
  });
});

describe('buildTierScalingAreaSpellCandidates', () => {
  const opp1 = { id: 'opp1', name: 'Fighter' };
  const opp2 = { id: 'opp2', name: 'Cleric' };

  const tier1 = {
    id: 'sp1', slug: 'wronged-monks-wrath-1action', label: "Wronged Monk's Wrath (1 action)",
    cost: 1, save: 'reflex', basic: true, entryId: 'entry1',
    placements: [{ centerType: 'self', centerId: null, affected: [opp1] }]
  };
  const tier2 = {
    id: 'sp1', slug: 'wronged-monks-wrath-2action', label: "Wronged Monk's Wrath (2 actions)",
    cost: 2, save: 'reflex', basic: true, entryId: 'entry1',
    placements: [{ centerType: 'self', centerId: null, affected: [opp1, opp2] }]
  };

  it('offers one candidate per affordable tier', () => {
    const candidates = buildTierScalingAreaSpellCandidates({ readyTierScalingAreaSpells: [tier1, tier2], actionsRemaining: 3 });
    expect(candidates).toEqual([
      {
        id: 'castAreaTier:wronged-monks-wrath-1action:self', type: 'castAreaTier',
        spellId: 'sp1', entryId: 'entry1', cost: 1, save: 'reflex', basic: true,
        centerType: 'self', centerId: null, affectedIds: ['opp1'], affectedAllyIds: [],
        summary: "Wronged Monk's Wrath (1 action) (hits Fighter)"
      },
      {
        id: 'castAreaTier:wronged-monks-wrath-2action:self', type: 'castAreaTier',
        spellId: 'sp1', entryId: 'entry1', cost: 2, save: 'reflex', basic: true,
        centerType: 'self', centerId: null, affectedIds: ['opp1', 'opp2'], affectedAllyIds: [],
        summary: "Wronged Monk's Wrath (2 actions) (hits Fighter, Cleric)"
      }
    ]);
  });

  it('omits a tier whose cost exceeds the actions remaining, keeping affordable ones', () => {
    const candidates = buildTierScalingAreaSpellCandidates({ readyTierScalingAreaSpells: [tier1, tier2], actionsRemaining: 1 });
    expect(candidates.map((c) => c.cost)).toEqual([1]);
  });

  it('omits a tier where every placement catches zero opponents', () => {
    const emptyTier = { ...tier1, placements: [{ centerType: 'self', centerId: null, affected: [] }] };
    const candidates = buildTierScalingAreaSpellCandidates({ readyTierScalingAreaSpells: [emptyTier], actionsRemaining: 3 });
    expect(candidates).toEqual([]);
  });
});

describe('parseActionGlyphTiers', () => {
  const harmDescription = "<p>You channel void energy to harm the living or heal the undead. If the target is a living creature, you deal 1d8 void damage to it, and it gets a basic Fortitude save. If the target is a willing undead creature, you restore that amount of Hit Points. The number of actions you spend when Casting this Spell determines its targets, range, area, and other parameters.</p>\n<p><span class=\"action-glyph\">1</span> The spell has a range of touch.</p>\n<p><span class=\"action-glyph\">2</span> (concentrate) The spell has a range of 30 feet. If you're healing an undead creature, increase the Hit Points restored by 8.</p>\n<p><span class=\"action-glyph\">3</span> (concentrate) You disperse void energy in a @Template[emanation|distance:30]. This targets all living and undead creatures in the area.</p>\n<hr />\n<p><strong>Heightened (+1)</strong> The amount of healing or damage increases by 1d8, and the extra healing for the 2-action version increases by 8.</p>";
  const healDescription = "<p>You channel vital energy to heal the living or damage the undead. If the target is a willing living creature, you restore 1d8 Hit Points. If the target is undead, you deal that amount of vitality damage to it, and it gets a basic Fortitude save. The number of actions you spend when Casting this Spell determines its targets, range, area, and other parameters.</p>\n<p><span class=\"action-glyph\">1</span> The spell has a range of touch.</p>\n<p><span class=\"action-glyph\">2</span> (concentrate) The spell has a range of 30 feet. If you're healing a living creature, increase the Hit Points restored by 8.</p>\n<p><span class=\"action-glyph\">3</span> (concentrate) You disperse vital energy in a @Template[emanation|distance:30]. This targets all living and undead creatures in the burst.</p>\n<hr />\n<p><strong>Heightened (+1)</strong> The amount of healing or damage increases by 1d8, and the extra healing for the 2-action version increases by 8.</p>";

  it('parses Harm\'s real tiered description', () => {
    expect(parseActionGlyphTiers(harmDescription)).toEqual({
      1: { cost: 1, rangeFeet: 'touch', bonus: 0 },
      2: { cost: 2, rangeFeet: 30, bonus: 8 },
      3: { cost: 3, area: { type: 'emanation', value: 30 }, bonus: 0 },
    });
  });

  it('parses Heal\'s real tiered description identically in shape', () => {
    expect(parseActionGlyphTiers(healDescription)).toEqual({
      1: { cost: 1, rangeFeet: 'touch', bonus: 0 },
      2: { cost: 2, rangeFeet: 30, bonus: 8 },
      3: { cost: 3, area: { type: 'emanation', value: 30 }, bonus: 0 },
    });
  });

  it('returns an empty object for a description with no action-glyph tiers', () => {
    expect(parseActionGlyphTiers('<p>A plain spell with no tiers.</p>')).toEqual({});
  });
});

describe('buildDualNatureSpellCandidates', () => {
  const livingFoe = { id: 'foe1', name: 'Bandit' };
  const undeadAlly = { id: 'ally1', name: 'Skeleton Guide' };
  const spell = {
    id: 'sp1', slug: 'harm', label: 'Harm', entryId: 'entry1', harmfulTrait: 'living',
    save: 'fortitude', basic: true,
    singleTargetTiers: [
      { cost: 1, bonus: 0, harmTargets: [livingFoe], healTargets: [] },
      { cost: 2, bonus: 8, harmTargets: [], healTargets: [undeadAlly] },
    ],
    areaTier: { cost: 3, harmTargets: [livingFoe], healTargets: [undeadAlly] },
  };

  it('offers a castDualHarm candidate per single-target harm target', () => {
    const candidates = buildDualNatureSpellCandidates({ readyDualNatureSpells: [spell], actionsRemaining: 3 });
    expect(candidates).toContainEqual({
      id: 'castDualHarm:harm:1:foe1', type: 'castDualHarm',
      spellId: 'sp1', entryId: 'entry1', cost: 1, targetId: 'foe1', save: 'fortitude', basic: true,
      summary: 'Harm (1 action) vs Bandit',
    });
  });

  it('offers a castDualHeal candidate per single-target heal target, carrying the tier bonus', () => {
    const candidates = buildDualNatureSpellCandidates({ readyDualNatureSpells: [spell], actionsRemaining: 3 });
    expect(candidates).toContainEqual({
      id: 'castDualHeal:harm:2:ally1', type: 'castDualHeal',
      spellId: 'sp1', entryId: 'entry1', cost: 2, targetId: 'ally1', bonus: 8,
      summary: 'Harm (2 actions) heals Skeleton Guide',
    });
  });

  it('offers one castDualArea candidate combining both harm and heal groups', () => {
    const candidates = buildDualNatureSpellCandidates({ readyDualNatureSpells: [spell], actionsRemaining: 3 });
    expect(candidates).toContainEqual({
      id: 'castDualArea:harm:3', type: 'castDualArea',
      spellId: 'sp1', entryId: 'entry1', cost: 3, save: 'fortitude', basic: true,
      harmIds: ['foe1'], healIds: ['ally1'],
      summary: 'Harm (3 actions) harms Bandit; heals Skeleton Guide',
    });
  });

  it('omits any tier whose cost exceeds the actions remaining', () => {
    const candidates = buildDualNatureSpellCandidates({ readyDualNatureSpells: [spell], actionsRemaining: 1 });
    expect(candidates.map((c) => c.id)).toEqual(['castDualHarm:harm:1:foe1']);
  });

  it('omits the area candidate when both harm and heal groups are empty', () => {
    const emptyArea = { ...spell, singleTargetTiers: [], areaTier: { cost: 3, harmTargets: [], healTargets: [] } };
    const candidates = buildDualNatureSpellCandidates({ readyDualNatureSpells: [emptyArea], actionsRemaining: 3 });
    expect(candidates).toEqual([]);
  });
});

describe('parseTargetCountFormula', () => {
  it('parses Rebuke Death\'s real structured target text', () => {
    expect(parseTargetCountFormula('1 living creature per action spent to Cast this Spell')).toEqual({ countPerAction: 1 });
  });

  it('parses an explicit "per N actions" denominator', () => {
    expect(parseTargetCountFormula('1 creature per 2 actions spent')).toEqual({ countPerAction: 0.5 });
  });

  it('parses a numerator greater than 1', () => {
    expect(parseTargetCountFormula('2 creatures per action spent')).toEqual({ countPerAction: 2 });
  });

  it('returns null for an ordinary single-target phrase', () => {
    expect(parseTargetCountFormula('1 creature')).toBeNull();
  });
});

describe('buildTargetCountSpellCandidates', () => {
  const ally1 = { id: 'ally1', name: 'Fighter' };
  const ally2 = { id: 'ally2', name: 'Cleric' };

  const rebukeDeath = {
    id: 'sp1', slug: 'rebuke-death', label: 'Rebuke Death', entryId: 'entry1', save: null, basic: null,
    tiers: [
      { cost: 1, targets: [ally1] },
      { cost: 2, targets: [ally1, ally2] },
    ],
  };

  it('offers one candidate per affordable tier, bundling its pre-selected targets', () => {
    const candidates = buildTargetCountSpellCandidates({ readyTargetCountSpells: [rebukeDeath], actionsRemaining: 3 });
    expect(candidates).toEqual([
      {
        id: 'castTargetCount:rebuke-death:1', type: 'castTargetCount',
        spellId: 'sp1', entryId: 'entry1', cost: 1, save: null, basic: null,
        targetIds: ['ally1'],
        summary: 'Rebuke Death (1 action) on Fighter',
      },
      {
        id: 'castTargetCount:rebuke-death:2', type: 'castTargetCount',
        spellId: 'sp1', entryId: 'entry1', cost: 2, save: null, basic: null,
        targetIds: ['ally1', 'ally2'],
        summary: 'Rebuke Death (2 actions) on Fighter, Cleric',
      },
    ]);
  });

  it('omits a tier whose cost exceeds the actions remaining', () => {
    const candidates = buildTargetCountSpellCandidates({ readyTargetCountSpells: [rebukeDeath], actionsRemaining: 1 });
    expect(candidates.map((c) => c.cost)).toEqual([1]);
  });

  it('omits a tier with no pre-selected targets', () => {
    const emptyTier = { ...rebukeDeath, tiers: [{ cost: 1, targets: [] }] };
    const candidates = buildTargetCountSpellCandidates({ readyTargetCountSpells: [emptyTier], actionsRemaining: 3 });
    expect(candidates).toEqual([]);
  });
});

describe('parseAutoHitAreaTiers', () => {
  const forceRainDescription = "<p>You conjure a magical cloud that batters creatures with shards of solidified magic. Creatures in the spell's area take force damage with a basic Reflex save. The number of actions you spend when Casting this Spell determines the area and other parameters.</p>\n<p><span class=\"action-glyph\">1</span> This spell affects a single 5-foot square and deals 4d6 force damage.</p>\n<p><span class=\"action-glyph\">2</span> This spell affects all squares in a @Template[type:burst|distance:10] and deals 8d6 force damage.</p>\n<p><span class=\"action-glyph\">3</span> The shards home in on creatures. This spell affects all squares in a @Template[type:burst|distance:10]. Creatures in the area don't attempt a saving throw and instead automatically take 20 force damage.</p><hr /><p><strong>Heightened (+1)</strong> The damage increases by 1d6 for the 1-action version, by 2d6 for the 2-action version, and by 5 for the 3-action version.</p>";

  it('parses Force Rain\'s real tiered description', () => {
    expect(parseAutoHitAreaTiers(forceRainDescription)).toEqual({
      1: { cost: 1, noSave: false, damageFormula: '4d6', damageType: 'force' },
      2: { cost: 2, area: { type: 'burst', value: 10 }, noSave: false, damageFormula: '8d6', damageType: 'force' },
      3: { cost: 3, area: { type: 'burst', value: 10 }, noSave: true, flatDamage: 20, damageType: 'force' },
    });
  });

  it('returns an empty object for a description with no action-glyph tiers', () => {
    expect(parseAutoHitAreaTiers('<p>A plain spell with no tiers.</p>')).toEqual({});
  });
});

describe('buildAutoHitAreaSpellCandidates', () => {
  const opp1 = { id: 'opp1', name: 'Fighter' };
  const opp2 = { id: 'opp2', name: 'Cleric' };

  const saveTier = {
    id: 'sp1', slug: 'force-rain-2action', label: 'Force Rain (2 actions)',
    cost: 2, save: 'reflex', basic: true, noSave: false, entryId: 'entry1',
    placements: [{ centerType: 'opponent', centerId: 'opp1', affected: [opp1, opp2] }],
  };
  const noSaveTier = {
    id: 'sp1', slug: 'force-rain-3action', label: 'Force Rain (3 actions)',
    cost: 3, save: null, basic: null, noSave: true, entryId: 'entry1',
    placements: [{ centerType: 'opponent', centerId: 'opp1', affected: [opp1, opp2] }],
  };

  it('offers a save-based candidate carrying noSave:false', () => {
    const candidates = buildAutoHitAreaSpellCandidates({ readyAutoHitAreaSpells: [saveTier], actionsRemaining: 3 });
    expect(candidates).toEqual([
      {
        id: 'castAutoHitAreaTier:force-rain-2action:opponent:opp1', type: 'castAutoHitAreaTier',
        spellId: 'sp1', entryId: 'entry1', cost: 2, save: 'reflex', basic: true, noSave: false,
        centerType: 'opponent', centerId: 'opp1', affectedIds: ['opp1', 'opp2'], affectedAllyIds: [],
        summary: 'Force Rain (2 actions) (hits Fighter, Cleric)',
      },
    ]);
  });

  it('offers a no-save candidate carrying noSave:true and a null save', () => {
    const candidates = buildAutoHitAreaSpellCandidates({ readyAutoHitAreaSpells: [noSaveTier], actionsRemaining: 3 });
    expect(candidates).toEqual([
      {
        id: 'castAutoHitAreaTier:force-rain-3action:opponent:opp1', type: 'castAutoHitAreaTier',
        spellId: 'sp1', entryId: 'entry1', cost: 3, save: null, basic: null, noSave: true,
        centerType: 'opponent', centerId: 'opp1', affectedIds: ['opp1', 'opp2'], affectedAllyIds: [],
        summary: 'Force Rain (3 actions) (hits Fighter, Cleric)',
      },
    ]);
  });

  it('omits a tier whose cost exceeds the actions remaining', () => {
    const candidates = buildAutoHitAreaSpellCandidates({ readyAutoHitAreaSpells: [saveTier, noSaveTier], actionsRemaining: 2 });
    expect(candidates.map((c) => c.cost)).toEqual([2]);
  });

  it('omits a tier where every placement catches zero opponents', () => {
    const emptyTier = { ...noSaveTier, placements: [{ centerType: 'opponent', centerId: 'opp1', affected: [] }] };
    const candidates = buildAutoHitAreaSpellCandidates({ readyAutoHitAreaSpells: [emptyTier], actionsRemaining: 3 });
    expect(candidates).toEqual([]);
  });
});

describe('buildAttackSpellCandidates', () => {
  const rayOfFrost = { id: 'sp4', slug: 'ray-of-frost', label: 'Ray of Frost', cost: 2, rangeSquares: 6, entryId: 'entry1' };
  const opponentInRange = { id: 'opp1', name: 'Fighter', distanceSquares: 5 };
  const opponentOutOfRange = { id: 'opp2', name: 'Cleric', distanceSquares: 10 };

  it('offers a castAttack against every opponent within range when enough actions remain', () => {
    const candidates = buildAttackSpellCandidates({ readyAttackSpells: [rayOfFrost], opponents: [opponentInRange, opponentOutOfRange], actionsRemaining: 3 });
    expect(candidates).toEqual([
      { id: 'castAttack:ray-of-frost:opp1', type: 'castAttack', spellId: 'sp4', entryId: 'entry1', targetId: 'opp1', cost: 2, summary: 'Ray of Frost vs Fighter' }
    ]);
  });

  it('omits a spell whose cost exceeds the actions remaining', () => {
    const candidates = buildAttackSpellCandidates({ readyAttackSpells: [rayOfFrost], opponents: [opponentInRange], actionsRemaining: 1 });
    expect(candidates).toEqual([]);
  });

  it('omits an opponent outside the spell\'s range', () => {
    const candidates = buildAttackSpellCandidates({ readyAttackSpells: [rayOfFrost], opponents: [opponentOutOfRange], actionsRemaining: 3 });
    expect(candidates).toEqual([]);
  });
});

describe('parseConditionsByOutcome', () => {
  it('extracts a directly-tagged condition and its value per outcome (Fear-shaped)', () => {
    const description = `
      <p><strong>Critical Success</strong> The target is unaffected.</p>
      <p><strong>Success</strong> The target is @UUID[Compendium.pf2e.conditionitems.Item.TBSHQspnbcqxsmjL]{Frightened 1}.</p>
      <p><strong>Failure</strong> The target is @UUID[Compendium.pf2e.conditionitems.Item.TBSHQspnbcqxsmjL]{Frightened 2}.</p>
      <p><strong>Critical Failure</strong> The target is @UUID[Compendium.pf2e.conditionitems.Item.TBSHQspnbcqxsmjL]{Frightened 3} and @UUID[Compendium.pf2e.conditionitems.Item.sDPxOjQ9kx2RZE8D]{Fleeing} for 1 round.</p>
    `;
    expect(parseConditionsByOutcome(description)).toEqual({
      success: [{ slug: 'frightened', value: 1 }],
      failure: [{ slug: 'frightened', value: 2 }],
      criticalFailure: [{ slug: 'frightened', value: 3 }, { slug: 'fleeing', value: null }]
    });
  });

  it('omits an outcome with no tag entirely, even if it mentions a condition in plain text', () => {
    const description = `
      <p><strong>Success</strong> The target is @UUID[Compendium.pf2e.conditionitems.Item.i3OJZU2nk64Df3xm]{Clumsy 1} and takes a penalty.</p>
      <p><strong>Failure</strong> The target is clumsy 3 and takes a bigger penalty.</p>
    `;
    expect(parseConditionsByOutcome(description)).toEqual({
      success: [{ slug: 'clumsy', value: 1 }]
    });
  });

  it('returns an empty object for a description with no condition tags at all', () => {
    const description = '<p><strong>Success</strong> The creature is pushed 5 feet away from you.</p>';
    expect(parseConditionsByOutcome(description)).toEqual({});
  });

  it('ignores non-outcome headings like Heightened', () => {
    const description = `
      <p><strong>Failure</strong> The target is @UUID[Compendium.pf2e.conditionitems.Item.TBSHQspnbcqxsmjL]{Frightened 2}.</p>
      <p><strong>Heightened (3rd)</strong> You can target up to five creatures.</p>
    `;
    expect(parseConditionsByOutcome(description)).toEqual({
      failure: [{ slug: 'frightened', value: 2 }]
    });
  });
});

describe('hasSpellUsesRemaining', () => {
  it('is true for a spell with no location.uses at all', () => {
    expect(hasSpellUsesRemaining({ name: 'Spirit Blast', system: { location: {} } })).toBe(true);
  });

  it('is true for a limited spell that still has uses left', () => {
    expect(hasSpellUsesRemaining({ name: 'Spirit Blast', system: { location: { uses: { value: 1, max: 1 } } } })).toBe(true);
  });

  it('is false for a limited spell with zero uses left', () => {
    expect(hasSpellUsesRemaining({ name: 'Spirit Blast', system: { location: { uses: { value: 0, max: 1 } } } })).toBe(false);
  });

  it('is always true for a spell named "(At will)", even with zero uses left', () => {
    expect(hasSpellUsesRemaining({ name: 'Mind Probe (At will)', system: { location: { uses: { value: 0, max: 1 } } } })).toBe(true);
  });

  it('is always true for a spell named "(Constant)", even with zero uses left', () => {
    expect(hasSpellUsesRemaining({ name: 'Truesight (Constant)', system: { location: { uses: { value: 0, max: 1 } } } })).toBe(true);
  });
});

describe('parseBreathWeaponEffect', () => {
  it('parses a real basic-save breath weapon description (Poison Breath-shaped)', () => {
    const description = 'The dragon breathes a toxic cloud that deals @Damage[13d6[poison]|options:area-damage] damage in a @Template[cone|distance:50] (@Check[fortitude|dc:31|basic|options:area-effect] save). They can\'t use Poison Breath again for [[/gmr 1d4 #Recharge Poison Breath]]{1d4 rounds}.';
    expect(parseBreathWeaponEffect(description)).toEqual({
      damageFormula: '13d6', damageType: 'poison', areaType: 'cone', distanceFeet: 50,
      save: 'fortitude', dc: 31, rechargeFormula: '1d4'
    });
  });

  it('returns a null rechargeFormula when there is no recharge text', () => {
    const description = 'Deals @Damage[13d6[poison]] damage in a @Template[cone|distance:50] (@Check[fortitude|dc:31|basic] save).';
    expect(parseBreathWeaponEffect(description)).toEqual({
      damageFormula: '13d6', damageType: 'poison', areaType: 'cone', distanceFeet: 50,
      save: 'fortitude', dc: 31, rechargeFormula: null
    });
  });

  it('returns null for a non-basic save (out of scope - v1 only supports basic saves)', () => {
    const description = 'Deals @Damage[15d6[mental]] damage in a @Template[cone|distance:40] (@Check[will|dc:39|options:area-effect] save).';
    expect(parseBreathWeaponEffect(description)).toBeNull();
  });

  it('returns null when there is no @Check at all', () => {
    const description = 'Deals @Damage[13d6[poison]] damage in a @Template[cone|distance:50].';
    expect(parseBreathWeaponEffect(description)).toBeNull();
  });

  it('returns null when there is no @Damage at all', () => {
    const description = 'Creatures in a @Template[cone|distance:50] must succeed at a @Check[fortitude|dc:31|basic] save.';
    expect(parseBreathWeaponEffect(description)).toBeNull();
  });
});

describe('buildBreathWeaponCandidates', () => {
  const opp1 = { id: 'opp1', name: 'Fighter' };
  const opp2 = { id: 'opp2', name: 'Cleric' };
  const opp3 = { id: 'opp3', name: 'Rogue' };

  const poisonBreath = {
    itemId: 'item1', slug: 'poison-breath', label: 'Poison Breath', cost: 2,
    damageFormula: '13d6', damageType: 'poison', save: 'fortitude', dc: 31, rechargeFormula: '1d4',
    placements: [
      { centerType: 'opponent', centerId: 'opp1', affected: [opp1, opp2] },
      { centerType: 'opponent', centerId: 'opp3', affected: [opp3] }
    ]
  };

  it('offers one candidate, centered on whichever placement catches the most opponents', () => {
    const candidates = buildBreathWeaponCandidates({ readyBreathWeapons: [poisonBreath], actionsRemaining: 3 });
    expect(candidates).toEqual([
      {
        id: 'breathWeapon:poison-breath:opponent:opp1', type: 'breathWeapon',
        itemId: 'item1', cost: 2, damageFormula: '13d6', damageType: 'poison', save: 'fortitude', dc: 31, rechargeFormula: '1d4',
        centerType: 'opponent', centerId: 'opp1', affectedIds: ['opp1', 'opp2'],
        summary: 'Poison Breath (hits Fighter, Cleric)'
      }
    ]);
  });

  it('omits an ability whose cost exceeds the actions remaining', () => {
    const candidates = buildBreathWeaponCandidates({ readyBreathWeapons: [poisonBreath], actionsRemaining: 1 });
    expect(candidates).toEqual([]);
  });

  it('omits an ability where every placement catches zero opponents', () => {
    const noTargets = { ...poisonBreath, placements: [{ centerType: 'opponent', centerId: 'opp1', affected: [] }] };
    const candidates = buildBreathWeaponCandidates({ readyBreathWeapons: [noTargets], actionsRemaining: 3 });
    expect(candidates).toEqual([]);
  });
});

describe('parseMultiStrikeBundle', () => {
  it('parses a real Draconic Frenzy-shaped description (two-plus-one, distinct strikes)', () => {
    const description = 'The dragon makes two claw Strikes and one tail Strike in any order.';
    expect(parseMultiStrikeBundle(description)).toEqual([
      { count: 2, name: 'claw' },
      { count: 1, name: 'tail' }
    ]);
  });

  it('parses a plural-noun-as-adjective strike name (a real observed phrasing quirk)', () => {
    const description = 'The gold dragon makes two claw Strikes and one horns Strike in any order.';
    expect(parseMultiStrikeBundle(description)).toEqual([
      { count: 2, name: 'claw' },
      { count: 1, name: 'horns' }
    ]);
  });

  it('returns null when the description has no "in any order" phrasing at all', () => {
    const description = 'The dragon makes a claw Strike.';
    expect(parseMultiStrikeBundle(description)).toBeNull();
  });

  it('returns null when "in any order" is present but no "N <name> Strike(s)" clause is found', () => {
    const description = 'The dragon acts in any order it chooses.';
    expect(parseMultiStrikeBundle(description)).toBeNull();
  });
});

describe('buildMultiStrikeCandidates', () => {
  const opponentAdjacent = { id: 'opp1', name: 'Fighter', distanceSquares: 1 };
  const opponentFar = { id: 'opp2', name: 'Cleric', distanceSquares: 3 };

  const draconicFrenzy = {
    itemId: 'item1', slug: 'draconic-frenzy', label: 'Draconic Frenzy', cost: 2,
    reachSquares: AGENT_MELEE_REACH_SQUARES,
    strikes: [{ actionSlug: 'claw', count: 2 }, { actionSlug: 'tail', count: 1 }]
  };

  it('offers a bundle against every opponent within its reach', () => {
    const candidates = buildMultiStrikeCandidates({
      readyMultiStrikeBundles: [draconicFrenzy], opponents: [opponentAdjacent, opponentFar], actionsRemaining: 3
    });
    expect(candidates).toEqual([
      {
        id: 'multiStrike:draconic-frenzy:opp1', type: 'multiStrike',
        itemId: 'item1', targetId: 'opp1', cost: 2,
        strikes: [{ actionSlug: 'claw', count: 2 }, { actionSlug: 'tail', count: 1 }],
        summary: 'Draconic Frenzy vs Fighter'
      }
    ]);
  });

  it('omits a bundle whose cost exceeds the actions remaining', () => {
    const candidates = buildMultiStrikeCandidates({
      readyMultiStrikeBundles: [draconicFrenzy], opponents: [opponentAdjacent], actionsRemaining: 1
    });
    expect(candidates).toEqual([]);
  });

  it('omits an opponent beyond the bundle\'s reach', () => {
    const candidates = buildMultiStrikeCandidates({
      readyMultiStrikeBundles: [draconicFrenzy], opponents: [opponentFar], actionsRemaining: 3
    });
    expect(candidates).toEqual([]);
  });
});

describe('buildDebuffSpellCandidates', () => {
  const fear = {
    id: 'sp5', slug: 'fear', label: 'Fear', cost: 2, rangeSquares: 6, save: 'will', entryId: 'entry1',
    conditionsByOutcome: { failure: [{ slug: 'frightened', value: 2 }] }
  };
  const opponentInRange = { id: 'opp1', name: 'Fighter', distanceSquares: 5 };
  const opponentOutOfRange = { id: 'opp2', name: 'Cleric', distanceSquares: 10 };

  it('offers a castDebuff against every opponent within range when enough actions remain', () => {
    const candidates = buildDebuffSpellCandidates({ readyDebuffSpells: [fear], opponents: [opponentInRange, opponentOutOfRange], actionsRemaining: 3 });
    expect(candidates).toEqual([
      {
        id: 'castDebuff:fear:opp1', type: 'castDebuff', spellId: 'sp5', entryId: 'entry1',
        targetId: 'opp1', cost: 2, save: 'will',
        conditionsByOutcome: { failure: [{ slug: 'frightened', value: 2 }] },
        summary: 'Fear vs Fighter'
      }
    ]);
  });

  it('omits a spell whose cost exceeds the actions remaining', () => {
    const candidates = buildDebuffSpellCandidates({ readyDebuffSpells: [fear], opponents: [opponentInRange], actionsRemaining: 1 });
    expect(candidates).toEqual([]);
  });

  it('omits an opponent outside the spell\'s range', () => {
    const candidates = buildDebuffSpellCandidates({ readyDebuffSpells: [fear], opponents: [opponentOutOfRange], actionsRemaining: 3 });
    expect(candidates).toEqual([]);
  });
});

describe('parseChainHopDistance', () => {
  it('parses a real chain-spell description (Chain Lightning-shaped)', () => {
    const description = 'The electricity arcs to another creature within 30 feet of the first target, jumps to another creature within 30 feet of that target, and so on.';
    expect(parseChainHopDistance(description)).toBe(30);
  });

  it('returns null when there is no chain phrasing at all', () => {
    expect(parseChainHopDistance('You deal 8d12 electricity damage to the target.')).toBeNull();
  });
});

describe('buildChainSpellCandidates', () => {
  const opponentInRange1 = { id: 'opp1', name: 'Fighter', distanceSquares: 3 };
  const opponentInRange2 = { id: 'opp2', name: 'Cleric', distanceSquares: 5 };
  const opponentOutOfRange3 = { id: 'opp3', name: 'Rogue', distanceSquares: 8 };

  const chainLightning = {
    id: 'sp1', slug: 'chain-lightning', label: 'Chain Lightning', cost: 2, rangeSquares: 6,
    save: 'reflex', basic: true, entryId: 'entry1',
    chainGraph: {
      opp1: [{ id: 'opp2', name: 'Cleric', distanceSquares: 2 }],
      opp2: [{ id: 'opp1', name: 'Fighter', distanceSquares: 2 }, { id: 'opp3', name: 'Rogue', distanceSquares: 3 }],
      opp3: [{ id: 'opp2', name: 'Cleric', distanceSquares: 3 }],
    }
  };

  it('builds the longest greedy chain, picking whichever in-range primary target produces it', () => {
    const candidates = buildChainSpellCandidates({
      readyChainSpells: [chainLightning],
      opponents: [opponentInRange1, opponentInRange2, opponentOutOfRange3],
      actionsRemaining: 3
    });
    expect(candidates).toEqual([
      {
        id: 'castChain:chain-lightning:opp1', type: 'castChain',
        spellId: 'sp1', entryId: 'entry1', cost: 2, save: 'reflex', basic: true,
        targetId: 'opp1', chainedIds: ['opp2', 'opp3'],
        summary: 'Chain Lightning vs Fighter, Cleric, Rogue'
      }
    ]);
  });

  it('omits a spell whose cost exceeds the actions remaining', () => {
    const candidates = buildChainSpellCandidates({
      readyChainSpells: [chainLightning], opponents: [opponentInRange1], actionsRemaining: 1
    });
    expect(candidates).toEqual([]);
  });

  it('omits a spell when no opponent is within range as a primary target', () => {
    const candidates = buildChainSpellCandidates({
      readyChainSpells: [chainLightning], opponents: [opponentOutOfRange3], actionsRemaining: 3
    });
    expect(candidates).toEqual([]);
  });

  it('offers a single-target candidate with an empty chain when no hop extension exists', () => {
    const isolated = { ...chainLightning, chainGraph: { opp1: [] } };
    const candidates = buildChainSpellCandidates({
      readyChainSpells: [isolated], opponents: [opponentInRange1], actionsRemaining: 3
    });
    expect(candidates).toEqual([
      {
        id: 'castChain:chain-lightning:opp1', type: 'castChain',
        spellId: 'sp1', entryId: 'entry1', cost: 2, save: 'reflex', basic: true,
        targetId: 'opp1', chainedIds: [],
        summary: 'Chain Lightning vs Fighter'
      }
    ]);
  });
});

describe('buildHealSpellCandidates', () => {
  const heal = { id: 'sp1', slug: 'heal', label: 'Heal', cost: 1, rangeSquares: 1, entryId: 'entry1' };
  const injuredAllyInRange = { id: 'ally1', name: 'Cleric', distanceSquares: 1, hp: 40, maxHp: 100 };
  const fullHpAllyInRange = { id: 'ally2', name: 'Fighter', distanceSquares: 1, hp: 100, maxHp: 100 };
  const injuredAllyOutOfRange = { id: 'ally3', name: 'Rogue', distanceSquares: 5, hp: 20, maxHp: 100 };

  it('offers a heal candidate for an injured ally within range', () => {
    const candidates = buildHealSpellCandidates({ readyHealSpells: [heal], allies: [injuredAllyInRange], actionsRemaining: 3 });
    expect(candidates).toEqual([
      {
        id: 'castHeal:heal:ally1', type: 'castHeal',
        spellId: 'sp1', entryId: 'entry1', targetId: 'ally1', cost: 1,
        summary: 'Heal on Cleric'
      }
    ]);
  });

  it('omits an ally already at full HP', () => {
    const candidates = buildHealSpellCandidates({ readyHealSpells: [heal], allies: [fullHpAllyInRange], actionsRemaining: 3 });
    expect(candidates).toEqual([]);
  });

  it('omits an injured ally outside the spell\'s range', () => {
    const candidates = buildHealSpellCandidates({ readyHealSpells: [heal], allies: [injuredAllyOutOfRange], actionsRemaining: 3 });
    expect(candidates).toEqual([]);
  });

  it('omits a spell whose cost exceeds the actions remaining', () => {
    const candidates = buildHealSpellCandidates({ readyHealSpells: [heal], allies: [injuredAllyInRange], actionsRemaining: 0 });
    expect(candidates).toEqual([]);
  });
});

describe('parseSpellEffectUuid', () => {
  it('parses a real linked Spell Effect UUID (Mountain Resilience-shaped)', () => {
    const description = "<p>The target's skin hardens like stone. It gains resistance 5 to physical damage.</p>\n<p>@UUID[Compendium.pf2e.spell-effects.Item.JHpYudY14g0H4VWU]{Spell Effect: Mountain Resilience}</p>\n<hr />";
    expect(parseSpellEffectUuid(description)).toBe(
      'Compendium.pf2e.spell-effects.Item.JHpYudY14g0H4VWU',
    );
  });

  it('returns null when there is no linked Spell Effect UUID at all', () => {
    const description = '<p>You deal 4d6 fire damage.</p>';
    expect(parseSpellEffectUuid(description)).toBeNull();
  });

  it('returns null for a UUID from an unrelated compendium', () => {
    const description = '<p>@UUID[Compendium.pf2e.conditionitems.Item.abc123]{Frightened 1}</p>';
    expect(parseSpellEffectUuid(description)).toBeNull();
  });
});

describe('parseReactiveStrikeWeaponRestriction', () => {
  it('parses a real "(X Only)" weapon restriction (Attack of Opportunity-shaped)', () => {
    expect(parseReactiveStrikeWeaponRestriction('Attack of Opportunity (Jaws Only)')).toBe('jaws');
  });

  it('parses a real "(X Only)" weapon restriction (Reactive Strike-shaped)', () => {
    expect(parseReactiveStrikeWeaponRestriction('Reactive Strike (Tail Only)')).toBe('tail');
  });

  it('returns null for a plain, unrestricted name', () => {
    expect(parseReactiveStrikeWeaponRestriction('Reactive Strike')).toBeNull();
  });

  it('returns null for a non-weapon qualifier (Special-shaped, not a restriction)', () => {
    expect(parseReactiveStrikeWeaponRestriction('Attack of Opportunity (Special)')).toBeNull();
  });
});

describe('buildBuffSpellCandidates', () => {
  const mountainResilience = { id: 'sp1', slug: 'mountain-resilience', label: 'Mountain Resilience', cost: 2, rangeSquares: 6, entryId: 'entry1' };
  const allyInRange = { id: 'ally1', name: 'Fighter', distanceSquares: 3 };
  const allyOutOfRange = { id: 'ally2', name: 'Rogue', distanceSquares: 10 };

  it('offers a buff candidate for an ally within range, regardless of HP', () => {
    const candidates = buildBuffSpellCandidates({ readyBuffSpells: [mountainResilience], allies: [allyInRange], actionsRemaining: 3 });
    expect(candidates).toEqual([
      {
        id: 'castBuff:mountain-resilience:ally1', type: 'castBuff',
        spellId: 'sp1', entryId: 'entry1', targetId: 'ally1', cost: 2,
        summary: 'Mountain Resilience on Fighter'
      }
    ]);
  });

  it('omits an ally outside the spell\'s range', () => {
    const candidates = buildBuffSpellCandidates({ readyBuffSpells: [mountainResilience], allies: [allyOutOfRange], actionsRemaining: 3 });
    expect(candidates).toEqual([]);
  });

  it('omits a spell whose cost exceeds the actions remaining', () => {
    const candidates = buildBuffSpellCandidates({ readyBuffSpells: [mountainResilience], allies: [allyInRange], actionsRemaining: 1 });
    expect(candidates).toEqual([]);
  });
});

describe('endTurnCandidate', () => {
  it('is always the same zero-cost candidate', () => {
    expect(endTurnCandidate()).toEqual({ id: 'endTurn', type: 'endTurn', cost: 0, summary: 'End turn' });
  });
});

describe('buildCandidateList', () => {
  const claw = { slug: 'claw', label: 'Claw', variantCount: 3, reachSquares: AGENT_MELEE_REACH_SQUARES };
  const opponent = { id: 'opp1', name: 'Fighter', distanceSquares: 1 };

  it('combines movement, strike, and endTurn candidates when actions remain', () => {
    const turnState = { actionsRemaining: 3, mapIncrement: 0 };
    const candidates = buildCandidateList({ opponents: [opponent], readyActions: [claw], turnState, hazard: null, hasRangedOrReach: false });
    expect(candidates.map((c) => c.id)).toEqual(['strike:claw:opp1', 'endTurn']);
  });

  it('offers only endTurn once actions are exhausted', () => {
    const turnState = { actionsRemaining: 0, mapIncrement: 1 };
    const candidates = buildCandidateList({ opponents: [opponent], readyActions: [claw], turnState, hazard: null, hasRangedOrReach: false });
    expect(candidates).toEqual([endTurnCandidate()]);
  });

  it('includes affordable spell candidates alongside strikes', () => {
    const spiritBlast = { id: 'sp1', slug: 'spirit-blast', label: 'Spirit Blast', cost: 2, rangeSquares: 6, save: 'fortitude', basic: true };
    const turnState = { actionsRemaining: 3, mapIncrement: 0 };
    const candidates = buildCandidateList({ opponents: [opponent], readyActions: [claw], readySpells: [spiritBlast], turnState, hazard: null, hasRangedOrReach: false });
    expect(candidates.map((c) => c.id)).toEqual(['strike:claw:opp1', 'cast:spirit-blast:opp1', 'endTurn']);
  });

  it('omits a spell that the remaining action budget cannot afford', () => {
    const spiritBlast = { id: 'sp1', slug: 'spirit-blast', label: 'Spirit Blast', cost: 2, rangeSquares: 6, save: 'fortitude', basic: true };
    const turnState = { actionsRemaining: 1, mapIncrement: 0 };
    const candidates = buildCandidateList({ opponents: [opponent], readyActions: [claw], readySpells: [spiritBlast], turnState, hazard: null, hasRangedOrReach: false });
    expect(candidates.map((c) => c.id)).toEqual(['strike:claw:opp1', 'endTurn']);
  });

  it('includes an affordable area-spell candidate alongside strikes', () => {
    const quench = {
      id: 'sp3', slug: 'quench', label: 'Quench', cost: 2, save: 'fortitude', basic: true, entryId: 'entry1',
      placements: [{ centerType: 'self', centerId: null, affected: [{ id: 'opp1', name: 'Fighter' }] }]
    };
    const turnState = { actionsRemaining: 3, mapIncrement: 0 };
    const candidates = buildCandidateList({ opponents: [opponent], readyActions: [claw], readyAreaSpells: [quench], turnState, hazard: null, hasRangedOrReach: false });
    expect(candidates.map((c) => c.id)).toEqual(['strike:claw:opp1', 'castArea:quench:self', 'endTurn']);
  });

  it('includes an affordable attack-roll spell candidate alongside strikes', () => {
    const rayOfFrost = { id: 'sp4', slug: 'ray-of-frost', label: 'Ray of Frost', cost: 1, rangeSquares: 6, entryId: 'entry1' };
    const turnState = { actionsRemaining: 3, mapIncrement: 0 };
    const candidates = buildCandidateList({ opponents: [opponent], readyActions: [claw], readyAttackSpells: [rayOfFrost], turnState, hazard: null, hasRangedOrReach: false });
    expect(candidates.map((c) => c.id)).toEqual(['strike:claw:opp1', 'castAttack:ray-of-frost:opp1', 'endTurn']);
  });

  it('includes an affordable debuff spell candidate alongside strikes', () => {
    const fear = {
      id: 'sp5', slug: 'fear', label: 'Fear', cost: 2, rangeSquares: 6, save: 'will', entryId: 'entry1',
      conditionsByOutcome: { failure: [{ slug: 'frightened', value: 2 }] }
    };
    const turnState = { actionsRemaining: 3, mapIncrement: 0 };
    const candidates = buildCandidateList({ opponents: [opponent], readyActions: [claw], readyDebuffSpells: [fear], turnState, hazard: null, hasRangedOrReach: false });
    expect(candidates.map((c) => c.id)).toEqual(['strike:claw:opp1', 'castDebuff:fear:opp1', 'endTurn']);
  });

  it('includes an affordable breath weapon candidate alongside strikes', () => {
    const poisonBreath = {
      itemId: 'item1', slug: 'poison-breath', label: 'Poison Breath', cost: 2,
      damageFormula: '13d6', damageType: 'poison', save: 'fortitude', dc: 31,
      placements: [{ centerType: 'opponent', centerId: 'opp1', affected: [{ id: 'opp1', name: 'Fighter' }] }]
    };
    const turnState = { actionsRemaining: 3, mapIncrement: 0 };
    const candidates = buildCandidateList({ opponents: [opponent], readyActions: [claw], readyBreathWeapons: [poisonBreath], turnState, hazard: null, hasRangedOrReach: false });
    expect(candidates.map((c) => c.id)).toEqual(['strike:claw:opp1', 'breathWeapon:poison-breath:opponent:opp1', 'endTurn']);
  });

  it('includes an affordable heal spell candidate alongside strikes', () => {
    const heal = { id: 'sp6', slug: 'heal', label: 'Heal', cost: 1, rangeSquares: 1, entryId: 'entry1' };
    const injuredAlly = { id: 'ally1', name: 'Cleric', distanceSquares: 1, hp: 40, maxHp: 100 };
    const turnState = { actionsRemaining: 3, mapIncrement: 0 };
    const candidates = buildCandidateList({ opponents: [opponent], readyActions: [claw], readyHealSpells: [heal], allies: [injuredAlly], turnState, hazard: null, hasRangedOrReach: false });
    expect(candidates.map((c) => c.id)).toEqual(['strike:claw:opp1', 'castHeal:heal:ally1', 'endTurn']);
  });

  it('includes an affordable tier-scaling area spell candidate alongside strikes', () => {
    const tier1 = {
      id: 'sp7', slug: 'wronged-monks-wrath-1action', label: "Wronged Monk's Wrath (1 action)",
      cost: 1, save: 'reflex', basic: true, entryId: 'entry1',
      placements: [{ centerType: 'self', centerId: null, affected: [{ id: 'opp1', name: 'Fighter' }] }]
    };
    const turnState = { actionsRemaining: 3, mapIncrement: 0 };
    const candidates = buildCandidateList({ opponents: [opponent], readyActions: [claw], readyTierScalingAreaSpells: [tier1], turnState, hazard: null, hasRangedOrReach: false });
    expect(candidates.map((c) => c.id)).toEqual(['strike:claw:opp1', 'castAreaTier:wronged-monks-wrath-1action:self', 'endTurn']);
  });
});

describe('applyCandidateToTurnState', () => {
  it('decrements actionsRemaining by the candidate\'s cost', () => {
    const next = applyCandidateToTurnState({ actionsRemaining: 3, mapIncrement: 0 }, { type: 'stride', cost: 1 });
    expect(next).toEqual({ actionsRemaining: 2, mapIncrement: 0 });
  });

  it('increments mapIncrement only for a strike', () => {
    const next = applyCandidateToTurnState({ actionsRemaining: 3, mapIncrement: 0 }, { type: 'strike', cost: 1 });
    expect(next).toEqual({ actionsRemaining: 2, mapIncrement: 1 });
  });

  it('zeroes actionsRemaining for endTurn regardless of what remained', () => {
    const next = applyCandidateToTurnState({ actionsRemaining: 2, mapIncrement: 1 }, { type: 'endTurn', cost: 0 });
    expect(next).toEqual({ actionsRemaining: 0, mapIncrement: 1 });
  });

  it('decrements actionsRemaining by a spell\'s own cost and never touches mapIncrement', () => {
    const next = applyCandidateToTurnState({ actionsRemaining: 3, mapIncrement: 1 }, { type: 'cast', cost: 2 });
    expect(next).toEqual({ actionsRemaining: 1, mapIncrement: 1 });
  });

  it('increments mapIncrement by the total strike count of a multi-strike bundle', () => {
    const candidate = {
      type: 'multiStrike', cost: 2,
      strikes: [{ actionSlug: 'claw', count: 2 }, { actionSlug: 'tail', count: 1 }]
    };
    const next = applyCandidateToTurnState({ actionsRemaining: 3, mapIncrement: 0 }, candidate);
    expect(next).toEqual({ actionsRemaining: 1, mapIncrement: 3 });
  });
});

describe('buildDecisionContext', () => {
  it('shapes self/opponents/candidates/roundNumber for a provider, trimming candidates to id+summary', () => {
    const context = buildDecisionContext({
      self: { name: 'Yamaraj', hp: 40 },
      opponents: [{ id: 'opp1', name: 'Fighter', distanceSquares: 1, hp: 30 }],
      candidates: [{ id: 'strike:claw:opp1', type: 'strike', actionSlug: 'claw', targetId: 'opp1', variantIndex: 0, cost: 1, summary: 'Claw vs Fighter (variant 0)' }],
      roundNumber: 2
    });
    expect(context).toEqual({
      self: { name: 'Yamaraj', hp: 40 },
      opponents: [{ id: 'opp1', name: 'Fighter', distanceSquares: 1, hp: 30 }],
      allies: [],
      candidates: [{ id: 'strike:claw:opp1', summary: 'Claw vs Fighter (variant 0)' }],
      roundNumber: 2
    });
  });

  it('includes allies when given (#132)', () => {
    const context = buildDecisionContext({
      self: { name: 'Yamaraj', hp: 40 },
      opponents: [],
      allies: [{ id: 'ally1', name: 'Cleric', distanceSquares: 1, hp: 40, maxHp: 100 }],
      candidates: [],
      roundNumber: 2
    });
    expect(context.allies).toEqual([{ id: 'ally1', name: 'Cleric', distanceSquares: 1, hp: 40, maxHp: 100 }]);
  });
});
