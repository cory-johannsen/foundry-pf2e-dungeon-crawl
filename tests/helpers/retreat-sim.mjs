// tests/helpers/retreat-sim.mjs
// #439 test-only. Stub set = the same greedy the spec's measurement used (canonical order,
// rules 1 and 3 only); #427 Chunk 6/7 replaces it with planStubs when that lands.
import { forEachEdge, planSelector } from './layout-sweep.mjs';
import { findCorridorPath } from '../../scripts/dungeon-layout.mjs';
import {
  canRetreat, openChildren, withEntry, withRetreat, withStubOpened,
} from '../../scripts/dungeon-retreat.mjs';

export function layoutsWithNullEdges(seedCount) {
  const layouts = [];
  forEachEdge(seedCount, planSelector, ({ layout, sourceId, toId, hidden }) => {
    if (hidden) return;
    const path = findCorridorPath(layout.pos[sourceId], layout.pos[toId], layout.occ,
      { fromRoomId: sourceId, toRoomId: toId, incomingFace: layout.incFace[toId], exitFace: undefined });
    (layout.nullEdgeList ??= []).push({ sourceId, toId, isNull: !path });
    if (layouts[layouts.length - 1] !== layout) layouts.push(layout);
  }, {});
  return layouts;
}

function reachable(edges, stubs) {
  const seen = new Set(['room-entry']); const queue = ['room-entry'];
  while (queue.length) {
    const x = queue.shift();
    for (const c of edges[x] ?? []) {
      if (stubs.has(`${x}>${c}`) || seen.has(c)) continue;
      seen.add(c); queue.push(c);
    }
  }
  return seen;
}

/** Greedy stub set in canonical order (target id, source id). Rule 1: the target keeps a routable
 * non-stub parent. Rule 3: every non-hidden room and the goal stay reachable over non-stub edges.
 * `allowSole` (retreat) drops rule 2. */
export function pickStubs(layout, { allowSole }) {
  const rooms = Object.keys(layout.rooms);
  const goal = rooms.find((r) => layout.rooms[r].isGoal);
  const all = layout.nullEdgeList ?? [];
  const nulls = all.filter((e) => e.isNull).sort((a, b) =>
    (a.toId < b.toId ? -1 : a.toId > b.toId ? 1 : a.sourceId < b.sourceId ? -1 : 1));
  const stubs = new Set();
  for (const e of nulls) {
    const k = `${e.sourceId}>${e.toId}`;
    const keeps = all.some((x) => x.toId === e.toId && x.sourceId !== e.sourceId && !x.isNull && !stubs.has(`${x.sourceId}>${x.toId}`));
    if (!keeps) continue;
    const others = (layout.edges[e.sourceId] ?? []).filter((c) => c !== e.toId && !stubs.has(`${e.sourceId}>${c}`));
    if (!allowSole && others.length === 0) continue;
    stubs.add(k);
    const seen = reachable(layout.edges, stubs);
    if (!seen.has(goal) || rooms.some((x) => !seen.has(x) && !layout.hiddenRooms.includes(x))) stubs.delete(k);
  }
  return stubs;
}

/** Run state for a layout and stub set, as the runner would hold it right after entering room-entry. */
export function initialState(layout, stubs) {
  const edges = {}; const stubEdges = {};
  for (const [src, kids] of Object.entries(layout.edges)) {
    edges[src] = kids.filter((c) => !stubs.has(`${src}>${c}`));
    const st = kids.filter((c) => stubs.has(`${src}>${c}`));
    if (st.length) stubEdges[src] = st;
  }
  return {
    rooms: layout.rooms, edges, stubEdges, history: [], currentRoomId: 'room-entry',
    retreatVersion: 1, retreatPath: ['room-entry'], stubsOpened: {}, retreats: [], completed: false,
  };
}

/** One walk. `policy`: 'sensible' (new doors and unopened stubs, uniformly), 'careless' (also revisits),
 * 'adversarial' (unopened stubs first, then the child whose closure contains the most stub sources). Calls
 * `check(state)` at EVERY step. Returns { done, steps, retreats }. */
export function walk(layout, stubs, policy, rnd, check) {
  let state = initialState(layout, stubs);
  const judge = (s, id) => ({ ...s, history: [...s.history, { roomId: id }], completed: layout.rooms[id].isGoal || s.completed });
  state = judge(state, 'room-entry');
  const stubOnly = new Set(Object.entries(initialState(layout, stubs).stubEdges)
    .filter(([src]) => (initialState(layout, stubs).edges[src] ?? []).length === 0).map(([src]) => src));
  let steps = 0; let retreats = 0;
  while (steps++ < 5000) {
    check(state);
    if (state.completed) return { done: true, steps, retreats };
    const cur = state.currentRoomId;
    const unopenedStubs = (state.stubEdges[cur] ?? []).filter((t) => !state.stubsOpened[`${cur}->${t}`]);
    const fresh = openChildren(state, cur);
    const revisits = policy === 'careless' ? (state.edges[cur] ?? []).filter((c) => !fresh.includes(c)) : [];
    const options = [...unopenedStubs.map((t) => ({ stub: t })), ...fresh.map((c) => ({ go: c })), ...revisits.map((c) => ({ go: c }))];
    if (options.length) {
      let pick;
      if (policy === 'adversarial') {
        pick = options.find((o) => o.stub) ?? options.find((o) => o.go && stubOnly.has(o.go)) ?? options[options.length - 1];
      } else {
        pick = options[Math.floor(rnd() * options.length)];
      }
      if (pick.stub) state = withStubOpened(state, cur, pick.stub);
      else {
        const spent = state.history.some((h) => h.roomId === pick.go);
        state = { ...withEntry(state, pick.go), currentRoomId: pick.go };
        if (!spent) state = judge(state, pick.go);
      }
      continue;
    }
    const verdict = canRetreat(state);
    if (!verdict.ok) throw new Error(`stuck at ${cur} (${verdict.reason}) in ${layout.seed}`);
    const before = state.retreatPath.length;
    state = withRetreat(state, steps);
    if (state.retreatPath.length >= before) throw new Error('retreat did not shorten the path');
    retreats += 1;
  }
  throw new Error(`walk did not finish in ${layout.seed}`);
}

export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
