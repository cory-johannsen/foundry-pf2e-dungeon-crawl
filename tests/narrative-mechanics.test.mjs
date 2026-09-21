import { describe, it, expect } from "vitest";
import { isValidNarrativeTemplate } from "../scripts/narrative-mechanics.mjs";

const base = {
  id: "the_example",
  kind: "narrative",
  name: "The Example",
  complete: true,
  summary: "An example narrative beat.",
};

describe("isValidNarrativeTemplate", () => {
  it("rejects a non-narrative-kind entry", () => {
    expect(isValidNarrativeTemplate({ ...base, kind: "puzzle", archetype: "lore", revealText: "x" })).toBe(false);
  });

  it("rejects an entry with no archetype at all", () => {
    expect(isValidNarrativeTemplate({ ...base })).toBe(false);
  });

  it("rejects an unknown archetype", () => {
    expect(isValidNarrativeTemplate({ ...base, archetype: "mystery-meat" })).toBe(false);
  });

  it("accepts a lore archetype with revealText", () => {
    expect(
      isValidNarrativeTemplate({ ...base, archetype: "lore", revealText: "The ruins predate the empire." }),
    ).toBe(true);
  });

  it("rejects a lore archetype missing revealText", () => {
    expect(isValidNarrativeTemplate({ ...base, archetype: "lore" })).toBe(false);
  });

  it("accepts an ally archetype with npcName and npcHook", () => {
    expect(
      isValidNarrativeTemplate({
        ...base,
        archetype: "ally",
        npcName: "Old Maren",
        npcHook: "Offers to trade information for safe passage later.",
      }),
    ).toBe(true);
  });

  it("rejects an ally archetype missing npcHook", () => {
    expect(isValidNarrativeTemplate({ ...base, archetype: "ally", npcName: "Old Maren" })).toBe(false);
  });

  it("accepts a choice archetype with exactly 2 options", () => {
    expect(
      isValidNarrativeTemplate({
        ...base,
        archetype: "choice",
        options: [
          { label: "Free the prisoner", consequence: "An ally, but a pursuer too." },
          { label: "Leave them", consequence: "No new ally, no new enemy." },
        ],
      }),
    ).toBe(true);
  });

  it("rejects a choice archetype with only 1 option", () => {
    expect(
      isValidNarrativeTemplate({
        ...base,
        archetype: "choice",
        options: [{ label: "Free the prisoner", consequence: "An ally, but a pursuer too." }],
      }),
    ).toBe(false);
  });

  it("rejects a choice archetype whose option is missing a consequence", () => {
    expect(
      isValidNarrativeTemplate({
        ...base,
        archetype: "choice",
        options: [
          { label: "Free the prisoner" },
          { label: "Leave them", consequence: "No new ally, no new enemy." },
        ],
      }),
    ).toBe(false);
  });

  it("accepts a goal archetype with suggestedObjective", () => {
    expect(
      isValidNarrativeTemplate({
        ...base,
        archetype: "goal",
        suggestedObjective: "Find the missing relic before the cultists do.",
      }),
    ).toBe(true);
  });

  it("rejects a goal archetype missing suggestedObjective", () => {
    expect(isValidNarrativeTemplate({ ...base, archetype: "goal" })).toBe(false);
  });
});
