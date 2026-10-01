// tests/dungeon-layout-lanes-prototype.test.mjs
// #427 Chunk 1 / PR B: does a lane plan fit when several edges cross one cell? Decides kill criterion K2.
import { describe, it, expect } from 'vitest';
import { buildSweepLayout } from './helpers/layout-sweep.mjs';
import { measureBuildability, sumMeasures } from './helpers/buildability.mjs';
import {
  crossingsByCell, edgeChains, assignLanes, bestAssignLanes, assignableWithoutCrossing,
} from './helpers/lane-prototype.mjs';
import { cellBounds, COLUMN_STRIDE } from '../scripts/dungeon-layout.mjs';

const SEEDS = 500;

describe('lane prototype building blocks (#427)', () => {
  // Two synthetic straight (north -> south) chains through one cell, pinned at both ends.
  const cell = { rank: 0, col: 0 };
  const x0 = cellBounds(0, 0).gx;
  const straight = (id, coord) => ({
    id, toId: id, sourceId: 's', targetRank: 1, seed: 'syn',
    cells: [{ ...cell, entrySide: 'north', exitSide: 'south' }], c0: x0 + coord, cn: x0 + coord, baseline: [],
  });
  it('parallel pinned lanes on different offsets are assignable', () => {
    expect(assignableWithoutCrossing([straight('a', 2), straight('b', 5)])).toBe(true);
  });
  it('two pinned lanes on the same offset are not', () => {
    const { infeasible } = assignLanes([straight('a', 2), straight('b', 2)]);
    expect(infeasible).toEqual(['b']);
  });
  it('a border holds exactly COLUMN_STRIDE one-wide straight lanes and reports the rest', () => {
    const chains = Array.from({ length: COLUMN_STRIDE + 3 }, (_, i) => straight(`e${String(i).padStart(2, '0')}`, i % COLUMN_STRIDE));
    const { infeasible } = assignLanes(chains);
    expect(infeasible.length).toBe(3);
  });
  it('a side-forced crossing (north-south and west-east) is infeasible, never merged', () => {
    const ns = straight('ns', 6);
    const we = {
      id: 'we', toId: 'we', sourceId: 's', targetRank: 1, seed: 'syn',
      cells: [{ ...cell, entrySide: 'west', exitSide: 'east' }],
      c0: cellBounds(0, 0).gy + 6, cn: cellBounds(0, 0).gy + 6, baseline: [],
    };
    expect(assignLanes([ns, we]).infeasible).toEqual(['we']);
  });
});

describe('lane prototype on the 500-seed layoutVersion 2 sweep (#427 K2)', () => {
  const layouts = Array.from({ length: SEEDS }, (_, i) => buildSweepLayout(i, { layoutVersion: 2 }));
  const base = layouts.map((l) => measureBuildability(l)).reduce(sumMeasures);
  const per = layouts.map((l) => {
    const chains = edgeChains(l);
    const raw = [...crossingsByCell(l).values()].reduce((m, v) => Math.max(m, v.length), 0);
    return { greedy: assignLanes(chains).infeasible.length, best: bestAssignLanes(chains).infeasible.length, raw };
  });
  const greedy = per.reduce((n, p) => n + p.greedy, 0);
  const best = per.reduce((n, p) => n + p.best, 0);
  const K2_ALLOWANCE = Math.floor(0.02 * base.multi);

  it('is non-vacuous: shared cells exist and carry 5+ edges today', () => {
    expect(base.multi).toBeGreaterThan(1500);
    expect(base.floorCrossings).toBeGreaterThan(400);
    expect(Math.max(...per.map((p) => p.raw))).toBeGreaterThanOrEqual(5);
    expect(crossingsByCell(layouts[10]).get('0,2').length).toBe(2);
  });
  // MEASURED 2026-10-01 (#427 PR B): K2 TRIPS. In the model of lane-prototype.mjs (pinned door ends,
  // existing straight/L shapes, free corner coordinates only) 204 edges (greedy, canonical order) or
  // 197 (best of 2 orderings; 8 reorderings reach 194; a pairwise lower bound is 193) cannot be placed without a floor crossing, against an allowance of
  // 2% of 2,063 multi-cell edges = 41. Almost all are forced by topology, not capacity: 365 of 381
  // forced pairs interleave across a 2-cell stretch (sweep-10: A west->south and B south->east around
  // cells r0c1+r0c2 alternate on the perimeter), only 16 are the cell-local N-S vs W-E pairs. Peak
  // load is 5 edges in one cell, well inside the 13-wide border. This test pins the finding; it does
  // not claim the allowance holds.
  it('K2 is exceeded: the measured unresolvable count is pinned, not hidden', () => {
    console.log(`K2: multi ${base.multi}, floorCrossings ${base.floorCrossings}, unresolvable greedy ${greedy} best ${best}, allowance ${K2_ALLOWANCE}`);
    expect(K2_ALLOWANCE).toBe(41);
    expect(greedy).toBeGreaterThan(K2_ALLOWANCE);
    expect(best).toBeGreaterThan(K2_ALLOWANCE);
    expect(greedy).toBeLessThanOrEqual(204);
    expect(best).toBeLessThanOrEqual(197);
  });
});

