import { describe, it, expect } from "vitest";
import { ROOM_FEATURE_ART, ROOM_FEATURE_OBJECT_SYSTEM_PROMPT, ROOM_FEATURE_DOOR_SYSTEM_PROMPT } from "../tools/room-feature-art-prompts.mjs";
import { ROOM_FEATURE_ART_THEMES, ROOM_FEATURE_ART_BASE_KINDS, ROOM_FEATURE_ART_STATE_KINDS, ROOM_FEATURE_ART_KINDS } from "../scripts/room-feature-art.mjs";

describe("ROOM_FEATURE_ART subjects", () => {
  it("has exactly one subject per theme and kind (base and state)", () => {
    for (const theme of ROOM_FEATURE_ART_THEMES) {
      for (const kind of ROOM_FEATURE_ART_KINDS) {
        const matches = ROOM_FEATURE_ART.filter((x) => x.id === `rf-${theme}-${kind}`);
        expect(matches, `${theme}/${kind}`).toHaveLength(1);
        expect(matches[0].dir).toBe(`assets/room-features/${theme}`);
        expect(matches[0].file).toBe(kind);
        expect(matches[0].icon).toBe(true);
      }
    }
  });
  it("adds floor variants 1 and 2 of each base kind for every theme", () => {
    for (const theme of ROOM_FEATURE_ART_THEMES) {
      for (const variant of [1, 2]) {
        for (const kind of ROOM_FEATURE_ART_BASE_KINDS) {
          const s = ROOM_FEATURE_ART.find((x) => x.id === `rf-${theme}-${kind}-${variant}`);
          expect(s, `${theme}/${kind}-${variant}`).toBeDefined();
          expect(s.file).toBe(`${kind}-${variant}`);
          expect(s.dir).toBe(`assets/room-features/${theme}`);
        }
      }
    }
  });
  it("makes the two variants of a kind visibly different prompts", () => {
    const a = ROOM_FEATURE_ART.find((x) => x.id === "rf-beast-treasure-1").prompt;
    const b = ROOM_FEATURE_ART.find((x) => x.id === "rf-beast-treasure-2").prompt;
    expect(a).not.toBe(b);
  });
  it("has the expected total count", () => {
    const n = ROOM_FEATURE_ART_THEMES.length * (ROOM_FEATURE_ART_BASE_KINDS.length + ROOM_FEATURE_ART_STATE_KINDS.length)
      + ROOM_FEATURE_ART_THEMES.length * 2 * ROOM_FEATURE_ART_BASE_KINDS.length;
    expect(ROOM_FEATURE_ART).toHaveLength(n);
  });
  it("gives every subject a systemPrompt: door kinds the door one, others the object one", () => {
    for (const s of ROOM_FEATURE_ART) {
      expect(s.systemPrompt, s.id).toBeTruthy();
      const isDoor = /^rf-[a-z]+-door(_locked)?(-\d)?$/.test(s.id);
      expect(s.systemPrompt, s.id).toBe(isDoor ? ROOM_FEATURE_DOOR_SYSTEM_PROMPT : ROOM_FEATURE_OBJECT_SYSTEM_PROMPT);
    }
  });
  it("keeps the locked door a top-down strip with a chain and padlock", () => {
    const s = ROOM_FEATURE_ART.find((x) => x.id === "rf-undead-door_locked");
    expect(s.prompt).toMatch(/directly above/);
    expect(s.prompt).toMatch(/chain/);
    expect(s.prompt).toMatch(/padlock/);
    expect(s.prompt).toMatch(/aspect ratio 5:1/);
  });
  it("has unique ids", () => {
    const ids = ROOM_FEATURE_ART.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
  it("has no apostrophes in any prompt or avoid string", () => {
    for (const s of ROOM_FEATURE_ART) {
      expect(s.prompt, s.id).not.toMatch(/['']/);
      expect(s.avoid ?? "", s.id).not.toMatch(/['']/);
      expect(s.systemPrompt, s.id).not.toMatch(/['']/);
    }
  });
  it("asks for a plain empty background and names the theme and the object", () => {
    for (const s of ROOM_FEATURE_ART) {
      expect(s.prompt, s.id).toMatch(/plain empty background/);
      expect(s.prompt.length, s.id).toBeGreaterThan(80);
    }
  });
});
