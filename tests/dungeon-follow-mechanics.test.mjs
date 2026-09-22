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
      Math.max(
        Math.abs(result.to.gx - 5),
        Math.abs(result.to.gy - 5),
      ),
    ).toBe(1);
  });

  it("avoids an already-occupied adjacent cell", () => {
    const occupied = new Set([
      "4,5",
      "4,4",
      "5,4",
      "6,4",
      "6,5",
      "6,6",
      "5,6",
    ]);
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
