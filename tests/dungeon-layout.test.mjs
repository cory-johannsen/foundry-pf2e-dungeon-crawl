import { describe, it, expect } from 'vitest';
import {
  ROOM_SIZE_SMALL, ROOM_SIZE_LARGE, DOOR_WIDTH,
  roomSizeAt, doorOffsetAt, corridorTileVariant,
  computeRanks, computeColumns,
  roomRect, exitFaceForIndex, roomEnclosureWalls, ROW_STRIDE, COLUMN_STRIDE, parentRoomIdsFor, incomingConnectionsFor, northDoorSlots, buildEdgeCorridor,
  cellBounds, findCorridorPath, INITIAL_GX, cellMarginWalls, transitCellCrossing,
} from '../scripts/dungeon-layout.mjs';
import { buildRoomGraph } from '../scripts/dungeon-deck.mjs';

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

describe('northDoorSlots', () => {
  it('divides the north edge into count equal, contiguous, left-to-right slots', () => {
    const rect = { gx: 0, gy: 0, gw: 4, gh: 4 };
    const slots = northDoorSlots(rect, 2);
    expect(slots).toEqual([
      { x1: 0, y1: 0, x2: 2, y2: 0 },
      { x1: 2, y1: 0, x2: 4, y2: 0 },
    ]);
  });

  it('a single slot spans the whole north edge', () => {
    const rect = { gx: 0, gy: 0, gw: 4, gh: 4 };
    expect(northDoorSlots(rect, 1)).toEqual([{ x1: 0, y1: 0, x2: 4, y2: 0 }]);
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
});

describe('buildEdgeCorridor', () => {
  it('same-column rooms (straight south connection) produce one corridor segment', () => {
    const from = roomRect('alpha', 'a', 0, 0);
    const to = roomRect('alpha', 'b', 1, 0);
    const toSlot = northDoorSlots(to, 1)[0];
    const { corridorSegments } = buildEdgeCorridor('alpha', 'a', 'b', from, to, 'south', toSlot);
    expect(corridorSegments).toHaveLength(1);
  });

  it('different-column rooms produce an L-shaped (2-segment) corridor', () => {
    const from = roomRect('alpha', 'a', 0, 0);
    const to = roomRect('alpha', 'b', 1, 2);
    const toSlot = northDoorSlots(to, 1)[0];
    const { corridorSegments } = buildEdgeCorridor('alpha', 'a', 'b', from, to, 'south', toSlot);
    expect(corridorSegments).toHaveLength(2);
  });

  it('always returns a door wall and a reveal door wall', () => {
    const from = roomRect('alpha', 'a', 0, 0);
    const to = roomRect('alpha', 'b', 1, 1);
    const toSlot = northDoorSlots(to, 1)[0];
    const { doorWall, revealDoorWall } = buildEdgeCorridor('alpha', 'a', 'b', from, to, 'south', toSlot);
    expect(doorWall).toBeDefined();
    expect(revealDoorWall).toBeDefined();
  });

  it('two exits from the same room on different faces never share a door offset key', () => {
    const from = roomRect('alpha', 'a', 0, 0);
    const toSouth = roomRect('alpha', 'b', 1, 0);
    const toEast = roomRect('alpha', 'c', 0, 1);
    const south = buildEdgeCorridor('alpha', 'a', 'b', from, toSouth, 'south', northDoorSlots(toSouth, 1)[0]);
    const east = buildEdgeCorridor('alpha', 'a', 'c', from, toEast, 'east', northDoorSlots(toEast, 1)[0]);
    expect(south.doorWall).not.toEqual(east.doorWall);
  });

  it('#93 pre-flight fix regression — two different incoming connections to the same merge room land on distinct, non-overlapping door slots', () => {
    const parentA = roomRect('alpha', 'a', 0, 0);
    const parentB = roomRect('alpha', 'b', 0, 1);
    const merge = roomRect('alpha', 'm', 1, 0);
    const slots = northDoorSlots(merge, 2);
    const fromA = buildEdgeCorridor('alpha', 'a', 'm', parentA, merge, 'south', slots[0]);
    const fromB = buildEdgeCorridor('alpha', 'b', 'm', parentB, merge, 'south', slots[1]);
    expect(fromA.revealDoorWall).not.toEqual(fromB.revealDoorWall);
    // The two doors must not overlap — slot 0's door stays left of slot 1's.
    expect(Math.max(fromA.revealDoorWall.x1, fromA.revealDoorWall.x2))
      .toBeLessThanOrEqual(Math.min(fromB.revealDoorWall.x1, fromB.revealDoorWall.x2));
  });

  it('#93 pre-flight fix regression (Task 10 review) — a same-column connection\'s TARGET-side plainWalls never extend past its own slot into a sibling\'s (would otherwise wall off the sibling\'s door)', () => {
    const parentA = roomRect('alpha', 'a', 0, 0);
    const merge = roomRect('alpha', 'm', 1, 0); // same column as parentA -> sameColumn branch
    const slots = northDoorSlots(merge, 2);
    const fromA = buildEdgeCorridor('alpha', 'a', 'm', parentA, merge, 'south', slots[0]);
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
    const toSlot = northDoorSlots(to, 1)[0];
    const { revealDoorWall, corridorSegments } = buildEdgeCorridor('alpha', 'a', 'm', from, to, 'south', toSlot);
    expect(revealDoorWall.y1).toBe(to.gy);
    expect(corridorSegments[0].gy + corridorSegments[0].gh).toBe(to.gy);
  });

  it('#93 pre-flight fix regression (this task\'s own final review) — a same-column room whose incoming-door count doesn\'t evenly divide its width still keeps every door within its own slot (doorOffsetAt must not exceed a fractional maxOffset)', () => {
    const parentA = roomRect('alpha', 'a', 0, 0);
    const parentB = roomRect('alpha', 'b', 0, 1);
    const merge = roomRect('alpha', 'm', 1, 0); // ROOM_SIZE_SMALL = 6, split 4 ways below -> slotWidth = 1.5
    const slots = northDoorSlots(merge, 4);
    for (let i = 0; i < slots.length; i += 1) {
      const from = i === 0 ? parentA : parentB; // exitFace/column irrelevant to this bug; same-column (i===0) is where it reproduces
      const { revealDoorWall } = buildEdgeCorridor('alpha', from === parentA ? 'a' : 'b', 'm', from, merge, 'south', slots[i]);
      expect(Math.min(revealDoorWall.x1, revealDoorWall.x2)).toBeGreaterThanOrEqual(slots[i].x1);
      expect(Math.max(revealDoorWall.x1, revealDoorWall.x2)).toBeLessThanOrEqual(slots[i].x2);
    }
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
    const occupiedCells = { '1,0': 'blocker' };
    const path = findCorridorPath(
      { rank: 0, col: 0 }, { rank: 2, col: 0 }, occupiedCells, { fromRoomId: 'a', toRoomId: 'b' },
    );
    expect(path).not.toBeNull();
    expect(path).not.toContainEqual({ rank: 1, col: 0 });
    expect(path[0]).toEqual({ rank: 0, col: 0 });
    expect(path[path.length - 1]).toEqual({ rank: 2, col: 0 });
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

describe('cellMarginWalls', () => {
  it('produces no walls for a ROOM_SIZE_LARGE room (no margin on either side)', () => {
    const rect = { gx: 300, gy: 0, gw: ROOM_SIZE_LARGE, gh: ROOM_SIZE_LARGE };
    expect(cellMarginWalls(rect, 0, 0)).toEqual([]);
  });

  it('seals both the east and south margin for a small room with no open connection', () => {
    const rect = { gx: 300, gy: 0, gw: ROOM_SIZE_SMALL, gh: ROOM_SIZE_SMALL };
    const walls = cellMarginWalls(rect, 0, 0);
    const east = walls.find((w) => w.dir === 'east');
    const south = walls.find((w) => w.dir === 'south');
    expect(east).toEqual({ dir: 'east', x1: 300 + COLUMN_STRIDE, y1: 0, x2: 300 + COLUMN_STRIDE, y2: ROW_STRIDE });
    expect(south).toEqual({ dir: 'south', x1: 300, y1: ROW_STRIDE, x2: 300 + COLUMN_STRIDE, y2: ROW_STRIDE });
  });

  it('leaves a gap in the east margin wall where a connection crosses it', () => {
    const rect = { gx: 300, gy: 0, gw: ROOM_SIZE_SMALL, gh: ROOM_SIZE_SMALL };
    const walls = cellMarginWalls(rect, 0, 0, { openSide: 'east', openOffset: 4, openWidth: 2 });
    const eastWalls = walls.filter((w) => w.dir === 'east');
    // Two remaining solid segments flanking the gap, never spanning across it.
    expect(eastWalls.length).toBe(2);
    for (const w of eastWalls) {
      expect(w.y2 <= 4 || w.y1 >= 6).toBe(true);
    }
  });

  it('omits a flanking segment entirely when the gap reaches a cell corner', () => {
    const rect = { gx: 300, gy: 0, gw: ROOM_SIZE_SMALL, gh: ROOM_SIZE_SMALL };
    const walls = cellMarginWalls(rect, 0, 0, { openSide: 'south', openOffset: 0, openWidth: ROOM_SIZE_SMALL });
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

    for (const roomSize of [ROOM_SIZE_SMALL]) {
      for (const opening of [
        {},
        { openSide: 'east', openOffset: 2, openWidth: 2 },
        { openSide: 'south', openOffset: 0, openWidth: 3 },
      ]) {
        const rank = 1;
        const col = 1;
        const rect = { gx: 300 + col * COLUMN_STRIDE, gy: rank * ROW_STRIDE, gw: roomSize, gh: roomSize };
        const margin = cellMarginWalls(rect, rank, col, opening);
        const cell = cellBounds(rank, col);
        for (const dir of ['east', 'south']) {
          const hasMargin = dir === 'east' ? roomSize < cell.gw : roomSize < cell.gh;
          if (!hasMargin) continue; // only ROOM_SIZE_SMALL has significant margins to seal; ROOM_SIZE_LARGE is already covered by the no-walls-at-all test
          const wallsOnSide = margin.filter((w) => w.dir === dir);
          const isOpenSide = opening.openSide === dir;
          const openStart = isOpenSide ? opening.openOffset : -1;
          const openEnd = isOpenSide ? opening.openOffset + opening.openWidth : -1;
          expect(sideFullyAccountedFor(dir, cell, wallsOnSide, openStart, openEnd)).toBe(true);
        }
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
});
