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
