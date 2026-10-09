import { describe, it, expect, vi, beforeEach } from "vitest";
import { getPendingAgentTurn } from "../scripts/dungeon-combat.mjs";

// #910: getPendingAgentTurn builds the turn's feat vocabulary next to the
// maneuver vocabulary. Stub shape copied from
// dungeon-combat-agent-maneuver-pending.test.mjs.

const G = 100;

beforeEach(() => {
  globalThis.CONST = {
    WALL_MOVEMENT_TYPES: { NONE: 0, NORMAL: 20 },
    WALL_DOOR_TYPES: { NONE: 0, DOOR: 1, SECRET: 2 },
    WALL_DOOR_STATES: { CLOSED: 0, OPEN: 1, LOCKED: 2 },
  };
  globalThis.foundry = { utils: {} };
  globalThis.ChatMessage = { create: async () => {}, getWhisperRecipients: () => [] };
  globalThis.game = {
    user: { isGM: true, flags: { pf2e: { settings: {} } }, update: async () => {} },
    i18n: { format: (k) => k },
    messages: { contents: [] },
    combats: { contents: [], has: () => false },
    modules: { get: () => ({ version: "0" }) },
    time: { worldTime: 1000 },
  };
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "debug").mockImplementation(() => {});
});

function mk(id, gx, gy, disposition, { type = "npc", skills = {}, size = "med", immunities = [], agent = true, held = true } = {}) {
  const flags = { agentControlled: agent };
  const items = held ? [{ type: "weapon", system: { equipped: { carryType: "held" } } }] : [];
  return {
    id,
    name: id,
    isDefeated: false,
    token: { x: gx * G, y: gy * G, disposition, width: 1, height: 1 },
    getFlag: (_m, k) => flags[k],
    actor: {
      type,
      conditions: [],
      items,
      skills,
      itemTypes: { weapon: [] },
      attributes: { immunities },
      system: {
        actions: [],
        traits: { size: { value: size } },
        attributes: { hp: { value: 20, max: 20 } },
        movement: { speeds: { land: { value: 30 } } },
      },
    },
  };
}

function mkCombat(combatants, current) {
  const flags = { dungeonSlot: "slot-1", reactionUsed: {} };
  return {
    id: "c1",
    round: 1,
    turn: 0,
    combatant: current,
    combatants,
    getFlag: (_m, k) => flags[k],
    setFlag: async (_m, k, v) => {
      flags[k] = v;
    },
    scene: {
      id: "s",
      grid: { size: G, distance: 5 },
      width: 10 * G,
      height: 3 * G,
      tokens: [],
      walls: { contents: [] },
      regions: [],
    },
  };
}

const RAGE_EFFECT = "Compendium.pf2e.feat-effects.Item.z3uyCMBddrPK5umr";

function rageItem() {
  return {
    id: "rage1",
    uuid: "Actor.atk.Item.rage1",
    slug: "rage",
    name: "Rage",
    system: {
      actionType: { value: "action" },
      actions: { value: 1 },
      selfEffect: { uuid: RAGE_EFFECT, name: "Effect: Rage" },
      frequency: null,
      traits: { value: ["barbarian", "concentrate", "emotion", "mental"] },
      rules: [],
    },
    flags: { pf2e: { rulesSelections: {} } },
  };
}

function withFeats(c, { action = [], feat = [], effect = [] } = {}) {
  c.actor.itemTypes = { ...c.actor.itemTypes, action, feat, effect };
  return c;
}

beforeEach(() => {
  // #914: the linked effect needs real rules to pass the derived filter.
  globalThis.fromUuid = vi.fn(async (uuid) =>
    uuid === RAGE_EFFECT
      ? { slug: "effect-rage", system: { rules: [{ key: "TempHP", value: 1 }], duration: { value: 1, unit: "minutes" } } }
      : null,
  );
});

describe("getPendingAgentTurn feat vocabulary (#910)", () => {
  it("includes an eligible self-effect item in featVocabulary", async () => {
    const me = withFeats(mk("atk", 0, 0, -1, { type: "character" }), { action: [rageItem()] });
    const opp = mk("opp1", 1, 0, 1);
    const pending = await getPendingAgentTurn(mkCombat([me, opp], me));
    expect(pending.featVocabulary).toEqual([
      { type: "feat", kind: "selfEffect", itemId: "rage1", slug: "rage", name: "Rage", cost: 1, targetId: null, replacesStance: null, traits: [], effectSummary: "temp HP", durationLabel: "1 minutes", frequencyLabel: null },
    ]);
  });

  it("includes an eligible composite feat against a real opponent", async () => {
    const me = withFeats(mk("atk", 0, 0, -1, { type: "character" }), {
      feat: [{ id: "lunge1", slug: "lunge", name: "Lunge", system: { actionType: { value: "action" }, actions: { value: 1 }, traits: { value: ["fighter"] } } }],
    });
    me.actor.system.actions = [
      { type: "strike", ready: true, label: "Longsword", traits: [], item: { id: "w1", slug: "longsword", type: "weapon", system: { category: "martial", range: null, equipped: { carryType: "held", handsHeld: 1 }, traits: { value: [] } } } },
    ];
    const opp = mk("opp1", 2, 0, 1);
    const pending = await getPendingAgentTurn(mkCombat([me, opp], me));
    expect(pending.featVocabulary).toEqual([
      { type: "feat", kind: "composite", itemId: "lunge1", slug: "lunge", name: "Lunge", cost: 1, targetId: "opp1", traits: [] },
    ]);
  });

  it("returns an empty featVocabulary for an actor with no eligible self-effect or composite feat", async () => {
    const me = withFeats(mk("atk", 0, 0, -1, { type: "character" }));
    const opp = mk("opp1", 1, 0, 1);
    const pending = await getPendingAgentTurn(mkCombat([me, opp], me));
    expect(pending.featVocabulary).toEqual([]);
  });

  it("returns an empty featVocabulary for an actor with no itemTypes at all", async () => {
    const me = mk("atk", 0, 0, -1, { type: "character" });
    const opp = mk("opp1", 1, 0, 1);
    const pending = await getPendingAgentTurn(mkCombat([me, opp], me));
    expect(pending.featVocabulary).toEqual([]);
  });

  it("turns a persisted feat pick into a real candidate", async () => {
    const me = withFeats(mk("atk", 0, 0, -1, { type: "character" }), { action: [rageItem()] });
    const opp = mk("opp1", 1, 0, 1);
    const combat = mkCombat([me, opp], me);
    await combat.setFlag("pf2e-dungeon-crawl", "agentTurnState", {
      combatantId: "atk", round: 1, turn: 0, actionsRemaining: 3, mapIncrement: 0,
      maneuverPicks: [{ type: "feat", slug: "rage", targetId: null, rationale: "r" }],
      counter: 1,
    });
    const pending = await getPendingAgentTurn(combat);
    expect(pending.candidates.filter((c) => c.type === "feat").map((c) => c.id)).toEqual(["feat:rage1"]);
  });

  it("drops stance entries once the persisted turn state records a stance action this turn", async () => {
    const stance = { ...rageItem(), id: "st1", uuid: "Actor.atk.Item.st1", slug: "gorilla-stance", name: "Gorilla Stance" };
    stance.system = { ...stance.system, traits: { value: ["stance"] } };
    const me = withFeats(mk("atk", 0, 0, -1, { type: "character" }), { feat: [stance] });
    const opp = mk("opp1", 1, 0, 1);
    const combat = mkCombat([me, opp], me);
    await combat.setFlag("pf2e-dungeon-crawl", "agentTurnState", {
      combatantId: "atk", round: 1, turn: 0, actionsRemaining: 2, mapIncrement: 0,
      maneuverPicks: [], stanceUsed: true, flourishUsed: false, counter: 1,
    });
    const pending = await getPendingAgentTurn(combat);
    expect(pending.featVocabulary).toEqual([]);
  });

  it("does not offer Demoralize (concentrate) while raging", async () => {
    const me = withFeats(mk("atk", 0, 0, -1, { type: "character", skills: { athletics: {}, intimidation: {} } }), {
      effect: [{ id: "e1", slug: "effect-rage", system: { traits: { value: [] } } }],
    });
    const opp = mk("opp1", 1, 0, 1);
    const pending = await getPendingAgentTurn(mkCombat([me, opp], me));
    expect(pending.maneuverVocabulary.map((v) => v.slug)).not.toContain("demoralize");
    expect(pending.maneuverVocabulary.map((v) => v.slug)).toContain("trip");
  });
});
