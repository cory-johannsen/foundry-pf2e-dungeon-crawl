import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  startCombatForRoom,
  rollStealthInitiativeAndDetect,
  clearDetection,
} from "../scripts/dungeon-combat.mjs";

// #616 Task 2: Stealth initiative + detection matrix at combat start.

const MOD = "pf2e-dungeon-crawl";

function makeCombat() {
  const flags = {};
  const calls = [];
  const combat = {
    id: "cbt",
    flags,
    calls,
    getFlag: (m, k) => flags[`${m}.${k}`],
    setFlag: vi.fn(async (m, k, v) => {
      calls.push(["setFlag", k]);
      flags[`${m}.${k}`] = v;
    }),
    unsetFlag: vi.fn(async (m, k) => {
      delete flags[`${m}.${k}`];
    }),
    rollInitiative: vi.fn(async (ids, opts) => calls.push(["rollInitiative", ids, opts])),
    setMultipleInitiatives: vi.fn(async (u) => calls.push(["setMultipleInitiatives", u])),
    startCombat: vi.fn(async () => calls.push(["startCombat"])),
    createEmbeddedDocuments: vi.fn(),
    combatants: new Map(),
  };
  return combat;
}

function actor(id, { sneaking = false, dc = 15, stealthTotal = 20, conds = [] } = {}) {
  const item = { id: `${id}-an`, slug: "avoid-notice" };
  return {
    id,
    name: id,
    system: { exploration: sneaking ? [item.id] : [] },
    items: sneaking ? [item] : [],
    perception: { dc: { value: dc } },
    skills: { stealth: { roll: vi.fn(async () => ({ total: stealthTotal })) } },
    conds: new Set(conds),
  };
}

const comb = (id, a) => ({ id, name: id, actor: a });

function deps(partyIds, over = {}) {
  return {
    partyIds: new Set(partyIds),
    rollStealth: vi.fn(async (a) => a.skills.stealth.roll({ createMessage: true })),
    hasCondition: vi.fn((a, slug) => a.conds.has(slug)),
    setCondition: vi.fn(async (a, slug, on) => (on ? a.conds.add(slug) : a.conds.delete(slug))),
    chat: vi.fn(async () => {}),
    ...over,
  };
}

describe("rollStealthInitiativeAndDetect", () => {
  it("no sneakers: one rollInitiative over all ids, no flags, no chat, no stealth", async () => {
    const combat = makeCombat();
    const pc = actor("pc");
    const combatants = [comb("c1", actor("m1")), comb("c2", pc)];
    const d = deps(["pc"]);
    await rollStealthInitiativeAndDetect(combat, combatants, d);
    expect(combat.calls).toEqual([["rollInitiative", ["c1", "c2"], { skipDialog: true }]]);
    expect(combat.setFlag).not.toHaveBeenCalled();
    expect(d.chat).not.toHaveBeenCalled();
    expect(d.rollStealth).not.toHaveBeenCalled();
    expect(d.setCondition).not.toHaveBeenCalled();
  });

  it("one sneaker: stealth for it only, others via rollInitiative, matrix stored", async () => {
    const combat = makeCombat();
    const sneak = actor("pc1", { sneaking: true, stealthTotal: 18 });
    const normal = actor("pc2");
    const m1 = actor("m1", { dc: 15 });
    const m2 = actor("m2", { dc: 20 });
    const combatants = [comb("c1", m1), comb("c2", m2), comb("p1", sneak), comb("p2", normal)];
    const d = deps(["pc1", "pc2"]);
    await rollStealthInitiativeAndDetect(combat, combatants, d);
    expect(d.rollStealth).toHaveBeenCalledTimes(1);
    expect(d.rollStealth).toHaveBeenCalledWith(sneak);
    expect(combat.rollInitiative).toHaveBeenCalledWith(["c1", "c2", "p2"], { skipDialog: true });
    expect(combat.setMultipleInitiatives).toHaveBeenCalledWith([
      { id: "p1", value: 18, statistic: "stealth" },
    ]);
    // 18 >= 15 unnoticed, 18 < 20 observed -> alarm: unnoticed -> undetected
    expect(combat.getFlag(MOD, "detection")).toEqual({
      p1: { c1: "undetected", c2: "observed" },
    });
    expect(d.chat).toHaveBeenCalled();
  });

  it("uniform unnoticed applies the condition and records it", async () => {
    const combat = makeCombat();
    const sneak = actor("pc1", { sneaking: true, stealthTotal: 30 });
    const combatants = [comb("c1", actor("m1")), comb("p1", sneak)];
    const d = deps(["pc1"]);
    await rollStealthInitiativeAndDetect(combat, combatants, d);
    expect(d.setCondition).toHaveBeenCalledWith(sneak, "unnoticed", true);
    expect(combat.getFlag(MOD, "appliedConditions")).toEqual({
      p1: { actorId: "pc1", slug: "unnoticed" },
    });
  });

  it("mixed states apply no condition", async () => {
    const combat = makeCombat();
    const sneak = actor("pc1", { sneaking: true, stealthTotal: 18 });
    const combatants = [
      comb("c1", actor("m1", { dc: 15 })),
      comb("c2", actor("m2", { dc: 25 })),
      comb("p1", sneak),
    ];
    const d = deps(["pc1"]);
    await rollStealthInitiativeAndDetect(combat, combatants, d);
    expect(d.setCondition).not.toHaveBeenCalled();
    expect(combat.getFlag(MOD, "appliedConditions")).toEqual({});
  });

  it("an actor that already had the condition is not recorded", async () => {
    const combat = makeCombat();
    const sneak = actor("pc1", { sneaking: true, stealthTotal: 30, conds: ["unnoticed"] });
    const combatants = [comb("c1", actor("m1")), comb("p1", sneak)];
    const d = deps(["pc1"]);
    await rollStealthInitiativeAndDetect(combat, combatants, d);
    expect(d.setCondition).not.toHaveBeenCalled();
    expect(combat.getFlag(MOD, "appliedConditions")).toEqual({});
  });

  it("owned but unselected avoid-notice item is not a sneaker", async () => {
    const combat = makeCombat();
    const a = actor("pc1", { sneaking: true });
    a.system.exploration = [];
    const d = deps(["pc1"]);
    await rollStealthInitiativeAndDetect(combat, [comb("c1", actor("m1")), comb("p1", a)], d);
    expect(d.rollStealth).not.toHaveBeenCalled();
    expect(combat.setFlag).not.toHaveBeenCalled();
  });
});

describe("clearDetection", () => {
  it("removes only recorded conditions and the flags", async () => {
    const combat = makeCombat();
    const sneak = actor("pc1", { conds: ["unnoticed"] });
    const other = actor("pc2", { conds: ["undetected"] });
    combat.combatants.set("p1", comb("p1", sneak));
    combat.combatants.set("p2", comb("p2", other));
    combat.flags[`${MOD}.detection`] = { p1: {} };
    combat.flags[`${MOD}.appliedConditions`] = { p1: { actorId: "pc1", slug: "unnoticed" } };
    const d = deps([]);
    await clearDetection(combat, d);
    expect(d.setCondition).toHaveBeenCalledTimes(1);
    expect(d.setCondition).toHaveBeenCalledWith(sneak, "unnoticed", false);
    expect(other.conds.has("undetected")).toBe(true);
    expect(combat.getFlag(MOD, "detection")).toBeUndefined();
    expect(combat.getFlag(MOD, "appliedConditions")).toBeUndefined();
  });

  it("is a no-op with no flags", async () => {
    const combat = makeCombat();
    const d = deps([]);
    await clearDetection(combat, d);
    expect(d.setCondition).not.toHaveBeenCalled();
    expect(combat.unsetFlag).not.toHaveBeenCalled();
  });
});

describe("startCombat integration", () => {
  let combat;
  beforeEach(() => {
    combat = makeCombat();
    globalThis.Combat = { create: vi.fn(async () => combat) };
    globalThis.Hooks = { on: () => {} };
    globalThis.game = {
      user: { isGM: true },
      i18n: { format: (k) => k },
      actors: { party: { members: [{ id: "pc" }] } },
      settings: { get: () => undefined },
      combats: { contents: [], has: () => false },
      modules: { get: () => ({ version: "0" }) },
    };
  });

  function scene(tokens) {
    return { id: "sc", tokens: { filter: (f) => tokens.filter(f) } };
  }
  const tok = (id, a, slot) => ({
    id,
    actor: a,
    getFlag: (m, k) => (k === "dungeonSlot" ? slot : undefined),
  });

  it("no sneaker: identical call sequence to before", async () => {
    const m = actor("m1");
    const pc = actor("pc");
    pc.id = "pc";
    combat.createEmbeddedDocuments = vi.fn(async () => [comb("c1", m), comb("c2", pc)]);
    await startCombatForRoom(scene([tok("t1", m, 1), tok("t2", pc, undefined)]), 1);
    expect(combat.calls).toEqual([
      ["setFlag", "dungeonSlot"],
      ["rollInitiative", ["c1", "c2"], { skipDialog: true }],
      ["startCombat"],
    ]);
  });
});
