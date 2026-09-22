import { describe, it, expect } from "vitest";
import {
  applyBasicSaveDamage,
  castChainSpellAndApplySaves,
  castDualAreaAndApply,
  castTargetCountSpellAndApply,
} from "../scripts/dungeon-combat.mjs";

// Same installFoundryStubs/.alter()-stub convention as
// tests/dungeon-combat-cast-spell-save.test.mjs (#81/#82) -- stubs
// spell.rollDamage() to return a fake roll with a spyable .alter(), and
// stubs game.messages.contents.at(-1) the same way the save roll's own
// outcome is read elsewhere in this codebase.

function installFoundryStubs() {
  globalThis.foundry = { utils: {} };
  globalThis.ChatMessage = {
    create: async () => {},
  };
  globalThis.game = {
    user: {
      isGM: true,
      flags: { pf2e: { settings: {} } },
      update: async () => {},
    },
    i18n: { format: (key) => key },
    messages: { contents: [] },
    packs: { get: () => undefined },
  };
}

function makeDamageRoll(alterCalls) {
  return {
    total: 10,
    alter: async (multiplier, addend) => {
      alterCalls.push({ multiplier, addend });
      return { total: 10 * multiplier, altered: true };
    },
  };
}

function makeSpell(damageRoll) {
  return {
    id: "spell1",
    system: { damage: { d1: { type: "fire" } } },
    rollDamage: async () => damageRoll,
  };
}

function makeCombatant(spell) {
  return {
    actor: {
      spellcasting: {
        contents: [
          {
            id: "entry1",
            statistic: { dc: { value: 20 } },
            cast: async () => {},
            spells: { contents: [spell] },
          },
        ],
      },
    },
  };
}

function makeTarget(id, outcome) {
  const applyDamageCalls = [];
  return {
    id,
    token: {},
    actor: {
      saves: {
        reflex: {
          roll: async () => {
            game.messages.contents.push({
              flags: { pf2e: { context: { outcome } } },
            });
          },
        },
      },
      applyDamage: async (args) => applyDamageCalls.push(args),
    },
    applyDamageCalls,
  };
}

describe("applyBasicSaveDamage (#83 shared helper)", () => {
  it("criticalSuccess takes zero damage: no .alter() call and no applyDamage call at all", async () => {
    installFoundryStubs();
    const alterCalls = [];
    const damageRoll = makeDamageRoll(alterCalls);
    const target = makeTarget("t1", "criticalSuccess");

    await applyBasicSaveDamage(damageRoll, "criticalSuccess", target);

    expect(alterCalls).toEqual([]);
    expect(target.applyDamageCalls).toHaveLength(0);
  });

  it("success halves damage via .alter(0.5, 0)", async () => {
    installFoundryStubs();
    const alterCalls = [];
    const damageRoll = makeDamageRoll(alterCalls);
    const target = makeTarget("t1", "success");

    await applyBasicSaveDamage(damageRoll, "success", target);

    expect(alterCalls).toEqual([{ multiplier: 0.5, addend: 0 }]);
    expect(target.applyDamageCalls).toHaveLength(1);
  });

  it("failure applies full, unscaled damage: no .alter() call, but applyDamage IS called", async () => {
    installFoundryStubs();
    const alterCalls = [];
    const damageRoll = makeDamageRoll(alterCalls);
    const target = makeTarget("t1", "failure");

    await applyBasicSaveDamage(damageRoll, "failure", target);

    expect(alterCalls).toEqual([]);
    expect(target.applyDamageCalls).toHaveLength(1);
  });

  it("criticalFailure doubles damage via .alter(2, 0)", async () => {
    installFoundryStubs();
    const alterCalls = [];
    const damageRoll = makeDamageRoll(alterCalls);
    const target = makeTarget("t1", "criticalFailure");

    await applyBasicSaveDamage(damageRoll, "criticalFailure", target);

    expect(alterCalls).toEqual([{ multiplier: 2, addend: 0 }]);
    expect(target.applyDamageCalls).toHaveLength(1);
  });

  it("does nothing when there is no damage roll at all", async () => {
    installFoundryStubs();
    const target = makeTarget("t1", "failure");

    await applyBasicSaveDamage(null, "failure", target);

    expect(target.applyDamageCalls).toHaveLength(0);
  });
});

describe("castChainSpellAndApplySaves basic-save damage scaling (#83)", () => {
  it("criticalSuccess takes zero damage and stops the chain", async () => {
    installFoundryStubs();
    const alterCalls = [];
    const spell = makeSpell(makeDamageRoll(alterCalls));
    const combatant = makeCombatant(spell);
    const targetA = makeTarget("tA", "criticalSuccess");
    const targetB = makeTarget("tB", "failure");

    const outcomes = await castChainSpellAndApplySaves(
      combatant,
      [targetA, targetB],
      "spell1",
      "entry1",
      "reflex",
    );

    expect(outcomes).toEqual([{ targetId: "tA", outcome: "criticalSuccess" }]);
    expect(alterCalls).toEqual([]);
    expect(targetA.applyDamageCalls).toHaveLength(0);
    expect(targetB.applyDamageCalls).toHaveLength(0);
  });

  it("success halves damage via .alter(0.5, 0)", async () => {
    installFoundryStubs();
    const alterCalls = [];
    const spell = makeSpell(makeDamageRoll(alterCalls));
    const combatant = makeCombatant(spell);
    const target = makeTarget("t1", "success");

    await castChainSpellAndApplySaves(
      combatant,
      [target],
      "spell1",
      "entry1",
      "reflex",
    );

    expect(alterCalls).toEqual([{ multiplier: 0.5, addend: 0 }]);
    expect(target.applyDamageCalls).toHaveLength(1);
  });

  it("failure applies full, unscaled damage", async () => {
    installFoundryStubs();
    const alterCalls = [];
    const spell = makeSpell(makeDamageRoll(alterCalls));
    const combatant = makeCombatant(spell);
    const target = makeTarget("t1", "failure");

    await castChainSpellAndApplySaves(
      combatant,
      [target],
      "spell1",
      "entry1",
      "reflex",
    );

    expect(alterCalls).toEqual([]);
    expect(target.applyDamageCalls).toHaveLength(1);
  });

  it("criticalFailure doubles damage via .alter(2, 0)", async () => {
    installFoundryStubs();
    const alterCalls = [];
    const spell = makeSpell(makeDamageRoll(alterCalls));
    const combatant = makeCombatant(spell);
    const target = makeTarget("t1", "criticalFailure");

    await castChainSpellAndApplySaves(
      combatant,
      [target],
      "spell1",
      "entry1",
      "reflex",
    );

    expect(alterCalls).toEqual([{ multiplier: 2, addend: 0 }]);
    expect(target.applyDamageCalls).toHaveLength(1);
  });

  it("resolves independently per target down the chain when no criticalSuccess occurs", async () => {
    installFoundryStubs();
    const successAlterCalls = [];
    const critFailAlterCalls = [];
    const successSpellDamage = makeDamageRoll(successAlterCalls);
    const critFailSpellDamage = makeDamageRoll(critFailAlterCalls);

    let rollDamageCallCount = 0;
    const spell = makeSpell(undefined);
    spell.rollDamage = async () => {
      rollDamageCallCount += 1;
      return rollDamageCallCount === 1 ? successSpellDamage : critFailSpellDamage;
    };
    const combatant = makeCombatant(spell);
    const targetA = makeTarget("tA", "success");
    const targetB = makeTarget("tB", "criticalFailure");

    const outcomes = await castChainSpellAndApplySaves(
      combatant,
      [targetA, targetB],
      "spell1",
      "entry1",
      "reflex",
    );

    expect(outcomes).toEqual([
      { targetId: "tA", outcome: "success" },
      { targetId: "tB", outcome: "criticalFailure" },
    ]);
    expect(successAlterCalls).toEqual([{ multiplier: 0.5, addend: 0 }]);
    expect(critFailAlterCalls).toEqual([{ multiplier: 2, addend: 0 }]);
    expect(targetA.applyDamageCalls).toHaveLength(1);
    expect(targetB.applyDamageCalls).toHaveLength(1);
  });
});

describe("castDualAreaAndApply harmTargets basic-save damage scaling (#83)", () => {
  it("criticalSuccess takes zero damage: no .alter() call and no applyDamage call at all", async () => {
    installFoundryStubs();
    const alterCalls = [];
    const spell = makeSpell(makeDamageRoll(alterCalls));
    const combatant = makeCombatant(spell);
    const target = makeTarget("t1", "criticalSuccess");

    const outcomes = await castDualAreaAndApply(
      combatant,
      [target],
      [],
      "spell1",
      "entry1",
      "reflex",
    );

    expect(outcomes).toEqual([
      { targetId: "t1", effect: "harm", outcome: "criticalSuccess" },
    ]);
    expect(alterCalls).toEqual([]);
    expect(target.applyDamageCalls).toHaveLength(0);
  });

  it("success halves damage via .alter(0.5, 0)", async () => {
    installFoundryStubs();
    const alterCalls = [];
    const spell = makeSpell(makeDamageRoll(alterCalls));
    const combatant = makeCombatant(spell);
    const target = makeTarget("t1", "success");

    await castDualAreaAndApply(
      combatant,
      [target],
      [],
      "spell1",
      "entry1",
      "reflex",
    );

    expect(alterCalls).toEqual([{ multiplier: 0.5, addend: 0 }]);
    expect(target.applyDamageCalls).toHaveLength(1);
  });

  it("failure applies full, unscaled damage", async () => {
    installFoundryStubs();
    const alterCalls = [];
    const spell = makeSpell(makeDamageRoll(alterCalls));
    const combatant = makeCombatant(spell);
    const target = makeTarget("t1", "failure");

    await castDualAreaAndApply(
      combatant,
      [target],
      [],
      "spell1",
      "entry1",
      "reflex",
    );

    expect(alterCalls).toEqual([]);
    expect(target.applyDamageCalls).toHaveLength(1);
  });

  it("criticalFailure doubles damage via .alter(2, 0)", async () => {
    installFoundryStubs();
    const alterCalls = [];
    const spell = makeSpell(makeDamageRoll(alterCalls));
    const combatant = makeCombatant(spell);
    const target = makeTarget("t1", "criticalFailure");

    await castDualAreaAndApply(
      combatant,
      [target],
      [],
      "spell1",
      "entry1",
      "reflex",
    );

    expect(alterCalls).toEqual([{ multiplier: 2, addend: 0 }]);
    expect(target.applyDamageCalls).toHaveLength(1);
  });

  it("resolves independently per harm target, and leaves healTargets' own unscaled heal roll alone", async () => {
    installFoundryStubs();
    const successAlterCalls = [];
    const critFailAlterCalls = [];
    const successSpellDamage = makeDamageRoll(successAlterCalls);
    const critFailSpellDamage = makeDamageRoll(critFailAlterCalls);
    const healRoll = { total: 7 };

    let rollDamageCallCount = 0;
    const spell = makeSpell(undefined);
    spell.rollDamage = async () => {
      rollDamageCallCount += 1;
      if (rollDamageCallCount === 1) return successSpellDamage;
      if (rollDamageCallCount === 2) return critFailSpellDamage;
      return healRoll;
    };
    const combatant = makeCombatant(spell);
    const harmA = makeTarget("hA", "success");
    const harmB = makeTarget("hB", "criticalFailure");
    const healTarget = makeTarget("healA", null);

    const outcomes = await castDualAreaAndApply(
      combatant,
      [harmA, harmB],
      [healTarget],
      "spell1",
      "entry1",
      "reflex",
    );

    expect(outcomes).toEqual([
      { targetId: "hA", effect: "harm", outcome: "success" },
      { targetId: "hB", effect: "harm", outcome: "criticalFailure" },
      { targetId: "healA", effect: "heal", healed: 7 },
    ]);
    expect(successAlterCalls).toEqual([{ multiplier: 0.5, addend: 0 }]);
    expect(critFailAlterCalls).toEqual([{ multiplier: 2, addend: 0 }]);
    expect(harmA.applyDamageCalls).toHaveLength(1);
    expect(harmB.applyDamageCalls).toHaveLength(1);
    expect(healTarget.applyDamageCalls).toHaveLength(1);
    expect(healTarget.applyDamageCalls[0]).toEqual({ damage: -7, token: {} });
  });
});

describe("castTargetCountSpellAndApply save branch basic-save damage scaling (#83)", () => {
  it("criticalSuccess takes zero damage: no .alter() call and no applyDamage call at all", async () => {
    installFoundryStubs();
    const alterCalls = [];
    const spell = makeSpell(makeDamageRoll(alterCalls));
    const combatant = makeCombatant(spell);
    const target = makeTarget("t1", "criticalSuccess");

    const outcomes = await castTargetCountSpellAndApply(
      combatant,
      [target],
      "spell1",
      "entry1",
      "reflex",
    );

    expect(outcomes).toEqual([{ targetId: "t1", outcome: "criticalSuccess" }]);
    expect(alterCalls).toEqual([]);
    expect(target.applyDamageCalls).toHaveLength(0);
  });

  it("success halves damage via .alter(0.5, 0)", async () => {
    installFoundryStubs();
    const alterCalls = [];
    const spell = makeSpell(makeDamageRoll(alterCalls));
    const combatant = makeCombatant(spell);
    const target = makeTarget("t1", "success");

    await castTargetCountSpellAndApply(
      combatant,
      [target],
      "spell1",
      "entry1",
      "reflex",
    );

    expect(alterCalls).toEqual([{ multiplier: 0.5, addend: 0 }]);
    expect(target.applyDamageCalls).toHaveLength(1);
  });

  it("failure applies full, unscaled damage", async () => {
    installFoundryStubs();
    const alterCalls = [];
    const spell = makeSpell(makeDamageRoll(alterCalls));
    const combatant = makeCombatant(spell);
    const target = makeTarget("t1", "failure");

    await castTargetCountSpellAndApply(
      combatant,
      [target],
      "spell1",
      "entry1",
      "reflex",
    );

    expect(alterCalls).toEqual([]);
    expect(target.applyDamageCalls).toHaveLength(1);
  });

  it("criticalFailure doubles damage via .alter(2, 0)", async () => {
    installFoundryStubs();
    const alterCalls = [];
    const spell = makeSpell(makeDamageRoll(alterCalls));
    const combatant = makeCombatant(spell);
    const target = makeTarget("t1", "criticalFailure");

    await castTargetCountSpellAndApply(
      combatant,
      [target],
      "spell1",
      "entry1",
      "reflex",
    );

    expect(alterCalls).toEqual([{ multiplier: 2, addend: 0 }]);
    expect(target.applyDamageCalls).toHaveLength(1);
  });

  it("no-save branch (healing) is untouched by outcome scaling", async () => {
    installFoundryStubs();
    const spell = makeSpell(undefined);
    spell.rollDamage = async () => ({ total: 12 });
    const combatant = makeCombatant(spell);
    const target = makeTarget("t1", null);

    const outcomes = await castTargetCountSpellAndApply(
      combatant,
      [target],
      "spell1",
      "entry1",
      null,
    );

    expect(outcomes).toEqual([{ targetId: "t1", healed: 12 }]);
    expect(target.applyDamageCalls).toEqual([{ damage: -12, token: {} }]);
  });
});
