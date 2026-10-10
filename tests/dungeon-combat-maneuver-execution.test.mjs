import { describe, it, expect, vi, beforeEach } from "vitest";
import { applyAgentDecision, getDemoralizeImmunityUntil } from "../scripts/dungeon-combat.mjs";

// #909: applyAgentDecision's `maneuver` branch, driven end-to-end through
// the real getPendingAgentTurn rebuild (stub shape copied from
// dungeon-combat-agent-move-stalled.test.mjs). Each test seeds the turn's
// persisted maneuverPicks so the chosen maneuver is a real candidate.

const G = 100;
const MODULE_ID = "pf2e-dungeon-crawl";

function makeToken({ x, y, disposition }) {
  const token = { x, y, disposition, width: 1, height: 1 };
  token.update = vi.fn(async function (changes) {
    Object.assign(this, changes);
  });
  token.move = vi.fn(async function ({ x, y }) {
    Object.assign(this, { x, y });
  });
  return token;
}

function makeCombatant({ id, gx, gy, disposition, heldWeapon = false }) {
  const flags = { agentControlled: true };
  const weapon = {
    id: `${id}-sword`,
    name: "Longsword",
    type: "weapon",
    system: { equipped: { carryType: "held", handsHeld: 1 }, traits: { value: [] } },
    update: vi.fn(async () => {}),
  };
  const items = heldWeapon ? [weapon] : [];
  return {
    id,
    name: id,
    isDefeated: false,
    token: makeToken({ x: gx * G, y: gy * G, disposition }),
    getFlag: (_m, key) => flags[key],
    actor: {
      type: "npc",
      conditions: [],
      items,
      itemTypes: { weapon: items },
      skills: { athletics: {}, intimidation: {} },
      attributes: { immunities: [] },
      increaseCondition: vi.fn(async () => {}),
      applyDamage: vi.fn(async () => {}),
      createEmbeddedDocuments: vi.fn(async () => {}),
      system: {
        actions: [],
        traits: { size: { value: "med" } },
        attributes: { hp: { value: 20, max: 20 } },
        movement: { speeds: { land: { value: 30 } } },
      },
    },
  };
}

function setup({ slug, outcome, opponentAt = [1, 0], dcs = null, feats = [], skills = null, levels = null }) {
  const attacker = makeCombatant({ id: "atk", gx: 0, gy: 0, disposition: -1 });
  // #911: maneuver-modifier feats/skills on the attacker.
  for (const featSlug of feats) attacker.actor.items.push({ type: "feat", slug: featSlug });
  if (skills) attacker.actor.skills = skills;
  const opponent = makeCombatant({
    id: "opp",
    gx: opponentAt[0],
    gy: opponentAt[1],
    disposition: 1,
    heldWeapon: true,
  });
  if (levels) {
    attacker.actor.level = levels[0];
    opponent.actor.level = levels[1];
  }
  if (dcs) {
    opponent.actor.getStatistic = vi.fn((s) => (s in dcs ? { dc: { value: dcs[s] } } : null));
  }
  const flags = {
    dungeonSlot: "slot-1",
    agentTurnState: {
      combatantId: "atk",
      round: 1,
      turn: 0,
      actionsRemaining: 3,
      mapIncrement: 0,
      maneuverPicks: [{ type: "maneuver", slug, targetId: "opp", rationale: "r" }],
      counter: 1,
    },
  };
  const combat = {
    id: "combat-1",
    round: 1,
    turn: 0,
    combatant: attacker,
    combatants: [attacker, opponent],
    getFlag: (_m, key) => flags[key],
    setFlag: async (_m, key, value) => {
      flags[key] = value;
    },
    scene: {
      grid: { size: G, distance: 5 },
      width: 8 * G,
      height: G,
      walls: { contents: [] },
      regions: [],
    },
  };
  const action = vi.fn(({ callback }) => {
    callback({ outcome });
  });
  game.pf2e = { actions: { [slug]: action } };
  return { attacker, opponent, combat, action };
}

beforeEach(() => {
  globalThis.CONST = {
    WALL_MOVEMENT_TYPES: { NONE: 0, NORMAL: 20 },
    WALL_DOOR_TYPES: { NONE: 0, DOOR: 1, SECRET: 2 },
    WALL_DOOR_STATES: { CLOSED: 0, OPEN: 1, LOCKED: 2 },
  };
  globalThis.foundry = { utils: {} };
  globalThis.ChatMessage = {
    create: vi.fn(async () => {}),
    getWhisperRecipients: () => [{ id: "gm1" }],
  };
  class DamageRoll {
    constructor(formula) {
      this.formula = formula;
    }
    async evaluate() {
      this.total = 4;
      return this;
    }
  }
  globalThis.CONFIG = { Dice: { rolls: [DamageRoll] } };
  globalThis.fromUuid = vi.fn(async () => ({ toObject: () => ({ name: "Effect: Disarm (Success)" }) }));
  globalThis.game = {
    i18n: { format: (key) => key },
    user: { flags: { pf2e: { settings: {} } }, update: vi.fn(async () => {}) },
    combats: { has: () => false },
    time: { worldTime: 1000 },
  };
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "debug").mockImplementation(() => {});
});

describe("applyAgentDecision maneuver execution (#909)", () => {
  it("calls game.pf2e.actions.trip with the attacker and an explicit target, and applies Prone on success", async () => {
    const { attacker, opponent, combat, action } = setup({ slug: "trip", outcome: "success" });
    await applyAgentDecision(combat, "atk", "maneuver:trip:opp", "r");
    expect(action).toHaveBeenCalledTimes(1);
    const opts = action.mock.calls[0][0];
    expect(opts.actors).toEqual([attacker.actor]);
    expect(opts.target()).toEqual({ actor: opponent.actor, token: opponent.token });
    expect(opponent.actor.increaseCondition).toHaveBeenCalledWith("prone");
    expect(opponent.actor.applyDamage).not.toHaveBeenCalled();
  });

  it("applies Prone plus 1d6 bludgeoning damage on a critical success Trip", async () => {
    const { opponent, combat } = setup({ slug: "trip", outcome: "criticalSuccess" });
    await applyAgentDecision(combat, "atk", "maneuver:trip:opp");
    expect(opponent.actor.increaseCondition).toHaveBeenCalledWith("prone");
    expect(opponent.actor.applyDamage).toHaveBeenCalledTimes(1);
    const { damage, token } = opponent.actor.applyDamage.mock.calls[0][0];
    expect(damage.formula).toBe("1d6[bludgeoning]");
    expect(token).toBe(opponent.token);
  });

  it("knocks the attacker Prone on a critical failure Trip", async () => {
    const { attacker, opponent, combat } = setup({ slug: "trip", outcome: "criticalFailure" });
    await applyAgentDecision(combat, "atk", "maneuver:trip:opp");
    expect(attacker.actor.increaseCondition).toHaveBeenCalledWith("prone");
    expect(opponent.actor.increaseCondition).not.toHaveBeenCalled();
  });

  it("pushes the target 5 ft (1 square) away on a successful Shove", async () => {
    const { opponent, combat } = setup({ slug: "shove", outcome: "success" });
    await applyAgentDecision(combat, "atk", "maneuver:shove:opp");
    expect(opponent.token.x).toBe(2 * G);
  });

  it("pushes the target 10 ft (2 squares) away on a critical success Shove", async () => {
    const { opponent, combat } = setup({ slug: "shove", outcome: "criticalSuccess" });
    await applyAgentDecision(combat, "atk", "maneuver:shove:opp");
    expect(opponent.token.x).toBe(3 * G);
  });

  it("applies Grabbed on a successful Grapple and Restrained on a critical success", async () => {
    let { opponent, combat } = setup({ slug: "grapple", outcome: "success" });
    await applyAgentDecision(combat, "atk", "maneuver:grapple:opp");
    expect(opponent.actor.increaseCondition).toHaveBeenCalledWith("grabbed");

    ({ opponent, combat } = setup({ slug: "grapple", outcome: "criticalSuccess" }));
    await applyAgentDecision(combat, "atk", "maneuver:grapple:opp");
    expect(opponent.actor.increaseCondition).toHaveBeenCalledWith("restrained");
  });

  it("applies the system's Disarm (Success) effect to the target on a successful Disarm", async () => {
    const { opponent, combat } = setup({ slug: "disarm", outcome: "success" });
    await applyAgentDecision(combat, "atk", "maneuver:disarm:opp");
    expect(fromUuid).toHaveBeenCalledWith("Compendium.pf2e.other-effects.Item.PuDS0DEq0CnaSIFV");
    expect(opponent.actor.createEmbeddedDocuments).toHaveBeenCalledWith("Item", [
      { name: "Effect: Disarm (Success)" },
    ]);
  });

  it("drops the target's held item on a critical success Disarm", async () => {
    const { opponent, combat } = setup({ slug: "disarm", outcome: "criticalSuccess" });
    await applyAgentDecision(combat, "atk", "maneuver:disarm:opp");
    expect(opponent.actor.items[0].update).toHaveBeenCalledWith({
      "system.equipped.carryType": "dropped",
      "system.equipped.handsHeld": 0,
    });
  });

  it("makes the attacker Off-Guard on a critical failure Disarm", async () => {
    const { attacker, combat } = setup({ slug: "disarm", outcome: "criticalFailure" });
    await applyAgentDecision(combat, "atk", "maneuver:disarm:opp");
    expect(attacker.actor.increaseCondition).toHaveBeenCalledWith("off-guard");
  });

  for (const [outcome, value] of [
    ["success", 1],
    ["criticalSuccess", 2],
  ]) {
    it(`applies Frightened ${value} on a ${outcome} Demoralize and records the 10-minute immunity`, async () => {
      const { opponent, combat } = setup({ slug: "demoralize", outcome });
      await applyAgentDecision(combat, "atk", "maneuver:demoralize:opp");
      expect(opponent.actor.increaseCondition).toHaveBeenCalledWith("frightened", { value });
      expect(getDemoralizeImmunityUntil(combat, "atk", "opp")).toBe(1600);
    });
  }

  it("records the Demoralize immunity even on a failure, with no condition applied", async () => {
    const { opponent, combat } = setup({ slug: "demoralize", outcome: "failure" });
    await applyAgentDecision(combat, "atk", "maneuver:demoralize:opp");
    expect(opponent.actor.increaseCondition).not.toHaveBeenCalled();
    expect(getDemoralizeImmunityUntil(combat, "atk", "opp")).toBe(1600);
  });

  it("reports the maneuver's outcome on the AI turn card (#925)", async () => {
    const { combat } = setup({ slug: "trip", outcome: "failure" });
    await applyAgentDecision(combat, "atk", "maneuver:trip:opp");
    const contents = ChatMessage.create.mock.calls.map((c) => c[0].content);
    expect(contents.some((c) => c.includes("Trip") && c.includes("failure"))).toBe(true);
  });

  it("spends one action on the maneuver", async () => {
    const { combat } = setup({ slug: "trip", outcome: "failure" });
    await applyAgentDecision(combat, "atk", "maneuver:trip:opp");
    expect(combat.getFlag(MODULE_ID, "agentTurnState").actionsRemaining).toBe(2);
  });

  it("never calls the maneuver macro when the target no longer resolves (defeated since the pick)", async () => {
    const { opponent, combat, action } = setup({ slug: "trip", outcome: "success" });
    opponent.isDefeated = true;
    await applyAgentDecision(combat, "atk", "maneuver:trip:opp");
    expect(action).not.toHaveBeenCalled();
    expect(opponent.actor.increaseCondition).not.toHaveBeenCalled();
  });
});

describe("maneuver target defense DC (#909)", () => {
  const DCS = { reflex: 17, fortitude: 19, will: 21 };
  const cases = [
    ["trip", "reflex", 17],
    ["shove", "fortitude", 19],
    ["grapple", "fortitude", 19],
    ["disarm", "reflex", 17],
    ["demoralize", "will", 21],
  ];
  it.each(cases)("%s passes difficultyClass {value} from the target's %s", async (slug, defense, value) => {
    const { opponent, combat, action } = setup({ slug, outcome: "failure", dcs: DCS });
    await applyAgentDecision(combat, "atk", `maneuver:${slug}:opp`, "r");
    expect(opponent.actor.getStatistic).toHaveBeenCalledWith(defense);
    expect(action.mock.calls[0][0].difficultyClass).toEqual({ value });
  });

  it("flows the outcome to applyManeuverOutcome when the DC is resolved", async () => {
    const { opponent, combat } = setup({ slug: "trip", outcome: "success", dcs: DCS });
    await applyAgentDecision(combat, "atk", "maneuver:trip:opp", "r");
    expect(opponent.actor.increaseCondition).toHaveBeenCalledWith("prone");
  });

  it("omits difficultyClass when the DC cannot be read", async () => {
    const { combat, action } = setup({ slug: "trip", outcome: "success", dcs: {} });
    await applyAgentDecision(combat, "atk", "maneuver:trip:opp", "r");
    expect("difficultyClass" in action.mock.calls[0][0]).toBe(false);
  });

  it("omits difficultyClass when the target has no getStatistic", async () => {
    const { combat, action } = setup({ slug: "trip", outcome: "success" });
    await applyAgentDecision(combat, "atk", "maneuver:trip:opp", "r");
    expect("difficultyClass" in action.mock.calls[0][0]).toBe(false);
  });
});

describe("maneuver skill substitution (#911)", () => {
  const SLY = { athletics: { mod: 3 }, thievery: { mod: 10 }, intimidation: {} };

  it("passes skill: thievery to game.pf2e.actions.disarm for a Sly Disarm actor whose Thievery is better", async () => {
    const { combat, action } = setup({ slug: "disarm", outcome: "failure", feats: ["sly-disarm"], skills: SLY });
    await applyAgentDecision(combat, "atk", "maneuver:disarm:opp", "r");
    expect(action).toHaveBeenCalledTimes(1);
    expect(action.mock.calls[0][0].skill).toBe("thievery");
  });

  it("still rolls against the target's Reflex DC when Disarming with Thievery", async () => {
    const { opponent, combat, action } = setup({
      slug: "disarm", outcome: "failure", feats: ["sly-disarm"], skills: SLY, dcs: { reflex: 18, fortitude: 20 },
    });
    await applyAgentDecision(combat, "atk", "maneuver:disarm:opp", "r");
    expect(opponent.actor.getStatistic).toHaveBeenCalledWith("reflex");
    expect(action.mock.calls[0][0].difficultyClass).toEqual({ value: 18 });
  });

  it("passes no skill override when the maneuver uses its own base skill", async () => {
    const { combat, action } = setup({ slug: "trip", outcome: "failure" });
    await applyAgentDecision(combat, "atk", "maneuver:trip:opp", "r");
    expect("skill" in action.mock.calls[0][0]).toBe(false);
  });

  it("passes no skill override for a Sly Disarm actor whose Athletics is at least as good", async () => {
    const { combat, action } = setup({
      slug: "disarm", outcome: "failure", feats: ["sly-disarm"],
      skills: { athletics: { mod: 10 }, thievery: { mod: 10 }, intimidation: {} },
    });
    await applyAgentDecision(combat, "atk", "maneuver:disarm:opp", "r");
    expect("skill" in action.mock.calls[0][0]).toBe(false);
  });
});

describe("maneuver feat riders (#911)", () => {
  const SLY = { athletics: { mod: 3 }, thievery: { mod: 10 }, intimidation: {} };
  const whispers = () => ChatMessage.create.mock.calls.map((c) => c[0].content).join("\n");

  it("deals Crushing Grab's Strength-modifier bludgeoning damage after a successful Grapple", async () => {
    const { attacker, opponent, combat } = setup({ slug: "grapple", outcome: "success", feats: ["crushing-grab"] });
    attacker.actor.abilities = { str: { mod: 4 } };
    await applyAgentDecision(combat, "atk", "maneuver:grapple:opp", "r");
    expect(opponent.actor.increaseCondition).toHaveBeenCalledWith("grabbed");
    expect(opponent.actor.applyDamage).toHaveBeenCalledTimes(1);
    const { damage, token } = opponent.actor.applyDamage.mock.calls[0][0];
    expect(damage.formula).toBe("4[bludgeoning]");
    expect(token).toBe(opponent.token);
    expect(whispers()).toContain("Crushing Grab");
  });

  it("also deals Crushing Grab damage on a critical success (Restrained)", async () => {
    const { attacker, opponent, combat } = setup({ slug: "grapple", outcome: "criticalSuccess", feats: ["crushing-grab"] });
    attacker.actor.abilities = { str: { mod: 3 } };
    await applyAgentDecision(combat, "atk", "maneuver:grapple:opp", "r");
    expect(opponent.actor.increaseCondition).toHaveBeenCalledWith("restrained");
    expect(opponent.actor.applyDamage.mock.calls[0][0].damage.formula).toBe("3[bludgeoning]");
  });

  it("deals no Crushing Grab damage without the feat, on a failure, or with a non-positive Strength modifier", async () => {
    let { attacker, opponent, combat } = setup({ slug: "grapple", outcome: "success" });
    attacker.actor.abilities = { str: { mod: 4 } };
    await applyAgentDecision(combat, "atk", "maneuver:grapple:opp", "r");
    expect(opponent.actor.applyDamage).not.toHaveBeenCalled();

    ({ attacker, opponent, combat } = setup({ slug: "grapple", outcome: "failure", feats: ["crushing-grab"] }));
    attacker.actor.abilities = { str: { mod: 4 } };
    await applyAgentDecision(combat, "atk", "maneuver:grapple:opp", "r");
    expect(opponent.actor.applyDamage).not.toHaveBeenCalled();

    ({ attacker, opponent, combat } = setup({ slug: "grapple", outcome: "success", feats: ["crushing-grab"] }));
    attacker.actor.abilities = { str: { mod: 0 } };
    await applyAgentDecision(combat, "atk", "maneuver:grapple:opp", "r");
    expect(opponent.actor.applyDamage).not.toHaveBeenCalled();
  });

  it("makes the target Off-Guard until the end of the turn after a successful Thievery Disarm with Sly Disarm", async () => {
    const { opponent, combat } = setup({ slug: "disarm", outcome: "success", feats: ["sly-disarm"], skills: SLY });
    await applyAgentDecision(combat, "atk", "maneuver:disarm:opp", "r");
    expect(opponent.actor.createEmbeddedDocuments).toHaveBeenCalled(); // base RAW effect still applied
    expect(opponent.actor.increaseCondition).toHaveBeenCalledWith("off-guard");
    expect(combat.getFlag(MODULE_ID, "maneuverRiderExpiry")).toEqual([
      { targetId: "opp", conditionSlug: "off-guard", expiry: { afterRoundTurn: { round: 1, turn: 0 } } },
    ]);
    expect(whispers()).toContain("Sly Disarm");
  });

  it("does not apply Sly Disarm's Off-Guard when the Disarm used Athletics", async () => {
    const { opponent, combat } = setup({
      slug: "disarm", outcome: "success", feats: ["sly-disarm"],
      skills: { athletics: { mod: 12 }, thievery: { mod: 5 }, intimidation: {} },
    });
    await applyAgentDecision(combat, "atk", "maneuver:disarm:opp", "r");
    expect(opponent.actor.increaseCondition).not.toHaveBeenCalledWith("off-guard");
    expect(combat.getFlag(MODULE_ID, "maneuverRiderExpiry")).toBeUndefined();
  });

  it("does not track (and so never later removes) Off-Guard the target already had", async () => {
    const { opponent, combat } = setup({ slug: "disarm", outcome: "success", feats: ["sly-disarm"], skills: SLY });
    opponent.actor.conditions = [{ slug: "off-guard" }];
    await applyAgentDecision(combat, "atk", "maneuver:disarm:opp", "r");
    expect(opponent.actor.increaseCondition).not.toHaveBeenCalledWith("off-guard");
    expect(combat.getFlag(MODULE_ID, "maneuverRiderExpiry")).toBeUndefined();
  });

  it("makes a lower-level target Fleeing for 1 round after a critical-success Demoralize with Terrified Retreat", async () => {
    const { opponent, combat } = setup({
      slug: "demoralize", outcome: "criticalSuccess", feats: ["terrified-retreat"], levels: [7, 4],
    });
    await applyAgentDecision(combat, "atk", "maneuver:demoralize:opp", "r");
    expect(opponent.actor.increaseCondition).toHaveBeenCalledWith("frightened", { value: 2 });
    expect(opponent.actor.increaseCondition).toHaveBeenCalledWith("fleeing");
    expect(combat.getFlag(MODULE_ID, "maneuverRiderExpiry")).toEqual([
      { targetId: "opp", conditionSlug: "fleeing", expiry: { untilRoundTurn: { round: 2, turn: 0 } } },
    ]);
    expect(whispers()).toContain("Terrified Retreat");
  });

  it("does not apply Fleeing on a plain success, or against a target of equal/higher level", async () => {
    let { opponent, combat } = setup({
      slug: "demoralize", outcome: "success", feats: ["terrified-retreat"], levels: [7, 4],
    });
    await applyAgentDecision(combat, "atk", "maneuver:demoralize:opp", "r");
    expect(opponent.actor.increaseCondition).not.toHaveBeenCalledWith("fleeing");

    ({ opponent, combat } = setup({
      slug: "demoralize", outcome: "criticalSuccess", feats: ["terrified-retreat"], levels: [7, 7],
    }));
    await applyAgentDecision(combat, "atk", "maneuver:demoralize:opp", "r");
    expect(opponent.actor.increaseCondition).not.toHaveBeenCalledWith("fleeing");
  });

  it("logs and continues when a rider fails, keeping the base outcome and reporting it to the GM", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { attacker, opponent, combat } = setup({ slug: "grapple", outcome: "success", feats: ["crushing-grab"] });
    attacker.actor.abilities = { str: { mod: 4 } };
    opponent.actor.applyDamage = vi.fn(async () => {
      throw new Error("boom");
    });
    await applyAgentDecision(combat, "atk", "maneuver:grapple:opp", "r"); // must not reject
    expect(opponent.actor.increaseCondition).toHaveBeenCalledWith("grabbed");
    expect(console.error).toHaveBeenCalled();
    expect(whispers()).toMatch(/Crushing Grab.*failed/);
    expect(combat.getFlag(MODULE_ID, "agentTurnState").actionsRemaining).toBe(2);
  });
});

// #920: the AI's own Demoralize rolls with a numeric DC, so the system
// records no target on its chat message -- the executor records the
// Antagonize floor itself; and an AI decision that is hostile toward an
// antagonizer ends that antagonizer's floor on the acting creature.
describe("Antagonize on the AI path (#920)", () => {
  const ENTRY = { antagonizerUuid: "Actor.x", sinceWorldTime: 0, unsensedSince: null };
  const whispers = () => ChatMessage.create.mock.calls.map((c) => c[0].content).join("\n");

  it("records the floor on the target after a successful Demoralize by an actor with Antagonize", async () => {
    const { opponent, combat } = setup({ slug: "demoralize", outcome: "success", feats: ["antagonize"] });
    opponent.actor.setFlag = vi.fn(async () => {});
    await applyAgentDecision(combat, "atk", "maneuver:demoralize:opp", "r");
    expect(opponent.actor.setFlag).toHaveBeenCalledWith(MODULE_ID, "antagonize.atk", {
      antagonizerUuid: null,
      sinceWorldTime: 1000,
      unsensedSince: null,
    });
    expect(whispers()).toMatch(/Antagonize: its Frightened can't fall below 1/);
  });

  it("records no floor on a failed Demoralize, or without the feat", async () => {
    let { opponent, combat } = setup({ slug: "demoralize", outcome: "failure", feats: ["antagonize"] });
    opponent.actor.setFlag = vi.fn(async () => {});
    await applyAgentDecision(combat, "atk", "maneuver:demoralize:opp", "r");
    expect(opponent.actor.setFlag).not.toHaveBeenCalled();

    ({ opponent, combat } = setup({ slug: "demoralize", outcome: "success" }));
    opponent.actor.setFlag = vi.fn(async () => {});
    await applyAgentDecision(combat, "atk", "maneuver:demoralize:opp", "r");
    expect(opponent.actor.setFlag).not.toHaveBeenCalled();
  });

  it("ends the acting creature's floor from its maneuver's target", async () => {
    const { attacker, combat } = setup({ slug: "trip", outcome: "failure" });
    attacker.actor.flags = { [MODULE_ID]: { antagonize: { opp: ENTRY } } };
    attacker.actor.unsetFlag = vi.fn(async () => {});
    await applyAgentDecision(combat, "atk", "maneuver:trip:opp", "r");
    expect(attacker.actor.unsetFlag).toHaveBeenCalledWith(MODULE_ID, "antagonize");
  });

  it("leaves a floor from anyone other than the action's target", async () => {
    const { attacker, combat } = setup({ slug: "trip", outcome: "success" });
    attacker.actor.flags = { [MODULE_ID]: { antagonize: { someoneElse: ENTRY } } };
    attacker.actor.unsetFlag = vi.fn(async () => {});
    await applyAgentDecision(combat, "atk", "maneuver:trip:opp", "r");
    expect(attacker.actor.unsetFlag).not.toHaveBeenCalled();
  });
});
