import { describe, it, expect, vi, afterEach } from "vitest";

// #1272: generateEncounter environment pass-through.
// Wholesale-mocked: generateEncounter's own module pulls in the entire
// encounter-generation/spawn dependency tree (deck building, generator
// registry, creature art, trait picker, combat start, cover items). None of
// that machinery is under test here — only that generateEncounter no longer
// gates on an Accept/Reroll preview dialog before spawning what it dealt
// (#93).
vi.mock("../scripts/foundry-api.mjs", () => ({
  makeFoundryApi: vi.fn(() => ({
    partyLevel: vi.fn(async () => 3),
    postChatCard: vi.fn(async () => {}),
    spawnCreatures: vi.fn(async () => {}),
    spawnCoverItems: vi.fn(async () => {}),
    listCreatureTraits: vi.fn(async () => []),
  })),
}));

vi.mock("../scripts/encounter-deck.mjs", () => ({
  buildEncounterDeck: vi.fn(() => []),
  dealEncounter: vi.fn(() => ({ resolved: [] })),
}));

const generateEncounterRoster = vi.fn(async () => ({
  foes: [],
  friend: null,
  twins: null,
  lurker: null,
}));

vi.mock("../scripts/generator-registry.mjs", () => ({
  getGenerator: vi.fn(() => ({ generateEncounterRoster })),
}));

vi.mock("../scripts/data-loader.mjs", () => ({
  loadCreatureArt: vi.fn(async () => [{ id: "a", pack: "p", docId: "d1" }]),
  loadCreatureEnvironments: vi.fn(async () => ({ creatures: { a: ["swamp"] } })),
}));

vi.mock("../scripts/creature-art.mjs", () => ({
  findCreatureArt: vi.fn(() => null),
  creatureArtPath: vi.fn((f) => f),
}));

vi.mock("../scripts/trait-picker.mjs", () => ({
  traitFieldHtml: vi.fn(() => ""),
  wireTraitPickerButtons: vi.fn(),
  readTraitField: vi.fn(() => []),
}));

vi.mock("../scripts/dungeon-combat.mjs", () => ({
  startCombatForEncounterId: vi.fn(async () => {}),
}));

vi.mock("../scripts/cover-items.mjs", () => ({
  chooseCoverItemTypes: vi.fn(() => []),
}));

const { makeFoundryApi } = await import("../scripts/foundry-api.mjs");
const { generateEncounter } = await import("../scripts/encounter-generator.mjs");

function installFoundryStubs({ dialogShownRef }) {
  globalThis.renderTemplate = vi.fn(async () => "<div></div>");
  globalThis.game = {
    user: { isGM: true },
    i18n: {
      localize: (k) => k,
      format: (k, data) => `${k}:${data?.name ?? ""}`,
    },
    actors: { party: { members: [{ id: "actor1", type: "character" }] } },
  };
  globalThis.canvas = {
    scene: { id: "scene1" },
    tokens: { placeables: [] },
  };
  globalThis.ui = { notifications: { warn: vi.fn() } };
  globalThis.foundry = {
    applications: {
      api: {
        DialogV2: {
          wait: vi.fn(async () => {
            dialogShownRef.shown = true;
            return "accept";
          }),
        },
      },
    },
    utils: {
      mergeObject: (a, b) => ({ ...a, ...b }),
    },
  };
}

afterEach(() => {
  vi.clearAllMocks();
  delete globalThis.renderTemplate;
  delete globalThis.game;
  delete globalThis.canvas;
  delete globalThis.ui;
  delete globalThis.foundry;
});

describe("generateEncounter environment (#1272)", () => {
  it("environment null: generator called WITHOUT environment args (golden parity)", async () => {
    installFoundryStubs({ dialogShownRef: {} });
    await generateEncounter({ skipThemeDialog: true, scene: { id: "scene1" }, environment: null });
    const arg = generateEncounterRoster.mock.calls[0][0];
    expect("environmentLookup" in arg).toBe(false);
    expect("environment" in arg).toBe(false);
  });
  it("environment swamp: passes environment and a lookup Map", async () => {
    installFoundryStubs({ dialogShownRef: {} });
    await generateEncounter({ skipThemeDialog: true, scene: { id: "scene1" }, environment: "swamp" });
    const arg = generateEncounterRoster.mock.calls[0][0];
    expect(arg.environment).toBe("swamp");
    expect(arg.environmentLookup).toBeInstanceOf(Map);
    expect(arg.environmentLookup.get("p:d1")).toEqual(["swamp"]);
  });
});
