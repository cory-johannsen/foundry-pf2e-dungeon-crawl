import { describe, it, expect, vi, beforeEach } from "vitest";
import { applyAgentDecision } from "../scripts/dungeon-combat.mjs";

// #925: applyAgentDecision records every executed candidate in the combat's
// agentLog and renders it on one consolidated turn card per (combatant,
// round) -- replacing the old per-decision GM whisper (postAgentDecisionChat),
// the stalled-move whisper (postMoveStalledChat) and the maneuver executor's
// own whisper. Stub shape copied from dungeon-combat-maneuver-execution.test.mjs.

const G = 100;
const MODULE_ID = "pf2e-dungeon-crawl";

function makeToken({ id, x, y, disposition }) {
  const token = { id, x, y, disposition, width: 1, height: 1, hidden: false, name: id };
  token.update = vi.fn(async function (changes) {
    Object.assign(this, changes);
  });
  token.move = vi.fn(async function ({ x, y }) {
    Object.assign(this, { x, y });
  });
  return token;
}

function makeCombatant({ id, gx, gy, disposition }) {
  const flags = { agentControlled: true };
  return {
    id,
    name: id,
    isDefeated: false,
    token: makeToken({ id: `${id}-tok`, x: gx * G, y: gy * G, disposition }),
    getFlag: (_m, key) => flags[key],
    actor: {
      id: `${id}-actor`,
      type: "npc",
      conditions: [],
      items: [],
      itemTypes: { weapon: [] },
      skills: { athletics: {}, intimidation: {} },
      attributes: { immunities: [] },
      increaseCondition: vi.fn(async () => {}),
      applyDamage: vi.fn(async () => {}),
      createEmbeddedDocuments: vi.fn(async () => {}),
      system: {
        actions: [],
        traits: { size: { value: "med" } },
        attributes: { hp: { value: 20, max: 20 } },
        movement: { speeds: { land: { value: 30 } } },
      },
    },
  };
}

function setup({ outcome = "success", opponentAt = [1, 0], blocker = false } = {}) {
  const attacker = makeCombatant({ id: "atk", gx: 0, gy: 0, disposition: -1 });
  const opponent = makeCombatant({ id: "opp", gx: opponentAt[0], gy: opponentAt[1], disposition: 1 });
  const combatants = [attacker, opponent];
  if (blocker) combatants.push(makeCombatant({ id: "blk", gx: 1, gy: 0, disposition: -1 }));
  const flags = {
    dungeonSlot: "slot-1",
    agentTurnState: {
      combatantId: "atk",
      round: 1,
      turn: 0,
      actionsRemaining: 3,
      mapIncrement: 0,
      maneuverPicks: [{ type: "maneuver", slug: "trip", targetId: "opp", rationale: "secret pick reason" }],
      counter: 1,
    },
  };
  const combat = {
    id: "combat-1",
    round: 1,
    turn: 0,
    combatant: attacker,
    combatants,
    flags,
    getFlag: (_m, key) => flags[key],
    setFlag: async (_m, key, value) => {
      flags[key] = value;
    },
    scene: {
      grid: { size: G, distance: 5 },
      width: 8 * G,
      height: G,
      walls: { contents: [] },
      regions: [],
    },
  };
  game.pf2e = { actions: { trip: vi.fn(({ callback }) => callback({ outcome })) } };
  return { attacker, opponent, combat };
}

let messages;
beforeEach(() => {
  globalThis.CONST = {
    WALL_MOVEMENT_TYPES: { NONE: 0, NORMAL: 20 },
    WALL_DOOR_TYPES: { NONE: 0, DOOR: 1, SECRET: 2 },
    WALL_DOOR_STATES: { CLOSED: 0, OPEN: 1, LOCKED: 2 },
  };
  globalThis.foundry = { utils: {} };
  messages = new Map();
  let nextId = 1;
  globalThis.ChatMessage = {
    create: vi.fn(async (data) => {
      const message = { id: `msg${nextId++}`, ...data };
      message.update = vi.fn(async (changes) => Object.assign(message, changes));
      messages.set(message.id, message);
      return message;
    }),
    getSpeaker: vi.fn(({ token }) => ({ token: token?.id })),
    getWhisperRecipients: () => [{ id: "gm1" }],
  };
  globalThis.CONFIG = { Dice: { rolls: [] } };
  globalThis.game = {
    i18n: { format: (key) => key },
    user: { flags: { pf2e: { settings: {} } }, update: vi.fn(async () => {}) },
    combats: { has: () => false },
    time: { worldTime: 1000 },
    messages: { get: (id) => messages.get(id) },
  };
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "debug").mockImplementation(() => {});
});

const cards = () => ChatMessage.create.mock.calls.map(([m]) => m).filter((m) => m.flags?.[MODULE_ID]?.agentTurnCard);

describe("applyAgentDecision AI turn card (#925)", () => {
  it("logs a maneuver with its real outcome and posts one public card -- no separate whisper", async () => {
    const { combat } = setup({ outcome: "success" });
    await applyAgentDecision(combat, "atk", "maneuver:trip:opp", "Knock it down first.");

    const log = combat.flags.agentLog;
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({
      combatantId: "atk",
      tokenId: "atk-tok",
      round: 1,
      turn: 0,
      index: 0,
      candidateId: "maneuver:trip:opp",
      type: "maneuver",
      cost: 1,
      summary: "Trip",
      target: { id: "opp", name: "opp-tok" },
      result: { text: "success: target is Prone", tone: "success" },
      rationale: "Knock it down first.",
      source: "model",
      visibility: "all",
    });

    expect(ChatMessage.create).toHaveBeenCalledOnce();
    const [card] = cards();
    expect(card.whisper).toBeUndefined();
    expect(card.speaker).toEqual({ token: "atk-tok" });
    expect(card.content).toContain("success: target is Prone");
    expect(card.content).toContain('data-visibility="gm" class="pf2edc-agent-rationale"><em>Knock it down first.</em>');
    // The reasoning model's own pick rationale is never in the public summary.
    expect(card.content).not.toContain("secret pick reason");
  });

  it("updates the same card for the second action of the turn instead of posting another", async () => {
    const { combat } = setup({ outcome: "failure" });
    await applyAgentDecision(combat, "atk", "maneuver:trip:opp");
    await applyAgentDecision(combat, "atk", "endTurn");

    expect(cards()).toHaveLength(1);
    const card = messages.get("msg1");
    expect(card.update).toHaveBeenCalledOnce();
    expect(card.content).toContain("failure: no effect");
    expect(card.content).toContain("ends turn");
    expect(combat.flags.agentLog.map((r) => r.index)).toEqual([0, 1]);
  });

  it("records a blocked stride with the GM-only stall note on the card (no separate stall whisper)", async () => {
    const { combat, attacker } = setup({ opponentAt: [2, 0], blocker: true });
    combat.scene.width = 4 * G;
    await applyAgentDecision(combat, "atk", "stride:approach:opp");
    expect(attacker.token.move).not.toHaveBeenCalled();
    expect(ChatMessage.create).toHaveBeenCalledOnce();
    expect(combat.flags.agentLog[0].result).toEqual({ text: "blocked", tone: "failure" });
    expect(cards()[0].content).toMatch(/data-visibility="gm" class="pf2edc-agent-note">A route exists, but every reachable square is occupied/);
  });

  it("whispers the card to the GM and marks the record GM-only when the acting token is hidden", async () => {
    const { combat, attacker } = setup();
    attacker.token.hidden = true;
    await applyAgentDecision(combat, "atk", "maneuver:trip:opp");
    expect(combat.flags.agentLog[0].visibility).toBe("gm");
    expect(cards()[0].whisper).toEqual(["gm1"]);
  });

  it("still logs the action and advances the turn state when the card cannot be created", async () => {
    const { combat } = setup();
    ChatMessage.create = vi.fn(async () => {
      throw new Error("chat down");
    });
    vi.spyOn(console, "error").mockImplementation(() => {});
    await applyAgentDecision(combat, "atk", "maneuver:trip:opp");
    expect(combat.flags.agentLog).toHaveLength(1);
    expect(combat.flags.agentTurnState.actionsRemaining).toBe(2);
    expect(console.error).toHaveBeenCalled();
  });

  it("starts a new card for the same combatant's next round", async () => {
    const { combat } = setup();
    await applyAgentDecision(combat, "atk", "maneuver:trip:opp");
    combat.round = 2;
    combat.flags.agentTurnState = { ...combat.flags.agentTurnState, round: 2, actionsRemaining: 3, counter: 5 };
    await applyAgentDecision(combat, "atk", "endTurn");
    expect(cards()).toHaveLength(2);
    expect(combat.flags.agentTurnCards).toEqual({ "atk:1": "msg1", "atk:2": "msg2" });
  });
});
