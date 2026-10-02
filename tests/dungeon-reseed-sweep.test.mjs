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
    // Base world (no reseed): over half of the dungeons cannot reach the goal. #575: the predicate also needs every
    // edge on the route to be walkable door to door (was 256 under `truth` alone; 496/500 accepted at N = 10).
    expect(stats.baseGoal).toBe(231);
    // Accepted seeds: goal reachable in 495/500 at N = 10 (5 more need 11+ reseeds; N = 20 reaches 500/500 on the
    // oracle sweep).
    expect(stats.goal).toBe(495);
    expect(stats.exhausted).toBe(5);
    expect(stats.cand).toBeGreaterThan(2.2);
    expect(stats.cand).toBeLessThan(2.35);
    expect(stats.worst).toBeLessThanOrEqual(1 + RESEED_MAX_TRIES);
    // Skew: secret-detour dungeons fall 66% -> ~29%, hidden rooms 1.11 -> ~0.38 (detour edges are often cut ones).
    expect(stats.detour).toBe(147);
    expect(stats.hidden).toBeGreaterThan(0.34);
    expect(stats.hidden).toBeLessThan(0.42);
  }, 600000);
});
