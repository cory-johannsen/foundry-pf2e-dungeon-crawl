import { describe, it, expect } from "vitest";
import { findReactiveStrikeOpportunities } from "../scripts/dungeon-combat.mjs";

function makeStrike({ slug = "claw", label = "Claw", reach = null } = {}) {
  return {
    type: "strike",
    ready: true,
    slug,
    label,
    traits: reach ? [{ name: `reach-${reach}` }] : [],
    item: { slug },
  };
}

function makeReactor({
  id,
  x,
  y,
  disposition = 1,
  agentControlled = true,
  itemName = "Reactive Strike",
  strikes = [makeStrike()],
} = {}) {
  const flags = { agentControlled };
  return {
    id,
    isDefeated: false,
    token: { x, y, disposition },
    getFlag: (_moduleId, key) => flags[key],
    actor: {
      items: [
        {
          type: "action",
          system: { actionType: { value: "reaction" } },
          name: itemName,
        },
      ],
      system: { actions: strikes },
    },
  };
}

function makeMover({ id = "mover1", x = 0, y = 0, disposition = -1 } = {}) {
  return { id, isDefeated: false, token: { x, y, disposition } };
}

function makeCombat({ round = 1, combatants = [], reactionUsed = {} } = {}) {
  const flags = { reactionUsed: { ...reactionUsed } };
  return {
    round,
    combatants,
    getFlag: (_moduleId, key) => flags[key],
  };
}

const GRID_SIZE = 100;
const GRID_DISTANCE_FT = 5;

describe("findReactiveStrikeOpportunities", () => {
  it("finds an eligible reactor with a ready Strike in reach", () => {
    const mover = makeMover();
    const reactor = makeReactor({ id: "r1", x: 100, y: 0 });
    const combat = makeCombat({ combatants: [mover, reactor] });

    expect(
      findReactiveStrikeOpportunities(combat, mover, GRID_SIZE, GRID_DISTANCE_FT),
    ).toEqual([{ reactor, actionSlug: "claw" }]);
  });

  it("excludes a reactor that isn't agent-controlled", () => {
    const mover = makeMover();
    const reactor = makeReactor({ id: "r1", x: 100, y: 0, agentControlled: false });
    const combat = makeCombat({ combatants: [mover, reactor] });

    expect(
      findReactiveStrikeOpportunities(combat, mover, GRID_SIZE, GRID_DISTANCE_FT),
    ).toEqual([]);
  });

  it("excludes a reactor that already used its reaction this round", () => {
    const mover = makeMover();
    const reactor = makeReactor({ id: "r1", x: 100, y: 0 });
    const combat = makeCombat({
      combatants: [mover, reactor],
      round: 2,
      reactionUsed: { r1: 2 },
    });

    expect(
      findReactiveStrikeOpportunities(combat, mover, GRID_SIZE, GRID_DISTANCE_FT),
    ).toEqual([]);
  });

  it("excludes a reactor with no in-scope Reactive Strike item", () => {
    const mover = makeMover();
    const reactor = makeReactor({ id: "r1", x: 100, y: 0, itemName: "Aid" });
    const combat = makeCombat({ combatants: [mover, reactor] });

    expect(
      findReactiveStrikeOpportunities(combat, mover, GRID_SIZE, GRID_DISTANCE_FT),
    ).toEqual([]);
  });

  it("excludes a reactor with no ready Strike within reach", () => {
    const mover = makeMover();
    const reactor = makeReactor({ id: "r1", x: 1000, y: 0 });
    const combat = makeCombat({ combatants: [mover, reactor] });

    expect(
      findReactiveStrikeOpportunities(combat, mover, GRID_SIZE, GRID_DISTANCE_FT),
    ).toEqual([]);
  });

  it("matches the weapon-restricted Strike among several ready actions", () => {
    const mover = makeMover();
    const reactor = makeReactor({
      id: "r1",
      x: 100,
      y: 0,
      itemName: "Attack of Opportunity (Claw Only)",
      strikes: [makeStrike({ slug: "claw" }), makeStrike({ slug: "bite" })],
    });
    const combat = makeCombat({ combatants: [mover, reactor] });

    expect(
      findReactiveStrikeOpportunities(combat, mover, GRID_SIZE, GRID_DISTANCE_FT),
    ).toEqual([{ reactor, actionSlug: "claw" }]);
  });
});
