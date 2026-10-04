import { describe, it, expect } from 'vitest';
import { overlaps, footprint, freeSpot, freeSpotInRect } from '../scripts/placement.mjs';
import { splitmix32, seedFromString } from '../scripts/prng.mjs';

describe('overlaps', () => {
  it('detects overlapping footprints', () => {
    expect(overlaps({ gx: 0, gy: 0, gw: 2, gh: 2 }, { gx: 1, gy: 1, gw: 2, gh: 2 })).toBe(true);
  });

  it('detects non-overlapping footprints', () => {
    expect(overlaps({ gx: 0, gy: 0, gw: 1, gh: 1 }, { gx: 5, gy: 5, gw: 1, gh: 1 })).toBe(false);
  });
});

describe('footprint', () => {
  it('converts pixel position and size to grid squares', () => {
    expect(footprint({ x: 200, y: 300, width: 2, height: 1 }, 100)).toEqual({ gx: 2, gy: 3, gw: 2, gh: 1 });
  });
});

describe('freeSpot', () => {
  it('returns the origin ring when nothing is occupied', () => {
    const spot = freeSpot({ occupied: [], gx: 5, gy: 5 });
    expect(spot).not.toBeNull();
  });

  it('returns null when the search radius is exhausted by occupation', () => {
    const occupied = [];
    for (let dx = -1; dx <= 1; dx += 1) {
      for (let dy = -1; dy <= 1; dy += 1) occupied.push({ gx: 5 + dx, gy: 5 + dy, gw: 1, gh: 1 });
    }
    expect(freeSpot({ occupied, gx: 5, gy: 5, maxRing: 1 })).toBeNull();
  });
});

describe('freeSpotInRect', () => {
  const rect = { gx: 0, gy: 0, gw: 6, gh: 6 };

  it('places at the rect center when empty', () => {
    const spot = freeSpotInRect({ rect });
    expect(spot).toEqual({ gx: 3, gy: 3, gw: 1, gh: 1 });
  });

  it('never returns a spot outside the rect bounds', () => {
    // Occupy everything except the corners, forcing the search outward.
    const occupied = [{ gx: 1, gy: 1, gw: 4, gh: 4 }];
    const spot = freeSpotInRect({ occupied, rect, gw: 1, gh: 1 });
    expect(spot).not.toBeNull();
    expect(spot.gx).toBeGreaterThanOrEqual(rect.gx);
    expect(spot.gy).toBeGreaterThanOrEqual(rect.gy);
    expect(spot.gx + spot.gw).toBeLessThanOrEqual(rect.gx + rect.gw);
    expect(spot.gy + spot.gh).toBeLessThanOrEqual(rect.gy + rect.gh);
  });

  it('returns null when a creature does not fit anywhere in the rect at all', () => {
    // An 8x8 creature can never fit inside a 6x6 room.
    expect(freeSpotInRect({ rect, gw: 8, gh: 8 })).toBeNull();
  });

  it('returns null when the whole rect is already occupied', () => {
    const occupied = [{ gx: 0, gy: 0, gw: 6, gh: 6 }];
    expect(freeSpotInRect({ occupied, rect, gw: 1, gh: 1 })).toBeNull();
  });
});

describe('freeSpot property tests', () => {
  it('property: a returned spot never overlaps any occupied footprint, and keeps the requested size', () => {
    let foundAtLeastOneSpot = false;
    for (let trial = 0; trial < 300; trial += 1) {
      const rand = splitmix32(seedFromString(`freeSpot-${trial}`));
      const gx = Math.floor(rand() * 20) - 10;
      const gy = Math.floor(rand() * 20) - 10;
      const gw = 1 + Math.floor(rand() * 2);
      const gh = 1 + Math.floor(rand() * 2);
      // Occupants scattered near (gx, gy), sparse enough that most trials
      // still find a free spot -- the common case this test needs to
      // actually exercise.
      const occupied = Array.from({ length: Math.floor(rand() * 6) }, () => ({
        gx: gx + Math.floor(rand() * 7) - 3,
        gy: gy + Math.floor(rand() * 7) - 3,
        gw: 1 + Math.floor(rand() * 2),
        gh: 1 + Math.floor(rand() * 2),
      }));

      const spot = freeSpot({ occupied, gx, gy, gw, gh, maxRing: 8 });
      if (!spot) continue; // search-exhausted is a valid outcome

      foundAtLeastOneSpot = true;
      expect(spot.gw).toBe(gw);
      expect(spot.gh).toBe(gh);
      for (const occ of occupied) {
        expect(overlaps(spot, occ)).toBe(false);
      }
    }
    expect(foundAtLeastOneSpot).toBe(true);
  });
});

describe('freeSpotInRect property tests', () => {
  it('property: a returned spot never overlaps an occupied footprint and always stays fully within the rect', () => {
    let foundAtLeastOneSpot = false;
    for (let trial = 0; trial < 300; trial += 1) {
      const rand = splitmix32(seedFromString(`freeSpotInRect-${trial}`));
      const rect = {
        gx: Math.floor(rand() * 10),
        gy: Math.floor(rand() * 10),
        gw: 3 + Math.floor(rand() * 8),
        gh: 3 + Math.floor(rand() * 8),
      };
      const gw = 1 + Math.floor(rand() * 2);
      const gh = 1 + Math.floor(rand() * 2);
      const occupied = Array.from({ length: Math.floor(rand() * 5) }, () => ({
        gx: rect.gx + Math.floor(rand() * rect.gw),
        gy: rect.gy + Math.floor(rand() * rect.gh),
        gw: 1,
        gh: 1,
      }));

      const spot = freeSpotInRect({ occupied, rect, gw, gh });
      if (!spot) continue;

      foundAtLeastOneSpot = true;
      expect(spot.gx).toBeGreaterThanOrEqual(rect.gx);
      expect(spot.gy).toBeGreaterThanOrEqual(rect.gy);
      expect(spot.gx + gw).toBeLessThanOrEqual(rect.gx + rect.gw);
      expect(spot.gy + gh).toBeLessThanOrEqual(rect.gy + rect.gh);
      for (const occ of occupied) {
        expect(overlaps(spot, occ)).toBe(false);
      }
    }
    expect(foundAtLeastOneSpot).toBe(true);
  });
});
