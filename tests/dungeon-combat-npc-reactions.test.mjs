import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  offerReactiveStrikesAgainst,
  handleRangedAttackForReactiveStrike,
  strideByPosture,
  rollAndApplyStrike,
  handleAttackRollForReactions,
  handleManualStrikeDamage,
  answerReactionConfirm,
  handleTokenMoveForReactions,
  resolveReactions,
} from "../scripts/dungeon-combat.mjs";

const MODULE = "pf2e-dungeon-crawl";
const GRID = 100;

let settings;
let idCounter;

function installFoundryStubs({ gmLessSceneId = null, agentServiceUrl = "" } = {}) {
  idCounter = 0;
  settings = {
    movementStepDelayMs: 0,
    agentServiceUrl,
    agentServiceApiKey: "k",
    dungeonRuns: gmLessSceneId ? { [gmLessSceneId]: { hostUserId: "player1" } } : {},
  };
  globalThis.foundry = { utils: { randomID: () => `rid${++idCounter}` } };
  globalThis.ChatMessage = {
    calls: [],
    create: async (data) => {
      ChatMessage.calls.push(data);
      return { id: `msg${ChatMessage.calls.length}`, ...data };
    },
    getWhisperRecipients: () => [{ id: "gm1" }],
  };
  globalThis.game = {
    user: { id: "gm1", isGM: true, flags: { pf2e: { settings: {} } }, update: async () => {} },
    users: { activeGM: { isSelf: true } },
    i18n: { format: (key, data) => `${key}|${JSON.stringify(data)}`, localize: (key) => key },
    messages: {
      contents: [],
      get(id) {
        return this.contents.find((m) => m.id === id) ?? null;
      },
    },
    combats: {
      contents: [],
      get(id) {
        return this.contents.find((c) => c.id === id) ?? null;
      },
    },
    settings: { get: (_m, key) => settings[key] },
    actors: { party: { members: [{ id: "pc-actor" }] } },
    pf2e: {
      Modifier: class {
        constructor(data) {
          Object.assign(this, data);
        }
      },
    },
  };
}

function d20(face) {
  return { dice: [{ faces: 20, results: [{ result: face, active: true }] }] };
}

/** A Strike action whose roll posts an attack-roll message with the given
 * total/dc/natural/outcome and records every roll() argument. */
function strikeAction({ slug = "claw", label = "Claw", reach = null, outcome = "success", total = 25, dc = 20, natural = 10, damageTotal = 6, attackEffects = [] } = {}) {
  const rollCalls = [];
  return {
    type: "strike",
    ready: true,
    slug,
    label,
    traits: reach ? [{ name: `reach-${reach}` }] : [],
    item: { slug, isRanged: false, system: { attackEffects: { value: attackEffects } } },
    rollCalls,
    variants: [
      {
        roll: async (args) => {
          rollCalls.push(args);
          game.messages.contents.push({
            id: `atk${game.messages.contents.length}`,
            flags: { pf2e: { context: { type: "attack-roll", action: "strike", outcome, dc: { value: dc }, options: ["melee"] } } },
            rolls: [{ total, ...d20(natural) }],
          });
        },
      },
    ],
    damage: async () => ({ total: damageTotal }),
  };
}

function reactionItem(name, rules = []) {
  return { type: "action", name, system: { actionType: { value: "reaction" }, rules } };
}

const TWISTING_TAIL_RULES = [
  { key: "RollOption", option: "twisting-tail", toggleable: true, domain: "attack-roll" },
  { key: "FlatModifier", predicate: ["twisting-tail"], selector: "tail-attack", type: "untyped", value: -2 },
];

function npc({ id, x = 0, y = 0, disposition = -1, items = [], strikes = [], shield = null, agentControlled = true, name = id } = {}) {
  const flags = { agentControlled };
  const applyDamageCalls = [];
  return {
    id,
    name,
    tokenId: `${id}-token`,
    isDefeated: false,
    token: { id: `${id}-token`, x, y, width: 1, height: 1, disposition, move: async function (c) { Object.assign(this, c); } },
    getFlag: (_m, key) => flags[key],
    actor: {
      id: `${id}-actor`,
      uuid: `Actor.${id}`,
      type: "npc",
      items,
      attributes: { shield },
      system: { actions: strikes, attributes: { hp: { value: 30 } }, movement: { speeds: { land: { value: 30 } } } },
      applyDamage: async (args) => applyDamageCalls.push(args),
    },
    applyDamageCalls,
  };
}

function pc({ id = "pc", x = 0, y = 0, agentControlled = false } = {}) {
  const c = npc({ id, x, y, disposition: 1, agentControlled, name: "Hero" });
  c.actor.id = "pc-actor";
  c.actor.type = "character";
  c.actor.conditions = [];
  return c;
}

function makeCombat({ combatants, round = 1, sceneId = "scene1", combatant = null } = {}) {
  const flags = { dungeonSlot: 1 };
  const combat = {
    id: "combat1",
    round,
    turn: 0,
    started: true,
    combatants: Object.assign([...combatants], { get: (id) => combatants.find((c) => c.id === id) }),
    combatant,
    scene: { id: sceneId, grid: { size: GRID, distance: 5 }, tokens: [] },
    getFlag: (_m, key) => flags[key],
    setFlag: async (_m, key, value) => {
      flags[key] = value;
    },
    flags,
  };
  game.combats.contents.push(combat);
  return combat;
}

describe("#931 movement reactions through the registry", () => {
  beforeEach(() => installFoundryStubs());

  it("the GM's manual check fires Twisting Tail with the item's own twisting-tail roll option (the system's -2)", async () => {
    const tail = strikeAction({ slug: "tail", label: "Tail", reach: 15 });
    const dragon = npc({ id: "dragon", x: 200, y: 0, items: [reactionItem("Twisting Tail", TWISTING_TAIL_RULES)], strikes: [strikeAction({ slug: "jaws" }), tail] });
    const hero = pc();
    const combat = makeCombat({ combatants: [hero, dragon] });

    await offerReactiveStrikesAgainst(combat, hero);

    expect(tail.rollCalls).toHaveLength(1);
    expect(tail.rollCalls[0].options).toEqual(["twisting-tail"]);
    expect(tail.rollCalls[0].modifiers).toBeUndefined();
    expect(combat.flags.reactionUsed).toEqual({ dragon: 1 });
    expect(ChatMessage.calls.at(-1).content).toContain("PF2EDC.Dungeon.Combat.ReactionChat");
    expect(ChatMessage.calls.at(-1).content).toContain("Twisting Tail");
  });

  it("falls back to an explicit -2 modifier for a Twisting Tail item without the rule element", async () => {
    const tail = strikeAction({ slug: "tail", label: "Tail", reach: 15 });
    const dragon = npc({ id: "dragon", x: 100, y: 0, items: [reactionItem("Twisting Tail")], strikes: [tail] });
    const hero = pc();
    const combat = makeCombat({ combatants: [hero, dragon] });

    await offerReactiveStrikesAgainst(combat, hero);

    expect(tail.rollCalls[0].options).toBeUndefined();
    expect(tail.rollCalls[0].modifiers).toHaveLength(1);
    expect(tail.rollCalls[0].modifiers[0]).toMatchObject({ modifier: -2, type: "untyped", label: "Twisting Tail" });
  });

  it("a ranged Strike provokes Reactive Strike but not Twisting Tail (its trigger is movement only)", async () => {
    const tail = strikeAction({ slug: "tail", label: "Tail", reach: 15 });
    const dragon = npc({ id: "dragon", x: 100, y: 0, items: [reactionItem("Twisting Tail", TWISTING_TAIL_RULES)], strikes: [tail] });
    const hero = pc();
    const combat = makeCombat({ combatants: [hero, dragon] });

    await handleRangedAttackForReactiveStrike({
      flags: { pf2e: { context: { type: "attack-roll", options: ["ranged"] } } },
      speaker: { scene: "scene1", token: "pc-token" },
    });

    expect(tail.rollCalls).toHaveLength(0);
    expect(combat.flags.reactionUsed).toBeUndefined();
  });

  it("a creature with two eligible reactions for one trigger uses exactly one -- the higher priority with no agent service", async () => {
    const claw = strikeAction({ slug: "claw" });
    const tail = strikeAction({ slug: "tail", label: "Tail", reach: 15 });
    const dragon = npc({
      id: "dragon",
      x: 100,
      y: 0,
      items: [reactionItem("Reactive Strike"), reactionItem("Twisting Tail", TWISTING_TAIL_RULES)],
      strikes: [claw, tail],
    });
    const hero = pc();
    const combat = makeCombat({ combatants: [hero, dragon] });

    await offerReactiveStrikesAgainst(combat, hero);

    expect(tail.rollCalls).toHaveLength(1);
    expect(claw.rollCalls).toHaveLength(0);
    expect(combat.flags.reactionUsed).toEqual({ dragon: 1 });
  });

  it("with an agent service configured, asks it (5 s timeout) and runs its pick", async () => {
    installFoundryStubs({ agentServiceUrl: "https://agent.example" });
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout");
    const fetchSpy = vi.fn(async () => ({ ok: true, json: async () => ({ candidateId: "reaction:reactive-strike:dragon", rationale: "save the tail" }) }));
    const realFetch = globalThis.fetch;
    globalThis.fetch = fetchSpy;
    try {
      const claw = strikeAction({ slug: "claw" });
      const tail = strikeAction({ slug: "tail", label: "Tail", reach: 15 });
      const dragon = npc({
        id: "dragon",
        x: 100,
        y: 0,
        items: [reactionItem("Reactive Strike"), reactionItem("Twisting Tail", TWISTING_TAIL_RULES)],
        strikes: [claw, tail],
      });
      const hero = pc();
      const combat = makeCombat({ combatants: [hero, dragon] });

      await offerReactiveStrikesAgainst(combat, hero);

      expect(fetchSpy).toHaveBeenCalledOnce();
      const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
      expect(body.decisionKind).toBe("reaction");
      expect(body.candidates.map((c) => c.id)).toEqual(["reaction:reactive-strike:dragon", "reaction:twisting-tail:dragon", "decline"]);
      expect(timeoutSpy).toHaveBeenCalledWith(5000);
      expect(claw.rollCalls).toHaveLength(1);
      expect(tail.rollCalls).toHaveLength(0);
      expect(ChatMessage.calls.at(-1).content).toContain("save the tail");
      expect(ChatMessage.calls.at(-1).content).toContain('data-visibility="gm"');
    } finally {
      globalThis.fetch = realFetch;
      timeoutSpy.mockRestore();
    }
  });

  it("skips the remaining reactors once an earlier reaction dropped the mover", async () => {
    const a = npc({ id: "a", x: 100, y: 0, items: [reactionItem("Reactive Strike")], strikes: [strikeAction()] });
    const b = npc({ id: "b", x: 0, y: 100, items: [reactionItem("Reactive Strike")], strikes: [strikeAction()] });
    const hero = pc();
    hero.actor.applyDamage = async () => {
      hero.isDefeated = true;
    };
    const combat = makeCombat({ combatants: [hero, a, b] });

    await offerReactiveStrikesAgainst(combat, hero);

    expect(combat.flags.reactionUsed).toEqual({ a: 1 });
  });
});

describe("#931 AI Stride mid-move disruption (Twisting Tail)", () => {
  beforeEach(() => installFoundryStubs());

  it("a Twisting Tail hit at the start of the move disrupts it: the mover stays put and the stride reports 'disrupted'", async () => {
    const tail = strikeAction({ slug: "tail", label: "Tail", reach: 15, outcome: "success" });
    const dragon = npc({ id: "dragon", x: 300, y: 0, disposition: 1, items: [reactionItem("Twisting Tail", TWISTING_TAIL_RULES)], strikes: [tail] });
    const goblin = npc({ id: "goblin", x: 100, y: 0, disposition: -1 });
    const combat = makeCombat({ combatants: [goblin, dragon] });

    const result = await strideByPosture(combat, goblin, "approach", { token: { x: 700, y: 0 } });

    expect(result).toBe("disrupted");
    expect(goblin.token.x).toBe(100);
    expect(tail.rollCalls).toHaveLength(1);
    expect(ChatMessage.calls.some((m) => m.content.includes("ReactionDisruptedMove"))).toBe(true);
  });

  it("a Twisting Tail miss lets the move finish", async () => {
    const tail = strikeAction({ slug: "tail", label: "Tail", reach: 15, outcome: "failure", total: 5 });
    const dragon = npc({ id: "dragon", x: 300, y: 0, disposition: 1, items: [reactionItem("Twisting Tail", TWISTING_TAIL_RULES)], strikes: [tail] });
    const goblin = npc({ id: "goblin", x: 100, y: 0, disposition: -1 });
    const combat = makeCombat({ combatants: [goblin, dragon] });

    const result = await strideByPosture(combat, goblin, "approach", { token: { x: 700, y: 0 } });

    expect(result).toBe("moved");
    expect(goblin.token.x).toBe(600);
    expect(tail.rollCalls).toHaveLength(1);
  });

  it("approaching into tail reach and stopping does not trigger Twisting Tail (no move action used within reach)", async () => {
    const tail = strikeAction({ slug: "tail", label: "Tail", reach: 5 });
    const dragon = npc({ id: "dragon", x: 500, y: 0, disposition: 1, items: [reactionItem("Twisting Tail", TWISTING_TAIL_RULES)], strikes: [tail] });
    const goblin = npc({ id: "goblin", x: 100, y: 0, disposition: -1 });
    const combat = makeCombat({ combatants: [goblin, dragon] });

    const result = await strideByPosture(combat, goblin, "approach", dragon);

    expect(result).toBe("moved");
    expect(goblin.token.x).toBe(400);
    expect(tail.rollCalls).toHaveLength(0);
  });
});

describe("#931 AI Stride mid-move disruption (Wing Rebuff)", () => {
  beforeEach(() => installFoundryStubs());

  function roc({ pushOutcome }) {
    const wing = strikeAction({ slug: "wing", label: "Wing", reach: 30, attackEffects: ["improved-push"] });
    const r = npc({ id: "roc", x: 1000, y: 0, disposition: 1, items: [reactionItem("Wing Rebuff")], strikes: [wing] });
    r.actor.skills = {
      athletics: {
        roll: async () => {
          game.messages.contents.push({ flags: { pf2e: { context: { outcome: pushOutcome } } } });
        },
      },
    };
    return { r, wing };
  }

  it("fires when the mover first enters wing reach; a successful push disrupts the move there", async () => {
    const { r, wing } = roc({ pushOutcome: "success" });
    const goblin = npc({ id: "goblin", x: 0, y: 0, disposition: -1 });
    goblin.actor.saves = { fortitude: { dc: { value: 15 } } };
    const combat = makeCombat({ combatants: [goblin, r] });

    const result = await strideByPosture(combat, goblin, "approach", r);

    expect(wing.rollCalls).toHaveLength(1);
    expect(result).toBe("disrupted");
    // Entered reach (6 squares from the roc) at x=400, then pushed 1 square away.
    expect(goblin.token.x).toBe(300);
  });

  it("a hit without a successful push lets the move continue", async () => {
    const { r, wing } = roc({ pushOutcome: "failure" });
    const goblin = npc({ id: "goblin", x: 0, y: 0, disposition: -1 });
    goblin.actor.saves = { fortitude: { dc: { value: 15 } } };
    const combat = makeCombat({ combatants: [goblin, r] });

    const result = await strideByPosture(combat, goblin, "approach", r);

    expect(wing.rollCalls).toHaveLength(1);
    expect(result).toBe("moved");
    expect(goblin.token.x).toBe(600);
  });
});

describe("#931 defensive reactions against an AI attacker's Strike", () => {
  beforeEach(() => installFoundryStubs());

  it("Wing Deflection turns a narrow hit into a miss: no damage, reaction used, table told", async () => {
    const drake = npc({ id: "drake", x: 100, y: 0, disposition: 1, items: [reactionItem("Wing Deflection")] });
    const attacker = npc({ id: "ally", x: 0, y: 0, disposition: -1, strikes: [strikeAction({ total: 21, dc: 20, natural: 11 })] });
    const combat = makeCombat({ combatants: [attacker, drake] });

    const outcome = await rollAndApplyStrike(combat, attacker, drake);

    expect(outcome).toBe("failure");
    expect(drake.applyDamageCalls).toHaveLength(0);
    expect(combat.flags.reactionUsed).toEqual({ drake: 1 });
    expect(ChatMessage.calls.some((m) => m.content.includes("ReactionAcBonusChat"))).toBe(true);
  });

  it("Wing Deflection is not used when +2 AC would not change the hit", async () => {
    const drake = npc({ id: "drake", x: 100, y: 0, disposition: 1, items: [reactionItem("Wing Deflection")] });
    const attacker = npc({ id: "ally", x: 0, y: 0, disposition: -1, strikes: [strikeAction({ total: 26, dc: 20 })] });
    const combat = makeCombat({ combatants: [attacker, drake] });

    const outcome = await rollAndApplyStrike(combat, attacker, drake);

    expect(outcome).toBe("success");
    expect(drake.applyDamageCalls).toHaveLength(1);
    expect(combat.flags.reactionUsed).toBeUndefined();
  });

  it("Shield Block passes shieldBlockRequest to the single applyDamage call when damage exceeds Hardness", async () => {
    const shield = { raised: true, broken: false, destroyed: false, hardness: 5, name: "Steel Shield" };
    const guard = npc({ id: "guard", x: 100, y: 0, disposition: 1, items: [reactionItem("Shield Block")], shield });
    const attacker = npc({ id: "ally", x: 0, y: 0, disposition: -1, strikes: [strikeAction({ damageTotal: 9 })] });
    const combat = makeCombat({ combatants: [attacker, guard] });

    await rollAndApplyStrike(combat, attacker, guard);

    expect(guard.applyDamageCalls).toHaveLength(1);
    expect(guard.applyDamageCalls[0].shieldBlockRequest).toBe(true);
    expect(combat.flags.reactionUsed).toEqual({ guard: 1 });
  });

  it("Shield Block is not used with a lowered shield (PF2e requires it raised) or for damage within Hardness", async () => {
    const lowered = npc({ id: "g1", x: 100, y: 0, disposition: 1, items: [reactionItem("Shield Block")], shield: { raised: false, hardness: 5 } });
    const smallHit = npc({ id: "g2", x: 100, y: 0, disposition: 1, items: [reactionItem("Shield Block")], shield: { raised: true, hardness: 10 } });
    const attacker = npc({ id: "ally", x: 0, y: 0, disposition: -1, strikes: [strikeAction({ damageTotal: 9 })] });
    const combat = makeCombat({ combatants: [attacker, lowered, smallHit] });

    await rollAndApplyStrike(combat, attacker, lowered);
    await rollAndApplyStrike(combat, attacker, smallHit);

    expect(lowered.applyDamageCalls[0].shieldBlockRequest).toBeUndefined();
    expect(smallHit.applyDamageCalls[0].shieldBlockRequest).toBeUndefined();
    expect(combat.flags.reactionUsed).toBeUndefined();
  });

  it("only one reaction per round: a creature that already used Wing Deflection cannot Shield Block the same round", async () => {
    const shield = { raised: true, hardness: 2, name: "Shield" };
    const drake = npc({ id: "drake", x: 100, y: 0, disposition: 1, items: [reactionItem("Wing Deflection"), reactionItem("Shield Block")], shield });
    const attacker = npc({ id: "ally", x: 0, y: 0, disposition: -1, strikes: [strikeAction({ total: 21, dc: 20, damageTotal: 9 })] });
    const combat = makeCombat({ combatants: [attacker, drake] });

    await rollAndApplyStrike(combat, attacker, drake);
    attacker.actor.system.actions = [strikeAction({ total: 30, dc: 20, damageTotal: 9, natural: 15 })];
    await rollAndApplyStrike(combat, attacker, drake);

    expect(drake.applyDamageCalls).toHaveLength(1);
    expect(drake.applyDamageCalls[0].shieldBlockRequest).toBeUndefined();
  });
});

/** A player's Strike: the attack-roll message, then its damage roll. */
function playerAttack({ total = 21, dc = 20, natural = 12, outcome = "success", options = ["melee", "item:type:weapon"] } = {}) {
  const attack = {
    id: "attack1",
    speaker: { scene: "scene1", token: "pc-token" },
    flags: { pf2e: { context: { type: "attack-roll", action: "strike", outcome, dc: { value: dc }, target: { token: "Scene.scene1.Token.drake-token" }, options } } },
    rolls: [{ total, ...d20(natural) }],
  };
  const damage = {
    id: "damage1",
    speaker: { scene: "scene1", token: "pc-token" },
    flags: { pf2e: { context: { type: "damage-roll", outcome, target: { token: "Scene.scene1.Token.drake-token" }, options } } },
    rolls: [{ total: 9 }],
    item: null,
    update: async () => {},
  };
  game.messages.contents.push(attack, damage);
  return { attack, damage };
}

describe("#931 defensive reactions against a player's Strike", () => {
  it("GM-less run: Wing Deflection is automatic -- no confirm card -- and the paired damage roll is skipped", async () => {
    installFoundryStubs({ gmLessSceneId: "scene1" });
    const drake = npc({ id: "drake", x: 100, y: 0, items: [reactionItem("Wing Deflection")] });
    const hero = pc();
    const combat = makeCombat({ combatants: [hero, drake] });
    const { attack, damage } = playerAttack();

    await handleAttackRollForReactions(attack);
    await handleManualStrikeDamage(damage);

    expect(ChatMessage.calls.some((m) => m.flags?.[MODULE]?.reactionConfirm)).toBe(false);
    expect(combat.flags.reactionUsed).toEqual({ drake: 1 });
    expect(combat.flags.reactionAttackMisses).toHaveProperty("attack1");
    expect(drake.applyDamageCalls).toHaveLength(0);
  });

  it("human GM present: posts a GM-only confirm card and holds the damage; accepting skips it", async () => {
    installFoundryStubs();
    const drake = npc({ id: "drake", x: 100, y: 0, items: [reactionItem("Wing Deflection")] });
    const hero = pc();
    const combat = makeCombat({ combatants: [hero, drake] });
    const { attack, damage } = playerAttack();

    await handleAttackRollForReactions(attack);
    const card = ChatMessage.calls.find((m) => m.flags?.[MODULE]?.reactionConfirm);
    expect(card).toBeDefined();
    expect(card.whisper).toEqual(["gm1"]);
    expect(combat.flags.reactionUsed).toBeUndefined();

    await handleManualStrikeDamage(damage);
    expect(drake.applyDamageCalls).toHaveLength(0);

    const cardMessage = { content: card.content, update: vi.fn(async () => {}) };
    const { confirmId } = card.flags[MODULE].reactionConfirm;
    expect(await answerReactionConfirm("combat1", confirmId, true, { cardMessage })).toBe("used");
    expect(combat.flags.reactionUsed).toEqual({ drake: 1 });
    expect(drake.applyDamageCalls).toHaveLength(0);
    expect(cardMessage.update.mock.calls[0][0].content).not.toContain("data-pf2edc-reaction");
    // A second click is a no-op.
    expect(await answerReactionConfirm("combat1", confirmId, true)).toBeNull();
  });

  it("human GM present: declining applies the held damage", async () => {
    installFoundryStubs();
    const drake = npc({ id: "drake", x: 100, y: 0, items: [reactionItem("Wing Deflection")] });
    const hero = pc();
    const combat = makeCombat({ combatants: [hero, drake] });
    const { attack, damage } = playerAttack();

    await handleAttackRollForReactions(attack);
    await handleManualStrikeDamage(damage);
    const card = ChatMessage.calls.find((m) => m.flags?.[MODULE]?.reactionConfirm);

    expect(await answerReactionConfirm("combat1", card.flags[MODULE].reactionConfirm.confirmId, false)).toBe("declined");
    expect(drake.applyDamageCalls).toHaveLength(1);
    expect(combat.flags.reactionUsed).toBeUndefined();
  });

  it("a confirm card answered after its round ended counts as declined", async () => {
    installFoundryStubs();
    const drake = npc({ id: "drake", x: 100, y: 0, items: [reactionItem("Wing Deflection")] });
    const hero = pc();
    const combat = makeCombat({ combatants: [hero, drake] });
    const { attack, damage } = playerAttack();
    await handleAttackRollForReactions(attack);
    await handleManualStrikeDamage(damage);
    combat.round = 2;
    const card = ChatMessage.calls.find((m) => m.flags?.[MODULE]?.reactionConfirm);

    expect(await answerReactionConfirm("combat1", card.flags[MODULE].reactionConfirm.confirmId, true)).toBe("declined");
    expect(drake.applyDamageCalls).toHaveLength(1);
  });

  it("GM-less run: Shield Block against a player's Strike is automatic", async () => {
    installFoundryStubs({ gmLessSceneId: "scene1" });
    const drake = npc({ id: "drake", x: 100, y: 0, items: [reactionItem("Shield Block")], shield: { raised: true, hardness: 5, name: "Shield" } });
    const hero = pc();
    const combat = makeCombat({ combatants: [hero, drake] });
    const { damage } = playerAttack({ total: 30 });

    await handleManualStrikeDamage(damage);

    expect(drake.applyDamageCalls).toHaveLength(1);
    expect(drake.applyDamageCalls[0].shieldBlockRequest).toBe(true);
    expect(combat.flags.reactionUsed).toEqual({ drake: 1 });
  });

  it("human GM present: Shield Block waits for the card; accepting applies the damage with shieldBlockRequest", async () => {
    installFoundryStubs();
    const drake = npc({ id: "drake", x: 100, y: 0, items: [reactionItem("Shield Block")], shield: { raised: true, hardness: 5, name: "Shield" } });
    const hero = pc();
    const combat = makeCombat({ combatants: [hero, drake] });
    const { damage } = playerAttack({ total: 30 });

    await handleManualStrikeDamage(damage);
    expect(drake.applyDamageCalls).toHaveLength(0);
    const card = ChatMessage.calls.find((m) => m.flags?.[MODULE]?.reactionConfirm);

    expect(await answerReactionConfirm("combat1", card.flags[MODULE].reactionConfirm.confirmId, true)).toBe("used");
    expect(drake.applyDamageCalls).toHaveLength(1);
    expect(drake.applyDamageCalls[0].shieldBlockRequest).toBe(true);
    expect(combat.flags.reactionUsed).toEqual({ drake: 1 });
  });

  it("ignores an AI attacker's attack-roll message (those resolve inline in the Strike executor)", async () => {
    installFoundryStubs({ gmLessSceneId: "scene1" });
    const drake = npc({ id: "drake", x: 100, y: 0, items: [reactionItem("Wing Deflection")] });
    const hero = pc({ agentControlled: true });
    const combat = makeCombat({ combatants: [hero, drake] });
    const { attack } = playerAttack();

    await handleAttackRollForReactions(attack);

    expect(combat.flags.reactionUsed).toBeUndefined();
  });

  it("Swat Projectile only answers a physical ranged attack", async () => {
    installFoundryStubs({ gmLessSceneId: "scene1" });
    const giant = npc({ id: "drake", x: 100, y: 0, items: [reactionItem("Swat Projectile")] });
    const hero = pc();
    const combat = makeCombat({ combatants: [hero, giant] });

    await handleAttackRollForReactions(playerAttack({ total: 22, options: ["melee"] }).attack);
    expect(combat.flags.reactionUsed).toBeUndefined();

    game.messages.contents = [];
    await handleAttackRollForReactions(playerAttack({ total: 22, options: ["ranged"] }).attack);
    expect(combat.flags.reactionUsed).toEqual({ drake: 1 });
  });
});

function moveEvent(origin, waypoints, method = "dragging") {
  return {
    method,
    origin: { x: origin[0], y: origin[1], width: 1, height: 1 },
    passed: { waypoints: waypoints.map(([x, y]) => ({ x, y, width: 1, height: 1, action: "walk" })) },
  };
}

describe("#931 a player's own move provokes NPC reactions", () => {
  function setup({ gmLess = false, items = [reactionItem("Reactive Strike")], strikes = [strikeAction()] } = {}) {
    installFoundryStubs(gmLess ? { gmLessSceneId: "scene1" } : {});
    const ogre = npc({ id: "ogre", x: 200, y: 0, items, strikes });
    const hero = pc({ x: 100, y: 0 });
    const tokenDoc = { id: "pc-token", parent: { id: "scene1", grid: { size: GRID } }, move: vi.fn(async () => {}) };
    const combat = makeCombat({ combatants: [hero, ogre], combatant: hero });
    return { ogre, hero, tokenDoc, combat };
  }

  it("moving out of reach (leaving a square within reach) provokes Reactive Strike", async () => {
    const { tokenDoc, combat } = setup();
    await handleTokenMoveForReactions(tokenDoc, moveEvent([100, 0], [[-200, 0]]));
    expect(combat.flags.reactionUsed).toEqual({ ogre: 1 });
  });

  it("a one-square move is a Step and provokes nothing", async () => {
    const { tokenDoc, combat } = setup();
    await handleTokenMoveForReactions(tokenDoc, moveEvent([100, 0], [[0, 0]]));
    expect(combat.flags.reactionUsed).toBeUndefined();
  });

  it("the module's own moves (api method, displace) never count", async () => {
    const { tokenDoc, combat } = setup();
    await handleTokenMoveForReactions(tokenDoc, moveEvent([100, 0], [[-200, 0]], "api"));
    expect(combat.flags.reactionUsed).toBeUndefined();
  });

  it("approaching into reach and stopping provokes nothing", async () => {
    installFoundryStubs();
    const ogre = npc({ id: "ogre", x: 600, y: 0, items: [reactionItem("Reactive Strike")], strikes: [strikeAction()] });
    const hero = pc({ x: 0, y: 0 });
    const tokenDoc = { id: "pc-token", parent: { id: "scene1", grid: { size: GRID } }, move: vi.fn() };
    const combat = makeCombat({ combatants: [hero, ogre], combatant: hero });
    await handleTokenMoveForReactions(tokenDoc, moveEvent([0, 0], [[500, 0]]));
    expect(combat.flags.reactionUsed).toBeUndefined();
  });

  it("GM-less: a Twisting Tail hit puts the token back on the square the reaction fired on", async () => {
    const tail = strikeAction({ slug: "tail", label: "Tail", reach: 10 });
    const { tokenDoc } = setup({ gmLess: true, items: [reactionItem("Twisting Tail", TWISTING_TAIL_RULES)], strikes: [tail] });
    await handleTokenMoveForReactions(tokenDoc, moveEvent([100, 0], [[-300, 0]]));
    expect(tail.rollCalls).toHaveLength(1);
    expect(tokenDoc.move).toHaveBeenCalledWith({ x: 100, y: 0, action: "displace" });
  });

  it("GM present: a Twisting Tail hit leaves the token and whispers the GM where it should stop", async () => {
    const tail = strikeAction({ slug: "tail", label: "Tail", reach: 10 });
    const { tokenDoc } = setup({ items: [reactionItem("Twisting Tail", TWISTING_TAIL_RULES)], strikes: [tail] });
    await handleTokenMoveForReactions(tokenDoc, moveEvent([100, 0], [[-300, 0]]));
    expect(tokenDoc.move).not.toHaveBeenCalled();
    expect(ChatMessage.calls.some((m) => m.content.includes("ReactionDisruptedMoveGm") && m.whisper)).toBe(true);
  });
});

describe("resolveReactions", () => {
  beforeEach(() => installFoundryStubs());

  it("resolves reactors in initiative order, never executes one that already used its reaction, and never throws", async () => {
    const r1 = { id: "r1", name: "R1", token: {} };
    const r2 = { id: "r2", name: "R2", token: {} };
    const combat = makeCombat({ combatants: [r2, r1] });
    combat.turns = [r1, r2];
    combat.flags.reactionUsed = { r2: 1 };
    const def = { id: "x", label: "X", priority: 1, policy: () => true };
    const order = [];
    const execute = vi.fn(async (chosen) => {
      order.push(chosen.reactor.id);
      throw new Error("boom");
    });
    const ran = await resolveReactions(combat, { trigger: "manual", mover: { id: "m", token: {} }, options: [{ reactor: r2, def, ctx: {} }, { reactor: r1, def, ctx: {} }] }, execute);
    expect(order).toEqual(["r1"]);
    expect(ran).toEqual([]);
  });
});
