// tests/dungeon-combat-feat-sudden-charge-execution.test.mjs
import { describe, it, expect, beforeEach } from "vitest";
import { applyAgentDecision } from "../scripts/dungeon-combat.mjs";
import { G, installGlobals, makeCombatant, makeCombat, makeStrike, makeWeapon, turnState } from "./helpers/feat-execution-fixture.mjs";

// #910: Sudden Charge (installed system text) -- "Stride twice. If you end
// your movement within melee reach of at least one enemy, you can make a
// melee Strike against that enemy." Flourish.

const CHARGE = {
  id: "sc1",
  slug: "sudden-charge",
  name: "Sudden Charge",
  system: { actionType: { value: "action" }, actions: { value: 2 }, traits: { value: ["barbarian", "fighter", "flourish"] } },
};

function setup({ opponentAt = 8, speed = 20, walls = [] } = {}) {
  const sword = makeStrike(makeWeapon({ id: "w1", slug: "longsword" }));
  const attacker = makeCombatant({ id: "atk", gx: 0, gy: 1, disposition: -1, type: "character", actions: [sword], feat: [CHARGE], speed });
  const opponent = makeCombatant({ id: "opp", gx: opponentAt, gy: 1, disposition: 1 });
  const combat = makeCombat(attacker, [opponent], {
    picks: [{ type: "feat", slug: "sudden-charge", targetId: "opp", rationale: "r" }],
  });
  combat.scene.walls.contents = walls;
  return { attacker, opponent, combat, sword };
}

beforeEach(() => installGlobals());

describe("applyAgentDecision Sudden Charge execution (#910)", () => {
  it("strides twice toward the target, then strikes once in melee reach", async () => {
    // 20 ft speed = 4 squares per Stride; target 8 squares away.
    const { attacker, combat, sword } = setup();
    await applyAgentDecision(combat, "atk", "feat:sc1:opp", "r");
    expect(attacker.token.x).toBe(7 * G);
    expect(sword.variants[0].roll).toHaveBeenCalledTimes(1);
    const ts = turnState(combat);
    expect(ts.actionsRemaining).toBe(1);
    expect(ts.mapIncrement).toBe(1);
    expect(ts.flourishUsed).toBe(true);
  });

  it("moves but does not strike when still out of reach after both Strides, and adds no MAP", async () => {
    // Speed shrank after the pick (e.g. a slowing effect): two 1-square
    // Strides can't close a 5-square gap.
    const { attacker, combat, sword } = setup({ opponentAt: 8, speed: 20 });
    const slowAfterFirstStep = (fn) =>
      async function (...args) {
        attacker.actor.system.movement.speeds.land.value = 5;
        return fn.apply(this, args);
      };
    attacker.token.move.mockImplementation(slowAfterFirstStep(async function ({ x, y }) {
      Object.assign(this, { x, y });
    }));
    attacker.token.update.mockImplementation(slowAfterFirstStep(async function (changes) {
      Object.assign(this, changes);
    }));
    await applyAgentDecision(combat, "atk", "feat:sc1:opp", "r");
    expect(attacker.token.x).toBe(5 * G);
    expect(sword.variants.every((v) => v.roll.mock.calls.length === 0)).toBe(true);
    const ts = turnState(combat);
    expect(ts.actionsRemaining).toBe(1);
    expect(ts.mapIncrement).toBe(0);
  });

  it("does nothing and spends nothing when the target no longer exists", async () => {
    const { attacker, opponent, combat } = setup();
    opponent.isDefeated = true;
    await applyAgentDecision(combat, "atk", "feat:sc1:opp", "r");
    expect(attacker.token.x).toBe(0);
    expect(turnState(combat).actionsRemaining).toBe(3);
  });
});
