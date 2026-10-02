// #427 Chunk 6: stub entries in the outgoing door plan and the stub filters of the incoming helpers.
import { describe, it, expect } from 'vitest';
import {
  outgoingDoorPlan, incomingConnectionsFor, incomingSlotsV3, isStubEdge, applyStubsToEdges, pendingForeignMarginOpenings,
} from '../scripts/dungeon-layout.mjs';

describe('stub entries in outgoingDoorPlan', () => {
  const rect = { gx: 300, gy: 13, gw: 6, gh: 6 };
  const P = (rank, col) => ({ rank, col });
  const pos = { rank: 1, col: 2 };

  it('without stubChildIds the plan is unchanged (byte-identical)', () => {
    const t = { a: P(3, 0), b: P(3, 2) };
    const base = outgoingDoorPlan(rect, pos, { realChildIds: ['a', 'b'], hiddenChildIds: [] }, t);
    const withEmpty = outgoingDoorPlan(rect, pos, { realChildIds: ['a', 'b'], hiddenChildIds: [], stubChildIds: [] }, t);
    expect([...withEmpty.entries()]).toEqual([...base.entries()]);
  });

  it('a stub always takes a south slot with its own door span, even alone', () => {
    const plan = outgoingDoorPlan(rect, pos, { realChildIds: [], hiddenChildIds: [], stubChildIds: ['s'] }, { s: P(3, 4) });
    const s = plan.get('s');
    expect(s).toMatchObject({ face: 'south', stub: true, doorCount: 1 });
    expect(s.doorSpan).toEqual({ x1: s.exitPoint.x, y1: 19, x2: s.exitPoint.x + 1, y2: 19 });
  });

  it('a stub shares the south face with a sibling: disjoint spans, ordered by the stub target column', () => {
    const t = { r: P(3, 2), s: P(3, 0) };
    const plan = outgoingDoorPlan(rect, pos, { realChildIds: ['r'], hiddenChildIds: [], stubChildIds: ['s'] }, t);
    expect(plan.get('s').slotIndex).toBe(0); // lower target column first
    expect(plan.get('r').slotIndex).toBe(1);
    expect(plan.get('r').doorCount).toBe(2);
    expect(plan.get('s').doorSpan.x2).toBeLessThanOrEqual(plan.get('r').doorSpan.x1);
    expect(plan.get('r').stub).toBeUndefined();
  });

  it('a stub whose target is east of the source still sits on the south face', () => {
    const plan = outgoingDoorPlan(rect, pos, { realChildIds: ['e'], hiddenChildIds: [], stubChildIds: ['s'] }, { e: P(2, 4), s: P(2, 5) });
    expect(plan.get('s').face).toBe('south');
    expect(plan.get('e').face).toBe('east');
  });

  it('is independent of stub order', () => {
    const t = { s1: P(3, 0), s2: P(3, 1), r: P(3, 2) };
    const one = outgoingDoorPlan(rect, pos, { realChildIds: ['r'], stubChildIds: ['s1', 's2'] }, t);
    const two = outgoingDoorPlan(rect, pos, { realChildIds: ['r'], stubChildIds: ['s2', 's1'] }, t);
    expect([...one.entries()].sort()).toEqual([...two.entries()].sort());
  });
});

describe('stub filters (incomingConnectionsFor, incomingSlotsV3, applyStubsToEdges)', () => {
  const layoutEdges = { 'room-entry': ['a', 'b'], a: ['m'], b: ['m'], m: ['room-goal'] };
  const hiddenIncoming = { m: ['c'] };

  it('isStubEdge reads { source: [targets] }', () => {
    expect(isStubEdge({ a: ['m'] }, 'a', 'm')).toBe(true);
    expect(isStubEdge({ a: ['m'] }, 'b', 'm')).toBe(false);
    expect(isStubEdge(undefined, 'a', 'm')).toBe(false);
  });

  it('incomingConnectionsFor without the 4th argument is unchanged; with it drops real and hidden stub sources', () => {
    const base = incomingConnectionsFor(layoutEdges, 'm', hiddenIncoming);
    expect(base.map((c) => c.sourceId)).toEqual(['a', 'b', 'c']);
    expect(incomingConnectionsFor(layoutEdges, 'm', hiddenIncoming, undefined)).toEqual(base);
    expect(incomingConnectionsFor(layoutEdges, 'm', hiddenIncoming, {})).toEqual(base);
    expect(incomingConnectionsFor(layoutEdges, 'm', hiddenIncoming, { a: ['m'], c: ['m'] }).map((c) => c.sourceId)).toEqual(['b']);
    // a stub toward some other room does not remove this room's connection
    expect(incomingConnectionsFor(layoutEdges, 'm', hiddenIncoming, { a: ['room-goal'] })).toEqual(base);
  });

  it('applyStubsToEdges removes only real stub edges and never mutates', () => {
    const edges = { a: ['m', 'x'], b: ['m'] };
    const snap = JSON.stringify(edges);
    expect(applyStubsToEdges(edges, { a: ['m'] })).toEqual({ a: ['x'], b: ['m'] });
    expect(applyStubsToEdges(edges, undefined)).toEqual(edges);
    expect(JSON.stringify(edges)).toBe(snap);
  });

  it('pendingForeignMarginOpenings skips a hidden stub (a dead end routes no dogleg through the blocker)', () => {
    const seed = 'dogleg-repro-seed-0';
    const fromId = 'from-room'; const toId = 'to-room'; const blockId = 'blocker-room';
    const pos = { [fromId]: { rank: 0, col: 0 }, [blockId]: { rank: 1, col: 0 }, [toId]: { rank: 2, col: 0 } };
    const edges = { [fromId]: [blockId] };
    const hiddenEdges = { [fromId]: [toId] };
    const hiddenIncoming = { [toId]: [fromId] };
    const occ = { '0,0': fromId, '1,0': blockId, '2,0': toId };
    const inc = { [toId]: 'north', [blockId]: 'north' };
    const planFor = (id) => (id === fromId ? new Map([[blockId, { face: 'south', exitPoint: null, doorSpan: null }], [toId, { face: 'south', exitPoint: null, doorSpan: null }]]) : null);
    const live = pendingForeignMarginOpenings(seed, blockId, 1, 0, edges, pos, inc, occ, edges, hiddenIncoming, hiddenEdges, planFor);
    expect(live.south.length).toBe(1);
    const stubbed = pendingForeignMarginOpenings(
      seed, blockId, 1, 0, edges, pos, inc, occ, edges, hiddenIncoming, hiddenEdges, planFor, false, { [fromId]: [toId] },
    );
    expect(stubbed.south).toEqual([]);
  });

  it('incomingSlotsV3 gives a room with a stubbed parent one slot fewer', () => {
    const pos = { 'room-entry': { rank: 0, col: 0 }, a: { rank: 1, col: 0 }, b: { rank: 1, col: 2 }, m: { rank: 2, col: 0 }, c: { rank: 1, col: 4 } };
    const occ = Object.fromEntries(Object.entries(pos).map(([id, p]) => [`${p.rank},${p.col}`, id]));
    const common = { layoutEdges, hiddenIncomingByRoomId: {}, positionByRoomId: pos, occupiedCells: occ, incomingFace: 'north' };
    expect(incomingSlotsV3('s', 'm', pos.m, common)).toHaveLength(2);
    const stubbed = incomingSlotsV3('s', 'm', pos.m, { ...common, stubEdges: { a: ['m'] } });
    expect(stubbed.map((c) => c.sourceId)).toEqual(['b']);
  });
});
