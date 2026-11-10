import { describe, it, expect, vi } from "vitest";
import {
  onViciousSwingCard, fixTrackerCost, waitForLogEntries, sweepExtraDiceEffects,
  registerViciousSwingHooks, onViciousSwingCombatUpdate,
} from "../scripts/vicious-swing.mjs";
import { TRACKER_NAMESPACE } from "../scripts/defensive-advance-logic.mjs";
import { EXTRA_DICE_OPTION, EXTRA_DICE_EFFECT_SLUG } from "../scripts/vicious-swing-logic.mjs";

const MODULE_ID = "pf2e-dungeon-crawl";
const L = "PF2EDC";

function world({
  trackerLog = [{ msgId: "m1" }], agent = false, current = true, defeated = false,
  targets = "one", hostile = true, targetDefeated = false, inCombat = true,
  die = "d8", level = 5, degree = 2, damageThrows = false, strikeInReach = true,
} = {}) {
  const calls = [];
  const variants = [0, 1, 2].map((i) => ({
    roll: vi.fn(async (p) => { calls.push(`roll${i}`); return { degreeOfSuccess: degree, p }; }),
  }));
  const strike = {
    type: "strike", ready: true, totalModifier: 10, variants,
    item: { system: { damage: { die } } },
    damage: vi.fn(async () => { calls.push("damage"); if (damageThrows) throw new Error("boom"); }),
    critical: vi.fn(async () => { calls.push("critical"); if (damageThrows) throw new Error("boom"); }),
  };
  const actor = {
    id: "a1", level, items: [], system: { actions: [strike] },
    createEmbeddedDocuments: vi.fn(async (_t, data) => { calls.push("create"); return data.map((_, i) => ({ id: `e${i}` })); }),
    deleteEmbeddedDocuments: vi.fn(async () => { calls.push("delete"); }),
  };
  const mover = {
    id: "c1", tokenId: "t1", isDefeated: defeated, actor, token: { id: "t1" }, name: "Fighter",
    getFlag: (s, k) => (s === MODULE_ID && k === "agentControlled" ? agent : undefined),
    flags: { [TRACKER_NAMESPACE]: { log: trackerLog } },
  };
  const target = { id: "c2", tokenId: "t2", isDefeated: targetDefeated, token: { id: "t2" } };
  const all = inCombat ? [mover, target] : [mover];
  const combat = {
    id: "k1", round: 2, started: true, scene: { id: "s1", grid: { size: 100, distance: 5 } },
    combatant: current ? mover : { id: "other" },
    combatants: { find: (fn) => all.find(fn), get: (id) => all.find((c) => c.id === id) },
  };
  const tgtToken = { document: { id: "t2" } };
  const userTargets = targets === "none" ? [] : targets === "many" ? [tgtToken, { document: { id: "t3" } }] : [tgtToken];
  const messages = { contents: [{
    id: "s-msg", timestamp: 2000, author: { id: "u1" }, speaker: { actor: "a1" },
    flags: { pf2e: { context: { type: "attack-roll" } } },
  }] };
  const game = { user: { id: "u1", targets: new Set(userTargets) }, combats: { contents: [combat], get: () => combat }, messages };
  return { mover, target, combat, game, actor, strike, variants, calls, hostile, strikeInReach };
}
const card = (over = {}) => ({
  id: "m1", author: { id: "u1" }, speaker: { scene: "s1", token: "t1" },
  flags: { pf2e: { origin: { type: "feat", rollOptions: ["origin:item:slug:vicious-swing"] } } },
  ...over,
});
function mkDeps(w, over = {}) {
  const socket = { executeAsGM: vi.fn(async () => {}) };
  return {
    socket,
    game: w.game, log: { error: vi.fn(), warn: vi.fn() }, notify: vi.fn(), whisperGM: vi.fn(),
    sleepFn: vi.fn(async () => {}), now: () => 1000, isModuleCombat: () => true,
    isMeleeStrikeAction: () => true, chebyshevSquares: () => 1, actionReachSquares: () => (w.strikeInReach ? 1 : 0),
    areHostile: () => w.hostile, withDialogsSuppressed: async (_g, fn) => fn(),
    getTrackerSocket: () => socket,
    ...over,
  };
}
const withIds = (w, ids = ["m1", "s-msg"]) => { w.mover.flags[TRACKER_NAMESPACE].log = ids.map((msgId) => ({ msgId })); };

describe("early exits", () => {
  const cases = [
    ["no target", { targets: "none" }, "TargetNone"],
    ["two targets", { targets: "many" }, "TargetMany"],
    ["ally", { hostile: false }, "TargetNotHostile"],
    ["defeated target", { targetDefeated: true }, "TargetDefeated"],
    ["out of reach", { strikeInReach: false }, "NoStrikeInReach"],
  ];
  it.each(cases)("%s -> notify, no roll, no tracker call", async (_n, opts, key) => {
    const w = world(opts); const deps = mkDeps(w);
    await onViciousSwingCard(card(), deps);
    expect(deps.notify).toHaveBeenCalledTimes(1);
    expect(deps.notify).toHaveBeenCalledWith(key);
    expect(w.variants[0].roll).not.toHaveBeenCalled();
    expect(deps.socket.executeAsGM).not.toHaveBeenCalled();
  });

  it("ignores other authors, other messages, AI combatants and off-turn", async () => {
    for (const [msg, opts] of [
      [card({ author: { id: "u2" } }), {}],
      [card({ flags: { pf2e: { origin: { type: "feat", rollOptions: ["origin:item:slug:x"] } } } }), {}],
      [card(), { agent: true }],
      [card(), { current: false }],
    ]) {
      const w = world(opts); const deps = mkDeps(w);
      await onViciousSwingCard(msg, deps);
      expect(deps.notify).not.toHaveBeenCalled();
      expect(w.variants[0].roll).not.toHaveBeenCalled();
      expect(deps.socket.executeAsGM).not.toHaveBeenCalled();
    }
  });
});

describe("Strike flow", () => {
  it("hit: rolls variant 0, creates the effect before damage, deletes it after", async () => {
    const w = world({ level: 10 }); withIds(w); const deps = mkDeps(w);
    await onViciousSwingCard(card(), deps);
    expect(w.variants[0].roll).toHaveBeenCalledTimes(1);
    expect(w.variants[0].roll.mock.calls[0][0]).toMatchObject({ target: { document: w.target.token }, skipDialog: true });
    expect(w.strike.damage).toHaveBeenCalledTimes(1);
    expect(w.strike.damage.mock.calls[0][0].options).toContain(EXTRA_DICE_OPTION);
    expect(w.calls).toEqual(["roll0", "create", "damage", "delete"]);
    const effect = w.actor.createEmbeddedDocuments.mock.calls[0][1][0];
    expect(effect.system.slug).toBe(EXTRA_DICE_EFFECT_SLUG);
    expect(effect.system.rules[0]).toMatchObject({ diceNumber: 2, dieSize: "d8" });
  });

  it("crit: rolls the critical damage", async () => {
    const w = world({ degree: 3 }); withIds(w); const deps = mkDeps(w);
    await onViciousSwingCard(card(), deps);
    expect(w.strike.critical).toHaveBeenCalledTimes(1);
    expect(w.strike.critical.mock.calls[0][0].options).toContain(EXTRA_DICE_OPTION);
    expect(w.strike.damage).not.toHaveBeenCalled();
  });

  it("miss: no damage, no effect, cost fix still runs", async () => {
    const w = world({ degree: 1 }); withIds(w); const deps = mkDeps(w);
    await onViciousSwingCard(card(), deps);
    expect(w.strike.damage).not.toHaveBeenCalled();
    expect(w.actor.createEmbeddedDocuments).not.toHaveBeenCalled();
    expect(deps.socket.executeAsGM).toHaveBeenCalledTimes(2);
  });

  it("damage throws: effect still deleted, error logged, cost fix still runs", async () => {
    const w = world({ damageThrows: true }); withIds(w); const deps = mkDeps(w);
    await onViciousSwingCard(card(), deps);
    expect(w.actor.deleteEmbeddedDocuments).toHaveBeenCalledTimes(1);
    expect(deps.log.error).toHaveBeenCalled();
    expect(deps.log.error.mock.calls[0][0]).toContain("#1281");
    expect(deps.socket.executeAsGM).toHaveBeenCalledTimes(2);
  });

  it.each([[0, 0], [1, 1], [2, 2], [3, 2]])("%i prior attacks -> variant %i", async (prior, idx) => {
    const log = [{ msgId: "m1" }, ...Array.from({ length: prior }, (_, i) => ({ msgId: `p${i}`, isMapRelevant: true }))];
    const w = world({ trackerLog: log }); const deps = mkDeps(w);
    await onViciousSwingCard(card(), deps);
    expect(w.variants[idx].roll).toHaveBeenCalledTimes(1);
  });

  it("the card's own log entry is not counted as a prior attack", async () => {
    const w = world({ trackerLog: [{ msgId: "m1", isMapRelevant: true }] }); const deps = mkDeps(w);
    await onViciousSwingCard(card(), deps);
    expect(w.variants[0].roll).toHaveBeenCalledTimes(1);
  });

  it("unreadable tracker log: variant 0 and a notice", async () => {
    const w = world(); w.mover.flags[TRACKER_NAMESPACE] = {}; const deps = mkDeps(w);
    await onViciousSwingCard(card(), deps);
    expect(w.variants[0].roll).toHaveBeenCalledTimes(1);
    expect(deps.notify).toHaveBeenCalledWith("MapUnknown");
  });

  it("null weapon die: Strike rolled, no effect, notice, plain damage", async () => {
    const w = world({ die: null }); withIds(w); const deps = mkDeps(w);
    await onViciousSwingCard(card(), deps);
    expect(w.variants[0].roll).toHaveBeenCalledTimes(1);
    expect(w.actor.createEmbeddedDocuments).not.toHaveBeenCalled();
    expect(deps.notify).toHaveBeenCalledWith("NoWeaponDie");
    expect(w.strike.damage.mock.calls[0][0].options).toBeUndefined();
  });

  it("stands down when the tracker models the card as an activity", async () => {
    const w = world({ trackerLog: [{ msgId: "m1", ComplexActionState: {} }] }); const deps = mkDeps(w);
    await onViciousSwingCard(card(), deps);
    expect(w.variants[0].roll).not.toHaveBeenCalled();
    expect(deps.socket.executeAsGM).not.toHaveBeenCalled();
  });
});

describe("fixTrackerCost", () => {
  const mk = (log) => ({ id: "c1", name: "F", flags: { [TRACKER_NAMESPACE]: { log } } });

  it("waits for both ids, then edits card and Strike", async () => {
    const combatant = mk([{ msgId: "m1" }]);
    let n = 0;
    const socket = { executeAsGM: vi.fn(async () => {}) };
    const sleepFn = vi.fn(async () => { if (++n === 2) combatant.flags[TRACKER_NAMESPACE].log.push({ msgId: "s1" }); });
    const ok = await fixTrackerCost({ combatant, cardMsgId: "m1", strikeMsgId: "s1" }, {
      sleepFn, getTrackerSocket: () => socket, notify: vi.fn(), log: { warn: vi.fn() },
    });
    expect(ok).toBe(true);
    expect(sleepFn).toHaveBeenCalledTimes(2);
    expect(socket.executeAsGM).toHaveBeenNthCalledWith(1, "editAction", { combatantId: "c1", msgId: "m1", updates: { isMapRelevant: true } });
    expect(socket.executeAsGM).toHaveBeenNthCalledWith(2, "editAction", { combatantId: "c1", msgId: "s1", updates: { cost: 0 } });
  });

  it("times out: no edit, notify and whisper the GM", async () => {
    const socket = { executeAsGM: vi.fn() }; const notify = vi.fn(); const whisperGM = vi.fn();
    const ok = await fixTrackerCost({ combatant: mk([{ msgId: "m1" }]), cardMsgId: "m1", strikeMsgId: "s1" }, {
      sleepFn: async () => {}, getTrackerSocket: () => socket, notify, whisperGM, log: { warn: vi.fn() },
    });
    expect(ok).toBe(false);
    expect(socket.executeAsGM).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledWith("FixFailed");
    expect(whisperGM).toHaveBeenCalled();
  });

  it("no Strike message id: no edit, fix-failed", async () => {
    const socket = { executeAsGM: vi.fn() }; const notify = vi.fn();
    const ok = await fixTrackerCost({ combatant: mk([{ msgId: "m1" }]), cardMsgId: "m1", strikeMsgId: null }, {
      sleepFn: async () => {}, getTrackerSocket: () => socket, notify, whisperGM: vi.fn(), log: { warn: vi.fn() },
    });
    expect(ok).toBe(false);
    expect(socket.executeAsGM).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledWith("FixFailed");
  });

  it("missing tracker socket: fix-failed", async () => {
    const notify = vi.fn();
    const ok = await fixTrackerCost({ combatant: mk([{ msgId: "m1" }, { msgId: "s1" }]), cardMsgId: "m1", strikeMsgId: "s1" }, {
      sleepFn: async () => {}, getTrackerSocket: () => undefined, notify, whisperGM: vi.fn(), log: { warn: vi.fn() },
    });
    expect(ok).toBe(false);
    expect(notify).toHaveBeenCalledWith("FixFailed");
  });
});

describe("waitForLogEntries", () => {
  it("resolves true once all ids are present", async () => {
    const c = { flags: { [TRACKER_NAMESPACE]: { log: [{ msgId: "a" }, { msgId: "b" }] } } };
    expect(await waitForLogEntries(c, ["a", "b"], { sleepFn: async () => {} })).toBe(true);
  });
});

describe("sweepExtraDiceEffects", () => {
  it("deletes only the extra-dice effects and swallows errors", async () => {
    const actor = { items: [{ id: "a", slug: EXTRA_DICE_EFFECT_SLUG }, { id: "b", slug: "x" }], deleteEmbeddedDocuments: vi.fn(async () => {}) };
    await sweepExtraDiceEffects(actor);
    expect(actor.deleteEmbeddedDocuments).toHaveBeenCalledWith("Item", ["a"]);
    const bad = { items: [{ id: "a", slug: EXTRA_DICE_EFFECT_SLUG }], deleteEmbeddedDocuments: vi.fn(async () => { throw new Error("x"); }) };
    await expect(sweepExtraDiceEffects(bad)).resolves.toBeUndefined();
  });
});

describe("hooks", () => {
  it("registers one createChatMessage and one updateCombat handler", () => {
    const hooks = { on: vi.fn(), once: vi.fn() };
    registerViciousSwingHooks(hooks);
    expect(hooks.on.mock.calls.filter(([n]) => n === "createChatMessage")).toHaveLength(1);
    expect(hooks.on.mock.calls.filter(([n]) => n === "updateCombat")).toHaveLength(1);
  });

  it("updateCombat sweeps only on a turn/round change and only for an owned actor", async () => {
    const mk = (isOwner) => ({
      previous: { combatantId: "c1" },
      combatants: { get: () => ({ actor: { isOwner, items: [{ id: "a", slug: EXTRA_DICE_EFFECT_SLUG }], deleteEmbeddedDocuments: vi.fn(async () => {}) } }) },
    });
    const owned = mk(true);
    await onViciousSwingCombatUpdate(owned, { turn: 1 });
    expect(owned.combatants.get().actor.deleteEmbeddedDocuments).not.toBe(undefined);
    const spyOwned = mk(true); const a = spyOwned.combatants.get(); spyOwned.combatants.get = () => a;
    await onViciousSwingCombatUpdate(spyOwned, { round: 2 });
    expect(a.actor.deleteEmbeddedDocuments).toHaveBeenCalledTimes(1);
    const spyOther = mk(true); const b = spyOther.combatants.get(); spyOther.combatants.get = () => b;
    await onViciousSwingCombatUpdate(spyOther, { name: "x" });
    expect(b.actor.deleteEmbeddedDocuments).not.toHaveBeenCalled();
    const notOwned = mk(false); const c = notOwned.combatants.get(); notOwned.combatants.get = () => c;
    await onViciousSwingCombatUpdate(notOwned, { turn: 3 });
    expect(c.actor.deleteEmbeddedDocuments).not.toHaveBeenCalled();
  });
});
