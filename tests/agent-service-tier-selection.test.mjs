import { describe, it, expect } from "vitest";
import { selectCombatTier, selectCustomizationTier } from "../tools/agent-service/tier-selection.mjs";

describe("selectCombatTier", () => {
  it("picks fast when candidates.length is below the default threshold", () => {
    const context = { candidates: Array.from({ length: 3 }, (_, i) => ({ id: `c${i}` })) };
    expect(selectCombatTier(context)).toBe("fast");
  });

  it("picks fast at exactly the threshold boundary (8)", () => {
    const context = { candidates: Array.from({ length: 8 }, (_, i) => ({ id: `c${i}` })) };
    expect(selectCombatTier(context)).toBe("fast");
  });

  it("picks reasoning just above the threshold boundary (9)", () => {
    const context = { candidates: Array.from({ length: 9 }, (_, i) => ({ id: `c${i}` })) };
    expect(selectCombatTier(context)).toBe("reasoning");
  });

  it("honors a custom threshold override", () => {
    const context = { candidates: Array.from({ length: 5 }, (_, i) => ({ id: `c${i}` })) };
    expect(selectCombatTier(context, { threshold: 4 })).toBe("reasoning");
    expect(selectCombatTier(context, { threshold: 5 })).toBe("fast");
  });
});

describe("selectCustomizationTier", () => {
  it("picks fast for trap and treasure", () => {
    expect(selectCustomizationTier("trap")).toBe("fast");
    expect(selectCustomizationTier("treasure")).toBe("fast");
  });

  it("picks reasoning for skill_challenge, puzzle, and narrative", () => {
    expect(selectCustomizationTier("skill_challenge")).toBe("reasoning");
    expect(selectCustomizationTier("puzzle")).toBe("reasoning");
    expect(selectCustomizationTier("narrative")).toBe("reasoning");
  });

  it("falls back to fast for an unrecognized kind rather than throwing", () => {
    expect(selectCustomizationTier("not-a-real-kind")).toBe("fast");
  });
});
