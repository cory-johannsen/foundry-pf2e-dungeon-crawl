#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

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
