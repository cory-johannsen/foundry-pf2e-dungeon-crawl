import { describe, it, expect, vi, beforeEach } from "vitest";
import { applyAgentDecision, getNpcAbilityImmunityUntil } from "../scripts/dungeon-combat.mjs";

// #915: applyAgentDecision's `npcAbility` branch, driven end-to-end through
// the real getPendingAgentTurn rebuild (stub shape copied from
// dungeon-combat-maneuver-execution.test.mjs). Each test seeds the turn's
// persisted picks so the chosen ability is a real candidate.

const G = 100;
const MODULE_ID = "pf2e-dungeon-crawl";
const DEGREES = ["criticalFailure", "failure", "success", "criticalSuccess"];

const TOUCH_AUTO = '<p>The hag touches a creature, which must attempt a @Check[will|dc:27|options:inflicts:stupefied] save.</p><hr /><p><strong>Critical Success</strong> The target is unaffected and is temporarily immune for 24 hours.</p><p><strong>Success</strong> The target is @UUID[Compendium.pf2e.conditionitems.Item.Dazzled]{Dazzled} for 1 round.</p><p><strong>Failure</strong> The target is @UUID[Compendium.pf2e.conditionitems.Item.Frightened]{Frightened 2} and @UUID[Compendium.pf2e.conditionitems.Item.Fleeing]{Fleeing} until the end of its next turn.</p><p><strong>Critical Failure</strong> For 1 minute, the target is @UUID[Compendium.pf2e.conditionitems.Item.Stupefied]{Stupefied 2}.</p>';
const TOUCH_REPORT = '<p>The vanth touches a creature, which must attempt a @Check[will|dc:25] save.</p><hr /><p><strong>Critical Success</strong> The target is unaffected.</p><p><strong>Success</strong> The target is unaffected.</p><p><strong>Failure</strong> The target is stupefied 2. Each time the target gains the dying condition, the value increases.</p><p><strong>Critical Failure</strong> As failure.</p>';
const SCREECH = '<p>Each creature in an @Template[emanation|distance:30] must attempt a @Check[will|dc:20] save. Regardless of the result, creatures are temporarily immune for 1 minute.</p><hr /><p><strong>Critical Success</strong> The creature is unaffected.</p><p><strong>Success</strong> The creature is unaffected.</p><p><strong>Failure</strong> The creature is frightened 1.</p><p><strong>Critical Failure</strong> The creature is frightened 2.</p>';

function makeToken({ x, y, disposition }) {
  return { x, y, disposition, width: 1, height: 1, update: vi.fn(), move: vi.fn() };
}

function makeCombatant({ id, gx, gy, disposition, level = 1, outcome = "failure", items = [] }) {
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

function abilityItem({ id = "ab1", name = "Hag Touch", description = TOUCH_AUTO, traits = [], frequency = null } = {}) {
  return {
    id, name, slug: null, type: "action",
    system: { actionType: { value: "action" }, actions: { value: 2 }, traits: { value: traits }, frequency, description: { value: description } },
    update: vi.fn(async () => {}),
    toMessage: vi.fn(async () => {}),
  };
}

function setup({ item = abilityItem(), outcomes = { pc1: "failure" }, pick = { type: "npcAbility", slug: "hag-touch", targetId: "pc1", rationale: "r" } } = {}) {
  const npc = makeCombatant({ id: "hag", gx: 0, gy: 0, disposition: -1, level: 5, items: [item] });
  const pcs = Object.entries(outcomes).map(([id, outcome], i) => makeCombatant({ id, gx: 1, gy: i, disposition: 1, outcome }));
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

const whispers = () => ChatMessage.create.mock.calls.map((c) => c[0].content).join("\n");

describe("applyAgentDecision npcAbility execution, mode auto (#915)", () => {
  it("rolls the target's save the way the system's own inline check does: numeric DC, the NPC as origin, the item, and its traits/options as roll options", async () => {
    const item = abilityItem({ traits: ["mental", "incapacitation"] });
    const { npc, pcs, combat } = setup({ item });
    await applyAgentDecision(combat, "hag", "npcAbility:ab1:pc1", "r");
    const args = pcs[0].actor.saves.will.roll.mock.calls[0][0];
    expect(args.dc).toEqual({ value: 27 });
    expect(args.origin).toBe(npc.actor);
    expect(args.item).toBe(item);
    expect(args.skipDialog).toBe(true);
    // Check#roll reads 'incapacitation' from the roll options (traits are
    // only merged in after its incapacitation check), so it goes there; the
    // system then shifts the degree itself.
    expect(args.extraRollOptions).toEqual(expect.arrayContaining(["incapacitation", "item:trait:incapacitation", "mental", "item:trait:mental", "inflicts:stupefied"]));
    expect(item.toMessage).toHaveBeenCalled();
  });

  it("never computes an incapacitation shift itself: the system's (already adjusted) degree is what gets applied", async () => {
    const item = abilityItem({ traits: ["incapacitation"] });
    const { pcs, combat } = setup({ item, outcomes: { pc1: "success" } });
    await applyAgentDecision(combat, "hag", "npcAbility:ab1:pc1", "r");
    expect(pcs[0].actor.increaseCondition).toHaveBeenCalledWith("dazzled");
    expect(pcs[0].actor.increaseCondition).toHaveBeenCalledTimes(1);
  });

  it("applies the failure degree's conditions, tracking Fleeing until the end of the target's next turn and leaving Frightened to decay on its own", async () => {
    const { pcs, combat, flags } = setup();
    await applyAgentDecision(combat, "hag", "npcAbility:ab1:pc1", "r");
    expect(pcs[0].actor.increaseCondition).toHaveBeenCalledWith("frightened", { value: 2 });
    expect(pcs[0].actor.increaseCondition).toHaveBeenCalledWith("fleeing");
    // pc1 is the last turn (1) of round 1; its next turn ends as round 2 begins.
    expect(flags.npcAbilityExpiry).toEqual([
      { targetId: "pc1", conditionSlug: "fleeing", expiry: { untilRoundTurn: { round: 2, turn: 0 } }, expiresAtWorldTime: null, source: "Hag Touch" },
    ]);
  });

  it("ends 'until the end of its next turn' when the turn after the target's next one starts, whichever round that is", async () => {
    const { combat, flags } = setup({ outcomes: { pc1: "failure", pc2: "success" } });
    await applyAgentDecision(combat, "hag", "npcAbility:ab1:pc1", "r");
    // turns: hag(0), pc1(1), pc2(2) -- pc1's next turn ends when pc2's starts.
    expect(flags.npcAbilityExpiry[0].expiry).toEqual({ untilRoundTurn: { round: 1, turn: 2 } });
  });

  it("maps a timed duration to the NPC's own turn N rounds later (1 minute = 10 rounds) and a game-clock end", async () => {
    const { pcs, combat, flags } = setup({ outcomes: { pc1: "criticalFailure" } });
    await applyAgentDecision(combat, "hag", "npcAbility:ab1:pc1", "r");
    expect(pcs[0].actor.increaseCondition).toHaveBeenCalledWith("stupefied", { value: 2 });
    expect(flags.npcAbilityExpiry).toEqual([
      { targetId: "pc1", conditionSlug: "stupefied", expiry: { untilRoundTurn: { round: 11, turn: 0 } }, expiresAtWorldTime: 1060, source: "Hag Touch" },
    ]);
  });

  it("takes the higher value when the target already has the condition (PF2e: never stacks)", async () => {
    const { pcs, combat } = setup();
    pcs[0].actor.conditions.push({ slug: "frightened", value: 1 });
    await applyAgentDecision(combat, "hag", "npcAbility:ab1:pc1", "r");
    expect(pcs[0].actor.increaseCondition).toHaveBeenCalledWith("frightened", { value: 1 });
    const again = setup();
    again.pcs[0].actor.conditions.push({ slug: "frightened", value: 3 });
    await applyAgentDecision(again.combat, "hag", "npcAbility:ab1:pc1", "r");
    expect(again.pcs[0].actor.increaseCondition).not.toHaveBeenCalledWith("frightened", expect.anything());
  });

  it("records the degree's temporary immunity on the game clock", async () => {
    const { pcs, combat } = setup({ outcomes: { pc1: "criticalSuccess" } });
    await applyAgentDecision(combat, "hag", "npcAbility:ab1:pc1", "r");
    expect(pcs[0].actor.increaseCondition).not.toHaveBeenCalled();
    expect(getNpcAbilityImmunityUntil(combat, "ab1", "pc1")).toBe(1000 + 86400);
  });

  it("spends a frequency use and spends the actions", async () => {
    const item = abilityItem({ frequency: { value: 2, max: 3, per: "day" } });
    const { combat, flags } = setup({ item });
    await applyAgentDecision(combat, "hag", "npcAbility:ab1:pc1", "r");
    expect(item.update).toHaveBeenCalledWith({ "system.frequency.value": 1 });
    expect(flags.agentTurnState.actionsRemaining).toBe(1);
  });

  it("records a recharge after use", async () => {
    const item = abilityItem({ description: TOUCH_AUTO.replace("save.</p>", "save. [[/gmr 1d4 #Recharge Hag Touch]]{1d4 rounds}</p>") });
    const { combat, flags } = setup({ item });
    await applyAgentDecision(combat, "hag", "npcAbility:ab1:pc1", "r");
    expect(flags.abilityRecharge).toEqual({ hag: { "hag-touch": { availableAtRound: 3 } } });
  });

  it("skips (without rolling) a target that turns out to be immune to the ability's traits", async () => {
    const { pcs, combat } = setup();
    // Becomes immune between vocabulary build and execution (e.g. an effect landed).
    let calls = 0;
    pcs[0].actor.isImmuneTo = vi.fn(() => ++calls > 1);
    await applyAgentDecision(combat, "hag", "npcAbility:ab1:pc1", "r");
    expect(pcs[0].actor.saves.will.roll).not.toHaveBeenCalled();
    expect(whispers()).toMatch(/immune/);
  });

  it("rolls every target in an area, records a regardless-of-result immunity for each, and keeps going when one save throws", async () => {
    const item = abilityItem({ name: "Bloodcurdling Screech", description: SCREECH });
    const { pcs, combat } = setup({
      item,
      outcomes: { pc1: "failure", pc2: "criticalFailure" },
      pick: { type: "npcAbility", slug: "bloodcurdling-screech", targetId: null, rationale: "r" },
    });
    pcs[0].actor.saves.will.roll = vi.fn(async () => { throw new Error("boom"); });
    await expect(applyAgentDecision(combat, "hag", "npcAbility:ab1", "r")).resolves.not.toThrow();
    expect(pcs[1].actor.increaseCondition).toHaveBeenCalledWith("frightened", { value: 2 });
    expect(getNpcAbilityImmunityUntil(combat, "ab1", "pc2")).toBe(1060);
  });

  it("whispers the GM each target's result and what was applied, plus the ability's off-degree rider text", async () => {
    const item = abilityItem({ description: TOUCH_AUTO.replace("<hr />", "<p>While a creature is frightened by this ability, it is off-guard to the hag.</p><hr />") });
    const { combat } = setup({ item });
    await applyAgentDecision(combat, "hag", "npcAbility:ab1:pc1", "r");
    const text = whispers();
    expect(text).toMatch(/pc1/);
    expect(text).toMatch(/failure/);
    expect(text).toMatch(/frightened 2/);
    expect(text).toMatch(/off-guard to the hag/);
  });
});

describe("applyAgentDecision npcAbility execution, mode reportOnly (#915)", () => {
  it("rolls the save but applies nothing, whispering the degree's own outcome text for the GM to apply", async () => {
    const item = abilityItem({ name: "Vanth's Curse", description: TOUCH_REPORT });
    const { pcs, combat, flags } = setup({ item, pick: { type: "npcAbility", slug: "vanth-s-curse", targetId: "pc1", rationale: "r" } });
    await applyAgentDecision(combat, "hag", "npcAbility:ab1:pc1", "r");
    expect(pcs[0].actor.saves.will.roll).toHaveBeenCalled();
    expect(pcs[0].actor.increaseCondition).not.toHaveBeenCalled();
    expect(flags.npcAbilityExpiry).toBeUndefined();
    expect(whispers()).toMatch(/Each time the target gains the dying condition/);
  });
});
