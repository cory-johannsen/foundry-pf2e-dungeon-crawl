import { describe, it, expect } from "vitest";
import { actionReachSquares } from "../scripts/dungeon-combat.mjs";

const act = (range, traits = []) => ({ traits, item: { system: { range } } });

describe("actionReachSquares (#614)", () => {
  it("reads a PC weapon's numeric range", () => {
    expect(actionReachSquares(act(120), 5)).toBe(24);
  });
  it("reads an NPC {increment, max} range", () => {
    expect(actionReachSquares(act({ increment: 30, max: null }), 5)).toBe(6);
  });
  it("melee with null range is 1", () => {
    expect(actionReachSquares(act(null), 5)).toBe(1);
  });
  it("reach trait wins over range", () => {
    expect(actionReachSquares(act(120, [{ name: "reach-10" }]), 5)).toBe(2);
  });
  it.each([0, NaN, -30, { increment: null, max: null }, undefined])(
    "invalid range %j falls back to melee",
    (r) => {
      expect(actionReachSquares(act(r), 5)).toBe(1);
    },
  );
});
