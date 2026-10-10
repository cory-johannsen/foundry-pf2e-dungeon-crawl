import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { archiveCombatAiLog, resolveSlotCombat } from "../scripts/dungeon-combat.mjs";
import { makeFakeJournalWorld } from "./helpers/fake-journal-world.mjs";

const MODULE_ID = "pf2e-dungeon-crawl";

function fakeSettingsRef(initial) {
  let value = initial;
  const set = vi.fn(async (_m, _k, v) => {
    value = v;
  });
  return { get: () => value, set };
}

const LOG = [
  { combatantId: "cb1", round: 1, turn: 0, index: 0, summary: "Claw vs Valeros", target: { id: "cb9", name: "Valeros" }, result: { text: "hit", tone: "success" }, rationale: "Weakest AC.", source: "model", visibility: "all", alternatives: [{ id: "x", summary: "Stride", chosen: false }], moreCount: 0, meta: { provider: "litellm" } },
  { combatantId: "cb2", round: 1, turn: 1, index: 0, summary: "Sneak", target: null, result: { text: "done", tone: "neutral" }, rationale: "Stay hidden.", source: "model", visibility: "gm" },
];

function makeCombat({ flags = {}, combatants = [], scene = { id: "scene1", name: "Dungeon Crawl" } } = {}) {
  return {
    id: "combat1",
    scene,
    combatants,
    getFlag: (_m, k) => flags[k],
  };
}

const goblin = { id: "cb1", name: "Goblin Warrior", token: { name: "Goblin Warrior", playersCanSeeName: true } };
const lurker = { id: "cb2", name: "Lurker", token: { name: "Lurker", playersCanSeeName: false } };

let world;
beforeEach(() => {
  world = makeFakeJournalWorld();
  let n = 0;
  globalThis.foundry = { utils: { randomID: () => `rid${++n}` } };
  globalThis.game = {
    pf2e: { settings: { tokens: { nameVisibility: true } } },
    i18n: { localize: (key) => ({ "PF2EDC.Dungeon.Kind.combat": "Combat" })[key] ?? key },
  };
});
afterEach(() => {
  delete globalThis.game;
  delete globalThis.foundry;
  vi.restoreAllMocks();
});

const runState = () => ({
  createdAt: new Date(2026, 9, 9, 14, 3).getTime(),
  rooms: { "room-entry": { kind: "safe_entry" }, r1: { kind: "combat" }, r2: { kind: "combat" } },
  history: [{ roomId: "room-entry" }, { roomId: "r1" }],
});

describe("archiveCombatAiLog (#953)", () => {
  it("creates nothing -- no settings write, folder, journal or page -- for an empty or malformed log", async () => {
    for (const agentLog of [undefined, [], "junk", [null]]) {
      const settingsRef = fakeSettingsRef({ scene1: runState() });
      const res = await archiveCombatAiLog(makeCombat({ flags: { agentLog, dungeonSlot: "r2" } }), { settingsRef, journalDeps: world.deps });
      expect(res).toBeNull();
      expect(settingsRef.set).not.toHaveBeenCalled();
    }
    expect(world.journals).toHaveLength(0);
    expect(world.folders).toHaveLength(0);
  });

  it("archives a dungeon combat into the run's journals, persisting the run's aiHistoryId first", async () => {
    const settingsRef = fakeSettingsRef({ scene1: runState() });
    const combat = makeCombat({ flags: { agentLog: LOG, dungeonSlot: "r2" }, combatants: [goblin, lurker] });
    const res = await archiveCombatAiLog(combat, { settingsRef, journalDeps: world.deps });
    expect(res).toEqual({ publicPage: true, gmPage: true });

    const historyId = settingsRef.get().scene1.aiHistoryId;
    expect(typeof historyId).toBe("string");
    expect(historyId.length).toBeGreaterThan(0);

    const pub = world.journals.find((j) => j.getFlag(MODULE_ID, "aiHistory").kind === "public");
    const gm = world.journals.find((j) => j.getFlag(MODULE_ID, "aiHistory").kind === "gm");
    expect(pub.getFlag(MODULE_ID, "aiHistory")).toEqual({ historyId, kind: "public", sceneId: "scene1" });
    expect(pub.name).toBe("AI Action History — Dungeon Crawl (2026-10-09 14:03)");
    expect(pub.ownership).toEqual({ default: 2 });
    expect(gm.ownership).toEqual({ default: 0 });

    const [pubPage] = pub.pages.contents;
    const [gmPage] = gm.pages.contents;
    expect(pubPage.name).toBe("Room 2 — Combat");
    expect(pubPage.getFlag(MODULE_ID, "aiHistory")).toEqual({ combatId: "combat1" });
    expect(pubPage.text.content).toContain("Goblin Warrior");
    expect(pubPage.text.content).toContain("Claw vs Valeros");
    for (const secret of ["Sneak", "Lurker", "Weakest AC.", "Stay hidden.", "Stride", "litellm"])
      expect(pubPage.text.content).not.toContain(secret);
    for (const s of ["Sneak", "Lurker", "Weakest AC.", "Stay hidden.", "Stride", "litellm"])
      expect(gmPage.text.content).toContain(s);
  });

  it("hides a name PF2e hides from players on the public page only", async () => {
    const settingsRef = fakeSettingsRef({ scene1: runState() });
    const shy = { id: "cb1", name: "Secret Lich", token: { name: "Secret Lich", playersCanSeeName: false } };
    await archiveCombatAiLog(makeCombat({ flags: { agentLog: [LOG[0]], dungeonSlot: "r2" }, combatants: [shy] }), { settingsRef, journalDeps: world.deps });
    const pub = world.journals.find((j) => j.getFlag(MODULE_ID, "aiHistory").kind === "public");
    const gm = world.journals.find((j) => j.getFlag(MODULE_ID, "aiHistory").kind === "gm");
    expect(pub.pages.contents[0].text.content).not.toContain("Secret Lich");
    expect(pub.pages.contents[0].text.content).toContain("Unknown creature");
    expect(gm.pages.contents[0].text.content).toContain("Secret Lich");
  });

  it("reuses the run's journals for a later combat and is idempotent for the same one", async () => {
    const settingsRef = fakeSettingsRef({ scene1: runState() });
    const combat = makeCombat({ flags: { agentLog: LOG, dungeonSlot: "r2" }, combatants: [goblin] });
    await archiveCombatAiLog(combat, { settingsRef, journalDeps: world.deps });
    expect(await archiveCombatAiLog(combat, { settingsRef, journalDeps: world.deps })).toEqual({ publicPage: false, gmPage: false });
    await archiveCombatAiLog({ ...combat, id: "combat2" }, { settingsRef, journalDeps: world.deps });
    expect(world.journals).toHaveLength(2);
    for (const j of world.journals) expect(j.pages.contents).toHaveLength(2);
    expect(settingsRef.set).toHaveBeenCalledTimes(1);
  });

  it("archives a standalone combat under a per-scene id, labelled by scene", async () => {
    const settingsRef = fakeSettingsRef({});
    const combat = makeCombat({ flags: { agentLog: LOG, encounterId: "enc1" }, scene: { id: "forest", name: "Forest Road" }, combatants: [goblin] });
    await archiveCombatAiLog(combat, { settingsRef, journalDeps: world.deps });
    expect(settingsRef.set).not.toHaveBeenCalled();
    const pub = world.journals.find((j) => j.getFlag(MODULE_ID, "aiHistory").kind === "public");
    expect(pub.getFlag(MODULE_ID, "aiHistory").historyId).toBe("standalone-forest");
    expect(pub.name).toBe("AI Action History — Forest Road");
    expect(pub.pages.contents[0].name).toBe("Encounter — Forest Road");
  });

  it("skips archiving (creating nothing) when the history id cannot be persisted", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const settingsRef = fakeSettingsRef({ scene1: runState() });
    settingsRef.set.mockRejectedValueOnce(new Error("not GM"));
    const res = await archiveCombatAiLog(makeCombat({ flags: { agentLog: LOG, dungeonSlot: "r2" } }), { settingsRef, journalDeps: world.deps });
    expect(res).toBeNull();
    expect(world.journals).toHaveLength(0);
    expect(err).toHaveBeenCalled();
  });

  it("never throws when a journal write fails", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    world.deps.JournalEntryCls.create.mockRejectedValue(new Error("boom"));
    const settingsRef = fakeSettingsRef({ scene1: runState() });
    await expect(
      archiveCombatAiLog(makeCombat({ flags: { agentLog: LOG, dungeonSlot: "r2" } }), { settingsRef, journalDeps: world.deps }),
    ).resolves.toBeNull();
    expect(err).toHaveBeenCalled();
  });
});

describe("resolveCombat archives before deleting the combat (#953)", () => {
  function installResolveGlobals(combat, { journalCreate } = {}) {
    let settingsValue = { scene1: runState() };
    globalThis.foundry = { utils: { randomID: () => "rid1" }, audio: { AudioHelper: { play: () => ({ catch: () => {} }) } } };
    globalThis.Actor = { deleteDocuments: async () => {}, createDocuments: async () => [] };
    globalThis.Folder = world.deps.FolderCls;
    globalThis.JournalEntry = { create: journalCreate ?? world.deps.JournalEntryCls.create };
    globalThis.game = {
      ...globalThis.game,
      user: { isGM: true },
      actors: { party: { members: [{ id: "pc" }] } },
      settings: { get: () => settingsValue, set: async (_m, _k, v) => { settingsValue = v; } },
      journal: world.deps.journals,
      folders: world.deps.folders,
      combats: { find: (fn) => [combat].find(fn), filter: (fn) => [combat].filter(fn), has: () => true, contents: [combat] },
    };
    return () => settingsValue;
  }

  function resolvableCombat(order) {
    const flags = { dungeonSlot: "r2", agentLog: LOG };
    return {
      id: "combat1",
      combatants: [],
      scene: { id: "scene1", name: "Dungeon Crawl", tokens: [], deleteEmbeddedDocuments: async () => {} },
      getFlag: (_m, k) => flags[k],
      delete: async () => {
        order.push(`delete (journals: ${world.journals.length})`);
      },
    };
  }

  it("writes the pages, then grants XP and deletes the combat", async () => {
    const order = [];
    const combat = resolvableCombat(order);
    const settings = installResolveGlobals(combat);
    const grants = [];
    await resolveSlotCombat(combat.scene, "r2", "victory", {
      partyLevel: async () => 1,
      grantPartyXp: async (xp) => grants.push(xp),
    });
    expect(order).toEqual(["delete (journals: 2)"]);
    expect(grants).toHaveLength(1);
    expect(settings().scene1.aiHistoryId).toBe("rid1");
    for (const j of world.journals) expect(j.pages.contents).toHaveLength(1);
  });

  it("still grants XP and deletes the combat when archiving fails", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const order = [];
    const combat = resolvableCombat(order);
    installResolveGlobals(combat, { journalCreate: vi.fn().mockRejectedValue(new Error("boom")) });
    const grants = [];
    await resolveSlotCombat(combat.scene, "r2", "victory", {
      partyLevel: async () => 1,
      grantPartyXp: async (xp) => grants.push(xp),
    });
    expect(grants).toHaveLength(1);
    expect(order).toEqual(["delete (journals: 0)"]);
    expect(err).toHaveBeenCalled();
  });
});
