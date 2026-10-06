import { describe, it, expect, vi, beforeEach } from "vitest";
import { revealSlotTokens, hideTokens } from "../scripts/dungeon-scene.mjs";

const MODULE_ID = "pf2e-dungeon-crawl";

function tok(id, flags, hidden = true, actor = null) {
  return { id, hidden, actor, getFlag: (m, k) => (m === MODULE_ID ? flags[k] : undefined) };
}
function sceneOf(tokens) {
  const scene = { tokens, updateEmbeddedDocuments: vi.fn(async () => {}) };
  tokens.filter = Array.prototype.filter.bind(tokens);
  return scene;
}

describe("revealSlotTokens (#753)", () => {
  it("keeps trapHazard tokens hidden, reveals normal ones, returns only those", async () => {
    const scene = sceneOf([
      tok("trap", { dungeonSlot: 2, trapHazard: true }),
      tok("mon", { dungeonSlot: 2 }),
      tok("other", { dungeonSlot: 3 }),
    ]);
    const ids = await revealSlotTokens(scene, 2);
    expect(ids).toEqual(["mon"]);
    expect(scene.updateEmbeddedDocuments).toHaveBeenCalledWith("Token", [
      { _id: "mon", hidden: false },
    ]);
  });

  it("makes no update when only a trap is in the slot", async () => {
    const scene = sceneOf([tok("trap", { dungeonSlot: 2, trapHazard: true })]);
    expect(await revealSlotTokens(scene, 2)).toEqual([]);
    expect(scene.updateEmbeddedDocuments).not.toHaveBeenCalled();
  });

  it("hideTokens re-hides exactly the returned ids", async () => {
    const scene = sceneOf([]);
    await hideTokens(scene, ["mon"]);
    expect(scene.updateEmbeddedDocuments).toHaveBeenCalledWith("Token", [
      { _id: "mon", hidden: true },
    ]);
  });
});

describe("revealSlotTokens ally announcement (#810)", () => {
  beforeEach(() => {
    globalThis.game = { i18n: { format: (k, d) => `${k}|${JSON.stringify(d)}` } };
    globalThis.ChatMessage = { create: vi.fn(async () => {}) };
  });

  it("announces a Friend-type ally (party alliance, non-character actor) revealed with its room", async () => {
    const ally = { name: "Clockwork Spy", alliance: "party", type: "npc" };
    const scene = sceneOf([tok("friend", { dungeonSlot: 2 }, true, ally)]);
    await revealSlotTokens(scene, 2);
    expect(globalThis.ChatMessage.create).toHaveBeenCalledWith({
      content: 'PF2EDC.Encounter.FriendAnnounceChat|{"name":"Clockwork Spy"}',
    });
  });

  it("does not announce an ordinary hostile or party-character token", async () => {
    const foe = { name: "Skeleton", alliance: "opposition", type: "npc" };
    const partyMember = { name: "Valeros", alliance: "party", type: "character" };
    const scene = sceneOf([
      tok("foe", { dungeonSlot: 2 }, true, foe),
      tok("pc", { dungeonSlot: 2 }, true, partyMember),
    ]);
    await revealSlotTokens(scene, 2);
    expect(globalThis.ChatMessage.create).not.toHaveBeenCalled();
  });

  it("announces nothing extra when nothing in the slot is an ally", async () => {
    const scene = sceneOf([tok("mon", { dungeonSlot: 2 })]);
    await revealSlotTokens(scene, 2);
    expect(globalThis.ChatMessage.create).not.toHaveBeenCalled();
  });

  it("announces a Friend only once when its slot is revealed twice", async () => {
    const ally = { name: "Clockwork Spy", alliance: "party", type: "npc" };
    const tokens = [tok("friend", { dungeonSlot: 2 }, true, ally)];
    const scene = sceneOf(tokens);
    scene.updateEmbeddedDocuments = vi.fn(async (_t, updates) => {
      for (const u of updates) tokens.find((t) => t.id === u._id).hidden = u.hidden;
    });
    await revealSlotTokens(scene, 2);
    await revealSlotTokens(scene, 2);
    expect(globalThis.ChatMessage.create).toHaveBeenCalledTimes(1);
  });
});
