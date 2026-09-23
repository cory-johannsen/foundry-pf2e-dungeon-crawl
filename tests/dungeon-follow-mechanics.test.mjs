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
      new Set(),
      noWalls(),
      null,
    );
    expect(result).toEqual({ status: "already-near" });
  });

  it("paths to a free tile adjacent to the leader when far away", () => {
    const result = findFollowMove(
      { gx: 0, gy: 0 },
      { gx: 5, gy: 5 },
      new Set(),
      noWalls(),
      null,
    );
    expect(result.status).toBe("move");
    expect(
      Math.max(Math.abs(result.to.gx - 5), Math.abs(result.to.gy - 5)),
    ).toBe(1);
  });

  it("avoids an already-occupied adjacent cell", () => {
    const occupied = new Set(["4,5", "4,4", "5,4", "6,4", "6,5", "6,6", "5,6"]);
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
    const occupied = new Set([
      "4,4",
      "4,5",
      "4,6",
      "5,4",
      "5,6",
      "6,4",
      "6,5",
      "6,6",
    ]);
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
      new Set(),
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
      new Set(),
      isBlocked,
      bounds,
    );

    expect(result.status).toBe("move");
    expect(result.to).not.toEqual({ gx: 4, gy: 4 });
    expect(
      Math.max(Math.abs(result.to.gx - 5), Math.abs(result.to.gy - 5)),
    ).toBe(1);
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
