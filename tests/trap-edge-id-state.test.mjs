import { describe, it, expect, vi, beforeEach } from "vitest";

// #779 R3: a corridor trap passes its EDGE id ("a->b") as populateSlotTrap's
// roomId, so the #136 customization flag and the #56 room-state mirror see an
// id with no state.rooms entry. Pin that every step of that path no-ops
// instead of throwing or writing garbage (#820 tracks real parity).
import { ensureTrapState, applyTrapRoomState, clearTrapState } from "../scripts/dungeon-runner.mjs";
import { applyTrapCustomization, getPendingTrapCustomization } from "../scripts/trap-combat.mjs";

const MODULE_ID = "pf2e-dungeon-crawl";
const EDGE = "room-a->room-b";

function install(runs) {
  const set = vi.fn();
  globalThis.game = {
    settings: { get: (m, k) => (k === "dungeonRuns" ? runs : undefined), set },
    actors: new Map(),
    scenes: new Map(),
  };
  return set;
}
const runs = () => ({ s1: { rooms: { "room-a": { id: "room-a" }, "room-b": { id: "room-b", trap: { name: "Real", description: "d" } } } } });

describe("#779 edge id as a trap roomId", () => {
  let set;
  beforeEach(() => { set = install(runs()); });

  it("ensureTrapState returns the state untouched and persists nothing", async () => {
    const state = await ensureTrapState("s1", EDGE, { name: "X", description: "Y" });
    expect(state.rooms[EDGE]).toBeUndefined();
    expect(Object.keys(state.rooms)).toEqual(["room-a", "room-b"]);
    expect(set).not.toHaveBeenCalled();
  });

  it("applyTrapRoomState and clearTrapState are no-ops for it", async () => {
    await applyTrapRoomState("s1", EDGE, { name: "X", description: "Y" });
    await clearTrapState("s1", EDGE);
    expect(set).not.toHaveBeenCalled();
  });

  it("ensureTrapState returns null (no throw) when the scene has no run state", async () => {
    install({});
    await expect(ensureTrapState("s1", EDGE, { name: "X" })).resolves.toBeNull();
  });

  it("applyTrapCustomization with an edge-id flag updates the actor, mirrors nothing, and marks it customized", async () => {
    const flags = { trapCustomization: { status: "pending", sceneId: "s1", roomId: EDGE, partyLevel: 3, locationTag: null } };
    const actor = {
      id: "a1", name: "Old",
      getFlag: (m, k) => flags[k],
      setFlag: vi.fn(async (m, k, v) => { flags[k] = v; }),
      update: vi.fn(async () => {}),
    };
    game.actors.set("a1", actor);
    await expect(applyTrapCustomization("a1", { name: "New", description: "Desc" })).resolves.toEqual({ actorId: "a1", name: "Old" });
    expect(actor.update).toHaveBeenCalledWith({ name: "New", "system.details.description": "Desc" });
    expect(set).not.toHaveBeenCalled();
    expect(flags.trapCustomization).toEqual({ status: "customized" });
  });

  it("getPendingTrapCustomization offers an edge-keyed pending trap without reading roomId", () => {
    const actor = {
      id: "a1", name: "Pit", system: { details: { description: "d", level: { value: 2 } } },
      getFlag: (m, k) => ({ status: "pending", sceneId: "s1", roomId: EDGE, partyLevel: 3, locationTag: null }),
    };
    game.scenes.set("s1", { id: "s1", tokens: [{ hidden: true, actor }] });
    game.scenes.get("s1").tokens.find = Array.prototype.find.bind(game.scenes.get("s1").tokens);
    expect(getPendingTrapCustomization("s1")).toMatchObject({ actorId: "a1", partyLevel: 3, trapLevel: 2 });
  });
});
