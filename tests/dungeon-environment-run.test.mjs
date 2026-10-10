// #1272 Task 5: run-wide environment wiring (createRun -> populateSlotEncounter -> generateEncounter).
import { describe, it, expect, vi, afterEach } from "vitest";
import { readFileSync } from "node:fs";

const generateEncounterMock = vi.fn(async () => {});
vi.mock("../scripts/encounter-generator.mjs", async (importOriginal) => ({
  ...(await importOriginal()),
  generateEncounter: (...a) => generateEncounterMock(...a),
}));

globalThis.canvas = {};
globalThis.foundry = {
  applications: { api: { ApplicationV2: class {}, HandlebarsApplicationMixin: (B) => B } },
  utils: { escapeHTML: (s) => String(s) },
};

const { createRun } = await import("../scripts/dungeon-runner.mjs");
const { populateSlotEncounter } = await import("../scripts/dungeon-scene.mjs");
const { resolveRunEnvironment, pickRandomEnvironment, buildEnvironmentLookup } =
  await import("../scripts/environments.mjs");
const { registerGenerator } = await import("../scripts/generator-registry.mjs");
const { DefaultGenerator } = await import("../scripts/default-generator.mjs");
registerGenerator(DefaultGenerator);

function makeSettingsStub() {
  let store = { dungeonRuns: {} };
  return {
    get: (m, k) => store[k],
    set: (m, k, v) => { store = { ...store, [k]: v }; },
  };
}
const lookup = buildEnvironmentLookup(
  [
    { id: "a", pack: "p", docId: "d1" },
    { id: "b", pack: "p", docId: "d2" },
  ],
  { creatures: { a: ["swamp"], b: ["cave", "forest"] } },
);
const mk = (environment, seed, environmentLookup = lookup) =>
  createRun(
    { sceneId: "s", roomCount: 3, environment, seed },
    { settingsRef: makeSettingsStub(), environmentLookup },
  );

afterEach(() => vi.clearAllMocks());

describe("createRun environment", () => {
  it("stores a normalized choice", async () => {
    expect((await mk("swamp", "x")).environment).toBe("swamp");
    expect((await mk("none", "x")).environment).toBeNull();
    expect((await mk("bogus", "x")).environment).toBeNull();
    expect((await mk(undefined, "x")).environment).toBeNull();
  });
  it("random is seeded and matches pickRandomEnvironment", async () => {
    const a = await mk("random", "seed-1");
    const b = await mk("random", "seed-1");
    expect(a.environment).toBe(b.environment);
    expect(a.environment).toBe(pickRandomEnvironment("seed-1", lookup));
    expect(["swamp", "cave", "forest"]).toContain(a.environment);
  });
  it("random with an empty lookup is null", async () => {
    expect((await mk("random", "s", new Map())).environment).toBeNull();
  });
});

describe("resolveRunEnvironment", () => {
  it("maps none/empty/unknown to null, ids to themselves", () => {
    expect(resolveRunEnvironment("none", "s", lookup)).toBeNull();
    expect(resolveRunEnvironment("", "s", lookup)).toBeNull();
    expect(resolveRunEnvironment("bogus", "s", lookup)).toBeNull();
    expect(resolveRunEnvironment("cave", "s", lookup)).toBe("cave");
    expect(resolveRunEnvironment("random", "s", lookup)).toBe(pickRandomEnvironment("s", lookup));
  });
});

describe("populateSlotEncounter", () => {
  const rect = { gx: 0, gy: 0, gw: 1, gh: 1 };
  it("passes environment through to generateEncounter", async () => {
    await populateSlotEncounter({}, "r1", { rect, environment: "swamp" });
    expect(generateEncounterMock).toHaveBeenCalledWith(expect.objectContaining({ environment: "swamp" }));
  });
  it("defaults to null", async () => {
    await populateSlotEncounter({}, "r1", { rect });
    expect(generateEncounterMock).toHaveBeenCalledWith(expect.objectContaining({ environment: null }));
  });
  it("dungeon-scene call site passes state.environment (old state => null)", () => {
    const src = readFileSync(new URL("../scripts/dungeon-scene.mjs", import.meta.url), "utf8");
    expect(src).toMatch(/environment:\s*state\.environment\s*\?\?\s*null/);
  });
});

describe("startRun relay", () => {
  it("forwards environment to startDungeonRun", async () => {
    vi.resetModules();
    const startDungeonRun = vi.fn(async () => {});
    vi.doMock("../scripts/ui/dungeon-app.mjs", () => ({ startDungeonRun }));
    const { DUNGEON_ACTIONS } = await import("../scripts/dungeon-remote.mjs");
    await DUNGEON_ACTIONS.startRun({ roomCount: 5, environment: "swamp", requestingUserId: "u1" });
    expect(startDungeonRun).toHaveBeenCalledWith(
      expect.objectContaining({ environment: "swamp", hostUserId: "u1" }),
    );
  });
});
