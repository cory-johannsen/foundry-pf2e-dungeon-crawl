// #427 Chunk 7 x #439: the retreat soft-lock property against the REAL stub plan (planRunLayoutStubs), not the
// greedy stand-in of tests/dungeon-retreat-softlock.test.mjs. The `pickStubs` seam of the retreat simulation is
// replaced by the shipped plan's stub set; 500 seeds, 3 walk policies.
// #585: the layouts are the shipped, reseeded ones (`chooseRunLayout`) and carry the dead-edge walls too: a walled edge
// is in neither `edges` nor `stubEdges`, so a room whose children were all walled has no forward move and no stub, and
// must still offer Turn back (it is a dead end like any other).
import { describe, it, expect } from 'vitest';
import * as deck from '../scripts/dungeon-deck.mjs';
import { chooseRunLayout } from '../scripts/dungeon-reseed.mjs';
import { canRetreat, openChildren } from '../scripts/dungeon-retreat.mjs';
import { walk, mulberry32, initialState } from './helpers/retreat-sim.mjs';
import { installFoundryStubs } from './helpers/scene-oracle.mjs';

installFoundryStubs();
const SEEDS = 500;
const cases = [];
for (let i = 0; i < SEEDS; i += 1) {
  const chosen = await chooseRunLayout({ generator: deck, seed: `sweep-${i}`, roomCount: 6 + (i % 15) });
  const L = chosen.layout;
  const flat = (m) => Object.entries(m ?? {}).flatMap(([s, ts]) => ts.map((t) => `${s}>${t}`));
  const stubs = new Set(flat(L.stubEdges));
  const walled = new Set(flat(L.walledEdges));
  // The stub-free, wall-free graph: the live edges plus every stub and walled edge.
  const all = {};
  for (const [s, kids] of Object.entries(L.edges)) all[s] = [...kids, ...(L.stubEdges?.[s] ?? []), ...(L.walledEdges?.[s] ?? [])];
  cases.push({ layout: { seed: L.seed, rooms: L.rooms, edges: all, hiddenRooms: L.hiddenRooms }, stubs, walled, goalReachable: chosen.goalReachable });
}

describe('#439 retreat soft-lock property against the real stub plan (500 seeds)', () => {
  it('has real sole-child stubs (guards the seam)', () => {
    const sole = cases.reduce((n, { layout, stubs, walled }) => n + Object.entries(initialState(layout, stubs, walled).edges)
      .filter(([s, kids]) => kids.length === 0 && (layout.edges[s] ?? []).length > 0).length, 0);
    expect(sole).toBeGreaterThan(1000);
  });

  it('has walled dead ends: rooms with no forward edge and no stub (guards the #585 seam)', () => {
    const pure = cases.reduce((n, { layout, stubs, walled }) => {
      const st = initialState(layout, stubs, walled);
      return n + Object.keys(layout.rooms).filter((r) => !layout.rooms[r].isGoal && (layout.edges[r] ?? []).length > 0
        && (st.edges[r] ?? []).length === 0 && (st.stubEdges[r] ?? []).length === 0).length;
    }, 0);
    expect(pure).toBeGreaterThan(50);
  });

  it('the goal is reachable over the live edges in every chosen layout (reseed N = 20)', () => {
    for (const { layout, stubs, walled, goalReachable } of cases) {
      const s = initialState(layout, stubs, walled);
      const seen = new Set(['room-entry']); const q = ['room-entry'];
      while (q.length) { const x = q.shift(); for (const c of s.edges[x] ?? []) if (!seen.has(c)) { seen.add(c); q.push(c); } }
      expect(goalReachable, layout.seed).toBe(true);
      expect([...seen].some((r) => layout.rooms[r].isGoal), layout.seed).toBe(true);
    }
  });

  for (const policy of ['sensible', 'careless', 'adversarial']) {
    it(`${policy} walks always have a forward move or a retreat, and reach the goal`, () => {
      for (const { layout, stubs, walled } of cases) {
        const walks = policy === 'adversarial' ? 1 : 12;
        for (let w = 0; w < walks; w += 1) {
          const rnd = mulberry32(w * 7919 + layout.seed.length * 13 + Object.keys(layout.rooms).length * 31);
          const result = walk(layout, stubs, policy, rnd, (state) => {
            if (state.completed) return;
            const forward = openChildren(state, state.currentRoomId).length > 0
              || (state.stubEdges[state.currentRoomId] ?? []).some((t) => !state.stubsOpened[`${state.currentRoomId}->${t}`]);
            const judged = state.history.some((h) => h.roomId === state.currentRoomId);
            if (!forward && judged) expect(canRetreat(state).ok, `${layout.seed} at ${state.currentRoomId}`).toBe(true);
          }, walled);
          expect(result.done, layout.seed).toBe(true);
        }
      }
    }, 300_000);
  }
});
