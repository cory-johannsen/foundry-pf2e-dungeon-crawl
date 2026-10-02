// #427 Chunk 6 (dead-end stubs). Pure planner tests first; geometry and sweep acceptance below.
import { describe, it, expect } from 'vitest';
import { planStubs } from '../scripts/dungeon-layout.mjs';

const room = (id, extra = {}) => ({ id, kind: 'combat', ...extra });
const rooms = {
  'room-entry': room('room-entry'), a: room('a'), b: room('b'), c: room('c'), m: room('m'),
  'room-goal': room('room-goal', { isGoal: true }),
};
const nul = (sourceId, toId, hidden = false) => ({ sourceId, toId, hidden });
const plan = (over) => planStubs({
  rooms, edges: {}, layoutEdges: {}, hiddenEdges: {}, hiddenIncomingByRoomId: {}, nullEdges: [], ...over,
});

describe('planStubs (#427 rules 1-3)', () => {
  it('never stubs the only child of a source while retreat is unavailable (soft-lock)', () => {
    const edges = { 'room-entry': ['a', 'b'], a: ['m'], b: ['m'], m: ['room-goal'], 'room-goal': [] };
    const { stubEdges } = plan({ edges, layoutEdges: edges, nullEdges: [nul('a', 'm')] });
    expect(stubEdges).toEqual({});
  });

  it('stubs that same sole-child source when retreatAvailable is true, target keeps its routable parent', () => {
    const edges = { 'room-entry': ['a', 'b'], a: ['m'], b: ['m'], m: ['room-goal'], 'room-goal': [] };
    const { stubEdges } = plan({ edges, layoutEdges: edges, nullEdges: [nul('a', 'm')], retreatAvailable: true });
    expect(stubEdges).toEqual({ a: ['m'] });
  });

  it('stubs a real null edge whose source keeps another child and whose target keeps a routable parent', () => {
    const edges = { 'room-entry': ['a', 'b'], a: ['m', 'c'], b: ['m'], c: ['room-goal'], m: ['room-goal'], 'room-goal': [] };
    const { stubEdges } = plan({ edges, layoutEdges: edges, nullEdges: [nul('a', 'm')] });
    expect(stubEdges).toEqual({ a: ['m'] });
  });

  it('stubs a hidden shortcut whose source has real children (m keeps its real parent)', () => {
    const edges = { 'room-entry': ['a'], a: ['b'], b: ['m'], m: ['room-goal'], 'room-goal': [] };
    const hiddenEdges = { a: ['m'] };
    const hiddenIncomingByRoomId = { m: ['a'] };
    const { stubEdges } = plan({
      edges, layoutEdges: edges, hiddenEdges, hiddenIncomingByRoomId, nullEdges: [nul('a', 'm', true)],
    });
    expect(stubEdges).toEqual({ a: ['m'] });
  });

  it('never stubs a hidden link into a detour room (its only incoming would be orphaned)', () => {
    const edges = { 'room-entry': ['a'], a: ['m'], m: ['room-goal'], d: ['m'], 'room-goal': [] };
    const layoutEdges = { ...edges, a: ['m', 'd'] };
    const rms = { ...rooms, d: room('d') };
    const { stubEdges } = planStubs({
      rooms: rms, edges, layoutEdges, hiddenEdges: { a: ['d'] }, hiddenIncomingByRoomId: {},
      nullEdges: [nul('a', 'd', true)],
    });
    expect(stubEdges).toEqual({});
  });

  it('never stubs the last routable parent of a target: both parents null keeps the canonical first', () => {
    const edges = { 'room-entry': ['a', 'b'], a: ['m', 'c'], b: ['m', 'c'], c: ['room-goal'], m: ['room-goal'], 'room-goal': [] };
    const { stubEdges } = plan({ edges, layoutEdges: edges, nullEdges: [nul('b', 'm'), nul('a', 'm')] });
    // a -> m is canonical first (kept connecting), b -> m may stub: b keeps c.
    expect(stubEdges).toEqual({ b: ['m'] });
  });

  it('refuses a stub that would strand the goal or a room (rule 3)', () => {
    // m is only reachable through a -> m; a also has a (routable) second child, so rule 2 passes, but m has no
    // other parent at all, so rule 1 refuses it; and a hidden-looking null into the goal is refused the same way.
    const edges = { 'room-entry': ['a'], a: ['m', 'c'], c: ['room-goal'], m: ['room-goal'], 'room-goal': [] };
    expect(plan({ edges, layoutEdges: edges, nullEdges: [nul('a', 'm')] }).stubEdges).toEqual({});
    expect(plan({ edges, layoutEdges: edges, nullEdges: [nul('c', 'room-goal'), nul('m', 'room-goal')] }).stubEdges).toEqual({});
  });

  it('is order independent (shuffled edge, room and null order give the same plan)', () => {
    const edges = { 'room-entry': ['a', 'b'], a: ['m', 'c'], b: ['m', 'c'], c: ['room-goal'], m: ['room-goal'], 'room-goal': [] };
    const nulls = [nul('b', 'm'), nul('a', 'm'), nul('a', 'c')];
    const forward = plan({ edges, layoutEdges: edges, nullEdges: nulls });
    const rev = Object.fromEntries(Object.entries(edges).reverse().map(([k, v]) => [k, [...v].reverse()]));
    const backward = planStubs({
      rooms: Object.fromEntries(Object.entries(rooms).reverse()), edges: rev, layoutEdges: rev,
      hiddenEdges: {}, hiddenIncomingByRoomId: {}, nullEdges: [...nulls].reverse(),
    });
    expect(backward).toEqual(forward);
    expect(JSON.stringify(Object.entries(backward.stubEdges).sort())).toBe(JSON.stringify(Object.entries(forward.stubEdges).sort()));
  });

  it('does not mutate its inputs', () => {
    const edges = { 'room-entry': ['a', 'b'], a: ['m', 'c'], b: ['m'], c: ['room-goal'], m: ['room-goal'], 'room-goal': [] };
    const snap = JSON.stringify(edges);
    plan({ edges, layoutEdges: edges, nullEdges: [nul('a', 'm')] });
    expect(JSON.stringify(edges)).toBe(snap);
  });
});
