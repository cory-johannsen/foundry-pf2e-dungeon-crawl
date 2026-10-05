import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

// #611/#623: no hbs rendering harness exists, so read files as text.
const read = (p) => readFileSync(new URL(p, import.meta.url), "utf8");
const template = read("../templates/dungeon-tracker.hbs");
const lang = JSON.parse(read("../lang/en.json"));
const appSource = read("../scripts/ui/dungeon-app.mjs");

// Count of `{{#if isGM}}` at base commit a795ff5
// (`git show a795ff5:templates/dungeon-tracker.hbs | grep -c "#if isGM"`).
// The room-feature gate must be `interactive`, never a new isGM wrapper
// (a GM-less host is a non-GM operator and would deadlock).
const BASE_IS_GM_COUNT = 1;

describe("room-feature reveal gating", () => {
  it.each([
    "PF2EDC.Dungeon.SkillChallenge.NotRevealedHint",
    "PF2EDC.Dungeon.Puzzle.NotRevealedHint",
  ])("lang has a non-empty %s", (key) => {
    expect(typeof lang[key]).toBe("string");
    expect(lang[key].length).toBeGreaterThan(0);
  });

  it("template gates the challenge and puzzle forms on revealed", () => {
    expect(template).toContain("{{#if challenge.revealed}}");
    expect(template).toContain("{{#if ../puzzle.revealed}}");
    expect(template).toContain("PF2EDC.Dungeon.SkillChallenge.NotRevealedHint");
    expect(template).toContain("PF2EDC.Dungeon.Puzzle.NotRevealedHint");
  });

  it("template adds no new isGM wrappers", () => {
    expect(template.match(/\{\{#if isGM\}\}/g)?.length ?? 0).toBe(BASE_IS_GM_COUNT);
  });

  it("claim, challenge and puzzle controls sit inside an interactive gate", () => {
    for (const marker of [
      'data-action="claimTreasure"',
      'class="pf2edc-dungeon__skill-challenge-form"',
      'class="pf2edc-dungeon__puzzle-stage-form"',
    ]) {
      const before = template.slice(0, template.indexOf(marker));
      // the nearest `{{#if interactive}}` must open inside this room kind's
      // own branch, i.e. after the nearest preceding `{{else if isXxx}}`.
      expect(before.lastIndexOf("{{#if interactive}}")).toBeGreaterThan(
        before.lastIndexOf("{{else if is"),
      );
    }
  });

  it("context exposes revealed on both challenge and puzzle", () => {
    expect(appSource.split("revealed: !!raw.revealed").length - 1).toBeGreaterThanOrEqual(2);
  });

  describe("operator reveal override", () => {
    const count = (hay, needle) => hay.split(needle).length - 1;
    const BTN = "PF2EDC.Dungeon.RoomFeature.RevealButton";

    it("lang has a non-empty reveal button label", () => {
      expect(typeof lang[BTN]).toBe("string");
      expect(lang[BTN].length).toBeGreaterThan(0);
    });

    it.each(["skill_challenge", "puzzle"])("%s has a reveal button inside an interactive gate", (kind) => {
      const marker = `data-action="revealRoomFeature" data-kind="${kind}"`;
      expect(template).toContain(marker);
      const before = template.slice(0, template.indexOf(marker));
      expect(before.lastIndexOf("{{#if interactive}}")).toBeGreaterThan(
        before.lastIndexOf("{{else if is"),
      );
    });

    it("reveal button key appears exactly twice; puzzle hint exactly once", () => {
      expect(count(template, BTN)).toBe(2);
      expect(count(template, "PF2EDC.Dungeon.Puzzle.NotRevealedHint")).toBe(1);
    });

    it("dungeon-app registers and implements the handler via the authoritative path", () => {
      expect(appSource).toContain("revealRoomFeature: DungeonApp.#onRevealRoomFeature");
      const start = appSource.indexOf("static async #onRevealRoomFeature");
      expect(start).toBeGreaterThan(-1);
      const body = appSource.slice(start, start + 1200);
      expect(body).toContain("runRoomFeatureAction(");
      expect(body).toContain('requestDungeonAction("roomFeatureInteract"');
    });
  });
});
