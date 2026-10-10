// @vitest-environment jsdom
// #951: the AI-action summary line under a Combat Tracker row. The fixture
// markup is Foundry v14's own templates/sidebar/tabs/combat/tracker.hbs
// output (rendered in the live world, 14.368 / pf2e 8.5.0), trimmed.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderTrackerDigestInto, registerAiActionDetail } from "../scripts/ui/ai-action-detail.mjs";

function trackerRow(id) {
  return `<li class="combatant" data-combatant-id="${id}" data-action="activateCombatant">
    <img class="token-image" src="x.png" alt="${id}">
    <div class="token-name">
      <strong class="name">${id}</strong>
      <div class="combatant-controls"><button type="button" data-action="toggleHidden"></button></div>
    </div>
    <div class="token-initiative"><input type="text" class="initiative-input" value="12"></div>
  </li>`;
}

function makeTracker(ids) {
  document.body.innerHTML = `<section id="combat"><ol class="combat-tracker plain">${ids.map(trackerRow).join("")}</ol></section>`;
  return document.getElementById("combat");
}

function rec(over) {
  return {
    combatantId: "c1",
    tokenId: "t1",
    round: 2,
    turn: 0,
    index: 0,
    type: "strike",
    cost: 1,
    summary: "Dagger",
    target: { id: "p1", name: "Fighter" },
    result: { text: "hit", tone: "success" },
    gmNote: null,
    rationale: "Closest target.",
    source: "model",
    visibility: "all",
    ...over,
  };
}

function combatWith(log, round = 2, id = "combat1") {
  return { id, round, getFlag: (mod, key) => (mod === "pf2e-dungeon-crawl" && key === "agentLog" ? log : undefined) };
}

const line = (root, id) => root.querySelector(`li[data-combatant-id="${id}"] .pf2edc-ai-last`);

describe("renderTrackerDigestInto (#951)", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("inserts a summary line under the name block only for a combatant with records", () => {
    const root = makeTracker(["c1", "p1"]);
    renderTrackerDigestInto(root, combatWith([rec()]), true, new Set());
    const l = line(root, "c1");
    expect(l).toBeTruthy();
    expect(l.parentElement.classList.contains("token-name")).toBe(true);
    expect(l.textContent).toContain("last: Dagger → Fighter (hit)");
    expect(l.querySelector(".pf2edc-tone-success")).toBeTruthy();
    expect(line(root, "p1")).toBeNull();
  });

  it("is idempotent -- repeated renders never duplicate the line", () => {
    const root = makeTracker(["c1"]);
    const combat = combatWith([rec()]);
    renderTrackerDigestInto(root, combat, true, new Set());
    renderTrackerDigestInto(root, combat, true, new Set());
    renderTrackerDigestInto(root, combat, true, new Set(["c1"]));
    expect(root.querySelectorAll(".pf2edc-ai-last")).toHaveLength(1);
  });

  it("shows #952's Details disclosure in a GM's expanded rows, opening it without collapsing the row; none for a player", () => {
    const detailed = rec({
      alternatives: [{ id: "x", summary: "Dagger vs Fighter", chosen: true }, { id: "y", summary: "Hide", chosen: false }],
      moreCount: 1,
      meta: { provider: "litellm", model: "fast", clientMs: 1000 },
    });
    const root = makeTracker(["c1"]);
    const expandedIds = new Set(["c1"]);
    renderTrackerDigestInto(root, combatWith([detailed]), true, expandedIds);
    const details = line(root, "c1").querySelector(".pf2edc-ai-expanded details.pf2edc-ai-details");
    expect(details).toBeTruthy();
    expect(details.open).toBe(false);
    expect(details.textContent).toContain("+1 more");
    expect(details.textContent).toContain("Provider: litellm · Model: fast");
    const rowClick = vi.fn();
    root.addEventListener("click", rowClick);
    details.querySelector("summary").click();
    expect(expandedIds.has("c1")).toBe(true);
    expect(rowClick).not.toHaveBeenCalled();
    expect(line(root, "c1").querySelector(".pf2edc-ai-expanded")).toBeTruthy();

    const playerRoot = makeTracker(["c1"]);
    renderTrackerDigestInto(playerRoot, combatWith([detailed]), false, new Set(["c1"]));
    expect(playerRoot.querySelector("details")).toBeNull();
    expect(playerRoot.innerHTML).not.toMatch(/Hide|litellm|Details/);
  });

  it("removes a row's line once it has nothing to show", () => {
    const root = makeTracker(["c1"]);
    renderTrackerDigestInto(root, combatWith([rec()]), true, new Set());
    renderTrackerDigestInto(root, combatWith([]), true, new Set());
    expect(line(root, "c1")).toBeNull();
  });

  it("collapsed by default; an id in expandedIds shows the current and previous rounds", () => {
    const log = [rec({ round: 1, summary: "Bite" }), rec({ summary: "Claw" }), rec({ index: 1, summary: "Tail" })];
    const root = makeTracker(["c1"]);
    renderTrackerDigestInto(root, combatWith(log), true, new Set());
    expect(root.querySelector(".pf2edc-ai-expanded")).toBeNull();
    renderTrackerDigestInto(root, combatWith(log), true, new Set(["c1"]));
    const expanded = root.querySelector(".pf2edc-ai-expanded");
    const lists = expanded.querySelectorAll("ul.pf2edc-ai-rows");
    expect(lists).toHaveLength(2);
    expect([...lists[0].querySelectorAll("li")].map((li) => li.querySelector("strong").textContent)).toEqual(["Claw", "Tail"]);
    expect(expanded.querySelector(".pf2edc-ai-previous-round-label").textContent).toBe("Last round");
    expect(lists[1].textContent).toContain("Bite");
  });

  it("labels a combatant that hasn't acted this round '(last round)'", () => {
    const root = makeTracker(["c1"]);
    renderTrackerDigestInto(root, combatWith([rec({ round: 1 })], 3), true, new Set(["c1"]));
    expect(line(root, "c1").textContent).toContain("(last round) last: Dagger");
    // The current round is empty, so only the "Last round" list shows.
    expect(root.querySelectorAll(".pf2edc-ai-expanded ul")).toHaveLength(1);
  });

  it("clicking toggles expansion, keeps the state in expandedIds, and never reaches the row's own actions", () => {
    const root = makeTracker(["c1"]);
    const rowClick = vi.fn();
    const rowDblClick = vi.fn();
    root.addEventListener("click", rowClick);
    root.addEventListener("dblclick", rowDblClick);
    const expandedIds = new Set();
    const combat = combatWith([rec()]);
    renderTrackerDigestInto(root, combat, true, expandedIds);
    line(root, "c1").querySelector(".pf2edc-ai-last-summary").click();
    expect(expandedIds.has("c1")).toBe(true);
    expect(root.querySelector(".pf2edc-ai-expanded")).toBeTruthy();
    expect(rowClick).not.toHaveBeenCalled();
    line(root, "c1").dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    expect(rowDblClick).not.toHaveBeenCalled();
    // A tracker re-render (fresh DOM) keeps it expanded.
    const fresh = makeTracker(["c1"]);
    renderTrackerDigestInto(fresh, combat, true, expandedIds);
    expect(fresh.querySelector(".pf2edc-ai-expanded")).toBeTruthy();
    line(fresh, "c1").click();
    expect(expandedIds.has("c1")).toBe(false);
    expect(fresh.querySelector(".pf2edc-ai-expanded")).toBeNull();
  });

  it("shows the GM rationale, GM note and fallback tag; a player sees none of them", () => {
    const log = [rec({ gmNote: "DC 18", source: "fallback" })];
    const gmRoot = makeTracker(["c1"]);
    renderTrackerDigestInto(gmRoot, combatWith(log), true, new Set(["c1"]));
    expect(gmRoot.querySelector(".pf2edc-ai-rationale").textContent).toBe("Closest target.");
    expect(gmRoot.textContent).toContain("DC 18");
    expect(gmRoot.textContent).toContain("fallback heuristic");

    const playerRoot = makeTracker(["c1"]);
    renderTrackerDigestInto(playerRoot, combatWith(log), false, new Set(["c1"]));
    expect(playerRoot.querySelector(".pf2edc-ai-expanded")).toBeTruthy();
    expect(playerRoot.querySelector(".pf2edc-ai-rationale")).toBeNull();
    expect(playerRoot.textContent).not.toContain("Closest target.");
    expect(playerRoot.textContent).not.toContain("DC 18");
    expect(playerRoot.textContent).not.toContain("fallback heuristic");
  });

  it("never shows a hidden-token actor's records to a player", () => {
    const root = makeTracker(["c1"]);
    renderTrackerDigestInto(root, combatWith([rec({ visibility: "gm" })]), false, new Set(["c1"]));
    expect(line(root, "c1")).toBeNull();
    renderTrackerDigestInto(root, combatWith([rec({ visibility: "gm" })]), true, new Set(["c1"]));
    expect(root.querySelector(".pf2edc-ai-gm-only")).toBeTruthy();
  });

  it("escapes record text", () => {
    const root = makeTracker(["c1"]);
    renderTrackerDigestInto(root, combatWith([rec({ summary: "<img src=x onerror=alert(1)>" })]), true, new Set(["c1"]));
    expect(root.querySelector(".pf2edc-ai-last img")).toBeNull();
    expect(line(root, "c1").textContent).toContain("<img src=x");
  });

  it("treats a malformed agentLog flag or a missing combat as empty (no line, no throw)", () => {
    const root = makeTracker(["c1"]);
    for (const combat of [combatWith("not-an-array"), combatWith({}), null, { round: 1, getFlag: () => { throw new Error("x"); } }]) {
      expect(() => renderTrackerDigestInto(root, combat, true, new Set())).not.toThrow();
      expect(root.querySelector(".pf2edc-ai-last")).toBeNull();
    }
  });
});

describe("registerAiActionDetail: renderCombatTracker wiring (#951)", () => {
  function fakeHooks() {
    const handlers = {};
    return {
      on: (name, fn) => (handlers[name] ??= []).push(fn),
      call: (name, ...args) => (handlers[name] ?? []).forEach((fn) => fn(...args)),
      handlers,
    };
  }

  it("renders into the tracker element for the tracker's viewed combat", () => {
    const hooks = fakeHooks();
    registerAiActionDetail({ hooks, getUser: () => ({ isGM: false }), getCombat: () => null, doc: document });
    const root = makeTracker(["c1"]);
    hooks.call("renderCombatTracker", { viewed: combatWith([rec()]) }, root, {}, {});
    expect(line(root, "c1")).toBeTruthy();
  });

  it("falls back to game.combat when the app has no viewed property, and does nothing with no combat", () => {
    const hooks = fakeHooks();
    let combat = combatWith([rec()]);
    registerAiActionDetail({ hooks, getUser: () => ({ isGM: true }), getCombat: () => combat, doc: document });
    const root = makeTracker(["c1"]);
    hooks.call("renderCombatTracker", {}, root);
    expect(line(root, "c1")).toBeTruthy();
    const empty = makeTracker(["c1"]);
    hooks.call("renderCombatTracker", { viewed: null }, empty);
    expect(line(empty, "c1")).toBeNull();
  });

  it("keeps expanded rows across renders of one combat, and clears them for another combat or on deleteCombat", () => {
    const hooks = fakeHooks();
    const { expandedIds } = registerAiActionDetail({ hooks, getUser: () => ({ isGM: true }), doc: document });
    const a = combatWith([rec()], 2, "A");
    let root = makeTracker(["c1"]);
    hooks.call("renderCombatTracker", { viewed: a }, root);
    line(root, "c1").click();
    root = makeTracker(["c1"]);
    hooks.call("renderCombatTracker", { viewed: a }, root);
    expect(root.querySelector(".pf2edc-ai-expanded")).toBeTruthy();

    root = makeTracker(["c1"]);
    hooks.call("renderCombatTracker", { viewed: combatWith([rec()], 2, "B") }, root);
    expect(root.querySelector(".pf2edc-ai-expanded")).toBeNull();

    expandedIds.add("c1");
    hooks.call("deleteCombat", { id: "B" });
    expect(expandedIds.size).toBe(0);
  });

  it("never throws into the tracker render", () => {
    const hooks = fakeHooks();
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    registerAiActionDetail({ hooks, getUser: () => { throw new Error("boom"); }, doc: document });
    expect(() => hooks.call("renderCombatTracker", { viewed: combatWith([rec()]) }, makeTracker(["c1"]))).not.toThrow();
    expect(err).toHaveBeenCalled();
    err.mockRestore();
  });
});
