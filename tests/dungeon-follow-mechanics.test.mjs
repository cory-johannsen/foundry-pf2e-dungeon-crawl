import { describe, it, expect } from "vitest";
import {
  findFollowMove,
  tokenCell,
  sceneBounds,
  chooseResnapCell,
  extendTrail,
  findTrailMove,
} from "../scripts/dungeon-follow-mechanics.mjs";

function noWalls() {
  return () => false;
}

describe("findFollowMove", () => {
  it("returns the path minus its start cell as `steps`, ending at `to` (#610)", () => {
    const result = findFollowMove(
      { gx: 0, gy: 0 },
      { gx: 5, gy: 0 },
      [],
      noWalls(),
      null,
    );
    expect(result.status).toBe("move");
    expect(result.steps).not.toContainEqual({ gx: 0, gy: 0 });
    expect(result.steps.at(-1)).toEqual(result.to);
    let prev = { gx: 0, gy: 0 };
    for (const c of result.steps) {
      expect(Math.max(Math.abs(c.gx - prev.gx), Math.abs(c.gy - prev.gy))).toBe(1);
      prev = c;
    }
  });

  it("returns already-near when within one tile of the leader", () => {
    const result = findFollowMove(
      { gx: 5, gy: 5 },
      { gx: 5, gy: 6 },
      [],
      noWalls(),
      null,
    );
    expect(result).toEqual({ status: "already-near" });
  });

  it("paths to a free tile adjacent to the leader when far away", () => {
    const result = findFollowMove(
      { gx: 0, gy: 0 },
      { gx: 5, gy: 5 },
      [],
      noWalls(),
      null,
    );
    expect(result.status).toBe("move");
    expect(
      Math.max(Math.abs(result.to.gx - 5), Math.abs(result.to.gy - 5)),
    ).toBe(1);
  });

  it("avoids an already-occupied adjacent cell", () => {
    const occupied = [
      { gx: 4, gy: 5, gw: 1, gh: 1 },
      { gx: 4, gy: 4, gw: 1, gh: 1 },
      { gx: 5, gy: 4, gw: 1, gh: 1 },
      { gx: 6, gy: 4, gw: 1, gh: 1 },
      { gx: 6, gy: 5, gw: 1, gh: 1 },
      { gx: 6, gy: 6, gw: 1, gh: 1 },
      { gx: 5, gy: 6, gw: 1, gh: 1 },
    ];
    const result = findFollowMove(
      { gx: 0, gy: 0 },
      { gx: 5, gy: 5 },
      occupied,
      noWalls(),
      null,
    );
    expect(result).toMatchObject({ status: "move", to: { gx: 4, gy: 6 } });
  });

  // #87 (third round): the leader's own immediate 8-neighborhood being
  // fully occupied used to mean "no-route" outright, even with plenty of
  // free, reachable floor one ring farther out — exactly the corner/
  // capacity-crowding bug live sessions confirmed (more AI-controlled
  // followers than the leader's own immediate neighborhood has room for).
  // freeCellsNear now expands to ring 2 automatically in that case.
  it("expands to ring 2 when every cell in the leader's own immediate 8-neighborhood is occupied", () => {
    const occupied = [
      { gx: 4, gy: 4, gw: 1, gh: 1 },
      { gx: 4, gy: 5, gw: 1, gh: 1 },
      { gx: 4, gy: 6, gw: 1, gh: 1 },
      { gx: 5, gy: 4, gw: 1, gh: 1 },
      { gx: 5, gy: 6, gw: 1, gh: 1 },
      { gx: 6, gy: 4, gw: 1, gh: 1 },
      { gx: 6, gy: 5, gw: 1, gh: 1 },
      { gx: 6, gy: 6, gw: 1, gh: 1 },
    ];
    const result = findFollowMove(
      { gx: 0, gy: 0 },
      { gx: 5, gy: 5 },
      occupied,
      noWalls(),
      null,
    );
    expect(result.status).toBe("move");
    // Ring 2 around (5,5): chebyshev distance exactly 2.
    expect(
      Math.max(Math.abs(result.to.gx - 5), Math.abs(result.to.gy - 5)),
    ).toBe(2);
  });

  it("returns no-route when every cell within the search radius is occupied", () => {
    const occupied = [];
    for (let r = 1; r <= 10; r += 1) {
      for (let dx = -r; dx <= r; dx += 1) {
        for (let dy = -r; dy <= r; dy += 1) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
          occupied.push({ gx: 5 + dx, gy: 5 + dy, gw: 1, gh: 1 });
        }
      }
    }
    const result = findFollowMove(
      { gx: 0, gy: 0 },
      { gx: 5, gy: 5 },
      occupied,
      noWalls(),
      null,
    );
    expect(result).toEqual({ status: "no-route" });
  });

  it("returns no-route when every path is wall-blocked", () => {
    const result = findFollowMove(
      { gx: 0, gy: 0 },
      { gx: 5, gy: 5 },
      [],
      () => true,
      null,
    );
    expect(result).toEqual({ status: "no-route" });
  });

  // #87: the closest-by-chebyshev adjacent cell used to be the *only* one
  // ever tried. At a doorway, that closest cell is very often a dead pocket
  // — walled off on every side except through a cell one square farther
  // away (the door tile itself) — while every other free adjacent cell,
  // including the door tile a follower actually needs to path through, was
  // never attempted at all. This reproduces that geometry directly: (4,4)
  // is the single closest free cell adjacent to the leader at (5,5) from a
  // follower all the way out at (0,0), but it's walled off on every side,
  // while (4,5)/(5,4)/etc. are wide open.
  it("falls back to another free adjacent cell when the single closest one is a walled-off dead pocket (#87)", () => {
    const bounds = { gx0: 0, gy0: 0, gx1: 10, gy1: 10 };
    const isBlocked = (a, b) =>
      (a.gx === 4 && a.gy === 4) || (b.gx === 4 && b.gy === 4);

    const result = findFollowMove(
      { gx: 0, gy: 0 },
      { gx: 5, gy: 5 },
      [],
      isBlocked,
      bounds,
    );

    expect(result.status).toBe("move");
    expect(result.to).not.toEqual({ gx: 4, gy: 4 });
    expect(
      Math.max(Math.abs(result.to.gx - 5), Math.abs(result.to.gy - 5)),
    ).toBe(1);
  });

  it("with a non-default footprint, refuses a candidate cell the mover's own footprint would overlap", () => {
    // Corrected during Task 3's own review: the original version placed
    // the occupied cell where the chebyshev-closest candidate to
    // fromCell never overlapped it regardless of footprint size, so the
    // test passed identically with footprint-aware occupancy reverted
    // entirely (same defect class as Task 2's test 3, found there twice
    // -- verified empirically here too, the same way).
    //
    // fromCell=(3,3) makes (4,4) the UNIQUE closest candidate (chebyshev
    // 1, no tie) among the leader's 8 adjacent cells. occupied=(5,4)
    // overlaps a 2x2 footprint anchored at (4,4) (columns 4-5, rows 4-5
    // both cover (5,4)) but NOT a 1x1 footprint there (exact-cell match
    // only, and (5,4) != (4,4)) -- forcing a 2x2 mover past (4,4) (and
    // (5,4) itself, which self-overlaps the occupant) to the next
    // genuinely free candidate, (4,5), while a 1x1 mover would land
    // directly on (4,4). The two footprint sizes are forced to
    // genuinely different winning candidates.
    const occupied = [{ gx: 5, gy: 4, gw: 1, gh: 1 }];
    const result = findFollowMove(
      { gx: 3, gy: 3 },
      { gx: 5, gy: 5 },
      occupied,
      noWalls(),
      null,
      { gw: 2, gh: 2 },
    );
    expect(result.status).toBe("move");
    expect(result.to).toEqual({ gx: 4, gy: 5 });
  });
});

describe("tokenCell / sceneBounds (#20)", () => {
  it("rounds a pixel position to its grid cell", () => {
    expect(tokenCell({ x: 250, y: 400 }, 100)).toEqual({ gx: 3, gy: 4 });
  });

  it("computes the inclusive grid-cell bounds of a scene", () => {
    expect(sceneBounds({ width: 1000, height: 800 }, 100)).toEqual({
      gx0: 0,
      gy0: 0,
      gx1: 9,
      gy1: 7,
    });
  });

  it("returns null when the scene has no usable dimensions", () => {
    expect(sceneBounds({ width: undefined, height: undefined }, 100)).toBe(
      null,
    );
  });
});

// #365: pathing is occupancy-aware -- a follower can't path through (and so
// can't leapfrog) another token.
describe("findFollowMove occupancy-aware pathing (#365)", () => {
  // 1-wide corridor along y=5, x in [0,20]; everything else is wall.
  const corridorBlocked = (_a, b) => b.gy !== 5 || b.gx < 0 || b.gx > 20;
  const tok = (gx, gy, extra = {}) => ({ gx, gy, gw: 1, gh: 1, ...extra });

  it("cannot leapfrog a token in a 1-wide corridor", () => {
    // Follower at 0, blocker at 3, leader at 10; the free cells next to
    // the leader are only reachable through the blocker, so the follower
    // may only settle short of it (ring expansion reaches x=2), never past.
    const result = findFollowMove(
      { gx: 0, gy: 5 },
      { gx: 10, gy: 5 },
      [tok(3, 5), tok(10, 5)],
      corridorBlocked,
      null,
    );
    expect(result.status).toBe("move");
    expect(result.to.gx).toBeLessThan(3);
  });

  it("routes around the same token in an open room", () => {
    const result = findFollowMove(
      { gx: 0, gy: 5 },
      { gx: 10, gy: 5 },
      [tok(3, 5), tok(10, 5)],
      noWalls(),
      null,
    );
    expect(result.status).toBe("move");
  });

  it("a passable (loot) footprint does not block the corridor", () => {
    const result = findFollowMove(
      { gx: 0, gy: 5 },
      { gx: 10, gy: 5 },
      [tok(3, 5, { passable: true }), tok(10, 5)],
      corridorBlocked,
      null,
    );
    expect(result).toMatchObject({ status: "move", to: { gx: 9, gy: 5 } });
  });

  it("the leader's own cell blocks pathing through it", () => {
    // Leader at 5, follower at 0; free cell on far side (6) is only
    // reachable through the leader, but 4 is reachable -- must pick 4.
    const result = findFollowMove(
      { gx: 0, gy: 5 },
      { gx: 5, gy: 5 },
      [tok(5, 5)],
      corridorBlocked,
      null,
    );
    expect(result).toMatchObject({ status: "move", to: { gx: 4, gy: 5 } });
  });

  it("a 2x2 mover is blocked by a token in its swept cells", () => {
    const big = { gw: 2, gh: 2 };
    // 2-wide corridor y in [5,6].
    const wide = (_a, b) => b.gy < 5 || b.gy > 6 || b.gx < 0 || b.gx > 20;
    const blocked = findFollowMove(
      { gx: 0, gy: 5 },
      { gx: 10, gy: 5 },
      [tok(4, 6), { gx: 10, gy: 5, gw: 2, gh: 2 }],
      wide,
      null,
      big,
    );
    expect(blocked.status).toBe("move");
    expect(blocked.to.gx + 1).toBeLessThan(4);
    const clear = findFollowMove(
      { gx: 0, gy: 5 },
      { gx: 10, gy: 5 },
      [{ gx: 10, gy: 5, gw: 2, gh: 2 }],
      wide,
      null,
      big,
    );
    expect(clear.status).toBe("move");
  });
});

describe("chooseResnapCell (#150)", () => {
  const G = 100;
  // vertical wall on the boundary between gx=4 and gx=5, all rows
  const wallBetween4and5 = (a, b) =>
    a.gy === b.gy && Math.max(a.gx, b.gx) === 5;

  it("uses the rounded cell when it's free and unwalled", () => {
    expect(
      chooseResnapCell({ x: 550, y: 330, gridSize: G }),
    ).toEqual({ gx: 6, gy: 3, valid: true });
  });

  it("keeps a rounded cell on the same side of a wall as the drifted center", () => {
    expect(
      chooseResnapCell({ x: 451, y: 300, gridSize: G, isBlocked: wallBetween4and5 }),
    ).toMatchObject({ gx: 5, valid: true });
  });

  it("rings out when the rounded cell is occupied", () => {
    const r = chooseResnapCell({
      x: 502,
      y: 301,
      gridSize: G,
      occupied: [{ gx: 5, gy: 3, gw: 1, gh: 1 }],
    });
    expect(r.valid).toBe(true);
    expect(r).not.toMatchObject({ gx: 5, gy: 3 });
    expect(Math.max(Math.abs(r.gx - 5), Math.abs(r.gy - 3))).toBe(1);
  });

  it("avoids ring cells behind a wall", () => {
    // occupied rounded cell (5,3); wall on 4|5 boundary; origin cell is 5,
    // so cells at gx=4 are across the wall and must be skipped
    const r = chooseResnapCell({
      x: 500,
      y: 300,
      gridSize: G,
      occupied: [{ gx: 5, gy: 3, gw: 1, gh: 1 }],
      isBlocked: wallBetween4and5,
    });
    expect(r.valid).toBe(true);
    expect(r.gx).toBeGreaterThanOrEqual(5);
  });

  it("requires the whole footprint to be free for a Large token", () => {
    const r = chooseResnapCell({
      x: 500,
      y: 300,
      gridSize: G,
      gw: 2,
      gh: 2,
      occupied: [{ gx: 6, gy: 4, gw: 1, gh: 1 }],
    });
    expect(r.valid).toBe(true);
    const spot = { gx: r.gx, gy: r.gy, gw: 2, gh: 2 };
    expect(
      spot.gx < 7 && spot.gx + 2 > 6 && spot.gy < 5 && spot.gy + 2 > 4,
    ).toBe(false);
  });

  it("falls back to the plain rounded cell, flagged invalid, if nothing fits", () => {
    const everything = [{ gx: 0, gy: 0, gw: 100, gh: 100 }];
    expect(
      chooseResnapCell({ x: 502, y: 301, gridSize: G, occupied: everything }),
    ).toEqual({ gx: 5, gy: 3, valid: false });
  });
});

describe("extendTrail (#610)", () => {
  it("starts a trail at the leader's cell when empty", () => {
    expect(extendTrail([], { gx: 2, gy: 2 }, noWalls(), null, 5)).toEqual([{ gx: 2, gy: 2 }]);
  });

  it("prepends the path cells newest-first for a straight run", () => {
    expect(extendTrail([{ gx: 2, gy: 2 }], { gx: 6, gy: 2 }, noWalls(), null, 10)).toEqual([
      { gx: 6, gy: 2 },
      { gx: 5, gy: 2 },
      { gx: 4, gy: 2 },
      { gx: 3, gy: 2 },
      { gx: 2, gy: 2 },
    ]);
  });

  it("a diagonal jump is exactly the diagonal", () => {
    expect(extendTrail([{ gx: 2, gy: 2 }], { gx: 5, gy: 5 }, noWalls(), null, 10)).toEqual([
      { gx: 5, gy: 5 },
      { gx: 4, gy: 4 },
      { gx: 3, gy: 3 },
      { gx: 2, gy: 2 },
    ]);
  });

  it("falls back to findPath when the straight run crosses a blocked edge", () => {
    const blocked = (a, b) => a.gx === 3 && a.gy === 2 && b.gx === 4 && b.gy === 2;
    const t = extendTrail([{ gx: 2, gy: 2 }], { gx: 6, gy: 2 }, blocked, null, 10);
    expect(t[0]).toEqual({ gx: 6, gy: 2 });
    expect(t.at(-1)).toEqual({ gx: 2, gy: 2 });
    expect(t.some((c) => c.gy !== 2)).toBe(true); // detoured around the blocked edge
  });

  it("routes around a wall using findPath", () => {
    // block the direct edge (2,2)->(3,2)
    const blocked = (a, b) => a.gx === 2 && a.gy === 2 && b.gx === 3 && b.gy === 2;
    const t = extendTrail([{ gx: 2, gy: 2 }], { gx: 3, gy: 2 }, blocked, null, 10);
    expect(t[0]).toEqual({ gx: 3, gy: 2 });
    expect(t.at(-1)).toEqual({ gx: 2, gy: 2 });
    expect(t.length).toBeGreaterThan(2);
  });

  it("resets to the new cell when no path exists (teleport)", () => {
    const wall = () => true;
    const t = extendTrail([{ gx: 0, gy: 0 }], { gx: 8, gy: 8 }, wall, null, 10);
    expect(t).toEqual([{ gx: 8, gy: 8 }]);
  });

  it("leaves the trail unchanged when the leader's cell did not change", () => {
    const trail = [{ gx: 4, gy: 2 }, { gx: 3, gy: 2 }];
    expect(extendTrail(trail, { gx: 4, gy: 2 }, noWalls(), null, 10)).toEqual(trail);
  });

  it("collapses the trail when the leader walks back over its own route", () => {
    const trail = [{ gx: 5, gy: 2 }, { gx: 4, gy: 2 }, { gx: 3, gy: 2 }, { gx: 2, gy: 2 }];
    const t = extendTrail(trail, { gx: 3, gy: 2 }, noWalls(), null, 10);
    expect(t).toEqual([{ gx: 3, gy: 2 }, { gx: 2, gy: 2 }]);
  });

  it("trims to maxLen keeping the newest cells", () => {
    const t = extendTrail([{ gx: 0, gy: 0 }], { gx: 9, gy: 0 }, noWalls(), null, 4);
    expect(t).toEqual([
      { gx: 9, gy: 0 },
      { gx: 8, gy: 0 },
      { gx: 7, gy: 0 },
      { gx: 6, gy: 0 },
    ]);
    expect(t).not.toContainEqual({ gx: 0, gy: 0 });
  });
});

describe("findTrailMove (#610)", () => {
  const one = { gw: 1, gh: 1 };

  it("returns null with no trail cell (caller falls back)", () => {
    expect(findTrailMove({ gx: 0, gy: 0 }, null, [], noWalls(), null, one)).toBeNull();
  });

  it("returns already-near when on or adjacent to the trail cell", () => {
    expect(findTrailMove({ gx: 4, gy: 3 }, { gx: 4, gy: 2 }, [], noWalls(), null, one)).toEqual({
      status: "already-near",
    });
  });

  it("returns the walk to the trail cell as steps", () => {
    const r = findTrailMove({ gx: 0, gy: 2 }, { gx: 4, gy: 2 }, [], noWalls(), null, one);
    expect(r.status).toBe("move");
    expect(r.to).toEqual({ gx: 4, gy: 2 });
    expect(r.steps.at(-1)).toEqual({ gx: 4, gy: 2 });
    expect(r.steps).not.toContainEqual({ gx: 0, gy: 2 });
  });

  it("returns null when the trail cell is occupied", () => {
    const occ = [{ gx: 4, gy: 2, gw: 1, gh: 1 }];
    expect(findTrailMove({ gx: 0, gy: 2 }, { gx: 4, gy: 2 }, occ, noWalls(), null, one)).toBeNull();
  });

  it("returns null for a follower larger than 1x1", () => {
    expect(
      findTrailMove({ gx: 0, gy: 2 }, { gx: 4, gy: 2 }, [], noWalls(), null, { gw: 2, gh: 2 }),
    ).toBeNull();
  });

  it("returns null when no path reaches the trail cell", () => {
    expect(findTrailMove({ gx: 0, gy: 2 }, { gx: 4, gy: 2 }, [], () => true, null, one)).toBeNull();
  });
});
