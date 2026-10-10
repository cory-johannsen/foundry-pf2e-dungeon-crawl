import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import { parseFeatRequirements, parseMarkedTargetRequirement } from "../scripts/marked-target-requirements.mjs";

// #946: real item descriptions (compiled pf2e 8.5.0 compendium text).
const POPULATION = JSON.parse(
  readFileSync(new URL("./fixtures/marked-target-population.json", import.meta.url), "utf8"),
).entries;
const descriptionOf = (slug) => {
  const entry = POPULATION.find((e) => e.slug === slug);
  if (!entry) throw new Error(`fixture has no ${slug}`);
  return entry.description;
};

describe("parseFeatRequirements (#946)", () => {
  it("no Requirements block -> []", () => {
    expect(parseFeatRequirements(descriptionOf("smite"))).toEqual([]);
    expect(parseFeatRequirements("")).toEqual([]);
  });

  it("Spell Parry: 'You have one or more hands free' -> handFree", () => {
    expect(parseFeatRequirements(descriptionOf("spell-parry"))).toEqual([{ type: "handFree" }]);
  });

  it("Point Blank Stance: 'You are wielding a ranged weapon' -> wieldingRanged", () => {
    expect(parseFeatRequirements(descriptionOf("point-blank-stance"))).toEqual([{ type: "wieldingRanged" }]);
  });

  it("a clause outside the closed set nulls the whole list (Monastic Archer Stance's 'unarmored', Hungry Blade, Enforce Oath, Nothing Personal, Harvest Blood)", () => {
    for (const slug of ["monastic-archer-stance", "hungry-blade", "enforce-oath", "nothing-personal", "harvest-blood"]) {
      expect(parseFeatRequirements(descriptionOf(slug)), slug).toBeNull();
    }
  });

  it("#934's own clause grammar still applies (a named weapon, a condition)", () => {
    expect(parseFeatRequirements("<p><strong>Requirements</strong> You are wielding a longbow.</p><hr /><p>x</p>")).toEqual([
      { type: "wielding", name: "longbow" },
    ]);
    expect(parseFeatRequirements("<p><strong>Requirements</strong> You are hidden.</p><p>x</p>")).toEqual([
      { type: "hasCondition", slug: "hidden" },
    ]);
  });
});

describe("parseMarkedTargetRequirement (#946)", () => {
  it("Smite: an enemy you can see; a new Smite ends the current one", () => {
    expect(parseMarkedTargetRequirement(descriptionOf("smite"))).toEqual({
      requirements: [], needsSight: true, needsHearing: false, rangeFeet: null, targetNotMindless: false, reDesignates: true,
    });
  });

  it("Duelist's Challenge: an enemy you can see; no re-designation clause", () => {
    expect(parseMarkedTargetRequirement(descriptionOf("duelists-challenge"))).toEqual({
      requirements: [], needsSight: true, needsHearing: false, rangeFeet: null, targetNotMindless: false, reDesignates: false,
    });
  });

  it("Size Up: see AND hear, non-mindless, the prior focus loses the designation", () => {
    expect(parseMarkedTargetRequirement(descriptionOf("size-up"))).toEqual({
      requirements: [], needsSight: true, needsHearing: true, rangeFeet: null, targetNotMindless: true, reDesignates: true,
    });
  });

  it("Hunt Prey: see OR hear is enough (detected, not seen)", () => {
    expect(parseMarkedTargetRequirement(descriptionOf("hunt-prey"))).toMatchObject({ needsSight: false, reDesignates: true });
  });

  it("reads 'within N feet' (Unfazed Assessment's 30 ft, aware of)", () => {
    expect(parseMarkedTargetRequirement(descriptionOf("unfazed-assessment"))).toMatchObject({ needsSight: false, rangeFeet: 30 });
  });

  it("null for untracked target state: sworn oath, Treerazer's agent, per-target immunity, planned course of action, previous/last action", () => {
    for (const slug of ["enforce-oath", "hunt-the-razers-pawn", "whispers-of-weakness", "nothing-personal", "hungry-blade", "harvest-blood"]) {
      expect(parseMarkedTargetRequirement(descriptionOf(slug)), slug).toBeNull();
    }
  });

  it("null when the text never says how the creature is perceived or how far it may be", () => {
    expect(parseMarkedTargetRequirement("<p>Designate a creature.</p>")).toBeNull();
    expect(parseMarkedTargetRequirement("")).toBeNull();
  });
});
