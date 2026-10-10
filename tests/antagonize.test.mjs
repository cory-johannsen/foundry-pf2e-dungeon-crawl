import { describe, it, expect } from "vitest";
import {
  readAntagonizeMap,
  frightenedFloorFor,
  sensesAntagonizer,
  fullRoundElapsed,
  evaluateAntagonizeEntry,
  isHostileCheckContext,
  hostileTargetIdsOf,
} from "../scripts/antagonize.mjs";

// #920: Antagonize (Player Core 2, swashbuckler 2) -- "When you successfully
// Demoralize a creature, its Frightened condition can't decrease to less
// than 1 at the end of its turn until it either uses a hostile action
// against you or can no longer observe or sense you for at least 1 round."

const MODULE_ID = "pf2e-dungeon-crawl";

function actorWithAntagonize(map) {
  return { flags: { [MODULE_ID]: { antagonize: map } } };
}

const entry = (overrides = {}) => ({
  antagonizerUuid: "Actor.a1",
  sinceWorldTime: 0,
  unsensedSince: null,
  ...overrides,
});

describe("readAntagonizeMap", () => {
  it("returns the stored map when present", () => {
    const map = { c1: entry() };
    expect(readAntagonizeMap(actorWithAntagonize(map))).toEqual(map);
  });

  it("returns an empty object when absent or malformed", () => {
    expect(readAntagonizeMap({ flags: {} })).toEqual({});
    expect(readAntagonizeMap(actorWithAntagonize("not-an-object"))).toEqual({});
    expect(readAntagonizeMap(actorWithAntagonize(["x"]))).toEqual({});
    expect(readAntagonizeMap(null)).toEqual({});
  });
});

describe("frightenedFloorFor", () => {
  it("is 0 with no antagonize flag at all", () => {
    expect(frightenedFloorFor({ flags: {} })).toBe(0);
    expect(frightenedFloorFor(null)).toBe(0);
  });

  it("is 1 with exactly one entry", () => {
    expect(frightenedFloorFor(actorWithAntagonize({ c1: entry() }))).toBe(1);
  });

  it("is 1 with several entries (never higher)", () => {
    expect(frightenedFloorFor(actorWithAntagonize({ c1: entry(), c2: entry() }))).toBe(1);
  });

  it("is 0 for a malformed flag value or an empty map", () => {
    expect(frightenedFloorFor(actorWithAntagonize("not-an-object"))).toBe(0);
    expect(frightenedFloorFor(actorWithAntagonize({}))).toBe(0);
  });
});

describe("sensesAntagonizer", () => {
  it("senses an observed or hidden antagonizer (hidden is still sensed, RAW)", () => {
    expect(sensesAntagonizer("observed")).toBe(true);
    expect(sensesAntagonizer("hidden")).toBe(true);
    expect(sensesAntagonizer(undefined)).toBe(true);
  });

  it("does not sense an undetected or unnoticed antagonizer", () => {
    expect(sensesAntagonizer("undetected")).toBe(false);
    expect(sensesAntagonizer("unnoticed")).toBe(false);
  });
});

describe("fullRoundElapsed", () => {
  it("is false within the same round", () => {
    expect(fullRoundElapsed({ round: 2, turn: 1 }, { round: 2, turn: 3 })).toBe(false);
  });

  it("is false the next round before the same initiative position", () => {
    expect(fullRoundElapsed({ round: 2, turn: 3 }, { round: 3, turn: 2 })).toBe(false);
  });

  it("is true the next round at or after the same initiative position", () => {
    expect(fullRoundElapsed({ round: 2, turn: 3 }, { round: 3, turn: 3 })).toBe(true);
    expect(fullRoundElapsed({ round: 2, turn: 3 }, { round: 3, turn: 4 })).toBe(true);
  });

  it("is true two or more rounds later regardless of turn", () => {
    expect(fullRoundElapsed({ round: 2, turn: 3 }, { round: 4, turn: 0 })).toBe(true);
  });
});

describe("evaluateAntagonizeEntry", () => {
  it("clears unsensedSince and never expires while sensed", () => {
    const result = evaluateAntagonizeEntry(entry({ unsensedSince: { round: 1, turn: 0 } }), {
      sensed: true,
      round: 5,
      turn: 0,
    });
    expect(result).toEqual({ entry: entry({ unsensedSince: null }), expired: false });
  });

  it("starts the not-sensed clock at the first unsensed sample", () => {
    const result = evaluateAntagonizeEntry(entry(), { sensed: false, round: 2, turn: 1 });
    expect(result).toEqual({ entry: entry({ unsensedSince: { round: 2, turn: 1 } }), expired: false });
  });

  it("keeps the original start while still unsensed, and expires a full round later", () => {
    const start = entry({ unsensedSince: { round: 2, turn: 1 } });
    expect(evaluateAntagonizeEntry(start, { sensed: false, round: 2, turn: 3 })).toEqual({
      entry: start,
      expired: false,
    });
    expect(evaluateAntagonizeEntry(start, { sensed: false, round: 3, turn: 1 }).expired).toBe(true);
  });

  it("re-sensing resets the clock, so a later loss needs a fresh full round", () => {
    let current = entry();
    current = evaluateAntagonizeEntry(current, { sensed: false, round: 1, turn: 0 }).entry;
    current = evaluateAntagonizeEntry(current, { sensed: true, round: 1, turn: 2 }).entry;
    current = evaluateAntagonizeEntry(current, { sensed: false, round: 2, turn: 0 }).entry;
    const stillHeld = evaluateAntagonizeEntry(current, { sensed: false, round: 2, turn: 2 });
    expect(stillHeld.expired).toBe(false);
    expect(evaluateAntagonizeEntry(current, { sensed: false, round: 3, turn: 0 }).expired).toBe(true);
  });
});

describe("isHostileCheckContext", () => {
  it("counts attack rolls, spell attack rolls and damage rolls", () => {
    expect(isHostileCheckContext({ type: "attack-roll" })).toBe(true);
    expect(isHostileCheckContext({ type: "spell-attack-roll" })).toBe(true);
    expect(isHostileCheckContext({ type: "damage-roll" })).toBe(true);
  });

  it("counts an attack-trait skill check (a maneuver) and Demoralize/Feint", () => {
    expect(isHostileCheckContext({ type: "skill-check", options: ["action:trip", "item:trait:attack"] })).toBe(true);
    expect(isHostileCheckContext({ type: "skill-check", options: ["action:demoralize"] })).toBe(true);
    expect(isHostileCheckContext({ type: "skill-check", options: ["action:feint"] })).toBe(true);
  });

  it("does not count a non-hostile skill check, a perception check or a missing context", () => {
    expect(isHostileCheckContext({ type: "skill-check", options: ["action:request"] })).toBe(false);
    expect(isHostileCheckContext({ type: "perception-check", options: [] })).toBe(false);
    expect(isHostileCheckContext(null)).toBe(false);
  });
});

describe("hostileTargetIdsOf", () => {
  it("treats a targeted self-effect feat (Hunt Prey, Devise a Stratagem) as not hostile (#922)", () => {
    expect(hostileTargetIdsOf({ type: "feat", kind: "targetedSelfEffect", targetId: "t1" })).toEqual([]);
    expect(hostileTargetIdsOf({ type: "feat", kind: "composite", targetId: "t1" })).toEqual(["t1"]);
  });

  it("returns the single target of a hostile single-target candidate", () => {
    for (const type of ["strike", "cast", "castAttack", "castDebuff", "multiStrike", "castDualHarm", "maneuver", "feat", "npcAbility"]) {
      expect(hostileTargetIdsOf({ type, targetId: "t1" })).toEqual(["t1"]);
    }
  });

  it("returns every affected id of an area or multi-target candidate", () => {
    expect(hostileTargetIdsOf({ type: "castArea", affectedIds: ["a", "b"] })).toEqual(["a", "b"]);
    expect(hostileTargetIdsOf({ type: "breathWeapon", affectedIds: ["a"] })).toEqual(["a"]);
    expect(hostileTargetIdsOf({ type: "castAreaTier", affectedIds: ["a"] })).toEqual(["a"]);
    expect(hostileTargetIdsOf({ type: "castAutoHitAreaTier", affectedIds: ["a"] })).toEqual(["a"]);
    expect(hostileTargetIdsOf({ type: "castChain", targetId: "a", chainedIds: ["b"] })).toEqual(["a", "b"]);
    expect(hostileTargetIdsOf({ type: "castTargetCount", targetIds: ["a", "b"] })).toEqual(["a", "b"]);
    expect(hostileTargetIdsOf({ type: "castDualArea", harmIds: ["a"], healIds: ["b"] })).toEqual(["a"]);
    expect(hostileTargetIdsOf({ type: "npcAbility", targetId: null, affectedIds: ["a"] })).toEqual(["a"]);
  });

  it("treats a movement ability as hostile only through its Strike (#932)", () => {
    expect(hostileTargetIdsOf({ type: "npcMove", kind: "strike", targetId: "t1" })).toEqual(["t1"]);
    expect(hostileTargetIdsOf({ type: "npcMove", kind: "move", targetId: "t1" })).toEqual([]);
    expect(hostileTargetIdsOf({ type: "npcMove", kind: "teleport", targetId: "t1" })).toEqual([]);
  });

  it("returns nothing for movement, Seek, healing, buffing and self-effect feats", () => {
    for (const type of ["stride", "seek", "castHeal", "castBuff", "castDualHeal", "endTurn"]) {
      expect(hostileTargetIdsOf({ type, targetId: "t1" })).toEqual([]);
    }
    expect(hostileTargetIdsOf({ type: "feat", kind: "selfEffect", targetId: null })).toEqual([]);
    expect(hostileTargetIdsOf(null)).toEqual([]);
  });
});
