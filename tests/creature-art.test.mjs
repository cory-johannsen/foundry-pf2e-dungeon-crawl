import { describe, it, expect } from 'vitest';
import { findCreatureArt, creatureArtPath } from '../scripts/creature-art.mjs';

const LIST = [
  { id: 'imp', pack: 'pf2e.pathfinder-monster-core', docId: 'abc123', name: 'Imp', level: 1, art: 'imp.webp' },
  { id: 'ort', pack: 'pf2e.pathfinder-monster-core', docId: 'def456', name: 'Ort', level: 0, art: 'ort.webp' }
];

describe('findCreatureArt', () => {
  it('matches on the exact {pack, docId} pair', () => {
    expect(findCreatureArt(LIST, { pack: 'pf2e.pathfinder-monster-core', id: 'abc123' })).toBe('imp.webp');
  });

  it('does not match on id alone across a different pack', () => {
    expect(findCreatureArt(LIST, { pack: 'pf2e.pathfinder-monster-core-2', id: 'abc123' })).toBeNull();
  });

  it('does not partial-match a docId', () => {
    expect(findCreatureArt(LIST, { pack: 'pf2e.pathfinder-monster-core', id: 'abc' })).toBeNull();
  });

  it('returns null when nothing matches', () => {
    expect(findCreatureArt(LIST, { pack: 'pf2e.pathfinder-monster-core', id: 'zzz' })).toBeNull();
  });

  it('returns null for an empty or missing list', () => {
    expect(findCreatureArt([], { pack: 'pf2e.pathfinder-monster-core', id: 'abc123' })).toBeNull();
    expect(findCreatureArt(undefined, { pack: 'pf2e.pathfinder-monster-core', id: 'abc123' })).toBeNull();
  });
});

describe('creatureArtPath', () => {
  it('joins the filename under the creature-art directory', () => {
    expect(creatureArtPath('imp.webp')).toBe('creature-art/imp.webp');
  });
});
