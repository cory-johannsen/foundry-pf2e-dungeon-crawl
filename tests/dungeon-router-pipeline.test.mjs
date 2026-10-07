// #427: the topology-aware router in the v3 run pipeline, gated by the run-state flag `topologyRouting`.
// What must NOT change (v1/v2 geometry, a v3 run without the flag) is pinned by golden digests (walls: computed on main before
// this change (the v3 digest was re-pinned in #754: it hashes the layout, which carries room kinds, and trap left the kind table); what changes (a flagged run) is proved edge by edge and by tests/dungeon-router-pipeline-sweep.test.mjs.
import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import * as deck from '../scripts/dungeon-deck.mjs';
import {
  computeRunLayout, chooseRunLayout, planRunLayoutStubs, topologyRoutingStateFor, NEW_RUN_TOPOLOGY_ROUTING,
} from '../scripts/dungeon-reseed.mjs';
import { deadEdgeSets } from '../scripts/dungeon-stub-oracle.mjs';
import { routingForLayout } from '../scripts/dungeon-layout.mjs';
import { routingFromState } from '../scripts/dungeon-scene.mjs';
import { buildSweepScene, buildSceneForLayout, installFoundryStubs } from './helpers/scene-oracle.mjs';
import { sweepShapeOfRunLayout } from './helpers/walkability-oracle.mjs';

installFoundryStubs();
const MODULE_ID = 'pf2e-dungeon-crawl';

function digestWalls(h, scene) {
  for (const w of scene.walls) h.update(`W${JSON.stringify([w.c, w.door ?? 0, w.ds ?? 0, w.flags?.[MODULE_ID] ?? null])}\n`);
}
function digestTiles(h, scene) {
  for (const t of scene.tiles) h.update(`T${JSON.stringify([t.x, t.y, t.width, t.height, t.rotation ?? 0, t.texture?.src ?? null])}\n`);
}
function digestScene(h, scene) {
  digestWalls(h, scene);
  digestTiles(h, scene);
}

// #823 re-pin: corridor TILES changed on purpose (an openings-based piece per distinct cell: join and bend cells get a
// different art file/rotation, a bend gets the new corner piece, stacked duplicate tiles are gone). Tiles are visual
// only, so every WALL digest below is the value computed on the pre-#823 code (8428daad) and is UNCHANGED; only the
// tile digests were re-pinned. (The pre-#823 combined walls+tiles digests were 8743a565..., 7c040a14... and 93561df2...)
// #860 re-pin (tiles only): west-face incoming corridors now run one cell west of the destination room's first column, so
// the corridor TILE digests moved; every WALL digest below is unchanged (verified: walls identical before and after).
describe('runs without the routing flag keep their geometry exactly (#427)', () => {
  const sceneDigests = async (layoutVersion) => {
    const walls = createHash('sha256');
    const tiles = createHash('sha256');
    for (let i = 0; i < 40; i += 1) {
      const { scene } = await buildSweepScene(i, layoutVersion);
      digestWalls(walls, scene);
      digestTiles(tiles, scene);
    }
    return { walls: walls.digest('hex'), tiles: tiles.digest('hex') };
  };
  it('layoutVersion 2 builds the same walls and (re-pinned, #823) tiles (40 seeds)', async () => {
    expect(await sceneDigests(2)).toEqual({ walls: 'eeedfa994be105aaab4a7ffd66ab885251aa65b53f015c7369f6d1e2ea935d39', tiles: 'beb78ef5ec6552697a48b6acfe397a18fcb7b603dcb28d297a9e49edfae8cd39' });
  }, 120000);
  it('layoutVersion 1 builds the same walls and (re-pinned, #823) tiles (40 seeds)', async () => {
    expect(await sceneDigests(1)).toEqual({ walls: 'c3432f24940373854c6eebc2cbc582c387cae91b547e1963592b407dd1b74836', tiles: 'be0de9a5cb8b0c259e7b927fc093a0971421b21d934ff9185c9d88edc14dcb32' });
  }, 120000);
  it('a v3 run without the flag: the whole pipeline (reseed, stubs, walls) is unchanged; tiles re-pinned (#823) (40 seeds)', async () => {
    const walls = createHash('sha256');
    const tiles = createHash('sha256');
    for (let i = 0; i < 40; i += 1) {
      const chosen = await chooseRunLayout({ generator: deck, seed: `sweep-${i}`, roomCount: 6 + (i % 15) });
      expect(chosen.layout.topologyRouting).toBeUndefined();
      walls.update(JSON.stringify(chosen.layout));
      const { scene } = await buildSceneForLayout(sweepShapeOfRunLayout(chosen.layout), 3);
      digestWalls(walls, scene);
      digestTiles(tiles, scene);
    }
    // #861: dead-end stub corridor tiles now use the openings-based piece rule (end/mid instead of the closed 'single'),
    // so the tiles digest moved (was e3123cd8...); the walls digest is byte-identical.
    expect({ walls: walls.digest('hex'), tiles: tiles.digest('hex') }).toEqual({ walls: 'a5721e874f506919d21f179ffcf16970e7e502eee1f3dc7a19be74da385d03aa', tiles: '3dcc98a0499a692844f4c590676fb42b777b59d2e4106e4cfb8ef689066a4578' });
  }, 300000);
});

describe('the topologyRouting flag (#427)', () => {
  const gen = { generator: deck, seed: 'sweep-3', roomCount: 9 };
  it('new runs are routed by default in the app, and the flag is stamped only on v3 layouts that asked for it', () => {
    expect(NEW_RUN_TOPOLOGY_ROUTING).toBe(true);
    expect(computeRunLayout({ ...gen, topologyRouting: true }).topologyRouting).toBe(true);
    expect(computeRunLayout({ ...gen }).topologyRouting).toBeUndefined();
    expect(computeRunLayout({ ...gen, layoutVersion: 2, topologyRouting: true }).topologyRouting).toBeUndefined();
    expect(computeRunLayout({ ...gen, layoutVersion: 1, topologyRouting: true }).topologyRouting).toBeUndefined();
  });
  it('topologyRoutingStateFor: only a flagged v3 layout adds the run-state field (v1/v2 states stay byte-identical)', () => {
    expect(topologyRoutingStateFor(3, { topologyRouting: true })).toEqual({ topologyRouting: true });
    expect(topologyRoutingStateFor(3, {})).toEqual({});
    expect(topologyRoutingStateFor(2, { topologyRouting: true })).toEqual({});
    expect(topologyRoutingStateFor(1, { topologyRouting: true })).toEqual({});
  });
  it('the planned layout keeps the flag through the stub and wall plan', async () => {
    const planned = await planRunLayoutStubs(computeRunLayout({ ...gen, topologyRouting: true }), { retreatAvailable: true });
    expect(planned.layout.topologyRouting).toBe(true);
  });
});

function stateOf(layout, extra = {}) {
  return {
    seed: layout.seed, layoutPositionByRoomId: layout.layoutPositionByRoomId, incomingFaceByRoomId: layout.incomingFaceByRoomId,
    hiddenRooms: layout.hiddenRooms, edges: layout.edges, layoutEdges: layout.layoutEdges,
    hiddenIncomingByRoomId: layout.hiddenIncomingByRoomId, hiddenEdges: layout.hiddenEdges, layoutVersion: 3, maxRank: 20,
    ...(layout.stubEdges ? { stubEdges: layout.stubEdges } : {}), ...(layout.walledEdges ? { walledEdges: layout.walledEdges } : {}),
    ...extra,
  };
}

describe('the scene routes only a run stamped topologyRouting (#427)', () => {
  const layoutOf = (i, topologyRouting) => computeRunLayout({ generator: deck, seed: `sweep-${i}`, roomCount: 6 + (i % 15), topologyRouting });
  it('no flag, or a version below 3: no routing at all', () => {
    const L = layoutOf(3, true);
    expect(routingFromState(stateOf(L))).toBeUndefined();
    expect(routingFromState(stateOf(L, { topologyRouting: false }))).toBeUndefined();
    expect(routingFromState(stateOf(L, { topologyRouting: true, layoutVersion: 2 }))).toBeUndefined();
    expect(routingFromState(stateOf(L, { topologyRouting: true, layoutVersion: 1 }))).toBeUndefined();
    expect(routingFromState(stateOf(L, { topologyRouting: true }))).toBeTypeOf('function');
  });
  it('equals routingForLayout on the same layout, is independent of key order, and is memoised (30 seeds)', () => {
    let routed = 0;
    for (let i = 0; i < 30; i += 1) {
      const L = layoutOf(i, true);
      const st = stateOf(L, { topologyRouting: true });
      const rev = (o) => Object.fromEntries(Object.entries(o).reverse());
      const pure = routingForLayout({
        seed: L.seed, positionByRoomId: L.layoutPositionByRoomId, occupiedCells: L.occupiedCells, incomingFaceByRoomId: L.incomingFaceByRoomId,
        layoutEdges: L.layoutEdges, hiddenIncomingByRoomId: L.hiddenIncomingByRoomId, hiddenRooms: L.hiddenRooms, edges: L.edges,
        hiddenEdges: L.hiddenEdges,
      });
      const fromScene = routingFromState(st);
      expect(routingFromState(st)).toBe(fromScene);
      const fromReversed = routingFromState({ ...st, layoutPositionByRoomId: rev(st.layoutPositionByRoomId), edges: rev(st.edges), layoutEdges: rev(st.layoutEdges) });
      const ids = Object.entries(L.layoutEdges).flatMap(([from, kids]) => kids.map((to) => `${from}->${to}`));
      for (const id of ids) {
        expect(fromScene(id)).toEqual(pure(id));
        expect(fromReversed(id)).toEqual(pure(id));
        if (pure(id)) routed += 1;
      }
    }
    expect(routed).toBeGreaterThan(50);
  });
  it('a flagged scene differs from the unflagged one only where the router acted (same layout, same seed)', async () => {
    let differing = 0;
    for (let i = 0; i < 20; i += 1) {
      const a = sweepShapeOfRunLayout(layoutOf(i, true));
      const b = sweepShapeOfRunLayout(layoutOf(i, false));
      const ha = createHash('sha256'); const hb = createHash('sha256');
      digestScene(ha, (await buildSceneForLayout(a, 3)).scene);
      digestScene(hb, (await buildSceneForLayout(b, 3)).scene);
      if (ha.digest('hex') !== hb.digest('hex')) differing += 1;
    }
    // The flag is not a no-op: routing moves at least one corridor in these layouts (the layouts themselves are identical).
    expect(differing).toBeGreaterThan(0);
  }, 120000);
});

describe('unresolvable edges are dead edges for the stub and wall plan (#427)', () => {
  // sweep-12~r3 (18 rooms) has two edges the router cannot place without crossing another edge's floor.
  const gen = { generator: deck, seed: 'sweep-12~r3', roomCount: 18, topologyRouting: true };
  it('the dead set of the stub-free scene contains them, and the planned layout leaves none live', async () => {
    const P = computeRunLayout(gen);
    const routingFor = routingForLayout({
      seed: P.seed, positionByRoomId: P.layoutPositionByRoomId, occupiedCells: P.occupiedCells, incomingFaceByRoomId: P.incomingFaceByRoomId,
      layoutEdges: P.layoutEdges, hiddenIncomingByRoomId: P.hiddenIncomingByRoomId, hiddenRooms: P.hiddenRooms, edges: P.edges,
      hiddenEdges: P.hiddenEdges,
    });
    expect(routingFor.unresolvable.length).toBeGreaterThan(0);
    const dead = deadEdgeSets(P, (await buildSceneForLayout(sweepShapeOfRunLayout(P), 3)).scene);
    for (const id of routingFor.unresolvable) {
      const [from, to] = id.split('->');
      if ((P.edges[from] ?? []).includes(to)) {
        expect(dead.truth.has(id), id).toBe(true);
        expect(dead.union.has(id), id).toBe(true);
      }
    }
    const planned = await planRunLayoutStubs(P, { retreatAvailable: true });
    const L = planned.layout;
    const final = routingForLayout({
      seed: L.seed, positionByRoomId: L.layoutPositionByRoomId, occupiedCells: L.occupiedCells, incomingFaceByRoomId: L.incomingFaceByRoomId,
      layoutEdges: L.layoutEdges, hiddenIncomingByRoomId: L.hiddenIncomingByRoomId, hiddenRooms: L.hiddenRooms, edges: L.edges,
      hiddenEdges: L.hiddenEdges, stubEdges: L.stubEdges ?? {}, walledEdges: L.walledEdges ?? {},
    });
    expect(final.unresolvable).toEqual([]);
    const after = deadEdgeSets(L, (await buildSceneForLayout(sweepShapeOfRunLayout(L), 3)).scene);
    expect(after.union.size).toBe(0);
  }, 120000);
});
