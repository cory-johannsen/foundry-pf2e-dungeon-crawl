import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  TAGS, csvEscape, geminiFirstCandidates, kindOf, parseCsv, parseLog, parseSpec, routeFor, rowToCsv, tagCounts, tally, variantOf,
} from '../tools/art-failure-lib.mjs';

describe('kindOf / variantOf', () => {
  it('classifies multi-species composites as hybrid, ahead of other rules', () => {
    expect(kindOf('Irriseni Owlbear')).toBe('hybrid');
    expect(kindOf('Manananggal')).toBe('hybrid');
    expect(kindOf("K'nonna")).toBe('hybrid');
  });
  it('classifies dragons, undead, and defaults to beast', () => {
    expect(kindOf('Sea Dragon (Young)')).toBe('dragon');
    expect(kindOf('Walcofinde')).toBe('undead');
    expect(kindOf('Silt Frog')).toBe('beast');
  });
  it('detects the variant from the display name', () => {
    expect(variantOf('Rime Dragon (Young, Spellcaster)')).toBe('spellcaster');
    expect(variantOf('Bog Dragon (Young)')).toBe('young');
    expect(variantOf('Pixiu')).toBe('base');
  });
});

describe('parseSpec', () => {
  it('parses accept and flag specs with a final backend', () => {
    expect(parseSpec('a-b=accept')).toEqual({ slug: 'a-b', first_pass: 'accept', tags: [], backend: 'comfyui' });
    expect(parseSpec('a=flag:cropped,bg_patch>gemini')).toEqual({ slug: 'a', first_pass: 'flag', tags: ['cropped', 'bg_patch'], backend: 'gemini' });
  });
  it('rejects unknown tags, tagless flags, tagged accepts and malformed input', () => {
    expect(() => parseSpec('a=flag:nonsense')).toThrow(/unknown failure tag/);
    expect(() => parseSpec('a=flag')).toThrow(/at least one tag/);
    expect(() => parseSpec('a=accept:cropped')).toThrow(/no tags/);
    expect(() => parseSpec('nonsense')).toThrow(/bad spec/);
  });
});

describe('csv round trip', () => {
  it('escapes commas and quotes and parses them back', () => {
    const row = { chunk: '7', slug: 's', name: 'Rime Dragon (Young, Spellcaster)', level: 6, kind: 'dragon', first_pass: 'flag', failure_tags: 'cropped;bg_patch', final_backend: 'gemini', note: 'said "no", twice' };
    expect(csvEscape(row.name)).toBe('"Rime Dragon (Young, Spellcaster)"');
    const text = `chunk,slug,name,level,kind,first_pass,failure_tags,final_backend,note\n${rowToCsv(row)}\n`;
    const [back] = parseLog(text);
    expect(back.name).toBe(row.name);
    expect(back.note).toBe(row.note);
    expect(parseCsv('a,"b,c"\n')).toEqual([['a', 'b,c']]);
  });
});

describe('analysis helpers', () => {
  const rows = [
    ...Array.from({ length: 5 }, (_, i) => ({ name: 'Owlbear', kind: 'hybrid', first_pass: i < 4 ? 'flag' : 'accept', failure_tags: i < 4 ? 'cropped;hybrid_anatomy' : '', final_backend: 'gemini' })),
    ...Array.from({ length: 5 }, () => ({ name: 'Wolf', kind: 'beast', first_pass: 'accept', failure_tags: '', final_backend: 'comfyui' })),
  ];
  it('tallies flag rate per group and counts tags', () => {
    const t = tally(rows, (r) => r.kind);
    expect(t[0]).toMatchObject({ key: 'hybrid', n: 5, flagged: 4, rate: 80 });
    expect(tagCounts(rows)).toEqual([['cropped', 4], ['hybrid_anatomy', 4]]);
  });
  it('proposes only groups with enough data and a high rate', () => {
    const c = geminiFirstCandidates(rows);
    expect(c.some((x) => x.by === 'kind' && x.key === 'hybrid')).toBe(true);
    expect(c.some((x) => x.key === 'beast')).toBe(false);
    expect(geminiFirstCandidates(rows.slice(0, 3))).toEqual([]);
  });
});

describe('routeFor', () => {
  const rules = { keywords: ['owlbear'], kinds: ['hybrid'], kindVariants: ['dragon/young'] };
  it('routes keyword, kind and kind/variant matches to gemini, everything else to comfyui', () => {
    expect(routeFor('Irriseni Owlbear', rules)).toMatchObject({ backend: 'gemini' });
    expect(routeFor('Pixiu', rules)).toMatchObject({ backend: 'gemini' });
    expect(routeFor('Sea Dragon (Young)', rules)).toMatchObject({ backend: 'gemini' });
    expect(routeFor('Silt Frog', rules)).toMatchObject({ backend: 'comfyui' });
    expect(routeFor('Bog Dragon (Young, Spellcaster)', rules)).toMatchObject({ backend: 'comfyui' });
  });
});

describe('docs/token-art-failures.csv', () => {
  const rows = parseLog(readFileSync(new URL('../docs/token-art-failures.csv', import.meta.url), 'utf8'));
  it('has unique slugs and valid tags/backends', () => {
    expect(new Set(rows.map((r) => r.slug)).size).toBe(rows.length);
    for (const r of rows) {
      for (const t of r.failure_tags.split(';').filter(Boolean)) expect(Object.keys(TAGS)).toContain(t);
      expect(['comfyui', 'gemini']).toContain(r.final_backend);
      expect(r.first_pass === 'flag').toBe(r.failure_tags !== '');
    }
  });
});
