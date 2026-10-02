// #490/#427 PROTOTYPE (test helper only, NOT shipped): goal-only reject-and-reseed. Predicate G = the goal is reachable
// from room-entry over edges the `truth` oracle (sealed OR null-path fallback crossing a wall = dead) leaves live.
// Candidate k of base i is seed `sweep-${i}~r${k}` (k = 0 is the base seed itself).
import { performance } from 'node:perf_hooks';
import { buildSceneForLayout } from './scene-oracle.mjs';
import { buildSweepLayout } from './layout-sweep.mjs';
import { oracleReports, planStubsOracleAwareVerified, buildStubbedSweepLayout, flood } from './stub-oracle-aware.mjs';

export const candidateSeed = (i, k) => (k === 0 ? undefined : `sweep-${i}~r${k}`);
const build = async (L) => (await buildSceneForLayout(L, 3)).scene;

/** Layout facts the skew table needs. */
export function stats(L) {
  const ids = Object.keys(L.rooms);
  const kinds = {};
  for (const id of ids) kinds[L.rooms[id].kind] = (kinds[L.rooms[id].kind] ?? 0) + 1;
  return {
    rooms: ids.length, hidden: L.hiddenRooms.length, merge: ids.filter((r) => /^room-merge-/.test(r)).length,
    stubs: Object.values(L.stubEdges ?? {}).flat().length, goalRank: L.pos['room-goal'].rank,
    sumRank: ids.reduce((a, r) => a + L.pos[r].rank, 0), kinds,
  };
}

/** Residual picture of one built layout under `truth`: unreachable non-goal rooms (with kinds), sole-incoming dead
 * edges, sealed doors, and rooms reachable only because a fallback line crosses no wall. */
export function residual(L, R) {
  const dead = (s, c) => R.sealed.has(`${s}->${c}`) || (R.nullE.has(`${s}->${c}`) && !R.walkableNull.has(`${s}->${c}`));
  const incoming = {};
  for (const kids of Object.values(L.edges)) for (const c of kids) incoming[c] = (incoming[c] ?? 0) + 1;
  let soleDead = 0;
  for (const [s, kids] of Object.entries(L.edges)) for (const c of kids) if (dead(s, c) && incoming[c] === 1) soleDead += 1;
  const unreachNonGoal = R.truth.unreachable.filter((r) => r !== 'room-goal');
  const strictSeen = flood(L.edges, (s, c) => R.sealed.has(`${s}->${c}`) || R.nullE.has(`${s}->${c}`));
  const truthSeen = flood(L.edges, dead);
  const fallbackOnly = [...truthSeen].filter((r) => !strictSeen.has(r) && r !== 'room-entry');
  return {
    unreachNonGoal: unreachNonGoal.map((r) => L.rooms[r].kind), soleDead, sealedDoors: R.sealedDoors,
    fallbackOnly: fallbackOnly.map((r) => L.rooms[r].kind),
  };
}

/** Evaluate candidate (i, k): plain layout + stub-verified layout, with timings. */
export async function evalCandidate(i, k) {
  const seed = candidateSeed(i, k);
  const t0 = performance.now();
  const B = buildSweepLayout(i, { layoutVersion: 3, seed });
  const bScene = await build(B);
  const Rb = oracleReports(B, bScene);
  const t1 = performance.now();
  const S = buildStubbedSweepLayout(i, { retreatAvailable: true, seed });
  const v = await planStubsOracleAwareVerified(B, Rb, S, build);
  const t2 = performance.now();
  return {
    gPlain: Rb.truth.goal, gStub: v.report.truth.goal, plainMs: t1 - t0, stubMs: t2 - t1,
    plain: { stats: stats(B), res: residual(B, Rb) }, stubbed: { stats: stats(v.layout), res: residual(v.layout, v.report) },
  };
}

/** Per base, the candidates k = 0..K evaluated lazily: stop at the first k where BOTH predicates (`gPlain`, `gStub`)
 * have already been satisfied by some candidate, so a base costs about as many candidates as the slower policy needs.
 * `list[k]` is then enough to answer any N <= list.length - 1 for either policy. */
export async function goalReseedSweep(bases, maxN) {
  const out = [];
  for (let i = 0; i < bases; i += 1) {
    const list = [];
    let plainDone = false; let stubDone = false;
    for (let k = 0; k <= maxN && !(plainDone && stubDone); k += 1) {
      const c = await evalCandidate(i, k);
      list.push(c); plainDone ||= c.gPlain; stubDone ||= c.gStub;
    }
    out.push(list);
  }
  return out;
}

/** First candidate within N reseeds whose `key` predicate holds (else the last, k = N, which ends invalid). */
export function pickCandidate(list, N, key) {
  for (let k = 0; k <= N; k += 1) if (list[k][key]) return { c: list[k], used: k + 1, ok: true };
  return { c: list[Math.min(N, list.length - 1)], used: Math.min(N, list.length - 1) + 1, ok: false };
}

const mean = (a) => a.reduce((x, y) => x + y, 0) / (a.length || 1);
/** Summary of the accepted-vs-base picture for policy `key` at N reseeds (stats are of the stub-planned layout). */
export function summarize(sweep, N, key) {
  const P = sweep.map((l) => pickCandidate(l, N, key));
  const st = P.map((p) => p.c.stubbed);
  const kinds = {}; let rooms = 0;
  for (const s of st) for (const [k, v] of Object.entries(s.stats.kinds)) { kinds[k] = (kinds[k] ?? 0) + v; rooms += v; }
  return {
    n: sweep.length, valid: P.filter((p) => p.ok).length, gStub: P.filter((p) => p.c.gStub).length,
    expectedCandidates: mean(P.map((p) => p.used)), worst: Math.max(...P.map((p) => p.used)),
    detourDungeons: st.filter((s) => s.stats.hidden > 0).length, hiddenMean: mean(st.map((s) => s.stats.hidden)),
    mergeMean: mean(st.map((s) => s.stats.merge)), stubsMean: mean(st.map((s) => s.stats.stubs)),
    roomsMean: mean(st.map((s) => s.stats.rooms)), goalRankMean: mean(st.map((s) => s.stats.goalRank)),
    meanRank: mean(st.map((s) => s.stats.sumRank / s.stats.rooms)),
    kindShare: Object.fromEntries(Object.entries(kinds).map(([k, v]) => [k, +(100 * v / rooms).toFixed(1)])),
    unreachDungeons: st.filter((s) => s.res.unreachNonGoal.length).length,
    unreachRooms: st.reduce((a, s) => a + s.res.unreachNonGoal.length, 0),
    unreachKinds: st.flatMap((s) => s.res.unreachNonGoal).reduce((o, k) => ({ ...o, [k]: (o[k] ?? 0) + 1 }), {}),
    soleDeadEdges: st.reduce((a, s) => a + s.res.soleDead, 0), soleDeadDungeons: st.filter((s) => s.res.soleDead).length,
    sealedDoors: st.reduce((a, s) => a + s.res.sealedDoors, 0),
    fallbackOnlyRooms: st.reduce((a, s) => a + s.res.fallbackOnly.length, 0),
    fallbackOnlyKinds: st.flatMap((s) => s.res.fallbackOnly).reduce((o, k) => ({ ...o, [k]: (o[k] ?? 0) + 1 }), {}),
  };
}
