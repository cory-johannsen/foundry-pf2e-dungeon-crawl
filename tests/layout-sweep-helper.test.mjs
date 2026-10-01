// tests/layout-sweep-helper.test.mjs
import { describe, it, expect } from 'vitest';
import { forEachEdge, legacyExitSelector, rectsOverlap, buildSweepLayout } from './helpers/layout-sweep.mjs';

describe('layout sweep helper', () => {
  it('visits real and hidden edges with a result and segments', () => {
    let n = 0; let hidden = 0;
    forEachEdge(20, legacyExitSelector, ({ result, segments, hidden: h }) => {
      n += 1; if (h) hidden += 1;
      expect(result.corridorSegments.length).toBeGreaterThan(0);
      expect(segments.length).toBeGreaterThanOrEqual(result.corridorSegments.length);
    });
    expect(n).toBeGreaterThan(50);
    expect(hidden).toBeGreaterThan(0);
  });
  it('incomingFace override replaces the incoming face of every room (#427)', () => {
    const forced = buildSweepLayout(3, { incomingFace: () => 'west' });
    expect(Object.values(forced.incFace).every((f) => f === 'west')).toBe(true);
    const dflt = buildSweepLayout(3);
    expect(Object.values(dflt.incFace).some((f) => f === 'north')).toBe(true);
  });
  it('rectsOverlap is strict', () => {
    expect(rectsOverlap({ gx: 0, gy: 0, gw: 2, gh: 2 }, { gx: 2, gy: 0, gw: 2, gh: 2 })).toBe(false);
    expect(rectsOverlap({ gx: 0, gy: 0, gw: 2, gh: 2 }, { gx: 1, gy: 1, gw: 2, gh: 2 })).toBe(true);
  });
});
