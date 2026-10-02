// #427 Chunk 7 PROTOTYPE (test helper only, NOT shipped): the stub rule evaluated with the scene oracle's own
// dead-edge semantics. See "Chunk 7 rule fix" in docs/superpowers/specs/2026-10-01-boxed-in-corridor-routing-design.md.
import { findCorridorPath, outgoingDoorPlan } from '../../scripts/dungeon-layout.mjs';
import { sealedEdgeReport, corridorLineBlockers } from './scene-oracle.mjs';
import { buildStubbedSweepLayout } from './stub-sweep.mjs';

const k = (s, t) => `${s}->${t}`;

/** Flood from room-entry over `edges` (`{ src: [child] }`) skipping any edge for which `dead(src, child)` holds.
 * Retreat (#439) changes nothing here: turning back only returns to a room already reached, and every room is
 * reached over forward edges, so directed reachability IS the retreat-on reachability. */
export function flood(edges, dead) {
  const seen = new Set(['room-entry']);
  const queue = ['room-entry'];
  while (queue.length) {
    const x = queue.shift();
    for (const c of edges[x] ?? []) if (!seen.has(c) && !dead(x, c)) { seen.add(c); queue.push(c); }
  }
  return seen;
}

export function isNullEdge(L, from, to) {
  const plan = outgoingDoorPlan(L.rect[from], L.pos[from], {
    realChildIds: L.edges[from] ?? [], hiddenChildIds: (L.hiddenEdges[from] ?? []).slice(0, 1),
  }, L.pos);
  return !findCorridorPath(L.pos[from], L.pos[to], L.occ, {
    fromRoomId: from, toRoomId: to, incomingFace: L.incFace[to], exitFace: plan.get(to)?.face,
  });
}

/**
 * The three dead-edge semantics, one report per built scene of `L` (stubs, if any, are already out of `L.edges`):
 *   opt    dead = a sealed door (what `sealedEdgeReport` floods; a null-path fallback with open doors counts live)
 *   strict dead = sealed OR null-path fallback (`sceneValidity`; no fallback is assumed walkable)
 *   truth  dead = sealed OR (null-path fallback whose centre line crosses a solid wall); a fallback line that
 *          crosses no wall is genuinely walkable
 * Each is `{ goal, unreachable: [roomId] }` (hidden rooms excluded).
 */
export function oracleReports(L, scene) {
  const rep = sealedEdgeReport(L, scene);
  const sealed = new Set(rep.sealedEdges.filter((e) => !e.hidden).map((e) => k(e.from, e.to)));
  const nullE = new Set();
  const walkableNull = new Set();
  for (const [from, kids] of Object.entries(L.edges)) {
    for (const to of kids) {
      if (!isNullEdge(L, from, to)) continue;
      nullE.add(k(from, to));
      const blockers = corridorLineBlockers(scene, { from, to });
      if (blockers && !blockers.length && !sealed.has(k(from, to))) walkableNull.add(k(from, to));
    }
  }
  const verdict = (dead) => {
    const seen = flood(L.edges, dead);
    return { goal: seen.has('room-goal'), unreachable: Object.keys(L.rooms).filter((r) => !seen.has(r) && !L.hiddenRooms.includes(r)) };
  };
  return {
    sealedDoors: rep.sealedDoors,
    sealedEdges: rep.sealedEdges,
    sealed, nullE, walkableNull,
    opt: verdict((s, c) => sealed.has(k(s, c))),
    strict: verdict((s, c) => sealed.has(k(s, c)) || nullE.has(k(s, c))),
    truth: verdict((s, c) => sealed.has(k(s, c)) || (nullE.has(k(s, c)) && !walkableNull.has(k(s, c)))),
  };
}

/**
 * PROTOTYPE `planStubsOracleAware`: take the placeable plan `planStubsForLayout` produced (`L.stubPlan.stubEdges`,
 * graph rules 1-3 + geometry), then keep a stub only when, over the BASELINE scene's live graph (`isDead(src, child)`
 * from the no-stub scene, under whichever semantics the caller picks), the rooms reachable from room-entry do not
 * shrink once the kept stubs are removed. Candidates are visited in canonical order (target id, source id), one at a
 * time, so the result is deterministic. Returns `{ stubEdges }` in the run-state shape.
 */
export function planStubsOracleAware(baseLayout, placedStubEdges, isDead) {
  const base = flood(baseLayout.edges, isDead);
  const cand = Object.entries(placedStubEdges).flatMap(([s, ts]) => ts.map((t) => ({ s, t })))
    .sort((a, b) => (a.t < b.t ? -1 : a.t > b.t ? 1 : a.s < b.s ? -1 : a.s > b.s ? 1 : 0));
  const kept = new Set();
  for (const { s, t } of cand) {
    kept.add(k(s, t));
    const seen = flood(baseLayout.edges, (x, c) => isDead(x, c) || kept.has(k(x, c)));
    if ([...base].some((r) => !seen.has(r))) kept.delete(k(s, t));
  }
  const stubEdges = {};
  for (const key of kept) { const [s, t] = key.split('->'); (stubEdges[s] ??= []).push(t); }
  return { stubEdges };
}

/** Candidate-plan layout for seed `i`: `buildStubbedSweepLayout` with its stubs replaced by `stubEdges`. */
export function withStubEdges(stubbed, stubEdges) {
  const edges = Object.fromEntries(Object.entries(stubbed.baseEdges).map(([s, kids]) => [s, kids.filter((c) => !stubEdges[s]?.includes(c))]));
  return { ...stubbed, edges, stubEdges };
}

const toStubEdges = (set) => { const o = {}; for (const x of set) { const [s, t] = x.split('->'); (o[s] ??= []).push(t); } return o; };

/** Does scene report `R` lose anything the no-stub report `Rb` had, under ANY of the three semantics: the goal, or
 * a room that was reachable? */
export function regresses(Rb, R) {
  return ['opt', 'strict', 'truth'].some((s) => (Rb[s].goal && !R[s].goal)
    || R[s].unreachable.some((r) => !Rb[s].unreachable.includes(r)));
}

/**
 * PROTOTYPE `planStubsOracleAwareVerified`: `planStubsOracleAware` under the `opt` semantics (dead = sealed in the
 * baseline scene), then a scene-level guard: build the scene, and while any semantics regresses against the baseline
 * (door re-slotting can seal a different edge, which no pre-scene predicate can see) drop the first stub, in
 * canonical order, whose removal alone clears it (else the last one). `buildScene(layout)` returns the fake scene.
 * Returns `{ stubEdges, report, layout, dropped }`, `report` being the final `oracleReports`.
 */
export async function planStubsOracleAwareVerified(baseLayout, baseReport, stubbed, buildScene) {
  const dead = (s, c) => baseReport.sealed.has(k(s, c));
  const kept = new Set(Object.entries(planStubsOracleAware(baseLayout, stubbed.stubEdges, dead).stubEdges)
    .flatMap(([s, ts]) => ts.map((t) => k(s, t))));
  const evalSet = async (set) => { const L = withStubEdges(stubbed, toStubEdges(set)); return { L, R: oracleReports(L, await buildScene(L)) }; };
  let { L, R } = await evalSet(kept);
  let dropped = 0;
  while (regresses(baseReport, R) && kept.size) {
    const list = [...kept].sort();
    let pick = null;
    for (const x of list) {
      const t = new Set(kept); t.delete(x);
      const next = await evalSet(t);
      if (!regresses(baseReport, next.R)) { pick = { x, next }; break; }
    }
    if (!pick) { const x = list[list.length - 1]; const t = new Set(kept); t.delete(x); pick = { x, next: await evalSet(t) }; }
    kept.delete(pick.x); ({ L, R } = pick.next); dropped += 1;
  }
  return { stubEdges: toStubEdges(kept), report: R, layout: L, dropped };
}

export { buildStubbedSweepLayout };
