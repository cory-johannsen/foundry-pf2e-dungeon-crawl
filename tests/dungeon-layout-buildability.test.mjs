// tests/dungeon-layout-buildability.test.mjs
import { describe, it, expect } from 'vitest';
import { buildSweepLayout, planSelector } from './helpers/layout-sweep.mjs';
import { measureBuildability, sumMeasures, visitEdges } from './helpers/buildability.mjs';
import { buildFloorModel } from './helpers/floor-oracle.mjs';
import { transitCellContainmentWalls, pendingForeignMarginOpenings, incomingSlotsV3 } from '../scripts/dungeon-layout.mjs';

const SEEDS = 500;
// Ratchets, measured on main 0.54.60 (layoutVersion 2: rest room spliced, shortcuts pruned; 9,498 edges).
// They may only fall. (The spec's 0.54.49 numbers were unpruned; the v1 block below reproduces those.)
const NULL_PATH_CEILING = 2052;
const INTERMEDIATE_OVERLAP_CEILING = 1132;
const SHARED_CELL_CUT_EDGES_CEILING = 501;
const SHARED_CELL_CUT_OCCURRENCES_CEILING = 814;
const FLOOR_CROSSING_CEILING = 484;
const DEEP_TARGET_OVERLAP_CEILING = 160;

describe('layoutVersion 2 buildability baseline (#427)', () => {
  const total = Array.from({ length: SEEDS }, (_, i) => measureBuildability(buildSweepLayout(i, { layoutVersion: 2 }))).reduce(sumMeasures);
  it('is non-vacuous and exact on the invariants that already hold', () => {
    expect(total.edges).toBeGreaterThan(9000);
    expect(total.interOverlapFound).toBe(0);
    expect(total.targetDoorCovered).toBe(0);
    expect(total.chainMismatch).toBe(0);
    expect(total.sourceOverlap).toBe(0);
  });
  it('ratchets do not rise', () => {
    expect(total.nullPath).toBeLessThanOrEqual(NULL_PATH_CEILING);
    expect(total.interOverlap).toBeLessThanOrEqual(INTERMEDIATE_OVERLAP_CEILING);
    expect(total.cutEdges).toBeLessThanOrEqual(SHARED_CELL_CUT_EDGES_CEILING);
    expect(total.cutOccurrences).toBeLessThanOrEqual(SHARED_CELL_CUT_OCCURRENCES_CEILING);
    expect(total.floorCrossings).toBeLessThanOrEqual(FLOOR_CROSSING_CEILING);
    expect(total.targetOverlapDeep).toBeLessThanOrEqual(DEEP_TARGET_OVERLAP_CEILING);
  });
});

// The oracle (flood fill over floors and solid walls) must agree with the geometric cut check on the
// known sample: seed sweep-10, cell r0c2, edge A runs west->south as a vertical lane, edge B west->east
// as a horizontal lane at y=10; each one's flank walls cut the other's floor.
describe('flood-fill oracle confirms the known cut (#427)', () => {
  const cellUse = new Map();
  measureBuildability(buildSweepLayout(10, { layoutVersion: 2 }), { cellUse });
  const uses = cellUse.get('0,2');
  const A = uses.find((u) => u.id === 'room-entry->room-room-entry-1');
  const B = uses.find((u) => u.id.startsWith('room-room-room-entry-0-0->'));
  const containment = transitCellContainmentWalls(0, 2, uses.flatMap(({ c }) => [
    { side: c.entrySide, point: c.entryPoint }, { side: c.exitSide, point: c.exitPoint }]));
  const allWalls = [...containment, ...uses.flatMap(({ c }) => c.plainWalls)];
  const key = (seg, last) => (last ? `${seg.gx + seg.gw - 1},${seg.gy + seg.gh - 1}` : `${seg.gx},${seg.gy}`);
  const endsOf = (use) => [key(use.c.corridorSegments[0]), key(use.c.corridorSegments.at(-1), true)];

  it('has the expected shared cell', () => {
    expect(uses.length).toBe(2);
    expect(A).toBeDefined();
    expect(B).toBeDefined();
  });
  it('severs edge A (a vertical lane) under both edges\' walls', () => {
    const [from, to] = endsOf(A);
    expect(buildFloorModel(A.c.corridorSegments, allWalls).reach(from).has(to)).toBe(false);
  });
  it('severs edge B (a horizontal lane) under both edges\' walls', () => {
    const [from, to] = endsOf(B);
    expect(buildFloorModel(B.c.corridorSegments, allWalls).reach(from).has(to)).toBe(false);
  });
  it('control: each edge alone (its own walls plus containment) is connected', () => {
    for (const u of [A, B]) {
      const own = [...transitCellContainmentWalls(0, 2, [
        { side: u.c.entrySide, point: u.c.entryPoint }, { side: u.c.exitSide, point: u.c.exitPoint }]), ...u.c.plainWalls];
      const [from, to] = endsOf(u);
      expect(buildFloorModel(u.c.corridorSegments, own).reach(from).has(to)).toBe(true);
    }
  });
  // flips in Chunk 1b: under a v3 lane plan the two edges no longer share floor, so the first two tests
  // become "connected".
});

// The helper must reproduce the spec's measurement on the unpruned layout, or the ratchets above mean nothing.
describe('measureBuildability reproduces the spec baseline on layoutVersion 1 (#427)', () => {
  it('matches the numbers measured on main 0.54.49', () => {
    const t = Array.from({ length: SEEDS }, (_, i) => measureBuildability(buildSweepLayout(i))).reduce(sumMeasures);
    expect(t).toMatchObject({
      // #860 re-pin: west-face corridor legs no longer run through the destination room's first column, so
      // interOverlap 1316 -> 1281 and targetOverlapDeep 170 -> 0 (the 170 west-incoming edges #427/#416 had abandoned).
      edges: 9930, nullPath: 2470, interOverlap: 1281, multi: 2077, sharedCells: 1257,
      cutEdges: 526, cutOccurrences: 861, floorCrossings: 510, targetOverlapDeep: 0,
    });
  });
});

// layoutVersion 3, Task 2.1 (#427): `incomingDoorOrder` replaces the list order; #297's priority swap still runs on it.
// Every v2 ratchet holds on the v3 geometry; the one that moves is intermediate overlap (the order alone).
const V3_INTERMEDIATE_OVERLAP_CEILING = 1097;
describe('layoutVersion 3 buildability: incoming door order only (#427)', () => {
  const layouts = Array.from({ length: SEEDS }, (_, i) => buildSweepLayout(i, { layoutVersion: 3 }));
  const total = layouts.map((l) => measureBuildability(l)).reduce(sumMeasures);
  it('holds every v2 invariant', () => {
    // #906: 9498 -> 9386, the 56 dropped (unreachable) detour rooms' two edges each.
    expect(total.edges).toBe(9386);
    expect(total.interOverlapFound).toBe(0);
    expect(total.targetDoorCovered).toBe(0);
    expect(total.chainMismatch).toBe(0);
    expect(total.sourceOverlap).toBe(0);
  });
  it('holds every v2 ratchet (K9) and the order alone lowers intermediate overlap', () => {
    expect(total.nullPath).toBeLessThanOrEqual(NULL_PATH_CEILING);
    expect(total.interOverlap).toBeLessThanOrEqual(V3_INTERMEDIATE_OVERLAP_CEILING);
    expect(total.interOverlap).toBeLessThan(INTERMEDIATE_OVERLAP_CEILING);
    expect(total.cutEdges).toBeLessThanOrEqual(SHARED_CELL_CUT_EDGES_CEILING);
    expect(total.cutOccurrences).toBeLessThanOrEqual(SHARED_CELL_CUT_OCCURRENCES_CEILING);
    expect(total.floorCrossings).toBeLessThanOrEqual(FLOOR_CROSSING_CEILING);
    expect(total.targetOverlapDeep).toBeLessThanOrEqual(DEEP_TARGET_OVERLAP_CEILING);
  });
  it('door/wall agreement: every dogleg\'s foreign margin opening is reported by pendingForeignMarginOpenings in v3 order', () => {
    let doglegs = 0;
    for (const L of layouts) {
      const planFor = planSelector.planFor(L);
      visitEdges(L, ({ res }) => {
        const fo = res.foreignOpening;
        if (!fo) return;
        doglegs += 1;
        const { rank, col } = L.pos[fo.roomId];
        const open = pendingForeignMarginOpenings(L.seed, fo.roomId, rank, col, L.edges, L.pos, L.incFace, L.occ,
          L.layoutEdges, L.hiddenIncomingByRoomId, L.hiddenEdges, planFor, true);
        expect(open[fo.side]).toContainEqual({ offset: fo.offset, width: fo.width });
      });
    }
    expect(doglegs).toBeGreaterThan(300);
  });
  it('incomingSlotsV3 is the slot every built edge actually received', () => {
    let checked = 0;
    for (const L of layouts.slice(0, 100)) {
      const planFor = planSelector.planFor(L);
      const received = new Map();
      visitEdges(L, ({ sourceId, toId, slot }) => received.set(`${sourceId}->${toId}`, slot));
      for (const toId of Object.keys(L.rooms)) {
        const slots = incomingSlotsV3(L.seed, toId, L.pos[toId], {
          layoutEdges: L.layoutEdges, hiddenIncomingByRoomId: L.hiddenIncomingByRoomId, positionByRoomId: L.pos,
          occupiedCells: L.occ, incomingFace: L.incFace[toId], planFor, detour: L.hiddenRooms.includes(toId),
        });
        for (const { sourceId, slot } of slots) { expect(received.get(`${sourceId}->${toId}`)).toEqual(slot); checked += 1; }
      }
    }
    expect(checked).toBeGreaterThan(1500);
  });
  it('v1/v2 slot assignment is untouched (the same helper without layoutVersion 3 still uses the priority swap)', () => {
    const v2 = Array.from({ length: SEEDS }, (_, i) => measureBuildability(buildSweepLayout(i, { layoutVersion: 2 }))).reduce(sumMeasures);
    // #860 re-pin: 1132 -> 1104 (west-face legs moved off the destination room's first column).
    expect(v2.interOverlap).toBe(1104);
    expect(v2.cutOccurrences).toBe(814);
  });
});
