#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

const schema = JSON.parse(readFileSync(resolve(root, 'data/schema/dungeon-setpieces.schema.json'), 'utf8'));
const setpieces = JSON.parse(readFileSync(resolve(root, 'data/dungeon-setpieces.json'), 'utf8'));

const ajv = new Ajv({ allErrors: true, strict: false });
addFormats(ajv);
const validate = ajv.compile(schema);

const ok = validate(setpieces);
if (!ok) {
  console.error('Schema validation failed:');
  for (const err of validate.errors) {
    console.error(`  ${err.instancePath} ${err.message}`);
  }
  process.exit(1);
}
console.log(`OK: ${setpieces.length} dungeon set-pieces validate against schema`);

const ids = setpieces.map((s) => s.id);
const dupes = ids.filter((id, i) => ids.indexOf(id) !== i);
if (dupes.length) {
  console.error(`Duplicate set-piece ids: ${[...new Set(dupes)].join(', ')}`);
  process.exit(1);
}

const incomplete = setpieces.filter((s) => !s.complete);
console.log(`${setpieces.length - incomplete.length}/${setpieces.length} set-pieces fully transcribed`);
if (process.argv.includes('--verbose') && incomplete.length) {
  console.log('\nIncomplete set-pieces:');
  for (const s of incomplete) console.log(`  ${s.name} (${s.id})`);
}
