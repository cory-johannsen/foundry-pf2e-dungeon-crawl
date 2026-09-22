import { describe, it, expect } from "vitest";
import {
  castSpellAndApplySave,
  castAreaSpellAndApplySaves,
} from "../scripts/dungeon-combat.mjs";

// Same installFoundryStubs/.alter()-stub convention as
// tests/dungeon-combat-cast-attack-spell.test.mjs (#75/#79) and
// tests/dungeon-combat-reactive-strike.test.mjs (#61) -- stubs
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

describe("castSpellAndApplySave basic-save damage scaling (#81)", () => {
  it("criticalSuccess takes zero damage: no .alter() call and no applyDamage call at all", async () => {
    installFoundryStubs();
    const alterCalls = [];
    const spell = makeSpell(makeDamageRoll(alterCalls));
    const combatant = makeCombatant(spell);
    const target = makeTarget("t1", "criticalSuccess");

    const outcome = await castSpellAndApplySave(
      combatant,
      target,
      "spell1",
      "entry1",
      "reflex",
    );

    expect(outcome).toBe("criticalSuccess");
    expect(alterCalls).toEqual([]);
    expect(target.applyDamageCalls).toHaveLength(0);
  });

  it("success halves damage via .alter(0.5, 0)", async () => {
    installFoundryStubs();
    const alterCalls = [];
    const spell = makeSpell(makeDamageRoll(alterCalls));
    const combatant = makeCombatant(spell);
    const target = makeTarget("t1", "success");

    await castSpellAndApplySave(combatant, target, "spell1", "entry1", "reflex");

    expect(alterCalls).toEqual([{ multiplier: 0.5, addend: 0 }]);
    expect(target.applyDamageCalls).toHaveLength(1);
  });

  it("failure applies full, unscaled damage: no .alter() call, but applyDamage IS called", async () => {
    installFoundryStubs();
    const alterCalls = [];
    const spell = makeSpell(makeDamageRoll(alterCalls));
    const combatant = makeCombatant(spell);
    const target = makeTarget("t1", "failure");

    await castSpellAndApplySave(combatant, target, "spell1", "entry1", "reflex");

    expect(alterCalls).toEqual([]);
    expect(target.applyDamageCalls).toHaveLength(1);
  });

  it("criticalFailure doubles damage via .alter(2, 0)", async () => {
    installFoundryStubs();
    const alterCalls = [];
    const spell = makeSpell(makeDamageRoll(alterCalls));
    const combatant = makeCombatant(spell);
    const target = makeTarget("t1", "criticalFailure");

    await castSpellAndApplySave(combatant, target, "spell1", "entry1", "reflex");

    expect(alterCalls).toEqual([{ multiplier: 2, addend: 0 }]);
    expect(target.applyDamageCalls).toHaveLength(1);
  });
});

describe("castAreaSpellAndApplySaves basic-save damage scaling (#81)", () => {
  it("criticalSuccess takes zero damage: no .alter() call and no applyDamage call at all", async () => {
    installFoundryStubs();
    const alterCalls = [];
    const spell = makeSpell(makeDamageRoll(alterCalls));
    const combatant = makeCombatant(spell);
    const target = makeTarget("t1", "criticalSuccess");

    const outcomes = await castAreaSpellAndApplySaves(
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

    await castAreaSpellAndApplySaves(
      combatant,
      [target],
      "spell1",
      "entry1",
      "reflex",
    );

    expect(alterCalls).toEqual([{ multiplier: 0.5, addend: 0 }]);
    expect(target.applyDamageCalls).toHaveLength(1);
  });

  it("failure applies full, unscaled damage: no .alter() call, but applyDamage IS called", async () => {
    installFoundryStubs();
    const alterCalls = [];
    const spell = makeSpell(makeDamageRoll(alterCalls));
    const combatant = makeCombatant(spell);
    const target = makeTarget("t1", "failure");

    await castAreaSpellAndApplySaves(
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

    await castAreaSpellAndApplySaves(
      combatant,
      [target],
      "spell1",
      "entry1",
      "reflex",
    );

    expect(alterCalls).toEqual([{ multiplier: 2, addend: 0 }]);
    expect(target.applyDamageCalls).toHaveLength(1);
  });

  it("resolves independently per target: one succeeds, another critically fails, in the same call", async () => {
    installFoundryStubs();
    const successAlterCalls = [];
    const critFailAlterCalls = [];
    const successSpellDamage = makeDamageRoll(successAlterCalls);
    const critFailSpellDamage = makeDamageRoll(critFailAlterCalls);

    // Each target's own saveStat.roll() pushes its own outcome onto
    // game.messages, and each call to spell.rollDamage() below returns a
    // damage roll scoped to whichever target is currently resolving --
    // rollDamage is invoked once per target in the loop, so a call counter
    // picks the right fake roll for each iteration.
    let rollDamageCallCount = 0;
    const spell = makeSpell(undefined);
    spell.rollDamage = async () => {
      rollDamageCallCount += 1;
      return rollDamageCallCount === 1 ? successSpellDamage : critFailSpellDamage;
    };
    const combatant = makeCombatant(spell);
    const targetA = makeTarget("tA", "success");
    const targetB = makeTarget("tB", "criticalFailure");

    const outcomes = await castAreaSpellAndApplySaves(
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
