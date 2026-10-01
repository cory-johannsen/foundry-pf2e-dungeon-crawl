// tests/dungeon-layout-endpoints.test.mjs
import { describe, it, expect } from 'vitest';
import {
  forEachEdge, legacyExitSelector, planSelector, rectsOverlap, buildSweepLayout, outgoingPlanFor,
} from './helpers/layout-sweep.mjs';
import {
  outgoingDoorPlan, DOOR_WIDTH, roomEnclosureWalls, cellMarginWalls, outgoingMarginOffset,
  pendingForeignMarginOpenings, incomingConnectionsFor,
} from '../scripts/dungeon-layout.mjs';

const SEEDS = 500;
// Ratchets: measured on the 500-seed sweep (9,930 edges incl. the mid-dungeon rest room the
// scene splices in). They may only fall.
//
// layoutVersion 1 (legacy exit faces by child index): kept as a reference, broken by design.
const LEGACY_SOURCE_OVERLAP_CEILING = 1138;
const LEGACY_TARGET_OVERLAP_CEILING = 2272;
const LEGACY_LANE_CONFLICT_CEILING = 654;
// layoutVersion 2 (outgoingDoorPlan): the new-run behavior.
const SOURCE_OVERLAP_CEILING = 0; // the #415 acceptance criterion
const TARGET_OVERLAP_CEILING = 2272; // fixed under #416
// Edges whose margin opening is narrower than the corridor floor, all explained by a pre-existing
// cause (below). Measured 993 of 9,930; may only fall.
const MARGIN_OPENING_CUT_CEILING = 993;
const LANE_CONFLICT_CEILING = 329; // spec Open question 5; Chunk 5 (avoid generating conflicting hidden shortcuts)

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

describe('layoutVersion 1 (legacy exit faces) reference (#415)', () => {
  const legacy = measure(legacyExitSelector);
  it('sweep is non-vacuous and legacy really is broken (why version 2 exists)', () => {
    expect(legacy.edges).toBeGreaterThan(9000);
    expect(legacy.source).toBeGreaterThan(0);
  });
  it('legacy overlaps do not grow', () => {
    expect(legacy.source).toBeLessThanOrEqual(LEGACY_SOURCE_OVERLAP_CEILING); // ratchet: may only fall
    expect(legacy.target).toBeLessThanOrEqual(LEGACY_TARGET_OVERLAP_CEILING);
    expect(legacy.lane).toBeLessThanOrEqual(LEGACY_LANE_CONFLICT_CEILING);
  });
});

describe('layoutVersion 2 (outgoingDoorPlan): corridors never lie inside their own endpoints (#415)', () => {
  const plan = measure(planSelector);
  it('sweep is non-vacuous', () => { expect(plan.edges).toBeGreaterThan(9000); });
  it('no corridor segment of any real or hidden edge overlaps its own SOURCE room', () => {
    expect(plan.source).toBeLessThanOrEqual(SOURCE_OVERLAP_CEILING);
  });
  it('target-room overlap does not grow', () => {
    expect(plan.target).toBeLessThanOrEqual(TARGET_OVERLAP_CEILING); // ratchet: may only fall; fixed under #416
  });
  it('same-source corridor lane conflicts do not grow', () => {
    expect(plan.lane).toBeLessThanOrEqual(LANE_CONFLICT_CEILING); // ratchet: may only fall; spec Open question 5
  });
});

// A found path is not a buildable one: check the walls the scene would actually build for each
// source room (enclosure + margin + each edge's own plain/door walls) against the planned doors.
describe('layoutVersion 2 buildability: wall versus door (#415)', () => {
  const faceLine = (rect, face) => (face === 'south'
    ? { horizontal: true, at: rect.gy + rect.gh, from: rect.gx, to: rect.gx + rect.gw }
    : { horizontal: false, at: rect.gx + rect.gw, from: rect.gy, to: rect.gy + rect.gh });
  // the [from, to] extent of a wall lying ON the face line (clipped to the face), or null
  const onFace = (w, line) => {
    if (line.horizontal ? !(w.y1 === line.at && w.y2 === line.at) : !(w.x1 === line.at && w.x2 === line.at)) return null;
    const a = line.horizontal ? Math.min(w.x1, w.x2) : Math.min(w.y1, w.y2);
    const b = line.horizontal ? Math.max(w.x1, w.x2) : Math.max(w.y1, w.y2);
    return [Math.max(a, line.from), Math.min(b, line.to)];
  };
  const spanOf = (w, horizontal) => (horizontal
    ? [Math.min(w.x1, w.x2), Math.max(w.x1, w.x2)]
    : [Math.min(w.y1, w.y2), Math.max(w.y1, w.y2)]);
  const overlapLen = (a, b) => Math.min(a[1], b[1]) - Math.max(a[0], b[0]);
  // does a wall segment cut through the interior of a corridor floor rect?
  const cuts = (w, f) => {
    if (w.y1 === w.y2) {
      return f.gy < w.y1 && w.y1 < f.gy + f.gh
        && Math.max(Math.min(w.x1, w.x2), f.gx) < Math.min(Math.max(w.x1, w.x2), f.gx + f.gw);
    }
    return f.gx < w.x1 && w.x1 < f.gx + f.gw
      && Math.max(Math.min(w.y1, w.y2), f.gy) < Math.min(Math.max(w.y1, w.y2), f.gy + f.gh);
  };

  it('every planned door has matching wall gaps and openings, with no leak and no covered door', () => {
    const bySource = new Map();
    forEachEdge(SEEDS, planSelector, (visit) => {
      const key = `${visit.layout.seed}|${visit.sourceId}`;
      if (!bySource.has(key)) bySource.set(key, []);
      bySource.get(key).push(visit);
    });
    const problems = [];
    let rooms = 0; let multiDoorFaces = 0; let doors = 0; let cutEdges = 0;
    for (const visits of bySource.values()) {
      const { layout, sourceId } = visits[0];
      const { seed, rect: rects, pos, occ, incFace } = layout;
      const rect = rects[sourceId];
      const { rank, col } = pos[sourceId];
      const tag = `${seed}|${sourceId}`;
      const plan = outgoingPlanFor(layout, sourceId);
      rooms += 1;
      if (visits.length !== plan.size) { problems.push(`${tag}: ${visits.length} built edges vs ${plan.size} planned`); continue; }

      // the scene's own walls for this source room
      const spansByFace = {};
      for (const e of plan.values()) if (e.doorSpan) (spansByFace[e.face] ??= []).push(e.doorSpan);
      const outgoingFaces = [...new Set([...plan.values()].map((e) => e.face))];
      const enclosure = roomEnclosureWalls(seed, sourceId, {
        incomingCount: 1, incomingFace: incFace[sourceId], outgoingFaces, doorSpansByFace: spansByFace,
      }, rect);
      const planFor = (id) => outgoingPlanFor(layout, id);
      const foreign = pendingForeignMarginOpenings(
        seed, sourceId, rank, col, layout.edges, pos, incFace, occ,
        layout.layoutEdges, layout.hiddenIncomingByRoomId, layout.hiddenEdges, planFor,
      );
      const openings = { east: [...foreign.east], south: [...foreign.south] };
      for (const v of visits) {
        const entry = plan.get(v.toId);
        openings[entry.face].push(outgoingMarginOffset(
          seed, sourceId, v.toId, entry.face, rect, { rank, col }, pos[v.toId], occ, incFace[v.toId], entry,
        ));
      }
      const margin = cellMarginWalls(rect, rank, col, openings);

      for (const face of outgoingFaces) {
        const line = faceLine(rect, face);
        const { horizontal } = line;
        const faceDoors = visits.filter((v) => v.face === face);
        doors += faceDoors.length;
        if (faceDoors.length > 1) multiDoorFaces += 1;
        // every edge's door is one cell on its face, and is the planned span when the face is multi-door
        for (const v of faceDoors) {
          const door = spanOf(v.result.doorWall, horizontal);
          if (!onFace(v.result.doorWall, line) || door[1] - door[0] !== DOOR_WIDTH) {
            problems.push(`${tag}->${v.toId}: door not one cell on the ${face} face`);
          }
          if (v.exitDoor?.exitPoint) {
            const sp = spanOf(v.exitDoor.doorSpan, horizontal);
            if (door[0] !== sp[0] || door[1] !== sp[1]) problems.push(`${tag}->${v.toId}: door is not the planned span`);
          }
        }
        // leak: the face is solid except exactly the doors (enclosure + every edge's own caps)
        const solid = [];
        for (const w of enclosure.filter((x) => x.dir === face)) solid.push(spanOf(w, horizontal));
        for (const v of visits) {
          for (const w of v.result.plainWalls) {
            const c = onFace(w, line);
            if (c && c[1] > c[0]) solid.push(c);
          }
        }
        for (let cell = line.from; cell < line.to; cell += 1) {
          const covered = solid.some((c) => c[0] <= cell && cell + 1 <= c[1]);
          const isDoor = faceDoors.some((v) => {
            const d = spanOf(v.result.doorWall, horizontal);
            return d[0] <= cell && cell + 1 <= d[1];
          });
          if (isDoor && covered) problems.push(`${tag}: a wall covers the door at ${face} cell ${cell}`);
          if (!isDoor && !covered) problems.push(`${tag}: leak at ${face} cell ${cell}`);
        }
        // no edge's wall covers a SIBLING's door (touching an end is allowed)
        for (const v of faceDoors) {
          const d = spanOf(v.result.doorWall, horizontal);
          for (const o of visits) {
            if (o === v) continue;
            for (const w of o.result.plainWalls) {
              const c = onFace(w, line);
              if (c && overlapLen(c, d) > 0) problems.push(`${tag}: ${o.toId}'s wall covers ${v.toId}'s door`);
            }
          }
        }
      }
      // a margin opening exists and is as wide as the corridor floor: no margin wall cuts any floor.
      // Two causes are known and NOT this change's: (a) #231, outgoingMarginOffset assumes the target has
      // one full-width incoming slot, so a merge target (2+ incoming) gets a wider floor than opening;
      // (b) lane conflicts (spec Open question 5, Chunk 5), where a sibling's corridor shares the lane.
      // Anything else, and in particular any planned door of its own, must be zero.
      for (const v of visits) {
        if (!v.segments.some((f) => margin.some((w) => cuts(w, f)))) continue;
        cutEdges += 1;
        const incoming = incomingConnectionsFor(layout.layoutEdges, v.toId, layout.hiddenIncomingByRoomId).length;
        const siblingLane = visits.some((o) => o !== v && o.segments.some((x) => v.segments.some((y) => rectsOverlap(x, y))));
        if (incoming < 2 && !siblingLane) problems.push(`${tag}->${v.toId}: a margin wall cuts the corridor floor`);
      }
    }
    expect(rooms).toBeGreaterThan(3000);
    expect(multiDoorFaces).toBeGreaterThan(100);
    expect(doors).toBeGreaterThan(5000);
    expect(problems.slice(0, 15)).toEqual([]);
    expect(cutEdges).toBeLessThanOrEqual(MARGIN_OPENING_CUT_CEILING); // ratchet: may only fall
  }, 300000);
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
