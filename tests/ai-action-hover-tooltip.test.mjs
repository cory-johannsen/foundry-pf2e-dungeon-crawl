// @vitest-environment jsdom
// #951: the hover tooltip over an AI token, and its hook wiring.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  renderHoverOverlay,
  hideHoverOverlay,
  canvasPointToClient,
  registerAiActionDetail,
} from "../scripts/ui/ai-action-detail.mjs";

function rec(over) {
  return {
    combatantId: "c1",
    tokenId: "t1",
    round: 1,
    turn: 0,
    index: 0,
    type: "strike",
    cost: 1,
    summary: "Strikes",
    target: { id: "p1", name: "Fighter" },
    result: { text: "hit", tone: "success" },
    gmNote: "DC 18",
    rationale: "Closest target.",
    source: "model",
    visibility: "all",
    ...over,
  };
}

function combatWith(log, round = 1) {
  return { id: "combat1", round, getFlag: (mod, key) => (mod === "pf2e-dungeon-crawl" && key === "agentLog" ? log : undefined) };
}

/** Canvas stub: v14's clientCoordinatesFromCanvas (stage worldTransform)
 * as a 2x zoom panned by (-100, -50); the board canvas sits at (10, 20). */
function fakeCanvas() {
  return {
    clientCoordinatesFromCanvas: ({ x, y }) => ({ x: x * 2 - 100, y: y * 2 - 50 }),
    app: { view: { getBoundingClientRect: () => ({ left: 10, top: 20 }) } },
  };
}

function makeToken(over = {}) {
  const combat = over.combat ?? combatWith([rec()]);
  const combatant = {
    id: "c1",
    name: "Goblin Warrior",
    hidden: false,
    parent: combat,
    token: { name: "Goblin", playersCanSeeName: true },
    ...over.combatant,
  };
  return {
    id: "t1",
    visible: true,
    bounds: { x: 100, y: 100, width: 100, height: 100 },
    center: { x: 150, y: 150 },
    combatant: over.noCombatant ? null : combatant,
    document: { id: "t1" },
    ...over.token,
  };
}

const overlay = () => document.getElementById("pf2edc-ai-hover");
const shown = () => overlay()?.style.display === "block";

describe("renderHoverOverlay (#951)", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("shows the name, latest action and result next to the token's top-right corner", () => {
    expect(renderHoverOverlay(makeToken(), null, false, { cv: fakeCanvas() })).toBe(true);
    const el = overlay();
    expect(shown()).toBe(true);
    expect(el.textContent).toContain("Goblin");
    expect(el.textContent).toContain("Strikes → Fighter");
    expect(el.querySelector(".pf2edc-ai-result.pf2edc-tone-success").textContent).toBe("hit");
    // corner (200, 100) -> (300, 150) on the board -> +(10, 20) page offset, +8 gap.
    expect(el.style.left).toBe("318px");
    expect(el.style.top).toBe("170px");
    expect(el.style.pointerEvents).toBe("none");
    expect(el.style.position).toBe("fixed");
  });

  it("shows the rationale to the GM only", () => {
    renderHoverOverlay(makeToken(), null, true, { cv: fakeCanvas() });
    expect(overlay().querySelector(".pf2edc-ai-rationale").textContent).toBe("Closest target.");
    renderHoverOverlay(makeToken(), null, false, { cv: fakeCanvas() });
    expect(overlay().querySelector(".pf2edc-ai-rationale")).toBeNull();
    expect(overlay().textContent).not.toContain("Closest target.");
    expect(overlay().textContent).not.toContain("DC 18");
  });

  it("labels a combatant that hasn't acted this round '(last round)'", () => {
    renderHoverOverlay(makeToken({ combat: combatWith([rec()], 3) }), null, false, { cv: fakeCanvas() });
    expect(overlay().textContent).toContain("(last round)");
  });

  it("uses an explicit combat over the combatant's own", () => {
    renderHoverOverlay(makeToken(), combatWith([rec({ summary: "Bites" })]), false, { cv: fakeCanvas() });
    expect(overlay().textContent).toContain("Bites");
  });

  it("respects PF2e's hidden token names for players", () => {
    const token = makeToken({ combatant: { token: { name: "Goblin", playersCanSeeName: false } } });
    renderHoverOverlay(token, null, false, { cv: fakeCanvas(), hideNames: true });
    expect(overlay().textContent).toContain("Unknown creature");
    expect(overlay().textContent).not.toContain("Goblin");
    renderHoverOverlay(token, null, true, { cv: fakeCanvas(), hideNames: true });
    expect(overlay().textContent).toContain("Goblin");
  });

  it("shows nothing for a token the user cannot see, even with visible records", () => {
    expect(renderHoverOverlay(makeToken({ token: { visible: false } }), null, true, { cv: fakeCanvas() })).toBe(false);
    expect(shown()).toBe(false);
  });

  it("shows nothing to a player for a combatant hidden in the tracker, or a hidden-token actor's records", () => {
    renderHoverOverlay(makeToken({ combatant: { hidden: true } }), null, false, { cv: fakeCanvas() });
    expect(shown()).toBe(false);
    renderHoverOverlay(makeToken({ combat: combatWith([rec({ visibility: "gm" })]) }), null, false, { cv: fakeCanvas() });
    expect(shown()).toBe(false);
    // The GM still sees both.
    expect(renderHoverOverlay(makeToken({ combatant: { hidden: true } }), null, true, { cv: fakeCanvas() })).toBe(true);
  });

  it("shows nothing for a token with no combatant, or a combatant with no records (human-controlled)", () => {
    renderHoverOverlay(makeToken({ noCombatant: true }), null, true, { cv: fakeCanvas() });
    expect(shown()).toBe(false);
    renderHoverOverlay(makeToken({ combat: combatWith([rec({ combatantId: "other" })]) }), null, true, { cv: fakeCanvas() });
    expect(shown()).toBe(false);
    renderHoverOverlay(makeToken({ combat: combatWith("junk") }), null, true, { cv: fakeCanvas() });
    expect(shown()).toBe(false);
  });

  it("hides on hideHoverOverlay and reuses one element", () => {
    renderHoverOverlay(makeToken(), null, true, { cv: fakeCanvas() });
    hideHoverOverlay();
    expect(overlay().style.display).toBe("none");
    renderHoverOverlay(makeToken(), null, true, { cv: fakeCanvas() });
    expect(document.querySelectorAll("#pf2edc-ai-hover")).toHaveLength(1);
  });

  it("shows nothing when the coordinate conversion throws or returns garbage", () => {
    renderHoverOverlay(makeToken(), null, true, { cv: fakeCanvas() });
    const throwing = { clientCoordinatesFromCanvas: () => { throw new Error("no view"); } };
    expect(renderHoverOverlay(makeToken(), null, true, { cv: throwing })).toBe(false);
    expect(shown()).toBe(false);
    const nan = { clientCoordinatesFromCanvas: () => ({ x: NaN, y: 0 }) };
    expect(renderHoverOverlay(makeToken(), null, true, { cv: nan })).toBe(false);
    expect(renderHoverOverlay(makeToken(), null, true, { cv: null })).toBe(false);
  });

  it("escapes record text and names", () => {
    const token = makeToken({
      combat: combatWith([rec({ summary: "<img src=x onerror=alert(1)>", rationale: "<script>x</script>" })]),
      combatant: { token: { name: "<b>Gob</b>", playersCanSeeName: true } },
    });
    renderHoverOverlay(token, null, true, { cv: fakeCanvas() });
    expect(overlay().querySelector("img, b, script")).toBeNull();
    expect(overlay().textContent).toContain("<img src=x");
  });
});

describe("canvasPointToClient (#951)", () => {
  it("falls back to the stage worldTransform when clientCoordinatesFromCanvas is absent", () => {
    const cv = { stage: { worldTransform: { apply: ({ x, y }) => ({ x: x + 1, y: y + 2 }) } }, app: { view: { getBoundingClientRect: () => ({ left: 0, top: 0 }) } } };
    expect(canvasPointToClient({ x: 5, y: 5 }, cv)).toEqual({ x: 6, y: 7 });
    expect(canvasPointToClient(null, cv)).toBeNull();
  });
});

describe("registerAiActionDetail: hover wiring (#951)", () => {
  function fakeHooks() {
    const handlers = {};
    return {
      on: (name, fn) => (handlers[name] ??= []).push(fn),
      call: (name, ...args) => (handlers[name] ?? []).forEach((fn) => fn(...args)),
    };
  }

  let hooks;
  let cv;
  beforeEach(() => {
    document.body.innerHTML = "";
    hooks = fakeHooks();
    cv = fakeCanvas();
    registerAiActionDetail({ hooks, getUser: () => ({ isGM: false }), getHideNames: () => false, doc: document, getCanvas: () => cv });
  });

  it("shows on hover and hides on unhover", () => {
    const token = makeToken();
    hooks.call("hoverToken", token, true);
    expect(shown()).toBe(true);
    hooks.call("hoverToken", token, false);
    expect(shown()).toBe(false);
  });

  it("an unhover of a different token doesn't hide the current one", () => {
    const token = makeToken();
    hooks.call("hoverToken", token, true);
    hooks.call("hoverToken", makeToken({ token: { id: "t2" } }), false);
    expect(shown()).toBe(true);
  });

  it("repositions on canvas pan and on the hovered token's refresh", () => {
    const token = makeToken();
    hooks.call("hoverToken", token, true);
    cv.clientCoordinatesFromCanvas = ({ x, y }) => ({ x, y });
    hooks.call("canvasPan", {}, {});
    expect(overlay().style.left).toBe(`${10 + 200 + 8}px`);
    token.bounds = { x: 300, y: 100, width: 100, height: 100 };
    hooks.call("refreshToken", makeToken({ token: { id: "other" } }), {});
    expect(overlay().style.left).toBe(`${10 + 200 + 8}px`);
    hooks.call("refreshToken", token, {});
    expect(overlay().style.left).toBe(`${10 + 400 + 8}px`);
  });

  it("hides when the hovered token is deleted, the combat ends, or the canvas tears down", () => {
    for (const [hook, arg] of [["deleteToken", { id: "t1" }], ["deleteCombat", { id: "combat1" }], ["canvasTearDown", {}]]) {
      hooks.call("hoverToken", makeToken(), true);
      expect(shown()).toBe(true);
      hooks.call(hook, arg);
      expect(shown()).toBe(false);
    }
  });

  it("deleting some other token leaves the tooltip up", () => {
    hooks.call("hoverToken", makeToken(), true);
    hooks.call("deleteToken", { id: "t9" });
    expect(shown()).toBe(true);
  });

  it("refreshes the text when the agentLog changes while hovering", () => {
    const log = [rec()];
    const combat = combatWith(log);
    const token = makeToken({ combat });
    hooks.call("hoverToken", token, true);
    log.push(rec({ index: 1, summary: "Trips", result: { text: "success", tone: "success" } }));
    hooks.call("updateCombat", combat, { flags: { "pf2e-dungeon-crawl": { agentLog: log } } });
    expect(overlay().textContent).toContain("Trips");
  });

  it("hovering a token a player can't see shows nothing", () => {
    hooks.call("hoverToken", makeToken({ token: { visible: false } }), true);
    expect(shown()).toBe(false);
  });
});

// (jsdom replaces import.meta.url with a non-file URL; vitest runs from the repo root.)
describe("#951 wiring", () => {
  it("module.mjs registers the tracker/hover detail and module.json loads its stylesheet", () => {
    const moduleSrc = readFileSync(join(process.cwd(), "scripts/module.mjs"), "utf8");
    expect(moduleSrc).toMatch(/import \{ registerAiActionDetail \} from "\.\/ui\/ai-action-detail\.mjs";/);
    expect(moduleSrc).toMatch(/^registerAiActionDetail\(\);$/m);
    const manifest = JSON.parse(readFileSync(join(process.cwd(), "module.json"), "utf8"));
    expect(manifest.styles).toContain("styles/ai-action-detail.css");
  });
});
