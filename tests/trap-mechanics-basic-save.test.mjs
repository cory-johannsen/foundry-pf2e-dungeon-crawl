import { describe, it, expect } from "vitest";
import {
  parseBasicSaveAction,
  basicSaveDamageMultiplier,
  parseAreaFeet,
  footprintDistanceFeet,
  isSimpleAutomatableTrap,
} from "../scripts/trap-mechanics.mjs";

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
    expect(parseBasicSaveAction(ELECTRIC_LATCH_RUNE)).toMatchObject({
      save: "reflex", dc: 22, damage: [{ formula: "3d12", type: "electricity" }], areaFeet: null,
    });
  });

  it("parses a single-target basic save even with extra trailing segments", () => {
    expect(parseBasicSaveAction(INSISTENT_PRIVACY_FENCE)).toMatchObject({
      save: "reflex", dc: 26, damage: [{ formula: "7d12", type: "electricity" }], areaFeet: null,
    });
  });

  it("parses an area basic save with two damage terms and a labeled {..} suffix", () => {
    expect(parseBasicSaveAction(STEAM_VENTS)).toMatchObject({
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

// Real pf2e.hazards descriptions (read from the installed compendium, 2026-10-07).
const FIREBALL_RUNE = `<p><strong>Trigger</strong> A living creature enters the sensor area</p><hr /><p><strong>Effect</strong> The rune detonates a @UUID[Compendium.pf2e.spells-srd.Item.sxQZ6yqTn0czJxVd]{Fireball} centered on the triggering creature's square. This is a 3rd-rank fireball spell that deals @Damage[6d6[fire]] damage (@Check[reflex|dc:22|basic] save).</p>`;
const ARMAGEDDON_ORB = `<p><strong>Effect</strong> Fire rains from the sky in a 100-mile radius, dealing @Damage[10d6[fire]] damage to creatures and objects in the area. Each creature or object can attempt a @Check[reflex|dc:46|basic] save.</p>`;

const SHRIEKER = `<p><strong>Trigger</strong> A creature or light source approaches within 10 feet of the shrieker</p><hr /><p><strong>Effect</strong> The shrieker emits a deafening screech that deals @Damage[1d6[sonic]] damage to creatures within @Template[emanation|distance:30]{30 feet} (@Check[fortitude|dc:16|basic|traits:auditory] save; creatures that critically fail this saving throw are @UUID[Compendium.pf2e.conditionitems.Item.9PR9y0bi4JPKnHPR]{Deafened} for 1 minute).</p>`;
const WEB_LURKER_DEADFALL = `<p><strong>Effect</strong> All creatures in the trap's 10-foot square take @Damage[2d6[bludgeoning]] damage (@Check[reflex|dc:20|basic] save).</p>`;

describe("#839 parseBasicSaveAction real area shapes", () => {
  it("reads a @Template emanation distance as the area and surfaces the Deafened rider", () => {
    const p = parseBasicSaveAction(SHRIEKER);
    expect(p.areaFeet).toBe(30);
    expect(p.save).toBe("fortitude");
    expect(p.traits).toEqual(["auditory"]);
    expect(p.proneOnCritFail).toBe(false);
    expect(p.unparsedText).toContain("Deafened");
  });
  it("returns null for \"all creatures in the trap's 10-foot square\" (unsized shape)", () => {
    expect(parseBasicSaveAction(WEB_LURKER_DEADFALL)).toBeNull();
  });
});

describe("#839 parseBasicSaveAction refuses areas it cannot size", () => {
  it("returns null for Fireball Rune (area via a referenced spell) rather than shrinking it to one target", () => {
    expect(parseBasicSaveAction(FIREBALL_RUNE)).toBeNull();
  });
  it("returns null for an unsized radius/area (Armageddon Orb)", () => {
    expect(parseBasicSaveAction(ARMAGEDDON_ORB)).toBeNull();
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

describe("#839 parseBasicSaveAction riders, traits and area anchoring", () => {
  it("captures the @Check traits for the save's roll options", () => {
    expect(parseBasicSaveAction(STEAM_VENTS).traits).toEqual(["mechanical", "trap", "hazard"]);
    expect(parseBasicSaveAction(ELECTRIC_LATCH_RUNE).traits).toEqual([]);
  });

  it("recognises the critical-failure prone rider and consumes it", () => {
    const p = parseBasicSaveAction(STEAM_VENTS);
    expect(p.proneOnCritFail).toBe(true);
    expect(p.unparsedText).toBe("");
  });

  it("reports no rider text for a plain single-target hazard", () => {
    const p = parseBasicSaveAction(ELECTRIC_LATCH_RUNE);
    expect(p.proneOnCritFail).toBe(false);
    expect(p.unparsedText).toBe("");
  });

  it("surfaces any other text after the save instead of dropping it", () => {
    const html = `<p><strong>Effect</strong> It deals @Damage[2d6[fire]] (@Check[reflex|dc:20|basic]) to creatures within 10 feet. Creatures that critically fail are knocked prone. The room fills with smoke and the door locks.</p>`;
    const p = parseBasicSaveAction(html);
    expect(p.areaFeet).toBe(10);
    expect(p.proneOnCritFail).toBe(true);
    expect(p.unparsedText).toBe("The room fills with smoke and the door locks.");
  });

  it("does not read an area from the Trigger line", () => {
    const html = `<p><strong>Trigger</strong> A creature within 30 feet steps here</p><hr /><p><strong>Effect</strong> It deals @Damage[3d6[fire]] to the creature (@Check[reflex|dc:20|basic] save).</p>`;
    expect(parseAreaFeet(html)).toBeNull();
    expect(parseBasicSaveAction(html).areaFeet).toBeNull();
  });
});

describe("#839 footprintDistanceFeet (PF2e 5-10-5 diagonals)", () => {
  const cell = (gx, gy) => ({ gx, gy, gw: 1, gh: 1 });
  it("is 0 on the same square and 5 ft per orthogonal step", () => {
    expect(footprintDistanceFeet(cell(0, 0), cell(0, 0))).toBe(0);
    expect(footprintDistanceFeet(cell(0, 0), cell(3, 0))).toBe(15);
  });
  it("counts every second diagonal double: 3 east + 2 north is 20 ft", () => {
    expect(footprintDistanceFeet(cell(0, 0), cell(3, 2))).toBe(20);
    expect(footprintDistanceFeet(cell(0, 0), cell(1, 1))).toBe(5);
    expect(footprintDistanceFeet(cell(0, 0), cell(2, 2))).toBe(15);
    expect(footprintDistanceFeet(cell(0, 0), cell(3, 3))).toBe(20);
  });
  it("measures to the nearest edge of a large footprint", () => {
    expect(footprintDistanceFeet(cell(0, 0), { gx: 2, gy: 0, gw: 2, gh: 2 })).toBe(10);
  });
});

describe("#839 isSimpleAutomatableTrap with basic-save actions", () => {
  const base = { isComplex: false, strikeActionCount: 0, basicSaveActionCount: 1, disableChecks: [{}] };
  it("accepts a no-strike hazard with a basic-save action", () => {
    expect(isSimpleAutomatableTrap(base)).toBe(true);
  });
  it("still rejects complex, check-less or action-less hazards", () => {
    expect(isSimpleAutomatableTrap({ ...base, isComplex: true })).toBe(false);
    expect(isSimpleAutomatableTrap({ ...base, disableChecks: [] })).toBe(false);
    expect(isSimpleAutomatableTrap({ ...base, basicSaveActionCount: 0 })).toBe(false);
  });
});

describe("#884 Effect-anchored parsing", () => {
  it("#884: @Check/@Damage before the Effect heading (a rider written earlier) is not mistaken for the real save", () => {
    const html =
      '<p><strong>Trigger</strong> Stage 4 (@Check[fortitude|dc:30|basic]) deals @Damage[4d6[poison]] damage.</p>' +
      '<p><strong>Effect</strong> The trap deals @Damage[2d8[piercing]] damage to the triggering creature (@Check[reflex|dc:22|basic] save).</p>';
    expect(parseBasicSaveAction(html)).toEqual(
      expect.objectContaining({ save: "reflex", dc: 22, damage: [{ formula: "2d8", type: "piercing" }] }),
    );
  });

  it("#884: still parses every real automatable hazard's own description unchanged", () => {
    expect(parseBasicSaveAction(ELECTRIC_LATCH_RUNE)).not.toBeNull();
    expect(parseBasicSaveAction(INSISTENT_PRIVACY_FENCE)).not.toBeNull();
    expect(parseBasicSaveAction(STEAM_VENTS)).not.toBeNull();
  });
});
