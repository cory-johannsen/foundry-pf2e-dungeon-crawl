/**
 * Pure helpers for the token-art failure log (docs/token-art-failures.csv).
 * No fs/Foundry deps so tests/art-failure-lib.test.mjs can cover them.
 *
 * One row per generated creature: how the first-pass image fared in review,
 * why it was flagged (fixed tag vocabulary below), and which backend finally
 * produced the accepted image. analyze-art-failures.mjs turns the rows into
 * per-kind / per-tag failure rates and Gemini-first routing suggestions.
 */

export const TAGS = {
  scenery_backdrop: 'coloured backdrop, scene, props or effects (flames, smoke, ship, sea) behind the subject',
  decorative_frame: 'ornate border / picture-frame / corner ornaments drawn around the subject',
  halo_or_disc: 'circle/halo/disc/splatter shape behind the subject',
  bg_patch: 'opaque leftover patch (ground rectangle, white corner, ledge) the salvage did not remove',
  cropped: 'subject cut off by the frame, or only a head/bust shown when the whole creature was asked for',
  wrong_subject: 'depicts a different creature/thing than asked (insect for an ink drop, ship for a wreck monster)',
  hybrid_anatomy: 'multi-species composite the model cannot compose (owl+bear, half a human, torso+wings)',
  wrong_details: 'right subject, wrong specifics (wings on a wingless creature, clothing on a beast)',
  salvage_damage: 'background salvage ate the subject (pale fur turned transparent)',
  bg_score_high: 'checker background score >= 50 after all attempts',
};

export const BACKENDS = ['comfyui', 'gemini'];

// Ordered: first match wins. Name is the creature's display name, lowercased.
const KIND_RULES = [
  ['hybrid', /owlbear|karina|rompo|manananggal|k'?-?nonna|pixiu|whalesteed|mamlambo|kallas|centaur|chimera|harpy|sphinx/],
  ['dragon', /dragon|linnorm|imugi|wyrm/],
  ['undead', /walcofinde|flotsam|shui[- ]gui|stone sister|aurosrath|spellscar|ulgrem-axaan|lunar consort|ethereal|ghost|zombie|skeleton|wight|vampire/],
  ['construct', /animated|hopping head|automaton|conformer|golem|clockwork|juggernaut/],
  ['elemental', /kasesh|temteki|xorn|elemental/],
  ['fey', /biloko|eloko|lamp blighter|spring-heeled|fey/],
  ['aberration', /skinskitter|graul|melfesh|spawn of|gutaki|inkdrop/],
  ['humanoid', /warrior|sailor|hunter|stalker|mastermind|acolyte|butcher|scoundrel|knight|armiger|evaluator|agent|scribe|defender|sage|elder|celebrant|hellknight|bibliodaemon|yeongno|asanbosam|sister/],
];

export function kindOf(name) {
  const n = String(name ?? '').toLowerCase();
  for (const [kind, re] of KIND_RULES) if (re.test(n)) return kind;
  return 'beast';
}

export function variantOf(name) {
  const n = String(name ?? '').toLowerCase();
  if (/spellcaster/.test(n)) return 'spellcaster';
  if (/\(young\)|young /.test(n)) return 'young';
  return 'base';
}

export const CSV_HEADER = 'chunk,slug,name,level,kind,first_pass,failure_tags,final_backend,note';

export function csvEscape(v) {
  const s = String(v ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function parseCsv(text) {
  const rows = [];
  let row = [], cell = '', q = false;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i += 1; }
      else if (c === '"') q = false;
      else cell += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
    else if (c !== '\r') cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

export function parseLog(text) {
  const [head, ...body] = parseCsv(text).filter((r) => r.length > 1);
  return body.map((r) => Object.fromEntries(head.map((h, i) => [h, r[i] ?? ''])));
}

export function rowToCsv(r) {
  return [r.chunk, r.slug, r.name, r.level, r.kind, r.first_pass, r.failure_tags, r.final_backend, r.note]
    .map(csvEscape).join(',');
}

/** "slug=accept" | "slug=flag:cropped,bg_patch>gemini" -> {slug, first_pass, tags[], backend}. */
export function parseSpec(spec) {
  const m = /^([^=]+)=(accept|flag)(?::([a-z_,]+))?(?:>(comfyui|gemini))?$/.exec(spec);
  if (!m) throw new Error(`bad spec "${spec}" (want slug=accept | slug=flag:tag1,tag2>gemini)`);
  const tags = m[3] ? m[3].split(',') : [];
  for (const t of tags) if (!(t in TAGS)) throw new Error(`unknown failure tag "${t}" (${Object.keys(TAGS).join(', ')})`);
  if (m[2] === 'flag' && !tags.length) throw new Error(`"${spec}": a flag needs at least one tag`);
  if (m[2] === 'accept' && tags.length) throw new Error(`"${spec}": accept takes no tags`);
  return { slug: m[1], first_pass: m[2], tags, backend: m[4] ?? 'comfyui' };
}

const pct = (a, b) => (b ? Math.round((100 * a) / b) : 0);

export function tally(rows, keyFn) {
  const m = new Map();
  for (const r of rows) {
    const k = keyFn(r);
    const t = m.get(k) ?? { key: k, n: 0, flagged: 0, gemini: 0 };
    t.n += 1;
    if (r.first_pass === 'flag') t.flagged += 1;
    if (r.final_backend === 'gemini') t.gemini += 1;
    m.set(k, t);
  }
  return [...m.values()].map((t) => ({ ...t, rate: pct(t.flagged, t.n) })).sort((a, b) => b.rate - a.rate || b.n - a.n);
}

export function tagCounts(rows) {
  const c = {};
  for (const r of rows) for (const t of (r.failure_tags || '').split(';').filter(Boolean)) c[t] = (c[t] ?? 0) + 1;
  return Object.entries(c).sort((a, b) => b[1] - a[1]);
}

/** Groups (by kind or variant or name word) with enough data and a high enough flag rate. */
export function geminiFirstCandidates(rows, { minN = 4, minRate = 60 } = {}) {
  const out = [];
  for (const [label, fn] of [
    ['kind', (r) => r.kind],
    ['variant', (r) => variantOf(r.name)],
    ['kind+variant', (r) => `${r.kind}/${variantOf(r.name)}`],
  ]) {
    for (const t of tally(rows, fn)) if (t.n >= minN && t.rate >= minRate) out.push({ by: label, ...t });
  }
  return out;
}

/** Recommended first backend for a creature name under data/token-art-routing.json rules. */
export function routeFor(name, rules) {
  const n = String(name ?? '').toLowerCase();
  const hit = (rules.keywords ?? []).find((k) => n.includes(k.toLowerCase()));
  if (hit) return { backend: 'gemini', why: `name matches "${hit}"` };
  const kind = kindOf(name);
  if ((rules.kinds ?? []).includes(kind)) return { backend: 'gemini', why: `kind "${kind}"` };
  const v = `${kind}/${variantOf(name)}`;
  if ((rules.kindVariants ?? []).includes(v)) return { backend: 'gemini', why: `kind/variant "${v}"` };
  return { backend: 'comfyui', why: 'no rule matched' };
}
