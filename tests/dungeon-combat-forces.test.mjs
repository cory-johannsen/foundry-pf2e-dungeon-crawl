import { describe, it, expect, vi } from "vitest";
import {
  combatantOpponents,
  combatantAllies,
  combatSideStatus,
  startCombatForEncounterId,
  rollAndApplyStrike,
  handleAttackForRetaliation,
} from "../scripts/dungeon-combat.mjs";

const MOD = "pf2e-dungeon-crawl";
const cb = (id, forceId, disposition, isDefeated = false) => ({
  id,
  isDefeated,
  actor: { type: "npc", conditions: [] },
  token: { disposition, flags: { [MOD]: { forceId } } },
});
const mk = (combatants, forces) => ({
  combatants,
  getFlag: (m, k) => (k === "forces" ? forces : undefined),
});
const ids = (l) => l.map((c) => c.id);

describe("multi-force opponents/allies", () => {
  const P = cb("P", "party", 1);
  const U = cb("U", "undead", -1);
  const G = cb("G", "gob", -1);
  const G2 = cb("G2", "gob", -1);
  const forces = {
    undead: { hostility: "all", hostileTo: [] },
    gob: { hostility: "players", hostileTo: [] },
  };
  it("opponents per force", () => {
    const c = mk([P, U, G], forces);
    expect(ids(combatantOpponents(c, P))).toEqual(["U", "G"]);
    expect(ids(combatantOpponents(c, U))).toEqual(["P", "G"]);
    expect(ids(combatantOpponents(c, G))).toEqual(["P", "U"]);
  });
  it("allies are same force only", () => {
    const c = mk([P, U, G, G2], forces);
    expect(ids(combatantAllies(c, G))).toEqual(["G2"]);
    expect(ids(combatantOpponents(c, G))).not.toContain("G2");
  });
  it("hostileTo makes players-forces opponents", () => {
    const A = cb("A", "f2", -1);
    const B = cb("B", "f3", -1);
    const f = { f2: { hostility: "players", hostileTo: ["f3"] }, f3: { hostility: "players", hostileTo: [] } };
    expect(ids(combatantOpponents(mk([A, B], f), A))).toEqual(["B"]);
    const f0 = { f2: { hostility: "players", hostileTo: [] }, f3: { hostility: "players", hostileTo: [] } };
    expect(ids(combatantOpponents(mk([A, B], f0), A))).toEqual([]);
  });
});

describe("legacy (no table) parity", () => {
  const oldOpp = (list, c) =>
    list.filter((o) => o.id !== c.id && !o.isDefeated && o.token && o.token.disposition !== c.token.disposition);
  const oldAlly = (list, c) =>
    list.filter((o) => o.id !== c.id && !o.isDefeated && o.token && o.token.disposition === c.token.disposition);
  it("matches old disposition rule", () => {
    const list = [cb("a", "x", -1), cb("b", "x", 0), cb("c", "x", 1), cb("d", "x", -1), cb("e", "x", 1, true)];
    const c = mk(list, undefined);
    for (const m of list) {
      expect(combatantOpponents(c, m)).toEqual(oldOpp(list, m));
      expect(combatantAllies(c, m)).toEqual(oldAlly(list, m));
    }
  });
});

describe("combatSideStatus with forces", () => {
  const forces = { u: { hostility: "all", hostileTo: [] }, g: { hostility: "players", hostileTo: [] } };
  it("hostilesDefeated only when all non-party forces down", () => {
    const P = cb("P", "party", 1);
    expect(combatSideStatus(mk([P, cb("U", "u", -1, true), cb("G", "g", -1, true)], forces)).hostilesDefeated).toBe(true);
    expect(combatSideStatus(mk([P, cb("U", "u", -1), cb("G", "g", -1, true)], forces)).hostilesDefeated).toBe(false);
  });
  it("partyDefeated when party down", () => {
    const P = cb("P", "party", 1, true);
    const r = combatSideStatus(mk([P, cb("U", "u", -1)], forces));
    expect(r.partyDefeated).toBe(true);
    expect(r.hostilesDefeated).toBe(false);
  });
});

describe("startCombatForEncounterId passes forces", () => {
  it("sets forces flag before rollInitiative", async () => {
    const calls = [];
    const flags = {};
    const combat = {
      id: "cbt",
      calls,
      getFlag: (m, k) => flags[`${m}.${k}`],
      setFlag: vi.fn(async (m, k, v) => {
        calls.push(["setFlag", k, v]);
        flags[`${m}.${k}`] = v;
      }),
      rollInitiative: vi.fn(async () => calls.push(["rollInitiative"])),
      setMultipleInitiatives: vi.fn(async () => {}),
      startCombat: vi.fn(async () => calls.push(["startCombat"])),
      createEmbeddedDocuments: vi.fn(async () => [cb("c1", "g", -1)]),
      combatants: new Map(),
    };
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
    const m = { id: "m1", items: [], system: { exploration: [] } };
    const tok = { id: "t1", actor: m, getFlag: (mod, k) => (k === "encounterId" ? "e1" : undefined) };
    const scene = { id: "sc", tokens: { filter: (f) => [tok].filter(f) } };
    const table = { g: { hostility: "players", hostileTo: [] } };
    await startCombatForEncounterId(scene, "e1", { forces: table });
    const names = calls.map((c) => c[0] + ":" + (c[1] ?? ""));
    expect(calls.find((c) => c[1] === "forces")[2]).toEqual(table);
    expect(names.indexOf("setFlag:forces")).toBeLessThan(names.indexOf("rollInitiative:"));
  });
});

describe("Friend with a stale forceId (#1083 final review)", () => {
  const forces = { f1: { hostility: "players", hostileTo: [] } };
  it("is not the party's opponent and not an ally of the force's monsters", () => {
    const P = cb("P", "party", 1);
    const M = cb("M", "f1", -1);
    const F = cb("F", "f1", 1); // Friend: disposition 1 but carries the force flag
    const c = mk([P, M, F], forces);
    expect(ids(combatantOpponents(c, P))).toEqual(["M"]);
    expect(ids(combatantAllies(c, M))).toEqual([]);
    expect(ids(combatantOpponents(c, M))).toEqual(["P", "F"]);
  });
});

describe("retaliation recording only for proceeding attacks (#1083)", () => {
  it("rollAndApplyStrike with no usable strike does not record retaliation", async () => {
    const A = { ...cb("A", "f1", -1), actor: { type: "npc", system: { actions: [] } } };
    const V = cb("V", "f2", -1);
    const setFlag = vi.fn();
    const combat = {
      combatants: [A, V],
      scene: { grid: { size: 100, distance: 5 } },
      getFlag: (m, k) => (k === "forces" ? { f1: { hostility: "all", hostileTo: [] }, f2: { hostility: "players", hostileTo: [] } } : undefined),
      setFlag,
    };
    expect(await rollAndApplyStrike(combat, A, V)).toBeNull();
    expect(setFlag).not.toHaveBeenCalled();
  });
  it("handleAttackForRetaliation never throws", async () => {
    globalThis.game = { users: { activeGM: { isSelf: true } }, combats: { get contents() { throw new Error("boom"); } } };
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(
      handleAttackForRetaliation({
        flags: { pf2e: { context: { type: "attack-roll", target: { token: "Scene.s.Token.t" } } } },
        speaker: { scene: "s", token: "a" },
      }),
    ).resolves.toBeUndefined();
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});
