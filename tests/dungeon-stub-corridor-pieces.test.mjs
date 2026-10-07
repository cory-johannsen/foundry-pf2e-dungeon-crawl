import { describe, it, expect } from 'vitest';
import { stubTilesFor } from '../scripts/dungeon-scene.mjs';
import { installFoundryStubs } from './helpers/scene-oracle.mjs';

installFoundryStubs();

const g = (length, dir) => ({ floor: [{ gx: 10, gy: 5, gw: length, gh: 1 }], length, dir });
const variantOf = (t) => t.texture.src.split('/').pop().replace('.webp', '');
const summary = (tiles) => tiles.map((t) => [variantOf(t), t.rotation]);

/** The pre-#861 rubble cap tile, reimplemented verbatim to pin "byte-identical". */
function legacyCapTile(geo, key) {
  const f = geo.floor[0];
  const k = geo.length - 1;
  const gx = geo.dir > 0 ? f.gx + k : f.gx + f.gw - 1 - k;
  return {
    texture: { src: 'modules/pf2e-dungeon-crawl/assets/dungeon-rooms/corridor-rubble.webp', anchorX: 0.5, anchorY: 0.5 },
    x: gx * 100 + 50,
    y: f.gy * 100 + 50,
    width: 100,
    height: 100,
    rotation: geo.dir > 0 ? 90 : 270,
    flags: { 'pf2e-dungeon-crawl': { dungeonStubCorridorFor: key } },
  };
}

describe('#861 stub corridor tiles use the openings-based piece rule, not a row of closed boxes', () => {
  it('a 3-long stub (dir=1): door-end "end" open toward next, mid both ways, cap stays rubble', () => {
    expect(summary(stubTilesFor(g(3, 1), 'r->s'))).toEqual([
      ['corridor-end', 270], // opens E
      ['corridor-mid', 90], // opens E+W
      ['corridor-rubble', 90],
    ]);
  });

  it('a 3-long stub (dir=-1): door-end opens W, mid both ways, cap unchanged', () => {
    expect(summary(stubTilesFor(g(3, -1), 'r->s'))).toEqual([
      ['corridor-end', 90], // opens W
      ['corridor-mid', 90],
      ['corridor-rubble', 270],
    ]);
  });

  it('a 2-long stub: door-end "end", cap stays rubble (no mid tile)', () => {
    expect(summary(stubTilesFor(g(2, 1), 'r->s'))).toEqual([
      ['corridor-end', 270],
      ['corridor-rubble', 90],
    ]);
  });

  it('a 1-long stub: unchanged, the single cell is the rubble cap', () => {
    expect(summary(stubTilesFor(g(1, 1), 'r->s'))).toEqual([['corridor-rubble', 90]]);
  });

  it('the cap tile and the length-1 tile are byte-identical to the pre-#861 output', () => {
    for (const geo of [g(1, 1), g(1, -1), g(2, 1), g(3, -1), g(5, 1)]) {
      const tiles = stubTilesFor(geo, 'k');
      expect(tiles.at(-1)).toEqual(legacyCapTile(geo, 'k'));
    }
  });
});
