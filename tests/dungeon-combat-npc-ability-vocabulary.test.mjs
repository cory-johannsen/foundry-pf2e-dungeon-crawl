import { describe, it, expect, vi, beforeEach } from "vitest";
import { computeReadyNpcAbilities, getPendingAgentTurn } from "../scripts/dungeon-combat.mjs";

// #915: the Foundry-touching half of NPC-ability readiness, and its wiring
// into getPendingAgentTurn. getPendingAgentTurn stub shape copied from
// dungeon-combat-agent-feat-pending.test.mjs.

const G = 100;
const EMANATION = '<p>Creatures within @Template[emanation|distance:50]{50 feet} must attempt a @Check[will|dc:27] save.</p><hr /><p><strong>Critical Success</strong> The creature is unaffected.</p><p><strong>Success</strong> The creature is unaffected.</p><p><strong>Failure</strong> The creature is frightened 1.</p><p><strong>Critical Failure</strong> The creature is frightened 2.</p>';
const TOUCH = '<p>The vanth touches a creature, which must attempt a @Check[will|dc:25] save.</p><hr /><p><strong>Critical Success</strong> The target is unaffected.</p><p><strong>Success</strong> The target is unaffected.</p><p><strong>Failure</strong> The target is stupefied 1 for 1 minute.</p><p><strong>Critical Failure</strong> As failure.</p>';

function actionItem({ id, name, description, cost = 2, frequency = null, traits = [] }) {
  return {
    id, name, slug: null, type: "action",
    system: { actionType: { value: "action" }, actions: { value: cost }, traits: { value: traits }, frequency, description: { value: description } },
  };
}

describe("computeReadyNpcAbilities (#915)", () => {
  beforeEach(() => {
    globalThis.game = { time: { worldTime: 1000 } };
  });

  it("splits parsed abilities into area and single-target lists, skipping unparseable items", () => {
    const actor = {
      itemTypes: {
        action: [
          actionItem({ id: "i1", name: "Terrifying Display", description: EMANATION }),
          actionItem({ id: "i2", name: "Bite", description: "<p>A plain Strike, no save.</p>", cost: 1 }),
          actionItem({ id: "i3", name: "Vanth's Curse", description: TOUCH }),
        ],
      },
    };
    const combat = { getFlag: () => undefined, round: 1 };
    const { readyAreaAbilities, readySingleTargetAbilities } = computeReadyNpcAbilities(combat, { id: "c1", actor });
    expect(readyAreaAbilities).toEqual([
      expect.objectContaining({ itemId: "i1", slug: "terrifying-display", name: "Terrifying Display", mode: "auto", cost: 2, areaType: "emanation", distanceFeet: 50, affectsAllies: true, immuneIds: [] }),
    ]);
    expect(readyAreaAbilities[0].summary).toMatch(/^will DC 27, 50-ft emanation/);
    expect(readySingleTargetAbilities).toEqual([
      expect.objectContaining({ itemId: "i3", slug: "vanth-s-curse", rangeFeet: 5 }),
    ]);
  });

  it("excludes an ability still on recharge cooldown (keyed by the name-derived slug, as breath weapons are)", () => {
    const actor = { itemTypes: { action: [actionItem({ id: "i1", name: "Terrifying Display", description: EMANATION })] } };
    const combat = { getFlag: (_m, k) => (k === "abilityRecharge" ? { c1: { "terrifying-display": { availableAtRound: 5 } } } : undefined), round: 1 };
    expect(computeReadyNpcAbilities(combat, { id: "c1", actor }).readyAreaAbilities).toHaveLength(0);
  });

  it("excludes an ability with no frequency uses remaining", () => {
    const actor = { itemTypes: { action: [actionItem({ id: "i1", name: "Vanth's Curse", description: TOUCH, frequency: { value: 0, max: 3, per: "day" } })] } };
    const combat = { getFlag: () => undefined, round: 1 };
    expect(computeReadyNpcAbilities(combat, { id: "c1", actor }).readySingleTargetAbilities).toHaveLength(0);
  });

  it("marks a creature immune to the ability's traits (the system's own isImmuneTo) as immune", () => {
    const item = actionItem({ id: "i1", name: "Terrifying Display", description: EMANATION, traits: ["mental"] });
    const actor = { itemTypes: { action: [item] } };
    const combat = { getFlag: () => undefined, round: 1 };
    const zombie = { id: "z", actor: { isImmuneTo: vi.fn((i) => i === item) } };
    const fighter = { id: "f", actor: { isImmuneTo: vi.fn(() => false) } };
    const { readyAreaAbilities } = computeReadyNpcAbilities(combat, { id: "c1", actor }, [zombie, fighter]);
    expect(readyAreaAbilities[0].immuneIds).toEqual(["z"]);
  });
});

describe("getPendingAgentTurn npcAbilityVocabulary (#915)", () => {
  function mk(id, gx, gy, disposition, { items = [] } = {}) {
    const flags = { agentControlled: true };
    return {
      id, name: id, isDefeated: false,
      token: { x: gx * G, y: gy * G, disposition, width: 1, height: 1 },
      getFlag: (_m, k) => flags[k],
      actor: {
        type: "npc", conditions: [], items, skills: {},
        itemTypes: { weapon: [], action: items, feat: [], effect: [] },
        attributes: { immunities: [] },
        system: { actions: [], traits: { size: { value: "med" } }, attributes: { hp: { value: 20, max: 20 } }, movement: { speeds: { land: { value: 30 } } } },
      },
    };
  }

  function mkCombat(combatants, current) {
    const flags = { dungeonSlot: "slot-1", reactionUsed: {} };
    return {
      id: "c1", round: 1, turn: 0, combatant: current, combatants,
      getFlag: (_m, k) => flags[k],
      setFlag: async (_m, k, v) => { flags[k] = v; },
      scene: {
        id: "s", grid: { size: G, distance: 5 }, width: 10 * G, height: 3 * G, tokens: [], walls: { contents: [] }, regions: [],
        // A circle "template" containing exactly the points within its radius.
        createEmbeddedDocuments: vi.fn(async (_t, data) => data.map((d, i) => ({ id: `t${i}`, ...d }))),
        deleteEmbeddedDocuments: vi.fn(async () => {}),
      },
    };
  }

  beforeEach(() => {
    globalThis.CONST = {
      WALL_MOVEMENT_TYPES: { NONE: 0, NORMAL: 20 },
      WALL_DOOR_TYPES: { NONE: 0, DOOR: 1, SECRET: 2 },
      WALL_DOOR_STATES: { CLOSED: 0, OPEN: 1, LOCKED: 2 },
    };
    globalThis.foundry = { utils: {} };
    globalThis.ChatMessage = { create: async () => {}, getWhisperRecipients: () => [] };
    globalThis.fromUuid = vi.fn(async () => null);
    globalThis.game = {
      user: { isGM: true, flags: { pf2e: { settings: {} } }, update: async () => {} },
      i18n: { format: (k) => k },
      messages: { contents: [] },
      combats: { contents: [], has: () => false },
      modules: { get: () => ({ version: "0" }) },
      time: { worldTime: 1000 },
      scenes: { viewed: { id: "s" } },
    };
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "debug").mockImplementation(() => {});
  });

  it("offers a touch ability against each adjacent opponent", async () => {
    const me = mk("vanth", 0, 0, -1, { items: [actionItem({ id: "i3", name: "Vanth's Curse", description: TOUCH })] });
    const near = mk("pc1", 1, 0, 1);
    const far = mk("pc2", 4, 0, 1);
    const pending = await getPendingAgentTurn(mkCombat([me, near, far], me));
    expect(pending.npcAbilityVocabulary).toEqual([
      expect.objectContaining({ type: "npcAbility", itemId: "i3", slug: "vanth-s-curse", targetId: "pc1", affectedIds: ["pc1"], mode: "auto" }),
    ]);
  });

  it("offers an emanation once, with every opponent inside it, using the real template containment", async () => {
    const me = mk("ape", 0, 0, -1, { items: [actionItem({ id: "i1", name: "Terrifying Display", description: EMANATION })] });
    const pc1 = mk("pc1", 2, 0, 1);
    const pc2 = mk("pc2", 9, 0, 1);
    globalThis.canvas = {
      templates: {
        get: () => ({ shape: { contains: (dx, dy) => Math.hypot(dx, dy) <= (50 / 5) * G - 1 } }),
      },
    };
    const pending = await getPendingAgentTurn(mkCombat([me, pc1, pc2], me));
    expect(pending.npcAbilityVocabulary).toEqual([
      expect.objectContaining({ type: "npcAbility", itemId: "i1", targetId: null, centerType: "self", affectedIds: ["pc1", "pc2"] }),
    ]);
  });

  it("returns an empty npcAbilityVocabulary for an actor with no in-scope ability", async () => {
    const me = mk("goblin", 0, 0, -1);
    const pending = await getPendingAgentTurn(mkCombat([me, mk("pc1", 1, 0, 1)], me));
    expect(pending.npcAbilityVocabulary).toEqual([]);
  });
});
