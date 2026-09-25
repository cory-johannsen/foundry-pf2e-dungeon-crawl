import { describe, it, expect, vi, afterEach } from "vitest";

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
  loadCreatureArt: vi.fn(async () => []),
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

const { generateEncounter } = await import("../scripts/encounter-generator.mjs");

function installFoundryStubs({ dialogShownRef }) {
  globalThis.renderTemplate = vi.fn(async () => "<div></div>");
  globalThis.game = {
    user: { isGM: true },
    i18n: { localize: (k) => k },
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

describe("generateEncounter (no approval gate)", () => {
  it("never prompts for Accept/Reroll, even for a GM-present run", async () => {
    const dialogShownRef = { shown: false };
    installFoundryStubs({ dialogShownRef });

    const result = await generateEncounter({
      skipThemeDialog: true,
      scene: { id: "scene1" },
    });

    expect(dialogShownRef.shown).toBe(false);
    expect(result).toBeUndefined();
    expect(generateEncounterRoster).toHaveBeenCalledTimes(1);
  });

  it("still shows the theme dialog when skipThemeDialog is false, but never an Accept/Reroll preview afterwards", async () => {
    const dialogShownRef = { shown: false };
    installFoundryStubs({ dialogShownRef });
    // The theme dialog itself goes through DialogV2.wait too (it always
    // returns "accept" from the stub above, which chooseThemeAndSize treats
    // as a truthy non-"cancel" value only if it looks like a theme object).
    globalThis.foundry.applications.api.DialogV2.wait = vi.fn(async () => {
      dialogShownRef.shown = true;
      return { traits: [], excludeTraits: [] };
    });

    await generateEncounter({ scene: { id: "scene1" } });

    // The theme-choice dialog is expected to run exactly once; nothing else
    // (i.e. no second, preview dialog) invokes DialogV2.wait afterwards.
    expect(globalThis.foundry.applications.api.DialogV2.wait).toHaveBeenCalledTimes(1);
    expect(generateEncounterRoster).toHaveBeenCalledTimes(1);
  });
});
