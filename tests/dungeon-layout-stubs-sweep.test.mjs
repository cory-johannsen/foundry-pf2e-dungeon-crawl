// #427 Chunk 6 acceptance: the stub plan and its geometry over the 500-seed sweep (layoutVersion 3).
// `retreatAvailable: true` is exercised too (Chunk 7's population, ~1,500 stubs) so the geometry is tested on
// every kind of source, not just the handful of hidden shortcuts that are eligible without retreat.
import { describe, it, expect } from 'vitest';
import {
  planStubsForLayout, layoutEdgeGeometry, outgoingPlanForStubs, roomRect, cellBounds, COLUMN_STRIDE,
} from '../scripts/dungeon-layout.mjs';
import { buildFloorModel } from './helpers/floor-oracle.mjs';
import { buildSweepLayout } from './helpers/layout-sweep.mjs';
import { stubInputsFor, buildStubbedSweepLayout } from './helpers/stub-sweep.mjs';

const SEEDS = 500;
// Measured on the 500-seed v3 sweep (main 0.54.159). Without retreat only hidden shortcut edges are eligible:
// 32 of the 2,052 null edges (86 hidden null edges, 54 of them into detour rooms, which rule 1 refuses; the 14
// non-sole-child real nulls all fail rule 1 or 3), and 26 of those have a free door tile. The old spec estimate
// of about 464 predates #415 Chunk 5 pruning hidden shortcuts. The counts below are floors (more stubs is better);
// the invariants further down are exact.
const NO_RETREAT_NULL_EDGES = 1952; // #906: 2052 -> 1952 (unreachable detours dropped)
const NO_RETREAT_ELIGIBLE = 32;
const NO_RETREAT_STUBS_MIN = 26;
const RETREAT_ELIGIBLE = 1573; // #906: 1576 -> 1573
const RETREAT_STUBS_MIN = 1376;

const layoutsNoRetreat = Array.from({ length: SEEDS }, (_, i) => buildStubbedSweepLayout(i));
const layoutsRetreat = Array.from({ length: SEEDS }, (_, i) => buildStubbedSweepLayout(i, { retreatAvailable: true }));

const reach = (edges) => {
  const seen = new Set(['room-entry']);
  const queue = ['room-entry'];
  while (queue.length) for (const c of edges[queue.shift()] ?? []) if (!seen.has(c)) { seen.add(c); queue.push(c); }
  return seen;
};
const stubCount = (L) => Object.values(L.stubEdges).flat().length;

describe('stub plan counts (500 seeds, v3)', () => {
  it('measures the eligible set without retreat (the ratchet) and the sole-child set with it', () => {
    expect(layoutsNoRetreat.reduce((n, L) => n + L.stubPlan.nullEdges.length, 0)).toBe(NO_RETREAT_NULL_EDGES);
    const planned = (ls) => ls.reduce((n, L) => n + stubCount(L) + L.stubPlan.dropped.length, 0);
    expect(planned(layoutsNoRetreat)).toBe(NO_RETREAT_ELIGIBLE);
    expect(planned(layoutsRetreat)).toBe(RETREAT_ELIGIBLE);
    expect(layoutsNoRetreat.reduce((n, L) => n + stubCount(L), 0)).toBeGreaterThanOrEqual(NO_RETREAT_STUBS_MIN);
    expect(layoutsRetreat.reduce((n, L) => n + stubCount(L), 0)).toBeGreaterThanOrEqual(RETREAT_STUBS_MIN);
    // Without retreat a stub is only ever a hidden shortcut (a false shortcut); sole-child sources stay unstubbed.
    for (const L of layoutsNoRetreat) {
      for (const [src, ts] of Object.entries(L.stubEdges)) for (const t of ts) expect((L.hiddenEdges[src] ?? []).includes(t), `${L.seed} ${src}->${t}`).toBe(true);
    }
  });
});

describe.each([['no retreat', layoutsNoRetreat, false], ['retreat available', layoutsRetreat, true]])('K6 graph invariants, %s', (_name, layouts, retreat) => {
  it('every room stays reachable over non-stub edges, the goal too, and nobody is stranded', () => {
    for (const L of layouts) {
      const before = reach(L.baseEdges);
      const after = reach(L.edges);
      for (const id of before) expect(after.has(id), `${L.seed} lost ${id}`).toBe(true);
      const goal = Object.keys(L.rooms).find((id) => L.rooms[id].isGoal);
      expect(after.has(goal), `${L.seed} goal`).toBe(true);
      if (retreat) continue;
      for (const id of after) {
        if (L.rooms[id].isGoal) continue;
        if ((L.baseEdges[id] ?? []).length > 0) expect((L.edges[id] ?? []).length, `${L.seed} ${id} stranded`).toBeGreaterThan(0);
      }
    }
  });
});

describe.each([['no retreat', layoutsNoRetreat], ['retreat available', layoutsRetreat]])('stub geometry, %s', (_name, layouts) => {
  it('every planned stub has geometry in its source\'s own south margin row, one door each, no room overlap', () => {
    let checked = 0;
    for (const L of layouts) {
      const rects = Object.fromEntries(Object.keys(L.rooms).map((id) => [id, roomRect(L.seed, id, L.pos[id].rank, L.pos[id].col)]));
      const doorKeys = new Set();
      for (const [src, targets] of Object.entries(L.stubEdges)) {
        for (const tgt of targets) {
          const g = L.stubGeometries.get(`${src}->${tgt}`);
          expect(g, `${L.seed} ${src}->${tgt}`).toBeTruthy();
          const cell = cellBounds(L.pos[src].rank, L.pos[src].col);
          const f = g.floor[0];
          expect(f.gy).toBe(rects[src].gy + rects[src].gh);
          expect(f.gh).toBe(1);
          expect(f.gx).toBeGreaterThanOrEqual(cell.gx);
          expect(f.gx + f.gw).toBeLessThanOrEqual(cell.gx + COLUMN_STRIDE - 1);
          expect(g.length).toBeGreaterThanOrEqual(1);
          expect(g.length).toBeLessThanOrEqual(4);
          for (const [id, r] of Object.entries(rects)) {
            const crosses = f.gx < r.gx + r.gw && f.gx + f.gw > r.gx && f.gy < r.gy + r.gh && f.gy + f.gh > r.gy;
            expect(crosses, `${L.seed} stub ${src}->${tgt} overlaps room ${id}`).toBe(false);
            for (const w of g.walls) {
              const inside = w.x1 === w.x2
                ? w.x1 > r.gx && w.x1 < r.gx + r.gw && Math.min(Math.max(w.y1, w.y2), r.gy + r.gh) > Math.max(Math.min(w.y1, w.y2), r.gy)
                : w.y1 > r.gy && w.y1 < r.gy + r.gh && Math.min(Math.max(w.x1, w.x2), r.gx + r.gw) > Math.max(Math.min(w.x1, w.x2), r.gx);
              expect(inside, `${L.seed} stub wall of ${src}->${tgt} cuts room ${id}`).toBe(false);
            }
          }
          const k = `${src}:${g.doorSpan.x1}`;
          expect(doorKeys.has(k)).toBe(false);
          doorKeys.add(k);
          checked += 1;
        }
      }
    }
    expect(checked).toBeGreaterThan(0);
  });

  it('floor oracle: each stub floor is connected end to end, reaches nothing else, and no wall cuts it', () => {
    let checked = 0;
    for (const L of layouts.slice(0, 250)) {
      if (!stubCount(L)) continue;
      const planFor = (s) => outgoingPlanForStubs(L.seed, s, { edges: L.edges, hiddenEdges: L.hiddenEdges, stubEdges: L.stubEdges, positionByRoomId: L.pos });
      const edgeGeo = layoutEdgeGeometry({ ...stubInputsFor(L), edges: undefined, planFor, stubEdges: L.stubEdges });
      const floors = []; const walls = [];
      for (const { result } of edgeGeo) {
        floors.push(...result.corridorSegments, ...result.transitCells.flatMap((c) => c.corridorSegments));
        walls.push(...result.plainWalls, ...result.transitCells.flatMap((c) => c.plainWalls ?? []));
      }
      for (const g of L.stubGeometries.values()) { floors.push(...g.floor); walls.push(...g.walls); }
      const model = buildFloorModel(floors.map((f) => ({ gx: Math.floor(f.gx), gy: Math.floor(f.gy), gw: Math.ceil(f.gw), gh: Math.ceil(f.gh) })), walls);
      for (const g of L.stubGeometries.values()) {
        const f = g.floor[0];
        const own = new Set(Array.from({ length: f.gw }, (_v, k) => `${f.gx + k},${f.gy}`));
        const reached = model.reach(`${g.doorSpan.x1},${f.gy}`);
        expect([...reached].sort(), `${L.seed} ${g.sourceId}->${g.targetId}`).toEqual([...own].sort());
        checked += 1;
      }
    }
    expect(checked).toBeGreaterThan(0);
  }, 120000);

  it('is deterministic: reversing every key order gives the identical plan and geometry', () => {
    const rev = (o) => Object.fromEntries(Object.entries(o).reverse().map(([k, v]) => [k, Array.isArray(v) ? [...v].reverse() : v]));
    let checked = 0;
    for (let i = 0; i < 60; i += 1) {
      const L = layouts[i];
      const retreat = layouts === layoutsRetreat;
      const base = buildSweepLayout(i, { layoutVersion: 3 });
      const inputs = stubInputsFor(base);
      const shuffled = planStubsForLayout({
        ...inputs, rooms: rev(inputs.rooms), positionByRoomId: rev(inputs.positionByRoomId), edges: rev(inputs.edges),
        layoutEdges: rev(inputs.layoutEdges), hiddenEdges: rev(inputs.hiddenEdges),
        hiddenIncomingByRoomId: rev(inputs.hiddenIncomingByRoomId), retreatAvailable: retreat,
      });
      const norm = (m) => JSON.stringify([...m.entries()].sort());
      expect(JSON.stringify(Object.entries(shuffled.stubEdges).sort())).toBe(JSON.stringify(Object.entries(L.stubEdges).sort()));
      expect(norm(shuffled.geometries)).toBe(norm(L.stubGeometries));
      checked += 1;
    }
    expect(checked).toBe(60);
  });
});
