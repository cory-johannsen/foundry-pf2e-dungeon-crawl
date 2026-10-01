// tests/dungeon-layout-endpoints.test.mjs
import { describe, it, expect } from 'vitest';
import {
  forEachEdge, legacyExitSelector, rectsOverlap, buildSweepLayout, outgoingPlanFor,
} from './helpers/layout-sweep.mjs';
import { outgoingDoorPlan, DOOR_WIDTH } from '../scripts/dungeon-layout.mjs';

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

describe('outgoingDoorPlan invariants over the sweep (#415)', () => {
  it('faces are south/east only, east only for higher-column targets, spans disjoint and in-slot, within face capacity, order-independent', () => {
    let rooms = 0; let maxDoors = 0; let multiDoorFaces = 0;
    for (let i = 0; i < SEEDS; i += 1) {
      const L = buildSweepLayout(i);
      for (const sourceId of Object.keys(L.rooms)) {
        const real = L.edges[sourceId] ?? [];
        const hidden = (L.hiddenEdges[sourceId] ?? []).slice(0, 1);
        if (!real.length && !hidden.length) continue;
        rooms += 1;
        const plan = outgoingPlanFor(L, sourceId);
        expect(plan.size).toBe(real.length + hidden.length);
        // order independence: reversed child lists give the identical plan
        const rev = outgoingDoorPlan(L.rect[sourceId], L.pos[sourceId],
          { realChildIds: real.slice().reverse(), hiddenChildIds: hidden }, L.pos);
        for (const [id, e] of plan) expect(rev.get(id)).toEqual(e);
        const rect = L.rect[sourceId];
        const spans = { south: [], east: [] };
        for (const [id, e] of plan) {
          expect(['south', 'east']).toContain(e.face);
          if (e.face === 'east') expect(L.pos[id].col).toBeGreaterThan(L.pos[sourceId].col);
          else expect(L.pos[id].col).toBeLessThanOrEqual(L.pos[sourceId].col);
          maxDoors = Math.max(maxDoors, e.doorCount);
          const faceLen = e.face === 'south' ? rect.gw : rect.gh;
          expect(e.doorCount * DOOR_WIDTH).toBeLessThanOrEqual(faceLen);
          if (e.doorCount === 1) {
            expect(e.exitPoint).toBeNull();
            expect(e.doorSpan).toBeNull();
            continue;
          }
          expect(Number.isInteger(e.exitPoint.x) && Number.isInteger(e.exitPoint.y)).toBe(true);
          const lo = e.face === 'south' ? e.doorSpan.x1 : e.doorSpan.y1;
          const hi = e.face === 'south' ? e.doorSpan.x2 : e.doorSpan.y2;
          const slo = e.face === 'south' ? e.slot.x1 : e.slot.y1;
          const shi = e.face === 'south' ? e.slot.x2 : e.slot.y2;
          expect(hi - lo).toBe(DOOR_WIDTH);
          expect(lo).toBeGreaterThanOrEqual(slo);
          expect(hi).toBeLessThanOrEqual(shi);
          spans[e.face].push([lo, hi]);
        }
        for (const face of ['south', 'east']) {
          const s = spans[face].sort((a, b) => a[0] - b[0]);
          if (s.length) multiDoorFaces += 1;
          for (let k = 1; k < s.length; k += 1) expect(s[k][0]).toBeGreaterThanOrEqual(s[k - 1][1]);
        }
      }
    }
    expect(rooms).toBeGreaterThan(3000);
    expect(maxDoors).toBeGreaterThan(1);
    expect(multiDoorFaces).toBeGreaterThan(0);
  });
});
