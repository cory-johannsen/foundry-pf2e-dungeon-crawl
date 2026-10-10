// tests/npc-strike-shapes.test.mjs
import { describe, it, expect } from "vitest";
import { parseStrikePlusAbility, describeStrikePlus } from "../scripts/npc-strike-shapes.mjs";

// #933: every description below is the real, unedited compendium text
// (pf2e packs, Monster Core 1-2 / Bestiary 1-3) unless marked otherwise.
const T = {
  wrestle:
    "<p>The tiger makes a claw Strike against a creature it is @UUID[Compendium.pf2e.conditionitems.Item.Grabbed]{Grabbing}. If the attack hits, that creature is knocked @UUID[Compendium.pf2e.conditionitems.Item.Prone].</p>",
  deathRoll:
    "<p><strong>Requirements</strong> The crocodile must have a creature @UUID[Compendium.pf2e.conditionitems.Item.Grabbed]</p>\n<hr />\n<p><strong>Effect</strong> The crocodile tucks its legs and rolls rapidly, twisting its victim. It makes a jaws Strike with a +2 circumstance bonus to the attack roll against the grabbed creature. If it hits, it also knocks the creature @UUID[Compendium.pf2e.conditionitems.Item.Prone]. If it fails, it releases the creature.</p>",
  gnawOwlbear:
    "<p><strong>Requirements</strong> The owlbear has a creature @UUID[Compendium.pf2e.conditionitems.Item.Grabbed] with its talons.</p>\n<hr />\n<p><strong>Effect</strong> The owlbear attempts to disembowel the creature with a beak Strike. If the Strike hits, the target must attempt a @Check[will|dc:22] save.</p>\n<hr />\n<p><strong>Critical Success</strong> The target is unaffected.</p>\n<p><strong>Success</strong> The target is @UUID[Compendium.pf2e.conditionitems.Item.Sickened]{Sickened 1}.</p>\n<p><strong>Failure</strong> The target is sickened 1 and @UUID[Compendium.pf2e.conditionitems.Item.Slowed]{Slowed 1} as long as it remains sickened.</p>",
  gnawWolverine:
    "<p><strong>Requirements</strong> The wolverine has a creature grabbed from its jaws Strike</p>\n<hr />\n<p><strong>Effect</strong> The wolverine chews violently on the creature, dealing @Damage[2d6[piercing]] damage (@Check[fortitude|dc:21|basic] save). A creature that fails its save also takes @Damage[2d6[bleed]].</p>",
  maul: "<p>The leopard makes two claw Strikes against a creature it has @UUID[Compendium.pf2e.conditionitems.Item.Grabbed]. Both count toward its multiple attack penalty, but the penalty increases only after both attacks are made.</p>",
  rapidRake:
    "<p>The aurumvorax makes four claw Strikes against a creature it has grabbed. Each attack counts toward the aurumvorax's multiple attack penalty, and the multiple attack penalty increases with each attack.</p>",
  rendingMandibles:
    "<p>The mantis makes a mandibles Strike against a creature it has @UUID[Compendium.pf2e.conditionitems.Item.Grabbed]. If that Strike hits and the creature is wearing armor with Hardness 12 or lower, the armor is broken. This Strike doesn't further damage armor that's already broken.</p>",
  constrict:
    "<p>@Damage[(1d8+6)[bludgeoning]], @Check[fortitude|dc:22|basic]</p>\n<hr />\n<p>@Localize[PF2E.NPC.Abilities.Glossary.Constrict]</p>",
  constrictTwoTypes:
    "<p>@Damage[(1d8+7)[bludgeoning],1d6[acid]], @Check[fortitude|dc:26|basic]</p>\n<hr />\n<p>@Localize[PF2E.NPC.Abilities.Glossary.Constrict]</p>",
  constrictChuul:
    "<p>@Damage[(1d8+9)[bludgeoning]] damage, @Check[fortitude|dc:25|basic] save (@UUID[Compendium.pf2e.conditionitems.Item.Grabbed] by claws only)</p>\n<hr />\n<p>@Localize[PF2E.NPC.Abilities.Glossary.Constrict]</p>",
  constrictKraken:
    "<p>@Damage[(2d10+17)[bludgeoning]], @Check[fortitude|dc:40|basic]. On a failed save, a creature that is holding its breath loses [[/gmr 1d4 #Lost rounds of air from Constrict]]{1d4 rounds} worth of air.</p>\n<hr />\n<p>@Localize[PF2E.NPC.Abilities.Glossary.Constrict]</p>",
  greaterConstrict:
    "<p>@Damage[(1d10+7)[bludgeoning]], @Check[fortitude|dc:26|basic]</p>\n<hr />\n<p>@Localize[PF2E.NPC.Abilities.Glossary.GreaterConstrict]</p>",
  lungingBiteDragon: "<p>The dragon lunges their head forward, making a jaws Strike with an extended reach of 20 feet.</p>",
  // Goblin Shark's Lunging Bite (Bestiary text quoted in the plan): a
  // movement-plus-reach compound, outside every shape.
  lungingBiteShark:
    "<p>The goblin shark dashes forward and extends its jaws bite a creature. It swims up to 10 feet in a straight line and makes a jaws Strike with a reach of 10 feet.</p>",
  lungingStrikeMantisCapture:
    "<p>The giant mantis lunges forward, making a leg Strike with an extended reach of 20 feet. If it hits, the mantis can use Capturing Grab after the Strike even if the creature is out of reach.</p>",
  broadSwipe:
    "<p>The giant makes two Strikes with its glaive against two adjacent foes, both of whom are within its reach. Both attacks count toward the giant's multiple attack penalty, but the penalty doesn't increase until after both attacks.</p>",
  zombieWideSwing: "<p>The zombie hulk makes two hunk of meat Strikes against different targets within its reach.</p>",
  wideSwing:
    "<p>The frost giant makes a single greataxe Strike and compares the attack roll result to the ACs of up to two foes within their reach. This counts as two attacks for the frost giant's multiple attack penalty.</p>",
  swipe:
    "<p><strong>Frequency</strong> once per round</p>\n<hr />\n<p><strong>Effect</strong> The cyclops makes a melee Strike and compares the attack roll result to the AC of up to two foes, each of whom must be within their melee reach and adjacent to each other. Roll damage only once and apply it to each creature hit. A Swipe counts as two attacks for the cyclops's multiple attack penalty.</p>",
  tailSweep:
    "<p>The brontosaurus makes a tail Strike and compares the attack roll to the AC of up to three foes, each of whom must be within its tail's melee reach and adjacent to at least one other target. It rolls damage only once and applies it to each creature hit.</p>\n<p>A Tail Sweep counts as two attacks for its multiple attack penalty.</p>",
  manglingRend:
    "<p>A megaprimatus makes two fist Strikes against the same target. If both hit, the attack deals an additional @Damage[2d6[bludgeoning]] damage, the target is @UUID[Compendium.pf2e.conditionitems.Item.Off-Guard], and the target takes a –20-foot status penalty to all Speeds until the end of its next turn.</p>\n<p>@UUID[Compendium.pf2e.bestiary-effects.Item.Effect: Mangling Rend]</p>",
  goryRend:
    "<p>The piscodaemon makes two claw Strikes against the same creature. If both hit, the creature takes @Damage[2d10[bleed]] and is exposed to piscovenom.</p>",
  hurlNet:
    "<p><strong>Requirements</strong> The tripkee is wielding a net in two hands</p><hr /><p><strong>Effect</strong> The tripkee makes a ranged Strike (with a [[/r 1d20+9]]{+9} attack modifier) against a Medium or smaller creature within 20 feet. On a hit, the target is @UUID[Compendium.pf2e.conditionitems.Item.Off-Guard] and takes a –10-foot circumstance penalty to its Speeds. On a critical hit, the creature is @UUID[Compendium.pf2e.conditionitems.Item.Restrained] instead. The DC to [[/act escape dc=16]] the net is 16. A creature adjacent to the target can Interact with the net to remove it.</p>\n<p>@UUID[Compendium.pf2e.bestiary-effects.Item.Effect: Hurl Net]</p>",
  hurlNetBog:
    "<p><strong>Requirements</strong> The bog strider is holding a net in two hands</p><hr /><p><strong>Effect</strong> The bog strider hurls their net to hamper a foe. They make a ranged Strike (with a [[/r 1d20+10 #Hurl Net]]{+10} modifier) against a Medium or smaller creature within 20 feet. On a hit, the target is @UUID[Compendium.pf2e.conditionitems.Item.Off-Guard] and takes a –10-foot circumstance penalty to its Speeds. On a critical hit, the creature is instead @UUID[Compendium.pf2e.conditionitems.Item.Restrained]. The DC to [[/act escape dc=16]]{Escape} the net is 16. A creature adjacent to the target can Interact with the net to remove it from the target.</p>\n<p>@UUID[Compendium.pf2e.bestiary-effects.Item.Effect: Hurl Net]</p>",
  rend: "<p>Claw</p>\n<hr />\n<p>@Localize[PF2E.NPC.Abilities.Glossary.Rend]</p>",
  rendGrisantian:
    "<p>claw.</p>\n<p>If the grisantian lion Rends after a successful Dual Pounce, combine the Rend's damage with that from the Dual Pounce for the purpose of resistances and weaknesses.</p>\n<p>@Localize[PF2E.NPC.Abilities.Glossary.Rend]</p>",
  // Lagofir's Gnaw (quoted in the plan): a flat-damage continuation.
  gnawLagofir:
    "<p><strong>Requirements</strong> The lagofir's last action was a successful jaws Strike</p><hr /><p><strong>Effect</strong> The lagofir gnaws on the target, driving its teeth deeper into its prey. The target takes @Damage[(1d8+3)[piercing]] damage.</p>",
  grab: "<p>@Localize[PF2E.NPC.Abilities.Glossary.Grab]</p>",
  changeShape: "<p>The creature changes its shape, taking on the appearance of a form of its choice.</p>",
};

function item(key, { cost = 1, frequency = null, actionType = "action" } = {}) {
  return {
    type: "action",
    name: key,
    system: { actionType: { value: actionType }, actions: { value: cost }, frequency, description: { value: T[key] } },
  };
}

describe("parseStrikePlusAbility: grab follow-ups (strikeAgainstGrabbed)", () => {
  it("Wrestle: claw Strike on the creature it is Grabbing; Prone on a hit", () => {
    const p = parseStrikePlusAbility(item("wrestle"));
    expect(p).toMatchObject({ shape: "strikeAgainstGrabbed", cost: 1, requirement: { grabbed: true, grabLimb: null } });
    expect(p.params).toEqual({ limb: "claw", count: 1, mapRule: "normal", attackBonus: 0, onHit: [{ kind: "condition", slug: "prone" }], onMissRelease: false });
  });

  it("Death Roll: flavor sentence ignored, +2 circumstance bonus, Prone on a hit, releases on a miss", () => {
    const p = parseStrikePlusAbility(item("deathRoll"));
    expect(p.shape).toBe("strikeAgainstGrabbed");
    expect(p.params).toMatchObject({ limb: "jaws", attackBonus: 2, onHit: [{ kind: "condition", slug: "prone" }], onMissRelease: true });
  });

  it("Owlbear's Gnaw: grab must be with its talons; Will save with #915 degrees, Slowed lasting while sickened", () => {
    const p = parseStrikePlusAbility(item("gnawOwlbear"));
    expect(p.shape).toBe("strikeAgainstGrabbed");
    expect(p.requirement).toEqual({ grabbed: true, grabLimb: "talons", item: null });
    expect(p.params.limb).toBe("beak");
    const [save] = p.params.onHit;
    expect(save).toMatchObject({ kind: "save", save: "will", dc: 22 });
    expect(save.degrees.criticalSuccess.none).toBe(true);
    expect(save.degrees.success.conditions).toEqual([{ slug: "sickened", value: 1, durationSeconds: null }]);
    expect(save.degrees.failure.conditions).toEqual([
      { slug: "sickened", value: 1, durationSeconds: null },
      { slug: "slowed", value: 1, durationSeconds: "while:sickened" },
    ]);
    // No Critical Failure block: PF2e uses the failure effect.
    expect(save.degrees.criticalFailure).toEqual(save.degrees.failure);
  });

  it("Maul: two claw Strikes, all at the current MAP which rises only afterwards", () => {
    expect(parseStrikePlusAbility(item("maul")).params).toMatchObject({ limb: "claw", count: 2, mapRule: "same", onHit: [] });
  });

  it("Rapid Rake: four claw Strikes with the normal MAP escalation", () => {
    expect(parseStrikePlusAbility(item("rapidRake", { cost: 2 })).params).toMatchObject({ limb: "claw", count: 4, mapRule: "normal" });
  });

  it("is all-or-nothing: armor breaking (Rending Mandibles) and bleed riders (the wolverine's Gnaw) are not offered", () => {
    expect(parseStrikePlusAbility(item("rendingMandibles"))).toBeNull();
    expect(parseStrikePlusAbility(item("gnawWolverine"))).toBeNull();
  });

  it("matches text, never names: Lagofir's 'Gnaw' (no Strike, last-action requirement) is not offered", () => {
    expect(parseStrikePlusAbility(item("gnawLagofir"))).toBeNull();
  });
});

describe("parseStrikePlusAbility: Constrict (constrictLike)", () => {
  it("Constrict: basic Fortitude damage to the grabbed creature, no Strike", () => {
    const p = parseStrikePlusAbility(item("constrict"));
    expect(p).toMatchObject({ shape: "constrictLike", requirement: { grabbed: true, grabLimb: null } });
    expect(p.params).toMatchObject({ damage: "(1d8+6)[bludgeoning]", save: "fortitude", dc: 22, degrees: null, greater: false });
  });

  it("keeps multi-type damage as one DamageRoll formula", () => {
    expect(parseStrikePlusAbility(item("constrictTwoTypes")).params.damage).toBe("(1d8+7)[bludgeoning],1d6[acid]");
  });

  it("'(Grabbed by claws only)' becomes a limb requirement", () => {
    expect(parseStrikePlusAbility(item("constrictChuul")).requirement).toEqual({ grabbed: true, grabLimb: "claw", item: null });
  });

  it("Greater Constrict: Unconscious on a failure, 1-minute immunity on a success", () => {
    const p = parseStrikePlusAbility(item("greaterConstrict"));
    expect(p.params.greater).toBe(true);
    expect(p.params.degrees.failure.conditions[0].slug).toBe("unconscious");
    expect(p.params.degrees.success).toMatchObject({ none: true, immuneSeconds: 60 });
  });

  it("the Kraken's extra air rider is not modeled, so it is not offered", () => {
    expect(parseStrikePlusAbility(item("constrictKraken"))).toBeNull();
  });
});

describe("parseStrikePlusAbility: reach and multi-target", () => {
  it("Lunging Bite (Mirage Dragon): extended reach of 20 feet", () => {
    const p = parseStrikePlusAbility(item("lungingBiteDragon", { cost: 2 }));
    expect(p).toMatchObject({ shape: "extendedReachStrike", cost: 2, params: { limb: "jaws", reachFeet: 20 } });
  });

  it("Goblin Shark's Lunging Bite (movement + reach) and Giant Mantis' Capturing-Grab rider are not offered", () => {
    expect(parseStrikePlusAbility(item("lungingBiteShark"))).toBeNull();
    expect(parseStrikePlusAbility(item("lungingStrikeMantisCapture"))).toBeNull();
  });

  it("Broad Swipe: two Strikes against two adjacent foes, same MAP, which then rises by both", () => {
    expect(parseStrikePlusAbility(item("broadSwipe", { cost: 2 })).params).toEqual({ limb: "glaive", mapRule: "same", adjacentTargets: true });
  });

  it("the zombie hulk's Wide Swing: two Strikes against different targets with the normal MAP", () => {
    const p = parseStrikePlusAbility(item("zombieWideSwing"));
    expect(p.shape).toBe("twoTargetStrikes");
    expect(p.params).toEqual({ limb: "hunk of meat", mapRule: "normal", adjacentTargets: false });
  });

  it("Wide Swing (giants): one roll against up to two ACs, counts as two attacks", () => {
    const p = parseStrikePlusAbility(item("wideSwing"));
    expect(p.shape).toBe("singleRollMultiAC");
    expect(p.params).toEqual({ limb: "greataxe", maxTargets: 2, mapCount: 2, adjacency: "none", damageOnce: false });
  });

  it("Swipe: any melee Strike, foes adjacent to each other, once per round (frequency kept)", () => {
    const p = parseStrikePlusAbility(item("swipe", { cost: 2, frequency: { max: 1, per: "round", value: 1 } }));
    expect(p.frequency).toEqual({ max: 1, per: "round", value: 1 });
    expect(p.params).toEqual({ limb: null, maxTargets: 2, mapCount: 2, adjacency: "eachOther", damageOnce: true });
  });

  it("Swipe's Frequency paragraph without structured frequency data is not trusted", () => {
    expect(parseStrikePlusAbility(item("swipe", { cost: 2 }))).toBeNull();
  });

  it("Tail Sweep: up to three foes, each adjacent to at least one other target", () => {
    expect(parseStrikePlusAbility(item("tailSweep", { cost: 2 })).params).toMatchObject({ limb: "tail", maxTargets: 3, adjacency: "atLeastOne", mapCount: 2 });
  });
});

describe("parseStrikePlusAbility: both-hit bundle, net, Rend", () => {
  it("Mangling Rend: extra damage, Off-Guard until the end of its next turn, and the Speed-penalty effect", () => {
    const p = parseStrikePlusAbility(item("manglingRend", { cost: 2 }));
    expect(p.shape).toBe("bundleWithBothHitRider");
    expect(p.params).toEqual({
      limb: "fist",
      count: 2,
      extraDamage: "2d6[bludgeoning]",
      conditions: [{ slug: "off-guard", value: null, durationSeconds: "untilNextTurn" }],
      effectName: "Effect: Mangling Rend",
    });
  });

  it("Gory Rend (bleed + piscovenom) is not offered", () => {
    expect(parseStrikePlusAbility(item("goryRend", { cost: 2 }))).toBeNull();
  });

  it("Hurl Net: fixed +9, 20 feet, Medium or smaller, the Hurl Net effect, Escape DC 16, needs a net", () => {
    const p = parseStrikePlusAbility(item("hurlNet"));
    expect(p).toMatchObject({ shape: "strikeWithOnHit", requirement: { item: "net" } });
    expect(p.params).toEqual({ fixedModifier: 9, rangeFeet: 20, sizeCap: "med", effectName: "Effect: Hurl Net", escapeDc: 16 });
  });

  it("the bog strider's Hurl Net wording (flavor sentence, 'instead Restrained') parses the same way", () => {
    expect(parseStrikePlusAbility(item("hurlNetBog")).params).toMatchObject({ fixedModifier: 10, rangeFeet: 20, sizeCap: "med" });
  });

  it("Rend: the listed Strike, from the glossary form", () => {
    expect(parseStrikePlusAbility(item("rend"))).toMatchObject({ shape: "rend", params: { limb: "claw" } });
  });

  it("a Rend with an extra rule sentence (Grisantian Lion) is not offered", () => {
    expect(parseStrikePlusAbility(item("rendGrisantian"))).toBeNull();
  });
});

describe("parseStrikePlusAbility: not offered", () => {
  it("glossary-only Strike riders (Grab) and Change Shape", () => {
    expect(parseStrikePlusAbility(item("grab"))).toBeNull();
    expect(parseStrikePlusAbility(item("changeShape"))).toBeNull();
  });

  it("reactions and free actions", () => {
    expect(parseStrikePlusAbility(item("wrestle", { actionType: "reaction" }))).toBeNull();
    expect(parseStrikePlusAbility(item("wrestle", { actionType: "free" }))).toBeNull();
  });

  it("never throws on malformed input", () => {
    expect(() => parseStrikePlusAbility(null)).not.toThrow();
    expect(parseStrikePlusAbility({ type: "action", system: { description: {} } })).toBeNull();
    expect(parseStrikePlusAbility({ type: "action", system: { description: { value: 7 } } })).toBeNull();
  });
});

describe("describeStrikePlus", () => {
  it("states the mechanics, never the prose", () => {
    expect(describeStrikePlus(parseStrikePlusAbility(item("deathRoll")), ["Goblin"])).toBe(
      "jaws Strike on grabbed Goblin; +2 to hit; on hit: prone; on a miss it releases the grab",
    );
    expect(describeStrikePlus(parseStrikePlusAbility(item("broadSwipe", { cost: 2 })), ["A", "B"])).toBe(
      "glaive Strike on each of A and B; both at the current MAP, which then rises by 2",
    );
    expect(describeStrikePlus(parseStrikePlusAbility(item("constrict")), ["Goblin"])).toBe(
      "(1d8+6)[bludgeoning] to grabbed Goblin, basic Fortitude DC 22; not an attack",
    );
  });
});
