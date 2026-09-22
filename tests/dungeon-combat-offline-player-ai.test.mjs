import { describe, it, expect } from "vitest";
import {
  isAgentEligible,
  isExcludedFromAutoPlay,
} from "../scripts/dungeon-combat.mjs";

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

describe("isExcludedFromAutoPlay (#20)", () => {
  function makeCombatant({ agentControlled = false, actor = {} } = {}) {
    const flags = { agentControlled };
    return {
      getFlag: (_moduleId, key) => flags[key],
      actor,
    };
  }

  it("excludes a human party member (no flag, actor id in partyIds)", () => {
    const combatant = makeCombatant({
      agentControlled: false,
      actor: { id: "party-1", hasPlayerOwner: true },
    });
    expect(isExcludedFromAutoPlay(combatant, new Set(["party-1"]))).toBe(
      true,
    );
  });

  it("does not exclude a run's AI-controlled party actor, regardless of hasPlayerOwner", () => {
    const combatant = makeCombatant({
      agentControlled: true,
      actor: { id: "party-1", hasPlayerOwner: true },
    });
    expect(isExcludedFromAutoPlay(combatant, new Set(["party-1"]))).toBe(
      false,
    );
  });

  it("does not exclude a flagged NPC", () => {
    const combatant = makeCombatant({
      agentControlled: true,
      actor: { id: "npc-1", hasPlayerOwner: false },
    });
    expect(isExcludedFromAutoPlay(combatant, new Set(["party-1"]))).toBe(
      false,
    );
  });

  it("excludes a manually-added, player-summoned ally (no flag, not in partyIds, hasPlayerOwner)", () => {
    const combatant = makeCombatant({
      agentControlled: false,
      actor: { id: "summon-1", hasPlayerOwner: true },
    });
    expect(isExcludedFromAutoPlay(combatant, new Set(["party-1"]))).toBe(
      true,
    );
  });
});
