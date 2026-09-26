import { describe, it, expect } from "vitest";
import { handleManualStrikeDamage } from "../scripts/dungeon-combat.mjs";

function installFoundryStubs() {
  globalThis.foundry = {
    audio: { AudioHelper: { play: () => ({ catch: () => {} }) } },
  };
  globalThis.game = {
    user: { isGM: true },
    actors: { party: { members: [{ id: "party-actor-1" }] } },
    combats: { contents: [] },
  };
}

function makeAttackerCombatant({
  id = "attacker1",
  tokenId = "attacker-token",
  actorId = "party-actor-1",
  agentControlled = false,
  hasPlayerOwner = true,
  isDefeated = false,
} = {}) {
  const flags = { agentControlled };
  return {
    id,
    tokenId,
    isDefeated,
    getFlag: (_moduleId, key) => flags[key],
    actor: { id: actorId, hasPlayerOwner },
  };
}

function makeTargetCombatant({
  id = "target1",
  tokenId = "target-token",
  hp = 10,
} = {}) {
  const applyDamageCalls = [];
  return {
    id,
    tokenId,
    isDefeated: false,
    token: { id: tokenId },
    actor: {
      type: "npc",
      applyDamage: async (args) => {
        applyDamageCalls.push(args);
      },
      increaseCondition: async () => {},
      system: { attributes: { hp: { value: hp } } },
    },
    applyDamageCalls,
  };
}

function makeCombat({ combatants = [], sceneId = "scene1" } = {}) {
  const flags = { dungeonSlot: 1 };
  return {
    combatants,
    scene: { id: sceneId },
    getFlag: (_moduleId, key) => flags[key],
  };
}

function makeMessage({
  type = "damage-roll",
  sceneId = "scene1",
  attackerTokenId = "attacker-token",
  targetTokenUuid = "Scene.scene1.Token.target-token",
  outcome = "success",
  appliedDamage = undefined,
  roll = { total: 7 },
  options = ["item:type:weapon"],
  item = null,
} = {}) {
  const updateCalls = [];
  return {
    flags: {
      pf2e: {
        context: { type, target: { token: targetTokenUuid }, outcome, options },
        appliedDamage,
      },
    },
    speaker: { scene: sceneId, token: attackerTokenId },
    rolls: [roll],
    // PF2e's own `ChatMessagePF2e#item` getter, resolving straight to the
    // live weapon Item off the attacker's actor via the message's stored
    // origin flag -- not a stale clone, so a fumble-deck weapon-damage
    // directive mutates the attacker's real weapon. `handleManualStrikeDamage`
    // has no live `strike` action object of its own (unlike
    // `rollAndApplyStrike`, which rolled the Strike itself), so this is the
    // only source it has for #92's card-draw inputs.
    item,
    update: async (changes) => updateCalls.push(changes),
    updateCalls,
  };
}

// A real weapon Item's shape needed by drawCriticalCardForStrike/
// drawAndApplyCriticalCard -- `isRanged`, `system.damage.damageType`
// (hitDeckCategory/soundContext), `system.category` (isUnarmed check), and
// `system.hp` (a fumble's weapon-HP-damage directive, #60).
function makeWeaponItem({
  damageType = "slashing",
  isRanged = false,
  category = "martial",
  hp,
} = {}) {
  const updateCalls = [];
  return {
    name: "Test Weapon",
    isRanged,
    system: {
      category,
      damage: { damageType },
      ...(hp ? { hp } : {}),
    },
    update: async (data) => updateCalls.push(data),
    updateCalls,
  };
}

// Real fixture content pulled directly from the live pf2e.criticaldeck pack
// (see tests/dungeon-critical-deck.test.mjs's own HIT_DECK_1/FUMBLE_DECK_14
// for the same source) -- single-category matches per card so
// `pickSubentry`'s randomness never makes these tests flaky.
const HIT_DECK_1 =
  '<section class="critical-deck"><h1>Crunch</h1><blockquote><p><strong>Crit Effect:</strong> The target is @UUID[Compendium.pf2e.conditionitems.Item.Sickened]{Sickened 3}.</p></blockquote><p><code>Bludgeoning</code></p><h1>Forearm Piercing</h1><blockquote><p><strong>Crit Effect:</strong> The target drops one weapon it\'s holding (chosen randomly by the GM).</p></blockquote><p><code>Piercing</code></p><h1>Surprise Opening</h1><blockquote><p><strong>Crit Effect:</strong> You gain 1 action that you can use before the end of your turn to use an attack action against the target.</p></blockquote><p><code>Slashing</code></p><h1>Allergic reaction</h1><blockquote><p>The target takes @Damage[1d8[poison]] damage.</p></blockquote><p><code>Bomb or Spell</code></p></section>';

const FUMBLE_DECK_14 =
  '<section class="fumble-deck"><h1>Notched</h1><blockquote><p>Your weapon takes @Damage[1d6] damage, ignoring Hardness.</p></blockquote><p><code>Melee</code></p><h1>Notched Fingers</h1><blockquote><p>You take @Damage[1d4[bleed]].</p></blockquote><p><code>Ranged</code></p><h1>Hit the Wall</h1><blockquote><p>You are @UUID[Compendium.pf2e.conditionitems.Item.Fatigued].</p></blockquote><p><code>Unarmed</code></p><h1>Electrical Feedback</h1><blockquote><p>You take @Damage[2d6[electricity]] damage.</p></blockquote><p><code>Spell</code></p></section>';

function makeDoc(name, html) {
  return { name, pages: [{ text: { content: html } }] };
}

// Layered on top of installFoundryStubs() -- adds the critical-deck pack,
// ChatMessage, i18n and Roll stubs #92's new card-draw path needs, matching
// tests/dungeon-critical-deck.test.mjs's own installFoundryStubs convention.
function installCriticalDeckStubs({ docs }) {
  globalThis.foundry.utils = { escapeHTML: (s) => s };
  globalThis.ChatMessage = {
    create: async (data) => {
      ChatMessage.calls.push(data);
    },
    calls: [],
  };
  globalThis.game.i18n = { format: (key) => key };
  globalThis.game.packs = {
    get: (id) =>
      id === "pf2e.criticaldeck"
        ? { getDocuments: async () => docs }
        : undefined,
  };
  globalThis.Roll = class {
    constructor(formula) {
      this.formula = formula;
    }
    async evaluate() {
      this.total = 3;
      return this;
    }
  };
}

describe("handleManualStrikeDamage", () => {
  it("applies damage to the roll's own stored target for a human party member's manual strike", async () => {
    installFoundryStubs();
    const attacker = makeAttackerCombatant();
    const target = makeTargetCombatant();
    const combat = makeCombat({ combatants: [attacker, target] });
    game.combats.contents.push(combat);

    const message = makeMessage();
    await handleManualStrikeDamage(message);

    expect(target.applyDamageCalls).toHaveLength(1);
    expect(target.applyDamageCalls[0]).toMatchObject({
      damage: { total: 7 },
      token: target.token,
      outcome: "success",
    });
    expect(message.updateCalls).toEqual([
      { "flags.pf2e.appliedDamage": { uuid: target.actor.uuid } },
    ]);
  });

  it("ignores a damage-roll message with no weapon/melee item-type tag (e.g. a spell)", async () => {
    installFoundryStubs();
    const attacker = makeAttackerCombatant();
    const target = makeTargetCombatant();
    const combat = makeCombat({ combatants: [attacker, target] });
    game.combats.contents.push(combat);

    await handleManualStrikeDamage(
      makeMessage({ options: ["item:type:spell"] }),
    );

    expect(target.applyDamageCalls).toHaveLength(0);
  });

  it("marks the target defeated via toggleDefeated (#152: the real Dead-condition path, not a hand-rolled update)", async () => {
    installFoundryStubs();
    const attacker = makeAttackerCombatant();
    const target = makeTargetCombatant({ hp: 0 });
    let toggleDefeatedCalls = 0;
    target.toggleDefeated = async () => {
      toggleDefeatedCalls += 1;
    };
    const combat = makeCombat({ combatants: [attacker, target] });
    game.combats.contents.push(combat);

    await handleManualStrikeDamage(makeMessage());

    expect(toggleDefeatedCalls).toBe(1);
  });

  it("ignores a message that isn't a damage-roll", async () => {
    installFoundryStubs();
    const attacker = makeAttackerCombatant();
    const target = makeTargetCombatant();
    const combat = makeCombat({ combatants: [attacker, target] });
    game.combats.contents.push(combat);

    await handleManualStrikeDamage(makeMessage({ type: "attack-roll" }));

    expect(target.applyDamageCalls).toHaveLength(0);
  });

  it("ignores a message already carrying appliedDamage (defensive double-apply guard)", async () => {
    installFoundryStubs();
    const attacker = makeAttackerCombatant();
    const target = makeTargetCombatant();
    const combat = makeCombat({ combatants: [attacker, target] });
    game.combats.contents.push(combat);

    await handleManualStrikeDamage(
      makeMessage({ appliedDamage: { uuid: "Actor.someone" } }),
    );

    expect(target.applyDamageCalls).toHaveLength(0);
  });

  it("ignores a combat this module doesn't own", async () => {
    installFoundryStubs();
    const attacker = makeAttackerCombatant();
    const target = makeTargetCombatant();
    const combat = {
      combatants: [attacker, target],
      scene: { id: "scene1" },
      getFlag: () => undefined,
    };
    game.combats.contents.push(combat);

    await handleManualStrikeDamage(makeMessage());

    expect(target.applyDamageCalls).toHaveLength(0);
  });

  it("skips an agent-controlled combatant's strike (already applied by rollAndApplyStrike)", async () => {
    installFoundryStubs();
    const attacker = makeAttackerCombatant({ agentControlled: true });
    const target = makeTargetCombatant();
    const combat = makeCombat({ combatants: [attacker, target] });
    game.combats.contents.push(combat);

    await handleManualStrikeDamage(makeMessage());

    expect(target.applyDamageCalls).toHaveLength(0);
  });

  it("skips a non-party NPC attacker (already applied by rollAndApplyStrike)", async () => {
    installFoundryStubs();
    const attacker = makeAttackerCombatant({
      actorId: "npc-actor-1",
      hasPlayerOwner: false,
    });
    const target = makeTargetCombatant();
    const combat = makeCombat({ combatants: [attacker, target] });
    game.combats.contents.push(combat);

    await handleManualStrikeDamage(makeMessage());

    expect(target.applyDamageCalls).toHaveLength(0);
  });

  it("does nothing when not the GM client", async () => {
    installFoundryStubs();
    game.user.isGM = false;
    const attacker = makeAttackerCombatant();
    const target = makeTargetCombatant();
    const combat = makeCombat({ combatants: [attacker, target] });
    game.combats.contents.push(combat);

    await handleManualStrikeDamage(makeMessage());

    expect(target.applyDamageCalls).toHaveLength(0);
  });

  // #92: a player's own manual Strike went through this hook without ever
  // drawing a Critical Hit/Fumble Deck card on crit/fumble, unlike an
  // AI-controlled combatant's Strike (rollAndApplyStrike's own
  // drawCriticalCardForStrike call).
  it("draws a Critical Hit Deck card and posts it to chat on a player's own critical-success Strike (#92)", async () => {
    installFoundryStubs();
    installCriticalDeckStubs({
      docs: [makeDoc("Critical Hit Deck #1", HIT_DECK_1)],
    });
    const attacker = makeAttackerCombatant();
    const target = makeTargetCombatant();
    const combat = makeCombat({ combatants: [attacker, target] });
    game.combats.contents.push(combat);
    const weaponItem = makeWeaponItem({ damageType: "bludgeoning" });

    await handleManualStrikeDamage(
      makeMessage({ outcome: "criticalSuccess", item: weaponItem }),
    );

    // "Crunch" is Bludgeoning's only sub-entry in this fixture, so the draw
    // is deterministic despite pickSubentry's own randomness.
    expect(ChatMessage.calls).toHaveLength(1);
    expect(ChatMessage.calls[0].content).toContain("Sickened");
    // The pre-existing damage-apply/appliedDamage-marking behavior is
    // unaffected by the new card draw.
    expect(target.applyDamageCalls).toHaveLength(1);
    expect(target.applyDamageCalls[0]).toMatchObject({
      outcome: "criticalSuccess",
    });
  });

  it("draws a Critical Fumble Deck card, breaks the attacker's own weapon, and posts it to chat on a player's own critical-failure Strike (#92)", async () => {
    installFoundryStubs();
    installCriticalDeckStubs({
      docs: [makeDoc("Critical Fumble Deck #14", FUMBLE_DECK_14)],
    });
    const attacker = makeAttackerCombatant();
    const target = makeTargetCombatant();
    const combat = makeCombat({ combatants: [attacker, target] });
    game.combats.contents.push(combat);
    const weaponItem = makeWeaponItem({
      isRanged: false,
      hp: { value: 10, max: 10, brokenThreshold: 5 },
    });

    await handleManualStrikeDamage(
      makeMessage({ outcome: "criticalFailure", item: weaponItem }),
    );

    // "Notched" is Melee's only sub-entry in this fixture (isRanged: false,
    // not unarmed -> fumbleDeckCategory returns "Melee").
    expect(ChatMessage.calls).toHaveLength(1);
    expect(ChatMessage.calls[0].content).toContain("Your weapon takes");
    // The card's own "Your weapon takes 1d6 damage" directive resolves to
    // the attacker's own live weapon item, not a fresh/unrelated one (#60).
    expect(weaponItem.updateCalls).toEqual([{ "system.hp.value": 7 }]);
  });

  it("never attempts a critical-deck draw when the message carries no resolvable weapon item (defensive no-op)", async () => {
    installFoundryStubs();
    const attacker = makeAttackerCombatant();
    const target = makeTargetCombatant();
    const combat = makeCombat({ combatants: [attacker, target] });
    game.combats.contents.push(combat);

    // No installCriticalDeckStubs() -- game.packs/ChatMessage stay
    // unstubbed, so a stray access would throw and fail this test.
    await handleManualStrikeDamage(
      makeMessage({ outcome: "criticalSuccess", item: null }),
    );

    expect(target.applyDamageCalls).toHaveLength(1);
  });

  it("never attempts a critical-deck draw on a plain (non-critical) success", async () => {
    installFoundryStubs();
    const attacker = makeAttackerCombatant();
    const target = makeTargetCombatant();
    const combat = makeCombat({ combatants: [attacker, target] });
    game.combats.contents.push(combat);
    const weaponItem = makeWeaponItem();

    // No installCriticalDeckStubs() here either -- game.packs stays
    // unstubbed, proving the plain-success path never even looks at it.
    await handleManualStrikeDamage(
      makeMessage({ outcome: "success", item: weaponItem }),
    );

    expect(target.applyDamageCalls).toHaveLength(1);
    expect(weaponItem.updateCalls).toEqual([]);
  });
});
