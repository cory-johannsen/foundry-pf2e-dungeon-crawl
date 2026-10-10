// tests/dungeon-combat-npc-move-execution.test.mjs
import { describe, it, expect, beforeEach, vi } from "vitest";
import { applyAgentDecision, getPendingAgentTurn, computeNpcMoveEntries } from "../scripts/dungeon-combat.mjs";
import { G, installGlobals, makeCombatant, makeCombat, makeStrike, makeWeapon, turnState } from "./helpers/feat-execution-fixture.mjs";

// #932: applyAgentDecision's `npcMove` branch, end-to-end through the real
// getPendingAgentTurn rebuild with persisted picks (feat-execution fixture).
// Ability descriptions are real compendium text.

const GALLOP = "<p>The riding horse Strides twice. It has a +10-foot circumstance bonus to its Speed during these Strides.</p>";
const SWIFT_LEAP = "<p>The ghoul jumps up to half its Speed. This movement doesn't trigger reactions.</p>";
const SWOOP = "<p>The giant dragonfly Flies up to its Speed and makes one mandible Strike at any point during that movement.</p>";
const EAGLE_DIVE = "<p>The giant eagle @UUID[Compendium.pf2e.actionspf2e.Item.Fly]{Flies} up to double its fly Speed in a straight line, descending at least 10 feet, and then makes a talon Strike.</p>";
const RUSH = "<p>The cave bear Strides and makes a Strike at the end of that movement. During the Stride, it gains a +10-foot circumstance bonus to its Speed.</p>";
const JAUNT = "<p>The poracha teleports up to 40 feet to a location it can see.</p>\n<p>It can't use Jaunt again for [[/gmr 1d4 #Recharge Jaunt]]{1d4 rounds}.</p>";
const PHASE_JUMP = "<p><strong>Frequency</strong> once per round</p><hr /><p><strong>Effect</strong> The dragon teleports up to 60 feet. If they are airborne, they maintain their momentum, and do not fall at the end of their turn, even if they didn't use an action to Fly.</p>";

function ability({ id = "ab1", name, description, cost = 1, frequency = null }) {
  return {
    id,
    name,
    slug: null,
    type: "action",
    system: { actionType: { value: "action" }, actions: { value: cost }, traits: { value: [] }, frequency, description: { value: description } },
    update: vi.fn(async function (changes) {
      if ("system.frequency.value" in changes) this.system.frequency.value = changes["system.frequency.value"];
    }),
    toMessage: vi.fn(async () => {}),
  };
}

/** An agent-controlled opponent with a Reactive Strike and a ready claw. */
function reactor({ id, gx, gy }) {
  const claw = makeStrike(makeWeapon({ id: `${id}-w`, slug: "claw" }));
  const c = makeCombatant({ id, gx, gy, disposition: 1, actions: [claw] });
  c.actor.items = [{ type: "action", name: "Reactive Strike", system: { actionType: { value: "reaction" }, rules: [] } }];
  return { combatant: c, claw };
}

function setup({ item, moverAt = [0, 1], speeds = { land: 30 }, opponents, picks, strikes = [], width = 16, actionsRemaining = 3, mapIncrement = 0 }) {
  const mover = makeCombatant({ id: "npc", gx: moverAt[0], gy: moverAt[1], disposition: -1, action: [item], actions: strikes, speed: speeds.land ?? 0 });
  for (const [mode, value] of Object.entries(speeds)) mover.actor.system.movement.speeds[mode] = { value };
  const combat = makeCombat(mover, opponents, { picks, width, actionsRemaining, mapIncrement });
  combat.turns = [mover, ...opponents];
  return { mover, combat };
}

beforeEach(() => {
  installGlobals();
  // No per-square walk pause in tests.
  globalThis.game.settings = { get: (_m, key) => (key === "movementStepDelayMs" ? 0 : undefined) };
  globalThis.Roll = class {
    constructor(formula) {
      this.formula = formula;
    }
    async evaluate() {
      this.total = 2;
      return this;
    }
  };
});

describe("npcMove: plain moves", () => {
  it("Gallop: two Strides of Speed + 10 each, spends 2 actions, posts the ability card", async () => {
    // 20 ft Speed + 10 = 6 squares per Stride, 12 in all; the target is 14
    // squares away, so the horse stops 2 squares short.
    const item = ability({ name: "Gallop", description: GALLOP, cost: 2 });
    const goblin = makeCombatant({ id: "gob", gx: 14, gy: 1, disposition: 1 });
    const { mover, combat } = setup({ item, speeds: { land: 20 }, opponents: [goblin], width: 20, picks: [{ type: "npcMove", slug: "gallop", targetId: "gob", rationale: "close in" }] });
    const pending = await getPendingAgentTurn(combat);
    expect(pending.npcMoveVocabulary).toEqual([
      expect.objectContaining({ type: "npcMove", kind: "move", slug: "gallop", posture: "approach", targetId: "gob", cost: 2 }),
    ]);
    expect(pending.npcMoveVocabulary[0].summary).toBe("Stride twice, 60 ft in all toward gob; can trigger reactions");
    await applyAgentDecision(combat, "npc", "npcMove:ab1:approach:gob", "r");
    expect(mover.token.x).toBe(12 * G);
    expect(item.toMessage).toHaveBeenCalledTimes(1);
    expect(turnState(combat)).toMatchObject({ actionsRemaining: 1, mapIncrement: 0 });
    const record = combat.getFlag("pf2e-dungeon-crawl", "agentLog").at(-1);
    expect(record).toMatchObject({ type: "npcMove", summary: "Gallop", result: { text: "moved" } });
  });

  it("a plain movement ability triggers Reactive Strike by the rules (leaving a square in reach)", async () => {
    // The horse starts adjacent to the reactor and gallops away past it:
    // leaving a square within reach is the trigger (Player Core), so the
    // reactor's claw rolls once.
    const item = ability({ name: "Gallop", description: GALLOP, cost: 2 });
    const goblin = makeCombatant({ id: "gob", gx: 14, gy: 1, disposition: 1 });
    const { combatant: guard, claw } = reactor({ id: "guard", gx: 1, gy: 0 });
    const { mover, combat } = setup({ item, speeds: { land: 20 }, opponents: [goblin, guard], width: 20, picks: [{ type: "npcMove", slug: "gallop", targetId: "gob" }] });
    await applyAgentDecision(combat, "npc", "npcMove:ab1:approach:gob", "r");
    expect(claw.variants[0].roll).toHaveBeenCalledTimes(1);
    expect(mover.token.x).toBe(12 * G);
  });

  it("Swift Leap: half Speed, and its 'doesn't trigger reactions' really suppresses them", async () => {
    // Ghoul (30 ft) leaps 15 ft = 3 squares away from an adjacent reactor.
    const item = ability({ name: "Swift Leap", description: SWIFT_LEAP });
    const bow = makeStrike({ id: "bow", slug: "bow", type: "weapon", system: { category: "martial", range: { increment: 60 }, traits: { value: [] } } }, { reach: null });
    const { combatant: guard, claw } = reactor({ id: "guard", gx: 5, gy: 1 });
    const { mover, combat } = setup({ item, moverAt: [4, 1], opponents: [guard], strikes: [bow], picks: [{ type: "npcMove", slug: "swift-leap", targetId: "guard" }] });
    const pending = await getPendingAgentTurn(combat);
    expect(pending.npcMoveVocabulary.map((v) => v.posture)).toEqual(["retreat"]);
    await applyAgentDecision(combat, "npc", "npcMove:ab1:retreat:guard", "r");
    expect(mover.token.x).toBe(1 * G);
    expect(claw.variants[0].roll).not.toHaveBeenCalled();
    expect(turnState(combat).actionsRemaining).toBe(2);
  });
});

describe("npcMove: move plus Strike", () => {
  it("Rush: Stride (+10 ft) then a Strike at the end at the current MAP, which then counts toward MAP", async () => {
    const claw = makeStrike(makeWeapon({ id: "w1", slug: "claw" }));
    const item = ability({ name: "Rush", description: RUSH, cost: 2 });
    const goblin = makeCombatant({ id: "gob", gx: 8, gy: 1, disposition: 1 });
    const { mover, combat } = setup({ item, opponents: [goblin], strikes: [claw], mapIncrement: 1, picks: [{ type: "npcMove", slug: "rush", targetId: "gob" }] });
    await applyAgentDecision(combat, "npc", "npcMove:ab1:approach:gob", "r");
    expect(mover.token.x).toBe(7 * G);
    expect(claw.variants[1].roll).toHaveBeenCalledTimes(1);
    expect(turnState(combat)).toMatchObject({ actionsRemaining: 1, mapIncrement: 2 });
  });

  it("Rush is not offered when the target is beyond Speed + 10 (the Strike could never land)", async () => {
    const claw = makeStrike(makeWeapon({ id: "w1", slug: "claw" }));
    const item = ability({ name: "Rush", description: RUSH, cost: 2 });
    const goblin = makeCombatant({ id: "gob", gx: 12, gy: 1, disposition: 1 });
    const { combat } = setup({ item, opponents: [goblin], strikes: [claw], picks: [] });
    expect((await getPendingAgentTurn(combat)).npcMoveVocabulary).toEqual([]);
  });

  it("Swoop (Fly Speed): hit and run -- Strikes at the first square in reach, then flies away with what is left", async () => {
    const mandible = makeStrike(makeWeapon({ id: "w1", slug: "mandible" }));
    const item = ability({ name: "Swoop", description: SWOOP, cost: 2 });
    const goblin = makeCombatant({ id: "gob", gx: 5, gy: 1, disposition: 1 });
    const { mover, combat } = setup({ item, speeds: { land: 10, fly: 40 }, opponents: [goblin], strikes: [mandible], picks: [{ type: "npcMove", slug: "swoop", targetId: "gob" }] });
    const pending = await getPendingAgentTurn(combat);
    expect(pending.candidates.filter((c) => c.type === "npcMove").map((c) => c.id)).toEqual([
      "npcMove:ab1:approach:gob",
      "npcMove:ab1:hitAndRun:gob",
    ]);
    await applyAgentDecision(combat, "npc", "npcMove:ab1:hitAndRun:gob", "r");
    // 8 squares: 4 to reach x=4 (adjacent), Strike, 4 back out to x=0.
    expect(mandible.variants[0].roll).toHaveBeenCalledTimes(1);
    expect(mover.token.x).toBe(0);
    const record = combat.getFlag("pf2e-dungeon-crawl", "agentLog").at(-1);
    expect(record.gmNote).toContain("fly Speed");
  });

  it("Swoop is never offered to a creature with no fly Speed", async () => {
    const mandible = makeStrike(makeWeapon({ id: "w1", slug: "mandible" }));
    const item = ability({ name: "Swoop", description: SWOOP, cost: 2 });
    const goblin = makeCombatant({ id: "gob", gx: 5, gy: 1, disposition: 1 });
    const { mover, combat } = setup({ item, speeds: { land: 40 }, opponents: [goblin], strikes: [mandible], picks: [] });
    expect(computeNpcMoveEntries(combat, mover, [goblin], 3)).toEqual([]);
  });

  it("Eagle Dive: a straight-line fly to the target, then the talon Strike", async () => {
    const talon = makeStrike(makeWeapon({ id: "w1", slug: "talon" }));
    const item = ability({ name: "Eagle Dive", description: EAGLE_DIVE, cost: 2 });
    const goblin = makeCombatant({ id: "gob", gx: 9, gy: 1, disposition: 1 });
    const { mover, combat } = setup({ item, speeds: { land: 10, fly: 30 }, opponents: [goblin], strikes: [talon], picks: [{ type: "npcMove", slug: "eagle-dive", targetId: "gob" }] });
    await applyAgentDecision(combat, "npc", "npcMove:ab1:approach:gob", "r");
    expect(mover.token.x).toBe(8 * G);
    expect(talon.variants[0].roll).toHaveBeenCalledTimes(1);
    expect(combat.getFlag("pf2e-dungeon-crawl", "agentLog").at(-1).gmNote).toContain("descending at least 10 feet");
  });
});

describe("npcMove: teleports", () => {
  it("Jaunt: teleports next to the target without a path, records its recharge, triggers no reactions", async () => {
    const item = ability({ name: "Jaunt", description: JAUNT });
    const { combatant: guard, claw } = reactor({ id: "guard", gx: 1, gy: 1 });
    const goblin = makeCombatant({ id: "gob", gx: 7, gy: 1, disposition: 1 });
    const { mover, combat } = setup({ item, opponents: [guard, goblin], picks: [{ type: "npcMove", slug: "jaunt", targetId: "gob" }] });
    await applyAgentDecision(combat, "npc", "npcMove:ab1:next-to:gob", "r");
    expect(mover.token.move).toHaveBeenLastCalledWith({ x: 6 * G, y: 1 * G, action: "displace" });
    expect(claw.variants[0].roll).not.toHaveBeenCalled();
    expect(combat.getFlag("pf2e-dungeon-crawl", "abilityRecharge")).toEqual({ npc: { jaunt: { availableAtRound: 3 } } });
    // Recharging: not offered again this round.
    expect((await getPendingAgentTurn(combat)).npcMoveVocabulary).toEqual([]);
  });

  it("Phase Jump away from the target spends its once-per-round use", async () => {
    const item = ability({ name: "Phase Jump", description: PHASE_JUMP, frequency: { value: 1, max: 1, per: "round" } });
    const goblin = makeCombatant({ id: "gob", gx: 3, gy: 1, disposition: 1 });
    const { mover, combat } = setup({ item, moverAt: [2, 1], opponents: [goblin], width: 20, picks: [{ type: "npcMove", slug: "phase-jump", targetId: "gob" }] });
    await applyAgentDecision(combat, "npc", "npcMove:ab1:away-from:gob", "r");
    // 60 ft = 12 squares: the farthest free square in range from the goblin.
    expect(mover.token.x).toBe(14 * G);
    expect(item.system.frequency.value).toBe(0);
    expect((await getPendingAgentTurn(combat)).npcMoveVocabulary).toEqual([]);
  });

  it("a teleport is not offered when no free square qualifies", async () => {
    const item = ability({ name: "Jaunt", description: JAUNT });
    const goblin = makeCombatant({ id: "gob", gx: 1, gy: 1, disposition: 1 });
    const { mover, combat } = setup({ item, opponents: [goblin], width: 2, picks: [] });
    expect(computeNpcMoveEntries(combat, mover, [goblin], 3)).toEqual([]);
  });
});

describe("npcMove: eligibility and stale picks", () => {
  it("excludes an ability with no uses left, one it can't afford, and every ability of a character", async () => {
    const goblin = makeCombatant({ id: "gob", gx: 8, gy: 1, disposition: 1 });
    const spent = ability({ name: "Phase Jump", description: PHASE_JUMP, frequency: { value: 0, max: 1, per: "round" } });
    const { mover, combat } = setup({ item: spent, opponents: [goblin], picks: [] });
    expect(computeNpcMoveEntries(combat, mover, [goblin], 3)).toEqual([]);
    const gallop = ability({ name: "Gallop", description: GALLOP, cost: 2 });
    mover.actor.itemTypes.action = [gallop];
    expect(computeNpcMoveEntries(combat, mover, [goblin], 1)).toEqual([]);
    expect(computeNpcMoveEntries(combat, mover, [goblin], 2)).toHaveLength(1);
    mover.actor.type = "character";
    expect(computeNpcMoveEntries(combat, mover, [goblin], 3)).toEqual([]);
  });

  it("spends nothing when the target is gone by execution time", async () => {
    const item = ability({ name: "Phase Jump", description: PHASE_JUMP, frequency: { value: 1, max: 1, per: "round" } });
    const goblin = makeCombatant({ id: "gob", gx: 8, gy: 1, disposition: 1 });
    const other = makeCombatant({ id: "orc", gx: 12, gy: 1, disposition: 1 });
    const { mover, combat } = setup({ item, opponents: [goblin, other], picks: [{ type: "npcMove", slug: "phase-jump", targetId: "gob" }] });
    const pending = await getPendingAgentTurn(combat);
    expect(pending.candidates.some((c) => c.id === "npcMove:ab1:next-to:gob")).toBe(true);
    // The goblin drops between the decision and its execution.
    const applyNow = applyAgentDecision(combat, "npc", "npcMove:ab1:next-to:gob", "r");
    goblin.isDefeated = true;
    await applyNow;
    expect(mover.token.x).toBe(0);
    expect(item.system.frequency.value).toBe(1);
    expect(item.toMessage).not.toHaveBeenCalled();
    expect(turnState(combat).actionsRemaining).toBe(3);
  });
});
