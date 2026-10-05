import { describe, it, expect, vi } from "vitest";
import { revealSlotTokens, hideTokens } from "../scripts/dungeon-scene.mjs";

const MODULE_ID = "pf2e-dungeon-crawl";

function tok(id, flags, hidden = true) {
  return { id, hidden, getFlag: (m, k) => (m === MODULE_ID ? flags[k] : undefined) };
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
