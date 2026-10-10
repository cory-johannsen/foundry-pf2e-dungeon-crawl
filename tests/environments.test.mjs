import { describe, it, expect } from "vitest";
import { ENVIRONMENTS, ADJACENCY, normalizeEnvironment, buildEnvironmentLookup, environmentsFor,
  creatureFitsEnvironment, widenEnvironments, pickRandomEnvironment } from "../scripts/environments.mjs";

describe("vocabulary", () => {
  it("adjacency lists are valid, non-self, for every environment", () => {
    for (const e of ENVIRONMENTS) {
      expect(ADJACENCY[e], e).toBeDefined();
      for (const a of ADJACENCY[e]) { expect(ENVIRONMENTS).toContain(a); expect(a).not.toBe(e); }
    }
    expect(Object.keys(ADJACENCY).sort()).toEqual([...ENVIRONMENTS].sort());
  });
  it("normalizeEnvironment", () => {
    expect(normalizeEnvironment("swamp")).toBe("swamp");
    for (const bad of ["", "none", "Swamp", "any", null, undefined, 3]) expect(normalizeEnvironment(bad)).toBeNull();
  });
});

const art = [
  { id: "a__gob", pack: "pf2e.x", docId: "D1" },
  { id: "a__frog", pack: "pf2e.x", docId: "D2" },
  { id: "a__zombie", pack: "pf2e.x", docId: "D3" },
  { id: "a__bad", pack: "pf2e.x", docId: "D4" },
];
const map = { version: 1, creatures: { a__gob: ["forest", "cave"], a__frog: ["swamp"], a__zombie: ["any"], a__bad: ["lava", "swamp"] } };
const lookup = buildEnvironmentLookup(art, map);

describe("lookup and fit", () => {
  it("keys by pack:docId, drops invalid ids", () => {
    expect(environmentsFor({ pack: "pf2e.x", id: "D1" }, lookup)).toEqual(["forest", "cave"]);
    expect(environmentsFor({ pack: "pf2e.x", id: "D4" }, lookup)).toEqual(["swamp"]);
    expect(environmentsFor({ pack: "pf2e.x", id: "ZZ" }, lookup)).toBeNull();
  });
  it("fits mapped, any; excludes unmapped", () => {
    expect(creatureFitsEnvironment({ pack: "pf2e.x", id: "D1" }, "cave", lookup)).toBe(true);
    expect(creatureFitsEnvironment({ pack: "pf2e.x", id: "D1" }, "swamp", lookup)).toBe(false);
    expect(creatureFitsEnvironment({ pack: "pf2e.x", id: "D3" }, "desert", lookup)).toBe(true);
    expect(creatureFitsEnvironment({ pack: "pf2e.x", id: "ZZ" }, "desert", lookup)).toBe(false);
  });
  it("tolerates a missing/malformed map", () => {
    expect(buildEnvironmentLookup(art, null).size).toBe(0);
    expect(buildEnvironmentLookup(art, { creatures: "x" }).size).toBe(0);
    expect(buildEnvironmentLookup(null, map).size).toBe(0);
  });
});

describe("widenEnvironments", () => {
  it("strict then adjacent", () => {
    expect(widenEnvironments("swamp")).toEqual([["swamp"], ["swamp", "forest", "underwater"]]);
    expect(widenEnvironments("planar")).toEqual([["planar"], ["planar"]]);
  });
});

describe("pickRandomEnvironment", () => {
  const big = buildEnvironmentLookup(
    [...Array(30).keys()].map((i) => ({ id: `c${i}`, pack: "p", docId: `d${i}` })),
    { creatures: Object.fromEntries([...Array(30).keys()].map((i) => [`c${i}`, [i < 27 ? "forest" : "desert"]])) },
  );
  it("deterministic per seed, only environments with creatures, weighted", () => {
    expect(pickRandomEnvironment("seed-1", big)).toBe(pickRandomEnvironment("seed-1", big));
    const picks = Array.from({ length: 400 }, (_, i) => pickRandomEnvironment(`s${i}`, big));
    expect(new Set(picks)).toEqual(new Set(["forest", "desert"]));
    expect(picks.filter((p) => p === "forest").length).toBeGreaterThan(picks.filter((p) => p === "desert").length * 3);
  });
  it("null when nothing is mapped", () => { expect(pickRandomEnvironment("s", new Map())).toBeNull(); });
});

describe("widenEnvironments inherited keys", () => {
  it("does not throw or use prototype members", () => {
    expect(widenEnvironments("constructor")).toEqual([["constructor"], ["constructor"]]);
    expect(widenEnvironments("toString")).toEqual([["toString"], ["toString"]]);
  });
});
