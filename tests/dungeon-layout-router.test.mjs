// #427 Chunk 3, Task 3.1: the pure topology-aware router (routeEdgesTopologyAware) and findCorridorPath's
// blockedCells option. See docs/superpowers/specs/2026-10-01-topology-aware-corridor-routing-design.md.
import { describe, it, expect } from 'vitest';
import {
  routeEdgesTopologyAware, makeLanePlacer, makeRoutingFor, findCorridorPath, cellBounds, COLUMN_STRIDE,
  buildEdgeCorridor, outgoingMarginOffset, roomRect,
} from '../scripts/dungeon-layout.mjs';
import { buildSweepLayout } from './helpers/layout-sweep.mjs';
import { fixtureInputs, routerInputsFor, checkLanes } from './helpers/router-layout.mjs';

const SEEDS = 500;

describe('findCorridorPath blockedCells (#427)', () => {
  const from = { rank: 0, col: 0 };
  const to = { rank: 3, col: 0 };
  const opts = { fromRoomId: 'a', toRoomId: 'b', incomingFace: 'north', exitFace: 'south' };
  it('is unchanged without the option (and with an empty one)', () => {
    const plain = findCorridorPath(from, to, {}, opts);
    expect(plain).toEqual([0, 1, 2, 3].map((rank) => ({ rank, col: 0 })));
    expect(findCorridorPath(from, to, {}, { ...opts, blockedCells: [] })).toEqual(plain);
    expect(findCorridorPath(from, to, {}, { ...opts, blockedCells: new Set() })).toEqual(plain);
  });
  it('detours around a blocked cell (array or Set of "rank,col") without touching occupiedCells', () => {
    const occ = {};
    const viaArray = findCorridorPath(from, to, occ, { ...opts, blockedCells: ['1,0'] });
    const viaSet = findCorridorPath(from, to, occ, { ...opts, blockedCells: new Set(['1,0']) });
    expect(viaArray).toEqual(viaSet);
    expect(viaArray.some((c) => c.rank === 1 && c.col === 0)).toBe(false);
    expect(viaArray.length).toBe(6);
    expect(viaArray.at(-2)).toEqual({ rank: 2, col: 0 }); // the incoming neighbor rule still holds
    expect(occ).toEqual({});
  });
  it('returns null when blocking removes every way in', () => {
    expect(findCorridorPath(from, to, {}, { ...opts, blockedCells: ['2,0'] })).toBeNull();
  });
});

describe('makeLanePlacer capacity (#427)', () => {
  const cell = cellBounds(1, 0);
  const straight = (id, x) => ({
    id, seed: 'cap', cells: [{ rank: 1, col: 0, entrySide: 'north', exitSide: 'south' }], c0: x, cn: x, baseline: [x],
  });
  it('14 straight crossings through one 13-wide border: 13 placed, the excess reported, never overlapped', () => {
    const placer = makeLanePlacer();
    const xs = Array.from({ length: 14 }, (_, i) => cell.gx + (i % COLUMN_STRIDE));
    const placed = xs.map((x, i) => placer.tryPlace(straight(`e${i}`, x)));
    expect(placed.filter(Boolean).length).toBe(13);
    expect(placed.filter((p) => !p).length).toBe(1);
  });
  it('eight corridors with distinct pinned coordinates all fit', () => {
    const placer = makeLanePlacer();
    expect(Array.from({ length: 8 }, (_, i) => placer.tryPlace(straight(`e${i}`, cell.gx + i))).every(Boolean)).toBe(true);
  });
});

describe('routeEdgesTopologyAware: hand-built grids (#427)', () => {
  const room = (rank, col) => ({ rank, col });
  const partition = (inputs, result) => {
    const ids = [];
    for (const toId of Object.keys(inputs.positionByRoomId)) for (const { sourceId } of inputs.slotsForRoom(toId)) ids.push(`${sourceId}->${toId}`);
    return ids;
  };

  it('two parents of one merge room get distinct lanes that never intersect', () => {
    const inputs = fixtureInputs(
      { p1: room(0, 0), p2: room(0, 1), m: room(3, 0) },
      { p1: ['m'], p2: ['m'] },
    );
    const result = routeEdgesTopologyAware(inputs);
    expect(result.unresolvable).toEqual([]);
    expect([...result.lanes.keys()].sort()).toEqual(['p1->m', 'p2->m']);
    const check = checkLanes(inputs.seed, result.lanes);
    expect(check.floorCrossings).toBe(0);
    expect(check.cutOccurrences).toBe(0);
  });

  it('a cell-local N-S vs W-E pair is never merged: one is re-routed around or reported unresolvable', () => {
    // a runs south through cell (1,0) to b; c runs west through cell (2,0)... both need (1,0): c (1,2) -> d (1,-1)? west exits are not
    // planned, so c goes east-free: c is placed so its path crosses a's column.
    const inputs = fixtureInputs(
      { a: room(0, 0), b: room(3, 0), c: room(1, -1), d: room(1, 1) },
      { a: ['b'], c: ['d'] },
    );
    const result = routeEdgesTopologyAware(inputs);
    const ids = partition(inputs, result);
    expect([...result.lanes.keys(), ...result.unresolvable].sort()).toEqual(ids.slice().sort());
    const check = checkLanes(inputs.seed, result.lanes);
    expect(check.floorCrossings).toBe(0);
    expect(check.cutOccurrences).toBe(0);
    // shortest routes would cross inside (1,0): at least one edge cannot keep its shortest path
    expect(result.blockedByEdge.size + result.unresolvable.length).toBeGreaterThan(0);
  });

  it('the sweep-10 pair (west to south over r0c1+r0c2, south to east) is not placed on both shortest paths, deterministically', () => {
    const layout = buildSweepLayout(10, { layoutVersion: 2 });
    const inputs = routerInputsFor(layout);
    const a = routeEdgesTopologyAware(inputs);
    const b = routeEdgesTopologyAware(inputs);
    expect(a).toEqual(b);
    const A = 'room-entry->room-room-entry-1';
    const B = 'room-room-room-entry-0-0->room-room-room-room-entry-0-0-2';
    // A (placed first, canonical order) keeps its path; B interleaves with it on r0c1+r0c2 and has no other way round.
    expect(a.lanes.has(A)).toBe(true);
    expect(a.blockedByEdge.has(A)).toBe(false);
    expect(a.lanes.has(B)).toBe(false);
    expect(a.unresolvable).toEqual([B]);
    const check = checkLanes(inputs.seed, a.lanes);
    expect(check.floorCrossings).toBe(0);
    expect(check.cutOccurrences).toBe(0);
  });

  it('is independent of key order: reversed layoutEdges and position maps give a deep-equal result', () => {
    const layout = buildSweepLayout(10, { layoutVersion: 2 });
    const inputs = routerInputsFor(layout);
    const rev = (o) => Object.fromEntries(Object.entries(o).reverse());
    const reversed = {
      ...inputs,
      layoutEdges: Object.fromEntries(Object.entries(rev(inputs.layoutEdges)).map(([k, v]) => [k, [...v].reverse()])),
      positionByRoomId: rev(inputs.positionByRoomId),
      occupiedCells: rev(inputs.occupiedCells),
      hiddenIncomingByRoomId: rev(inputs.hiddenIncomingByRoomId),
    };
    expect(routeEdgesTopologyAware(reversed)).toEqual(routeEdgesTopologyAware(inputs));
  });

  it('every lane entry carries its sides and absolute border points, chained cell to cell', () => {
    const inputs = fixtureInputs({ p1: room(0, 0), m: room(3, 0) }, { p1: ['m'] });
    const { lanes } = routeEdgesTopologyAware(inputs);
    const cells = [...lanes.get('p1->m').entries()];
    expect(cells.map(([k]) => k)).toEqual(['1,0', '2,0']);
    expect(cells[0][1]).toMatchObject({ entrySide: 'north', exitSide: 'south' });
    expect(cells[0][1].exitPoint).toEqual(cells[1][1].entryPoint);
  });
});

describe('buildEdgeCorridor routing parameter and makeRoutingFor (#427, layoutVersion 3)', () => {
  const pos = { p: { rank: 0, col: 0 }, m: { rank: 3, col: 0 } };
  const inputs = fixtureInputs(pos, { p: ['m'] });
  const seed = inputs.seed;
  const plan = inputs.planFor('p').get('m');
  const slot = inputs.slotsForRoom('m')[0].slot;
  const rect = (id) => roomRect(seed, id, pos[id].rank, pos[id].col);
  const build = (routing) => buildEdgeCorridor(seed, 'p', 'm', rect('p'), rect('m'), pos.p, pos.m, plan.face, slot, inputs.occupiedCells, 'north', plan, routing);

  it('no routing, an empty one and a routing with only undefined members build the same geometry', () => {
    const plain = build(undefined);
    expect(build({})).toEqual(plain);
    expect(build({ blockedCells: undefined, lanes: undefined })).toEqual(plain);
    expect(plain.transitCells.map((c) => `${c.rank},${c.col}`)).toEqual(['1,0', '2,0']);
  });
  it('lanes force each transit cell\'s entry and exit points', () => {
    const routed = routeEdgesTopologyAware(inputs);
    const lanes = routed.lanes.get('p->m');
    // move the chain's free coordinate is impossible (straight), so shift a corner chain: two parents with a corner
    const res = build({ lanes });
    expect(res.transitCells.map((c) => [c.entryPoint, c.exitPoint])).toEqual([...lanes.values()].map((l) => [l.entryPoint, l.exitPoint]));
  });
  it('a lane map on a corner chain is honoured cell by cell and the chain stays continuous', () => {
    const pos2 = { a: { rank: 0, col: 0 }, b: { rank: 2, col: 1 } };
    const inputs2 = fixtureInputs(pos2, { a: ['b'] });
    const routed = routeEdgesTopologyAware(inputs2);
    const lanes = routed.lanes.get('a->b');
    expect(lanes).toBeDefined();
    const r = (id) => roomRect(inputs2.seed, id, pos2[id].rank, pos2[id].col);
    const plan2 = inputs2.planFor('a').get('b');
    const res = buildEdgeCorridor(inputs2.seed, 'a', 'b', r('a'), r('b'), pos2.a, pos2.b, plan2.face, inputs2.slotsForRoom('b')[0].slot,
      inputs2.occupiedCells, 'north', plan2, { lanes });
    for (let i = 0; i + 1 < res.transitCells.length; i += 1) expect(res.transitCells[i].exitPoint).toEqual(res.transitCells[i + 1].entryPoint);
    expect(res.transitCells.map((c) => [c.entryPoint, c.exitPoint])).toEqual([...lanes.values()].map((l) => [l.entryPoint, l.exitPoint]));
  });
  it('blockedCells re-route the path; `unresolvable` draws the null-path fallback instead (no transit cells)', () => {
    const blocked = build({ blockedCells: ['1,0'] });
    expect(blocked.transitCells.some((c) => c.rank === 1 && c.col === 0)).toBe(false);
    const fallback = build({ unresolvable: true });
    expect(fallback.transitCells).toEqual([]);
    expect(fallback.corridorSegments.length).toBeGreaterThan(0);
  });
  it('makeRoutingFor: placed edges get { blockedCells, lanes }, unresolvable ones { unresolvable: true }, others undefined', () => {
    const routed = {
      lanes: new Map([['a->b', new Map([['1,0', {}]])], ['c->d', new Map([['1,1', {}]])]]),
      blockedByEdge: new Map([['c->d', ['1,0']]]), unresolvable: ['e->f'],
    };
    const routingFor = makeRoutingFor(routed);
    expect(routingFor('a->b')).toEqual({ blockedCells: undefined, lanes: routed.lanes.get('a->b') });
    expect(routingFor('c->d')).toEqual({ blockedCells: ['1,0'], lanes: routed.lanes.get('c->d') });
    expect(routingFor('e->f')).toEqual({ unresolvable: true });
    expect(routingFor('g->h')).toBeUndefined();
  });
  it('outgoingMarginOffset reads the routed geometry: an unresolvable aligned edge uses the offset-based fallback span', () => {
    const routingFor = (id) => (id === 'p->m' ? { unresolvable: true } : undefined);
    const fallback = build({ unresolvable: true });
    const seg = fallback.corridorSegments[0];
    const viaRouting = outgoingMarginOffset(seed, 'p', 'm', plan.face, rect('p'), pos.p, pos.m, inputs.occupiedCells, 'north', plan, slot, routingFor);
    expect(viaRouting).toEqual({ offset: seg.gx - rect('p').gx, width: seg.gw });
    // without it the planned (path-independent) door is reported, as before
    expect(outgoingMarginOffset(seed, 'p', 'm', plan.face, rect('p'), pos.p, pos.m, inputs.occupiedCells, 'north', plan, slot))
      .toEqual(outgoingMarginOffset(seed, 'p', 'm', plan.face, rect('p'), pos.p, pos.m, inputs.occupiedCells, 'north', plan, slot, () => undefined));
  });
});

describe('routeEdgesTopologyAware: 500-seed sweep on layoutVersion 3 (#427)', () => {
  const zero = () => ({ multi: 0, placedFirst: 0, rerouted: 0, unresolvable: 0, baseCells: 0, extraCells: 0, floorCrossings: 0, cutOccurrences: 0, firstHopChanged: 0, lastHopChanged: 0 });
  const totals = zero();
  const kept = zero(); // keepFirstHop: re-routes may not change the first transit cell
  const add = (t, inputs, r) => {
    const c = checkLanes(inputs.seed, r.lanes);
    for (const k of ['multi', 'placedFirst', 'rerouted', 'baseCells', 'extraCells', 'firstHopChanged', 'lastHopChanged']) t[k] += r.stats[k];
    t.unresolvable += r.unresolvable.length; t.floorCrossings += c.floorCrossings; t.cutOccurrences += c.cutOccurrences;
  };
  for (let i = 0; i < SEEDS; i += 1) {
    const inputs = routerInputsFor(buildSweepLayout(i, { layoutVersion: 3 }));
    add(totals, inputs, routeEdgesTopologyAware(inputs));
    add(kept, inputs, routeEdgesTopologyAware({ ...inputs, keepFirstHop: true }));
  }
  it('is non-vacuous and partitions every multi-cell edge', () => {
    expect(totals.multi).toBeGreaterThan(2000);
    expect(totals.placedFirst + totals.rerouted + totals.unresolvable).toBe(totals.multi);
    expect(kept.placedFirst + kept.rerouted + kept.unresolvable).toBe(kept.multi);
    expect(totals.rerouted).toBeGreaterThan(0);
  });
  it('placed edges: 0 floor crossings and 0 cut occurrences on the real wall/floor check', () => {
    expect(totals.floorCrossings).toBe(0);
    expect(totals.cutOccurrences).toBe(0);
    expect(kept.floorCrossings).toBe(0);
    expect(kept.cutOccurrences).toBe(0);
  });
  it('K7: extra path length under 3% of base cells', () => {
    expect(totals.extraCells).toBeLessThan(0.03 * totals.baseCells);
    expect(kept.extraCells).toBeLessThan(0.03 * kept.baseCells);
  });
  it("K2'/K8: the unresolvable counts (prototype on v2: 185; keepFirstHop 199, +7.6%, under K8's +25%) only fall", () => {
    expect(totals.unresolvable).toBeLessThanOrEqual(185);
    expect(kept.unresolvable).toBeLessThanOrEqual(199);
    expect(kept.unresolvable).toBeLessThanOrEqual(Math.floor(185 * 1.25));
  });
  it('K8 measurement: re-routes never change the last hop (the incoming-neighbor rule), and change the first hop in 20 of 36 cases', () => {
    expect(totals.lastHopChanged).toBe(0);
    expect(totals.firstHopChanged).toBeLessThanOrEqual(20);
    expect(totals.rerouted).toBeLessThanOrEqual(36);
    expect(kept.firstHopChanged).toBe(0);
  });
});
