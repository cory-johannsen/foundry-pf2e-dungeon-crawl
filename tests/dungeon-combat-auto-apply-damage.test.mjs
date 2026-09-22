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
    update: async (changes) => updateCalls.push(changes),
    updateCalls,
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

  it("sets defeated when damage reduces the target to 0 HP", async () => {
    installFoundryStubs();
    const attacker = makeAttackerCombatant();
    const target = makeTargetCombatant({ hp: 0 });
    const updateCalls = [];
    target.update = async (changes) => updateCalls.push(changes);
    const combat = makeCombat({ combatants: [attacker, target] });
    game.combats.contents.push(combat);

    await handleManualStrikeDamage(makeMessage());

    expect(updateCalls).toEqual([{ defeated: true }]);
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
});
