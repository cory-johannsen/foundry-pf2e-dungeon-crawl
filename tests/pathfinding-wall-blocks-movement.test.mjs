import { describe, it, expect, beforeEach } from "vitest";
import { wallBlocksMovement } from "../scripts/pathfinding.mjs";

describe("#884 wallBlocksMovement (shared by dungeon-combat.mjs, dungeon-follow.mjs, trap-combat.mjs)", () => {
  beforeEach(() => {
    globalThis.CONST = {
      WALL_MOVEMENT_TYPES: { NONE: 0, NORMAL: 20 },
      WALL_DOOR_TYPES: { NONE: 0, DOOR: 1, SECRET: 2 },
      WALL_DOOR_STATES: { CLOSED: 0, OPEN: 1, LOCKED: 2 },
    };
  });

  it("blocks a normal wall", () => {
    expect(wallBlocksMovement({ move: 20, door: 0, ds: 0 })).toBe(true);
  });
  it("does not block a wall with no movement sense", () => {
    expect(wallBlocksMovement({ move: 0, door: 0, ds: 0 })).toBe(false);
  });
  it("does not block an open door", () => {
    expect(wallBlocksMovement({ move: 20, door: 1, ds: 1 })).toBe(false);
  });
  it("blocks a closed or locked door", () => {
    expect(wallBlocksMovement({ move: 20, door: 1, ds: 0 })).toBe(true);
    expect(wallBlocksMovement({ move: 20, door: 1, ds: 2 })).toBe(true);
  });
});
