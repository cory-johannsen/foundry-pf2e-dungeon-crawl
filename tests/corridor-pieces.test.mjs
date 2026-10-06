import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import {
  PIECE_OPENINGS,
  corridorPieceForOpenings,
  openingsOf,
  cellKey,
  hasBlock2x2,
} from '../scripts/corridor-pieces.mjs';

const sorted = (a) => [...a].sort().join('');

describe('corridorPieceForOpenings', () => {
  it('maps every opening set to a piece whose openings match (round trip)', () => {
    const sets = [[], ['N'], ['E'], ['S'], ['W'], ['N', 'S'], ['E', 'W'],
      ['S', 'E'], ['S', 'W'], ['N', 'W'], ['N', 'E']];
    for (const open of sets) {
      const { variant, rotation } = corridorPieceForOpenings(open);
      const key = variant === 'single' ? 'single' : `${variant}@${rotation}`;
      expect(sorted(PIECE_OPENINGS[key]), JSON.stringify(open)).toBe(sorted(open));
    }
  });

  it('uses end caps with the wall opposite the single opening (door ends keep today\'s look)', () => {
    expect(corridorPieceForOpenings(['S'])).toEqual({ variant: 'end', rotation: 0 });
    expect(corridorPieceForOpenings(['W'])).toEqual({ variant: 'end', rotation: 90 });
    expect(corridorPieceForOpenings(['N'])).toEqual({ variant: 'end', rotation: 180 });
    expect(corridorPieceForOpenings(['E'])).toEqual({ variant: 'end', rotation: 270 });
  });

  it('uses single for no openings, mid for opposite pairs, corner for adjacent pairs', () => {
    expect(corridorPieceForOpenings([])).toEqual({ variant: 'single', rotation: 0 });
    expect(corridorPieceForOpenings(['N', 'S'])).toEqual({ variant: 'mid', rotation: 0 });
    expect(corridorPieceForOpenings(['E', 'W'])).toEqual({ variant: 'mid', rotation: 90 });
    expect(corridorPieceForOpenings(['S', 'E'])).toEqual({ variant: 'corner', rotation: 0 });
    expect(corridorPieceForOpenings(['S', 'W'])).toEqual({ variant: 'corner', rotation: 90 });
    expect(corridorPieceForOpenings(['N', 'W'])).toEqual({ variant: 'corner', rotation: 180 });
    expect(corridorPieceForOpenings(['N', 'E'])).toEqual({ variant: 'corner', rotation: 270 });
  });

  it('falls back to a straight mid for 3+ openings (T / cross), N-S preferred', () => {
    expect(corridorPieceForOpenings(['N', 'E', 'S'])).toEqual({ variant: 'mid', rotation: 0 });
    expect(corridorPieceForOpenings(['E', 'S', 'W'])).toEqual({ variant: 'mid', rotation: 90 });
    expect(corridorPieceForOpenings(['N', 'E', 'S', 'W'])).toEqual({ variant: 'mid', rotation: 0 });
  });

  it('is order-independent', () => {
    expect(corridorPieceForOpenings(['E', 'S'])).toEqual(corridorPieceForOpenings(['S', 'E']));
  });
});

describe('openingsOf / hasBlock2x2', () => {
  const set = (...cells) => new Set(cells.map(([gx, gy]) => cellKey({ gx, gy })));

  it('reports the sides whose neighbour is in the set', () => {
    const cells = set([1, 1], [1, 2], [2, 1]);
    expect(sorted(openingsOf({ gx: 1, gy: 1 }, cells))).toBe('ES'); // east (2,1), south (1,2)
    expect(sorted(openingsOf({ gx: 2, gy: 1 }, cells))).toBe('W');
  });

  it('detects a fully occupied 2x2 block only', () => {
    expect(hasBlock2x2(set([0, 0], [1, 0], [0, 1], [1, 1]))).toBe(true);
    expect(hasBlock2x2(set([0, 0], [1, 0], [0, 1]))).toBe(false);
    expect(hasBlock2x2(set([0, 0], [1, 0], [2, 0]))).toBe(false);
  });
});

describe('compose-corridor-pieces.py stays in sync with PIECE_OPENINGS (#857)', () => {
  it('documents the same canonical openings corridor-pieces.mjs defines', () => {
    const src = readFileSync(
      new URL('../tools/compose-corridor-pieces.py', import.meta.url),
      'utf8',
    );
    // Mirrors corridor-pieces.mjs's own doc comment verbatim -- if either
    // changes, this test is the tripwire that catches the other going stale.
    expect(src).toContain('end@0 open S');
    expect(src).toContain('mid@0 open N+S');
    expect(src).toContain('corner@0 walls N+W');
  });
});
