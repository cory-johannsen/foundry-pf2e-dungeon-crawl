import { describe, it, expect, beforeEach } from "vitest";
import { hasLineOfSight } from "../scripts/dungeon-combat.mjs";

// #91: ranged Strikes/spells could target and hit actors with no line of
// sight, including targets in an entirely different room separated by a
// solid wall, because eligibility was computed from grid distance alone.
// These tests exercise the real Foundry-glue `hasLineOfSight` against real
// wall documents, the same `{move, door, ds, c}` shape
// `dungeon-combat-grid-snap.test.mjs` already uses for movement-blocking
// wall fixtures.

const GRID_SIZE = 100;

function makeToken({ gx, gy }) {
  return { x: gx * GRID_SIZE, y: gy * GRID_SIZE };
}

function makeCombat({ walls = [] } = {}) {
  return {
    scene: {
      grid: { size: GRID_SIZE, distance: 5 },
      walls: { contents: walls },
    },
  };
}

// A vertical wall segment at pixel x, spanning grid rows [gyLo, gyHi)
// (exclusive of its own end row) -- blocks east/west movement across that
// column boundary for the rows it spans.
function verticalWall(gx, gyLo, gyHi, extra = {}) {
  return {
    move: 20,
    door: 0,
    ds: 0,
    c: [gx * GRID_SIZE, gyLo * GRID_SIZE, gx * GRID_SIZE, gyHi * GRID_SIZE],
    ...extra,
  };
}

// A horizontal wall segment at pixel y, spanning grid columns [gxLo, gxHi).
function horizontalWall(gy, gxLo, gxHi, extra = {}) {
  return {
    move: 20,
    door: 0,
    ds: 0,
    c: [gxLo * GRID_SIZE, gy * GRID_SIZE, gxHi * GRID_SIZE, gy * GRID_SIZE],
    ...extra,
  };
}

beforeEach(() => {
  globalThis.CONST = {
    WALL_MOVEMENT_TYPES: { NONE: 0, NORMAL: 20 },
    WALL_DOOR_TYPES: { NONE: 0, DOOR: 1, SECRET: 2 },
    WALL_DOOR_STATES: { CLOSED: 0, OPEN: 1, LOCKED: 2 },
  };
});

describe("hasLineOfSight (#91)", () => {
  it("is true for same-room adjacent targets with no wall between them", () => {
    const combat = makeCombat();
    const attacker = makeToken({ gx: 0, gy: 0 });
    const target = makeToken({ gx: 1, gy: 0 });
    expect(hasLineOfSight(combat, attacker, target)).toBe(true);
  });

  it("is true for a same-room target several squares away with no wall between them", () => {
    const combat = makeCombat();
    const attacker = makeToken({ gx: 0, gy: 0 });
    const target = makeToken({ gx: 5, gy: 0 });
    expect(hasLineOfSight(combat, attacker, target)).toBe(true);
  });

  it("is false for a target through a solid wall with no door, even in the same straight line", () => {
    const combat = makeCombat({ walls: [verticalWall(2, 0, 1)] });
    const attacker = makeToken({ gx: 0, gy: 0 });
    const target = makeToken({ gx: 4, gy: 0 });
    expect(hasLineOfSight(combat, attacker, target)).toBe(false);
  });

  it("is false for a target in an entirely different room separated by a wall", () => {
    // A vertical wall spanning several rows, dividing two rooms.
    const combat = makeCombat({ walls: [verticalWall(3, -2, 5)] });
    const attacker = makeToken({ gx: 0, gy: 1 });
    const target = makeToken({ gx: 6, gy: 1 });
    expect(hasLineOfSight(combat, attacker, target)).toBe(false);
  });

  it("is false through a closed door", () => {
    const combat = makeCombat({
      walls: [
        verticalWall(2, 0, 1, {
          door: 1,
          ds: 0, // CLOSED
        }),
      ],
    });
    const attacker = makeToken({ gx: 0, gy: 0 });
    const target = makeToken({ gx: 4, gy: 0 });
    expect(hasLineOfSight(combat, attacker, target)).toBe(false);
  });

  it("is false through a locked door", () => {
    const combat = makeCombat({
      walls: [
        verticalWall(2, 0, 1, {
          door: 1,
          ds: 2, // LOCKED
        }),
      ],
    });
    const attacker = makeToken({ gx: 0, gy: 0 });
    const target = makeToken({ gx: 4, gy: 0 });
    expect(hasLineOfSight(combat, attacker, target)).toBe(false);
  });

  it("is true through an open door, matching movementBlockedEdges' own open-door treatment", () => {
    const combat = makeCombat({
      walls: [
        verticalWall(2, 0, 1, {
          door: 1,
          ds: 1, // OPEN
        }),
      ],
    });
    const attacker = makeToken({ gx: 0, gy: 0 });
    const target = makeToken({ gx: 4, gy: 0 });
    expect(hasLineOfSight(combat, attacker, target)).toBe(true);
  });

  it("is true through an open reveal door (dungeonRevealDoorForSlot), same as any other open door", () => {
    // wallBlocksMovement only ever consults the native door/ds fields, never
    // this module's own dungeonRevealDoorForSlot/dungeonDoorToSlot flags --
    // hasLineOfSight must match that, not invent new door semantics.
    const wall = verticalWall(2, 0, 1, { door: 1, ds: 1 });
    wall.getFlag = () => 3; // a module flag present, but irrelevant to blocking
    const combat = makeCombat({ walls: [wall] });
    const attacker = makeToken({ gx: 0, gy: 0 });
    const target = makeToken({ gx: 4, gy: 0 });
    expect(hasLineOfSight(combat, attacker, target)).toBe(true);
  });

  it("is true at exactly the boundary of range with a clear line of sight", () => {
    const combat = makeCombat();
    const attacker = makeToken({ gx: 0, gy: 0 });
    const target = makeToken({ gx: 10, gy: 0 });
    expect(hasLineOfSight(combat, attacker, target)).toBe(true);
  });

  it("is false when a diagonal shot would clip a wall corner", () => {
    // An L-shaped corner: a vertical wall on the east side of (1,0)/(1,1)
    // and a horizontal wall on the south side of (0,1)/(1,1), meeting
    // exactly at the (2,2)-pixel corner the diagonal line from (0,0) to
    // (2,2) passes through.
    const combat = makeCombat({
      walls: [verticalWall(2, 0, 2), horizontalWall(2, 0, 2)],
    });
    const attacker = makeToken({ gx: 0, gy: 0 });
    const target = makeToken({ gx: 2, gy: 2 });
    expect(hasLineOfSight(combat, attacker, target)).toBe(false);
  });

  it("is true along a clear diagonal line with no walls", () => {
    const combat = makeCombat();
    const attacker = makeToken({ gx: 0, gy: 0 });
    const target = makeToken({ gx: 3, gy: 3 });
    expect(hasLineOfSight(combat, attacker, target)).toBe(true);
  });

  it("is unaffected by a wall that doesn't cross the actual line between attacker and target", () => {
    const combat = makeCombat({ walls: [verticalWall(2, 5, 6)] });
    const attacker = makeToken({ gx: 0, gy: 0 });
    const target = makeToken({ gx: 4, gy: 0 });
    expect(hasLineOfSight(combat, attacker, target)).toBe(true);
  });
});
