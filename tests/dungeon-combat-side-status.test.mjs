import { describe, it, expect } from "vitest";
import { combatSideStatus } from "../scripts/dungeon-combat.mjs";

function makeCombatant({
  disposition,
  isDefeated = false,
  actorType = "character",
  conditions = [],
} = {}) {
  return {
    isDefeated,
    token: { disposition },
    actor: { type: actorType, conditions: conditions.map((slug) => ({ slug })) },
  };
}

describe("combatSideStatus", () => {
  it("both false while the fight is still going (everyone up)", () => {
    const combat = {
      combatants: [
        makeCombatant({ disposition: -1 }),
        makeCombatant({ disposition: 1 }),
      ],
    };
    expect(combatSideStatus(combat)).toEqual({
      hostilesDefeated: false,
      partyDefeated: false,
    });
  });

  it("hostilesDefeated is true once every hostile combatant is isDefeated (unchanged behavior)", () => {
    const combat = {
      combatants: [
        makeCombatant({ disposition: -1, isDefeated: true }),
        makeCombatant({ disposition: -1, isDefeated: true }),
        makeCombatant({ disposition: 1 }),
      ],
    };
    const result = combatSideStatus(combat);
    expect(result.hostilesDefeated).toBe(true);
    expect(result.partyDefeated).toBe(false);
  });

  it("partyDefeated is true once every party combatant is isDefeated (unchanged behavior, no conditions involved)", () => {
    const combat = {
      combatants: [
        makeCombatant({ disposition: -1 }),
        makeCombatant({ disposition: 1, isDefeated: true }),
        makeCombatant({ disposition: 1, isDefeated: true }),
      ],
    };
    expect(combatSideStatus(combat).partyDefeated).toBe(true);
  });

  it("#580: partyDefeated is true once every party PC is dying/unconscious, even though none are isDefeated", () => {
    const combat = {
      combatants: [
        makeCombatant({ disposition: -1 }),
        makeCombatant({ disposition: 1, conditions: ["dying", "unconscious"] }),
        makeCombatant({ disposition: 1, conditions: ["unconscious"] }),
      ],
    };
    expect(combatSideStatus(combat).partyDefeated).toBe(true);
  });

  it("#580: partyDefeated stays false when at least one party PC is still conscious (could still stabilize the rest)", () => {
    const combat = {
      combatants: [
        makeCombatant({ disposition: -1 }),
        makeCombatant({ disposition: 1, conditions: ["dying", "unconscious"] }),
        makeCombatant({ disposition: 1, conditions: [] }), // conscious
      ],
    };
    expect(combatSideStatus(combat).partyDefeated).toBe(false);
  });

  it("#580: a merely-unconscious, non-character party ally does not count as incapacitated -- only a real character's dying/unconscious condition does", () => {
    const combat = {
      combatants: [
        makeCombatant({ disposition: -1 }),
        makeCombatant({ disposition: 1, conditions: ["dying", "unconscious"] }),
        makeCombatant({
          disposition: 1,
          actorType: "npc", // a summoned ally, not a PF2e "character"
          conditions: ["unconscious"],
        }),
      ],
    };
    // The ally isn't isDefeated and isDownedCharacter doesn't apply to it
    // (not a "character") -- so the party is NOT yet all-incapacitated.
    expect(combatSideStatus(combat).partyDefeated).toBe(false);
  });

  it("stays false for an empty side (no hostiles, or no party, in this combat) -- unchanged behavior", () => {
    const partyOnly = { combatants: [makeCombatant({ disposition: 1, isDefeated: true })] };
    expect(combatSideStatus(partyOnly)).toEqual({ hostilesDefeated: false, partyDefeated: true });

    const hostileOnly = { combatants: [makeCombatant({ disposition: -1, isDefeated: true })] };
    expect(combatSideStatus(hostileOnly)).toEqual({ hostilesDefeated: true, partyDefeated: false });
  });
});
