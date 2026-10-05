import { describe, it, expect, vi, afterEach } from "vitest";
import {
  healAndClearPartyConditions,
  teardownDungeonRun,
  sweepCompletedDungeonScene,
} from "../scripts/dungeon-scene.mjs";

function installGame(partyMembers) {
  globalThis.game = {
    actors: { party: { members: partyMembers } },
    scenes: { get: () => null, find: () => null },
    i18n: { format: (k, d) => `${k}|${JSON.stringify(d)}`, localize: (k) => k },
  };
  globalThis.ui = { notifications: { error: vi.fn() } };
}

afterEach(() => {
  delete globalThis.game;
  delete globalThis.ui;
  delete globalThis.Actor;
  vi.restoreAllMocks();
});

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
  it("calls the injected healAndClearParty (empty scene)", async () => {
    installGame([]);
    const scene = makeFakeScene();
    const healAndClearParty = vi.fn();

    await sweepCompletedDungeonScene(scene, { healAndClearParty });

    expect(healAndClearParty).toHaveBeenCalledTimes(1);
  });
});

describe("teardownDungeonRun calls the party heal/clear (#617)", () => {
  it("calls the injected healAndClearParty and still deletes the scene", async () => {
    installGame([]); // empty party -- skips the scene-placement branch entirely
    const scene = makeFakeScene();
    const healAndClearParty = vi.fn();

    const result = await teardownDungeonRun(scene, { healAndClearParty });

    expect(healAndClearParty).toHaveBeenCalledTimes(1);
    expect(scene.delete).toHaveBeenCalledTimes(1);
    expect(result.deletedNpcActorCount).toBe(0);
  });
});

describe("party-heal failures never block run cleanup (#617 fix round 1)", () => {
  it("healAndClearPartyConditions isolates a failing member and heals the rest", async () => {
    installGame([{ id: "a", name: "A" }, { id: "b", name: "Bee" }, { id: "c", name: "C" }]);
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const healAndClearConditions = vi.fn(async (id) => {
      if (id === "b") throw new Error("boom");
    });

    await expect(healAndClearPartyConditions({ healAndClearConditions })).resolves.toBeUndefined();

    expect(healAndClearConditions).toHaveBeenCalledWith("a");
    expect(healAndClearConditions).toHaveBeenCalledWith("c");
    expect(ui.notifications.error).toHaveBeenCalledTimes(1);
    expect(ui.notifications.error).toHaveBeenCalledWith(
      'PF2EDC.Dungeon.PartyHealFailedError|{"name":"Bee"}',
    );
    expect(errSpy).toHaveBeenCalled();
  });

  it("teardownDungeonRun still sweeps and deletes the scene when the heal rejects, and heals first", async () => {
    installGame([]);
    vi.spyOn(console, "error").mockImplementation(() => {});
    const order = [];
    const scene = makeFakeScene();
    scene.delete = vi.fn(async () => { order.push("delete"); });
    const healAndClearParty = vi.fn(async () => { order.push("heal"); throw new Error("boom"); });

    const result = await teardownDungeonRun(scene, { healAndClearParty });

    expect(scene.delete).toHaveBeenCalledTimes(1);
    expect(result.deletedNpcActorCount).toBe(0);
    expect(ui.notifications.error).toHaveBeenCalledTimes(1);
    expect(order).toEqual(["heal", "delete"]);
  });

  it("sweepCompletedDungeonScene still runs the real NPC sweep when the heal rejects, and heals first", async () => {
    installGame([{ id: "pc1" }]);
    vi.spyOn(console, "error").mockImplementation(() => {});
    const order = [];
    globalThis.Actor = { deleteDocuments: vi.fn(async () => { order.push("sweep"); }) };
    const scene = makeFakeScene();
    scene.tokens = [
      { id: "t-pc", actor: { id: "pc1" } },
      { id: "t-npc", actor: { id: "npc1" } },
    ];
    const healAndClearParty = vi.fn(async () => { order.push("heal"); throw new Error("boom"); });

    const count = await sweepCompletedDungeonScene(scene, { healAndClearParty });

    expect(count).toBe(1);
    expect(scene.deleteEmbeddedDocuments).toHaveBeenCalledWith("Token", ["t-npc"]);
    expect(Actor.deleteDocuments).toHaveBeenCalledWith(["npc1"]);
    expect(ui.notifications.error).toHaveBeenCalledTimes(1);
    expect(order).toEqual(["heal", "sweep"]);
  });
});
