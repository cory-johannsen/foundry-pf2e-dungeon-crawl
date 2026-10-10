import { describe, it, expect } from "vitest";
import {
  extractHabitatText, habitatEnvironments, traitHints, candidateFor, mergeCandidates,
} from "../tools/creature-environment-patterns.mjs";

describe("habitatEnvironments", () => {
  it("reads a Habitat: label", () => {
    expect(habitatEnvironments("Habitat: swamps and marshes")).toEqual(["swamp"]);
  });
  it("reads 'live in' clauses in vocabulary order", () => {
    expect(habitatEnvironments("Goblins live in caves and ruined temples")).toEqual(["cave", "underground-ruin"]);
  });
  it("orders by vocabulary, not text order", () => {
    expect(habitatEnvironments("found in forests near towns")).toEqual(["forest", "urban"]);
    expect(habitatEnvironments("found in towns near forests")).toEqual(["forest", "urban"]);
  });
  it("returns [] without a habitat sentence", () => {
    expect(habitatEnvironments("A fearsome beast that hunts at night.")).toEqual([]);
    expect(habitatEnvironments("")).toEqual([]);
    expect(habitatEnvironments(undefined)).toEqual([]);
  });
});

describe("extractHabitatText", () => {
  it("strips HTML and collapses whitespace", () => {
    const doc = { system: { details: { publicNotes: "<p>Found   in <em>forests</em>.</p>\n<p>Rare.</p>" } } };
    expect(extractHabitatText(doc)).toBe("Found in forests. Rare.");
    expect(habitatEnvironments(extractHabitatText(doc))).toEqual(["forest"]);
  });
  it("tolerates missing fields", () => {
    expect(extractHabitatText({})).toBe("");
    expect(extractHabitatText(null)).toBe("");
  });
});

describe("traitHints", () => {
  it("maps traits", () => {
    expect(traitHints(["aquatic"])).toEqual(["underwater"]);
    expect(traitHints(["fire"])).toEqual(["desert"]);
    expect(traitHints(["fiend"])).toEqual(["planar"]);
    expect(traitHints(["undead"])).toEqual(["any"]);
    expect(traitHints(["humanoid"])).toEqual([]);
    expect(traitHints(undefined)).toEqual([]);
  });
});

describe("candidateFor", () => {
  const doc = (notes, traits) => ({ system: { details: { publicNotes: notes }, traits: { value: traits } } });
  it("prose wins over traits", () => {
    expect(candidateFor(doc("Habitat: caves", ["aquatic"]))).toEqual({ environments: ["cave"], basis: "prose" });
  });
  it("undead with prose uses prose", () => {
    expect(candidateFor(doc("found in crypts", ["undead"]))).toEqual({ environments: ["underground-ruin"], basis: "prose" });
  });
  it("undead without prose is any via traits", () => {
    expect(candidateFor(doc("", ["undead"]))).toEqual({ environments: ["any"], basis: "traits" });
  });
  it("traits only", () => {
    expect(candidateFor(doc("", ["aquatic"]))).toEqual({ environments: ["underwater"], basis: "traits" });
  });
  it("none", () => {
    expect(candidateFor(doc("", ["humanoid"]))).toEqual({ environments: [], basis: "none" });
  });
});

describe("mergeCandidates", () => {
  it("adds new ids, skips empty, never overwrites", () => {
    const existing = { version: 1, creatures: { a: ["cave"] } };
    const sources = { version: 1, sources: { a: "manual" } };
    const cands = { a: ["forest"], b: ["swamp"], c: [] };
    const r = mergeCandidates(existing, sources, cands);
    expect(r.map.creatures).toEqual({ a: ["cave"], b: ["swamp"] });
    expect(r.sources.sources).toEqual({ a: "manual", b: "audit" });
    expect(r.added).toBe(1);
  });
  it("is idempotent and sorts keys", () => {
    const r1 = mergeCandidates({ version: 1, creatures: {} }, { version: 1, sources: {} }, { z: ["cave"], a: ["forest"] });
    expect(Object.keys(r1.map.creatures)).toEqual(["a", "z"]);
    const r2 = mergeCandidates(r1.map, r1.sources, { z: ["cave"], a: ["forest"] });
    expect(r2.added).toBe(0);
    expect(r2.map).toEqual(r1.map);
    expect(r2.sources).toEqual(r1.sources);
  });
  it("does not mutate inputs", () => {
    const existing = { version: 1, creatures: {} };
    mergeCandidates(existing, { version: 1, sources: {} }, { a: ["cave"] });
    expect(existing.creatures).toEqual({});
  });
});

describe("matchArtToDocs", () => {
  it("splits art entries into matched docs and missing entries", async () => {
    const { matchArtToDocs } = await import("../tools/creature-environment-patterns.mjs");
    const docsById = new Map([["d1", { _id: "d1" }]]);
    const r = matchArtToDocs([{ id: "a", docId: "d1" }, { id: "b", docId: "zz" }], docsById);
    expect(r.matched).toEqual([{ entry: { id: "a", docId: "d1" }, doc: { _id: "d1" } }]);
    expect(r.missing).toEqual([{ id: "b", docId: "zz" }]);
  });
  it("tolerates empty input", async () => {
    const { matchArtToDocs } = await import("../tools/creature-environment-patterns.mjs");
    expect(matchArtToDocs(undefined, new Map())).toEqual({ matched: [], missing: [] });
  });
});

describe("keyword tuning (audit samples)", () => {
  it("does not read 'plain sight' as plains", () => {
    expect(habitatEnvironments("Wererats dwell in metropolitan areas where they can hide in plain sight")).toEqual([]);
    expect(habitatEnvironments("found in warm grasslands and savannas")).toEqual(["plains"]);
  });
  it("does not read 'sandy' or 'temples' as habitats", () => {
    expect(habitatEnvironments("live among sandy river shoals")).toEqual(["underwater"]);
    expect(habitatEnvironments("dwell in jungles, where they build webs as big as temples")).toEqual(["forest"]);
  });
  it("recognises rainforests, Darklands, mountainous, sewers, graveyards", () => {
    expect(habitatEnvironments("found in rainforests")).toEqual(["forest"]);
    expect(habitatEnvironments("dwell in the tunnels of the Darklands")).toEqual(["cave"]);
    expect(habitatEnvironments("dwell in mountainous regions")).toEqual(["mountain"]);
    expect(habitatEnvironments("live in sewers")).toEqual(["urban"]);
    expect(habitatEnvironments("found in abandoned graveyards")).toEqual(["underground-ruin"]);
  });
  it("a planar habitat is planar only", () => {
    expect(habitatEnvironments("live in the immense seven-tiered mountain of Heaven")).toEqual(["planar"]);
    expect(habitatEnvironments("dwell in Hell's myriad waterways, lakes, and oceans")).toEqual(["planar"]);
    expect(habitatEnvironments("live in the perfect city of Axis")).toEqual(["planar"]);
    expect(habitatEnvironments("dwell in the vast and endless Abyssal swamps")).toEqual(["planar"]);
  });
  it("the Material Plane is not planar", () => {
    expect(habitatEnvironments("found in forests throughout the Material Plane")).toEqual(["forest"]);
  });
});

describe("trait hint tuning", () => {
  it("drops element hints for multi-element creatures", () => {
    expect(traitHints(["air", "earth", "elemental", "fire", "genie", "water"])).toEqual([]);
    expect(traitHints(["air", "beast", "fire", "water"])).toEqual([]);
  });
  it("outsider traits make the hint planar only", () => {
    expect(traitHints(["beast", "fiend", "fire", "unholy"])).toEqual(["planar"]);
    expect(traitHints(["amphibious", "demon", "fiend", "fungus"])).toEqual(["planar"]);
  });
  it("single element still hints", () => {
    expect(traitHints(["elemental", "fire"])).toEqual(["desert"]);
  });
});
