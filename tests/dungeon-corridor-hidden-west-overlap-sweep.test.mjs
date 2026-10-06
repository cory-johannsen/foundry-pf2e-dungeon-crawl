import { describe, it, expect } from 'vitest';
import * as deck from '../scripts/dungeon-deck.mjs';
import { computeRunLayout, planRunLayoutStubs } from '../scripts/dungeon-reseed.mjs';
import { buildSceneForLayout, installFoundryStubs } from './helpers/scene-oracle.mjs';
import { sweepShapeOfRunLayout } from './helpers/walkability-oracle.mjs';

installFoundryStubs();
const MODULE_ID = 'pf2e-dungeon-crawl';
const SEEDS = 100;
const cellOf = (t) => [Math.round((t.x - 50) / 100), Math.round((t.y - 50) / 100)];
const inRect = ([gx, gy], r) => gx >= r.gx && gx < r.gx + r.gw && gy >= r.gy && gy < r.gy + r.gh;

/** Groups a built scene's own corridor tiles by their dungeonCorridorEdge
 * flag (same convention tests/dungeon-corridor-joins-sweep.test.mjs
 * already uses), then classifies every HIDDEN, WEST-face-incoming edge's
 * own cells against every room's rect and every other edge's own cells. */
function measure(L, scene) {
  const tilesByEdge = new Map();
  for (const tile of scene.tiles) {
    const edge = tile.flags?.[MODULE_ID]?.dungeonCorridorEdge;
    if (!edge) continue;
    if (!tilesByEdge.has(edge)) tilesByEdge.set(edge, []);
    tilesByEdge.get(edge).push(tile);
  }
  const hits = { ownDest: [], ownSource: [], otherRoom: [], crossCorridor: [] };
  for (const [edgeId, tiles] of tilesByEdge) {
    const [sourceId, targetId] = edgeId.split('->');
    const isHidden = (L.hiddenEdges[sourceId] ?? []).includes(targetId);
    if (!isHidden || L.incFace[targetId] !== 'west') continue;
    for (const tile of tiles) {
      const cell = cellOf(tile);
      if (inRect(cell, L.rect[targetId])) { hits.ownDest.push({ edgeId, cell }); continue; }
      if (inRect(cell, L.rect[sourceId])) { hits.ownSource.push({ edgeId, cell }); continue; }
      const otherRoomId = Object.keys(L.rect).find(
        (roomId) => roomId !== sourceId && roomId !== targetId && inRect(cell, L.rect[roomId]),
      );
      if (otherRoomId) { hits.otherRoom.push({ edgeId, cell, otherRoomId }); continue; }
      const otherEdgeId = [...tilesByEdge.keys()].find(
        (oid) => oid !== edgeId && tilesByEdge.get(oid).some((o) => { const oc = cellOf(o); return oc[0] === cell[0] && oc[1] === cell[1]; }),
      );
      if (otherEdgeId) hits.crossCorridor.push({ edgeId, cell, otherEdgeId });
    }
  }
  return hits;
}

describe('#860 hidden west-face detour corridor entries never cross a room or another corridor', () => {
  it('sweep: 100 routed v3 seeds, a hidden west-face edge never lands on a cell inside any room rect or another edge\'s own cells', async () => {
    const all = { ownDest: [], ownSource: [], otherRoom: [], crossCorridor: [] };
    for (let i = 0; i < SEEDS; i += 1) {
      const P = computeRunLayout({ generator: deck, seed: `sweep-${i}`, roomCount: 6 + (i % 15), topologyRouting: true });
      const planned = await planRunLayoutStubs(P, { retreatAvailable: true });
      const L = sweepShapeOfRunLayout(planned.layout);
      const { scene } = await buildSceneForLayout(L, 3);
      const hits = measure(L, scene);
      for (const k of Object.keys(all)) all[k].push(...hits[k].map((h) => ({ seed: `sweep-${i}`, ...h })));
    }
    // #860's own fix target: a hidden west-face edge's own corridor tile
    // never lands inside its own destination (or source) room's rect.
    expect(all.ownDest).toEqual([]);
    expect(all.ownSource).toEqual([]);
    expect(all.otherRoom).toEqual([]);
    expect(all.crossCorridor).toEqual([]);
  }, 600000);
});
