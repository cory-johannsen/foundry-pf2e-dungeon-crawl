import { describe, it, expect } from "vitest";
import {
  parseDisableChecks,
  trapDetectionDC,
  isSimpleAutomatableTrap,
  classifyTrapMove,
  trapFootprintSize,
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

describe("classifyTrapMove", () => {
  const trap = { gx: 5, gy: 5, gw: 1, gh: 1 };

  it("is 'trigger' when the mover's footprint overlaps the trap's own cell", () => {
    expect(classifyTrapMove(trap, { gx: 5, gy: 5, gw: 1, gh: 1 })).toBe("trigger");
  });

  it("is 'trigger' for a larger mover footprint that still overlaps", () => {
    expect(classifyTrapMove(trap, { gx: 4, gy: 5, gw: 2, gh: 1 })).toBe("trigger");
  });

  it("is 'detect' for a mover orthogonally adjacent (not overlapping)", () => {
    expect(classifyTrapMove(trap, { gx: 6, gy: 5, gw: 1, gh: 1 })).toBe("detect");
  });

  it("is 'detect' for a mover diagonally adjacent (not overlapping)", () => {
    expect(classifyTrapMove(trap, { gx: 6, gy: 6, gw: 1, gh: 1 })).toBe("detect");
  });

  it("is 'none' for a mover two squares away", () => {
    expect(classifyTrapMove(trap, { gx: 7, gy: 5, gw: 1, gh: 1 })).toBe("none");
  });

  it("is 'trigger' (not 'detect') when both overlap and would also count as adjacent", () => {
    // Overlap always wins over the weaker adjacency signal.
    expect(classifyTrapMove(trap, { gx: 5, gy: 5, gw: 2, gh: 2 })).toBe("trigger");
  });
});

describe('trapFootprintSize', () => {
  it('is deterministic for the same seed and roomId', () => {
    expect(trapFootprintSize('alpha', 'room-5')).toEqual(trapFootprintSize('alpha', 'room-5'));
  });

  it('is always one of 1x1, 2x1, 1x2, or 2x2', () => {
    const valid = [
      { width: 1, height: 1 },
      { width: 2, height: 1 },
      { width: 1, height: 2 },
      { width: 2, height: 2 },
    ];
    for (let i = 0; i < 500; i += 1) {
      const size = trapFootprintSize('sweep-seed', `room-${i}`);
      expect(valid).toContainEqual(size);
    }
  });

  it('stays 1x1 at approximately 70% across a large sample', () => {
    let ones = 0;
    const trials = 5000;
    for (let i = 0; i < trials; i += 1) {
      const size = trapFootprintSize('rate-seed', `room-${i}`);
      if (size.width === 1 && size.height === 1) ones += 1;
    }
    const rate = ones / trials;
    expect(rate).toBeGreaterThan(0.65);
    expect(rate).toBeLessThan(0.75);
  });

  it('splits the elongated case roughly evenly between 2x1 and 1x2', () => {
    let wide = 0;
    let tall = 0;
    const trials = 5000;
    for (let i = 0; i < trials; i += 1) {
      const size = trapFootprintSize('orientation-seed', `room-${i}`);
      if (size.width === 2 && size.height === 1) wide += 1;
      if (size.width === 1 && size.height === 2) tall += 1;
    }
    expect(wide).toBeGreaterThan(0);
    expect(tall).toBeGreaterThan(0);
    const ratio = wide / (wide + tall);
    expect(ratio).toBeGreaterThan(0.35);
    expect(ratio).toBeLessThan(0.65);
  });

  it('produces 2x2 at approximately 10% across a large sample', () => {
    let squares = 0;
    const trials = 5000;
    for (let i = 0; i < trials; i += 1) {
      const size = trapFootprintSize('square-rate-seed', `room-${i}`);
      if (size.width === 2 && size.height === 2) squares += 1;
    }
    const rate = squares / trials;
    expect(rate).toBeGreaterThan(0.07);
    expect(rate).toBeLessThan(0.13);
  });
});
