import { describe, it, expect } from 'vitest';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { LOCATION_TAGS, ROOM_ART_VARIANTS } from '../scripts/dungeon-deck.mjs';

/**
 * `roomArtPath`/`CORRIDOR_ART_PATH` (dungeon-scene.mjs) build their asset
 * paths from two interpolated variables (locationTag and either a variant
 * index or 'goal'), so the existing regex-based tests/asset-paths.test.mjs
 * scanner — which only catches mostly-literal `modules/${MODULE_ID}/...`
 * paths — can't verify these exist. A missing one is silent everywhere in
 * Foundry (no error, just a blank Tile), so this checks every combination
 * directly against the filesystem instead.
 */
const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOM_ART_DIR = resolve(__dirname, '../assets/dungeon-rooms');

describe('dungeon room art assets exist on disk', () => {
  const cases = [];
  for (const tag of LOCATION_TAGS) {
    for (let variant = 0; variant < ROOM_ART_VARIANTS; variant += 1) {
      cases.push(`${tag}-${variant}.webp`);
    }
    cases.push(`${tag}-goal.webp`);
  }
  // corridor-end/-mid (ITEM-12): the open-sided tiles used for any gallery
  // longer than one square, so it reads as one continuous hallway instead of
  // a stack of separate boxed alcoves — see corridorTileVariant.
  cases.push('corridor.webp', 'corridor-end.webp', 'corridor-mid.webp');

  it('finds every expected filename to check at all', () => {
    // A guard on the guard: LOCATION_TAGS.length * (ROOM_ART_VARIANTS + 1) + 3.
    expect(cases.length).toBe(LOCATION_TAGS.length * (ROOM_ART_VARIANTS + 1) + 3);
  });

  it.each(cases)('%s exists', (filename) => {
    expect(existsSync(resolve(ROOM_ART_DIR, filename))).toBe(true);
  });
});
