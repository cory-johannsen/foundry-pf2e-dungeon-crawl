// #906: a detour room no corridor can reach is not produced. Every #877 wall crossing (12 edges, 11/100 seeds) was a
// hidden link X -> room-detour-N whose target sits in column 0 inside a solid stack of rooms: north is an unrelated
// room, the only west entry cell (rank, -1) cannot be reached without crossing the stack, findCorridorPath returns
// null and the scene draws buildEdgeCorridor's fallback line through other rooms and sealed cells.
import { describe, it, expect } from 'vitest';
import * as deck from '../scripts/dungeon-deck.mjs';
import {
  unreachableDetourIds, withoutDetours, placeLayoutGraph, computeRanks, computeColumns, pruneConflictingShortcuts,
  findCorridorPath, incomingFaceFor, parentRoomIdsFor,
} from '../scripts/dungeon-layout.mjs';

// Column 0 is a solid stack from rank 0 to rank 5 except the detour d at (3,0); its source x is at (2,2).
const STACK_POS = {
  'room-entry': { rank: 0, col: 0 }, a: { rank: 1, col: 0 }, b: { rank: 2, col: 0 }, d: { rank: 3, col: 0 },
  c: { rank: 4, col: 0 }, e: { rank: 5, col: 0 }, x: { rank: 2, col: 2 },
};
const STACK_EDGES = { 'room-entry': ['a'], a: ['b'], b: ['c'], x: ['d'], d: ['c'], c: ['e'] };

function attachedFor(i) {
  const seed = `sweep-${i}`;
  const roomCount = 6 + (i % 15);
  const g = deck.buildRoomGraph({ seed, roomCount });
  const r = deck.insertRestRoom({ rooms: g.rooms, edges: g.edges, seed, roomCount });
  return deck.attachHiddenPaths({ rooms: r.rooms, edges: r.edges, seed });
}

describe('unreachableDetourIds (#906)', () => {
  it('reports a column-0 detour whose north is an unrelated room and whose west cell is cut off by the stack', () => {
    expect(unreachableDetourIds({ positionByRoomId: STACK_POS, layoutEdges: STACK_EDGES, hiddenRooms: new Set(['d']) })).toEqual(['d']);
  });

  it('does not report it once a free column-0 cell inside the search bounds opens a way round to (rank, -1)', () => {
    const { e: _e, ...pos } = STACK_POS;
    const { c: _c, ...edges } = STACK_EDGES;
    expect(unreachableDetourIds({ positionByRoomId: pos, layoutEdges: { ...edges, c: [] }, hiddenRooms: ['d'] })).toEqual([]);
  });

  it('reports exactly the 12 #877 detours over the 100 crossing-sweep seeds, before any is dropped', () => {
    const found = [];
    for (let i = 0; i < 100; i += 1) {
      const A = attachedFor(i);
      const placed = placeLayoutGraph(A, { prune: true, dropUnreachableDetours: false });
      for (const id of unreachableDetourIds({
        positionByRoomId: placed.positionByRoomId, layoutEdges: placed.layoutEdges, hiddenRooms: placed.hiddenRooms,
        hiddenIncomingByRoomId: placed.hiddenIncomingByRoomId,
      })) found.push(`${i}:${id}`);
    }
    expect(found).toEqual([
      '8:room-detour-0', '36:room-detour-0', '41:room-detour-1', '48:room-detour-0', '51:room-detour-0',
      '52:room-detour-0', '56:room-detour-0', '69:room-detour-1', '81:room-detour-0', '87:room-detour-0',
      '87:room-detour-2', '94:room-detour-0',
    ]);
  });

  it('north is no alternative for any of them: it is blocked too (a face-only fallback cannot fix #877)', () => {
    for (const i of [8, 36, 41, 48, 51, 52, 56, 69, 81, 87, 94]) {
      const A = attachedFor(i);
      const placed = placeLayoutGraph(A, { prune: true, dropUnreachableDetours: false });
      const pos = placed.positionByRoomId;
      const occ = Object.fromEntries(Object.entries(pos).map(([id, p]) => [`${p.rank},${p.col}`, id]));
      for (const id of unreachableDetourIds({ positionByRoomId: pos, layoutEdges: placed.layoutEdges, hiddenRooms: placed.hiddenRooms, hiddenIncomingByRoomId: placed.hiddenIncomingByRoomId })) {
        const [src] = parentRoomIdsFor(placed.layoutEdges, id);
        expect(pos[id].col).toBe(0);
        expect(incomingFaceFor(id, pos, occ, new Set([src]))).toBe('west');
        expect(findCorridorPath(pos[src], pos[id], occ, { fromRoomId: src, toRoomId: id, incomingFace: 'north', exitFace: 'south' })).toBeNull();
      }
    }
  });
});

describe('withoutDetours (#906)', () => {
  it('removes the detour from every map and leaves everything else as it was', () => {
    const graph = {
      rooms: { 'room-entry': {}, x: {}, t: {}, d: {} },
      edges: { 'room-entry': ['x'], x: ['t'], d: ['t'], t: [] },
      layoutEdges: { 'room-entry': ['x'], x: ['t', 'd'], d: ['t'], t: [] },
      hiddenRooms: new Set(['d']),
      hiddenEdges: { x: ['d'] },
      hiddenIncomingByRoomId: { t: ['room-entry'] },
    };
    const out = withoutDetours(graph, ['d']);
    expect(Object.keys(out.rooms)).toEqual(['room-entry', 'x', 't']);
    expect(out.edges).toEqual({ 'room-entry': ['x'], x: ['t'], t: [] });
    expect(out.layoutEdges).toEqual({ 'room-entry': ['x'], x: ['t'], t: [] });
    expect([...out.hiddenRooms]).toEqual([]);
    expect(out.hiddenEdges).toEqual({});
    expect(out.hiddenIncomingByRoomId).toEqual({ t: ['room-entry'] });
    // pure: the input is untouched
    expect(graph.layoutEdges.x).toEqual(['t', 'd']);
    expect([...graph.hiddenRooms]).toEqual(['d']);
  });
});

describe('placeLayoutGraph (#906)', () => {
  it('without the drop it is exactly the old inline placement (ranks, columns, prune) on every one of 100 seeds', () => {
    for (let i = 0; i < 100; i += 1) {
      const A = attachedFor(i);
      const ranks = computeRanks(A.layoutEdges, 'room-entry');
      const cols = computeColumns(A.layoutEdges, ranks, 'room-entry');
      const pos = Object.fromEntries(Object.keys(A.rooms).map((id) => [id, { rank: ranks[id], col: cols[id] }]));
      const pruned = pruneConflictingShortcuts(A, pos);
      const placed = placeLayoutGraph(A, { prune: true, dropUnreachableDetours: false });
      expect(placed.positionByRoomId).toEqual(pos);
      expect(placed.ranks).toEqual(ranks);
      expect(placed.hiddenEdges).toEqual(pruned.hiddenEdges);
      expect(placed.hiddenIncomingByRoomId).toEqual(pruned.hiddenIncomingByRoomId);
      expect(placed.droppedDetours).toEqual([]);
    }
  });

  it('prune: false passes the hidden maps through untouched (layoutVersion 1)', () => {
    const A = attachedFor(13);
    const placed = placeLayoutGraph(A, { prune: false });
    expect(placed.hiddenEdges).toBe(A.hiddenEdges);
    expect(placed.hiddenIncomingByRoomId).toBe(A.hiddenIncomingByRoomId);
  });

  it('with the drop, seed 81 loses room-detour-0 and its child moves up into the freed rank', () => {
    const before = placeLayoutGraph(attachedFor(81), { prune: true, dropUnreachableDetours: false });
    const after = placeLayoutGraph(attachedFor(81), { prune: true, dropUnreachableDetours: true });
    expect(before.positionByRoomId['room-detour-0']).toEqual({ rank: 4, col: 0 });
    expect(before.positionByRoomId['room-rest']).toEqual({ rank: 5, col: 0 });
    expect(after.droppedDetours).toEqual(['room-detour-0']);
    expect(after.rooms['room-detour-0']).toBeUndefined();
    expect([...after.hiddenRooms]).not.toContain('room-detour-0');
    expect(after.positionByRoomId['room-rest']).toEqual({ rank: 4, col: 0 });
  });

  it('re-places until no detour is unreachable (500 seeds; a second pass is needed in some)', () => {
    let dropped = 0;
    let multiPass = 0;
    for (let i = 0; i < 500; i += 1) {
      const placed = placeLayoutGraph(attachedFor(i), { prune: true, dropUnreachableDetours: true });
      dropped += placed.droppedDetours.length;
      const firstPass = unreachableDetourIds({
        ...placeLayoutGraph(attachedFor(i), { prune: true, dropUnreachableDetours: false }),
      });
      if (placed.droppedDetours.length > firstPass.length) multiPass += 1;
      expect(unreachableDetourIds(placed)).toEqual([]);
    }
    expect([dropped, multiPass]).toEqual([56, 2]);
  });
});
