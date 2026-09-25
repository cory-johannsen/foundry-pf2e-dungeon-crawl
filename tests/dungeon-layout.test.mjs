import { describe, it, expect } from 'vitest';
import {
  ROOM_SIZE_SMALL, ROOM_SIZE_LARGE, ROOMS_PER_ROW, CORRIDOR_LEN, DOOR_WIDTH,
  roomSizeAt, buildConnectionGeometry, doorOffsetAt, corridorTileVariant,
  computeRanks, computeColumns,
  roomRect, exitFaceForIndex, roomEnclosureWalls, ROW_STRIDE, COLUMN_STRIDE, parentRoomIdsFor, incomingConnectionsFor, northDoorSlots, buildEdgeCorridor,
  slotRowCol, slotRect, connectionDirection
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

describe('buildConnectionGeometry', () => {
  it('places an east-facing door on the room\'s east edge', () => {
    const { doorWall } = buildConnectionGeometry(0, SEED);
    const rect = slotRect(SEED, 0);
    expect(doorWall.x1).toBe(rect.gx + rect.gw);
    expect(doorWall.x2).toBe(rect.gx + rect.gw);
  });

  it('places a south-facing door for a row-wrap connection', () => {
    const wrapSlot = ROOMS_PER_ROW - 1;
    const { doorWall } = buildConnectionGeometry(wrapSlot, SEED);
    const rect = slotRect(SEED, wrapSlot);
    expect(doorWall.y1).toBe(rect.gy + rect.gh);
    expect(doorWall.y2).toBe(rect.gy + rect.gh);
  });

  it('always lands every wall segment on integer grid coordinates', () => {
    for (let slot = 0; slot < 2 * ROOMS_PER_ROW; slot += 1) {
      const { doorWall, plainWalls, corridorRect } = buildConnectionGeometry(slot, SEED);
      const { revealDoorWall } = buildConnectionGeometry(slot, SEED);
      const coords = [doorWall.x1, doorWall.y1, doorWall.x2, doorWall.y2,
                       revealDoorWall.x1, revealDoorWall.y1, revealDoorWall.x2, revealDoorWall.y2,
                       corridorRect.gx, corridorRect.gy, corridorRect.gw, corridorRect.gh,
                       ...plainWalls.flatMap((w) => [w.x1, w.y1, w.x2, w.y2])];
      for (const v of coords) expect(Number.isInteger(v)).toBe(true);
    }
  });

  it('gives slot + 1 its own reveal door, on its own face, at its own (incoming) offset', () => {
    const rect = slotRect(SEED, 0); // slot 0 -> east, slot 1 receives it on its west face
    const nextRect = slotRect(SEED, 1);
    const { revealDoorWall } = buildConnectionGeometry(0, SEED);
    // On slot 1's own west face, not slot 0's east face.
    expect(revealDoorWall.x1).toBe(nextRect.gx);
    expect(revealDoorWall.x2).toBe(nextRect.gx);
    expect(revealDoorWall.x1).not.toBe(rect.gx + rect.gw);
    // Width DOOR_WIDTH, fully within the room's face.
    expect(Math.abs(revealDoorWall.y2 - revealDoorWall.y1)).toBe(DOOR_WIDTH);
    expect(Math.min(revealDoorWall.y1, revealDoorWall.y2)).toBeGreaterThanOrEqual(nextRect.gy);
    expect(Math.max(revealDoorWall.y1, revealDoorWall.y2)).toBeLessThanOrEqual(nextRect.gy + nextRect.gh);
  });

  it('the reveal door and the outgoing door can land at different offsets (ITEM-9\'s whole point)', () => {
    let sawMisalignment = false;
    for (let slot = 0; slot < 15; slot += 1) {
      const { doorWall, revealDoorWall } = buildConnectionGeometry(slot, SEED);
      const doorPos = Math.min(doorWall.y1, doorWall.y2) + Math.min(doorWall.x1, doorWall.x2);
      const revealPos = Math.min(revealDoorWall.y1, revealDoorWall.y2) + Math.min(revealDoorWall.x1, revealDoorWall.x2);
      if (doorPos !== revealPos) { sawMisalignment = true; break; }
    }
    expect(sawMisalignment).toBe(true);
  });

  it('keeps the door fully within the room\'s own face, never spilling past a corner', () => {
    const rect = slotRect(SEED, 0); // slot 0 -> east
    const { doorWall } = buildConnectionGeometry(0, SEED);
    expect(Math.min(doorWall.y1, doorWall.y2)).toBeGreaterThanOrEqual(rect.gy);
    expect(Math.max(doorWall.y1, doorWall.y2)).toBeLessThanOrEqual(rect.gy + rect.gh);

    const wrapSlot = ROOMS_PER_ROW - 1;
    const wrapRect = slotRect(SEED, wrapSlot); // -> south
    const { doorWall: wrapDoor } = buildConnectionGeometry(wrapSlot, SEED);
    expect(Math.min(wrapDoor.x1, wrapDoor.x2)).toBeGreaterThanOrEqual(wrapRect.gx);
    expect(Math.max(wrapDoor.x1, wrapDoor.x2)).toBeLessThanOrEqual(wrapRect.gx + wrapRect.gw);
  });

  it('extends the corridor beyond the door by CORRIDOR_LEN', () => {
    const { plainWalls } = buildConnectionGeometry(0, SEED);
    const rect = slotRect(SEED, 0);
    const closureXs = plainWalls.map((w) => Math.max(w.x1, w.x2));
    expect(Math.max(...closureXs)).toBe(rect.gx + rect.gw + CORRIDOR_LEN);
  });

  it('gives an east/west connection a corridorRect exactly as tall as the door-to-door span (ITEM-13), even across different-sized rooms', () => {
    for (let slot = 0; slot < ROOMS_PER_ROW - 1; slot += 1) {
      const a = slotRect(SEED, slot);
      const b = slotRect(SEED, slot + 1);
      const outgoing = doorOffsetAt(SEED, slot, 'outgoing', a.gw);
      const incoming = doorOffsetAt(SEED, slot + 1, 'incoming', b.gw);
      const doorY0 = a.gy + outgoing;
      const doorY1 = doorY0 + DOOR_WIDTH;
      const gapY0 = b.gy + incoming;
      const gapY1 = gapY0 + DOOR_WIDTH;
      const expectedSpan = Math.max(doorY1, gapY1) - Math.min(doorY0, gapY0);
      const { corridorRect } = buildConnectionGeometry(slot, SEED);
      expect(corridorRect.gw).toBe(CORRIDOR_LEN);
      expect(corridorRect.gh).toBe(expectedSpan);
    }
  });

  it('gives a south (row-wrap) connection a corridorRect exactly as wide as the door-to-door span (ITEM-13)', () => {
    const wrapSlot = ROOMS_PER_ROW - 1;
    const a = slotRect(SEED, wrapSlot);
    const b = slotRect(SEED, wrapSlot + 1);
    const outgoing = doorOffsetAt(SEED, wrapSlot, 'outgoing', a.gw);
    const incoming = doorOffsetAt(SEED, wrapSlot + 1, 'incoming', b.gw);
    const doorX0 = a.gx + outgoing;
    const doorX1 = doorX0 + DOOR_WIDTH;
    const gapX0 = b.gx + incoming;
    const gapX1 = gapX0 + DOOR_WIDTH;
    const expectedSpan = Math.max(doorX1, gapX1) - Math.min(doorX0, gapX0);
    const { corridorRect } = buildConnectionGeometry(wrapSlot, SEED);
    expect(corridorRect.gh).toBe(CORRIDOR_LEN);
    expect(corridorRect.gw).toBe(expectedSpan);
  });

  it('tracks the offsets: closely-offset doors give a short corridor, far-apart doors give a long one (ITEM-13)', () => {
    const sizes = new Set();
    for (const seed of ['seed-a', 'seed-b', 'seed-c', 'seed-d', 'seed-e']) {
      const { corridorRect } = buildConnectionGeometry(0, seed);
      expect(corridorRect.gh).toBeGreaterThanOrEqual(DOOR_WIDTH);
      expect(corridorRect.gh).toBeLessThanOrEqual(ROOM_SIZE_LARGE);
      sizes.add(corridorRect.gh);
    }
    expect(sizes.size).toBeGreaterThan(1);
  });

  it('always keeps corridorRect flush against the outgoing room, within the combined span of both rooms\' faces', () => {
    const a = slotRect(SEED, 0);
    const b = slotRect(SEED, 1);
    const { corridorRect } = buildConnectionGeometry(0, SEED); // slot 0 -> east
    expect(corridorRect.gx).toBe(a.gx + a.gw);
    expect(corridorRect.gy).toBeGreaterThanOrEqual(Math.min(a.gy, b.gy));
    expect(corridorRect.gy + corridorRect.gh).toBeLessThanOrEqual(Math.max(a.gy + a.gh, b.gy + b.gh));
  });

  it('never produces a door and a plain wall at the same coordinates', () => {
    const sameSeg = (a, b) => a.x1 === b.x1 && a.y1 === b.y1 && a.x2 === b.x2 && a.y2 === b.y2;
    for (const slot of [0, 1, ROOMS_PER_ROW - 1, ROOMS_PER_ROW]) {
      const { doorWall, revealDoorWall, plainWalls } = buildConnectionGeometry(slot, SEED);
      for (const w of plainWalls) {
        expect(sameSeg(w, doorWall)).toBe(false);
        expect(sameSeg(w, revealDoorWall)).toBe(false);
      }
      expect(sameSeg(doorWall, revealDoorWall)).toBe(false);
    }
  });

  it('drops a degenerate (zero-length) flanking segment when an offset lands at the extreme edge', () => {
    // Find a seed where at least one offset for slot 0 lands at 0 or its own
    // room's max, which would otherwise produce a zero-length plainWalls segment.
    let found = false;
    for (let i = 0; i < 50 && !found; i += 1) {
      const seed = `edge-search-${i}`;
      const a = slotRect(seed, 0);
      const b = slotRect(seed, 1);
      const outgoing = doorOffsetAt(seed, 0, 'outgoing', a.gw);
      const incoming = doorOffsetAt(seed, 1, 'incoming', b.gw);
      if (outgoing === 0 || outgoing === a.gw - DOOR_WIDTH
        || incoming === 0 || incoming === b.gw - DOOR_WIDTH) {
        const { plainWalls } = buildConnectionGeometry(0, seed);
        for (const w of plainWalls) expect(w.x1 !== w.x2 || w.y1 !== w.y2).toBe(true);
        found = true;
      }
    }
    expect(found).toBe(true); // the search itself should actually hit an edge case
  });

  it('produces different door positions for different seeds (not always centered)', () => {
    const positions = new Set();
    for (const seed of ['seed-a', 'seed-b', 'seed-c', 'seed-d', 'seed-e']) {
      const { doorWall } = buildConnectionGeometry(0, seed);
      positions.add(doorWall.y1);
    }
    expect(positions.size).toBeGreaterThan(1);
  });

  it('builds each room\'s own wall segments from that room\'s own rect when the two rooms differ in size, reaching at least that room\'s own full height', () => {
    // Find a seed where an east/west-connected pair actually differs in
    // size, then confirm each side's flanking wall reaches AT LEAST that
    // side's own full height, not the other room's. "At least," not
    // "exactly" (#34): when the trimmed span (spanY1) extends past a room's
    // own edge — which this same search's first hit already does — that
    // room's own flanking segment must extend to match the span, not stop
    // short at its own edge (see the dedicated #34 regression test below for
    // that gap itself).
    let checked = false;
    for (let i = 0; i < 100 && !checked; i += 1) {
      const seed = `size-diff-${i}`;
      for (let slot = 0; slot < ROOMS_PER_ROW - 1; slot += 1) {
        const a = slotRect(seed, slot);
        const b = slotRect(seed, slot + 1);
        if (a.gh === b.gh) continue;
        const { plainWalls } = buildConnectionGeometry(slot, seed);
        const aFaceX = a.gx + a.gw;
        const bFaceX = aFaceX + CORRIDOR_LEN;
        const aSegYs = plainWalls.filter((w) => w.x1 === aFaceX && w.x2 === aFaceX).flatMap((w) => [w.y1, w.y2]);
        const bSegYs = plainWalls.filter((w) => w.x1 === bFaceX && w.x2 === bFaceX).flatMap((w) => [w.y1, w.y2]);
        expect(Math.max(...aSegYs)).toBeGreaterThanOrEqual(a.gy + a.gh);
        expect(Math.max(...bSegYs)).toBeGreaterThanOrEqual(b.gy + b.gh);
        checked = true;
        break;
      }
    }
    expect(checked).toBe(true); // the search itself should hit a differently-sized pair
  });

  it('closes the corridor\'s own face wall out to the full trimmed span, not just the acting room\'s own edge, for a south (row-wrap) connection between differently-sized rooms (#34)', () => {
    // slot 4 (row 0's last room, small, 6x6) -> slot 5 (row 1's first room,
    // large, 12x12) -- a south/row-wrap connection. With this seed, slot 5's
    // own incoming offset pushes the corridor's trimmed span (spanX1) past
    // slot 4's own east edge -- live-confirmed (a real Foundry
    // ClockwiseSweepPolygon computed from inside this exact corridor) that
    // before this fix, the corridor's own face wall was unwalled for the gap
    // between slot 4's own edge and spanX1, leaking sight straight through to
    // the edge of the scene's pre-sized canvas (#34).
    const seed = 'live-repro-seed';
    const slot = 4;
    const a = slotRect(seed, slot);
    const b = slotRect(seed, slot + 1);
    expect(a.gw).not.toBe(b.gw); // sanity: this seed really does connect two differently-sized rooms

    const outgoing = doorOffsetAt(seed, slot, 'outgoing', a.gw);
    const incoming = doorOffsetAt(seed, slot + 1, 'incoming', b.gw);
    const faceY = a.gy + a.gh;
    const doorX1 = a.gx + outgoing + DOOR_WIDTH;
    const gapX1 = b.gx + incoming + DOOR_WIDTH;
    const spanX1 = Math.max(doorX1, gapX1);
    // Sanity: this seed/slot really does hit the bug's precondition -- the
    // trimmed span extends past room A's own edge, not just up to it.
    expect(spanX1).toBeGreaterThan(a.gx + a.gw);

    const { plainWalls } = buildConnectionGeometry(slot, seed);
    // Room A's own "after door" flanking segment (along y = faceY, starting
    // at doorX1) must close the gap out to the full span, not just its own
    // room edge -- otherwise the strip between the room's own edge and the
    // span is left completely unwalled.
    const aAfterDoor = plainWalls.find((w) => w.y1 === faceY && w.y2 === faceY && w.x1 === doorX1);
    expect(aAfterDoor).toBeDefined();
    expect(aAfterDoor.x2).toBeGreaterThanOrEqual(spanX1);
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
});
