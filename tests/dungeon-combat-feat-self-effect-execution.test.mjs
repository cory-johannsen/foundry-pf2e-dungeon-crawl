// tests/dungeon-combat-feat-self-effect-execution.test.mjs
import { describe, it, expect, vi, beforeEach } from "vitest";
import { applyAgentDecision } from "../scripts/dungeon-combat.mjs";
import { installGlobals, makeCombatant, makeCombat, turnState } from "./helpers/feat-execution-fixture.mjs";

// #910: applyAgentDecision's self-effect feat branch reproduces the PF2e
// system's own chat-card "apply effect" handler (#onClickApplyEffect).

const RAGE_EFFECT = "Compendium.pf2e.feat-effects.Item.z3uyCMBddrPK5umr";
const GORILLA_EFFECT = "Compendium.pf2e.feat-effects.Item.gorilla";

function selfEffectItem({ id = "rage1", slug = "rage", name = "Rage", traits = ["barbarian", "concentrate", "emotion", "mental"], uuid = RAGE_EFFECT, frequency = null } = {}) {
  return {
    id,
    uuid: `Actor.atk.Item.${id}`,
    slug,
    name,
    system: {
      actionType: { value: "action" },
      actions: { value: 1 },
      selfEffect: { uuid, name: "Effect" },
      frequency,
      traits: { value: traits },
      rules: [],
    },
    flags: { pf2e: { rulesSelections: {} } },
    getOriginData: () => ({ rollOptions: ["origin:item:rage"] }),
    toMessage: vi.fn(async () => {}),
    update: vi.fn(async () => {}),
  };
}

// #914: the linked effect must carry real rules to pass the derived
// eligibility filter (an effect with no rules is excluded).
const EFFECT_RULES = [{ key: "RollOption", domain: "all", option: "x" }];
function effectDoc(slug) {
  const duration = { value: 1, unit: "minutes" };
  return {
    slug,
    system: { rules: EFFECT_RULES, duration },
    toObject: () => ({ _id: "src", name: slug, type: "effect", system: { slug, rules: EFFECT_RULES, duration, traits: { value: [] } } }),
  };
}

function setup({ item = selfEffectItem(), effect = [], picks } = {}) {
  const attacker = makeCombatant({ id: "atk", gx: 0, gy: 0, disposition: -1, type: "character", action: [item], effect });
  const opponent = makeCombatant({ id: "opp", gx: 1, gy: 0, disposition: 1 });
  const combat = makeCombat(attacker, [opponent], {
    picks: picks ?? [{ type: "feat", slug: item.slug, targetId: null, rationale: "r" }],
  });
  return { attacker, opponent, combat, item };
}

beforeEach(() => {
  installGlobals();
  globalThis.fromUuid = vi.fn(async (uuid) => {
    if (uuid === RAGE_EFFECT) return effectDoc("effect-rage");
    if (uuid === GORILLA_EFFECT) return effectDoc("stance-gorilla-stance");
    return null;
  });
});

describe("applyAgentDecision self-effect feat execution (#910)", () => {
  it("creates the linked effect on the actor with the origin-context shape PF2e itself writes", async () => {
    const { attacker, combat } = setup();
    await applyAgentDecision(combat, "atk", "feat:rage1", "r");
    expect(attacker.actor.createEmbeddedDocuments).toHaveBeenCalledTimes(1);
    const [docType, [source]] = attacker.actor.createEmbeddedDocuments.mock.calls[0];
    expect(docType).toBe("Item");
    expect(source._id).toBe(null);
    expect(source.system.context).toEqual({
      origin: {
        actor: "Actor.atk",
        token: "Scene.s.Token.atk",
        item: "Actor.atk.Item.rage1",
        spellcasting: null,
        rollOptions: ["origin:item:rage"],
      },
      target: { actor: "Actor.atk", token: "Scene.s.Token.atk" },
      roll: null,
    });
    // Only the action's traits that are valid effect traits carry over.
    expect(source.system.traits.value).toEqual(["emotion", "mental"]);
    expect(source.system.slug).toBe("effect-rage");
  });

  it("tags the created effect as agent-created so combat-end cleanup can find it (#914)", async () => {
    const { attacker, combat } = setup();
    await applyAgentDecision(combat, "atk", "feat:rage1", "r");
    const [, [source]] = attacker.actor.createEmbeddedDocuments.mock.calls[0];
    expect(source.flags?.["pf2e-dungeon-crawl"]?.agentSelfEffect).toBe(true);
  });

  it("posts the action's usage card and spends its action cost", async () => {
    const { combat, item } = setup();
    await applyAgentDecision(combat, "atk", "feat:rage1", "r");
    expect(item.toMessage).toHaveBeenCalledTimes(1);
    expect(turnState(combat).actionsRemaining).toBe(2);
    expect(turnState(combat).mapIncrement).toBe(0);
  });

  it("decrements the item's own frequency.value when present", async () => {
    const item = selfEffectItem({ frequency: { value: 1, max: 1, per: "day" } });
    const { combat } = setup({ item });
    await applyAgentDecision(combat, "atk", "feat:rage1", "r");
    expect(item.update).toHaveBeenCalledWith({ "system.frequency.value": 0 });
  });

  it("removes the previous stance's effect when entering a new stance, and records the stance action", async () => {
    const stance = selfEffectItem({ id: "gor1", slug: "gorilla-stance", name: "Gorilla Stance", traits: ["stance"], uuid: GORILLA_EFFECT });
    const oldStance = { id: "old-effect-id", slug: "stance-crane-stance", system: { traits: { value: ["stance"] } } };
    const { attacker, combat } = setup({ item: stance, effect: [oldStance] });
    await applyAgentDecision(combat, "atk", "feat:gor1", "r");
    expect(attacker.actor.createEmbeddedDocuments).toHaveBeenCalledTimes(1);
    expect(attacker.actor.deleteEmbeddedDocuments).toHaveBeenCalledWith("Item", ["old-effect-id"]);
    const created = attacker.actor.createEmbeddedDocuments.mock.invocationCallOrder[0];
    const deleted = attacker.actor.deleteEmbeddedDocuments.mock.invocationCallOrder[0];
    // The new stance is created first, so a failed creation never leaves
    // the actor with no stance at all.
    expect(created).toBeLessThan(deleted);
    expect(turnState(combat).stanceUsed).toBe(true);
  });

  it("leaves the action unspent and drops the pick when the effect can't be created", async () => {
    const { attacker, combat, item } = setup();
    attacker.actor.createEmbeddedDocuments.mockRejectedValueOnce(new Error("boom"));
    vi.spyOn(console, "error").mockImplementation(() => {});
    await applyAgentDecision(combat, "atk", "feat:rage1", "r");
    expect(turnState(combat).actionsRemaining).toBe(3);
    expect(turnState(combat).maneuverPicks).toEqual([]);
    expect(item.toMessage).not.toHaveBeenCalled();
  });

  it("does nothing (and spends nothing) when the selfEffect UUID no longer resolves", async () => {
    const { attacker, combat } = setup();
    globalThis.fromUuid = vi.fn(async () => null);
    await applyAgentDecision(combat, "atk", "feat:rage1", "r");
    expect(attacker.actor.createEmbeddedDocuments).not.toHaveBeenCalled();
    expect(turnState(combat).actionsRemaining).toBe(3);
  });
});
