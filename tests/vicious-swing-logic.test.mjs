import { describe, it, expect } from "vitest";
import {
  VICIOUS_SWING_SLUG, EXTRA_DICE_OPTION, EXTRA_DICE_EFFECT_SLUG, isViciousSwingMessage,
  extraDiceCount, weaponDieSize, buildExtraDiceEffectData, costFixUpdates,
  findStrikeMessageId, sweepableEffectIds, trackerHasViciousSwingEntry,
} from "../scripts/vicious-swing-logic.mjs";

const card = (over = {}) => ({
  flags: { pf2e: { origin: { type: "feat", rollOptions: ["origin:item:slug:vicious-swing"] } } },
  ...over,
});

describe("isViciousSwingMessage", () => {
  it("accepts the feat card", () => expect(isViciousSwingMessage(card())).toBe(true));
  it("rejects another feat", () => {
    expect(isViciousSwingMessage({ flags: { pf2e: { origin: { type: "feat", rollOptions: ["origin:item:slug:power-attack"] } } } })).toBe(false);
  });
  it("rejects a roll carrying a context", () => {
    const m = card(); m.flags.pf2e.context = { type: "attack-roll" };
    expect(isViciousSwingMessage(m)).toBe(false);
  });
  it("rejects a non-feat origin", () => {
    const m = card(); m.flags.pf2e.origin.type = "weapon";
    expect(isViciousSwingMessage(m)).toBe(false);
  });
  it("rejects null and {}", () => {
    expect(isViciousSwingMessage(null)).toBe(false);
    expect(isViciousSwingMessage({})).toBe(false);
  });
  it("exports the slug", () => expect(VICIOUS_SWING_SLUG).toBe("vicious-swing"));
});

describe("extraDiceCount", () => {
  it.each([[1, 1], [9, 1], [10, 2], [17, 2], [18, 3], [20, 3]])("level %i -> %i dice", (l, n) => {
    expect(extraDiceCount(l)).toBe(n);
  });
  it("tolerates bad input", () => {
    expect(extraDiceCount(undefined)).toBe(1);
    expect(extraDiceCount(NaN)).toBe(1);
  });
});

describe("weaponDieSize", () => {
  it("reads the weapon die", () => expect(weaponDieSize({ item: { system: { damage: { die: "d8" } } } })).toBe("d8"));
  it("is null without a die or item", () => {
    expect(weaponDieSize({ item: { system: { damage: { die: null } } } })).toBeNull();
    expect(weaponDieSize({})).toBeNull();
    expect(weaponDieSize(undefined)).toBeNull();
  });
});

describe("buildExtraDiceEffectData", () => {
  it("builds an effect with one gated DamageDice rule", () => {
    const e = buildExtraDiceEffectData({ count: 2, dieSize: "d8" });
    expect(e.type).toBe("effect");
    expect(e.system.slug).toBe(EXTRA_DICE_EFFECT_SLUG);
    expect(e.system.rules).toEqual([
      { key: "DamageDice", selector: "strike-damage", diceNumber: 2, dieSize: "d8", predicate: [EXTRA_DICE_OPTION] },
    ]);
    expect(e.system.duration.unit).toBe("unlimited");
  });
});

describe("costFixUpdates", () => {
  it("marks the card MAP-relevant and zeroes the Strike", () => {
    expect(costFixUpdates()).toEqual({ card: { isMapRelevant: true }, strike: { cost: 0 } });
  });
});

describe("findStrikeMessageId", () => {
  const msg = (id, over = {}) => ({
    id, timestamp: 1000, author: { id: "u1" }, speaker: { actor: "a1" },
    flags: { pf2e: { context: { type: "attack-roll" } } }, ...over,
  });
  const q = { userId: "u1", actorId: "a1", sinceMs: 500 };
  it("picks the newest match", () => {
    expect(findStrikeMessageId([msg("old", { timestamp: 900 }), msg("new", { timestamp: 1200 })], q)).toBe("new");
  });
  it("ignores other users, actors, contexts and old messages", () => {
    expect(findStrikeMessageId([
      msg("x1", { author: { id: "u2" } }),
      msg("x2", { speaker: { actor: "a2" } }),
      msg("x3", { flags: { pf2e: { context: { type: "damage-roll" } } } }),
      msg("x4", { timestamp: 100 }),
    ], q)).toBeNull();
  });
  it("is null on empty/undefined", () => {
    expect(findStrikeMessageId([], q)).toBeNull();
    expect(findStrikeMessageId(undefined, q)).toBeNull();
  });
});

describe("sweepableEffectIds", () => {
  it("returns only the extra-dice effects", () => {
    const items = [{ id: "a", slug: EXTRA_DICE_EFFECT_SLUG }, { id: "b", slug: "other" }];
    expect(sweepableEffectIds(items)).toEqual(["a"]);
    expect(sweepableEffectIds(undefined)).toEqual([]);
  });
});

describe("trackerHasViciousSwingEntry", () => {
  it("detects the slug", () => {
    expect(trackerHasViciousSwingEntry(["a"])).toBe(false);
    expect(trackerHasViciousSwingEntry(["a", "vicious-swing"])).toBe(true);
    expect(trackerHasViciousSwingEntry(undefined)).toBe(false);
  });
});
