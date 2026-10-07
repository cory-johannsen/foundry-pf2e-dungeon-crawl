import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  getPendingAgentTurn,
  playHeuristicTurn,
  findReactiveStrikeOpportunities,
  stepToward,
  strideByPosture,
} from "../scripts/dungeon-combat.mjs";

// #410: hostile AI must not target unconscious/dying party members, but a
// downed PC still physically occupies and blocks its square.

const G = 100;

beforeEach(() => {
  globalThis.CONST = {
    WALL_MOVEMENT_TYPES: { NONE: 0, NORMAL: 20 },
    WALL_DOOR_TYPES: { NONE: 0, DOOR: 1, SECRET: 2 },
    WALL_DOOR_STATES: { CLOSED: 0, OPEN: 1, LOCKED: 2 },
  };
  globalThis.foundry = { utils: {} };
  globalThis.ChatMessage = { create: async () => {}, getWhisperRecipients: () => [] };
  globalThis.game = {
    user: { isGM: true, flags: { pf2e: { settings: {} } }, update: async () => {} },
    i18n: { format: (k) => k },
    messages: { contents: [] },
    combats: { contents: [], has: () => false },
    modules: { get: () => ({ version: "0" }) },
  };
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "debug").mockImplementation(() => {});
});

function claw() {
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

function mk(id, gx, gy, disposition, { type = "character", conds = [], agent = true } = {}) {
  const flags = { agentControlled: agent };
  return {
    id,
    name: id,
    isDefeated: false,
    token: {
      x: gx * G,
      y: gy * G,
      disposition,
      width: 1,
      height: 1,
      update: vi.fn(async function (c) {
        Object.assign(this, c);
      }),
      // #631: positions are written via move({x, y, action: "displace"}).
      move: vi.fn(async function ({ x, y }) {
        Object.assign(this, { x, y });
      }),
    },
    getFlag: (_m, k) => flags[k],
    actor: {
      type,
      conditions: conds.map((slug) => ({ slug })),
      items: [
        {
          type: "action",
          system: { actionType: { value: "reaction" } },
          name: "Reactive Strike",
        },
      ],
      system: {
        actions: [claw()],
        attributes: { hp: { value: 20, max: 20 } },
        movement: { speeds: { land: { value: 30 } } },
      },
    },
  };
}

function mkCombat(combatants, current) {
  const flags = { dungeonSlot: "slot-1", reactionUsed: {} };
  return {
    id: "c1",
    round: 1,
    turn: 0,
    combatant: current,
    combatants,
    getFlag: (_m, k) => flags[k],
    setFlag: async () => {},
    scene: {
      id: "s",
      grid: { size: G, distance: 5 },
      width: 10 * G,
      height: 3 * G,
      tokens: [],
      walls: { contents: [] },
      regions: [],
    },
  };
}

describe("hostile AI skips downed PCs (#410)", () => {
  for (const cond of ["unconscious", "dying"]) {
    it(`(a) getPendingAgentTurn omits a ${cond} PC but keeps a conscious one`, async () => {
      const me = mk("atk", 0, 0, -1, { type: "npc" });
      const down = mk("down", 0, 1, 1, { conds: [cond] });
      const up = mk("up", 1, 0, 1);
      const combat = mkCombat([me, down, up], me);
      const turn = await getPendingAgentTurn(combat);
      expect(turn.context.opponents.map((o) => o.id)).toEqual(["up"]);
      for (const c of turn.candidates) expect(JSON.stringify(c)).not.toContain("down");
      expect(turn.candidates.some((c) => c.id === "strike:claw:up")).toBe(true);
    });
  }

  it("(b) nearestOpponent skips a downed PC for a farther conscious one", async () => {
    const me = mk("atk", 0, 0, -1, { type: "npc" });
    const down = mk("down", 1, 0, 1, { conds: ["unconscious"] });
    const up = mk("up", 5, 0, 1);
    const combat = mkCombat([me, down, up], me);
    const move = vi.fn(async () => {});
    const strike = vi.fn(async () => {});
    await playHeuristicTurn(combat, me, { move, strike, delayMs: 0 });
    expect(move.mock.calls[0][2].id).toBe("up");
    expect(strike.mock.calls[0][2].id).toBe("up");
  });

  it("(b2) nearestOpponent returns nothing when only downed PCs remain", async () => {
    const me = mk("atk", 0, 0, -1, { type: "npc" });
    const down = mk("down", 1, 0, 1, { conds: ["dying"] });
    const combat = mkCombat([me, down], me);
    const move = vi.fn(async () => {});
    const strike = vi.fn(async () => {});
    await playHeuristicTurn(combat, me, { move, strike, delayMs: 0 });
    expect(move).not.toHaveBeenCalled();
    expect(strike).not.toHaveBeenCalled();
  });

  it("(c) a downed agent-controlled PC is not offered a Reactive Strike", () => {
    const mover = mk("mover", 0, 0, -1, { type: "npc", agent: false });
    const down = mk("down", 1, 0, 1, { conds: ["unconscious"] });
    const up = mk("up", 0, 1, 1);
    const combat = mkCombat([mover, down, up], mover);
    const ops = findReactiveStrikeOpportunities(combat, mover, G, 5);
    expect(ops.map((o) => o.reactor.id)).toEqual(["up"]);
  });

  it("(d) a downed PC still blocks movement (no pass-through, no landing)", async () => {
    vi.useFakeTimers();
    const me = mk("atk", 0, 0, -1, { type: "npc" });
    const down = mk("down", 3, 0, 1, { conds: ["unconscious"] });
    const far = mk("far", 9, 0, 1);
    const combat = mkCombat([me, down, far], me);
    const p1 = strideByPosture(combat, me, "approach", far);
    await vi.runAllTimersAsync();
    await p1;
    expect(me.token.move.mock.calls.length).toBeGreaterThan(0);
    for (const c of me.token.move.mock.calls.map((x) => x[0])) {
      expect(
        Math.round((c.x ?? 0) / G) === 3 && Math.round((c.y ?? 0) / G) === 0,
      ).toBe(false);
    }
    expect(me.token.x === 3 * G && me.token.y === 0).toBe(false);
    const me2 = mk("atk2", 0, 0, -1, { type: "npc" });
    const combat2 = mkCombat(
      [me2, mk("down", 2, 0, 1, { conds: ["dying"] }), far],
      me2,
    );
    const p2 = stepToward(combat2, me2, far, 9);
    await vi.runAllTimersAsync();
    await p2;
    vi.useRealTimers();
    expect(me2.token.move.mock.calls.length).toBeGreaterThan(0);
    expect(me2.token.x === 2 * G && me2.token.y === 0).toBe(false);
  });

  it("(e) a downed MONSTER is still a valid target for a party AI", async () => {
    const me = mk("pc", 0, 0, 1);
    const sleeper = mk("mon", 1, 0, -1, { type: "npc", conds: ["unconscious"] });
    const combat = mkCombat([me, sleeper], me);
    const turn = await getPendingAgentTurn(combat);
    expect(turn.context.opponents.map((o) => o.id)).toEqual(["mon"]);
  });
});
