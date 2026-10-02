// tests/dungeon-retreat-softlock.test.mjs
import { describe, it, expect } from 'vitest';
import { layoutsWithNullEdges, pickStubs, walk, mulberry32, initialState } from './helpers/retreat-sim.mjs';
import { canRetreat, openChildren } from '../scripts/dungeon-retreat.mjs';

const SEEDS = 500;
const layouts = layoutsWithNullEdges(SEEDS);

describe('#439 retreat soft-lock property (500 seeds)', () => {
  it('has the measured shape (guards the helper itself)', () => {
    expect(layouts).toHaveLength(SEEDS);
    const sole = layouts.reduce((n, l) => n + pickStubs(l, { allowSole: true }).size, 0);
    expect(sole).toBeGreaterThan(1400); // measured 1,544 in the spec
    expect(layouts.reduce((n, l) => n + pickStubs(l, { allowSole: false }).size, 0)).toBeLessThan(sole);
  });

  it('premise (#427 rule 3): the goal and every room stay reachable over non-stub edges', () => {
    for (const l of layouts) {
      const stubs = pickStubs(l, { allowSole: true });
      const s = initialState(l, stubs);
      const seen = new Set(['room-entry']); const q = ['room-entry'];
      while (q.length) { const x = q.shift(); for (const c of s.edges[x] ?? []) if (!seen.has(c)) { seen.add(c); q.push(c); } }
      expect(Object.keys(l.rooms).filter((r) => !seen.has(r) && !l.hiddenRooms.includes(r))).toEqual([]);
    }
  });

  for (const policy of ['sensible', 'careless', 'adversarial']) {
    it(`${policy} walks always have a forward move or a retreat, always reach the goal`, () => {
      for (const l of layouts) {
        const stubs = pickStubs(l, { allowSole: true });
        const walks = policy === 'adversarial' ? 1 : 40;
        for (let w = 0; w < walks; w += 1) {
          const rnd = mulberry32(w * 7919 + l.seed.length * 13 + Object.keys(l.rooms).length * 31);
          const result = walk(l, stubs, policy, rnd, (state) => {
            if (state.completed) return;
            const forward = openChildren(state, state.currentRoomId).length > 0
              || (state.stubEdges[state.currentRoomId] ?? []).some((t) => !state.stubsOpened[`${state.currentRoomId}->${t}`]);
            const judged = state.history.some((h) => h.roomId === state.currentRoomId);
            // A move exists, or (once judged and every stub opened) a retreat target exists.
            if (!forward && judged) expect(canRetreat(state).ok, `${l.seed} at ${state.currentRoomId}`).toBe(true);
            // retreatPath is always a chain from room-entry ending at the current room.
            expect(state.retreatPath[0]).toBe('room-entry');
            expect(state.retreatPath[state.retreatPath.length - 1]).toBe(state.currentRoomId);
          });
          expect(result.done).toBe(true);
        }
      }
    }, 120_000);
  }
});
