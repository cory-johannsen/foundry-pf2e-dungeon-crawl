import { describe, it, expect } from 'vitest';
import {
  defaultForce,
  equalShares,
  normalizeForce,
  forceSectionHtml,
  readForcesFromForm,
} from '../scripts/encounter-forces-dialog.mjs';

describe('defaultForce', () => {
  it('builds force 1 with the documented defaults', () => {
    expect(defaultForce(0)).toEqual({
      id: 'f1', name: '', hostility: 'players', share: 100,
      filters: { traits: [], excludeTraits: [], levelOffsetMin: null, levelOffsetMax: null, family: '', rarity: '' },
      placement: { mode: 'nearParty' },
    });
  });
  it('uses index+1 for the id and applies overrides', () => {
    const f = defaultForce(2, { name: 'Orcs', share: 40 });
    expect(f.id).toBe('f3');
    expect(f.name).toBe('Orcs');
    expect(f.share).toBe(40);
  });
});

describe('equalShares', () => {
  it('sums to 100 with the remainder on the first force', () => {
    expect(equalShares(1)).toEqual([100]);
    expect(equalShares(2)).toEqual([50, 50]);
    expect(equalShares(3)).toEqual([34, 33, 33]);
    for (const n of [1, 2, 3, 4, 5, 7]) expect(equalShares(n).reduce((a, b) => a + b, 0)).toBe(100);
  });
});

describe('normalizeForce', () => {
  it('coerces form strings', () => {
    const f = normalizeForce({
      name: ' Orcs ', hostility: 'all', share: '40',
      filters: { traits: ['orc'], levelOffsetMin: '-1', levelOffsetMax: '', family: '  orc ', rarity: 'rare' },
      placement: { mode: 'region:abc' },
    }, 1);
    expect(f.id).toBe('f2');
    expect(f.share).toBe(40);
    expect(f.filters.levelOffsetMin).toBe(-1);
    expect(f.filters.levelOffsetMax).toBeNull();
    expect(f.filters.family).toBe('orc');
    expect(f.filters.rarity).toBe('rare');
    expect(f.filters.excludeTraits).toEqual([]);
    expect(f.placement.mode).toBe('region:abc');
  });
  it('falls back for unknown hostility/rarity', () => {
    const f = normalizeForce({ hostility: 'bogus', filters: { rarity: 'mythic' } }, 0);
    expect(f.hostility).toBe('players');
    expect(f.filters.rarity).toBe('');
  });
});

describe('forceSectionHtml', () => {
  const html = forceSectionHtml(
    defaultForce(0, { hostility: 'all', filters: { ...defaultForce(0).filters, rarity: 'uncommon' } }),
    0,
    { traitsLabel: 'Favor', excludeTraitsLabel: 'Exclude', chooseLabel: 'Choose' },
  );
  it('has the fieldset and named inputs', () => {
    expect(html).toContain('<fieldset data-force="f1"');
    for (const n of ['name', 'hostility', 'share', 'levelMin', 'levelMax', 'family', 'rarity', 'placement'])
      expect(html).toContain(`name="force-f1-${n}"`);
    expect(html).toContain('name="traits-f1"');
    expect(html).toContain('name="excludeTraits-f1"');
  });
  it('marks selected hostility and rarity', () => {
    expect(html).toMatch(/<option value="all" selected>/);
    expect(html).toMatch(/<option value="uncommon" selected>/);
  });
});

describe('readForcesFromForm', () => {
  it('reads every fieldset', () => {
    const vals = {
      'force-f1-name': 'A', 'force-f1-hostility': 'players', 'force-f1-share': '60',
      'force-f1-levelMin': '', 'force-f1-levelMax': '1', 'force-f1-family': 'goblin',
      'force-f1-rarity': '', 'force-f1-placement': 'nearParty',
      'force-f2-name': 'B', 'force-f2-hostility': 'all', 'force-f2-share': '40',
      'force-f2-levelMin': '-2', 'force-f2-levelMax': '', 'force-f2-family': '',
      'force-f2-rarity': 'rare', 'force-f2-placement': 'region:r1',
      'traits-f1': 'undead,fiend',
    };
    const root = {
      querySelectorAll: () => [{ dataset: { force: 'f1' } }, { dataset: { force: 'f2' } }],
      querySelector: (sel) => {
        const m = sel.match(/name="([^"]+)"/);
        const n = m?.[1];
        if (sel.startsWith('input[type="hidden"]')) return { value: vals[n] ?? '' };
        return n in vals ? { value: vals[n] } : null;
      },
    };
    const forces = readForcesFromForm(root);
    expect(forces).toHaveLength(2);
    expect(forces[0]).toMatchObject({ id: 'f1', name: 'A', share: 60 });
    expect(forces[0].filters).toMatchObject({ traits: ['undead', 'fiend'], levelOffsetMin: null, levelOffsetMax: 1, family: 'goblin' });
    expect(forces[1]).toMatchObject({ id: 'f2', hostility: 'all', share: 40, placement: { mode: 'region:r1' } });
    expect(forces[1].filters).toMatchObject({ levelOffsetMin: -2, rarity: 'rare' });
  });
});
