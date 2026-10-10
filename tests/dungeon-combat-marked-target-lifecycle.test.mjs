import { describe, it, expect, vi, beforeEach } from "vitest";
import { removeMarksTargeting, endMarksOnCombatantGone, cleanupAgentSelfEffects } from "../scripts/dungeon-combat.mjs";

// #946: agent-created marks end when the marked creature is defeated or
// leaves the combat, and at combat end whatever their duration.

const MODULE_ID = "pf2e-dungeon-crawl";
const mark = (id, tokenUuid, duration = { unit: "rounds", value: 1 }) => ({
  id, name: `Effect ${id}`, flags: { [MODULE_ID]: { agentSelfEffect: true, markTargetTokenUuid: tokenUuid } }, system: { duration },
});
const holder = (effects, name = "Champion") => ({
  name, actor: { name, itemTypes: { effect: effects }, deleteEmbeddedDocuments: vi.fn(async () => {}) },
});

beforeEach(() => {
  globalThis.foundry = { utils: {} };
  globalThis.ChatMessage = { create: vi.fn(async () => {}), getWhisperRecipients: () => [] };
  globalThis.game = { user: { isGM: true }, users: { activeGM: { isSelf: true } }, combats: { contents: [] } };
});

describe("removeMarksTargeting (#946)", () => {
  it("removes every tagged mark on that token, across combatants, and nothing else", async () => {
    const a = holder([mark("m1", "Scene.s.Token.gob"), mark("m2", "Scene.s.Token.orc")]);
    const untagged = { id: "u", flags: {}, system: {} };
    const plainBuff = { id: "b", flags: { [MODULE_ID]: { agentSelfEffect: true } }, system: {} };
    const b = holder([mark("m3", "Scene.s.Token.gob"), untagged, plainBuff], "Fighter");
    const c = holder([]);
    await removeMarksTargeting({ combatants: [a, b, c] }, "Scene.s.Token.gob");
    expect(a.actor.deleteEmbeddedDocuments).toHaveBeenCalledWith("Item", ["m1"]);
    expect(b.actor.deleteEmbeddedDocuments).toHaveBeenCalledWith("Item", ["m3"]);
    expect(c.actor.deleteEmbeddedDocuments).not.toHaveBeenCalled();
  });

  it("a failed removal is logged and whispered to the GM, never thrown, and doesn't stop the next combatant", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const a = holder([mark("m1", "Scene.s.Token.gob")]);
    a.actor.deleteEmbeddedDocuments.mockRejectedValueOnce(new Error("boom"));
    const b = holder([mark("m2", "Scene.s.Token.gob")], "Fighter");
    await expect(removeMarksTargeting({ combatants: [a, b] }, "Scene.s.Token.gob")).resolves.toBeUndefined();
    expect(b.actor.deleteEmbeddedDocuments).toHaveBeenCalledWith("Item", ["m2"]);
    expect(globalThis.ChatMessage.create).toHaveBeenCalled();
  });
});

describe("endMarksOnCombatantGone (#946)", () => {
  const moduleCombat = (combatants) => ({ combatants, getFlag: (_m, k) => (k === "dungeonSlot" ? "slot-1" : undefined) });

  it("ends the marks on a combatant newly marked defeated", async () => {
    const a = holder([mark("m1", "Scene.s.Token.gob")]);
    const combat = moduleCombat([a]);
    await endMarksOnCombatantGone({ parent: combat, token: { uuid: "Scene.s.Token.gob" } }, { defeated: true });
    expect(a.actor.deleteEmbeddedDocuments).toHaveBeenCalledWith("Item", ["m1"]);
  });

  it("ignores an update that isn't a defeat (or un-defeats)", async () => {
    const a = holder([mark("m1", "Scene.s.Token.gob")]);
    const combat = moduleCombat([a]);
    await endMarksOnCombatantGone({ parent: combat, token: { uuid: "Scene.s.Token.gob" } }, { initiative: 12 });
    await endMarksOnCombatantGone({ parent: combat, token: { uuid: "Scene.s.Token.gob" } }, { defeated: false });
    expect(a.actor.deleteEmbeddedDocuments).not.toHaveBeenCalled();
  });

  it("ends the marks on a combatant removed from the combat (fled)", async () => {
    const a = holder([mark("m1", "Scene.s.Token.gob")]);
    await endMarksOnCombatantGone({ parent: moduleCombat([a]), token: { uuid: "Scene.s.Token.gob" } });
    expect(a.actor.deleteEmbeddedDocuments).toHaveBeenCalledWith("Item", ["m1"]);
  });

  it("does nothing on a non-active-GM client or outside a module combat", async () => {
    const a = holder([mark("m1", "Scene.s.Token.gob")]);
    globalThis.game.users.activeGM.isSelf = false;
    await endMarksOnCombatantGone({ parent: moduleCombat([a]), token: { uuid: "Scene.s.Token.gob" } }, { defeated: true });
    globalThis.game.users.activeGM.isSelf = true;
    await endMarksOnCombatantGone({ parent: { combatants: [a], getFlag: () => undefined }, token: { uuid: "Scene.s.Token.gob" } }, { defeated: true });
    expect(a.actor.deleteEmbeddedDocuments).not.toHaveBeenCalled();
  });
});

describe("cleanupAgentSelfEffects: marks (#946)", () => {
  it("removes a tagged mark at combat end whatever its duration (Size Up's 1 day), leaving timed non-mark buffs alone", async () => {
    const timedBuff = { id: "b", flags: { [MODULE_ID]: { agentSelfEffect: true } }, system: { duration: { unit: "rounds", value: 1 } } };
    const a = holder([mark("m1", "Scene.s.Token.gob", { unit: "days", value: 1 }), timedBuff]);
    await cleanupAgentSelfEffects({ combatants: [a] });
    expect(a.actor.deleteEmbeddedDocuments).toHaveBeenCalledWith("Item", ["m1"]);
  });
});
