// #427 Chunk 6: stub geometry (pure) and the shared inputs it needs.
import { describe, it, expect } from 'vitest';
import { plannedMarginOpenings, cellMarginWalls, roomRect, stubGeometry } from '../scripts/dungeon-layout.mjs';
import { buildSweepScene } from './helpers/scene-oracle.mjs';
import { outgoingPlanFor } from './helpers/layout-sweep.mjs';

const MODULE_ID = 'pf2e-dungeon-crawl';
const wallKey = (c) => c.map((v) => Math.round(v * 1000) / 1000).join(',');

describe('plannedMarginOpenings agrees with the scene (the stub planner reuses it)', () => {
  it('reproduces every room\'s built cell-margin walls on 40 v3 sweep scenes', async () => {
    let rooms = 0;
    for (let i = 0; i < 40; i += 1) {
      const { layout: L, scene } = await buildSweepScene(i, 3);
      const planFor = (src) => outgoingPlanFor(L, src);
      for (const id of Object.keys(L.rooms)) {
        const { rank, col } = L.pos[id];
        const openings = plannedMarginOpenings(L.seed, id, { rank, col }, {
          plan: planFor(id), hiddenChildId: (L.hiddenEdges[id] ?? [])[0] ?? null, edges: L.edges, hiddenEdges: L.hiddenEdges,
          layoutEdges: L.layoutEdges, hiddenIncomingByRoomId: L.hiddenIncomingByRoomId, positionByRoomId: L.pos,
          incomingFaceByRoomId: L.incFace, occupiedCells: L.occ, planFor, layoutVersion: 3,
        });
        const expected = cellMarginWalls(roomRect(L.seed, id, rank, col), rank, col, openings)
          .map((w) => wallKey([w.x1, w.y1, w.x2, w.y2])).sort();
        const built = scene.walls.filter((w) => w.flags?.[MODULE_ID]?.dungeonCellMarginWallForRoom === id)
          .map((w) => wallKey(w.c.map((v) => v / 100))).sort();
        expect(built, `${L.seed} ${id}`).toEqual(expected);
        rooms += 1;
      }
    }
    expect(rooms).toBeGreaterThan(300);
  }, 120000);
});

describe('stubGeometry (pure, hand-built obstacles)', () => {
  // LARGE source at rank 0, col 0: rect {300,0,12,12}, south margin row y=12, cell x in [300,313).
  const sourceRect = { gx: 300, gy: 0, gw: 12, gh: 12 };
  const sourcePos = { rank: 0, col: 0 };
  const door = (x) => ({ x1: x, y1: 12, x2: x + 1, y2: 12 });
  const base = {
    sourceRect, sourcePos, targetPos: { rank: 2, col: -2 }, doorSpan: door(306),
    obstacleFloors: [], obstacleWalls: [], otherDoorSpans: [],
  };
  const run = (over = {}, ids = ['src', 'tgt']) => stubGeometry('s', ids[0], ids[1], { ...base, ...over });

  it('lays a rubble stub in the south margin row: door tile plus up to three cells toward the target', () => {
    const g = run();
    expect(g).toMatchObject({ flavor: 'rubble', dir: -1 });
    expect(g.length).toBeGreaterThanOrEqual(1);
    expect(g.length).toBeLessThanOrEqual(4);
    expect(g.floor).toHaveLength(1);
    const f = g.floor[0];
    expect(f.gy).toBe(12);
    expect(f.gh).toBe(1);
    expect(f.gw).toBe(g.length);
    // the door tile is part of it, extension runs west (target col is lower)
    expect(f.gx + f.gw).toBe(307);
    expect(f.gx).toBe(307 - g.length);
  });

  it('walls: a south flank and a cap at each end, nothing on the room face (the room seals its own face)', () => {
    const g = run();
    const f = g.floor[0];
    expect(g.walls).toEqual([
      { x1: f.gx, y1: 13, x2: f.gx + f.gw, y2: 13 },
      { x1: f.gx, y1: 12, x2: f.gx, y2: 13 },
      { x1: f.gx + f.gw, y1: 12, x2: f.gx + f.gw, y2: 13 },
    ]);
    expect(g.doorWall).toEqual({ x1: 306, y1: 12, x2: 307, y2: 12 });
  });

  it('goes east when the target is east, and toward the room middle when the target shares the column', () => {
    expect(run({ targetPos: { rank: 2, col: 2 } }).dir).toBe(1);
    expect(run({ targetPos: { rank: 2, col: 0 }, doorSpan: door(302) }).dir).toBe(1);
    expect(run({ targetPos: { rank: 2, col: 0 }, doorSpan: door(310) }).dir).toBe(-1);
  });

  it('length is seeded and deterministic; lengths 1..4 all occur across ids', () => {
    const lens = new Set();
    for (let i = 0; i < 60; i += 1) {
      const a = run({}, [`src${i}`, `tgt${i}`]);
      expect(run({}, [`src${i}`, `tgt${i}`])).toEqual(a);
      lens.add(a.length);
    }
    expect([...lens].sort()).toEqual([1, 2, 3, 4]);
  });

  it('yields: an obstacle floor in the next tile clips the stub to the door tile', () => {
    for (let i = 0; i < 20; i += 1) {
      const g = run({ obstacleFloors: [{ gx: 305, gy: 12, gw: 1, gh: 5 }] }, [`src${i}`, `tgt${i}`]);
      expect(g.length).toBe(1);
      expect(g.floor[0]).toEqual({ gx: 306, gy: 12, gw: 1, gh: 1 });
    }
  });

  it('yields: a vertical wall on the boundary between two tiles stops the stub before it', () => {
    for (let i = 0; i < 20; i += 1) {
      const g = run({ obstacleWalls: [{ x1: 305, y1: 12, x2: 305, y2: 20 }] }, [`src${i}`, `tgt${i}`]);
      expect(g.floor[0].gx).toBeGreaterThanOrEqual(305);
    }
  });

  it('never runs under a sibling door of the same south face', () => {
    for (let i = 0; i < 20; i += 1) {
      const g = run({ otherDoorSpans: [door(304)] }, [`src${i}`, `tgt${i}`]);
      expect(g.floor[0].gx).toBeGreaterThan(304);
    }
  });

  it('stays inside its own cell: at least one cell short of the east boundary and off the west boundary', () => {
    for (let i = 0; i < 30; i += 1) {
      const east = run({ targetPos: { rank: 2, col: 2 }, doorSpan: door(310) }, [`a${i}`, `b${i}`]);
      expect(east.floor[0].gx + east.floor[0].gw).toBeLessThanOrEqual(312);
      const west = run({ doorSpan: door(301) }, [`a${i}`, `b${i}`]);
      expect(west.floor[0].gx).toBeGreaterThanOrEqual(301);
      expect(west.length).toBe(1); // tile 300 is on the cell boundary: extension tiles start at 301
    }
  });

  it('returns null when the door tile itself is not free (infeasible, the edge keeps its fallback line)', () => {
    expect(run({ obstacleFloors: [{ gx: 306, gy: 12, gw: 1, gh: 3 }] })).toBeNull();
  });

  it('is independent of obstacle order', () => {
    const obstacleFloors = [{ gx: 300, gy: 12, gw: 1, gh: 1 }, { gx: 302, gy: 12, gw: 1, gh: 4 }];
    const obstacleWalls = [{ x1: 303, y1: 12, x2: 303, y2: 13 }, { x1: 308, y1: 12, x2: 308, y2: 13 }];
    const a = run({ obstacleFloors, obstacleWalls });
    const b = run({ obstacleFloors: [...obstacleFloors].reverse(), obstacleWalls: [...obstacleWalls].reverse() });
    expect(b).toEqual(a);
  });
});
