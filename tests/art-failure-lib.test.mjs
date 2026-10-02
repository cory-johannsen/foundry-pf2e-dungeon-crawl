import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  CONCEPT_GROUPS, TAGS, comfyRows, conceptEnrichment, csvEscape, geminiFirstCandidates, isGeminiFirst, kindOf, normName, parseCsv, parseLog, parseSpec, routeFor, rowToCsv, tagCounts, tally, variantOf,
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
    expect(routeFor('Irriseni Owlbear', rules)).toMatchObject({ backend: 'openrouter' });
    expect(routeFor('Pixiu', rules)).toMatchObject({ backend: 'openrouter' });
    expect(routeFor('Sea Dragon (Young)', rules)).toMatchObject({ backend: 'openrouter' });
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

describe('history enrichment', () => {
  it('normalises names the same way for population and failures', () => {
    expect(normName("K'nonna (Young, Spellcaster)")).toBe('k-nonna-young-spellcaster');
  });
  it('reports a lower-bound flag rate per name-word group, highest first', () => {
    const pop = [
      { name: 'Storm Lord' }, { name: 'Thunder Drake' }, { name: 'Cloud Giant' }, { name: 'Silt Frog' },
    ];
    const flagged = new Set([normName('Storm Lord'), normName('Cloud Giant')]);
    const out = conceptEnrichment(pop, flagged, { storm_air: CONCEPT_GROUPS.storm_air });
    expect(out).toEqual([{ group: 'storm_air', pop: 3, flagged: 2, lowerBoundRate: 67 }]);
  });
  it('knows the history-derived tags', () => {
    for (const t of ['monochrome_line_art', 'dark_palette_bg_lightened', 'nudity_or_clothing']) expect(Object.keys(TAGS)).toContain(t);
  });
});

describe('data/token-art-routing.json', () => {
  const rules = JSON.parse(readFileSync(new URL('../data/token-art-routing.json', import.meta.url), 'utf8'));
  it('routes storm/sky concepts, hybrids and young dragons to gemini, ordinary creatures to comfyui', () => {
    expect(routeFor('Stormcrown Dragon (Young, Spellcaster)', rules).backend).toBe('openrouter');
    expect(routeFor('Cloud Dragon (Young)', rules).backend).toBe('openrouter');
    expect(routeFor('Pixiu', rules).backend).toBe('openrouter');
    expect(routeFor('Sea Dragon (Young)', rules).backend).toBe('openrouter');
    expect(routeFor('Silt Frog', rules).backend).toBe('comfyui');
    expect(routeFor('Vorpal Dragon (Young, Spellcaster)', rules).backend).toBe('openrouter');
    expect(routeFor('Rime Dragon (Adult, Spellcaster)', rules).backend).toBe('openrouter');
    expect(routeFor('Rime Dragon (Adult)', rules).backend).toBe('openrouter');
  });
});

describe('Gemini-first rows are excluded from ComfyUI flag rates', () => {
  const rows = [
    { name: 'Sea Dragon (Young)', kind: 'dragon', first_pass: 'flag', failure_tags: 'cropped', final_backend: 'gemini' },
    { name: 'Bog Dragon (Young)', kind: 'dragon', first_pass: 'flag', failure_tags: 'cropped', final_backend: 'gemini' },
    { name: 'Sky Dragon (Young)', kind: 'dragon', first_pass: 'accept', failure_tags: '', final_backend: 'gemini' },
    { name: 'Cloud Dragon (Young)', kind: 'dragon', first_pass: 'accept', failure_tags: '', final_backend: 'gemini' },
    { name: 'Wish Dragon (Young)', kind: 'dragon', first_pass: 'accept', failure_tags: '', final_backend: 'comfyui' },
    { name: 'Oath Dragon (Young)', kind: 'dragon', first_pass: 'flag', failure_tags: 'cropped', final_backend: 'gemini' },
    { name: 'Rime Dragon (Young)', kind: 'dragon', first_pass: 'flag', failure_tags: 'cropped', final_backend: 'gemini' },
  ];
  it('identifies routed rows and drops them', () => {
    expect(rows.filter(isGeminiFirst).map((r) => r.name)).toEqual(['Sky Dragon (Young)', 'Cloud Dragon (Young)']);
    expect(comfyRows(rows)).toHaveLength(5);
  });
  it('keeps a routed group qualifying instead of letting its rate collapse', () => {
    const c = geminiFirstCandidates(rows, { minN: 4, minRate: 60 });
    expect(c.find((x) => x.by === 'kind+variant' && x.key === 'dragon/young')).toMatchObject({ n: 5, flagged: 4, rate: 80 });
  });
  it('treats a note starting gemini-first as routed even when it needed a retry', () => {
    const r = { name: 'Nue', kind: 'hybrid', first_pass: 'flag', failure_tags: 'cropped', final_backend: 'gemini', note: 'gemini-first' };
    expect(isGeminiFirst(r)).toBe(true);
    expect(comfyRows([r])).toEqual([]);
  });
  it('classifies nue as a hybrid', () => {
    expect(kindOf('Nue')).toBe('hybrid');
  });
});

describe('enforced routing (persistent ComfyUI failure classes)', () => {
  const real = JSON.parse(readFileSync(new URL('../data/token-art-routing.json', import.meta.url), 'utf8'));

  it('sends catalogued failure classes to openrouter, never comfyui', () => {
    for (const [name, id] of [
      ['Centaur Scout', 'centaur-scout'], ['Winged Owlbear', 'winged-owlbear'], ['Death Drider', 'death-drider'],
      ['Hooktongue Hydra', 'hooktongue-hydra'], ['Headless Xulgath', 'headless-xulgath'], ['Faceless Butcher', 'faceless-butcher'],
      ['Cyclops Zombie', 'cyclops-zombie'], ['Luminous Ooze', 'luminous-ooze'], ['Ghostly Guard', 'ghostly-guard'],
      ['Xae', 'xae'], ['Nihiris', 'nihiris'],
    ]) expect(routeFor(name, real, id).backend, name).toBe('openrouter');
  });

  it('leaves ordinary creatures on comfyui', () => {
    expect(routeFor('Silt Frog', real, 'silt-frog').backend).toBe('comfyui');
    expect(routeFor('Casino Bouncer', real, 'casino-bouncer').backend).toBe('comfyui');
  });

  it('matches by explicit id even when the name carries no keyword', () => {
    expect(routeFor('Binumir', real, 'binumir')).toMatchObject({ backend: 'openrouter' });
  });

  it('is actually enforced by the generator (not just advisory)', () => {
    const src = readFileSync(new URL('../tools/generate-token-art.mjs', import.meta.url), 'utf8');
    expect(src).toContain("import { routeFor } from './art-failure-lib.mjs'");
    expect(src).toMatch(/routeFor\(s\.id\.replace/);
    expect(src).toMatch(/--backend=comfyui overrides this/);
  });
});

describe('hybrid model preference', () => {
  it('generator uses Krea for centaur-type hybrids', () => {
    const src = readFileSync(new URL('../tools/generate-token-art.mjs', import.meta.url), 'utf8');
    expect(src).toMatch(/\/centaur\/\.test\(s\.id\)/);
    expect(src).toContain("override: 'krea/krea-2-medium-turbo'");
  });
});
