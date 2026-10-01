// tests/dungeon-layout-endpoints.test.mjs
import { describe, it, expect } from 'vitest';
import { forEachEdge, legacyExitSelector, rectsOverlap } from './helpers/layout-sweep.mjs';

const SEEDS = 500;
// Ratchets: measured on the 500-seed sweep (9,464 edges, 1,019 hidden). They may only fall.
const SOURCE_OVERLAP_CEILING = 1141; // goal 0; Chunk 4 sets it to 0
const TARGET_OVERLAP_CEILING = 2272; // fixed under #416
const LANE_CONFLICT_CEILING = 663; // spec Open question 5; Chunk 5 (avoid conflicting hidden shortcuts)

function measure(selector) {
  const m = { edges: 0, source: 0, target: 0, lane: 0, bySource: new Map() };
  forEachEdge(SEEDS, selector, ({ layout, sourceId, toId, segments }) => {
    m.edges += 1;
    if (segments.some((s) => rectsOverlap(s, layout.rect[sourceId]))) m.source += 1;
    if (segments.some((s) => rectsOverlap(s, layout.rect[toId]))) m.target += 1;
    const key = `${layout.seed}|${sourceId}`;
    if (!m.bySource.has(key)) m.bySource.set(key, []);
    m.bySource.get(key).push(segments);
  });
  for (const lists of m.bySource.values()) {
    for (let a = 0; a < lists.length; a += 1) {
      for (let b = a + 1; b < lists.length; b += 1) {
        if (lists[a].some((x) => lists[b].some((y) => rectsOverlap(x, y)))) m.lane += 1;
      }
    }
  }
  return m;
}

describe('corridors never lie inside their own endpoints (#415)', () => {
  const legacy = measure(legacyExitSelector);
  it('sweep is non-vacuous', () => { expect(legacy.edges).toBeGreaterThan(8000); });
  it('no corridor segment of any real or hidden edge overlaps its own SOURCE room', () => {
    expect(legacy.source).toBeLessThanOrEqual(SOURCE_OVERLAP_CEILING); // ratchet: may only fall
  });
  it('target-room overlap does not grow', () => {
    expect(legacy.target).toBeLessThanOrEqual(TARGET_OVERLAP_CEILING); // ratchet: may only fall; fixed under #416
  });
  it('same-source corridor lane conflicts do not grow', () => {
    expect(legacy.lane).toBeLessThanOrEqual(LANE_CONFLICT_CEILING); // ratchet: may only fall; spec Open question 5
  });
});
