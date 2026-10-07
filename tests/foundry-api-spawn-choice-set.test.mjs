import { describe, it, expect, vi, beforeEach } from "vitest";
import { makeFoundryApi } from "../scripts/foundry-api.mjs";

// #897: a spawned NPC/hazard's embedded items may carry a PF2e ChoiceSet rule
// element; it must be pre-resolved before Actor.createDocuments.
function choiceItem(extra = {}) {
  return {
    name: "Charm of Resistance",
    system: {
      rules: [
        {
          key: "ChoiceSet",
          flag: "damageType",
          choices: [
            { label: "Acid", value: "acid" },
            { label: "Fire", value: "fire" },
          ],
        },
      ],
    },
    flags: { pf2e: { rulesSelections: {}, ...extra } },
  };
}

let createdData;
function install(actorData) {
  createdData = [];
  globalThis.foundry = {
    utils: { mergeObject: (a, b) => ({ ...a, ...b }) },
  };
  globalThis.Actor = {
    createDocuments: vi.fn(async (docs) => {
      createdData.push(...docs);
      return [
        {
          id: "a1",
          name: "Test",
          system: {},
          prototypeToken: { width: 1, height: 1 },
          getTokenDocument: async () => ({ toObject: () => ({}) }),
        },
      ];
    }),
  };
  globalThis.game = {
    packs: {
      get: () => ({
        getDocument: async () => ({
          prototypeToken: { texture: { src: "x.webp" } },
          toObject: () => actorData,
        }),
      }),
    },
  };
}

function scene() {
  return {
    grid: { size: 100 },
    width: 1000,
    height: 1000,
    tokens: [],
    createEmbeddedDocuments: async () => [{ id: "t1" }],
  };
}

describe("spawnCreatures ChoiceSet pre-resolution (#897)", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("pre-resolves a ChoiceSet on a spawned actor's embedded item", async () => {
    install({ name: "Test", items: [choiceItem(), { name: "Fists", system: { rules: [] } }] });
    await makeFoundryApi(scene()).spawnCreatures([{ pack: "p", id: "i" }], { disposition: 1 });
    expect(createdData).toHaveLength(1);
    expect(["acid", "fire"]).toContain(createdData[0].items[0].flags.pf2e.rulesSelections.damageType);
    expect(createdData[0].items[1]).toEqual({ name: "Fists", system: { rules: [] } });
  });

  it("does not overwrite an already-resolved selection", async () => {
    install({ name: "Test", items: [choiceItem({ rulesSelections: { damageType: "fire" } })] });
    vi.spyOn(Math, "random").mockReturnValue(0);
    await makeFoundryApi(scene()).spawnCreatures([{ pack: "p", id: "i" }], { disposition: 1 });
    expect(createdData[0].items[0].flags.pf2e.rulesSelections.damageType).toBe("fire");
  });
});
