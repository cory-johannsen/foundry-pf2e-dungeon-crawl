import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import { buildPuzzleStageChoices } from "../scripts/ui/puzzle-stage-dialog.mjs";

const chars = [
  { id: "a1", name: "Amiri" },
  { id: "b2", name: "Seoni" },
];
const stages = [
  { index: 0, skill: "thievery", dc: 18, label: "Thievery", attempted: false },
  { index: 1, skill: "arcana", dc: 20, label: "Arcana", attempted: true },
  { index: 2, skill: "stealth", dc: 16, label: "Stealth", attempted: false },
];

describe("buildPuzzleStageChoices (#822)", () => {
  it("offers only not-yet-attempted stages, with label and DC", () => {
    const r = buildPuzzleStageChoices(stages, chars);
    expect(r.stages).toEqual([
      { index: 0, skill: "thievery", dc: 18, label: "Thievery" },
      { index: 2, skill: "stealth", dc: 16, label: "Stealth" },
    ]);
    expect(r.characters).toEqual(chars);
  });

  it("falls back to the skill slug when a stage has no label", () => {
    const r = buildPuzzleStageChoices(
      [{ index: 0, skill: "medicine", dc: 15, attempted: false }],
      chars,
    );
    expect(r.stages[0].label).toBe("medicine");
  });

  it("null when every stage is already attempted, or no stages, or no characters", () => {
    expect(buildPuzzleStageChoices([{ ...stages[1] }], chars)).toBeNull();
    expect(buildPuzzleStageChoices([], chars)).toBeNull();
    expect(buildPuzzleStageChoices(stages, [])).toBeNull();
  });
});

describe("puzzle-stage-dialog source", () => {
  const src = readFileSync(new URL("../scripts/ui/puzzle-stage-dialog.mjs", import.meta.url), "utf8");
  it("uses DialogV2 and the localized keys", () => {
    expect(src).toContain("DialogV2");
    for (const k of ["Title", "CharacterLabel", "StageOption", "Confirm", "Cancel"])
      expect(src).toContain(`PF2EDC.Dungeon.Puzzle.Dialog${k}`);
  });
});

describe("puzzle dialog lang keys", () => {
  const lang = JSON.parse(readFileSync(new URL("../lang/en.json", import.meta.url), "utf8"));
  it("defines the new keys", () => {
    for (const k of ["DialogTitle", "DialogCharacterLabel", "DialogStageOption", "DialogConfirm", "DialogCancel", "DialogNoCharacters", "DialogNothingToAttempt"])
      expect(lang[`PF2EDC.Dungeon.Puzzle.${k}`]).toBeTruthy();
    expect(lang["PF2EDC.Dungeon.Puzzle.DialogStageOption"]).toContain("{dc}");
  });
});
