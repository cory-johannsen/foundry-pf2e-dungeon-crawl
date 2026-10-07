
import { describe, it, expect } from "vitest";
import { subtractXpOnLevelUp } from "../scripts/dungeon-leveling.mjs";

function actor({ type = "character", level = 2, xp = 1848, max = 1000, flags = {} } = {}) {
  const a = {
    type,
    system: { details: { level: { value: level }, xp: { value: xp, max } } },
    getFlag: (_m, k) => flags[k],
    update: async function (changes) {
      Object.assign(a._lastUpdate = {}, changes);
      if ("system.details.xp.value" in changes) a.system.details.xp.value = changes["system.details.xp.value"];
      for (const [k, v] of Object.entries(changes)) {
        const m = /^flags\.pf2e-dungeon-crawl\.(.+)$/.exec(k);
        if (m) flags[m[1]] = v;
      }
    },
  };
  return a;
}

describe("#853 subtractXpOnLevelUp", () => {
  it("subtracts one xp.max on a single level increase, carry-over remains", async () => {
    const a = actor({ level: 2, xp: 1848, max: 1000 });
    await subtractXpOnLevelUp(a, { system: { details: { level: { value: 2 } } } });
    expect(a.system.details.xp.value).toBe(848);
  });

  it("subtracts xp.max per level on a multi-level jump in one update", async () => {
    const a = actor({ level: 3, xp: 2500, max: 1000, flags: { xpSubtractedThroughLevel: 1 } });
    await subtractXpOnLevelUp(a, { system: { details: { level: { value: 3 } } } });
    expect(a.system.details.xp.value).toBe(500); // 2500 - 1000*2
  });

  it("clamps to 0, never negative", async () => {
    const a = actor({ level: 2, xp: 400, max: 1000 });
    await subtractXpOnLevelUp(a, { system: { details: { level: { value: 2 } } } });
    expect(a.system.details.xp.value).toBe(0);
  });

  it("clears the readyToLevelUp flag and records the handled level", async () => {
    const a = actor({ level: 2, xp: 1200, max: 1000, flags: { readyToLevelUp: true } });
    await subtractXpOnLevelUp(a, { system: { details: { level: { value: 2 } } } });
    expect(a.getFlag("pf2e-dungeon-crawl", "readyToLevelUp")).toBe(false);
    expect(a.getFlag("pf2e-dungeon-crawl", "xpSubtractedThroughLevel")).toBe(2);
  });

  it("is a no-op when changes has no level field (an unrelated actor update)", async () => {
    const a = actor({ level: 2, xp: 1848 });
    let updated = false;
    a.update = async () => { updated = true; };
    await subtractXpOnLevelUp(a, { system: { attributes: { hp: { value: 10 } } } });
    expect(updated).toBe(false);
  });

  it("is a no-op for an already-handled level (no re-subtraction on a later, unrelated update)", async () => {
    const a = actor({ level: 2, xp: 848, flags: { xpSubtractedThroughLevel: 2 } });
    let updated = false;
    a.update = async () => { updated = true; };
    await subtractXpOnLevelUp(a, { system: { details: { level: { value: 2 } } } });
    expect(updated).toBe(false);
  });

  it("ignores a non-character actor", async () => {
    const a = actor({ type: "npc", level: 2, xp: 1848 });
    let updated = false;
    a.update = async () => { updated = true; };
    await subtractXpOnLevelUp(a, { system: { details: { level: { value: 2 } } } });
    expect(updated).toBe(false);
  });

  it("never writes a level (cannot re-trigger itself via updateActor)", async () => {
    const a = actor({ level: 2, xp: 1848, max: 1000 });
    await subtractXpOnLevelUp(a, { system: { details: { level: { value: 2 } } } });
    expect(a._lastUpdate).toBeDefined();
    expect(Object.keys(a._lastUpdate).some((k) => k.startsWith("system.details.level"))).toBe(false);
    expect(a._lastUpdate["flags.pf2e-dungeon-crawl.xpSubtractedThroughLevel"]).toBe(2);
  });
});
