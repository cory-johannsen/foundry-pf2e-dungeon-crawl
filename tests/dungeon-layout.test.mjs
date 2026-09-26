import { describe, it, expect } from 'vitest';
import {
  ROOM_SIZE_SMALL, ROOM_SIZE_LARGE, DOOR_WIDTH,
  roomSizeAt, doorOffsetAt, corridorTileVariant,
  computeRanks, computeColumns,
  roomRect, exitFaceForIndex, roomEnclosureWalls, ROW_STRIDE, COLUMN_STRIDE, parentRoomIdsFor, incomingConnectionsFor, northDoorSlots, buildEdgeCorridor,
  cellBounds, findCorridorPath, INITIAL_GX, cellMarginWalls, transitCellCrossing,
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
    const toSlot = northDoorSlots(to, 1)[0];
    const { corridorSegments } = buildEdgeCorridor('alpha', 'a', 'b', from, to, ADJACENT_FROM, ADJACENT_TO, 'south', toSlot, {});
    expect(corridorSegments).toHaveLength(1);
  });

  it('different-column rooms produce an L-shaped (2-segment) corridor', () => {
    const from = roomRect('alpha', 'a', 0, 0);
    const to = roomRect('alpha', 'b', 1, 2);
    const toSlot = northDoorSlots(to, 1)[0];
    const { corridorSegments } = buildEdgeCorridor('alpha', 'a', 'b', from, to, ADJACENT_FROM, ADJACENT_TO, 'south', toSlot, {});
    expect(corridorSegments).toHaveLength(2);
  });

  it('always returns a door wall and a reveal door wall', () => {
    const from = roomRect('alpha', 'a', 0, 0);
    const to = roomRect('alpha', 'b', 1, 1);
    const toSlot = northDoorSlots(to, 1)[0];
    const { doorWall, revealDoorWall } = buildEdgeCorridor('alpha', 'a', 'b', from, to, ADJACENT_FROM, ADJACENT_TO, 'south', toSlot, {});
    expect(doorWall).toBeDefined();
    expect(revealDoorWall).toBeDefined();
  });

  it('two exits from the same room on different faces never share a door offset key', () => {
    const from = roomRect('alpha', 'a', 0, 0);
    const toSouth = roomRect('alpha', 'b', 1, 0);
    const toEast = roomRect('alpha', 'c', 0, 1);
    const south = buildEdgeCorridor('alpha', 'a', 'b', from, toSouth, ADJACENT_FROM, ADJACENT_TO, 'south', northDoorSlots(toSouth, 1)[0], {});
    const east = buildEdgeCorridor('alpha', 'a', 'c', from, toEast, ADJACENT_FROM, ADJACENT_TO, 'east', northDoorSlots(toEast, 1)[0], {});
    expect(south.doorWall).not.toEqual(east.doorWall);
  });

  it('#93 pre-flight fix regression — two different incoming connections to the same merge room land on distinct, non-overlapping door slots', () => {
    const parentA = roomRect('alpha', 'a', 0, 0);
    const parentB = roomRect('alpha', 'b', 0, 1);
    const merge = roomRect('alpha', 'm', 1, 0);
    const slots = northDoorSlots(merge, 2);
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
    const slots = northDoorSlots(merge, 2);
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
    const toSlot = northDoorSlots(to, 1)[0];
    const { revealDoorWall, corridorSegments } = buildEdgeCorridor('alpha', 'a', 'm', from, to, ADJACENT_FROM, ADJACENT_TO, 'south', toSlot, {});
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
      const { revealDoorWall } = buildEdgeCorridor('alpha', from === parentA ? 'a' : 'b', 'm', from, merge, ADJACENT_FROM, ADJACENT_TO, 'south', slots[i], {});
      expect(Math.min(revealDoorWall.x1, revealDoorWall.x2)).toBeGreaterThanOrEqual(slots[i].x1);
      expect(Math.max(revealDoorWall.x1, revealDoorWall.x2)).toBeLessThanOrEqual(slots[i].x2);
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
    const offset = outgoingMarginOffset(seed, 'A', 'B', 'south', fromRect, fromPos, toPos, occupiedCells);
    const toSlot = northDoorSlots(toRect, 1)[0];
    const { doorWall } = buildEdgeCorridor(seed, 'A', 'B', fromRect, toRect, fromPos, toPos, 'south', toSlot, occupiedCells);
    const marginWalls = cellMarginWalls(fromRect, fromPos.rank, fromPos.col, {
      openSide: 'south', openOffset: offset, openWidth: DOOR_WIDTH,
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

  it('aligns an east-face connection regardless of column (buildEdgeCorridor never uses the offset-based branch for east)', () => {
    const fromPos = { rank: 0, col: 0 };
    const toPos = { rank: 0, col: 1 };
    const fromRect = smallRect(fromPos.rank, fromPos.col);
    const toRect = smallRect(toPos.rank, toPos.col);
    const offset = outgoingMarginOffset(seed, 'A', 'B', 'east', fromRect, fromPos, toPos, {});
    const toSlot = northDoorSlots(toRect, 1)[0];
    const { doorWall } = buildEdgeCorridor(seed, 'A', 'B', fromRect, toRect, fromPos, toPos, 'east', toSlot, {});
    const marginWalls = cellMarginWalls(fromRect, fromPos.rank, fromPos.col, {
      openSide: 'east', openOffset: offset, openWidth: DOOR_WIDTH,
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
});

function rectsOverlap(a, b) {
  return a.gx < b.gx + b.gw && a.gx + a.gw > b.gx && a.gy < b.gy + b.gh && a.gy + a.gh > b.gy;
}

describe('corridor routing regression sweep (#174)', () => {
  it('no corridor segment overlaps any room footprint other than its own endpoints, across a large seed/roomCount sweep', () => {
    let totalEdges = 0;
    let overlappingEdges = 0;
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
          const toSlot = northDoorSlots(toRect, 1)[0];
          const result = buildEdgeCorridor(
            seed, fromId, toId, fromRect, toRect,
            positionByRoomId[fromId], positionByRoomId[toId],
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
          if (hasOverlap) overlappingEdges += 1;
        }
      }
    }
    expect(overlappingEdges).toBe(0);
    expect(totalEdges).toBeGreaterThan(1000); // sanity: the sweep actually exercised real branching
  });

  // #174 Task 5's own margin-alignment bug (a room's cell-margin
  // containment wall built directly across the real corridor's own
  // crossing point) took 3 fix rounds to close correctly and had zero
  // regression coverage until Task 5's own fix round added 5 hand-picked
  // unit tests. This sweep provides the same broad, whole-pipeline proof
  // for that bug that the test above provides for room-footprint
  // overlap — real seeds, real branching, not just the handful of cases
  // a person thought to write by hand.
  it('every SMALL room\'s cell-margin gap coincides exactly with buildEdgeCorridor\'s real crossing point, across the same seed/roomCount sweep', () => {
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
          if (fromRect.gw !== ROOM_SIZE_SMALL) continue; // no margin for LARGE rooms — cellMarginWalls' own no-op
          const toRect = rectById[toId];
          const toSlot = northDoorSlots(toRect, 1)[0];
          const { doorWall } = buildEdgeCorridor(
            seed, fromId, toId, fromRect, toRect,
            positionByRoomId[fromId], positionByRoomId[toId],
            face, toSlot, occupiedCells,
          );
          const offset = outgoingMarginOffset(
            seed, fromId, toId, face, fromRect,
            positionByRoomId[fromId], positionByRoomId[toId], occupiedCells,
          );
          const marginWalls = cellMarginWalls(
            fromRect, positionByRoomId[fromId].rank, positionByRoomId[fromId].col,
            { openSide: face, openOffset: offset, openWidth: DOOR_WIDTH },
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
          expect(gap0).toBeCloseTo(door0, 9);
          expect(gap1).toBeCloseTo(door1, 9);
        }
      }
    }
    expect(totalMarginedConnections).toBeGreaterThan(200); // sanity: real SMALL-room south/east connections were exercised
  });
});
