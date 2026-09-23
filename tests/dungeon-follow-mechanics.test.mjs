import { describe, it, expect } from "vitest";
import {
  findFollowMove,
  tokenCell,
  sceneBounds,
} from "../scripts/dungeon-follow-mechanics.mjs";

function noWalls() {
  return () => false;
}

describe("findFollowMove", () => {
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
    expect(result).toEqual({ status: "move", to: { gx: 4, gy: 6 } });
  });

  it("returns no-route when every adjacent cell is occupied", () => {
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

  // #140: a 2x2 follower must refuse a candidate adjacent cell its own
  // footprint wouldn't fit into cleanly (here, overlapping a 1x1 blocker
  // one square east of the otherwise-closest candidate).
  it("with a non-default footprint, refuses a candidate cell the mover's own footprint would overlap", () => {
    const occupied = [{ gx: 5, gy: 6, gw: 1, gh: 1 }]; // sits inside a 2x2 footprint anchored at (4,6) or (5,5) etc.
    const result = findFollowMove(
      { gx: 0, gy: 0 },
      { gx: 5, gy: 5 },
      occupied,
      noWalls(),
      null,
      { gw: 2, gh: 2 },
    );
    expect(result.status).toBe("move");
    // Every candidate whose own 2x2 block would overlap (5,6) must be
    // excluded -- confirm the chosen destination's own 2x2 footprint does
    // not cover (5,6).
    const overlapsBlocker =
      result.to.gx <= 5 &&
      result.to.gx + 2 > 5 &&
      result.to.gy <= 6 &&
      result.to.gy + 2 > 6;
    expect(overlapsBlocker).toBe(false);
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
