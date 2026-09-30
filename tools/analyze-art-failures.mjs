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
import { TAGS, conceptEnrichment, geminiFirstCandidates, normName, parseLog, routeFor, tagCounts, tally, variantOf } from './art-failure-lib.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
if (process.argv[2] === '--history') {
  const art = JSON.parse(readFileSync(join(root, 'data/creature-art.json'), 'utf8')).filter((e) => !e.id.endsWith('_lob'));
  const pop = new Map(art.map((e) => [normName(e.name), e]));
  const hist = parseLog(readFileSync(join(root, 'docs/token-art-history/creatures.csv'), 'utf8'))
    .filter((r) => ['redo', 'deferred', 'gemini_after_failure', 'prompt_fixed'].includes(r.event));
  const flagged = new Set();
  for (const r of hist) {
    let k = normName(r.slug_or_name);
    if (!pop.has(k)) k = k.replace(/-(mc2?|b[123]?|npc)$/, '');
    if (pop.has(k)) flagged.add(k);
  }
  console.log(`History: ${flagged.size} of ${pop.size} older creatures have a recovered failure event (${Math.round((100 * flagged.size) / pop.size)}%, a LOWER bound; stated first-pass flag rate where known is ~47%).`);
  console.log('\nName-group over-representation (lower bound on true flag rate; failures only, so no per-kind true rates):');
  for (const g of conceptEnrichment([...pop.values()], flagged)) {
    console.log(`  ${g.group.padEnd(12)} ${String(g.flagged).padStart(3)}/${String(g.pop).padEnd(4)} >= ${g.lowerBoundRate}%`);
  }
  process.exit(0);
}
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
