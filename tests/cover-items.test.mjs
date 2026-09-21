import { describe, it, expect } from "vitest";
import {
  COVER_ITEM_TYPES,
  COVER_EFFECT_DATA,
  chooseCoverItemTypes,
  buildCoverItemActorData,
  lineCells,
  coverBlocksLineOfFire,
} from "../scripts/cover-items.mjs";

describe("chooseCoverItemTypes", () => {
  it("is deterministic for the same seed", () => {
    expect(chooseCoverItemTypes("seed-a")).toEqual(
      chooseCoverItemTypes("seed-a"),
    );
  });

  it("varies by seed", () => {
    const results = new Set();
    for (const seed of [
      "seed-a",
      "seed-b",
      "seed-c",
      "seed-d",
      "seed-e",
      "seed-f",
    ]) {
      results.add(JSON.stringify(chooseCoverItemTypes(seed)));
    }
    expect(results.size).toBeGreaterThan(1);
  });

  it("never exceeds maxCount entries", () => {
    for (let i = 0; i < 30; i += 1) {
      expect(chooseCoverItemTypes(`seed-${i}`, 3).length).toBeLessThanOrEqual(
        3,
      );
    }
  });

  it("respects a custom maxCount", () => {
    for (let i = 0; i < 30; i += 1) {
      expect(chooseCoverItemTypes(`seed-${i}`, 1).length).toBeLessThanOrEqual(
        1,
      );
    }
  });

  it("only ever returns known type ids", () => {
    for (let i = 0; i < 30; i += 1) {
      for (const id of chooseCoverItemTypes(`seed-${i}`, 3)) {
        expect(Object.keys(COVER_ITEM_TYPES)).toContain(id);
      }
    }
  });

  it("can return zero items", () => {
    let sawZero = false;
    for (let i = 0; i < 50; i += 1) {
      if (chooseCoverItemTypes(`seed-${i}`, 3).length === 0) sawZero = true;
    }
    expect(sawZero).toBe(true);
  });
});

describe("buildCoverItemActorData", () => {
  it("builds a hazard actor with real hp/hardness matching the type table", () => {
    const data = buildCoverItemActorData("crate");
    expect(data.type).toBe("hazard");
    expect(data.name).toBe("Wooden Crate");
    expect(data.system.attributes.hp).toEqual({
      value: 20,
      max: 20,
      brokenThreshold: 10,
    });
    expect(data.system.attributes.hardness).toBe(5);
    expect(data.system.details.isComplex).toBe(false);
  });

  it("flags the actor as a cover item with its type id", () => {
    const data = buildCoverItemActorData("barrel");
    expect(data.flags["deck-of-many-more-things"].coverItem).toBe("barrel");
  });

  it("defaults to neutral disposition, overridable", () => {
    expect(buildCoverItemActorData("rubble").prototypeToken.disposition).toBe(
      0,
    );
    expect(
      buildCoverItemActorData("rubble", { disposition: -1 }).prototypeToken
        .disposition,
    ).toBe(-1);
  });

  it("throws on an unknown type id", () => {
    expect(() => buildCoverItemActorData("nonexistent")).toThrow(/nonexistent/);
  });

  it("builds every declared type without throwing", () => {
    for (const id of Object.keys(COVER_ITEM_TYPES)) {
      expect(() => buildCoverItemActorData(id)).not.toThrow();
    }
  });
});

describe("lineCells", () => {
  it("includes both endpoints", () => {
    const cells = lineCells({ gx: 0, gy: 0 }, { gx: 3, gy: 0 });
    expect(cells[0]).toEqual({ gx: 0, gy: 0 });
    expect(cells.at(-1)).toEqual({ gx: 3, gy: 0 });
  });

  it("is a straight horizontal run", () => {
    expect(lineCells({ gx: 0, gy: 2 }, { gx: 4, gy: 2 })).toEqual([
      { gx: 0, gy: 2 },
      { gx: 1, gy: 2 },
      { gx: 2, gy: 2 },
      { gx: 3, gy: 2 },
      { gx: 4, gy: 2 },
    ]);
  });

  it("is a straight vertical run", () => {
    expect(lineCells({ gx: 2, gy: 0 }, { gx: 2, gy: 3 })).toEqual([
      { gx: 2, gy: 0 },
      { gx: 2, gy: 1 },
      { gx: 2, gy: 2 },
      { gx: 2, gy: 3 },
    ]);
  });

  it("is a straight diagonal run", () => {
    expect(lineCells({ gx: 0, gy: 0 }, { gx: 3, gy: 3 })).toEqual([
      { gx: 0, gy: 0 },
      { gx: 1, gy: 1 },
      { gx: 2, gy: 2 },
      { gx: 3, gy: 3 },
    ]);
  });

  it("a single-point line is just that point", () => {
    expect(lineCells({ gx: 5, gy: 5 }, { gx: 5, gy: 5 })).toEqual([
      { gx: 5, gy: 5 },
    ]);
  });

  it("is symmetric regardless of direction", () => {
    const forward = lineCells({ gx: 0, gy: 0 }, { gx: 5, gy: 2 });
    const backward = lineCells({ gx: 5, gy: 2 }, { gx: 0, gy: 0 }).reverse();
    expect(forward).toEqual(backward);
  });
});

describe("coverBlocksLineOfFire", () => {
  it("is false with no cover items", () => {
    expect(coverBlocksLineOfFire({ gx: 0, gy: 0 }, { gx: 5, gy: 0 }, [])).toBe(
      false,
    );
  });

  it("is true when a cover cell sits strictly between attacker and target", () => {
    expect(
      coverBlocksLineOfFire({ gx: 0, gy: 0 }, { gx: 4, gy: 0 }, [
        { gx: 2, gy: 0 },
      ]),
    ).toBe(true);
  });

  it('is false when the only "cover" cell is the attacker\'s own square', () => {
    expect(
      coverBlocksLineOfFire({ gx: 0, gy: 0 }, { gx: 4, gy: 0 }, [
        { gx: 0, gy: 0 },
      ]),
    ).toBe(false);
  });

  it('is false when the only "cover" cell is the target\'s own square', () => {
    expect(
      coverBlocksLineOfFire({ gx: 0, gy: 0 }, { gx: 4, gy: 0 }, [
        { gx: 4, gy: 0 },
      ]),
    ).toBe(false);
  });

  it("is false when the cover item is off the line of fire entirely", () => {
    expect(
      coverBlocksLineOfFire({ gx: 0, gy: 0 }, { gx: 4, gy: 0 }, [
        { gx: 2, gy: 3 },
      ]),
    ).toBe(false);
  });

  it("works for adjacent attacker/target with nothing between them", () => {
    expect(
      coverBlocksLineOfFire({ gx: 0, gy: 0 }, { gx: 1, gy: 0 }, [
        { gx: 0, gy: 0 },
        { gx: 1, gy: 0 },
      ]),
    ).toBe(false);
  });

  it("is true along a diagonal line of fire", () => {
    expect(
      coverBlocksLineOfFire({ gx: 0, gy: 0 }, { gx: 4, gy: 4 }, [
        { gx: 2, gy: 2 },
      ]),
    ).toBe(true);
  });
});

describe("COVER_EFFECT_DATA", () => {
  it("is a +2 circumstance bonus to AC", () => {
    expect(COVER_EFFECT_DATA.type).toBe("effect");
    const rule = COVER_EFFECT_DATA.system.rules[0];
    expect(rule).toEqual({
      key: "FlatModifier",
      selector: "ac",
      type: "circumstance",
      value: 2,
      label: "Cover",
    });
  });
});
