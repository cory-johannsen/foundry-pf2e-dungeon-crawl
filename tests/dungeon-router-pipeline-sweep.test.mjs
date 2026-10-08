// #427: the topology router in the shipped v3 pipeline (reseed N = 20 over router -> stubs -> dead-edge walls), 500 seeds,
// judged by the TEST-SIDE oracles (tests/helpers/pipeline-measure.mjs: the union oracle = truth OR walkability).
// The numbers are exact and deterministic; if the generator or the router changes they move: re-measure with
//   node tests/helpers/pipeline-measure.mjs 500 1     (routed)      node tests/helpers/pipeline-measure.mjs 500 0   (unrouted)
// and update them (never loosen a ratchet without a recorded reason).
import { describe, it, expect } from 'vitest';
import { measureSeed, summarize } from './helpers/pipeline-measure.mjs';

const SEEDS = 500;

// The same 500 seeds through the same pipeline WITHOUT routing (a v3 run created before the router), measured on main.
// #906 re-measure (unreachable detours dropped from every v3 layout): was baseDead 1952, baseFoundDead 419, stubs 1466,
// walls 495, unreachableNonGoalRooms 463, roomsWith2PlusLiveExits 1052, dungeonsWith2Plus 479, reachableRooms 6978,
// deadEndRooms 1145, reseedTriesTotal 654.
const UNROUTED = {
  baseDead: 1978, baseFoundDead: 428, stubs: 1495, walls: 496, unreachableNonGoalRooms: 480, roomsWith2PlusLiveExits: 1072,
  dungeonsWith2Plus: 482, reachableRooms: 6961, deadEndRooms: 1166, reseedTriesTotal: 499,
};

describe('v3 pipeline with topology routing (500 seeds, reseed N = 20, union oracle)', () => {
  const records = [];
  let total;
  it('runs the pipeline', async () => {
    for (let i = 0; i < SEEDS; i += 1) records.push(await measureSeed(i, { topologyRouting: true }));
    total = summarize(records);
    expect(total.dungeons).toBe(SEEDS);
  }, 1_800_000);

  it('K6: every dungeon finishable, no dead edge left, no sealed progression door, every door has its corridor', () => {
    expect(total.goalReachable).toBe(SEEDS);
    expect(total.reseedExhausted).toBe(0);
    expect(total.deadLeft).toBe(0);
    expect(total.sealedProgression).toBe(0);
    expect(total.doorMismatch).toBe(0);
    // No edge the router could not place survives in the final graph (it would be a fallback line through rooms).
    expect(total.liveUnresolvable).toBe(0);
  });

  it('the reseed numbers are those of the unrouted pipeline (routing does not cost candidates)', () => {
    expect(total.reseedTriesTotal).toBe(UNROUTED.reseedTriesTotal);
    expect([total.reseedFirstTry, total.reseedMaxTries]).toEqual([260, 12]); // #906: was [234, 18]
  });

  it('routing leaves fewer dead edges, fewer walls, fewer lost rooms and more branching than not routing', () => {
    expect(total.baseDead).toBeLessThan(UNROUTED.baseDead);
    expect(total.baseFoundDead).toBeLessThan(UNROUTED.baseFoundDead);
    expect(total.walls).toBeLessThan(UNROUTED.walls);
    expect(total.stubs).toBeLessThanOrEqual(UNROUTED.stubs);
    expect(total.unreachableNonGoalRooms).toBeLessThan(UNROUTED.unreachableNonGoalRooms);
    expect(total.roomsWith2PlusLiveExits).toBeGreaterThan(UNROUTED.roomsWith2PlusLiveExits);
    expect(total.dungeonsWith2Plus).toBeGreaterThanOrEqual(UNROUTED.dungeonsWith2Plus);
    expect(total.reachableRooms).toBeGreaterThan(UNROUTED.reachableRooms);
  });

  it('pins the measured routed numbers', () => {
    // #906 (unreachable detours dropped; 155 fewer reseeds, so many dungeons are a different accepted candidate): was
    // [8557, 1704, 171], [1466, 250], [1171, 483, 1288], [7232, 209, 7441]; router edges 8775, multi 1941,
    // placedFirst 1769, rerouted 32, unresolvable 140, tries 4265, baseCells 4630, extraCells 62, firstHopChanged 17.
    expect([total.realEdges, total.baseDead, total.baseFoundDead]).toEqual([8558, 1723, 173]);
    expect([total.stubs, total.walls]).toEqual([1495, 242]);
    expect([total.roomsWith2PlusLiveExits, total.dungeonsWith2Plus, total.deadEndRooms]).toEqual([1190, 484, 1312]);
    expect([total.reachableRooms, total.unreachableNonGoalRooms, total.rooms]).toEqual([7225, 216, 7441]);
    expect(total.router).toEqual({
      edges: 8751, multi: 1973, placedFirst: 1797, rerouted: 34, unresolvable: 142, tries: 4414, baseCells: 4677, extraCells: 68,
      firstHopChanged: 20, lastHopChanged: 0, unresolvableIds: 142,
    });
  });
});
