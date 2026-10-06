import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  getPendingAgentTurn,
  applyAgentDecision,
  playHeuristicTurn,
  runAgentDecisionLoop,
  autoPlayCombatantTurnIfDue,
  performSeek,
} from "../scripts/dungeon-combat.mjs";

// #616 Task 4: Seek and the unaware hostile.

const G = 100;

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

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
    combats: { contents: [], has: () => true },
    modules: { get: () => ({ version: "0" }) },
    settings: {
      get: (_m, key) => ({ agentServiceUrl: "https://agent.example", agentServiceApiKey: "k" })[key],
    },
    actors: { party: { members: [] } },
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

function mk(id, gx, gy, disposition, { type = "character", agent = true, stealthDc = 20 } = {}) {
  const flags = { agentControlled: agent };
  return {
    id,
    name: id,
    isDefeated: false,
    token: { x: gx * G, y: gy * G, disposition, width: 1, height: 1, update: vi.fn(async () => {}) },
    getFlag: (_m, k) => flags[k],
    actor: {
      id: `actor-${id}`,
      type,
      conditions: [],
      items: [],
      perception: { roll: vi.fn(async () => ({})) },
      skills: { stealth: { dc: { value: stealthDc } } },
      system: {
        actions: [claw()],
        attributes: { hp: { value: 20, max: 20 } },
        movement: { speeds: { land: { value: 30 } } },
      },
    },
  };
}

function mkCombat(combatants, current, detection, extraFlags = {}) {
  const flags = { dungeonSlot: "slot-1", reactionUsed: {}, detection, ...extraFlags };
  const combat = {
    id: "c1",
    round: 1,
    turn: 0,
    combatant: current,
    combatants,
    flags,
    getFlag: (_m, k) => flags[k],
    setFlag: vi.fn(async (_m, k, v) => {
      flags[k] = v;
    }),
    nextTurn: vi.fn(async () => {}),
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
  return combat;
}

const outcomeRoll = (...outcomes) => {
  const q = [...outcomes];
  return vi.fn(async () => q.shift());
};

const quietDeps = (rollPerception) => ({
  rollPerception,
  chat: vi.fn(async () => {}),
  hasCondition: () => false,
  setCondition: vi.fn(async () => {}),
});

describe("performSeek outcome table (#616)", () => {
  const cases = [
    ["criticalSuccess", "hidden", "observed"],
    ["criticalSuccess", "undetected", "observed"],
    ["success", "undetected", "hidden"],
    ["success", "hidden", "observed"],
    ["failure", "hidden", "hidden"],
    ["failure", "undetected", "undetected"],
    ["criticalFailure", "undetected", "undetected"],
  ];
  for (const [outcome, from, to] of cases) {
    it(`${outcome}: ${from} -> ${to}`, async () => {
      const me = mk("atk", 0, 0, -1, { type: "npc" });
      const pc = mk("sneak", 3, 0, 1, { stealthDc: 23 });
      const combat = mkCombat([me, pc], me, { sneak: { atk: from } });
      const roll = outcomeRoll(outcome);
      const deps = quietDeps(roll);
      const res = await performSeek(combat, me, deps);
      expect(roll).toHaveBeenCalledWith(me.actor, 23);
      expect(combat.flags.detection.sneak.atk).toBe(to);
      expect(res).toEqual([{ sneakerId: "sneak", dc: 23, outcome, from, to }]);
      if (to !== from) expect(deps.chat).toHaveBeenCalledTimes(1);
      else expect(deps.chat).not.toHaveBeenCalled();
    });
  }

  it("updates only that (hostile, sneaker) pair and leaves unnoticed sneakers alone", async () => {
    const me = mk("atk", 0, 0, -1, { type: "npc" });
    const other = mk("other", 5, 0, -1, { type: "npc" });
    const a = mk("a", 3, 0, 1);
    const b = mk("b", 3, 1, 1);
    const combat = mkCombat([me, other, a, b], me, {
      a: { atk: "hidden", other: "hidden" },
      b: { atk: "unnoticed", other: "unnoticed" },
    });
    await performSeek(combat, me, quietDeps(outcomeRoll("criticalSuccess")));
    expect(combat.flags.detection).toEqual({
      a: { atk: "observed", other: "hidden" },
      b: { atk: "unnoticed", other: "unnoticed" },
    });
  });

  it("rolls against each seekable sneaker's own Stealth DC", async () => {
    const me = mk("atk", 0, 0, -1, { type: "npc" });
    const a = mk("a", 3, 0, 1, { stealthDc: 18 });
    const b = mk("b", 3, 1, 1, { stealthDc: 27 });
    const combat = mkCombat([me, a, b], me, { a: { atk: "hidden" }, b: { atk: "undetected" } });
    const roll = outcomeRoll("failure", "failure");
    await performSeek(combat, me, quietDeps(roll));
    expect(roll.mock.calls.map((c) => c[1])).toEqual([18, 27]);
  });

  it("does nothing when the hostile has an observed target", async () => {
    const me = mk("atk", 0, 0, -1, { type: "npc" });
    const seen = mk("seen", 1, 0, 1);
    const hid = mk("hid", 3, 0, 1);
    const combat = mkCombat([me, seen, hid], me, { hid: { atk: "hidden" } });
    const roll = outcomeRoll("criticalSuccess");
    expect(await performSeek(combat, me, quietDeps(roll))).toEqual([]);
    expect(roll).not.toHaveBeenCalled();
  });

  it("refreshes the display condition: an undetected sneaker found becomes hidden (condition removed)", async () => {
    const me = mk("atk", 0, 0, -1, { type: "npc" });
    const pc = mk("sneak", 3, 0, 1);
    const combat = mkCombat(
      [me, pc],
      me,
      { sneak: { atk: "undetected" } },
      { appliedConditions: { sneak: { actorId: "actor-sneak", slug: "undetected" } } },
    );
    const deps = quietDeps(outcomeRoll("success"));
    await performSeek(combat, me, deps);
    expect(deps.setCondition).toHaveBeenCalledWith(pc.actor, "undetected", false);
    expect(combat.flags.appliedConditions).toEqual({});
  });
});

describe("candidate/heuristic selection (#616)", () => {
  it("getPendingAgentTurn offers seek only when no PC is observed and one is hidden", async () => {
    const me = mk("atk", 0, 0, -1, { type: "npc" });
    const hid = mk("hid", 3, 0, 1);
    const t1 = await getPendingAgentTurn(mkCombat([me, hid], me, { hid: { atk: "hidden" } }));
    expect(t1.candidates.map((c) => c.id)).toContain("seek");
    const seen = mk("seen", 1, 0, 1);
    const t2 = await getPendingAgentTurn(mkCombat([me, hid, seen], me, { hid: { atk: "hidden" } }));
    const ids = t2.candidates.map((c) => c.id);
    expect(ids).not.toContain("seek");
    expect(ids).toContain("strike:claw:seen");
  });

  it("applyAgentDecision seek costs one action, refreshes the matrix, and the next pending turn attacks the revealed PC", async () => {
    const me = mk("atk", 0, 0, -1, { type: "npc" });
    const hid = mk("hid", 1, 0, 1);
    const combat = mkCombat([me, hid], me, { hid: { atk: "hidden" } });
    me.actor.perception.roll = vi.fn(async () => ({ degreeOfSuccess: 3 }));
    const next = await applyAgentDecision(combat, "atk", "seek");
    expect(me.actor.perception.roll).toHaveBeenCalledTimes(1);
    expect(combat.flags.detection.hid.atk).toBe("observed");
    expect(combat.nextTurn).not.toHaveBeenCalled();
    expect(next.candidates.map((c) => c.id)).toContain("strike:claw:hid");
    expect(next.candidates.map((c) => c.id)).not.toContain("seek");
  });

  it("a failed Seek leaves seek on offer; actions run out after repeats and the turn ends", async () => {
    const me = mk("atk", 0, 0, -1, { type: "npc" });
    const hid = mk("hid", 3, 0, 1);
    const combat = mkCombat([me, hid], me, { hid: { atk: "hidden" } });
    me.actor.perception.roll = vi.fn(async () => ({ degreeOfSuccess: 1 }));
    let pending = await applyAgentDecision(combat, "atk", "seek");
    expect(pending.candidates.map((c) => c.id)).toContain("seek");
    pending = await applyAgentDecision(combat, "atk", "seek");
    pending = await applyAgentDecision(combat, "atk", "seek");
    expect(pending).toBeNull();
    expect(combat.nextTurn).toHaveBeenCalledTimes(1);
    expect(combat.flags.detection.hid.atk).toBe("hidden");
  });

  it("heuristic: Seeks until a PC is revealed, then strikes with the remaining actions", async () => {
    const me = mk("atk", 0, 0, -1, { type: "npc" });
    const hid = mk("hid", 1, 0, 1);
    const combat = mkCombat([me, hid], me, { hid: { atk: "undetected" } });
    const seek = vi.fn(async () => {
      combat.flags.detection = { hid: { atk: "observed" } };
    });
    const move = vi.fn(async () => {});
    const strike = vi.fn(async () => {});
    await playHeuristicTurn(combat, me, { seek, move, strike, delayMs: 0 });
    expect(seek).toHaveBeenCalledTimes(1);
    expect(strike).toHaveBeenCalledWith(combat, me, hid);
    expect(combat.nextTurn).toHaveBeenCalledTimes(1);
  });

  it("heuristic: never Seeks when a PC is observed; attacks as normal", async () => {
    const me = mk("atk", 0, 0, -1, { type: "npc" });
    const seen = mk("seen", 1, 0, 1);
    const hid = mk("hid", 3, 0, 1);
    const combat = mkCombat([me, seen, hid], me, { hid: { atk: "hidden" } });
    const seek = vi.fn();
    const strike = vi.fn(async () => {});
    await playHeuristicTurn(combat, me, { seek, move: vi.fn(async () => {}), strike, delayMs: 0 });
    expect(seek).not.toHaveBeenCalled();
    expect(strike).toHaveBeenCalledWith(combat, me, seen);
  });

  it("heuristic: keeps Seeking until the 3 actions run out when nobody is found", async () => {
    const me = mk("atk", 0, 0, -1, { type: "npc" });
    const hid = mk("hid", 3, 0, 1);
    const combat = mkCombat([me, hid], me, { hid: { atk: "hidden" } });
    const seek = vi.fn(async () => {});
    const strike = vi.fn();
    await playHeuristicTurn(combat, me, { seek, move: vi.fn(), strike, delayMs: 0 });
    expect(seek).toHaveBeenCalledTimes(3);
    expect(strike).not.toHaveBeenCalled();
    expect(combat.nextTurn).toHaveBeenCalledTimes(1);
  });
});

describe("unaware hostile ends its turn (#616)", () => {
  it("heuristic path: nextTurn, no seek/move/strike", async () => {
    const me = mk("atk", 0, 0, -1, { type: "npc", agent: false });
    const pc = mk("sneak", 3, 0, 1);
    const combat = mkCombat([me, pc], me, { sneak: { atk: "unnoticed" } });
    const seek = vi.fn();
    const move = vi.fn();
    const strike = vi.fn();
    await playHeuristicTurn(combat, me, { seek, move, strike, delayMs: 0 });
    expect(combat.nextTurn).toHaveBeenCalledTimes(1);
    expect(seek).not.toHaveBeenCalled();
    expect(move).not.toHaveBeenCalled();
    expect(strike).not.toHaveBeenCalled();
  });

  it("runAgentDecisionLoop: ends the turn without calling the agent service", async () => {
    const me = mk("atk", 0, 0, -1, { type: "npc" });
    const pc = mk("sneak", 3, 0, 1);
    const combat = mkCombat([me, pc], me, { sneak: { atk: "unnoticed" } });
    const fetchDecision = vi.fn();
    await runAgentDecisionLoop(combat, me, { fetchDecision });
    expect(fetchDecision).not.toHaveBeenCalled();
    expect(combat.nextTurn).toHaveBeenCalledTimes(1);
  });

  it("autoPlayCombatantTurnIfDue: agent-controlled unaware hostile ends immediately, no 45 s timer armed", async () => {
    const me = mk("atk", 0, 0, -1, { type: "npc" });
    const pc = mk("sneak", 3, 0, 1);
    const combat = mkCombat([me, pc], me, { sneak: { atk: "unnoticed" } });
    combat.flags.dungeonSlot = "slot-1";
    vi.useFakeTimers();
    const timeoutSpy = vi.spyOn(globalThis, "setTimeout");
    await autoPlayCombatantTurnIfDue(combat);
    expect(combat.nextTurn).toHaveBeenCalledTimes(1);
    expect(timeoutSpy).not.toHaveBeenCalled();
  });

  it("autoPlayCombatantTurnIfDue: non-agent unaware hostile ends its turn too", async () => {
    const me = mk("atk", 0, 0, -1, { type: "npc", agent: false });
    const pc = mk("sneak", 3, 0, 1);
    const combat = mkCombat([me, pc], me, { sneak: { atk: "unnoticed" } });
    vi.useFakeTimers();
    const p = autoPlayCombatantTurnIfDue(combat);
    await vi.runAllTimersAsync();
    await p;
    expect(combat.nextTurn).toHaveBeenCalledTimes(1);
  });

  it("a hostile with a mix of unnoticed and hidden sneakers is not unaware (it Seeks)", async () => {
    const me = mk("atk", 0, 0, -1, { type: "npc" });
    const a = mk("a", 3, 0, 1);
    const b = mk("b", 3, 1, 1);
    const combat = mkCombat([me, a, b], me, { a: { atk: "unnoticed" }, b: { atk: "hidden" } });
    const fetchDecision = vi.fn(async () => ({ candidateId: "endTurn" }));
    const applyDecision = vi.fn(async () => null);
    const getPending = vi.fn(async () => getPendingAgentTurn(combat));
    await runAgentDecisionLoop(combat, me, { fetchDecision, getPending, applyDecision });
    expect(fetchDecision).toHaveBeenCalledTimes(1);
    const ctx = fetchDecision.mock.calls[0][0].context;
    expect(ctx.candidates.map((c) => c.id)).toContain("seek");
  });
});
