import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  onDefensiveAdviceCard, pendingDefensiveAdvance, waitForTrackerLog,
  clearDefensiveAdvanceForCombat, onDefensiveAdviceCombatUpdate, registerDefensiveAdvanceHooks,
} from "../scripts/defensive-advance.mjs";
import { TRACKER_NAMESPACE } from "../scripts/defensive-advance-logic.mjs";

const MODULE_ID = "pf2e-dungeon-crawl";

function world({ shield = { isRaised: false }, trackerLog = [{ msgId: "m1" }], agent = false, current = true, defeated = false } = {}) {
  const mover = {
    id: "c1", tokenId: "t1", isDefeated: defeated,
    getFlag: (scope, key) => (scope === MODULE_ID && key === "agentControlled" ? agent : undefined),
    flags: { [TRACKER_NAMESPACE]: { log: trackerLog } },
    actor: { heldShield: shield },
  };
  const combat = {
    id: "k1", round: 2, started: true, scene: { id: "s1" },
    combatant: current ? mover : { id: "other" },
    combatants: { find: (fn) => [mover].find(fn), get: (id) => [mover].find((c) => c.id === id) },
  };
  const game = { user: { id: "u1", targets: new Set() }, combats: { contents: [combat], get: () => combat } };
  return { mover, combat, game };
}
const card = (over = {}) => ({
  id: "m1", author: { id: "u1" }, speaker: { scene: "s1", token: "t1" },
  flags: { pf2e: { origin: { type: "feat", rollOptions: ["origin:item:slug:defensive-advance"] } } },
  ...over,
});
const mkDeps = (w, over = {}) => ({
  game: w.game, log: { error: vi.fn(), warn: vi.fn() }, notify: vi.fn(),
  raiseAShield: vi.fn(async () => {}), sleepFn: vi.fn(async () => {}), isModuleCombat: () => true, ...over,
});

beforeEach(() => pendingDefensiveAdvance.clear());

describe("onDefensiveAdviceCard", () => {
  it("raises the shield and arms the pending Strike", async () => {
    const w = world(); const deps = mkDeps(w);
    await onDefensiveAdviceCard(card(), deps);
    expect(deps.raiseAShield).toHaveBeenCalledTimes(1);
    expect(deps.raiseAShield).toHaveBeenCalledWith({ actors: [w.mover.actor] });
    expect(pendingDefensiveAdvance.get("t1")).toEqual({
      tokenId: "t1", combatId: "k1", combatantId: "c1", round: 2, featMessageId: "m1",
    });
  });

  it("never lowers an already-raised shield (raiseAShield is a toggle) but still arms", async () => {
    const w = world({ shield: { isRaised: true } }); const deps = mkDeps(w);
    await onDefensiveAdviceCard(card(), deps);
    expect(deps.raiseAShield).not.toHaveBeenCalled();
    expect(deps.notify).toHaveBeenCalledWith("PF2EDC.Dungeon.Combat.DefensiveAdvance.ShieldAlreadyRaised");
    expect(pendingDefensiveAdvance.has("t1")).toBe(true);
  });

  it("with no shield, notifies, does not raise, and still arms", async () => {
    const w = world({ shield: null }); const deps = mkDeps(w);
    await onDefensiveAdviceCard(card(), deps);
    expect(deps.raiseAShield).not.toHaveBeenCalled();
    expect(deps.notify).toHaveBeenCalledWith("PF2EDC.Dungeon.Combat.DefensiveAdvance.NoShield");
    expect(pendingDefensiveAdvance.has("t1")).toBe(true);
  });

  it("waits for the tracker to log the feat card before raising", async () => {
    const w = world({ trackerLog: [] });
    let calls = 0;
    const deps = mkDeps(w, {
      sleepFn: vi.fn(async () => { if (++calls === 3) w.mover.flags[TRACKER_NAMESPACE].log = [{ msgId: "m1" }]; }),
    });
    await onDefensiveAdviceCard(card(), deps);
    expect(deps.sleepFn).toHaveBeenCalledTimes(3);
    expect(deps.raiseAShield).toHaveBeenCalledTimes(1);
  });

  it("raises anyway after the wait times out", async () => {
    const w = world({ trackerLog: [] }); const deps = mkDeps(w);
    await onDefensiveAdviceCard(card(), deps);
    expect(deps.raiseAShield).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["another feat", { flags: { pf2e: { origin: { type: "feat", rollOptions: ["origin:item:slug:devoted-guardian"] } } } }, {}],
    ["another user's card", { author: { id: "u2" } }, {}],
    ["an AI-controlled combatant", {}, { agent: true }],
    ["not the combatant's turn", {}, { current: false }],
    ["a defeated combatant", {}, { defeated: true }],
  ])("does nothing for %s", async (_name, msgOver, worldOver) => {
    const w = world(worldOver); const deps = mkDeps(w);
    await onDefensiveAdviceCard(card(msgOver), deps);
    expect(deps.raiseAShield).not.toHaveBeenCalled();
    expect(pendingDefensiveAdvance.size).toBe(0);
  });

  it("does nothing outside a module combat", async () => {
    const w = world(); const deps = mkDeps(w, { isModuleCombat: () => false });
    await onDefensiveAdviceCard(card(), deps);
    expect(pendingDefensiveAdvance.size).toBe(0);
  });

  it("never throws: a failing raise is logged and the Strike still stays armed", async () => {
    const w = world(); const deps = mkDeps(w, { raiseAShield: vi.fn(async () => { throw new Error("boom"); }) });
    await expect(onDefensiveAdviceCard(card(), deps)).resolves.toBeUndefined();
    expect(deps.log.error).toHaveBeenCalled();
    expect(pendingDefensiveAdvance.has("t1")).toBe(true);
  });
});

describe("waitForTrackerLog", () => {
  it("resolves true immediately when the predicate already holds", async () => {
    const c = { flags: { [TRACKER_NAMESPACE]: { log: [{ msgId: "m1" }] } } };
    const sleepFn = vi.fn(async () => {});
    expect(await waitForTrackerLog(c, (l) => l.length === 1, { sleepFn })).toBe(true);
    expect(sleepFn).not.toHaveBeenCalled();
  });
  it("resolves false after the attempts are used up, treating a missing log as empty", async () => {
    const c = { flags: {} };
    const sleepFn = vi.fn(async () => {});
    expect(await waitForTrackerLog(c, (l) => l.length > 0, { attempts: 4, sleepFn })).toBe(false);
    expect(sleepFn).toHaveBeenCalledTimes(4);
  });
});

import { onDefensiveAdviceMove } from "../scripts/defensive-advance.mjs";
import { armPending } from "../scripts/defensive-advance-logic.mjs";

function moveWorld({ targets = "one", targetOver = {}, strikeOver = {}, trackerLog, hostile = true, hookRound = 2 } = {}) {
  const strike = {
    type: "strike", ready: true, totalModifier: 9, name: "Morningstar",
    variants: [{ roll: vi.fn(async () => ({ degreeOfSuccess: 2 })) }, { roll: vi.fn(async () => ({ degreeOfSuccess: 2 })) }, { roll: vi.fn(async () => ({ degreeOfSuccess: 2 })) }],
    damage: vi.fn(async () => ({})), ...strikeOver,
  };
  const featLog = [{
    msgId: "m1", ComplexActionState: { leaves: { s: { type: "move", childActions: [{ msgId: "x" }] } }, orderedActivityChildActions: [] },
  }];
  const w = world({ trackerLog: trackerLog ?? featLog });
  w.mover.actor = { heldShield: { isRaised: true }, system: { actions: [strike] } };
  const targetDoc = { id: "t2", x: 200, y: 0, width: 1, height: 1 };
  const targetCombatant = { id: "c2", tokenId: "t2", isDefeated: false, token: targetDoc, ...targetOver };
  w.combat.round = hookRound;
  w.combat.scene.grid = { size: 100, distance: 5 };
  w.combat.combatants = {
    find: (fn) => [w.mover, targetCombatant].find(fn),
    get: (id) => [w.mover, targetCombatant].find((c) => c.id === id),
  };
  w.game.user.targets = targets === "one" ? new Set([{ document: targetDoc }]) : targets === "none" ? new Set() : new Set([{ document: targetDoc }, { document: { id: "t3" } }]);
  w.game.combats.get = () => w.combat;
  w.game.messages = { contents: [] };
  const tokenDoc = { id: "t1", x: 100, y: 0, width: 1, height: 1 };
  const deps = mkDeps(w, {
    chebyshevSquares: (a, b) => Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y)) / 100,
    actionReachSquares: () => 1,
    isMeleeStrikeAction: () => true,
    areHostile: () => hostile,
    withDialogsSuppressed: async (_game, fn) => fn(),
  });
  return { ...w, strike, tokenDoc, deps, targetCombatant };
}
const move = (over = {}) => ({ method: "dragging", origin: { x: 0, y: 0 }, passed: { waypoints: [{ x: 100, y: 0 }] }, ...over });
const arm = (over = {}) =>
  armPending(pendingDefensiveAdvance, { tokenId: "t1", combatId: "k1", combatantId: "c1", round: 2, featMessageId: "m1", ...over });

describe("onDefensiveAdviceMove", () => {
  it("Strikes the targeted enemy in reach (attack then damage on a hit) and spends the pending state", async () => {
    const w = moveWorld(); arm();
    await onDefensiveAdviceMove(w.tokenDoc, move(), w.deps);
    expect(w.strike.variants[0].roll).toHaveBeenCalledTimes(1);
    const rollArgs = w.strike.variants[0].roll.mock.calls[0][0];
    expect(rollArgs.target).toEqual({ document: w.targetCombatant.token });
    expect(rollArgs.createMessage).toBe(true);
    expect(rollArgs.skipDialog).toBe(true);
    expect(w.strike.damage).toHaveBeenCalledWith({ target: { document: w.targetCombatant.token }, outcome: "success", createMessage: true });
    expect(pendingDefensiveAdvance.size).toBe(0);
  });

  it("rolls damage as a critical on a critical hit and none on a miss", async () => {
    const crit = moveWorld(); arm();
    crit.strike.variants[0].roll = vi.fn(async () => ({ degreeOfSuccess: 3 }));
    await onDefensiveAdviceMove(crit.tokenDoc, move(), crit.deps);
    expect(crit.strike.damage.mock.calls[0][0].outcome).toBe("criticalSuccess");

    pendingDefensiveAdvance.clear();
    const miss = moveWorld(); arm();
    miss.strike.variants[0].roll = vi.fn(async () => ({ degreeOfSuccess: 1 }));
    await onDefensiveAdviceMove(miss.tokenDoc, move(), miss.deps);
    expect(miss.strike.damage).not.toHaveBeenCalled();
  });

  it("uses the MAP variant from the tracker log", async () => {
    const log = [
      { msgId: "a1", isMapRelevant: true, type: "action" },
      { msgId: "m1", ComplexActionState: { leaves: { s: { type: "move", childActions: [{}] } }, orderedActivityChildActions: [] } },
    ];
    const w = moveWorld({ trackerLog: log }); arm();
    await onDefensiveAdviceMove(w.tokenDoc, move(), w.deps);
    expect(w.strike.variants[1].roll).toHaveBeenCalledTimes(1);
    expect(w.strike.variants[0].roll).not.toHaveBeenCalled();
  });

  it("falls back to no penalty and tells the player when the tracker log is unreadable", async () => {
    const w = moveWorld(); arm();
    delete w.mover.flags[TRACKER_NAMESPACE];
    await onDefensiveAdviceMove(w.tokenDoc, move(), { ...w.deps, sleepFn: vi.fn(async () => {}) });
    expect(w.strike.variants[0].roll).toHaveBeenCalledTimes(1);
    expect(w.deps.notify).toHaveBeenCalledWith("PF2EDC.Dungeon.Combat.DefensiveAdvance.MapUnknown");
  });

  it("waits for the tracker to log the Stride before rolling", async () => {
    const w = moveWorld({ trackerLog: [{ msgId: "m1", ComplexActionState: { leaves: { s: { type: "move", childActions: [] } } } }] }); arm();
    let n = 0;
    const deps = { ...w.deps, sleepFn: vi.fn(async () => {
      if (++n === 2) w.mover.flags[TRACKER_NAMESPACE].log[0].ComplexActionState.leaves.s.childActions = [{}];
    }) };
    await onDefensiveAdviceMove(w.tokenDoc, move(), deps);
    expect(deps.sleepFn).toHaveBeenCalledTimes(2);
    expect(w.strike.variants[0].roll).toHaveBeenCalledTimes(1);
  });

  it.each([["none", "TargetOne"], ["many", "TargetOne"]])("with %s targeted: notifies, no Strike, pending spent", async (targets, key) => {
    const w = moveWorld({ targets }); arm();
    await onDefensiveAdviceMove(w.tokenDoc, move(), w.deps);
    expect(w.deps.notify).toHaveBeenCalledWith(`PF2EDC.Dungeon.Combat.DefensiveAdvance.${key}`);
    expect(w.strike.variants[0].roll).not.toHaveBeenCalled();
    expect(pendingDefensiveAdvance.size).toBe(0);
  });

  it.each([
    ["an ally", { hostile: false }],
    ["a defeated creature", { targetOver: { isDefeated: true } }],
  ])("does not Strike %s", async (_n, over) => {
    const w = moveWorld(over); arm();
    await onDefensiveAdviceMove(w.tokenDoc, move(), w.deps);
    expect(w.deps.notify).toHaveBeenCalledWith("PF2EDC.Dungeon.Combat.DefensiveAdvance.TargetInvalid");
    expect(w.strike.variants[0].roll).not.toHaveBeenCalled();
  });

  it("does not Strike a target out of reach, silently, and spends the pending state", async () => {
    const w = moveWorld({ targetOver: { token: { id: "t2", x: 500, y: 0, width: 1, height: 1 } } }); arm();
    w.game.user.targets = new Set([{ document: w.targetCombatant.token }]);
    await onDefensiveAdviceMove(w.tokenDoc, move(), w.deps);
    expect(w.strike.variants[0].roll).not.toHaveBeenCalled();
    expect(w.deps.notify).not.toHaveBeenCalled();
    expect(pendingDefensiveAdvance.size).toBe(0);
  });

  it("ignores another user's drag and keeps the pending state for the player's own move", async () => {
    const w = moveWorld(); arm();
    await onDefensiveAdviceMove(w.tokenDoc, move(), w.deps, [{ id: "gm", isGM: true }]);
    expect(w.strike.variants[0].roll).not.toHaveBeenCalled();
    expect(pendingDefensiveAdvance.size).toBe(1);
  });

  it("accepts the player's own user in the hook arguments", async () => {
    const w = moveWorld(); arm();
    await onDefensiveAdviceMove(w.tokenDoc, move(), w.deps, [{}, { id: "u1", isGM: false }]);
    expect(w.strike.variants[0].roll).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["a displace waypoint", move({ passed: { waypoints: [{ x: 100, y: 0, action: "displace" }] } })],
    ["a non-drag method", move({ method: "api" })],
    ["no waypoints", move({ passed: { waypoints: [] } })],
  ])("ignores %s", async (_n, mv) => {
    const w = moveWorld(); arm();
    await onDefensiveAdviceMove(w.tokenDoc, mv, w.deps);
    expect(w.strike.variants[0].roll).not.toHaveBeenCalled();
    expect(pendingDefensiveAdvance.size).toBe(1);
  });

  it("does nothing for a token with no pending Defensive Advance", async () => {
    const w = moveWorld();
    await onDefensiveAdviceMove(w.tokenDoc, move(), w.deps);
    expect(w.strike.variants[0].roll).not.toHaveBeenCalled();
  });

  it("drops stale pending state from an earlier round or a different turn", async () => {
    const w = moveWorld({ hookRound: 3 }); arm({ round: 2 });
    await onDefensiveAdviceMove(w.tokenDoc, move(), w.deps);
    expect(w.strike.variants[0].roll).not.toHaveBeenCalled();
    expect(pendingDefensiveAdvance.size).toBe(0);
  });

  it("never throws: a failing roll is logged", async () => {
    const w = moveWorld(); arm();
    w.strike.variants[0].roll = vi.fn(async () => { throw new Error("boom"); });
    await expect(onDefensiveAdviceMove(w.tokenDoc, move(), w.deps)).resolves.toBeUndefined();
    expect(w.deps.log.error).toHaveBeenCalled();
  });
});

describe("withDialogsSuppressed", () => {
  it("turns the roll dialogs off for the call and restores the previous values", async () => {
    const { withDialogsSuppressed } = await import("../scripts/defensive-advance.mjs");
    const update = vi.fn(async () => {});
    const game = { user: { flags: { pf2e: { settings: { showCheckDialogs: true, showDamageDialogs: true } } }, update } };
    const result = await withDialogsSuppressed(game, async () => "done");
    expect(result).toBe("done");
    expect(update).toHaveBeenNthCalledWith(1, { "flags.pf2e.settings.showCheckDialogs": false, "flags.pf2e.settings.showDamageDialogs": false });
    expect(update).toHaveBeenNthCalledWith(2, { "flags.pf2e.settings.showCheckDialogs": true, "flags.pf2e.settings.showDamageDialogs": true });
  });
  it("restores even when the callback throws", async () => {
    const { withDialogsSuppressed } = await import("../scripts/defensive-advance.mjs");
    const update = vi.fn(async () => {});
    const game = { user: { flags: { pf2e: { settings: { showCheckDialogs: true, showDamageDialogs: false } } }, update } };
    await expect(withDialogsSuppressed(game, async () => { throw new Error("x"); })).rejects.toThrow("x");
    expect(update).toHaveBeenLastCalledWith({ "flags.pf2e.settings.showCheckDialogs": true, "flags.pf2e.settings.showDamageDialogs": false });
  });
});

describe("lifecycle clearing", () => {
  it("a turn or round change clears that combat's pending state only", () => {
    arm({ tokenId: "a", combatId: "k1" }); arm({ tokenId: "b", combatId: "k2" });
    expect(onDefensiveAdviceCombatUpdate({ id: "k1" }, { turn: 3 })).toBe(1);
    expect([...pendingDefensiveAdvance.keys()]).toEqual(["b"]);
  });
  it("a round change clears too; an unrelated update does not", () => {
    arm({ tokenId: "a", combatId: "k1" });
    expect(onDefensiveAdviceCombatUpdate({ id: "k1" }, { scene: "x" })).toBe(0);
    expect(onDefensiveAdviceCombatUpdate({ id: "k1" }, { round: 4 })).toBe(1);
  });
  it("deleting a combat clears its pending state", () => {
    arm({ tokenId: "a", combatId: "k1" });
    expect(clearDefensiveAdvanceForCombat({ id: "k1" })).toBe(1);
    expect(pendingDefensiveAdvance.size).toBe(0);
  });
});

describe("registerDefensiveAdvanceHooks", () => {
  it("registers the four hooks; the card hook does not pass hook options in as deps", async () => {
    const handlers = {};
    registerDefensiveAdvanceHooks({ on: (name, fn) => { handlers[name] = fn; } });
    expect(Object.keys(handlers).sort()).toEqual(["createChatMessage", "deleteCombat", "moveToken", "updateCombat"]);
    // createChatMessage passes (message, options, userId): options must not be read as deps.
    await expect(handlers.createChatMessage({ flags: {} }, { game: "NOT-A-GAME" }, "u1")).resolves.toBeUndefined();
  });
});
