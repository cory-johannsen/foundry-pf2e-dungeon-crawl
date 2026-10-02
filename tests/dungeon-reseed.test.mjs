// #490: goal-only reject-and-reseed (product module scripts/dungeon-reseed.mjs).
import { describe, it, expect } from 'vitest';
import * as deck from '../scripts/dungeon-deck.mjs';
import { NEW_RUN_LAYOUT_VERSION, applyStubsToEdges } from '../scripts/dungeon-layout.mjs';
import {
  candidateSeed, selectSeed, reseedStateFor, computeRunLayout, evaluateLayout, planRunLayoutStubs, RESEED_MAX_TRIES,
} from '../scripts/dungeon-reseed.mjs';
import { chooseRunLayout } from '../scripts/dungeon-reseed.mjs';
import { buildSweepLayout } from './helpers/layout-sweep.mjs';
import { buildSceneForLayout } from './helpers/scene-oracle.mjs';
import { oracleReports } from './helpers/stub-oracle-aware.mjs';
import { edgeWalkability, walkableVerdict } from './helpers/walkability-oracle.mjs';

describe('selectSeed (pure given an evaluate)', () => {
  it('candidate seeds are the original, then <seed>~r<k>', () => {
    expect([candidateSeed('abc', 0), candidateSeed('abc', 1), candidateSeed('abc', 10)]).toEqual(['abc', 'abc~r1', 'abc~r10']);
    expect(RESEED_MAX_TRIES).toBe(20);
  });
  it('keeps the original seed when its goal is reachable', async () => {
    const r = await selectSeed({ seed: 's', evaluate: async () => ({ goal: true, unreachable: 3 }) });
    expect(r).toMatchObject({ seed: 's', seedOrigin: 's', reseedTries: 0, goalReachable: true, exhausted: false });
  });
  it('takes the first later candidate that reaches the goal, and stops there', async () => {
    const seen = [];
    const evaluate = async (seed) => { seen.push(seed); return { goal: seed === 's~r3', unreachable: 0 }; };
    const r = await selectSeed({ seed: 's', evaluate });
    expect(r).toMatchObject({ seed: 's~r3', seedOrigin: 's', reseedTries: 3, goalReachable: true });
    expect(seen).toEqual(['s', 's~r1', 's~r2', 's~r3']);
  });
  it('is bounded: tries 1 + N candidates then keeps the best (goal first, then fewest unreachable), flagged exhausted', async () => {
    const seen = [];
    const evaluate = async (seed) => { seen.push(seed); return { goal: false, unreachable: seed === 's~r4' ? 1 : 5 }; };
    const r = await selectSeed({ seed: 's', evaluate, maxTries: 6 });
    expect(seen).toHaveLength(7);
    expect(r).toMatchObject({ seed: 's~r4', reseedTries: 4, goalReachable: false, exhausted: true });
  });
  it('ties keep the earliest candidate', async () => {
    const r = await selectSeed({ seed: 's', evaluate: async () => ({ goal: false, unreachable: 2 }), maxTries: 3 });
    expect(r).toMatchObject({ seed: 's', reseedTries: 0, exhausted: true });
  });
  it('is deterministic and calls yieldFn between candidates', async () => {
    let y = 0;
    const evaluate = async (seed) => ({ goal: seed === 's~r2', unreachable: 0 });
    const a = await selectSeed({ seed: 's', evaluate, yieldFn: async () => { y += 1; } });
    const b = await selectSeed({ seed: 's', evaluate });
    expect(a.seed).toBe(b.seed);
    expect(y).toBe(2);
  });
});

describe('reseedStateFor', () => {
  it('stamps seedOrigin + reseedTries on layoutVersion >= 3 only; v1/v2 add no key', () => {
    const o = { seedOrigin: 'a', reseedTries: 2 };
    expect(reseedStateFor(3, o)).toEqual(o);
    expect(reseedStateFor(2, o)).toEqual({});
    expect(reseedStateFor(1, o)).toEqual({});
    expect(reseedStateFor(undefined, o)).toEqual({});
  });
});

const ctx = (i, seed) => ({ generator: deck, seed, roomCount: 6 + (i % 15), setpieceIds: {} });

describe('product layout + truth predicate agree with the test oracle', () => {
  it('computeRunLayout equals the stub-free sweep layout (edges, positions) and the verdict equals oracle truth plus per-edge walkability', async () => {
    let goalFalse = 0;
    for (let i = 0; i < 500; i += 1) {
      const seed = `sweep-${i}`;
      const S = buildSweepLayout(i, { layoutVersion: 3, seed });
      const P = computeRunLayout({ ...ctx(i, seed), layoutVersion: NEW_RUN_LAYOUT_VERSION });
      expect(P.edges).toEqual(S.edges);
      expect('stubEdges' in P).toBe(false); // #427 Chunk 7: stubs come from planRunLayoutStubs, not the sync precompute
      expect(P.layoutPositionByRoomId).toEqual(S.pos);
      expect(P.incomingFaceByRoomId).toEqual(S.incFace);
      const { scene } = await buildSceneForLayout(S, 3);
      const R = oracleReports(S, scene);
      // #575: the product verdict is `truth` PLUS the per-edge walkability oracle (a dead edge under either is dead).
      const deadEdges = new Set([...R.sealed, ...[...R.nullE].filter((e) => !R.walkableNull.has(e)), ...edgeWalkability(S, scene).dead]);
      const expected = walkableVerdict(S, deadEdges);
      const v = await evaluateLayout(P);
      expect([i, v.goal]).toEqual([i, expected.goal]);
      expect([i, v.unreachable]).toEqual([i, expected.unreachable.length]);
      if (!v.goal) goalFalse += 1;
    }
    expect(goalFalse).toBeGreaterThan(100); // the base world has plenty of failures to be equivalent on
  }, 300000);
});

describe('chooseRunLayout', () => {
  it('v1/v2: no reseed, no evaluation, the original seed and a layout byte-identical to the sweep layout, no stub key', async () => {
    for (const layoutVersion of [1, 2]) {
      for (let i = 0; i < 40; i += 1) {
        const seed = `sweep-${i}`;
        const r = await chooseRunLayout({ ...ctx(i, seed), layoutVersion });
        expect([r.seed, r.reseedTries, r.ms]).toEqual([seed, 0, 0]);
        expect('stubEdges' in r.layout).toBe(false);
        // The sweep builder prunes shortcuts from v2 on only; the product precompute always has (new runs are v3).
        if (layoutVersion < 2) continue;
        const S = buildSweepLayout(i, { layoutVersion });
        const pick = (L) => JSON.stringify([L.rooms, L.edges, L.hiddenEdges, L.layoutEdges, L.hiddenRooms, L.hiddenIncomingByRoomId]);
        expect(JSON.stringify([r.layout.rooms, r.layout.edges, r.layout.hiddenEdges, r.layout.layoutEdges, r.layout.hiddenRooms, r.layout.hiddenIncomingByRoomId])).toBe(pick(S));
        expect(r.layout.layoutPositionByRoomId).toEqual(S.pos);
        expect(r.layout.incomingFaceByRoomId).toEqual(S.incFace);
      }
    }
  }, 60000);
  it('v3: the layout is built from the FINAL seed, deterministically, and warns only when exhausted', async () => {
    const warnings = [];
    for (const i of [0, 1, 2, 3, 4, 5, 6, 7]) {
      const a = await chooseRunLayout({ ...ctx(i, `sweep-${i}`), warn: (m) => warnings.push(m) });
      const b = await chooseRunLayout(ctx(i, `sweep-${i}`));
      expect(a.seed).toBe(b.seed);
      expect(a.layout.seed).toBe(a.seed);
      expect(a.seedOrigin).toBe(`sweep-${i}`);
      expect(a.seed).toBe(a.reseedTries === 0 ? `sweep-${i}` : `sweep-${i}~r${a.reseedTries}`);
      const S = buildSweepLayout(i, { layoutVersion: 3, seed: a.seed });
      // The chosen layout is the final seed's layout with its planned stubs removed from the progression graph.
      expect(a.layout.edges).toEqual(applyStubsToEdges(S.edges, a.layout.stubEdges));
      expect(a.layout.layoutEdges).toEqual(S.layoutEdges);
      expect(a.layout.stubEdges).toBeTypeOf('object');
    }
    expect(warnings).toEqual([]);
  }, 60000);
  it('exhausted: keeps a candidate and warns instead of blocking', async () => {
    const warnings = [];
    // base 12 needs 11 reseeds (see the ratchet test); with maxTries 3 it exhausts.
    const r = await chooseRunLayout({ ...ctx(12, 'sweep-12'), maxTries: 3, warn: (m) => warnings.push(m) });
    expect([r.exhausted, r.goalReachable, warnings.length]).toEqual([true, false, 1]);
    expect(r.layout.seed).toBe(r.seed);
  }, 60000);
});

describe('planRunLayoutStubs / the reseed predicate runs AFTER the stub plan (#427 Chunk 7)', () => {
  it('the verdict of the plan is the verdict of the stubbed layout, and the plan has sole-child stubs', async () => {
    let soleChild = 0;
    for (let i = 0; i < 25; i += 1) {
      const P = computeRunLayout({ ...ctx(i, `sweep-${i}`) });
      const planned = await planRunLayoutStubs(P, { retreatAvailable: true });
      expect(await evaluateLayout(planned.layout)).toEqual(planned.verdict);
      expect(planned.layout.layoutEdges).toEqual(P.layoutEdges); // nothing moves
      for (const [s, ts] of Object.entries(planned.layout.stubEdges)) {
        for (const t of ts) expect(planned.layout.edges[s]).not.toContain(t);
        if ((planned.layout.edges[s] ?? []).length === 0) soleChild += 1;
      }
    }
    expect(soleChild).toBeGreaterThan(0);
  }, 120000);
  it('without retreat no source is left without a forward edge (rule 2 stays)', async () => {
    for (let i = 0; i < 25; i += 1) {
      const P = computeRunLayout({ ...ctx(i, `sweep-${i}`) });
      const planned = await planRunLayoutStubs(P, { retreatAvailable: false });
      for (const s of Object.keys(planned.layout.stubEdges)) {
        if ((P.edges[s] ?? []).length > 0) expect([i, s, (planned.layout.edges[s] ?? []).length > 0 || (planned.layout.stubEdges[s] ?? []).every((t) => !P.edges[s].includes(t))]).toEqual([i, s, true]);
      }
    }
  }, 120000);
});
