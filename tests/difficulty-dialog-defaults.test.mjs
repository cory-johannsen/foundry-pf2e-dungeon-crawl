import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

// #636: the repo has no hbs / ApplicationV2 rendering harness, so these read
// the template, strings and handler as text -- the cheapest reliable check
// that the dialog actually defaults to Moderate.
const read = (p) => readFileSync(new URL(p, import.meta.url), "utf8");
const template = read("../templates/dungeon-tracker.hbs");
const lang = JSON.parse(read("../lang/en.json"));
const appSource = read("../scripts/ui/dungeon-app.mjs");

const TIERS = ["trivial", "low", "moderate", "severe", "extreme"];
const cap = (s) => s[0].toUpperCase() + s.slice(1);

describe("Start Dungeon difficulty dialog defaults (#636)", () => {
  const select = template.match(/<select name="difficulty">([\s\S]*?)<\/select>/)?.[1] ?? "";
  const options = [...select.matchAll(/<option value="(\w+)"( selected)?>/g)].map((m) => ({
    value: m[1],
    selected: Boolean(m[2]),
  }));

  it("offers all five tiers in order", () => {
    expect(options.map((o) => o.value)).toEqual(TIERS);
  });

  it("preselects Moderate and no other option", () => {
    expect(options.filter((o) => o.selected).map((o) => o.value)).toEqual(["moderate"]);
  });

  it('marks only Moderate as "(default)" in the labels', () => {
    for (const tier of TIERS) {
      const label = lang[`PF2EDC.Dungeon.Difficulty.${cap(tier)}`];
      expect(typeof label).toBe("string");
      expect(label.includes("(default)")).toBe(tier === "moderate");
    }
  });

  it('labels the control "Difficulty", not "Maximum difficulty"', () => {
    expect(lang["PF2EDC.Dungeon.DifficultyLabel"]).toBe("Difficulty");
  });

  it('#onStart falls back to "moderate" when the form value is missing', () => {
    expect(appSource).toMatch(/\[name="difficulty"\]'\)\?\.value \?\? "moderate"/);
  });
});
