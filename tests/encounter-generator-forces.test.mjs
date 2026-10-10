import { describe, it, expect, vi, afterEach } from "vitest";

const spawnCreatures = vi.fn(async () => []);
const api = {
  partyLevel: vi.fn(async () => 3),
  postChatCard: vi.fn(async () => {}),
  spawnCreatures,
  spawnCoverItems: vi.fn(async () => {}),
  listCreatureTraits: vi.fn(async () => []),
};
vi.mock("../scripts/foundry-api.mjs", () => ({ makeFoundryApi: vi.fn(() => api) }));
vi.mock("../scripts/encounter-deck.mjs", () => ({
  buildEncounterDeck: vi.fn(() => []),
  dealEncounter: vi.fn((_slots, { seed }) => ({ resolved: [seed] })),
}));
const generateEncounterRoster = vi.fn();
vi.mock("../scripts/generator-registry.mjs", () => ({
  getGenerator: vi.fn(() => ({ generateEncounterRoster })),
}));
vi.mock("../scripts/data-loader.mjs", () => ({ loadCreatureArt: vi.fn(async () => []) }));
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
vi.mock("../scripts/cover-items.mjs", () => ({ chooseCoverItemTypes: vi.fn(() => []) }));
const chooseEncounterForces = vi.fn();
vi.mock("../scripts/encounter-forces-dialog.mjs", () => ({ chooseEncounterForces }));

const { generateEncounter, buildForceTable, FORCE_TINTS, forceTint } = await import(
  "../scripts/encounter-generator.mjs"
);
const { startCombatForEncounterId } = await import("../scripts/dungeon-combat.mjs");

const MODULE_ID = "pf2e-dungeon-crawl";
const foe = { pack: "p", id: "x", name: "Goblin", level: 1, count: 1 };
const roster = (extra = {}) => ({
  foes: [foe],
  friend: null,
  twins: null,
  lurker: null,
  appliedFilters: ["levelRange", "family", "rarity", "xpCapOverride"],
  ...extra,
});
const force = (id, over = {}) => ({
  id,
  name: over.name ?? id.toUpperCase(),
  hostility: over.hostility ?? "players",
  share: 50,
  filters: {
    traits: [],
    excludeTraits: [],
    levelOffsetMin: null,
    levelOffsetMax: null,
    family: "",
    rarity: "",
    ...(over.filters ?? {}),
  },
  placement: over.placement ?? { mode: "nearParty" },
});

function install(members = 4) {
  globalThis.renderTemplate = vi.fn(async () => "<div></div>");
  globalThis.game = {
    user: { isGM: true },
    i18n: { localize: (k) => k, format: (k, d) => `${k}:${d?.name ?? ""}` },
    actors: {
      party: {
        members: Array.from({ length: members }, (_, i) => ({ id: `a${i}`, type: "character" })),
      },
    },
  };
  globalThis.canvas = { scene: { id: "scene1" }, tokens: { placeables: [] } };
  globalThis.ui = { notifications: { warn: vi.fn() } };
  globalThis.foundry = {
    applications: { api: { DialogV2: { wait: vi.fn() } } },
    utils: { mergeObject: (a, b) => ({ ...a, ...b }) },
  };
}

afterEach(() => {
  vi.clearAllMocks();
  generateEncounterRoster.mockReset();
  for (const k of ["renderTemplate", "game", "canvas", "ui", "foundry"]) delete globalThis[k];
});

const twoForces = () => ({
  difficulty: "moderate",
  forces: [
    force("f1", { filters: { traits: ["undead"], family: "goblin" } }),
    force("f2", { hostility: "all" }),
  ],
});

describe("buildForceTable / tints", () => {
  it("maps forces to hostility entries", () => {
    expect(
      buildForceTable([force("f1", { hostility: "all" }), force("f2", { hostility: "players" })]),
    ).toEqual({
      f1: { hostility: "all", hostileTo: [] },
      f2: { hostility: "players", hostileTo: [] },
    });
  });
  it("has at least six tints and wraps", () => {
    expect(FORCE_TINTS.length).toBeGreaterThanOrEqual(6);
    expect(forceTint(0)).toBe(FORCE_TINTS[0]);
    expect(forceTint(FORCE_TINTS.length)).toBe(FORCE_TINTS[0]);
  });
});

describe("generateEncounter multi-force (#1083)", () => {
  it("generates per force with split budget, own seed, and filters", async () => {
    install(4);
    chooseEncounterForces.mockResolvedValue(twoForces());
    generateEncounterRoster.mockResolvedValue(roster());
    await generateEncounter({ scene: { id: "scene1" } });
    expect(chooseEncounterForces).toHaveBeenCalledWith(expect.objectContaining({ partySize: 4 }));
    expect(generateEncounterRoster).toHaveBeenCalledTimes(2);
    const [a, b] = generateEncounterRoster.mock.calls.map((c) => c[0]);
    expect(a.xpCapOverride).toBe(40);
    expect(b.xpCapOverride).toBe(40);
    expect(a.resolved).not.toEqual(b.resolved);
    expect(a.traits).toEqual(["undead"]);
    expect(a.family).toBe("goblin");
    expect(a.depthBias).toBeNull();
  });

  it("spawns each force hostile with forceId flag, offset and tint, then starts combat once with the table", async () => {
    install(4);
    chooseEncounterForces.mockResolvedValue(twoForces());
    generateEncounterRoster.mockResolvedValue(roster());
    await generateEncounter({ scene: { id: "scene1" } });
    const calls = spawnCreatures.mock.calls.map((c) => c[1]);
    expect(calls).toHaveLength(2);
    expect(calls.map((o) => o.extraFlags[MODULE_ID].forceId)).toEqual(["f1", "f2"]);
    expect(calls.map((o) => o.disposition)).toEqual([-1, -1]);
    expect(calls[0].originOffsetCells).not.toEqual(calls[1].originOffsetCells);
    expect(calls[0].tint).not.toBe(calls[1].tint);
    expect(calls[0].nameSuffix).toBe("F1");
    expect(startCombatForEncounterId).toHaveBeenCalledTimes(1);
    expect(startCombatForEncounterId.mock.calls[0][2]).toEqual({
      forces: {
        f1: { hostility: "players", hostileTo: [] },
        f2: { hostility: "all", hostileTo: [] },
      },
    });
  });

  it("drops an empty force with a warning; all empty means no spawn and no combat", async () => {
    install(4);
    chooseEncounterForces.mockResolvedValue(twoForces());
    generateEncounterRoster
      .mockResolvedValueOnce(roster())
      .mockResolvedValueOnce(roster({ foes: [] }));
    await generateEncounter({ scene: { id: "scene1" } });
    expect(ui.notifications.warn).toHaveBeenCalledWith("PF2EDC.Encounter.ForceEmpty:F2");
    expect(spawnCreatures).toHaveBeenCalledTimes(1);
    expect(Object.keys(startCombatForEncounterId.mock.calls[0][2].forces)).toEqual(["f1"]);

    vi.clearAllMocks();
    chooseEncounterForces.mockResolvedValue(twoForces());
    generateEncounterRoster.mockResolvedValue(roster({ foes: [] }));
    await generateEncounter({ scene: { id: "scene1" } });
    expect(spawnCreatures).not.toHaveBeenCalled();
    expect(startCombatForEncounterId).not.toHaveBeenCalled();
  });

  it("warns when a requested filter is not reported applied", async () => {
    install(4);
    chooseEncounterForces.mockResolvedValue(twoForces());
    generateEncounterRoster.mockResolvedValue(roster({ appliedFilters: undefined }));
    await generateEncounter({ scene: { id: "scene1" } });
    const posted = api.postChatCard.mock.calls.length;
    expect(posted).toBe(2);
    expect(globalThis.renderTemplate.mock.calls.some(([, d]) =>
      d.roster.warnings?.some((w) => w.includes("PF2EDC.Encounter.ForceFilterUnsupported")),
    )).toBe(true);
  });

  it("keeps friend/twins/lurker on force 1 only", async () => {
    install(4);
    chooseEncounterForces.mockResolvedValue(twoForces());
    const extras = {
      friend: { pack: "p", id: "fr", name: "Fr", level: 1 },
      twins: [{ pack: "p", id: "t", name: "T", level: 1 }],
      lurker: { pack: "p", id: "l", name: "L", level: 1 },
    };
    generateEncounterRoster.mockResolvedValue(roster(extras));
    await generateEncounter({ scene: { id: "scene1" } });
    const dispositions = spawnCreatures.mock.calls.map(
      (c) => `${c[1].extraFlags[MODULE_ID].forceId}:${c[1].disposition}`,
    );
    expect(dispositions.filter((d) => d.startsWith("f2"))).toEqual(["f2:-1"]);
    expect(dispositions.filter((d) => d.startsWith("f1")).length).toBe(4);
  });

  it("uses the real party size", async () => {
    install(2);
    chooseEncounterForces.mockResolvedValue(twoForces());
    generateEncounterRoster.mockResolvedValue(roster());
    await generateEncounter({ scene: { id: "scene1" } });
    expect(chooseEncounterForces).toHaveBeenCalledWith(expect.objectContaining({ partySize: 2 }));
    expect(generateEncounterRoster.mock.calls[0][0].partySize).toBe(2);
  });

  it("cancelled dialog does nothing", async () => {
    install(4);
    chooseEncounterForces.mockResolvedValue(null);
    await generateEncounter({ scene: { id: "scene1" } });
    expect(generateEncounterRoster).not.toHaveBeenCalled();
  });

  it("skipThemeDialog stays the legacy single-force path", async () => {
    install(4);
    generateEncounterRoster.mockResolvedValue(roster());
    await generateEncounter({ skipThemeDialog: true, scene: { id: "scene1" } });
    expect(chooseEncounterForces).not.toHaveBeenCalled();
    expect(generateEncounterRoster).toHaveBeenCalledTimes(1);
    expect(generateEncounterRoster.mock.calls[0][0]).not.toHaveProperty("xpCapOverride");
    const o = spawnCreatures.mock.calls[0][1];
    expect(o.extraFlags[MODULE_ID]).not.toHaveProperty("forceId");
    expect(o).not.toHaveProperty("tint");
    expect(startCombatForEncounterId.mock.calls[0]).toHaveLength(2);
  });
});
