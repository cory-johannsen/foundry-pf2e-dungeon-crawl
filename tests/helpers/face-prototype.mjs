// #603 PROTOTYPE (test helper): path-aware incoming faces under the shipped pipeline (router + stubs + walls + reseed).
// #427's spec measured "pick north/west per room by fewer null edges" as net negative BEFORE the topology router existed;
// this re-measures it with the router in place. Faces are replaced on the stub-free layout, nothing else changes.
//   node tests/helpers/face-prototype.mjs [seeds] [mode: none|pathaware]
import * as deck from '../../scripts/dungeon-deck.mjs';
import {
  computeRunLayout, planRunLayoutStubs, selectSeed, RESEED_MAX_TRIES,
} from '../../scripts/dungeon-reseed.mjs';
import { findCorridorPath, outgoingDoorPlan, roomRect } from '../../scripts/dungeon-layout.mjs';
import { installFoundryStubs, buildSceneForLayout } from './scene-oracle.mjs';
import { sweepShapeOfRunLayout } from './walkability-oracle.mjs';
import { unionReports } from './stub-union.mjs';
import { graphMetrics } from './candidate-scores.mjs';
import { roomCountOf } from './chosen-seeds.mjs';
import { computeRunLayoutWith, computeColumnsMergeEast } from './column-prototype.mjs';

installFoundryStubs();
const count = (m) => Object.values(m ?? {}).reduce((n, k) => n + k.length, 0);

/** Per room: the face (north/west) with fewer null-path incoming edges (real + hidden sources); ties keep today's face. */
export function pathAwareFaces(P) {
  const pos = P.layoutPositionByRoomId;
  const planFor = (src) => outgoingDoorPlan(roomRect(P.seed, src, pos[src].rank, pos[src].col), pos[src], {
    realChildIds: P.edges[src] ?? [], hiddenChildIds: (P.hiddenEdges[src] ?? []).slice(0, 1),
  }, pos);
  const incoming = {};
  for (const [s, kids] of Object.entries(P.edges)) for (const t of kids) (incoming[t] ??= []).push(s);
  const faces = { ...P.incomingFaceByRoomId };
  for (const [to, sources] of Object.entries(incoming)) {
    const nulls = (face) => sources.filter((s) => !findCorridorPath(pos[s], pos[to], P.occupiedCells, {
      fromRoomId: s, toRoomId: to, incomingFace: face, exitFace: planFor(s).get(to)?.face,
    })).length;
    const cur = faces[to];
    const other = cur === 'north' ? 'west' : 'north';
    const occupant = (r, c) => P.occupiedCells[`${r},${c}`];
    const gateFree = other === 'north' ? occupant(pos[to].rank - 1, pos[to].col) == null || sources.includes(occupant(pos[to].rank - 1, pos[to].col))
      : occupant(pos[to].rank, pos[to].col - 1) == null || sources.includes(occupant(pos[to].rank, pos[to].col - 1));
    if (!gateFree) continue;
    if (nulls(other) < nulls(cur)) faces[to] = other;
  }
  return faces;
}

export const buildCandidate = (mode) => (seed, i) => {
  if (mode === 'mergeeast') {
    return computeRunLayoutWith({ generator: deck, seed, roomCount: roomCountOf(i), columnsFn: computeColumnsMergeEast, topologyRouting: true });
  }
  const P = computeRunLayout({ generator: deck, seed, roomCount: roomCountOf(i), topologyRouting: true });
  return mode === 'pathaware' ? { ...P, incomingFaceByRoomId: pathAwareFaces(P) } : P;
};

if (import.meta.url === `file://${process.argv[1]}`) {
  const n = Number(process.argv[2] ?? 100);
  const mode = process.argv[3] ?? 'none';
  const build = buildCandidate(mode);
  const tot = { baseDead: 0, realEdges: 0, stubs: 0, walls: 0, branching: 0, unr: 0, exits: 0, reached: 0, tries: 0, goalFail: 0, ms: 0, westRooms: 0 };
  for (let i = 0; i < n; i += 1) {
    const t0 = performance.now();
    const layouts = new Map();
    const r = await selectSeed({
      seed: `sweep-${i}`, maxTries: RESEED_MAX_TRIES,
      evaluate: async (s) => { const p = await planRunLayoutStubs(build(s, i)); layouts.set(s, p.layout); return p.verdict; },
    });
    tot.ms += performance.now() - t0;
    const final = layouts.get(r.seed);
    const m = graphMetrics(final);
    const base = sweepShapeOfRunLayout(build(r.seed, i));
    const Rb = unionReports(base, (await buildSceneForLayout(base, 3)).scene);
    tot.baseDead += Rb.union.dead.size; tot.realEdges += count(base.edges);
    tot.stubs += count(final.stubEdges); tot.walls += count(final.walledEdges);
    tot.branching += m.branching; tot.unr += m.unreachable; tot.exits += m.exits; tot.reached += m.reached;
    tot.tries += r.reseedTries; tot.goalFail += r.goalReachable ? 0 : 1;
    tot.westRooms += Object.values(final.incomingFaceByRoomId).filter((f) => f === 'west').length;
  }
  console.log(mode, n, JSON.stringify({ ...tot, ms: Math.round(tot.ms / n) }));
}
