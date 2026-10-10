import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import {
  runAgentDecisionLoop,
  armAgentTimeout,
  playHeuristicTurn,
  takeAgentFallbackReason,
  noteAgentFallbackReason,
  AGENT_TIMEOUT_MS,
} from "../scripts/dungeon-combat.mjs";

// #952: the combat loop measures the decision round trip and records why a
// fallback fired; the heuristic fallback's actions reach the agentLog as
// fallback records carrying that reason.

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

let combatSeq = 0;
function makeCombat(over = {}) {
  combatSeq += 1;
  const flags = {};
  return {
    id: `combat-${combatSeq}`,
    round: 1,
    turn: 0,
    flags,
    getFlag: (_m, key) => flags[key],
    setFlag: vi.fn(async (_m, key, value) => {
      flags[key] = value;
    }),
    ...over,
  };
}

function installSettings({ agentServiceUrl = "https://agent.example" } = {}) {
  globalThis.game = {
    settings: { get: (_m, key) => ({ agentServiceUrl, agentServiceApiKey: "k" })[key] },
  };
}

const pendingFor = (combatantId = "atk") => ({
  combatId: "x",
  combatantId,
  context: { candidates: [] },
  candidates: [],
});

describe("runAgentDecisionLoop decision metadata (#952)", () => {
  beforeEach(() => vi.spyOn(console, "error").mockImplementation(() => {}));

  it("measures clientMs around the call and passes the service meta through as decisionInfo", async () => {
    installSettings();
    const combat = makeCombat();
    const fetchDecision = vi.fn(
      () =>
        new Promise((resolve) =>
          setTimeout(() => resolve({ candidateId: "endTurn", rationale: "r", meta: { provider: "litellm", serverMs: 10, tier: "fast" } }), 30),
        ),
    );
    const applyDecision = vi.fn().mockResolvedValue(null);

    await runAgentDecisionLoop(combat, { id: "atk" }, { fetchDecision, getPending: async () => pendingFor(), applyDecision });

    const info = applyDecision.mock.calls[0][4];
    expect(info.source).toBe("model");
    expect(info.meta).toMatchObject({ provider: "litellm", serverMs: 10, tier: "fast" });
    expect(info.meta.clientMs).toBeGreaterThanOrEqual(25);
  });

  it("works with an old service response that carries no meta (and ignores a malformed one)", async () => {
    installSettings();
    const combat = makeCombat();
    const applyDecision = vi.fn().mockResolvedValue(null);
    await runAgentDecisionLoop(combat, { id: "atk" }, {
      fetchDecision: async () => ({ candidateId: "endTurn", rationale: "r", meta: ["junk"] }),
      getPending: async () => pendingFor(),
      applyDecision,
    });
    expect(applyDecision.mock.calls[0][4]).toEqual({ source: "model", meta: { clientMs: expect.any(Number) } });
  });

  it("notes 'error' for the fallback timer -- before returning, and without touching the turn-state counter -- when the decision call fails", async () => {
    installSettings();
    const combat = makeCombat();
    await runAgentDecisionLoop(combat, { id: "atk" }, {
      fetchDecision: vi.fn().mockRejectedValue(new Error("network error")),
      getPending: async () => pendingFor(),
      applyDecision: vi.fn(),
    });
    // A setAgentTurnState write would bump the counter armAgentTimeout
    // checks and silently cancel the fallback it is meant to explain.
    expect(combat.setFlag).not.toHaveBeenCalled();
    expect(takeAgentFallbackReason(combat, "atk")).toBe("error");
  });

  it("notes 'unconfigured' and makes no call when the service URL is not set", async () => {
    installSettings({ agentServiceUrl: "" });
    const combat = makeCombat();
    const fetchDecision = vi.fn();
    await runAgentDecisionLoop(combat, { id: "atk" }, { fetchDecision, getPending: vi.fn(), applyDecision: vi.fn() });
    expect(fetchDecision).not.toHaveBeenCalled();
    expect(combat.setFlag).not.toHaveBeenCalled();
    expect(takeAgentFallbackReason(combat, "atk")).toBe("unconfigured");
  });

  it("notes 'apply-error' when applying the decided candidate throws", async () => {
    installSettings();
    const combat = makeCombat();
    await runAgentDecisionLoop(combat, { id: "atk" }, {
      fetchDecision: async () => ({ candidateId: "endTurn" }),
      getPending: async () => pendingFor(),
      applyDecision: vi.fn().mockRejectedValue(new Error("boom")),
    });
    expect(takeAgentFallbackReason(combat, "atk")).toBe("apply-error");
  });

  it("clears an earlier noted reason once a decision call succeeds", async () => {
    installSettings();
    const combat = makeCombat();
    noteAgentFallbackReason(combat, "atk", "error");
    await runAgentDecisionLoop(combat, { id: "atk" }, {
      fetchDecision: async () => ({ candidateId: "endTurn" }),
      getPending: async () => pendingFor(),
      applyDecision: vi.fn().mockResolvedValue(null),
    });
    expect(takeAgentFallbackReason(combat, "atk")).toBe("timeout");
  });
});

describe("takeAgentFallbackReason (#952)", () => {
  it("defaults to 'timeout', is consumed once, and belongs to the exact turn it was noted on", () => {
    const combat = makeCombat();
    expect(takeAgentFallbackReason(combat, "atk")).toBe("timeout");
    noteAgentFallbackReason(combat, "atk", "error");
    combat.round = 2;
    expect(takeAgentFallbackReason(combat, "atk")).toBe("timeout");
    combat.round = 1;
    expect(takeAgentFallbackReason(combat, "other")).toBe("timeout");
    expect(takeAgentFallbackReason(combat, "atk")).toBe("error");
    expect(takeAgentFallbackReason(combat, "atk")).toBe("timeout");
  });
});

describe("armAgentTimeout fallback records (#952)", () => {
  function setup() {
    const combatant = { id: "atk", name: "Goblin", token: { id: "tok1", hidden: false, name: "Goblin" } };
    const combat = makeCombat({ combatant, combatants: [combatant] });
    const messages = new Map();
    let n = 0;
    globalThis.ChatMessage = {
      create: vi.fn(async (data) => {
        const m = { id: `m${++n}`, ...data, update: vi.fn() };
        messages.set(m.id, m);
        return m;
      }),
      getWhisperRecipients: () => [{ id: "gm1" }],
    };
    globalThis.ui = { notifications: { warn: vi.fn() } };
    globalThis.game = {
      combats: { has: () => true },
      i18n: { format: (key) => key },
      messages: { get: (id) => messages.get(id) },
    };
    globalThis.foundry = { utils: {} };
    return { combat, combatant };
  }

  async function fire(combat, combatant, playHeuristic) {
    vi.useFakeTimers();
    const done = armAgentTimeout(combat, combatant, { playHeuristic });
    await vi.advanceTimersByTimeAsync(AGENT_TIMEOUT_MS);
    await done;
  }

  it("logs each heuristic action as a fallback record carrying the noted reason", async () => {
    const { combat, combatant } = setup();
    noteAgentFallbackReason(combat, "atk", "error");
    const playHeuristic = vi.fn(async (_c, _cb, { onAction }) => {
      await onAction({ id: "strike:opp", type: "strike", targetId: "opp", summary: "Strike", cost: 1 }, "success");
    });

    await fire(combat, combatant, playHeuristic);

    expect(playHeuristic).toHaveBeenCalledOnce();
    const [record] = combat.flags.agentLog;
    expect(record).toMatchObject({
      combatantId: "atk",
      source: "fallback",
      fallbackReason: "error",
      meta: { provider: "heuristic" },
      summary: "Strike",
      result: { text: "hit", tone: "success" },
    });
    expect(record).not.toHaveProperty("alternatives");
    expect(record.meta).not.toHaveProperty("timeoutMs");
  });

  it("reports a plain timeout, with how long it waited, when nothing else was noted", async () => {
    const { combat, combatant } = setup();
    const playHeuristic = vi.fn(async (_c, _cb, { onAction }) => {
      await onAction({ id: "seek", type: "seek", summary: "Seek", cost: 1 }, []);
    });

    await fire(combat, combatant, playHeuristic);

    expect(combat.flags.agentLog[0]).toMatchObject({
      source: "fallback",
      fallbackReason: "timeout",
      meta: { provider: "heuristic", timeoutMs: AGENT_TIMEOUT_MS },
    });
  });

  it("does not fire (or consume the reason) when the turn already moved on", async () => {
    const { combat, combatant } = setup();
    noteAgentFallbackReason(combat, "atk", "error");
    const playHeuristic = vi.fn();
    vi.useFakeTimers();
    const done = armAgentTimeout(combat, combatant, { playHeuristic });
    combat.combatant = { id: "someone-else" };
    await vi.advanceTimersByTimeAsync(AGENT_TIMEOUT_MS);
    await done;
    expect(playHeuristic).not.toHaveBeenCalled();
    expect(takeAgentFallbackReason(combat, "atk")).toBe("error");
  });
});

describe("playHeuristicTurn onAction (#952)", () => {
  const G = 100;
  const make = (id, x, disposition) => ({ id, isDefeated: false, token: { x, y: 0, disposition } });

  beforeEach(() => {
    globalThis.game = { combats: { has: () => true } };
  });

  it("reports the move and the Strike it made, as stride/strike candidate shapes", async () => {
    const me = make("me", 0, -1);
    const foe = make("foe", 3 * G, 1);
    const combat = { id: "c", combatant: me, combatants: [me, foe], scene: { grid: { size: G, distance: 5 } }, nextTurn: vi.fn() };
    const onAction = vi.fn();

    await playHeuristicTurn(combat, me, {
      move: vi.fn().mockResolvedValue("moved"),
      strike: vi.fn().mockResolvedValue("criticalSuccess"),
      delayMs: 0,
      onAction,
    });

    expect(onAction.mock.calls).toEqual([
      [expect.objectContaining({ type: "stride", posture: "approach", targetId: "foe", cost: 1 }), "moved"],
      [expect.objectContaining({ type: "strike", targetId: "foe", cost: 1 }), "criticalSuccess"],
    ]);
  });

  it("skips logging a move when already adjacent, and logs an out-of-reach Strike as not made", async () => {
    const me = make("me", 0, -1);
    const foe = make("foe", G, 1);
    const combat = { id: "c", combatant: me, combatants: [me, foe], scene: { grid: { size: G, distance: 5 } }, nextTurn: vi.fn() };
    const onAction = vi.fn();

    await playHeuristicTurn(combat, me, {
      move: vi.fn().mockResolvedValue("already-there"),
      strike: vi.fn().mockResolvedValue(null),
      delayMs: 0,
      onAction,
    });

    expect(onAction).toHaveBeenCalledOnce();
    expect(onAction).toHaveBeenCalledWith(expect.objectContaining({ type: "strike" }), { skipped: "no Strike in reach" });
  });

  it("keeps playing the turn when logging an action throws", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const me = make("me", 0, -1);
    const foe = make("foe", 3 * G, 1);
    const combat = { id: "c", combatant: me, combatants: [me, foe], scene: { grid: { size: G, distance: 5 } }, nextTurn: vi.fn() };
    const strike = vi.fn().mockResolvedValue("failure");

    await playHeuristicTurn(combat, me, {
      move: vi.fn().mockResolvedValue("moved"),
      strike,
      delayMs: 0,
      onAction: vi.fn().mockRejectedValue(new Error("log down")),
    });

    expect(strike).toHaveBeenCalled();
    expect(combat.nextTurn).toHaveBeenCalled();
  });
});
