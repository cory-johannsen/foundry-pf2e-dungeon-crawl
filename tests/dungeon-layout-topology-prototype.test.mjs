// tests/dungeon-layout-topology-prototype.test.mjs
// #427 topology-aware routing PROTOTYPE (test-only measurement, no scripts/ change). See
// docs/superpowers/specs/2026-10-01-topology-aware-corridor-routing-design.md.
// The full 500-seed run takes about 75 s, so the suite runs the first 100 seeds; the 500-seed numbers
// are recorded in the design note (unresolvable 185 of 2,063 = 9.0%; this subset: 36 of 411 = 8.8%).
import { describe, it, expect } from 'vitest';
import { buildSweepLayout } from './helpers/layout-sweep.mjs';
import { routeLayoutTopologyAware, sumRoutes } from './helpers/topology-router.mjs';

const SEEDS = 100;

describe('topology-aware sequential router prototype (#427)', () => {
  const total = Array.from({ length: SEEDS }, (_, i) => routeLayoutTopologyAware(buildSweepLayout(i, { layoutVersion: 2 }))).reduce(sumRoutes);

  it('is non-vacuous and internally consistent', () => {
    expect(total.multi).toBeGreaterThan(300);
    expect(total.placedFirst + total.rerouted + total.unresolvable).toBe(total.multi);
    expect(total.rerouted).toBeGreaterThan(0);
  });
  it('placed edges have zero crossings and zero cuts (real wall check, not the model)', () => {
    expect(total.placedFloorCrossings).toBe(0);
    expect(total.placedCutOccurrences).toBe(0);
    expect(total.newInterOverlap).toBe(0);
  });
  it("K2' is exceeded: re-routing recovers little (204 -> 185 on 500 seeds), residual pinned", () => {
    expect(total.unresolvable).toBeGreaterThan(Math.floor(0.02 * total.multi));
    expect(total.unresolvable).toBeLessThanOrEqual(36);
    expect(total.extraCells).toBeLessThanOrEqual(12);
  });
});
