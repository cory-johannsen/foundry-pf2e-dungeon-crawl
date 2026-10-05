import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";

const src = readFileSync(new URL("../scripts/module.mjs", import.meta.url), "utf8");

describe("room-feature prop click control (#611/#623)", () => {
  it("uses a standalone controls-layer display object like Foundry's DoorControl", () => {
    expect(src).toContain("new PIXI.Graphics()");
    expect(src).toContain("control.drawRect(");
    expect(src).not.toContain("control.rect(");
    expect(src).toContain("layer.addChild(control)");
    expect(src).toContain('control.on("pointerdown"');
    expect(src).toContain('control.eventMode = "static"');
  });
  it("does not rely on token/stage listeners or a Token prototype patch", () => {
    expect(src).not.toContain('token.on("pointerdown"');
    expect(src).not.toContain('stage.on("pointerdowncapture"');
    expect(src).not.toContain("proto._onClickLeft");
  });
  it("primary button only, rebuilt on canvasReady and prop token changes", () => {
    expect(src).toContain("event.button !== 0");
    expect(src).toContain('Hooks.on("canvasReady", syncRoomFeatureControls)');
    for (const h of ["createToken", "updateToken", "deleteToken"]) expect(src).toContain(`"${h}"`);
  });
});
