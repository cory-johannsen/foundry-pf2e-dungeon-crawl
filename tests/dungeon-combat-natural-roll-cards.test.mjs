import { describe, it, expect } from "vitest";
import {
  naturalD20,
  criticalCardKindFor,
} from "../scripts/dungeon-critical-deck.mjs";
import { findAttackMessageForDamage } from "../scripts/dungeon-combat.mjs";

// #976: Critical Hit/Fumble Deck cards draw only when the roll is BOTH a
// critical success/failure by degree of success AND a natural 20/1 -- the
// owner's explicit, recorded deviation from the deck's usual "any critical"
// guidance.

// A real CheckRoll's d20 Die term shape, as read live off a stored
// attack-roll message (`message.rolls[0].dice[0].results`).
function d20Roll(...results) {
  return {
    dice: [{ faces: 20, results: results.map((r) => ({ active: true, ...r })) }],
  };
}

describe("naturalD20", () => {
  it("reads the d20's natural face", () => {
    expect(naturalD20(d20Roll({ result: 20 }))).toBe(20);
    expect(naturalD20(d20Roll({ result: 1 }))).toBe(1);
    expect(naturalD20(d20Roll({ result: 13 }))).toBe(13);
  });

  it("reads the kept die of a fortune/misfortune 2d20 roll", () => {
    expect(
      naturalD20(
        d20Roll(
          { result: 20, active: true },
          { result: 4, active: false, discarded: true },
        ),
      ),
    ).toBe(20);
    expect(
      naturalD20(
        d20Roll(
          { result: 20, active: false, discarded: true },
          { result: 4, active: true },
        ),
      ),
    ).toBe(4);
  });

  it("ignores non-d20 dice", () => {
    expect(
      naturalD20({ dice: [{ faces: 6, results: [{ result: 1, active: true }] }] }),
    ).toBeNull();
  });

  it("returns null for missing or malformed data", () => {
    expect(naturalD20(undefined)).toBeNull();
    expect(naturalD20({ total: 7 })).toBeNull();
    expect(naturalD20({ dice: [{ faces: 20, results: [] }] })).toBeNull();
    // The plan's assumed field: CheckRoll#degreeOfSuccess is actually the
    // bare numeric degree (0-3), so it must not be mistaken for a die face.
    expect(naturalD20({ degreeOfSuccess: 3, total: 27 })).toBeNull();
  });
});

describe("criticalCardKindFor", () => {
  it("draws a Hit card only for a criticalSuccess on a natural 20", () => {
    expect(criticalCardKindFor("criticalSuccess", 20)).toBe("hit");
  });

  it("draws nothing for a criticalSuccess reached by a 10+ margin on a non-20", () => {
    expect(criticalCardKindFor("criticalSuccess", 19)).toBeNull();
    expect(criticalCardKindFor("criticalSuccess", 15)).toBeNull();
  });

  it("draws nothing for a natural 20 that only reaches a plain success (very high DC)", () => {
    expect(criticalCardKindFor("success", 20)).toBeNull();
    expect(criticalCardKindFor("failure", 20)).toBeNull();
  });

  it("draws a Fumble card only for a criticalFailure on a natural 1", () => {
    expect(criticalCardKindFor("criticalFailure", 1)).toBe("fumble");
    expect(criticalCardKindFor("criticalFailure", 6)).toBeNull();
  });

  it("draws nothing for a natural 1 that is only a plain failure (very low DC)", () => {
    expect(criticalCardKindFor("failure", 1)).toBeNull();
    expect(criticalCardKindFor("success", 1)).toBeNull();
  });

  it("draws nothing when the natural face is unknown", () => {
    expect(criticalCardKindFor("criticalSuccess", null)).toBeNull();
    expect(criticalCardKindFor("criticalFailure", null)).toBeNull();
  });
});

describe("findAttackMessageForDamage", () => {
  function attackMessage({
    id,
    token = "tok",
    origin = "Actor.a.Item.w",
    target = "Scene.s.Token.t",
    outcome = "criticalSuccess",
  }) {
    return {
      id,
      speaker: { token },
      flags: {
        pf2e: {
          origin: { uuid: origin },
          context: { type: "attack-roll", outcome, target: { token: target } },
        },
      },
    };
  }

  function damageMessage({ id = "dmg", outcome = "criticalSuccess" } = {}) {
    return {
      id,
      speaker: { token: "tok" },
      flags: {
        pf2e: {
          origin: { uuid: "Actor.a.Item.w" },
          context: {
            type: "damage-roll",
            outcome,
            target: { token: "Scene.s.Token.t" },
          },
        },
      },
    };
  }

  it("scans back from the damage message's own position, not the collection's tail", () => {
    const dmg = damageMessage();
    const own = attackMessage({ id: "a1" });
    globalThis.game = {
      messages: {
        // A newer attack by the same weapon AFTER the damage message must
        // not be picked up.
        contents: [own, dmg, attackMessage({ id: "a2", outcome: "success" })],
      },
    };
    expect(findAttackMessageForDamage(dmg)).toBe(own);
  });

  it("skips other attackers' and other weapons' attack rolls", () => {
    const dmg = damageMessage();
    const own = attackMessage({ id: "a1" });
    globalThis.game = {
      messages: {
        contents: [
          own,
          attackMessage({ id: "x", token: "other" }),
          attackMessage({ id: "y", origin: "Actor.a.Item.other" }),
          { id: "chat", speaker: { token: "tok" }, flags: {} },
          dmg,
        ],
      },
    };
    expect(findAttackMessageForDamage(dmg)).toBe(own);
  });

  it("returns null when the nearest matching attack disagrees on target or outcome", () => {
    const dmg = damageMessage();
    globalThis.game = {
      messages: {
        contents: [attackMessage({ id: "a1", target: "Scene.s.Token.z" }), dmg],
      },
    };
    expect(findAttackMessageForDamage(dmg)).toBeNull();
    globalThis.game = {
      messages: {
        contents: [attackMessage({ id: "a1", outcome: "success" }), dmg],
      },
    };
    expect(findAttackMessageForDamage(dmg)).toBeNull();
  });

  it("returns null when there is no attack message at all", () => {
    globalThis.game = { messages: { contents: [] } };
    expect(findAttackMessageForDamage(damageMessage())).toBeNull();
    globalThis.game = {};
    expect(findAttackMessageForDamage(damageMessage())).toBeNull();
  });
});
