import { describe, it, expect } from "vitest";
import { parseBasicSaveAction, basicSaveDamageMultiplier } from "../scripts/trap-mechanics.mjs";

// Real description HTML from pf2e.hazards, confirmed live this session (2026-10-06).
const ELECTRIC_LATCH_RUNE = `<p><strong>Trigger</strong> A creature grasps the door latch directly or with a tool</p><hr /><p><strong>Effect</strong> The trap deals @Damage[3d12[electricity]] damage to the triggering creature (@Check[reflex|dc:22|basic] save).</p>`;
const INSISTENT_PRIVACY_FENCE = `<p><strong>Trigger</strong> A creature touches the fence directly or with a tool or weapon</p><hr /><p><strong>Effect</strong> The fence deals @Damage[7d12[electricity]] damage to the triggering creature (@Check[reflex|dc:26|basic|traits:electricity,mechanical,trap,hazard] save).</p>`;
const STEAM_VENTS = `<p><strong>Trigger</strong> The trip wire is pulled or severed, typically because a creature walked through the square with the trip wire</p><hr /><p><strong>Effect</strong> Steam erupts from the pipes, dealing @Damage[3d6[bludgeoning],3d6[fire]]{3d6 bludgeoning damage and 3d6 fire damage} (@Check[reflex|dc:24|basic|name:Avoid the erupting steam|traits:mechanical,trap,hazard]) to all creatures within 15 feet. Creatures that critically fail their save are knocked prone.</p>`;
const SLAMMING_DOOR = `<p><strong>Effect</strong> The stone slab deals @Damage[3d8[bludgeoning]] damage to anyone beneath or adjacent to the slab (@Check[reflex|dc:17|traits:damaging-effect] save).</p>`;
const PHARAOHS_WARD = `<p><strong>Effect</strong> Each living creature within 60 feet must succeed at a @Check[will|dc:23] save or be subjected to the pharaoh's curse.</p>`;
const WHEEL_OF_MISERY = `<p><strong>Effect</strong> The wheel begins to spin and rolls initiative.</p>`;
const HIDDEN_PIT = `<p><strong>Effect</strong> The triggering creature falls in and takes falling damage (typically @Damage[10[bludgeoning]|options:fall-damage] damage).</p>`;

describe("#839 parseBasicSaveAction", () => {
  it("parses a single-target basic save with one damage term, no area", () => {
    expect(parseBasicSaveAction(ELECTRIC_LATCH_RUNE)).toEqual({
      save: "reflex", dc: 22, damage: [{ formula: "3d12", type: "electricity" }], areaFeet: null,
    });
  });

  it("parses a single-target basic save even with extra trailing segments", () => {
    expect(parseBasicSaveAction(INSISTENT_PRIVACY_FENCE)).toEqual({
      save: "reflex", dc: 26, damage: [{ formula: "7d12", type: "electricity" }], areaFeet: null,
    });
  });

  it("parses an area basic save with two damage terms and a labeled {..} suffix", () => {
    expect(parseBasicSaveAction(STEAM_VENTS)).toEqual({
      save: "reflex", dc: 24,
      damage: [{ formula: "3d6", type: "bludgeoning" }, { formula: "3d6", type: "fire" }],
      areaFeet: 15,
    });
  });

  it("returns null for a save with no \"basic\" keyword (Slamming Door, Pharaoh's Ward)", () => {
    expect(parseBasicSaveAction(SLAMMING_DOOR)).toBeNull();
    expect(parseBasicSaveAction(PHARAOHS_WARD)).toBeNull();
  });

  it("returns null for a hazard with no @Check at all (rolls initiative, or no save)", () => {
    expect(parseBasicSaveAction(WHEEL_OF_MISERY)).toBeNull();
  });

  it("returns null for a damage term this parser doesn't recognize (fall damage, no dice-die shape)", () => {
    expect(parseBasicSaveAction(HIDDEN_PIT)).toBeNull();
  });

  it("returns null for non-string input", () => {
    expect(parseBasicSaveAction(undefined)).toBeNull();
    expect(parseBasicSaveAction(null)).toBeNull();
  });
});

describe("#839 basicSaveDamageMultiplier", () => {
  it("is the exact PF2e basic-save scaling", () => {
    expect(basicSaveDamageMultiplier("criticalSuccess")).toBe(0);
    expect(basicSaveDamageMultiplier("success")).toBe(0.5);
    expect(basicSaveDamageMultiplier("failure")).toBe(1);
    expect(basicSaveDamageMultiplier("criticalFailure")).toBe(2);
  });

  it("is 0 for an unrecognized outcome rather than throwing", () => {
    expect(basicSaveDamageMultiplier(undefined)).toBe(0);
  });
});
