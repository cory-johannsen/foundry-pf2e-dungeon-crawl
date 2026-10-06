// #585 acceptance ratchets: the SHIPPED plan (stubs, then walls for every dead edge that cannot be a stub) over 500 v3
// seeds, judged by the TEST-SIDE oracles (tests/helpers/stub-union.mjs), which share no code with the planner's.
// Numbers are exact and deterministic; if the generator changes they move, update them with a fresh measurement.
import { describe, it, expect } from 'vitest';
import * as deck from '../scripts/dungeon-deck.mjs';
import { computeRunLayout, planRunLayoutStubs } from '../scripts/dungeon-reseed.mjs';
import { buildSceneForLayout, sealedEdgeReport } from './helpers/scene-oracle.mjs';
import { sweepShapeOfRunLayout } from './helpers/walkability-oracle.mjs';
import { unionReports } from './helpers/stub-union.mjs';
import { doorCorridorMismatches } from './helpers/door-corridor-oracle.mjs';

const SEEDS = 500;
const MODULE_ID = 'pf2e-dungeon-crawl';

// Scene-level overlap counts: corridor tiles that share a cell, and corridor tiles that sit inside some room's rect.
function tileOverlaps(L, scene) {
  const cells = new Map();
  let inRoom = 0;
  const rects = Object.values(L.rect);
  for (const t of scene.tiles.filter((x) => x.width === 100 && x.height === 100)) {
    const cx = Math.floor(t.x / 100);
    const cy = Math.floor(t.y / 100);
    const k = `${cx},${cy}`;
    cells.set(k, (cells.get(k) ?? 0) + 1);
    if (rects.some((r) => cx >= r.gx && cx < r.gx + r.gw && cy >= r.gy && cy < r.gy + r.gh)) inRoom += 1;
  }
  return { dup: [...cells.values()].filter((n) => n > 1).length, inRoom };
}

describe('#585: dead edges that cannot be stubs are walled (500 seeds, retreat on, union oracle)', () => {
  it('leaves no dead real edge, no sealed progression door, loses nothing that was reachable', async () => {
    const t = {
      walled: 0, walledDungeons: 0, maxWalled: 0, deadLeft: 0, sealedProgressionDoors: 0, regress: 0, goalLostBefore: 0,
      goalLostAfter: 0, unreachBefore: 0, unreachAfter: 0, walledStillInEdges: 0, walledNotInLayoutEdges: 0,
      walledAlsoStub: 0, walledStillBuilt: 0, lostFlagged: 0,
      dupBefore: 0, dupAfter: 0, inRoomBefore: 0, inRoomAfter: 0, doorMismatchBefore: 0, doorMismatchAfter: 0,
    };
    for (let i = 0; i < SEEDS; i += 1) {
      const P = computeRunLayout({ generator: deck, seed: `sweep-${i}`, roomCount: 6 + (i % 15) });
      const before = sweepShapeOfRunLayout(P);
      const sceneBefore = (await buildSceneForLayout(before, 3)).scene;
      const Rb = unionReports(before, sceneBefore);
      const planned = await planRunLayoutStubs(P, { retreatAvailable: true });
      const L = sweepShapeOfRunLayout(planned.layout);
      const scene = (await buildSceneForLayout(L, 3)).scene;
      const R = unionReports(L, scene);
      // The shipped (pre-#585) state: stubs, but the dead edges built as doors and blocked corridors.
      const unwalled = {
        ...L, walledEdges: undefined,
        edges: Object.fromEntries(Object.entries(L.edges).map(([s, kids]) => [s, [...kids, ...(planned.layout.walledEdges?.[s] ?? [])]])),
      };
      const sceneUnwalled = (await buildSceneForLayout(unwalled, 3)).scene;
      const ob = tileOverlaps(unwalled, sceneUnwalled);
      const oa = tileOverlaps(L, scene);
      t.dupBefore += ob.dup; t.dupAfter += oa.dup; t.inRoomBefore += ob.inRoom; t.inRoomAfter += oa.inRoom;
      t.doorMismatchBefore += doorCorridorMismatches(unwalled, sceneUnwalled).filter((m) => !m.hidden).length;
      t.doorMismatchAfter += doorCorridorMismatches(L, scene).filter((m) => !m.hidden).length;
      const keys = Object.entries(planned.layout.walledEdges ?? {}).flatMap(([s, ts]) => ts.map((x) => [s, x]));
      if (planned.lost) t.lostFlagged += 1;
      t.walled += keys.length;
      if (keys.length) t.walledDungeons += 1;
      t.maxWalled = Math.max(t.maxWalled, keys.length);
      t.deadLeft += R.union.dead.size;
      // A progression door (outgoing or reveal) covered by a solid wall can never be walked.
      t.sealedProgressionDoors += sealedEdgeReport(L, scene).sealedEdges.filter((e) => !e.hidden).length;
      // The product predicate is the union oracle: walling removes edges the optimistic semantics (opt / strict) still
      // call live, so only the union verdict is compared.
      if ((Rb.union.goal && !R.union.goal) || R.union.unreachable.some((r) => !Rb.union.unreachable.includes(r))) t.regress += 1;
      if (!Rb.union.goal) t.goalLostBefore += 1;
      if (!R.union.goal) t.goalLostAfter += 1;
      t.unreachBefore += Rb.union.unreachable.length;
      t.unreachAfter += R.union.unreachable.length;
      for (const [s, x] of keys) {
        if ((planned.layout.edges[s] ?? []).includes(x)) t.walledStillInEdges += 1;
        if (!(planned.layout.layoutEdges[s] ?? []).includes(x)) t.walledNotInLayoutEdges += 1;
        if ((planned.layout.stubEdges?.[s] ?? []).includes(x)) t.walledAlsoStub += 1;
        if (scene.walls.some((w) => w.door && w.flags?.[MODULE_ID]?.dungeonDoorFromRoomId === s
          && (w.flags[MODULE_ID].dungeonDoorToRoomId === x || w.flags[MODULE_ID].dungeonRevealDoorForSlot === x))) t.walledStillBuilt += 1;
      }
    }
    expect(t.deadLeft).toBe(0);
    expect(t.sealedProgressionDoors).toBe(0);
    // Door re-slotting after a wall can kill an edge that was walkable: the plan reports it (`lost`) and the reseed rejects it.
    expect(t.regress).toBe(t.lostFlagged);
    // No new overlaps or uncovered doors: the walled scene only removes corridors and doors.
    expect(t.dupAfter).toBeLessThanOrEqual(t.dupBefore);
    expect(t.inRoomAfter).toBeLessThanOrEqual(t.inRoomBefore);
    expect(t.doorMismatchAfter).toBeLessThanOrEqual(t.doorMismatchBefore);
    expect(t.walledStillInEdges).toBe(0);
    expect(t.walledNotInLayoutEdges).toBe(0);
    expect(t.walledAlsoStub).toBe(0);
    expect(t.walledStillBuilt).toBe(0);
    expect(t.goalLostAfter).toBeLessThanOrEqual(t.goalLostBefore);
    // Measured: 1279 walls in 313 dungeons (max 15); 2 more than the static count of dead edges after the stub plan (1277)
    // because walling re-slots siblings and kills 2 more; goal-unreachable dungeons 271 -> 266 (the stubs' doing).
    expect([t.walled, t.walledDungeons, t.maxWalled, t.lostFlagged]).toEqual([1279, 313, 15, 1]);
    // Against the shipped (stubs, dead edges built) scene: corridor tiles sharing a cell, tiles inside a room
    // (the dead edges' straight-line fallback corridors are gone), uncovered progression doors 130 -> 0.
    // #823 re-pin (tile identity only): the scene now lays ONE corridor tile per distinct cell (a cross-corridor guard
    // plus per-corridor dedup), so cells holding stacked tiles drop 15066 -> 19 (shipped scene; all 19 are the documented
    // keepOne case, two crossings of one cell that must each keep a marker tile) and 5437 -> 0 (walled scene), and tiles inside some room's rect drop 7909 -> 6163 / 2572 -> 1987 (the duplicates that sat in rooms
    // are gone; the single overshoot tile per cell stays, deliberately out of scope). doorMismatch (130 -> 0) reads
    // walls/doors only, so it is unchanged; so are the walled/lost counts above.
    expect([t.dupBefore, t.dupAfter, t.inRoomBefore, t.inRoomAfter, t.doorMismatchBefore, t.doorMismatchAfter])
      .toEqual([19, 0, 6163, 1987, 130, 0]);
    expect([t.unreachBefore, t.unreachAfter, t.goalLostBefore, t.goalLostAfter]).toEqual([2305, 2259, 271, 266]);
  }, 900000);
});
