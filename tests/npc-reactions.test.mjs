import { describe, it, expect, vi, afterEach } from "vitest";
import {
  REACTION_DEFS,
  REACTION_DECISION_TIMEOUT_MS,
  reactionDefById,
  reactionItemsFor,
  moveTriggerIndex,
  degreeOfSuccess,
  acBonusTurnsHitToMiss,
  decideReaction,
  fallbackReaction,
  defensiveReactionMode,
  reactionConfirmActionFor,
  isGmLessRunState,
  reactionGmNoteHtml,
} from "../scripts/npc-reactions.mjs";

const reaction = (name) => ({ type: "action", name, system: { actionType: { value: "reaction" } } });

describe("REACTION_DEFS", () => {
  it("covers the first-slice reactions, each with triggers, a kind, a priority and a policy", () => {
    expect(REACTION_DEFS.map((d) => d.id).sort()).toEqual(
      ["ghost-dodge", "reactive-strike", "shield-block", "swat-projectile", "twisting-tail", "wing-deflection", "wing-rebuff"].sort(),
    );
    for (const def of REACTION_DEFS) {
      expect(def.triggers.length).toBeGreaterThan(0);
      expect(["strike", "acBonus", "damageReduction"]).toContain(def.kind);
      expect(typeof def.priority).toBe("number");
      expect(typeof def.policy).toBe("function");
    }
  });

  it("reactive-strike matches #202's names and limb variants, anchored at the start", () => {
    const def = reactionDefById("reactive-strike");
    expect(def.match.test("Reactive Strike")).toBe(true);
    expect(def.match.test("Attack of Opportunity (Jaws Only)")).toBe(true);
    expect(def.match.test("Attack of Opportunity (Special)")).toBe(true);
    expect(def.match.test("Not Reactive Strike")).toBe(false);
  });

  it("only Reactive Strike answers a ranged attack or an AI Stride's end (#202's triggers)", () => {
    const ids = (t) => REACTION_DEFS.filter((d) => d.triggers.includes(t)).map((d) => d.id);
    expect(ids("rangedAttack")).toEqual(["reactive-strike"]);
    expect(ids("strideEnd")).toEqual(["reactive-strike"]);
    expect(ids("manual").sort()).toEqual(["reactive-strike", "twisting-tail"]);
    expect(ids("move").sort()).toEqual(["reactive-strike", "twisting-tail", "wing-rebuff"]);
  });

  it("twisting-tail uses the item's own roll option, a tail Strike, and disrupts on a hit", () => {
    const def = reactionDefById("twisting-tail");
    expect(def).toMatchObject({ limb: "tail", rollOption: "twisting-tail", penalty: -2, disrupts: "hit" });
    expect(reactionDefById("wing-rebuff")).toMatchObject({ limb: "wing", disrupts: "push", moveTrigger: "entersReach" });
  });
});

describe("reactionItemsFor", () => {
  it("finds every registry reaction on the actor, ignoring non-reaction items and unknown reactions", () => {
    const actor = {
      items: [
        reaction("Attack of Opportunity (Tail Only)"),
        reaction("Shield Block"),
        reaction("Ferocity"),
        { type: "action", name: "Twisting Tail", system: { actionType: { value: "action" } } },
      ],
    };
    expect(reactionItemsFor(actor).map((r) => r.def.id)).toEqual(["reactive-strike", "shield-block"]);
  });

  it("returns nothing for a missing actor or item list", () => {
    expect(reactionItemsFor(null)).toEqual([]);
    expect(reactionItemsFor({})).toEqual([]);
  });
});

describe("moveTriggerIndex", () => {
  it("withinReach fires at the origin when the move starts in reach (uses a move action within reach)", () => {
    expect(moveTriggerIndex("withinReach", [true, false, false])).toBe(0);
  });

  it("withinReach fires when the mover leaves a square within reach mid-move", () => {
    expect(moveTriggerIndex("withinReach", [false, true, true])).toBe(1);
  });

  it("withinReach does not fire when the mover only ends its move in reach", () => {
    expect(moveTriggerIndex("withinReach", [false, false, true])).toBe(-1);
  });

  it("entersReach fires at the first square within reach when the origin was beyond it", () => {
    expect(moveTriggerIndex("entersReach", [false, false, true, true])).toBe(2);
  });

  it("entersReach never fires for a move that starts within reach", () => {
    expect(moveTriggerIndex("entersReach", [true, false, true])).toBe(-1);
  });

  it("a path with no movement never fires", () => {
    expect(moveTriggerIndex("withinReach", [true])).toBe(-1);
    expect(moveTriggerIndex("entersReach", [])).toBe(-1);
  });
});

describe("degreeOfSuccess", () => {
  it("uses the +/-10 critical bands", () => {
    expect(degreeOfSuccess(30, 20)).toBe("criticalSuccess");
    expect(degreeOfSuccess(20, 20)).toBe("success");
    expect(degreeOfSuccess(19, 20)).toBe("failure");
    expect(degreeOfSuccess(10, 20)).toBe("criticalFailure");
  });

  it("steps up on a natural 20 and down on a natural 1", () => {
    expect(degreeOfSuccess(19, 20, 20)).toBe("success");
    expect(degreeOfSuccess(20, 20, 1)).toBe("failure");
    expect(degreeOfSuccess(30, 20, 20)).toBe("criticalSuccess");
  });
});

describe("acBonusTurnsHitToMiss (AC-bonus policy)", () => {
  it("is true when the bonus turns a hit into a miss", () => {
    expect(acBonusTurnsHitToMiss({ rollTotal: 21, dcValue: 20, outcome: "success", natural: 10 }, 2)).toBe(true);
  });

  it("is false when the attack still hits with the bonus", () => {
    expect(acBonusTurnsHitToMiss({ rollTotal: 25, dcValue: 20, outcome: "success", natural: 10 }, 2)).toBe(false);
  });

  it("is false for an attack that already missed", () => {
    expect(acBonusTurnsHitToMiss({ rollTotal: 18, dcValue: 20, outcome: "failure", natural: 10 }, 2)).toBe(false);
  });

  it("is false for a critical hit that would only drop to a hit", () => {
    expect(acBonusTurnsHitToMiss({ rollTotal: 31, dcValue: 20, outcome: "criticalSuccess", natural: 15 }, 2)).toBe(false);
  });

  it("accounts for the natural 20 step-up (a 20 that still hits after the bonus stays a hit)", () => {
    expect(acBonusTurnsHitToMiss({ rollTotal: 21, dcValue: 20, outcome: "criticalSuccess", natural: 20 }, 2)).toBe(false);
  });

  it("is false without a DC (unknown AC)", () => {
    expect(acBonusTurnsHitToMiss({ rollTotal: 21, dcValue: null, outcome: "success" }, 2)).toBe(false);
  });

  it("swat-projectile's policy uses +4", () => {
    const ctx = { rollTotal: 23, dcValue: 20, outcome: "success", natural: 8 };
    expect(reactionDefById("swat-projectile").policy(ctx)).toBe(true);
    expect(reactionDefById("wing-deflection").policy(ctx)).toBe(false);
  });
});

describe("shield-block policy", () => {
  it("blocks only when the incoming damage exceeds the shield's Hardness", () => {
    const def = reactionDefById("shield-block");
    expect(def.policy({ incomingDamage: 9, shieldHardness: 5 })).toBe(true);
    expect(def.policy({ incomingDamage: 5, shieldHardness: 5 })).toBe(false);
  });
});

function option(id, { priority = 10, policy = true } = {}) {
  return { def: { id, label: id, priority, policy: () => policy }, ctx: {} };
}

describe("decideReaction (the hybrid)", () => {
  afterEach(() => vi.useRealTimers());

  it("does nothing with no eligible reaction", async () => {
    const requestDecision = vi.fn();
    expect(await decideReaction([], { reactorId: "r1", requestDecision })).toEqual({ choice: null, source: "policy", rationale: null });
    expect(requestDecision).not.toHaveBeenCalled();
  });

  it("uses the deterministic policy for exactly one eligible reaction, never calling the service", async () => {
    const requestDecision = vi.fn();
    const only = option("a");
    expect((await decideReaction([only], { reactorId: "r1", requestDecision })).choice).toBe(only);
    expect((await decideReaction([option("a", { policy: false })], { reactorId: "r1", requestDecision })).choice).toBeNull();
    expect(requestDecision).not.toHaveBeenCalled();
  });

  it("asks the service with every eligible reaction plus decline when several are eligible, and runs its pick", async () => {
    const a = option("a", { priority: 5 });
    const b = option("b", { priority: 20 });
    const requestDecision = vi.fn(async () => ({ candidateId: "reaction:a:r1", rationale: "because" }));
    const result = await decideReaction([a, b], { reactorId: "r1", requestDecision });
    expect(requestDecision).toHaveBeenCalledOnce();
    expect(requestDecision.mock.calls[0][0].candidates.map((c) => c.id)).toEqual(["reaction:a:r1", "reaction:b:r1", "decline"]);
    expect(result).toEqual({ choice: a, source: "model", rationale: "because" });
  });

  it("respects a decline pick", async () => {
    const requestDecision = vi.fn(async () => ({ candidateId: "decline", rationale: "save it" }));
    const result = await decideReaction([option("a"), option("b")], { reactorId: "r1", requestDecision });
    expect(result).toEqual({ choice: null, source: "declined", rationale: "save it" });
  });

  it("falls back to the highest-priority reaction whose policy says yes when the service throws", async () => {
    const low = option("low", { priority: 5 });
    const highNo = option("highNo", { priority: 30, policy: false });
    const mid = option("mid", { priority: 20 });
    const requestDecision = vi.fn(async () => {
      throw new Error("boom");
    });
    const result = await decideReaction([low, highNo, mid], { reactorId: "r1", requestDecision });
    expect(result.choice).toBe(mid);
    expect(result.source).toBe("fallback");
  });

  it("falls back after the 5 s timeout when the service never answers", async () => {
    vi.useFakeTimers();
    const a = option("a", { priority: 5 });
    const b = option("b", { priority: 20 });
    const requestDecision = vi.fn(() => new Promise(() => {}));
    const pending = decideReaction([a, b], { reactorId: "r1", requestDecision });
    await vi.advanceTimersByTimeAsync(REACTION_DECISION_TIMEOUT_MS - 1);
    let settled = false;
    pending.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(2);
    const result = await pending;
    expect(REACTION_DECISION_TIMEOUT_MS).toBe(5000);
    expect(result.choice).toBe(b);
    expect(result.source).toBe("fallback");
  });

  it("falls back immediately with no service configured", async () => {
    const b = option("b", { priority: 20 });
    expect((await decideReaction([option("a"), b], { reactorId: "r1", requestDecision: null })).choice).toBe(b);
    expect((await decideReaction([option("a"), b], { reactorId: "r1", requestDecision: async () => null })).choice).toBe(b);
  });

  it("falls back when the service picks an id it was never offered", async () => {
    const b = option("b", { priority: 20 });
    const result = await decideReaction([option("a"), b], { reactorId: "r1", requestDecision: async () => ({ candidateId: "strike:x" }) });
    expect(result.choice).toBe(b);
  });

  it("fallbackReaction returns null when no policy says yes", () => {
    expect(fallbackReaction([option("a", { policy: false })])).toBeNull();
  });
});

describe("defensiveReactionMode", () => {
  it("is automatic for an AI-driven attacker regardless of mode", () => {
    expect(defensiveReactionMode({ attackerIsPlayerDriven: false, gmLess: false })).toBe("automatic");
    expect(defensiveReactionMode({ attackerIsPlayerDriven: false, gmLess: true })).toBe("automatic");
  });

  it("is automatic -- never a confirm card -- for a player attack in a GM-less run", () => {
    expect(defensiveReactionMode({ attackerIsPlayerDriven: true, gmLess: true })).toBe("automatic");
  });

  it("asks the GM to confirm a player attack's reaction when a human GM runs the table", () => {
    expect(defensiveReactionMode({ attackerIsPlayerDriven: true, gmLess: false })).toBe("confirm");
  });
});

describe("isGmLessRunState", () => {
  it("is true only for a hosted, unfinished run", () => {
    expect(isGmLessRunState({ hostUserId: "u1" })).toBe(true);
    expect(isGmLessRunState({ hostUserId: "u1", completed: true })).toBe(false);
    expect(isGmLessRunState({ hostUserId: null })).toBe(false);
    expect(isGmLessRunState(null)).toBe(false);
  });
});

describe("reactionConfirmActionFor", () => {
  const message = { flags: { "pf2e-dungeon-crawl": { reactionConfirm: { combatId: "c1", confirmId: "k1" } } } };

  it("is enabled for a GM on a pending card", () => {
    expect(reactionConfirmActionFor(message, { isGM: true })).toEqual({ combatId: "c1", confirmId: "k1", enabled: true });
  });

  it("is disabled for a non-GM or a resolved card", () => {
    expect(reactionConfirmActionFor(message, { isGM: false }).enabled).toBe(false);
    const resolved = { flags: { "pf2e-dungeon-crawl": { reactionConfirm: { combatId: "c1", confirmId: "k1", resolved: true } } } };
    expect(reactionConfirmActionFor(resolved, { isGM: true }).enabled).toBe(false);
  });

  it("is null for any other message", () => {
    expect(reactionConfirmActionFor({ flags: {} }, { isGM: true })).toBeNull();
  });
});

describe("reactionGmNoteHtml", () => {
  it("wraps the note GM-only and escapes it", () => {
    expect(reactionGmNoteHtml("a <b>")).toBe('<div data-visibility="gm" class="pf2edc-agent-rationale"><em>a &lt;b&gt;</em></div>');
    expect(reactionGmNoteHtml(null)).toBe("");
  });
});
