import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  applyAgentDecision,
  getPendingAgentTurn,
} from "../scripts/dungeon-combat.mjs";

// #140: applyAgentDecision has no existing test coverage at all (confirmed
// via `grep -rl applyAgentDecision tests/*.mjs` before writing this file).
// This drives it end-to-end -- real getPendingAgentTurn candidate
// generation, real applyAgentDecision execution -- the same style
// dungeon-combat-agent-turn-line-of-sight.test.mjs already uses for
// getPendingAgentTurn alone, extended with movement speed and a blocker
// token so a "stride:approach" candidate resolves to strideByPosture's new
// "blocked" status.

const GRID_SIZE = 100;
const GRID_DISTANCE_FT = 5;
const MODULE_ID = "pf2e-dungeon-crawl";

function makeToken({ x, y, disposition }) {
  const token = { x, y, disposition };
  token.update = vi.fn(async function (changes) {
    Object.assign(this, changes);
  });
  return token;
}

function makeCombatant({ id, gx, gy, disposition, speedFt = 30 } = {}) {
  const flags = { agentControlled: true };
  return {
    id,
    name: id,
    isDefeated: false,
    token: makeToken({ x: gx * GRID_SIZE, y: gy * GRID_SIZE, disposition }),
    getFlag: (_moduleId, key) => flags[key],
    actor: {
      system: {
        actions: [],
        attributes: { hp: { value: 20, max: 20 } },
        movement: { speeds: { land: { value: speedFt } } },
      },
    },
  };
}

function makeCombat({ attacker, opponent, blocker }) {
  const flags = { dungeonSlot: "slot-1" };
  return {
    id: "combat-1",
    round: 1,
    turn: 0,
    combatant: attacker,
    combatants: [attacker, opponent, blocker],
    getFlag: (_moduleId, key) => flags[key],
    setFlag: async (_moduleId, key, value) => {
      flags[key] = value;
    },
    scene: {
      grid: { size: GRID_SIZE, distance: GRID_DISTANCE_FT },
      walls: { contents: [] },
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
  globalThis.foundry = { utils: {} };
  globalThis.ChatMessage = {
    create: vi.fn(async () => {}),
    getWhisperRecipients: () => [{ id: "gm1" }],
  };
  globalThis.game = { i18n: { format: (key) => key } };
});

describe("applyAgentDecision move-stalled chat card (#140)", () => {
  it("whispers a follow-up 'stalled' chat card when a stride candidate resolves to blocked", async () => {
    // Attacker at (0,0), a blocker one square east (the only cell within
    // reach of the melee-stop clamp), and the actual target two squares
    // east -- a route exists, but the sole landing cell short of melee
    // range is occupied, matching the "blocked" scenario in
    // dungeon-combat-grid-snap.test.mjs's stepToward tests exactly, just
    // reached here through strideByPosture/applyAgentDecision instead.
    const attacker = makeCombatant({
      id: "atk",
      gx: 0,
      gy: 0,
      disposition: -1,
    });
    const blocker = makeCombatant({
      id: "blocker",
      gx: 1,
      gy: 0,
      disposition: -1, // ally -- still occupies a landing cell either way
    });
    const opponent = makeCombatant({
      id: "opp",
      gx: 2,
      gy: 0,
      disposition: 1,
    });
    const combat = makeCombat({ attacker, opponent, blocker });
    combat.scene.width = 4 * GRID_SIZE;
    combat.scene.height = GRID_SIZE;

    const turn = await getPendingAgentTurn(combat);
    const candidate = turn.candidates.find((c) => c.id === "stride:approach:opp");
    expect(candidate).toBeDefined();

    await applyAgentDecision(combat, "atk", candidate.id);

    // Two chat cards: postAgentDecisionChat's pre-move announcement, then
    // the stall follow-up.
    expect(ChatMessage.create).toHaveBeenCalledTimes(2);
    expect(ChatMessage.create.mock.calls[1][0].content).toContain(
      "PF2EDC.Dungeon.Combat.AgentMoveStalled",
    );
    expect(attacker.token.update).not.toHaveBeenCalled();
  });

  it("does not whisper a stall card on a normal successful stride", async () => {
    const attacker = makeCombatant({
      id: "atk",
      gx: 0,
      gy: 0,
      disposition: -1,
    });
    const opponent = makeCombatant({
      id: "opp",
      gx: 5,
      gy: 0,
      disposition: 1,
    });
    const combat = makeCombat({
      attacker,
      opponent,
      blocker: makeCombatant({ id: "far", gx: 20, gy: 20, disposition: -1 }),
    });

    const turn = await getPendingAgentTurn(combat);
    const candidate = turn.candidates.find((c) => c.id === "stride:approach:opp");
    expect(candidate).toBeDefined();

    await applyAgentDecision(combat, "atk", candidate.id);

    expect(ChatMessage.create).toHaveBeenCalledTimes(1);
    expect(attacker.token.update).toHaveBeenCalled();
  });
});
