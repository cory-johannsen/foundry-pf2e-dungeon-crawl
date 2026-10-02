// #427 Chunk 7: the oracle-aware stub planner's pure pieces (scripts/dungeon-stub-oracle.mjs, scripts/dungeon-layout.mjs)
// and their agreement with the test-side oracles (tests/helpers/walkability-oracle.mjs, stub-union.mjs).
import { describe, it, expect } from 'vitest';
import { filterStubsByLiveReach, planStubsForLayout, stubStateFor, planStubs } from '../scripts/dungeon-layout.mjs';
import { deadEdgeSets, verdictsOf, regressesAny, SEMANTICS } from '../scripts/dungeon-stub-oracle.mjs';
import { buildSweepLayout } from './helpers/layout-sweep.mjs';
import { buildSceneForLayout } from './helpers/scene-oracle.mjs';
import { stubInputsFor } from './helpers/stub-sweep.mjs';
import { unionReports } from './helpers/stub-union.mjs';

const rooms = { 'room-entry': {}, a: {}, b: {}, 'room-goal': { isGoal: true } };

describe('filterStubsByLiveReach (rule 3\')', () => {
  const edges = { 'room-entry': ['a', 'b'], a: ['room-goal'], b: ['room-goal'] };
  it('keeps a stub on a dead edge when the live reach does not shrink', () => {
    const out = filterStubsByLiveReach({ edges, stubEdges: { b: ['room-goal'] }, deadKeys: new Set(['b->room-goal']) });
    expect(out).toEqual({ b: ['room-goal'] });
  });
  it('drops a stub on a LIVE edge that is the only way to a room', () => {
    const out = filterStubsByLiveReach({ edges, stubEdges: { a: ['room-goal'], b: ['room-goal'] }, deadKeys: new Set() });
    // canonical order (target id, source id): a->goal is kept first, then b->goal would orphan the goal
    expect(out).toEqual({ a: ['room-goal'] });
  });
  it('a stub whose edge is dead and whose target is reached another way never shrinks reach', () => {
    const out = filterStubsByLiveReach({ edges, stubEdges: { a: ['room-goal'] }, deadKeys: new Set(['a->room-goal']) });
    expect(out).toEqual({ a: ['room-goal'] });
  });
  it('keeps hidden-shortcut stubs the caller marks as exempt', () => {
    const out = filterStubsByLiveReach({ edges, stubEdges: { a: ['room-goal'], b: ['room-goal'] }, deadKeys: new Set(), exempt: new Set(['b->room-goal']) });
    expect(out).toEqual({ a: ['room-goal'], b: ['room-goal'] });
  });
});

describe('regressesAny / SEMANTICS', () => {
  const v = (goal, unreachable = []) => ({ goal, unreachable });
  const same = () => Object.fromEntries(SEMANTICS.map((s) => [s, v(true)]));
  it('names the four semantics', () => expect(SEMANTICS).toEqual(['opt', 'strict', 'truth', 'union']));
  it('is false when nothing is lost', () => expect(regressesAny(same(), same())).toBe(false));
  it('is true when any semantics loses the goal or a reachable room', () => {
    expect(regressesAny(same(), { ...same(), truth: v(false) })).toBe(true);
    expect(regressesAny(same(), { ...same(), union: v(true, ['x']) })).toBe(true);
  });
  it('a room that was already unreachable is not a regression', () => {
    const base = { ...same(), opt: v(true, ['x']) };
    expect(regressesAny(base, { ...base })).toBe(false);
    expect(regressesAny(base, { ...base, opt: v(true, ['x', 'y']) })).toBe(true);
  });
});

describe('planStubsForLayout with deadEdges (walkability union as the dead-edge definition)', () => {
  it('without deadEdges the plan is unchanged (null-path candidates)', () => {
    const L = buildSweepLayout(3, { layoutVersion: 3 });
    const a = planStubsForLayout({ ...stubInputsFor(L), retreatAvailable: true });
    const b = planStubsForLayout({ ...stubInputsFor(L), retreatAvailable: true, deadEdges: undefined });
    expect(b.stubEdges).toEqual(a.stubEdges);
  });
  it('with deadEdges only those real edges (plus hidden null links) are candidates, and a found-path dead edge can be stubbed', () => {
    let foundPathStub = 0;
    for (let i = 0; i < 40; i += 1) {
      const L = buildSweepLayout(i, { layoutVersion: 3 });
      const nulls = planStubsForLayout({ ...stubInputsFor(L), retreatAvailable: true });
      const nullKeys = new Set(nulls.nullEdges.filter((e) => !e.hidden).map((e) => `${e.sourceId}->${e.toId}`));
      // every real edge dead: the planner may stub any of them, and only real edges that are dead
      const all = Object.entries(L.edges).flatMap(([s, ts]) => ts.map((t) => ({ sourceId: s, toId: t })));
      const plan = planStubsForLayout({ ...stubInputsFor(L), retreatAvailable: true, deadEdges: all });
      for (const [s, ts] of Object.entries(plan.stubEdges)) for (const t of ts) if (!nullKeys.has(`${s}->${t}`) && L.edges[s]?.includes(t)) foundPathStub += 1;
    }
    expect(foundPathStub).toBeGreaterThan(0);
  });
  it('stubStateFor passes deadEdges through and stays stub-free below layoutVersion 3', () => {
    let stubbed = 0;
    for (let i = 0; i < 12; i += 1) {
      const L = buildSweepLayout(i, { layoutVersion: 3 });
      const all = Object.entries(L.edges).flatMap(([s, ts]) => ts.map((t) => ({ sourceId: s, toId: t })));
      expect('stubEdges' in stubStateFor(2, stubInputsFor(L), { retreatAvailable: true, deadEdges: all })).toBe(false);
      expect('stubEdges' in stubStateFor(1, stubInputsFor(L), { retreatAvailable: true, deadEdges: all })).toBe(false);
      stubbed += Object.keys(stubStateFor(3, stubInputsFor(L), { retreatAvailable: true, deadEdges: all }).stubEdges).length;
    }
    expect(stubbed).toBeGreaterThan(0);
  });
});

describe('deadEdgeSets (product) = test-side oracles', () => {
  it('opt / strict / truth / union dead sets and verdicts equal the test oracles over 60 seeds', async () => {
    for (let i = 0; i < 60; i += 1) {
      const L = buildSweepLayout(i, { layoutVersion: 3 });
      const { scene } = await buildSceneForLayout(L, 3);
      const R = unionReports(L, scene);
      const runLayout = {
        seed: L.seed, rooms: L.rooms, edges: L.edges, hiddenEdges: L.hiddenEdges, hiddenRooms: L.hiddenRooms,
        layoutPositionByRoomId: L.pos, incomingFaceByRoomId: L.incFace, occupiedCells: L.occ,
      };
      const sets = deadEdgeSets(runLayout, scene);
      expect([i, [...sets.union].sort()]).toEqual([i, [...R.union.dead].sort()]);
      expect([i, [...sets.opt].sort()]).toEqual([i, [...R.sealed].sort()]);
      const v = verdictsOf(runLayout, sets);
      for (const s of SEMANTICS) expect([i, s, v[s].goal, [...v[s].unreachable].sort()]).toEqual([i, s, R[s].goal, [...R[s].unreachable].sort()]);
    }
  }, 120000);
});

describe('planStubs is untouched when called without the union (guard)', () => {
  it('still refuses a sole-child source without retreat', () => {
    const edges = { 'room-entry': ['a'], a: ['b'], b: ['room-goal'] };
    const r = planStubs({ rooms, edges, layoutEdges: edges, nullEdges: [{ sourceId: 'a', toId: 'b', hidden: false }], retreatAvailable: false });
    expect(r.stubEdges).toEqual({});
  });
});
