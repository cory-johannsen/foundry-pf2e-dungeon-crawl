#!/usr/bin/env node
/**
 * Append review results to docs/token-art-failures.csv.
 *
 *   node tools/log-art-review.mjs --chunk 7 [--gemini-first slugA,slugB] \
 *     mocking-dragon-young=accept \
 *     sea-dragon-young=flag:cropped,bg_patch>gemini
 *
 * `slug` is the creature-art.json id with underscores as hyphens (the
 * `-lob` suffix is optional). Name and level come from data/creature-art.json,
 * so accepted creatures must already be wired; log flagged ones after their
 * final image is wired too, so the row records the backend that succeeded.
 * `--gemini-first` marks creatures routed Gemini-first (excluded from ComfyUI flag rates even if
 * they needed a Gemini retry). `>gemini` = final backend (default comfyui). Tags: see TAGS in art-failure-lib.mjs.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { CSV_HEADER, kindOf, parseLog, parseSpec, rowToCsv } from './art-failure-lib.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const LOG = join(root, 'docs/token-art-failures.csv');

const args = process.argv.slice(2);
const gi = args.indexOf('--gemini-first');
const geminiFirst = new Set(gi >= 0 ? args.splice(gi, 2)[1].split(',').map((x) => x.replace(/-lob$/, '')) : []);
const ci = args.indexOf('--chunk');
const chunk = ci >= 0 ? args.splice(ci, 2)[1] : null;
if (!chunk || !args.length) {
  console.error('usage: log-art-review.mjs --chunk N slug=accept|slug=flag:tag,tag[>gemini] ...');
  process.exit(2);
}
const art = JSON.parse(readFileSync(join(root, 'data/creature-art.json'), 'utf8'));
const existing = existsSync(LOG) ? parseLog(readFileSync(LOG, 'utf8')) : [];
const have = new Set(existing.map((r) => r.slug));
const lines = existsSync(LOG) ? readFileSync(LOG, 'utf8').replace(/\n*$/, '\n') : `${CSV_HEADER}\n`;
let out = lines;
for (const spec of args) {
  const s = parseSpec(spec);
  const slug = s.slug.replace(/-lob$/, '');
  if (have.has(slug)) throw new Error(`${slug} is already logged; edit the CSV row instead`);
  const e = art.find((x) => x.id === `${slug.replace(/-/g, '_')}_lob`);
  if (!e) throw new Error(`${slug}: not in data/creature-art.json (wire it first)`);
  out += `${rowToCsv({
    chunk, slug, name: e.name, level: e.level, kind: kindOf(e.name),
    first_pass: s.first_pass, failure_tags: s.tags.join(';'), final_backend: s.backend, note: geminiFirst.has(slug) ? 'gemini-first' : '',
  })}\n`;
  have.add(slug);
}
writeFileSync(LOG, out);
console.log(`logged ${args.length} row(s) for chunk ${chunk}`);
