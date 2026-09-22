import { describe, it, expect, beforeEach } from "vitest";
import {
  parseDeckEntry,
  extractDirectives,
  pickSubentry,
  hitDeckCategory,
  fumbleDeckCategory,
  drawAndApplyCriticalCard,
} from "../scripts/dungeon-critical-deck.mjs";

// Real fixture content pulled directly from
// /home/cjohannsen/pf2e-data/packs/pf2e/criticaldeck/*.json
// (pages[0].text.content), confirmed live against the running world's
// pf2e.criticaldeck pack per #28.

const HIT_DECK_1 =
  '<section class="critical-deck"><h1>Crunch</h1><blockquote><p><strong>Crit Effect:</strong> The target is @UUID[Compendium.pf2e.conditionitems.Item.Sickened]{Sickened 3}.</p></blockquote><p><code>Bludgeoning</code></p><h1>Forearm Piercing</h1><blockquote><p><strong>Crit Effect:</strong> The target drops one weapon it\'s holding (chosen randomly by the GM).</p></blockquote><p><code>Piercing</code></p><h1>Surprise Opening</h1><blockquote><p><strong>Crit Effect:</strong> You gain 1 action that you can use before the end of your turn to use an attack action against the target.</p></blockquote><p><code>Slashing</code></p><h1>Allergic reaction</h1><blockquote><p>The target takes @Damage[1d8[poison]] damage.</p></blockquote><p><code>Bomb or Spell</code></p></section>';

const FUMBLE_DECK_1 =
  '<section class="fumble-deck"><h1>Meant to do That</h1><blockquote><p>You are moved 10 feet in a random direction (determined by the GM). This movement triggers reactions.</p></blockquote><p><code>Melee</code></p><h1>Misjudged the Distance</h1><blockquote><p>Until the end of your next turn, all your range increment penalties are doubled.</p></blockquote><p><code>Ranged</code></p><h1>Not the Weak Point</h1><blockquote><p>You take and @Damage[1d6[bleed]] and can\'t use this attack until the end of your next turn.</p></blockquote><p><code>Unarmed</code></p><h1>How did that Happen?</h1><blockquote><p>You call forth a mist with the effects of @UUID[Compendium.pf2e.spells-srd.Item.Stinking Cloud] centered on a corner of your space (determined by the GM).</p></blockquote><p><code>Spell</code></p></section>';

const FUMBLE_DECK_10 =
  "<section class=\"fumble-deck\"><h1>Off Balance</h1><blockquote><p>You take a @UUID[Compendium.pf2e.other-effects.Item.Effect: -2 circumstance penalty to attack rolls]{-2 circumstance penalty to attack rolls} until the end of your next turn.</p></blockquote><p><code>Melee</code></p><h1>Friendly Fire</h1><blockquote><p>You hit the ally nearest to the target.</p></blockquote><p><code>Ranged</code></p><h1>Something's Broken</h1><blockquote><p>You take @Damage[1d4[bludgeoning]] damage, and you can't use this attack until healed.</p></blockquote><p><code>Unarmed</code></p><h1>Power Drain</h1><blockquote><p>You loose one prepared spell or spell slot (determined randomly by the GM).</p></blockquote><p><code>Spell</code></p></section>";

const FUMBLE_DECK_15 =
  '<section class="fumble-deck"><h1>Broken Weapon</h1><blockquote><p>Your weapon\'s current Hit Point are reduced to its Broken Threshold. If already @UUID[Compendium.pf2e.conditionitems.Item.Broken], the weapon takes @Damage[3d6] damage, ignoring Hardness.</p></blockquote><p><code>Melee</code></p><h1>My Spleeny Bits!</h1><blockquote><p>You become @UUID[Compendium.pf2e.conditionitems.Item.Wounded]{Wounded 1} or your wounded value increases by 1.</p></blockquote><p><code>Ranged</code></p><h1>Frustration</h1><blockquote><p>You take a @UUID[Compendium.pf2e.other-effects.Item.Effect: -2 circumstance penalty to attack rolls]{-2 circumstance penalty to attack rolls} until the end of your next turn.</p></blockquote><p><code>Unarmed</code></p><h1>Beastly Rift</h1><blockquote><p>Your spell becomes a @UUID[Compendium.pf2e.spells-srd.Item.Summon Animal] spell of the same rank. The animal attacks you.</p></blockquote><p><code>Spell</code></p></section>';

const FUMBLE_DECK_2 =
  '<section class="fumble-deck"><h1>Wrong End</h1><blockquote><p>If you are using a slashing weapon, you take @Damage[1d6[slashing]] damage and 1 persistent bleed damage.</p></blockquote><p><code>Melee</code></p><h1>Phantom Wind</h1><blockquote><p>You take a @UUID[Compendium.pf2e.other-effects.Item.Effect: -2 circumstance penalty to ranged attacks]{-2 circumstance penalty to ranged attacks} until the end of your next turn.</p></blockquote><p><code>Ranged</code></p><h1>Overthink It</h1><blockquote><p>Your target gains a @UUID[Compendium.pf2e.other-effects.Item.Effect: +2 circumstance bonus to AC]{+2 circumstance bonus to AC} against attacks you make against it until the end of your next turn.</p></blockquote><p><code>Unarmed</code></p><h1>Power Down</h1><blockquote><p>Until healed, you are @UUID[Compendium.pf2e.conditionitems.Item.Stupefied]{Stupefied 2}</p></blockquote><p><code>Spell</code></p></section>';

const HIT_DECK_10 =
  '<section class="critical-deck"><h1>I See Stars</h1><blockquote><p>Normal damage. <strong>Crit Effect:</strong> The target is @UUID[Compendium.pf2e.conditionitems.Item.Dazzled] until healed.</p></blockquote><p><code>Bludgeoning</code></p><h1>Pinhole</h1><blockquote><p><strong>Crit Effect:</strong> The target takes @Localize[PF2E.PersistentDamage.Bleed1.success] that can\'t be removed until the target is healed.</p></blockquote><p><code>Piercing</code></p><h1>Disembowel</h1><blockquote><p>Triple damage.</p></blockquote><p><code>Slashing</code></p><h1>Conduit</h1><blockquote><p>The target takes a -2 status penalty to AC and saves against your bombs or spells until the end of your next turn.</p></blockquote><p><code>Bomb or Spell</code></p></section>';

const HIT_DECK_40 =
  '<section class="critical-deck"><h1>Breathless</h1><blockquote><p>The target is @UUID[Compendium.pf2e.conditionitems.Item.Fatigued].</p></blockquote><p><code>Bludgeoning</code></p><h1>Spun Around</h1><blockquote><p>The target is @UUID[Compendium.pf2e.conditionitems.Item.Off-Guard] until the end of its next turn.</p></blockquote><p><code>Piercing</code></p><h1>Sliced Hand</h1><blockquote><p>Normal damage. Until healed, the target is @UUID[Compendium.pf2e.conditionitems.Item.Enfeebled]{Enfeebled 1}, @UUID[Compendium.pf2e.conditionitems.Item.Clumsy]{Clumsy 1}, and can\'t used one of its hands (determined randomly by the GM).</p></blockquote><p><code>Slashing</code></p><h1>Combustion</h1><blockquote><p>If this is a fire bomb or spell, the target takes triple damage and @Damage[1d6[persistent,fire]]. Any other bomb or spell deals double damage.</p></blockquote><p><code>Bomb or Spell</code></p></section>';

// Real fixture content pulled directly from
// /home/cjohannsen/pf2e-data/packs/pf2e/criticaldeck/critical-hit-deck-37.json
// -- confirmed live alongside HIT_DECK_40's Combustion as the only two
// occurrences of a bracket-tagged persistent @Damage formula in the deck.
const HIT_DECK_37 =
  '<section class="critical-deck"><h1>Concussion</h1><blockquote><p>Normal damage. The target is @UUID[Compendium.pf2e.conditionitems.Item.Confused] for 1 minute and @UUID[Compendium.pf2e.conditionitems.Item.Stupefied]{Stupefied 2} until healed.</p></blockquote><p><code>Bludgeoning</code></p><h1>Infection</h1><blockquote><p>The target must succeed at a @Check[fortitude] or contract filth fever (Pathfinder Bestiary 258).</p></blockquote><p><code>Piercing</code></p><h1>Flay</h1><blockquote><p>Normal damage. The target is @UUID[Compendium.pf2e.conditionitems.Item.Enfeebled]{Enfeebled 3} until healed.</p></blockquote><p><code>Slashing</code></p><h1>Corrosive</h1><blockquote><p>If this is an acid bomb or spell, the target takes triple damage and @Damage[1d6[persistent,acid]]. Any other bomb or spell deals double damage.</p></blockquote><p><code>Bomb or Spell</code></p></section>';

// Real fixture content pulled directly from
// /home/cjohannsen/pf2e-data/packs/pf2e/criticaldeck/critical-fumble-deck-11.json
// -- a self-directed @Localize persistent-damage shorthand (all 6 real
// occurrences share the exact same key, "Bleed1.success", but are parsed
// generically -- not hardcoded to this one case).
const FUMBLE_DECK_11 =
  '<section class="fumble-deck"><h1>Slipped</h1><blockquote><p>You fall @UUID[Compendium.pf2e.conditionitems.Item.Prone].</p></blockquote><p><code>Melee</code></p><h1>Backfire</h1><blockquote><p>You hit yourself instead of the target.</p></blockquote><p><code>Ranged</code></p><h1>Bruised Ego</h1><blockquote><p>You can\'t attack another creature until the target is knocked out or the end of your next turn.</p></blockquote><p><code>Unarmed</code></p><h1>Nosebleed</h1><blockquote><p>You take @Localize[PF2E.PersistentDamage.Bleed1.success].</p></blockquote><p><code>Spell</code></p></section>';

// Pretty-printed with newlines between tags -- confirmed live several real
// deck documents are stored this way rather than compact, so the parser
// must tolerate both.
const HIT_DECK_2_PRETTY = `<section class="critical-deck">
<h1>Where Am I?</h1>
<blockquote>
<p>Normal damage. <strong>Crit Effect:</strong> The target is @UUID[Compendium.pf2e.conditionitems.Item.Stunned]{Stunned 2}.</p>
</blockquote>
<p><code>Bludgeoning</code></p>
<h1>Surprise Opening</h1>
<blockquote>
<p><strong>Crit Effect:</strong> You gain 1 action that you can use before the end of your turn to use an attack action against the target.</p>
</blockquote>
<p><code>Piercing</code></p>
<h1>Missing Ear</h1>
<blockquote>
<p>Normal damage. The target takes a -2 circumstance penalty to Perception check and Charisma-based check except Intimidation until healed.</p>
</blockquote>
<p><code>Slashing</code></p>
<h1>Mind Cloud</h1>
<blockquote>
<p>The target is @UUID[Compendium.pf2e.conditionitems.Item.Stupefied]{Stupefied 2} until healed.</p>
</blockquote>
<p><code>Bomb or Spell</code></p>
</section>`;

describe("parseDeckEntry", () => {
  it("parses all 4 sub-entries of a compact hit-deck card, in order", () => {
    const entries = parseDeckEntry(HIT_DECK_1);
    expect(entries.map((e) => e.name)).toEqual([
      "Crunch",
      "Forearm Piercing",
      "Surprise Opening",
      "Allergic reaction",
    ]);
    expect(entries.map((e) => e.category)).toEqual([
      "Bludgeoning",
      "Piercing",
      "Slashing",
      "Bomb or Spell",
    ]);
  });

  it("tolerates pretty-printed HTML with newlines between tags", () => {
    const entries = parseDeckEntry(HIT_DECK_2_PRETTY);
    expect(entries).toHaveLength(4);
    expect(entries[0].name).toBe("Where Am I?");
    expect(entries[0].category).toBe("Bludgeoning");
    expect(entries[0].directives).toEqual([
      { type: "condition", slug: "stunned", value: 2, target: "target" },
    ]);
  });

  it("a condition directive with a target subject applies to the target (Crunch)", () => {
    const [crunch] = parseDeckEntry(HIT_DECK_1);
    expect(crunch.directives).toEqual([
      { type: "condition", slug: "sickened", value: 3, target: "target" },
    ]);
  });

  it("bare prose with no directive at all yields no directives", () => {
    const [, forearmPiercing, surpriseOpening] = parseDeckEntry(HIT_DECK_1);
    expect(forearmPiercing.directives).toEqual([]);
    expect(surpriseOpening.directives).toEqual([]);
  });

  it("a target-subject damage directive applies to the target (Allergic reaction)", () => {
    const [, , , allergic] = parseDeckEntry(HIT_DECK_1);
    expect(allergic.directives).toEqual([
      { type: "damage", formula: "1d8[poison]", target: "target" },
    ]);
  });

  it("self-directed damage on a fumble card (Not the Weak Point)", () => {
    const entries = parseDeckEntry(FUMBLE_DECK_1);
    const notTheWeakPoint = entries.find(
      (e) => e.name === "Not the Weak Point",
    );
    expect(notTheWeakPoint.directives).toEqual([
      { type: "damage", formula: "1d6[bleed]", target: "self" },
    ]);
  });

  it("a spells-srd UUID is never auto-applied regardless of subject", () => {
    const entries = parseDeckEntry(FUMBLE_DECK_1);
    const howDidThatHappen = entries.find(
      (e) => e.name === "How did that Happen?",
    );
    expect(howDidThatHappen.directives).toEqual([
      {
        type: "skip",
        raw: expect.stringContaining("spells-srd"),
        reason: "other-uuid",
      },
    ]);
  });

  it("a self-directed other-effects UUID applies via effect (Off Balance)", () => {
    const entries = parseDeckEntry(FUMBLE_DECK_10);
    const offBalance = entries.find((e) => e.name === "Off Balance");
    expect(offBalance.directives).toEqual([
      {
        type: "effect",
        uuid: "Compendium.pf2e.other-effects.Item.Effect: -2 circumstance penalty to attack rolls",
        label: "-2 circumstance penalty to attack rolls",
        target: "self",
      },
    ]);
  });

  it("weapon-HP damage is skipped even though it wraps @Damage (Something's Broken is self, Broken Weapon is skipped)", () => {
    const somethingsBroken = parseDeckEntry(FUMBLE_DECK_10).find(
      (e) => e.name === "Something's Broken",
    );
    expect(somethingsBroken.directives).toEqual([
      { type: "damage", formula: "1d4[bludgeoning]", target: "self" },
    ]);

    const brokenWeapon = parseDeckEntry(FUMBLE_DECK_15).find(
      (e) => e.name === "Broken Weapon",
    );
    // Both the condition (ambiguous subject: "If already <UUID>,") and the
    // weapon-HP damage ("the weapon takes @Damage[3d6]") are skipped.
    expect(brokenWeapon.directives).toEqual([
      {
        type: "skip",
        raw: expect.stringContaining("Broken"),
        reason: "subject",
      },
      { type: "skip", raw: expect.stringContaining("3d6"), reason: "subject" },
    ]);
  });

  it("an 'or' fallback clause after a condition UUID doesn't block applying it (My Spleeny Bits!)", () => {
    const entry = parseDeckEntry(FUMBLE_DECK_15).find(
      (e) => e.name === "My Spleeny Bits!",
    );
    expect(entry.directives).toEqual([
      { type: "condition", slug: "wounded", value: 1, target: "self" },
    ]);
  });

  it("a target-directed effect on a FUMBLE card still applies to the target (Overthink It)", () => {
    const entry = parseDeckEntry(FUMBLE_DECK_2).find(
      (e) => e.name === "Overthink It",
    );
    expect(entry.directives).toEqual([
      {
        type: "effect",
        uuid: "Compendium.pf2e.other-effects.Item.Effect: +2 circumstance bonus to AC",
        label: "+2 circumstance bonus to AC",
        target: "target",
      },
    ]);
  });

  it("self-directed damage even when the clause opens with a conditional (Wrong End)", () => {
    const entry = parseDeckEntry(FUMBLE_DECK_2).find(
      (e) => e.name === "Wrong End",
    );
    expect(entry.directives).toEqual([
      { type: "damage", formula: "1d6[slashing]", target: "self" },
    ]);
  });

  it("a bare (no-braces) condition UUID resolves with a null value (Power Down uses braces; Beastly Rift's spell UUID is skipped)", () => {
    const powerDown = parseDeckEntry(FUMBLE_DECK_2).find(
      (e) => e.name === "Power Down",
    );
    expect(powerDown.directives).toEqual([
      { type: "condition", slug: "stupefied", value: 2, target: "self" },
    ]);

    const beastlyRift = parseDeckEntry(FUMBLE_DECK_15).find(
      (e) => e.name === "Beastly Rift",
    );
    expect(beastlyRift.directives).toEqual([
      {
        type: "skip",
        raw: expect.stringContaining("Summon Animal"),
        reason: "other-uuid",
      },
    ]);
  });

  it("a condition directive alongside a @Localize directive on another sub-entry still resolves normally (I See Stars)", () => {
    const iSeeStars = parseDeckEntry(HIT_DECK_10).find(
      (e) => e.name === "I See Stars",
    );
    expect(iSeeStars.directives).toEqual([
      { type: "condition", slug: "dazzled", value: null, target: "target" },
    ]);
  });

  it("a @Localize[PF2E.PersistentDamage.<Type><N>.<outcome>] shorthand parses to a target-directed persistentDamage directive (Pinhole)", () => {
    const pinhole = parseDeckEntry(HIT_DECK_10).find(
      (e) => e.name === "Pinhole",
    );
    expect(pinhole.directives).toEqual([
      {
        type: "persistentDamage",
        damageType: "bleed",
        value: 1,
        target: "target",
      },
    ]);
  });

  it("the same @Localize persistent-damage shorthand parses to a self-directed directive on a fumble card (Nosebleed)", () => {
    const nosebleed = parseDeckEntry(FUMBLE_DECK_11).find(
      (e) => e.name === "Nosebleed",
    );
    expect(nosebleed.directives).toEqual([
      {
        type: "persistentDamage",
        damageType: "bleed",
        value: 1,
        target: "self",
      },
    ]);
  });

  it("a damage formula with nested brackets (a damage-type trait) parses whole (Corrosive)", () => {
    const corrosive = parseDeckEntry(HIT_DECK_37).find(
      (e) => e.name === "Corrosive",
    );
    expect(corrosive.directives).toEqual([
      { type: "damage", formula: "1d6[persistent,acid]", target: "target" },
    ]);
  });

  it("plain prose with no directive markup at all yields no directives (Disembowel, Conduit)", () => {
    const disembowel = parseDeckEntry(HIT_DECK_10).find(
      (e) => e.name === "Disembowel",
    );
    expect(disembowel.directives).toEqual([]);
    expect(disembowel.effectHtml).toContain("Triple damage.");

    const conduit = parseDeckEntry(HIT_DECK_10).find(
      (e) => e.name === "Conduit",
    );
    expect(conduit.directives).toEqual([]);
  });

  it("multiple conditions in one clause all resolve to the same subject (Sliced Hand)", () => {
    const slicedHand = parseDeckEntry(HIT_DECK_40).find(
      (e) => e.name === "Sliced Hand",
    );
    expect(slicedHand.directives).toEqual([
      { type: "condition", slug: "enfeebled", value: 1, target: "target" },
      { type: "condition", slug: "clumsy", value: 1, target: "target" },
    ]);
  });

  it("a bare condition UUID with a hyphenated name slugs to 'off-guard' (Spun Around)", () => {
    const spunAround = parseDeckEntry(HIT_DECK_40).find(
      (e) => e.name === "Spun Around",
    );
    expect(spunAround.directives).toEqual([
      { type: "condition", slug: "off-guard", value: null, target: "target" },
    ]);
  });

  it("a damage formula with nested brackets (a damage-type trait) parses whole (Combustion)", () => {
    const combustion = parseDeckEntry(HIT_DECK_40).find(
      (e) => e.name === "Combustion",
    );
    expect(combustion.directives).toEqual([
      { type: "damage", formula: "1d6[persistent,fire]", target: "target" },
    ]);
  });

  it("a bare condition UUID with no braces at all resolves with a null value (Breathless)", () => {
    const breathless = parseDeckEntry(HIT_DECK_40).find(
      (e) => e.name === "Breathless",
    );
    expect(breathless.directives).toEqual([
      { type: "condition", slug: "fatigued", value: null, target: "target" },
    ]);
  });
});

describe("extractDirectives", () => {
  it("trims a stray leading space inside @Damage[ ... ]", () => {
    expect(
      extractDirectives("<p>The target takes @Damage[ 1d6] damage.</p>"),
    ).toEqual([{ type: "damage", formula: "1d6", target: "target" }]);
  });

  it("skips an ambiguous third-party subject", () => {
    expect(
      extractDirectives("<p>An ally takes @Damage[1d6[fire]] damage.</p>"),
    ).toEqual([
      {
        type: "skip",
        raw: expect.stringContaining("@Damage"),
        reason: "subject",
      },
    ]);
  });

  it("a @Localize key that isn't the PF2E.PersistentDamage.<Type><N>.<outcome> shape is skipped, not crashed on", () => {
    expect(
      extractDirectives(
        "<p>The target takes @Localize[PF2E.SomeOtherKey.success] damage.</p>",
      ),
    ).toEqual([
      {
        type: "skip",
        raw: expect.stringContaining("@Localize"),
        reason: "localize",
      },
    ]);
  });

  it("a @Localize persistent-damage key with an ambiguous subject is skipped", () => {
    expect(
      extractDirectives(
        "<p>An ally takes @Localize[PF2E.PersistentDamage.Bleed1.success].</p>",
      ),
    ).toEqual([
      {
        type: "skip",
        raw: expect.stringContaining("@Localize"),
        reason: "subject",
      },
    ]);
  });
});

describe("pickSubentry", () => {
  const subentries = [
    { name: "a", category: "Bludgeoning" },
    { name: "b", category: "Piercing" },
    { name: "c", category: "Bludgeoning" },
  ];

  it("picks uniformly among matching-category sub-entries only", () => {
    const rng = () => 0.99; // last index
    expect(pickSubentry(subentries, "Bludgeoning", rng)).toEqual({
      name: "c",
      category: "Bludgeoning",
    });
    const rngFirst = () => 0;
    expect(pickSubentry(subentries, "Bludgeoning", rngFirst)).toEqual({
      name: "a",
      category: "Bludgeoning",
    });
  });

  it("falls back to the full pool when no sub-entry matches the category", () => {
    const rng = () => 0;
    expect(pickSubentry(subentries, "Slashing", rng)).toEqual(subentries[0]);
  });

  it("returns null for an empty pool", () => {
    expect(pickSubentry([], "Bludgeoning")).toBeNull();
  });
});

describe("hitDeckCategory", () => {
  it("maps the three physical damage types Title-Case", () => {
    expect(hitDeckCategory("bludgeoning")).toBe("Bludgeoning");
    expect(hitDeckCategory("piercing")).toBe("Piercing");
    expect(hitDeckCategory("slashing")).toBe("Slashing");
  });

  it("falls back to 'Bomb or Spell' for anything else, including none at all", () => {
    expect(hitDeckCategory("fire")).toBe("Bomb or Spell");
    expect(hitDeckCategory(null)).toBe("Bomb or Spell");
    expect(hitDeckCategory(undefined)).toBe("Bomb or Spell");
  });
});

describe("fumbleDeckCategory", () => {
  it("Ranged wins when isRanged is true", () => {
    expect(fumbleDeckCategory({ isRanged: true, isUnarmed: true })).toBe(
      "Ranged",
    );
  });

  it("Unarmed when not ranged but unarmed", () => {
    expect(fumbleDeckCategory({ isRanged: false, isUnarmed: true })).toBe(
      "Unarmed",
    );
  });

  it("Melee as the default", () => {
    expect(fumbleDeckCategory({})).toBe("Melee");
    expect(fumbleDeckCategory()).toBe("Melee");
  });
});

describe("drawAndApplyCriticalCard", () => {
  function installFoundryStubs({ docs }) {
    globalThis.foundry = { utils: {} };
    globalThis.ChatMessage = {
      create: async (data) => {
        ChatMessage.calls.push(data);
      },
      calls: [],
    };
    globalThis.game = {
      i18n: { format: (key) => key },
      packs: {
        get: (id) =>
          id === "pf2e.criticaldeck"
            ? { getDocuments: async () => docs }
            : undefined,
      },
    };
    globalThis.Roll = class {
      constructor(formula) {
        this.formula = formula;
      }
      async evaluate() {
        this.total = 4;
        return this;
      }
    };
    // A distinct total (7, vs. plain Roll's 4) and a `calls` log let tests
    // prove which class actually got constructed -- the real bug (#50) was
    // that a persistent-tagged formula silently went through plain Roll
    // instead of this one.
    globalThis.DamageRoll = class DamageRoll {
      constructor(formula) {
        this.formula = formula;
        DamageRoll.calls.push(formula);
      }
      async evaluate() {
        this.total = 7;
        return this;
      }
    };
    globalThis.DamageRoll.calls = [];
    globalThis.CONFIG = { Dice: { rolls: [globalThis.DamageRoll] } };
    globalThis.fromUuid = async (uuid) => {
      globalThis.fromUuid.calls.push(uuid);
      if (uuid.includes("nonexistent")) return null;
      return {
        name: uuid.split(".").pop(),
        toObject: () => ({ name: uuid.split(".").pop(), type: "effect" }),
      };
    };
    globalThis.fromUuid.calls = [];
  }

  function makeDoc(name, html) {
    return { name, pages: [{ text: { content: html } }] };
  }

  function makeActorDouble() {
    const applyDamageCalls = [];
    const increaseConditionCalls = [];
    const createEmbeddedDocumentsCalls = [];
    return {
      applyDamage: async (args) => applyDamageCalls.push(args),
      increaseCondition: async (slug, opts) =>
        increaseConditionCalls.push({ slug, opts }),
      createEmbeddedDocuments: async (type, docsArg) =>
        createEmbeddedDocumentsCalls.push({ type, docsArg }),
      applyDamageCalls,
      increaseConditionCalls,
      createEmbeddedDocumentsCalls,
    };
  }

  it("draws from the Hit deck, applies a target-directed condition, and posts to chat", async () => {
    const docs = [
      makeDoc("Critical Hit Deck #1", HIT_DECK_1),
      makeDoc("Critical Fumble Deck #1", FUMBLE_DECK_1),
    ];
    installFoundryStubs({ docs });

    const combatant = {
      name: "Attacker",
      actor: makeActorDouble(),
      token: { id: "atk-token" },
    };
    const target = {
      name: "Victim",
      actor: makeActorDouble(),
      token: { id: "tgt-token" },
    };

    const result = await drawAndApplyCriticalCard("hit", "Bludgeoning", {
      combatant,
      target,
    });

    expect(result.subentry.name).toBe("Crunch");
    expect(target.actor.increaseConditionCalls).toEqual([
      { slug: "sickened", opts: { value: 3 } },
    ]);
    expect(combatant.actor.increaseConditionCalls).toEqual([]);
    expect(ChatMessage.calls).toHaveLength(1);
    expect(ChatMessage.calls[0].content).toContain("Sickened");
  });

  it("only draws from the requested deck kind (Fumble never pulls a Hit card)", async () => {
    const docs = [
      makeDoc("Critical Hit Deck #1", HIT_DECK_1),
      makeDoc("Critical Fumble Deck #1", FUMBLE_DECK_1),
    ];
    installFoundryStubs({ docs });
    const combatant = { name: "Attacker", actor: makeActorDouble(), token: {} };
    const target = { name: "Victim", actor: makeActorDouble(), token: {} };

    const result = await drawAndApplyCriticalCard("fumble", "Unarmed", {
      combatant,
      target,
    });

    expect([
      "Meant to do That",
      "Misjudged the Distance",
      "Not the Weak Point",
      "How did that Happen?",
    ]).toContain(result.subentry.name);
  });

  it("applies self-directed damage to the combatant's own actor via a rolled formula", async () => {
    const docs = [makeDoc("Critical Fumble Deck #1", FUMBLE_DECK_1)];
    installFoundryStubs({ docs });
    const combatant = {
      name: "Attacker",
      actor: makeActorDouble(),
      token: { id: "atk" },
    };
    const target = {
      name: "Victim",
      actor: makeActorDouble(),
      token: { id: "tgt" },
    };

    await drawAndApplyCriticalCard("fumble", "Unarmed", { combatant, target });

    expect(combatant.actor.applyDamageCalls).toEqual([
      { damage: 4, token: { id: "atk" } },
    ]);
    expect(target.actor.applyDamageCalls).toEqual([]);
  });

  it("applies bracket-tagged persistent @Damage via a real DamageRoll object, not a bare number (Corrosive)", async () => {
    const docs = [makeDoc("Critical Hit Deck #37", HIT_DECK_37)];
    installFoundryStubs({ docs });
    const combatant = { name: "Attacker", actor: makeActorDouble(), token: {} };
    const target = {
      name: "Victim",
      actor: makeActorDouble(),
      token: { id: "tgt" },
    };

    const result = await drawAndApplyCriticalCard("hit", "Bomb or Spell", {
      combatant,
      target,
    });

    expect(result.subentry.name).toBe("Corrosive");
    expect(DamageRoll.calls).toEqual(["1d6[persistent,acid]"]);
    expect(target.actor.applyDamageCalls).toHaveLength(1);
    const [call] = target.actor.applyDamageCalls;
    expect(call.damage).toBeInstanceOf(DamageRoll);
    expect(call.damage.formula).toBe("1d6[persistent,acid]");
    expect(call.damage.total).toBe(7);
    expect(call.token).toEqual({ id: "tgt" });
    expect(combatant.actor.applyDamageCalls).toEqual([]);
  });

  it("applies a @Localize persistent-damage shorthand as a flat-N DamageRoll targeted at the target (Pinhole)", async () => {
    const docs = [makeDoc("Critical Hit Deck #10", HIT_DECK_10)];
    installFoundryStubs({ docs });
    const combatant = { name: "Attacker", actor: makeActorDouble(), token: {} };
    const target = {
      name: "Victim",
      actor: makeActorDouble(),
      token: { id: "tgt" },
    };

    const result = await drawAndApplyCriticalCard("hit", "Piercing", {
      combatant,
      target,
    });

    expect(result.subentry.name).toBe("Pinhole");
    expect(DamageRoll.calls).toEqual(["(1)[persistent,bleed]"]);
    expect(target.actor.applyDamageCalls).toHaveLength(1);
    const [call] = target.actor.applyDamageCalls;
    expect(call.damage).toBeInstanceOf(DamageRoll);
    expect(call.damage.total).toBe(7);
    expect(call.token).toEqual({ id: "tgt" });
    expect(combatant.actor.applyDamageCalls).toEqual([]);
  });

  it("applies a @Localize persistent-damage shorthand as a flat-N DamageRoll targeted at self on a fumble card (Nosebleed)", async () => {
    const docs = [makeDoc("Critical Fumble Deck #11", FUMBLE_DECK_11)];
    installFoundryStubs({ docs });
    const combatant = {
      name: "Attacker",
      actor: makeActorDouble(),
      token: { id: "atk" },
    };
    const target = { name: "Victim", actor: makeActorDouble(), token: {} };

    const result = await drawAndApplyCriticalCard("fumble", "Spell", {
      combatant,
      target,
    });

    expect(result.subentry.name).toBe("Nosebleed");
    expect(DamageRoll.calls).toEqual(["(1)[persistent,bleed]"]);
    expect(combatant.actor.applyDamageCalls).toHaveLength(1);
    const [call] = combatant.actor.applyDamageCalls;
    expect(call.damage).toBeInstanceOf(DamageRoll);
    expect(call.token).toEqual({ id: "atk" });
    expect(target.actor.applyDamageCalls).toEqual([]);
  });

  it("applies a self-directed effect via fromUuid -> toObject -> createEmbeddedDocuments", async () => {
    const docs = [makeDoc("Critical Fumble Deck #10", FUMBLE_DECK_10)];
    installFoundryStubs({ docs });
    const combatant = { name: "Attacker", actor: makeActorDouble(), token: {} };
    const target = { name: "Victim", actor: makeActorDouble(), token: {} };

    await drawAndApplyCriticalCard("fumble", "Melee", { combatant, target });

    expect(combatant.actor.createEmbeddedDocumentsCalls).toHaveLength(1);
    expect(combatant.actor.createEmbeddedDocumentsCalls[0].type).toBe("Item");
    expect(target.actor.createEmbeddedDocumentsCalls).toEqual([]);
  });

  it("a target-directed effect on a fumble card applies to the target actor, not the attacker", async () => {
    const docs = [makeDoc("Critical Fumble Deck #2", FUMBLE_DECK_2)];
    installFoundryStubs({ docs });
    const combatant = { name: "Attacker", actor: makeActorDouble(), token: {} };
    const target = { name: "Victim", actor: makeActorDouble(), token: {} };

    await drawAndApplyCriticalCard("fumble", "Unarmed", { combatant, target });

    // Whichever of the 4 sub-entries got drawn, only "Overthink It" (Unarmed)
    // would create an embedded doc on the TARGET -- assert the invariant
    // rather than which card was drawn, since the pool for Unarmed has
    // exactly one match here.
    expect(target.actor.createEmbeddedDocumentsCalls).toHaveLength(1);
    expect(combatant.actor.createEmbeddedDocumentsCalls).toEqual([]);
  });

  it("posts the full effect text to chat even for a card with no auto-applicable directives", async () => {
    const docs = [makeDoc("Critical Hit Deck #10", HIT_DECK_10)];
    installFoundryStubs({ docs });
    const combatant = { name: "Attacker", actor: makeActorDouble(), token: {} };
    const target = { name: "Victim", actor: makeActorDouble(), token: {} };

    const result = await drawAndApplyCriticalCard("hit", "Slashing", {
      combatant,
      target,
    });

    expect(result.subentry.name).toBe("Disembowel");
    expect(ChatMessage.calls).toHaveLength(1);
    expect(ChatMessage.calls[0].content).toContain("Triple damage.");
    expect(result.applied).toEqual([]);
  });

  it("returns null and posts nothing when the pf2e.criticaldeck pack isn't available", async () => {
    installFoundryStubs({ docs: [] });
    globalThis.game.packs.get = () => undefined;
    const combatant = { name: "Attacker", actor: makeActorDouble(), token: {} };
    const target = { name: "Victim", actor: makeActorDouble(), token: {} };

    const result = await drawAndApplyCriticalCard("hit", "Bludgeoning", {
      combatant,
      target,
    });

    expect(result).toBeNull();
    expect(ChatMessage.calls).toHaveLength(0);
  });
});
