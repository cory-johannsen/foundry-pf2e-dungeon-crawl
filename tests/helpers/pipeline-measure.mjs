// tests/helpers/pipeline-measure.mjs
// #427: the whole v3 run pipeline (reseed over router -> stubs -> walls) measured with the TEST-SIDE oracles, with and
// without the topology router, on the same seeds. Used by tests/dungeon-router-pipeline-sweep.test.mjs and by hand:
//   node tests/helpers/pipeline-measure.mjs [seeds] [routing 0|1]
import * as deck from '../../scripts/dungeon-deck.mjs';
import { chooseRunLayout, computeRunLayout } from '../../scripts/dungeon-reseed.mjs';
import { routingForLayout } from '../../scripts/dungeon-layout.mjs';
import { buildSceneForLayout, installFoundryStubs, sealedEdgeReport } from './scene-oracle.mjs';
import { doorCorridorMismatches } from './door-corridor-oracle.mjs';

installFoundryStubs();
import { sweepShapeOfRunLayout } from './walkability-oracle.mjs';
import { unionReports } from './stub-union.mjs';

const roomCountOf = (i) => 6 + (i % 15);
const count = (map) => Object.values(map ?? {}).reduce((n, kids) => n + kids.length, 0);

function flood(L, dead) {
  const seen = new Set(['room-entry']);
  const q = ['room-entry'];
  while (q.length) {
    const x = q.shift();
    for (const c of L.edges[x] ?? []) if (!seen.has(c) && !dead.has(`${x}->${c}`)) { seen.add(c); q.push(c); }
  }
  return seen;
}

/** The pipeline for sweep seed `i`; returns the per-dungeon record. */
export async function measureSeed(i, { topologyRouting, maxTries }) {
  const seed = `sweep-${i}`;
  const roomCount = roomCountOf(i);
  const t0 = performance.now();
  const chosen = await chooseRunLayout({ generator: deck, seed, roomCount, topologyRouting, ...(maxTries !== undefined ? { maxTries } : {}) });
  const ms = performance.now() - t0;
  const final = sweepShapeOfRunLayout(chosen.layout);
  const finalScene = (await buildSceneForLayout(final, 3)).scene;
  const R = unionReports(final, finalScene);
  // The stub-free layout of the chosen seed: its dead edges are what the stub/wall planner had to deal with.
  const P = computeRunLayout({ generator: deck, seed: chosen.seed, roomCount, topologyRouting });
  const base = sweepShapeOfRunLayout(P);
  const Rb = unionReports(base, (await buildSceneForLayout(base, 3)).scene);
  const baseReach = flood(base, Rb.union.dead);
  const rows = {
    realEdges: Object.values(P.edges).reduce((n, k) => n + k.length, 0),
    baseDead: Rb.union.dead.size,
    baseFoundDead: [...Rb.W.edges.values()].filter((e) => !e.walkable && !e.nullPath).length,
    baseDeadReachable: [...Rb.union.dead].some((k) => baseReach.has(k.split('->')[0])) ? 1 : 0,
  };
  const causes = {};
  for (const e of Rb.W.edges.values()) if (!e.walkable) causes[e.cause] = (causes[e.cause] ?? 0) + 1;
  let routerStats = null;
  if (topologyRouting) {
    const occ = P.occupiedCells;
    const rf = routingForLayout({
      seed: P.seed, positionByRoomId: P.layoutPositionByRoomId, occupiedCells: occ, incomingFaceByRoomId: P.incomingFaceByRoomId,
      layoutEdges: P.layoutEdges, hiddenIncomingByRoomId: P.hiddenIncomingByRoomId, hiddenRooms: P.hiddenRooms, edges: P.edges,
      hiddenEdges: P.hiddenEdges,
    });
    routerStats = { ...rf.stats, unresolvableIds: rf.unresolvable.length };
  }
  // Final-pipeline metrics.
  const reach = flood(final, R.union.dead);
  let liveExits = 0;
  let nonGoalReach = 0;
  for (const id of reach) {
    if (id === 'room-goal') continue;
    nonGoalReach += 1;
    liveExits += (final.edges[id] ?? []).filter((c) => !R.union.dead.has(`${id}->${c}`)).length;
  }
  const branching = [...reach].filter((id) => id !== 'room-goal' && (final.edges[id] ?? []).filter((c) => !R.union.dead.has(`${id}->${c}`)).length >= 2).length;
  // K6/K8 on the product layout: no sealed progression door, every door's corridor present, and no live edge the router
  // could not place (it would be drawn as a fallback line through rooms).
  const sealedProgression = sealedEdgeReport(final, finalScene).sealedEdges.filter((e) => !e.hidden).length;
  const doorMismatch = doorCorridorMismatches(final, finalScene).filter((m) => !m.hidden).length;
  let liveUnresolvable = 0;
  if (topologyRouting) {
    const rf = routingForLayout({
      seed: chosen.layout.seed, positionByRoomId: chosen.layout.layoutPositionByRoomId, occupiedCells: chosen.layout.occupiedCells,
      incomingFaceByRoomId: chosen.layout.incomingFaceByRoomId, layoutEdges: chosen.layout.layoutEdges,
      hiddenIncomingByRoomId: chosen.layout.hiddenIncomingByRoomId, hiddenRooms: chosen.layout.hiddenRooms,
      edges: chosen.layout.edges, hiddenEdges: chosen.layout.hiddenEdges, stubEdges: chosen.layout.stubEdges ?? {},
      walledEdges: chosen.layout.walledEdges ?? {},
    });
    liveUnresolvable = rf.unresolvable.length;
  }
  const deadEnds = [...reach].filter((id) => id !== 'room-goal' && (final.edges[id] ?? []).filter((c) => !R.union.dead.has(`${id}->${c}`)).length === 0).length;
  const nonHidden = Object.keys(final.rooms).filter((r) => !final.hiddenRooms.includes(r));
  return {
    i, ms, rows, causes, routerStats, tries: chosen.reseedTries, goalReachable: chosen.goalReachable,
    stubs: count(chosen.layout.stubEdges), walls: count(chosen.layout.walledEdges), deadLeft: R.union.dead.size,
    goal: R.union.goal ? 1 : 0, sealedProgression, doorMismatch, liveUnresolvable, deadEnds, reachableRooms: reach.size, liveExits, nonGoalReach, branching, rooms: nonHidden.length,
    unreachableNonGoal: R.union.unreachable.filter((r) => r !== 'room-goal').length,
  };
}

const sum = (xs, f) => xs.reduce((n, x) => n + f(x), 0);

export function summarize(rec) {
  const n = rec.length;
  const ms = rec.map((r) => r.ms).sort((a, b) => a - b);
  const s = (f) => sum(rec, f);
  const out = {
    dungeons: n,
    realEdges: s((r) => r.rows.realEdges), baseDead: s((r) => r.rows.baseDead), baseFoundDead: s((r) => r.rows.baseFoundDead),
    dungeonsWithReachableDeadEdge: s((r) => r.rows.baseDeadReachable),
    stubs: s((r) => r.stubs), walls: s((r) => r.walls), stubsPerDungeon: +(s((r) => r.stubs) / n).toFixed(3), wallsPerDungeon: +(s((r) => r.walls) / n).toFixed(3),
    deadLeft: s((r) => r.deadLeft), goalReachable: s((r) => r.goal), sealedProgression: s((r) => r.sealedProgression),
    doorMismatch: s((r) => r.doorMismatch), liveUnresolvable: s((r) => r.liveUnresolvable), deadEndRooms: s((r) => r.deadEnds),
    reachableRooms: s((r) => r.reachableRooms),
    meanLiveExitsPerReachableRoom: +(s((r) => r.liveExits) / s((r) => r.nonGoalReach)).toFixed(4),
    roomsWith2PlusLiveExits: s((r) => r.branching), dungeonsWith2Plus: rec.filter((r) => r.branching > 0).length,
    unreachableNonGoalRooms: s((r) => r.unreachableNonGoal), rooms: s((r) => r.rooms),
    reseedTriesTotal: s((r) => r.tries), reseedFirstTry: rec.filter((r) => r.tries === 0).length, reseedMaxTries: Math.max(...rec.map((r) => r.tries)),
    reseedExhausted: rec.filter((r) => r.goalReachable === false).length,
    msMean: +(s((r) => r.ms) / n).toFixed(1), msP95: +ms[Math.floor(n * 0.95)].toFixed(1), msMax: +ms.at(-1).toFixed(1),
  };
  const causes = {};
  for (const r of rec) for (const [k, v] of Object.entries(r.causes)) causes[k] = (causes[k] ?? 0) + v;
  out.baseCauses = causes;
  if (rec[0].routerStats) {
    const keys = Object.keys(rec[0].routerStats);
    out.router = Object.fromEntries(keys.map((k) => [k, s((r) => r.routerStats[k])]));
  }
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const seeds = Number(process.argv[2] ?? 500);
  const routing = process.argv[3] === '1';
  const from = Number(process.argv[4] ?? 0);
  const rec = [];
  for (let i = from; i < from + seeds; i += 1) rec.push(await measureSeed(i, { topologyRouting: routing }));
  console.log(JSON.stringify({ routing, ...summarize(rec) }, null, 1));
  const slow = [...rec].sort((a, b) => b.ms - a.ms).slice(0, 5).map((r) => `${r.i}:${Math.round(r.ms)}ms`);
  console.log('slowest', slow.join(' '));
}
