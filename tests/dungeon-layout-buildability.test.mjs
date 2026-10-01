// tests/dungeon-layout-buildability.test.mjs
import { describe, it, expect } from 'vitest';
import { buildSweepLayout } from './helpers/layout-sweep.mjs';
import { measureBuildability, sumMeasures } from './helpers/buildability.mjs';
import { buildFloorModel } from './helpers/floor-oracle.mjs';
import { transitCellContainmentWalls } from '../scripts/dungeon-layout.mjs';

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
      edges: 9930, nullPath: 2470, interOverlap: 1316, multi: 2077, sharedCells: 1257,
      cutEdges: 526, cutOccurrences: 861, floorCrossings: 510, targetOverlapDeep: 170,
    });
  });
});
