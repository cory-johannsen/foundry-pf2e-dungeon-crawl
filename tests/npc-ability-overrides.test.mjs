// tests/npc-ability-overrides.test.mjs
import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import { NPC_ABILITY_OVERRIDES, findNpcAbilityOverride } from '../scripts/npc-ability-overrides.mjs';
import { parseSaveAbility, KNOWN_CONDITION_SLUGS } from '../scripts/npc-ability-parse.mjs';

// #935: the reviewed override table. Each entry is checked against the real
// compendium text in the committed slice (pf2e source data): if a refreshed
// compendium changes an overridden ability's text, these tests fail and the
// entry is re-reviewed (at runtime the entry is simply ignored).
const { entries } = JSON.parse(
  readFileSync(new URL('./fixtures/npc-save-ability-slice.json', import.meta.url), 'utf8'),
);
const withName = (entry) => ({ ...entry.item, name: entry.name });
const DEGREES = ['criticalSuccess', 'success', 'failure', 'criticalFailure'];

describe('NPC_ABILITY_OVERRIDES (#935)', () => {
  it('every entry matches at least one real fixture item, whose text still reads as reviewed', () => {
    for (const override of NPC_ABILITY_OVERRIDES) {
      const matches = entries.filter((e) => e.name === override.name);
      expect(matches.length, override.name).toBeGreaterThan(0);
      for (const entry of matches) {
        const descriptor = parseSaveAbility(withName(entry));
        expect(descriptor?.family, `${entry.actor}: ${entry.name}`).toBe('override');
        expect(descriptor.save).toBe(override.save);
      }
    }
  });

  it('every entry is a complete outcome: four concrete degrees of known conditions', () => {
    for (const override of NPC_ABILITY_OVERRIDES) {
      expect(override.verifiedText.length, override.name).toBeGreaterThan(0);
      for (const key of DEGREES) {
        const degree = override.descriptor.degrees[key];
        expect(degree, `${override.name} ${key}`).toBeTruthy();
        expect(Object.keys(degree).sort()).toEqual(['conditions', 'immuneSeconds', 'none', 'penalties']);
        const effects = degree.conditions.length + degree.penalties.length;
        expect(degree.none ? effects === 0 : effects > 0, `${override.name} ${key}`).toBe(true);
        for (const c of degree.conditions) expect(KNOWN_CONDITION_SLUGS).toContain(c.slug);
      }
    }
  });

  it('every entry overrides an ability the grammar leaves reportOnly (an override never replaces a working parse)', () => {
    for (const override of NPC_ABILITY_OVERRIDES) {
      for (const entry of entries.filter((e) => e.name === override.name)) {
        // Without its name the item can't match an override: the grammar alone.
        expect(parseSaveAbility(entry.item)?.mode, `${entry.actor}: ${entry.name}`).toBe('reportOnly');
      }
    }
  });

  it('Unnatural Shriek: the compendium\'s "stupefed" typo, read as written otherwise', () => {
    const entry = entries.find((e) => e.actor === 'Argorth' && e.name === 'Unnatural Shriek');
    const d = parseSaveAbility(withName(entry));
    expect(d.mode).toBe('auto');
    expect(d.family).toBe('override');
    // Save, DC, traits and cost still come from the item's own enrichers.
    expect(d.save).toBe('will');
    expect(d.dc).toBe(30);
    expect(d.traits).toEqual(['auditory', 'emotion', 'fear', 'mental']);
    expect(d.shape).toEqual({ areaType: 'emanation', distanceFeet: 120 });
    expect(d.targetFilter).toEqual({ excludeTraits: ['aberration'], excludeNames: [], livingOnly: false });
    expect(d.immuneSeconds).toBe(86400);
    expect(d.degrees.failure.conditions).toEqual([
      { slug: 'stupefied', value: 1, durationSeconds: 60 },
      { slug: 'frightened', value: 2, durationSeconds: null },
    ]);
  });

  it('Bone-Chilling Screech: "Stunned 1 by fear", with its recharge from the item', () => {
    const entry = entries.find((e) => e.actor === 'Skaveling' && e.name === 'Bone-Chilling Screech');
    const d = parseSaveAbility(withName(entry));
    expect(d.mode).toBe('auto');
    expect(d.rechargeFormula).toBe('1d4');
    expect(d.shape).toEqual({ areaType: 'emanation', distanceFeet: 20 });
    expect(d.degrees.criticalSuccess.immuneSeconds).toBe(86400);
    expect(d.degrees.criticalFailure.conditions.map((c) => c.slug)).toEqual(['frightened', 'stunned']);
  });

  it('a changed text disables the entry at runtime: the grammar result applies instead', () => {
    const entry = entries.find((e) => e.actor === 'Argorth' && e.name === 'Unnatural Shriek');
    const edited = {
      ...withName(entry),
      system: {
        ...entry.item.system,
        description: { value: entry.item.system.description.value.replace('stupefed 1 for 1 minute', 'stupefied 1 for 1 minute') },
      },
    };
    expect(findNpcAbilityOverride(edited, 'unrelated text', 'will')).toBeNull();
    const d = parseSaveAbility(edited);
    expect(d.family).toBe('blocks');
    // The fixed spelling parses on its own; the failure degree is the grammar's.
    expect(d.degrees.failure.conditions.map((c) => c.slug)).toEqual(['stupefied', 'frightened']);
  });

  it('matches by name and save type only, and hands out a fresh copy', () => {
    const entry = entries.find((e) => e.actor === 'Argorth' && e.name === 'Unnatural Shriek');
    const plain = NPC_ABILITY_OVERRIDES[0].verifiedText.join(' ');
    expect(findNpcAbilityOverride({ name: 'Other Shriek' }, plain, 'will')).toBeNull();
    expect(findNpcAbilityOverride({ name: 'Unnatural Shriek' }, plain, 'fortitude')).toBeNull();
    expect(findNpcAbilityOverride(entry.item, plain, 'will')).toBeNull(); // no name
    const a = findNpcAbilityOverride({ name: 'Unnatural Shriek' }, plain, 'will');
    a.degrees.failure.conditions.push({ slug: 'prone' });
    const b = findNpcAbilityOverride({ name: 'Unnatural Shriek' }, plain, 'will');
    expect(b.degrees.failure.conditions).toHaveLength(2);
  });
});
