// #950: AiActionLogApp -- the AI Action Log window. Foundry stubs mirror
// tests/marching-order-app.test.mjs (ApplicationV2 stub, the mixin as
// identity, globalThis.foundry restored afterwards).
import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import { readFileSync } from "node:fs";

const priorFoundry = globalThis.foundry;
const priorGame = globalThis.game;
const priorCanvas = globalThis.canvas;
globalThis.foundry = {
  applications: {
    api: {
      ApplicationV2: class {
        render() {}
      },
      HandlebarsApplicationMixin: (Base) => Base,
    },
    instances: new Map(),
  },
};

const {
  AiActionLogApp,
  isScrolledToBottom,
  refreshAiActionLogWindow,
  shouldRefreshAiActionLog,
  aiLogCombat,
  panToLogToken,
} = await import("../scripts/ui/ai-action-log-app.mjs");
const { buildAiLogView } = await import("../scripts/ui/ai-action-log-view.mjs");

afterAll(() => {
  globalThis.foundry = priorFoundry;
  globalThis.game = priorGame;
  globalThis.canvas = priorCanvas;
});

const MODULE_ID = "pf2e-dungeon-crawl";

function record(over) {
  return {
    combatantId: "c1",
    tokenId: "t1",
    round: 1,
    turn: 0,
    index: 0,
    type: "strike",
    cost: 1,
    summary: "Jaws",
    target: { id: "c2", name: "Valeros" },
    result: { text: "hit", tone: "success" },
    gmNote: null,
    rationale: "Closest foe.",
    source: "model",
    visibility: "all",
    ...over,
  };
}

function makeCombat({ id = "combat1", agentLog, flags = { encounterId: "e1" }, combatants } = {}) {
  const all = { ...flags, agentLog };
  return {
    id,
    getFlag: (mod, key) => (mod === MODULE_ID ? all[key] : undefined),
    combatants: combatants ?? [
      { id: "c1", name: "Wolf", img: "wolf.webp", token: { name: "Wolf", playersCanSeeName: true } },
      { id: "c2", name: "Valeros", img: "valeros.webp", token: { name: "Valeros", playersCanSeeName: true } },
      { id: "c3", name: "Ghost", img: "ghost.webp", token: { name: "Ghost", playersCanSeeName: false } },
    ],
  };
}

function setup({ isGM = true, combat = makeCombat({ agentLog: [record()] }), hideNames = false } = {}) {
  globalThis.game = {
    user: { isGM },
    combat,
    pf2e: { settings: { tokens: { nameVisibility: hideNames } } },
  };
}

describe("isScrolledToBottom (#950)", () => {
  it("true when within tolerance of the bottom", () => {
    expect(isScrolledToBottom({ scrollTop: 395, scrollHeight: 500, clientHeight: 100 }, 10)).toBe(true);
  });
  it("false when the user scrolled well above the bottom", () => {
    expect(isScrolledToBottom({ scrollTop: 0, scrollHeight: 500, clientHeight: 100 }, 10)).toBe(false);
  });
  it("a list shorter than its box counts as at the bottom; no list at all too", () => {
    expect(isScrolledToBottom({ scrollTop: 0, scrollHeight: 80, clientHeight: 100 })).toBe(true);
    expect(isScrolledToBottom(null)).toBe(true);
  });
});

describe("AiActionLogApp._prepareContext (#950)", () => {
  beforeEach(() => setup());

  it("empty state with no viewed combat", async () => {
    globalThis.game.combat = null;
    const ctx = await new AiActionLogApp()._prepareContext();
    expect(ctx).toMatchObject({ hasCombat: false, rows: [] });
  });

  it("empty state for a combat this module doesn't manage", async () => {
    globalThis.game.combat = makeCombat({ agentLog: [record()], flags: {} });
    const ctx = await new AiActionLogApp()._prepareContext();
    expect(ctx.hasCombat).toBe(false);
  });

  it("a managed combat with no log renders no rows (template's empty state)", async () => {
    globalThis.game.combat = makeCombat({ agentLog: undefined, flags: { dungeonSlot: 2 } });
    const ctx = await new AiActionLogApp()._prepareContext();
    expect(ctx.hasCombat).toBe(true);
    expect(ctx.rows).toEqual([]);
  });

  it("builds rows from the viewed combat's log with combatant names and portraits", async () => {
    const ctx = await new AiActionLogApp()._prepareContext();
    expect(ctx.rows).toHaveLength(1);
    expect(ctx.rows[0]).toMatchObject({ combatantName: "Wolf", img: "wolf.webp", rationale: "Closest foe." });
  });

  it("a player gets no rationale and no GM-only row", async () => {
    setup({
      isGM: false,
      combat: makeCombat({ agentLog: [record(), record({ combatantId: "c3", tokenId: "t3", visibility: "gm" })] }),
    });
    const ctx = await new AiActionLogApp()._prepareContext();
    expect(ctx.isGM).toBe(false);
    expect(ctx.rows).toHaveLength(1);
    expect(ctx.rows[0].rationale).toBeNull();
    expect(ctx.combatants.map((c) => c.id)).toEqual(["c1"]);
  });

  it("respects PF2e's hidden token names for players only", async () => {
    const combat = makeCombat({ agentLog: [record({ combatantId: "c3" })] });
    setup({ isGM: false, combat, hideNames: true });
    expect((await new AiActionLogApp()._prepareContext()).rows[0].combatantName).toBe("Unknown creature");
    setup({ isGM: true, combat, hideNames: true });
    expect((await new AiActionLogApp()._prepareContext()).rows[0].combatantName).toBe("Ghost");
  });

  it("applies the instance's filters, and resets them when the viewed combat changes", async () => {
    const log = [record(), record({ combatantId: "c2", tokenId: "t2", round: 2 })];
    setup({ combat: makeCombat({ agentLog: log }) });
    const app = new AiActionLogApp();
    await app._prepareContext();
    app.setFilters({ combatantId: "c2" });
    let ctx = await app._prepareContext();
    expect(ctx.rows.map((r) => r.combatantId)).toEqual(["c2"]);
    app.setFilters({ round: "1", combatantId: "" });
    ctx = await app._prepareContext();
    expect(ctx.rows.map((r) => r.round)).toEqual([1]);
    globalThis.game.combat = makeCombat({ id: "combat2", agentLog: log });
    ctx = await app._prepareContext();
    expect(ctx.rows).toHaveLength(2);
    expect(app.filters).toEqual({ combatantId: null, round: null });
  });

  it("setFilters keeps a filter passed as undefined", () => {
    const app = new AiActionLogApp();
    app.setFilters({ combatantId: "c1", round: 3 });
    app.setFilters({});
    expect(app.filters).toEqual({ combatantId: "c1", round: 3 });
    app.setFilters({ round: null });
    expect(app.filters).toEqual({ combatantId: "c1", round: null });
  });
});

describe("auto-scroll across a re-render (#950)", () => {
  function fakeList(over) {
    return { scrollTop: 0, scrollHeight: 1000, clientHeight: 200, ...over };
  }
  function appWith(list) {
    const app = new AiActionLogApp();
    Object.defineProperty(app, "element", {
      value: { querySelector: (sel) => (sel === ".pf2edc-ai-action-log-rows" ? list : null) },
    });
    return app;
  }

  it("scrolls to the new bottom when the list was at the bottom", async () => {
    const list = fakeList({ scrollTop: 800 });
    const app = appWith(list);
    await app._preRender({}, {});
    list.scrollHeight = 1200; // a new row arrived
    await app._onRender({}, {});
    expect(list.scrollTop).toBe(1200);
  });

  it("leaves the scroll position alone when the user scrolled up", async () => {
    const list = fakeList({ scrollTop: 100 });
    const app = appWith(list);
    await app._preRender({}, {});
    list.scrollHeight = 1200;
    await app._onRender({}, {});
    expect(list.scrollTop).toBe(100);
  });
});

describe("filter selects (#950)", () => {
  it("a select change sets the filter and re-renders", async () => {
    const listeners = {};
    const select = (name) => ({
      addEventListener: (type, fn) => {
        listeners[name] = fn;
      },
    });
    const app = new AiActionLogApp();
    app.render = vi.fn();
    Object.defineProperty(app, "element", {
      value: {
        querySelector: (sel) =>
          sel.includes('"combatant"') ? select("combatant") : sel.includes('"round"') ? select("round") : null,
      },
    });
    await app._onRender({}, {});
    listeners.combatant({ currentTarget: { value: "c2" } });
    listeners.round({ currentTarget: { value: "3" } });
    expect(app.filters).toEqual({ combatantId: "c2", round: 3 });
    expect(app.render).toHaveBeenCalledTimes(2);
  });
});

describe("click-to-pan (#950)", () => {
  function fakeCanvas(token) {
    return { tokens: { get: (id) => (id === "t1" ? token : undefined) }, animatePan: vi.fn() };
  }

  it("selects and pans to a visible token", () => {
    const token = { visible: true, center: { x: 150, y: 250 }, control: vi.fn() };
    const cv = fakeCanvas(token);
    expect(panToLogToken("t1", cv)).toBe(true);
    expect(token.control).toHaveBeenCalledWith({ releaseOthers: true });
    expect(cv.animatePan).toHaveBeenCalledWith({ x: 150, y: 250 });
  });

  it("is a silent no-op for a token the user can't see", () => {
    const token = { visible: false, center: { x: 1, y: 1 }, control: vi.fn() };
    const cv = fakeCanvas(token);
    expect(panToLogToken("t1", cv)).toBe(false);
    expect(token.control).not.toHaveBeenCalled();
    expect(cv.animatePan).not.toHaveBeenCalled();
  });

  it("is a silent no-op for an off-scene/deleted token, a missing id, or no canvas", () => {
    const cv = fakeCanvas(null);
    expect(panToLogToken("t-other-scene", cv)).toBe(false);
    expect(panToLogToken("", cv)).toBe(false);
    expect(panToLogToken("t1", null)).toBe(false);
    expect(cv.animatePan).not.toHaveBeenCalled();
  });

  it("the selectRow action reads the row's data-token-id", () => {
    const token = { visible: true, center: { x: 5, y: 6 }, control: vi.fn() };
    globalThis.canvas = fakeCanvas(token);
    AiActionLogApp.DEFAULT_OPTIONS.actions.selectRow({}, { dataset: { tokenId: "t1" } });
    expect(globalThis.canvas.animatePan).toHaveBeenCalledWith({ x: 5, y: 6 });
  });
});

describe("refreshAiActionLogWindow (#950)", () => {
  it("re-renders only an open instance", () => {
    const render = vi.fn();
    refreshAiActionLogWindow({ get: (id) => (id === "pf2edc-ai-action-log-app" ? { render } : undefined) });
    expect(render).toHaveBeenCalledTimes(1);
  });
  it("does nothing when no instance is open, or no instances map", () => {
    expect(() => refreshAiActionLogWindow({ get: () => undefined })).not.toThrow();
    expect(() => refreshAiActionLogWindow(undefined)).not.toThrow();
  });
  it("a failing render is logged, never thrown into the combat pipeline", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const render = () => {
      throw new Error("boom");
    };
    expect(() => refreshAiActionLogWindow({ get: () => ({ render }) })).not.toThrow();
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});

describe("shouldRefreshAiActionLog (#950)", () => {
  it("true when the agentLog flag changed", () => {
    expect(shouldRefreshAiActionLog({ flags: { [MODULE_ID]: { agentLog: [] } } })).toBe(true);
  });
  it("true when the combat became (in)active or started", () => {
    expect(shouldRefreshAiActionLog({ active: true })).toBe(true);
    expect(shouldRefreshAiActionLog({ started: true })).toBe(true);
  });
  it("false for unrelated combat updates", () => {
    expect(shouldRefreshAiActionLog({ turn: 2 })).toBe(false);
    expect(shouldRefreshAiActionLog({ round: 3 })).toBe(false);
    expect(shouldRefreshAiActionLog({ flags: { [MODULE_ID]: { agentTurnCards: {} } } })).toBe(false);
    expect(shouldRefreshAiActionLog(null)).toBe(false);
  });
});

describe("aiLogCombat (#950)", () => {
  it("only a module-managed combat", () => {
    expect(aiLogCombat(makeCombat({ flags: { dungeonSlot: 0 } }))).not.toBeNull();
    expect(aiLogCombat(makeCombat({ flags: { encounterId: "e" } }))).not.toBeNull();
    expect(aiLogCombat(makeCombat({ flags: {} }))).toBeNull();
    expect(aiLogCombat(null)).toBeNull();
  });
});

describe("templates/ai-action-log.hbs (#950)", () => {
  const template = readFileSync(new URL("../templates/ai-action-log.hbs", import.meta.url), "utf8");

  it("reads only fields buildAiLogView's rows actually carry (no raw-record access)", () => {
    const view = buildAiLogView([record()], { c1: { name: "Wolf", img: "w" } }, { isGM: true });
    const rowKeys = new Set(Object.keys(view.rows[0]));
    const rowsBlock = template.slice(template.indexOf("{{#each rows}}"), template.indexOf("{{/each}}", template.indexOf("{{#each rows}}")));
    const used = [...rowsBlock.matchAll(/this\.(\w+)/g)].map((m) => m[1]);
    expect(used.length).toBeGreaterThan(0);
    for (const field of used) expect(rowKeys.has(field), field).toBe(true);
  });

  it("every GM-only part is conditional on a field buildAiLogView blanks for players", () => {
    for (const field of ["fallback", "gmNote", "rationale"]) {
      expect(template).toContain(`{{#if this.${field}}}`);
    }
  });

  it("rows carry the click-to-pan action and token id", () => {
    expect(template).toContain('data-action="selectRow"');
    expect(template).toContain('data-token-id="{{this.tokenId}}"');
  });
});
