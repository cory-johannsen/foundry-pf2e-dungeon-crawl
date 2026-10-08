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
    // Base: goal reachable in 265/500 after stubs (255 on the plain layout); 66% of dungeons have a secret detour.
    expect([base.valid, summarize(sweep, 0, 'gPlain').valid]).toEqual([265, 255]);
    expect(base.detourDungeons).toBe(330);
    // Share of runs ending with G true after N reseeds (stub-first policy).
    expect([1, 3, 5, 10, 20].map((N) => at(N).valid)).toEqual([389, 465, 485, 499, 500]);
    // Check-before-stubs policy (cheaper: stubs only for the accepted candidate): never better than stub-first.
    expect([1, 3, 5, 10, 20].map((N) => at(N, 'gPlain').valid)).toEqual([379, 459, 482, 497, 500]);
    // Expected candidates and worst case.
    expect(at(20).expectedCandidates).toBeLessThan(2.1);
    expect(at(20).worst).toBeLessThanOrEqual(20);
    // Skew: secret-detour dungeons fall 66% -> 36% (full predicate: 22-25%); room count and kind mix hold.
    const a = at(20);
    expect(a.detourDungeons).toBe(180);
    expect(a.hiddenMean).toBeLessThan(0.55);
    expect(Math.abs(a.mergeMean - base.mergeMean)).toBeLessThan(0.05);
    expect(Math.abs(a.roomsMean - base.roomsMean)).toBeLessThan(0.7);
    // Residual after goal-only reseed + stubs (truth): the goal is reachable everywhere, optional rooms mostly are.
    expect([a.unreachDungeons, a.unreachRooms]).toEqual([47, 80]);
    expect(a.soleDeadDungeons).toBe(16);
    expect(a.sealedDoors).toBe(89);
    expect(base.unreachRooms).toBe(1275);
  }, 300000);
});
