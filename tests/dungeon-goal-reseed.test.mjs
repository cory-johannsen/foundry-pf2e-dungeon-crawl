// #490 / #427 PROTOTYPE measurement (not shipped): goal-only reject-and-reseed. Predicate G = the goal is reachable
// from room-entry over edges the `truth` oracle leaves live (dead = sealed, or null-path fallback whose centre line
// crosses a wall), measured on the layout AFTER the corrected stub plan (retreat on, planStubsOracleAwareVerified).
// Candidate k of base i is seed `sweep-${i}~r${k}`. Exact deterministic numbers over 500 v3 bases; see "Goal-only
// reject-and-reseed" in docs/superpowers/specs/2026-10-01-boxed-in-corridor-routing-design.md.
import { describe, it, expect } from 'vitest';
import { goalReseedSweep, summarize } from './helpers/goal-reseed.mjs';

describe('goal-only reject-and-reseed (#490/#427 prototype, truth oracle, stubs on)', () => {
  it('N = 0..20 reseeds: goal reachability, skew of accepted vs base, residual', async () => {
    const sweep = await goalReseedSweep(500, 20);
    const at = (N, key = 'gStub') => summarize(sweep, N, key);
    const base = at(0);
    // Base: goal reachable in 291/500 after stubs (281 on the plain layout); 61% of dungeons have a secret detour.
    // #906 (unreachable detours dropped): 265/255 -> 291/281, detour dungeons 330 -> 303.
    expect([base.valid, summarize(sweep, 0, 'gPlain').valid]).toEqual([291, 281]);
    expect(base.detourDungeons).toBe(303);
    // Share of runs ending with G true after N reseeds (stub-first policy). #906: was 389/465/485/499/500.
    expect([1, 3, 5, 10, 20].map((N) => at(N).valid)).toEqual([413, 484, 492, 500, 500]);
    // Check-before-stubs policy (cheaper: stubs only for the accepted candidate): never better than stub-first.
    // #906: was 379/459/482/497/500.
    expect([1, 3, 5, 10, 20].map((N) => at(N, 'gPlain').valid)).toEqual([404, 477, 490, 499, 500]);
    // Expected candidates and worst case.
    expect(at(20).expectedCandidates).toBeLessThan(2.1);
    expect(at(20).worst).toBeLessThanOrEqual(20);
    // Skew: secret-detour dungeons fall 61% -> 32% (full predicate: 22-25%); room count and kind mix hold.
    // #906: accepted detour dungeons 180 -> 159 (base 330 -> 303).
    const a = at(20);
    expect(a.detourDungeons).toBe(159);
    expect(a.hiddenMean).toBeLessThan(0.55);
    expect(Math.abs(a.mergeMean - base.mergeMean)).toBeLessThan(0.05);
    expect(Math.abs(a.roomsMean - base.roomsMean)).toBeLessThan(0.7);
    // Residual after goal-only reseed + stubs (truth): the goal is reachable everywhere, optional rooms mostly are.
    // #906: residual 47/80 -> 50/85 and sole-dead 16 -> 19 (other seeds are accepted now), sealed doors 89 -> 63,
    // base unreachable rooms 1275 -> 1125.
    expect([a.unreachDungeons, a.unreachRooms]).toEqual([50, 85]);
    expect(a.soleDeadDungeons).toBe(19);
    expect(a.sealedDoors).toBe(63);
    expect(base.unreachRooms).toBe(1125);
  }, 300000);
});
