// #490: sealed gate/reveal doors make real rooms (sometimes the goal) unreachable. Root cause, measured here:
// a merge room's ONE incoming gate cell (north, rank-1) can be held by a co-parent, so every OTHER parent has
// no free route (findCorridorPath returns null) and buildEdgeCorridor draws its straight-line fallback through
// the co-parent's room; the co-parent's own cell-margin wall (same line as the merge room's north face) then
// covers the second parent's door. Ratchets only fall; the acceptance target is 0 (see the todo).
import { describe, it, expect } from 'vitest';
import { buildSweepScene, buildSceneForLayout, sealedEdgeReport, corridorLineBlockers, sceneValidity, layoutValidity } from './helpers/scene-oracle.mjs';
import { buildSweepLayout } from './helpers/layout-sweep.mjs';

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

  // Why "cut an opening in the co-parent's margin wall" is NOT a fix: the gate-held fallback corridor is a
  // door-to-door L drawn through other rooms' cells. Its center line crosses ~13 solid walls on average (other
  // rooms' cell-margin walls, other corridors' walls, and, for ~43%, a room's own enclosure walls). Unsealing the
  // door alone leaves every one of these edges unwalkable. If a fix ever makes the line walkable this test must
  // be flipped to the new numbers (never loosened without that).
  it('documents that no gate-held fallback corridor line is walkable end to end (unsealing the door is not enough)', async () => {
    let edges = 0;
    let walkable = 0;
    let withEnclosure = 0;
    for (let i = 0; i < SEEDS; i += 1) {
      const { layout, scene } = await buildSweepScene(i, 3);
      const r = sealedEdgeReport(layout, scene);
      for (const e of r.sealedEdges.filter((x) => !x.hidden && x.cause === 'noPathGateHeld')) {
        const blockers = corridorLineBlockers(scene, e);
        edges += 1;
        if (!blockers.length) walkable += 1;
        if (blockers.some((b) => b.kind === 'EnclosureWall')) withEnclosure += 1;
      }
    }
    expect(edges).toBe(V3_SEALED_GATE_HELD);
    expect(walkable).toBe(0);
    expect(withEnclosure).toBe(197);
  }, 180000);

  it.todo('target: 0 sealed real edges and 0 goal-unreachable dungeons over 500 seeds (needs the #490 routing fix)');
});

// #490 reject-and-reseed PROTOTYPE, measured and NOT shipped (see the issue): derive seed_k = `${seed}~r${k}`
// (k = 1..N) until the pure-layout check passes (goal + every real room reachable over non-null-path real edges).
// Findings over 500 bases, layoutVersion 3: validity is bought almost entirely by dropping secret detour rooms
// (they hold other rooms' gate cells), so shipping it would nearly disable that feature. Numbers are exact and
// deterministic; if the layout generator changes they will move, update them with the new measurement.
describe('reject-and-reseed prototype (#490, measured, not shipped)', () => {
  const BASES = 500;
  const N = 10;
  const pureOk = (L) => { const v = layoutValidity(L); return v.goalReachable && v.unreachable.length === 0; };
  const sceneOk = (v) => v.goalReachable && v.unreachable.length === 0;

  it('pure-layout predicate: N=10 reseed outcome, and the secret-room skew it causes', async () => {
    const t = { pureInvalid: 0, sceneInvalid: 0, goalLost: 0, baseHidden: 0, acceptedHidden: 0, baseSceneValid: 0, tries: 0 };
    for (let i = 0; i < BASES; i += 1) {
      const base = buildSweepLayout(i, { layoutVersion: 3 });
      if (base.hiddenRooms.length > 0) t.baseHidden += 1;
      let chosen = base;
      let used = 1;
      for (let k = 1; !pureOk(chosen) && k <= N; k += 1) {
        chosen = buildSweepLayout(i, { layoutVersion: 3, seed: `sweep-${i}~r${k}` });
        used = k + 1;
      }
      t.tries += used;
      if (!pureOk(chosen)) t.pureInvalid += 1;
      if (chosen.hiddenRooms.length > 0) t.acceptedHidden += 1;
      const sv = sceneValidity(chosen, (await buildSceneForLayout(chosen, 3)).scene);
      if (!sceneOk(sv)) t.sceneInvalid += 1;
      if (!sv.goalReachable) t.goalLost += 1;
      if (sceneOk(sceneValidity(base, (await buildSceneForLayout(base, 3)).scene))) t.baseSceneValid += 1;
    }
    // Base seeds: only ~41% are scene-valid under "null-path fallback = dead edge".
    expect(t.baseSceneValid).toBeLessThan(BASES * 0.45);
    // After the reseed the PURE check is satisfied for all but the leftover few ...
    expect(t.pureInvalid).toBeLessThanOrEqual(2);
    // ... but the scene-level oracle still finds sealed doors the pure check cannot see.
    expect(t.sceneInvalid).toBeLessThanOrEqual(45);
    expect(t.goalLost).toBeLessThanOrEqual(27);
    // The skew: dungeons with at least one secret detour room fall from ~2/3 to ~1/4.
    expect(t.baseHidden).toBeGreaterThan(BASES * 0.6);
    expect(t.acceptedHidden).toBeLessThan(BASES * 0.3);
    expect(t.tries / BASES).toBeLessThan(2.6);
  }, 240000);
});
