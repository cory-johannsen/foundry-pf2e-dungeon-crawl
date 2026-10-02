// #585: a dead edge that cannot become a stub is WALLED: no door, no corridor, a solid wall over the former door span,
// and it leaves the progression graph (`edges`) like a stub does. These tests read the REAL walls a built v3 scene holds.
import { describe, it, expect } from 'vitest';
import * as deck from '../scripts/dungeon-deck.mjs';
import { computeRunLayout, planRunLayoutStubs } from '../scripts/dungeon-reseed.mjs';
import { buildSceneForLayout, installFoundryStubs } from './helpers/scene-oracle.mjs';
import { sweepShapeOfRunLayout } from './helpers/walkability-oracle.mjs';
import {
  mergeEdgeMaps, applyStubsToEdges, incomingConnectionsFor, outgoingDoorPlan, roomRect,
} from '../scripts/dungeon-layout.mjs';

installFoundryStubs();
const MODULE_ID = 'pf2e-dungeon-crawl';
const flagsOf = (w) => w.flags?.[MODULE_ID] ?? {};

describe('#585 edge-map helpers', () => {
  it('mergeEdgeMaps unions two { source: [target] } maps without duplicates and without mutating', () => {
    const a = { x: ['p'], y: ['q'] };
    const b = { x: ['r', 'p'], z: ['s'] };
    expect(mergeEdgeMaps(a, b)).toEqual({ x: ['p', 'r'], y: ['q'], z: ['s'] });
    expect(a).toEqual({ x: ['p'], y: ['q'] });
    expect(mergeEdgeMaps(undefined, undefined)).toEqual({});
  });

  it('applyStubsToEdges strips every edge of the maps it is given', () => {
    const edges = { a: ['b', 'c'], b: ['d'] };
    expect(applyStubsToEdges(edges, mergeEdgeMaps({ a: ['b'] }, { b: ['d'] }))).toEqual({ a: ['c'], b: [] });
  });

  it('a walled edge gives its target no incoming connection (excluded like a stub)', () => {
    const layoutEdges = { 'room-entry': ['r1', 'r2'], r1: ['r3'], r2: ['r3'] };
    const walled = { r1: ['r3'] };
    expect(incomingConnectionsFor(layoutEdges, 'r3', {}, mergeEdgeMaps({}, walled)).map((c) => c.sourceId)).toEqual(['r2']);
  });
});

// First `want` seeds whose shipped plan walls at least one edge.
async function walledCases(want) {
  const out = [];
  for (let i = 0; i < 400 && out.length < want; i += 1) {
    const P = computeRunLayout({ generator: deck, seed: `sweep-${i}`, roomCount: 6 + (i % 15) });
    const planned = await planRunLayoutStubs(P, { retreatAvailable: true });
    if (Object.keys(planned.layout.walledEdges ?? {}).length) out.push({ P, planned });
  }
  return out;
}

// The solid walls (not doors) that lie on the line of `span`, as 1-D intervals along it.
function solidCoverage(scene, span) {
  const horizontal = span.y1 === span.y2;
  const lo = horizontal ? Math.min(span.x1, span.x2) : Math.min(span.y1, span.y2);
  const hi = horizontal ? Math.max(span.x1, span.x2) : Math.max(span.y1, span.y2);
  const ivs = scene.walls.filter((w) => !w.door).flatMap((w) => {
    const [a, b, c, e] = w.c;
    if (horizontal && b === span.y1 && e === span.y1) return [[Math.min(a, c), Math.max(a, c)]];
    if (!horizontal && a === span.x1 && c === span.x1) return [[Math.min(b, e), Math.max(b, e)]];
    return [];
  }).sort((p, q) => p[0] - q[0]);
  let at = lo;
  for (const [s, e] of ivs) { if (s <= at) at = Math.max(at, e); }
  return at >= hi;
}

describe('#585 the scene builds a solid wall where a walled edge\'s door would be', () => {
  it('builds no door, placeholder or corridor for it, and a solid wall exactly over the former door span', async () => {
    const cases = await walledCases(25);
    expect(cases.length).toBeGreaterThan(10);
    let checked = 0;
    for (const { P, planned } of cases) {
      const L = sweepShapeOfRunLayout(planned.layout);
      const { scene } = await buildSceneForLayout(L, 3);
      for (const [src, targets] of Object.entries(planned.layout.walledEdges)) {
        for (const tgt of targets) {
          const key = `${src}->${tgt}`;
          expect(planned.layout.edges[src], key).not.toContain(tgt);
          expect(planned.layout.layoutEdges[src], key).toContain(tgt);
          expect(planned.layout.stubEdges?.[src] ?? [], key).not.toContain(tgt);
          const doorsOfEdge = scene.walls.filter((w) => w.door && flagsOf(w).dungeonDoorFromRoomId === src
            && (flagsOf(w).dungeonDoorToRoomId === tgt || flagsOf(w).dungeonRevealDoorForSlot === tgt || flagsOf(w).dungeonStubDoorFor === tgt));
          expect(doorsOfEdge, key).toHaveLength(0);
          expect(scene.walls.filter((w) => flagsOf(w).dungeonFrontierWallForEdge === key), key).toHaveLength(0);
          // The span its door would have taken: the plan WITH the edge present, minus stubs.
          const pos = P.layoutPositionByRoomId;
          const withEdge = outgoingDoorPlan(roomRect(P.seed, src, pos[src].rank, pos[src].col), pos[src], {
            realChildIds: [...(planned.layout.edges[src] ?? []), tgt],
            hiddenChildIds: (planned.layout.hiddenEdges[src] ?? []).slice(0, 1),
            stubChildIds: planned.layout.stubEdges?.[src] ?? [],
          }, pos).get(tgt);
          // Every room face that the walled edge would have used is solid where it would have opened, except where a
          // sibling door was re-slotted into it: the removed door leaves no gap of its own.
          const raw = withEdge.doorSpan ?? withEdge.slot; // grid units; walls are in pixels
          const span = { x1: raw.x1 * 100, y1: raw.y1 * 100, x2: raw.x2 * 100, y2: raw.y2 * 100 };
          const sibling = scene.walls.some((w) => w.door
            && (flagsOf(w).dungeonDoorFromRoomId === src || flagsOf(w).dungeonHiddenDoorForEdge?.startsWith(`${src}->`))
            && (span.y1 === span.y2 ? w.c[1] === span.y1 && w.c[3] === span.y1 : w.c[0] === span.x1 && w.c[2] === span.x1)
            && Math.max(Math.min(w.c[0], w.c[2]), Math.min(span.x1, span.x2)) <= Math.min(Math.max(w.c[0], w.c[2]), Math.max(span.x1, span.x2))
            && Math.max(Math.min(w.c[1], w.c[3]), Math.min(span.y1, span.y2)) <= Math.min(Math.max(w.c[1], w.c[3]), Math.max(span.y1, span.y2)));
          if (!sibling) expect(solidCoverage(scene, span), `${P.seed} ${key} span not solid`).toBe(true);
          checked += 1;
        }
      }
    }
    expect(checked).toBeGreaterThan(10);
  }, 300000);

  it('leaves no gap in any room perimeter (doors plus solid walls cover every side): nothing leaks', async () => {
    const cases = await walledCases(25);
    for (const { P, planned } of cases) {
      const L = sweepShapeOfRunLayout(planned.layout);
      const { scene } = await buildSceneForLayout(L, 3);
      for (const id of Object.keys(P.rooms)) {
        const pos = P.layoutPositionByRoomId[id];
        const r = roomRect(P.seed, id, pos.rank, pos.col);
        const sides = [
          { y1: r.gy, y2: r.gy, x1: r.gx, x2: r.gx + r.gw }, { y1: r.gy + r.gh, y2: r.gy + r.gh, x1: r.gx, x2: r.gx + r.gw },
          { x1: r.gx, x2: r.gx, y1: r.gy, y2: r.gy + r.gh }, { x1: r.gx + r.gw, x2: r.gx + r.gw, y1: r.gy, y2: r.gy + r.gh },
        ].map((sd) => ({ x1: sd.x1 * 100, x2: sd.x2 * 100, y1: sd.y1 * 100, y2: sd.y2 * 100 }));
        for (const sd of sides) {
          const horizontal = sd.y1 === sd.y2;
          const ivs = scene.walls.flatMap((w) => {
            const [a, b, c, e] = w.c;
            if (horizontal && b === sd.y1 && e === sd.y1) return [[Math.min(a, c), Math.max(a, c)]];
            if (!horizontal && a === sd.x1 && c === sd.x1) return [[Math.min(b, e), Math.max(b, e)]];
            return [];
          }).sort((p, q) => p[0] - q[0]);
          let at = horizontal ? sd.x1 : sd.y1;
          for (const [s0, e0] of ivs) { if (s0 <= at) at = Math.max(at, e0); }
          expect(at >= (horizontal ? sd.x2 : sd.y2), `${P.seed} ${id} perimeter gap`).toBe(true);
        }
      }
    }
  }, 300000);
});

describe('#585 run state and the reseed predicate', () => {
  it('deadEdgeWallsStateFor stamps the flag (and the walled map) on layoutVersion >= 3 only', async () => {
    const { deadEdgeWallsStateFor } = await import('../scripts/dungeon-reseed.mjs');
    expect(deadEdgeWallsStateFor(3, { a: ['b'] })).toEqual({ deadEdgeWalls: true, walledEdges: { a: ['b'] } });
    expect(deadEdgeWallsStateFor(3, undefined)).toEqual({ deadEdgeWalls: true });
    expect(deadEdgeWallsStateFor(2, { a: ['b'] })).toEqual({});
    expect(deadEdgeWallsStateFor(1, { a: ['b'] })).toEqual({});
  });

  it('the plan verdict is the union verdict of the WALLED layout (goal flooding the live graph after stubs and walls)', async () => {
    const { unionReports } = await import('./helpers/stub-union.mjs');
    let checked = 0;
    for (let i = 0; i < 60; i += 1) {
      const P = computeRunLayout({ generator: deck, seed: `sweep-${i}`, roomCount: 6 + (i % 15) });
      const planned = await planRunLayoutStubs(P, { retreatAvailable: true });
      const L = sweepShapeOfRunLayout(planned.layout);
      const R = unionReports(L, (await buildSceneForLayout(L, 3)).scene);
      expect(planned.verdict.goal, `sweep-${i}`).toBe(R.union.goal && !planned.lost);
      expect(planned.verdict.unreachable, `sweep-${i}`).toBe(R.union.unreachable.length);
      expect(R.union.dead.size, `sweep-${i}`).toBe(0);
      checked += 1;
    }
    expect(checked).toBe(60);
  }, 300000);
});
