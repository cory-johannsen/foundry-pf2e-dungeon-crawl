// #575: per-edge door-to-door walkability (tests/helpers/walkability-oracle.mjs) and the user's stuck-run repro.
import { describe, it, expect } from 'vitest';
import * as deck from '../scripts/dungeon-deck.mjs';
import { computeRunLayout, evaluateLayout } from '../scripts/dungeon-reseed.mjs';
import { buildSweepLayout } from './helpers/layout-sweep.mjs';
import { buildStubbedSweepLayout } from './helpers/stub-sweep.mjs';
import { buildSceneForLayout } from './helpers/scene-oracle.mjs';
import { oracleReports } from './helpers/stub-oracle-aware.mjs';
import { edgeWalkability, walkableVerdict, sweepShapeOfRunLayout } from './helpers/walkability-oracle.mjs';

// The live stuck run (module 0.54.169): seed 1790965681939-q11uulo9ja, 12 rooms, no stubs.
const STUCK_SEED = '1790965681939-q11uulo9ja';
const E010 = 'room-room-room-room-entry-0-1-0';
const REST = 'room-rest';

describe('#575 stuck run (seed 1790965681939-q11uulo9ja)', () => {
  const P = computeRunLayout({ generator: deck, seed: STUCK_SEED, roomCount: 12, setpieceIds: {} });

  it('the walkability oracle sees both dead edges the live run hit; the `truth` oracle sees only one', async () => {
    const L = sweepShapeOfRunLayout(P);
    const { scene } = await buildSceneForLayout(L, 3);
    const W = edgeWalkability(L, scene);
    // e0-1-0 -> rest: null-path fallback whose first leg runs west along the door row, through the x=32800/32900 channel walls.
    expect(W.edges.get(`${E010}->${REST}`)).toMatchObject({ walkable: false, nullPath: true, cause: 'wallCut' });
    // e0 -> e0-0: a FOUND-path corridor cut by its sibling's flank walls (same south face).
    expect(W.edges.get('room-room-entry-0->room-room-room-entry-0-0')).toMatchObject({ walkable: false, nullPath: false, cause: 'wallCut' });
    expect(walkableVerdict(L, W.dead).goal).toBe(false);
    const R = oracleReports(L, scene);
    expect(R.truth.goal).toBe(true); // the blind spot: truth thinks e0 -> e0-0 is alive
  });

  it('the reseed predicate rejects it (goal not reachable over walkable edges)', async () => {
    expect((await evaluateLayout(P)).goal).toBe(false);
  });
});

// Ratchets: measured on 500 sweep seeds. Lower these when the geometry improves; never raise them.
const RATCHET = {
  1: { dead: 3498, foundDead: 1792, goalFalse: 382 },
  2: { dead: 2755, foundDead: 1051, goalFalse: 342 },
  3: { dead: 2358, foundDead: 655, goalFalse: 144 },
};

describe('#575 per-edge walkability ratchets (500 seeds)', () => {
  for (const v of [1, 2, 3]) {
    it(`layoutVersion ${v}: dead edges, dead found-path edges and goal-unreachable dungeons do not grow`, async () => {
      let dead = 0; let foundDead = 0; let goalFalse = 0; let truthMissedFound = 0;
      for (let i = 0; i < 500; i += 1) {
        const L = v >= 3 ? buildStubbedSweepLayout(i, { layoutVersion: 3, seed: `sweep-${i}` }) : buildSweepLayout(i, { layoutVersion: v });
        const { scene } = await buildSceneForLayout(L, v);
        const W = edgeWalkability(L, scene);
        dead += W.dead.size;
        for (const [, e] of W.edges) if (!e.walkable && !e.nullPath) foundDead += 1;
        if (!walkableVerdict(L, W.dead).goal) goalFalse += 1;
        if (v >= 3) {
          const R = oracleReports(L, scene);
          for (const [k, e] of W.edges) if (!e.walkable && !e.nullPath && !R.sealed.has(k)) truthMissedFound += 1;
        }
      }
      expect(dead).toBeLessThanOrEqual(RATCHET[v].dead);
      expect(foundDead).toBeLessThanOrEqual(RATCHET[v].foundDead);
      expect(goalFalse).toBeLessThanOrEqual(RATCHET[v].goalFalse);
      if (v >= 3) expect(truthMissedFound).toBeGreaterThan(0); // documents that `truth` alone misses found-path cuts
    }, 300000);
  }
});
