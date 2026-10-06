import { describe, it, expect, vi, beforeEach } from "vitest";

const spawnCreatures = vi.fn();
let creatureArt = [];

vi.mock("../scripts/data-loader.mjs", async (importOriginal) => {
  const real = await importOriginal();
  return { ...real, loadCreatureArt: vi.fn(async () => creatureArt) };
});
vi.mock("../scripts/foundry-api.mjs", async (importOriginal) => {
  const real = await importOriginal();
  return { ...real, makeFoundryApi: () => ({ spawnCreatures }) };
});
vi.mock("../scripts/trap-library.mjs", async (importOriginal) => {
  const real = await importOriginal();
  return {
    ...real,
    selectTrap: vi.fn(async () => ({ pack: "pf2e.hazards", id: "BHq5wpQU8hQEke8D" })),
  };
});

import { populateSlotTrap } from "../scripts/dungeon-scene.mjs";

const rect = { gx: 0, gy: 0, gw: 5, gh: 5 };

async function run() {
  globalThis.ui = { notifications: { warn: vi.fn() } };
  globalThis.game = { i18n: { localize: (k) => k }, actors: { get: () => null } };
  await populateSlotTrap({ id: "s1", tokens: { get: () => null } }, "room-1", {
    rect, partyLevel: 1, seed: "seed", roomId: "room-1",
  });
}

describe("populateSlotTrap art (#759)", () => {
  beforeEach(() => {
    spawnCreatures.mockReset();
    spawnCreatures.mockResolvedValue([]);
  });

  it("applies creature art as imgFallback when a matching entry exists", async () => {
    creatureArt = [
      { id: "hazards__hidden_pit", pack: "pf2e.hazards", docId: "BHq5wpQU8hQEke8D", name: "Hidden Pit", level: 0, art: "hazards/hidden-pit.webp" },
    ];
    await run();
    expect(spawnCreatures).toHaveBeenCalledTimes(1);
    const [entries] = spawnCreatures.mock.calls[0];
    expect(entries[0].imgFallback).toBe(
      "modules/pf2e-dungeon-crawl/assets/creature-art/hazards/hidden-pit.webp",
    );
  });

  it("passes no imgFallback when the selected hazard has no art entry", async () => {
    creatureArt = [];
    await run();
    expect(spawnCreatures).toHaveBeenCalledTimes(1);
    const [entries] = spawnCreatures.mock.calls[0];
    expect(entries[0].imgFallback ?? null).toBeNull();
  });
});
