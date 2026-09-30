#!/usr/bin/env node
/**
 * Failure-rate report over docs/token-art-failures.csv.
 *
 *   node tools/analyze-art-failures.mjs            # summary + Gemini-first candidates
 *   node tools/analyze-art-failures.mjs --route "Irriseni Owlbear" "Silt Frog"
 *
 * `--route` applies data/token-art-routing.json and prints the recommended
 * first backend per creature name, so a chunk's worklist can be split
 * before spending any ComfyUI attempts.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { TAGS, geminiFirstCandidates, parseLog, routeFor, tagCounts, tally, variantOf } from './art-failure-lib.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const rows = parseLog(readFileSync(join(root, 'docs/token-art-failures.csv'), 'utf8'));
const rules = JSON.parse(readFileSync(join(root, 'data/token-art-routing.json'), 'utf8'));
const args = process.argv.slice(2);

if (args[0] === '--route') {
  for (const name of args.slice(1)) {
    const r = routeFor(name, rules);
    console.log(`${r.backend.padEnd(8)} ${name}  (${r.why})`);
  }
  process.exit(0);
}

const table = (title, ts) => {
  console.log(`\n${title}`);
  console.log('  group'.padEnd(28) + 'n'.padStart(4) + 'flagged'.padStart(9) + 'rate'.padStart(6) + 'gemini'.padStart(8));
  for (const t of ts) {
    console.log(`  ${String(t.key).padEnd(26)}${String(t.n).padStart(4)}${String(t.flagged).padStart(9)}${`${t.rate}%`.padStart(6)}${String(t.gemini).padStart(8)}`);
  }
};

const flagged = rows.filter((r) => r.first_pass === 'flag');
console.log(`${rows.length} creatures logged, ${flagged.length} flagged on first pass (${Math.round((100 * flagged.length) / rows.length)}%)`);
console.log(`final backend: ${rows.filter((r) => r.final_backend === 'gemini').length} gemini, ${rows.filter((r) => r.final_backend === 'comfyui').length} comfyui`);
table('By chunk', tally(rows, (r) => `chunk ${r.chunk}`).sort((a, b) => Number(a.key.split(' ')[1]) - Number(b.key.split(' ')[1])));
table('By kind', tally(rows, (r) => r.kind));
table('By variant', tally(rows, (r) => variantOf(r.name)));
table('By kind/variant (n>=3)', tally(rows, (r) => `${r.kind}/${variantOf(r.name)}`).filter((t) => t.n >= 3));
console.log('\nFailure tags (a creature can carry several):');
for (const [t, n] of tagCounts(flagged)) console.log(`  ${String(n).padStart(3)}  ${t.padEnd(18)} ${TAGS[t] ?? ''}`);
console.log('\nGemini-first candidates (n>=4, first-pass flag rate >=60%):');
const c = geminiFirstCandidates(rows);
if (!c.length) console.log('  none yet');
for (const t of c) console.log(`  by ${t.by.padEnd(12)} ${String(t.key).padEnd(24)} ${t.flagged}/${t.n} flagged (${t.rate}%)`);
console.log(`\nCurrent routing rules (data/token-art-routing.json): keywords=${JSON.stringify(rules.keywords)} kinds=${JSON.stringify(rules.kinds)} kindVariants=${JSON.stringify(rules.kindVariants)}`);
