import { describe, it, expect } from "vitest";
import { findPath, blockedEdgesFromWalls } from "../scripts/pathfinding.mjs";

const openField = () => false;

describe("findPath", () => {
  it("returns just the start when start equals goal", () => {
    const start = { gx: 3, gy: 3 };
    expect(findPath(start, { gx: 3, gy: 3 }, openField)).toEqual([
      { gx: 3, gy: 3 },
    ]);
  });

  it("takes a direct diagonal line across an open field (Chebyshev-optimal)", () => {
    const path = findPath({ gx: 0, gy: 0 }, { gx: 3, gy: 3 }, openField);
    expect(path).toHaveLength(4); // 3 diagonal steps + start
    expect(path[0]).toEqual({ gx: 0, gy: 0 });
    expect(path.at(-1)).toEqual({ gx: 3, gy: 3 });
  });

  it("every step in a returned path is one of the 8 adjacent cells", () => {
    const path = findPath({ gx: 0, gy: 0 }, { gx: 5, gy: 2 }, openField);
    for (let i = 1; i < path.length; i += 1) {
      const dx = Math.abs(path[i].gx - path[i - 1].gx);
      const dy = Math.abs(path[i].gy - path[i - 1].gy);
      expect(dx).toBeLessThanOrEqual(1);
      expect(dy).toBeLessThanOrEqual(1);
      expect(dx + dy).toBeGreaterThan(0);
    }
  });

  it("routes around a wall that fully blocks the direct path", () => {
    // A horizontal wall directly between (x, 0) and (x, 1) for x in [0, 4] --
    // straight south from (2,0) to (2,3) is blocked; must detour around an end.
    const isBlocked = (a, b) =>
      a.gy !== b.gy &&
      Math.max(a.gy, b.gy) === 1 &&
      a.gx >= 0 &&
      a.gx <= 4 &&
      b.gx >= 0 &&
      b.gx <= 4;
    const path = findPath({ gx: 2, gy: 0 }, { gx: 2, gy: 3 }, isBlocked);
    expect(path).not.toBeNull();
    // Confirm no consecutive pair in the path actually crosses the blocked boundary.
    for (let i = 1; i < path.length; i += 1) {
      expect(isBlocked(path[i - 1], path[i])).toBe(false);
    }
    expect(path.at(-1)).toEqual({ gx: 2, gy: 3 });
  });

  it("returns null when the goal is fully enclosed", () => {
    const goal = { gx: 5, gy: 5 };
    const isBlocked = (a, b) => {
      const touches = (c) =>
        Math.abs(c.gx - goal.gx) <= 1 &&
        Math.abs(c.gy - goal.gy) <= 1 &&
        !(c.gx === goal.gx && c.gy === goal.gy);
      // Block every edge on the ring immediately surrounding the goal.
      return (
        (a.gx === goal.gx && a.gy === goal.gy && touches(b)) ||
        (b.gx === goal.gx && b.gy === goal.gy && touches(a))
      );
    };
    expect(findPath({ gx: 0, gy: 0 }, goal, isBlocked)).toBeNull();
  });

  it("refuses to cut a diagonal across a wall corner even when the diagonal pair itself is not blocked", () => {
    // Two walls meeting at a corner between (1,0)/(1,1) [vertical] and (0,1)/(1,1) [horizontal]
    // form an L that should stop a diagonal step from (0,0) to (1,1), even though isBlocked
    // is never asked about that (0,0)->(1,1) pair directly.
    const isBlocked = (a, b) => {
      const vertical =
        (a.gx === 1 && a.gy === 0 && b.gx === 1 && b.gy === 1) ||
        (a.gx === 1 && a.gy === 1 && b.gx === 1 && b.gy === 0);
      const horizontal =
        (a.gx === 0 && a.gy === 1 && b.gx === 1 && b.gy === 1) ||
        (a.gx === 1 && a.gy === 1 && b.gx === 0 && b.gy === 1);
      return vertical || horizontal;
    };
    const path = findPath({ gx: 0, gy: 0 }, { gx: 1, gy: 1 }, isBlocked);
    // A direct diagonal would be exactly [{0,0},{1,1}] -- must not be that.
    expect(path).not.toEqual([
      { gx: 0, gy: 0 },
      { gx: 1, gy: 1 },
    ]);
    expect(path.at(-1)).toEqual({ gx: 1, gy: 1 });
  });

  it("respects bounds, refusing a goal outside them", () => {
    expect(
      findPath({ gx: 0, gy: 0 }, { gx: 10, gy: 0 }, openField, {
        gx0: 0,
        gy0: 0,
        gx1: 5,
        gy1: 5,
      }),
    ).toBeNull();
  });

  it("stays within bounds even when a route would otherwise leave them", () => {
    const bounds = { gx0: 0, gy0: 0, gx1: 3, gy1: 3 };
    const path = findPath(
      { gx: 0, gy: 0 },
      { gx: 3, gy: 3 },
      openField,
      bounds,
    );
    for (const cell of path) {
      expect(cell.gx).toBeGreaterThanOrEqual(0);
      expect(cell.gx).toBeLessThanOrEqual(3);
      expect(cell.gy).toBeGreaterThanOrEqual(0);
      expect(cell.gy).toBeLessThanOrEqual(3);
    }
  });
});

describe("blockedEdgesFromWalls", () => {
  const gridSize = 100;

  it("a vertical wall blocks east/west movement across it for the rows it spans", () => {
    // Wall at pixel x=200 spanning rows 0-2 (y: 0 to 200).
    const isBlocked = blockedEdgesFromWalls(
      [{ x1: 200, y1: 0, x2: 200, y2: 200 }],
      gridSize,
    );
    expect(isBlocked({ gx: 1, gy: 0 }, { gx: 2, gy: 0 })).toBe(true);
    expect(isBlocked({ gx: 2, gy: 0 }, { gx: 1, gy: 0 })).toBe(true);
    expect(isBlocked({ gx: 1, gy: 1 }, { gx: 2, gy: 1 })).toBe(true);
    // Row 2 is outside [0,2) -- the wall's span is exclusive of its own end row.
    expect(isBlocked({ gx: 1, gy: 2 }, { gx: 2, gy: 2 })).toBe(false);
  });

  it("a horizontal wall blocks north/south movement across it for the columns it spans", () => {
    // Wall at pixel y=300 spanning columns 1-4 (x: 100 to 400).
    const isBlocked = blockedEdgesFromWalls(
      [{ x1: 100, y1: 300, x2: 400, y2: 300 }],
      gridSize,
    );
    expect(isBlocked({ gx: 1, gy: 2 }, { gx: 1, gy: 3 })).toBe(true);
    expect(isBlocked({ gx: 3, gy: 3 }, { gx: 3, gy: 2 })).toBe(true);
    expect(isBlocked({ gx: 0, gy: 2 }, { gx: 0, gy: 3 })).toBe(false);
  });

  it("does not block unrelated edges", () => {
    const isBlocked = blockedEdgesFromWalls(
      [{ x1: 200, y1: 0, x2: 200, y2: 100 }],
      gridSize,
    );
    expect(isBlocked({ gx: 5, gy: 5 }, { gx: 6, gy: 5 })).toBe(false);
    expect(isBlocked({ gx: 1, gy: 0 }, { gx: 1, gy: 1 })).toBe(false);
  });

  it("ignores a non-axis-aligned wall segment rather than throwing", () => {
    const isBlocked = blockedEdgesFromWalls(
      [{ x1: 0, y1: 0, x2: 100, y2: 100 }],
      gridSize,
    );
    expect(() => isBlocked({ gx: 0, gy: 0 }, { gx: 1, gy: 0 })).not.toThrow();
    expect(isBlocked({ gx: 0, gy: 0 }, { gx: 1, gy: 0 })).toBe(false);
  });

  it("end to end: a corridor with side walls keeps a path from cutting through them", () => {
    // A 1-row-tall, 5-column corridor from gx 0..5 at gy=1, walled top (y=100) and
    // bottom (y=200) -- the same shape buildConnectionGeometry's capping segments
    // produce for a real east/west connection.
    const walls = [
      { x1: 0, y1: 100, x2: 500, y2: 100 },
      { x1: 0, y1: 200, x2: 500, y2: 200 },
    ];
    const isBlocked = blockedEdgesFromWalls(walls, gridSize);
    const path = findPath({ gx: 0, gy: 1 }, { gx: 4, gy: 1 }, isBlocked, {
      gx0: 0,
      gy0: 0,
      gx1: 4,
      gy1: 2,
    });
    expect(path).not.toBeNull();
    for (const cell of path) expect(cell.gy).toBe(1);
  });
});
