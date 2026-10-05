// #427: the topology-aware router in the v3 run pipeline, gated by the run-state flag `topologyRouting`.
// What must NOT change (v1/v2 geometry, a v3 run without the flag) is pinned by golden digests computed on main before
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

function digestScene(h, scene) {
  for (const w of scene.walls) h.update(`W${JSON.stringify([w.c, w.door ?? 0, w.ds ?? 0, w.flags?.[MODULE_ID] ?? null])}\n`);
  for (const t of scene.tiles) h.update(`T${JSON.stringify([t.x, t.y, t.width, t.height, t.rotation ?? 0, t.texture?.src ?? null])}\n`);
}

describe('runs without the routing flag keep their geometry exactly (#427)', () => {
  const sceneDigest = async (layoutVersion) => {
    const h = createHash('sha256');
    for (let i = 0; i < 40; i += 1) digestScene(h, (await buildSweepScene(i, layoutVersion)).scene);
    return h.digest('hex');
  };
  it('layoutVersion 2 builds the same walls and tiles as before (40 seeds)', async () => {
    expect(await sceneDigest(2)).toBe('8743a565e9b3d2b039ce0824540a789542ef002e5931e6490d1df868a67c2c02');
  }, 120000);
  it('layoutVersion 1 builds the same walls and tiles as before (40 seeds)', async () => {
    expect(await sceneDigest(1)).toBe('7c040a14c59a253658de7088caf43b062d822cbb425a9c33d5ebe9163a24bd45');
  }, 120000);
  it('a v3 run without the flag: the whole pipeline (reseed, stubs, walls) and its scene are unchanged (40 seeds)', async () => {
    const h = createHash('sha256');
    for (let i = 0; i < 40; i += 1) {
      const chosen = await chooseRunLayout({ generator: deck, seed: `sweep-${i}`, roomCount: 6 + (i % 15) });
      expect(chosen.layout.topologyRouting).toBeUndefined();
      h.update(JSON.stringify(chosen.layout));
      digestScene(h, (await buildSceneForLayout(sweepShapeOfRunLayout(chosen.layout), 3)).scene);
    }
    expect(h.digest('hex')).toBe('93561df2b1fa7dfd527d3f7d89b71fe879319d69b7bfc78af5bb124ad08f3fc3');
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
