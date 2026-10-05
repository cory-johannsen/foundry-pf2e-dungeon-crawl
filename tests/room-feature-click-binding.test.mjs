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

describe("trap click-to-disable control (#754)", () => {
  it("creates controls for visible, unspent trapHazard tokens from token data only", () => {
    expect(src).toContain("trapHazard");
    expect(src).toContain("trapSpent");
    expect(src).toContain("doc.hidden");
    const start = src.indexOf("function syncRoomFeatureControls");
    const end = src.indexOf('Hooks.on("canvasReady", syncRoomFeatureControls)');
    expect(src.slice(start, end)).not.toContain("doc.actor");
  });
  it("rebuild hook also fires for trapHazard tokens", () => {
    const i = src.indexOf('for (const hook of ["createToken"');
    const block = src.slice(i, i + 500);
    expect(block).toContain("roomFeatureKind");
    expect(block).toContain("trapHazard");
  });
  it("click handler: primary button, in-flight guard, relay vs GM direct", () => {
    expect(src).toContain("promptTrapDisable");
    expect(src).toContain("trapDisableInFlight");
    expect(src).toContain("attemptTrapDisableForScene(");
    expect(src).toContain('requestDungeonAction("attemptTrapDisable"');
    // the whole party is offered, like the tracker skill checks
    expect(src).not.toContain("actor.isOwner");
    expect(src).toContain('actor.type === "character"');
    expect(src).toContain("trapDisableChecks");
  });
});
