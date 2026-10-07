// #852: MarchingOrderApp -- standalone marching-order window.
import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import { readFileSync } from "node:fs";

const mocks = vi.hoisted(() => ({
  state: null,
  setMarchingOrder: vi.fn(),
  requestDungeonAction: vi.fn(),
}));

vi.mock("../scripts/dungeon-runner.mjs", () => ({
  getRunState: () => mocks.state,
  effectiveMarchingOrder: (run) => run.marchingOrder,
  setMarchingOrder: mocks.setMarchingOrder,
}));
vi.mock("../scripts/dungeon-remote.mjs", () => ({
  requestDungeonAction: mocks.requestDungeonAction,
}));

const priorFoundry = globalThis.foundry;
globalThis.foundry = {
  applications: {
    api: {
      ApplicationV2: class {
        render() {}
      },
      HandlebarsApplicationMixin: (Base) => Base,
    },
  },
};

const { MarchingOrderApp, reorderMarching, refreshMarchingOrderWindow } = await import(
  "../scripts/ui/marching-order-app.mjs"
);

afterAll(() => {
  globalThis.foundry = priorFoundry;
});

function setup({ user, state }) {
  globalThis.canvas = { scene: { id: "scene1" } };
  globalThis.game = { actors: { get: (id) => ({ name: `Actor-${id}` }) }, user };
  mocks.state = state;
  mocks.setMarchingOrder.mockClear();
  mocks.requestDungeonAction.mockClear();
}

const run = (over = {}) => ({ marchingOrder: ["a", "b", "c"], hostUserId: "host", ...over });
const GM = { id: "gm", isGM: true };
const HOST = { id: "host", isGM: false };
const PLAYER = { id: "pl", isGM: false };

describe("MarchingOrderApp._prepareContext", () => {
  beforeEach(() => setup({ user: GM, state: run() }));

  it("lists the effective order, named and flagged first/last", async () => {
    const ctx = await new MarchingOrderApp()._prepareContext();
    expect(ctx.hasRun).toBe(true);
    expect(ctx.marchingOrder).toEqual([
      { actorId: "a", name: "Actor-a", isFirst: true, isLast: false },
      { actorId: "b", name: "Actor-b", isFirst: false, isLast: false },
      { actorId: "c", name: "Actor-c", isFirst: false, isLast: true },
    ]);
  });

  it("renders an empty state when no run is active on the viewed scene", async () => {
    mocks.state = null;
    expect(await new MarchingOrderApp()._prepareContext()).toEqual({
      hasRun: false,
      canReorder: false,
      marchingOrder: [],
    });
  });

  it("renders an empty state when there is no viewed scene", async () => {
    globalThis.canvas = { scene: null };
    const ctx = await new MarchingOrderApp()._prepareContext();
    expect(ctx.hasRun).toBe(false);
  });

  it("GM and run host get controls; a non-host player gets a read-only view", async () => {
    for (const [user, expected] of [[GM, true], [HOST, true], [PLAYER, false]]) {
      globalThis.game.user = user;
      expect((await new MarchingOrderApp()._prepareContext()).canReorder).toBe(expected);
    }
  });
});

describe("reorderMarching", () => {
  it("swaps with the neighbour", () => {
    expect(reorderMarching(["a", "b", "c"], "b", -1)).toEqual(["b", "a", "c"]);
    expect(reorderMarching(["a", "b", "c"], "b", 1)).toEqual(["a", "c", "b"]);
  });
  it("is a no-op at the ends or for unknown actors", () => {
    expect(reorderMarching(["a", "b"], "a", -1)).toBeNull();
    expect(reorderMarching(["a", "b"], "b", 1)).toBeNull();
    expect(reorderMarching(["a", "b"], "z", 1)).toBeNull();
  });
});

describe("move actions", () => {
  const { moveUp, moveDown } = MarchingOrderApp.DEFAULT_OPTIONS.actions;
  const target = (actorId) => ({ dataset: { actorId } });
  const mkApp = () => ({ render: vi.fn() });

  it("GM writes directly via setMarchingOrder", async () => {
    setup({ user: GM, state: run() });
    const app = mkApp();
    await moveUp.call(app, {}, target("b"));
    expect(mocks.setMarchingOrder).toHaveBeenCalledWith("scene1", ["b", "a", "c"]);
    expect(mocks.requestDungeonAction).not.toHaveBeenCalled();
    expect(app.render).toHaveBeenCalled();
  });

  it("the run host (non-GM) relays setMarchingOrder", async () => {
    setup({ user: HOST, state: run() });
    const app = mkApp();
    await moveDown.call(app, {}, target("a"));
    expect(mocks.requestDungeonAction).toHaveBeenCalledWith("setMarchingOrder", {
      sceneId: "scene1",
      orderedActorIds: ["b", "a", "c"],
    });
    expect(mocks.setMarchingOrder).not.toHaveBeenCalled();
  });

  it("a non-host player sends nothing (the relay would refuse it)", async () => {
    setup({ user: PLAYER, state: run() });
    const app = mkApp();
    await moveUp.call(app, {}, target("b"));
    expect(mocks.requestDungeonAction).not.toHaveBeenCalled();
    expect(mocks.setMarchingOrder).not.toHaveBeenCalled();
  });

  it("does nothing at the ends, without a run, or without an actor id", async () => {
    setup({ user: GM, state: run() });
    await moveUp.call(mkApp(), {}, target("a"));
    await moveDown.call(mkApp(), {}, target("c"));
    await moveUp.call(mkApp(), {}, { dataset: {} });
    mocks.state = null;
    await moveUp.call(mkApp(), {}, target("b"));
    expect(mocks.setMarchingOrder).not.toHaveBeenCalled();
  });
});

describe("refreshMarchingOrderWindow", () => {
  it("re-renders the open window instance", () => {
    const win = { render: vi.fn() };
    const instances = new Map([["pf2edc-marching-order-app", win]]);
    refreshMarchingOrderWindow(instances);
    expect(win.render).toHaveBeenCalledTimes(1);
  });
  it("is a no-op when the window is closed", () => {
    expect(() => refreshMarchingOrderWindow(new Map())).not.toThrow();
    expect(() => refreshMarchingOrderWindow(undefined)).not.toThrow();
  });
});

describe("template", () => {
  const tpl = readFileSync(new URL("../templates/marching-order-app.hbs", import.meta.url), "utf8");
  it("shows controls only when canReorder, plus read-only and empty-state copy", () => {
    expect(tpl).toContain("{{#if ../canReorder}}");
    expect(tpl).toContain("PF2EDC.MarchingOrder.ReadOnly");
    expect(tpl).toContain("PF2EDC.MarchingOrder.NoActiveRun");
  });
});
