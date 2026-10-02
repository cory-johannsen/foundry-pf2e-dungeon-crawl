// #603 PROTOTYPE/measurement: score every reseed candidate `seed~r0..rK-1` of the sweep seeds through the shipped stub/wall
// planner (planRunLayoutStubs), so best-of-K selection policies can be compared offline.
//   node tests/helpers/candidate-scores.mjs <out.json> [seeds] [K] [from]
import fs from 'node:fs';
import * as deck from '../../scripts/dungeon-deck.mjs';
import { computeRunLayout, planRunLayoutStubs, candidateSeed } from '../../scripts/dungeon-reseed.mjs';
import { installFoundryStubs } from './scene-oracle.mjs';
import { roomCountOf } from './chosen-seeds.mjs';

installFoundryStubs();
const count = (m) => Object.values(m ?? {}).reduce((n, k) => n + k.length, 0);

/** Graph-only branching of a final run layout: reachable (from room-entry over live `edges`) rooms with 2+ live exits. */
export function graphMetrics(layout) {
  const seen = new Set(['room-entry']);
  const q = ['room-entry'];
  while (q.length) { const x = q.shift(); for (const c of layout.edges[x] ?? []) if (!seen.has(c)) { seen.add(c); q.push(c); } }
  let branching = 0; let exits = 0;
  for (const id of seen) { const n = (layout.edges[id] ?? []).length; exits += n; if (n >= 2 && id !== 'room-goal') branching += 1; }
  const nonHidden = Object.keys(layout.rooms).filter((r) => !layout.hiddenRooms.includes(r));
  return { branching, exits, reached: seen.size, unreachable: nonHidden.filter((r) => !seen.has(r)).length };
}

export async function scoreCandidate(i, k, { topologyRouting = true } = {}) {
  const seed = candidateSeed(`sweep-${i}`, k);
  const t0 = performance.now();
  const base = computeRunLayout({ generator: deck, seed, roomCount: roomCountOf(i), topologyRouting });
  const p = await planRunLayoutStubs(base);
  const ms = performance.now() - t0;
  return { k, seed, goal: p.verdict.goal, unr: p.verdict.unreachable, stubs: count(p.layout.stubEdges), walls: count(p.layout.walledEdges), ms, ...graphMetrics(p.layout), edgesTotal: count(base.edges) };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const out = process.argv[2];
  const n = Number(process.argv[3] ?? 500);
  const K = Number(process.argv[4] ?? 20);
  const from = Number(process.argv[5] ?? 0);
  const rec = {};
  for (let i = from; i < from + n; i += 1) {
    rec[i] = [];
    for (let k = 0; k < K; k += 1) rec[i].push(await scoreCandidate(i, k));
  }
  fs.writeFileSync(out, JSON.stringify(rec));
}
