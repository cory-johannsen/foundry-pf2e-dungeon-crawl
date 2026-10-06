import { describe, it, expect } from 'vitest';
import { corridorEdgeTiles, corridorTileAt } from '../scripts/dungeon-scene.mjs';

const piece = (tile) => `${tile.texture.src.split('/').pop().replace('.webp', '')}@${tile.rotation}`;
const at = (tiles, gx, gy) =>
  tiles.find((t) => t.x === gx * 100 + 50 && t.y === gy * 100 + 50);

describe('corridorEdgeTiles (#823)', () => {
  it('a straight horizontal corridor is end, mid..., end with the walls at the ends', () => {
    const { main } = corridorEdgeTiles({
      corridorSegments: [{ gx: 0, gy: 5, gw: 4, gh: 1 }],
      transitCells: [],
    });
    expect(main.map(piece)).toEqual(['corridor-end@270', 'corridor-mid@90', 'corridor-mid@90', 'corridor-end@90']);
  });

  it('an L-shaped corridor (two segments sharing the corner cell) gets ONE corner tile there, no stack', () => {
    // horizontal leg (0..3, 5) then vertical leg (3, 5..8): corner cell (3,5)
    const { main } = corridorEdgeTiles({
      corridorSegments: [
        { gx: 0, gy: 5, gw: 4, gh: 1 },
        { gx: 3, gy: 5, gw: 1, gh: 4 },
      ],
      transitCells: [],
    });
    const keys = main.map((t) => `${t.x},${t.y}`);
    expect(new Set(keys).size).toBe(keys.length); // no stacked tiles
    expect(piece(at(main, 3, 5))).toBe('corridor-corner@90'); // open W (from 2,5) and S (to 3,6)
    expect(piece(at(main, 0, 5))).toBe('corridor-end@270');
    expect(piece(at(main, 3, 8))).toBe('corridor-end@180'); // wall at S end
  });

  it('two side-adjacent cells that belong to different owners join with mid pieces (the live sealed-looking pair)', () => {
    // main corridor (0..1, 5) continues into a transit crossing covering (2..3, 5)
    const { main, transit } = corridorEdgeTiles({
      corridorSegments: [{ gx: 0, gy: 5, gw: 2, gh: 1 }],
      transitCells: [{ corridorSegments: [{ gx: 2, gy: 5, gw: 2, gh: 1 }] }],
    });
    expect(piece(at(main, 1, 5))).toBe('corridor-mid@90'); // was an end cap facing the transit cell
    expect(piece(at(transit[0], 2, 5))).toBe('corridor-mid@90');
    expect(piece(at(transit[0], 3, 5))).toBe('corridor-end@90');
  });

  it('a cell shared by main and transit is owned by the transit crossing (so its marker tile survives)', () => {
    const { main, transit } = corridorEdgeTiles({
      corridorSegments: [{ gx: 0, gy: 5, gw: 3, gh: 1 }],
      transitCells: [{ corridorSegments: [{ gx: 2, gy: 5, gw: 2, gh: 1 }] }],
    });
    expect(at(main, 2, 5)).toBeUndefined();
    expect(at(transit[0], 2, 5)).toBeDefined();
    const all = [...main, ...transit.flat()].map((t) => `${t.x},${t.y}`);
    expect(new Set(all).size).toBe(all.length);
  });

  it('a one-cell corridor stays single', () => {
    const { main } = corridorEdgeTiles({
      corridorSegments: [{ gx: 4, gy: 4, gw: 1, gh: 1 }],
      transitCells: [],
    });
    expect(main.map(piece)).toEqual(['corridor@0']);
  });

  it('a wide corridor (2x2 block) keeps today\'s pieces untouched (legacy)', () => {
    // fullWidth (layout v3) tiles a segment across its whole width: 2x2 cells.
    const r = corridorEdgeTiles({
      corridorSegments: [{ gx: 0, gy: 0, gw: 2, gh: 2 }],
      transitCells: [],
    }, { fullWidth: true });
    expect(r.legacy).toBe(true);
  });

  it('mainCells is the UNFILTERED cell list (#779 trap placement reads it)', () => {
    const r = corridorEdgeTiles({
      corridorSegments: [
        { gx: 0, gy: 5, gw: 4, gh: 1 },
        { gx: 3, gy: 5, gw: 1, gh: 4 },
      ],
      transitCells: [],
    });
    expect(r.mainCells.length).toBeGreaterThan(r.main.length); // the shared corner appears twice in mainCells
  });

  it('every transit crossing keeps at least one tile (marker safety)', () => {
    const { transit } = corridorEdgeTiles({
      corridorSegments: [{ gx: 0, gy: 5, gw: 2, gh: 1 }],
      transitCells: [
        { corridorSegments: [{ gx: 2, gy: 5, gw: 2, gh: 1 }] },
        { corridorSegments: [{ gx: 2, gy: 5, gw: 2, gh: 1 }] }, // an identical crossing
      ],
    });
    expect(transit[0].length).toBeGreaterThan(0);
    expect(transit[1].length).toBeGreaterThan(0);
  });
});
