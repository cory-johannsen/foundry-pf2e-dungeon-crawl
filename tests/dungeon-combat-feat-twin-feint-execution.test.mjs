// tests/dungeon-combat-feat-twin-feint-execution.test.mjs
import { describe, it, expect, beforeEach } from "vitest";
import { applyAgentDecision } from "../scripts/dungeon-combat.mjs";
import { installGlobals, makeCombatant, makeCombat, makeStrike, makeWeapon, turnState } from "./helpers/feat-execution-fixture.mjs";

// #910: Twin Feint (installed system text) -- "Make one Strike with each of
// your two melee weapons, both against the same target. The target is
// automatically Off-Guard against the second attack. Apply your multiple
// attack penalty to the Strikes normally." No rule elements automate it.

const TWIN = {
  id: "tf1",
  slug: "twin-feint",
  name: "Twin Feint",
  system: { actionType: { value: "action" }, actions: { value: 2 }, traits: { value: ["rogue"] } },
};

function setup({ mapIncrement = 0 } = {}) {
  const sword = makeStrike(makeWeapon({ id: "w1", slug: "shortsword" }));
  const dagger = makeStrike(makeWeapon({ id: "w2", slug: "dagger" }));
  const attacker = makeCombatant({ id: "atk", gx: 0, gy: 0, disposition: -1, type: "character", actions: [sword, dagger], feat: [TWIN] });
  const opponent = makeCombatant({ id: "opp", gx: 1, gy: 0, disposition: 1 });
  const combat = makeCombat(attacker, [opponent], {
    picks: [{ type: "feat", slug: "twin-feint", targetId: "opp", rationale: "r" }],
    mapIncrement,
  });
  return { attacker, opponent, combat, sword, dagger };
}

beforeEach(() => installGlobals());

describe("applyAgentDecision Twin Feint execution (#910)", () => {
  it("strikes once with each weapon, the target Off-Guard only for the second Strike", async () => {
    const { opponent, combat, sword, dagger } = setup();
    await applyAgentDecision(combat, "atk", "feat:tf1:opp", "r");
    expect(sword.variants[0].roll).toHaveBeenCalledTimes(1);
    expect(dagger.variants[1].roll).toHaveBeenCalledTimes(1);
    expect(opponent.actor.increaseCondition).toHaveBeenCalledWith("off-guard");
    expect(opponent.actor.decreaseCondition).toHaveBeenCalledWith("off-guard", { forceRemove: true });
    const first = sword.variants[0].roll.mock.invocationCallOrder[0];
    const second = dagger.variants[1].roll.mock.invocationCallOrder[0];
    const added = opponent.actor.increaseCondition.mock.invocationCallOrder[0];
    const removed = opponent.actor.decreaseCondition.mock.invocationCallOrder[0];
    expect(first).toBeLessThan(added);
    expect(added).toBeLessThan(second);
    expect(second).toBeLessThan(removed);
  });

  it("applies MAP normally across both Strikes and counts two attacks", async () => {
    const { combat, sword, dagger } = setup({ mapIncrement: 1 });
    await applyAgentDecision(combat, "atk", "feat:tf1:opp", "r");
    expect(sword.variants[1].roll).toHaveBeenCalledTimes(1);
    expect(dagger.variants[2].roll).toHaveBeenCalledTimes(1);
    const ts = turnState(combat);
    expect(ts.actionsRemaining).toBe(1);
    expect(ts.mapIncrement).toBe(3);
  });

  it("leaves an Off-Guard the target already had in place", async () => {
    const { opponent, combat } = setup();
    opponent.actor.conditions = [{ slug: "off-guard" }];
    await applyAgentDecision(combat, "atk", "feat:tf1:opp", "r");
    expect(opponent.actor.increaseCondition).not.toHaveBeenCalled();
    expect(opponent.actor.decreaseCondition).not.toHaveBeenCalled();
  });

  it("skips the second Strike (and the Off-Guard) when the first one defeated the target", async () => {
    const { opponent, combat, sword, dagger } = setup();
    sword.variants[0].roll.mockImplementation(async () => {
      opponent.isDefeated = true;
    });
    await applyAgentDecision(combat, "atk", "feat:tf1:opp", "r");
    expect(dagger.variants.every((v) => v.roll.mock.calls.length === 0)).toBe(true);
    expect(opponent.actor.increaseCondition).not.toHaveBeenCalled();
    expect(turnState(combat).mapIncrement).toBe(1);
  });

  it("does nothing when fewer than two weapons are wielded at execution time", async () => {
    const { attacker, opponent, combat } = setup();
    // The off-hand weapon was stowed after the vocabulary was built: keep
    // it in the list getPendingAgentTurn reads, but make it ineligible.
    attacker.actor.system.actions[1].item.system.equipped.handsHeld = 2;
    await applyAgentDecision(combat, "atk", "feat:tf1:opp", "r");
    expect(opponent.actor.increaseCondition).not.toHaveBeenCalled();
    expect(turnState(combat).actionsRemaining).toBe(3);
  });
});
