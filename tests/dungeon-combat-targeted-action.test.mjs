// #947: targeted feats with no selfEffect -- the vocabulary
// (computeTargetedActionVocabularyEntries) and applyAgentDecision's
// `targetedAction` branch end-to-end through the real getPendingAgentTurn
// rebuild with persisted picks (feat-execution fixture). Feat text and rule
// elements are the real pf2e 8.5.0 compendium data.
import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  applyAgentDecision,
  computeTargetedActionVocabularyEntries,
  getPendingAgentTurn,
  sweepExpiredNpcAbilityConditions,
} from "../scripts/dungeon-combat.mjs";
import { afterCandidateRebuild } from "./helpers/after-candidate-rebuild.mjs";
import { installGlobals, makeCombatant, makeCombat, makeStrike, makeWeapon, turnState, MODULE_ID } from "./helpers/feat-execution-fixture.mjs";

const OFF_GUARD_UUID = "Compendium.pf2e.conditionitems.Item.AJh5ex99aV6VTggg";

function featItem({ id, slug, name, traits, actions = 1, description, rules = [] }) {
  return {
    id,
    slug,
    name,
    uuid: `Actor.atk.Item.${id}`,
    type: "feat",
    img: "feat.webp",
    system: {
      actionType: { value: "action" },
      actions: { value: actions },
      traits: { value: traits },
      frequency: null,
      selfEffect: null,
      rules,
      description: { value: description },
    },
    flags: { pf2e: { rulesSelections: {} } },
    toMessage: vi.fn(async () => {}),
    update: vi.fn(async () => {}),
  };
}

const intimidatingStrike = () =>
  featItem({
    id: "is1",
    slug: "intimidating-strike",
    name: "Intimidating Strike",
    traits: ["barbarian", "emotion", "fear", "fighter", "mental"],
    actions: 2,
    description:
      "<p>Your blow not only wounds creatures but also shatters their confidence. Make a melee Strike. If you hit and deal damage, the target is @UUID[Compendium.pf2e.conditionitems.Item.TBSHQspnbcqxsmjL]{Frightened 1}, or @UUID[Compendium.pf2e.conditionitems.Item.TBSHQspnbcqxsmjL]{Frightened 2} on a critical hit.</p>",
  });

const resoundingBlow = () =>
  featItem({
    id: "rb1",
    slug: "resounding-blow",
    name: "Resounding Blow",
    traits: ["barbarian", "rage"],
    actions: 2,
    description:
      "<p><strong>Requirements</strong> You are wielding a melee weapon that deals bludgeoning damage.</p><hr /><p>You strike your enemy in the head with such force that their ears ring. Make a melee Strike. If the Strike hits and deals damage, the target is @UUID[Compendium.pf2e.conditionitems.Item.9PR9y0bi4JPKnHPR]{Deafened} until the start of your next turn (or for 1 minute on a critical hit).</p>",
  });

const unbalancingFinisher = () =>
  featItem({
    id: "uf1",
    slug: "unbalancing-finisher",
    name: "Unbalancing Finisher",
    traits: ["finisher", "swashbuckler"],
    description:
      "<p>You attack with a flashy assault that leaves your target off balance. Make a melee Strike. If you hit and deal damage, the target is @UUID[Compendium.pf2e.conditionitems.Item.AJh5ex99aV6VTggg]{Off-Guard} until the end of your next turn.</p>",
    rules: [
      {
        disabledIf: [{ not: "self:effect:panache" }],
        disabledValue: false,
        key: "RollOption",
        label: "PF2E.SpecificRule.Swashbuckler.Finisher.Label",
        mergeable: true,
        option: "finisher",
        suboptions: [{ label: "PF2E.SpecificRule.Swashbuckler.Finisher.Unbalancing", value: "unbalancing" }],
        toggleable: true,
      },
      { key: "Note", predicate: ["finisher:unbalancing"], selector: "strike-damage", text: "{item|system.description.value}", title: "{item|name}" },
    ],
  });

const instantOpening = () =>
  featItem({
    id: "io1",
    slug: "instant-opening",
    name: "Instant Opening",
    traits: ["concentrate", "rogue"],
    description:
      "<p>You distract your opponent with a few choice words or a rude gesture. Choose a target within 30 feet. It's @UUID[Compendium.pf2e.conditionitems.Item.AJh5ex99aV6VTggg]{Off-Guard} against your attacks until the end of your next turn. Depending on the way you describe your distraction, this action gains either the auditory or visual trait.</p>",
  });

/** A ready Strike whose variant rolls post an attack message with
 * `outcome`; its damage roll is applied by the target's applyDamage mock. */
function strike(slug, { outcome = "success", traits = [], damageType = "slashing", category = "martial" } = {}) {
  const weapon = makeWeapon({ id: `w-${slug}`, slug, category });
  weapon.system.traits.value = traits;
  weapon.system.damage = { damageType };
  const s = makeStrike(weapon);
  s.totalModifier = 10;
  for (const variant of s.variants) {
    variant.roll = vi.fn(async () => {
      game.messages.contents.push({
        flags: { pf2e: { context: { outcome } } },
        rolls: [{ total: 20, dice: [{ faces: 20, results: [{ result: 12, active: true }] }] }],
      });
    });
  }
  s.damage = vi.fn(async () => ({ total: 7, alter: async () => ({ total: 14 }) }));
  return s;
}

function withConditions(c, slugs = []) {
  c.actor.conditions = slugs.map((slug) => ({ slug }));
  c.actor.getCondition = (slug) => c.actor.conditions.find((x) => x.slug === slug) ?? null;
  c.actor.increaseCondition = vi.fn(async (slug, opts) => {
    if (!c.actor.conditions.some((x) => x.slug === slug)) c.actor.conditions.push({ slug, value: opts?.value ?? null });
  });
  c.actor.decreaseCondition = vi.fn(async (slug) => {
    c.actor.conditions = c.actor.conditions.filter((x) => x.slug !== slug);
  });
  return c;
}

function opponent(id, gx, { conditions = [], damage = 7, immuneTo = [] } = {}) {
  const c = withConditions(makeCombatant({ id, gx, gy: 0, disposition: 1 }), conditions);
  c.actor.armorClass = { value: 18 };
  c.actor.size = "med";
  c.toggleDefeated = vi.fn(async () => {});
  c.actor.applyDamage = vi.fn(async () => {
    c.actor.system.attributes.hp.value -= damage;
  });
  c.actor.isImmuneTo = vi.fn((x) => immuneTo.includes(typeof x === "string" ? x : x?.slug));
  return c;
}

function setup({ item, strikes = [], effects = [], foe = opponent("opp", 1), picks, mapIncrement = 0, actionsRemaining = 3 }) {
  const attacker = makeCombatant({ id: "atk", gx: 0, gy: 0, disposition: -1, type: "character", feat: [item], actions: strikes, effect: effects });
  attacker.actor.getActiveTokens = () => [{}];
  attacker.actor.level = 5;
  attacker.actor.createEmbeddedDocuments = vi.fn(async (_t, [src]) => [{ id: "new-effect", ...src }]);
  attacker.actor.deleteEmbeddedDocuments = vi.fn(async () => []);
  const combat = makeCombat(attacker, [foe], {
    picks: picks ?? [{ type: "feat", slug: item.slug, targetId: foe.id, rationale: "r" }],
    mapIncrement,
    actionsRemaining,
  });
  combat.turns = [attacker, foe];
  for (const c of [attacker, foe]) c.parent = combat;
  return { attacker, foe, combat };
}

const rage = { id: "rage", slug: "effect-rage", system: { rules: [] } };
const panache = { id: "pan", slug: "effect-panache", system: { rules: [] } };

beforeEach(() => {
  installGlobals();
  globalThis.game.settings = { get: () => undefined };
  globalThis.CONFIG.PF2E.effectTraits = { ...globalThis.CONFIG.PF2E.effectTraits, visual: "Visual", auditory: "Auditory" };
});

describe("computeTargetedActionVocabularyEntries (#947)", () => {
  const foeAt = (id, distanceSquares, extra = {}) => ({
    id,
    name: id,
    hasLineOfSight: true,
    distanceSquares,
    distanceFeet: distanceSquares * 5,
    tokenUuid: `Scene.s.Token.${id}`,
    actor: { conditions: [] },
    ...extra,
  });
  function actor({ feat = [], strikes = [], effects = [], type = "character" } = {}) {
    return { type, itemTypes: { feat, action: [], effect: effects }, system: { actions: strikes }, getActiveTokens: () => [{}] };
  }
  const state = (extra = {}) => ({ actionsRemaining: 3, mapIncrement: 0, flourishUsed: false, stanceUsed: false, finisherUsed: false, ...extra });

  it("offers a strikePlus feat against each opponent in reach of a ready melee Strike, with a deterministic summary", () => {
    const entries = computeTargetedActionVocabularyEntries(
      actor({ feat: [intimidatingStrike()], strikes: [strike("longsword")] }),
      [foeAt("near", 1), foeAt("far", 3)],
      state(),
    );
    expect(entries).toEqual([
      {
        itemId: "is1",
        slug: "intimidating-strike",
        name: "Intimidating Strike",
        cost: 2,
        targetId: "near",
        traits: [],
        attack: true,
        effectSummary: "melee Strike near; hit+damage: frightened 1, crit: frightened 2",
      },
    ]);
  });

  it("is character-only and gated by cost, line of sight and a usable strike", () => {
    const feat = [intimidatingStrike()];
    expect(computeTargetedActionVocabularyEntries(actor({ feat, strikes: [strike("longsword")], type: "npc" }), [foeAt("a", 1)], state())).toEqual([]);
    expect(computeTargetedActionVocabularyEntries(actor({ feat, strikes: [strike("longsword")] }), [foeAt("a", 1)], state({ actionsRemaining: 1 }))).toEqual([]);
    expect(computeTargetedActionVocabularyEntries(actor({ feat, strikes: [strike("longsword")] }), [foeAt("a", 1, { hasLineOfSight: false })], state())).toEqual([]);
    expect(computeTargetedActionVocabularyEntries(actor({ feat, strikes: [] }), [foeAt("a", 1)], state())).toEqual([]);
  });

  it("offers a rage feat only while raging, and only with a held melee weapon of the required damage type (Resounding Blow)", () => {
    const opp = [foeAt("a", 1)];
    const club = strike("club", { damageType: "bludgeoning" });
    expect(computeTargetedActionVocabularyEntries(actor({ feat: [resoundingBlow()], strikes: [club] }), opp, state())).toEqual([]);
    expect(computeTargetedActionVocabularyEntries(actor({ feat: [resoundingBlow()], strikes: [strike("axe")], effects: [rage] }), opp, state())).toEqual([]);
    const fist = strike("fist", { damageType: "bludgeoning", category: "unarmed" });
    expect(computeTargetedActionVocabularyEntries(actor({ feat: [resoundingBlow()], strikes: [fist], effects: [rage] }), opp, state())).toEqual([]);
    expect(computeTargetedActionVocabularyEntries(actor({ feat: [resoundingBlow()], strikes: [club], effects: [rage] }), opp, state())).toHaveLength(1);
  });

  it("offers a finisher only with panache, an agile/finesse melee Strike, and not after a finisher this turn", () => {
    const opp = [foeAt("a", 1)];
    const rapier = strike("rapier", { traits: ["finesse"] });
    const feat = [unbalancingFinisher()];
    expect(computeTargetedActionVocabularyEntries(actor({ feat, strikes: [rapier] }), opp, state())).toEqual([]);
    expect(computeTargetedActionVocabularyEntries(actor({ feat, strikes: [strike("longsword")], effects: [panache] }), opp, state())).toEqual([]);
    expect(computeTargetedActionVocabularyEntries(actor({ feat, strikes: [rapier], effects: [panache] }), opp, state({ finisherUsed: true }))).toEqual([]);
    const [entry] = computeTargetedActionVocabularyEntries(actor({ feat, strikes: [rapier], effects: [panache] }), opp, state());
    expect(entry).toMatchObject({ traits: ["finisher"], attack: true });
  });

  it("offers a targetEffect within range to an opponent that can perceive it, not while raging, not twice on one target (Instant Opening)", () => {
    const feat = [instantOpening()];
    const entries = computeTargetedActionVocabularyEntries(
      actor({ feat }),
      [foeAt("in", 6), foeAt("out", 7), foeAt("senseless", 2, { actor: { conditions: [{ slug: "blinded" }, { slug: "deafened" }] } }), foeAt("blind", 2, { actor: { conditions: [{ slug: "blinded" }] } })],
      state(),
    );
    expect(entries.map((e) => e.targetId)).toEqual(["in", "blind"]);
    expect(entries[0]).toMatchObject({ attack: false, effectSummary: "in off-guard to your attacks (until the end of your next turn)" });
    expect(computeTargetedActionVocabularyEntries(actor({ feat, effects: [rage] }), [foeAt("in", 1)], state())).toEqual([]);
    const existing = { id: "e1", slug: "effect-instant-opening", flags: { [MODULE_ID]: { targetedActionItemId: "io1", markTargetTokenUuid: "Scene.s.Token.in" } }, system: { rules: [] } };
    expect(computeTargetedActionVocabularyEntries(actor({ feat, effects: [existing] }), [foeAt("in", 1)], state())).toEqual([]);
  });
});

describe("applyAgentDecision targetedAction: strikePlus (#947)", () => {
  it("rolls the Strike at the turn's MAP, counts one attack, and applies the hit's condition when damage was dealt", async () => {
    const sword = strike("longsword", { outcome: "success" });
    const { foe, combat, attacker } = setup({ item: intimidatingStrike(), strikes: [sword], mapIncrement: 1 });
    await applyAgentDecision(combat, "atk", "feat:is1:opp", "r");
    expect(sword.variants[1].roll).toHaveBeenCalledTimes(1);
    expect(foe.actor.increaseCondition).toHaveBeenCalledWith("frightened", { value: 1 });
    expect(attacker.actor.itemTypes.feat[0].toMessage).toHaveBeenCalled();
    expect(turnState(combat)).toMatchObject({ actionsRemaining: 1, mapIncrement: 2 });
    const [record] = combat.getFlag(MODULE_ID, "agentLog");
    expect(record).toMatchObject({ type: "feat", kind: "targetedAction", summary: "Intimidating Strike", result: { text: "hit; frightened 1", tone: "success" } });
  });

  it("applies the critical value on a critical hit", async () => {
    const { foe, combat } = setup({ item: intimidatingStrike(), strikes: [strike("longsword", { outcome: "criticalSuccess" })] });
    await applyAgentDecision(combat, "atk", "feat:is1:opp", "r");
    expect(foe.actor.increaseCondition).toHaveBeenCalledWith("frightened", { value: 2 });
  });

  it("applies nothing on a miss, on a hit that dealt no damage, or to a target immune to the feat", async () => {
    let s = setup({ item: intimidatingStrike(), strikes: [strike("longsword", { outcome: "failure" })] });
    await applyAgentDecision(s.combat, "atk", "feat:is1:opp", "r");
    expect(s.foe.actor.increaseCondition).not.toHaveBeenCalled();
    expect(turnState(s.combat).actionsRemaining).toBe(1);

    s = setup({ item: intimidatingStrike(), strikes: [strike("longsword")], foe: opponent("opp", 1, { damage: 0 }) });
    await applyAgentDecision(s.combat, "atk", "feat:is1:opp", "r");
    expect(s.foe.actor.increaseCondition).not.toHaveBeenCalled();
    expect(s.combat.getFlag(MODULE_ID, "agentLog")[0].result.text).toBe("hit; no damage, no effect");

    s = setup({ item: intimidatingStrike(), strikes: [strike("longsword")], foe: opponent("opp", 1, { immuneTo: ["intimidating-strike"] }) });
    await applyAgentDecision(s.combat, "atk", "feat:is1:opp", "r");
    expect(s.foe.actor.increaseCondition).not.toHaveBeenCalled();
    expect(s.combat.getFlag(MODULE_ID, "agentLog")[0].result.text).toBe("hit; immune");
  });

  it("tracks a 'until the start of your next turn' condition from the actor's turn and removes it then (Resounding Blow)", async () => {
    const club = strike("club", { damageType: "bludgeoning" });
    const { foe, combat } = setup({ item: resoundingBlow(), strikes: [club], effects: [rage] });
    await applyAgentDecision(combat, "atk", "feat:rb1:opp", "r");
    expect(foe.actor.increaseCondition).toHaveBeenCalledWith("deafened");
    const [entry] = combat.getFlag(MODULE_ID, "npcAbilityExpiry");
    expect(entry).toMatchObject({ targetId: "opp", conditionSlug: "deafened", expiry: { untilRoundTurn: { round: 2, turn: 0 } } });
    combat.round = 2;
    combat.turn = 0;
    await sweepExpiredNpcAbilityConditions(combat);
    expect(foe.actor.decreaseCondition).toHaveBeenCalledWith("deafened", { forceRemove: true });
  });

  it("rolls a finisher with the system's finisher toggle, loses panache, then offers no more attacks this turn (Unbalancing Finisher)", async () => {
    const rapier = strike("rapier", { traits: ["finesse"] });
    const { attacker, foe, combat } = setup({ item: unbalancingFinisher(), strikes: [rapier], effects: [panache] });
    expect((await getPendingAgentTurn(combat)).candidates.map((c) => c.type)).toContain("strike");
    await applyAgentDecision(combat, "atk", "feat:uf1:opp", "r");
    const toggle = attacker.actor.toggleRollOption;
    expect(toggle).toHaveBeenNthCalledWith(1, "all", "finisher", "uf1", true, "unbalancing");
    expect(toggle).toHaveBeenNthCalledWith(2, "all", "finisher", "uf1", false);
    expect(toggle.mock.invocationCallOrder[0]).toBeLessThan(rapier.variants[0].roll.mock.invocationCallOrder[0]);
    expect(attacker.actor.deleteEmbeddedDocuments).toHaveBeenCalledWith("Item", ["pan"]);
    expect(foe.actor.increaseCondition).toHaveBeenCalledWith("off-guard");
    expect(combat.getFlag(MODULE_ID, "npcAbilityExpiry")[0].expiry).toEqual({ untilRoundTurn: { round: 2, turn: 1 } });
    expect(turnState(combat)).toMatchObject({ actionsRemaining: 2, finisherUsed: true });

    const pending = await getPendingAgentTurn(combat);
    const types = pending.candidates.map((c) => c.type);
    expect(types).not.toContain("strike");
    expect(types).toContain("endTurn");
  });

  it("spends nothing when no allowed strike reaches the target any more at execution", async () => {
    const item = intimidatingStrike();
    const sword = strike("longsword");
    const { foe, combat } = setup({ item, strikes: [sword] });
    afterCandidateRebuild(combat, () => {
      foe.token.x = 5 * 100; // moved out of reach after the candidate was built
    });
    await applyAgentDecision(combat, "atk", "feat:is1:opp", "r");
    expect(sword.variants[0].roll).not.toHaveBeenCalled();
    expect(item.toMessage).not.toHaveBeenCalled();
    expect(turnState(combat).actionsRemaining).toBe(3);
  });
});

describe("applyAgentDecision targetedAction: targetEffect (#947)", () => {
  it("creates an effect on the actor marking the target, with Off-Guard on the actor's attack rolls against it (Instant Opening)", async () => {
    const item = instantOpening();
    const { attacker, combat } = setup({ item, foe: opponent("opp", 4) });
    await applyAgentDecision(combat, "atk", "feat:io1:opp", "r");
    expect(attacker.actor.createEmbeddedDocuments).toHaveBeenCalledTimes(1);
    const [, [source]] = attacker.actor.createEmbeddedDocuments.mock.calls[0];
    expect(source.type).toBe("effect");
    expect(source.system.rules).toEqual([
      { key: "TokenMark", slug: "instant-opening", uuid: "Scene.s.Token.opp" },
      { key: "EphemeralEffect", affects: "target", selectors: ["attack-roll"], uuid: OFF_GUARD_UUID, predicate: ["self:mark:instant-opening"] },
    ]);
    expect(source.system.duration).toEqual({ value: 1, unit: "rounds", expiry: "turn-end", sustained: false });
    expect(source.system.traits.value).toEqual(["visual"]);
    expect(source.flags[MODULE_ID]).toEqual({ agentSelfEffect: true, markTargetTokenUuid: "Scene.s.Token.opp", targetedActionItemId: "io1" });
    expect(item.toMessage).toHaveBeenCalled();
    expect(turnState(combat)).toMatchObject({ actionsRemaining: 2, mapIncrement: 0 });
    expect(combat.getFlag(MODULE_ID, "agentLog")[0].result).toEqual({ text: "off-guard against its attacks", tone: "success" });
  });

  it("uses the auditory trait against a blinded target", async () => {
    const { attacker, combat } = setup({ item: instantOpening(), foe: opponent("opp", 2, { conditions: ["blinded"] }) });
    await applyAgentDecision(combat, "atk", "feat:io1:opp", "r");
    expect(attacker.actor.createEmbeddedDocuments.mock.calls[0][1][0].system.traits.value).toEqual(["auditory"]);
  });

  it("spends nothing when the effect isn't created (the system dropped an unresolvable TokenMark)", async () => {
    const item = instantOpening();
    const { attacker, combat } = setup({ item, foe: opponent("opp", 2) });
    attacker.actor.createEmbeddedDocuments = vi.fn(async () => []);
    await applyAgentDecision(combat, "atk", "feat:io1:opp", "r");
    expect(item.toMessage).not.toHaveBeenCalled();
    expect(turnState(combat).actionsRemaining).toBe(3);
  });
});
