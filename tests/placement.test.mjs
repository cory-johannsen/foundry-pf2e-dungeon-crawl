import { describe, it, expect } from 'vitest';
import { overlaps, footprint, freeSpot, freeSpotInRect } from '../scripts/placement.mjs';

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
