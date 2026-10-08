// #427 Chunk 7 PROTOTYPE measurement (not shipped): why does `planStubs({ retreatAvailable: true })` lose the goal in
// more dungeons (opt oracle: 36 -> 41) and what rule fixes it? Design note: "Chunk 7 rule fix" in
// docs/superpowers/specs/2026-10-01-boxed-in-corridor-routing-design.md. Three dead-edge semantics, see
// tests/helpers/stub-oracle-aware.mjs: opt (sealed doors only, the ratchet oracle), strict (sealed or null-path),
// truth (sealed, or null-path whose centre line crosses a wall). Exact deterministic numbers over 500 v3 seeds.
import { describe, it, expect } from 'vitest';
import { buildSceneForLayout } from './helpers/scene-oracle.mjs';
import { buildSweepLayout } from './helpers/layout-sweep.mjs';
import {
  oracleReports, planStubsOracleAwareVerified, buildStubbedSweepLayout, regresses, flood,
} from './helpers/stub-oracle-aware.mjs';

const SEEDS = 500;
const sealedStub = (scene, d) => {
  const [x1, y1, x2, y2] = d.c;
  return scene.walls.some((w) => !w.door && (y1 === y2
    ? w.c[1] === y1 && w.c[3] === y1 && Math.max(Math.min(w.c[0], w.c[2]), Math.min(x1, x2)) < Math.min(Math.max(w.c[0], w.c[2]), Math.max(x1, x2))
    : w.c[0] === x1 && w.c[2] === x1 && Math.max(Math.min(w.c[1], w.c[3]), Math.min(y1, y2)) < Math.min(Math.max(w.c[1], w.c[3]), Math.max(y1, y2))));
};
const blank = () => ({
  sealedDoors: 0, sealedReal: 0, stubs: 0, stubDungeons: 0, stubDoorsSealed: 0,
  opt: { rooms: 0, dungeons: 0, goal: 0 }, strict: { rooms: 0, dungeons: 0, goal: 0 }, truth: { rooms: 0, dungeons: 0, goal: 0 },
});
function add(t, R, L, scene) {
  t.sealedDoors += R.sealedDoors;
  t.sealedReal += R.sealedEdges.filter((e) => !e.hidden).length;
  const n = Object.values(L.stubEdges ?? {}).flat().length;
  t.stubs += n; if (n) t.stubDungeons += 1;
  t.stubDoorsSealed += scene.walls.filter((w) => w.door && w.flags?.['pf2e-dungeon-crawl']?.dungeonStubDoorFor && sealedStub(scene, w)).length;
  for (const s of ['opt', 'strict', 'truth']) {
    t[s].rooms += R[s].unreachable.length;
    if (R[s].unreachable.length) t[s].dungeons += 1;
    if (!R[s].goal) t[s].goal += 1;
  }
}

describe('stub rule vs the scene oracle (#427 Chunk 7 prototype, retreat on)', () => {
  it('current planner: net opt-goal loss is churn; the oracle-aware + verified prototype never regresses', async () => {
    const none = blank(); const cur = blank(); const fix = blank();
    const churn = { goalLost: 0, goalGained: 0, roomLost: 0, roomGained: 0, truthGoalLost: 0 };
    const fixRegress = { perDungeon: 0, dropped: 0, droppedDungeons: 0 };
    const removalCause = { removedOptLiveEdge: 0, reslotOnly: 0 };
    for (let i = 0; i < SEEDS; i += 1) {
      const B = buildSweepLayout(i, { layoutVersion: 3 });
      const bScene = (await buildSceneForLayout(B, 3)).scene;
      const Rb = oracleReports(B, bScene);
      add(none, Rb, B, bScene);
      const S = buildStubbedSweepLayout(i, { retreatAvailable: true });
      const sScene = (await buildSceneForLayout(S, 3)).scene;
      const Rs = oracleReports(S, sScene);
      add(cur, Rs, S, sScene);
      const lost = Rb.opt.goal && !Rs.opt.goal;
      if (lost) {
        churn.goalLost += 1;
        if (Rb.truth.goal) churn.truthGoalLost += 1;
        // Cause: would the baseline's live (unsealed) graph still reach the goal with just the stubs removed?
        const stubSet = new Set(Object.entries(S.stubEdges).flatMap(([s, ts]) => ts.map((t) => `${s}->${t}`)));
        const seen = flood(B.edges, (s, c) => Rb.sealed.has(`${s}->${c}`) || stubSet.has(`${s}->${c}`));
        if (seen.has('room-goal')) removalCause.reslotOnly += 1; else removalCause.removedOptLiveEdge += 1;
      }
      if (!Rb.opt.goal && Rs.opt.goal) churn.goalGained += 1;
      if (!Rb.opt.unreachable.length && Rs.opt.unreachable.length) churn.roomLost += 1;
      if (Rb.opt.unreachable.length && !Rs.opt.unreachable.length) churn.roomGained += 1;

      const v = await planStubsOracleAwareVerified(B, Rb, S, async (L) => (await buildSceneForLayout(L, 3)).scene);
      const fScene = (await buildSceneForLayout(v.layout, 3)).scene;
      add(fix, v.report, v.layout, fScene);
      if (regresses(Rb, v.report)) fixRegress.perDungeon += 1;
      fixRegress.dropped += v.dropped; if (v.dropped) fixRegress.droppedDungeons += 1;
    }
    console.log('[stub-oracle-aware]', JSON.stringify({ none, cur, fix, churn, fixRegress, removalCause }));
    // Baseline and current planner are the numbers the stubs agent measured (guards the helpers).
    // #906 (unreachable detours dropped): was 1294, [32, 58], [26, 58], churn lost 23 / gained 29.
    expect(none.sealedDoors).toBe(1218);
    expect([none.opt.goal, none.opt.dungeons]).toEqual([23, 53]);
    expect([cur.opt.goal, cur.opt.dungeons]).toEqual([19, 50]);
    // The "extra" goal losses are the net of many losses and gains (churn); under strict nothing is lost.
    expect(churn.goalLost).toBe(17);
    expect(churn.goalGained).toBe(21);
    expect(strictNeverLost(none, cur)).toBe(true);
    // The prototype: never worse than no stubs, per dungeon and in total, under all three semantics.
    expect(fixRegress.perDungeon).toBe(0);
    for (const s of ['opt', 'strict', 'truth']) {
      expect(fix[s].goal, `${s} goal`).toBeLessThanOrEqual(none[s].goal);
      expect(fix[s].dungeons, `${s} dungeons`).toBeLessThanOrEqual(none[s].dungeons);
      expect(fix[s].rooms, `${s} rooms`).toBeLessThanOrEqual(none[s].rooms);
    }
    expect(fix.sealedDoors).toBeLessThan(none.sealedDoors * 0.35);
    expect(fix.stubDungeons).toBeGreaterThan(SEEDS * 0.85);
  }, 600000);
});

const strictNeverLost = (a, b) => b.strict.goal <= a.strict.goal && b.strict.dungeons <= a.strict.dungeons;
