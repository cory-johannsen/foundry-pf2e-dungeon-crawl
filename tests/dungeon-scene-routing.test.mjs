// #427 Chunk 3, Task 3.2: the topology-aware router wired into the scene under layoutVersion >= 3.
// v1/v2 states build byte-identical geometry (the golden digests below were computed on main before the wiring).
import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { buildSweepScene } from './helpers/scene-oracle.mjs';
import { buildSweepLayout } from './helpers/layout-sweep.mjs';
import { routerInputsFor } from './helpers/router-layout.mjs';
import { routeEdgesTopologyAware, makeRoutingFor } from '../scripts/dungeon-layout.mjs';
import { routingFromState } from '../scripts/dungeon-scene.mjs';

const MODULE_ID = 'pf2e-dungeon-crawl';
const DIGEST_SEEDS = 40;

async function sceneDigest(layoutVersion) {
  const h = createHash('sha256');
  for (let i = 0; i < DIGEST_SEEDS; i += 1) {
    const { scene } = await buildSweepScene(i, layoutVersion);
    for (const w of scene.walls) h.update(`W${JSON.stringify([w.c, w.door ?? 0, w.ds ?? 0, w.flags?.[MODULE_ID] ?? null])}\n`);
    for (const t of scene.tiles) h.update(`T${JSON.stringify([t.x, t.y, t.width, t.height, t.rotation ?? 0, t.texture?.src ?? null])}\n`);
  }
  return h.digest('hex');
}

describe('v1/v2 scene geometry is untouched by the router wiring (#427)', () => {
  it('layoutVersion 2 builds the same walls and tiles as before (40 seeds)', async () => {
    expect(await sceneDigest(2)).toBe('8743a565e9b3d2b039ce0824540a789542ef002e5931e6490d1df868a67c2c02');
  }, 120000);
  it('layoutVersion 1 builds the same walls and tiles as before (40 seeds)', async () => {
    expect(await sceneDigest(1)).toBe('7c040a14c59a253658de7088caf43b062d822cbb425a9c33d5ebe9163a24bd45');
  }, 120000);
});

function stateOf(L, layoutVersion) {
  return {
    seed: L.seed, layoutPositionByRoomId: L.pos, incomingFaceByRoomId: L.incFace, hiddenRooms: L.hiddenRooms,
    edges: L.edges, layoutEdges: L.layoutEdges, hiddenIncomingByRoomId: L.hiddenIncomingByRoomId,
    hiddenEdges: L.hiddenEdges, layoutVersion, maxRank: 20,
  };
}

describe('the scene computes the pure router\'s routing (#427, layoutVersion 3)', () => {
  const edgeIds = (L) => Object.entries(L.layoutEdges).flatMap(([from, kids]) => kids.map((to) => `${from}->${to}`));
  it('equals routeEdgesTopologyAware on the same layout, and is independent of state key order (30 seeds)', () => {
    let routedEdges = 0;
    for (let i = 0; i < 30; i += 1) {
      const L = buildSweepLayout(i, { layoutVersion: 3 });
      const pure = makeRoutingFor(routeEdgesTopologyAware(routerInputsFor(L)));
      const rev = (o) => Object.fromEntries(Object.entries(o).reverse());
      const st = stateOf(L, 3);
      const fromScene = routingFromState(st);
      const fromReversed = routingFromState({ ...st, layoutPositionByRoomId: rev(st.layoutPositionByRoomId), edges: rev(st.edges), layoutEdges: rev(st.layoutEdges) });
      for (const id of [...edgeIds(L), ...Object.entries(L.hiddenEdges).flatMap(([f, k]) => k.map((t) => `${f}->${t}`))]) {
        expect(fromScene(id)).toEqual(pure(id));
        expect(fromReversed(id)).toEqual(pure(id));
        if (pure(id)) routedEdges += 1;
      }
    }
    expect(routedEdges).toBeGreaterThan(50);
  });
  it('is absent below layoutVersion 3 (no routing at all)', () => {
    const L = buildSweepLayout(3, { layoutVersion: 2 });
    expect(routingFromState(stateOf(L, 2))).toBeUndefined();
    expect(routingFromState(stateOf(L, 1))).toBeUndefined();
  });
  it('is memoised on the layout inputs (the same function for an unchanged state)', () => {
    const L = buildSweepLayout(3, { layoutVersion: 3 });
    expect(routingFromState(stateOf(L, 3))).toBe(routingFromState(stateOf(L, 3)));
  });
});
