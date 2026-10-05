#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const NORMALIZE_HINT = 'Run `npm run art:normalize` (tools/migrate-creature-art-sources.mjs) to move new/flat art into its per-source folder and fix ids.';

const schema = JSON.parse(readFileSync(resolve(root, 'data/schema/creature-art.schema.json'), 'utf8'));
const creatureArt = JSON.parse(readFileSync(resolve(root, 'data/creature-art.json'), 'utf8'));

const ajv = new Ajv({ allErrors: true, strict: false });
addFormats(ajv);
const validate = ajv.compile(schema);

const ok = validate(creatureArt);
if (!ok) {
  console.error('Schema validation failed:');
  for (const err of validate.errors) {
    console.error(`  ${err.instancePath} ${err.message}`);
  }
  if (validate.errors.some((err) => err.instancePath.endsWith('/art'))) console.error(NORMALIZE_HINT);
  process.exit(1);
}
console.log(`OK: ${creatureArt.length} creature-art entries validate against schema`);

const ids = creatureArt.map((c) => c.id);
const dupeIds = ids.filter((id, i) => ids.indexOf(id) !== i);
if (dupeIds.length) {
  console.error(`Duplicate creature-art ids: ${[...new Set(dupeIds)].join(', ')}`);
  process.exit(1);
}

const keys = creatureArt.map((c) => `${c.pack}::${c.docId}`);
const dupeKeys = keys.filter((k, i) => keys.indexOf(k) !== i);
if (dupeKeys.length) {
  console.error(`Duplicate {pack, docId} lookup keys: ${[...new Set(dupeKeys)].join(', ')}`);
  process.exit(1);
}

console.log(`${creatureArt.length} unique creature-art entries, no duplicate lookup keys`);

const folderMismatches = [];
const artToPacksForValidation = new Map();
for (const entry of creatureArt) {
  if (!artToPacksForValidation.has(entry.art)) artToPacksForValidation.set(entry.art, new Set());
  artToPacksForValidation.get(entry.art).add(entry.pack);
}
for (const entry of creatureArt) {
  const [folder] = entry.art.split('/');
  const expectedSource = entry.pack.replace(/^pf2e\./, '');
  const packsForThisArt = artToPacksForValidation.get(entry.art);
  const isGenuinelyShared = packsForThisArt.size > 1;
  if (isGenuinelyShared) {
    if (folder !== 'shared') {
      folderMismatches.push(`${entry.id}: art "${entry.art}" is referenced by ${packsForThisArt.size} distinct packs but isn't under shared/`);
    }
  } else if (folder !== expectedSource) {
    folderMismatches.push(`${entry.id}: art "${entry.art}" is in "${folder}/" but its pack (${entry.pack}) derives source "${expectedSource}/"`);
  }
}
if (folderMismatches.length) {
  console.error(`Folder/pack mismatches:\n  ${folderMismatches.join('\n  ')}`);
  console.error(NORMALIZE_HINT);
  process.exit(1);
}
console.log(`${creatureArt.length} entries' art paths agree with their own pack's derived source (or shared/)`);
