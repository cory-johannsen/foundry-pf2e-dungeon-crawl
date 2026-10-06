import { readFileSync } from "node:fs";
import { describe, it, expect, vi } from "vitest";

vi.mock("../scripts/ui/dungeon-app.mjs", () => ({
  skillLabel: (slug) => ({ thievery: "Thievery", diplomacy: "Diplomacy", stealth: "Stealth" })[slug] ?? slug,
}));

import { buildSkillChallengeChoices } from "../scripts/ui/skill-challenge-dialog.mjs";

const chars = [
  { id: "a1", name: "Amiri" },
  { id: "b2", name: "Seoni" },
];

describe("buildSkillChallengeChoices (#822)", () => {
  it("one option per specialty skill, labeled; characters as given", () => {
    const r = buildSkillChallengeChoices(["thievery", "diplomacy", "stealth"], chars);
    expect(r.skills).toEqual([
      { slug: "thievery", label: "Thievery" },
      { slug: "diplomacy", label: "Diplomacy" },
      { slug: "stealth", label: "Stealth" },
    ]);
    expect(r.characters).toEqual(chars);
  });

  it("null for missing/empty skills or no characters", () => {
    expect(buildSkillChallengeChoices([], chars)).toBeNull();
    expect(buildSkillChallengeChoices(undefined, chars)).toBeNull();
    expect(buildSkillChallengeChoices(["thievery"], [])).toBeNull();
  });
});

describe("skill-challenge-dialog source", () => {
  const src = readFileSync(new URL("../scripts/ui/skill-challenge-dialog.mjs", import.meta.url), "utf8");
  it("uses DialogV2 and the localized keys", () => {
    expect(src).toContain("DialogV2");
    for (const k of ["Title", "CharacterLabel", "SkillLabel", "Confirm", "Cancel"])
      expect(src).toContain(`PF2EDC.Dungeon.SkillChallenge.Dialog${k}`);
  });
});

describe("skill-challenge dialog lang keys", () => {
  const lang = JSON.parse(readFileSync(new URL("../lang/en.json", import.meta.url), "utf8"));
  it("defines the new keys", () => {
    for (const k of ["DialogTitle", "DialogCharacterLabel", "DialogSkillLabel", "DialogConfirm", "DialogCancel", "DialogNoCharacters"])
      expect(lang[`PF2EDC.Dungeon.SkillChallenge.${k}`]).toBeTruthy();
  });
});
