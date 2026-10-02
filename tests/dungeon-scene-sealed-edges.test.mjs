// #490: sealed gate/reveal doors make real rooms (sometimes the goal) unreachable. Root cause, measured here:
// a merge room's ONE incoming gate cell (north, rank-1) can be held by a co-parent, so every OTHER parent has
// no free route (findCorridorPath returns null) and buildEdgeCorridor draws its straight-line fallback through
// the co-parent's room; the co-parent's own cell-margin wall (same line as the merge room's north face) then
// covers the second parent's door. Ratchets only fall; the acceptance target is 0 (see the todo).
import { describe, it, expect } from 'vitest';
import { buildSweepScene, sealedEdgeReport } from './helpers/scene-oracle.mjs';

const SEEDS = 200;
// layoutVersion 3 (shipped), measured over sweep-0..199. v2 for reference: 737 / 491 / 13 / 497 / 100 / 78.
const V3_SEALED_REAL_EDGES = 580;
const V3_SEALED_GATE_HELD = 460; // null path because a co-parent holds the gate cell: the dominant cause
const V3_SEALED_SOLE_INCOMING = 13; // real edge that is its target's only incoming edge (true soft-locks)
const V3_UNREACHABLE_ROOMS = 165;
const V3_DUNGEONS_WITH_UNREACHABLE = 44;
const V3_GOAL_UNREACHABLE = 14;

describe('sealed edges: the live repro (#490)', () => {
  it('sweep-0: room-merge-3\'s second parent is sealed because its co-parent holds the gate cell', async () => {
    const { layout, scene } = await buildSweepScene(0, 3);
    const report = sealedEdgeReport(layout, scene);
    const dead = report.sealedEdges.find((e) => e.to === 'room-merge-3');
    expect(dead).toMatchObject({ from: 'room-room-entry-1', cause: 'noPathGateHeld', sole: false, altOk: true });
    // The gate cell (rank 2, col 0) holds the co-parent, the other real parent of the merge room.
    expect(layout.occ['2,0']).toBe('room-room-room-entry-0-0');
    // Still reachable through the co-parent: the merge room is a dead edge, not a soft-lock, here.
    expect(report.unreachable).toEqual([]);
  });
});

describe('scene oracle: sealed edges and reachability (#490, layoutVersion 3)', () => {
  it('ratchets sealed real edges, unreachable rooms and goal locks down from the measured baseline', async () => {
    const t = { sealed: 0, gateHeld: 0, sole: 0, rooms: 0, dungeons: 0, goal: 0 };
    for (let i = 0; i < SEEDS; i += 1) {
      const { layout, scene } = await buildSweepScene(i, 3);
      const r = sealedEdgeReport(layout, scene);
      for (const e of r.sealedEdges.filter((x) => !x.hidden)) {
        t.sealed += 1;
        if (e.cause === 'noPathGateHeld') t.gateHeld += 1;
        if (e.sole) t.sole += 1;
      }
      t.rooms += r.unreachable.length;
      if (r.unreachable.length) t.dungeons += 1;
      if (!r.goalReachable) t.goal += 1;
    }
    expect(t.sealed).toBeLessThanOrEqual(V3_SEALED_REAL_EDGES);
    expect(t.gateHeld).toBeLessThanOrEqual(V3_SEALED_GATE_HELD);
    expect(t.sole).toBeLessThanOrEqual(V3_SEALED_SOLE_INCOMING);
    expect(t.rooms).toBeLessThanOrEqual(V3_UNREACHABLE_ROOMS);
    expect(t.dungeons).toBeLessThanOrEqual(V3_DUNGEONS_WITH_UNREACHABLE);
    expect(t.goal).toBeLessThanOrEqual(V3_GOAL_UNREACHABLE);
  }, 180000);

  it.todo('target: 0 sealed real edges and 0 goal-unreachable dungeons over 500 seeds (needs the #490 routing fix)');
});
