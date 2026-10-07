import { describe, it, expect, vi, afterEach } from "vitest";
import {
  computeFlankedTokenIds,
  createFlankedIndicator,
  flankingPlaceablesFor,
  registerFlankedIndicator,
} from "../scripts/flanking-indicator.mjs";

// `flanking` = ids of tokens THIS token is flanking (what Token#isFlanking
// would return true for).
function token(id, { flanking = [], actor = true } = {}) {
  return {
    id,
    actor: actor ? { id: `actor-${id}`, update: vi.fn() } : null,
    document: { update: vi.fn() },
    isFlanking: vi.fn((target) => flanking.includes(target.id)),
  };
}

describe("computeFlankedTokenIds", () => {
  it("flags a token another token reports flanking", () => {
    const a = token("a", { flanking: ["target"] });
    const target = token("target");
    expect([...computeFlankedTokenIds([a, target])]).toEqual(["target"]);
  });

  it("flags a friendly token too (any alliance, any actor)", () => {
    const enemy = token("enemy", { flanking: ["pc"] });
    const pc = token("pc");
    expect(computeFlankedTokenIds([enemy, pc]).has("pc")).toBe(true);
  });

  it("returns an empty set when nobody is flanking anybody", () => {
    expect(computeFlankedTokenIds([token("a"), token("b")]).size).toBe(0);
    expect(computeFlankedTokenIds([]).size).toBe(0);
  });

  it("a token never counts as flanking itself", () => {
    const a = token("a", { flanking: ["a"] });
    expect(computeFlankedTokenIds([a]).size).toBe(0);
  });

  it("re-evaluates every token: a different token's flanking changes who is flanked", () => {
    const flanker = token("flanker", { flanking: ["x"] });
    const x = token("x");
    const y = token("y");
    expect([...computeFlankedTokenIds([flanker, x, y])]).toEqual(["x"]);
    flanker.isFlanking.mockImplementation((t) => t.id === "y");
    expect([...computeFlankedTokenIds([flanker, x, y])]).toEqual(["y"]);
  });

  it("ignores tokens with no actor, as target and as flanker", () => {
    const ghost = token("ghost", { flanking: ["t"], actor: false });
    const t = token("t");
    const ghostTarget = token("g2", { actor: false });
    const real = token("real", { flanking: ["g2"] });
    expect(computeFlankedTokenIds([ghost, t]).size).toBe(0);
    expect(computeFlankedTokenIds([real, ghostTarget]).size).toBe(0);
  });

  it("treats a throwing isFlanking as not flanking", () => {
    const bad = token("bad");
    bad.isFlanking.mockImplementation(() => {
      throw new Error("token mid-destroy");
    });
    expect(computeFlankedTokenIds([bad, token("t")]).size).toBe(0);
  });
});

function makeDeps({ combat = { id: "c1" }, placeables = [] } = {}) {
  const state = { combat, placeables, badges: [], deferred: [] };
  const deps = {
    getCombat: vi.fn(() => state.combat),
    getPlaceables: vi.fn(() => state.placeables),
    createBadge: vi.fn((p) => {
      const badge = {
        tokenId: p.id,
        destroyed: false,
        destroy: vi.fn(() => {
          badge.destroyed = true;
        }),
        isAttached: vi.fn(() => !badge.destroyed),
      };
      state.badges.push(badge);
      return badge;
    }),
    defer: vi.fn((fn) => state.deferred.push(fn)),
    onError: vi.fn(),
  };
  return { state, deps };
}

describe("createFlankedIndicator", () => {
  it("creates one badge per flanked token", () => {
    const a = token("a", { flanking: ["t"] });
    const b = token("b", { flanking: ["t"] });
    const t = token("t");
    const { deps } = makeDeps({ placeables: [a, b, t] });
    const ind = createFlankedIndicator(deps);
    ind.refresh();
    expect(deps.createBadge).toHaveBeenCalledTimes(1);
    expect(deps.createBadge.mock.calls[0][0].id).toBe("t");
    expect(ind.badgeCount()).toBe(1);
  });

  it("keeps a healthy badge across refreshes instead of recreating it", () => {
    const a = token("a", { flanking: ["t"] });
    const t = token("t");
    const { deps } = makeDeps({ placeables: [a, t] });
    const ind = createFlankedIndicator(deps);
    ind.refresh();
    ind.refresh();
    expect(deps.createBadge).toHaveBeenCalledTimes(1);
  });

  it("destroys a badge once its token is no longer flanked", () => {
    const a = token("a", { flanking: ["t"] });
    const t = token("t");
    const { deps, state } = makeDeps({ placeables: [a, t] });
    const ind = createFlankedIndicator(deps);
    ind.refresh();
    a.isFlanking.mockImplementation(() => false);
    ind.refresh();
    expect(state.badges[0].destroy).toHaveBeenCalled();
    expect(ind.badgeCount()).toBe(0);
  });

  it("recreates a badge that reports itself detached (token was redrawn)", () => {
    const a = token("a", { flanking: ["t"] });
    const t = token("t");
    const { deps, state } = makeDeps({ placeables: [a, t] });
    const ind = createFlankedIndicator(deps);
    ind.refresh();
    state.badges[0].isAttached.mockImplementation(() => false);
    ind.refresh();
    expect(deps.createBadge).toHaveBeenCalledTimes(2);
    expect(state.badges[0].destroy).toHaveBeenCalled();
    expect(ind.badgeCount()).toBe(1);
  });

  it("destroys the badge of a token that left the combat or was deleted", () => {
    const a = token("a", { flanking: ["t"] });
    const t = token("t");
    const { deps, state } = makeDeps({ placeables: [a, t] });
    const ind = createFlankedIndicator(deps);
    ind.refresh();
    state.placeables = [a];
    ind.refresh();
    expect(state.badges[0].destroy).toHaveBeenCalled();
    expect(ind.badgeCount()).toBe(0);
  });

  it("with no started combat: creates nothing and clears every existing badge", () => {
    const a = token("a", { flanking: ["t"] });
    const t = token("t");
    const { deps, state } = makeDeps({ placeables: [a, t] });
    const ind = createFlankedIndicator(deps);
    ind.refresh();
    state.combat = null;
    ind.refresh();
    expect(state.badges[0].destroy).toHaveBeenCalled();
    expect(ind.badgeCount()).toBe(0);
    expect(deps.getPlaceables).toHaveBeenCalledTimes(1); // not asked again
  });

  it("clear() destroys every badge", () => {
    const a = token("a", { flanking: ["t", "u"] });
    const t = token("t");
    const u = token("u");
    const { deps, state } = makeDeps({ placeables: [a, t, u] });
    const ind = createFlankedIndicator(deps);
    ind.refresh();
    expect(ind.badgeCount()).toBe(2);
    ind.clear();
    expect(state.badges.every((b) => b.destroy.mock.calls.length === 1)).toBe(true);
    expect(ind.badgeCount()).toBe(0);
  });

  it("schedule() coalesces many calls into a single deferred refresh", () => {
    const a = token("a", { flanking: ["t"] });
    const t = token("t");
    const { deps, state } = makeDeps({ placeables: [a, t] });
    const ind = createFlankedIndicator(deps);
    ind.schedule();
    ind.schedule();
    ind.schedule();
    expect(state.deferred).toHaveLength(1);
    state.deferred[0]();
    expect(deps.getPlaceables).toHaveBeenCalledTimes(1);
    ind.schedule(); // a new pass can be scheduled after the first ran
    expect(state.deferred).toHaveLength(2);
  });

  it("reports a failing refresh through onError instead of throwing", () => {
    const { deps, state } = makeDeps();
    deps.getPlaceables.mockImplementation(() => {
      throw new Error("canvas not ready");
    });
    const ind = createFlankedIndicator(deps);
    ind.schedule();
    expect(() => state.deferred[0]()).not.toThrow();
    expect(deps.onError).toHaveBeenCalledTimes(1);
  });

  it("writes nothing: no actor or token update is ever called", () => {
    const a = token("a", { flanking: ["t"] });
    const t = token("t");
    const { deps } = makeDeps({ placeables: [a, t] });
    const ind = createFlankedIndicator(deps);
    ind.refresh();
    ind.refresh();
    ind.clear();
    for (const p of [a, t]) {
      expect(p.actor.update).not.toHaveBeenCalled();
      expect(p.document.update).not.toHaveBeenCalled();
    }
  });
});

// A combatant whose linked token placeable is `placeable` (undefined = no
// linked token on this client).
function combatant(placeable, { defeated = false } = {}) {
  return {
    id: `cbt-${placeable?.id ?? "none"}`,
    isDefeated: defeated,
    token: placeable ? { object: placeable } : undefined,
  };
}

describe("flankingPlaceablesFor (#875)", () => {
  it("excludes a defeated combatant's token and keeps the alive ones", () => {
    const alive = token("alive");
    const dead = token("dead");
    const out = flankingPlaceablesFor({
      combatants: [combatant(alive), combatant(dead, { defeated: true })],
    });
    expect(out).toEqual([alive]);
  });

  it("skips a combatant with no linked token safely", () => {
    const alive = token("alive");
    const out = flankingPlaceablesFor({
      combatants: [combatant(undefined), combatant(alive)],
    });
    expect(out).toEqual([alive]);
  });

  it("composes: a defeated tokenless combatant is also skipped", () => {
    const alive = token("alive");
    const out = flankingPlaceablesFor({
      combatants: [combatant(undefined, { defeated: true }), combatant(alive)],
    });
    expect(out).toEqual([alive]);
  });
});

describe("flanked badge vs defeat (#875)", () => {
  function setup() {
    const a = token("a", { flanking: ["t"] });
    const b = token("b", { flanking: ["t"] });
    const t = token("t");
    const bystander = token("x");
    const cbts = {
      a: combatant(a),
      b: combatant(b),
      t: combatant(t),
      x: combatant(bystander),
    };
    const combat = { combatants: Object.values(cbts) };
    const { deps, state } = makeDeps({ placeables: [] });
    deps.getPlaceables = vi.fn((c) => flankingPlaceablesFor(c));
    state.combat = combat;
    return { ind: createFlankedIndicator(deps), deps, state, cbts, ids: { a, b, t } };
  }

  it("creates a badge for a flanked creature", () => {
    const { ind, state } = setup();
    ind.refresh();
    expect(ind.badgeCount()).toBe(1);
    expect(state.badges[0].tokenId).toBe("t");
  });

  it("destroys the badge when the flanked creature is defeated", () => {
    const { ind, state, cbts } = setup();
    ind.refresh();
    cbts.t.isDefeated = true;
    ind.refresh();
    expect(state.badges[0].destroy).toHaveBeenCalled();
    expect(ind.badgeCount()).toBe(0);
  });

  it("defeating one flanker of a two-flanker pair removes the flank", () => {
    // Flanking needs BOTH flankers: each reports isFlanking(t) only while
    // its partner is present among the placeables the pass sees.
    const t = token("t");
    const mk = (id, partner) => {
      const p = token(id);
      p.isFlanking.mockImplementation(
        (target) => target.id === "t" && partner.present,
      );
      return p;
    };
    const pa = { present: true };
    const pb = { present: true };
    const a = mk("a", pb);
    const b = mk("b", pa);
    const ca = combatant(a);
    const cb = combatant(b);
    const ct = combatant(t);
    const { deps, state } = makeDeps();
    state.combat = { combatants: [ca, cb, ct] };
    deps.getPlaceables = vi.fn((c) => {
      const out = flankingPlaceablesFor(c);
      pa.present = out.includes(a);
      pb.present = out.includes(b);
      return out;
    });
    const ind = createFlankedIndicator(deps);
    ind.refresh();
    expect(ind.badgeCount()).toBe(1);
    ca.isDefeated = true;
    ind.refresh();
    expect(state.badges[0].destroy).toHaveBeenCalled();
    expect(ind.badgeCount()).toBe(0);
  });

  it("an un-defeated flanked creature is unaffected by another's defeat", () => {
    const { ind, state, cbts } = setup();
    ind.refresh();
    cbts.x.isDefeated = true; // unrelated bystander
    ind.refresh();
    expect(state.badges[0].destroy).not.toHaveBeenCalled();
    expect(ind.badgeCount()).toBe(1);
  });
});

describe("registerFlankedIndicator hooks (#875)", () => {
  const saved = {};
  afterEach(() => {
    vi.useRealTimers();
    for (const k of ["Hooks", "canvas", "game"]) {
      if (saved[k] === undefined) delete globalThis[k];
      else globalThis[k] = saved[k];
    }
  });

  function install(combat) {
    for (const k of ["Hooks", "canvas", "game"]) saved[k] = globalThis[k];
    const hooks = {};
    globalThis.Hooks = {
      on: vi.fn((name, fn) => {
        (hooks[name] ??= []).push(fn);
      }),
    };
    globalThis.canvas = { scene: { id: "s1" } };
    const getCombat = vi.fn(() => combat);
    globalThis.game = {
      get combat() {
        return getCombat();
      },
    };
    return { hooks, getCombat };
  }

  it("keeps every existing hook and adds updateCombatant", () => {
    const { hooks } = install(null);
    registerFlankedIndicator();
    for (const name of [
      "updateToken",
      "refreshToken",
      "updateCombat",
      "updateCombatant",
      "createCombatant",
      "deleteCombatant",
      "canvasReady",
      "deleteCombat",
      "canvasTearDown",
    ])
      expect(hooks[name]?.length, name).toBeGreaterThan(0);
  });

  it("updateCombatant schedules a refresh that consults the combat", () => {
    vi.useFakeTimers();
    // started combat on another scene -> getCombat() resolves to null, no drawing
    const { hooks, getCombat } = install({ started: true, scene: { id: "other" } });
    registerFlankedIndicator();
    hooks.updateCombatant[0]();
    expect(getCombat).not.toHaveBeenCalled(); // deferred, not synchronous
    vi.advanceTimersByTime(100);
    expect(getCombat).toHaveBeenCalled();
  });
});
