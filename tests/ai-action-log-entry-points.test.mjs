// #950: entry points (scene tool, module API, chat-card link, macro) and the
// module.mjs live-update wiring for the AI Action Log window.
import { describe, it, expect, vi, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import { MACRO_DEFS } from "../scripts/world-macros.mjs";
import { renderAgentTurnCardHtml } from "../scripts/agent-action-display.mjs";

const priorFoundry = globalThis.foundry;
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

const { aiActionLogSceneTool, openAiActionLog, bindAiActionLogCardLink, AiActionLogApp } = await import(
  "../scripts/ui/ai-action-log-app.mjs"
);
const { findTokenControl } = await import("../scripts/ui/marching-order-app.mjs");

afterAll(() => {
  globalThis.foundry = priorFoundry;
});

const moduleSrc = readFileSync(new URL("../scripts/module.mjs", import.meta.url), "utf8");

describe("aiActionLogSceneTool (#950)", () => {
  it("is visible to every user, not just the GM", () => {
    const tool = aiActionLogSceneTool((k) => k);
    expect(tool).toMatchObject({
      name: "pf2edc-ai-action-log",
      title: "PF2EDC.SceneControl.AiActionLogLabel",
      icon: "fa-solid fa-scroll",
      visible: true,
      button: true,
    });
  });

  it("opens the window on v14 onChange and v13 onClick", () => {
    const open = vi.fn();
    const tool = aiActionLogSceneTool((k) => k, open);
    tool.onClick();
    tool.onChange();
    expect(open).toHaveBeenCalledTimes(2);
  });

  it("module.mjs registers it in the token controls next to the marching-order tool", () => {
    const hook = moduleSrc.slice(moduleSrc.indexOf('Hooks.on("getSceneControlButtons"'));
    const body = hook.slice(0, hook.indexOf("\n});"));
    expect(body).toContain("aiActionLogSceneTool(");
    expect(body).toMatch(/tools\.push\([^)]*aiActionLogButton/);
    expect(body).toContain("tokenControl.tools[aiActionLogButton.name] = aiActionLogButton");
    // the v14 shape the hook branches on (confirmed live: controls.tokens.tools is an object)
    const controls = { tokens: { tools: {} } };
    expect(findTokenControl(controls)).toBe(controls.tokens);
  });
});

describe("openAiActionLog (#950)", () => {
  function fakeApp() {
    return { setFilters: vi.fn(), render: vi.fn(), bringToFront: vi.fn() };
  }

  it("creates and renders a window when none is open", () => {
    const app = fakeApp();
    const create = vi.fn(() => app);
    openAiActionLog({ combatantId: "c1" }, { instances: new Map(), create });
    expect(create).toHaveBeenCalledTimes(1);
    expect(app.setFilters).toHaveBeenCalledWith({ combatantId: "c1", round: undefined });
    expect(app.render).toHaveBeenCalledWith({ force: true });
  });

  it("re-uses (re-filters, re-renders, raises) the open window instead of opening a second", () => {
    const app = fakeApp();
    const create = vi.fn(() => fakeApp());
    const instances = new Map([["pf2edc-ai-action-log-app", app]]);
    openAiActionLog({ round: 2 }, { instances, create });
    openAiActionLog({}, { instances, create });
    expect(create).not.toHaveBeenCalled();
    expect(app.setFilters).toHaveBeenNthCalledWith(1, { combatantId: undefined, round: 2 });
    expect(app.render).toHaveBeenCalledTimes(2);
    expect(app.bringToFront).toHaveBeenCalledTimes(2);
  });

  it("a real AiActionLogApp keeps its filters across a filter-less re-open", () => {
    const app = new AiActionLogApp();
    const instances = new Map([["pf2edc-ai-action-log-app", app]]);
    openAiActionLog({ combatantId: "c9", round: 4 }, { instances });
    openAiActionLog(undefined, { instances });
    expect(app.filters).toEqual({ combatantId: "c9", round: 4 });
  });

  it("module.mjs exposes it on the module API", () => {
    expect(moduleSrc).toMatch(/openAiActionLog:\s*\(filters\)\s*=>\s*openAiActionLog\(filters\)/);
  });
});

describe("chat-card link (#950)", () => {
  it("#925's AI turn card header carries the link with the combatant id", () => {
    const html = renderAgentTurnCardHtml({ round: 2, combatantId: "c1", records: [] });
    expect(html).toMatch(/<a [^>]*data-pf2edc-open-ai-log[^>]*data-combatant-id="c1"/);
  });

  it("escapes the combatant id, and omits the link without one", () => {
    expect(renderAgentTurnCardHtml({ round: 1, combatantId: '"><x', records: [] })).toContain('data-combatant-id="&quot;&gt;&lt;x"');
    expect(renderAgentTurnCardHtml({ round: 1, records: [] })).not.toContain("data-pf2edc-open-ai-log");
  });

  function fakeHtml(dataset = { combatantId: "c1" }) {
    const link = { dataset, addEventListener: vi.fn() };
    return { link, html: { querySelector: (sel) => (sel === "[data-pf2edc-open-ai-log]" ? link : null) } };
  }
  const cardMessage = { flags: { "pf2e-dungeon-crawl": { agentTurnCard: { combatantId: "c1", round: 2 } } } };

  it("binds a click that opens the window pre-filtered to the card's combatant, all rounds", () => {
    const { link, html } = fakeHtml();
    const open = vi.fn();
    expect(bindAiActionLogCardLink(cardMessage, html, open)).toBe(true);
    const [type, handler] = link.addEventListener.mock.calls[0];
    expect(type).toBe("click");
    handler({ preventDefault: vi.fn() });
    expect(open).toHaveBeenCalledWith({ combatantId: "c1", round: null });
  });

  it("ignores any other chat message, or a card without the link", () => {
    const { html } = fakeHtml();
    expect(bindAiActionLogCardLink({ flags: {} }, html, vi.fn())).toBe(false);
    expect(bindAiActionLogCardLink(cardMessage, { querySelector: () => null }, vi.fn())).toBe(false);
  });

  it("module.mjs binds it from renderChatMessageHTML", () => {
    expect(moduleSrc).toMatch(/Hooks\.on\("renderChatMessageHTML", \(message, html\) =>\s*bindAiActionLogCardLink\(message, html\)/);
  });
});

describe("macro (#950)", () => {
  it("MACRO_DEFS includes an AI Action Log macro calling the API", () => {
    const entry = MACRO_DEFS.find((d) => d.name === "AI Action Log");
    expect(entry?.command).toBe("game.modules.get('pf2e-dungeon-crawl').api.openAiActionLog();");
    expect(entry?.img).toBe("icons/sundries/scrolls/scroll-bound-black-tan.webp");
  });
});

describe("module.mjs live-update wiring (#950)", () => {
  it("an updateCombat refreshes only when shouldRefreshAiActionLog says so", () => {
    expect(moduleSrc).toMatch(
      /Hooks\.on\("updateCombat", \(combat, changes\) => \{\s*if \(shouldRefreshAiActionLog\(changes\)\) refreshAiActionLogWindow\(foundry\.applications\.instances\);/,
    );
  });
  it("createCombat, deleteCombat and canvasReady refresh an open window", () => {
    expect(moduleSrc).toContain('for (const hook of ["createCombat", "deleteCombat", "canvasReady"]) {\n  Hooks.on(hook, () => refreshAiActionLogWindow(foundry.applications.instances));');
  });
});

describe("locale (#950)", () => {
  it("has every key the window, template and scene tool use", () => {
    const lang = JSON.parse(readFileSync(new URL("../lang/en.json", import.meta.url), "utf8"));
    const template = readFileSync(new URL("../templates/ai-action-log.hbs", import.meta.url), "utf8");
    const keys = [
      "PF2EDC.SceneControl.AiActionLogLabel",
      "PF2EDC.AiActionLog.Title",
      ...[...template.matchAll(/localize "([^"]+)"/g)].map((m) => m[1]),
    ];
    for (const key of keys) expect(lang[key], key).toBeTruthy();
  });
});
