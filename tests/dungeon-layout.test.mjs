import { describe, it, expect } from 'vitest';
import {
  ROOM_SIZE_SMALL, ROOM_SIZE_LARGE, DOOR_WIDTH,
  roomSizeAt, doorOffsetAt, corridorTileVariant,
  computeRanks, computeColumns,
  roomRect, exitFaceForIndex, roomEnclosureWalls, ROW_STRIDE, COLUMN_STRIDE, parentRoomIdsFor, incomingConnectionsFor, buildEdgeCorridor, incomingFaceFor, doorSlotsForFace,
  cellBounds, projectOntoSide, findCorridorPath, INITIAL_GX, cellMarginWalls, transitCellCrossing,
  transitCellContainmentWalls, CORRIDOR_LEN, outgoingMarginOffset,
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
    expect(result.foreignOpening).toEqual({ roomId: 'x', side: 'south', offset: 12, width: DOOR_WIDTH });
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
    for (const wall of result.plainWalls) {
      expect(wall.x1).toBe(toSlot.x1);
      expect(wall.x2).toBe(toSlot.x1);
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
    const blockerRight = blockerRect.gx + blockerRect.gw;

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
    // The foreign opening's own offset must describe a gap that starts at
    // (or past) the blocker's own east edge, within the blocker's cell.
    const blockerCell = cellBounds(1, 0);
    expect(blockerCell.gx + result.foreignOpening.offset).toBeGreaterThanOrEqual(blockerRight);
    expect(result.foreignOpening.width).toBe(DOOR_WIDTH);
    // Review round 1 fix: the corridor must actually REACH the target's
    // real door, not just avoid the blocker -- the last (turn 2) segment's
    // own x-range must cover revealDoorWall's own x-range.
    const lastSeg = result.corridorSegments[result.corridorSegments.length - 1];
    expect(lastSeg.gx).toBeLessThanOrEqual(result.revealDoorWall.x1);
    expect(lastSeg.gx + lastSeg.gw).toBeGreaterThanOrEqual(result.revealDoorWall.x2);
  });

  it('does not activate when a real blocker exists but its footprint misses the fixed door column', () => {
    // Review round 1 fix: the original version of this test used an EMPTY
    // intermediate cell, which only exercises findCorridorPath's own
    // found-path branch (the multi-cell branch, returned before this
    // task's own null-path fallback is ever reached) -- it never actually
    // proved anything about the dogleg condition itself. This version
    // uses a REAL blocker room at rank 1, boxed in on every side (same
    // occupiedCells shape as the 'falls back to a direct line' test
    // above) so findCorridorPath returns null and this task's own
    // null-path fallback fires -- but with a seed/room pairing (found the
    // same way as Step 1a, this time searching for doorX0 landing AT OR
    // PAST the blocker's own east edge instead of inside it) where the
    // blocker's own footprint does NOT contain doorX0, so the dogleg
    // condition (`doorX0 < occupantEastEdge`) is false and the output
    // must be byte-identical to this file's pre-#297 single-box shape.
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

    // Confirm the scenario is real: doorX0 (derived independently here,
    // the same way buildEdgeCorridor computes it internally) sits at or
    // past the blocker's own east edge (verified via node: fromSize=LARGE,
    // blockerSize=SMALL, doorX0=308, blockerRect={gx:300,gw:6} so
    // blockerEast=306 <= 308) -- '1,0' in occupiedCells above is a genuine
    // blocker room, not an empty cell.
    const blockerRect = roomRect(missSeed, blockerRoomId, 1, 0);
    const outgoingOffset = doorOffsetAt(missSeed, `${fromRoomId}-south`, 'outgoing', fromRect.gw);
    const doorX0 = fromRect.gx + outgoingOffset;
    expect(doorX0).toBeGreaterThanOrEqual(blockerRect.gx + blockerRect.gw);

    // Byte-identical to the pre-#297 single-box shape: no dogleg, no
    // third segment, no foreignOpening.
    expect(result.foreignOpening).toBeNull();
    expect(result.corridorSegments).toHaveLength(1);
    expect(result.corridorSegments).toEqual([
      { gx: 305, gy: 12, gw: 4, gh: 14 },
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

  it('with a single opening, matches the old single-opening call exactly', () => {
    const rect = { gx: 300, gy: 0, gw: 6, gh: 6 };
    const oldStyle = cellMarginWalls(rect, 0, 0, { east: [{ offset: 2, width: 1 }] });
    // Same result whether expressed as the old openSide/openOffset/openWidth
    // shape or the new list-of-one shape — this pins the generalization as
    // a strict superset, not a behavior change, for the common case.
    expect(oldStyle).toEqual([
      { dir: 'east', x1: 313, y1: 0, x2: 313, y2: 2 },
      { dir: 'east', x1: 313, y1: 3, x2: 313, y2: 13 },
      { dir: 'south', x1: 300, y1: 13, x2: 313, y2: 13 },
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
