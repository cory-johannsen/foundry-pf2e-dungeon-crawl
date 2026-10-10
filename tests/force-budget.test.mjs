import { describe, it, expect } from "vitest";
import { splitBudget, validateShares } from "../scripts/force-budget.mjs";
import { xpBudget } from "../scripts/encounter-roster.mjs";

describe("splitBudget", () => {
  it("a single 100% force gets the whole budget (legacy parity)", () => {
    expect(splitBudget(xpBudget("moderate", 4), [100])).toEqual([80]);
  });
  it("splits by percentage, flooring", () => {
    expect(splitBudget(80, [50, 50])).toEqual([40, 40]);
    expect(splitBudget(100, [33, 33, 34])).toEqual([33, 33, 34]);
    expect(splitBudget(xpBudget("low", 5), [50, 50])).toEqual([37, 37]); // 75 → 37,37
  });
  it("never returns negative or NaN", () => {
    expect(splitBudget(-5, [100])).toEqual([0]);
    expect(splitBudget(80, [NaN, 100])).toEqual([0, 80]);
  });
});

describe("validateShares", () => {
  it("accepts shares summing to 100", () => {
    expect(validateShares([60, 40])).toEqual({ ok: true, total: 100 });
  });
  it("rejects wrong sum, zero, negative and NaN shares", () => {
    expect(validateShares([60, 30]).ok).toBe(false);
    expect(validateShares([100, 0]).ok).toBe(false);
    expect(validateShares([120, -20]).ok).toBe(false);
    expect(validateShares([NaN, 100]).ok).toBe(false);
    expect(validateShares([]).ok).toBe(false);
  });
});
