// #427 Phase 4 PROTOTYPE test (test-only; no scripts/ change). The 500-seed numbers quoted in
// docs/superpowers/specs/2026-10-01-margin-lane-passage-design.md come from `measurePassages` over all
// 500 seeds; the suite runs the first 12 only, to keep `npm test` fast, and pins the properties the
// design relies on (determinism, lanes never enter a room, default slot order untouched).
import { describe, it, expect } from 'vitest';
import { buildSweepLayout } from './helpers/layout-sweep.mjs';
import { measurePassages, ZERO_PASSAGE, sumPassage } from './helpers/passage-prototype.mjs';
import { measureBuildability, sumMeasures, ZERO } from './helpers/buildability.mjs';

const SEEDS = 12;
const layouts = Array.from({ length: SEEDS }, (_, i) => buildSweepLayout(i, { layoutVersion: 2 }));
const total = (opts) => layouts.map((l) => measurePassages(l, opts)).reduce(sumPassage, ZERO_PASSAGE());

describe('passage lane prototype (#427 Phase 4, test-only)', () => {
  const approach = total({ slotOrder: 'approach' });

  it('serves a non-trivial share of the boxed-in edges and never routes through a room', () => {
    expect(approach.boxedIn).toBeGreaterThan(20);
    expect(approach.served).toBeGreaterThan(0);
    expect(approach.served + approach.residual).toBe(approach.boxedIn);
    expect(approach.overlapsOwnRooms).toBe(0);
    expect(approach.noMouth).toBe(0);
  });

  it('no served lane crosses the fallback line an unserved edge still draws', () => {
    let checked = 0;
    for (const l of layouts) {
      const { edges } = measurePassages(l, { slotOrder: 'approach', detail: true });
      const laneTiles = new Set(edges.filter((e) => e.lane).flatMap((e) => e.lane.map((t) => `${t.x},${t.y}`)));
      for (const e of edges.filter((x) => x.null && x.overlapRoom && !x.lane)) {
        for (const s of e.segs) {
          for (let x = s.gx; x < s.gx + s.gw; x += 1) for (let y = s.gy; y < s.gy + s.gh; y += 1) expect(laneTiles.has(`${x},${y}`)).toBe(false);
        }
        checked += 1;
      }
    }
    expect(checked).toBeGreaterThan(10);
  });

  it('is deterministic', () => {
    expect(total({ slotOrder: 'approach' })).toEqual(approach);
  });

  it('the default slot order is untouched by the approach option', () => {
    const dflt = layouts.map((l) => measureBuildability(l)).reduce(sumMeasures, ZERO());
    const dfltExplicit = layouts.map((l) => measureBuildability(l, { slotOrder: 'plan' })).reduce(sumMeasures, ZERO());
    expect(dfltExplicit).toEqual(dflt);
  });

  it('approach slot order does not change which edges lack a grid path', () => {
    const plan = layouts.map((l) => measureBuildability(l)).reduce(sumMeasures, ZERO());
    const appr = layouts.map((l) => measureBuildability(l, { slotOrder: 'approach' })).reduce(sumMeasures, ZERO());
    expect(appr.nullPath).toBe(plan.nullPath);
    expect(appr.interOverlapFound).toBe(0);
  });
});
