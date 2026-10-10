// tests/npc-ability-parse.test.mjs
import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import { parseSaveAbility, describeNpcAbility, npcAbilityExcludesTarget, AGENT_MELEE_REACH_FEET } from '../scripts/npc-ability-parse.mjs';

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
    expect(descriptor.degrees.criticalSuccess).toEqual({ none: true, conditions: [], penalties: [], immuneSeconds: 60 });
    expect(descriptor.degrees.success).toEqual({ none: true, conditions: [], penalties: [], immuneSeconds: null });
    expect(descriptor.degrees.failure).toEqual({ none: false, conditions: [{ slug: 'frightened', value: 1, durationSeconds: null }], penalties: [], immuneSeconds: null });
    // The duration belongs to Fleeing's own clause; Frightened decays on its own.
    expect(descriptor.degrees.criticalFailure).toEqual({
      none: false,
      conditions: [{ slug: 'frightened', value: 2, durationSeconds: null }, { slug: 'fleeing', value: null, durationSeconds: 'untilNextTurn' }],
      penalties: [],
      immuneSeconds: null,
    });
    expect(descriptor.family).toBe('blocks');
    expect(descriptor.targetFilter).toBeNull();
    expect(descriptor.degreeText.failure).toBe('The creature is Frightened 1.');
  });

  it('parses the raw-source form of a condition link (name instead of id, no label)', () => {
    const descriptor = parseSaveAbility(item({
      description: '<p>Creatures within @Template[emanation|distance:10] must attempt a @Check[will|dc:20] save.</p><hr /><p><strong>Critical Success</strong> The creature is unaffected.</p><p><strong>Success</strong> The creature is unaffected.</p><p><strong>Failure</strong> The creature is @UUID[Compendium.pf2e.conditionitems.Item.Off-Guard] for 1 round.</p><p><strong>Critical Failure</strong> As failure.</p>',
    }));
    expect(descriptor.mode).toBe('auto');
    expect(descriptor.degrees.failure.conditions).toEqual([{ slug: 'off-guard', value: null, durationSeconds: 6 }]);
    // #935: "As failure." is resolved to the failure outcome itself.
    expect(descriptor.degrees.criticalFailure).toEqual(descriptor.degrees.failure);
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

  it('is reportOnly when there are no outcome blocks and the inline outcome is outside the grammar (#935)', () => {
    const descriptor = parseSaveAbility(item({
      description: '<p>A creature within 30 feet must succeed at a @Check[will|dc:20] save or forget its own name.</p>',
    }));
    expect(descriptor.mode).toBe('reportOnly');
    expect(descriptor.family).toBe('inline');
  });

  it('is reportOnly when the success or failure block is missing', () => {
    const descriptor = parseSaveAbility(item({
      description: '<p>@Template[emanation|distance:10] @Check[will|dc:20] save.</p><hr /><p><strong>Critical Success</strong> The creature is unaffected.</p><p><strong>Failure</strong> The creature is frightened 1.</p>',
    }));
    expect(descriptor.mode).toBe('reportOnly');
  });

  it('gives an unlisted critical success the success effect and an unlisted critical failure the failure effect (#935, PF2e convention)', () => {
    const descriptor = parseSaveAbility(item({
      description: '<p>@Template[emanation|distance:10] @Check[will|dc:20] save.</p><hr /><p><strong>Success</strong> The creature is unaffected.</p><p><strong>Failure</strong> The creature is frightened 1.</p>',
    }));
    expect(descriptor.mode).toBe('auto');
    expect(descriptor.degrees.criticalSuccess).toEqual(descriptor.degrees.success);
    expect(descriptor.degrees.criticalFailure).toEqual(descriptor.degrees.failure);
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

describe('describeNpcAbility (#915)', () => {
  it('summarizes save, shape and the auto-applied outcomes deterministically', () => {
    const descriptor = parseSaveAbility(item({ description: TERRIFYING_DISPLAY }));
    expect(describeNpcAbility(descriptor)).toBe(
      'will DC 27, 50-ft emanation; success: no effect; failure: frightened 1; critical failure: frightened 2, fleeing (until end of its next turn)',
    );
  });

  it('says the GM resolves a reportOnly ability\'s outcome, and names a single target\'s range', () => {
    expect(describeNpcAbility({ save: 'will', dc: 25, shape: { rangeFeet: 5 }, mode: 'reportOnly', degrees: {} })).toBe(
      'will DC 25, single target within 5 ft; outcome resolved by the GM',
    );
  });
});

// #935: real compendium texts come from the committed 369-ability slice
// (pf2e source data); `fixtureItem` adds the item's name, as a live item has.
const SLICE = JSON.parse(
  readFileSync(new URL('./fixtures/npc-save-ability-slice.json', import.meta.url), 'utf8'),
).entries;
function fixtureItem(actor, name) {
  const entry = SLICE.find((e) => e.actor === actor && e.name === name);
  if (!entry) throw new Error(`no fixture entry ${actor} :: ${name}`);
  return { ...entry.item, name: entry.name };
}
const blockItem = (blocks, preamble = '<p>Each creature in a @Template[emanation|distance:30] must attempt a @Check[will|dc:20] save.</p><hr />') =>
  item({
    description: preamble + Object.entries(blocks).map(([label, body]) => `<p><strong>${label}</strong> ${body}</p>`).join(''),
  });
const cond = (slug, value = null, durationSeconds = null) => ({ slug, value, durationSeconds });

describe('degree-block grammar widening (#935)', () => {
  it('still reads a bare (unlinked) condition word -- regression guard for #915\'s extractBareConditions', () => {
    const d = parseSaveAbility(blockItem({
      'Critical Success': 'The creature is unaffected.',
      Success: 'The creature is unaffected.',
      Failure: 'The creature is Frightened 1.',
      'Critical Failure': 'The creature is Frightened 2.',
    }));
    expect(d.mode).toBe('auto');
    expect(d.degrees.criticalFailure.conditions).toEqual([cond('frightened', 2)]);
  });

  it('resolves "As success" and "As critical failure" references, not just "As failure"', () => {
    const d = parseSaveAbility(blockItem({
      'Critical Success': 'The creature is unaffected.',
      Success: 'As critical success.',
      Failure: 'The creature is Frightened 1.',
      'Critical Failure': 'As failure.',
    }));
    expect(d.mode).toBe('auto');
    expect(d.degrees.success).toEqual(d.degrees.criticalSuccess);
    expect(d.degrees.criticalFailure).toEqual(d.degrees.failure);
  });

  it('"As failure, but for 1 minute" changes the duration (Gongorinan\'s Disquieting Display, real text)', () => {
    const d = parseSaveAbility(fixtureItem('Gongorinan', 'Disquieting Display'));
    expect(d.mode).toBe('auto');
    // "Clumsy 2 and Slowed 1 for 1 round": the trailing duration covers both.
    expect(d.degrees.failure.conditions).toEqual([cond('clumsy', 2, 6), cond('slowed', 1, 6)]);
    expect(d.degrees.criticalFailure.conditions).toEqual([cond('clumsy', 2, 60), cond('slowed', 1, 60)]);
    // "... after which they are temporarily immune ... for 1 minute": everyone.
    expect(d.immuneSeconds).toBe(60);
  });

  it('"As failure, plus <condition> for as long as it\'s frightened" adds a condition (Deep One\'s Share Devotion, real text)', () => {
    const d = parseSaveAbility(fixtureItem('Deep One', 'Share Devotion'));
    expect(d.mode).toBe('auto');
    expect(d.degrees.criticalFailure.conditions).toEqual([cond('frightened', 2), cond('dazzled', null, 'while:frightened')]);
  });

  it('"As failure, but <condition>" replaces the same condition, keeping its duration', () => {
    const d = parseSaveAbility(blockItem({
      Success: 'The creature is unaffected.',
      Failure: 'The creature is Stupefied 2 for 1 minute.',
      'Critical Failure': 'As failure, but the creature is Stupefied 3.',
    }));
    expect(d.mode).toBe('auto');
    expect(d.degrees.criticalFailure.conditions).toEqual([cond('stupefied', 3, 60)]);
  });

  it('an "As X" suffix outside the grammar keeps the ability reportOnly (Radiant Wings, Vanth\'s Curse, Augnagar, real texts)', () => {
    expect(parseSaveAbility(fixtureItem('Quetz Coatl', 'Radiant Wings')).mode).toBe('reportOnly');
    expect(parseSaveAbility(fixtureItem('Vanth', "Vanth's Curse")).mode).toBe('reportOnly');
    expect(parseSaveAbility(fixtureItem('Augnagar', 'Confusing Display')).mode).toBe('reportOnly');
  });

  it('strips a fascination\'s subject ("fascinated by the melody on the wind") and scopes success-only preamble immunity (Mesmerizing Melody, real text)', () => {
    const d = parseSaveAbility(fixtureItem('Melody on the Wind', 'Mesmerizing Melody'));
    expect(d.mode).toBe('auto');
    expect(d.degrees.success.conditions).toEqual([cond('fascinated', null, 6)]);
    expect(d.degrees.failure.conditions).toEqual([cond('fascinated', null, 24)]);
    // No critical failure block: the failure effect.
    expect(d.degrees.criticalFailure).toEqual(d.degrees.failure);
    // "A creature that succeeds at its save is temporarily immune for 24 hours".
    expect(d.immuneSeconds).toBeNull();
    expect(d.degrees.criticalSuccess.immuneSeconds).toBe(86400);
    expect(d.degrees.success.immuneSeconds).toBe(86400);
    expect(d.degrees.failure.immuneSeconds).toBeNull();
  });

  it('reads an immunity-only block and an "until no longer sickened" duration (Giant Pangolin\'s Emit Musk, real text)', () => {
    const d = parseSaveAbility(fixtureItem('Giant Pangolin', 'Emit Musk'));
    expect(d.mode).toBe('auto');
    expect(d.degrees.criticalSuccess).toEqual({ none: true, conditions: [], penalties: [], immuneSeconds: 60 });
    expect(d.degrees.criticalFailure.conditions).toEqual([cond('sickened', 1), cond('off-guard', null, 'while:sickened')]);
  });

  it('shares a trailing duration with the earlier conditions of its sentence, but not with a self-ending one (Wihsaak, real text)', () => {
    const d = parseSaveAbility(fixtureItem('Wihsaak', 'Droning Distraction'));
    expect(d.mode).toBe('auto');
    expect(d.degrees.failure.conditions).toEqual([cond('confused', null, 6), cond('stupefied', 1, 6)]);
    expect(d.degrees.criticalFailure.conditions).toEqual([cond('confused', null, 6), cond('stupefied', 2, 60)]);
    const terrifying = parseSaveAbility(item({ description: TERRIFYING_DISPLAY }));
    expect(terrifying.degrees.criticalFailure.conditions[0]).toEqual(cond('frightened', 2));
  });

  it('never applies a timed-style condition open-ended: Trumpet Blast\'s bare "Off-Guard" success is reportOnly (real text)', () => {
    expect(parseSaveAbility(fixtureItem('Trumpet Archon', 'Trumpet Blast')).mode).toBe('reportOnly');
  });

  it('does not model a duration-based Stunned ("stunned for 1 round", Zoaem\'s Behold!, real text)', () => {
    expect(parseSaveAbility(fixtureItem('Zoaem', 'Behold!')).mode).toBe('reportOnly');
  });

  it('a bespoke trailing clause still disqualifies the block (Skaveling\'s "Stunned 1 by fear" is left to the override table)', () => {
    const d = parseSaveAbility(blockItem({
      Success: 'The creature is unaffected.',
      Failure: 'The creature is Frightened 1.',
      'Critical Failure': 'As failure, and the creature also forgets the last minute.',
    }));
    expect(d.mode).toBe('reportOnly');
  });
});

describe('penalty outcomes (#935)', () => {
  it('reads a status penalty to Speeds with a duration', () => {
    const d = parseSaveAbility(blockItem({
      Success: 'The creature is unaffected.',
      Failure: 'The creature takes a –10-foot status penalty to its Speeds for 1 round.',
    }));
    expect(d.mode).toBe('auto');
    expect(d.degrees.failure.penalties).toEqual([{ type: 'status', value: -10, selectors: ['all-speeds'], durationSeconds: 6 }]);
  });

  it('reads one penalty to several statistics, with a leading floating duration', () => {
    const d = parseSaveAbility(blockItem({
      Success: 'The creature is unaffected.',
      Failure: 'For 1 minute, the creature takes a -1 status penalty to attack rolls, saving throws, and skill checks.',
    }));
    expect(d.mode).toBe('auto');
    expect(d.degrees.failure.penalties).toEqual([
      { type: 'status', value: -1, selectors: ['attack-roll', 'saving-throw', 'skill-check'], durationSeconds: 60 },
    ]);
    expect(describeNpcAbility(d)).toContain('failure: -1 status penalty to attack-roll/saving-throw/skill-check (1 minute)');
  });

  it('reads a named-save penalty alongside a condition', () => {
    const d = parseSaveAbility(blockItem({
      Success: 'The creature is unaffected.',
      Failure: 'The creature is Dazzled for 1 round and takes a -1 circumstance penalty to Will saves for 1 round.',
    }));
    expect(d.mode).toBe('auto');
    expect(d.degrees.failure.conditions).toEqual([cond('dazzled', null, 6)]);
    expect(d.degrees.failure.penalties).toEqual([{ type: 'circumstance', value: -1, selectors: ['will'], durationSeconds: 6 }]);
  });

  it('does not let a clean penalty clause rescue a trailing rider (Bittersweet Dreams, real text)', () => {
    expect(parseSaveAbility(fixtureItem('Dramofir', 'Bittersweet Dreams')).mode).toBe('reportOnly');
    const d = parseSaveAbility(blockItem({
      Success: 'For 1 round, the creature takes a -1 status penalty to attack rolls, saving throws, and skill checks, and all other emotion effects on it are suppressed.',
      Failure: 'The creature is Frightened 1.',
    }));
    expect(d.mode).toBe('reportOnly');
  });

  it('never guesses a backward-reference selector ("checks using that skill" -- Steal Knowledge, real text)', () => {
    expect(parseSaveAbility(fixtureItem('Whisper Dragon (Adult)', 'Steal Knowledge')).mode).toBe('reportOnly');
  });

  it('rejects a single-use "next saving throw" penalty (Mask of Fate, real text)', () => {
    expect(parseSaveAbility(fixtureItem('Divine Warden of Pharasma', 'Mask of Fate')).mode).toBe('reportOnly');
  });

  it('rejects a penalty with no stated end (Fiddle\'s Speed penalty lasts while the grig fiddles, real text)', () => {
    expect(parseSaveAbility(fixtureItem('Grig', 'Fiddle')).mode).toBe('reportOnly');
  });

  it('rejects a penalty "against" something narrower than a statistic (Funereal Dirge, real text)', () => {
    expect(parseSaveAbility(fixtureItem('Cairn Wight', 'Funereal Dirge')).mode).toBe('reportOnly');
  });
});

describe('inline-outcome grammar (#935)', () => {
  it('reads "becomes <condition> unless they succeed" with the crit-success immunity and the non-boggard filter (Terrifying Croak, real text)', () => {
    const d = parseSaveAbility(fixtureItem('Boggard Warrior', 'Terrifying Croak'));
    expect(d.mode).toBe('auto');
    expect(d.family).toBe('inline');
    expect(d.shape).toEqual({ areaType: 'emanation', distanceFeet: 30 });
    expect(d.targetFilter).toEqual({ excludeTraits: ['boggard'], excludeNames: [], livingOnly: false });
    expect(d.degrees.criticalSuccess).toEqual({ none: true, conditions: [], penalties: [], immuneSeconds: 60 });
    expect(d.degrees.success).toEqual({ none: true, conditions: [], penalties: [], immuneSeconds: null });
    expect(d.degrees.failure.conditions).toEqual([cond('frightened', 1)]);
    expect(d.degrees.criticalFailure.conditions).toEqual([cond('frightened', 1)]);
    expect(d.immuneSeconds).toBeNull();
    expect(describeNpcAbility(d)).toBe(
      'will DC 18, 30-ft emanation (non-boggard only); success: no effect; failure: frightened 1; critical failure: frightened 1',
    );
  });

  it('reads compiled runtime links (id plus label) the same as source names', () => {
    const source = fixtureItem('Boggard Warrior', 'Terrifying Croak');
    const compiled = {
      ...source,
      system: {
        ...source.system,
        description: { value: source.system.description.value.replace('Item.Frightened]', 'Item.TBSHQspnbcqxsmjL]') },
      },
    };
    expect(parseSaveAbility(compiled)).toEqual(parseSaveAbility(source));
  });

  it('reads "attempt a save. On a failure, ... (or ... on a critical failure). On a success, ... immune" for living creatures (Frightful Moan, real text)', () => {
    const d = parseSaveAbility(fixtureItem('Ghost Commoner', 'Frightful Moan'));
    expect(d.mode).toBe('auto');
    expect(d.targetFilter).toEqual({ excludeTraits: [], excludeNames: [], livingOnly: true });
    expect(d.degrees.failure.conditions).toEqual([cond('frightened', 2)]);
    expect(d.degrees.criticalFailure.conditions).toEqual([cond('frightened', 3)]);
    expect(d.degrees.success.immuneSeconds).toBe(60);
    expect(d.degrees.criticalSuccess.immuneSeconds).toBe(60);
    expect(d.immuneSeconds).toBeNull();
  });

  it('reads "must succeed ... or be X and Y (or Z on a critical failure) for 1 round" with a regardless-of-result immunity (Captivating Display, real text)', () => {
    const d = parseSaveAbility(fixtureItem('Mirage Dragon (Adult)', 'Captivating Display'));
    expect(d.mode).toBe('auto');
    expect(d.degrees.failure.conditions).toEqual([cond('dazzled', null, 6), cond('slowed', 1, 6)]);
    expect(d.degrees.criticalFailure.conditions).toEqual([cond('dazzled', null, 6), cond('slowed', 2, 6)]);
    expect(d.degrees.success.none).toBe(true);
    expect(d.immuneSeconds).toBe(60);
  });

  it('reads a parenthetical with success and critical-success outcomes (Bunyip\'s Roar, real text)', () => {
    const d = parseSaveAbility(fixtureItem('Bunyip', 'Roar'));
    expect(d.mode).toBe('auto');
    expect(d.degrees.criticalSuccess.none).toBe(true);
    expect(d.degrees.success.conditions).toEqual([cond('frightened', 1)]);
    expect(d.degrees.failure.conditions).toEqual([cond('frightened', 2)]);
    expect(d.degrees.criticalFailure.conditions).toEqual([cond('frightened', 3)]);
    expect(d.immuneSeconds).toBe(60);
  });

  it('reads a critical-failure duration change "(or 1 minute on a critical failure)" (Graffiti Egg, real text)', () => {
    const d = parseSaveAbility(fixtureItem('Halfling Troublemaker', 'Graffiti Egg'));
    expect(d.mode).toBe('auto');
    expect(d.shape).toEqual({ rangeFeet: 30 });
    expect(d.degrees.failure.conditions).toEqual([cond('dazzled', null, 6)]);
    expect(d.degrees.criticalFailure.conditions).toEqual([cond('dazzled', null, 60)]);
  });

  it('reads "On a critical failure, a creature is also ...", success-scoped immunity and the recharge sentence (Goblin Breath, real text)', () => {
    const d = parseSaveAbility(fixtureItem('Goblin Snake', 'Goblin Breath'));
    expect(d.mode).toBe('auto');
    expect(d.rechargeFormula).toBe('1d4');
    expect(d.targetFilter.excludeTraits).toEqual(['goblin']);
    expect(d.degrees.criticalFailure.conditions).toEqual([cond('sickened', 1), cond('slowed', 1, 'while:sickened')]);
    expect(d.degrees.success.immuneSeconds).toBe(86400);
    expect(d.degrees.failure.immuneSeconds).toBeNull();
  });

  it('reads "... that fail a save become X (Y on a critical failure)" (Urglid\'s Gravechoke, real text)', () => {
    const d = parseSaveAbility(fixtureItem('Urglid', 'Gravechoke'));
    expect(d.mode).toBe('auto');
    expect(d.degrees.failure.conditions).toEqual([cond('sickened', 1)]);
    expect(d.degrees.criticalFailure.conditions).toEqual([cond('sickened', 2)]);
  });

  it('reads "or fall Prone" / "or be knocked Prone" (Tripping Tide, Tail Sweep, real texts)', () => {
    expect(parseSaveAbility(fixtureItem('Island Oni', 'Tripping Tide')).degrees.failure.conditions).toEqual([cond('prone')]);
    expect(parseSaveAbility(fixtureItem('Osyluth', 'Tail Sweep')).degrees.failure.conditions).toEqual([cond('prone')]);
  });

  it('a bundled effect (forced movement alongside the condition) stays reportOnly (Forceful Winds, real text)', () => {
    expect(parseSaveAbility(fixtureItem('Living Whirlwind', 'Forceful Winds')).mode).toBe('reportOnly');
  });

  it('an effect on every target before the save sentence stays reportOnly, never dropped (Cytillesh Stare, real text)', () => {
    expect(parseSaveAbility(fixtureItem('Dero Magister', 'Cytillesh Stare')).mode).toBe('reportOnly');
  });

  it('a stacking/escalation rider after the outcome stays reportOnly (Lamia\'s Caress, real text)', () => {
    expect(parseSaveAbility(fixtureItem('Lamia', "Lamia's Caress")).mode).toBe('reportOnly');
  });

  it('a spell-effect outcome stays reportOnly (Desert Wind, real text)', () => {
    expect(parseSaveAbility(fixtureItem('Brass Dragon (Adult)', 'Desert Wind')).mode).toBe('reportOnly');
  });

  it('a success-only wording with no stated failure outcome never defaults to no effect', () => {
    const d = parseSaveAbility(item({
      description: '<p>Each creature within @Template[emanation|distance:20] must attempt a @Check[will|dc:20] save; a creature is unaffected on a success.</p>',
    }));
    expect(d.mode).toBe('reportOnly');
  });
});

describe('target filters (#935)', () => {
  it('a "non-" word that is neither a creature trait nor the creature\'s own kind is reportOnly (Terror Shrike\'s "non-terror bird", real text)', () => {
    const d = parseSaveAbility(fixtureItem('Terror Shrike', 'Stunning Screech'));
    expect(d.mode).toBe('reportOnly');
  });

  it('"Non-d\'ziriaks" names the acting creature\'s own kind (Dazzling Burst, real text)', () => {
    const d = parseSaveAbility(fixtureItem("D'ziriak", 'Dazzling Burst'));
    expect(d.mode).toBe('auto');
    expect(d.targetFilter).toEqual({ excludeTraits: [], excludeNames: ["d'ziriak"], livingOnly: false });
    // "A creature that attempts this save is immune to all Dazzling Bursts for 1 minute."
    expect(d.immuneSeconds).toBe(60);
  });

  it('"living or undead" is not a filter the module can test', () => {
    expect(parseSaveAbility(fixtureItem('Nosoi', 'Haunting Melody')).mode).toBe('reportOnly');
  });

  it('npcAbilityExcludesTarget tests the target\'s traits, name and mode of being', () => {
    const boggard = { targetFilter: { excludeTraits: ['boggard'], excludeNames: [], livingOnly: false } };
    expect(npcAbilityExcludesTarget(boggard, { traits: new Set(['boggard', 'humanoid']), name: 'Boggard Scout' })).toBe(true);
    expect(npcAbilityExcludesTarget(boggard, { traits: new Set(['human', 'humanoid']), name: 'Valeros' })).toBe(false);
    expect(npcAbilityExcludesTarget(boggard, { system: { traits: { value: ['boggard'] } }, name: 'x' })).toBe(true);
    const named = { targetFilter: { excludeTraits: [], excludeNames: ['emperor cobra'], livingOnly: false } };
    expect(npcAbilityExcludesTarget(named, { traits: new Set(), name: 'Emperor Cobra' })).toBe(true);
    const living = { targetFilter: { excludeTraits: [], excludeNames: [], livingOnly: true } };
    expect(npcAbilityExcludesTarget(living, { traits: new Set(['undead']), modeOfBeing: 'undead', name: 'Zombie' })).toBe(true);
    expect(npcAbilityExcludesTarget(living, { traits: new Set(['construct']), name: 'Golem' })).toBe(true);
    expect(npcAbilityExcludesTarget(living, { traits: new Set(['human']), modeOfBeing: 'living', name: 'Kyra' })).toBe(false);
    expect(npcAbilityExcludesTarget({ targetFilter: null }, { traits: new Set(['boggard']) })).toBe(false);
  });
});
