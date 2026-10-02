// #427 Chunk 7 acceptance ratchets: the SHIPPED stub plan (planRunLayoutStubs: walkability-union dead edges, retreat on,
// rule 3' and the verify step) over 500 v3 seeds, judged by the TEST-SIDE oracles (tests/helpers/stub-union.mjs), which
// share no code with the planner's. Numbers are exact and deterministic; if the generator changes they move, update
// them with a fresh measurement.
import { describe, it, expect } from 'vitest';
import * as deck from '../scripts/dungeon-deck.mjs';
import { computeRunLayout, planRunLayoutStubs } from '../scripts/dungeon-reseed.mjs';
import { RETREAT_VERSION } from '../scripts/dungeon-retreat.mjs';
import { buildSceneForLayout } from './helpers/scene-oracle.mjs';
import { sweepShapeOfRunLayout } from './helpers/walkability-oracle.mjs';
import { unionReports } from './helpers/stub-union.mjs';

const SEEDS = 500;
const GENERATE = (i) => computeRunLayout({ generator: deck, seed: `sweep-${i}`, roomCount: 6 + (i % 15) });

const sealedStubDoor = (scene, d) => {
  const [x1, y1, x2, y2] = d.c;
  return scene.walls.some((w) => !w.door && (y1 === y2
    ? w.c[1] === y1 && w.c[3] === y1 && Math.max(Math.min(w.c[0], w.c[2]), Math.min(x1, x2)) < Math.min(Math.max(w.c[0], w.c[2]), Math.max(x1, x2))
    : w.c[0] === x1 && w.c[2] === x1 && Math.max(Math.min(w.c[1], w.c[3]), Math.min(y1, y2)) < Math.min(Math.max(w.c[1], w.c[3]), Math.max(y1, y2))));
};

describe('#427 Chunk 7: dead edges become stubs (500 seeds, retreat on, union oracle)', () => {
  it('never regresses, seals no stub door, and removes the dead-edge corridors it stubs', async () => {
    expect(RETREAT_VERSION).toBeGreaterThanOrEqual(1);
    const t = {
      stubs: 0, stubDungeons: 0, maxStubs: 0, soleChildStubs: 0, regress: 0, stubDoorsSealed: 0, droppedByVerify: 0,
      sealedBefore: 0, sealedAfter: 0, deadBefore: 0, deadAfter: 0, deadDungeonsBefore: 0, deadDungeonsAfter: 0,
      unreachRoomsBefore: 0, unreachRoomsAfter: 0, goalLostBefore: 0, goalLostAfter: 0, stubbedEdgeStillBuilt: 0,
      stubsNotInProgressionGraph: 0, stubsNotInLayoutEdges: 0,
    };
    for (let i = 0; i < SEEDS; i += 1) {
      const P = GENERATE(i);
      const before = sweepShapeOfRunLayout(P);
      const Rb = unionReports(before, (await buildSceneForLayout(before, 3)).scene);
      const planned = await planRunLayoutStubs(P, { retreatAvailable: true });
      const L = sweepShapeOfRunLayout(planned.layout);
      const scene = (await buildSceneForLayout(L, 3)).scene;
      const R = unionReports(L, scene);
      const stubKeys = Object.entries(L.stubEdges ?? {}).flatMap(([s, ts]) => ts.map((x) => `${s}->${x}`));
      t.stubs += stubKeys.length; if (stubKeys.length) t.stubDungeons += 1; t.maxStubs = Math.max(t.maxStubs, stubKeys.length);
      t.droppedByVerify += planned.dropped;
      // #585: dead edges that could not be stubs are now walled, which removes edges the optimistic semantics (opt /
      // strict) still call live, so only the union verdict (the product predicate) is compared. One walled-dungeon
      // regression exists (tests/dungeon-walled-sweep.test.mjs: door re-slotting killed an edge; the reseed rejects it).
      if ((Rb.union.goal && !R.union.goal) || R.union.unreachable.some((r) => !Rb.union.unreachable.includes(r))) t.regress += 1;
      t.sealedBefore += Rb.sealedDoors; t.sealedAfter += R.sealedDoors;
      t.deadBefore += Rb.union.dead.size; t.deadAfter += R.union.dead.size;
      if (Rb.union.dead.size) t.deadDungeonsBefore += 1;
      if (R.union.dead.size) t.deadDungeonsAfter += 1;
      t.unreachRoomsBefore += Rb.union.unreachable.length; t.unreachRoomsAfter += R.union.unreachable.length;
      if (!Rb.union.goal) t.goalLostBefore += 1;
      if (!R.union.goal) t.goalLostAfter += 1;
      for (const w of scene.walls.filter((x) => x.door && x.flags?.['pf2e-dungeon-crawl']?.dungeonStubDoorFor)) if (sealedStubDoor(scene, w)) t.stubDoorsSealed += 1;
      for (const key of stubKeys) {
        const [s, x] = key.split('->');
        if ((planned.layout.edges[s] ?? []).includes(x)) t.stubsNotInProgressionGraph += 1;
        if (!(planned.layout.layoutEdges[s] ?? []).includes(x) && !(planned.layout.hiddenEdges[s] ?? []).includes(x)) t.stubsNotInLayoutEdges += 1;
        // The stubbed edge builds no corridor of its own: no real door carries it as an outgoing connection.
        if (scene.walls.some((w) => w.door && w.flags?.['pf2e-dungeon-crawl']?.dungeonDoorFromRoomId === s && w.flags['pf2e-dungeon-crawl'].dungeonDoorToRoomId === x)) t.stubbedEdgeStillBuilt += 1;
      }
      const retreatOnly = Object.keys(L.stubEdges ?? {}).filter((s) => (planned.layout.edges[s] ?? []).length === 0 && (P.edges[s] ?? []).length > 0);
      t.soleChildStubs += retreatOnly.length;
    }
    expect(t.regress).toBeLessThanOrEqual(1);
    expect(t.stubDoorsSealed).toBe(0);
    expect(t.stubbedEdgeStillBuilt).toBe(0);
    expect(t.stubsNotInProgressionGraph).toBe(0);
    expect(t.goalLostAfter).toBeLessThanOrEqual(t.goalLostBefore);
    expect(t.unreachRoomsAfter).toBeLessThanOrEqual(t.unreachRoomsBefore);
    expect(t.deadAfter).toBeLessThan(t.deadBefore);
    // Measured (retreat on, union oracle). Dead real edges 2556 -> 1277 (1245 became stubs, 28 more stubs are hidden
    // shortcut links); the rest are refused by the rules (target has no other walkable parent, graph rule 3) or have no
    // free door tile in the source's south margin row. Sealed doors 1478 -> 473.
    // #585: the dead edges the rules refuse are now walled (tests/dungeon-walled-sweep.test.mjs), so no dead real edge is
    // left (1277 -> 0), one stub fewer (its door tile went when the walled doors re-slotted) and the 58 doors still sealed
    // are hidden shortcut/detour doors (not progression edges). Sole-child stub sources count walled siblings too.
    expect([t.stubs, t.stubDungeons, t.maxStubs, t.soleChildStubs]).toEqual([1271, 454, 8, 1250]);
    expect(t.droppedByVerify).toBe(24);
    expect([t.sealedBefore, t.sealedAfter]).toEqual([1478, 58]);
    expect([t.deadBefore, t.deadAfter, t.deadDungeonsBefore, t.deadDungeonsAfter]).toEqual([2556, 0, 490, 0]);
    expect([t.unreachRoomsBefore, t.unreachRoomsAfter, t.goalLostBefore, t.goalLostAfter]).toEqual([2305, 2259, 271, 266]);
  }, 900000);
});
