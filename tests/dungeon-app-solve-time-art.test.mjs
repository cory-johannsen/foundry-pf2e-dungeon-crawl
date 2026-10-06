import { describe, it, expect, beforeEach, vi } from "vitest";

// #764: puzzle / skill-challenge used-state art must swap when the
// challenge COMPLETES (recordPuzzleStageOutcome / recordSkillChallengeOutcome
// reaching a final `resolved`), never mid-challenge, and an art failure must
// never break completion.

const h = vi.hoisted(() => ({
  state: null,
  applyUsedArt: null,
  resolveOrder: [],
}));

vi.mock("../scripts/dungeon-runner.mjs", async (orig) => ({
  ...(await orig()),
  recordSkillChallengeAttempt: async () => h.state,
  recordPuzzleStageAttempt: async () => h.state,
  getRunState: () => h.state,
  markRoomOutcome: async () => {
    h.resolveOrder.push("markRoomOutcome");
    return { state: h.state, effectKey: null };
  },
}));
vi.mock("../scripts/dungeon-scene.mjs", async (orig) => ({
  ...(await orig()),
  applyRoomFeatureUsedArtForScene: (...a) => h.applyUsedArt(...a),
}));
vi.mock("../scripts/data-loader.mjs", async (orig) => ({
  ...(await orig()),
  loadDungeonSetpieces: async () => [],
}));
vi.mock("../scripts/foundry-api.mjs", async (orig) => ({
  ...(await orig()),
  makeFoundryApi: () => ({ grantPartyXp: async () => {} }),
}));

function stubGlobals() {
  globalThis.foundry = {
    applications: { api: { ApplicationV2: class {}, HandlebarsApplicationMixin: (B) => B } },
    utils: { escapeHTML: (s) => String(s) },
  };
  globalThis.ui = { notifications: { info() {}, warn() {}, error() {} } };
  globalThis.game = {
    i18n: { format: () => "", localize: (k) => k },
    scenes: { get: () => ({ id: "s", tokens: [] }) },
    actors: {},
  };
  globalThis.Hooks = { on() {}, once() {}, off() {}, callAll() {} };
}

function stateWith(kind, resolved) {
  const room = { id: "r1", kind, locationTag: "undead" };
  room[kind === "puzzle" ? "puzzle" : "challenge"] = { resolved };
  return { currentRoomId: "r1", rooms: { r1: room }, layoutPositionByRoomId: {} };
}

describe("#764 solve-time used art (dungeon-app)", () => {
  let app;
  beforeEach(async () => {
    stubGlobals();
    h.applyUsedArt = vi.fn(async () => {});
    h.resolveOrder = [];
    app = await import("../scripts/ui/dungeon-app.mjs");
  });

  it("puzzle: no swap while unresolved", async () => {
    h.state = stateWith("puzzle", null);
    await app.recordPuzzleStageOutcome("s", "r1", 0, "success");
    expect(h.applyUsedArt).not.toHaveBeenCalled();
  });

  it.each(["success", "failure"])("puzzle: swaps once when resolved %s", async (r) => {
    h.state = stateWith("puzzle", r);
    await app.recordPuzzleStageOutcome("s", "r1", 0, "success");
    expect(h.applyUsedArt.mock.calls).toEqual([["s", "r1", "puzzle", { theme: "undead" }]]);
  });

  it("skill_challenge: no swap while unresolved", async () => {
    h.state = stateWith("skill_challenge", null);
    await app.recordSkillChallengeOutcome("s", "r1", "success");
    expect(h.applyUsedArt).not.toHaveBeenCalled();
  });

  it.each(["success", "failure"])("skill_challenge: swaps once when resolved %s", async (r) => {
    h.state = stateWith("skill_challenge", r);
    await app.recordSkillChallengeOutcome("s", "r1", "success");
    expect(h.applyUsedArt.mock.calls).toEqual([["s", "r1", "skill_challenge", { theme: "undead" }]]);
  });

  it("art failure does not break completion (room still resolves)", async () => {
    h.applyUsedArt = vi.fn(async () => { throw new Error("boom"); });
    h.state = stateWith("puzzle", "success");
    await expect(app.recordPuzzleStageOutcome("s", "r1", 0, "success")).resolves.toBeUndefined();
    expect(h.resolveOrder).toContain("markRoomOutcome");
  });
});
