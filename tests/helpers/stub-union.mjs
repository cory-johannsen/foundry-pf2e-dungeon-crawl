// #427 Chunk 7 PROTOTYPE (test helper): the stub plan with the WALKABILITY UNION as the dead-edge definition.
// Dead edge = `truth` dead (sealed, or a null-path fallback whose centre line crosses a wall) UNION #575's per-edge
// walkability dead (sealedDoor / wallCut / tileGap / noStartTile / noEndTile / missingDoor). Candidates are the dead
// real edges (found-path cut edges included) plus the hidden null-path links.
import { buildSceneForLayout } from './scene-oracle.mjs';
import { oracleReports, flood } from './stub-oracle-aware.mjs';
import { edgeWalkability, walkableVerdict } from './walkability-oracle.mjs';
import { stubInputsFor } from './stub-sweep.mjs';
import {
  nullPathEdges, planStubs, planStubGeometries, outgoingPlanForStubs, applyStubsToEdges,
} from '../../scripts/dungeon-layout.mjs';

const k = (s, t) => `${s}->${t}`;
export const toKeys = (stubEdges) => new Set(Object.entries(stubEdges).flatMap(([s, ts]) => ts.map((t) => k(s, t))));
export const fromKeys = (set) => { const o = {}; for (const x of [...set].sort()) { const [s, t] = x.split('->'); (o[s] ??= []).push(t); } return o; };

/** `B` with `stubEdges` applied (progression graph without them). */
export const withStubs = (B, stubEdges) => ({
  ...B, baseEdges: B.baseEdges ?? B.edges, edges: applyStubsToEdges(B.baseEdges ?? B.edges, stubEdges), stubEdges,
});

/** All verdicts of a built scene: the three #490 semantics plus the walkability union. */
export function unionReports(L, scene) {
  const R = oracleReports(L, scene);
  const W = edgeWalkability(L, scene);
  const dead = new Set(W.dead);
  for (const e of R.sealed) dead.add(e);
  for (const e of R.nullE) if (!R.walkableNull.has(e)) dead.add(e);
  return { ...R, W, union: { ...walkableVerdict(L, dead), dead } };
}

export const SEMANTICS = ['opt', 'strict', 'truth', 'union'];
/** Does `R` lose the goal or any room that the no-stub report `Rb` reached, under any semantics? */
export function regressesAll(Rb, R) {
  return SEMANTICS.some((s) => (Rb[s].goal && !R[s].goal) || R[s].unreachable.some((r) => !Rb[s].unreachable.includes(r)));
}

/**
 * Plan for baseline layout `B` (no stubs) and its scene report `Rb`. Returns the stage-by-stage sets so a test can
 * attribute every refusal: `{ dead, hiddenNull, graph, live, placed, final, dropped, report, layout }`.
 */
export async function planUnion(B, bScene, Rb = unionReports(B, bScene), { retreatAvailable = true } = {}) {
  const inputs = stubInputsFor(B);
  const planFor0 = (src) => outgoingPlanForStubs(B.seed, src, { edges: B.edges, hiddenEdges: B.hiddenEdges, stubEdges: {}, positionByRoomId: B.pos });
  const nulls = nullPathEdges({
    positionByRoomId: B.pos, occupiedCells: B.occ, layoutEdges: B.layoutEdges, hiddenRooms: B.hiddenRooms,
    hiddenIncomingByRoomId: B.hiddenIncomingByRoomId, incomingFaceByRoomId: B.incFace, planFor: planFor0,
  });
  const dead = Rb.union.dead;
  const cands = [...nulls.filter((e) => e.hidden), ...[...dead].map((x) => { const [sourceId, toId] = x.split('->'); return { sourceId, toId, hidden: false }; })];
  const graph = toKeys(planStubs({
    rooms: B.rooms, edges: B.edges, layoutEdges: B.layoutEdges, hiddenEdges: B.hiddenEdges,
    hiddenIncomingByRoomId: B.hiddenIncomingByRoomId, nullEdges: cands, retreatAvailable, positionByRoomId: B.pos,
  }).stubEdges);
  // Rule 3': reachable set over the baseline's live edges must not shrink (canonical order, one at a time).
  const baseReach = flood(B.edges, (s, c) => dead.has(k(s, c)));
  const kept = new Set();
  const order = [...graph].sort((a, b) => { const [as, at] = a.split('->'); const [bs, bt] = b.split('->'); return at < bt ? -1 : at > bt ? 1 : as < bs ? -1 : as > bs ? 1 : 0; });
  const hiddenKeys = new Set(nulls.filter((e) => e.hidden).map((e) => k(e.sourceId, e.toId)));
  for (const x of order) {
    if (hiddenKeys.has(x)) { kept.add(x); continue; }
    kept.add(x);
    const seen = flood(B.edges, (s, c) => dead.has(k(s, c)) || kept.has(k(s, c)));
    if ([...baseReach].some((r) => !seen.has(r))) kept.delete(x);
  }
  const live = new Set(kept);
  // Geometry: drop an infeasible stub (canonical order) until every stored stub places.
  const placedSet = new Set(kept);
  for (;;) {
    const se = fromKeys(placedSet);
    if (!Object.keys(se).length) break;
    const placed = planStubGeometries({
      seed: B.seed, positionByRoomId: B.pos, occupiedCells: B.occ, edges: B.edges, layoutEdges: B.layoutEdges, hiddenEdges: B.hiddenEdges,
      hiddenRooms: B.hiddenRooms, hiddenIncomingByRoomId: B.hiddenIncomingByRoomId, incomingFaceByRoomId: B.incFace, stubEdges: se,
    });
    if (!placed.infeasible.length) break;
    placedSet.delete([...placed.infeasible].sort()[0]);
  }
  const placed = new Set(placedSet);
  // Verify against the baseline under all semantics; drop the first stub whose removal alone clears it, else the last.
  const evalSet = async (set) => { const L = withStubs(B, fromKeys(set)); return { L, R: unionReports(L, (await buildSceneForLayout(L, 3)).scene) }; };
  let cur = await evalSet(placedSet);
  let dropped = 0;
  const verifyDropped = [];
  while (regressesAll(Rb, cur.R) && placedSet.size) {
    const list = [...placedSet].sort();
    let pick = null;
    for (const x of list) {
      const t = new Set(placedSet); t.delete(x);
      const next = await evalSet(t);
      if (!regressesAll(Rb, next.R)) { pick = { x, next }; break; }
    }
    if (!pick) { const x = list[list.length - 1]; const t = new Set(placedSet); t.delete(x); pick = { x, next: await evalSet(t) }; }
    placedSet.delete(pick.x); verifyDropped.push(pick.x); cur = pick.next; dropped += 1;
  }
  return { dead, hiddenNull: hiddenKeys, graph, live, placed, final: placedSet, dropped, verifyDropped, report: cur.R, layout: cur.L };
}
