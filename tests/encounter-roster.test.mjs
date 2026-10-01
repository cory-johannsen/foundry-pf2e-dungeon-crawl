import { describe, it, expect } from "vitest";
import {
  resolveEncounterRoster,
  xpFor,
  xpBudget,
  xpCeilingTierForDepth,
} from "../scripts/encounter-roster.mjs";

function makeStubApi(pool) {
  const calls = [];
  return {
    calls,
    async findCreatures(opts) {
      calls.push(opts);
      return pool.filter((c) => {
        const traits = c.traits ?? [];
        if (opts.packs && !opts.packs.includes(c.pack)) return false;
        if ((opts.excludePacks ?? []).includes(c.pack)) return false;
        if (opts.minLevel != null && c.level < opts.minLevel) return false;
        if (opts.maxLevel != null && c.level > opts.maxLevel) return false;
        if ((opts.excludeTraits ?? []).some((t) => traits.includes(t)))
          return false;
        if (
          (opts.traits ?? []).length &&
          !opts.traits.some((t) => traits.includes(t))
        )
          return false;
        if (opts.requireTrait && !traits.includes(opts.requireTrait))
          return false;
        return true;
      });
    },
  };
}

const seq = (values) => {
  let i = 0;
  return () => values[Math.min(i++, values.length - 1)];
};

describe("resolveEncounterRoster", () => {
  it("queries at partyLevel + levelOffset, with tolerance", async () => {
    const api = makeStubApi([
      { pack: "p", id: "goblin", name: "Goblin", level: 3, traits: [] },
    ]);
    const resolved = {
      foes: [{ id: "s1", kind: "creature", levelOffset: -2 }],
    };
    const roster = await resolveEncounterRoster({
      resolved,
      api,
      partyLevel: 5,
      rng: () => 0,
    });
    expect(roster.foes).toHaveLength(1);
    expect(roster.foes[0].name).toBe("Goblin");
    expect(api.calls[0].minLevel).toBe(2);
    expect(api.calls[0].maxLevel).toBe(4);
  });

  it("always excludes troop and swarm, even when the caller did not ask", async () => {
    const api = makeStubApi([
      { pack: "p", id: "x", name: "X", level: 5, traits: [] },
    ]);
    const resolved = { foes: [{ id: "s1", kind: "creature", levelOffset: 0 }] };
    await resolveEncounterRoster({
      resolved,
      api,
      partyLevel: 5,
      excludeTraits: [],
      rng: () => 0,
    });
    expect(api.calls[0].excludeTraits).toEqual(
      expect.arrayContaining(["troop", "swarm"]),
    );
  });

  it("resolves a group to the same creature repeated", async () => {
    const api = makeStubApi([
      { pack: "p", id: "g", name: "Goblin", level: 5, traits: [] },
    ]);
    const resolved = {
      foes: [
        { id: "s1", kind: "creature", levelOffset: 0, group: "pack" },
        { id: "s2", kind: "creature", levelOffset: 0, group: "pack" },
      ],
    };
    const roster = await resolveEncounterRoster({
      resolved,
      api,
      partyLevel: 5,
      rng: () => 0,
    });
    expect(roster.foes).toHaveLength(2);
    expect(roster.foes[0].id).toBe("g");
    expect(roster.foes[1].id).toBe("g");
    // One pick for the whole group, not one per slot: the ladder walks
    // Monster Core, then the general packs, then all packs (where "p" is
    // found) — 3 queries total, not 3 per slot.
    expect(api.calls).toHaveLength(3);
  });

  it("expands countsAs into a higher count on a single foe entry", async () => {
    const api = makeStubApi([
      { pack: "p", id: "rat", name: "Giant Rat", level: 5, traits: [] },
    ]);
    const resolved = {
      foes: [{ id: "s1", kind: "creature", levelOffset: 0, countsAs: 4 }],
    };
    const roster = await resolveEncounterRoster({
      resolved,
      api,
      partyLevel: 5,
      rng: () => 0,
    });
    expect(roster.foes[0].count).toBe(4);
  });

  it("warns instead of throwing when no creature matches a slot", async () => {
    const api = makeStubApi([]);
    const resolved = { foes: [{ id: "s1", kind: "creature", levelOffset: 0 }] };
    const roster = await resolveEncounterRoster({
      resolved,
      api,
      partyLevel: 5,
      rng: () => 0,
    });
    expect(roster.foes).toHaveLength(0);
    expect(roster.warnings).toHaveLength(1);
  });

  it("falls back to dropping the theme traits entirely when nothing matches them, even with no requireTrait", async () => {
    // "castle" is a setting, not a real creature trait — nothing will ever
    // carry it, so every slot used to come back empty even though the
    // bestiary has plenty of creatures at this level.
    const api = makeStubApi([
      { pack: "p", id: "g", name: "Goblin", level: 5, traits: ["humanoid"] },
    ]);
    const resolved = { foes: [{ id: "s1", kind: "creature", levelOffset: 0 }] };
    const roster = await resolveEncounterRoster({
      resolved,
      api,
      partyLevel: 5,
      traits: ["castle"],
      rng: () => 0,
    });
    expect(roster.foes).toHaveLength(1);
    expect(roster.foes[0].id).toBe("g");
    expect(roster.warnings).toHaveLength(0);
    expect(api.calls.at(-1).traits).toEqual([]);
  });

  it("resolves friend, lurker and twins into their own roster slots", async () => {
    const api = makeStubApi([
      { pack: "p", id: "ally", name: "Wandering Cleric", level: 4, traits: [] },
      { pack: "p", id: "sneak", name: "Ambusher", level: 5, traits: [] },
      { pack: "p", id: "twin", name: "Displacer Beast", level: 5, traits: [] },
    ]);
    const resolved = {
      foes: [],
      friend: { id: "friend", kind: "friend", levelOffset: -1 },
      lurker: { id: "lurker", kind: "lurker", levelOffset: 0 },
      twins: [
        { id: "twinA", kind: "twin", levelOffset: 0, twinPairId: "twinB" },
        { id: "twinB", kind: "twin", levelOffset: 0, twinPairId: "twinA" },
      ],
      noncombat: null,
      goal: null,
    };
    const roster = await resolveEncounterRoster({
      resolved,
      api,
      partyLevel: 5,
      rng: seq([0, 0, 0]),
    });
    expect(roster.friend).toBeTruthy();
    expect(roster.lurker).toBeTruthy();
    expect(roster.twins).toHaveLength(2);
    expect(roster.approxXp).toBeGreaterThan(0);
  });

  it("passes noncombat and goal through untouched", async () => {
    const api = makeStubApi([]);
    const resolved = { foes: [], noncombat: { id: "nc" }, goal: { id: "g" } };
    const roster = await resolveEncounterRoster({
      resolved,
      api,
      partyLevel: 5,
    });
    expect(roster.noncombat).toEqual({ id: "nc" });
    expect(roster.goal).toEqual({ id: "g" });
  });
});

describe("levelOffsetBias", () => {
  it("shifts the queried level band", async () => {
    const api = makeStubApi([
      { pack: "p", id: "x", name: "X", level: 8, traits: [] },
    ]);
    const resolved = { foes: [{ id: "s1", kind: "creature", levelOffset: 0 }] };
    await resolveEncounterRoster({
      resolved,
      api,
      partyLevel: 5,
      levelOffsetBias: 3,
      rng: () => 0,
    });
    expect(api.calls[0].minLevel).toBe(7);
    expect(api.calls[0].maxLevel).toBe(9);
  });

  it("raises the reported approximate severity", async () => {
    // Spans both the unbiased band ([4,6]) and the biased one ([6,8]) so
    // both calls actually find a creature — approxXp is a function of the
    // slot's levelOffset + bias, not of which creature happened to match.
    const api = makeStubApi([
      { pack: "p", id: "lo", name: "Lo", level: 5, traits: [] },
      { pack: "p", id: "hi", name: "Hi", level: 8, traits: [] },
    ]);
    const resolved = { foes: [{ id: "s1", kind: "creature", levelOffset: 0 }] };
    const withoutBias = await resolveEncounterRoster({
      resolved,
      api,
      partyLevel: 5,
      rng: () => 0,
    });
    const withBias = await resolveEncounterRoster({
      resolved,
      api,
      partyLevel: 5,
      levelOffsetBias: 2,
      rng: () => 0,
    });
    expect(withoutBias.foes).toHaveLength(1);
    expect(withBias.foes).toHaveLength(1);
    expect(withBias.approxXp).toBeGreaterThan(withoutBias.approxXp);
  });

  it("applies uniformly to friend, lurker and twins, not just regular foes", async () => {
    const api = makeStubApi([
      { pack: "p", id: "x", name: "X", level: 9, traits: [] },
    ]);
    const resolved = {
      foes: [],
      lurker: { id: "l", kind: "lurker", levelOffset: 0 },
    };
    await resolveEncounterRoster({
      resolved,
      api,
      partyLevel: 5,
      levelOffsetBias: 3,
      rng: () => 0,
    });
    expect(api.calls[0].minLevel).toBe(7);
  });
});

describe("requireTrait (per-location restriction)", () => {
  it("is passed through to findCreatures as an ANDed filter", async () => {
    const api = makeStubApi([
      { pack: "p", id: "g", name: "Ghoul", level: 5, traits: ["undead"] },
    ]);
    const resolved = { foes: [{ id: "s1", kind: "creature", levelOffset: 0 }] };
    await resolveEncounterRoster({
      resolved,
      api,
      partyLevel: 5,
      requireTrait: "undead",
      rng: () => 0,
    });
    expect(api.calls[0].requireTrait).toBe("undead");
  });

  it("warns instead of throwing when nothing carries the required trait", async () => {
    const api = makeStubApi([
      { pack: "p", id: "g", name: "Goblin", level: 5, traits: ["humanoid"] },
    ]);
    const resolved = { foes: [{ id: "s1", kind: "creature", levelOffset: 0 }] };
    const roster = await resolveEncounterRoster({
      resolved,
      api,
      partyLevel: 5,
      requireTrait: "undead",
      rng: () => 0,
    });
    expect(roster.foes).toHaveLength(0);
    expect(roster.warnings).toHaveLength(1);
  });

  it("drops the broader dungeon-wide traits before ever dropping the room's own required trait", async () => {
    // Satisfies requireTrait only — incompatible with the dungeon-wide theme.
    const api = makeStubApi([
      { pack: "p", id: "g", name: "Ghoul", level: 5, traits: ["undead"] },
    ]);
    const resolved = { foes: [{ id: "s1", kind: "creature", levelOffset: 0 }] };
    const roster = await resolveEncounterRoster({
      resolved,
      api,
      partyLevel: 5,
      traits: ["dragon"],
      requireTrait: "undead",
      rng: () => 0,
    });
    expect(roster.foes).toHaveLength(1);
    expect(roster.foes[0].id).toBe("g");
    // Three failed attempts (Monster-Core-first, then the general packs, then
    // all packs, each still requiring 'dragon') before the loosened final
    // attempt succeeds.
    expect(api.calls).toHaveLength(4);
    expect(api.calls.at(-1).traits).toEqual([]);
    expect(api.calls.at(-1).requireTrait).toBe("undead");
  });

  it("never loosens requireTrait itself, even as a last resort", async () => {
    const api = makeStubApi([
      { pack: "p", id: "g", name: "Goblin", level: 5, traits: ["humanoid"] },
    ]);
    const resolved = { foes: [{ id: "s1", kind: "creature", levelOffset: 0 }] };
    const roster = await resolveEncounterRoster({
      resolved,
      api,
      partyLevel: 5,
      traits: ["dragon"],
      requireTrait: "undead",
      rng: () => 0,
    });
    expect(roster.foes).toHaveLength(0);
    expect(roster.warnings).toHaveLength(1);
    expect(api.calls.every((c) => c.requireTrait === "undead")).toBe(true);
  });
});

describe("xpBudget", () => {
  it("matches GM Core's published 4-PC baseline for every tier", () => {
    expect(xpBudget("trivial", 4)).toBe(40);
    expect(xpBudget("low", 4)).toBe(60);
    expect(xpBudget("moderate", 4)).toBe(80);
    expect(xpBudget("severe", 4)).toBe(120);
    expect(xpBudget("extreme", 4)).toBe(160);
  });

  it("adjusts by the tier's own flat per-PC amount above/below 4", () => {
    expect(xpBudget("severe", 3)).toBe(90);
    expect(xpBudget("severe", 5)).toBe(150);
    expect(xpBudget("extreme", 1)).toBe(40);
  });
});

describe("resolveEncounterRoster — #144 severity cap", () => {
  it("does not cap anything when partySize is omitted (default behavior unchanged)", async () => {
    const api = makeStubApi([
      { pack: "p", id: "g", name: "Goblin", level: 5, traits: [] },
    ]);
    const resolved = {
      foes: [
        { id: "s1", kind: "creature", levelOffset: 0 },
        { id: "s2", kind: "creature", levelOffset: 0 },
        { id: "s3", kind: "creature", levelOffset: 0 },
        { id: "s4", kind: "creature", levelOffset: 0 },
      ],
    };
    const roster = await resolveEncounterRoster({
      resolved,
      api,
      partyLevel: 5,
      rng: () => 0,
    });
    expect(roster.foes).toHaveLength(4);
    expect(roster.approxXp).toBe(160);
    expect(roster.warnings).toHaveLength(0);
  });

  it("holds back plain creature slots once accepting one would exceed the Severe budget (#144)", async () => {
    // Four level-0 slots at 40 XP each (partyLevel + offset 0) would total
    // 160 XP — exactly the Extreme threshold for a 4-PC party — which is
    // the real-world bug report: an ordinary room-1 draw landing Extreme.
    // The Severe budget for 4 PCs is 120, so only the first three (120 XP,
    // right at the cap) should be admitted.
    const api = makeStubApi([
      { pack: "p", id: "g", name: "Goblin", level: 5, traits: [] },
    ]);
    const resolved = {
      foes: [
        { id: "s1", kind: "creature", levelOffset: 0 },
        { id: "s2", kind: "creature", levelOffset: 0 },
        { id: "s3", kind: "creature", levelOffset: 0 },
        { id: "s4", kind: "creature", levelOffset: 0 },
      ],
    };
    const roster = await resolveEncounterRoster({
      resolved,
      api,
      partyLevel: 5,
      rng: () => 0,
      partySize: 4,
    });
    expect(roster.foes).toHaveLength(3);
    expect(roster.approxXp).toBe(120);
    expect(roster.warnings).toHaveLength(1);
    expect(roster.warnings[0]).toMatch(/capped at Severe/);
  });

  it("never caps the very first slot to an empty roster, even if it alone exceeds Severe", async () => {
    const api = makeStubApi([
      { pack: "p", id: "ogre", name: "Ogre", level: 7, traits: [] },
    ]);
    // levelOffset 2 with countsAs 3 -> xpFor(2) * 3 = 240, already past the
    // 120 Severe budget for a 4-PC party on its own.
    const resolved = {
      foes: [{ id: "s1", kind: "creature", levelOffset: 2, countsAs: 3 }],
    };
    const roster = await resolveEncounterRoster({
      resolved,
      api,
      partyLevel: 5,
      rng: () => 0,
      partySize: 4,
    });
    expect(roster.foes).toHaveLength(1);
    expect(roster.approxXp).toBe(240);
    expect(roster.warnings).toHaveLength(0);
  });

  it("caps the Lurker card too once the foe track already used up the budget", async () => {
    const api = makeStubApi([
      { pack: "p", id: "g", name: "Goblin", level: 5, traits: [] },
      { pack: "p", id: "sneak", name: "Ambusher", level: 5, traits: [] },
    ]);
    const resolved = {
      foes: [
        { id: "s1", kind: "creature", levelOffset: 0 },
        { id: "s2", kind: "creature", levelOffset: 0 },
        { id: "s3", kind: "creature", levelOffset: 0 },
      ],
      lurker: { id: "lurker", kind: "lurker", levelOffset: 0 },
    };
    const roster = await resolveEncounterRoster({
      resolved,
      api,
      partyLevel: 5,
      rng: () => 0,
      partySize: 4,
    });
    expect(roster.foes).toHaveLength(3);
    expect(roster.approxXp).toBe(120);
    expect(roster.lurker).toBeNull();
    expect(roster.warnings[0]).toMatch(/capped at Severe/);
  });

  it("scales the cap with partySize, admitting more at a larger table", async () => {
    const api = makeStubApi([
      { pack: "p", id: "g", name: "Goblin", level: 5, traits: [] },
    ]);
    const resolved = {
      foes: [
        { id: "s1", kind: "creature", levelOffset: 0 },
        { id: "s2", kind: "creature", levelOffset: 0 },
        { id: "s3", kind: "creature", levelOffset: 0 },
        { id: "s4", kind: "creature", levelOffset: 0 },
      ],
    };
    // Severe budget for 5 PCs is 150 -> all four 40-XP slots (160 total)
    // still get capped at three (120), since the fourth would push to 160.
    // A 6-PC party's budget is 180, which does admit all four.
    const partyOf5 = await resolveEncounterRoster({
      resolved,
      api,
      partyLevel: 5,
      rng: () => 0,
      partySize: 5,
    });
    const partyOf6 = await resolveEncounterRoster({
      resolved,
      api,
      partyLevel: 5,
      rng: () => 0,
      partySize: 6,
    });
    expect(partyOf5.foes).toHaveLength(3);
    expect(partyOf6.foes).toHaveLength(4);
  });
});

describe("boss room pool", () => {
  const CORE = "pf2e.pathfinder-monster-core";
  const BESTIARY = "pf2e.pathfinder-bestiary";
  const LOST = "pf2e.lost-omens-bestiary";
  const m = { pack: CORE, id: "m", name: "M", level: 5, traits: [] };
  const v = { pack: LOST, id: "v", name: "V", level: 5, traits: [] };
  const b = { pack: BESTIARY, id: "b", name: "B", level: 5, traits: [] };
  const one = { foes: [{ id: "s1", kind: "creature", levelOffset: 0 }] };
  const run = (pool, resolved, isBoss) =>
    resolveEncounterRoster({
      resolved,
      api: makeStubApi(pool),
      partyLevel: 5,
      rng: () => 0,
      isBoss,
    });

  it("draws a boss room's creature from the non-general packs", async () => {
    const roster = await run([m, v], one, true);
    expect(roster.foes[0].id).toBe("v");
  });

  it("falls back to the normal ladder when no boss-pool creature fits", async () => {
    const roster = await run([m], one, true);
    expect(roster.foes[0].id).toBe("m");
  });

  it("keeps ordinary rooms on general packs, boss pool as last resort", async () => {
    expect((await run([m, v], one, false)).foes[0].id).toBe("m");
    expect((await run([v], one, false)).foes[0].id).toBe("v");
  });

  it("prefers the general packs over the boss pool for ordinary rooms", async () => {
    const roster = await run([b, v], one, false);
    expect(roster.foes[0].id).toBe("b");
  });

  it("marks only the first foe slot as boss", async () => {
    const two = {
      foes: [
        { id: "s1", kind: "creature", levelOffset: 0 },
        { id: "s2", kind: "creature", levelOffset: 0 },
      ],
    };
    const roster = await run([m, v], two, true);
    expect(roster.foes[0].id).toBe("v");
    expect(roster.foes[1].id).toBe("m");
  });
});

describe("depth-scaled XP ceiling (#293)", () => {
  const goblinApi = () =>
    makeStubApi([{ pack: "p", id: "g", name: "Goblin", level: 5, traits: [] }]);
  const fourPlain = {
    foes: [1, 2, 3, 4, 5, 6].map((n) => ({
      id: `s${n}`,
      kind: "creature",
      levelOffset: 0,
    })),
  };
  const run = (extra) =>
    resolveEncounterRoster({
      resolved: fourPlain,
      api: goblinApi(),
      partyLevel: 5,
      rng: () => 0,
      ...extra,
    });

  it("maps depth bias to a ceiling tier", () => {
    expect(xpCeilingTierForDepth(0)).toBe("low");
    expect(xpCeilingTierForDepth(1)).toBe("moderate");
    expect(xpCeilingTierForDepth(2)).toBe("severe");
    expect(xpCeilingTierForDepth(3)).toBe("severe");
    expect(xpCeilingTierForDepth(null)).toBe("severe");
    expect(xpCeilingTierForDepth(undefined)).toBe("severe");
  });

  for (const partySize of [1, 3, 4, 5, 6]) {
    for (const [bias, tier] of [
      [0, "low"],
      [1, "moderate"],
      [2, "severe"],
    ]) {
      it(`bias ${bias} stays within ${tier} for a party of ${partySize}`, async () => {
        const roster = await run({ partySize, depthBias: bias });
        const budget = xpBudget(tier, partySize);
        // First slot is always accepted, so only assert the budget when it
        // could have admitted more than that one slot.
        if (budget >= 40) expect(roster.approxXp).toBeLessThanOrEqual(budget);
        else expect(roster.foes).toHaveLength(1);
        expect(roster.foes.length).toBeGreaterThanOrEqual(1);
      });
    }
  }

  it("bias 0 admits fewer slots than bias 2 for a party of 4", async () => {
    expect((await run({ partySize: 4, depthBias: 0 })).approxXp).toBe(40);
    expect((await run({ partySize: 4, depthBias: 1 })).approxXp).toBe(80);
    expect((await run({ partySize: 4, depthBias: 2 })).approxXp).toBe(120);
  });

  it("still always accepts the first slot even above the Low ceiling", async () => {
    const api = makeStubApi([
      { pack: "p", id: "ogre", name: "Ogre", level: 7, traits: [] },
    ]);
    const roster = await resolveEncounterRoster({
      resolved: {
        foes: [{ id: "s1", kind: "creature", levelOffset: 2, countsAs: 3 }],
      },
      api,
      partyLevel: 5,
      rng: () => 0,
      partySize: 4,
      depthBias: 0,
    });
    expect(roster.foes).toHaveLength(1);
    expect(roster.approxXp).toBe(240);
  });

  it("omitted depthBias keeps the Severe cap", async () => {
    const roster = await run({ partySize: 4 });
    expect(roster.approxXp).toBe(120);
    expect(roster.warnings[0]).toMatch(/capped at Severe/);
  });

  it("names the actual tier in the cap warning", async () => {
    const roster = await run({ partySize: 4, depthBias: 0 });
    expect(roster.warnings[0]).toMatch(/capped at Low/);
  });
});

describe("depth XP cap clamps real creature levels (#293 follow-up)", () => {
  // One creature at every level 0..10, so any clamp has something to land on.
  const ladderPool = () =>
    Array.from({ length: 11 }, (_, level) => ({
      pack: "p",
      id: `c${level}`,
      name: `C${level}`,
      level,
      traits: [],
    }));
  const slots = (offsets) =>
    offsets.map((levelOffset, i) => ({
      id: `s${i}`,
      kind: "creature",
      levelOffset,
    }));
  const realXp = (roster, partyLevel) =>
    roster.foes.reduce(
      (sum, f) => sum + xpFor(f.level - partyLevel) * f.count,
      0,
    ) +
    (roster.lurker ? xpFor(roster.lurker.level - partyLevel) : 0) +
    (roster.twins
      ? roster.twins.reduce((s, t) => s + xpFor(t.level - partyLevel), 0)
      : 0);

  it("first slot alone over the cap is clamped (5xL1, Moderate, +2 slot +1 bias)", async () => {
    const roster = await resolveEncounterRoster({
      resolved: { foes: slots([2]) },
      api: makeStubApi(ladderPool()),
      partyLevel: 1,
      rng: () => 0.99,
      levelOffsetBias: 1,
      partySize: 5,
      depthBias: 1,
    });
    expect(roster.foes).toHaveLength(1);
    expect(realXp(roster, 1)).toBeLessThanOrEqual(xpBudget("moderate", 5));
    expect(roster.approxXp).toBeLessThanOrEqual(xpBudget("moderate", 5));
  });

  it("does not let level tolerance pick a creature above the counted level", async () => {
    // Nominal +1 (60 XP) fits a 100 budget, but tolerance would allow +2.
    const roster = await resolveEncounterRoster({
      resolved: { foes: slots([1]) },
      api: makeStubApi(ladderPool()),
      partyLevel: 3,
      rng: () => 0.99,
      partySize: 5,
      depthBias: 1,
    });
    expect(roster.foes[0].level).toBeLessThanOrEqual(4);
    expect(realXp(roster, 3)).toBeLessThanOrEqual(roster.approxXp);
  });

  for (const partySize of [1, 4, 6]) {
    it(`Low at bias 0 stays under budget for a party of ${partySize}`, async () => {
      const roster = await resolveEncounterRoster({
        resolved: { foes: slots([0, 1, 0]) },
        api: makeStubApi(ladderPool()),
        partyLevel: 5,
        rng: () => 0.99,
        partySize,
        depthBias: 0,
      });
      expect(roster.foes.length).toBeGreaterThanOrEqual(1);
      expect(realXp(roster, 5)).toBeLessThanOrEqual(xpBudget("low", partySize));
    });
  }

  it("without partySize nothing is clamped (unchanged)", async () => {
    const roster = await resolveEncounterRoster({
      resolved: { foes: slots([2]) },
      api: makeStubApi(ladderPool()),
      partyLevel: 1,
      rng: () => 0.99,
      levelOffsetBias: 1,
    });
    expect(roster.foes[0].level).toBe(5); // +3 +1 tolerance
    expect(roster.approxXp).toBe(120);
  });

  it("property: real-level XP never exceeds the cap, roster never empty", async () => {
    let seed = 12345;
    const rand = () => {
      seed = (seed * 1664525 + 1013904223) % 4294967296;
      return seed / 4294967296;
    };
    for (let i = 0; i < 300; i += 1) {
      const partyLevel = 1 + Math.floor(rand() * 8);
      const partySize = 1 + Math.floor(rand() * 6);
      const depthBias = Math.floor(rand() * 3);
      const levelOffsetBias = Math.floor(rand() * 3);
      const n = 1 + Math.floor(rand() * 5);
      const offsets = Array.from(
        { length: n },
        () => Math.floor(rand() * 5) - 2,
      );
      const resolved = { foes: slots(offsets) };
      if (rand() < 0.3) resolved.lurker = { kind: "lurker", levelOffset: 1 };
      if (rand() < 0.2)
        resolved.twins = [
          { kind: "creature", levelOffset: 0 },
          { kind: "creature", levelOffset: 0 },
        ];
      const roster = await resolveEncounterRoster({
        resolved,
        api: makeStubApi(ladderPool()),
        partyLevel,
        rng: rand,
        levelOffsetBias,
        partySize,
        depthBias,
      });
      const cap = xpBudget(xpCeilingTierForDepth(depthBias), partySize);
      const total =
        roster.foes.length + (roster.lurker ? 1 : 0) + (roster.twins ? 1 : 0);
      expect(total).toBeGreaterThanOrEqual(1);
      if (total > 1)
        expect(realXp(roster, partyLevel)).toBeLessThanOrEqual(cap);
    }
  });
});
