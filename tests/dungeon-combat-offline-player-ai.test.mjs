import { describe, it, expect } from "vitest";
import { isAgentEligible } from "../scripts/dungeon-combat.mjs";

describe("isAgentEligible (#20)", () => {
  it("is eligible for a non-party actor regardless of aiControlledIds", () => {
    expect(isAgentEligible("npc-1", new Set(["party-1"]), new Set())).toBe(
      true,
    );
  });

  it("is not eligible for a party actor absent from aiControlledIds", () => {
    expect(isAgentEligible("party-1", new Set(["party-1"]), new Set())).toBe(
      false,
    );
  });

  it("is eligible for a party actor present in aiControlledIds", () => {
    expect(
      isAgentEligible("party-1", new Set(["party-1"]), new Set(["party-1"])),
    ).toBe(true);
  });
});
