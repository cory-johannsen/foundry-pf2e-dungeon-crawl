import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { ROOM_FEATURE_ART_THEMES, ROOM_FEATURE_ART_KINDS, ROOM_FEATURE_ART_BASE_KINDS } from "../scripts/room-feature-art.mjs";

const root = new URL("../", import.meta.url);
const manifest = JSON.parse(readFileSync(new URL("data/room-feature-art.json", root), "utf8"));
const artDir = new URL("assets/room-features/", root);

// Theme/kind pairs knowingly shipped without art (they use the fallback).
// Empty once all 32 images exist.
const INTENTIONAL_GAPS = [];

describe("room-feature art manifest", () => {
  it("lists only known themes and kinds", () => {
    for (const [theme, kinds] of Object.entries(manifest)) {
      expect(ROOM_FEATURE_ART_THEMES).toContain(theme);
      for (const kind of Object.keys(kinds)) expect(ROOM_FEATURE_ART_KINDS).toContain(kind);
    }
  });
  it("lists every theme and kind except the intentional gaps", () => {
    for (const theme of ROOM_FEATURE_ART_THEMES) {
      // #764: state kinds ship with Task 5's art; only base kinds are required here.
      for (const kind of ROOM_FEATURE_ART_BASE_KINDS) {
        const gap = INTENTIONAL_GAPS.some((g) => g.theme === theme && g.kind === kind);
        expect(Object.keys(manifest[theme] ?? {}).includes(kind), `${theme}/${kind}`).toBe(!gap);
      }
    }
  });
  it("has a file on disk for every manifest entry", () => {
    for (const [theme, kinds] of Object.entries(manifest)) {
      for (const kind of Object.keys(kinds)) {
        expect(existsSync(new URL(`${theme}/${kind}.webp`, artDir)), `${theme}/${kind}`).toBe(true);
      }
    }
  });
  it("has no image on disk the manifest does not list", () => {
    if (!existsSync(artDir)) return;
    for (const theme of readdirSync(artDir)) {
      for (const file of readdirSync(new URL(`${theme}/`, artDir))) {
        const kind = file.replace(/\.webp$/, "");
        expect(Object.keys(manifest[theme] ?? {}).includes(kind), `${theme}/${kind}`).toBe(true);
      }
    }
  });
});
