import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import {
  ROOM_FEATURE_ART_THEMES,
  ROOM_FEATURE_ART_KINDS,
} from "../scripts/room-feature-art.mjs";

const root = new URL("../", import.meta.url);
const manifest = JSON.parse(readFileSync(new URL("data/room-feature-art.json", root), "utf8"));
const artDir = new URL("assets/room-features/", root);

// Theme/kind pairs knowingly shipped without art (they use the fallback).
// Empty: every theme has every base and state kind (#750, #764).
const INTENTIONAL_GAPS = [];

const fileFor = (kind, variant) => `${kind}${variant === 0 ? "" : `-${variant}`}.webp`;

describe("room-feature art manifest", () => {
  it("lists only known themes, kinds and 0-2 variants", () => {
    for (const [theme, kinds] of Object.entries(manifest)) {
      expect(ROOM_FEATURE_ART_THEMES).toContain(theme);
      for (const [kind, variants] of Object.entries(kinds)) {
        expect(ROOM_FEATURE_ART_KINDS).toContain(kind);
        for (const v of variants) expect([0, 1, 2]).toContain(v);
      }
    }
  });
  it("lists every theme and kind (base and state) except the intentional gaps", () => {
    for (const theme of ROOM_FEATURE_ART_THEMES) {
      for (const kind of ROOM_FEATURE_ART_KINDS) {
        const gap = INTENTIONAL_GAPS.some((g) => g.theme === theme && g.kind === kind);
        expect(Object.keys(manifest[theme] ?? {}).includes(kind), `${theme}/${kind}`).toBe(!gap);
      }
    }
  });
  it("gives every listed kind a variant 0", () => {
    for (const [theme, kinds] of Object.entries(manifest)) {
      for (const [kind, variants] of Object.entries(kinds)) {
        expect(variants, `${theme}/${kind}`).toContain(0);
      }
    }
  });
  it("has a file on disk for every manifest variant", () => {
    for (const [theme, kinds] of Object.entries(manifest)) {
      for (const [kind, variants] of Object.entries(kinds)) {
        for (const v of variants) {
          expect(existsSync(new URL(`${theme}/${fileFor(kind, v)}`, artDir)), `${theme}/${fileFor(kind, v)}`).toBe(true);
        }
      }
    }
  });
  it("has no image on disk the manifest does not list", () => {
    if (!existsSync(artDir)) return;
    for (const theme of readdirSync(artDir)) {
      for (const file of readdirSync(new URL(`${theme}/`, artDir))) {
        const m = /^(.*?)(?:-([12]))?\.webp$/.exec(file);
        expect(m, `${theme}/${file}`).not.toBeNull();
        const kind = m[1];
        const variant = m[2] ? Number(m[2]) : 0;
        expect((manifest[theme]?.[kind] ?? []).includes(variant), `${theme}/${file}`).toBe(true);
      }
    }
  });
});
