import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import {
  classifyTargetEffect,
  resolveTargetedSelfEffectConfig,
  summarizeMarkEffect,
  TARGETED_SELF_EFFECT_ALLOWLIST,
  bindTokenMarkEffect,
  selectRollOptionSuboption,
  markedTokenUuids,
  findActiveMarkEffects,
  markAnnotation,
} from "../scripts/targeted-feat-actions.mjs";

// #922: rule shapes copied from the live compiled compendium (pf2e 8.5.0):
// Effect: Hunt Prey / Effect: Devise a Stratagem.
const HUNT_PREY_EFFECT = {
  name: "Effect: Hunt Prey",
  type: "effect",
  system: { slug: "effect-hunt-prey", rules: [{ key: "TokenMark", slug: "hunted-prey" }], badge: null },
};
const DEVISE_EFFECT = {
  name: "Effect: Devise a Stratagem",
  type: "effect",
  system: {
    slug: "effect-devise-a-stratagem",
    badge: { type: "formula", value: "1d20", evaluate: true },
    rules: [
      { key: "TokenMark", slug: "devise-a-stratagem" },
      {
        alwaysActive: true,
        key: "RollOption",
        option: "devise-a-stratagem",
        suboptions: [{ value: "attack" }, { value: "skill" }, { value: "defensive", predicate: ["feat:defensive-stratagem"] }],
        toggleable: true,
      },
      { key: "SubstituteRoll", selector: "strike-attack-roll", value: "@item.badge.value" },
    ],
  },
};

describe("TARGETED_SELF_EFFECT_ALLOWLIST", () => {
  it("lists exactly hunt-prey and devise-a-stratagem for this first slice", () => {
    expect(Object.keys(TARGETED_SELF_EFFECT_ALLOWLIST).sort()).toEqual(["devise-a-stratagem", "hunt-prey"]);
  });

  it("maps each action slug to its effect's own TokenMark slug (Hunt Prey's is hunted-prey)", () => {
    expect(TARGETED_SELF_EFFECT_ALLOWLIST["hunt-prey"].markSlug).toBe("hunted-prey");
    expect(TARGETED_SELF_EFFECT_ALLOWLIST["devise-a-stratagem"].markSlug).toBe("devise-a-stratagem");
  });

  it("Hunt Prey: see-or-hear (no sight requirement), one prey at a time", () => {
    expect(TARGETED_SELF_EFFECT_ALLOWLIST["hunt-prey"]).toMatchObject({ requiresSight: false, exclusiveMark: true, suboption: null });
  });

  it("Devise a Stratagem: a creature you can see, attack stratagem", () => {
    expect(TARGETED_SELF_EFFECT_ALLOWLIST["devise-a-stratagem"]).toMatchObject({
      requiresSight: true,
      exclusiveMark: false,
      suboption: { option: "devise-a-stratagem", value: "attack" },
    });
  });
});

describe("bindTokenMarkEffect", () => {
  it("sets the matching TokenMark rule's uuid to the target token", () => {
    const bound = bindTokenMarkEffect(HUNT_PREY_EFFECT, "hunted-prey", "Scene.s1.Token.t1");
    expect(bound.system.rules[0]).toEqual({ key: "TokenMark", slug: "hunted-prey", uuid: "Scene.s1.Token.t1" });
    expect(bound.system.slug).toBe("effect-hunt-prey");
  });

  it("never mutates the original source object", () => {
    const original = structuredClone(DEVISE_EFFECT);
    bindTokenMarkEffect(DEVISE_EFFECT, "devise-a-stratagem", "Scene.s1.Token.t1");
    expect(DEVISE_EFFECT).toEqual(original);
  });

  it("returns null when no TokenMark rule has that slug (e.g. the action slug instead of the mark slug)", () => {
    expect(bindTokenMarkEffect(HUNT_PREY_EFFECT, "hunt-prey", "Scene.s1.Token.t1")).toBeNull();
  });

  it("returns null for a source with no rules, or with no target token uuid", () => {
    expect(bindTokenMarkEffect({ system: { rules: [] } }, "hunted-prey", "Scene.s1.Token.t1")).toBeNull();
    expect(bindTokenMarkEffect(HUNT_PREY_EFFECT, "hunted-prey", null)).toBeNull();
  });

  it("leaves every other rule untouched", () => {
    const bound = bindTokenMarkEffect(DEVISE_EFFECT, "devise-a-stratagem", "Scene.s1.Token.t2");
    expect(bound.system.rules[0]).toEqual({ key: "TokenMark", slug: "devise-a-stratagem", uuid: "Scene.s1.Token.t2" });
    expect(bound.system.rules.slice(1)).toEqual(DEVISE_EFFECT.system.rules.slice(1));
  });
});

describe("selectRollOptionSuboption", () => {
  it("sets the toggleable RollOption's selection (the field RollOptionRuleElement#toggle writes)", () => {
    const selected = selectRollOptionSuboption(DEVISE_EFFECT, "devise-a-stratagem", "attack");
    expect(selected.system.rules[1].selection).toBe("attack");
    expect(selected.system.rules[0]).toEqual(DEVISE_EFFECT.system.rules[0]);
  });

  it("never mutates the original source object", () => {
    const original = structuredClone(DEVISE_EFFECT);
    selectRollOptionSuboption(DEVISE_EFFECT, "devise-a-stratagem", "attack");
    expect(DEVISE_EFFECT).toEqual(original);
  });

  it("returns null for an unknown option or suboption", () => {
    expect(selectRollOptionSuboption(DEVISE_EFFECT, "nope", "attack")).toBeNull();
    expect(selectRollOptionSuboption(DEVISE_EFFECT, "devise-a-stratagem", "bogus")).toBeNull();
  });

  it("composes with bindTokenMarkEffect", () => {
    const both = selectRollOptionSuboption(bindTokenMarkEffect(DEVISE_EFFECT, "devise-a-stratagem", "T"), "devise-a-stratagem", "attack");
    expect(both.system.rules[0].uuid).toBe("T");
    expect(both.system.rules[1].selection).toBe("attack");
  });
});

describe("markedTokenUuids", () => {
  it("lists the token uuids an actor's effects mark with that slug", () => {
    const effects = [
      { system: { rules: [{ key: "TokenMark", slug: "hunted-prey", uuid: "A" }] } },
      { system: { rules: [{ key: "TokenMark", slug: "devise-a-stratagem", uuid: "B" }] } },
      { system: { rules: [{ key: "TokenMark", slug: "hunted-prey" }] } },
    ];
    expect(markedTokenUuids(effects, "hunted-prey")).toEqual(["A"]);
    expect(markedTokenUuids(effects, "devise-a-stratagem")).toEqual(["B"]);
    expect(markedTokenUuids([], "hunted-prey")).toEqual([]);
  });
});

describe("findActiveMarkEffects / markAnnotation", () => {
  const effects = [
    { system: { rules: [{ key: "TokenMark", slug: "hunted-prey", uuid: "Scene.s1.Token.t1" }], badge: null } },
    { system: { rules: [{ key: "TokenMark", slug: "devise-a-stratagem", uuid: "Scene.s1.Token.t2" }], badge: { type: "value", value: 17 } } },
    { system: { rules: [], badge: null } },
  ];

  it("finds the marks bound to a target, with the evaluated badge value when present", () => {
    expect(findActiveMarkEffects(effects, "Scene.s1.Token.t1")).toEqual([{ slug: "hunted-prey", badgeValue: null }]);
    expect(findActiveMarkEffects(effects, "Scene.s1.Token.t2")).toEqual([{ slug: "devise-a-stratagem", badgeValue: 17 }]);
  });

  it("returns [] for an unmarked token or a missing uuid", () => {
    expect(findActiveMarkEffects(effects, "Scene.s1.Token.unmarked")).toEqual([]);
    expect(findActiveMarkEffects(effects, null)).toEqual([]);
  });

  it("ignores an unevaluated formula badge", () => {
    const raw = [{ system: { rules: [{ key: "TokenMark", slug: "devise-a-stratagem", uuid: "X" }], badge: { type: "formula", value: "1d20" } } }];
    expect(findActiveMarkEffects(raw, "X")).toEqual([{ slug: "devise-a-stratagem", badgeValue: null }]);
  });

  it("returns every mark on the same target and joins them into one annotation", () => {
    const both = [
      effects[0],
      { system: { rules: [{ key: "TokenMark", slug: "devise-a-stratagem", uuid: "Scene.s1.Token.t1" }], badge: { type: "value", value: 4 } } },
    ];
    const marks = findActiveMarkEffects(both, "Scene.s1.Token.t1");
    expect(marks).toEqual([
      { slug: "hunted-prey", badgeValue: null },
      { slug: "devise-a-stratagem", badgeValue: 4 },
    ]);
    expect(markAnnotation(marks)).toBe("marked: hunted-prey; marked: devise-a-stratagem, d20 = 4");
    expect(markAnnotation([])).toBeNull();
  });
});

// #946: real linked-effect rules from the pf2e 8.5.0 compendium population
// (tests/fixtures/marked-target-population.json).
const POPULATION = JSON.parse(
  readFileSync(new URL("./fixtures/marked-target-population.json", import.meta.url), "utf8"),
).entries;
const rulesOf = (slug) => {
  const entry = POPULATION.find((e) => e.slug === slug);
  if (!entry) throw new Error(`fixture has no ${slug}`);
  return entry.effect.rules;
};

describe("classifyTargetEffect (#946)", () => {
  it("'none' for a plain effect with no target dependence, even with a toggleable RollOption or ChoiceSet (#914's own gates handle those)", () => {
    expect(classifyTargetEffect([{ key: "FlatModifier", selector: "ac", value: 2 }])).toBe("none");
    expect(classifyTargetEffect([{ key: "RollOption", option: "x", toggleable: true }])).toBe("none");
    expect(classifyTargetEffect([])).toBe("none");
  });

  it("'targetConditional' for target: predicates with no TokenMark (Point Blank Stance, Spell Parry, Monastic Archer Stance, Eye of the Arclords)", () => {
    for (const slug of ["point-blank-stance", "spell-parry", "monastic-archer-stance", "eye-of-the-arclords"]) {
      expect(classifyTargetEffect(rulesOf(slug)), slug).toBe("targetConditional");
    }
  });

  it("'marked' for a clean single-TokenMark effect (Smite, Duelist's Challenge, Size Up, Hunt Prey)", () => {
    for (const slug of ["smite", "duelists-challenge", "size-up", "hunt-prey", "whispers-of-weakness"]) {
      expect(classifyTargetEffect(rulesOf(slug)), slug).toBe("marked");
    }
  });

  it("'unsupported' for a TokenMark effect with a toggleable RollOption (Harsh Judgement, Nothing Personal, Devise a Stratagem without its #922 config)", () => {
    for (const slug of ["harsh-judgement", "nothing-personal", "devise-a-stratagem"]) {
      expect(classifyTargetEffect(rulesOf(slug)), slug).toBe("unsupported");
    }
  });

  it("'unsupported' for a target-dependent effect with a ChoiceSet or GrantItem (Unfazed Assessment, Come and Get Me, Divine Weapon, Hunt Runelord, Intensified Element Stance)", () => {
    for (const slug of ["unfazed-assessment", "come-and-get-me", "divine-weapon", "hunt-runelord", "intensified-element-stance"]) {
      expect(classifyTargetEffect(rulesOf(slug)), slug).toBe("unsupported");
    }
  });

  it("'unsupported' for an @target reference, a slugless TokenMark, or two TokenMarks", () => {
    expect(classifyTargetEffect([{ key: "Note", text: "does something to @target" }])).toBe("unsupported");
    expect(classifyTargetEffect([{ key: "TokenMark" }])).toBe("unsupported");
    expect(classifyTargetEffect([{ key: "TokenMark", slug: "a" }, { key: "TokenMark", slug: "b" }])).toBe("unsupported");
  });
});

describe("resolveTargetedSelfEffectConfig (#946)", () => {
  const itemFor = (slug, overrides = {}) => {
    const e = POPULATION.find((p) => p.slug === slug);
    return { slug, system: { traits: { value: e.traits }, description: { value: e.description } }, ...overrides };
  };
  const effectFor = (slug) => ({ system: { rules: rulesOf(slug) } });

  it("keeps #922's explicit configs for Hunt Prey and Devise a Stratagem", () => {
    expect(resolveTargetedSelfEffectConfig(itemFor("hunt-prey"), effectFor("hunt-prey"))).toMatchObject({ markSlug: "hunted-prey", requiresSight: false, exclusiveMark: true });
    expect(resolveTargetedSelfEffectConfig(itemFor("devise-a-stratagem"), effectFor("devise-a-stratagem"))).toMatchObject({
      markSlug: "devise-a-stratagem", suboption: { option: "devise-a-stratagem", value: "attack" },
    });
  });

  it("derives Smite / Duelist's Challenge / Size Up from their own data", () => {
    expect(resolveTargetedSelfEffectConfig(itemFor("smite"), effectFor("smite"))).toEqual({
      markSlug: "smite", requiresSight: true, needsHearing: false, rangeFeet: null, targetNotMindless: false, requirements: [], exclusiveMark: true, suboption: null,
    });
    expect(resolveTargetedSelfEffectConfig(itemFor("duelists-challenge"), effectFor("duelists-challenge"))).toMatchObject({ markSlug: "duelists-challenge", exclusiveMark: false });
    expect(resolveTargetedSelfEffectConfig(itemFor("size-up"), effectFor("size-up"))).toMatchObject({ markSlug: "size-up", needsHearing: true, targetNotMindless: true });
  });

  it("null for a cursebound item even when its text is otherwise usable", () => {
    const item = itemFor("smite", { system: { traits: { value: ["cursebound", "oracle"] }, description: { value: "<p>Designate one enemy you can see.</p>" } } });
    expect(resolveTargetedSelfEffectConfig(item, effectFor("smite"))).toBeNull();
  });

  it("null for a non-marked effect, or no description", () => {
    expect(resolveTargetedSelfEffectConfig(itemFor("harsh-judgement"), effectFor("harsh-judgement"))).toBeNull();
    expect(resolveTargetedSelfEffectConfig(itemFor("point-blank-stance"), effectFor("point-blank-stance"))).toBeNull();
    expect(resolveTargetedSelfEffectConfig({ slug: "smite", system: {} }, effectFor("smite"))).toBeNull();
  });
});

describe("summarizeMarkEffect (#946)", () => {
  it("scopes each bonus/penalty to the mark, the marked creature's own actions, or everyone else", () => {
    expect(summarizeMarkEffect(rulesOf("size-up"), "size-up", "Orc", "1 days")).toBe(
      "mark Orc: +perception-dc vs Orc's actions, +deception/diplomacy/intimidation vs Orc (1 days)",
    );
    expect(summarizeMarkEffect(rulesOf("duelists-challenge"), "duelists-challenge", "Orc")).toBe(
      "mark Orc: +melee-strike-damage vs Orc, -strike-damage vs others",
    );
  });
});
