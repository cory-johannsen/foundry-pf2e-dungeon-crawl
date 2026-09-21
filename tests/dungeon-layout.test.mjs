import { describe, it, expect } from 'vitest';
import {
  ROOM_SIZE_SMALL, ROOM_SIZE_LARGE, ROOMS_PER_ROW, CORRIDOR_LEN, DOOR_WIDTH,
  slotRowCol, slotRect, connectionDirection, roomEnclosureWalls,
  buildConnectionGeometry, doorOffsetAt, corridorTileVariant, outgoingFaceWall, roomSizeAt
} from '../scripts/dungeon-layout.mjs';

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

describe('slotRowCol / slotRect', () => {
  it('lays out a row west-to-east on even rows', () => {
    expect(slotRowCol(0)).toEqual({ row: 0, col: 0 });
    expect(slotRowCol(1)).toEqual({ row: 0, col: 1 });
    expect(slotRowCol(ROOMS_PER_ROW - 1)).toEqual({ row: 0, col: ROOMS_PER_ROW - 1 });
  });

  it('lays out the next row east-to-west (boustrophedon)', () => {
    expect(slotRowCol(ROOMS_PER_ROW)).toEqual({ row: 1, col: ROOMS_PER_ROW - 1 });
    expect(slotRowCol(ROOMS_PER_ROW + 1)).toEqual({ row: 1, col: ROOMS_PER_ROW - 2 });
    expect(slotRowCol(2 * ROOMS_PER_ROW - 1)).toEqual({ row: 1, col: 0 });
  });

  it('every room is square, sized ROOM_SIZE_SMALL or ROOM_SIZE_LARGE (ITEM-17)', () => {
    for (const slot of [0, 3, 7, 12]) {
      const r = slotRect(SEED, slot);
      expect(r.gw).toBe(r.gh);
      expect([ROOM_SIZE_SMALL, ROOM_SIZE_LARGE]).toContain(r.gw);
    }
  });

  it('a room\'s rect size always matches roomSizeAt for that same slot', () => {
    for (let slot = 0; slot < 15; slot += 1) {
      const r = slotRect(SEED, slot);
      const expected = roomSizeAt(SEED, slot);
      expect(r.gw).toBe(expected);
      expect(r.gh).toBe(expected);
    }
  });

  it('aligns a row wrap in the same column on both sides, regardless of either room\'s size', () => {
    // The last room of row 0 and the first room of row 1 must share gx, so
    // the wrap connector is a straight vertical corridor, never a jog — even
    // though (ITEM-17) the two rooms can now be different sizes.
    for (const seed of ['seed-a', 'seed-b', 'seed-c', 'seed-d', 'seed-e']) {
      const lastOfRow0 = slotRect(seed, ROOMS_PER_ROW - 1);
      const firstOfRow1 = slotRect(seed, ROOMS_PER_ROW);
      expect(firstOfRow1.gx).toBe(lastOfRow0.gx);

      const lastOfRow1 = slotRect(seed, 2 * ROOMS_PER_ROW - 1);
      const firstOfRow2 = slotRect(seed, 2 * ROOMS_PER_ROW);
      expect(firstOfRow2.gx).toBe(lastOfRow1.gx);
    }
  });

  it('keeps every room in the same row top-aligned (shared gy), even when sizes differ', () => {
    for (const seed of ['seed-a', 'seed-b', 'seed-c']) {
      for (let row = 0; row < 2; row += 1) {
        const gys = [];
        for (let col = 0; col < ROOMS_PER_ROW; col += 1) {
          const slot = row * ROOMS_PER_ROW + col;
          gys.push(slotRect(seed, slot).gy);
        }
        expect(new Set(gys).size).toBe(1);
      }
    }
  });

  it('never produces a negative gx across many seeds and a generous slot range (confirmed live: this broke once before INITIAL_GX)', () => {
    for (let n = 0; n < 200; n += 1) {
      const seed = `neg-check-${n}`;
      for (let slot = 0; slot < 24; slot += 1) {
        expect(slotRect(seed, slot).gx).toBeGreaterThanOrEqual(0);
        expect(slotRect(seed, slot).gy).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it('advances gx by the departing room\'s own width on an east step', () => {
    // slot 0 -> slot 1 is always 'east' (row 0, not the last column).
    const a = slotRect(SEED, 0);
    const b = slotRect(SEED, 1);
    expect(b.gx).toBe(a.gx + a.gw + CORRIDOR_LEN);
    expect(b.gy).toBe(a.gy);
  });

  it('advances gy by the departing room\'s own height on a south step, leaving gx untouched', () => {
    const wrapSlot = ROOMS_PER_ROW - 1;
    const a = slotRect(SEED, wrapSlot);
    const b = slotRect(SEED, wrapSlot + 1);
    expect(b.gx).toBe(a.gx);
    expect(b.gy).toBe(a.gy + a.gh + CORRIDOR_LEN);
  });
});

describe('connectionDirection', () => {
  it('goes east across an even row, except the last room in the row', () => {
    for (let i = 0; i < ROOMS_PER_ROW - 1; i += 1) expect(connectionDirection(i)).toBe('east');
    expect(connectionDirection(ROOMS_PER_ROW - 1)).toBe('south');
  });

  it('goes west across an odd row, except the last room in the row', () => {
    for (let i = ROOMS_PER_ROW; i < 2 * ROOMS_PER_ROW - 1; i += 1) {
      expect(connectionDirection(i)).toBe('west');
    }
    expect(connectionDirection(2 * ROOMS_PER_ROW - 1)).toBe('south');
  });
});

describe('roomEnclosureWalls', () => {
  it('slot 0 has all four sides walled when it has an outgoing connection', () => {
    const walls = roomEnclosureWalls(SEED, 0, { hasOutgoing: true });
    // hasOutgoing excludes the outgoing side; slot 0 has no incoming side to exclude.
    expect(walls).toHaveLength(3);
    expect(walls.map((w) => w.dir).sort()).toEqual(['north', 'south', 'west'].sort());
  });

  it('an interior slot excludes both its incoming and outgoing sides', () => {
    // Slot 1 (row 0): incoming from slot 0 is 'east' arriving, so slot 1's
    // incoming side is 'west'; outgoing to slot 2 is 'east'.
    const walls = roomEnclosureWalls(SEED, 1, { hasOutgoing: true });
    const dirs = walls.map((w) => w.dir);
    expect(dirs).not.toContain('west');
    expect(dirs).not.toContain('east');
    expect(dirs.sort()).toEqual(['north', 'south']);
  });

  it('the final (goal) slot has no outgoing exclusion', () => {
    const lastOfRow0 = ROOMS_PER_ROW - 1;
    const walls = roomEnclosureWalls(SEED, lastOfRow0, { hasOutgoing: false });
    // Incoming side is 'west' (arriving eastward across the row).
    const dirs = walls.map((w) => w.dir);
    expect(dirs).not.toContain('west');
    expect(dirs.sort()).toEqual(['east', 'north', 'south'].sort());
  });

  it('walls always match that slot\'s own actual size, not a fixed constant', () => {
    for (const slot of [0, 2, 6, 8]) {
      const rect = slotRect(SEED, slot);
      const walls = roomEnclosureWalls(SEED, slot, { hasOutgoing: true });
      for (const w of walls) {
        const dx = Math.abs(w.x2 - w.x1);
        const dy = Math.abs(w.y2 - w.y1);
        expect(Math.max(dx, dy)).toBe(rect.gw);
      }
    }
  });
});

describe('outgoingFaceWall', () => {
  it('is the full, unsplit segment on the outgoing side — exactly what roomEnclosureWalls excludes there', () => {
    for (const slot of [0, 1, 2, ROOMS_PER_ROW - 1, ROOMS_PER_ROW]) {
      const dir = connectionDirection(slot);
      const withOutgoing = roomEnclosureWalls(SEED, slot, { hasOutgoing: true });
      const withoutOutgoing = roomEnclosureWalls(SEED, slot, { hasOutgoing: false });
      const missing = withoutOutgoing.find((w) => w.dir === dir && !withOutgoing.some((v) => v.dir === dir));
      expect(missing).toBeDefined();
      const wall = outgoingFaceWall(SEED, slot);
      expect(wall).toEqual(missing);
    }
  });

  it('spans the room\'s full face, not a trimmed door-width segment', () => {
    const rect = slotRect(SEED, 0); // slot 0 -> east
    const wall = outgoingFaceWall(SEED, 0);
    expect(wall.dir).toBe('east');
    expect(wall.x1).toBe(rect.gx + rect.gw);
    expect(wall.x2).toBe(rect.gx + rect.gw);
    expect(Math.min(wall.y1, wall.y2)).toBe(rect.gy);
    expect(Math.max(wall.y1, wall.y2)).toBe(rect.gy + rect.gh);
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

  it('builds each room\'s own wall segments from that room\'s own rect when the two rooms differ in size', () => {
    // Find a seed where an east/west-connected pair actually differs in
    // size, then confirm each side's flanking wall reaches that side's own
    // full height, not the other room's.
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
        expect(Math.max(...aSegYs)).toBe(a.gy + a.gh);
        expect(Math.max(...bSegYs)).toBe(b.gy + b.gh);
        checked = true;
        break;
      }
    }
    expect(checked).toBe(true); // the search itself should hit a differently-sized pair
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
