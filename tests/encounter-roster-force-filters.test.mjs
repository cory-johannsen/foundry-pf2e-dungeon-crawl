import { describe, it, expect } from "vitest";
import {
  resolveEncounterRoster,
  creatureMatchesFilters,
} from "../scripts/encounter-roster.mjs";

const oneFoeSlot = {
  foes: [{ id: "s1", kind: "creature", levelOffset: 0, countsAs: 1 }],
};
const twoFoeSlots = {
  foes: [
    { id: "s1", kind: "creature", levelOffset: 0, countsAs: 1 },
    { id: "s2", kind: "creature", levelOffset: 0, countsAs: 1 },
  ],
};

function poolApi(pool) {
  const calls = [];
  return {
    calls,
    async findCreatures(q) {
      calls.push(q);
      return pool.filter(
        (c) =>
          (q.minLevel == null || c.level >= q.minLevel) &&
          (q.maxLevel == null || c.level <= q.maxLevel) &&
          creatureMatchesFilters(c, q),
      );
    },
  };
}
const gob = {
  pack: "p",
  id: "g",
  name: "Goblin Warrior",
  level: 3,
  traits: ["goblin", "humanoid"],
  rarity: "common",
};

describe("resolveEncounterRoster force filters", () => {
  it("passes family/rarity through every fallback look", async () => {
    const calls = [];
    const api = {
      findCreatures: async (q) => {
        calls.push(q);
        return [];
      },
    };
    await resolveEncounterRoster({
      resolved: oneFoeSlot,
      api,
      partyLevel: 3,
      partySize: 4,
      family: "Goblin",
      rarity: "common",
      xpCapOverride: 40,
    });
    expect(calls.length).toBeGreaterThan(1);
    for (const q of calls) {
      expect(q.family).toBe("Goblin");
      expect(q.rarity).toBe("common");
    }
  });

  it("clamps the level window to the party-relative range", async () => {
    const calls = [];
    const api = {
      findCreatures: async (q) => {
        calls.push(q);
        return [];
      },
    };
    await resolveEncounterRoster({
      resolved: oneFoeSlot,
      api,
      partyLevel: 5,
      partySize: 4,
      levelOffsetMin: -1,
      levelOffsetMax: 1,
      xpCapOverride: 80,
    });
    expect(calls.length).toBeGreaterThan(0);
    for (const q of calls) {
      expect(q.minLevel).toBeGreaterThanOrEqual(4);
      expect(q.maxLevel).toBeLessThanOrEqual(6);
    }
  });

  it("xpCapOverride replaces the depth-bias cap", async () => {
    const api = poolApi([gob]);
    const roster = await resolveEncounterRoster({
      resolved: twoFoeSlots,
      api,
      partyLevel: 3,
      partySize: 4,
      xpCapOverride: 40,
      rng: () => 0,
    });
    expect(roster.foes).toHaveLength(1);
  });

  it("xpCapOverride 0 yields an empty roster (no -4 fallback)", async () => {
    const api = poolApi([gob]);
    const roster = await resolveEncounterRoster({
      resolved: twoFoeSlots,
      api,
      partyLevel: 3,
      partySize: 4,
      xpCapOverride: 0,
      rng: () => 0,
    });
    expect(roster.foes).toHaveLength(0);
    expect(api.calls).toHaveLength(0);
  });

  it.each([-5, NaN, -Infinity])("xpCapOverride %s yields an empty roster", async (bad) => {
    const api = poolApi([gob]);
    const roster = await resolveEncounterRoster({ resolved: twoFoeSlots, api, partyLevel: 3,
      partySize: 4, xpCapOverride: bad, rng: () => 0 });
    expect(roster.foes).toHaveLength(0);
  });

  it("xpCapOverride works without a partySize", async () => {
    const api = poolApi([gob]);
    const roster = await resolveEncounterRoster({
      resolved: twoFoeSlots,
      api,
      partyLevel: 3,
      xpCapOverride: 40,
      rng: () => 0,
    });
    expect(roster.foes).toHaveLength(1);
  });

  it("appliedFilters lists all four supported filters", async () => {
    const roster = await resolveEncounterRoster({
      resolved: oneFoeSlot,
      api: poolApi([gob]),
      partyLevel: 3,
    });
    expect(roster.appliedFilters).toEqual([
      "levelRange",
      "family",
      "rarity",
      "xpCapOverride",
    ]);
  });

  it("no new params = identical result to today (regression)", async () => {
    const api = poolApi([gob]);
    const roster = await resolveEncounterRoster({
      resolved: oneFoeSlot,
      api,
      partyLevel: 3,
      rng: () => 0,
    });
    expect(roster.foes).toHaveLength(1);
    expect(roster.foes[0].name).toBe("Goblin Warrior");
    expect(api.calls[0].minLevel).toBe(2);
    expect(api.calls[0].maxLevel).toBe(4);
    expect(api.calls[0].family).toBeNull();
    expect(api.calls[0].rarity).toBeNull();
  });

  it("filters the pool by family (ancestry trait) end to end", async () => {
    const orc = {
      pack: "p",
      id: "o",
      name: "Orc",
      level: 3,
      traits: ["orc"],
      rarity: "common",
    };
    const roster = await resolveEncounterRoster({
      resolved: oneFoeSlot,
      api: poolApi([orc, gob]),
      partyLevel: 3,
      family: "ORC",
      rng: () => 0.99,
    });
    expect(roster.foes.map((f) => f.name)).toEqual(["Orc"]);
  });
});

describe("creatureMatchesFilters", () => {
  it("matches family case-insensitively against traits", () => {
    expect(creatureMatchesFilters(gob, { family: "GOBLIN" })).toBe(true);
    expect(creatureMatchesFilters(gob, { family: "orc" })).toBe(false);
  });
  it("matches rarity exactly", () => {
    expect(creatureMatchesFilters(gob, { rarity: "common" })).toBe(true);
    expect(creatureMatchesFilters(gob, { rarity: "rare" })).toBe(false);
  });
  it("null/undefined means no constraint", () => {
    expect(creatureMatchesFilters(gob, {})).toBe(true);
    expect(creatureMatchesFilters(gob, { family: null, rarity: null })).toBe(
      true,
    );
    expect(creatureMatchesFilters({ traits: undefined }, { family: "x" })).toBe(
      false,
    );
  });
});
