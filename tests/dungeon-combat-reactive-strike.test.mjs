import { describe, it, expect } from "vitest";
import {
  findReactiveStrikeOpportunities,
  offerReactiveStrikesAgainst,
  handleRangedAttackForReactiveStrike,
  strideByPosture,
  stepToward,
} from "../scripts/dungeon-combat.mjs";

function makeStrike({
  slug = "claw",
  label = "Claw",
  reach = null,
  isRanged = false,
  rangeIncrementFt = null,
} = {}) {
  return {
    type: "strike",
    ready: true,
    slug,
    label,
    traits: reach ? [{ name: `reach-${reach}` }] : [],
    item: {
      slug,
      isRanged,
      system: rangeIncrementFt
        ? { range: { increment: rangeIncrementFt } }
        : {},
    },
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

  it("excludes a reactor whose only ready Strike is ranged, even if its range increment would cover the mover", () => {
    const mover = makeMover();
    const reactor = makeReactor({
      id: "r1",
      x: 500,
      y: 0,
      strikes: [makeStrike({ slug: "bow", isRanged: true, rangeIncrementFt: 60 })],
    });
    const combat = makeCombat({ combatants: [mover, reactor] });

    expect(
      findReactiveStrikeOpportunities(combat, mover, GRID_SIZE, GRID_DISTANCE_FT),
    ).toEqual([]);
  });

  it("picks the melee Strike over a ranged one when both are ready", () => {
    const mover = makeMover();
    const reactor = makeReactor({
      id: "r1",
      x: 100,
      y: 0,
      strikes: [
        makeStrike({ slug: "bow", isRanged: true, rangeIncrementFt: 60 }),
        makeStrike({ slug: "claw", isRanged: false }),
      ],
    });
    const combat = makeCombat({ combatants: [mover, reactor] });

    expect(
      findReactiveStrikeOpportunities(combat, mover, GRID_SIZE, GRID_DISTANCE_FT),
    ).toEqual([{ reactor, actionSlug: "claw" }]);
  });
});

function installFoundryStubs() {
  globalThis.foundry = { utils: {} };
  globalThis.ChatMessage = {
    create: async (data) => {
      ChatMessage.calls.push(data);
    },
    calls: [],
  };
  globalThis.game = {
    user: {
      isGM: true,
      flags: { pf2e: { settings: {} } },
      update: async () => {},
    },
    i18n: { format: (key) => key },
    messages: { contents: [] },
    combats: { contents: [] },
  };
}

function makeStrikeAction({ slug = "claw", label = "Claw", outcome = "success" } = {}) {
  return {
    type: "strike",
    ready: true,
    slug,
    label,
    traits: [],
    item: { slug, isRanged: false, system: {} },
    variants: [
      {
        roll: async () => {
          game.messages.contents.push({
            flags: { pf2e: { context: { outcome } } },
          });
        },
      },
    ],
    damage: async () => ({ total: 4 }),
  };
}

function makeFullReactor({
  id,
  x,
  y,
  disposition = 1,
  itemName = "Reactive Strike",
  strike = makeStrikeAction(),
  name = "Test Reactor",
} = {}) {
  const flags = { agentControlled: true };
  return {
    id,
    name,
    tokenId: `${id}-token`,
    isDefeated: false,
    token: { x, y, disposition },
    getFlag: (_moduleId, key) => flags[key],
    actor: {
      type: "npc",
      items: [
        {
          type: "action",
          system: { actionType: { value: "reaction" } },
          name: itemName,
        },
      ],
      system: { actions: [strike] },
    },
  };
}

function makeFullCombat({ round = 1, combatants = [], sceneId = "scene1" } = {}) {
  const flags = { dungeonSlot: 1 };
  return {
    round,
    combatants,
    scene: { id: sceneId, grid: { size: 100, distance: 5 }, tokens: [] },
    getFlag: (_moduleId, key) => flags[key],
    setFlag: async (_moduleId, key, value) => {
      flags[key] = value;
    },
  };
}

// The struck target (not the reactor) is who rollAndApplyStrikeAtVariant's
// `target.actor.applyDamage` and `applyDefeatIfReducedToZero` read — this
// double stands in for the mover/attacker being reacted against.
function makeMoverTarget({ id = "mover1", x = 0, y = 0, disposition = -1, name = "Test Mover" } = {}) {
  const applyDamageCalls = [];
  return {
    id,
    name,
    isDefeated: false,
    token: { x, y, disposition },
    actor: {
      type: "character",
      applyDamage: async (args) => {
        applyDamageCalls.push(args);
      },
      system: { attributes: { hp: { value: 10 } } },
    },
    applyDamageCalls,
  };
}

describe("offerReactiveStrikesAgainst", () => {
  it("marks the reaction used, rolls the Strike, applies damage, and posts a chat message", async () => {
    installFoundryStubs();
    const mover = makeMoverTarget();
    const reactor = makeFullReactor({ id: "r1", x: 100, y: 0 });
    const combat = makeFullCombat({ combatants: [mover, reactor] });

    await offerReactiveStrikesAgainst(combat, mover);

    expect(await combat.getFlag("pf2e-dungeon-crawl", "reactionUsed")).toEqual({ r1: 1 });
    expect(mover.applyDamageCalls).toHaveLength(1);
    expect(ChatMessage.calls).toHaveLength(1);
    expect(ChatMessage.calls[0].content).toBe("PF2EDC.Dungeon.Combat.ReactiveStrikeChat");
  });

  it("does nothing when no reactor is eligible", async () => {
    installFoundryStubs();
    const mover = makeMoverTarget();
    const combat = makeFullCombat({ combatants: [mover] });

    await expect(offerReactiveStrikesAgainst(combat, mover)).resolves.toBeUndefined();
  });

  it("does nothing when the combat isn't owned by this module", async () => {
    installFoundryStubs();
    const mover = makeMoverTarget();
    const reactor = makeFullReactor({ id: "r1", x: 100, y: 0 });
    const setFlagCalls = [];
    const combat = {
      round: 1,
      combatants: [mover, reactor],
      scene: { id: "scene1", grid: { size: 100, distance: 5 }, tokens: [] },
      getFlag: () => undefined,
      setFlag: async (_moduleId, key, value) => {
        setFlagCalls.push({ key, value });
      },
    };

    await expect(offerReactiveStrikesAgainst(combat, mover)).resolves.toBeUndefined();

    expect(setFlagCalls).toHaveLength(0);
    expect(mover.applyDamageCalls).toHaveLength(0);
    expect(ChatMessage.calls).toHaveLength(0);
  });
});

describe("handleRangedAttackForReactiveStrike", () => {
  it("resolves the combat and attacker from the chat message and delegates to offerReactiveStrikesAgainst", async () => {
    installFoundryStubs();
    const attacker = { ...makeMoverTarget({ id: "mover1" }), tokenId: "attacker-token" };
    const reactor = makeFullReactor({ id: "r1", x: 100, y: 0 });
    const combat = makeFullCombat({ combatants: [attacker, reactor] });
    game.combats.contents.push(combat);

    const message = {
      flags: { pf2e: { context: { type: "attack-roll", options: ["ranged"] } } },
      speaker: { scene: "scene1", token: "attacker-token" },
    };

    await handleRangedAttackForReactiveStrike(message);

    expect(await combat.getFlag("pf2e-dungeon-crawl", "reactionUsed")).toEqual({ r1: 1 });
  });
});

describe("strideByPosture (Reactive Strike wiring)", () => {
  it("offers a Reactive Strike after a real move ends within a reactor's reach", async () => {
    installFoundryStubs();
    const reactor = makeFullReactor({ id: "r1", x: 400, y: 0 });
    const mover = makeMoverTarget();
    mover.token.update = async function (changes) {
      Object.assign(this, changes);
    };
    mover.actor.system.movement = { speeds: { land: { value: 30 } } };
    const combat = makeFullCombat({ combatants: [mover, reactor] });

    await strideByPosture(combat, mover, "approach", { token: { x: 400, y: 0 } });

    expect(mover.token.x).toBe(300);
    expect(await combat.getFlag("pf2e-dungeon-crawl", "reactionUsed")).toEqual({ r1: 1 });
  });

  it("does not trigger a Reactive Strike on a no-op move (no speed)", async () => {
    installFoundryStubs();
    const reactor = makeFullReactor({ id: "r1", x: 100, y: 0 });
    const mover = {
      id: "mover1",
      isDefeated: false,
      token: {
        x: 0,
        y: 0,
        disposition: -1,
        update: async () => {
          throw new Error("should not move: speed is 0");
        },
      },
      actor: { system: { movement: { speeds: { land: { value: 0 } } } } },
    };
    const combat = makeFullCombat({ combatants: [mover, reactor] });

    await strideByPosture(combat, mover, "approach", { token: { x: 100, y: 0 } });

    expect(await combat.getFlag("pf2e-dungeon-crawl", "reactionUsed")).toBeUndefined();
  });
});

describe("stepToward (Reactive Strike wiring)", () => {
  it("offers a Reactive Strike after a real move ends within a reactor's reach", async () => {
    installFoundryStubs();
    const reactor = makeFullReactor({ id: "r1", x: 400, y: 0 });
    const mover = makeMoverTarget();
    mover.token.update = async function (changes) {
      Object.assign(this, changes);
    };
    mover.actor.system.movement = { speeds: { land: { value: 30 } } };
    const combat = makeFullCombat({ combatants: [mover, reactor] });

    await stepToward(combat, mover, { token: { x: 400, y: 0 } }, 4);

    expect(mover.token.x).toBe(300);
    expect(await combat.getFlag("pf2e-dungeon-crawl", "reactionUsed")).toEqual({ r1: 1 });
  });

  it("does not trigger a Reactive Strike on a no-op move (distanceSquares at MELEE_REACH_SQUARES)", async () => {
    installFoundryStubs();
    const reactor = makeFullReactor({ id: "r1", x: 100, y: 0 });
    const mover = {
      id: "mover1",
      isDefeated: false,
      token: {
        x: 0,
        y: 0,
        disposition: -1,
        update: async () => {
          throw new Error("should not move: distanceSquares <= MELEE_REACH_SQUARES");
        },
      },
      actor: { system: { movement: { speeds: { land: { value: 30 } } } } },
    };
    const combat = makeFullCombat({ combatants: [mover, reactor] });

    await stepToward(combat, mover, { token: { x: 100, y: 0 } }, 1);

    expect(await combat.getFlag("pf2e-dungeon-crawl", "reactionUsed")).toBeUndefined();
  });

  it("routes around a hostile creature instead of moving through it (#27)", async () => {
    installFoundryStubs();
    // The blocker sits at (3,-1) — the REAL unobstructed path's own
    // landing waypoint for this exact mover/target/speed scenario
    // (confirmed by the trace note above and the two ally tests that
    // follow: (0,0) -> (1,-1) -> (2,-2) -> (3,-1) -> (4,0), landing at
    // (3,-1) i.e. pixel (300,-100)). Placing it anywhere off that real
    // path (e.g. the naive straight-line cell (1,0)/(100,0), the original
    // vacuous placement) would make this test pass identically whether or
    // not hostile-edge-blocking exists, since the unobstructed route never
    // touches it either. Placing it at an earlier intermediate cell like
    // (1,-1) instead is *also* insufficient here: blocking that one edge
    // does force a different route (confirmed by tracing findPath
    // directly), but that alternate route still happens to land on the
    // exact same final cell (3,-1) — so only a landing-cell assertion
    // (below) would stay vacuous even though the mechanism fired. Blocking
    // the landing cell itself is what actually forces a *different final
    // position*, which is what the assertions below can observe.
    const blocker = makeFullReactor({ id: "blocker", x: 300, y: -100 });
    const farTarget = makeFullReactor({ id: "far", x: 400, y: 0 });
    const mover = makeMoverTarget();
    mover.token.update = async function (changes) {
      Object.assign(this, changes);
    };
    mover.actor.system.movement = { speeds: { land: { value: 30 } } };
    const combat = makeFullCombat({ combatants: [mover, blocker, farTarget] });

    await stepToward(combat, mover, { token: { x: 400, y: 0 } }, 4);

    // Must not have stopped on top of the blocker — which, since the
    // blocker sits exactly on the baseline unblocked landing cell here,
    // also proves the route genuinely changed because of it: if the mover
    // landed there anyway, the blocker had no effect and this test would
    // still be vacuous.
    expect(mover.token.x === 300 && mover.token.y === -100).toBe(false);
    // Must still have reached adjacency (within MELEE_REACH_SQUARES) of
    // the far target despite the detour.
    const distanceToTarget = Math.max(
      Math.abs(mover.token.x - 400) / 100,
      Math.abs(mover.token.y - 0) / 100,
    );
    expect(distanceToTarget).toBeLessThanOrEqual(1);
  });

  // #27 trace note: with no hostiles blocking (an ally never enters
  // hostileFootprints), findPath's own tie-breaking between equal-f-score
  // neighbors (DIRECTIONS explores (-1,-1)/(0,-1)/(1,-1) before (-1,0)/(1,0),
  // and Map iteration keeps first-inserted on a tie) picks a diagonal
  // zigzag for this straight east-facing approach, not the naive straight
  // line: (0,0) -> (1,-1) -> (2,-2) -> (3,-1) -> (4,0). Confirmed by
  // instrumenting findPath/walkPath directly against this exact start/goal.
  // With no occupant at all, walkPath's MELEE_REACH_SQUARES=1 clamp lands
  // the mover on (3,-1) — pixel (300,-100), NOT (300,0) as a naive
  // straight-line trace would suggest. So an ally literally at (300,0)
  // never sits on the path at all, and wouldn't exercise the landing-block
  // logic. The two tests below place the ally on the real path's own
  // natural-landing cell (300,-100) and on an earlier real path cell
  // (100,-100) respectively, so they actually exercise walkPath's
  // occupant-skipping behavior instead of coincidentally passing.
  it("does not end movement standing on an ally's square, even when that's the natural stopping cell (#27)", async () => {
    installFoundryStubs();
    const allyInTheWay = {
      id: "ally1",
      isDefeated: false,
      token: { x: 300, y: -100, disposition: -1 },
      actor: { system: {} },
    };
    const mover = makeMoverTarget();
    mover.token.update = async function (changes) {
      Object.assign(this, changes);
    };
    mover.actor.system.movement = { speeds: { land: { value: 30 } } };
    const combat = makeFullCombat({ combatants: [mover, allyInTheWay] });

    await stepToward(combat, mover, { token: { x: 400, y: 0 } }, 4);

    // Backs off to the previous real-path cell (200,-200) instead of
    // landing on the ally's square.
    expect(mover.token.x).toBe(200);
    expect(mover.token.y).toBe(-200);
  });

  it("passes through an ally's square without stopping there, when a free square lies beyond it (#27)", async () => {
    installFoundryStubs();
    const allyPassedThrough = {
      id: "ally1",
      isDefeated: false,
      token: { x: 100, y: -100, disposition: -1 },
      actor: { system: {} },
    };
    const mover = makeMoverTarget();
    mover.token.update = async function (changes) {
      Object.assign(this, changes);
    };
    mover.actor.system.movement = { speeds: { land: { value: 30 } } };
    const combat = makeFullCombat({ combatants: [mover, allyPassedThrough] });

    await stepToward(combat, mover, { token: { x: 400, y: 0 } }, 4);

    // Same result as if the ally weren't there at all (300,-100) — proves
    // the ally's square didn't block the route, only prevented landing
    // exactly on it.
    expect(mover.token.x).toBe(300);
    expect(mover.token.y).toBe(-100);
  });
});
