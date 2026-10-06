import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  getPendingAgentTurn,
  applyAgentDecision,
  playHeuristicTurn,
  findReactiveStrikeOpportunities,
  stepToward,
} from "../scripts/dungeon-combat.mjs";

// #616: a hostile may only target party combatants it has observed per the
// Combat's stealth detection matrix (sneaker id -> hostile id -> state).

const G = 100;

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
    variants: [{ roll: vi.fn(async () => {}) }],
    damage: vi.fn(async () => null),
    item: { slug: "claw", isRanged: false, system: {} },
  };
}

function mk(id, gx, gy, disposition, { type = "character", agent = true } = {}) {
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
    },
    getFlag: (_m, k) => flags[k],
    actor: {
      type,
      conditions: [],
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

function mkCombat(combatants, current, detection) {
  const flags = { dungeonSlot: "slot-1", reactionUsed: {}, detection };
  return {
    id: "c1",
    round: 1,
    turn: 0,
    combatant: current,
    combatants,
    flags,
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

describe("hostile targeting honors the detection matrix (#616)", () => {
  for (const state of ["unnoticed", "undetected", "hidden"]) {
    it(`getPendingAgentTurn omits a ${state} sneaker but keeps observed and non-sneaker PCs`, async () => {
      const me = mk("atk", 0, 0, -1, { type: "npc" });
      const sneak = mk("sneak", 0, 1, 1);
      const seen = mk("seen", 1, 0, 1);
      const plain = mk("plain", 1, 1, 1);
      const combat = mkCombat([me, sneak, seen, plain], me, {
        sneak: { atk: state },
        seen: { atk: "observed" },
      });
      const turn = await getPendingAgentTurn(combat);
      expect(turn.context.opponents.map((o) => o.id).sort()).toEqual(["plain", "seen"]);
      for (const c of turn.candidates) expect(JSON.stringify(c)).not.toContain("sneak");
      expect(turn.candidates.some((c) => c.id === "strike:claw:seen")).toBe(true);
    });
  }

  it("the state is per hostile: unnoticed by atk, observed by another hostile", async () => {
    const me = mk("atk", 0, 0, -1, { type: "npc" });
    const other = mk("other", 5, 0, -1, { type: "npc" });
    const sneak = mk("sneak", 1, 0, 1);
    const combat = mkCombat([me, other, sneak], me, {
      sneak: { atk: "unnoticed", other: "observed" },
    });
    const t1 = await getPendingAgentTurn(combat);
    expect(t1.context.opponents).toEqual([]);
    combat.combatant = other;
    const t2 = await getPendingAgentTurn(combat);
    expect(t2.context.opponents.map((o) => o.id)).toEqual(["sneak"]);
  });

  it("an agent-controlled party member still targets every hostile", async () => {
    const pc = mk("sneak", 0, 0, 1);
    const mon = mk("atk", 1, 0, -1, { type: "npc" });
    const combat = mkCombat([pc, mon], pc, { sneak: { atk: "unnoticed" } });
    const turn = await getPendingAgentTurn(combat);
    expect(turn.context.opponents.map((o) => o.id)).toEqual(["atk"]);
  });

  it("no matrix leaves targeting untouched", async () => {
    const me = mk("atk", 0, 0, -1, { type: "npc" });
    const pc = mk("pc", 1, 0, 1);
    const turn = await getPendingAgentTurn(mkCombat([me, pc], me, undefined));
    expect(turn.context.opponents.map((o) => o.id)).toEqual(["pc"]);
  });

  it("heuristic path does not move toward or strike an unobserved PC", async () => {
    const me = mk("atk", 0, 0, -1, { type: "npc" });
    const sneak = mk("sneak", 1, 0, 1);
    const combat = mkCombat([me, sneak], me, { sneak: { atk: "hidden" } });
    const move = vi.fn(async () => {});
    const strike = vi.fn(async () => {});
    await playHeuristicTurn(combat, me, { move, strike, delayMs: 0 });
    expect(move).not.toHaveBeenCalled();
    expect(strike).not.toHaveBeenCalled();
  });

  it("applyAgentDecision does not resolve a stale candidate id for a PC that became unobserved", async () => {
    const claw1 = claw();
    const me = mk("atk", 0, 0, -1, { type: "npc" });
    me.actor.system.actions = [claw1];
    const sneak = mk("sneak", 1, 0, 1);
    const combat = mkCombat([me, sneak], me, undefined);
    // Candidate is built while observed; the PC slips out of notice right
    // after the decision announcement, before the target is re-resolved.
    ChatMessage.create.mockImplementation(async () => {
      combat.flags.detection = { sneak: { atk: "undetected" } };
    });
    await applyAgentDecision(combat, "atk", "strike:claw:sneak");
    expect(claw1.variants[0].roll).not.toHaveBeenCalled();
  });

  it("applyAgentDecision still strikes an observed PC (control)", async () => {
    const claw1 = claw();
    const me = mk("atk", 0, 0, -1, { type: "npc" });
    me.actor.system.actions = [claw1];
    const sneak = mk("sneak", 1, 0, 1);
    const combat = mkCombat([me, sneak], me, { sneak: { atk: "observed" } });
    await applyAgentDecision(combat, "atk", "strike:claw:sneak");
    expect(claw1.variants[0].roll).toHaveBeenCalledTimes(1);
  });

  it("a hostile mover is not offered a Reactive Strike from an unobserved PC", () => {
    const mover = mk("mover", 0, 0, -1, { type: "npc", agent: false });
    const sneak = mk("sneak", 1, 0, 1);
    const up = mk("up", 0, 1, 1);
    const combat = mkCombat([mover, sneak, up], mover, { sneak: { mover: "hidden" } });
    const ops = findReactiveStrikeOpportunities(combat, mover, G, 5);
    expect(ops.map((o) => o.reactor.id)).toEqual(["up"]);
  });

  it("an unobserved PC still physically blocks movement", async () => {
    vi.useFakeTimers();
    const me = mk("atk", 0, 0, -1, { type: "npc" });
    const sneak = mk("sneak", 2, 0, 1);
    const far = mk("far", 9, 0, 1);
    const combat = mkCombat([me, sneak, far], me, {
      sneak: { atk: "unnoticed" },
      far: { atk: "observed" },
    });
    const p = stepToward(combat, me, far, 9);
    await vi.runAllTimersAsync();
    await p;
    vi.useRealTimers();
    expect(me.token.update.mock.calls.length).toBeGreaterThan(0);
    expect(me.token.x === 2 * G && me.token.y === 0).toBe(false);
  });
});
