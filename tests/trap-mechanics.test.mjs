import { describe, it, expect } from "vitest";
import {
  parseDisableChecks,
  trapDetectionDC,
  isSimpleAutomatableTrap,
} from "../scripts/trap-mechanics.mjs";

describe("parseDisableChecks", () => {
  it("parses a single disable check (Hidden Pit, confirmed live)", () => {
    const html =
      "<p>@Check[thievery|dc:12|name:Remove the Trapdoor] to remove the trapdoor</p>";
    expect(parseDisableChecks(html)).toEqual([
      { skill: "thievery", dc: 12, label: "Remove the Trapdoor" },
    ]);
  });

  it("parses a check with trailing traits (Poisoned Dart Gallery, confirmed live)", () => {
    const html =
      "<p>@Check[thievery|dc:21|name:Disable Trap (Control Panel)|traits:action:disable-a-device] (expert) on the control panel deactivates the trap.</p>";
    expect(parseDisableChecks(html)).toEqual([
      { skill: "thievery", dc: 21, label: "Disable Trap (Control Panel)" },
    ]);
  });

  it("parses multiple alternative disable checks in one description (Wheel of Misery, confirmed live)", () => {
    const html =
      "<p>@Check[thievery|dc:26|name:Stop Wheel from Spinning|traits:action:disable-a-device] (expert) on the wheel to stop it from spinning, " +
      "@Check[thievery|dc:22|name:Erase Rune|traits:action:disable-a-device] (master) to erase each rune, or " +
      "@UUID[Compendium.pf2e.spells-srd.Item.9HpwDN4MYQJnW0LG]{Dispel Magic} (4th rank; counteract DC 22) to counteract each rune</p>";
    expect(parseDisableChecks(html)).toEqual([
      { skill: "thievery", dc: 26, label: "Stop Wheel from Spinning" },
      { skill: "thievery", dc: 22, label: "Erase Rune" },
    ]);
  });

  it("returns an empty array for text with no @Check link at all", () => {
    expect(parseDisableChecks("<p>Cannot be disabled.</p>")).toEqual([]);
  });

  it("returns an empty array for null/undefined/empty input", () => {
    expect(parseDisableChecks(null)).toEqual([]);
    expect(parseDisableChecks(undefined)).toEqual([]);
    expect(parseDisableChecks("")).toEqual([]);
  });

  it("handles a check with no |name: segment at all", () => {
    expect(parseDisableChecks("@Check[thievery|dc:15]")).toEqual([
      { skill: "thievery", dc: 15, label: null },
    ]);
  });
});

describe("trapDetectionDC", () => {
  it("is 10 + the stealth value (Hidden Pit: stealth 8 -> DC 18, confirmed live)", () => {
    expect(trapDetectionDC(8)).toBe(18);
  });

  it("defaults a missing stealth value to 0", () => {
    expect(trapDetectionDC(undefined)).toBe(10);
    expect(trapDetectionDC(null)).toBe(10);
  });

  it("handles a negative stealth value (an easy-to-spot trap)", () => {
    expect(trapDetectionDC(-2)).toBe(8);
  });
});

describe("isSimpleAutomatableTrap", () => {
  const base = {
    isComplex: false,
    strikeActionCount: 1,
    disableChecks: [{ skill: "thievery", dc: 12, label: null }],
  };

  it("is true for a non-complex trap with exactly one strike and a disable check", () => {
    expect(isSimpleAutomatableTrap(base)).toBe(true);
  });

  it("is false for a complex hazard", () => {
    expect(isSimpleAutomatableTrap({ ...base, isComplex: true })).toBe(false);
  });

  it("is false with zero strike actions (a save-only or pure-narrative effect)", () => {
    expect(isSimpleAutomatableTrap({ ...base, strikeActionCount: 0 })).toBe(
      false,
    );
  });

  it("is false with more than one strike action (a multi-attack routine)", () => {
    expect(isSimpleAutomatableTrap({ ...base, strikeActionCount: 2 })).toBe(
      false,
    );
  });

  it("is false with no parseable disable check", () => {
    expect(isSimpleAutomatableTrap({ ...base, disableChecks: [] })).toBe(false);
  });
});
