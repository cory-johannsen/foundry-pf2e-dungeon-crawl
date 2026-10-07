import { describe, it, expect } from "vitest";
import { selectTrap } from "../scripts/trap-library.mjs";
import { classifyTrap } from "../scripts/trap-combat.mjs";

function makeStubApi({ hazards, automatableIds = new Set() }) {
  const calls = [];
  return {
    calls,
    async findHazards(opts) {
      calls.push({ method: "findHazards", opts });
      return hazards.filter((h) => {
        if (opts.minLevel != null && h.level < opts.minLevel) return false;
        if (opts.maxLevel != null && h.level > opts.maxLevel) return false;
        return true;
      });
    },
    async classifyHazard({ pack, id }) {
      calls.push({ method: "classifyHazard", pack, id });
      return { automatable: automatableIds.has(id) };
    },
  };
}

describe("selectTrap", () => {
  it("returns null when the compendium has nothing within level tolerance", async () => {
    const api = makeStubApi({ hazards: [] });
    const result = await selectTrap({ api, partyLevel: 5, rng: () => 0 });
    expect(result).toBeNull();
  });

  it("queries at partyLevel + levelOffsetBias, wider tolerance than creature encounters", async () => {
    const api = makeStubApi({ hazards: [] });
    await selectTrap({ api, partyLevel: 5, levelOffsetBias: 2, rng: () => 0 });
    expect(api.calls[0]).toMatchObject({
      method: "findHazards",
      opts: { minLevel: 4, maxLevel: 10 }, // 5+2-3 .. 5+2+3
    });
  });

  it("picks from the level-filtered pool", async () => {
    const hazards = [
      {
        pack: "pf2e.hazards",
        id: "a",
        name: "Hidden Pit",
        level: 5,
        traits: ["trap"],
      },
      {
        pack: "pf2e.hazards",
        id: "b",
        name: "Out of Range",
        level: 20,
        traits: ["trap"],
      },
    ];
    const api = makeStubApi({ hazards, automatableIds: new Set(["a"]) });
    const result = await selectTrap({ api, partyLevel: 5, rng: () => 0 });
    expect(result.id).toBe("a");
  });

  it("prefers automatable candidates when at least one is in range", async () => {
    const hazards = [
      {
        pack: "pf2e.hazards",
        id: "complex",
        name: "Wheel of Misery",
        level: 5,
        traits: ["trap"],
      },
      {
        pack: "pf2e.hazards",
        id: "simple",
        name: "Hidden Pit",
        level: 5,
        traits: ["trap"],
      },
    ];
    const api = makeStubApi({ hazards, automatableIds: new Set(["simple"]) });
    // rng() => 0.99 would pick the last candidate in an unfiltered pool of 2;
    // with automatable-preference filtering there's only one candidate left
    // ('simple'), so any rng value must still land on it.
    const result = await selectTrap({ api, partyLevel: 5, rng: () => 0.99 });
    expect(result.id).toBe("simple");
    expect(result.automatable).toBe(true);
  });

  it("falls back to the full pool (GM-narrated) when nothing in range is automatable", async () => {
    const hazards = [
      {
        pack: "pf2e.hazards",
        id: "complex-a",
        name: "Wheel of Misery",
        level: 5,
        traits: ["trap"],
      },
      {
        pack: "pf2e.hazards",
        id: "complex-b",
        name: "Telekinetic Swarm Trap",
        level: 5,
        traits: ["trap"],
      },
    ];
    const api = makeStubApi({ hazards, automatableIds: new Set() });
    const result = await selectTrap({ api, partyLevel: 5, rng: () => 0 });
    expect(result.id).toBe("complex-a");
    expect(result.automatable).toBe(false);
  });

  it("classifies every in-range candidate exactly once", async () => {
    const hazards = [
      { pack: "pf2e.hazards", id: "a", name: "A", level: 5, traits: ["trap"] },
      { pack: "pf2e.hazards", id: "b", name: "B", level: 5, traits: ["trap"] },
      { pack: "pf2e.hazards", id: "c", name: "C", level: 20, traits: ["trap"] }, // out of range
    ];
    const api = makeStubApi({ hazards, automatableIds: new Set(["a"]) });
    await selectTrap({ api, partyLevel: 5, rng: () => 0 });
    const classifyCalls = api.calls.filter(
      (c) => c.method === "classifyHazard",
    );
    expect(classifyCalls).toHaveLength(2);
    expect(classifyCalls.map((c) => c.id).sort()).toEqual(["a", "b"]);
  });
});

describe("selectTrap with basic-save hazards (#839)", () => {
  const disable = "<p>@Check[thievery|dc:20] to disable</p>";
  const doc = (description, extra = {}) => ({
    system: { details: { disable, isComplex: false }, actions: [] },
    items: [{ type: "action", system: { description: { value: description } } }],
    ...extra,
  });
  const STEAM = doc("<p><strong>Effect</strong> @Damage[3d6[bludgeoning],3d6[fire]] (@Check[reflex|dc:24|basic]) to all creatures within 15 feet.</p>");
  const LATCH = doc("<p><strong>Effect</strong> @Damage[3d12[electricity]] to the triggering creature (@Check[reflex|dc:22|basic] save).</p>");
  const WHEEL = doc("<p>The wheel rolls initiative.</p>");
  const docs = { steam: STEAM, latch: LATCH, wheel: WHEEL };
  const hazards = [
    { pack: "pf2e.hazards", id: "steam", name: "Steam Vents", level: 4, traits: ["trap"] },
    { pack: "pf2e.hazards", id: "latch", name: "Electric Latch Rune", level: 3, traits: ["trap"] },
    { pack: "pf2e.hazards", id: "wheel", name: "Wheel of Misery", level: 6, traits: ["trap"] },
  ];
  const api = {
    findHazards: async ({ minLevel, maxLevel }) =>
      hazards.filter((h) => h.level >= minLevel && h.level <= maxLevel),
    classifyHazard: async ({ id }) => classifyTrap(docs[id]),
  };

  it("can select a basic-save hazard when it is the automatable one in range", async () => {
    // party level 4: all three are in range; only steam + latch are automatable.
    const picks = new Set();
    for (const rng of [0, 0.99]) {
      picks.add((await selectTrap({ api, partyLevel: 4, rng: () => rng })).name);
    }
    expect(picks).toEqual(new Set(["Electric Latch Rune", "Steam Vents"]));
  });

  it("never picks the initiative-rolling hazard while an automatable one is in range", async () => {
    for (const rng of [0, 0.5, 0.99]) {
      expect((await selectTrap({ api, partyLevel: 4, rng: () => rng })).name).not.toBe("Wheel of Misery");
    }
  });
});
