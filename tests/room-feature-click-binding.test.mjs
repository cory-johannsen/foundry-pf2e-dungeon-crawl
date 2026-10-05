import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";

const src = readFileSync(new URL("../scripts/module.mjs", import.meta.url), "utf8");

describe("room-feature prop click binding (#611/#623)", () => {
  it("listens on the stage in the capture phase (token-level listeners are stripped by Foundry)", () => {
    expect(src).toContain('stage.on("pointerdowncapture"');
    expect(src).not.toContain('token.on("pointerdown"');
    expect(src).not.toContain("proto._onClickLeft");
  });
  it("binds on canvasReady and ready, idempotently, primary button only", () => {
    expect(src).toContain('Hooks.on("canvasReady", bindRoomFeatureClick)');
    expect(src).toContain("_pf2edcRoomFeatureBound");
    expect(src).toContain("event.button !== 0");
  });
});
