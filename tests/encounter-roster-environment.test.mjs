import { describe, it, expect } from "vitest";
import { resolveEncounterRoster } from "../scripts/encounter-roster.mjs";
import { buildEnvironmentLookup } from "../scripts/environments.mjs";

const PACK = "pf2e.pathfinder-monster-core";
const mk = (id, extra = {}) => ({ pack: PACK, id, name: id, level: 3, traits: [], rarity: "common", ...extra });

function stub(pool) {
  const calls = [];
  return {
    calls,
    async findCreatures(q) {
      calls.push(q);
      return pool.filter((c) => {
        const t = c.traits ?? [];
        if (q.packs && !q.packs.includes(c.pack)) return false;
        if ((q.excludePacks ?? []).includes(c.pack)) return false;
        if (c.level < q.minLevel || c.level > q.maxLevel) return false;
        if ((q.traits ?? []).length && !q.traits.some((x) => t.includes(x))) return false;
        if (q.requireTrait && !t.includes(q.requireTrait)) return false;
        return true;
      });
    },
  };
}
const lookupOf = (map, pool) =>
  buildEnvironmentLookup(
    pool.map((c) => ({ id: c.id, pack: c.pack, docId: c.id })),
    { creatures: map },
  );
const slots = (n, extra = {}) => ({
  foes: Array.from({ length: n }, (_, i) => ({ id: `s${i}`, kind: "creature", levelOffset: 0, countsAs: 1, ...extra })),
});
const counting = (v = 0) => {
  const f = () => (f.n++, v);
  f.n = 0;
  return f;
};
const run = (opts) => resolveEncounterRoster({ partyLevel: 3, rng: () => 0, ...opts });

describe("environment selection", () => {
  it("strict hit: chosen, no note", async () => {
    const pool = [mk("wolf"), mk("ghoul")];
    const r = await run({ resolved: slots(1), api: stub(pool), environment: "forest", environmentLookup: lookupOf({ ghoul: ["forest"], wolf: ["desert"] }, pool) });
    expect(r.foes[0].id).toBe("ghoul");
    expect(r.warnings).toEqual([]);
    expect(r.appliedFilters).toContain("environment");
  });

  it("adjacent hit yields adjacent note", async () => {
    const pool = [mk("wolf"), mk("croc")];
    const r = await run({ resolved: slots(1), api: stub(pool), environment: "swamp", environmentLookup: lookupOf({ croc: ["forest"], wolf: ["desert"] }, pool) });
    expect(r.foes[0].id).toBe("croc");
    expect(r.warnings).toEqual(["Environment: 1 of 1 creatures from adjacent environments."]);
  });

  it("both empty -> dropped with dropped note; unmapped returned only then", async () => {
    const pool = [mk("wolf"), mk("blob")];
    const r = await run({ resolved: slots(1), api: stub(pool), environment: "arctic", environmentLookup: lookupOf({ wolf: ["desert"] }, pool) });
    expect(r.foes).toHaveLength(1);
    expect(r.warnings).toEqual(["Environment: 1 of 1 creatures outside the chosen environment (no fitting creatures at this level)."]);
  });

  it("unmapped excluded when a mapped creature exists", async () => {
    const pool = [mk("blob"), mk("ghoul")];
    const r = await run({ resolved: slots(1), api: stub(pool), environment: "forest", environmentLookup: lookupOf({ ghoul: ["forest"] }, pool) });
    expect(r.foes[0].id).toBe("ghoul");
  });

  it("any-mapped creature matches every environment (strict)", async () => {
    const pool = [mk("anyone")];
    const r = await run({ resolved: slots(1), api: stub(pool), environment: "planar", environmentLookup: lookupOf({ anyone: ["any"] }, pool) });
    expect(r.foes[0].id).toBe("anyone");
    expect(r.warnings).toEqual([]);
  });

  it("trait theme survives; environment dropped first (no requireTrait)", async () => {
    // zombie: traited, outside the environment; wolf: untraited, inside it.
    const pool = [mk("zombie", { traits: ["undead"] }), mk("wolf")];
    const r = await run({
      resolved: slots(1), api: stub(pool), traits: ["undead"],
      environment: "forest", environmentLookup: lookupOf({ zombie: ["desert"], wolf: ["forest"] }, pool),
    });
    expect(r.foes[0].id).toBe("zombie");
    expect(r.warnings).toEqual(["Environment: 1 of 1 creatures outside the chosen environment (no fitting creatures at this level)."]);
  });

  it("boss: trait theme survives; environment dropped first", async () => {
    const pool = [mk("zombie", { traits: ["undead"] }), mk("wolf")];
    const r = await run({
      resolved: slots(1), api: stub(pool), traits: ["undead"], isBoss: true,
      environment: "forest", environmentLookup: lookupOf({ zombie: ["desert"], wolf: ["forest"] }, pool),
    });
    expect(r.foes[0].id).toBe("zombie");
    expect(r.warnings).toEqual(["Environment: 1 of 1 creatures outside the chosen environment (no fitting creatures at this level)."]);
  });

  it("trait-less steps run only after every traited step failed, keeping requireTrait", async () => {
    // Nothing undead in range: fall back to the untraited, environment-fitting wolf.
    const pool = [mk("wolf"), mk("bear")];
    const api = stub(pool);
    const r = await run({
      resolved: slots(1), api, traits: ["undead"],
      environment: "forest", environmentLookup: lookupOf({ wolf: ["forest"], bear: ["desert"] }, pool),
    });
    expect(r.foes[0].id).toBe("wolf");
    expect(r.warnings).toEqual([]);
    const firstNoTrait = api.calls.findIndex((q) => q.traits.length === 0);
    expect(firstNoTrait).toBeGreaterThan(0);
    expect(api.calls.slice(0, firstNoTrait).every((q) => q.traits[0] === "undead")).toBe(true);
    expect(api.calls.slice(firstNoTrait).every((q) => q.traits.length === 0)).toBe(true);
  });

  it("requireTrait kept on every call", async () => {
    const pool = [mk("zombie", { traits: ["undead"] }), mk("wolf")];
    const api = stub(pool);
    await run({
      resolved: slots(1), api, traits: ["undead"], requireTrait: "undead",
      environment: "forest", environmentLookup: lookupOf({ zombie: ["desert"] }, pool),
    });
    expect(api.calls.every((q) => q.requireTrait === "undead")).toBe(true);
  });

  it("per pack step: an adjacent Monster Core creature beats a strict creature from a later pack", async () => {
    const pool = [mk("croc"), mk("frog", { pack: "pf2e.pathfinder-bestiary" })];
    const r = await run({
      resolved: slots(1), api: stub(pool), environment: "swamp",
      environmentLookup: lookupOf({ croc: ["forest"], frog: ["swamp"] }, pool),
    });
    expect(r.foes[0].id).toBe("croc");
  });

  it("boss path runs boss steps inside each pass", async () => {
    const pool = [mk("boss")];
    const api = stub(pool);
    const r = await run({ resolved: slots(1), api, isBoss: true, environment: "forest", environmentLookup: lookupOf({ boss: ["forest"] }, pool) });
    expect(r.foes[0].id).toBe("boss");
    expect(api.calls[0].excludePacks.length).toBeGreaterThan(0);
  });

  it("cap-aware (upwardTolerance 0) pick carries the environment", async () => {
    const pool = [mk("blob"), mk("ghoul")];
    const r = await run({ resolved: slots(1), api: stub(pool), partySize: 4, environment: "forest", environmentLookup: lookupOf({ ghoul: ["forest"] }, pool) });
    expect(r.foes[0].id).toBe("ghoul");
  });

  it("group and twins carry the environment", async () => {
    const pool = [mk("blob"), mk("ghoul")];
    const lk = lookupOf({ ghoul: ["forest"] }, pool);
    const g = await run({ resolved: { foes: [{ id: "a", kind: "creature", levelOffset: 0, group: "g" }, { id: "b", kind: "creature", levelOffset: 0, group: "g" }] }, api: stub(pool), environment: "forest", environmentLookup: lk });
    expect(g.foes.map((f) => f.id)).toEqual(["ghoul", "ghoul"]);
    const t = await run({ resolved: { foes: [], twins: [{ levelOffset: 0 }, { levelOffset: 0 }] }, api: stub(pool), environment: "forest", environmentLookup: lk });
    expect(t.twins.map((f) => f.id)).toEqual(["ghoul", "ghoul"]);
  });

  it("roster-level: 4 foes, 2 adjacent -> exactly one note; all strict -> none", async () => {
    const pool = [mk("s1"), mk("f1")];
    const lk = lookupOf({ s1: ["swamp"], f1: ["forest"] }, pool);
    const allStrict = await run({ resolved: slots(4), api: stub(pool), environment: "swamp", environmentLookup: lk });
    expect(allStrict.warnings).toEqual([]);
    // After two picks the strict creature "runs out" (stateful stub).
    const base = stub(pool);
    let picks = 0;
    const api = {
      calls: base.calls,
      async findCreatures(q) {
        const res = await base.findCreatures(q);
        if (res.length && res.some((c) => c.id === "s1")) picks += 1;
        return picks > 2 ? res.filter((c) => c.id !== "s1") : res;
      },
    };
    const r = await run({ resolved: slots(4), api, environment: "swamp", environmentLookup: lk });
    expect(r.foes.map((f) => f.id)).toEqual(["s1", "s1", "f1", "f1"]);
    expect(r.warnings).toEqual(["Environment: 2 of 4 creatures from adjacent environments."]);
    expect(r.warnings.filter((w) => w.startsWith("Environment")).length).toBe(1);
  });
});

describe("environment off = golden", () => {
  it("environment set but environmentLookup null = None behavior", async () => {
    const pool = [mk("zombie", { traits: ["undead"] }), mk("wolf")];
    const a1 = stub(pool), a2 = stub(pool);
    const r1 = counting(), r2 = counting();
    const base = { resolved: slots(2), traits: ["undead"], partyLevel: 3 };
    const x = await resolveEncounterRoster({ ...base, api: a1, rng: r1 });
    const y = await resolveEncounterRoster({ ...base, api: a2, rng: r2, environment: "forest", environmentLookup: null });
    expect(a2.calls).toEqual(a1.calls);
    expect(r2.n).toBe(r1.n);
    expect(y).toEqual(x);
    expect(y.appliedFilters).not.toContain("environment");
    expect(y.foes[0]).not.toHaveProperty("environmentMatch");
  });

  const pool = [mk("zombie", { traits: ["undead"] }), mk("wolf")];
  const base = { resolved: slots(2), traits: ["undead"], requireTrait: "undead" };
  for (const env of [null, "bogus"]) {
    it(`environment ${JSON.stringify(env)} equals no params`, async () => {
      const a1 = stub(pool), a2 = stub(pool);
      const r1 = counting(), r2 = counting();
      const x = await resolveEncounterRoster({ ...base, partyLevel: 3, api: a1, rng: r1 });
      const y = await resolveEncounterRoster({ ...base, partyLevel: 3, api: a2, rng: r2, environment: env, environmentLookup: lookupOf({}, pool) });
      expect(a2.calls).toEqual(a1.calls);
      expect(r2.n).toBe(r1.n);
      expect(y).toEqual(x);
      expect(y.foes[0]).not.toHaveProperty("environmentMatch");
    });
  }
});

describe("environment note localization", () => {
  it("uses game.i18n.format with PF2EDC.Environment.* keys when available", async () => {
    const fmt = (k, d) => `${k}|${d.n}/${d.total}`;
    globalThis.game = { i18n: { format: fmt } };
    try {
      const pool = [mk("wolf"), mk("croc")];
      const lk = lookupOf({ croc: ["forest"], wolf: ["desert"] }, pool);
      const a = await run({ resolved: slots(1), api: stub(pool), environment: "swamp", environmentLookup: lk });
      expect(a.warnings).toEqual(["PF2EDC.Environment.NoteAdjacent|1/1"]);
      const b = await run({ resolved: slots(1), api: stub(pool), environment: "arctic", environmentLookup: lk });
      expect(b.warnings).toEqual(["PF2EDC.Environment.NoteOutside|1/1"]);
    } finally {
      delete globalThis.game;
    }
  });
});
