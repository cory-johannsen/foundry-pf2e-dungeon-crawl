import { describe, it, expect } from "vitest";
import {
  findPath,
  blockedEdgesFromWalls,
  hasLineOfSight,
} from "../scripts/pathfinding.mjs";

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

  it("with a non-default footprint, refuses a corridor only wide enough for a 1x1 mover", () => {
    // A 1-row-tall corridor at gy=1 (open), walled top (between gy 0/1) and
    // bottom (between gy 1/2) for gx 0..5 -- a 2x2 mover can never fit
    // inside it, since its own second row would always cross a wall.
    const isBlocked = (a, b) =>
      a.gy !== b.gy && Math.min(a.gy, b.gy) === 0 && a.gx >= 0 && a.gx <= 5 && b.gx >= 0 && b.gx <= 5
        ? true
        : a.gy !== b.gy && Math.min(a.gy, b.gy) === 1 && a.gx >= 0 && a.gx <= 5 && b.gx >= 0 && b.gx <= 5;
    const bounds = { gx0: 0, gy0: 0, gx1: 6, gy1: 3 };
    const path1x1 = findPath({ gx: 0, gy: 1 }, { gx: 5, gy: 1 }, isBlocked, bounds);
    expect(path1x1).not.toBeNull();
    const path2x2 = findPath(
      { gx: 0, gy: 1 },
      { gx: 5, gy: 1 },
      isBlocked,
      bounds,
      20000,
      { gw: 2, gh: 2 },
    );
    expect(path2x2).toBeNull();
  });

  it("with a non-default footprint, still finds a route through a corridor wide enough for its real size", () => {
    // Two open rows (gy 1 and gy 2), walled above gy=1 and below gy=2, for
    // gx 0..5 -- exactly wide enough for a 2x2 mover.
    const isBlocked = (a, b) => {
      if (a.gy === b.gy) return false;
      const boundary = Math.max(a.gy, b.gy);
      const inCols = a.gx >= 0 && a.gx <= 5 && b.gx >= 0 && b.gx <= 5;
      return inCols && (boundary === 1 || boundary === 3);
    };
    const bounds = { gx0: 0, gy0: 0, gx1: 6, gy1: 4 };
    const path = findPath(
      { gx: 0, gy: 1 },
      { gx: 5, gy: 1 },
      isBlocked,
      bounds,
      20000,
      { gw: 2, gh: 2 },
    );
    expect(path).not.toBeNull();
    for (const cell of path) {
      expect(cell.gy).toBeGreaterThanOrEqual(1);
      expect(cell.gy).toBeLessThanOrEqual(2);
    }
  });

  it("a 1x1 footprint (the default) is byte-identical to calling without the parameter", () => {
    const isBlocked = (a, b) =>
      a.gy !== b.gy && Math.max(a.gy, b.gy) === 1 && a.gx >= 0 && a.gx <= 4 && b.gx >= 0 && b.gx <= 4;
    const withoutParam = findPath({ gx: 2, gy: 0 }, { gx: 2, gy: 3 }, isBlocked);
    const withDefault = findPath(
      { gx: 2, gy: 0 },
      { gx: 2, gy: 3 },
      isBlocked,
      null,
      20000,
      { gw: 1, gh: 1 },
    );
    expect(withDefault).toEqual(withoutParam);
  });

  it("returns null when start itself has an invalid footprint (a wall runs through its own interior)", () => {
    // A 2x2 mover starting at (0,0) covers (0,0),(1,0),(0,1),(1,1). A wall
    // between (0,0) and (1,0) -- an edge internal to the footprint itself,
    // never crossed by any transition -- means this starting position is
    // invalid regardless of where the mover is trying to go.
    const isBlocked = (a, b) =>
      (a.gx === 0 && a.gy === 0 && b.gx === 1 && b.gy === 0) ||
      (a.gx === 1 && a.gy === 0 && b.gx === 0 && b.gy === 0);
    const start = { gx: 0, gy: 0 };
    const footprint = { gw: 2, gh: 2 };

    // A different goal: must not return a path, even though the goal itself
    // and every transition edge toward it are perfectly open.
    expect(
      findPath(start, { gx: 5, gy: 5 }, isBlocked, null, 20000, footprint),
    ).toBeNull();

    // The degenerate start === goal case must also refuse -- not shortcut to
    // a trivial 1-cell path -- since the mover's own footprint doesn't fit
    // at that cell regardless of whether it needs to move at all.
    expect(
      findPath(start, { ...start }, isBlocked, null, 20000, footprint),
    ).toBeNull();
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

describe("hasLineOfSight (#91)", () => {
  it("is true between the same cell", () => {
    expect(hasLineOfSight({ gx: 2, gy: 2 }, { gx: 2, gy: 2 }, openField)).toBe(
      true,
    );
  });

  it("is true across an open field, adjacent cells", () => {
    expect(hasLineOfSight({ gx: 0, gy: 0 }, { gx: 1, gy: 0 }, openField)).toBe(
      true,
    );
  });

  it("is true across an open field at a longer straight-line distance", () => {
    expect(hasLineOfSight({ gx: 0, gy: 0 }, { gx: 6, gy: 0 }, openField)).toBe(
      true,
    );
  });

  it("is false when a wall directly crosses the straight orthogonal line between two cells", () => {
    // Wall boundary blocks stepping from column 0 to column 1 at row 0 --
    // blockedEdgesFromWalls' own isBlocked(a,b) shape.
    const isBlocked = (a, b) =>
      a.gy === 0 && b.gy === 0 && Math.max(a.gx, b.gx) === 1;
    expect(hasLineOfSight({ gx: 0, gy: 0 }, { gx: 3, gy: 0 }, isBlocked)).toBe(
      false,
    );
  });

  it("is false when a wall crosses the line partway between two far-apart cells, not just at an adjacent boundary", () => {
    // Wall between column 3 and column 4 at row 0 -- several cells past the
    // attacker's own cell, well short of the target.
    const isBlocked = (a, b) =>
      a.gy === 0 && b.gy === 0 && Math.max(a.gx, b.gx) === 4;
    expect(hasLineOfSight({ gx: 0, gy: 0 }, { gx: 8, gy: 0 }, isBlocked)).toBe(
      false,
    );
  });

  it("is true when a wall exists but doesn't cross the straight line between attacker and target", () => {
    // Wall blocks column0->column1 at row 5 -- irrelevant to a shot fired
    // along row 0.
    const isBlocked = (a, b) =>
      a.gy === 5 && b.gy === 5 && Math.max(a.gx, b.gx) === 1;
    expect(hasLineOfSight({ gx: 0, gy: 0 }, { gx: 3, gy: 0 }, isBlocked)).toBe(
      true,
    );
  });

  it("is false along a vertical line crossing a horizontal wall", () => {
    const isBlocked = (a, b) =>
      a.gx === 0 && b.gx === 0 && Math.max(a.gy, b.gy) === 2;
    expect(hasLineOfSight({ gx: 0, gy: 0 }, { gx: 0, gy: 4 }, isBlocked)).toBe(
      false,
    );
  });

  it("is true along a clear diagonal line with no walls", () => {
    expect(hasLineOfSight({ gx: 0, gy: 0 }, { gx: 4, gy: 4 }, openField)).toBe(
      true,
    );
  });

  it("is false when a diagonal line clips a wall corner (matches findPath's own corner-cut refusal)", () => {
    // Same L-corner shape as findPath's own corner-cutting test: a vertical
    // wall on (1,0)/(1,1) and a horizontal wall on (0,1)/(1,1) meeting at
    // the (1,1) corner the diagonal line from (0,0) to (2,2) passes through.
    const isBlocked = (a, b) => {
      const vertical =
        (a.gx === 1 && a.gy === 0 && b.gx === 1 && b.gy === 1) ||
        (a.gx === 1 && a.gy === 1 && b.gx === 1 && b.gy === 0);
      const horizontal =
        (a.gx === 0 && a.gy === 1 && b.gx === 1 && b.gy === 1) ||
        (a.gx === 1 && a.gy === 1 && b.gx === 0 && b.gy === 1);
      return vertical || horizontal;
    };
    expect(hasLineOfSight({ gx: 0, gy: 0 }, { gx: 2, gy: 2 }, isBlocked)).toBe(
      false,
    );
  });

  it("is true when a diagonal line passes through a lattice corner with no wall flanking it", () => {
    expect(hasLineOfSight({ gx: 0, gy: 0 }, { gx: 2, gy: 2 }, openField)).toBe(
      true,
    );
  });

  it("is symmetric: swapping attacker and target gives the same answer", () => {
    const isBlocked = (a, b) =>
      a.gy === 0 && b.gy === 0 && Math.max(a.gx, b.gx) === 2;
    expect(hasLineOfSight({ gx: 0, gy: 0 }, { gx: 4, gy: 0 }, isBlocked)).toBe(
      false,
    );
    expect(hasLineOfSight({ gx: 4, gy: 0 }, { gx: 0, gy: 0 }, isBlocked)).toBe(
      false,
    );
  });
});
