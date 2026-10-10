import { afterCandidateRebuild } from "./helpers/after-candidate-rebuild.mjs";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { applyAgentDecision } from "../scripts/dungeon-combat.mjs";
import { installGlobals, makeCombatant, makeCombat, turnState } from "./helpers/feat-execution-fixture.mjs";

// #922: applyAgentDecision's targetedSelfEffect branch (Hunt Prey, Devise a
// Stratagem). Effect rule shapes copied from the live compendium (pf2e 8.5.0).

const HUNT_PREY_EFFECT = "Compendium.pf2e.feat-effects.Item.MeXyXqWY9qN42bSQ";
const DEVISE_EFFECT = "Compendium.pf2e.feat-effects.Item.XQpTyjXFYYNexyOk";
const DEVISE_RULES = [
  { key: "TokenMark", slug: "devise-a-stratagem" },
  {
    alwaysActive: true,
    key: "RollOption",
    option: "devise-a-stratagem",
    suboptions: [{ value: "attack" }, { value: "skill" }, { value: "defensive", predicate: ["feat:defensive-stratagem"] }],
    toggleable: true,
  },
];

let effectSources;
function effectDoc(slug, rules, extra = {}) {
  const source = { _id: "src", name: slug, type: "effect", system: { slug, rules, ...extra } };
  effectSources.push(source);
  return { slug, system: { rules }, toObject: () => structuredClone(source), _source: source };
}

function action({ id, slug, name, uuid, traits, frequency = null }) {
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
    getOriginData: () => ({ rollOptions: [`origin:item:${slug}`] }),
    toMessage: vi.fn(async () => {}),
    update: vi.fn(async () => {}),
  };
}
const huntPrey = () => action({ id: "hp1", slug: "hunt-prey", name: "Hunt Prey", uuid: HUNT_PREY_EFFECT, traits: ["concentrate", "ranger"] });
const devise = () =>
  action({ id: "ds1", slug: "devise-a-stratagem", name: "Devise a Stratagem", uuid: DEVISE_EFFECT, traits: ["concentrate", "investigator"], frequency: { max: 1, per: "round", value: 1 } });

function setup({ item = huntPrey(), effect = [], targetId = "opp" } = {}) {
  const attacker = makeCombatant({ id: "atk", gx: 0, gy: 0, disposition: -1, type: "character", action: [item], effect });
  attacker.actor.getActiveTokens = () => [{}];
  // Devise needs a Strike its d20 can replace.
  attacker.actor.system.actions = [
    { type: "strike", ready: true, label: "Rapier", slug: "rapier", item: { slug: "rapier", type: "weapon", system: { range: null, traits: { value: ["finesse"] } } }, variants: [] },
  ];
  attacker.actor.createEmbeddedDocuments = vi.fn(async (_t, [src]) => [{ id: "new-effect", system: { badge: src.system.badge ? { type: "value", value: 14 } : null } }]);
  const opponent = makeCombatant({ id: "opp", gx: 3, gy: 0, disposition: 1 });
  const other = makeCombatant({ id: "opp2", gx: 5, gy: 0, disposition: 1 });
  const combat = makeCombat(attacker, [opponent, other], {
    picks: [{ type: "feat", slug: item.slug, targetId, rationale: "r" }],
  });
  return { attacker, opponent, other, combat, item };
}

beforeEach(() => {
  installGlobals();
  effectSources = [];
  globalThis.fromUuid = vi.fn(async (uuid) => {
    if (uuid === HUNT_PREY_EFFECT) return effectDoc("effect-hunt-prey", [{ key: "TokenMark", slug: "hunted-prey" }], { badge: null });
    if (uuid === DEVISE_EFFECT) return effectDoc("effect-devise-a-stratagem", structuredClone(DEVISE_RULES), { badge: { type: "formula", value: "1d20", evaluate: true } });
    return null;
  });
});

describe("applyAgentDecision targetedSelfEffect execution: Hunt Prey (#922)", () => {
  it("creates the Hunt Prey effect with its TokenMark rule bound to the target's token, origin context as PF2e writes it", async () => {
    const { attacker, combat } = setup();
    await applyAgentDecision(combat, "atk", "feat:hp1:opp", "r");
    expect(attacker.actor.createEmbeddedDocuments).toHaveBeenCalledTimes(1);
    const [docType, [source]] = attacker.actor.createEmbeddedDocuments.mock.calls[0];
    expect(docType).toBe("Item");
    expect(source._id).toBe(null);
    expect(source.system.rules).toEqual([{ key: "TokenMark", slug: "hunted-prey", uuid: "Scene.s.Token.opp" }]);
    expect(source.system.context).toEqual({
      origin: { actor: "Actor.atk", token: "Scene.s.Token.atk", item: "Actor.atk.Item.hp1", spellcasting: null, rollOptions: ["origin:item:hunt-prey"] },
      target: { actor: "Actor.atk", token: "Scene.s.Token.atk" },
      roll: null,
    });
    expect(source.flags["pf2e-dungeon-crawl"].agentSelfEffect).toBe(true);
    // "concentrate"/"ranger" aren't valid effect traits in the fixture.
    expect(source.system.traits.value).toEqual([]);
  });

  it("never mutates the compendium effect source", async () => {
    const { combat } = setup();
    await applyAgentDecision(combat, "atk", "feat:hp1:opp", "r");
    expect(effectSources[0].system.rules).toEqual([{ key: "TokenMark", slug: "hunted-prey" }]);
  });

  it("spends one action, posts the usage card and reports it on the AI turn card, without counting as an attack", async () => {
    const { combat, item } = setup();
    await applyAgentDecision(combat, "atk", "feat:hp1:opp", "r");
    expect(item.toMessage).toHaveBeenCalledTimes(1);
    expect(turnState(combat).actionsRemaining).toBe(2);
    expect(turnState(combat).mapIncrement).toBe(0);
    const contents = globalThis.ChatMessage.create.mock.calls.map(([m]) => m.content);
    expect(contents.some((c) => c.includes("Hunt Prey") && c.includes("hunts its target as prey") && c.includes("→ opp"))).toBe(true);
  });

  it("re-designation: creates the new mark, then removes the prior Hunt Prey effect", async () => {
    const prior = { id: "old-prey", slug: "effect-hunt-prey", system: { rules: [{ key: "TokenMark", slug: "hunted-prey", uuid: "Scene.s.Token.opp2" }] } };
    const unrelated = { id: "other-effect", slug: "effect-devise-a-stratagem", system: { rules: [{ key: "TokenMark", slug: "devise-a-stratagem", uuid: "Scene.s.Token.opp" }] } };
    const { attacker, combat } = setup({ effect: [prior, unrelated] });
    await applyAgentDecision(combat, "atk", "feat:hp1:opp", "r");
    expect(attacker.actor.deleteEmbeddedDocuments).toHaveBeenCalledWith("Item", ["old-prey"]);
    const created = attacker.actor.createEmbeddedDocuments.mock.invocationCallOrder[0];
    const deleted = attacker.actor.deleteEmbeddedDocuments.mock.invocationCallOrder[0];
    expect(created).toBeLessThan(deleted);
  });

  it("leaves the action unspent and drops the pick when the effect can't be created", async () => {
    const { attacker, combat, item } = setup();
    attacker.actor.createEmbeddedDocuments.mockRejectedValueOnce(new Error("boom"));
    vi.spyOn(console, "error").mockImplementation(() => {});
    await applyAgentDecision(combat, "atk", "feat:hp1:opp", "r");
    expect(turnState(combat).actionsRemaining).toBe(3);
    expect(turnState(combat).maneuverPicks).toEqual([]);
    expect(item.toMessage).not.toHaveBeenCalled();
  });

  it("leaves the action unspent when the system drops the effect at creation (unresolvable mark)", async () => {
    const { attacker, combat, item } = setup();
    attacker.actor.createEmbeddedDocuments.mockResolvedValueOnce([]);
    await applyAgentDecision(combat, "atk", "feat:hp1:opp", "r");
    expect(turnState(combat).actionsRemaining).toBe(3);
    expect(item.toMessage).not.toHaveBeenCalled();
  });

  it("creates nothing and spends nothing when the linked effect has no matching TokenMark rule", async () => {
    const { attacker, combat } = setup();
    vi.spyOn(console, "error").mockImplementation(() => {});
    // The vocabulary was built while the effect was intact; it changed since.
    const pending = globalThis.fromUuid;
    let calls = 0;
    globalThis.fromUuid = vi.fn(async (uuid) => (++calls > 1 ? effectDoc("effect-hunt-prey", [{ key: "RollOption", option: "x" }]) : pending(uuid)));
    await applyAgentDecision(combat, "atk", "feat:hp1:opp", "r");
    expect(attacker.actor.createEmbeddedDocuments).not.toHaveBeenCalled();
    expect(turnState(combat).actionsRemaining).toBe(3);
  });

  it("creates nothing when the actor has no token on the viewed canvas any more", async () => {
    const { attacker, combat } = setup();
    let calls = 0;
    attacker.actor.getActiveTokens = () => (++calls > 1 ? [] : [{}]);
    await applyAgentDecision(combat, "atk", "feat:hp1:opp", "r");
    expect(attacker.actor.createEmbeddedDocuments).not.toHaveBeenCalled();
    expect(turnState(combat).actionsRemaining).toBe(3);
  });
});

describe("applyAgentDecision targetedSelfEffect execution: Devise a Stratagem (#922)", () => {
  it("creates the effect bound to the target with the attack stratagem selected on its RollOption", async () => {
    const { attacker, combat } = setup({ item: devise() });
    await applyAgentDecision(combat, "atk", "feat:ds1:opp", "r");
    const [, [source]] = attacker.actor.createEmbeddedDocuments.mock.calls[0];
    expect(source.system.rules[0]).toEqual({ key: "TokenMark", slug: "devise-a-stratagem", uuid: "Scene.s.Token.opp" });
    expect(source.system.rules[1]).toMatchObject({ key: "RollOption", option: "devise-a-stratagem", selection: "attack" });
    // The formula badge is left for the system to roll at creation.
    expect(source.system.badge).toEqual({ type: "formula", value: "1d20", evaluate: true });
    expect(attacker.actor.toggleRollOption).not.toHaveBeenCalled();
    expect(attacker.actor.deleteEmbeddedDocuments).not.toHaveBeenCalled();
  });

  it("spends its 1/round frequency and reports the rolled d20 to the GM only", async () => {
    const { combat, item } = setup({ item: devise() });
    await applyAgentDecision(combat, "atk", "feat:ds1:opp", "r");
    expect(item.update).toHaveBeenCalledWith({ "system.frequency.value": 0 });
    expect(turnState(combat).actionsRemaining).toBe(2);
    const contents = globalThis.ChatMessage.create.mock.calls.map(([m]) => m.content);
    expect(contents.some((c) => c.includes("devises a stratagem against its target"))).toBe(true);
    expect(contents.some((c) => c.includes('<div data-visibility="gm" class="pf2edc-agent-note">Stratagem d20 = 14</div>'))).toBe(true);
  });

  it("spends nothing when the target is no longer in line of sight", async () => {
    const { attacker, combat } = setup({ item: devise() });
    // A wall appears between the candidate rebuild and execution.
    afterCandidateRebuild(combat, () => {
      combat.scene.walls.contents = [{ move: 20, door: 0, ds: 0, c: [200, 0, 200, 300] }];
    });
    await applyAgentDecision(combat, "atk", "feat:ds1:opp", "r");
    expect(globalThis.ChatMessage.create).toHaveBeenCalled();
    expect(attacker.actor.createEmbeddedDocuments).not.toHaveBeenCalled();
    expect(turnState(combat).actionsRemaining).toBe(3);
  });
});
