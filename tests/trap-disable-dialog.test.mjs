import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import { buildTrapDisableChoices } from "../scripts/ui/trap-disable-dialog.mjs";

const chars = [
  { id: "a1", name: "Amiri" },
  { id: "b2", name: "Seoni" },
];
const checks = [
  { skill: "thievery", dc: 18, label: "Thievery" },
  { skill: "crafting", dc: 20, label: "Crafting" },
];

describe("buildTrapDisableChoices (#754)", () => {
  it("one skill option per check with label and DC; characters as given", () => {
    const r = buildTrapDisableChoices(checks, chars);
    expect(r.skills).toEqual([
      { skill: "thievery", dc: 18, label: "Thievery" },
      { skill: "crafting", dc: 20, label: "Crafting" },
    ]);
    expect(r.characters).toEqual([
      { id: "a1", name: "Amiri" },
      { id: "b2", name: "Seoni" },
    ]);
  });
  it("falls back to the skill slug when a check has no label", () => {
    const r = buildTrapDisableChoices([{ skill: "stealth", dc: 15 }], chars);
    expect(r.skills[0].label).toBe("stealth");
  });
  it("null for missing/empty checks or no characters", () => {
    expect(buildTrapDisableChoices([], chars)).toBeNull();
    expect(buildTrapDisableChoices(undefined, chars)).toBeNull();
    expect(buildTrapDisableChoices(checks, [])).toBeNull();
  });
});

describe("trap-disable-dialog source", () => {
  const src = readFileSync(new URL("../scripts/ui/trap-disable-dialog.mjs", import.meta.url), "utf8");
  it("uses DialogV2 and the localized keys", () => {
    expect(src).toContain("DialogV2");
    for (const k of ["DisableTitle", "CharacterLabel", "DisableOption", "DisableConfirm", "DisableCancel"])
      expect(src).toContain(`PF2EDC.Dungeon.Trap.${k}`);
  });
});

describe("trap lang keys", () => {
  const lang = JSON.parse(readFileSync(new URL("../lang/en.json", import.meta.url), "utf8"));
  it("defines the new keys", () => {
    for (const k of ["CannotDisable", "CharacterLabel", "DisableCancel", "DisableConfirm", "DisableNoCharacters", "DisableOption", "DisableTitle"])
      expect(lang[`PF2EDC.Dungeon.Trap.${k}`]).toBeTruthy();
    expect(lang["PF2EDC.Dungeon.Trap.DisableOption"]).toContain("{dc}");
  });
});
