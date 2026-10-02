// #490 ratchet: 500 base seeds through the REAL selection function (chooseRunLayout), stub-first with today's stub
// planner (retreat off), truth oracle. Pins the goal-reachable rate, the expected candidate count and the skew
// (secret-detour dungeons, hidden rooms) of the accepted seeds.
import { describe, it, expect } from 'vitest';
import * as deck from '../scripts/dungeon-deck.mjs';
import { chooseRunLayout, evaluateLayout, computeRunLayout, RESEED_MAX_TRIES } from '../scripts/dungeon-reseed.mjs';
import { installFoundryStubs } from './helpers/scene-oracle.mjs';

const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
const run = (i, extra = {}) => chooseRunLayout({ generator: deck, seed: `sweep-${i}`, roomCount: 6 + (i % 15), ...extra });

describe('goal-only reseed ratchet (500 bases, N = 10)', () => {
  it('goal-reachable rate, candidates and skew', async () => {
    installFoundryStubs();
    const out = [];
    for (let i = 0; i < 500; i += 1) out.push(await run(i));
    const base = [];
    for (let i = 0; i < 500; i += 1) base.push(await evaluateLayout(computeRunLayout({ generator: deck, seed: `sweep-${i}`, roomCount: 6 + (i % 15) })));
    const stats = {
      goal: out.filter((r) => r.goalReachable).length,
      baseGoal: base.filter((v) => v.goal).length,
      cand: mean(out.map((r) => r.reseedTries + 1)),
      worst: Math.max(...out.map((r) => r.reseedTries + 1)),
      exhausted: out.filter((r) => r.exhausted).length,
      detour: out.filter((r) => r.layout.hiddenRooms.length > 0).length,
      hidden: mean(out.map((r) => r.layout.hiddenRooms.length)),
      maxMs: Math.max(...out.map((r) => r.ms)), meanMs: mean(out.map((r) => r.ms)),
    };
    expect(RESEED_MAX_TRIES).toBe(10);
    // Base world (no reseed): about half of the dungeons cannot reach the goal.
    expect(stats.baseGoal).toBe(256);
    // Accepted seeds: goal reachable in 496/500 at N = 10 with today's stub planner (4 more need 11-18 reseeds:
    // bases 12, 87, 269 at k = 11/12, base 358 at k = 18). The corrected Chunk 7 planner measured 499.
    expect(stats.goal).toBe(496);
    expect(stats.exhausted).toBe(4);
    expect(stats.cand).toBeGreaterThan(2.0);
    expect(stats.cand).toBeLessThan(2.1);
    expect(stats.worst).toBeLessThanOrEqual(1 + RESEED_MAX_TRIES);
    // Skew: secret-detour dungeons fall 66% -> ~36%, hidden rooms 1.11 -> ~0.5.
    expect(stats.detour).toBe(179);
    expect(stats.hidden).toBeGreaterThan(0.46);
    expect(stats.hidden).toBeLessThan(0.54);
  }, 600000);
});
