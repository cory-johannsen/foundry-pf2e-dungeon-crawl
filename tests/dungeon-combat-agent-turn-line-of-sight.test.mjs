import { describe, it, expect, beforeEach } from "vitest";
import { getPendingAgentTurn } from "../scripts/dungeon-combat.mjs";

// #91: getPendingAgentTurn is the single read surface tools/agent-loop's
// poller uses to decide an agent-controlled combatant's turn -- it builds
// the `opponents` list (with each one's own `distanceSquares`) and the
// `candidates` list (buildCandidateList, agent-candidates.mjs) an external
// agent picks from. Before #91's fix, an opponent behind a solid wall was
// still offered as a full-fledged strike candidate purely because it was
// within reach's grid distance. These are integration tests: real
// getPendingAgentTurn, exercising the actual wiring from real wall
// documents through to the candidate list an agent would receive, not just
// the isolated pure/glue pieces `agent-candidates.test.mjs` and
// `dungeon-combat-line-of-sight.test.mjs` already cover.

const GRID_SIZE = 100;
const GRID_DISTANCE_FT = 5;
const MODULE_ID = "pf2e-dungeon-crawl";

function verticalWall(gx, gyLo, gyHi) {
  return {
    move: 20,
    door: 0,
    ds: 0,
    c: [gx * GRID_SIZE, gyLo * GRID_SIZE, gx * GRID_SIZE, gyHi * GRID_SIZE],
  };
}

function makeClawAction() {
  return {
    type: "strike",
    ready: true,
    slug: "claw",
    label: "Claw",
    traits: [],
    variants: [{}],
    item: { slug: "claw", isRanged: false, system: {} },
  };
}

function makeCombatant({ id, gx, gy, disposition, hp = 20 } = {}) {
  const flags = { agentControlled: true };
  return {
    id,
    name: id,
    isDefeated: false,
    token: { x: gx * GRID_SIZE, y: gy * GRID_SIZE, disposition },
    getFlag: (_moduleId, key) => flags[key],
    actor: {
      system: {
        actions: [makeClawAction()],
        attributes: { hp: { value: hp, max: hp } },
      },
    },
  };
}

function makeCombat({ attacker, opponent, walls = [] }) {
  const flags = { dungeonSlot: "slot-1" };
  return {
    id: "combat-1",
    round: 1,
    turn: 0,
    combatant: attacker,
    combatants: [attacker, opponent],
    getFlag: (_moduleId, key) => flags[key],
    scene: {
      grid: { size: GRID_SIZE, distance: GRID_DISTANCE_FT },
      walls: { contents: walls },
      regions: [],
    },
  };
}

beforeEach(() => {
  globalThis.CONST = {
    WALL_MOVEMENT_TYPES: { NONE: 0, NORMAL: 20 },
    WALL_DOOR_TYPES: { NONE: 0, DOOR: 1, SECRET: 2 },
    WALL_DOOR_STATES: { CLOSED: 0, OPEN: 1, LOCKED: 2 },
  };
});

describe("getPendingAgentTurn line of sight (#91)", () => {
  it("marks an adjacent opponent with a clear line of sight as visible and offers a strike candidate", async () => {
    const attacker = makeCombatant({
      id: "atk",
      gx: 0,
      gy: 0,
      disposition: -1,
    });
    const opponent = makeCombatant({ id: "opp", gx: 1, gy: 0, disposition: 1 });
    const combat = makeCombat({ attacker, opponent, walls: [] });

    const turn = await getPendingAgentTurn(combat);

    expect(turn.context.opponents).toEqual([
      {
        id: "opp",
        name: "opp",
        distanceSquares: 1,
        hp: 20,
        hasLineOfSight: true,
      },
    ]);
    expect(turn.candidates.some((c) => c.id === "strike:claw:opp")).toBe(true);
  });

  it("excludes an in-reach opponent separated by a solid wall from strike candidates, and flags it not visible", async () => {
    const attacker = makeCombatant({
      id: "atk",
      gx: 0,
      gy: 0,
      disposition: -1,
    });
    const opponent = makeCombatant({ id: "opp", gx: 1, gy: 0, disposition: 1 });
    // A wall directly between the attacker's cell and the opponent's cell.
    const combat = makeCombat({
      attacker,
      opponent,
      walls: [verticalWall(1, 0, 1)],
    });

    const turn = await getPendingAgentTurn(combat);

    expect(turn.candidates.some((c) => c.id === "strike:claw:opp")).toBe(false);
    expect(turn.candidates.some((c) => c.id === "endTurn")).toBe(true);
  });

  it("never hops a chain spell between two opponents with a wall between them", async () => {
    const attacker = makeCombatant({
      id: "atk",
      gx: 0,
      gy: 0,
      disposition: -1,
    });
    const opp1 = makeCombatant({ id: "opp1", gx: 1, gy: 0, disposition: 1 });
    const opp2 = makeCombatant({ id: "opp2", gx: 2, gy: 0, disposition: 1 });
    const chainSpell = {
      id: "sp1",
      slug: "chain-lightning",
      name: "Chain Lightning",
      system: {
        area: null,
        target: {
          value: "1 creature, plus any number of additional creatures",
        },
        defense: { save: { statistic: "reflex" }, basic: true },
        damage: { d1: {} },
        time: { value: "2" },
        range: { value: "500 feet" },
        description: {
          value:
            "The electricity arcs to another creature within 30 feet of the first target, jumps to another creature within 30 feet of that target, and so on.",
        },
      },
    };
    attacker.actor.spellcasting = {
      contents: [{ id: "entry1", spells: { contents: [chainSpell] } }],
    };

    // A wall directly between opp1 and opp2 -- both are still individually
    // visible (and in range) from the attacker.
    const combat = {
      id: "combat-1",
      round: 1,
      turn: 0,
      combatant: attacker,
      combatants: [attacker, opp1, opp2],
      getFlag: (_moduleId, key) => ({ dungeonSlot: "slot-1" })[key],
      scene: {
        grid: { size: GRID_SIZE, distance: GRID_DISTANCE_FT },
        walls: { contents: [verticalWall(2, 0, 1)] },
        regions: [],
      },
    };

    const turn = await getPendingAgentTurn(combat);
    const chainCandidate = turn.candidates.find((c) => c.type === "castChain");
    expect(chainCandidate).toBeDefined();
    expect(chainCandidate.chainedIds).toEqual([]);
  });

  it("still hops a chain spell between two opponents when nothing blocks the line between them", async () => {
    const attacker = makeCombatant({
      id: "atk",
      gx: 0,
      gy: 0,
      disposition: -1,
    });
    const opp1 = makeCombatant({ id: "opp1", gx: 1, gy: 0, disposition: 1 });
    const opp2 = makeCombatant({ id: "opp2", gx: 2, gy: 0, disposition: 1 });
    const chainSpell = {
      id: "sp1",
      slug: "chain-lightning",
      name: "Chain Lightning",
      system: {
        area: null,
        target: {
          value: "1 creature, plus any number of additional creatures",
        },
        defense: { save: { statistic: "reflex" }, basic: true },
        damage: { d1: {} },
        time: { value: "2" },
        range: { value: "500 feet" },
        description: {
          value:
            "The electricity arcs to another creature within 30 feet of the first target, jumps to another creature within 30 feet of that target, and so on.",
        },
      },
    };
    attacker.actor.spellcasting = {
      contents: [{ id: "entry1", spells: { contents: [chainSpell] } }],
    };

    const combat = {
      id: "combat-1",
      round: 1,
      turn: 0,
      combatant: attacker,
      combatants: [attacker, opp1, opp2],
      getFlag: (_moduleId, key) => ({ dungeonSlot: "slot-1" })[key],
      scene: {
        grid: { size: GRID_SIZE, distance: GRID_DISTANCE_FT },
        walls: { contents: [] },
        regions: [],
      },
    };

    const turn = await getPendingAgentTurn(combat);
    const chainCandidate = turn.candidates.find((c) => c.type === "castChain");
    expect(chainCandidate).toBeDefined();
    expect(chainCandidate.chainedIds).toEqual(["opp2"]);
  });

  it("excludes an opponent behind a wall from a target-count spell's targets", async () => {
    const attacker = makeCombatant({
      id: "atk",
      gx: 0,
      gy: 0,
      disposition: -1,
    });
    const opp1 = makeCombatant({ id: "opp1", gx: 1, gy: 0, disposition: 1 });
    const opp2 = makeCombatant({ id: "opp2", gx: 2, gy: 0, disposition: 1 });
    const targetCountSpell = {
      id: "sp2",
      slug: "rebuke-death",
      name: "Rebuke Death",
      system: {
        target: { value: "2 creatures per action spent" },
        time: { value: "1 to 3" },
        damage: { d1: {} },
        area: { value: 100 },
        defense: { save: { statistic: "fortitude" }, basic: false },
      },
    };
    attacker.actor.spellcasting = {
      contents: [{ id: "entry1", spells: { contents: [targetCountSpell] } }],
    };

    const combat = {
      id: "combat-1",
      round: 1,
      turn: 0,
      combatant: attacker,
      combatants: [attacker, opp1, opp2],
      getFlag: (_moduleId, key) => ({ dungeonSlot: "slot-1" })[key],
      scene: {
        grid: { size: GRID_SIZE, distance: GRID_DISTANCE_FT },
        // Wall between the attacker and opp2 only.
        walls: { contents: [verticalWall(2, 0, 1)] },
        regions: [],
      },
    };

    const turn = await getPendingAgentTurn(combat);
    const targetCountCandidate = turn.candidates.find(
      (c) => c.type === "castTargetCount",
    );
    expect(targetCountCandidate).toBeDefined();
    expect(targetCountCandidate.targetIds).toEqual(["opp1"]);
  });

  it("excludes an opponent behind a wall from a dual-nature spell's harm-direction single-target tier", async () => {
    const attacker = makeCombatant({
      id: "atk",
      gx: 0,
      gy: 0,
      disposition: -1,
    });
    const opponent = makeCombatant({ id: "opp", gx: 1, gy: 0, disposition: 1 });
    // Harm's own real description (agent-candidates.test.mjs's own
    // parseActionGlyphTiers fixture): tier 1 is touch range.
    const harmDescription =
      '<p>You channel void energy to harm the living or heal the undead. If the target is a living creature, you deal 1d8 void damage to it, and it gets a basic Fortitude save. If the target is a willing undead creature, you restore that amount of Hit Points. The number of actions you spend when Casting this Spell determines its targets, range, area, and other parameters.</p>\n<p><span class="action-glyph">1</span> The spell has a range of touch.</p>\n<p><span class="action-glyph">2</span> (concentrate) The spell has a range of 30 feet. If you\'re healing an undead creature, increase the Hit Points restored by 8.</p>\n<p><span class="action-glyph">3</span> (concentrate) You disperse void energy in a @Template[emanation|distance:30]. This targets all living and undead creatures in the area.</p>';
    const harmSpell = {
      id: "sp3",
      slug: "harm",
      name: "Harm",
      system: {
        time: { value: "1 to 3" },
        defense: { save: { statistic: "fortitude" }, basic: true },
        damage: { d1: {} },
        target: { value: "one living or undead creature" },
        traits: { value: [] },
        description: { value: harmDescription },
      },
    };
    attacker.actor.spellcasting = {
      contents: [{ id: "entry1", spells: { contents: [harmSpell] } }],
    };

    const combat = {
      id: "combat-1",
      round: 1,
      turn: 0,
      combatant: attacker,
      combatants: [attacker, opponent],
      getFlag: (_moduleId, key) => ({ dungeonSlot: "slot-1" })[key],
      scene: {
        grid: { size: GRID_SIZE, distance: GRID_DISTANCE_FT },
        walls: { contents: [verticalWall(1, 0, 1)] },
        regions: [],
      },
    };

    const turn = await getPendingAgentTurn(combat);
    expect(turn.candidates.some((c) => c.type === "castDualHarm")).toBe(false);
  });
});
