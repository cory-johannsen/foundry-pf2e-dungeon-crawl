// #427 Task 2.2: the pure passage-lane planner (`needsPassage`, `mouthTile`, `planPassageLanes`,
// `passageLaneGeometry`). Nothing here touches the scene; Task 2.4 wires it after the user's gate (Task 2.3).
import { describe, it, expect } from 'vitest';
import {
  INITIAL_GX, needsPassage, mouthTile, mouthDoorSide, passageLaneGeometry, planPassageLanes,
} from '../scripts/dungeon-layout.mjs';
import { buildSweepLayout } from './helpers/layout-sweep.mjs';
import { measureBuildability, sumMeasures } from './helpers/buildability.mjs';
import {
  passageEdges, passageInput, measurePlan, ZERO_PLAN, sumPlan,
} from './helpers/passage-layout.mjs';
import { oracleForSeed } from './helpers/passage-oracle.mjs';

const OX = INITIAL_GX + 2;
const t = (x, y) => ({ x: OX + x, y: 2 + y });

describe('needsPassage: the single trigger', () => {
  const cases = [
    [{ nullPath: false, fallbackOverlapsOtherRoom: false, unresolvable: false }, false],
    [{ nullPath: false, fallbackOverlapsOtherRoom: true, unresolvable: false }, false], // a found path never overlaps; defensive
    [{ nullPath: true, fallbackOverlapsOtherRoom: false, unresolvable: false }, false], // a harmless fallback line stays
    [{ nullPath: true, fallbackOverlapsOtherRoom: true, unresolvable: false }, true],
    [{ nullPath: false, fallbackOverlapsOtherRoom: false, unresolvable: true }, true], // the router's unresolvable edges
    [{ nullPath: true, fallbackOverlapsOtherRoom: false, unresolvable: true }, true],
  ];
  it.each(cases)('%j -> %s', (input, expected) => {
    expect(needsPassage(input)).toBe(expected);
  });
});

describe('mouthTile: the unit tile just outside a door', () => {
  it('south below, north above, east right, west left', () => {
    expect(mouthTile({ x1: 10, y1: 20, x2: 11, y2: 20 }, 'south')).toEqual({ x: 10, y: 20 });
    expect(mouthTile({ x1: 10, y1: 20, x2: 11, y2: 20 }, 'north')).toEqual({ x: 10, y: 19 });
    expect(mouthTile({ x1: 30, y1: 5, x2: 30, y2: 6 }, 'east')).toEqual({ x: 30, y: 5 });
    expect(mouthTile({ x1: 30, y1: 5, x2: 30, y2: 6 }, 'west')).toEqual({ x: 29, y: 5 });
  });
  it('does not depend on the order of the wall endpoints', () => {
    expect(mouthTile({ x1: 11, y1: 20, x2: 10, y2: 20 }, 'south')).toEqual({ x: 10, y: 20 });
  });
  it('mouthDoorSide is the mouth tile edge that carries the door', () => {
    expect(['south', 'north', 'east', 'west'].map(mouthDoorSide)).toEqual(['north', 'south', 'west', 'east']);
  });
});

describe('passageLaneGeometry', () => {
  it('a straight lane: one floor rect, two flank walls, no openings', () => {
    const tiles = [t(0, 0), t(0, 1), t(0, 2)];
    const g = passageLaneGeometry(tiles, { srcDoorSide: 'north', dstDoorSide: 'south' });
    expect(g.floors).toEqual([{ gx: OX, gy: 2, gw: 1, gh: 3 }]);
    expect(g.walls).toEqual([
      { x1: OX, y1: 2, x2: OX, y2: 5 },
      { x1: OX + 1, y1: 2, x2: OX + 1, y2: 5 },
    ]);
    expect(g.openingsByCell).toEqual({});
  });
  it('an L-shaped lane: two floor rects sharing no tile, walls on every boundary but the lane\'s own joins and doors', () => {
    const tiles = [t(0, 0), t(0, 1), t(1, 1), t(2, 1)];
    const g = passageLaneGeometry(tiles, { srcDoorSide: 'north', dstDoorSide: 'east' });
    expect(g.floors).toEqual([{ gx: OX, gy: 2, gw: 1, gh: 2 }, { gx: OX + 1, gy: 3, gw: 2, gh: 1 }]);
    expect(g.walls).toEqual([
      { x1: OX, y1: 2, x2: OX, y2: 4 },
      { x1: OX, y1: 4, x2: OX + 3, y2: 4 },
      { x1: OX + 1, y1: 2, x2: OX + 1, y2: 3 },
      { x1: OX + 1, y1: 3, x2: OX + 3, y2: 3 },
    ]);
  });
  it('a one-tile lane is walled on the two sides that are not doors', () => {
    const g = passageLaneGeometry([t(0, 0)], { srcDoorSide: 'north', dstDoorSide: 'south' });
    expect(g.floors).toEqual([{ gx: OX, gy: 2, gw: 1, gh: 1 }]);
    expect(g.walls).toEqual([{ x1: OX, y1: 2, x2: OX, y2: 3 }, { x1: OX + 1, y1: 2, x2: OX + 1, y2: 3 }]);
  });
  it('non-consecutive lane tiles that touch are walled apart', () => {
    const tiles = [t(0, 0), t(1, 0), t(1, 1), t(0, 1)]; // a U: (0,0) and (0,1) are neighbours but not consecutive
    const g = passageLaneGeometry(tiles, { srcDoorSide: 'north', dstDoorSide: 'south' });
    expect(g.walls).toContainEqual({ x1: OX, y1: 3, x2: OX + 1, y2: 3 });
  });
  it('one opening per cell border crossed, on both cells, in absolute coordinates', () => {
    const x12 = INITIAL_GX + 12; // last tile column of cell col 0; x13 starts col 1
    const tiles = [{ x: x12 - 1, y: 3 }, { x: x12, y: 3 }, { x: x12 + 1, y: 3 }, { x: x12 + 1, y: 4 }];
    const g = passageLaneGeometry(tiles, { srcDoorSide: 'west', dstDoorSide: 'north' });
    expect(g.openingsByCell).toEqual({
      '0,0': [{ side: 'east', offset: 3, width: 1 }],
      '0,1': [{ side: 'west', offset: 3, width: 1 }],
    });
  });
});

describe('passageLaneGeometry: a door on a cell border is a crossing', () => {
  it('a door on the top-row mouth tile of a cell (door on its north edge) asks the cell above for an opening at the door', () => {
    const x = INITIAL_GX + 3;
    const y = 13; // first tile row of rank 1; the door line is the border with rank 0
    const g = passageLaneGeometry([{ x, y }, { x, y: y + 1 }], { srcDoorSide: 'north', dstDoorSide: 'south' });
    expect(g.openingsByCell['0,0']).toContainEqual({ side: 'south', offset: x, width: 1 });
    expect(g.openingsByCell['1,0']).toContainEqual({ side: 'north', offset: x, width: 1 });
  });
});

describe('planPassageLanes: synthetic fixtures', () => {
  const rooms = (...rects) => Object.fromEntries(rects.map((r, k) => [`room-${k}`, r]));
  const positions = { a: { rank: 0, col: 0 }, b: { rank: 0, col: 1 }, c: { rank: 0, col: 0 }, d: { rank: 0, col: 1 } };
  const base = { positionByRoomId: positions, rectByRoomId: {}, edgeGeometry: [] };
  const target = (edgeId, sourceId, toId, srcMouth, dstMouth) => ({
    edgeId, sourceId, toId, srcMouth, dstMouth, srcFace: 'east', dstFace: 'west', floors: [],
  });
  const X = INITIAL_GX;

  it('routes a straight lane between two mouths and derives its geometry from the tile list', () => {
    const lanes = planPassageLanes({ ...base, targets: [target('a->b', 'a', 'b', { x: X + 2, y: 5 }, { x: X + 6, y: 5 })] });
    const lane = lanes.get('a->b');
    expect(lane.tiles.map((p) => p.x)).toEqual([2, 3, 4, 5, 6].map((d) => X + d));
    expect(lane.doorMouths).toEqual({ src: { x: X + 2, y: 5 }, dst: { x: X + 6, y: 5 } });
    expect(lane.floors).toEqual([{ gx: X + 2, gy: 5, gw: 5, gh: 1 }]);
  });
  it('capacity: two targets needing the one gap tile serve the first and report the other residual, never overlapping', () => {
    // a wall of blocked tiles (a room) at x = X+10 except the single gap tile (X+10, 6)
    const wall = { gx: X + 10, gy: -13, gw: 1, gh: 19 }; // y -13..5
    const wall2 = { gx: X + 10, gy: 7, gw: 1, gh: 19 }; // y 7..25
    const input = {
      ...base,
      rectByRoomId: rooms(wall, wall2),
      targets: [
        target('c->d', 'c', 'd', { x: X + 8, y: 6 }, { x: X + 12, y: 6 }),
        target('a->b', 'a', 'b', { x: X + 8, y: 7 }, { x: X + 12, y: 5 }),
      ],
    };
    const lanes = planPassageLanes(input);
    // canonical order: target rank, target id, source id -> a->b (target b) before c->d (target d)
    expect([...lanes.keys()]).toEqual(['a->b']);
    expect(lanes.has('c->d')).toBe(false);
  });
  it('an unserved target keeps its fallback line, so no served lane crosses it', () => {
    const wall = { gx: X + 10, gy: -13, gw: 1, gh: 39 }; // spans the whole search box: nothing crosses it
    const line = [{ gx: X + 4, gy: 0, gw: 1, gh: 13 }];
    const lanes = planPassageLanes({
      ...base,
      rectByRoomId: rooms(wall),
      targets: [
        { ...target('a->b', 'a', 'b', { x: X + 2, y: 5 }, { x: X + 6, y: 5 }), floors: [] },
        { ...target('c->d', 'c', 'd', { x: X + 12, y: 5 }, { x: X + 8, y: 5 }), floors: line }, // unserved (the wall blocks it)
      ],
    });
    // c->d cannot reach (X+8 is west of the wall); it is unserved and its line at x = X+4 blocks a->b's straight run
    expect(lanes.has('c->d')).toBe(false);
    expect(lanes.has('a->b')).toBe(true); // it detours around the kept line instead of crossing it
    for (const p of lanes.get('a->b').tiles) expect(p.x === X + 4 && p.y >= 0 && p.y < 13).toBe(false);
    expect(lanes.get('a->b').tiles.length).toBeGreaterThan(5); // not the straight run
  });
});

describe('planPassageLanes on real layouts (sweep seeds, layoutVersion 3 geometry)', () => {
  it('sweep-0 repro (room-room-entry-1 -> room-merge-3): v2 draws it through the co-parent, the v3 order alone removes the overlap', () => {
    const id = 'room-room-entry-1->room-merge-3';
    const v2 = passageEdges(buildSweepLayout(0, { layoutVersion: 2 })).find((x) => x.edgeId === id);
    expect(v2.passage).toBe(true); // the repro still reproduces under v2 geometry: null path, fallback through the co-parent
    const v3 = passageEdges(buildSweepLayout(0, { layoutVersion: 3 })).find((x) => x.edgeId === id);
    expect(v3.nullPath).toBe(true); // still no grid path ...
    expect(v3.overlapsOther).toBe(false); // ... but with its slot east of the co-parent's its fallback line misses every room
    expect(v3.passage).toBe(false);
  });

  it('pinned real lane, sweep-2 room-room-entry-1 -> room-rest: starts and ends on its door mouths and never enters a room', () => {
    const layout = buildSweepLayout(2, { layoutVersion: 3 });
    const edges = passageEdges(layout);
    const e = edges.find((x) => x.edgeId === 'room-room-entry-1->room-rest');
    expect(e.passage).toBe(true);
    const lane = planPassageLanes(passageInput(layout, edges)).get(e.edgeId);
    expect(lane).toBeDefined();
    expect(lane.tiles[0]).toEqual(e.srcMouth);
    expect(lane.tiles.at(-1)).toEqual(e.dstMouth);
    expect(lane.tiles.length).toBe(52);
    for (const r of Object.values(layout.rect)) {
      for (const p of lane.tiles) expect(p.x >= r.gx && p.x < r.gx + r.gw && p.y >= r.gy && p.y < r.gy + r.gh).toBe(false);
    }
  });

  it('is independent of edge and room order and repeatable', () => {
    for (const i of [0, 3, 7, 12, 40]) {
      const layout = buildSweepLayout(i, { layoutVersion: 3 });
      const edges = passageEdges(layout);
      const input = passageInput(layout, edges);
      const plan = planPassageLanes(input);
      const rev = {
        ...input,
        edgeGeometry: [...input.edgeGeometry].reverse(),
        targets: [...input.targets].reverse(),
        positionByRoomId: Object.fromEntries(Object.entries(input.positionByRoomId).reverse()),
        rectByRoomId: Object.fromEntries(Object.entries(input.rectByRoomId).reverse()),
      };
      const toObj = (m) => JSON.parse(JSON.stringify([...m.entries()].sort(([a], [b]) => (a < b ? -1 : 1))));
      expect(toObj(planPassageLanes(rev))).toEqual(toObj(plan));
      expect(toObj(planPassageLanes(input))).toEqual(toObj(plan));
    }
  });
});

// Oracle: every served lane over 100 seeds, with the walls a scene would build (see helpers/passage-oracle.mjs).
describe('passage lane oracle (#427 Task 2.2)', () => {
  it('connected door to door, nothing else reachable, no door sealed, 0 failures over 100 seeds', async () => {
    const total = { served: 0, notConnected: 0, leaks: 0, doorSealed: 0, sealedBefore: 0, sealedAfter: 0 };
    for (let i = 0; i < 100; i += 1) {
      const r = await oracleForSeed(i);
      total.served += r.served;
      for (const k of ['notConnected', 'leaks', 'doorSealed']) total[k] += r.fails[k];
      total.sealedBefore += r.sealedBefore;
      total.sealedAfter += r.sealedAfter;
    }
    expect(total.served).toBeGreaterThan(20);
    expect(total.notConnected).toBe(0);
    expect(total.leaks).toBe(0);
    expect(total.doorSealed).toBe(0);
    expect(total.sealedAfter).toBeLessThanOrEqual(total.sealedBefore); // lanes replace fallback lines; never seal more
  }, 300000);
});

// Sweep ratchets on all 500 seeds. Values set from the first real measurement (PR 2.2); they may only improve.
const PASSAGE_TARGETS = 1097; // v3 intermediate-overlap edges (the order alone took 1,132 to 1,097)
const PASSAGE_SERVED_FLOOR = 151; // measured; the prototype's upper bound was 193 of 1,101
const PASSAGE_RESIDUAL_CEILING = 946;
const K10_FLOOR = 145;
describe('passage planner sweep (500 seeds, v3 geometry)', () => {
  const layouts = Array.from({ length: 500 }, (_, i) => buildSweepLayout(i, { layoutVersion: 3 }));
  const total = layouts.map((l) => measurePlan(l).m).reduce(sumPlan, ZERO_PLAN());
  it('targets equal the v3 intermediate-overlap edges', () => {
    const overlap = layouts.map((l) => measureBuildability(l)).reduce(sumMeasures);
    expect(total.targets).toBe(overlap.interOverlap);
    expect(total.served + total.residual).toBe(total.targets);
  });
  it('serves at least the kill-criterion floor (K10) and the recorded floor', () => {
    expect(total.served).toBeGreaterThanOrEqual(K10_FLOOR);
    expect(total.served).toBeGreaterThanOrEqual(PASSAGE_SERVED_FLOOR);
    expect(total.residual).toBeLessThanOrEqual(PASSAGE_RESIDUAL_CEILING);
    expect(total.targets).toBeLessThanOrEqual(PASSAGE_TARGETS);
  });
  it('lanes are not tours (K12): total length within 1.15x Manhattan, few over 2x, crossings only what distance needs', () => {
    expect(total.servedTiles).toBeLessThanOrEqual(1.15 * total.servedManhattan);
    expect(total.over2xManhattan).toBeLessThanOrEqual(0.05 * total.served);
    // K12 read literally ("a lane crosses a cell border more than 12 times") trips on distance alone: the
    // longest lane's two rooms are 13 cells apart. What K12 is after is detours, so the test pins the excess
    // over the cell-level Manhattan distance between the two rooms.
    expect(total.maxExcessCrossings).toBeLessThanOrEqual(2);
  });
  it('the residual is almost all sole-child edges (nothing but stubs after #439 can take them)', () => {
    expect(total.residualSoleChild / total.residual).toBeGreaterThan(0.95);
  });
});
