// tests/npc-ability-parse.test.mjs
import { describe, it, expect } from 'vitest';
import { parseSaveAbility, AGENT_MELEE_REACH_FEET } from '../scripts/npc-ability-parse.mjs';

function item({ type = 'action', actionType = 'action', cost = 2, description, traits = [], frequency = null } = {}) {
  return {
    type,
    system: {
      actionType: { value: actionType },
      actions: { value: cost },
      description: { value: description },
      traits: { value: traits },
      frequency,
    },
  };
}

// Real compiled-runtime text (condition links carry an id plus a label).
const TERRIFYING_DISPLAY = '<p>The megaprimatus beats its chest in a terrifying display. Creatures within @Template[emanation|distance:50]{50 feet} must attempt a @Check[will|dc:27|name:Frightening Display] save.</p><p>While a creature is @UUID[Compendium.pf2e.conditionitems.Item.TBSHQspnbcqxsmjL]{Frightened} by this ability, it is @UUID[Compendium.pf2e.conditionitems.Item.AJh5ex99aV6VTggg]{Off-Guard} to the megaprimatus and to gorillas.</p><hr /><p><strong>Critical Success</strong> No effect and temporarily immune for 1 minute.</p><p><strong>Success</strong> The creature is unaffected.</p><p><strong>Failure</strong> The creature is @UUID[Compendium.pf2e.conditionitems.Item.TBSHQspnbcqxsmjL]{Frightened 1}.</p><p><strong>Critical Failure</strong> The creature is @UUID[Compendium.pf2e.conditionitems.Item.TBSHQspnbcqxsmjL]{Frightened 2} and @UUID[Compendium.pf2e.conditionitems.Item.sDPxOjQ9kx2RZE8D]{Fleeing} until the end of its next turn.</p>';

describe('parseSaveAbility', () => {
  it('parses Terrifying Display (Megaprimatus) fully, mode "auto", keeping its off-degree Off-Guard rider as GM rider text', () => {
    const descriptor = parseSaveAbility(item({ traits: ['auditory', 'emotion', 'fear', 'mental'], description: TERRIFYING_DISPLAY }));
    expect(descriptor.mode).toBe('auto');
    expect(descriptor.save).toBe('will');
    expect(descriptor.dc).toBe(27);
    expect(descriptor.shape).toEqual({ areaType: 'emanation', distanceFeet: 50 });
    expect(descriptor.affectsAllies).toBe(true);
    expect(descriptor.riderText).toMatch(/Off-Guard to the megaprimatus and to gorillas/);
    expect(descriptor.immuneSeconds).toBeNull();
    expect(descriptor.degrees.criticalSuccess).toEqual({ none: true, asFailure: false, conditions: [], immuneSeconds: 60 });
    expect(descriptor.degrees.success).toEqual({ none: true, asFailure: false, conditions: [], immuneSeconds: null });
    expect(descriptor.degrees.failure).toEqual({ none: false, asFailure: false, conditions: [{ slug: 'frightened', value: 1, durationSeconds: null }], immuneSeconds: null });
    // The duration belongs to Fleeing's own clause; Frightened decays on its own.
    expect(descriptor.degrees.criticalFailure).toEqual({
      none: false, asFailure: false,
      conditions: [{ slug: 'frightened', value: 2, durationSeconds: null }, { slug: 'fleeing', value: null, durationSeconds: 'untilNextTurn' }],
      immuneSeconds: null,
    });
    expect(descriptor.degreeText.failure).toBe('The creature is Frightened 1.');
  });

  it('parses the raw-source form of a condition link (name instead of id, no label)', () => {
    const descriptor = parseSaveAbility(item({
      description: '<p>Creatures within @Template[emanation|distance:10] must attempt a @Check[will|dc:20] save.</p><hr /><p><strong>Critical Success</strong> The creature is unaffected.</p><p><strong>Success</strong> The creature is unaffected.</p><p><strong>Failure</strong> The creature is @UUID[Compendium.pf2e.conditionitems.Item.Off-Guard] for 1 round.</p><p><strong>Critical Failure</strong> As failure.</p>',
    }));
    expect(descriptor.mode).toBe('auto');
    expect(descriptor.degrees.failure.conditions).toEqual([{ slug: 'off-guard', value: null, durationSeconds: 6 }]);
    expect(descriptor.degrees.criticalFailure.asFailure).toBe(true);
  });

  it('falls back to reportOnly for Radiant Wings -- its critical-failure block has a leftover conditional rider beyond "As failure"', () => {
    const descriptor = parseSaveAbility(item({
      traits: ['divine', 'incapacitation', 'light', 'mental', 'visual'],
      description: '<p>The quetz coatl spreads their multicolored wings and radiant plumage. Each enemy in a @Template[emanation|distance:30] must attempt a @Check[will|dc:29] save.</p><hr /><p><strong>Critical Success</strong> The creature is unaffected and is temporarily immune to Radiant Wings for 24 hours.</p><p><strong>Success</strong> The creature is @UUID[Compendium.pf2e.conditionitems.Item.TkIyaNPgTZFBCCuh]{Dazzled} for 1 round.</p><p><strong>Failure</strong> The creature is dazzled for 1 minute.</p><p><strong>Critical Failure</strong> As failure, plus if the creature is unholy, it is also @UUID[Compendium.pf2e.conditionitems.Item.dfCMdR4wnpbYNTix]{Stunned 3}.</p>',
    }));
    expect(descriptor.mode).toBe('reportOnly');
    expect(descriptor.traits).toContain('incapacitation');
    expect(descriptor.affectsAllies).toBe(false);
    expect(descriptor.degrees.criticalSuccess.immuneSeconds).toBe(86400);
    expect(descriptor.degrees.criticalFailure).toBeNull();
    expect(descriptor.degreeText.criticalFailure).toMatch(/if the creature is unholy/);
  });

  it('recognizes a bare, unlinked condition name in plain text (Radiant Wings\' own "dazzled" shape)', () => {
    const descriptor = parseSaveAbility(item({
      description: '<p>Test. @Template[emanation|distance:10] @Check[fortitude|dc:20] save.</p><hr /><p><strong>Critical Success</strong> The creature is unaffected.</p><p><strong>Success</strong> The creature is unaffected.</p><p><strong>Failure</strong> The creature is sickened for 1 minute.</p><p><strong>Critical Failure</strong> The creature is sickened for 1 minute.</p>',
    }));
    expect(descriptor.mode).toBe('auto');
    expect(descriptor.degrees.failure.conditions).toEqual([{ slug: 'sickened', value: null, durationSeconds: 60 }]);
  });

  it('falls back to reportOnly for Vanth\'s Curse -- its failure block has a leftover escalation clause', () => {
    const descriptor = parseSaveAbility(item({
      traits: ['curse', 'divine', 'misfortune'],
      frequency: { value: 3, max: 3, per: 'day' },
      description: '<p><strong>Frequency</strong> three times per day</p><hr /><p><strong>Effect</strong> The vanth bestows a curse on a creature by touching it with its scythe. The creature must attempt a @Check[will|dc:25] save.</p><hr /><p><strong>Critical Success</strong> The target is unaffected and is temporarily immune to Vanth\'s Curse for 24 hours.</p><p><strong>Success</strong> The target is @UUID[Compendium.pf2e.conditionitems.Item.e1XGnhKNSQIm5IXg]{Stupefied 1} for 1 minute.</p><p><strong>Failure</strong> For 1 hour, the target is @UUID[Compendium.pf2e.conditionitems.Item.e1XGnhKNSQIm5IXg]{Stupefied 2}. Each time the target gains the dying condition, the stupefied condition value increases by 1, to a maximum value of @UUID[Compendium.pf2e.conditionitems.Item.e1XGnhKNSQIm5IXg]{Stupefied 4}.</p><p><strong>Critical Failure</strong> As failure, but the effect is permanent.</p>',
    }));
    expect(descriptor.mode).toBe('reportOnly');
    expect(descriptor.shape).toEqual({ rangeFeet: AGENT_MELEE_REACH_FEET });
    expect(descriptor.frequency).toEqual({ value: 3, max: 3, per: 'day' });
  });

  it('resolves touch/melee range when no template and no explicit range phrase are present', () => {
    const descriptor = parseSaveAbility(item({
      description: '<p>Effect: by touching it, the creature must attempt a @Check[will|dc:20] save.</p><hr /><p><strong>Success</strong> The creature is unaffected.</p>',
    }));
    expect(descriptor.shape).toEqual({ rangeFeet: AGENT_MELEE_REACH_FEET });
    expect(AGENT_MELEE_REACH_FEET).toBe(5);
  });

  it('returns null (not offered) when there is neither a template, an explicit range, nor touch language', () => {
    const descriptor = parseSaveAbility(item({
      description: '<p>The creature must attempt a @Check[will|dc:20] save.</p><hr /><p><strong>Success</strong> The creature is unaffected.</p>',
    }));
    expect(descriptor).toBeNull();
  });

  it('ignores range/touch words that only appear inside a degree block', () => {
    const descriptor = parseSaveAbility(item({
      description: '<p>The creature must attempt a @Check[will|dc:20] save.</p><hr /><p><strong>Failure</strong> The creature can\'t move within 30 feet or touch anything.</p>',
    }));
    expect(descriptor).toBeNull();
  });

  it('returns null for a damaging ability (the breath-weapon/strike code owns it)', () => {
    expect(parseSaveAbility(item({ description: '<p>@Template[cone|distance:30] @Check[reflex|dc:25|basic] save. @Damage[6d6[fire]]</p>' }))).toBeNull();
  });

  it('returns null for a basic save even without an @Damage enricher (a basic save is a damage save)', () => {
    expect(parseSaveAbility(item({ description: '<p>@Template[cone|distance:30] @Check[reflex|dc:25|basic] save.</p><hr /><p><strong>Success</strong> The creature is unaffected.</p>' }))).toBeNull();
  });

  it('returns null for a passive or reaction item, and for a non-action item', () => {
    const description = '<p>@Template[emanation|distance:10] @Check[will|dc:20] save.</p><hr /><p><strong>Success</strong> The creature is unaffected.</p>';
    expect(parseSaveAbility(item({ actionType: 'passive', description }))).toBeNull();
    expect(parseSaveAbility(item({ actionType: 'reaction', description }))).toBeNull();
    expect(parseSaveAbility(item({ type: 'feat', description }))).toBeNull();
  });

  it('returns null for an ability with a Requirements or Trigger line (requirements are not verifiable here)', () => {
    expect(parseSaveAbility(item({ description: '<p><strong>Requirements</strong> A creature is grabbed.</p><hr /><p>@Template[emanation|distance:10] @Check[will|dc:20] save.</p><hr /><p><strong>Success</strong> The creature is unaffected.</p>' }))).toBeNull();
  });

  it('returns null for a free action with neither a frequency nor a recharge (nothing would limit its reuse)', () => {
    expect(parseSaveAbility(item({ actionType: 'free', description: '<p>@Template[emanation|distance:10] @Check[will|dc:20] save.</p><hr /><p><strong>Success</strong> The creature is unaffected.</p>' }))).toBeNull();
  });

  it('returns null when there is no saving-throw @Check at all', () => {
    expect(parseSaveAbility(item({ description: '<p>Just flavor text, no save.</p>' }))).toBeNull();
    expect(parseSaveAbility(item({ description: '<p>Within 30 feet, @Check[athletics|dc:20].</p><hr /><p><strong>Success</strong> The creature is unaffected.</p>' }))).toBeNull();
  });

  it('parses an explicit single-target range phrase ("within 30 feet") when no template is present', () => {
    const descriptor = parseSaveAbility(item({
      description: '<p>A creature within 30 feet must attempt a @Check[will|dc:20] save.</p><hr /><p><strong>Success</strong> The creature is unaffected.</p>',
    }));
    expect(descriptor.shape).toEqual({ rangeFeet: 30 });
  });

  it('is reportOnly when the outcome blocks are missing entirely (a recognizable save, unparseable outcome)', () => {
    const descriptor = parseSaveAbility(item({
      description: '<p>A creature within 30 feet must succeed at a @Check[will|dc:20] save or become frightened 1.</p>',
    }));
    expect(descriptor.mode).toBe('reportOnly');
  });

  it('is reportOnly when a degree block is missing (all four are needed to auto-apply)', () => {
    const descriptor = parseSaveAbility(item({
      description: '<p>@Template[emanation|distance:10] @Check[will|dc:20] save.</p><hr /><p><strong>Success</strong> The creature is unaffected.</p><p><strong>Failure</strong> The creature is frightened 1.</p>',
    }));
    expect(descriptor.mode).toBe('reportOnly');
  });

  it('forwards the @Check\'s own options (inflicts:<slug>, area-effect) as roll options, never as an inflicted condition', () => {
    const descriptor = parseSaveAbility(item({
      description: '<p>@Template[emanation|distance:10] @Check[will|dc:18|options:area-effect,inflicts:frightened] save.</p><hr /><p><strong>Critical Success</strong> The creature is unaffected.</p><p><strong>Success</strong> The creature is unaffected.</p><p><strong>Failure</strong> The creature is frightened.</p><p><strong>Critical Failure</strong> The creature is frightened 2.</p>',
    }));
    expect(descriptor.rollOptions).toEqual(['area-effect', 'inflicts:frightened']);
    expect(descriptor.degrees.success.conditions).toEqual([]);
    expect(descriptor.degrees.failure.conditions).toEqual([{ slug: 'frightened', value: null, durationSeconds: null }]);
  });

  it('merges the @Check\'s own traits param with the item\'s traits (the system\'s inline-check behaviour)', () => {
    const descriptor = parseSaveAbility(item({
      traits: ['mental'],
      description: '<p>@Template[emanation|distance:10] @Check[will|dc:18|traits:incapacitation] save.</p><hr /><p><strong>Success</strong> The creature is unaffected.</p>',
    }));
    expect(descriptor.traits).toEqual(['incapacitation', 'mental']);
  });

  it('parses a recharge formula', () => {
    const descriptor = parseSaveAbility(item({
      description: '<p>@Template[emanation|distance:10] @Check[will|dc:18] save. [[/gmr 1d4 #Recharge Screech]]{1d4 rounds}</p><hr /><p><strong>Success</strong> The creature is unaffected.</p>',
    }));
    expect(descriptor.rechargeFormula).toBe('1d4');
  });

  it('reads "Creatures within 30 feet of the X" as an emanation, not one target (Aqudel\'s Strobe), with per-clause durations', () => {
    const descriptor = parseSaveAbility(item({
      traits: ['concentrate', 'visual'],
      description: '<p>The aqudel changes the intensity and pattern of their skin in a rapid pulse, attempting to disorient any creatures that can see them. Creatures within 30 feet of the aqudel must attempt a @Check[will|dc:25|options:area-effect,inflicts:dazzled,inflicts:stunned] save. The aqudel can\'t use Strobe again for [[/gmr 1d4 #Recharge Strobe]]{1d4 rounds}.</p><hr /><p><strong>Critical Success</strong> The target is unaffected.</p>\n<p><strong>Success</strong> The target is @UUID[Compendium.pf2e.conditionitems.Item.Dazzled] for 1 round.</p>\n<p><strong>Failure</strong> The target is dazzled for 1 minute and @UUID[Compendium.pf2e.conditionitems.Item.Stunned]{Stunned 1}.</p>\n<p><strong>Critical Failure</strong> The target is dazzled for 1 minute and @UUID[Compendium.pf2e.conditionitems.Item.Stunned]{Stunned 2}</p>',
    }));
    expect(descriptor.mode).toBe('auto');
    expect(descriptor.shape).toEqual({ areaType: 'emanation', distanceFeet: 30 });
    expect(descriptor.rechargeFormula).toBe('1d4');
    expect(descriptor.degrees.failure.conditions).toEqual([
      { slug: 'dazzled', value: null, durationSeconds: 60 },
      { slug: 'stunned', value: 1, durationSeconds: null },
    ]);
  });

  it('applies a leading floating duration ("For 1 hour, the target is ...") to the block\'s conditions', () => {
    const descriptor = parseSaveAbility(item({
      description: '<p>@Template[emanation|distance:10] @Check[will|dc:20] save.</p><hr /><p><strong>Critical Success</strong> The target is unaffected.</p><p><strong>Success</strong> The target is unaffected.</p><p><strong>Failure</strong> For 1 hour, the target is @UUID[Compendium.pf2e.conditionitems.Item.Stupefied]{Stupefied 2}.</p><p><strong>Critical Failure</strong> As failure.</p>',
    }));
    expect(descriptor.mode).toBe('auto');
    expect(descriptor.degrees.failure.conditions).toEqual([{ slug: 'stupefied', value: 2, durationSeconds: 3600 }]);
  });

  it('records a preamble immunity that applies regardless of the result (Bloodcurdling Screech)', () => {
    const descriptor = parseSaveAbility(item({
      traits: ['auditory', 'emotion', 'fear', 'mental'],
      description: '<p>The owlbear unleashes a loud screech that terrifies its prey. Each creature in an @Template[emanation|distance:80] must attempt a @Check[will|dc:20] save. Regardless of the result, creatures are temporarily immune for 1 minute.</p>\n<hr />\n<p><strong>Critical Success</strong> The creature is unaffected.</p>\n<p><strong>Success</strong> The creature is @UUID[Compendium.pf2e.conditionitems.Item.Frightened]{Frightened 1}.</p>\n<p><strong>Failure</strong> The creature is @UUID[Compendium.pf2e.conditionitems.Item.Frightened]{Frightened 2}.</p>\n<p><strong>Critical Failure</strong> The creature is @UUID[Compendium.pf2e.conditionitems.Item.Fleeing] for 1 round and @UUID[Compendium.pf2e.conditionitems.Item.Frightened]{Frightened 3}.</p>',
    }));
    expect(descriptor.mode).toBe('auto');
    expect(descriptor.immuneSeconds).toBe(60);
    expect(descriptor.riderText).toBeNull();
    expect(descriptor.degrees.criticalFailure.conditions).toEqual([
      { slug: 'fleeing', value: null, durationSeconds: 6 },
      { slug: 'frightened', value: 3, durationSeconds: null },
    ]);
  });

  it('does not offer a burst whose center has no stated range ("within reach of its tail Strike")', () => {
    expect(parseSaveAbility(item({
      description: '<p>The mokele-mbembe cracks its tail, creating a sonic boom in a @Template[burst|distance:5] centered on a corner within reach of its tail Strike.</p><p>Each creature in the burst\'s area must attempt a @Check[fortitude|dc:28] save.</p><hr /><p><strong>Success</strong> The creature is unaffected.</p>',
    }))).toBeNull();
  });

  it('keeps a burst\'s stated center range', () => {
    const descriptor = parseSaveAbility(item({
      description: '<p>A @Template[burst|distance:10] centered within 60 feet; each creature must attempt a @Check[will|dc:20] save.</p><hr /><p><strong>Success</strong> The creature is unaffected.</p>',
    }));
    expect(descriptor.shape).toEqual({ areaType: 'burst', distanceFeet: 10, rangeFeet: 60 });
  });

  it('does not offer an "up to N creatures" target-count ability', () => {
    expect(parseSaveAbility(item({
      description: '<p>Up to three creatures within 30 feet must attempt a @Check[will|dc:20] save.</p><hr /><p><strong>Success</strong> The creature is unaffected.</p>',
    }))).toBeNull();
  });
});
