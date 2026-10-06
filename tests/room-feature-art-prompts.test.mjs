import { describe, it, expect } from "vitest";
import { ROOM_FEATURE_ART } from "../tools/room-feature-art-prompts.mjs";
import { ROOM_FEATURE_ART_THEMES, ROOM_FEATURE_ART_BASE_KINDS } from "../scripts/room-feature-art.mjs";

describe("ROOM_FEATURE_ART subjects", () => {
  it("has exactly one subject per theme and kind", () => {
    expect(ROOM_FEATURE_ART).toHaveLength(ROOM_FEATURE_ART_THEMES.length * ROOM_FEATURE_ART_BASE_KINDS.length);
    for (const theme of ROOM_FEATURE_ART_THEMES) {
      for (const kind of ROOM_FEATURE_ART_BASE_KINDS) {
        const s = ROOM_FEATURE_ART.find((x) => x.id === `rf-${theme}-${kind}`);
        expect(s, `${theme}/${kind}`).toBeDefined();
        expect(s.dir).toBe(`assets/room-features/${theme}`);
        expect(s.file).toBe(kind);
        expect(s.icon).toBe(true);
      }
    }
  });
  it("has unique ids", () => {
    const ids = ROOM_FEATURE_ART.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
  it("has no apostrophes in any prompt or avoid string", () => {
    for (const s of ROOM_FEATURE_ART) {
      expect(s.prompt, s.id).not.toMatch(/['']/);
      expect(s.avoid ?? "", s.id).not.toMatch(/['']/);
    }
  });
  it("asks for a plain empty background and names the theme and the object", () => {
    for (const s of ROOM_FEATURE_ART) {
      expect(s.prompt, s.id).toMatch(/plain empty background/);
      expect(s.prompt.length, s.id).toBeGreaterThan(80);
    }
  });
});
