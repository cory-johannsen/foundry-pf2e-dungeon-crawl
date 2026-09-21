import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

/**
 * `data/creature-art.json`'s `art` field is looked up dynamically (via
 * `findCreatureArt`/`creatureArtPath`), so the existing regex-based
 * `tests/asset-paths.test.mjs` scanner can't verify these exist — same gap
 * `tests/dungeon-room-art.test.mjs` closes for room art. A missing file here
 * is silent in Foundry (a blank token), so check every entry against disk.
 */
const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const ART_DIR = resolve(root, 'assets/creature-art');

const creatureArt = JSON.parse(readFileSync(resolve(root, 'data/creature-art.json'), 'utf8'));

describe('creature-art assets exist on disk', () => {
  it('has at least one entry to check at all', () => {
    expect(creatureArt.length).toBeGreaterThan(0);
  });

  it.each(creatureArt.map((c) => [c.name, c.art]))('%s (%s) exists', (_name, art) => {
    expect(existsSync(resolve(ART_DIR, art))).toBe(true);
  });
});
