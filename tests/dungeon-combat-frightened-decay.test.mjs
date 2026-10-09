import { describe, it, expect, vi, afterEach } from "vitest";
import { decayFrightenedAtEndOfTurn } from "../scripts/dungeon-combat.mjs";

// #943: PF2e RAW -- "at the end of each of your turns, the value of your
// frightened condition decreases by 1." The installed system (8.5.0) never
// does this itself: ConditionPF2e#onEndTurn only handles persistent damage.

function combatantWithCondition(value) {
  const condition = value === null ? null : { value };
  return {
    combat: { id: "combat1" },
    actor: {
      id: "actor1",
      getCondition: vi.fn(() => condition),
      decreaseCondition: vi.fn(async () => {}),
    },
  };
}

afterEach(() => vi.restoreAllMocks());

describe("decayFrightenedAtEndOfTurn", () => {
  it("decreases Frightened by 1 (decreaseCondition with no options) when the actor has it", async () => {
    const combatant = combatantWithCondition(2);
    await decayFrightenedAtEndOfTurn(combatant);
    expect(combatant.actor.getCondition).toHaveBeenCalledWith("frightened");
    expect(combatant.actor.decreaseCondition).toHaveBeenCalledTimes(1);
    expect(combatant.actor.decreaseCondition).toHaveBeenCalledWith("frightened");
  });

  it("decreases Frightened 1 too (PF2e's decreaseCondition removes it at 0)", async () => {
    const combatant = combatantWithCondition(1);
    await decayFrightenedAtEndOfTurn(combatant);
    expect(combatant.actor.decreaseCondition).toHaveBeenCalledWith("frightened");
  });

  it("does nothing when the actor has no Frightened condition at all", async () => {
    const combatant = combatantWithCondition(null);
    await decayFrightenedAtEndOfTurn(combatant);
    expect(combatant.actor.decreaseCondition).not.toHaveBeenCalled();
  });

  it("does nothing when the combatant has no actor", async () => {
    const combatant = { combat: { id: "combat1" }, actor: null };
    await expect(decayFrightenedAtEndOfTurn(combatant)).resolves.toBeUndefined();
  });

  it("does nothing when the combatant itself is missing", async () => {
    await expect(decayFrightenedAtEndOfTurn(undefined)).resolves.toBeUndefined();
  });

  it("applies to a player-controlled combatant's actor, not just an NPC's", async () => {
    const combatant = combatantWithCondition(1);
    combatant.actor.hasPlayerOwner = true;
    combatant.actor.type = "character";
    await decayFrightenedAtEndOfTurn(combatant);
    expect(combatant.actor.decreaseCondition).toHaveBeenCalledWith("frightened");
  });

  it("logs and does not throw when decreaseCondition rejects", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const combatant = combatantWithCondition(2);
    combatant.actor.decreaseCondition.mockRejectedValue(new Error("boom"));
    await expect(decayFrightenedAtEndOfTurn(combatant)).resolves.toBeUndefined();
    expect(err).toHaveBeenCalled();
  });

  it("logs and does not throw when reading the condition throws (actor deleted mid-hook)", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const combatant = combatantWithCondition(2);
    combatant.actor.getCondition.mockImplementation(() => {
      throw new Error("gone");
    });
    await expect(decayFrightenedAtEndOfTurn(combatant)).resolves.toBeUndefined();
    expect(combatant.actor.decreaseCondition).not.toHaveBeenCalled();
    expect(err).toHaveBeenCalled();
  });
});
