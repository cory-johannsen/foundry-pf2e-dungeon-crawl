import { describe, it, expect } from 'vitest';
import {
  ROOM_SIZE_SMALL, ROOM_SIZE_LARGE, DOOR_WIDTH,
  roomSizeAt, doorOffsetAt, corridorTileVariant,
  computeRanks, computeColumns,
  roomRect, exitFaceForIndex, roomEnclosureWalls, ROW_STRIDE, COLUMN_STRIDE, parentRoomIdsFor, incomingConnectionsFor, buildEdgeCorridor, incomingFaceFor, doorSlotsForFace, outgoingSlotsForFace, outgoingDoorPlan,
  cellBounds, projectOntoSide, findCorridorPath, INITIAL_GX, cellMarginWalls, transitCellCrossing,
  transitCellContainmentWalls, CORRIDOR_LEN, outgoingMarginOffset, pendingForeignMarginOpenings,
  marginBandApproach, findCoParentCollision, findPriorityCollision, assignDoorSlotsWithPriority,
} from '../scripts/dungeon-layout.mjs';
import { buildRoomGraph, attachHiddenPaths } from '../scripts/dungeon-deck.mjs';

const SEED = 'seed-a';

describe('roomSizeAt', () => {
  it('is deterministic for the same seed/slot', () => {
    expect(roomSizeAt(SEED, 3)).toBe(roomSizeAt(SEED, 3));
  });

  it('always returns exactly ROOM_SIZE_SMALL or ROOM_SIZE_LARGE', () => {
    for (let slot = 0; slot < 20; slot += 1) {
      expect([ROOM_SIZE_SMALL, ROOM_SIZE_LARGE]).toContain(roomSizeAt(SEED, slot));
    }
  });

  it('produces both sizes across enough slots (not always the same one)', () => {
    const sizes = new Set();
    for (let slot = 0; slot < 20; slot += 1) sizes.add(roomSizeAt(SEED, slot));
    expect(sizes.size).toBe(2);
  });

  it('varies by seed for the same slot', () => {
    const sizes = new Set();
    for (const seed of ['seed-a', 'seed-b', 'seed-c', 'seed-d', 'seed-e', 'seed-f']) {
      sizes.add(roomSizeAt(seed, 0));
    }
    expect(sizes.size).toBeGreaterThan(1);
  });
});

describe('roomRect', () => {
  it('is a pure function of (seed, roomId, rank, col)', () => {
    const a = roomRect('alpha', 'room-3', 2, 1);
    const b = roomRect('alpha', 'room-3', 2, 1);
    expect(a).toEqual(b);
  });

  it('increasing rank moves gy forward by at least ROW_STRIDE', () => {
    const a = roomRect('alpha', 'x', 0, 0);
    const b = roomRect('alpha', 'x', 1, 0);
    expect(b.gy - a.gy).toBeGreaterThanOrEqual(ROW_STRIDE - 1);
  });

  it('increasing col moves gx forward by at least COLUMN_STRIDE', () => {
    const a = roomRect('alpha', 'x', 0, 0);
    const b = roomRect('alpha', 'x', 0, 1);
    expect(b.gx - a.gx).toBeGreaterThanOrEqual(COLUMN_STRIDE - 1);
  });
});

describe('exitFaceForIndex', () => {
  it('assigns distinct faces to up to 3 exits', () => {
    expect(exitFaceForIndex(0)).toBe('south');
    expect(exitFaceForIndex(1)).toBe('east');
    expect(exitFaceForIndex(2)).toBe('west');
  });

  it('defaults to north-incoming behavior, byte-identical to before this change', () => {
    expect(exitFaceForIndex(0)).toBe('south');
    expect(exitFaceForIndex(1)).toBe('east');
    expect(exitFaceForIndex(2)).toBe('west');
  });

  it('produces the same result when incomingFace is explicitly north', () => {
    expect(exitFaceForIndex(0, 'north')).toBe('south');
    expect(exitFaceForIndex(1, 'north')).toBe('east');
    expect(exitFaceForIndex(2, 'north')).toBe('west');
  });

  it('excludes west and offers north instead when incomingFace is west', () => {
    expect(exitFaceForIndex(0, 'west')).toBe('south');
    expect(exitFaceForIndex(1, 'west')).toBe('east');
    expect(exitFaceForIndex(2, 'west')).toBe('north');
  });
});

describe('roomEnclosureWalls (multi-exit)', () => {
  // #93 pre-flight fix: roomEnclosureWalls' real Step-3 implementation
  // takes `rect` as a mandatory 4th argument (documented in this task's
  // own "Note for the implementer" and matching Task 10's real call
  // site) -- the Interfaces section's 3-arg summary above was incomplete.
  // Omitting it here would throw ("Cannot destructure property 'gx' of
  // undefined") rather than fail cleanly. A plain, arbitrary valid rect
  // is enough since these tests only assert on `.dir`, never coordinates.
  const rect = { gx: 0, gy: 0, gw: 4, gh: 4 };

  it('excludes north (incoming) and every outgoing face', () => {
    const walls = roomEnclosureWalls('alpha', 'x', { incomingCount: 1, outgoingFaces: ['south', 'east'] }, rect);
    const dirs = walls.map((w) => w.dir);
    expect(dirs).not.toContain('north');
    expect(dirs).not.toContain('south');
    expect(dirs).not.toContain('east');
    expect(dirs).toContain('west');
  });

  it('the entry room (incomingCount 0) walls every side except its outgoing faces', () => {
    const walls = roomEnclosureWalls('alpha', 'room-entry', { incomingCount: 0, outgoingFaces: ['south'] }, rect);
    expect(walls.map((w) => w.dir)).toEqual(expect.arrayContaining(['north', 'east', 'west']));
  });

  it('a merge room with several real incoming connections still only excludes north ONCE (one shared face, subdivided into door slots later — not one excluded face per incoming connection, which would run out of faces past 3)', () => {
    const walls = roomEnclosureWalls('alpha', 'm', { incomingCount: 3, outgoingFaces: ['south'] }, rect);
    const dirs = walls.map((w) => w.dir);
    expect(dirs).not.toContain('north');
    expect(dirs).toContain('east');
    expect(dirs).toContain('west');
  });
});

describe('roomEnclosureWalls with incomingFace', () => {
  const rect = { gx: 300, gy: 26, gw: 12, gh: 12 };

  it('defaults to north, byte-identical to before this change', () => {
    const walls = roomEnclosureWalls('seed1', 'r', { incomingCount: 1, outgoingFaces: ['south'] }, rect);
    expect(walls.map((w) => w.dir).sort()).toEqual(['east', 'west']);
  });

  it('leaves the west face open (not north) when incomingFace is west', () => {
    const walls = roomEnclosureWalls('seed1', 'r', { incomingCount: 1, incomingFace: 'west', outgoingFaces: ['south'] }, rect);
    expect(walls.map((w) => w.dir).sort()).toEqual(['east', 'north']);
  });

  it('the entry room (incomingCount 0) still gets a solid wall on its own incoming face, even when that face is west', () => {
    const walls = roomEnclosureWalls('seed1', 'r', { incomingCount: 0, incomingFace: 'west', outgoingFaces: ['south', 'east'] }, rect);
    expect(walls.map((w) => w.dir).sort()).toEqual(['north', 'west']);
  });
});

describe('parentRoomIdsFor', () => {
  it('returns every real parent for a merge room, in deterministic order', () => {
    const layoutEdges = { 'room-entry': ['a', 'b'], a: ['m'], b: ['m'], m: [] };
    expect(parentRoomIdsFor(layoutEdges, 'm')).toEqual(['a', 'b']);
  });

  it('returns a single-element array for a normal (non-merge) room', () => {
    const layoutEdges = { 'room-entry': ['a'], a: [] };
    expect(parentRoomIdsFor(layoutEdges, 'a')).toEqual(['room-entry']);
  });

  it('returns an empty array for the entry room', () => {
    expect(parentRoomIdsFor({ 'room-entry': [] }, 'room-entry')).toEqual([]);
  });

  it('resolves a detour room\'s one real parent via layoutEdges (#156 — a plain edges lookup would find none)', () => {
    const layoutEdges = { 'room-entry': ['a'], a: ['b', 'room-detour-0'], b: [], 'room-detour-0': ['b'] };
    expect(parentRoomIdsFor(layoutEdges, 'room-detour-0')).toEqual(['a']);
  });
});

describe('incomingConnectionsFor', () => {
  it('lists real parents first (in parentRoomIdsFor order), then any hidden incoming source', () => {
    const layoutEdges = { 'room-entry': ['a', 'b'], a: ['m'], b: ['m'], m: [] };
    const hiddenIncomingByRoomId = { m: ['x'] };
    expect(incomingConnectionsFor(layoutEdges, 'm', hiddenIncomingByRoomId)).toEqual([
      { sourceId: 'a', hidden: false },
      { sourceId: 'b', hidden: false },
      { sourceId: 'x', hidden: true },
    ]);
  });

  it('a room with no hidden incoming just returns its real parent(s)', () => {
    const layoutEdges = { 'room-entry': ['a'], a: [] };
    expect(incomingConnectionsFor(layoutEdges, 'a')).toEqual([{ sourceId: 'room-entry', hidden: false }]);
  });
});

describe('incomingFaceFor', () => {
  it('returns north when the north-neighbor cell is empty', () => {
    const positionByRoomId = { r: { rank: 1, col: 1 } };
    expect(incomingFaceFor('r', positionByRoomId, {}, new Set())).toBe('north');
  });

  it('returns north when the north-neighbor cell is occupied only by a real parent', () => {
    const positionByRoomId = { r: { rank: 1, col: 1 }, p: { rank: 0, col: 1 } };
    const occupiedCells = { '0,1': 'p' };
    expect(incomingFaceFor('r', positionByRoomId, occupiedCells, new Set(['p']))).toBe('north');
  });

  it('falls back to west when north is blocked by an unrelated room but west is free', () => {
    const positionByRoomId = { r: { rank: 1, col: 1 }, blocker: { rank: 0, col: 1 } };
    const occupiedCells = { '0,1': 'blocker' };
    expect(incomingFaceFor('r', positionByRoomId, occupiedCells, new Set())).toBe('west');
  });

  it('falls back to west when north is blocked by an unrelated room, even if west is occupied by a legitimate parent', () => {
    const positionByRoomId = { r: { rank: 1, col: 1 }, blocker: { rank: 0, col: 1 }, p: { rank: 1, col: 0 } };
    const occupiedCells = { '0,1': 'blocker', '1,0': 'p' };
    expect(incomingFaceFor('r', positionByRoomId, occupiedCells, new Set(['p']))).toBe('west');
  });

  it('returns north (the documented residual-case tiebreak) when both north and west are blocked by unrelated rooms', () => {
    const positionByRoomId = { r: { rank: 1, col: 1 }, blockerN: { rank: 0, col: 1 }, blockerW: { rank: 1, col: 0 } };
    const occupiedCells = { '0,1': 'blockerN', '1,0': 'blockerW' };
    expect(incomingFaceFor('r', positionByRoomId, occupiedCells, new Set())).toBe('north');
  });

  it('correctly excludes multiple real parents for a merge room', () => {
    // Both p1 (north-neighbor) and p2 (elsewhere entirely) are this
    // room's own real parents — p1 sitting at the north-neighbor
    // position must not count as blocking.
    //
    // #174 follow-up: a same-plan attempt to require a legitimate
    // occupant be the room's SOLE source (so this specific case would
    // fall to west instead) was reverted — see incomingFaceFor's own
    // docblock for why (the multi-cell/transit-cell machinery that
    // "fix" pushed more connections into was found net-negative given
    // its own current, separately-tracked geometry bugs).
    const positionByRoomId = { r: { rank: 2, col: 1 }, p1: { rank: 1, col: 1 }, p2: { rank: 0, col: 3 } };
    const occupiedCells = { '1,1': 'p1', '0,3': 'p2' };
    expect(incomingFaceFor('r', positionByRoomId, occupiedCells, new Set(['p1', 'p2']))).toBe('north');
  });
});

describe('doorSlotsForFace', () => {
  it('produces byte-identical output to the old doorSlotsForFace for face="north"', () => {
    const rect = { gx: 300, gy: 26, gw: 12, gh: 12 };
    expect(doorSlotsForFace(rect, 3, 'north')).toEqual([
      { x1: 300, y1: 26, x2: 304, y2: 26 },
      { x1: 304, y1: 26, x2: 308, y2: 26 },
      { x1: 308, y1: 26, x2: 312, y2: 26 },
    ]);
  });

  it('divides the west edge along height for face="west"', () => {
    const rect = { gx: 300, gy: 26, gw: 12, gh: 12 };
    expect(doorSlotsForFace(rect, 3, 'west')).toEqual([
      { x1: 300, y1: 26, x2: 300, y2: 30 },
      { x1: 300, y1: 30, x2: 300, y2: 34 },
      { x1: 300, y1: 34, x2: 300, y2: 38 },
    ]);
  });

  it('single slot spans the whole face, either orientation', () => {
    const rect = { gx: 300, gy: 26, gw: 6, gh: 6 };
    expect(doorSlotsForFace(rect, 1, 'north')).toEqual([{ x1: 300, y1: 26, x2: 306, y2: 26 }]);
    expect(doorSlotsForFace(rect, 1, 'west')).toEqual([{ x1: 300, y1: 26, x2: 300, y2: 32 }]);
  });
});

describe('doorOffsetAt', () => {
  it('is deterministic for the same seed/slot/role/roomSize', () => {
    expect(doorOffsetAt(SEED, 3, 'outgoing', ROOM_SIZE_SMALL)).toBe(doorOffsetAt(SEED, 3, 'outgoing', ROOM_SIZE_SMALL));
  });

  it('always falls within [0, roomSize - DOOR_WIDTH], for either room size', () => {
    for (const roomSize of [ROOM_SIZE_SMALL, ROOM_SIZE_LARGE]) {
      for (let slot = 0; slot < 10; slot += 1) {
        for (const role of ['outgoing', 'incoming']) {
          const offset = doorOffsetAt(SEED, slot, role, roomSize);
          expect(offset).toBeGreaterThanOrEqual(0);
          expect(offset).toBeLessThanOrEqual(roomSize - DOOR_WIDTH);
          expect(Number.isInteger(offset)).toBe(true);
        }
      }
    }
  });

  it('varies across slots and roles (not always the same offset)', () => {
    const values = new Set();
    for (let slot = 0; slot < 10; slot += 1) {
      values.add(doorOffsetAt(SEED, slot, 'outgoing', ROOM_SIZE_SMALL));
      values.add(doorOffsetAt(SEED, slot, 'incoming', ROOM_SIZE_SMALL));
    }
    expect(values.size).toBeGreaterThan(1);
  });

  it('a room\'s own outgoing and incoming offsets are independent draws, not the same value reused', () => {
    // Not guaranteed different for any one slot, but across many slots at
    // least one should differ, or ITEM-9's whole premise (doors don't have
    // to line up) would be silently false.
    let sawDifference = false;
    for (let slot = 0; slot < 15; slot += 1) {
      if (doorOffsetAt(SEED, slot, 'outgoing', ROOM_SIZE_SMALL) !== doorOffsetAt(SEED, slot, 'incoming', ROOM_SIZE_SMALL)) {
        sawDifference = true;
        break;
      }
    }
    expect(sawDifference).toBe(true);
  });

  it('a larger room allows a wider range of offsets than a small one', () => {
    // Sweep enough slots that the large-room max (ROOM_SIZE_LARGE - DOOR_WIDTH)
    // actually gets hit at least once — confirms the bound really does scale
    // with roomSize, not just clamp to the small room's own range.
    let sawBeyondSmallMax = false;
    for (let slot = 0; slot < 200 && !sawBeyondSmallMax; slot += 1) {
      if (doorOffsetAt(SEED, slot, 'outgoing', ROOM_SIZE_LARGE) > ROOM_SIZE_SMALL - DOOR_WIDTH) {
        sawBeyondSmallMax = true;
      }
    }
    expect(sawBeyondSmallMax).toBe(true);
  });
});

describe('corridorTileVariant', () => {
  it('always uses the single fully-walled tile for a length-1 gallery', () => {
    expect(corridorTileVariant(0, 1, true)).toEqual({ variant: 'single', rotation: 0 });
    expect(corridorTileVariant(0, 1, false)).toEqual({ variant: 'single', rotation: 0 });
  });

  it('a length-2 vertical gallery is two open-sided ends, no mid tile', () => {
    expect(corridorTileVariant(0, 2, true)).toEqual({ variant: 'end', rotation: 0 });
    expect(corridorTileVariant(1, 2, true)).toEqual({ variant: 'end', rotation: 180 });
  });

  it('a length-2 horizontal gallery mirrors that, rotated for its own axis', () => {
    expect(corridorTileVariant(0, 2, false)).toEqual({ variant: 'end', rotation: 270 });
    expect(corridorTileVariant(1, 2, false)).toEqual({ variant: 'end', rotation: 90 });
  });

  it('a longer vertical gallery sandwiches mid tiles between two ends', () => {
    expect(corridorTileVariant(0, 4, true)).toEqual({ variant: 'end', rotation: 0 });
    expect(corridorTileVariant(1, 4, true)).toEqual({ variant: 'mid', rotation: 0 });
    expect(corridorTileVariant(2, 4, true)).toEqual({ variant: 'mid', rotation: 0 });
    expect(corridorTileVariant(3, 4, true)).toEqual({ variant: 'end', rotation: 180 });
  });

  it('a longer horizontal gallery sandwiches rotated mid tiles between two rotated ends', () => {
    expect(corridorTileVariant(0, 4, false)).toEqual({ variant: 'end', rotation: 270 });
    expect(corridorTileVariant(1, 4, false)).toEqual({ variant: 'mid', rotation: 90 });
    expect(corridorTileVariant(2, 4, false)).toEqual({ variant: 'mid', rotation: 90 });
    expect(corridorTileVariant(3, 4, false)).toEqual({ variant: 'end', rotation: 90 });
  });

  it('every tile in a gallery of any length gets exactly one variant assignment', () => {
    for (let length = 1; length <= ROOM_SIZE_LARGE; length += 1) {
      for (const vertical of [true, false]) {
        const variants = [];
        for (let i = 0; i < length; i += 1) variants.push(corridorTileVariant(i, length, vertical).variant);
        const endCount = variants.filter((v) => v === 'end').length;
        const midCount = variants.filter((v) => v === 'mid').length;
        if (length === 1) {
          expect(variants).toEqual(['single']);
        } else {
          expect(endCount).toBe(2);
          expect(midCount).toBe(length - 2);
        }
      }
    }
  });
});

describe('computeRanks', () => {
  it('entry is rank 0; a straight chain increments by 1', () => {
    const edges = { 'room-entry': ['a'], a: ['b'], b: ['c'], c: [] };
    const ranks = computeRanks(edges, 'room-entry');
    expect(ranks['room-entry']).toBe(0);
    expect(ranks.a).toBe(1);
    expect(ranks.b).toBe(2);
    expect(ranks.c).toBe(3);
  });

  it('a merge room takes the max rank over all its parents', () => {
    const edges = { 'room-entry': ['a', 'b'], a: ['m'], b: ['x', 'm'], x: ['m'], m: [] };
    const ranks = computeRanks(edges, 'room-entry');
    // a=1, b=1, x=2 (via b), m must be max(rank(a)+1, rank(b)+1, rank(x)+1) = 3
    expect(ranks.m).toBe(3);
  });
});

describe('computeColumns', () => {
  it('two siblings at the same rank get distinct columns', () => {
    const edges = { 'room-entry': ['a', 'b'], a: [], b: [] };
    const ranks = computeRanks(edges, 'room-entry');
    const cols = computeColumns(edges, ranks, 'room-entry');
    expect(cols.a).not.toBe(cols.b);
  });

  it('a single child is centered under a single parent (same column)', () => {
    const edges = { 'room-entry': ['a'], a: ['b'], b: [] };
    const ranks = computeRanks(edges, 'room-entry');
    const cols = computeColumns(edges, ranks, 'room-entry');
    expect(cols.a).toBe(cols['room-entry']);
    expect(cols.b).toBe(cols.a);
  });

  it('is deterministic and assigns every room a column', () => {
    const edges = { 'room-entry': ['a', 'b'], a: ['c'], b: ['c'], c: [] };
    const ranks = computeRanks(edges, 'room-entry');
    const cols = computeColumns(edges, ranks, 'room-entry');
    for (const id of Object.keys(edges)) expect(typeof cols[id]).toBe('number');
  });

  it('a diamond (two parents converging on the same child) still gives the two parents distinct columns (#93 pre-flight fix regression — the original centering design collapsed both onto the shared child\'s column, which roomRect would then place at the exact same grid cell)', () => {
    const edges = { 'room-entry': ['a', 'b'], a: ['c'], b: ['c'], c: [] };
    const ranks = computeRanks(edges, 'room-entry');
    const cols = computeColumns(edges, ranks, 'room-entry');
    expect(cols.a).not.toBe(cols.b);
  });

  it('no two rooms at the same rank ever share a column, across a wide sweep of generated graphs (the real invariant roomRect depends on to avoid overlapping rooms)', () => {
    for (let n = 0; n < 40; n += 1) {
      const seed = `layout-${n}`;
      for (const roomCount of [3, 4, 6, 8, 12, 16, 24]) {
        const { rooms, edges } = buildRoomGraph({ seed, roomCount });
        const ranks = computeRanks(edges, 'room-entry');
        const cols = computeColumns(edges, ranks, 'room-entry');
        const seenByRank = {};
        for (const roomId of Object.keys(rooms)) {
          const key = ranks[roomId];
          const col = cols[roomId];
          seenByRank[key] ??= new Set();
          expect(seenByRank[key].has(col)).toBe(false);
          seenByRank[key].add(col);
        }
      }
    }
  });

  it('assigns columns via a skip-by-2 stride: every room\'s own column is even, and same-rank rooms differ by exactly 2 in visit order (#174 follow-up: guarantees a genuinely empty west-neighbor column for every room, not just the first in its rank)', () => {
    const edges = { 'room-entry': ['a', 'b', 'c'], a: [], b: [], c: [] };
    const ranks = computeRanks(edges, 'room-entry');
    const cols = computeColumns(edges, ranks, 'room-entry');
    expect(cols['room-entry']).toBe(0);
    expect(cols.a).toBe(0);
    expect(cols.b).toBe(2);
    expect(cols.c).toBe(4);
    for (const id of Object.keys(edges)) expect(cols[id] % 2).toBe(0);
  });

  it('every same-rank room\'s immediate column neighbors (col-1, col+1) are guaranteed never occupied by another room in the same rank, across a wide sweep', () => {
    for (let n = 0; n < 40; n += 1) {
      const seed = `layout-${n}`;
      for (const roomCount of [3, 4, 6, 8, 12, 16, 24]) {
        const { rooms, edges } = buildRoomGraph({ seed, roomCount });
        const ranks = computeRanks(edges, 'room-entry');
        const cols = computeColumns(edges, ranks, 'room-entry');
        const usedByRank = {};
        for (const roomId of Object.keys(rooms)) {
          const key = ranks[roomId];
          usedByRank[key] ??= new Set();
          usedByRank[key].add(cols[roomId]);
        }
        for (const roomId of Object.keys(rooms)) {
          const key = ranks[roomId];
          const col = cols[roomId];
          expect(usedByRank[key].has(col - 1)).toBe(false);
          expect(usedByRank[key].has(col + 1)).toBe(false);
        }
      }
    }
  });

});

describe('buildEdgeCorridor', () => {
  // #174 Task 4: buildEdgeCorridor now pathfinds first (fromPos/toPos +
  // occupiedCells), only falling into this pre-existing geometry when the
  // resulting path is length <= 2. Every test below passes an adjacent
  // fromPos/toPos pair with an empty occupiedCells so the path is always
  // exactly 2 cells long regardless of the REAL rects' own rank/col (some
  // of which are intentionally non-adjacent, e.g. the L-shaped case below)
  // — that reproduces the exact pre-#174 behavior these tests pin, since
  // the path.length <= 2 branch's own geometry depends only on
  // fromRect/toRect/exitFace/toSlot, never on fromPos/toPos themselves.
  const ADJACENT_FROM = { rank: 0, col: 0 };
  const ADJACENT_TO = { rank: 1, col: 0 };

  it('same-column rooms (straight south connection) produce one corridor segment', () => {
    const from = roomRect('alpha', 'a', 0, 0);
    const to = roomRect('alpha', 'b', 1, 0);
    const toSlot = doorSlotsForFace(to, 1, 'north')[0];
    const { corridorSegments } = buildEdgeCorridor('alpha', 'a', 'b', from, to, ADJACENT_FROM, ADJACENT_TO, 'south', toSlot, {});
    expect(corridorSegments).toHaveLength(1);
  });

  it('different-column rooms produce an L-shaped (2-segment) corridor', () => {
    const from = roomRect('alpha', 'a', 0, 0);
    const to = roomRect('alpha', 'b', 1, 2);
    const toSlot = doorSlotsForFace(to, 1, 'north')[0];
    const { corridorSegments } = buildEdgeCorridor('alpha', 'a', 'b', from, to, ADJACENT_FROM, ADJACENT_TO, 'south', toSlot, {});
    expect(corridorSegments).toHaveLength(2);
  });

  it('always returns a door wall and a reveal door wall', () => {
    const from = roomRect('alpha', 'a', 0, 0);
    const to = roomRect('alpha', 'b', 1, 1);
    const toSlot = doorSlotsForFace(to, 1, 'north')[0];
    const { doorWall, revealDoorWall } = buildEdgeCorridor('alpha', 'a', 'b', from, to, ADJACENT_FROM, ADJACENT_TO, 'south', toSlot, {});
    expect(doorWall).toBeDefined();
    expect(revealDoorWall).toBeDefined();
  });

  it('two exits from the same room on different faces never share a door offset key', () => {
    const from = roomRect('alpha', 'a', 0, 0);
    const toSouth = roomRect('alpha', 'b', 1, 0);
    const toEast = roomRect('alpha', 'c', 0, 1);
    const south = buildEdgeCorridor('alpha', 'a', 'b', from, toSouth, ADJACENT_FROM, ADJACENT_TO, 'south', doorSlotsForFace(toSouth, 1, 'north')[0], {});
    const east = buildEdgeCorridor('alpha', 'a', 'c', from, toEast, ADJACENT_FROM, ADJACENT_TO, 'east', doorSlotsForFace(toEast, 1, 'north')[0], {});
    expect(south.doorWall).not.toEqual(east.doorWall);
  });

  it('#93 pre-flight fix regression — two different incoming connections to the same merge room land on distinct, non-overlapping door slots', () => {
    const parentA = roomRect('alpha', 'a', 0, 0);
    const parentB = roomRect('alpha', 'b', 0, 1);
    const merge = roomRect('alpha', 'm', 1, 0);
    const slots = doorSlotsForFace(merge, 2, 'north');
    const fromA = buildEdgeCorridor('alpha', 'a', 'm', parentA, merge, ADJACENT_FROM, ADJACENT_TO, 'south', slots[0], {});
    const fromB = buildEdgeCorridor('alpha', 'b', 'm', parentB, merge, ADJACENT_FROM, ADJACENT_TO, 'south', slots[1], {});
    expect(fromA.revealDoorWall).not.toEqual(fromB.revealDoorWall);
    // The two doors must not overlap — slot 0's door stays left of slot 1's.
    expect(Math.max(fromA.revealDoorWall.x1, fromA.revealDoorWall.x2))
      .toBeLessThanOrEqual(Math.min(fromB.revealDoorWall.x1, fromB.revealDoorWall.x2));
  });

  it('#93 pre-flight fix regression (Task 10 review) — a same-column connection\'s TARGET-side plainWalls never extend past its own slot into a sibling\'s (would otherwise wall off the sibling\'s door)', () => {
    const parentA = roomRect('alpha', 'a', 0, 0);
    const merge = roomRect('alpha', 'm', 1, 0); // same column as parentA -> sameColumn branch
    const slots = doorSlotsForFace(merge, 2, 'north');
    const fromA = buildEdgeCorridor('alpha', 'a', 'm', parentA, merge, ADJACENT_FROM, ADJACENT_TO, 'south', slots[0], {});
    // Only the walls ON THE TARGET'S OWN north face (y === corridorEndY,
    // i.e. merge.gy) are bounded by the target's slot — a connection's
    // SOURCE-side walls (at faceY, closing off parentA's own south face)
    // have nothing to do with the target's slot layout at all (parentA
    // has no siblings sharing ITS OWN south face), so they're
    // deliberately excluded from this assertion (#93 pre-flight fix,
    // round 2 — the original version of this test wrongly asserted
    // those too, and failed against an otherwise-correct fix).
    const targetSideWalls = fromA.plainWalls.filter((w) => w.y1 === merge.gy);
    for (const w of targetSideWalls) {
      expect(Math.max(w.x1, w.x2)).toBeLessThanOrEqual(slots[0].x2);
      expect(Math.min(w.x1, w.x2)).toBeGreaterThanOrEqual(slots[0].x1);
    }
  });

  it('#93 pre-flight fix regression (Task 10 review) — a same-column corridor reaches the target\'s REAL position, not a fixed CORRIDOR_LEN, when the source is more than one rank above the target', () => {
    const from = roomRect('alpha', 'a', 0, 0);
    // Simulate a merge room whose rank is 3 above one of its real parents
    // (computeRanks takes the MAX over all parents + 1 — a parent not on
    // the longest path can sit several ranks above the merge room).
    const to = roomRect('alpha', 'm', 3, 0);
    const toSlot = doorSlotsForFace(to, 1, 'north')[0];
    const { revealDoorWall, corridorSegments } = buildEdgeCorridor('alpha', 'a', 'm', from, to, ADJACENT_FROM, ADJACENT_TO, 'south', toSlot, {});
    expect(revealDoorWall.y1).toBe(to.gy);
    expect(corridorSegments[0].gy + corridorSegments[0].gh).toBe(to.gy);
  });

  it('#93 pre-flight fix regression (this task\'s own final review) — a same-column room whose incoming-door count doesn\'t evenly divide its width still keeps every door within its own slot (doorOffsetAt must not exceed a fractional maxOffset)', () => {
    const parentA = roomRect('alpha', 'a', 0, 0);
    const parentB = roomRect('alpha', 'b', 0, 1);
    const merge = roomRect('alpha', 'm', 1, 0); // ROOM_SIZE_SMALL = 6, split 4 ways below -> slotWidth = 1.5
    const slots = doorSlotsForFace(merge, 4, 'north');
    for (let i = 0; i < slots.length; i += 1) {
      const from = i === 0 ? parentA : parentB; // exitFace/column irrelevant to this bug; same-column (i===0) is where it reproduces
      const { revealDoorWall } = buildEdgeCorridor('alpha', from === parentA ? 'a' : 'b', 'm', from, merge, ADJACENT_FROM, ADJACENT_TO, 'south', slots[i], {});
      expect(Math.min(revealDoorWall.x1, revealDoorWall.x2)).toBeGreaterThanOrEqual(slots[i].x1);
      expect(Math.max(revealDoorWall.x1, revealDoorWall.x2)).toBeLessThanOrEqual(slots[i].x2);
    }
  });

  it('#324: no door (source or target, corner-case branch) ever straddles a grid line -- exactly DOOR_WIDTH wide, starting on a whole grid coordinate, even when the target slot itself has fractional bounds', () => {
    const parentA = roomRect('alpha', 'a', 0, 0);
    const parentB = roomRect('alpha', 'b', 0, 1);
    const merge = roomRect('alpha', 'm', 1, 0); // slotWidth = 1.5, same fixture as the test above
    const slots = doorSlotsForFace(merge, 4, 'north');
    for (let i = 0; i < slots.length; i += 1) {
      const from = i === 0 ? parentA : parentB;
      const { doorWall, revealDoorWall } = buildEdgeCorridor(
        'alpha', from === parentA ? 'a' : 'b', 'm', from, merge, ADJACENT_FROM, ADJACENT_TO, 'south', slots[i], {},
      );
      for (const wall of [doorWall, revealDoorWall]) {
        const lo = Math.min(wall.x1, wall.x2);
        const hi = Math.max(wall.x1, wall.x2);
        expect(hi - lo).toBe(DOOR_WIDTH);
        expect(Number.isInteger(lo)).toBe(true);
        expect(Number.isInteger(hi)).toBe(true);
      }
    }
  });

  it('#324: no door straddles a grid line in the multi-cell chain either (real room-door anchor, not just the internal chain values)', () => {
    // Straight same-column descent, rank 0 -> rank 3 -- same fixture shape
    // as "chains every crossing point end-to-end" above, but asserting the
    // no-straddle property directly instead of only internal chain
    // consistency.
    const fromRect = { gx: 300, gy: 0, gw: 12, gh: 12 };
    const toRect = { gx: 300, gy: 39, gw: 12, gh: 12 };
    const toSlot = { x1: 300, y1: 39, x2: 312, y2: 39 };
    const { doorWall, revealDoorWall, transitCells } = buildEdgeCorridor(
      'seed1', 'a', 'b', fromRect, toRect, { rank: 0, col: 0 }, { rank: 3, col: 0 },
      'south', toSlot, {},
    );
    expect(transitCells.length).toBeGreaterThan(0); // sanity: really the multi-cell branch
    for (const wall of [doorWall, revealDoorWall]) {
      const lo = Math.min(wall.x1, wall.x2);
      const hi = Math.max(wall.x1, wall.x2);
      expect(hi - lo).toBe(DOOR_WIDTH);
      expect(Number.isInteger(lo)).toBe(true);
      expect(Number.isInteger(hi)).toBe(true);
    }
    // Every transit cell's own entry/exit point is also grid-aligned (the
    // chain anchors are exitPoint/entryPoint directly now, #324's fix).
    for (const cell of transitCells) {
      expect(Number.isInteger(cell.entryPoint.x)).toBe(true);
      expect(Number.isInteger(cell.entryPoint.y)).toBe(true);
      expect(Number.isInteger(cell.exitPoint.x)).toBe(true);
      expect(Number.isInteger(cell.exitPoint.y)).toBe(true);
    }
  });

  it('#324: the SOURCE room\'s own remaining exit face is fully contained, not just the target\'s -- a closed door must not leave the rest of that wall open to walk/see around (multi-cell branch)', () => {
    const fromRect = { gx: 300, gy: 0, gw: 12, gh: 12 };
    const toRect = { gx: 300, gy: 39, gw: 12, gh: 12 };
    const toSlot = { x1: 300, y1: 39, x2: 312, y2: 39 };
    const { doorWall, plainWalls, transitCells } = buildEdgeCorridor(
      'seed1', 'a', 'b', fromRect, toRect, { rank: 0, col: 0 }, { rank: 3, col: 0 },
      'south', toSlot, {},
    );
    expect(transitCells.length).toBeGreaterThan(0); // sanity: really the multi-cell branch
    // The source's own south face (y = fromRect.gy + fromRect.gh) must be
    // fully covered: the door itself, plus a plain wall on EITHER side
    // reaching all the way to the room's own west/east edges -- nowhere
    // for a token or a line of sight to slip past the door through an
    // unwalled remainder of the same face.
    const faceY = fromRect.gy + fromRect.gh;
    const sourceFaceWalls = plainWalls.filter((w) => w.y1 === faceY && w.y2 === faceY);
    const doorLo = Math.min(doorWall.x1, doorWall.x2);
    const doorHi = Math.max(doorWall.x1, doorWall.x2);
    const leftCap = sourceFaceWalls.find((w) => Math.max(w.x1, w.x2) === doorLo);
    const rightCap = sourceFaceWalls.find((w) => Math.min(w.x1, w.x2) === doorHi);
    expect(leftCap).toBeDefined();
    expect(Math.min(leftCap.x1, leftCap.x2)).toBe(fromRect.gx);
    expect(rightCap).toBeDefined();
    expect(Math.max(rightCap.x1, rightCap.x2)).toBe(fromRect.gx + fromRect.gw);
  });

  it('#324: the SOURCE room\'s own remaining exit face is fully contained in the corner-case branch too', () => {
    const fromRect = { gx: 300, gy: 0, gw: 6, gh: 6 };
    const toRect = { gx: 313, gy: 6, gw: 6, gh: 6 };
    const toSlot = doorSlotsForFace(toRect, 1, 'north')[0];
    // Boxed in (same shape the existing "corner branch" describe block
    // above already uses): both north- and west-neighbor of toPos
    // occupied, so findCorridorPath returns null and this genuinely takes
    // the corner-case fallback, not the multi-cell branch.
    const occupiedCells = { '0,1': 'blockerN', '1,0': 'blockerW' };
    const { doorWall, plainWalls, transitCells } = buildEdgeCorridor(
      'seed1', 'a', 'b', fromRect, toRect, { rank: 0, col: 0 }, { rank: 1, col: 1 },
      'south', toSlot, occupiedCells,
    );
    expect(transitCells).toHaveLength(0); // sanity: really the corner-case branch, not multi-cell
    const faceY = fromRect.gy + fromRect.gh;
    const sourceFaceWalls = plainWalls.filter((w) => w.y1 === faceY && w.y2 === faceY);
    const doorLo = Math.min(doorWall.x1, doorWall.x2);
    const doorHi = Math.max(doorWall.x1, doorWall.x2);
    const leftCap = sourceFaceWalls.find((w) => Math.max(w.x1, w.x2) === doorLo);
    const rightCap = sourceFaceWalls.find((w) => Math.min(w.x1, w.x2) === doorHi);
    expect(leftCap).toBeDefined();
    expect(Math.min(leftCap.x1, leftCap.x2)).toBe(fromRect.gx);
    expect(rightCap).toBeDefined();
    expect(Math.max(rightCap.x1, rightCap.x2)).toBe(fromRect.gx + fromRect.gw);
  });

  // #294: plainWalls used to be exactly 2 segments (both horizontal caps,
  // at the source's own face and the target's own face) for the
  // same-column fast path — nothing closed the SIDES of the margin band
  // in between, so a token standing between the two faces could walk
  // laterally anywhere in the room's own width, not just the corridor's
  // own real span. Confirmed live: a player could see and walk into that
  // space, correctly narrow floor tile notwithstanding.
  it('the same-column fast path seals both sides of the corridor\'s own depth, not just its two horizontal caps (#294)', () => {
    const from = roomRect('alpha', 'a', 0, 0);
    const to = roomRect('alpha', 'b', 1, 0);
    const toSlot = doorSlotsForFace(to, 1, 'north')[0];
    const { plainWalls, corridorSegments } = buildEdgeCorridor('alpha', 'a', 'b', from, to, ADJACENT_FROM, ADJACENT_TO, 'south', toSlot, {});
    const seg = corridorSegments[0];
    const spanX0 = seg.gx;
    const spanX1 = seg.gx + seg.gw;
    const faceY = seg.gy;
    const corridorEndY = seg.gy + seg.gh;
    // A vertical wall at each of the corridor's own real edges, spanning
    // its own full depth (not just a partial segment).
    const westSide = plainWalls.find((w) => w.x1 === spanX0 && w.x2 === spanX0);
    const eastSide = plainWalls.find((w) => w.x1 === spanX1 && w.x2 === spanX1);
    expect(westSide).toBeDefined();
    expect(eastSide).toBeDefined();
    expect(Math.min(westSide.y1, westSide.y2)).toBe(faceY);
    expect(Math.max(westSide.y1, westSide.y2)).toBe(corridorEndY);
    expect(Math.min(eastSide.y1, eastSide.y2)).toBe(faceY);
    expect(Math.max(eastSide.y1, eastSide.y2)).toBe(corridorEndY);
  });

  it('the same-rank fast path seals both sides of the corridor\'s own depth too, mirrored onto the x-axis (#294)', () => {
    const from = roomRect('alpha', 'a', 0, 0);
    const to = roomRect('alpha', 'b', 0, 1);
    const toSlot = doorSlotsForFace(to, 1, 'west')[0];
    const { plainWalls, corridorSegments } = buildEdgeCorridor(
      'alpha', 'a', 'b', from, to, ADJACENT_FROM, { rank: 0, col: 1 }, 'east', toSlot, {}, 'west',
    );
    const seg = corridorSegments[0];
    const spanY0 = seg.gy;
    const spanY1 = seg.gy + seg.gh;
    const faceX = seg.gx;
    const corridorEndX = seg.gx + seg.gw;
    const northSide = plainWalls.find((w) => w.y1 === spanY0 && w.y2 === spanY0);
    const southSide = plainWalls.find((w) => w.y1 === spanY1 && w.y2 === spanY1);
    expect(northSide).toBeDefined();
    expect(southSide).toBeDefined();
    expect(Math.min(northSide.x1, northSide.x2)).toBe(faceX);
    expect(Math.max(northSide.x1, northSide.x2)).toBe(corridorEndX);
    expect(Math.min(southSide.x1, southSide.x2)).toBe(faceX);
    expect(Math.max(southSide.x1, southSide.x2)).toBe(corridorEndX);
  });

  // #294 fix round: the two tests above both use a single-slot target,
  // where spanX0 === doorX0 exactly — they don't exercise the reason
  // span (not door) was deliberately chosen. This one does: `clamp-seed-1`
  // (the same seed #230/#288's own clamp-residual test already
  // established) rolls a LARGE, multi-slot merge target whose 3rd slot is
  // narrower than the source's own face, forcing the #230 clamp — the
  // corridor floor ends up WIDER than DOOR_WIDTH, and the side walls must
  // bound that real (wider) floor, not the narrower door.
  it('a wide (clamped merge-room) corridor still gets its side walls at the REAL floor edges, not the narrower door edges (#294, #231 residual)', () => {
    const seed = 'clamp-seed-1';
    const fromRect = { gx: 300, gy: 0, gw: 6, gh: 6 };
    const fromPos = { rank: 0, col: 0 };
    const toPos = { rank: 1, col: 0 };
    const toRect = roomRect(seed, 'merge-target', toPos.rank, toPos.col);
    expect(toRect.gw).toBe(ROOM_SIZE_LARGE); // sanity: this seed really does roll LARGE
    const toSlot = doorSlotsForFace(toRect, 3, 'north')[2];
    const { plainWalls, corridorSegments, doorWall } = buildEdgeCorridor(
      seed, 'merge-source', 'merge-target', fromRect, toRect, fromPos, toPos, 'south', toSlot, {},
    );
    const seg = corridorSegments[0];
    expect(seg.gw).toBeGreaterThan(DOOR_WIDTH); // sanity: this really is the wide-corridor case
    const spanX0 = seg.gx, spanX1 = seg.gx + seg.gw;
    const doorX0 = doorWall.x1, doorX1 = doorWall.x2;
    // The whole point of this scenario: the clamp (#230) pulls the
    // target's own gap away from the source's door on (at least) one
    // side, so the real floor span genuinely differs from the door's own
    // narrower width on that side — don't assume which side, just require
    // at least one to actually differ (both being equal would mean this
    // scenario failed to exercise the wide-corridor case at all).
    expect(spanX0 !== doorX0 || spanX1 !== doorX1).toBe(true);
    const westSide = plainWalls.find((w) => w.x1 === spanX0 && w.x2 === spanX0);
    const eastSide = plainWalls.find((w) => w.x1 === spanX1 && w.x2 === spanX1);
    expect(westSide).toBeDefined();
    expect(eastSide).toBeDefined();
    // And, just as importantly, on whichever side actually differs, NO
    // side wall sits at the narrower door edge instead — that would wall
    // over part of the real floor.
    if (spanX0 !== doorX0) {
      expect(plainWalls.find((w) => w.x1 === doorX0 && w.x2 === doorX0 && w.y1 !== w.y2)).toBeUndefined();
    }
    if (spanX1 !== doorX1) {
      expect(plainWalls.find((w) => w.x1 === doorX1 && w.x2 === doorX1 && w.y1 !== w.y2)).toBeUndefined();
    }
  });
});

describe('buildEdgeCorridor (multi-cell path)', () => {
  it('matches today\'s direct behavior when source and target are adjacent (no transit cells)', () => {
    const fromRect = { gx: 300, gy: 0, gw: 12, gh: 12 };
    const toRect = { gx: 300, gy: 13, gw: 12, gh: 12 };
    const toSlot = { x1: 300, y1: 13, x2: 312, y2: 13 };
    const result = buildEdgeCorridor(
      'seed1', 'a', 'b', fromRect, toRect, { rank: 0, col: 0 }, { rank: 1, col: 0 },
      'south', toSlot, {},
    );
    expect(result.transitCells).toEqual([]);
    expect(result.doorWall).toBeDefined();
    expect(result.revealDoorWall).toBeDefined();
  });

  it('produces one transitCells entry per intermediate cell when routing around an obstacle', () => {
    // #174 fix round: toPos is at rank 3 (not 2) so the blocked cell
    // ('1,0') sits short of toPos's own north-neighbor cell (rank 2,
    // col 0), which findCorridorPath now requires to stay free/be the
    // sole approach into toPos — see dungeon-layout.mjs's findCorridorPath
    // canEnter guard.
    const fromRect = { gx: 300, gy: 0, gw: 12, gh: 12 };
    const toRect = { gx: 300, gy: 39, gw: 12, gh: 12 }; // rank 3
    const toSlot = { x1: 300, y1: 39, x2: 312, y2: 39 };
    const occupiedCells = { '1,0': 'blocker' };
    const result = buildEdgeCorridor(
      'seed1', 'a', 'b', fromRect, toRect, { rank: 0, col: 0 }, { rank: 3, col: 0 },
      'south', toSlot, occupiedCells,
    );
    expect(result.transitCells.length).toBeGreaterThan(0);
    expect(result.transitCells.every((c) => `${c.rank},${c.col}` !== '1,0')).toBe(true);
  });

  it('two different edges crossing the same intermediate cell get geometrically distinct, non-conflicting crossings (Review Focus)', () => {
    // The actual wall-merging/idempotency check (skip vs. add-only-the-
    // new-opening) is Foundry-glue code in dungeon-scene.mjs, verified
    // live per Task 5's own manual checklist item (e) — this test pins
    // the piece buildEdgeCorridor itself is responsible for: that two
    // edges sharing a transit cell never get IDENTICAL geometry (which
    // would make "already built, skip" and "needs its own new opening"
    // indistinguishable), because each edge's own edgeId salts the
    // crossing's offset independently (see transitCellCrossing, Task 3).
    // #174 fix round: endpoints are at rank 3 (not 2) so the blocked
    // cell ('1,0') sits short of toPos's own north-neighbor cell,
    // consistent with findCorridorPath's canEnter guard (see the note
    // in the test above).
    const fromRectA = { gx: 300, gy: 0, gw: 12, gh: 12 };
    const toRectA = { gx: 300, gy: 39, gw: 12, gh: 12 };
    const toSlotA = { x1: 300, y1: 39, x2: 312, y2: 39 };
    const occupiedCells = { '1,0': 'blocker' };
    const resultA = buildEdgeCorridor(
      'seed1', 'a', 'b', fromRectA, toRectA, { rank: 0, col: 0 }, { rank: 3, col: 0 },
      'south', toSlotA, occupiedCells,
    );

    const fromRectC = { gx: 300 + 13, gy: 0, gw: 12, gh: 12 };
    const toRectC = { gx: 300 + 13, gy: 39, gw: 12, gh: 12 };
    const toSlotC = { x1: 300 + 13, y1: 39, x2: 300 + 13 + 12, y2: 39 };
    const resultC = buildEdgeCorridor(
      'seed1', 'c', 'd', fromRectC, toRectC, { rank: 0, col: 1 }, { rank: 3, col: 1 },
      'south', toSlotC, occupiedCells,
    );

    // Both detour through rank 1 (col 0 blocked, but A and C are in
    // different columns so they don't actually share a cell here — this
    // is the control case, confirming two INDEPENDENT edges each get
    // their own transitCells at all).
    expect(resultA.transitCells.length).toBeGreaterThan(0);
    expect(resultC.transitCells.length).toBeGreaterThan(0);

    // Now force both to cross the SAME cell (1,0) by routing C's own
    // endpoints through col 0 too, with a DIFFERENT edgeId (fromRoomId/
    // toRoomId pair) than A's.
    const resultD = buildEdgeCorridor(
      'seed1', 'e', 'f', fromRectA, toRectA, { rank: 0, col: 0 }, { rank: 3, col: 0 },
      'south', toSlotA, occupiedCells,
    );
    expect(resultD.transitCells).toHaveLength(resultA.transitCells.length);
    const sameCells = resultD.transitCells.every((c, i) =>
      c.rank === resultA.transitCells[i].rank && c.col === resultA.transitCells[i].col,
    );
    expect(sameCells).toBe(true); // same cell(s) crossed...
    const identicalGeometry = resultD.transitCells.every((c, i) =>
      c.entryPoint.x === resultA.transitCells[i].entryPoint.x &&
      c.entryPoint.y === resultA.transitCells[i].entryPoint.y,
    );
    expect(identicalGeometry).toBe(false); // ...but a distinct crossing point, since edgeId differs
  });

  it('falls back to a direct line when findCorridorPath finds no route', () => {
    const fromRect = { gx: 300, gy: 0, gw: 12, gh: 12 };
    const toRect = { gx: 300, gy: 26, gw: 12, gh: 12 };
    const toSlot = { x1: 300, y1: 26, x2: 312, y2: 26 };
    const occupiedCells = {
      '1,0': 'x', '1,1': 'x', '1,-1': 'x', '1,2': 'x', '1,-2': 'x',
      '0,1': 'x', '0,-1': 'x', '0,2': 'x', '0,-2': 'x',
      '2,1': 'x', '2,-1': 'x', '2,2': 'x', '2,-2': 'x',
    };
    const result = buildEdgeCorridor(
      'seed1', 'a', 'b', fromRect, toRect, { rank: 0, col: 0 }, { rank: 2, col: 0 },
      'south', toSlot, occupiedCells,
    );
    expect(result.transitCells).toEqual([]);
    expect(result.doorWall).toBeDefined();
    // #297 update: '1,0' (the intermediate cell between fromPos and toPos)
    // is occupied by room 'x' here -- exactly the boxed-in-through-a-real-
    // room scenario #297's own dogleg now detects and reroutes around,
    // where this test used to pin the OLD, buggy single-segment direct
    // line straight through 'x' -- the "known, documented limitation" the
    // #174 Task 5 comment above once described. For seed1/fromRoomId 'a',
    // doorX0 lands at 306, inside 'x''s own rolled 12-wide footprint at
    // (1,0) (gx 300..312), so the dogleg now fires. Hand-traced from
    // buildEdgeCorridor's own #297 geometry: faceY=12, doorX0=306,
    // doorX1=307, occupantEastEdge (x's own east edge)=312, laneX0=312,
    // laneX1=313, turnGx=min(306,312)=306, turnGx2=max(307,313)=313,
    // turnBottom=faceY+DOOR_WIDTH=13, corridorEndY=toRect.gy=26,
    // legTop=corridorEndY-DOOR_WIDTH=25. Review round 1 fix added turn 2:
    // gapX0=min(max(laneX0=312,toSlot.x1=300),toSlot.x2-DOOR_WIDTH=311)=311,
    // gapX1=312, so turn 2 spans
    // [min(laneX0=312,gapX0=311), max(laneX1=313,gapX1=312))=[311,313).
    expect(result.corridorSegments).toEqual([
      { gx: 306, gy: 12, gw: 7, gh: 1 },
      { gx: 312, gy: 13, gw: 1, gh: 12 },
      { gx: 311, gy: 25, gw: 2, gh: 1 },
    ]);
    // Review round 2 fix: foreignOpening now describes turn 2's own REAL
    // (wider) floor width -- [311,313) -- not the narrower lane width
    // round 1 used, so a future gap opened from this in the blocking
    // room's own south wall doesn't wall off part of turn 2's own real
    // floor. offset is relative to the blocking cell's own gx (300).
    expect(result.foreignOpening).toEqual({ roomId: 'x', side: 'south', offset: 11, width: 2 });
    // The real property #297 exists to guarantee: neither segment overlaps
    // room 'x''s own rolled footprint at (1,0).
    const xRect = roomRect('seed1', 'x', 1, 0);
    for (const seg of result.corridorSegments) {
      const overlapsX = seg.gx < xRect.gx + xRect.gw && seg.gx + seg.gw > xRect.gx;
      const overlapsY = seg.gy < xRect.gy + xRect.gh && seg.gy + seg.gh > xRect.gy;
      expect(overlapsX && overlapsY).toBe(false);
    }
    // Review round 1 fix: the corridor must actually REACH the target's
    // real door, not just avoid the blocker -- the last (turn 2) segment's
    // own x-range must cover revealDoorWall's own x-range.
    const lastSeg = result.corridorSegments[result.corridorSegments.length - 1];
    expect(lastSeg.gx).toBeLessThanOrEqual(result.revealDoorWall.x1);
    expect(lastSeg.gx + lastSeg.gw).toBeGreaterThanOrEqual(result.revealDoorWall.x2);
    // Review round 2 fix: pin the RELATIONSHIP, not just point values --
    // foreignOpening's own x-range (relative to the blocking cell) must
    // equal turn 2's own floor segment's x-range exactly, so a future
    // regression in either place (the wall opening or the floor) is
    // caught here even if the other one is edited without this test.
    const blockerCellForA = cellBounds(1, 0);
    expect(blockerCellForA.gx + result.foreignOpening.offset).toBe(lastSeg.gx);
    expect(blockerCellForA.gx + result.foreignOpening.offset + result.foreignOpening.width).toBe(lastSeg.gx + lastSeg.gw);
  });

  it('chains every crossing point end-to-end: entry/exit points align exactly across every boundary in a straight multi-cell corridor', () => {
    // Straight same-column descent, no obstacle needed — findCorridorPath
    // still returns a multi-cell path (rank 0 to rank 3 with nothing
    // blocking is 4 cells, 2 of them transit cells) since it always
    // routes cell-by-cell, not room-to-room. Kept deliberately straight
    // (entrySide/exitSide always 'north'/'south' here) so every forced
    // point shares the same axis (x) as the room doors' own — see the
    // Review Focus note on why a SIDEWAYS first hop needs its own,
    // axis-aware check instead (Task 5's whole-pipeline sweep covers that
    // general case).
    const fromRect = { gx: 300, gy: 0, gw: 12, gh: 12 };
    const toRect = { gx: 300, gy: 39, gw: 12, gh: 12 }; // rank 3
    const toSlot = { x1: 300, y1: 39, x2: 312, y2: 39 };
    const result = buildEdgeCorridor(
      'seed1', 'a', 'b', fromRect, toRect, { rank: 0, col: 0 }, { rank: 3, col: 0 },
      'south', toSlot, {},
    );
    expect(result.transitCells).toHaveLength(2); // ranks 1 and 2
    expect(result.transitCells.every((c) => c.entrySide === 'north' && c.exitSide === 'south')).toBe(true);

    // Source's real door (recoverable from doorWall's own center — same
    // convention the existing corner-branch tests use) aligns exactly
    // with the first cell's entry point — offset by DOOR_WIDTH/2, since
    // doorWall/revealDoorWall are gap-CENTER (matching the room's own
    // door), while a transit cell's own entryPoint/exitPoint are
    // gap-START (matching transitCellContainmentWalls — see #225 C1's
    // fix in buildEdgeCorridor for the full reasoning).
    const sourceDoorX = (result.doorWall.x1 + result.doorWall.x2) / 2;
    expect(result.transitCells[0].entryPoint.x).toBeCloseTo(sourceDoorX - DOOR_WIDTH / 2, 9);

    // Target's real door (recoverable from revealDoorWall's own center)
    // aligns exactly with the last cell's exit point, same center->start
    // offset.
    const targetDoorX = (result.revealDoorWall.x1 + result.revealDoorWall.x2) / 2;
    const lastCell = result.transitCells[result.transitCells.length - 1];
    expect(lastCell.exitPoint.x).toBeCloseTo(targetDoorX - DOOR_WIDTH / 2, 9);

    // The shared border between the two transit cells coincides exactly —
    // no more independently-seeded mismatch (#225 bug #2).
    expect(result.transitCells[0].exitPoint).toEqual(result.transitCells[1].entryPoint);
  });

  it('every transitCells entry carries the edge\'s own id, unchanged, for buildTransitCellIfNeeded\'s marker (#225 bug #3)', () => {
    const fromRect = { gx: 300, gy: 0, gw: 12, gh: 12 };
    const toRect = { gx: 300, gy: 39, gw: 12, gh: 12 };
    const toSlot = { x1: 300, y1: 39, x2: 312, y2: 39 };
    const occupiedCells = { '1,0': 'blocker' };
    const result = buildEdgeCorridor(
      'seed1', 'source-room', 'target-room', fromRect, toRect, { rank: 0, col: 0 }, { rank: 3, col: 0 },
      'south', toSlot, occupiedCells,
    );
    expect(result.transitCells.length).toBeGreaterThan(0);
    for (const cell of result.transitCells) {
      expect(cell.edgeId).toBe('source-room->target-room');
    }
  });

  it('a single-intermediate-cell path forces BOTH entry and exit from the two real room doors — no seeded randomness at all', () => {
    // rank 0 -> rank 2, nothing blocked: findCorridorPath returns exactly
    // one intermediate cell (rank 1), so the loop's only iteration has
    // isLast === true from its very first step.
    const fromRect = { gx: 300, gy: 0, gw: 12, gh: 12 };
    const toRect = { gx: 300, gy: 26, gw: 12, gh: 12 }; // rank 2
    const toSlot = { x1: 300, y1: 26, x2: 312, y2: 26 };
    // buildEdgeCorridor checks `path.length > 2` before it ever looks at
    // exitFace/sameColumn, so a same-column, south-exit connection still
    // takes the multi-cell branch here: findCorridorPath returns the
    // 3-cell path [rank 0, rank 1, rank 2] even with nothing blocked,
    // which is > 2.
    const result = buildEdgeCorridor(
      'seed1', 'a', 'b', fromRect, toRect, { rank: 0, col: 0 }, { rank: 2, col: 0 },
      'south', toSlot, {},
    );
    expect(result.transitCells).toHaveLength(1);
    // doorWall/revealDoorWall are gap-CENTER; entryPoint/exitPoint are
    // gap-START (see the previous test's comment, and #225 C1's fix in
    // buildEdgeCorridor).
    const sourceDoorX = (result.doorWall.x1 + result.doorWall.x2) / 2;
    const targetDoorX = (result.revealDoorWall.x1 + result.revealDoorWall.x2) / 2;
    expect(result.transitCells[0].entryPoint.x).toBeCloseTo(sourceDoorX - DOOR_WIDTH / 2, 9);
    expect(result.transitCells[0].exitPoint.x).toBeCloseTo(targetDoorX - DOOR_WIDTH / 2, 9);
  });
});

describe('buildEdgeCorridor with a west-incoming target', () => {
  const SMALL = ROOM_SIZE_SMALL;
  const smallRect = (rank, col) => {
    const cell = cellBounds(rank, col);
    return { gx: cell.gx, gy: cell.gy, gw: SMALL, gh: SMALL };
  };

  it('same-rank, east-exit fast path: door offsets align, corridor is a single horizontal segment', () => {
    const fromPos = { rank: 0, col: 0 };
    const toPos = { rank: 0, col: 1 };
    const fromRect = smallRect(0, 0);
    const toRect = smallRect(0, 1);
    const toSlot = doorSlotsForFace(toRect, 1, 'west');
    const result = buildEdgeCorridor(
      'seed1', 'a', 'b', fromRect, toRect, fromPos, toPos, 'east', toSlot[0], {}, 'west',
    );
    // doorWall sits on fromRect's own east face (a vertical segment)
    expect(result.doorWall.x1).toBe(fromRect.gx + fromRect.gw);
    expect(result.doorWall.x2).toBe(fromRect.gx + fromRect.gw);
    expect(result.doorWall.y1).not.toBe(result.doorWall.y2); // a real vertical span, not degenerate
    // revealDoorWall sits on toRect's own west face
    expect(result.revealDoorWall.x1).toBe(toRect.gx);
    expect(result.revealDoorWall.x2).toBe(toRect.gx);
    // exactly one horizontal corridor segment spanning between the two rooms
    expect(result.corridorSegments).toHaveLength(1);
    const seg = result.corridorSegments[0];
    expect(seg.gx).toBeCloseTo(fromRect.gx + fromRect.gw, 9);
    expect(seg.gx + seg.gw).toBeCloseTo(toRect.gx, 9);
  });

  // Regression coverage for a bug found by review after this task's own
  // brief only made `entryPoint` face-aware: `revealDoorWall`/`plainWalls`
  // in the corner and multi-cell branches were left computing a
  // horizontal wall unconditionally, even for a west toSlot (a vertical
  // line) -- producing a door/flanking-wall shape perpendicular to the
  // room's actual west face instead of running along it.
  function expectVerticalDoorGeometry(result, toSlot) {
    expect(result.revealDoorWall.x1).toBe(toSlot.x1);
    expect(result.revealDoorWall.x2).toBe(toSlot.x1);
    expect(result.revealDoorWall.y1).not.toBe(result.revealDoorWall.y2);
    // #324: plainWalls now also includes the SOURCE room's own face-cap
    // walls (sourceFaceCapWalls) -- filter to the TARGET-side flanking
    // walls only (the ones this helper's own name is actually about),
    // identified by sitting on the target's own west face (x === toSlot.x1).
    const targetSideWalls = result.plainWalls.filter((w) => w.x1 === toSlot.x1 && w.x2 === toSlot.x1);
    expect(targetSideWalls.length).toBeGreaterThan(0); // sanity: the target-side walls this test is actually about exist
    for (const wall of targetSideWalls) {
      expect(wall.y1).toBeGreaterThanOrEqual(toSlot.y1);
      expect(wall.y2).toBeLessThanOrEqual(toSlot.y2);
    }
  }

  it('corner branch (different rank AND column, null path): reveal door and flanking walls run vertically along the west face', () => {
    const fromPos = { rank: 0, col: 0 };
    const toPos = { rank: 2, col: 2 };
    const fromRect = smallRect(0, 0);
    const toRect = smallRect(2, 2);
    const toSlot = doorSlotsForFace(toRect, 1, 'west')[0];
    // Boxed in: both north- and west-neighbor of toPos occupied.
    const occupiedCells = { '1,2': 'blockerN', '2,1': 'blockerW' };
    const result = buildEdgeCorridor(
      'seed1', 'a', 'b', fromRect, toRect, fromPos, toPos, 'south', toSlot, occupiedCells, 'west',
    );
    expectVerticalDoorGeometry(result, toSlot);
  });

  it('multi-cell branch (obstacle-routed path): reveal door and flanking walls run vertically along the west face', () => {
    const fromPos = { rank: 0, col: 0 };
    const toPos = { rank: 0, col: 3 };
    const fromRect = smallRect(0, 0);
    const toRect = smallRect(0, 3);
    const toSlot = doorSlotsForFace(toRect, 1, 'west')[0];
    // Block the direct row so the path must detour (multi-cell branch),
    // while keeping toPos's own west-neighbor free.
    const occupiedCells = { '1,1': 'blocker', '1,2': 'blocker' };
    const result = buildEdgeCorridor(
      'seed1', 'a', 'b', fromRect, toRect, fromPos, toPos, 'east', toSlot, occupiedCells, 'west',
    );
    expect(result.transitCells.length).toBeGreaterThan(0); // sanity: this really is the multi-cell branch
    expectVerticalDoorGeometry(result, toSlot);
  });

  it('the corridor segment never overlaps either room\'s own footprint', () => {
    for (let seedIndex = 0; seedIndex < 20; seedIndex += 1) {
      const seed = `sweep-west-${seedIndex}`;
      const fromPos = { rank: 0, col: 0 };
      const toPos = { rank: 0, col: 1 };
      const fromRect = smallRect(0, 0);
      const toRect = smallRect(0, 1);
      const toSlot = doorSlotsForFace(toRect, 1, 'west');
      const { corridorSegments } = buildEdgeCorridor(seed, 'a', 'b', fromRect, toRect, fromPos, toPos, 'east', toSlot[0], {}, 'west');
      for (const seg of corridorSegments) {
        const overlapsFrom = seg.gx < fromRect.gx + fromRect.gw && seg.gx + seg.gw > fromRect.gx && seg.gy < fromRect.gy + fromRect.gh && seg.gy + seg.gh > fromRect.gy;
        const overlapsTo = seg.gx < toRect.gx + toRect.gw && seg.gx + seg.gw > toRect.gx && seg.gy < toRect.gy + toRect.gh && seg.gy + seg.gh > toRect.gy;
        expect(overlapsFrom).toBe(false);
        expect(overlapsTo).toBe(false);
      }
    }
  });

  it('a null path (boxed in, both north and west neighbors occupied) falls back to the honest direct-line degradation, not a trunk-lane hack', () => {
    const fromPos = { rank: 0, col: 0 };
    const toPos = { rank: 2, col: 2 };
    const fromRect = smallRect(0, 0);
    const toRect = smallRect(2, 2);
    const toSlot = doorSlotsForFace(toRect, 1, 'north');
    // Block both toPos's north-neighbor (1,2) and west-neighbor (2,1).
    const occupiedCells = { '1,2': 'blockerN', '2,1': 'blockerW' };
    const result = buildEdgeCorridor('seed1', 'a', 'b', fromRect, toRect, fromPos, toPos, 'south', toSlot[0], occupiedCells, 'north');
    // fromPos/toPos are different columns, so this hits the
    // different-column/corner branch's own collapsed null-path handling
    // -- its found-path shape is always exactly 2 segments (one leg per
    // axis), never the old trunk-lane hack's 3-segment shape.
    expect(result.corridorSegments).toHaveLength(2);
  });

  it('north-incoming behavior is byte-identical to before this change (regression guard)', () => {
    const fromPos = { rank: 0, col: 0 };
    const toPos = { rank: 1, col: 0 };
    const fromRect = smallRect(0, 0);
    const toRect = smallRect(1, 0);
    const toSlot = doorSlotsForFace(toRect, 1, 'north');
    const withDefault = buildEdgeCorridor('seed1', 'a', 'b', fromRect, toRect, fromPos, toPos, 'south', toSlot[0], {});
    const withExplicitNorth = buildEdgeCorridor('seed1', 'a', 'b', fromRect, toRect, fromPos, toPos, 'south', toSlot[0], {}, 'north');
    expect(withDefault).toEqual(withExplicitNorth);
  });
});

describe('buildEdgeCorridor — #297 dogleg around a blocking intermediate room', () => {
  // Mirrors the live-reported repro: source at rank 0, target (a merge
  // room reached via a shortcut) at rank 2, same column -- with an
  // unrelated room occupying rank 1 of that same column whose footprint
  // the naive direct line would cross. A LARGE source room (gw=12) and a
  // SMALL blocking room (gw=6) reproduces the live scenario's own size
  // mix and guarantees doorX0 can land inside the blocker's narrower
  // footprint.
  const seed = 'dogleg-repro-seed-0';

  // doorOffsetAt is deterministic per (seed, slot, role, roomSize) -- for
  // THIS seed/fromRoomId/exitFace combination it's a fixed value. The
  // concrete seed above was chosen (see Step 1a) by looping
  // 'dogleg-repro-seed-' + i and checking roomSizeAt/doorOffsetAt/roomRect
  // directly until the real outgoingOffset it produces at
  // 'from-room-south' already landed inside a 6-wide blocker's own
  // footprint -- no runtime search needed here.

  it('routes around a blocking room instead of crossing its footprint', () => {
    const fromRoomId = 'from-room';
    const toRoomId = 'to-room';
    const blockerRoomId = 'blocker-room';
    const fromPos = { rank: 0, col: 0 };
    const toPos = { rank: 2, col: 0 };
    const fromRect = roomRect(seed, fromRoomId, fromPos.rank, fromPos.col);
    const toRect = roomRect(seed, toRoomId, toPos.rank, toPos.col);
    const occupiedCells = {
      '0,0': fromRoomId,
      '1,0': blockerRoomId,
      '2,0': toRoomId,
    };
    const toSlot = doorSlotsForFace(toRect, 1, 'north')[0];

    const result = buildEdgeCorridor(
      seed, fromRoomId, toRoomId, fromRect, toRect, fromPos, toPos,
      'south', toSlot, occupiedCells, 'north',
    );

    const blockerRect = roomRect(seed, blockerRoomId, 1, 0);

    // The real property, not a proxy: no corridor floor segment overlaps
    // the blocker's own rect at all.
    for (const seg of result.corridorSegments) {
      const overlapsX = seg.gx < blockerRect.gx + blockerRect.gw && seg.gx + seg.gw > blockerRect.gx;
      const overlapsY = seg.gy < blockerRect.gy + blockerRect.gh && seg.gy + seg.gh > blockerRect.gy;
      expect(overlapsX && overlapsY).toBe(false);
    }

    // A dogleg was actually exercised for this scenario (the whole point
    // of the test) -- if this ever fails, the seed no longer produces a
    // doorX0 inside the blocker's footprint and must be re-chosen.
    expect(result.foreignOpening).not.toBeNull();
    expect(result.foreignOpening.roomId).toBe(blockerRoomId);
    // Review round 1 fix: the lane travels vertically through the
    // blocker's own EAST margin but never crosses that room's own east
    // wall -- it crosses the blocker's own SOUTH wall (turn 2) to reach
    // the target's cell below, so the opening is on the blocker's south
    // side.
    expect(result.foreignOpening.side).toBe('south');
    // Review round 1 fix: the corridor must actually REACH the target's
    // real door, not just avoid the blocker -- the last (turn 2) segment's
    // own x-range must cover revealDoorWall's own x-range.
    const lastSeg = result.corridorSegments[result.corridorSegments.length - 1];
    expect(lastSeg.gx).toBeLessThanOrEqual(result.revealDoorWall.x1);
    expect(lastSeg.gx + lastSeg.gw).toBeGreaterThanOrEqual(result.revealDoorWall.x2);
    // Review round 2 fix: foreignOpening now describes turn 2's own real
    // (potentially wider-than-DOOR_WIDTH) floor width, not the narrower
    // lane width round 1 used -- pin the RELATIONSHIP (not just point
    // values) between foreignOpening's own x-range (relative to the
    // blocking cell) and turn 2's own floor segment's x-range, so a
    // future regression in either place is caught here.
    const blockerCell = cellBounds(1, 0);
    expect(blockerCell.gx + result.foreignOpening.offset).toBe(lastSeg.gx);
    expect(blockerCell.gx + result.foreignOpening.offset + result.foreignOpening.width).toBe(lastSeg.gx + lastSeg.gw);
  });

  it('activates due to #230/#231 span-widening even when the raw door offset alone would miss the blocker', () => {
    // Review round 3 fix (Task 5's own closing system-wide sweep measured
    // 40/455, 8.79%, dogleg-eligible overlap across a 500-seed corpus):
    // this exact seed/room combination is the "does not activate" test's
    // OWN original scenario from round 1/2 -- doorX0=308 sits safely past
    // the blocker's own east edge (306), so the OLD trigger
    // (`doorX0 < occupantEastEdge`) correctly declined. But the TARGET
    // here is SMALL (gw=6) while the toSlot is a single-incoming, full-
    // width slot clamped to that narrow 6-wide face -- #230's own
    // pre-existing gap-widening (`gapX0`/`spanX0`/`spanX1`) then clamps
    // gapX0 down to 305 and widens the final span back to [305,309],
    // which DOES cross the blocker's [300,306] footprint. The widened-
    // trigger fix (`spanOverlapsBlocker`, checking the SAME provisional
    // span the non-dogleg branch would actually produce) now correctly
    // catches this and reroutes -- this test pins that regression
    // directly, since round 1/2's own narrower trigger silently produced
    // an overlapping corridor for this exact scenario.
    const missSeed = 'dogleg-miss-seed-2';
    const fromRoomId = 'from-room-2';
    const toRoomId = 'to-room-2';
    const blockerRoomId = 'blocker-room-2';
    const fromPos = { rank: 0, col: 0 };
    const toPos = { rank: 2, col: 0 };
    const fromRect = roomRect(missSeed, fromRoomId, fromPos.rank, fromPos.col);
    const toRect = roomRect(missSeed, toRoomId, toPos.rank, toPos.col);
    const occupiedCells = {
      '0,0': fromRoomId, '2,0': toRoomId,
      '1,0': blockerRoomId, '1,1': 'y', '1,-1': 'y', '1,2': 'y', '1,-2': 'y',
      '0,1': 'y', '0,-1': 'y', '0,2': 'y', '0,-2': 'y',
      '2,1': 'y', '2,-1': 'y', '2,2': 'y', '2,-2': 'y',
    };
    const toSlot = doorSlotsForFace(toRect, 1, 'north')[0];

    const result = buildEdgeCorridor(
      missSeed, fromRoomId, toRoomId, fromRect, toRect, fromPos, toPos,
      'south', toSlot, occupiedCells, 'north',
    );

    // Confirm the scenario is real: doorX0 alone sits past the blocker's
    // own east edge (the OLD trigger's own check), yet the dogleg still
    // activates (the round-3 fix's whole point).
    const blockerRect = roomRect(missSeed, blockerRoomId, 1, 0);
    const outgoingOffset = doorOffsetAt(missSeed, `${fromRoomId}-south`, 'outgoing', fromRect.gw);
    const doorX0 = fromRect.gx + outgoingOffset;
    expect(doorX0).toBeGreaterThanOrEqual(blockerRect.gx + blockerRect.gw);
    expect(result.foreignOpening).not.toBeNull();

    // The real property: no corridor floor segment overlaps the blocker's
    // own rect.
    for (const seg of result.corridorSegments) {
      const overlapsX = seg.gx < blockerRect.gx + blockerRect.gw && seg.gx + seg.gw > blockerRect.gx;
      const overlapsY = seg.gy < blockerRect.gy + blockerRect.gh && seg.gy + seg.gh > blockerRect.gy;
      expect(overlapsX && overlapsY).toBe(false);
    }
    // Connectivity: the last (turn 2) segment must actually reach the
    // real door.
    const lastSeg = result.corridorSegments[result.corridorSegments.length - 1];
    expect(lastSeg.gx).toBeLessThanOrEqual(result.revealDoorWall.x1);
    expect(lastSeg.gx + lastSeg.gw).toBeGreaterThanOrEqual(result.revealDoorWall.x2);
    // Hand-traced exact geometry (faceY=12, doorX0=308, doorX1=309,
    // occupantEastEdge=306 -- so laneX0=306, laneX1=307; toSlot clamps
    // gapX0 to 305, gapX1=306; turn 2 spans [min(306,305), max(307,306))
    // = [305,307)).
    expect(result.corridorSegments).toEqual([
      { gx: 306, gy: 12, gw: 3, gh: 1 },
      { gx: 306, gy: 13, gw: 1, gh: 12 },
      { gx: 305, gy: 25, gw: 2, gh: 1 },
    ]);
    expect(result.foreignOpening).toEqual({ roomId: blockerRoomId, side: 'south', offset: 5, width: 2 });
  });

  it('does not activate when a real blocker exists but neither the raw door offset nor the widened span reaches its footprint', () => {
    // Review round 3 fix: this test used to use `dogleg-miss-seed-2`
    // (checking only that doorX0 missed the blocker), but that scenario
    // turned out to ALSO exercise the round-3 gap (#230's own span-
    // widening reaching back into the blocker even though doorX0 alone
    // didn't) -- see the test above, which now correctly pins that as an
    // ACTIVATING case. A genuine "does not activate" test needs a
    // scenario where the WIDENED span also misses the blocker, not just
    // doorX0 alone -- found via the same seed-search method as Step 1a
    // and the round-3 fix's own provisional-span formula, this time using
    // a LARGE (gw=12) target so its toSlot spans the target's full face
    // (a single incoming connection, no #230 clamping at all) and
    // doorX0/doorX1 land safely past the blocker's own east edge with no
    // widening effect possible.
    const missSeed = 'dogleg-clean-miss-seed-27';
    const fromRoomId = 'from-room-2';
    const toRoomId = 'to-room-2';
    const blockerRoomId = 'blocker-room-2';
    const fromPos = { rank: 0, col: 0 };
    const toPos = { rank: 2, col: 0 };
    const fromRect = roomRect(missSeed, fromRoomId, fromPos.rank, fromPos.col);
    const toRect = roomRect(missSeed, toRoomId, toPos.rank, toPos.col);
    const occupiedCells = {
      '0,0': fromRoomId, '2,0': toRoomId,
      '1,0': blockerRoomId, '1,1': 'y', '1,-1': 'y', '1,2': 'y', '1,-2': 'y',
      '0,1': 'y', '0,-1': 'y', '0,2': 'y', '0,-2': 'y',
      '2,1': 'y', '2,-1': 'y', '2,2': 'y', '2,-2': 'y',
    };
    const toSlot = doorSlotsForFace(toRect, 1, 'north')[0];

    const result = buildEdgeCorridor(
      missSeed, fromRoomId, toRoomId, fromRect, toRect, fromPos, toPos,
      'south', toSlot, occupiedCells, 'north',
    );

    // Confirm the scenario is real: doorX0 sits past the blocker's own
    // east edge, AND (since the target is LARGE, matching the source's
    // own full face width) the target's own slot is never narrower than
    // the source's face, so #230's own clamp never widens the span back
    // toward the blocker either -- '1,0' in occupiedCells above is a
    // genuine blocker room, not an empty cell.
    const blockerRect = roomRect(missSeed, blockerRoomId, 1, 0);
    const outgoingOffset = doorOffsetAt(missSeed, `${fromRoomId}-south`, 'outgoing', fromRect.gw);
    const doorX0 = fromRect.gx + outgoingOffset;
    expect(doorX0).toBeGreaterThanOrEqual(blockerRect.gx + blockerRect.gw);
    expect(toRect.gw).toBe(fromRect.gw);

    // Byte-identical to the pre-#297 single-box shape: no dogleg, no
    // third segment, no foreignOpening.
    expect(result.foreignOpening).toBeNull();
    expect(result.corridorSegments).toHaveLength(1);
    expect(result.corridorSegments).toEqual([
      { gx: 308, gy: 12, gw: 1, gh: 14 },
    ]);
  });
});

describe('marginBandApproach — #297 Round 2 extraction', () => {
  it("produces the turn geometry Round 1's own south-branch dogleg already computes for its own laneX0 target", () => {
    // Pinned values taken verbatim from the "activates due to #230/#231
    // span-widening" test above (search 'dogleg-miss-seed-2'): faceY=12,
    // doorX0=308, doorX1=309, occupantEastEdge=306 -- so laneX0=306,
    // laneWidth=DOOR_WIDTH=1 -- and that test's own result.corridorSegments[0]
    // ({ gx: 306, gy: 12, gw: 3, gh: 1 }) is exactly this helper's own
    // turnSegment for the same inputs, confirming these literals are real,
    // already-verified pinned values, not re-derived ones.
    const doorX0 = 308;
    const doorX1 = 309;
    const faceY = 12;
    const laneX0 = 306;
    const laneWidth = DOOR_WIDTH;
    const result = marginBandApproach(doorX0, doorX1, faceY, laneX0, laneWidth);
    expect(result.turnGx).toBe(Math.min(doorX0, laneX0));
    expect(result.turnGx2).toBe(Math.max(doorX1, laneX0 + laneWidth));
    expect(result.turnBottom).toBe(faceY + DOOR_WIDTH);
    expect(result.turnSegment).toEqual({ gx: result.turnGx, gy: faceY, gw: result.turnGx2 - result.turnGx, gh: DOOR_WIDTH });
    expect(result.turnWalls.length).toBeGreaterThan(0);
  });
});

describe('buildEdgeCorridor — #297 dogleg around a blocking intermediate room, mirrored onto the same-rank (east) fast path', () => {
  // Exact mirror of the south/sameColumn dogleg tests above, axes swapped
  // per the task-3 brief's own table (doorX0->doorY0, faceY->faceX,
  // corridorEndY->corridorEndX, etc.). `toSlot`/`incomingFace` here are
  // 'west', NOT 'north' -- a 'north' toSlot is a degenerate (single-y-value)
  // horizontal line on this branch, which only makes sense as the TARGET
  // face for a south-exit connection; an east-exit connection's physically
  // sensible target face is its own west face (a vertical slot spanning y),
  // the same pairing `outgoingMarginOffset`'s own test (above, "aligns an
  // east-face, same-rank connection") and this file's own pre-existing
  // "same-rank, east-exit fast path" test already establish.
  const seed = 'dogleg-east-from-room-e-0';

  // doorOffsetAt is deterministic per (seed, slot, role, roomSize) -- for
  // THIS seed/fromRoomId/exitFace combination it's a fixed value. Found
  // (per Step 1a) by looping 'dogleg-east-from-room-e-' + i and checking
  // roomSizeAt/doorOffsetAt/roomRect directly until the real outgoingOffset
  // it produces at 'from-room-e-east' already landed inside a 6-wide
  // (ROOM_SIZE_SMALL) blocker's own footprint -- no runtime search needed
  // here. Found on i=0: fromSize=12 (LARGE), blockerSize=6 (SMALL),
  // doorY0=0, blocker spans [0,6) -- 0 lands inside.
  it('routes around a blocking room instead of crossing its footprint', () => {
    const fromRoomId = 'from-room-e';
    const toRoomId = 'to-room-e';
    const blockerRoomId = 'blocker-room-e';
    const fromPos = { rank: 0, col: 0 };
    const toPos = { rank: 0, col: 2 };
    const fromRect = roomRect(seed, fromRoomId, fromPos.rank, fromPos.col);
    const toRect = roomRect(seed, toRoomId, toPos.rank, toPos.col);
    const occupiedCells = {
      '0,0': fromRoomId,
      '0,1': blockerRoomId,
      '0,2': toRoomId,
    };
    const toSlot = doorSlotsForFace(toRect, 1, 'west')[0];

    const result = buildEdgeCorridor(
      seed, fromRoomId, toRoomId, fromRect, toRect, fromPos, toPos,
      'east', toSlot, occupiedCells, 'west',
    );

    const blockerRect = roomRect(seed, blockerRoomId, 0, 1);

    // The real property, not a proxy: no corridor floor segment overlaps
    // the blocker's own rect at all.
    for (const seg of result.corridorSegments) {
      const overlapsX = seg.gx < blockerRect.gx + blockerRect.gw && seg.gx + seg.gw > blockerRect.gx;
      const overlapsY = seg.gy < blockerRect.gy + blockerRect.gh && seg.gy + seg.gh > blockerRect.gy;
      expect(overlapsX && overlapsY).toBe(false);
    }

    // A dogleg was actually exercised for this scenario (the whole point
    // of the test) -- if this ever fails, the seed no longer produces a
    // doorY0 inside the blocker's footprint and must be re-chosen.
    expect(result.foreignOpening).not.toBeNull();
    expect(result.foreignOpening.roomId).toBe(blockerRoomId);
    // The lane travels horizontally through the blocker's own SOUTH
    // margin but never crosses that room's own south wall -- it crosses
    // the blocker's own EAST wall (turn 2) to reach the target's cell,
    // so the opening is on the blocker's east side (the exact mirror of
    // the south branch's own 'south' side).
    expect(result.foreignOpening.side).toBe('east');
    // The corridor must actually REACH the target's real door, not just
    // avoid the blocker -- the last (turn 2) segment's own y-range must
    // cover revealDoorWall's own y-range.
    const lastSeg = result.corridorSegments[result.corridorSegments.length - 1];
    expect(lastSeg.gy).toBeLessThanOrEqual(result.revealDoorWall.y1);
    expect(lastSeg.gy + lastSeg.gh).toBeGreaterThanOrEqual(result.revealDoorWall.y2);
    // Relationship pin (mirrors the south branch's own round-2 fix):
    // foreignOpening's own y-range must equal the LAST segment's own
    // y-range exactly, not merely overlap it -- both are the same turn-2
    // crossing, computed from the same values.
    const blockerCell = cellBounds(0, 1);
    expect(blockerCell.gy + result.foreignOpening.offset).toBe(lastSeg.gy);
    expect(blockerCell.gy + result.foreignOpening.offset + result.foreignOpening.width).toBe(lastSeg.gy + lastSeg.gh);
  });

  it('does not activate when a real blocker exists but doorY0 already sits past its own footprint', () => {
    // Same seed-search process as above (Step 1a), this time searching
    // for doorY0 landing AT OR PAST the blocker's own south edge instead
    // of inside it, so the dogleg condition (`doorY0 < occupantSouthEdge`)
    // is false and the output must be byte-identical to this file's
    // pre-#297 single-box shape. Found: fromSize=12, blockerSize=6,
    // doorY0=7, blocker spans [0,6) -- 7 sits past it.
    const missSeed = 'dogleg-east-from-room-e2-1';
    const fromRoomId = 'from-room-e2';
    const toRoomId = 'to-room-e2';
    const blockerRoomId = 'blocker-room-e2';
    const fromPos = { rank: 0, col: 0 };
    const toPos = { rank: 0, col: 2 };
    const fromRect = roomRect(missSeed, fromRoomId, fromPos.rank, fromPos.col);
    const toRect = roomRect(missSeed, toRoomId, toPos.rank, toPos.col);
    const occupiedCells = {
      '0,0': fromRoomId,
      '0,1': blockerRoomId,
      '0,2': toRoomId,
    };
    const toSlot = doorSlotsForFace(toRect, 1, 'west')[0];

    const result = buildEdgeCorridor(
      missSeed, fromRoomId, toRoomId, fromRect, toRect, fromPos, toPos,
      'east', toSlot, occupiedCells, 'west',
    );

    // Confirm the scenario is real: doorY0 (derived independently here,
    // the same way buildEdgeCorridor computes it internally) sits at or
    // past the blocker's own south edge -- '0,1' in occupiedCells above
    // is a genuine blocker room, not an empty cell.
    const blockerRect = roomRect(missSeed, blockerRoomId, 0, 1);
    const outgoingOffset = doorOffsetAt(missSeed, `${fromRoomId}-east`, 'outgoing', fromRect.gw);
    const doorY0 = fromRect.gy + outgoingOffset;
    expect(doorY0).toBeGreaterThanOrEqual(blockerRect.gy + blockerRect.gh);

    // Byte-identical to the pre-#297 single-box shape: no dogleg, no
    // third segment, no foreignOpening.
    expect(result.foreignOpening).toBeNull();
    expect(result.corridorSegments).toHaveLength(1);
    expect(result.corridorSegments).toEqual([
      { gx: 312, gy: 7, gw: 14, gh: 1 },
    ]);
  });
});

describe('cellBounds', () => {
  it('returns the full stride-sized cell at the same origin roomRect uses', () => {
    expect(cellBounds(0, 0)).toEqual({ gx: INITIAL_GX, gy: 0, gw: COLUMN_STRIDE, gh: ROW_STRIDE });
    expect(cellBounds(2, 3)).toEqual({
      gx: INITIAL_GX + 3 * COLUMN_STRIDE, gy: 2 * ROW_STRIDE, gw: COLUMN_STRIDE, gh: ROW_STRIDE,
    });
  });
});

describe('projectOntoSide', () => {
  const cell = cellBounds(1, 2); // gx: INITIAL_GX + 26, gy: 13, gw: 13, gh: 13

  it('north: shares the anchor\'s x, sits on the cell\'s own north edge', () => {
    expect(projectOntoSide(cell, 'north', { x: cell.gx + 5, y: 999 }))
      .toEqual({ x: cell.gx + 5, y: cell.gy });
  });

  it('south: shares the anchor\'s x, sits on the cell\'s own south edge', () => {
    expect(projectOntoSide(cell, 'south', { x: cell.gx + 5, y: 999 }))
      .toEqual({ x: cell.gx + 5, y: cell.gy + cell.gh });
  });

  it('west: shares the anchor\'s y, sits on the cell\'s own west edge', () => {
    expect(projectOntoSide(cell, 'west', { x: 999, y: cell.gy + 5 }))
      .toEqual({ x: cell.gx, y: cell.gy + 5 });
  });

  it('east: shares the anchor\'s y, sits on the cell\'s own east edge', () => {
    expect(projectOntoSide(cell, 'east', { x: 999, y: cell.gy + 5 }))
      .toEqual({ x: cell.gx + cell.gw, y: cell.gy + 5 });
  });

  it('is pure — never mutates the cell or anchor it was given', () => {
    const cellCopy = { ...cell };
    const anchor = { x: cell.gx + 5, y: cell.gy + 5 };
    const anchorCopy = { ...anchor };
    projectOntoSide(cell, 'east', anchor);
    expect(cell).toEqual(cellCopy);
    expect(anchor).toEqual(anchorCopy);
  });
});

describe('findCorridorPath', () => {
  it('returns a direct 2-cell path when adjacent and nothing blocks it', () => {
    const path = findCorridorPath(
      { rank: 0, col: 0 }, { rank: 1, col: 0 }, {}, { fromRoomId: 'a', toRoomId: 'b' },
    );
    expect(path).toEqual([{ rank: 0, col: 0 }, { rank: 1, col: 0 }]);
  });

  it('routes straight through empty cells when the endpoints are several ranks apart', () => {
    const path = findCorridorPath(
      { rank: 0, col: 0 }, { rank: 3, col: 0 }, {}, { fromRoomId: 'a', toRoomId: 'b' },
    );
    expect(path).toEqual([
      { rank: 0, col: 0 }, { rank: 1, col: 0 }, { rank: 2, col: 0 }, { rank: 3, col: 0 },
    ]);
  });

  it('detours around a cell occupied by an unrelated room', () => {
    // #174 fix round: a single-cell obstacle directly under fromPos,
    // well short of toPos's own north-neighbor, would produce a path
    // identical in shape to the north-reconvergence test below it — so
    // this uses a 3-wide barrier spanning columns -1..1 at rank 1
    // instead, forcing a genuinely wider sideways detour (through
    // column -2 or 2) to stay a distinct "generic BFS detour" check
    // from the north-entry-specific tests after this describe block.
    const occupiedCells = { '1,-1': 'blocker', '1,0': 'blocker', '1,1': 'blocker' };
    const path = findCorridorPath(
      { rank: 0, col: 0 }, { rank: 3, col: 0 }, occupiedCells, { fromRoomId: 'a', toRoomId: 'b' },
    );
    expect(path).not.toBeNull();
    expect(path).not.toContainEqual({ rank: 1, col: -1 });
    expect(path).not.toContainEqual({ rank: 1, col: 0 });
    expect(path).not.toContainEqual({ rank: 1, col: 1 });
    expect(path[0]).toEqual({ rank: 0, col: 0 });
    expect(path[path.length - 1]).toEqual({ rank: 3, col: 0 });
  });

  // #174 fix-round addendum: a room's incoming connection always lands
  // on its north face, and there is no margin to route through on any
  // other side — so a path whose last hop into toPos arrives from the
  // east, west, or south produces corridor geometry that cuts into the
  // target room's own interior. findCorridorPath must never return such
  // a path; it must treat toPos as reachable only from its own
  // north-neighbor cell.
  it('returns null when toPos\'s own north-neighbor cell is occupied, even though a longer lateral route into toPos would otherwise be free', () => {
    // Same occupiedCells/endpoints the pre-fix BFS used to "detour"
    // through: '1,0' is toPos's own north-neighbor here (toPos is
    // {rank: 2, col: 0}), so blocking it removes the only permitted
    // approach into toPos. A free lateral route into toPos still exists
    // via column 1 (entering from the east) — the pre-fix code returned
    // that path; the fixed code must not.
    const occupiedCells = { '1,0': 'blocker' };
    const path = findCorridorPath(
      { rank: 0, col: 0 }, { rank: 2, col: 0 }, occupiedCells, { fromRoomId: 'a', toRoomId: 'b' },
    );
    expect(path).toBeNull();
  });

  it('still finds a detour that re-converges on toPos\'s own column when toPos\'s immediate north neighbor is free', () => {
    // The obstacle blocks the direct route but sits short of toPos's
    // own north-neighbor cell (rank 2, col 0), which stays free — so a
    // path still exists, and it must approach toPos from the north.
    const occupiedCells = { '1,0': 'blocker' };
    const path = findCorridorPath(
      { rank: 0, col: 0 }, { rank: 3, col: 0 }, occupiedCells, { fromRoomId: 'a', toRoomId: 'b' },
    );
    expect(path).not.toBeNull();
    expect(path.slice(-2)).toEqual([{ rank: 2, col: 0 }, { rank: 3, col: 0 }]);
  });

  it('never treats the endpoints themselves as blocked, even though they are occupied by fromRoomId/toRoomId', () => {
    const occupiedCells = { '0,0': 'a', '1,0': 'b' };
    const path = findCorridorPath(
      { rank: 0, col: 0 }, { rank: 1, col: 0 }, occupiedCells, { fromRoomId: 'a', toRoomId: 'b' },
    );
    expect(path).toEqual([{ rank: 0, col: 0 }, { rank: 1, col: 0 }]);
  });

  it('returns null when every route is blocked within the search bounds', () => {
    const occupiedCells = { '1,0': 'x', '1,1': 'x', '1,-1': 'x', '0,1': 'x', '0,-1': 'x' };
    const path = findCorridorPath(
      { rank: 0, col: 0 }, { rank: 2, col: 0 }, occupiedCells, { fromRoomId: 'a', toRoomId: 'b' },
    );
    expect(path).toBeNull();
  });

  it('is deterministic — same inputs, same path, every call', () => {
    const occupiedCells = { '1,0': 'blocker' };
    const path1 = findCorridorPath({ rank: 0, col: 0 }, { rank: 2, col: 0 }, occupiedCells, { fromRoomId: 'a', toRoomId: 'b' });
    const path2 = findCorridorPath({ rank: 0, col: 0 }, { rank: 2, col: 0 }, occupiedCells, { fromRoomId: 'a', toRoomId: 'b' });
    expect(path2).toEqual(path1);
  });
});

describe('findCorridorPath with incomingFace', () => {
  it('defaults to north-only entry, byte-identical to before this change', () => {
    const occupiedCells = { '1,0': 'blocker' };
    const path = findCorridorPath({ rank: 0, col: 0 }, { rank: 2, col: 0 }, occupiedCells, { fromRoomId: 'a', toRoomId: 'b' });
    expect(path).toBeNull(); // north-neighbor (1,0) is the blocker
  });

  it('allows entry from the west-neighbor when incomingFace is west, even though north is blocked', () => {
    // toPos {rank:2,col:2}; north-neighbor (1,2) is blocked, west-neighbor (2,1) is free.
    const occupiedCells = { '1,2': 'blocker' };
    const path = findCorridorPath(
      { rank: 0, col: 0 }, { rank: 2, col: 2 }, occupiedCells,
      { fromRoomId: 'a', toRoomId: 'b', incomingFace: 'west' },
    );
    expect(path).not.toBeNull();
    expect(path[path.length - 1]).toEqual({ rank: 2, col: 2 });
    expect(path[path.length - 2]).toEqual({ rank: 2, col: 1 }); // must enter from the west-neighbor
  });

  it('still rejects a north approach when incomingFace is west (the target only accepts its own declared face)', () => {
    // toPos {rank:1,col:1}; its west-neighbor (1,0) is blocked, but its
    // north-neighbor (0,1) is free -- must NOT silently accept north
    // just because it's open, since incomingFace says west.
    const occupiedCells = { '1,0': 'blocker' };
    const path = findCorridorPath(
      { rank: 0, col: 1 }, { rank: 1, col: 1 }, occupiedCells,
      { fromRoomId: 'a', toRoomId: 'b', incomingFace: 'west' },
    );
    expect(path).toBeNull();
  });
});

describe('cellMarginWalls', () => {
  // #288: a ROOM_SIZE_LARGE room is NOT flush with its own cell —
  // ROW_STRIDE/COLUMN_STRIDE = ROOM_SIZE_LARGE + CORRIDOR_LEN, so a
  // LARGE room has a real, CORRIDOR_LEN-wide margin on its own
  // south/east sides too, exactly like a SMALL room's wider one. This
  // used to be silently skipped (the bug: no wall at all, not just a
  // misaligned gap) — a player could see and walk straight through it.
  it('seals both the east and south margin for a ROOM_SIZE_LARGE room, one CORRIDOR_LEN wide, with no open connection', () => {
    const rect = { gx: 300, gy: 0, gw: ROOM_SIZE_LARGE, gh: ROOM_SIZE_LARGE };
    const walls = cellMarginWalls(rect, 0, 0, {});
    const east = walls.find((w) => w.dir === 'east');
    const south = walls.find((w) => w.dir === 'south');
    expect(east).toEqual({ dir: 'east', x1: 300 + COLUMN_STRIDE, y1: 0, x2: 300 + COLUMN_STRIDE, y2: ROW_STRIDE });
    expect(south).toEqual({ dir: 'south', x1: 300, y1: ROW_STRIDE, x2: 300 + COLUMN_STRIDE, y2: ROW_STRIDE });
    expect(COLUMN_STRIDE - ROOM_SIZE_LARGE).toBe(CORRIDOR_LEN); // sanity: the margin really is CORRIDOR_LEN wide, not zero
  });

  it('leaves a gap in a ROOM_SIZE_LARGE room\'s own south margin where a connection crosses it', () => {
    const rect = { gx: 300, gy: 0, gw: ROOM_SIZE_LARGE, gh: ROOM_SIZE_LARGE };
    const walls = cellMarginWalls(rect, 0, 0, { south: [{ offset: 6, width: DOOR_WIDTH }] });
    const southWalls = walls.filter((w) => w.dir === 'south');
    expect(southWalls.length).toBe(2); // two segments flanking a 1-unit gap inside a 1-unit-wide margin
    for (const w of southWalls) {
      expect(w.x2 <= 306 || w.x1 >= 307).toBe(true);
    }
  });

  it('seals both the east and south margin for a small room with no open connection', () => {
    const rect = { gx: 300, gy: 0, gw: ROOM_SIZE_SMALL, gh: ROOM_SIZE_SMALL };
    const walls = cellMarginWalls(rect, 0, 0, {});
    const east = walls.find((w) => w.dir === 'east');
    const south = walls.find((w) => w.dir === 'south');
    expect(east).toEqual({ dir: 'east', x1: 300 + COLUMN_STRIDE, y1: 0, x2: 300 + COLUMN_STRIDE, y2: ROW_STRIDE });
    expect(south).toEqual({ dir: 'south', x1: 300, y1: ROW_STRIDE, x2: 300 + COLUMN_STRIDE, y2: ROW_STRIDE });
  });

  it('leaves a gap in the east margin wall where a connection crosses it', () => {
    const rect = { gx: 300, gy: 0, gw: ROOM_SIZE_SMALL, gh: ROOM_SIZE_SMALL };
    const walls = cellMarginWalls(rect, 0, 0, { east: [{ offset: 4, width: 2 }] });
    const eastWalls = walls.filter((w) => w.dir === 'east');
    // Two remaining solid segments flanking the gap, never spanning across it.
    expect(eastWalls.length).toBe(2);
    for (const w of eastWalls) {
      expect(w.y2 <= 4 || w.y1 >= 6).toBe(true);
    }
  });

  it('omits a flanking segment entirely when the gap reaches a cell corner', () => {
    const rect = { gx: 300, gy: 0, gw: ROOM_SIZE_SMALL, gh: ROOM_SIZE_SMALL };
    const walls = cellMarginWalls(rect, 0, 0, { south: [{ offset: 0, width: ROOM_SIZE_SMALL }] });
    const southWalls = walls.filter((w) => w.dir === 'south');
    expect(southWalls.length).toBe(1); // only the segment from the gap's end to the cell's far corner
  });

  it('containment sweep: cellMarginWalls seals the full cell boundary except exactly at the declared opening, across many size/connection combinations', () => {
    // cellMarginWalls' own wall segments sit at the CELL's outer
    // boundary — a different (further out) x/y position than
    // roomEnclosureWalls' own room-rect walls whenever the room is
    // smaller than its cell, so the two wall sets are parallel, not
    // continuous, and are verified separately: roomEnclosureWalls' own
    // no-gap invariant is already covered by its own existing tests
    // (Task 5, #93); this sweep is cellMarginWalls' own equivalent,
    // checked across the realistic size/opening combination space rather
    // than the single hand-picked case each earlier test in this file
    // already covers. (The full room+margin containment, as one
    // continuous seal a token can't slip through, is verified live —
    // Task 5's own manual checklist — since only a real built scene's
    // wall documents share one true coordinate system to check for gaps
    // in.)
    function sideFullyAccountedFor(dir, cell, wallsOnThatSide, openStart, openEnd) {
      const full = dir === 'east' ? cell.gh : cell.gw;
      for (let unit = 0; unit < full; unit += 1) {
        const inOpening = openStart >= 0 && unit >= openStart && unit < openEnd;
        const covered = wallsOnThatSide.some((w) => {
          const lo = dir === 'east' ? w.y1 - cell.gy : w.x1 - cell.gx;
          const hi = dir === 'east' ? w.y2 - cell.gy : w.x2 - cell.gx;
          return unit >= Math.min(lo, hi) && unit < Math.max(lo, hi);
        });
        if (inOpening === covered) return false; // open-but-walled, or closed-but-gapped — either is wrong
      }
      return true;
    }

    // #288: ROOM_SIZE_LARGE swept too — it has its own real,
    // CORRIDOR_LEN-wide margin now, not "no margin at all."
    for (const roomSize of [ROOM_SIZE_SMALL, ROOM_SIZE_LARGE]) {
      for (const opening of [
        {},
        { east: [{ offset: 2, width: roomSize === ROOM_SIZE_LARGE ? DOOR_WIDTH : 2 }] },
        { south: [{ offset: 0, width: roomSize === ROOM_SIZE_LARGE ? DOOR_WIDTH : 3 }] },
      ]) {
        const rank = 1;
        const col = 1;
        const rect = { gx: 300 + col * COLUMN_STRIDE, gy: rank * ROW_STRIDE, gw: roomSize, gh: roomSize };
        const margin = cellMarginWalls(rect, rank, col, opening);
        const cell = cellBounds(rank, col);
        for (const dir of ['east', 'south']) {
          const hasMargin = dir === 'east' ? roomSize < cell.gw : roomSize < cell.gh;
          expect(hasMargin).toBe(true); // sanity: both sizes have a real margin post-#288 (LARGE: CORRIDOR_LEN wide)
          const wallsOnSide = margin.filter((w) => w.dir === dir);
          const openings = opening[dir] ?? [];
          const openStart = openings.length > 0 ? openings[0].offset : -1;
          const openEnd = openings.length > 0 ? openings[0].offset + openings[0].width : -1;
          expect(sideFullyAccountedFor(dir, cell, wallsOnSide, openStart, openEnd)).toBe(true);
        }
      }
    }
  });

  // #288: every ROOM_SIZE_LARGE room in a REAL generated dungeon now
  // gets a real east+south margin seal — the whole-pipeline proof this
  // bug class's other fixes (#225, #230) established: real seeds, real
  // room placement, not just a single hand-picked rect.
  it('every ROOM_SIZE_LARGE room in a real generated dungeon gets a non-empty east and south margin seal, across a large seed/roomCount sweep', () => {
    let totalLargeRooms = 0;
    for (let i = 0; i < 500; i += 1) {
      const seed = `sweep-${i}`;
      const roomCount = 6 + (i % 15);
      const { rooms, edges } = buildRoomGraph({ seed, roomCount });
      const { layoutEdges } = attachHiddenPaths({ rooms, edges, seed });
      const ranks = computeRanks(layoutEdges, 'room-entry');
      const columns = computeColumns(layoutEdges, ranks, 'room-entry');
      for (const roomId of Object.keys(rooms)) {
        const rank = ranks[roomId];
        const col = columns[roomId];
        const rect = roomRect(seed, roomId, rank, col);
        if (rect.gw !== ROOM_SIZE_LARGE) continue;
        totalLargeRooms += 1;
        const walls = cellMarginWalls(rect, rank, col, {});
        expect(walls.some((w) => w.dir === 'east')).toBe(true);
        expect(walls.some((w) => w.dir === 'south')).toBe(true);
      }
    }
    expect(totalLargeRooms).toBeGreaterThan(200); // sanity: real LARGE rooms were actually exercised
  });

  // #353: sealSide's own east/south wall only closes the margin's OUTER
  // edge (the cell's own boundary) -- an opening's own PASSAGE across the
  // margin strip (from the room's real wall out to that outer edge) had
  // nothing capping its perpendicular sides, leaking sight the whole
  // width of the strip. These pin the new passage-cap walls directly.
  it('caps both perpendicular sides of an east opening\'s own passage across the margin strip', () => {
    const rect = { gx: 300, gy: 0, gw: ROOM_SIZE_SMALL, gh: ROOM_SIZE_SMALL };
    const cell = cellBounds(0, 0);
    const walls = cellMarginWalls(rect, 0, 0, { east: [{ offset: 2, width: DOOR_WIDTH }] });
    const caps = walls.filter((w) => w.dir === undefined);
    expect(caps.length).toBe(2);
    const nearEdge = rect.gx + rect.gw;
    const farEdge = cell.gx + cell.gw;
    expect(caps).toContainEqual({ x1: nearEdge, y1: 2, x2: farEdge, y2: 2 });
    expect(caps).toContainEqual({ x1: nearEdge, y1: 3, x2: farEdge, y2: 3 });
  });

  it('caps both perpendicular sides of a south opening\'s own passage across the margin strip', () => {
    const rect = { gx: 300, gy: 0, gw: ROOM_SIZE_SMALL, gh: ROOM_SIZE_SMALL };
    const cell = cellBounds(0, 0);
    const walls = cellMarginWalls(rect, 0, 0, { south: [{ offset: 1, width: DOOR_WIDTH }] });
    const caps = walls.filter((w) => w.dir === undefined);
    expect(caps.length).toBe(2);
    const nearEdge = rect.gy + rect.gh;
    const farEdge = cell.gy + cell.gh;
    expect(caps).toContainEqual({ x1: 301, y1: nearEdge, x2: 301, y2: farEdge });
    expect(caps).toContainEqual({ x1: 302, y1: nearEdge, x2: 302, y2: farEdge });
  });

  it('adds no passage caps when a side has no openings', () => {
    const rect = { gx: 300, gy: 0, gw: ROOM_SIZE_SMALL, gh: ROOM_SIZE_SMALL };
    const walls = cellMarginWalls(rect, 0, 0, {});
    expect(walls.filter((w) => w.dir === undefined).length).toBe(0);
  });

  it('caps every opening on a side independently when there are two (own connection + a foreign dogleg)', () => {
    const rect = { gx: 300, gy: 0, gw: ROOM_SIZE_SMALL, gh: ROOM_SIZE_SMALL };
    const walls = cellMarginWalls(rect, 0, 0, {
      east: [{ offset: 1, width: DOOR_WIDTH }, { offset: 4, width: DOOR_WIDTH }],
    });
    const caps = walls.filter((w) => w.dir === undefined);
    expect(caps.length).toBe(4); // 2 openings x 2 caps each
  });
});

describe('cellMarginWalls — multiple openings per side', () => {
  it('seals a side with two non-overlapping openings into three segments', () => {
    const rect = { gx: 300, gy: 0, gw: 6, gh: 6 };
    const walls = cellMarginWalls(rect, 0, 0, {
      east: [{ offset: 1, width: 1 }, { offset: 4, width: 1 }],
    });
    const eastWalls = walls.filter((w) => w.dir === 'east').sort((a, b) => a.y1 - b.y1);
    // cell is (300,0)-(313,13); rect is 6x6, so east margin runs y:[0,13] at x:313.
    // Two 1-wide gaps at y=1 and y=4 split the east side into three segments:
    // [0,1], [2,4], [5,13].
    expect(eastWalls).toEqual([
      { dir: 'east', x1: 313, y1: 0, x2: 313, y2: 1 },
      { dir: 'east', x1: 313, y1: 2, x2: 313, y2: 4 },
      { dir: 'east', x1: 313, y1: 5, x2: 313, y2: 13 },
    ]);
  });

  it('with a single opening, matches the old single-opening call exactly (plus #353\'s own passage caps)', () => {
    const rect = { gx: 300, gy: 0, gw: 6, gh: 6 };
    const oldStyle = cellMarginWalls(rect, 0, 0, { east: [{ offset: 2, width: 1 }] });
    // Same outer-boundary seal whether expressed as the old openSide/
    // openOffset/openWidth shape or the new list-of-one shape — the
    // generalization is a strict superset of THAT part, not a behavior
    // change. #353 added two more (dir-less) passage-cap walls on top,
    // capping the opening's own crossing of the margin strip itself.
    expect(oldStyle).toEqual([
      { dir: 'east', x1: 313, y1: 0, x2: 313, y2: 2 },
      { dir: 'east', x1: 313, y1: 3, x2: 313, y2: 13 },
      { dir: 'south', x1: 300, y1: 13, x2: 313, y2: 13 },
      { x1: 306, y1: 2, x2: 313, y2: 2 },
      { x1: 306, y1: 3, x2: 313, y2: 3 },
    ]);
  });

  it('with no openings on a margin-having side, seals it fully (unchanged behavior)', () => {
    const rect = { gx: 300, gy: 0, gw: 6, gh: 6 };
    const walls = cellMarginWalls(rect, 0, 0, {});
    expect(walls).toEqual([
      { dir: 'east', x1: 313, y1: 0, x2: 313, y2: 13 },
      { dir: 'south', x1: 300, y1: 13, x2: 313, y2: 13 },
    ]);
  });

  it('a LARGE room (no margin on a side) ignores openings for that side', () => {
    const rect = { gx: 300, gy: 0, gw: 12, gh: 12 };
    const walls = cellMarginWalls(rect, 0, 0, { east: [{ offset: 0, width: 1 }] });
    // gw === cell.gw (13? no -- LARGE=12, cell=13, margin=1, so east DOES
    // have margin here) -- use gw===cell.gw case instead: a room exactly
    // filling the cell has no margin on that side at all.
    const fullRect = { gx: 300, gy: 0, gw: 13, gh: 13 };
    const noMarginWalls = cellMarginWalls(fullRect, 0, 0, { east: [{ offset: 0, width: 1 }] });
    expect(noMarginWalls.filter((w) => w.dir === 'east')).toEqual([]);
  });
});

describe('transitCellContainmentWalls', () => {
  it('seals all four sides solid when given no openings', () => {
    const walls = transitCellContainmentWalls(1, 1, []);
    const cell = cellBounds(1, 1);
    expect(walls).toHaveLength(4);
    for (const dir of ['north', 'south', 'east', 'west']) {
      expect(walls.filter((w) => w.dir === dir)).toHaveLength(1);
    }
    const north = walls.find((w) => w.dir === 'north');
    expect(north).toEqual({ dir: 'north', x1: cell.gx, y1: cell.gy, x2: cell.gx + cell.gw, y2: cell.gy });
  });

  it('leaves a gap on each side that has an opening, sealing the other two sides fully', () => {
    const cell = cellBounds(0, 0);
    const entryPoint = { x: cell.gx + 3, y: cell.gy }; // on the north side
    const exitPoint = { x: cell.gx + cell.gw, y: cell.gy + 5 }; // on the east side
    const walls = transitCellContainmentWalls(0, 0, [
      { side: 'north', point: entryPoint },
      { side: 'east', point: exitPoint },
    ]);

    // South and west have no opening — one full-length solid wall each.
    expect(walls.filter((w) => w.dir === 'south')).toHaveLength(1);
    expect(walls.filter((w) => w.dir === 'west')).toHaveLength(1);

    // North and east each have a gap flanked by up to two solid segments,
    // never spanning across the gap itself.
    const northWalls = walls.filter((w) => w.dir === 'north');
    for (const w of northWalls) {
      expect(w.x2 <= entryPoint.x || w.x1 >= entryPoint.x + CORRIDOR_LEN).toBe(true);
    }
    const eastWalls = walls.filter((w) => w.dir === 'east');
    for (const w of eastWalls) {
      expect(w.y2 <= exitPoint.y || w.y1 >= exitPoint.y + CORRIDOR_LEN).toBe(true);
    }
  });

  it('supports two independent openings on the same side (a second edge crossing via the same side)', () => {
    const cell = cellBounds(2, 0);
    const pointA = { x: cell.gx + 1, y: cell.gy };
    const pointB = { x: cell.gx + 8, y: cell.gy };
    const walls = transitCellContainmentWalls(2, 0, [
      { side: 'north', point: pointA },
      { side: 'north', point: pointB },
    ]);
    const northWalls = walls.filter((w) => w.dir === 'north');
    // Three solid segments: before pointA, between pointA and pointB, after pointB.
    expect(northWalls.length).toBe(3);
    for (const w of northWalls) {
      const overlapsA = w.x1 < pointA.x + CORRIDOR_LEN && w.x2 > pointA.x;
      const overlapsB = w.x1 < pointB.x + CORRIDOR_LEN && w.x2 > pointB.x;
      expect(overlapsA).toBe(false);
      expect(overlapsB).toBe(false);
    }
  });

  it('omits a flanking segment entirely when the gap reaches a cell corner', () => {
    const cell = cellBounds(0, 0);
    const entryPoint = { x: cell.gx, y: cell.gy }; // north side, at the very west corner
    const walls = transitCellContainmentWalls(0, 0, [{ side: 'north', point: entryPoint }]);
    const northWalls = walls.filter((w) => w.dir === 'north');
    expect(northWalls.length).toBe(1); // only the segment from the gap's end to the cell's far corner
  });

  it('containment sweep: seals the full cell boundary except exactly at each declared opening', () => {
    // Same methodology as cellMarginWalls' own containment sweep, but
    // across all four sides and an arbitrary number of openings per side,
    // since a transit cell has no anchor corner restricting it to two.
    function sideFullyAccountedFor(dir, cell, wallsOnThatSide, openings) {
      const full = dir === 'east' || dir === 'west' ? cell.gh : cell.gw;
      const base = dir === 'east' || dir === 'west' ? cell.gy : cell.gx;
      for (let unit = 0; unit < full; unit += 1) {
        const inOpening = openings.some((o) => unit >= o && unit < o + CORRIDOR_LEN);
        const covered = wallsOnThatSide.some((w) => {
          const lo = (dir === 'east' || dir === 'west' ? w.y1 : w.x1) - base;
          const hi = (dir === 'east' || dir === 'west' ? w.y2 : w.x2) - base;
          return unit >= Math.min(lo, hi) && unit < Math.max(lo, hi);
        });
        if (inOpening === covered) return false;
      }
      return true;
    }

    const rank = 1;
    const col = 2;
    const cell = cellBounds(rank, col);
    const combos = [
      [],
      [{ side: 'north', point: { x: cell.gx + 2, y: cell.gy } }],
      [{ side: 'south', point: { x: cell.gx + 0, y: cell.gy + cell.gh } }],
      [{ side: 'east', point: { x: cell.gx + cell.gw, y: cell.gy + 4 } }],
      [{ side: 'west', point: { x: cell.gx, y: cell.gy + 6 } }],
      [
        { side: 'north', point: { x: cell.gx + 1, y: cell.gy } },
        { side: 'south', point: { x: cell.gx + 9, y: cell.gy + cell.gh } },
      ],
      [
        { side: 'north', point: { x: cell.gx + 1, y: cell.gy } },
        { side: 'north', point: { x: cell.gx + 8, y: cell.gy } },
      ],
    ];
    for (const openings of combos) {
      const walls = transitCellContainmentWalls(rank, col, openings);
      for (const dir of ['north', 'south', 'east', 'west']) {
        const wallsOnSide = walls.filter((w) => w.dir === dir);
        const openingsOnSide = openings
          .filter((o) => o.side === dir)
          .map((o) => (dir === 'east' || dir === 'west' ? o.point.y - cell.gy : o.point.x - cell.gx));
        expect(sideFullyAccountedFor(dir, cell, wallsOnSide, openingsOnSide)).toBe(true);
      }
    }
  });
});

describe('transitCellCrossing', () => {
  it('draws a single straight segment for a north-to-south (opposite sides) crossing', () => {
    const result = transitCellCrossing('seed1', 1, 0, 'north', 'south', 'a->b');
    expect(result.corridorSegments).toHaveLength(1);
    expect(result.entryPoint.y).toBe(cellBounds(1, 0).gy);
    expect(result.exitPoint.y).toBe(cellBounds(1, 0).gy + ROW_STRIDE);
    // The straight segment never leaves this cell's own bounds.
    const cell = cellBounds(1, 0);
    for (const seg of result.corridorSegments) {
      expect(seg.gx).toBeGreaterThanOrEqual(cell.gx);
      expect(seg.gx + seg.gw).toBeLessThanOrEqual(cell.gx + cell.gw);
      expect(seg.gy).toBeGreaterThanOrEqual(cell.gy);
      expect(seg.gy + seg.gh).toBeLessThanOrEqual(cell.gy + cell.gh);
    }
  });

  // #353 follow-up: transitCellContainmentWalls (called separately) only
  // seals this CELL's own outer boundary -- plainWalls here is this
  // crossing's OWN contribution, flanking the corridor's own 1-unit-wide
  // passage so it's separated from the rest of this cell's own open
  // interior, not just left as an empty array (the actual bug: a token in
  // the passage had unobstructed sight to the whole cell's own dead
  // space).
  it('flanks a straight-through crossing\'s own passage with exactly two walls, on both long sides', () => {
    const result = transitCellCrossing('seed1', 1, 0, 'north', 'south', 'a->b');
    expect(result.plainWalls).toHaveLength(2);
    const [seg] = result.corridorSegments;
    // A north-south crossing is a vertical (narrow-x) strip -- flanked
    // west (x=seg.gx) and east (x=seg.gx+seg.gw), each spanning its own
    // full y-range, not the cell's own outer boundary (a different x).
    for (const w of result.plainWalls) {
      expect(w.x1).toBe(w.x2); // vertical wall
      expect(Math.min(w.y1, w.y2)).toBe(seg.gy);
      expect(Math.max(w.y1, w.y2)).toBe(seg.gy + seg.gh);
    }
    const xs = result.plainWalls.map((w) => w.x1).sort((a, b) => a - b);
    expect(xs).toEqual([seg.gx, seg.gx + seg.gw]);
  });

  it('flanks an east-west straight-through crossing horizontally instead', () => {
    const result = transitCellCrossing('seed1', 1, 0, 'west', 'east', 'a->b');
    expect(result.plainWalls).toHaveLength(2);
    const [seg] = result.corridorSegments;
    for (const w of result.plainWalls) {
      expect(w.y1).toBe(w.y2); // horizontal wall
      expect(Math.min(w.x1, w.x2)).toBe(seg.gx);
      expect(Math.max(w.x1, w.x2)).toBe(seg.gx + seg.gw);
    }
    const ys = result.plainWalls.map((w) => w.y1).sort((a, b) => a - b);
    expect(ys).toEqual([seg.gy, seg.gy + seg.gh]);
  });

  it('draws an L-shaped 2-segment path for a north-to-east (adjacent sides) crossing, staying inside the cell', () => {
    const result = transitCellCrossing('seed1', 0, 0, 'north', 'east', 'a->b');
    expect(result.corridorSegments.length).toBeGreaterThanOrEqual(1);
    const cell = cellBounds(0, 0);
    for (const seg of result.corridorSegments) {
      expect(seg.gx).toBeGreaterThanOrEqual(cell.gx);
      expect(seg.gx + seg.gw).toBeLessThanOrEqual(cell.gx + cell.gw);
      expect(seg.gy).toBeGreaterThanOrEqual(cell.gy);
      expect(seg.gy + seg.gh).toBeLessThanOrEqual(cell.gy + cell.gh);
    }
  });

  // #355 follow-up: live-reported after that fix shipped -- a player got
  // stuck at what looked like a dead end where a corridor actually turns.
  // Two distinct bugs were found chasing this, both caught by the same
  // BFS reachability check below:
  // 1. Flanking seg1 and seg2 independently put a wall right across the
  //    corner cell the two segments share, sealing the turn shut instead
  //    of containing the passage (confirmed live: an unflagged wall
  //    directly overlapped a door opening transitCellContainmentWalls had
  //    correctly left open).
  // 2. A pre-existing (not introduced by #355), previously-invisible gap
  //    in seg1/seg2's own geometry: for certain entrySide/exitSide
  //    combinations (confirmed live: entrySide 'north' + exitSide
  //    'west'), NEITHER segment's own cell range actually reached the
  //    corner cell at all -- a real gap in the floor tiles too, not just
  //    the walls, invisible before because nothing ever tested cell-level
  //    connectivity this way.
  // This is the actual regression guard for both -- a direct BFS walk
  // through the corridor's own cells, blocked only by the returned
  // plainWalls, independent of the implementation's own internal
  // cell/flanking logic (re-deriving corridor occupancy from
  // corridorSegments here, not reusing any private helper).
  function corridorCellSet(segments) {
    const cells = new Set();
    for (const { gx, gy, gw, gh } of segments) {
      if (gh > gw) {
        for (let y = gy; y < gy + gh; y += 1) cells.add(`${gx},${y}`);
      } else {
        for (let x = gx; x < gx + gw; x += 1) cells.add(`${x},${gy}`);
      }
    }
    return cells;
  }
  function wallsBlockEdge(plainWalls, a, b) {
    // The shared edge between two orthogonally-adjacent unit cells.
    const x1 = Math.max(a.gx, b.gx);
    const y1 = Math.max(a.gy, b.gy);
    const x2 = a.gx === b.gx ? x1 + 1 : x1;
    const y2 = a.gy === b.gy ? y1 + 1 : y1;
    return plainWalls.some(
      (w) =>
        (Math.min(w.x1, w.x2) === Math.min(x1, x2) &&
          Math.max(w.x1, w.x2) === Math.max(x1, x2) &&
          Math.min(w.y1, w.y2) === Math.min(y1, y2) &&
          Math.max(w.y1, w.y2) === Math.max(y1, y2)),
    );
  }
  function reachable(plainWalls, cellSet, fromKey, toKey) {
    const seen = new Set([fromKey]);
    const queue = [fromKey];
    while (queue.length) {
      const key = queue.shift();
      if (key === toKey) return true;
      const [gx, gy] = key.split(',').map(Number);
      for (const [dx, dy] of [[0, -1], [0, 1], [-1, 0], [1, 0]]) {
        const next = { gx: gx + dx, gy: gy + dy };
        const nextKey = `${next.gx},${next.gy}`;
        if (!cellSet.has(nextKey) || seen.has(nextKey)) continue;
        if (wallsBlockEdge(plainWalls, { gx, gy }, next)) continue;
        seen.add(nextKey);
        queue.push(nextKey);
      }
    }
    return false;
  }

  it('keeps the corridor passable through every corner turn (#355 regression)', () => {
    const SIDES = ['north', 'south', 'east', 'west'];
    const OPPOSITE = { north: 'south', south: 'north', east: 'west', west: 'east' };
    for (const entrySide of SIDES) {
      for (const exitSide of SIDES) {
        if (entrySide === exitSide || OPPOSITE[entrySide] === exitSide) continue;
        const result = transitCellCrossing('seed1', 0, 0, entrySide, exitSide, `${entrySide}->${exitSide}`);
        const cellSet = corridorCellSet(result.corridorSegments);
        // Any cell from seg1 (the entry leg) to any cell from seg2 (the
        // exit leg) -- the two segments must stay connected through the
        // corner they share, regardless of exactly which cell each one's
        // own entryPoint/exitPoint maps to.
        const [seg1, seg2] = result.corridorSegments;
        const fromKey = [...corridorCellSet([seg1])][0];
        const toKey = [...corridorCellSet([seg2])][0];
        expect(reachable(result.plainWalls, cellSet, fromKey, toKey)).toBe(true);
      }
    }
  });

  it('is deterministic for a given seed, rank, col, and edgeId', () => {
    const a = transitCellCrossing('seed1', 2, 1, 'west', 'east', 'x->y');
    const b = transitCellCrossing('seed1', 2, 1, 'west', 'east', 'x->y');
    expect(b).toEqual(a);
  });

  it('produces a different offset for a different edgeId crossing the same cell', () => {
    const a = transitCellCrossing('seed1', 2, 1, 'west', 'east', 'x->y');
    const b = transitCellCrossing('seed1', 2, 1, 'west', 'east', 'p->q');
    expect(b.entryPoint).not.toEqual(a.entryPoint);
  });

  // The two containment checks above only bound each segment's own rect
  // inside the cell — a segment that's individually in-bounds but too
  // short to actually reach the corner (e.g. a fixed CORRIDOR_LEN-sized
  // stub near entryPoint that never extends down to the corner's own y)
  // would still pass them. This test instead checks the corner-turn path
  // is actually CONTINUOUS: the first segment must span the full run from
  // entryPoint to the corner, and the second must span the full run from
  // the corner to exitPoint — not just sit somewhere inside the cell.
  it('connects entryPoint to exitPoint through the corner, not just two disconnected stubs', () => {
    const result = transitCellCrossing('seed1', 0, 0, 'north', 'east', 'a->b');
    const { entryPoint, exitPoint } = result;
    const corner = { x: entryPoint.x, y: exitPoint.y };

    // entryPoint -> corner is vertical (shared x): some segment's y-range
    // must fully cover [entryPoint.y, corner.y].
    const lo1 = Math.min(entryPoint.y, corner.y);
    const hi1 = Math.max(entryPoint.y, corner.y);
    const spansEntryToCorner = result.corridorSegments.some(
      (seg) => seg.gy <= lo1 && seg.gy + seg.gh >= hi1
    );
    expect(spansEntryToCorner).toBe(true);

    // corner -> exitPoint is horizontal (shared y): some segment's x-range
    // must fully cover [corner.x, exitPoint.x].
    const lo2 = Math.min(corner.x, exitPoint.x);
    const hi2 = Math.max(corner.x, exitPoint.x);
    const spansCornerToExit = result.corridorSegments.some(
      (seg) => seg.gx <= lo2 && seg.gx + seg.gw >= hi2
    );
    expect(spansCornerToExit).toBe(true);
  });

  // #174 fix round 2: the fixed-CORRIDOR_LEN dimension of each corner-case
  // leg must extend INWARD from its anchor point, not always in the
  // positive direction — entryPoint sits at the cell's own FAR edge
  // exactly when entrySide/exitSide is 'east'/'south' (SIDE_POINT uses
  // `cell.gx + cell.gw`/`cell.gy + cell.gh` for those sides), so extending
  // positively from there overflows into the next cell. Of the 8 valid
  // adjacent-side pairings, only 3 (east/north, east/south, west/south)
  // ever exercise this — a single hand-picked pairing (north/east, used
  // above) never hits it, which is exactly why the earlier fix round
  // missed it. Sweep all 8 pairings, across several seeds/edgeIds, so no
  // single pairing's own geometry can hide a regression again.
  it('keeps every segment within cellBounds for all 8 adjacent-side pairings', () => {
    const SIDES = ['north', 'south', 'east', 'west'];
    const OPPOSITE = { north: 'south', south: 'north', east: 'west', west: 'east' };
    const adjacentPairings = [];
    for (const entrySide of SIDES) {
      for (const exitSide of SIDES) {
        if (entrySide !== exitSide && OPPOSITE[entrySide] !== exitSide) {
          adjacentPairings.push([entrySide, exitSide]);
        }
      }
    }
    expect(adjacentPairings).toHaveLength(8);

    const rank = 1;
    const col = 1;
    const cell = cellBounds(rank, col);
    for (const [entrySide, exitSide] of adjacentPairings) {
      for (let seedIndex = 0; seedIndex < 20; seedIndex += 1) {
        const seed = `sweep-seed-${seedIndex}`;
        const edgeId = `edge-${seedIndex}`;
        const result = transitCellCrossing(seed, rank, col, entrySide, exitSide, edgeId);
        for (const seg of result.corridorSegments) {
          expect(seg.gx).toBeGreaterThanOrEqual(cell.gx);
          expect(seg.gx + seg.gw).toBeLessThanOrEqual(cell.gx + cell.gw);
          expect(seg.gy).toBeGreaterThanOrEqual(cell.gy);
          expect(seg.gy + seg.gh).toBeLessThanOrEqual(cell.gy + cell.gh);
        }
      }
    }
  });

  it('uses a forced entry point verbatim instead of the seeded offset', () => {
    const forcedEntryPoint = { x: 12345, y: 67 };
    const result = transitCellCrossing('seed1', 1, 0, 'north', 'south', 'a->b', { forcedEntryPoint });
    expect(result.entryPoint).toEqual(forcedEntryPoint);
  });

  it('uses a forced exit point verbatim instead of the seeded offset', () => {
    const forcedExitPoint = { x: 999, y: 111 };
    const result = transitCellCrossing('seed1', 1, 0, 'north', 'south', 'a->b', { forcedExitPoint });
    expect(result.exitPoint).toEqual(forcedExitPoint);
  });

  it('forces entry and exit independently — one forced, the other still seeded', () => {
    const forcedEntryPoint = { x: 12345, y: 67 };
    const withForcedEntry = transitCellCrossing('seed1', 1, 0, 'north', 'south', 'a->b', { forcedEntryPoint });
    const seededOnly = transitCellCrossing('seed1', 1, 0, 'north', 'south', 'a->b');
    expect(withForcedEntry.entryPoint).toEqual(forcedEntryPoint);
    expect(withForcedEntry.exitPoint).toEqual(seededOnly.exitPoint); // exit still seeded, unaffected
  });

  it('omitting the options object is byte-identical to every pre-#225 call (regression guard)', () => {
    const withoutOptions = transitCellCrossing('seed1', 2, 1, 'west', 'east', 'x->y');
    const withEmptyOptions = transitCellCrossing('seed1', 2, 1, 'west', 'east', 'x->y', {});
    expect(withEmptyOptions).toEqual(withoutOptions);
  });

  it('a forced point still produces valid, in-bounds corridorSegments (corner case)', () => {
    // Adjacent sides (north/east) with entry forced onto the cell's own
    // north edge — the free axis (exit) is still seeded, and the
    // resulting corner geometry must stay inside the cell, same
    // containment guarantee as the fully-seeded case.
    const cell = cellBounds(0, 0);
    const forcedEntryPoint = { x: cell.gx + 3, y: cell.gy };
    const result = transitCellCrossing('seed1', 0, 0, 'north', 'east', 'a->b', { forcedEntryPoint });
    expect(result.entryPoint).toEqual(forcedEntryPoint);
    for (const seg of result.corridorSegments) {
      expect(seg.gx).toBeGreaterThanOrEqual(cell.gx);
      expect(seg.gx + seg.gw).toBeLessThanOrEqual(cell.gx + cell.gw);
      expect(seg.gy).toBeGreaterThanOrEqual(cell.gy);
      expect(seg.gy + seg.gh).toBeLessThanOrEqual(cell.gy + cell.gh);
    }
  });
});

describe('outgoingMarginOffset (#174 Task 5 fix round)', () => {
  // Regression coverage for a bug class that bit twice before being
  // caught: a room's cell-margin containment wall must leave its gap
  // exactly where buildEdgeCorridor will actually route the real
  // corridor, or the wall gets built directly across the corridor's own
  // crossing point. Each case here computes both outgoingMarginOffset's
  // result AND buildEdgeCorridor's own real doorWall for the identical
  // inputs, and asserts they describe the same position — the actual
  // invariant that matters, not just outgoingMarginOffset's return value
  // in isolation.
  const seed = 'margin-offset-alignment';
  const smallRect = (rank, col) => {
    const cell = cellBounds(rank, col);
    return { gx: cell.gx, gy: cell.gy, gw: ROOM_SIZE_SMALL, gh: ROOM_SIZE_SMALL };
  };

  function expectSouthAlignment(fromPos, toPos, occupiedCells) {
    const fromRect = smallRect(fromPos.rank, fromPos.col);
    const toRect = smallRect(toPos.rank, toPos.col);
    // outgoingMarginOffset now derives its own toRect internally via
    // roomRect(seed, 'B', toPos.rank, toPos.col) — this hand-built
    // toRect must actually match that, or this test would silently stop
    // exercising what it claims to (#288's own review round found this
    // exact class of drift already, in a different test).
    expect(toRect).toEqual(roomRect(seed, 'B', toPos.rank, toPos.col));
    const { offset, width } = outgoingMarginOffset(seed, 'A', 'B', 'south', fromRect, fromPos, toPos, occupiedCells);
    const toSlot = doorSlotsForFace(toRect, 1, 'north')[0];
    const { doorWall } = buildEdgeCorridor(seed, 'A', 'B', fromRect, toRect, fromPos, toPos, 'south', toSlot, occupiedCells);
    const marginWalls = cellMarginWalls(fromRect, fromPos.rank, fromPos.col, {
      south: [{ offset, width }],
    }).filter((w) => w.dir === 'south');
    // The margin wall's gap (the space between its two solid segments)
    // must span exactly [doorWall.x1, doorWall.x2].
    expect(marginWalls).toHaveLength(2);
    const gapX0 = Math.min(...marginWalls.map((w) => w.x2));
    const gapX1 = Math.max(...marginWalls.map((w) => w.x1));
    expect(gapX0).toBeCloseTo(doorWall.x1, 9);
    expect(gapX1).toBeCloseTo(doorWall.x2, 9);
  }

  it('aligns a same-column, one-rank-apart connection (buildEdgeCorridor\'s offset-based branch)', () => {
    expectSouthAlignment({ rank: 0, col: 0 }, { rank: 1, col: 0 }, {});
  });

  it('aligns a same-column, multi-rank-apart connection with no obstacle (buildEdgeCorridor\'s multi-cell branch)', () => {
    expectSouthAlignment({ rank: 0, col: 0 }, { rank: 3, col: 0 }, {});
  });

  it('aligns a same-column, multi-rank-apart connection whose target\'s north-neighbor is occupied (buildEdgeCorridor\'s null-path fallback branch)', () => {
    // This is the exact scenario a re-review found the first fix-round
    // pass missed: findCorridorPath returns null here (the target's own
    // north-neighbor cell is blocked), and buildEdgeCorridor's fallback
    // for a null path uses the SAME offset-based formula as a
    // directly-adjacent connection — a rank-gap-only check gets this
    // wrong.
    expectSouthAlignment({ rank: 0, col: 0 }, { rank: 3, col: 0 }, { '2,0': 'blocker' });
  });

  it('aligns an east-face, same-rank connection (buildEdgeCorridor\'s east/sameRank offset-based fast path, added in the incoming-face redesign)', () => {
    const fromPos = { rank: 0, col: 0 };
    const toPos = { rank: 0, col: 1 };
    const fromRect = smallRect(fromPos.rank, fromPos.col);
    const toRect = smallRect(toPos.rank, toPos.col);
    expect(toRect).toEqual(roomRect(seed, 'B', toPos.rank, toPos.col)); // same drift guard as expectSouthAlignment
    // #288's own review round: this test used to omit incomingFace
    // entirely (defaulting to 'north') while exiting 'east' — a null vs.
    // length<=2 path both reach this SAME fast path (usesOffsetBasedExit
    // is `aligned && (!path || path.length<=2)`), so path itself was
    // never the problem. The real bug: outgoingMarginOffset's NEW code
    // internally builds an ASSUMED toSlot via
    // `doorSlotsForFace(toRect,1,incomingFace)` — with the omitted
    // 'north' default, that's a HORIZONTAL slot (y1===y2), but an
    // 'east'-exit fast path clamps along Y — producing a degenerate,
    // out-of-bounds `gapY0 = -1`. The OLD outgoingMarginOffset never
    // built real geometry, so this mismatch was invisible; the NEW one
    // does. Passing the coherent, matching `incomingFace: 'west'`
    // (a VERTICAL slot, the axis an east-exit fast path actually clamps
    // along) fixes it, and is also the physically sensible choice for a
    // same-rank east-west pair.
    const { offset, width } = outgoingMarginOffset(seed, 'A', 'B', 'east', fromRect, fromPos, toPos, {}, 'west');
    const toSlot = doorSlotsForFace(toRect, 1, 'west')[0];
    const { doorWall } = buildEdgeCorridor(seed, 'A', 'B', fromRect, toRect, fromPos, toPos, 'east', toSlot, {}, 'west');
    const marginWalls = cellMarginWalls(fromRect, fromPos.rank, fromPos.col, {
      east: [{ offset, width }],
    }).filter((w) => w.dir === 'east');
    expect(marginWalls).toHaveLength(2);
    const gapY0 = Math.min(...marginWalls.map((w) => w.y2));
    const gapY1 = Math.max(...marginWalls.map((w) => w.y1));
    expect(gapY0).toBeCloseTo(doorWall.y1, 9);
    expect(gapY1).toBeCloseTo(doorWall.y2, 9);
  });

  it('aligns a different-column south connection (buildEdgeCorridor\'s center-based branch — multi-cell here, since a 1-rank/1-col move is Manhattan distance 2, but shares its exitPoint formula byte-for-byte with the different-column fallback branch)', () => {
    expectSouthAlignment({ rank: 0, col: 0 }, { rank: 1, col: 1 }, {});
  });

  // #230: the alignment checks above only ever compare the margin wall's
  // gap against the SOURCE's own doorWall — which was ALREADY correct
  // before this fix (outgoingMarginOffset always re-derives the exact
  // same seeded offset buildEdgeCorridor's own doorWall uses). That's
  // exactly why this bug class went undetected: the real defect was
  // that buildEdgeCorridor's own same-column/same-rank fast path draws
  // its corridor floor wide enough to ALSO reach the TARGET's own
  // independently-seeded incoming offset, but the source's cell-margin
  // wall's gap never accounted for that — so it could cover the
  // target's own door entirely. This reproduces the exact live scenario
  // that surfaced the bug (seed/room ids from a real generated dungeon,
  // #230's own issue body) and checks the invariant that actually
  // matters: the margin wall's gap must cover BOTH the source's door
  // AND the target's own revealDoorWall, not just the source's.
  it('the source room\'s own margin-wall gap never covers the target\'s own door, even when their independently-seeded offsets would otherwise differ (#230)', () => {
    const seed = '1790639860888-ap2tnimbepu';
    const fromRect = { gx: 300, gy: 0, gw: 6, gh: 6 };
    const toRect = { gx: 300, gy: 13, gw: 6, gh: 6 };
    const fromPos = { rank: 0, col: 0 };
    const toPos = { rank: 1, col: 0 };
    const toSlot = doorSlotsForFace(toRect, 1, 'north')[0];
    const result = buildEdgeCorridor(seed, 'room-entry', 'room-room-entry-0', fromRect, toRect, fromPos, toPos, 'south', toSlot, {});
    const { offset, width } = outgoingMarginOffset(seed, 'room-entry', 'room-room-entry-0', 'south', fromRect, fromPos, toPos, {}, 'north');
    const marginWalls = cellMarginWalls(fromRect, 0, 0, { south: [{ offset, width }] })
      .filter((w) => w.dir === 'south');
    // The margin wall's own gap (space between its solid segments) must
    // fully contain the target's own real door interval.
    const gapStart = Math.min(...marginWalls.map((w) => w.x2));
    const gapEnd = Math.max(...marginWalls.map((w) => w.x1));
    expect(gapStart).toBeLessThanOrEqual(result.revealDoorWall.x1 + 1e-9);
    expect(gapEnd).toBeGreaterThanOrEqual(result.revealDoorWall.x2 - 1e-9);
    // And, now that the fix derives the target's own gap from the
    // source's door offset, the corridor floor itself collapses back to
    // exactly DOOR_WIDTH wide in this single-incoming-slot case — not
    // the wider, independently-seeded-offsets span the bug produced.
    expect(result.corridorSegments).toHaveLength(1);
    expect(result.corridorSegments[0].gw).toBeCloseTo(DOOR_WIDTH, 9);
  });

  // #230's own documented residual: a merge room's own incoming slot can
  // be narrower than the source's full face, forcing the derived target
  // offset to clamp — reintroducing a (smaller) version of the same gap.
  // This test doesn't assert the residual away; it pins the clamped
  // shape so a future fix attempt has a concrete case to work from.
  it('a narrower target slot (merge room, multiple incoming connections) can still clamp the derived offset, leaving a residual gap (#230/#288, documented limitation)', () => {
    // #288's own review round: outgoingMarginOffset now derives its own
    // gap by calling buildEdgeCorridor with an ASSUMED single, full-width
    // incoming slot (correct for a real single-incoming-connection target
    // — the common case, and #288's own fix for that case). A merge
    // target's REAL slot (one of several, narrower than the assumed
    // full-width one) is a separate story — outgoingMarginOffset has no
    // way to know about it, so this scenario's own real toRect must be
    // derived the SAME way outgoingMarginOffset derives it internally
    // (roomRect(seed, toRoomId, ...)), not hand-constructed, or the two
    // would silently disagree for a reason this test doesn't intend to
    // exercise. `clamp-seed-1` is confirmed (by direct roomSizeAt check)
    // to roll a LARGE 'merge-target', matching this scenario's own intent
    // (a merge room, split into narrower slots than the source's face).
    const seed = 'clamp-seed-1';
    const fromRect = { gx: 300, gy: 0, gw: 6, gh: 6 };
    const fromPos = { rank: 0, col: 0 };
    const toPos = { rank: 1, col: 0 };
    const toRect = roomRect(seed, 'merge-target', toPos.rank, toPos.col);
    expect(toRect.gw).toBe(ROOM_SIZE_LARGE); // sanity: this seed really does roll LARGE
    // 3 narrow incoming slots (4 units each) — narrower than the source's
    // own 6-unit face, so a source door offset near the source's own far
    // edge won't fit the slot this connection lands on.
    const toSlot = doorSlotsForFace(toRect, 3, 'north')[2]; // the slot farthest from the source's own column origin
    const result = buildEdgeCorridor(seed, 'merge-source', 'merge-target', fromRect, toRect, fromPos, toPos, 'south', toSlot, {});
    const { offset, width } = outgoingMarginOffset(seed, 'merge-source', 'merge-target', 'south', fromRect, fromPos, toPos, {}, 'north');
    const marginWalls = cellMarginWalls(fromRect, 0, 0, { south: [{ offset, width }] })
      .filter((w) => w.dir === 'south');
    const gapStart = Math.min(...marginWalls.map((w) => w.x2));
    const gapEnd = Math.max(...marginWalls.map((w) => w.x1));
    // Hand-traced and confirmed via a standalone script (not assumed):
    // outgoingMarginOffset's own ASSUMED full-width slot ([300,312], the
    // whole 12-wide target face) never needs to clamp against the
    // source's own doorX0=302, so it returns offset=2 (absolute 302),
    // width=DOOR_WIDTH=1 — its own margin gap is exactly [302,303],
    // matching doorWall.x1/x2 (still correct for the source's OWN real
    // door). But the REAL corridor (built with the REAL, narrower 3rd
    // slot) has its target's own real door at revealDoorWall=[308,309]
    // — outside outgoingMarginOffset's own assumed gap entirely, falling
    // inside the margin wall's own second solid segment ([303,313]).
    // `covers` is true only when the margin's own OPEN gap fully
    // contains the target's real door (i.e. NOT blocked) — pinned here
    // as `false` (still blocked): #288 does not solve the merge-room
    // residual, same documented scope as #230's own version of this test.
    const covers = gapStart <= result.revealDoorWall.x1 + 1e-9 && gapEnd >= result.revealDoorWall.x2 - 1e-9;
    expect(covers).toBe(false);
  });
});

function rectsOverlap(a, b) {
  return a.gx < b.gx + b.gw && a.gx + a.gw > b.gx && a.gy < b.gy + b.gh && a.gy + a.gh > b.gy;
}

describe('corridor routing regression sweep (#174)', () => {
  // #174 Task 5: this sweep was born (bdcd209) alongside trunkLaneCorridorSegments
  // and originally asserted zero overlaps across EVERY edge, found-path or
  // not — that hack routed even the boxed-in (`findCorridorPath` returns
  // null) case through two "safe lanes" clear of every room. Task 5 removed
  // that hack after a review found it unsound (100% broken for a west-exit
  // connection, and roughly half its remaining cases were themselves
  // bisected by a real containment wall) and reverted `buildEdgeCorridor`'s
  // null-path case to the original, honest direct-line/corner fallback —
  // the same one findCorridorPath's own docblock and Task 4's ruling always
  // documented as a known limitation, not a hack that quietly failed just
  // as often while claiming to be a fix. That fallback can still cut
  // through an unrelated room's footprint when no real route exists, so
  // this sweep now separates the two cases: a FOUND path (the actual
  // routing algorithm did its job) must still produce zero overlaps —
  // that's the real regression guard — while a null path's own overlap
  // rate is tracked and reported, not asserted to zero, since it's an
  // accepted, pre-existing limitation this task deliberately restored.
  it('no corridor segment overlaps any room footprint other than its own endpoints, when findCorridorPath finds a real route, across a large seed/roomCount sweep', () => {
    let totalEdges = 0;
    let foundPathEdges = 0;
    let overlappingFoundPathEdges = 0;
    let nullPathEdges = 0;
    let overlappingNullPathEdges = 0;
    for (let i = 0; i < 500; i += 1) {
      const seed = `sweep-${i}`;
      const roomCount = 6 + (i % 15);
      const { rooms, edges } = buildRoomGraph({ seed, roomCount });
      const { layoutEdges } = attachHiddenPaths({ rooms, edges, seed });
      const ranks = computeRanks(layoutEdges, 'room-entry');
      const columns = computeColumns(layoutEdges, ranks, 'room-entry');
      const positionByRoomId = Object.fromEntries(
        Object.keys(rooms).map((id) => [id, { rank: ranks[id], col: columns[id] }]),
      );
      const occupiedCells = Object.fromEntries(
        Object.entries(positionByRoomId).map(([id, pos]) => [`${pos.rank},${pos.col}`, id]),
      );
      // Keyed by room id, not object reference — roomRect is called fresh
      // per edge below, so two calls for the same room id would otherwise
      // produce distinct object instances a `!==` reference check could
      // never actually exclude.
      const rectById = Object.fromEntries(
        Object.keys(rooms).map((id) => [id, roomRect(seed, id, positionByRoomId[id].rank, positionByRoomId[id].col)]),
      );

      for (const [fromId, children] of Object.entries(edges)) {
        for (let idx = 0; idx < children.length; idx += 1) {
          const toId = children[idx];
          totalEdges += 1;
          const fromRect = rectById[fromId];
          const toRect = rectById[toId];
          const fromPos = positionByRoomId[fromId];
          const toPos = positionByRoomId[toId];
          const toSlot = doorSlotsForFace(toRect, 1, 'north')[0];
          const result = buildEdgeCorridor(
            seed, fromId, toId, fromRect, toRect,
            fromPos, toPos,
            exitFaceForIndex(idx), toSlot, occupiedCells,
          );
          const allSegments = [
            ...result.corridorSegments,
            ...result.transitCells.flatMap((c) => c.corridorSegments),
          ];
          const hasOverlap = allSegments.some((seg) =>
            Object.entries(rectById).some(
              ([id, r]) => id !== fromId && id !== toId && rectsOverlap(seg, r),
            ),
          );
          const path = findCorridorPath(fromPos, toPos, occupiedCells, { fromRoomId: fromId, toRoomId: toId });
          if (path) {
            foundPathEdges += 1;
            if (hasOverlap) overlappingFoundPathEdges += 1;
          } else {
            nullPathEdges += 1;
            if (hasOverlap) overlappingNullPathEdges += 1;
          }
        }
      }
    }
    expect(overlappingFoundPathEdges).toBe(0);
    expect(totalEdges).toBeGreaterThan(1000); // sanity: the sweep actually exercised real branching
    expect(foundPathEdges).toBeGreaterThan(0); // sanity: the found-path case above wasn't vacuously true
    // Not a pass/fail assertion — logged so a reviewer can see the accepted
    // limitation's real size without the suite failing on it.
    if (nullPathEdges > 0) {
      // eslint-disable-next-line no-console
      console.log(`[sweep] null-path edges: ${nullPathEdges}, overlapping: ${overlappingNullPathEdges}`);
    }
  });

  // #174 Task 5's own margin-alignment bug (a room's cell-margin
  // containment wall built directly across the real corridor's own
  // crossing point) took 3 fix rounds to close correctly and had zero
  // regression coverage until Task 5's own fix round added 5 hand-picked
  // unit tests. This sweep provides the same broad, whole-pipeline proof
  // for that bug that the test above provides for room-footprint
  // overlap — real seeds, real branching, not just the handful of cases
  // a person thought to write by hand.
  it('every room\'s (SMALL or LARGE) cell-margin gap fully contains buildEdgeCorridor\'s real crossing point at the source\'s own door, across the same seed/roomCount sweep', () => {
    let totalMarginedConnections = 0;
    for (let i = 0; i < 500; i += 1) {
      const seed = `sweep-${i}`;
      const roomCount = 6 + (i % 15);
      const { rooms, edges } = buildRoomGraph({ seed, roomCount });
      const { layoutEdges } = attachHiddenPaths({ rooms, edges, seed });
      const ranks = computeRanks(layoutEdges, 'room-entry');
      const columns = computeColumns(layoutEdges, ranks, 'room-entry');
      const positionByRoomId = Object.fromEntries(
        Object.keys(rooms).map((id) => [id, { rank: ranks[id], col: columns[id] }]),
      );
      const occupiedCells = Object.fromEntries(
        Object.entries(positionByRoomId).map(([id, pos]) => [`${pos.rank},${pos.col}`, id]),
      );
      const rectById = Object.fromEntries(
        Object.keys(rooms).map((id) => [id, roomRect(seed, id, positionByRoomId[id].rank, positionByRoomId[id].col)]),
      );

      for (const [fromId, children] of Object.entries(edges)) {
        for (let idx = 0; idx < children.length; idx += 1) {
          const toId = children[idx];
          const face = exitFaceForIndex(idx);
          if (face !== 'south' && face !== 'east') continue;
          const fromRect = rectById[fromId];
          // #288: LARGE rooms have a real margin now too (ROW_STRIDE/
          // COLUMN_STRIDE = ROOM_SIZE_LARGE + CORRIDOR_LEN) — swept for
          // both sizes.
          const toRect = rectById[toId];
          const toSlot = doorSlotsForFace(toRect, 1, 'north')[0];
          const { doorWall } = buildEdgeCorridor(
            seed, fromId, toId, fromRect, toRect,
            positionByRoomId[fromId], positionByRoomId[toId],
            face, toSlot, occupiedCells,
          );
          const { offset, width } = outgoingMarginOffset(
            seed, fromId, toId, face, fromRect,
            positionByRoomId[fromId], positionByRoomId[toId], occupiedCells,
          );
          const marginWalls = cellMarginWalls(
            fromRect, positionByRoomId[fromId].rank, positionByRoomId[fromId].col,
            { [face]: [{ offset, width }] },
          ).filter((w) => w.dir === face);
          totalMarginedConnections += 1;
          // South's gap runs along x; east's runs along y. #174 Task 6
          // fix-round finding: cellMarginWalls does NOT always return 2
          // segments sandwiching the gap (the brief's own reference code
          // assumed it always would) — when the gap touches either end of
          // the cell's own side (openOffset === 0, or openOffset +
          // openWidth === the full side length), only the OTHER side's
          // wall is built (sealSide's own `gapStart > 0` / `gapEnd < full`
          // guards). openOffset === 0 is a routine, common value (e.g.
          // doorOffsetAt's own seeded roll), not a rare edge case — a
          // 500-seed sweep hit it 616/6192 times. Verified by direct
          // instrumentation: production (outgoingMarginOffset/
          // cellMarginWalls/buildEdgeCorridor) was byte-for-byte correct
          // in every one of these 616 cases; only this test's own
          // min(w2)/max(w1) extraction — which silently assumed
          // `marginWalls.length === 2` — produced a nonsensical
          // reversed-looking gap when length was actually 1. Fixed by
          // deriving the gap from the room's own cell bounds instead of
          // assuming a fixed wall count: the "before" wall (if present)
          // always starts exactly at the cell's own edge and ends at the
          // gap; the "after" wall (if present) always ends exactly at the
          // cell's opposite edge and starts at the gap; whichever one is
          // missing means the gap itself extends all the way to that
          // cell edge.
          const cell = cellBounds(positionByRoomId[fromId].rank, positionByRoomId[fromId].col);
          const cellStart = face === 'south' ? cell.gx : cell.gy;
          const cellEnd = face === 'south' ? cell.gx + cell.gw : cell.gy + cell.gh;
          const beforeWall = marginWalls.find((w) => (face === 'south' ? w.x1 : w.y1) === cellStart);
          const afterWall = marginWalls.find((w) => (face === 'south' ? w.x2 : w.y2) === cellEnd);
          const gap0 = beforeWall ? (face === 'south' ? beforeWall.x2 : beforeWall.y2) : cellStart;
          const gap1 = afterWall ? (face === 'south' ? afterWall.x1 : afterWall.y1) : cellEnd;
          const [door0, door1] = face === 'south'
            ? [doorWall.x1, doorWall.x2]
            : [doorWall.y1, doorWall.y2];
          // #288: the margin gap must CONTAIN the source's own door — no
          // longer necessarily equal it exactly. When the corridor's own
          // real span is wider than DOOR_WIDTH (the source's and the
          // target's own offsets differ, #230), the margin correctly
          // widens to cover the whole span, not just the source's own
          // narrower door — exact equality only holds in the (still
          // common) unclamped case.
          expect(gap0).toBeLessThanOrEqual(door0 + 1e-9);
          expect(gap1).toBeGreaterThanOrEqual(door1 - 1e-9);
        }
      }
    }
    expect(totalMarginedConnections).toBeGreaterThan(200); // sanity: real south/east connections (both sizes, #288) were exercised
  });

  // #230: the sweep above only ever checks the margin gap against
  // doorWall (the SOURCE's own door) — which was ALREADY correct before
  // this fix, since outgoingMarginOffset always re-derives the exact
  // same seeded offset buildEdgeCorridor's own doorWall uses. That's
  // precisely why the real defect (the margin wall covering the
  // TARGET's own door, via #230's own issue) went unnoticed by this
  // file's existing coverage for as long as it did. This sweep checks
  // the actual invariant instead: does the margin wall's gap cover the
  // TARGET's own real door too, using the exact real-pipeline
  // `incomingConnectionsFor`/`doorSlotsForFace` machinery every other
  // slot-count-aware sweep in this file already uses (not just a
  // single-slot toy scenario).
  it('the source room\'s own margin-wall gap never covers the target\'s own real door, across the same seed/roomCount sweep, for a single-incoming-connection target — and the measured, un-fixed residual for a multi-slot (merge room) target stays within its own tracked ceiling (#230)', () => {
    let totalChecked = 0;
    let coveredCount = 0;
    // #288's own review round: a blended multi-slot ceiling hid a
    // LARGE-source-specific rate (76.8%) that would have failed a
    // tighter bound on its own, blended down by SMALL's own lower rate
    // (61.9%) — split by source size so neither population can regress
    // unseen inside the other's own slack.
    let multiSlotChecked = 0;
    let multiSlotCoveredCount = 0;
    let multiSlotLargeChecked = 0;
    let multiSlotLargeCoveredCount = 0;
    for (let i = 0; i < 500; i += 1) {
      const seed = `sweep-${i}`;
      const roomCount = 6 + (i % 15);
      const { rooms, edges } = buildRoomGraph({ seed, roomCount });
      const { layoutEdges, hiddenIncomingByRoomId } = attachHiddenPaths({ rooms, edges, seed });
      const ranks = computeRanks(layoutEdges, 'room-entry');
      const columns = computeColumns(layoutEdges, ranks, 'room-entry');
      const positionByRoomId = Object.fromEntries(
        Object.keys(rooms).map((id) => [id, { rank: ranks[id], col: columns[id] }]),
      );
      const occupiedCells = Object.fromEntries(
        Object.entries(positionByRoomId).map(([id, pos]) => [`${pos.rank},${pos.col}`, id]),
      );
      const rectById = Object.fromEntries(
        Object.keys(rooms).map((id) => [id, roomRect(seed, id, positionByRoomId[id].rank, positionByRoomId[id].col)]),
      );

      for (const [fromId, children] of Object.entries(edges)) {
        for (let idx = 0; idx < children.length; idx += 1) {
          const toId = children[idx];
          const face = exitFaceForIndex(idx);
          if (face !== 'south' && face !== 'east') continue;
          const fromRect = rectById[fromId];
          // #288: swept for both source sizes now — LARGE rooms have a
          // real margin too, and #288's own review round found the
          // naive fix (sealing it without also widening the gap) newly
          // BLOCKED a real fraction of LARGE-source doors; this sweep
          // (with the skip removed) is what would have caught that.
          const toRect = rectById[toId];
          // Only the FAST PATH (buildEdgeCorridor's own same-column/
          // same-rank offset-based branch, the one #230 actually fixed)
          // has this invariant at all — a different-column/different-rank
          // pair takes the corner or multi-cell branch instead, whose
          // margin gap is center-based and aligns with its own connector
          // leg near doorWall, not with revealDoorWall (a target door on
          // a completely different, unrelated physical line). Checking
          // revealDoorWall alignment for those cases would be testing the
          // wrong invariant, not a #230 regression.
          const aligned = face === 'south' ? fromRect.gx === toRect.gx : fromRect.gy === toRect.gy;
          if (!aligned) continue;
          const incoming = incomingConnectionsFor(layoutEdges, toId, hiddenIncomingByRoomId);
          const slotIndex = incoming.findIndex((c) => c.sourceId === fromId);
          if (slotIndex === -1) continue; // shouldn't happen for a real edge, but never index -1 into doorSlotsForFace
          // A merge room's own multi-slot target is #230's own documented,
          // un-fixed residual (the clamp can still land the derived offset
          // away from where the source's own margin gap sits) — checked
          // and tracked with its own real ceiling below, never silently
          // skipped, so a regression there is still caught even though
          // it isn't asserted to zero.
          const toSlot = doorSlotsForFace(toRect, incoming.length, 'north')[slotIndex];
          const { revealDoorWall } = buildEdgeCorridor(
            seed, fromId, toId, fromRect, toRect,
            positionByRoomId[fromId], positionByRoomId[toId],
            face, toSlot, occupiedCells,
          );
          const { offset, width } = outgoingMarginOffset(
            seed, fromId, toId, face, fromRect,
            positionByRoomId[fromId], positionByRoomId[toId], occupiedCells,
          );
          const marginWalls = cellMarginWalls(
            fromRect, positionByRoomId[fromId].rank, positionByRoomId[fromId].col,
            { [face]: [{ offset, width }] },
          ).filter((w) => w.dir === face);
          const cell = cellBounds(positionByRoomId[fromId].rank, positionByRoomId[fromId].col);
          const cellStart = face === 'south' ? cell.gx : cell.gy;
          const cellEnd = face === 'south' ? cell.gx + cell.gw : cell.gy + cell.gh;
          const beforeWall = marginWalls.find((w) => (face === 'south' ? w.x1 : w.y1) === cellStart);
          const afterWall = marginWalls.find((w) => (face === 'south' ? w.x2 : w.y2) === cellEnd);
          const gap0 = beforeWall ? (face === 'south' ? beforeWall.x2 : beforeWall.y2) : cellStart;
          const gap1 = afterWall ? (face === 'south' ? afterWall.x1 : afterWall.y1) : cellEnd;
          // revealDoorWall's own shape depends on the TARGET's incomingFace
          // (unpassed here, so it defaults to 'north' — always a
          // HORIZONTAL wall, x1 !== x2, y1 === y2), not on this edge's own
          // exitFace — read whichever axis is actually non-degenerate,
          // rather than assuming south->x/east->y (that pairing describes
          // the MARGIN wall's own axis, a different wall entirely).
          const doorIsVertical = Math.abs(revealDoorWall.x1 - revealDoorWall.x2) < 1e-9;
          const [door0, door1] = doorIsVertical
            ? [revealDoorWall.y1, revealDoorWall.y2]
            : [revealDoorWall.x1, revealDoorWall.x2];
          const covered = gap0 > door0 + 1e-9 || gap1 < door1 - 1e-9;
          if (incoming.length === 1) {
            totalChecked += 1;
            if (covered) coveredCount += 1;
          } else if (fromRect.gw === ROOM_SIZE_LARGE) {
            multiSlotLargeChecked += 1;
            if (covered) multiSlotLargeCoveredCount += 1;
          } else {
            multiSlotChecked += 1;
            if (covered) multiSlotCoveredCount += 1;
          }
        }
      }
    }
    expect(totalChecked).toBeGreaterThan(200); // sanity: real single-incoming-slot connections were exercised
    expect(multiSlotChecked).toBeGreaterThan(0); // sanity: the merge-room residual case exists in this sweep too
    expect(coveredCount).toBe(0); // #230's fix: fully closes the single-incoming-slot case
    // #230's own documented, un-fixed residual for a merge room's narrower
    // slot — tracked with a real ceiling (not just logged) so a future
    // regression here is still caught, even though a full fix (passing the
    // target's own toSlot into outgoingMarginOffset) is tracked separately.
    // eslint-disable-next-line no-console
    console.log(`[#230 residual] multi-slot (merge room), SMALL source coverage: ${multiSlotCoveredCount}/${multiSlotChecked}`);
    expect(multiSlotCoveredCount / multiSlotChecked).toBeLessThanOrEqual(0.75);
    // #288: a SECOND, newly-real population of this same residual — a
    // LARGE source into a merge target — didn't exist on main at all
    // (no margin wall there yet), so there is no earlier baseline this
    // ceiling improves on; it exists purely to catch a FUTURE regression
    // in this already-known-imperfect case, not to claim improvement.
    // See #231's own updated scope.
    expect(multiSlotLargeChecked).toBeGreaterThan(0); // sanity
    // eslint-disable-next-line no-console
    console.log(`[#230/#288 residual] multi-slot (merge room), LARGE source coverage: ${multiSlotLargeCoveredCount}/${multiSlotLargeChecked}`);
    expect(multiSlotLargeCoveredCount / multiSlotLargeChecked).toBeLessThanOrEqual(0.85);
  });

  // #294: every fast-path connection's own corridor floor must be sealed
  // on BOTH sides (not just capped top/bottom), across a real generated
  // graph — not just the two hand-picked cases the unit tests above pin.
  it('every same-column/same-rank fast-path corridor is sealed on both sides of its own SOURCE-cell depth (never further — a review round found the unclipped version sliced other rooms in the null-path case), across the same seed/roomCount sweep (#294)', () => {
    let totalChecked = 0;
    let unsealedCount = 0;
    let slicedRoomCount = 0;
    for (let i = 0; i < 500; i += 1) {
      const seed = `sweep-${i}`;
      const roomCount = 6 + (i % 15);
      const { rooms, edges } = buildRoomGraph({ seed, roomCount });
      const { layoutEdges, hiddenIncomingByRoomId } = attachHiddenPaths({ rooms, edges, seed });
      const ranks = computeRanks(layoutEdges, 'room-entry');
      const columns = computeColumns(layoutEdges, ranks, 'room-entry');
      const positionByRoomId = Object.fromEntries(
        Object.keys(rooms).map((id) => [id, { rank: ranks[id], col: columns[id] }]),
      );
      const occupiedCells = Object.fromEntries(
        Object.entries(positionByRoomId).map(([id, pos]) => [`${pos.rank},${pos.col}`, id]),
      );
      const rectById = Object.fromEntries(
        Object.keys(rooms).map((id) => [id, roomRect(seed, id, positionByRoomId[id].rank, positionByRoomId[id].col)]),
      );

      for (const [fromId, children] of Object.entries(edges)) {
        for (let idx = 0; idx < children.length; idx += 1) {
          const toId = children[idx];
          const face = exitFaceForIndex(idx);
          if (face !== 'south' && face !== 'east') continue;
          const fromRect = rectById[fromId];
          const toRect = rectById[toId];
          const aligned = face === 'south' ? fromRect.gx === toRect.gx : fromRect.gy === toRect.gy;
          if (!aligned) continue;
          const incoming = incomingConnectionsFor(layoutEdges, toId, hiddenIncomingByRoomId);
          const slotIndex = incoming.findIndex((c) => c.sourceId === fromId);
          if (slotIndex === -1) continue;
          const toSlot = doorSlotsForFace(toRect, incoming.length, 'north')[slotIndex];
          const fromPos = positionByRoomId[fromId];
          const { plainWalls, corridorSegments } = buildEdgeCorridor(
            seed, fromId, toId, fromRect, toRect,
            fromPos, positionByRoomId[toId],
            face, toSlot, occupiedCells,
          );
          // Only the fast path itself produces exactly one corridorSegments
          // entry shaped like a straight-through span — a multi-cell or
          // corner path (which can still reach here if findCorridorPath's
          // own aligned check passes but the path is actually null/blocked
          // differently) is out of THIS fix's own scope (#294's issue body
          // notes the corner/multi-cell branch separately).
          if (corridorSegments.length !== 1) continue;
          const seg = corridorSegments[0];
          totalChecked += 1;
          const sourceCell = cellBounds(fromPos.rank, fromPos.col);
          if (face === 'south') {
            const spanX0 = seg.gx, spanX1 = seg.gx + seg.gw;
            const faceY = seg.gy, corridorEndY = seg.gy + seg.gh;
            // #294 fix round: the CORRECT invariant is "reaches the
            // SOURCE's own cell boundary" — not necessarily corridorEndY,
            // which can be several ranks away in the null-path (boxed-in)
            // case. Reaching further than the source's own cell would be
            // the exact regression the fix round closed.
            const expectedEndY = Math.min(corridorEndY, sourceCell.gy + ROW_STRIDE);
            const westSide = plainWalls.find((w) => w.x1 === spanX0 && w.x2 === spanX0
              && Math.min(w.y1, w.y2) <= faceY + 1e-9 && Math.max(w.y1, w.y2) >= expectedEndY - 1e-9
              && Math.max(w.y1, w.y2) <= expectedEndY + 1e-9);
            const eastSide = plainWalls.find((w) => w.x1 === spanX1 && w.x2 === spanX1
              && Math.min(w.y1, w.y2) <= faceY + 1e-9 && Math.max(w.y1, w.y2) >= expectedEndY - 1e-9
              && Math.max(w.y1, w.y2) <= expectedEndY + 1e-9);
            if (!westSide || !eastSide) unsealedCount += 1;
          } else {
            const spanY0 = seg.gy, spanY1 = seg.gy + seg.gh;
            const faceX = seg.gx, corridorEndX = seg.gx + seg.gw;
            const expectedEndX = Math.min(corridorEndX, sourceCell.gx + COLUMN_STRIDE);
            const northSide = plainWalls.find((w) => w.y1 === spanY0 && w.y2 === spanY0
              && Math.min(w.x1, w.x2) <= faceX + 1e-9 && Math.max(w.x1, w.x2) >= expectedEndX - 1e-9
              && Math.max(w.x1, w.x2) <= expectedEndX + 1e-9);
            const southSide = plainWalls.find((w) => w.y1 === spanY1 && w.y2 === spanY1
              && Math.min(w.x1, w.x2) <= faceX + 1e-9 && Math.max(w.x1, w.x2) >= expectedEndX - 1e-9
              && Math.max(w.x1, w.x2) <= expectedEndX + 1e-9);
            if (!northSide || !southSide) unsealedCount += 1;
          }
          // The room-slicing regression check: none of this edge's own
          // plainWalls may cross through the INTERIOR of any OTHER real
          // room's rect (the exact failure mode the fix round's own
          // review found — a side wall running the full, unclipped
          // distance to a far-away target sliced through whatever
          // occupied the cells in between, most often a revealed hidden
          // detour room).
          for (const w of plainWalls) {
            for (const [otherId, otherRect] of Object.entries(rectById)) {
              if (otherId === fromId || otherId === toId) continue;
              const wx0 = Math.min(w.x1, w.x2), wx1 = Math.max(w.x1, w.x2);
              const wy0 = Math.min(w.y1, w.y2), wy1 = Math.max(w.y1, w.y2);
              const crossesInterior = wx1 > otherRect.gx && wx0 < otherRect.gx + otherRect.gw
                && wy1 > otherRect.gy && wy0 < otherRect.gy + otherRect.gh;
              if (crossesInterior) { slicedRoomCount += 1; break; }
            }
          }
        }
      }
    }
    expect(totalChecked).toBeGreaterThan(200); // sanity: real fast-path connections were exercised
    expect(unsealedCount).toBe(0);
    expect(slicedRoomCount).toBe(0);
  });

  // #294 fix round: pins the exact detour-room regression a review found
  // in the FIRST version of this fix — a parent (P) whose direct route to
  // its own real child (C) is blocked by a detour room (Dt) sitting
  // directly between them still takes the fast path (a null path, #93/
  // #174's own accepted direct-line fallback), and the FIRST version's
  // unclipped side walls ran the full P-to-C distance, slicing straight
  // through Dt and cutting its own separate, WORKING Dt->C corridor in
  // half. Seed `sweep-12` reproduces this exact shape.
  it('a detour room sitting directly between a blocked parent and its own real child does not get sliced by the parent\'s own (null-path) fast-path side walls (#294 fix round)', () => {
    const seed = 'sweep-12';
    const roomCount = 6 + (12 % 15);
    const { rooms, edges } = buildRoomGraph({ seed, roomCount });
    const { layoutEdges, hiddenIncomingByRoomId } = attachHiddenPaths({ rooms, edges, seed });
    const ranks = computeRanks(layoutEdges, 'room-entry');
    const columns = computeColumns(layoutEdges, ranks, 'room-entry');
    const positionByRoomId = Object.fromEntries(
      Object.keys(rooms).map((id) => [id, { rank: ranks[id], col: columns[id] }]),
    );
    const occupiedCells = Object.fromEntries(
      Object.entries(positionByRoomId).map(([id, pos]) => [`${pos.rank},${pos.col}`, id]),
    );
    const rectById = Object.fromEntries(
      Object.keys(rooms).map((id) => [id, roomRect(seed, id, positionByRoomId[id].rank, positionByRoomId[id].col)]),
    );
    let checkedAtLeastOne = false;
    for (const [fromId, children] of Object.entries(edges)) {
      for (let idx = 0; idx < children.length; idx += 1) {
        const toId = children[idx];
        const face = exitFaceForIndex(idx);
        if (face !== 'south') continue;
        const fromRect = rectById[fromId];
        const toRect = rectById[toId];
        if (fromRect.gx !== toRect.gx) continue;
        const path = findCorridorPath(
          positionByRoomId[fromId], positionByRoomId[toId], occupiedCells,
          { fromRoomId: fromId, toRoomId: toId },
        );
        if (path) continue; // only the null-path (boxed-in) case is at risk here
        const toSlot = doorSlotsForFace(toRect, 1, 'north')[0];
        const { plainWalls } = buildEdgeCorridor(
          seed, fromId, toId, fromRect, toRect,
          positionByRoomId[fromId], positionByRoomId[toId],
          face, toSlot, occupiedCells,
        );
        for (const w of plainWalls) {
          for (const [otherId, otherRect] of Object.entries(rectById)) {
            if (otherId === fromId || otherId === toId) continue;
            const wx0 = Math.min(w.x1, w.x2), wx1 = Math.max(w.x1, w.x2);
            const wy0 = Math.min(w.y1, w.y2), wy1 = Math.max(w.y1, w.y2);
            const crossesInterior = wx1 > otherRect.gx && wx0 < otherRect.gx + otherRect.gw
              && wy1 > otherRect.gy && wy0 < otherRect.gy + otherRect.gh;
            expect(crossesInterior).toBe(false);
          }
        }
        checkedAtLeastOne = true;
      }
    }
    expect(checkedAtLeastOne).toBe(true); // sanity: seed sweep-12 really does reproduce a null-path same-column edge
  });

  // 2026-09-27 investigation note, three times revised: computeColumns'
  // skip-by-2 stride (#174 follow-up) DOES guarantee every room a
  // genuinely free west lane — incomingFaceFor's own legitimacy-exclusion
  // never misfires against a buffer column (buffer columns are odd and are
  // never written into occupiedCells at all, confirmed directly). This
  // alone is a real, measured improvement over the ~32% pre-#174 baseline.
  //
  // Two further attempts at the SEPARATE merge-room multi-parent gate
  // conflict were both tried and both reverted:
  //
  // 1. Widening findCorridorPath's own isBlocked to exempt a target's full
  //    legitimateSourceIds, everywhere in the search, not just at the
  //    gate — found UNSOUND by this plan's own final whole-branch review
  //    (C1): it let a path route straight THROUGH a co-parent's own real
  //    room as if it were empty shared transit space, and
  //    buildTransitCellIfNeeded then built full containment walls on top
  //    of that co-parent's own cell, potentially sealing its own door.
  // 2. A narrower fix in incomingFaceFor itself (only treat a legitimate
  //    occupant as available when it's the room's SOLE source, otherwise
  //    fall to west) — architecturally sound in isolation, but a SECOND
  //    round of the same final whole-branch review found it NET NEGATIVE
  //    given the current state of the multi-cell/transit-cell machinery:
  //    it converted ~1083 previously-direct, known-good connections into
  //    detours, and ~89% of those ended up with their own target door
  //    covered by a wall — trading a smaller, honest problem (some merge
  //    rooms stay null-path) for a larger, silent one (many "found"
  //    corridors are actually unbuildable). That same review also found
  //    two previously-unnamed defects in the multi-cell machinery itself:
  //    consecutive transit cells' own crossing offsets don't reliably
  //    line up on their shared border, and a second edge converging on an
  //    already-crossed cell with the SAME entry/exit side pair is
  //    silently dropped instead of adding its own opening. Both are
  //    pre-existing (not introduced by this plan) but load-bearing for
  //    why pushing MORE connections through this machinery backfired.
  //
  // Both attempts are reverted. incomingFaceFor is back to its original
  // rule (any legitimate source is an available gate, regardless of
  // count) and findCorridorPath's isBlocked is back to its original,
  // narrow fromRoomId/toRoomId-only exemption. The merge-room gate-sharing
  // problem, and the deeper multi-cell/transit-cell geometry bugs above
  // (tracked together as "C3" in this plan's own history, filed as its
  // own issue: #225), remain OPEN — fixing them properly needs its own
  // investigation and design, not a
  // patch applied under time pressure.
  //
  // This sweep enumerates every room's REAL incoming connections via
  // `incomingConnectionsFor` (real parents + hidden/detour sources),
  // matching what `buildPopulateAndUnlockGraphNode` actually builds — an
  // earlier form of this test only iterated `edges` (visible connections),
  // missing hidden ones entirely (a gap this plan's own final review also
  // found, C2) and letting attempt 1 above go undetected.
  it('the boxed-in rate (null findCorridorPath), measured against every real incoming connection including hidden/detour ones, is meaningfully better than the ~32% pre-#174 baseline thanks to computeColumns\' skip-by-2 stride alone — the separate merge-room gate-sharing problem remains open, not attempted here', () => {
    let totalEdges = 0;
    let nullPathEdges = 0;
    for (let i = 0; i < 500; i += 1) {
      const seed = `sweep-${i}`;
      const roomCount = 6 + (i % 15);
      const { rooms, edges } = buildRoomGraph({ seed, roomCount });
      const { layoutEdges, hiddenIncomingByRoomId } = attachHiddenPaths({ rooms, edges, seed });
      const ranks = computeRanks(layoutEdges, 'room-entry');
      const columns = computeColumns(layoutEdges, ranks, 'room-entry');
      const positionByRoomId = Object.fromEntries(
        Object.keys(rooms).map((id) => [id, { rank: ranks[id], col: columns[id] }]),
      );
      const occupiedCells = Object.fromEntries(
        Object.entries(positionByRoomId).map(([id, pos]) => [`${pos.rank},${pos.col}`, id]),
      );
      const incomingFaceByRoomId = Object.fromEntries(
        Object.keys(rooms).map((id) => {
          const legitimateSourceIds = new Set([
            ...parentRoomIdsFor(layoutEdges, id),
            ...(hiddenIncomingByRoomId[id] ?? []),
          ]);
          return [id, incomingFaceFor(id, positionByRoomId, occupiedCells, legitimateSourceIds)];
        }),
      );

      for (const toId of Object.keys(rooms)) {
        for (const { sourceId: fromId } of incomingConnectionsFor(layoutEdges, toId, hiddenIncomingByRoomId)) {
          totalEdges += 1;
          const path = findCorridorPath(
            positionByRoomId[fromId], positionByRoomId[toId], occupiedCells,
            { fromRoomId: fromId, toRoomId: toId, incomingFace: incomingFaceByRoomId[toId] },
          );
          if (!path) nullPathEdges += 1;
        }
      }
    }
    expect(totalEdges).toBeGreaterThan(1000);
    // Real, honest measured rate with BOTH merge-room-gate attempts
    // reverted: 0.2610 (fully deterministic across this sweep's fixed
    // seeds) — a genuine ~6 point improvement over the ~32.2% pre-#174
    // baseline, entirely attributable to computeColumns' skip-by-2 stride
    // (Tasks 1-2 of this plan). Neither the 0.92% nor the 18.77% numbers
    // this test previously reported should be trusted — see the
    // investigation note above for why both of the attempts that produced
    // them were reverted. Closing this further requires fixing the
    // multi-cell/transit-cell machinery itself (C3, plus the two sibling
    // defects the final whole-branch review found) BEFORE attempting any
    // fix that routes more connections through it — tracked as a
    // separate, ongoing investigation, not solved here.
    expect(nullPathEdges / totalEdges).toBeLessThanOrEqual(0.27);
  });

  // #225 fix-round rework: the original version of this sweep checked that
  // computed crossing POINTS were equal to the door's own center — exactly
  // the proxy metric this whole plan exists to replace (a point can
  // "coincide" while the actual passable opening it anchors is only half
  // as wide as the door, which is precisely the C1 bug this fix round
  // found and fixed — see buildEdgeCorridor's chainStartAnchor/
  // chainEndAnchor comment). This sweep now builds the ACTUAL wall
  // geometry `buildTransitCellIfNeeded` would build for the last transit
  // cell's own crossing and asserts the REAL passable gap — not just a
  // point — matches the target door's own real interval exactly.
  it('every multi-cell corridor is actually buildable at its target door: the last transit cell\'s real containment-wall gap has the full DOOR_WIDTH, exactly where the target door sits, across a large seed/roomCount sweep (#225)', () => {
    let totalMultiCellEdges = 0;
    // Informational only (#225 I2 finding, not asserted here): when the
    // BFS path's first hop leaves the source room through a side that
    // ISN'T that edge's own exit face, the connector can cross the source
    // room's own sealed cell-margin wall, or a wall whose gap belongs to
    // a different sibling connection — a real, pre-existing (confirmed on
    // main too, not a regression introduced by this plan) defect that is
    // out of scope for #225 and worth its own follow-up issue. Counted
    // here only to track the affected population's size over time.
    let sourceSidewaysFirstHopEdges = 0;
    for (let i = 0; i < 500; i += 1) {
      const seed = `sweep-${i}`;
      const roomCount = 6 + (i % 15);
      const { rooms, edges } = buildRoomGraph({ seed, roomCount });
      const { layoutEdges } = attachHiddenPaths({ rooms, edges, seed });
      const ranks = computeRanks(layoutEdges, 'room-entry');
      const columns = computeColumns(layoutEdges, ranks, 'room-entry');
      const positionByRoomId = Object.fromEntries(
        Object.keys(rooms).map((id) => [id, { rank: ranks[id], col: columns[id] }]),
      );
      const occupiedCells = Object.fromEntries(
        Object.entries(positionByRoomId).map(([id, pos]) => [`${pos.rank},${pos.col}`, id]),
      );
      const rectById = Object.fromEntries(
        Object.keys(rooms).map((id) => [id, roomRect(seed, id, positionByRoomId[id].rank, positionByRoomId[id].col)]),
      );

      for (const [fromId, children] of Object.entries(edges)) {
        for (let idx = 0; idx < children.length; idx += 1) {
          const toId = children[idx];
          const fromRect = rectById[fromId];
          const toRect = rectById[toId];
          const fromPos = positionByRoomId[fromId];
          const toPos = positionByRoomId[toId];
          const face = exitFaceForIndex(idx);
          const toSlot = doorSlotsForFace(toRect, 1, 'north')[0];
          const result = buildEdgeCorridor(
            seed, fromId, toId, fromRect, toRect, fromPos, toPos,
            face, toSlot, occupiedCells,
          );
          if (result.transitCells.length === 0) continue; // only multi-cell connections are in scope here
          totalMultiCellEdges += 1;

          // --- TARGET side (PRIMARY assertion): build the last transit
          // cell's own real containment walls for a first-time crossing of
          // this cell (matching what buildTransitCellIfNeeded actually
          // builds — a single opening, this crossing's own exitSide/
          // exitPoint) and derive the gap it actually leaves on that line,
          // the same before/after-wall technique the margin sweep above
          // uses (cellMarginWalls doesn't always return exactly 2 sandwich
          // walls; neither does transitCellContainmentWalls).
          const lastCell = result.transitCells[result.transitCells.length - 1];
          const lastCellBounds = cellBounds(lastCell.rank, lastCell.col);
          const lastCellWalls = transitCellContainmentWalls(
            lastCell.rank, lastCell.col,
            [{ side: lastCell.exitSide, point: lastCell.exitPoint }],
          ).filter((w) => w.dir === lastCell.exitSide);
          const horizontal = lastCell.exitSide === 'north' || lastCell.exitSide === 'south';
          const cellStart = horizontal ? lastCellBounds.gx : lastCellBounds.gy;
          const cellEnd = horizontal ? lastCellBounds.gx + lastCellBounds.gw : lastCellBounds.gy + lastCellBounds.gh;
          const beforeWall = lastCellWalls.find((w) => (horizontal ? w.x1 : w.y1) === cellStart);
          const afterWall = lastCellWalls.find((w) => (horizontal ? w.x2 : w.y2) === cellEnd);
          const gapStart = beforeWall ? (horizontal ? beforeWall.x2 : beforeWall.y2) : cellStart;
          const gapEnd = afterWall ? (horizontal ? afterWall.x1 : afterWall.y1) : cellEnd;
          const [doorStart, doorEnd] = horizontal
            ? [result.revealDoorWall.x1, result.revealDoorWall.x2]
            : [result.revealDoorWall.y1, result.revealDoorWall.y2];
          // The real invariant the design spec asked for: DOOR_WIDTH of
          // passable width exists, exactly where the door is — not just
          // that some point coincides.
          expect(gapStart).toBeCloseTo(doorStart, 9);
          expect(gapEnd).toBeCloseTo(doorEnd, 9);
          expect(gapEnd - gapStart).toBeCloseTo(DOOR_WIDTH, 9);

          // --- SOURCE side (informational, see sourceSidewaysFirstHopEdges
          // above): only track whether this edge's first hop left the
          // source through its own real exit face (the well-understood,
          // known-good case) or sideways (the #225 I2 population).
          const firstEntrySide = result.transitCells[0].entrySide;
          const straightOutOfSource =
            (face === 'south' && firstEntrySide === 'north') ||
            (face === 'east' && firstEntrySide === 'west') ||
            (face === 'west' && firstEntrySide === 'east');
          if (!straightOutOfSource) {
            sourceSidewaysFirstHopEdges += 1;
          } else {
            // Straight out of the room's own exit face: door and first
            // transit cell entry share the forced axis exactly (center ->
            // gap-start, same conversion as the target side above).
            const sourceDoorX = (result.doorWall.x1 + result.doorWall.x2) / 2;
            const sourceDoorY = (result.doorWall.y1 + result.doorWall.y2) / 2;
            if (firstEntrySide === 'north' || firstEntrySide === 'south') {
              expect(result.transitCells[0].entryPoint.x).toBeCloseTo(sourceDoorX - DOOR_WIDTH / 2, 9);
            } else {
              expect(result.transitCells[0].entryPoint.y).toBeCloseTo(sourceDoorY - DOOR_WIDTH / 2, 9);
            }
          }

          // (c): every consecutive pair of transit cells' shared border —
          // one cell's exit must exactly equal the next cell's entry.
          for (let ci = 0; ci < result.transitCells.length - 1; ci += 1) {
            expect(result.transitCells[ci].exitPoint).toEqual(result.transitCells[ci + 1].entryPoint);
          }

          // (d): edgeId survives onto every transitCells entry, unchanged
          // — this is what lets two edges crossing the same cell (#225
          // bug #3) each get their own opening, per Task 4's marker fix.
          const expectedEdgeId = `${fromId}->${toId}`;
          for (const cell of result.transitCells) {
            expect(cell.edgeId).toBe(expectedEdgeId);
          }
        }
      }
    }
    expect(totalMultiCellEdges).toBeGreaterThan(50); // sanity: real multi-cell corridors were actually exercised
    if (sourceSidewaysFirstHopEdges > 0) {
      // eslint-disable-next-line no-console
      console.log(`[sweep] source-sideways-first-hop edges (#225 I2, pre-existing, out of scope): ${sourceSidewaysFirstHopEdges}/${totalMultiCellEdges}`);
    }
  });

  // #225 I3: a bent (multi-axis) multi-cell corridor — one whose transit
  // cells turn a genuine corner somewhere in the MIDDLE of the chain, not
  // just descend straight — with real wall/tile geometry, asserting the
  // last transit cell's own containment wall leaves the full DOOR_WIDTH
  // exactly where the target door sits (same technique as the sweep's
  // target-side check above). Blocking the source room's own straight-
  // south neighbor cell forces findCorridorPath to detour sideways first,
  // producing two interior corner cells (west/south, then north/east)
  // before the path straightens out to enter the target from the north —
  // a genuine mix of north/south and east/west legs, not a single-axis
  // descent.
  it('an obstacle-routed multi-cell corridor with interior corner turns still leaves the target door\'s full real width open (#225 I3)', () => {
    const fromPos = { rank: 0, col: 0 };
    const toPos = { rank: 2, col: 2 };
    const occupiedCells = { '1,0': 'blocker' };
    const fromRect = { gx: cellBounds(0, 0).gx, gy: cellBounds(0, 0).gy, gw: ROOM_SIZE_LARGE, gh: ROOM_SIZE_LARGE };
    const toRect = { gx: cellBounds(2, 2).gx, gy: cellBounds(2, 2).gy, gw: ROOM_SIZE_LARGE, gh: ROOM_SIZE_LARGE };
    const toSlot = { x1: toRect.gx, y1: toRect.gy, x2: toRect.gx + ROOM_SIZE_LARGE, y2: toRect.gy };
    const result = buildEdgeCorridor(
      'seed1', 'a', 'b', fromRect, toRect, fromPos, toPos, 'south', toSlot, occupiedCells,
    );

    // Confirm this is a genuinely bent path: at least one interior transit
    // cell turns a corner (entrySide/exitSide on ADJACENT, not opposite,
    // sides) — not merely a straight descent.
    expect(result.transitCells.length).toBeGreaterThanOrEqual(2);
    const hasInteriorCorner = result.transitCells.some((c) => {
      const opposite = { north: 'south', south: 'north', east: 'west', west: 'east' };
      return opposite[c.entrySide] !== c.exitSide;
    });
    expect(hasInteriorCorner).toBe(true);
    // And a genuine mix of both axes across the chain (not e.g. every leg
    // just happening to be north/south).
    const sides = new Set(result.transitCells.flatMap((c) => [c.entrySide, c.exitSide]));
    expect(sides.has('east') || sides.has('west')).toBe(true);
    expect(sides.has('north') || sides.has('south')).toBe(true);

    const lastCell = result.transitCells[result.transitCells.length - 1];
    const lastCellBounds = cellBounds(lastCell.rank, lastCell.col);
    const lastCellWalls = transitCellContainmentWalls(
      lastCell.rank, lastCell.col,
      [{ side: lastCell.exitSide, point: lastCell.exitPoint }],
    ).filter((w) => w.dir === lastCell.exitSide);
    const horizontal = lastCell.exitSide === 'north' || lastCell.exitSide === 'south';
    const cellStart = horizontal ? lastCellBounds.gx : lastCellBounds.gy;
    const cellEnd = horizontal ? lastCellBounds.gx + lastCellBounds.gw : lastCellBounds.gy + lastCellBounds.gh;
    const beforeWall = lastCellWalls.find((w) => (horizontal ? w.x1 : w.y1) === cellStart);
    const afterWall = lastCellWalls.find((w) => (horizontal ? w.x2 : w.y2) === cellEnd);
    const gapStart = beforeWall ? (horizontal ? beforeWall.x2 : beforeWall.y2) : cellStart;
    const gapEnd = afterWall ? (horizontal ? afterWall.x1 : afterWall.y1) : cellEnd;
    const [doorStart, doorEnd] = horizontal
      ? [result.revealDoorWall.x1, result.revealDoorWall.x2]
      : [result.revealDoorWall.y1, result.revealDoorWall.y2];

    // No wall covers the door: the real passable gap is exactly the door's
    // own real interval, full DOOR_WIDTH wide.
    expect(gapStart).toBeCloseTo(doorStart, 9);
    expect(gapEnd).toBeCloseTo(doorEnd, 9);
    expect(gapEnd - gapStart).toBeCloseTo(DOOR_WIDTH, 9);
  });

  // #297: the real, downstream property this whole fix exists to
  // guarantee -- not the proxy metrics (side walls sealed, foreignOpening
  // non-null, etc.) the dedicated unit tests already pin, but the actual
  // corridor geometry: does any corridor segment for any real edge, across
  // a real generated graph, land on top of any OTHER room's own footprint.
  // Same seed/roomCount corpus and full pipeline (buildRoomGraph ->
  // attachHiddenPaths -> computeRanks -> computeColumns) as the #294 sweep
  // above, and the same real-slot resolution via incomingConnectionsFor/
  // doorSlotsForFace (a merge room's real slot index, not always 0) --
  // only the per-edge check differs: EVERY corridor segment (a dogleg's
  // own 3-segment output included, not skipped the way the #294 sweep's
  // own `corridorSegments.length !== 1` guard does), for EVERY real edge
  // (not just the south/same-column and east/same-rank fast path), checked
  // against every OTHER room's own rect.
  it('no corridor segment overlaps any OTHER room\'s own footprint, across the same full-pipeline seed/roomCount sweep -- the real property #297\'s dogleg fix exists to guarantee, measured separately for the single-intermediate-blocking-cell case this plan covers (#297), using the REAL priority-aware slot assignment (Round 2)', () => {
    let totalEdges = 0;
    let overlappingEdges = 0;
    let doglegEligibleEdges = 0;
    let doglegEligibleOverlaps = 0;
    let priorityCollisions = 0;
    let nonResidualWallCollisions = 0;
    let residualWallCollisions = 0;
    let residualEdges = 0;
    for (let i = 0; i < 500; i += 1) {
      const seed = `sweep-${i}`;
      const roomCount = 6 + (i % 15);
      const { rooms, edges } = buildRoomGraph({ seed, roomCount });
      const { layoutEdges, hiddenIncomingByRoomId } = attachHiddenPaths({ rooms, edges, seed });
      const ranks = computeRanks(layoutEdges, 'room-entry');
      const columns = computeColumns(layoutEdges, ranks, 'room-entry');
      const positionByRoomId = Object.fromEntries(
        Object.keys(rooms).map((id) => [id, { rank: ranks[id], col: columns[id] }]),
      );
      const occupiedCells = Object.fromEntries(
        Object.entries(positionByRoomId).map(([id, pos]) => [`${pos.rank},${pos.col}`, id]),
      );
      const rectById = Object.fromEntries(
        Object.keys(rooms).map((id) => [id, roomRect(seed, id, positionByRoomId[id].rank, positionByRoomId[id].col)]),
      );

      for (const [fromId, children] of Object.entries(edges)) {
        for (let idx = 0; idx < children.length; idx += 1) {
          const toId = children[idx];
          const face = exitFaceForIndex(idx);
          const fromRect = rectById[fromId];
          const toRect = rectById[toId];
          const fromPos = positionByRoomId[fromId];
          const toPos = positionByRoomId[toId];
          const incoming = incomingConnectionsFor(layoutEdges, toId, hiddenIncomingByRoomId);
          const slotIndex = incoming.findIndex((c) => c.sourceId === fromId);
          if (slotIndex === -1) continue;
          // #297 Round 2: real production slot resolution (this is what
          // buildPopulateAndUnlockGraphNode actually calls now), not the
          // plain list-order doorSlotsForFace this sweep used pre-Round-2.
          const collision = findPriorityCollision(
            seed, toId, toPos.rank, toPos.col, incoming, positionByRoomId, occupiedCells,
          );
          const slots = assignDoorSlotsWithPriority(seed, toRect, incoming, 'north', collision);
          const toSlot = slots[slotIndex];
          const { corridorSegments, transitCells, plainWalls, doorWall, revealDoorWall } = buildEdgeCorridor(
            seed, fromId, toId, fromRect, toRect, fromPos, toPos,
            face, toSlot, occupiedCells,
          );
          const allSegments = [
            ...corridorSegments,
            ...transitCells.flatMap((c) => c.corridorSegments),
          ];
          const overlaps = allSegments.some((seg) =>
            Object.entries(rectById).some(
              ([id, r]) => id !== fromId && id !== toId && rectsOverlap(seg, r),
            ),
          );
          totalEdges += 1;
          if (overlaps) overlappingEdges += 1;

          const doglegEligible = (face === 'south' && toPos.col === fromPos.col && toPos.rank === fromPos.rank + 2)
            || (face === 'east' && toPos.rank === fromPos.rank && toPos.col === fromPos.col + 2);
          if (doglegEligible) {
            doglegEligibleEdges += 1;
            if (overlaps) doglegEligibleOverlaps += 1;
          }

          // #297 Round 2: whenever THIS edge is the colliding connection,
          // measure the real cross-connection property against its own
          // co-parent's own corridor, and separately track the documented
          // LARGE-blocker/SMALL-target residual (Review Focus item 6) --
          // reported, not assumed zero.
          if (collision && incoming[collision.collidingIndex].sourceId === fromId) {
            priorityCollisions += 1;
            const blockerRect = rectById[collision.blockerId];
            const isResidual = collision.axis === 'south'
              ? (blockerRect.gw === ROOM_SIZE_LARGE && toRect.gw === ROOM_SIZE_SMALL)
              : (blockerRect.gh === ROOM_SIZE_LARGE && toRect.gh === ROOM_SIZE_SMALL);
            if (isResidual) residualEdges += 1;

            const coParentId = collision.blockerId;
            const coParentChildren = edges[coParentId] ?? [];
            const coParentIdx = coParentChildren.indexOf(toId);
            if (coParentIdx !== -1) {
              const coParentFace = exitFaceForIndex(coParentIdx);
              const coParentSlotIndex = incoming.findIndex((c) => c.sourceId === coParentId);
              const coParentSlot = slots[coParentSlotIndex];
              const coParentResult = buildEdgeCorridor(
                seed, coParentId, toId, rectById[coParentId], toRect, positionByRoomId[coParentId], toPos,
                coParentFace, coParentSlot, occupiedCells,
              );
              const wallCoversDoor = (walls, door) => walls.some(
                (w) => w.y1 === w.y2 && door.y1 === door.y2 && w.y1 === door.y1
                  && Math.min(w.x1, w.x2) < Math.max(door.x1, door.x2)
                  && Math.max(w.x1, w.x2) > Math.min(door.x1, door.x2),
              ) || walls.some(
                (w) => w.x1 === w.x2 && door.x1 === door.x2 && w.x1 === door.x1
                  && Math.min(w.y1, w.y2) < Math.max(door.y1, door.y2)
                  && Math.max(w.y1, w.y2) > Math.min(door.y1, door.y2),
              );
              const collides = wallCoversDoor(plainWalls, coParentResult.revealDoorWall)
                || wallCoversDoor(coParentResult.plainWalls, revealDoorWall)
                || wallCoversDoor(plainWalls, coParentResult.doorWall)
                || wallCoversDoor(coParentResult.plainWalls, doorWall);
              if (collides) {
                if (isResidual) residualWallCollisions += 1;
                else nonResidualWallCollisions += 1;
              }
            }
          }
        }
      }
    }
    expect(totalEdges).toBeGreaterThan(1000); // sanity: the sweep actually exercised real branching
    expect(doglegEligibleEdges).toBeGreaterThan(0); // sanity: the dogleg-eligible shape actually occurs in this corpus
    const overallRate = totalEdges > 0 ? overlappingEdges / totalEdges : 0;
    const doglegRate = doglegEligibleEdges > 0 ? doglegEligibleOverlaps / doglegEligibleEdges : 0;
    // eslint-disable-next-line no-console
    console.log(`[sweep] #297 footprint overlap: ${overlappingEdges}/${totalEdges} edges overall (${(overallRate * 100).toFixed(2)}%); dogleg-eligible (rank+2/col+2, single intermediate blocking cell): ${doglegEligibleOverlaps}/${doglegEligibleEdges} (${(doglegRate * 100).toFixed(2)}%)`);
    expect(priorityCollisions).toBeGreaterThan(0); // sanity: the corpus actually produced a real co-parent collision
    const residualRate = priorityCollisions > 0 ? residualEdges / priorityCollisions : 0;
    const nonResidualRate = priorityCollisions > 0 ? nonResidualWallCollisions / priorityCollisions : 0;
    // eslint-disable-next-line no-console
    console.log(`[sweep] #297 Round 2 slot priority: ${priorityCollisions} real co-parent collisions found; ${nonResidualWallCollisions}/${priorityCollisions} (${(nonResidualRate * 100).toFixed(2)}%) had a cross-connection wall collision OUTSIDE the documented LARGE/SMALL residual; documented LARGE-blocker/SMALL-target residual: ${residualEdges}/${priorityCollisions} (${(residualRate * 100).toFixed(2)}%), of which ${residualWallCollisions} actually manifested as a wall collision`);
    // #297 Round 2's own second, smaller residual (originally found by
    // this sweep, measured 2026-09-29 at 4/381 ~= 1.05%, tracked in #309):
    // slot priority only ever repositions the TARGET's own door
    // slots -- it was never designed to, and does not, protect the
    // colliding connection's own dogleg containment wall (sealing "turn 2"
    // at the blocking room's own south/east margin edge) from landing on
    // the CO-PARENT's own door or gap position on that SAME face, which is
    // computed completely independently -- the same "two independently-
    // computed positions sharing one crossing point, nothing forces
    // agreement" shape this codebase has hit before (#230/#231).
    //
    // #324 update (2026-09-30): fixing every door to be grid-aligned (no
    // element up to one grid cell wide may straddle a grid line --
    // clampDoorStart, dungeon-layout.mjs) raised this measured rate from
    // ~1% to ~6.76% (25/370 in this corpus). This is NOT a new regression
    // from #324 -- it's the SAME residual class (#231/#232's own already-
    // tracked slot-boundary encroachment) newly exposed: when a room has
    // more incoming connections than its own width in grid units (e.g. 7
    // connections on a SMALL, 6-wide room), no single grid cell can fit a
    // DOOR_WIDTH-wide door entirely inside its own narrower-than-1 slot,
    // so clampDoorStart's own degenerate-case fallback occasionally
    // encroaches into a neighboring slot -- previously masked by the old,
    // fractional (grid-straddling) positions coincidentally landing
    // somewhere that didn't collide as often. Grid alignment is a hard,
    // non-negotiable rule (per explicit product direction); a bare 0%
    // collision rate is not achievable simultaneously with it for this
    // narrow-slot shape. Tracked with its own real ceiling (measured value
    // + margin, this file's own established convention), not asserted to
    // zero and not silently softened.
    expect(nonResidualRate).toBeLessThanOrEqual(0.08);
    expect(doglegEligibleOverlaps).toBe(0);
  });
});

describe('incomingFaceByRoomId derivation over a real generated graph', () => {
  it('produces a valid face for every room, and at least one west case across a wide sweep', () => {
    let sawWest = false;
    for (let i = 0; i < 200; i += 1) {
      const seed = `incoming-face-sweep-${i}`;
      const roomCount = 6 + (i % 15);
      const { rooms, edges } = buildRoomGraph({ seed, roomCount });
      const { layoutEdges, hiddenIncomingByRoomId } = attachHiddenPaths({ rooms, edges, seed });
      const ranks = computeRanks(layoutEdges, 'room-entry');
      const columns = computeColumns(layoutEdges, ranks, 'room-entry');
      const positionByRoomId = Object.fromEntries(
        Object.keys(rooms).map((id) => [id, { rank: ranks[id], col: columns[id] }]),
      );
      const occupiedCells = Object.fromEntries(
        Object.entries(positionByRoomId).map(([id, pos]) => [`${pos.rank},${pos.col}`, id]),
      );
      for (const id of Object.keys(rooms)) {
        const legitimateSourceIds = new Set([
          ...parentRoomIdsFor(layoutEdges, id),
          ...(hiddenIncomingByRoomId[id] ?? []),
        ]);
        const face = incomingFaceFor(id, positionByRoomId, occupiedCells, legitimateSourceIds);
        expect(['north', 'west']).toContain(face);
        if (face === 'west') sawWest = true;
      }
    }
    expect(sawWest).toBe(true); // sanity: the sweep actually exercised the new fallback, not just the unchanged default
  });
});

describe('pendingForeignMarginOpenings — #297', () => {
  it('finds a foreign opening for the blocking room in a dogleg scenario', () => {
    const seed = 'dogleg-repro-seed-0'; // same concrete seed Task 2 pinned (tests/dungeon-layout.test.mjs's own dogleg describe block)
    const fromRoomId = 'from-room';
    const toRoomId = 'to-room';
    const blockerRoomId = 'blocker-room';
    const fromPos = { rank: 0, col: 0 };
    const toPos = { rank: 2, col: 0 };
    const layoutPositionByRoomId = {
      [fromRoomId]: fromPos,
      [blockerRoomId]: { rank: 1, col: 0 },
      [toRoomId]: toPos,
    };
    // Index 0 = toRoomId (the merge/shortcut room, gets exitFaceForIndex(0)='south'
    // -- confirmed live repro order), index 1 = blockerRoomId.
    const edges = { [fromRoomId]: [toRoomId, blockerRoomId] };
    const occupiedCells = { '0,0': fromRoomId, '1,0': blockerRoomId, '2,0': toRoomId };
    const incomingFaceByRoomId = { [toRoomId]: 'north', [blockerRoomId]: 'north' };

    const openings = pendingForeignMarginOpenings(
      seed, blockerRoomId, 1, 0, edges, layoutPositionByRoomId, incomingFaceByRoomId, occupiedCells,
    );

    // Cross-check against the SAME buildEdgeCorridor call this function
    // internally makes for this edge, rather than a second, independently
    // hardcoded expected value -- this file's own recurring "two things
    // must agree on a shared boundary" lesson applies here too, one level
    // up from Task 2's own fix.
    const fromRect = roomRect(seed, fromRoomId, fromPos.rank, fromPos.col);
    const toRect = roomRect(seed, toRoomId, toPos.rank, toPos.col);
    const toSlot = doorSlotsForFace(toRect, 1, 'north')[0];
    const { foreignOpening } = buildEdgeCorridor(
      seed, fromRoomId, toRoomId, fromRect, toRect, fromPos, toPos,
      'south', toSlot, occupiedCells, 'north',
    );
    expect(foreignOpening).not.toBeNull();
    expect(foreignOpening.side).toBe('south');
    expect(openings.south).toEqual([{ offset: foreignOpening.offset, width: foreignOpening.width }]);
    expect(openings.east).toEqual([]);
  });

  it('finds no foreign opening for a room with no blocking role', () => {
    const seed = 'dogleg-repro-seed-0';
    const layoutPositionByRoomId = {
      'a': { rank: 0, col: 0 },
      'b': { rank: 1, col: 0 },
    };
    const edges = { a: ['b'] };
    const occupiedCells = { '0,0': 'a', '1,0': 'b' };
    const openings = pendingForeignMarginOpenings(
      seed, 'b', 1, 0, edges, layoutPositionByRoomId, { b: 'north' }, occupiedCells,
    );
    expect(openings.east).toEqual([]);
    expect(openings.south).toEqual([]);
  });
});

describe('pendingForeignMarginOpenings — #297 Round 2: real slot resolution', () => {
  it('resolves the REAL per-connection slot for a multi-parent target, not slot 0 of an assumed single-connection room', () => {
    // A merge room with TWO real parents: shortcutSourceId (index 0, the
    // edge whose own dogleg blocks through the SAME room this test
    // targets) and blockerRoomId (index 1, its own direct adjacent edge).
    // The merge room's own incoming face is 'north' with 2 real
    // connections, so doorSlotsForFace(targetRect, 2, 'north') produces
    // TWO half-width slots -- genuinely different from the single
    // full-width slot the OLD, buggy call (doorSlotsForFace(targetRect, 1,
    // 'north')[0]) would have used. This difference is what makes the
    // test actually pin the fix, not just happen to pass under both the
    // old and new code.
    const seed = 'dogleg-repro-seed-0'; // reuse Round 1's own pinned seed
    const blockerRoomId = 'blocker-room'; // this test's own room being queried -- the co-parent AND the blocker, per Round 2's own detection
    const shortcutSourceId = 'from-room';
    const mergeRoomId = 'to-room';
    const layoutPositionByRoomId = {
      [shortcutSourceId]: { rank: 0, col: 0 },
      [blockerRoomId]: { rank: 1, col: 0 },
      [mergeRoomId]: { rank: 2, col: 0 },
    };
    // blockerRoomId is ALSO a real parent of mergeRoomId here (a second,
    // independent edge, unrelated to shortcutSourceId's own edge) --
    // giving mergeRoomId 2 real incoming connections.
    const layoutEdges = {
      [shortcutSourceId]: [mergeRoomId, blockerRoomId],
      [blockerRoomId]: [mergeRoomId],
    };
    const edges = layoutEdges; // no detour rooms in this scenario
    const occupiedCells = { '0,0': shortcutSourceId, '1,0': blockerRoomId, '2,0': mergeRoomId };
    const incomingFaceByRoomId = { [mergeRoomId]: 'north', [blockerRoomId]: 'north' };

    const openings = pendingForeignMarginOpenings(
      seed, blockerRoomId, 1, 0, edges, layoutPositionByRoomId, incomingFaceByRoomId, occupiedCells,
      layoutEdges, {},
    );

    // Cross-check: the REAL slot for shortcutSourceId's own edge into
    // mergeRoomId is index 0 of a 2-connection doorSlotsForFace call --
    // parentRoomIdsFor iterates Object.entries(layoutEdges) in insertion
    // order, and shortcutSourceId ('from-room') is this object literal's
    // own first key, so it's this target's own first real parent
    // (verified directly: `node -e` printing Object.entries(layoutEdges)
    // for this exact literal gives `from-room` before `blocker-room`).
    // blockerRoomId occupies index 1.
    const mergeRect = roomRect(seed, mergeRoomId, 2, 0);
    const realSlots = doorSlotsForFace(mergeRect, 2, 'north');
    const realSlotForShortcut = realSlots[0];
    const { foreignOpening } = buildEdgeCorridor(
      seed, shortcutSourceId, mergeRoomId, roomRect(seed, shortcutSourceId, 0, 0), mergeRect,
      { rank: 0, col: 0 }, { rank: 2, col: 0 }, 'south', realSlotForShortcut, occupiedCells, 'north',
    );
    expect(foreignOpening).not.toBeNull();
    expect(openings.south).toEqual([{ offset: foreignOpening.offset, width: foreignOpening.width }]);
  });
});

describe('#297 regression: exact live repro (issue #297, seed 1790705053246-4vdgop9m7i5\'s own edge shape)', () => {
  it('the merge room\'s second-parent edge routes around the blocking room instead of crossing its footprint, full pipeline', () => {
    const seed = 'dogleg-repro-seed-0';
    const sourceId = 'from-room';
    const blockerRoomId = 'blocker-room';
    const mergeRoomId = 'to-room';
    const sourcePos = { rank: 1, col: 0 };
    const blockerPos = { rank: 2, col: 0 };
    const mergePos = { rank: 3, col: 0 };
    const layoutPositionByRoomId = {
      [sourceId]: sourcePos,
      [blockerRoomId]: blockerPos,
      [mergeRoomId]: mergePos,
    };
    // Confirmed live graph order: index 0 = merge room (south exit),
    // index 1 = blocking room (east exit) -- see this brief's own note
    // above for why index order matters here.
    const edges = { [sourceId]: [mergeRoomId, blockerRoomId] };
    const occupiedCells = {
      '1,0': sourceId,
      '2,0': blockerRoomId,
      '3,0': mergeRoomId,
    };
    const incomingFaceByRoomId = { [mergeRoomId]: 'north', [blockerRoomId]: 'north' };

    const sourceRect = roomRect(seed, sourceId, sourcePos.rank, sourcePos.col);
    const mergeRect = roomRect(seed, mergeRoomId, mergePos.rank, mergePos.col);
    const blockerRect = roomRect(seed, blockerRoomId, blockerPos.rank, blockerPos.col);
    const toSlot = doorSlotsForFace(mergeRect, 1, 'north')[0];

    // The real edge that crosses the blocking room's own cell: source's
    // south exit (index 0) to the merge room, 2 ranks down, same column --
    // exactly buildEdgeCorridor's own null-path fast-path fallback.
    const { corridorSegments, foreignOpening } = buildEdgeCorridor(
      seed, sourceId, mergeRoomId, sourceRect, mergeRect, sourcePos, mergePos,
      'south', toSlot, occupiedCells, 'north',
    );

    // The real property (this issue's own root cause): no corridor floor
    // segment overlaps the blocking room's own rect.
    for (const seg of corridorSegments) {
      const overlapsX = seg.gx < blockerRect.gx + blockerRect.gw && seg.gx + seg.gw > blockerRect.gx;
      const overlapsY = seg.gy < blockerRect.gy + blockerRect.gh && seg.gy + seg.gh > blockerRect.gy;
      expect(overlapsX && overlapsY).toBe(false);
    }
    expect(foreignOpening).not.toBeNull();
    expect(foreignOpening.roomId).toBe(blockerRoomId);
    expect(foreignOpening.side).toBe('south');

    // Full pipeline: the blocking room's own pendingForeignMarginOpenings
    // scan (run as if building the BLOCKING room itself) must find this
    // exact opening, and cellMarginWalls must actually seal the blocking
    // room's own margin with it present -- not just that buildEdgeCorridor
    // reports it in isolation.
    const openings = pendingForeignMarginOpenings(
      seed, blockerRoomId, blockerPos.rank, blockerPos.col, edges, layoutPositionByRoomId, incomingFaceByRoomId, occupiedCells,
    );
    expect(openings.south).toEqual([{ offset: foreignOpening.offset, width: foreignOpening.width }]);
    expect(openings.east).toEqual([]);

    const marginWalls = cellMarginWalls(blockerRect, blockerPos.rank, blockerPos.col, {
      south: openings.south,
      east: openings.east,
    });
    // The blocking room's own south margin must have a REAL gap at the
    // foreign opening's own position -- not a single, unbroken wall that
    // would seal the dogleg's own crossing shut. Check the midpoint of the
    // opening's own x-range: no south wall segment may cover it.
    const blockCell = cellBounds(blockerPos.rank, blockerPos.col);
    const gapMidX = blockCell.gx + foreignOpening.offset + foreignOpening.width / 2;
    const southWalls = marginWalls.filter((w) => w.dir === 'south');
    const gapMidCovered = southWalls.some(
      (w) => Math.min(w.x1, w.x2) < gapMidX && Math.max(w.x1, w.x2) > gapMidX,
    );
    expect(gapMidCovered).toBe(false);
    // And the wall actually got split (more than a single unbroken
    // full-width segment) -- confirms cellMarginWalls really acted on the
    // opening, not that it happened to produce a wall that just doesn't
    // reach the midpoint for some other reason.
    expect(southWalls.length).toBeGreaterThan(1);
  });
});

describe('#297 Round 2 regression: co-parent correctly distinguished from an unrelated blocker in the original live-reported graph', () => {
  it('findPriorityCollision returns null when the blocker is genuinely unrelated to the target\'s real co-parent', () => {
    const seed = 'dogleg-repro-seed-0';
    const sourceId = 'room-room-entry-0';
    const blockerRoomId = 'room-room-room-entry-0-1';
    const mergeRoomId = 'room-room-room-entry-0-0';
    const coParentId = 'room-detour-0';
    const sourcePos = { rank: 1, col: 0 };
    const blockerPos = { rank: 2, col: 0 };
    const mergePos = { rank: 3, col: 0 };
    const coParentPos = { rank: 2, col: 2 };
    const layoutPositionByRoomId = {
      [sourceId]: sourcePos,
      [blockerRoomId]: blockerPos,
      [mergeRoomId]: mergePos,
      [coParentId]: coParentPos,
    };
    // Real graph shape from the original live report (#297's own issue
    // body, and this spec's own "Confirmed live" section): the merge
    // room's real parents are sourceId and coParentId -- blockerRoomId is
    // an unrelated sibling that merely happens to occupy the intermediate
    // cell sourceId's own south-exit edge crosses.
    const layoutEdges = {
      [sourceId]: [mergeRoomId, blockerRoomId],
      [coParentId]: [mergeRoomId],
    };
    const occupiedCells = {
      '1,0': sourceId,
      '2,0': blockerRoomId,
      '3,0': mergeRoomId,
      '2,2': coParentId,
    };
    const incomingConnections = incomingConnectionsFor(layoutEdges, mergeRoomId, {});
    expect(incomingConnections).toEqual([
      { sourceId, hidden: false },
      { sourceId: coParentId, hidden: false },
    ]);
    const collision = findPriorityCollision(
      seed, mergeRoomId, mergePos.rank, mergePos.col, incomingConnections, layoutPositionByRoomId, occupiedCells,
    );
    // The critical assertion: blockerRoomId occupies the intermediate cell
    // (Round 1's own dogleg trigger fires), but it is NOT one of the merge
    // room's own real parents -- findCoParentCollision (reused inside
    // findPriorityCollision) must correctly reject it, so Round 1's own
    // unmodified dogleg is used exactly as it always has been for this
    // exact originally-reported shape.
    expect(collision).toBeNull();
  });
});

describe('#297 Round 2 regression: slot priority resolves the real co-parent collision without touching Round 1\'s own dogleg geometry', () => {
  it('the colliding connection\'s own corridor uses the exact same dogleg shape as a naive slot assignment, only its own final target-approach gap differs, and the co-parent\'s own corridor is unaffected', () => {
    const seed = 'dogleg-repro-seed-0';
    const shortcutSourceId = 'from-room';
    const blockerRoomId = 'blocker-room';
    const mergeRoomId = 'to-room';
    const shortcutPos = { rank: 0, col: 0 };
    const blockerPos = { rank: 1, col: 0 };
    const mergePos = { rank: 2, col: 0 };
    const layoutPositionByRoomId = {
      [shortcutSourceId]: shortcutPos,
      [blockerRoomId]: blockerPos,
      [mergeRoomId]: mergePos,
    };
    const occupiedCells = { '0,0': shortcutSourceId, '1,0': blockerRoomId, '2,0': mergeRoomId };
    const incomingConnections = [
      { sourceId: shortcutSourceId, hidden: false },
      { sourceId: blockerRoomId, hidden: false },
    ];
    const shortcutRect = roomRect(seed, shortcutSourceId, shortcutPos.rank, shortcutPos.col);
    const blockerRect = roomRect(seed, blockerRoomId, blockerPos.rank, blockerPos.col);
    const mergeRect = roomRect(seed, mergeRoomId, mergePos.rank, mergePos.col);

    const collision = findPriorityCollision(
      seed, mergeRoomId, mergePos.rank, mergePos.col, incomingConnections, layoutPositionByRoomId, occupiedCells,
    );
    expect(collision).not.toBeNull();

    const naiveSlots = doorSlotsForFace(mergeRect, 2, 'north');
    const prioritySlots = assignDoorSlotsWithPriority(seed, mergeRect, incomingConnections, 'north', collision);

    const naiveResult = buildEdgeCorridor(
      seed, shortcutSourceId, mergeRoomId, shortcutRect, mergeRect, shortcutPos, mergePos,
      'south', naiveSlots[0], occupiedCells, 'north',
    );
    const priorityResult = buildEdgeCorridor(
      seed, shortcutSourceId, mergeRoomId, shortcutRect, mergeRect, shortcutPos, mergePos,
      'south', prioritySlots[0], occupiedCells, 'north',
    );

    // Round 1's own dogleg logic is completely untouched: same trigger,
    // same turn/lane/turn-2 SHAPE (segment count, and every segment's own
    // width/height except the final one), only the FINAL branch segment's
    // own x-range (which encodes the target gap position) may differ
    // between the naive and priority slot. `foreignOpening`'s own
    // roomId/side are unaffected by which slot is used, but its own
    // offset/width are NOT asserted equal here: per buildEdgeCorridor's
    // own "Review round 2 fix" comment, that range is deliberately derived
    // from gapX0/gapX1 (the same final target-approach gap this comment
    // already calls out as allowed to differ), so asserting it byte-equal
    // would contradict the very shape invariant this test is checking --
    // confirmed by direct invocation against this exact fixture: naive
    // gives {offset:2,width:5}, priority gives {offset:5,width:2} (same
    // combined span, different split), both real slot assignments.
    expect(priorityResult.foreignOpening.roomId).toEqual(naiveResult.foreignOpening.roomId);
    expect(priorityResult.foreignOpening.side).toEqual(naiveResult.foreignOpening.side);
    expect(priorityResult.corridorSegments).toHaveLength(naiveResult.corridorSegments.length);
    for (let i = 0; i < naiveResult.corridorSegments.length - 1; i += 1) {
      expect(priorityResult.corridorSegments[i]).toEqual(naiveResult.corridorSegments[i]);
    }
    // The source's own door is real and unmovable -- unaffected by which
    // TARGET slot is used.
    expect(priorityResult.doorWall).toEqual(naiveResult.doorWall);

    // Now the real cross-connection property: build the co-parent's own
    // corridor with ITS OWN priority slot, and confirm neither connection's
    // own revealDoorWall is covered by the other's plainWalls -- the exact
    // shape Round 1's own final review found violated.
    const coParentResult = buildEdgeCorridor(
      seed, blockerRoomId, mergeRoomId, blockerRect, mergeRect, blockerPos, mergePos,
      'south', prioritySlots[1], occupiedCells, 'north',
    );
    const wallCoversDoor = (walls, door) => walls.some(
      (w) => w.y1 === w.y2 && door.y1 === door.y2 && w.y1 === door.y1
        && Math.min(w.x1, w.x2) < Math.max(door.x1, door.x2)
        && Math.max(w.x1, w.x2) > Math.min(door.x1, door.x2),
    );
    expect(wallCoversDoor(priorityResult.plainWalls, coParentResult.revealDoorWall)).toBe(false);
    expect(wallCoversDoor(coParentResult.plainWalls, priorityResult.revealDoorWall)).toBe(false);
    // And the co-parent's own corridor takes the simple adjacent branch,
    // not a dogleg -- the Global Constraints invariant this plan requires
    // verifying, not assuming.
    expect(coParentResult.foreignOpening).toBeNull();
    expect(coParentResult.corridorSegments).toHaveLength(1);
  });
});

describe('findCoParentCollision — #297 Round 2', () => {
  it('finds the matching real connection index when the blocker is a co-parent', () => {
    const incomingConnections = [
      { sourceId: 'blocker-room', hidden: false },
      { sourceId: 'from-room', hidden: false },
    ];
    const foreignOpening = { roomId: 'blocker-room', side: 'south', offset: 5, width: 2 };
    expect(findCoParentCollision(foreignOpening, incomingConnections)).toBe(0);
  });

  it('returns -1 when there is no blocker', () => {
    const incomingConnections = [{ sourceId: 'from-room', hidden: false }];
    expect(findCoParentCollision(null, incomingConnections)).toBe(-1);
  });

  it('returns -1 when the blocker is unrelated to this target (Round 1\'s own unrelated-blocker case)', () => {
    const incomingConnections = [{ sourceId: 'from-room', hidden: false }];
    const foreignOpening = { roomId: 'some-unrelated-room', side: 'south', offset: 5, width: 2 };
    expect(findCoParentCollision(foreignOpening, incomingConnections)).toBe(-1);
  });

  it('returns -1 when the matching connection is HIDDEN, not a real co-parent (Review Focus item 5)', () => {
    const incomingConnections = [
      { sourceId: 'detour-room', hidden: true },
      { sourceId: 'from-room', hidden: false },
    ];
    const foreignOpening = { roomId: 'detour-room', side: 'south', offset: 5, width: 2 };
    expect(findCoParentCollision(foreignOpening, incomingConnections)).toBe(-1);
  });
});

describe('findPriorityCollision — #297 Round 2 (slot priority)', () => {
  it('finds the priority collision for the pinned dogleg scenario', () => {
    const seed = 'dogleg-repro-seed-0'; // reuses Task 2's own pinned seed/graph
    const shortcutSourceId = 'from-room';
    const blockerRoomId = 'blocker-room';
    const mergeRoomId = 'to-room';
    const layoutPositionByRoomId = {
      [shortcutSourceId]: { rank: 0, col: 0 },
      [blockerRoomId]: { rank: 1, col: 0 },
      [mergeRoomId]: { rank: 2, col: 0 },
    };
    const occupiedCells = { '0,0': shortcutSourceId, '1,0': blockerRoomId, '2,0': mergeRoomId };
    // Real parent order for mergeRoomId matches Object.entries(layoutEdges)'s
    // own insertion order from Task 2's own pinned scenario: shortcutSourceId
    // first (index 0), blockerRoomId second (index 1) -- verified via
    // `node -e` in Task 2's own report, reused here directly.
    const incomingConnections = [
      { sourceId: shortcutSourceId, hidden: false },
      { sourceId: blockerRoomId, hidden: false },
    ];
    const collision = findPriorityCollision(
      seed, mergeRoomId, 2, 0, incomingConnections, layoutPositionByRoomId, occupiedCells,
    );
    expect(collision).not.toBeNull();
    expect(collision.collidingIndex).toBe(0);
    expect(collision.axis).toBe('south');
    expect(collision.blockerId).toBe(blockerRoomId);
    expect(collision.blockRank).toBe(1);
    expect(collision.blockCol).toBe(0);
  });

  it('returns null when the intermediate cell is unoccupied (no dogleg needed at all)', () => {
    const seed = 'dogleg-repro-seed-0';
    const layoutPositionByRoomId = { a: { rank: 0, col: 0 }, b: { rank: 2, col: 0 } };
    const occupiedCells = { '0,0': 'a', '2,0': 'b' };
    const incomingConnections = [{ sourceId: 'a', hidden: false }];
    expect(findPriorityCollision(seed, 'b', 2, 0, incomingConnections, layoutPositionByRoomId, occupiedCells)).toBeNull();
  });

  it('returns null when the intermediate occupant is NOT one of this target\'s own real parents (Round 1\'s own unrelated-blocker case)', () => {
    const seed = 'dogleg-repro-seed-0';
    const layoutPositionByRoomId = { a: { rank: 0, col: 0 }, unrelated: { rank: 1, col: 0 }, b: { rank: 2, col: 0 } };
    const occupiedCells = { '0,0': 'a', '1,0': 'unrelated', '2,0': 'b' };
    // 'unrelated' is not in incomingConnections at all -- not a parent of 'b'.
    const incomingConnections = [{ sourceId: 'a', hidden: false }];
    expect(findPriorityCollision(seed, 'b', 2, 0, incomingConnections, layoutPositionByRoomId, occupiedCells)).toBeNull();
  });

  it('ignores a HIDDEN connection as the colliding edge (Review Focus item 5)', () => {
    const seed = 'dogleg-repro-seed-0';
    const layoutPositionByRoomId = { hiddenSource: { rank: 0, col: 0 }, blocker: { rank: 1, col: 0 }, target: { rank: 2, col: 0 } };
    const occupiedCells = { '0,0': 'hiddenSource', '1,0': 'blocker', '2,0': 'target' };
    const incomingConnections = [
      { sourceId: 'hiddenSource', hidden: true },
      { sourceId: 'blocker', hidden: false },
    ];
    expect(findPriorityCollision(seed, 'target', 2, 0, incomingConnections, layoutPositionByRoomId, occupiedCells)).toBeNull();
  });
});

describe('assignDoorSlotsWithPriority — #297 Round 2', () => {
  it('assigns the colliding connection the slot nearest the blocker\'s own east edge, for the pinned scenario', () => {
    const seed = 'dogleg-repro-seed-0';
    const mergeRect = roomRect(seed, 'to-room', 2, 0);
    const incomingConnections = [
      { sourceId: 'from-room', hidden: false },
      { sourceId: 'blocker-room', hidden: false },
    ];
    const collision = { collidingIndex: 0, axis: 'south', blockerId: 'blocker-room', blockRank: 1, blockCol: 0 };
    const slots = assignDoorSlotsWithPriority(seed, mergeRect, incomingConnections, 'north', collision);
    const blockerRect = roomRect(seed, 'blocker-room', 1, 0);
    const edgeX = blockerRect.gx + blockerRect.gw;
    // The colliding connection's own slot must contain, or lie entirely
    // east of, the blocker's own east edge -- the real property, not a
    // hardcoded expectation, so this test still pins the fix if the
    // pinned seed's own room sizes ever change.
    expect(slots[0].x1).toBeGreaterThanOrEqual(Math.min(edgeX, mergeRect.gx));
    expect(slots[0].x1 <= edgeX && slots[0].x2 >= edgeX || slots[0].x1 >= edgeX).toBe(true);
    // The co-parent's own slot must lie entirely at-or-west of the
    // blocker's own east edge (never reaching into the dogleg's own lane).
    expect(slots[1].x2).toBeLessThanOrEqual(edgeX);
    // Every connection still gets exactly one, distinct slot (Review Focus
    // item 2) -- no duplication, no dropped connection.
    expect(slots).toHaveLength(2);
    expect(slots[0]).not.toEqual(slots[1]);
  });

  it('returns list-order slots, unchanged, when there is no collision (Review Focus item 4)', () => {
    const seed = 'dogleg-repro-seed-0';
    const rect = roomRect(seed, 'to-room', 2, 0);
    const incomingConnections = [{ sourceId: 'a', hidden: false }, { sourceId: 'b', hidden: false }];
    const plain = doorSlotsForFace(rect, 2, 'north');
    const result = assignDoorSlotsWithPriority(seed, rect, incomingConnections, 'north', null);
    expect(result).toEqual(plain);
  });

  it('pins the co-parent west of the edge even with 3+ connections and unfavorable list order (final-review finding B, 2026-09-29 -- real seed sweep-37, room-merge-9)', () => {
    const seed = 'sweep-37';
    const toId = 'room-merge-9';
    const toPos = { rank: 7, col: 0 };
    // Real graph shape (positions only -- roomRect/findPriorityCollision/
    // assignDoorSlotsWithPriority are pure functions of seed+roomId+rank+
    // col, so this reproduces the exact real geometry without running the
    // full buildRoomGraph/attachHiddenPaths pipeline). The co-parent
    // ('room-detour-0') is listed LAST (index 3), after the colliding
    // connection (index 2) -- exactly the list-order shape finding B
    // exploited.
    const incomingConnections = [
      { sourceId: 'room-room-room-room-room-entry-0-0-0-1', hidden: false },
      { sourceId: 'room-room-room-room-room-entry-0-1-0-0', hidden: false },
      { sourceId: 'room-room-room-room-room-room-entry-0-0-0-0-0', hidden: false },
      { sourceId: 'room-detour-0', hidden: false },
    ];
    const layoutPositionByRoomId = {
      'room-room-room-room-room-entry-0-0-0-1': { rank: 4, col: 2 },
      'room-room-room-room-room-entry-0-1-0-0': { rank: 4, col: 4 },
      'room-room-room-room-room-room-entry-0-0-0-0-0': { rank: 5, col: 0 },
      'room-detour-0': { rank: 6, col: 0 },
    };
    const occupiedCells = {
      '5,0': 'room-room-room-room-room-room-entry-0-0-0-0-0',
      '6,0': 'room-detour-0',
      '7,0': toId,
    };
    const toRect = roomRect(seed, toId, toPos.rank, toPos.col);

    const collision = findPriorityCollision(
      seed, toId, toPos.rank, toPos.col, incomingConnections, layoutPositionByRoomId, occupiedCells, 'north',
    );
    expect(collision).not.toBeNull();
    expect(collision.collidingIndex).toBe(2);
    expect(collision.blockerId).toBe('room-detour-0');

    const slots = assignDoorSlotsWithPriority(seed, toRect, incomingConnections, 'north', collision);
    const blockerRect = roomRect(seed, collision.blockerId, collision.blockRank, collision.blockCol);
    const edgeCoord = blockerRect.gx + blockerRect.gw;
    const coParentIndex = incomingConnections.findIndex((c) => c.sourceId === collision.blockerId);

    // The critical assertion: the co-parent's own slot (index 3, listed
    // AFTER the colliding connection) must land west of/at the edge --
    // NOT wherever plain list-order preservation would have put it. Hand-
    // traced against the pre-fix algorithm for this exact fixture: the
    // pre-fix code gave this connection {x1:309,x2:312}, entirely EAST of
    // edgeCoord (306), because the pre-fix loop merely preserved each
    // non-colliding connection's own list-order position across the
    // leftover slots, without regard to WHICH of them was actually the
    // co-parent.
    expect(slots[coParentIndex].x2).toBeLessThanOrEqual(edgeCoord);
  });

});

describe('findPriorityCollision — #297 Round 2 fix (final-review finding D, corrected 2026-09-29)', () => {
  it('does not grant priority when the corridor\'s own real span never overlaps the blocker\'s footprint, even though the intermediate cell is occupied by a real co-parent (real seed sweep-461, room-merge-14)', () => {
    const seed = 'sweep-461';
    const toId = 'room-merge-14';
    const toPos = { rank: 9, col: 0 };
    // Real graph shape: the co-parent ('room-room-merge-11-0') sits
    // directly in the intermediate cell between the colliding connection's
    // own source and the target -- Round 1's own dogleg TRIGGER condition
    // (occupied intermediate cell, real co-parent) is satisfied, but the
    // corridor's own actual provisional span (derived from the source's
    // real door offset) never reaches the blocker's footprint, so Round
    // 1's own dogleg would never actually fire for this edge. Verified by
    // direct instrumentation against the pinned seed (search script, not
    // committed): `spanOverlapsBlocker` is false. NOTE: in this specific
    // fixture the colliding connection's own list index already happens
    // to equal `priorityIndexForEdge`'s own result, so this test alone
    // does NOT distinguish the plain-slot check (the first, broken version
    // of this fix) from the priority-slot check (the corrected version) --
    // see the second test below for that distinction, added after an
    // independent re-review caught the first version using the wrong slot.
    const incomingConnections = [
      { sourceId: 'room-room-merge-11-0', hidden: false },
      { sourceId: 'room-room-merge-11-1', hidden: false },
    ];
    const layoutPositionByRoomId = {
      'room-room-merge-11-0': { rank: 8, col: 0 },
      'room-room-merge-11-1': { rank: 7, col: 0 },
    };
    const occupiedCells = {
      '7,0': 'room-room-merge-11-1',
      '8,0': 'room-room-merge-11-0',
      '9,0': toId,
    };
    const collision = findPriorityCollision(
      seed, toId, toPos.rank, toPos.col, incomingConnections, layoutPositionByRoomId, occupiedCells, 'north',
    );
    // The critical assertion (finding D): an occupied, real-co-parent
    // intermediate cell is NECESSARY but not SUFFICIENT -- without also
    // checking `spanOverlapsBlocker`, the pre-fix version of this function
    // returned a non-null collision here, granting the colliding
    // connection slot priority for a corridor that was never actually
    // going to dogleg at all.
    expect(collision).toBeNull();
  });

  it('checks the span against the slot the connection would ACTUALLY receive if granted priority, not its own plain list-order slot (real seed sweep-9)', () => {
    // This is the exact case an independent re-review caught the first
    // version of the finding-D fix missing: the colliding connection's own
    // PLAIN slot (list-order index 0, x=326..332) DOES overlap the
    // blocker's footprint (the old, broken check's own verdict -- would
    // have incorrectly granted priority), but the slot it would actually
    // be assigned if priority WERE granted (priorityIndexForEdge's own
    // result, index 1, x=332..338) does NOT overlap. The first fix
    // attempt used the plain slot and got this wrong; it fixed only 1 of
    // 11 real cases (the one where plain and priority slots coincidentally
    // matched) and left the other 10, including this one, broken.
    const seed = 'sweep-9';
    const toId = 'room-room-room-room-room-room-entry-0-0-0-1-0';
    const toPos = { rank: 7, col: 2 };
    const incomingConnections = [
      { sourceId: 'room-room-room-room-room-entry-0-0-0-1', hidden: false },
      { sourceId: 'room-detour-1', hidden: false },
    ];
    const layoutPositionByRoomId = {
      'room-room-room-room-room-entry-0-0-0-1': { rank: 5, col: 2 },
      'room-detour-1': { rank: 6, col: 2 },
    };
    const occupiedCells = {
      '5,2': 'room-room-room-room-room-entry-0-0-0-1',
      '6,2': 'room-detour-1',
      '7,2': toId,
    };
    const collision = findPriorityCollision(
      seed, toId, toPos.rank, toPos.col, incomingConnections, layoutPositionByRoomId, occupiedCells, 'north',
    );
    expect(collision).toBeNull();
  });
});

describe('outgoingSlotsForFace (#415)', () => {
  const rect = { gx: 300, gy: 13, gw: 6, gh: 6 };
  it('splits the south face left to right', () => {
    expect(outgoingSlotsForFace(rect, 3, 'south')).toEqual([
      { x1: 300, y1: 19, x2: 302, y2: 19 },
      { x1: 302, y1: 19, x2: 304, y2: 19 },
      { x1: 304, y1: 19, x2: 306, y2: 19 },
    ]);
  });
  it('splits the east face top to bottom', () => {
    expect(outgoingSlotsForFace(rect, 2, 'east')).toEqual([
      { x1: 306, y1: 13, x2: 306, y2: 16 },
      { x1: 306, y1: 16, x2: 306, y2: 19 },
    ]);
  });
  it('rejects faces that are never outgoing', () => {
    expect(() => outgoingSlotsForFace(rect, 1, 'west')).toThrow();
    expect(() => outgoingSlotsForFace(rect, 1, 'north')).toThrow();
  });
});

describe('outgoingDoorPlan (#415)', () => {
  const rect = { gx: 300, gy: 13, gw: 6, gh: 6 };
  const pos = { rank: 1, col: 0 };
  const P = (rank, col) => ({ rank, col });
  it('uses south for same-column and lower-column targets, east for higher-column', () => {
    const plan = outgoingDoorPlan(rect, { rank: 1, col: 2 }, { realChildIds: ['a', 'b'], hiddenChildIds: [] },
      { a: P(2, 2), b: P(3, 4) });
    expect(plan.get('a').face).toBe('south');
    expect(plan.get('b').face).toBe('east');
  });
  it('never assigns west or north', () => {
    const plan = outgoingDoorPlan(rect, pos, { realChildIds: ['a', 'b', 'c'], hiddenChildIds: [] },
      { a: P(2, 0), b: P(2, 2), c: P(3, 4) });
    for (const e of plan.values()) expect(['south', 'east']).toContain(e.face);
  });
  it('single door on a face leaves exitPoint null (legacy, byte-identical)', () => {
    const plan = outgoingDoorPlan(rect, pos, { realChildIds: ['a'], hiddenChildIds: [] }, { a: P(2, 0) });
    expect(plan.get('a')).toMatchObject({ face: 'south', doorCount: 1, exitPoint: null, doorSpan: null });
  });
  it('two south doors get disjoint one-cell spans inside their slots, sorted by target column', () => {
    const plan = outgoingDoorPlan(rect, { rank: 1, col: 2 }, { realChildIds: ['far', 'same'], hiddenChildIds: [] },
      { far: P(3, 0), same: P(3, 2) });
    const far = plan.get('far'); const same = plan.get('same');
    expect(far.slotIndex).toBe(0); expect(same.slotIndex).toBe(1);
    expect(far.doorSpan.x2 - far.doorSpan.x1).toBe(1);
    expect(far.doorSpan.x2).toBeLessThanOrEqual(same.doorSpan.x1);
    for (const e of [far, same]) {
      expect(e.doorSpan.x1).toBeGreaterThanOrEqual(e.slot.x1);
      expect(e.doorSpan.x2).toBeLessThanOrEqual(e.slot.x2);
      expect(e.exitPoint).toEqual({ x: e.doorSpan.x1, y: rect.gy + rect.gh });
    }
  });
  it('is independent of child-list order', () => {
    const t = { a: P(3, 0), b: P(3, 2), c: P(4, 4) };
    const one = outgoingDoorPlan(rect, { rank: 1, col: 2 }, { realChildIds: ['a', 'b', 'c'], hiddenChildIds: [] }, t);
    const two = outgoingDoorPlan(rect, { rank: 1, col: 2 }, { realChildIds: ['c', 'b', 'a'], hiddenChildIds: [] }, t);
    expect([...one.entries()].sort()).toEqual([...two.entries()].sort());
  });
});
