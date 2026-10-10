// tests/npc-strike-shapes-coverage.test.mjs
import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import { parseStrikePlusAbility } from "../scripts/npc-strike-shapes.mjs";

// #933: the spec's data-driven coverage audit. The fixture is every active
// (1-3 action) NPC action in Monster Core 1-2 and Bestiary 1-3 that names a
// Strike together with a grab / reach / multi-target / same-target /
// ranged-net cue, plus every Constrict, Greater Constrict and Rend glossary
// action -- read from the PF2e system's own source data. Each entry's
// `expected` shape (null = not offered) snapshots this parser's
// classification, so a grammar or compendium change is an explicit diff and
// #978/#979 can measure their added coverage against it.
const { entries } = JSON.parse(
  readFileSync(new URL("./fixtures/npc-strike-ability-slice.json", import.meta.url), "utf8"),
);

const classify = (entry) => parseStrikePlusAbility(entry.item)?.shape ?? null;

describe("npc strike-plus parser coverage (#933)", () => {
  it("covers the whole 208-ability slice", () => {
    expect(entries).toHaveLength(208);
  });

  it("classifies the slice per shape", () => {
    const counts = {};
    for (const entry of entries) {
      const key = classify(entry) ?? "none";
      counts[key] = (counts[key] ?? 0) + 1;
    }
    expect(counts).toEqual({
      constrictLike: 74,
      rend: 27,
      singleRollMultiAC: 8,
      strikeAgainstGrabbed: 7,
      extendedReachStrike: 7,
      strikeWithOnHit: 4,
      twoTargetStrikes: 3,
      bundleWithBothHitRider: 1,
      none: 77,
    });
  });

  it("recognizes the issue's named abilities", () => {
    const shapeOf = (actor, name) => classify(entries.find((e) => e.actor === actor && e.name === name));
    expect(shapeOf("Crocodile", "Death Roll")).toBe("strikeAgainstGrabbed");
    expect(shapeOf("Tiger", "Wrestle")).toBe("strikeAgainstGrabbed");
    expect(shapeOf("Owlbear", "Gnaw")).toBe("strikeAgainstGrabbed");
    expect(shapeOf("Globster", "Constrict")).toBe("constrictLike");
    expect(shapeOf("Troll", "Rend")).toBe("rend");
    expect(shapeOf("Frost Giant", "Wide Swing")).toBe("singleRollMultiAC");
    expect(shapeOf("Megaprimatus", "Mangling Rend")).toBe("bundleWithBothHitRider");
    expect(shapeOf("Tripkee Scout", "Hurl Net")).toBe("strikeWithOnHit");
  });

  it("matches every entry's snapshot classification", () => {
    const mismatches = entries
      .filter((entry) => classify(entry) !== entry.expected)
      .map((entry) => `${entry.actor}: ${entry.name} (${entry.expected} -> ${classify(entry)})`);
    expect(mismatches).toEqual([]);
  });
});
