// tests/dungeon-combat-npc-self-execution.test.mjs
import { readFileSync } from "node:fs";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { applyAgentDecision, getPendingAgentTurn, executeNpcSelfCandidate, cleanupAgentSelfEffects } from "../scripts/dungeon-combat.mjs";
import { installGlobals, makeCombatant, makeCombat, turnState, MODULE_ID } from "./helpers/feat-execution-fixture.mjs";

// #934: applyAgentDecision's `npcSelf` branch, end-to-end through the real
// getPendingAgentTurn rebuild with persisted picks (feat-execution fixture).
// Ability items are real compiled bestiary text (the coverage slice).

const { entries: SLICE } = JSON.parse(
  readFileSync(new URL("./fixtures/npc-self-ability-slice.json", import.meta.url), "utf8"),
);

function ability(actor, name, { id = "ab1", frequencyValue } = {}) {
  const entry = SLICE.find((e) => e.actor === actor && e.name === name);
  if (!entry) throw new Error(`fixture has no ${actor}: ${name}`);
  const item = structuredClone(entry.item);
  if (item.system.frequency && frequencyValue !== undefined) item.system.frequency.value = frequencyValue;
  return {
    ...item,
    id,
    slug: null,
    uuid: `Actor.npc.Item.${id}`,
    getOriginData: () => ({ rollOptions: ["origin:item:x"] }),
    update: vi.fn(async function (changes) {
      if ("system.frequency.value" in changes) this.system.frequency.value = changes["system.frequency.value"];
    }),
    toMessage: vi.fn(async () => {}),
  };
}

const PHALANX = "Compendium.pf2e.bestiary-effects.Item.l62iAFL3EO7wSsLL";
const ROUND = { expiry: "turn-start", sustained: false, unit: "rounds", value: 1 };
let docs;
beforeEach(() => {
  installGlobals();
  globalThis.game.settings = { get: (_m, key) => (key === "movementStepDelayMs" ? 0 : undefined) };
  globalThis.Roll = class {
    constructor(formula) {
      this.formula = formula;
    }
    async evaluate() {
      this.total = globalThis.__rollTotal ?? 7;
      return this;
    }
    async toMessage() {}
  };
  globalThis.__rollTotal = 7;
  docs = {
    [PHALANX]: {
      slug: "effect-form-a-phalanx",
      name: "Effect: Form a Phalanx",
      system: { rules: [{ key: "FlatModifier", selector: "ac", type: "circumstance", value: 2 }], duration: ROUND },
      toObject() {
        return { _id: "orig", name: this.name, type: "effect", system: { rules: structuredClone(this.system.rules), duration: { ...ROUND } } };
      },
    },
  };
  globalThis.fromUuid = vi.fn(async (uuid) => docs[uuid] ?? null);
});

function setup({ item, opponents = [], picks, actionsRemaining = 3, hp = 20, maxHp = 20, effect = [] }) {
  const npc = makeCombatant({ id: "npc", gx: 1, gy: 1, disposition: -1, action: [item], effect });
  npc.actor.items = [item];
  npc.actor.system.attributes.hp = { value: hp, max: maxHp };
  // The system's own healing clamp (calculateHealthDelta) -- a negative
  // amount heals up to max HP.
  npc.actor.applyDamage = vi.fn(async ({ damage }) => {
    const hpData = npc.actor.system.attributes.hp;
    hpData.value = Math.max(0, Math.min(hpData.max, hpData.value - damage));
  });
  const combat = makeCombat(npc, opponents, { picks, actionsRemaining, width: 12 });
  combat.turns = [npc, ...opponents];
  return { npc, combat };
}

function opponent(id, gx, gy, conditions = []) {
  const c = makeCombatant({ id, gx, gy, disposition: 1, type: "character" });
  c.actor.conditions = conditions.map((slug) => ({ slug }));
  return c;
}

describe("npcSelf: effect abilities (#934)", () => {
  it("Form a Phalanx: offered, then applied as a tagged self-effect with origin context; usage card; 1 action", async () => {
    const item = ability("Skeleton Infantry", "Form a Phalanx");
    const { npc, combat } = setup({ item, picks: [{ type: "npcSelf", slug: "form-a-phalanx", targetId: null, rationale: "brace" }] });
    const pending = await getPendingAgentTurn(combat);
    expect(pending.npcSelfVocabulary).toEqual([
      expect.objectContaining({ type: "npcSelf", family: "selfEffectAction", slug: "form-a-phalanx", targetId: null, cost: 1, summary: "self-buff: +ac; lasts 1 rounds" }),
    ]);
    expect(pending.candidates.map((c) => c.id)).toContain("npcSelf:ab1");

    await applyAgentDecision(combat, "npc", "npcSelf:ab1", "brace");
    expect(npc.actor.createEmbeddedDocuments).toHaveBeenCalledTimes(1);
    const [type, [source]] = npc.actor.createEmbeddedDocuments.mock.calls[0];
    expect(type).toBe("Item");
    expect(source).toMatchObject({
      _id: null,
      name: "Effect: Form a Phalanx",
      flags: { [MODULE_ID]: { agentSelfEffect: true } },
      system: {
        context: {
          origin: { actor: "Actor.npc", token: "Scene.s.Token.npc", item: "Actor.npc.Item.ab1", rollOptions: ["origin:item:x"] },
          target: { actor: "Actor.npc", token: "Scene.s.Token.npc" },
        },
      },
    });
    expect(item.toMessage).toHaveBeenCalledTimes(1);
    expect(turnState(combat)).toMatchObject({ actionsRemaining: 2, mapIncrement: 0 });
    const record = combat.getFlag(MODULE_ID, "agentLog").at(-1);
    expect(record).toMatchObject({ type: "npcSelf", summary: "Form a Phalanx", result: { text: "gains Effect: Form a Phalanx", tone: "success" } });
  });

  it("a failed effect creation spends nothing and drops the pick", async () => {
    const item = ability("Skeleton Infantry", "Form a Phalanx");
    const { npc, combat } = setup({ item, picks: [{ type: "npcSelf", slug: "form-a-phalanx", targetId: null }] });
    npc.actor.createEmbeddedDocuments = vi.fn(async () => {
      throw new Error("nope");
    });
    vi.spyOn(console, "error").mockImplementation(() => {});
    await applyAgentDecision(combat, "npc", "npcSelf:ab1", "r");
    expect(item.toMessage).not.toHaveBeenCalled();
    expect(turnState(combat)).toMatchObject({ actionsRemaining: 3, maneuverPicks: [] });
  });

  it("an effect the actor already has is not offered again (no re-buff loop)", async () => {
    const item = ability("Skeleton Infantry", "Form a Phalanx");
    const active = { id: "e1", slug: "effect-form-a-phalanx", system: { context: { origin: { item: item.uuid } } } };
    const { combat } = setup({ item, effect: [active], picks: [{ type: "npcSelf", slug: "form-a-phalanx", targetId: null }] });
    const pending = await getPendingAgentTurn(combat);
    expect(pending.npcSelfVocabulary).toEqual([]);
    expect(pending.candidates.some((c) => c.type === "npcSelf")).toBe(false);
  });

  it("entering a stance ends the previous one (PF2e RAW)", async () => {
    const item = ability("Skeleton Infantry", "Form a Phalanx");
    item.system.traits.value = ["stance"];
    const oldStance = { id: "old", slug: "stance-x", system: { traits: { value: ["stance"] } } };
    const { npc, combat } = setup({ item, effect: [oldStance] });
    const result = await executeNpcSelfCandidate(combat, npc, { type: "npcSelf", family: "selfEffectAction", itemId: "ab1" });
    expect(result.performed).toBe(true);
    expect(npc.actor.deleteEmbeddedDocuments).toHaveBeenCalledWith("Item", ["old"]);
  });

  it("a stale candidate (item gone, or now a different family) is not performed", async () => {
    const item = ability("Skeleton Infantry", "Form a Phalanx");
    const { npc, combat } = setup({ item });
    expect(await executeNpcSelfCandidate(combat, npc, { type: "npcSelf", family: "selfEffectAction", itemId: "missing" })).toEqual({ performed: false });
    expect(await executeNpcSelfCandidate(combat, npc, { type: "npcSelf", family: "selfHeal", itemId: "ab1" })).toEqual({ performed: false });
  });
});

describe("npcSelf: self-heals (#934)", () => {
  it("Self-Repair: heals through applyDamage with a negative amount, clamps at max HP, reports what was regained", async () => {
    globalThis.__rollTotal = 30;
    const item = ability("Adamant Sentinel", "Self-Repair");
    const { npc, combat } = setup({ item, hp: 70, maxHp: 80, picks: [{ type: "npcSelf", slug: "self-repair", targetId: null }] });
    await applyAgentDecision(combat, "npc", "npcSelf:ab1", "patch up");
    expect(npc.actor.applyDamage).toHaveBeenCalledWith({ damage: -30, token: npc.token });
    expect(npc.actor.system.attributes.hp.value).toBe(80);
    const record = combat.getFlag(MODULE_ID, "agentLog").at(-1);
    expect(record).toMatchObject({ type: "npcSelf", result: { text: "heals 10 HP", tone: "success" } });
    expect(turnState(combat)).toMatchObject({ actionsRemaining: 2 });
  });

  it("is not offered at full HP", async () => {
    const item = ability("Adamant Sentinel", "Self-Repair");
    const { combat } = setup({ item, hp: 80, maxHp: 80, picks: [{ type: "npcSelf", slug: "self-repair", targetId: null }] });
    expect((await getPendingAgentTurn(combat)).npcSelfVocabulary).toEqual([]);
  });

  it("Vine Splint records its own recharge in the shared abilityRecharge store", async () => {
    globalThis.__rollTotal = 3;
    const item = ability("Canopy Elder", "Vine Splint");
    const { npc, combat } = setup({ item, hp: 10, maxHp: 200 });
    await executeNpcSelfCandidate(combat, npc, { type: "npcSelf", family: "selfHeal", itemId: "ab1" });
    expect(combat.getFlag(MODULE_ID, "abilityRecharge")).toEqual({ npc: { "vine-splint": { availableAtRound: 4 } } });
  });

  it("voidglutton Feed on Fear: needs a frightened/dying enemy within 25 ft; spends its once-per-round use and recharges Consume Light", async () => {
    globalThis.__rollTotal = 2;
    const item = ability("Voidglutton", "Feed on Fear", { frequencyValue: 1 });
    const far = opponent("far", 7, 1, ["frightened"]); // 30 ft away
    const { combat } = setup({ item, hp: 10, maxHp: 50, opponents: [far], picks: [{ type: "npcSelf", slug: "feed-on-fear", targetId: null }] });
    expect((await getPendingAgentTurn(combat)).npcSelfVocabulary).toEqual([]);

    far.token.x = 5 * 100; // 20 ft away
    expect((await getPendingAgentTurn(combat)).npcSelfVocabulary).toHaveLength(1);
    await applyAgentDecision(combat, "npc", "npcSelf:ab1", "feed");
    expect(item.system.frequency.value).toBe(0);
    expect(combat.getFlag(MODULE_ID, "abilityRecharge")).toEqual({ npc: { "consume-light": { availableAtRound: 3 } } });
    const record = combat.getFlag(MODULE_ID, "agentLog").at(-1);
    expect(record.gmNote).toContain("Consume Light recharging (1d4 rounds)");
    // Spent for the round: not offered again this turn.
    expect((await getPendingAgentTurn(combat))?.npcSelfVocabulary ?? []).toEqual([]);
  });
});

describe("cleanupAgentSelfEffects covers NPC self-effects (#914 + #934, no new code)", () => {
  it("removes an unlimited-duration tagged effect from an NPC combatant, leaving timed ones", async () => {
    const deleteEmbeddedDocuments = vi.fn(async () => []);
    const actor = {
      name: "Nakasha",
      type: "npc",
      itemTypes: {
        effect: [
          { id: "stance", name: "Effect: Ironblood Stance", flags: { [MODULE_ID]: { agentSelfEffect: true } }, system: { duration: { unit: "unlimited" } } },
          { id: "timed", name: "Effect: Form a Phalanx", flags: { [MODULE_ID]: { agentSelfEffect: true } }, system: { duration: { unit: "rounds" } } },
        ],
      },
      deleteEmbeddedDocuments,
    };
    await cleanupAgentSelfEffects({ combatants: [{ actor }] });
    expect(deleteEmbeddedDocuments).toHaveBeenCalledWith("Item", ["stance"]);
  });
});
