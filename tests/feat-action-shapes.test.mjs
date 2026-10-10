import { describe, it, expect } from "vitest";
import {
  parseTargetedFeat,
  explainTargetedFeat,
  summarizeTargetedFeat,
  FEAT_ACTION_CLASS_SET,
  OFF_GUARD_CONDITION_UUID,
} from "../scripts/feat-action-shapes.mjs";

// #947: item text is the real pf2e 8.5.0 compendium description
// (pf2e.feats-srd / pf2e.actionspf2e), enrichers included.

function feat({ slug, traits, description, actionType = "action", actions = 1, type = "feat", selfEffect = null, frequency = null }) {
  return {
    type,
    slug,
    name: slug,
    system: {
      actionType: { value: actionType },
      actions: { value: actionType === "free" ? null : actions },
      traits: { value: traits },
      frequency,
      selfEffect,
      description: { value: description },
    },
  };
}

const INTIMIDATING_STRIKE = feat({
  slug: "intimidating-strike",
  traits: ["barbarian", "emotion", "fear", "fighter", "mental"],
  actions: 2,
  description:
    "<p>Your blow not only wounds creatures but also shatters their confidence. Make a melee Strike. If you hit and deal damage, the target is @UUID[Compendium.pf2e.conditionitems.Item.TBSHQspnbcqxsmjL]{Frightened 1}, or @UUID[Compendium.pf2e.conditionitems.Item.TBSHQspnbcqxsmjL]{Frightened 2} on a critical hit.</p>",
});

const RESOUNDING_BLOW = feat({
  slug: "resounding-blow",
  traits: ["barbarian", "rage"],
  actions: 2,
  description:
    "<p><strong>Requirements</strong> You are wielding a melee weapon that deals bludgeoning damage.</p><hr /><p>You strike your enemy in the head with such force that their ears ring. Make a melee Strike. If the Strike hits and deals damage, the target is @UUID[Compendium.pf2e.conditionitems.Item.9PR9y0bi4JPKnHPR]{Deafened} until the start of your next turn (or for 1 minute on a critical hit).</p>",
});

const UNBALANCING_FINISHER = feat({
  slug: "unbalancing-finisher",
  traits: ["finisher", "swashbuckler"],
  description:
    "<p>You attack with a flashy assault that leaves your target off balance. Make a melee Strike. If you hit and deal damage, the target is @UUID[Compendium.pf2e.conditionitems.Item.AJh5ex99aV6VTggg]{Off-Guard} until the end of your next turn.</p>",
});

const INSTANT_OPENING = feat({
  slug: "instant-opening",
  traits: ["concentrate", "rogue"],
  description:
    "<p>You distract your opponent with a few choice words or a rude gesture. Choose a target within 30 feet. It's @UUID[Compendium.pf2e.conditionitems.Item.AJh5ex99aV6VTggg]{Off-Guard} against your attacks until the end of your next turn. Depending on the way you describe your distraction, this action gains either the auditory or visual trait.</p>",
});

const FELLING_STRIKE = feat({
  slug: "felling-strike",
  traits: ["fighter"],
  actions: 2,
  description:
    "<p>Your attack can ground an airborne foe. Make a Strike. If it hits and deals damage to a flying target, the target falls up to 120 feet. The fall is gradual enough that if it causes the target to hit the ground, the target takes no damage from the fall.</p>\n<p>If the attack is a critical hit, the target can't Fly, @UUID[Compendium.pf2e.actionspf2e.Item.d5I6018Mci2SWokk]{Leap}, levitate, or otherwise leave the ground until the end of your next turn.</p>",
});

describe("parseTargetedFeat -- strikePlus (#947)", () => {
  it("reads an on-hit-and-damage condition with a stronger critical value (Intimidating Strike)", () => {
    const parsed = parseTargetedFeat(INTIMIDATING_STRIKE);
    expect(parsed).toMatchObject({ shape: "strikePlus", cost: 2, source: "shape", requirements: { weapon: null } });
    expect(parsed.params).toEqual({
      melee: true,
      degrees: {
        success: { conditions: [{ slug: "frightened", value: 1, durationSeconds: null }] },
        criticalSuccess: { conditions: [{ slug: "frightened", value: 2, durationSeconds: null }] },
      },
    });
  });

  it("reads a weapon requirement and separate hit/critical durations (Resounding Blow)", () => {
    const parsed = parseTargetedFeat(RESOUNDING_BLOW);
    expect(parsed.requirements).toEqual({ weapon: { melee: true, damageType: "bludgeoning" } });
    expect(parsed.params.degrees.success.conditions).toEqual([{ slug: "deafened", value: null, durationSeconds: "actorNextTurnStart" }]);
    expect(parsed.params.degrees.criticalSuccess.conditions).toEqual([{ slug: "deafened", value: null, durationSeconds: 60 }]);
  });

  it("reads a finisher's rider and keeps its traits for the turn rules (Unbalancing Finisher)", () => {
    const parsed = parseTargetedFeat(UNBALANCING_FINISHER);
    expect(parsed.traits).toContain("finisher");
    expect(parsed.params.degrees.criticalSuccess.conditions).toEqual([
      { slug: "off-guard", value: null, durationSeconds: "actorNextTurnEnd" },
    ]);
  });

  it("rejects a rider it can't model, never part-applying it (Felling Strike's flying target)", () => {
    expect(explainTargetedFeat(FELLING_STRIKE)).toEqual({ descriptor: null, reason: "unmodeled rider text" });
  });

  it("rejects a requirement outside the closed set (Mage Hunter's 'seen the target Cast a Spell')", () => {
    const item = feat({
      slug: "mage-hunter",
      traits: ["barbarian", "rage"],
      actions: 2,
      description:
        "<p><strong>Requirements</strong> You've seen the target Cast a Spell</p><hr /><p>You use your hatred of magic to lash out at a known spellcaster. Make a melee Strike against the required creature. If you hit and deal damage, the target is Stupefied 1, or Stupefied 2 on a critical hit, until the beginning of your next turn.</p>",
    });
    expect(explainTargetedFeat(item).reason).toBe("requirement outside the closed set");
  });

  it("rejects rules text before the Strike instead of reading it as flavor", () => {
    const item = feat({
      slug: "x",
      traits: ["fighter"],
      description: "<p>You gain a +2 circumstance bonus to the attack roll. Make a melee Strike. If you hit and deal damage, the target is Frightened 1.</p>",
    });
    expect(explainTargetedFeat(item).reason).toBe("mechanics before the Strike");
  });
});

describe("parseTargetedFeat -- targetEffect (#947)", () => {
  it("reads Off-Guard against the actor's own attacks with its range and sense choice (Instant Opening)", () => {
    const parsed = parseTargetedFeat(INSTANT_OPENING);
    expect(parsed).toMatchObject({ shape: "targetEffect", cost: 1 });
    expect(parsed.params).toEqual({
      rangeFeet: 30,
      condition: { slug: "off-guard", uuid: OFF_GUARD_CONDITION_UUID },
      scope: "actorAttacks",
      durationSeconds: "actorNextTurnEnd",
      senseChoice: true,
    });
  });

  it("rejects a target effect with an extra clause (all-or-nothing)", () => {
    const item = feat({
      slug: "x",
      traits: ["rogue"],
      description: "<p>Choose a target within 30 feet. It's Off-Guard against your attacks until the end of your next turn. It also forgets your name.</p>",
    });
    expect(parseTargetedFeat(item)).toBeNull();
  });

  it("rejects a condition other than Off-Guard against your attacks", () => {
    const item = feat({
      slug: "x",
      traits: ["rogue"],
      description: "<p>Choose a target within 30 feet. It's Dazzled against your attacks until the end of your next turn.</p>",
    });
    expect(parseTargetedFeat(item)).toBeNull();
  });
});

describe("parseTargetedFeat -- scope filters (#947)", () => {
  it("lists exactly the nine first-slice classes", () => {
    expect([...FEAT_ACTION_CLASS_SET].sort()).toEqual(
      ["barbarian", "champion", "fighter", "investigator", "monk", "ranger", "rogue", "swashbuckler", "thaumaturge"].sort(),
    );
  });

  it("excludes a feat with no first-slice class trait before any shape (Bon Mot's real traits)", () => {
    const item = feat({
      slug: "bon-mot",
      traits: ["auditory", "concentrate", "emotion", "general", "linguistic", "mental", "skill"],
      description: INTIMIDATING_STRIKE.system.description.value,
    });
    expect(explainTargetedFeat(item).reason).toBe("outside the first-slice classes");
  });

  it("excludes an item with a selfEffect, a #910 composite feat, a reaction and a frequency", () => {
    expect(parseTargetedFeat({ ...INTIMIDATING_STRIKE, system: { ...INTIMIDATING_STRIKE.system, selfEffect: { uuid: "x" } } })).toBeNull();
    expect(parseTargetedFeat({ ...INTIMIDATING_STRIKE, slug: "sudden-charge" })).toBeNull();
    expect(parseTargetedFeat(feat({ slug: "x", traits: ["fighter"], actionType: "reaction", description: "" }))).toBeNull();
    const withFrequency = feat({
      slug: "x",
      traits: ["fighter"],
      description: `<p><strong>Frequency</strong> once per round</p><hr />${INTIMIDATING_STRIKE.system.description.value}`,
    });
    expect(explainTargetedFeat(withFrequency).reason).toBe("has a frequency");
  });
});

describe("summarizeTargetedFeat (#947)", () => {
  it("states the Strike, the rider by degree and the finisher cost", () => {
    expect(summarizeTargetedFeat(parseTargetedFeat(INTIMIDATING_STRIKE), "Goblin")).toBe(
      "melee Strike Goblin; hit+damage: frightened 1, crit: frightened 2",
    );
    expect(summarizeTargetedFeat(parseTargetedFeat(RESOUNDING_BLOW), "Goblin")).toBe(
      "melee Strike Goblin; hit+damage: deafened until your next turn, crit: deafened 1 min",
    );
    expect(summarizeTargetedFeat(parseTargetedFeat(UNBALANCING_FINISHER), "Goblin")).toBe(
      "melee Strike Goblin; hit+damage: off-guard until the end of your next turn; finisher: spends panache, no more attacks this turn",
    );
    expect(summarizeTargetedFeat(parseTargetedFeat(INSTANT_OPENING), "Goblin")).toBe(
      "Goblin off-guard to your attacks (until the end of your next turn)",
    );
  });
});
