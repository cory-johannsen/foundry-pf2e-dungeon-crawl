// tests/dungeon-layout-buildability.test.mjs
import { describe, it, expect } from 'vitest';
import { buildSweepLayout } from './helpers/layout-sweep.mjs';
import { measureBuildability, sumMeasures } from './helpers/buildability.mjs';

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
