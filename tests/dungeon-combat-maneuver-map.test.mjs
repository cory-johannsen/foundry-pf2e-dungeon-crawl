import { describe, it, expect, vi, beforeEach } from "vitest";
import { applyAgentDecision } from "../scripts/dungeon-combat.mjs";

// #940: Trip/Shove/Grapple/Disarm carry the attack trait, so the module must
// pass the multiple attack penalty to the system's maneuver macro itself (the
// macros apply none on their own) and count the maneuver toward MAP.
// Demoralize has no attack trait and is exempt. Stub shape copied from
// dungeon-combat-maneuver-execution.test.mjs.

const G = 100;

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

function makeWeapon({ id, traits }) {
  return {
    id,
    name: id,
    type: "weapon",
    isEquipped: true,
    traits: new Set(traits),
    system: { equipped: { carryType: "held", handsHeld: 1 }, traits: { value: traits } },
    update: vi.fn(async () => {}),
  };
}

function makeCombatant({ id, gx, gy, disposition, type = "npc", weapons = [] }) {
  const flags = { agentControlled: true };
  return {
    id,
    name: id,
    isDefeated: false,
    token: makeToken({ x: gx * G, y: gy * G, disposition }),
    getFlag: (_m, key) => flags[key],
    actor: {
      type,
      conditions: [],
      items: [...weapons],
      itemTypes: { weapon: [...weapons] },
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

class FakeModifier {
  constructor(params) {
    Object.assign(this, params);
  }
}

function setup({ slug, mapIncrement = 0, weapons = [], character = false, feats = [], effects = [] }) {
  const attacker = makeCombatant({ id: "atk", gx: 0, gy: 0, disposition: -1, weapons });
  // #919: feat items live in actor.items (and itemTypes.feat); Panache is
  // an effect item in itemTypes.effect.
  const featItems = feats.map((s) => ({ id: s, name: s, type: "feat", slug: s }));
  const effectItems = effects.map((s) => ({ id: s, name: s, type: "effect", slug: s }));
  attacker.actor.items.push(...featItems, ...effectItems);
  attacker.actor.itemTypes.feat = featItems;
  attacker.actor.itemTypes.effect = effectItems;
  if (character) {
    // A PC's maneuver weapon comes from its ready strike actions (the
    // system's own #getApplicableEquippedWeapons for characters).
    attacker.actor.type = "character";
    attacker.actor.handsFree = 0;
    attacker.actor.isOfType = (t) => t === "character";
    attacker.actor.system.actions = weapons.map((item) => ({ ready: true, item }));
  }
  // The opponent holds a weapon so Disarm has something to knock away.
  const opponent = makeCombatant({
    id: "opp",
    gx: 1,
    gy: 0,
    disposition: 1,
    weapons: [makeWeapon({ id: "opp-sword", traits: [] })],
  });
  const flags = {
    dungeonSlot: "slot-1",
    agentTurnState: {
      combatantId: "atk",
      round: 1,
      turn: 0,
      actionsRemaining: 3,
      mapIncrement,
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
    callback({ outcome: "failure" });
  });
  game.pf2e = { actions: { [slug]: action }, Modifier: FakeModifier };
  return { combat, action, flags };
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
  globalThis.game = {
    i18n: { format: (key) => key },
    user: { flags: { pf2e: { settings: {} } }, update: vi.fn(async () => {}) },
    combats: { has: () => false },
    time: { worldTime: 1000 },
  };
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "debug").mockImplementation(() => {});
});

const passedModifiers = (action) => action.mock.calls[0][0].modifiers;

describe("applyAgentDecision maneuver MAP accounting (#940)", () => {
  it("passes no modifiers on the first attack this turn (mapIncrement 0)", async () => {
    const { combat, action } = setup({ slug: "trip", mapIncrement: 0 });
    await applyAgentDecision(combat, "atk", "maneuver:trip:opp", "r");
    expect(action).toHaveBeenCalledTimes(1);
    expect(passedModifiers(action)).toBeUndefined();
  });

  for (const slug of ["trip", "shove", "grapple", "disarm"]) {
    it(`passes a -5 MAP modifier on a second-attack ${slug} with no matching-trait weapon`, async () => {
      const { combat, action } = setup({ slug, mapIncrement: 1 });
      await applyAgentDecision(combat, "atk", `maneuver:${slug}:opp`, "r");
      const modifiers = passedModifiers(action);
      expect(modifiers).toHaveLength(1);
      expect(modifiers[0]).toBeInstanceOf(FakeModifier);
      expect(modifiers[0]).toMatchObject({
        slug: "multiple-attack-penalty",
        label: "PF2E.MultipleAttackPenalty",
        modifier: -5,
        type: "untyped",
      });
    });
  }

  it("passes a -10 MAP modifier on the third attack this turn", async () => {
    const { combat, action } = setup({ slug: "grapple", mapIncrement: 2 });
    await applyAgentDecision(combat, "atk", "maneuver:grapple:opp", "r");
    expect(passedModifiers(action)[0].modifier).toBe(-10);
  });

  it("keeps the -10 cap past the third attack", async () => {
    const { combat, action } = setup({ slug: "grapple", mapIncrement: 3 });
    await applyAgentDecision(combat, "atk", "maneuver:grapple:opp", "r");
    expect(passedModifiers(action)[0].modifier).toBe(-10);
  });

  it("uses -4/-8 when the NPC's equipped trip-trait weapon is agile", async () => {
    const weapons = [makeWeapon({ id: "whip", traits: ["trip", "agile", "finesse"] })];
    let { combat, action } = setup({ slug: "trip", mapIncrement: 1, weapons });
    await applyAgentDecision(combat, "atk", "maneuver:trip:opp", "r");
    expect(passedModifiers(action)[0].modifier).toBe(-4);

    ({ combat, action } = setup({ slug: "trip", mapIncrement: 2, weapons }));
    await applyAgentDecision(combat, "atk", "maneuver:trip:opp", "r");
    expect(passedModifiers(action)[0].modifier).toBe(-8);
  });

  it("uses -5 when the matching-trait weapon is not agile", async () => {
    const weapons = [makeWeapon({ id: "guisarme", traits: ["trip", "reach"] })];
    const { combat, action } = setup({ slug: "trip", mapIncrement: 1, weapons });
    await applyAgentDecision(combat, "atk", "maneuver:trip:opp", "r");
    expect(passedModifiers(action)[0].modifier).toBe(-5);
  });

  it("ignores an agile weapon that lacks the maneuver's own trait", async () => {
    const weapons = [makeWeapon({ id: "dagger", traits: ["agile", "finesse"] })];
    const { combat, action } = setup({ slug: "shove", mapIncrement: 1, weapons });
    await applyAgentDecision(combat, "atk", "maneuver:shove:opp", "r");
    expect(passedModifiers(action)[0].modifier).toBe(-5);
  });

  it("reads a character's maneuver weapon from its ready strike actions", async () => {
    const weapons = [makeWeapon({ id: "whip", traits: ["disarm", "trip", "agile"] })];
    const { combat, action } = setup({ slug: "disarm", mapIncrement: 1, weapons, character: true });
    await applyAgentDecision(combat, "atk", "maneuver:disarm:opp", "r");
    expect(passedModifiers(action)[0].modifier).toBe(-4);
  });

  it("never passes a MAP modifier for demoralize and does not count it as an attack", async () => {
    const { combat, action, flags } = setup({ slug: "demoralize", mapIncrement: 2 });
    await applyAgentDecision(combat, "atk", "maneuver:demoralize:opp", "r");
    expect(action).toHaveBeenCalledTimes(1);
    expect(passedModifiers(action)).toBeUndefined();
    expect(flags.agentTurnState.mapIncrement).toBe(2);
  });

  it("counts an attack-trait maneuver toward this turn's MAP", async () => {
    const { combat, flags } = setup({ slug: "trip", mapIncrement: 1 });
    await applyAgentDecision(combat, "atk", "maneuver:trip:opp", "r");
    expect(flags.agentTurnState.mapIncrement).toBe(2);
    expect(flags.agentTurnState.actionsRemaining).toBe(2);
  });
});

describe("applyAgentDecision maneuver MAP with Agile Maneuvers (#919)", () => {
  it("passes -4/-8 when the actor has Agile Maneuvers but no agile weapon", async () => {
    let { combat, action } = setup({ slug: "trip", mapIncrement: 1, feats: ["agile-maneuvers"] });
    await applyAgentDecision(combat, "atk", "maneuver:trip:opp", "r");
    expect(passedModifiers(action)[0]).toMatchObject({ slug: "multiple-attack-penalty", modifier: -4 });

    ({ combat, action } = setup({ slug: "grapple", mapIncrement: 2, feats: ["agile-maneuvers"] }));
    await applyAgentDecision(combat, "atk", "maneuver:grapple:opp", "r");
    expect(passedModifiers(action)[0].modifier).toBe(-8);
  });

  it("passes -3/-6 with Agile Maneuvers, an agile maneuver weapon, AND active Panache", async () => {
    const weapons = [makeWeapon({ id: "whip", traits: ["trip", "disarm", "agile"] })];
    const opts = { weapons, feats: ["agile-maneuvers"], effects: ["effect-panache"] };
    let { combat, action } = setup({ slug: "trip", mapIncrement: 1, ...opts });
    await applyAgentDecision(combat, "atk", "maneuver:trip:opp", "r");
    expect(passedModifiers(action)[0].modifier).toBe(-3);

    ({ combat, action } = setup({ slug: "disarm", mapIncrement: 2, ...opts }));
    await applyAgentDecision(combat, "atk", "maneuver:disarm:opp", "r");
    expect(passedModifiers(action)[0].modifier).toBe(-6);
  });

  it("falls back to -4 when the weapon is agile but Panache is not active", async () => {
    const weapons = [makeWeapon({ id: "whip", traits: ["trip", "agile"] })];
    const { combat, action } = setup({ slug: "trip", mapIncrement: 1, weapons, feats: ["agile-maneuvers"] });
    await applyAgentDecision(combat, "atk", "maneuver:trip:opp", "r");
    expect(passedModifiers(action)[0].modifier).toBe(-4);
  });

  it("falls back to -4 when Panache is active but the maneuver weapon is not agile", async () => {
    const { combat, action } = setup({
      slug: "shove",
      mapIncrement: 1,
      feats: ["agile-maneuvers"],
      effects: ["effect-panache"],
    });
    await applyAgentDecision(combat, "atk", "maneuver:shove:opp", "r");
    expect(passedModifiers(action)[0].modifier).toBe(-4);
  });

  it("keeps the #940 baseline (-5) without the feat, even with Panache", async () => {
    const { combat, action } = setup({ slug: "shove", mapIncrement: 1, effects: ["effect-panache"] });
    await applyAgentDecision(combat, "atk", "maneuver:shove:opp", "r");
    expect(passedModifiers(action)[0].modifier).toBe(-5);
  });

  it("still passes no modifier on the first attack with the feat", async () => {
    const { combat, action } = setup({ slug: "trip", mapIncrement: 0, feats: ["agile-maneuvers"] });
    await applyAgentDecision(combat, "atk", "maneuver:trip:opp", "r");
    expect(passedModifiers(action)).toBeUndefined();
  });

  it("never gives demoralize a MAP modifier, even with Agile Maneuvers", async () => {
    const { combat, action } = setup({
      slug: "demoralize",
      mapIncrement: 2,
      feats: ["agile-maneuvers"],
      effects: ["effect-panache"],
    });
    await applyAgentDecision(combat, "atk", "maneuver:demoralize:opp", "r");
    expect(passedModifiers(action)).toBeUndefined();
  });
});
