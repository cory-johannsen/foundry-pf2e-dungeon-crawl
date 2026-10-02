// #427 Chunk 7 x #439: the retreat soft-lock property against the REAL stub plan (planRunLayoutStubs), not the
// greedy stand-in of tests/dungeon-retreat-softlock.test.mjs. The `pickStubs` seam of the retreat simulation is
// replaced by the shipped plan's stub set; 500 seeds, 3 walk policies.
import { describe, it, expect } from 'vitest';
import * as deck from '../scripts/dungeon-deck.mjs';
import { computeRunLayout, planRunLayoutStubs } from '../scripts/dungeon-reseed.mjs';
import { canRetreat, openChildren } from '../scripts/dungeon-retreat.mjs';
import { walk, mulberry32, initialState } from './helpers/retreat-sim.mjs';
import { installFoundryStubs } from './helpers/scene-oracle.mjs';

installFoundryStubs();
const SEEDS = 500;
const cases = [];
for (let i = 0; i < SEEDS; i += 1) {
  const P = computeRunLayout({ generator: deck, seed: `sweep-${i}`, roomCount: 6 + (i % 15) });
  const planned = await planRunLayoutStubs(P, { retreatAvailable: true });
  const stubs = new Set(Object.entries(planned.layout.stubEdges).flatMap(([s, ts]) => ts.map((t) => `${s}>${t}`)));
  cases.push({ layout: { seed: P.seed, rooms: P.rooms, edges: P.edges, hiddenRooms: P.hiddenRooms }, stubs });
}

describe('#439 retreat soft-lock property against the real stub plan (500 seeds)', () => {
  it('has real sole-child stubs (guards the seam)', () => {
    const sole = cases.reduce((n, { layout, stubs }) => n + Object.entries(initialState(layout, stubs).edges)
      .filter(([s, kids]) => kids.length === 0 && (layout.edges[s] ?? []).length > 0).length, 0);
    expect(sole).toBeGreaterThan(1000);
  });

  it('every room and the goal stay reachable over non-stub edges', () => {
    for (const { layout, stubs } of cases) {
      const s = initialState(layout, stubs);
      const seen = new Set(['room-entry']); const q = ['room-entry'];
      while (q.length) { const x = q.shift(); for (const c of s.edges[x] ?? []) if (!seen.has(c)) { seen.add(c); q.push(c); } }
      const baseSeen = new Set(['room-entry']); const bq = ['room-entry'];
      while (bq.length) { const x = bq.shift(); for (const c of layout.edges[x] ?? []) if (!baseSeen.has(c)) { baseSeen.add(c); bq.push(c); } }
      expect([...baseSeen].filter((r) => !seen.has(r)), layout.seed).toEqual([]);
    }
  });

  for (const policy of ['sensible', 'careless', 'adversarial']) {
    it(`${policy} walks always have a forward move or a retreat, and reach the goal`, () => {
      for (const { layout, stubs } of cases) {
        const walks = policy === 'adversarial' ? 1 : 12;
        for (let w = 0; w < walks; w += 1) {
          const rnd = mulberry32(w * 7919 + layout.seed.length * 13 + Object.keys(layout.rooms).length * 31);
          const result = walk(layout, stubs, policy, rnd, (state) => {
            if (state.completed) return;
            const forward = openChildren(state, state.currentRoomId).length > 0
              || (state.stubEdges[state.currentRoomId] ?? []).some((t) => !state.stubsOpened[`${state.currentRoomId}->${t}`]);
            const judged = state.history.some((h) => h.roomId === state.currentRoomId);
            if (!forward && judged) expect(canRetreat(state).ok, `${layout.seed} at ${state.currentRoomId}`).toBe(true);
          });
          expect(result.done, layout.seed).toBe(true);
        }
      }
    }, 300_000);
  }
});
