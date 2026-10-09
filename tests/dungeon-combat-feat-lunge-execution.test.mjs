// tests/dungeon-combat-feat-lunge-execution.test.mjs
import { describe, it, expect, beforeEach } from "vitest";
import { applyAgentDecision } from "../scripts/dungeon-combat.mjs";
import { installGlobals, makeCombatant, makeCombat, makeStrike, makeWeapon, turnState } from "./helpers/feat-execution-fixture.mjs";

// #910: Lunge = one melee Strike with the feat's own toggleable "lunge"
// roll option on (its ActiveEffectLike adds 5 ft to reach), default domain
// "all" -- confirmed against the installed system's feat data.

const LUNGE = {
  id: "lunge1",
  slug: "lunge",
  name: "Lunge",
  system: { actionType: { value: "action" }, actions: { value: 1 }, traits: { value: ["fighter"] } },
};

function setup({ opponentAt = 2, mapIncrement = 0 } = {}) {
  const sword = makeStrike(makeWeapon({ id: "w1", slug: "longsword" }));
  const attacker = makeCombatant({ id: "atk", gx: 0, gy: 0, disposition: -1, type: "character", actions: [sword], feat: [LUNGE] });
  const opponent = makeCombatant({ id: "opp", gx: opponentAt, gy: 0, disposition: 1 });
  const combat = makeCombat(attacker, [opponent], {
    picks: [{ type: "feat", slug: "lunge", targetId: "opp", rationale: "r" }],
    mapIncrement,
  });
  return { attacker, opponent, combat, sword };
}

beforeEach(() => installGlobals());

describe("applyAgentDecision Lunge execution (#910)", () => {
  it("toggles the lunge roll option on, strikes with the melee weapon, then toggles it back off", async () => {
    const { attacker, combat, sword } = setup();
    await applyAgentDecision(combat, "atk", "feat:lunge1:opp", "r");
    const toggle = attacker.actor.toggleRollOption;
    expect(toggle).toHaveBeenNthCalledWith(1, "all", "lunge", "lunge1", true);
    expect(toggle).toHaveBeenNthCalledWith(2, "all", "lunge", "lunge1", false);
    expect(sword.variants[0].roll).toHaveBeenCalledTimes(1);
    const rollOrder = sword.variants[0].roll.mock.invocationCallOrder[0];
    expect(toggle.mock.invocationCallOrder[0]).toBeLessThan(rollOrder);
    expect(toggle.mock.invocationCallOrder[1]).toBeGreaterThan(rollOrder);
  });

  it("rolls at the turn's current MAP and counts as one attack", async () => {
    const { combat, sword } = setup({ mapIncrement: 1 });
    await applyAgentDecision(combat, "atk", "feat:lunge1:opp", "r");
    expect(sword.variants[1].roll).toHaveBeenCalledTimes(1);
    expect(turnState(combat).actionsRemaining).toBe(2);
    expect(turnState(combat).mapIncrement).toBe(2);
  });

  it("spends nothing and never toggles when the target has moved out of Lunge range since the pick", async () => {
    const { attacker, opponent, combat } = setup();
    // The pick was made with the target 10 ft away; it then moved.
    opponent.token.x = 6 * 100;
    // Rebuilding the vocabulary at execution time no longer offers Lunge,
    // so the stale candidate id resolves to nothing.
    await applyAgentDecision(combat, "atk", "feat:lunge1:opp", "r");
    expect(attacker.actor.toggleRollOption).not.toHaveBeenCalled();
    expect(turnState(combat).actionsRemaining).toBe(3);
  });

  it("does nothing when the target no longer exists", async () => {
    const { attacker, opponent, combat } = setup();
    opponent.isDefeated = true;
    await applyAgentDecision(combat, "atk", "feat:lunge1:opp", "r");
    expect(attacker.actor.toggleRollOption).not.toHaveBeenCalled();
  });
});
