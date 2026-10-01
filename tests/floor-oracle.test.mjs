import { describe, it, expect } from 'vitest';
import { buildFloorModel } from './helpers/floor-oracle.mjs';

describe('floor oracle', () => {
  const floors = [{ gx: 0, gy: 0, gw: 3, gh: 1 }];
  it('reaches along an open strip', () => {
    expect([...buildFloorModel(floors, []).reach('0,0')].sort()).toEqual(['0,0', '1,0', '2,0']);
  });
  it('a wall on a shared unit edge splits the strip', () => {
    const walls = [{ x1: 1, y1: 0, x2: 1, y2: 1 }];
    expect([...buildFloorModel(floors, walls).reach('0,0')]).toEqual(['0,0']);
  });
  it('a wall along the strip edge does not block it', () => {
    const walls = [{ x1: 0, y1: 0, x2: 3, y2: 0 }];
    expect(buildFloorModel(floors, walls).reach('0,0').size).toBe(3);
  });
});
