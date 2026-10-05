import { describe, it, expect, vi } from "vitest";
import {
  healAndClearPartyConditions,
  teardownDungeonRun,
  sweepCompletedDungeonScene,
} from "../scripts/dungeon-scene.mjs";

function installGame(partyMembers) {
  globalThis.game = {
    actors: { party: { members: partyMembers } },
    scenes: { get: () => null, find: () => null },
  };
}

function makeFakeScene() {
  return {
    tokens: [],
    deleteEmbeddedDocuments: vi.fn(async () => {}),
    delete: vi.fn(async () => {}),
  };
}

describe("healAndClearPartyConditions (#617)", () => {
  it("calls healAndClearConditions for every current party member", async () => {
    installGame([{ id: "pc1" }, { id: "pc2" }]);
    const healAndClearConditions = vi.fn();

    await healAndClearPartyConditions({ healAndClearConditions });

    expect(healAndClearConditions).toHaveBeenCalledTimes(2);
    expect(healAndClearConditions).toHaveBeenCalledWith("pc1");
    expect(healAndClearConditions).toHaveBeenCalledWith("pc2");
  });

  it("is a no-op, not a throw, with no current party members", async () => {
    installGame([]);
    const healAndClearConditions = vi.fn();

    await expect(healAndClearPartyConditions({ healAndClearConditions })).resolves.toBeUndefined();
    expect(healAndClearConditions).not.toHaveBeenCalled();
  });
});

describe("sweepCompletedDungeonScene calls the party heal/clear (#617)", () => {
  it("calls the injected healAndClearParty alongside the existing NPC sweep", async () => {
    installGame([]);
    const scene = makeFakeScene();
    const healAndClearParty = vi.fn();

    await sweepCompletedDungeonScene(scene, { healAndClearParty });

    expect(healAndClearParty).toHaveBeenCalledTimes(1);
  });
});

describe("teardownDungeonRun calls the party heal/clear (#617)", () => {
  it("calls the injected healAndClearParty alongside the existing teardown", async () => {
    installGame([]); // empty party -- skips the scene-placement branch entirely
    const scene = makeFakeScene();
    const healAndClearParty = vi.fn();

    const result = await teardownDungeonRun(scene, { healAndClearParty });

    expect(healAndClearParty).toHaveBeenCalledTimes(1);
    expect(scene.delete).toHaveBeenCalledTimes(1);
    expect(result.deletedNpcActorCount).toBe(0);
  });
});
