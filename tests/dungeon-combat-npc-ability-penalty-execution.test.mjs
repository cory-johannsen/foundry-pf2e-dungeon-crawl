import { describe, it, expect, vi, beforeEach } from "vitest";
import { applyAgentDecision, getNpcAbilityImmunityUntil } from "../scripts/dungeon-combat.mjs";

// #935: executing the widened NPC save-ability outcomes through the real
// applyAgentDecision -> getPendingAgentTurn path (harness copied from
// dungeon-combat-npc-ability-execution.test.mjs): penalty outcomes become a
// synthesized effect item, an inline-outcome ability runs automatically,
// and a creature outside the ability's stated targets is never rolled.

const G = 100;
const DEGREES = ["criticalFailure", "failure", "success", "criticalSuccess"];

const PENALTY_TOUCH = '<p>The hag touches a creature, which must attempt a @Check[will|dc:27] save.</p><hr /><p><strong>Critical Success</strong> The target is unaffected.</p><p><strong>Success</strong> The target takes a –1 status penalty to Will saves for 1 round.</p><p><strong>Failure</strong> The target is @UUID[Compendium.pf2e.conditionitems.Item.Dazzled]{Dazzled} for 1 minute and takes a –1 status penalty to attack rolls and saving throws for 1 minute.</p><p><strong>Critical Failure</strong> As failure.</p>';
// Boggard Warrior's Terrifying Croak (Monster Core), compiled-pack form.
const CROAK = '<p>The boggard warrior unleashes a terrifying croak. Any non-boggard within @Template[emanation|distance:30]{30 feet} becomes @UUID[Compendium.pf2e.conditionitems.Item.TBSHQspnbcqxsmjL]{Frightened 1} unless they succeed at a @Check[will|dc:18] save; those who critically succeed are temporarily immune for 1 minute.</p>';

function makeToken({ x, y, disposition }) {
  return { x, y, disposition, width: 1, height: 1, update: vi.fn(), move: vi.fn() };
}

function makeCombatant({ id, gx, gy, disposition, level = 1, outcome = "failure", items = [], traits = [] }) {
  const flags = { agentControlled: true };
  const conditions = [];
  const actor = {
    type: "npc",
    level,
    conditions,
    items,
    itemTypes: { weapon: [], action: items, feat: [], effect: [] },
    skills: {},
    attributes: { immunities: [] },
    getCondition: vi.fn((slug) => conditions.find((c) => c.slug === slug) ?? null),
    increaseCondition: vi.fn(async () => {}),
    createEmbeddedDocuments: vi.fn(async (_t, data) => data),
    uuid: `Actor.${id}`,
    traits: new Set(traits),
    isImmuneTo: vi.fn(() => false),
    saves: {
      will: { roll: vi.fn(async () => ({ degreeOfSuccess: DEGREES.indexOf(outcome) })) },
    },
    system: {
      actions: [],
      traits: { size: { value: "med" } },
      attributes: { hp: { value: 20, max: 20 } },
      movement: { speeds: { land: { value: 30 } } },
    },
  };
  return { id, name: id, isDefeated: false, token: makeToken({ x: gx * G, y: gy * G, disposition }), getFlag: (_m, k) => flags[k], actor };
}

function abilityItem({ id = "ab1", name = "Hag Touch", description = PENALTY_TOUCH, traits = [], frequency = null } = {}) {
  return {
    id, name, slug: null, type: "action", uuid: `Actor.hag.Item.${id}`, img: "icons/x.webp",
    system: { actionType: { value: "action" }, actions: { value: 2 }, traits: { value: traits }, frequency, description: { value: description } },
    update: vi.fn(async () => {}),
    toMessage: vi.fn(async () => {}),
  };
}

function setup({ item = abilityItem(), outcomes = { pc1: "failure" }, pcTraits = {}, pick = { type: "npcAbility", slug: "hag-touch", targetId: "pc1", rationale: "r" } } = {}) {
  const npc = makeCombatant({ id: "hag", gx: 0, gy: 0, disposition: -1, level: 5, items: [item] });
  const pcs = Object.entries(outcomes).map(([id, outcome], i) => makeCombatant({ id, gx: 1, gy: i, disposition: 1, outcome, traits: pcTraits[id] ?? [] }));
  const flags = {
    dungeonSlot: "slot-1",
    agentTurnState: { combatantId: "hag", round: 1, turn: 0, actionsRemaining: 3, mapIncrement: 0, maneuverPicks: [pick], counter: 1 },
  };
  const combatants = [npc, ...pcs];
  const combat = {
    id: "combat-1", round: 1, turn: 0, combatant: npc, combatants, turns: combatants,
    getFlag: (_m, k) => flags[k],
    setFlag: async (_m, k, v) => { flags[k] = v; },
    scene: {
      id: "s", grid: { size: G, distance: 5 }, width: 8 * G, height: 4 * G, walls: { contents: [] }, regions: [],
      createEmbeddedDocuments: vi.fn(async (_t, data) => data.map((d, i) => ({ id: `t${i}`, ...d }))),
      deleteEmbeddedDocuments: vi.fn(async () => {}),
    },
  };
  return { npc, pcs, combat, item, flags };
}

beforeEach(() => {
  globalThis.CONST = {
    WALL_MOVEMENT_TYPES: { NONE: 0, NORMAL: 20 },
    WALL_DOOR_TYPES: { NONE: 0, DOOR: 1, SECRET: 2 },
    WALL_DOOR_STATES: { CLOSED: 0, OPEN: 1, LOCKED: 2 },
  };
  globalThis.foundry = { utils: {} };
  globalThis.ChatMessage = { create: vi.fn(async () => {}), getWhisperRecipients: () => [{ id: "gm1" }] };
  globalThis.CONFIG = { PF2E: { actionTraits: { incapacitation: "x", mental: "x" } } };
  globalThis.Roll = class { constructor(f) { this.f = f; } async evaluate() { this.total = 2; return this; } };
  globalThis.fromUuid = vi.fn(async () => null);
  globalThis.canvas = { templates: { get: () => ({ shape: { contains: () => true } }) } };
  globalThis.game = {
    i18n: { format: (k) => k },
    user: { isGM: true, flags: { pf2e: { settings: {} } }, update: vi.fn(async () => {}) },
    combats: { has: () => false },
    messages: { contents: [] },
    time: { worldTime: 1000 },
    scenes: { viewed: { id: "s" } },
  };
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "debug").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

beforeEach(() => {
  globalThis.CONST = {
    WALL_MOVEMENT_TYPES: { NONE: 0, NORMAL: 20 },
    WALL_DOOR_TYPES: { NONE: 0, DOOR: 1, SECRET: 2 },
    WALL_DOOR_STATES: { CLOSED: 0, OPEN: 1, LOCKED: 2 },
  };
  globalThis.foundry = { utils: {} };
  globalThis.ChatMessage = { create: vi.fn(async () => {}), getWhisperRecipients: () => [{ id: "gm1" }] };
  globalThis.CONFIG = { PF2E: { actionTraits: { incapacitation: "x", mental: "x" } } };
  globalThis.Roll = class { constructor(f) { this.f = f; } async evaluate() { this.total = 2; return this; } };
  globalThis.fromUuid = vi.fn(async () => null);
  globalThis.canvas = { templates: { get: () => ({ shape: { contains: () => true } }) } };
  globalThis.game = {
    i18n: { format: (k) => k },
    user: { isGM: true, flags: { pf2e: { settings: {} } }, update: vi.fn(async () => {}) },
    combats: { has: () => false },
    messages: { contents: [] },
    time: { worldTime: 1000 },
    scenes: { viewed: { id: "s" } },
  };
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "debug").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

const whispers = () => ChatMessage.create.mock.calls.map((c) => c[0].content).join("\n");

describe("NPC save-ability penalty outcomes (#935)", () => {
  it("creates one effect item on the target with a FlatModifier per selector, the NPC as origin and a self-expiring duration", async () => {
    const { pcs, combat } = setup();
    await applyAgentDecision(combat, "hag", "npcAbility:ab1:pc1", "r");
    expect(pcs[0].actor.increaseCondition).toHaveBeenCalledWith("dazzled");
    expect(pcs[0].actor.createEmbeddedDocuments).toHaveBeenCalledTimes(1);
    const [type, [source]] = pcs[0].actor.createEmbeddedDocuments.mock.calls[0];
    expect(type).toBe("Item");
    expect(source.type).toBe("effect");
    expect(source.name).toBe("Hag Touch (penalty)");
    expect(source.system.duration).toEqual({ value: 1, unit: "minutes", expiry: "turn-start", sustained: false });
    expect(source.system.rules).toEqual([
      { key: "FlatModifier", selector: "attack-roll", type: "status", value: -1 },
      { key: "FlatModifier", selector: "saving-throw", type: "status", value: -1 },
    ]);
    expect(source.system.context.origin).toEqual(expect.objectContaining({ actor: "Actor.hag", item: "Actor.hag.Item.ab1" }));
    expect(source.system.context.target.actor).toBe("Actor.pc1");
    expect(whispers()).toMatch(/-1 status penalty to attack-roll\/saving-throw \(1 minute\)/);
  });

  it("maps a round duration to rounds, and the critical failure's \"As failure\" applies the same penalty", async () => {
    const success = setup({ outcomes: { pc1: "success" } });
    await applyAgentDecision(success.combat, "hag", "npcAbility:ab1:pc1", "r");
    const [, [source]] = success.pcs[0].actor.createEmbeddedDocuments.mock.calls[0];
    expect(source.system.duration).toEqual({ value: 1, unit: "rounds", expiry: "turn-start", sustained: false });
    expect(source.system.rules).toEqual([{ key: "FlatModifier", selector: "will", type: "status", value: -1 }]);
    const crit = setup({ outcomes: { pc1: "criticalFailure" } });
    await applyAgentDecision(crit.combat, "hag", "npcAbility:ab1:pc1", "r");
    expect(crit.pcs[0].actor.createEmbeddedDocuments.mock.calls[0][1][0].system.rules).toHaveLength(2);
  });

  it("reports a failed effect creation for the GM to apply by hand, still applying the degree's conditions", async () => {
    const { pcs, combat } = setup();
    pcs[0].actor.createEmbeddedDocuments = vi.fn(async () => { throw new Error("boom"); });
    await expect(applyAgentDecision(combat, "hag", "npcAbility:ab1:pc1", "r")).resolves.not.toThrow();
    expect(pcs[0].actor.increaseCondition).toHaveBeenCalledWith("dazzled");
    expect(whispers()).toMatch(/penalty to attack-roll\/saving-throw \(1 minute\) FAILED -- apply by hand/);
  });
});

describe("NPC inline-outcome abilities and target filters (#935)", () => {
  const croak = () => abilityItem({ name: "Terrifying Croak", description: CROAK, traits: ["auditory", "emotion", "fear", "mental"] });
  const pick = { type: "npcAbility", slug: "terrifying-croak", targetId: null, rationale: "r" };

  it("runs Terrifying Croak automatically, never rolling a boggard, and tells the GM the outcome came from inline text", async () => {
    const { pcs, combat } = setup({
      item: croak(),
      outcomes: { pc1: "failure", pc2: "failure" },
      pcTraits: { pc2: ["boggard", "humanoid"] },
      pick,
    });
    await applyAgentDecision(combat, "hag", "npcAbility:ab1", "r");
    expect(pcs[0].actor.saves.will.roll).toHaveBeenCalled();
    expect(pcs[0].actor.increaseCondition).toHaveBeenCalledWith("frightened", { value: 1 });
    expect(pcs[1].actor.saves.will.roll).not.toHaveBeenCalled();
    expect(pcs[1].actor.increaseCondition).not.toHaveBeenCalled();
    expect(whispers()).toMatch(/Outcome parsed from the ability's inline text/);
  });

  it("records the critical-success-only immunity", async () => {
    const { combat } = setup({ item: croak(), outcomes: { pc1: "criticalSuccess", pc2: "success" }, pick });
    await applyAgentDecision(combat, "hag", "npcAbility:ab1", "r");
    expect(getNpcAbilityImmunityUntil(combat, "ab1", "pc1")).toBe(1000 + 60);
    expect(getNpcAbilityImmunityUntil(combat, "ab1", "pc2")).toBe(0);
  });
});
