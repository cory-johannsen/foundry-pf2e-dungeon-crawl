import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";

const src = readFileSync(new URL("../scripts/module.mjs", import.meta.url), "utf8");

describe("room-feature prop click binding (#611/#623)", () => {
  it("binds a pointerdown listener on the prop, not a Token prototype patch", () => {
    expect(src).toContain('token.on("pointerdown"');
    expect(src).not.toContain("proto._onClickLeft");
  });
  it("binds on draw and on canvasReady, idempotently, primary button only", () => {
    expect(src).toContain('Hooks.on("drawToken", bindRoomFeatureClick)');
    expect(src).toContain('Hooks.on("canvasReady"');
    expect(src).toContain("_pf2edcRoomFeatureBound");
    expect(src).toContain("event.button !== 0");
  });
});
