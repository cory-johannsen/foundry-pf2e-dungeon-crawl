import { describe, it, expect } from "vitest";
import { castAttackSpellAndApplyRoll } from "../scripts/dungeon-combat.mjs";

// Same installFoundryStubs/.alter()-stub convention as
// tests/dungeon-combat-reactive-strike.test.mjs (#61) and the same real
// critical-deck card fixture HTML as tests/dungeon-critical-deck.test.mjs,
// trimmed to just the "Bomb or Spell" sub-entry each test needs -- the
// spell-attack call site always draws category "Bomb or Spell" (it has no
// weapon damage type to map through hitDeckCategory).

function installFoundryStubs() {
  globalThis.foundry = { utils: {} };
  globalThis.ChatMessage = {
    create: async (data) => {
      ChatMessage.calls.push(data);
    },
    calls: [],
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

function makeDoc(name, html) {
  return { name, pages: [{ text: { content: html } }] };
}

function installCriticalDeckPack(docs) {
  game.packs = {
    get: (id) =>
      id === "pf2e.criticaldeck" ? { getDocuments: async () => docs } : undefined,
  };
}

// Real fixture prose from tests/dungeon-critical-deck.test.mjs's own
// HIT_DECK_10/HIT_DECK_37 fixtures, trimmed to one sub-entry each.
const HIT_DECK_DISEMBOWEL =
  '<section class="critical-deck"><h1>Disembowel</h1><blockquote><p>Triple damage.</p></blockquote><p><code>Bomb or Spell</code></p></section>';
const HIT_DECK_CORROSIVE =
  '<section class="critical-deck"><h1>Corrosive</h1><blockquote><p>If this is an acid bomb or spell, the target takes triple damage. Any other bomb or spell deals double damage.</p></blockquote><p><code>Bomb or Spell</code></p></section>';
const HIT_DECK_NO_MULTIPLIER =
  '<section class="critical-deck"><h1>Concussion</h1><blockquote><p>Normal damage.</p></blockquote><p><code>Bomb or Spell</code></p></section>';

// #976: a real CheckRoll's d20 Die term shape (`dice[].faces`/`results[]`,
// as read live off a stored attack message) -- the natural face is what
// gates a critical-deck card draw, not the outcome alone.
function d20Roll(face) {
  return { dice: [{ faces: 20, results: [{ result: face, active: true }] }] };
}

function makeSpell({
  damageType = "acid",
  outcome = "criticalSuccess",
  natural = outcome === "criticalSuccess" ? 20 : outcome === "criticalFailure" ? 1 : 10,
  damageRoll,
} = {}) {
  return {
    id: "spell1",
    system: { damage: { d1: { type: damageType } } },
    rollAttack: async () => {
      game.messages.contents.push({
        flags: { pf2e: { context: { outcome } } },
        rolls: [d20Roll(natural)],
      });
    },
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
            cast: async () => {},
            spells: { contents: [spell] },
          },
        ],
      },
    },
  };
}

function makeTarget() {
  const applyDamageCalls = [];
  return {
    token: {},
    actor: {
      applyDamage: async (args) => applyDamageCalls.push(args),
    },
    applyDamageCalls,
  };
}

function makeDamageRoll(alterCalls) {
  return {
    total: 4,
    alter: async (multiplier, addend) => {
      alterCalls.push({ multiplier, addend });
    },
  };
}

describe("castAttackSpellAndApplyRoll critical-deck damage multiplier (#75)", () => {
  it("applies a flat-triple card's multiplier to the spell damage roll", async () => {
    installFoundryStubs();
    installCriticalDeckPack([makeDoc("Critical Hit Deck #10", HIT_DECK_DISEMBOWEL)]);
    const alterCalls = [];
    const spell = makeSpell({ damageType: "acid", damageRoll: makeDamageRoll(alterCalls) });
    const combatant = makeCombatant(spell);
    const target = makeTarget();

    await castAttackSpellAndApplyRoll(combatant, target, "spell1", "entry1");

    expect(alterCalls).toEqual([{ multiplier: 3, addend: 0 }]);
    expect(target.applyDamageCalls).toHaveLength(1);
  });

  it("triples for a conditional card when the spell's damage type matches (Corrosive, acid)", async () => {
    installFoundryStubs();
    installCriticalDeckPack([makeDoc("Critical Hit Deck #37", HIT_DECK_CORROSIVE)]);
    const alterCalls = [];
    const spell = makeSpell({ damageType: "acid", damageRoll: makeDamageRoll(alterCalls) });
    const combatant = makeCombatant(spell);
    const target = makeTarget();

    await castAttackSpellAndApplyRoll(combatant, target, "spell1", "entry1");

    expect(alterCalls).toEqual([{ multiplier: 3, addend: 0 }]);
  });

  it("only doubles for a conditional card when the spell's damage type doesn't match (Corrosive, fire)", async () => {
    installFoundryStubs();
    installCriticalDeckPack([makeDoc("Critical Hit Deck #37", HIT_DECK_CORROSIVE)]);
    const alterCalls = [];
    const spell = makeSpell({ damageType: "fire", damageRoll: makeDamageRoll(alterCalls) });
    const combatant = makeCombatant(spell);
    const target = makeTarget();

    await castAttackSpellAndApplyRoll(combatant, target, "spell1", "entry1");

    expect(alterCalls).toEqual([{ multiplier: 2, addend: 0 }]);
  });

  it("applies PF2e's own baseline crit-doubling (#79) when the drawn card carries no multiplier text", async () => {
    installFoundryStubs();
    installCriticalDeckPack([makeDoc("Critical Hit Deck #10", HIT_DECK_NO_MULTIPLIER)]);
    const alterCalls = [];
    const spell = makeSpell({ damageType: "acid", damageRoll: makeDamageRoll(alterCalls) });
    const combatant = makeCombatant(spell);
    const target = makeTarget();

    await castAttackSpellAndApplyRoll(combatant, target, "spell1", "entry1");

    expect(alterCalls).toEqual([{ multiplier: 2, addend: 0 }]);
    expect(target.applyDamageCalls).toHaveLength(1);
  });

  it("applies PF2e's own baseline crit-doubling (#79) when no critical-deck pack is available", async () => {
    installFoundryStubs();
    const alterCalls = [];
    const spell = makeSpell({ damageType: "acid", damageRoll: makeDamageRoll(alterCalls) });
    const combatant = makeCombatant(spell);
    const target = makeTarget();

    await castAttackSpellAndApplyRoll(combatant, target, "spell1", "entry1");

    expect(alterCalls).toEqual([{ multiplier: 2, addend: 0 }]);
    expect(target.applyDamageCalls).toHaveLength(1);
  });

  it("never draws a card or scales damage on a plain success (not a crit)", async () => {
    installFoundryStubs();
    installCriticalDeckPack([makeDoc("Critical Hit Deck #10", HIT_DECK_DISEMBOWEL)]);
    const alterCalls = [];
    const spell = makeSpell({
      damageType: "acid",
      outcome: "success",
      damageRoll: makeDamageRoll(alterCalls),
    });
    const combatant = makeCombatant(spell);
    const target = makeTarget();

    await castAttackSpellAndApplyRoll(combatant, target, "spell1", "entry1");

    expect(alterCalls).toEqual([]);
    expect(ChatMessage.calls).toEqual([]);
    expect(target.applyDamageCalls).toHaveLength(1);
  });

  // #976: cards only draw on a natural 20 crit / natural 1 fumble.
  it("draws no card on a 10+-margin crit (natural 15) but still applies PF2e's baseline crit doubling", async () => {
    installFoundryStubs();
    installCriticalDeckPack([makeDoc("Critical Hit Deck #10", HIT_DECK_DISEMBOWEL)]);
    const alterCalls = [];
    const spell = makeSpell({
      damageType: "acid",
      natural: 15,
      damageRoll: makeDamageRoll(alterCalls),
    });
    const combatant = makeCombatant(spell);
    const target = makeTarget();

    await castAttackSpellAndApplyRoll(combatant, target, "spell1", "entry1");

    expect(ChatMessage.calls).toEqual([]);
    expect(alterCalls).toEqual([{ multiplier: 2, addend: 0 }]);
    expect(target.applyDamageCalls).toHaveLength(1);
  });

  it("draws no card on a crit whose attack message carries no readable d20 (missing data never draws)", async () => {
    installFoundryStubs();
    installCriticalDeckPack([makeDoc("Critical Hit Deck #10", HIT_DECK_DISEMBOWEL)]);
    const alterCalls = [];
    const spell = makeSpell({ damageType: "acid", damageRoll: makeDamageRoll(alterCalls) });
    spell.rollAttack = async () => {
      game.messages.contents.push({
        flags: { pf2e: { context: { outcome: "criticalSuccess" } } },
      });
    };
    const combatant = makeCombatant(spell);
    const target = makeTarget();

    await castAttackSpellAndApplyRoll(combatant, target, "spell1", "entry1");

    expect(ChatMessage.calls).toEqual([]);
    expect(alterCalls).toEqual([{ multiplier: 2, addend: 0 }]);
  });

  it("draws a Fumble card only on a natural-1 critical failure, not a 10+-margin one", async () => {
    const FUMBLE_SPELL =
      '<section class="fumble-deck"><h1>Electrical Feedback</h1><blockquote><p>Your spell fizzles.</p></blockquote><p><code>Spell</code></p></section>';

    installFoundryStubs();
    installCriticalDeckPack([makeDoc("Critical Fumble Deck #14", FUMBLE_SPELL)]);
    await castAttackSpellAndApplyRoll(
      makeCombatant(makeSpell({ outcome: "criticalFailure", natural: 6 })),
      makeTarget(),
      "spell1",
      "entry1",
    );
    expect(ChatMessage.calls).toEqual([]);

    installFoundryStubs();
    installCriticalDeckPack([makeDoc("Critical Fumble Deck #14", FUMBLE_SPELL)]);
    await castAttackSpellAndApplyRoll(
      makeCombatant(makeSpell({ outcome: "criticalFailure", natural: 1 })),
      makeTarget(),
      "spell1",
      "entry1",
    );
    expect(ChatMessage.calls).toHaveLength(1);
    expect(ChatMessage.calls[0].content).toContain("Your spell fizzles.");
  });
});
