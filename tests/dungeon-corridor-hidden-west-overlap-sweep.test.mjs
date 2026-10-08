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
  const hits = { ownDest: [], ownSource: [], otherRoom: [], crossCorridor: [], doorUncovered: [] };
  for (const [edgeId, tiles] of tilesByEdge) {
    const [sourceId, targetId] = edgeId.split('->');
    // #860: EVERY west-face-incoming edge (hidden or visible): the reveal door's OUTSIDE cell (one cell west of the
    // door, same row) must be one of the edge's own corridor cells, or the corridor stops diagonal to / short of it.
    if (L.incFace[targetId] === 'west') {
      const f = (w) => w.flags?.[MODULE_ID] ?? {};
      const rev = scene.walls.find((w) => (f(w).dungeonHiddenDoorForEdge === edgeId && f(w).dungeonHiddenDoorRole === 'reveal')
        || (w.door && f(w).dungeonRevealDoorForSlot === targetId && f(w).dungeonDoorFromRoomId === sourceId));
      if (rev) {
        const [rx, ry1] = rev.c.map((n) => n / 100);
        const out = [rx - 1, Math.floor(ry1)];
        if (!tiles.some((t) => { const c = cellOf(t); return c[0] === out[0] && c[1] === out[1]; })) hits.doorUncovered.push({ edgeId, cell: out });
      }
    }
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
    const all = { ownDest: [], ownSource: [], otherRoom: [], crossCorridor: [], doorUncovered: [] };
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
    // Second, distinct phenomenon #860 also reports: a corridor cell inside an UNRELATED third room. 17 cells before
    // #860, 12 after it (all sweep-81, y=45, x=300..311 through room-room-room-room-entry-0-0-0): that detour had no
    // reachable approach at all, so the scene drew the null-path fallback line. #906 drops such detours: 0.
    expect(all.otherRoom.map((h) => `${h.seed} ${h.cell}`)).toEqual([]);
    expect(all.crossCorridor).toEqual([]);
    // #860: every west-face door's outside cell is covered by its own corridor (incl. a corridor arriving from the north).
    expect(all.doorUncovered).toEqual([]);
  }, 600000);
});

// #906: seed 51 (#860's named repro) no longer builds a hidden west-face edge -- its detour was unreachable and is now
// dropped -- so the repro runs on seed 10, the lowest sweep seed that still builds one.
describe('#860 repro on seed 10 (seed 51\'s detour is dropped by #906)', () => {
  it('its hidden west-face corridor has no cell inside its destination room and covers its door\'s outside cell', async () => {
    const P = computeRunLayout({ generator: deck, seed: 'sweep-10', roomCount: 6 + (10 % 15), topologyRouting: true });
    const planned = await planRunLayoutStubs(P, { retreatAvailable: true });
    const L = sweepShapeOfRunLayout(planned.layout);
    const { scene } = await buildSceneForLayout(L, 3);
    const hits = measure(L, scene);
    expect(hits.ownDest).toEqual([]);
    expect(hits.doorUncovered).toEqual([]);
    const edges = new Set(scene.tiles.map((t) => t.flags?.[MODULE_ID]?.dungeonCorridorEdge).filter(Boolean));
    expect([...edges].some((e) => L.incFace[e.split('->')[1]] === 'west' && (L.hiddenEdges[e.split('->')[0]] ?? []).includes(e.split('->')[1]))).toBe(true);
  }, 120000);
});
