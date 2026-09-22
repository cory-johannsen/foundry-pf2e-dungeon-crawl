import { describe, it, expect } from "vitest";
import {
  extractRiderEffects,
  extractCriticalSpecializationNote,
  postStrikeRiderReminder,
  postCriticalSpecializationReminder,
  resolveGrabRider,
  resolveKnockdownRider,
} from "../scripts/dungeon-strike-riders.mjs";

// Fixtures pulled from the local bestiary mirror
// (/home/cjohannsen/pf2e-data/packs/pf2e), trimmed to the fields our own
// code reads. Real shapes matter here: a monster's synthetic strike item
// often has no `system.slug` at all (confirmed on draconic-fumecrux's own
// "Jaws" melee item, which is null), while its "Grab" action item does carry
// a real slug. caustic-wolf's "Jaws" strike is the opposite case -- the
// strike item itself has a slug too -- included so the rider lookup is
// proven not to accidentally key off the STRIKE's own slug instead of the
// attackEffects entries.

function fumecruxJawsStrike() {
  return {
    type: "strike",
    label: "Jaws",
    item: {
      name: "Jaws",
      type: "melee",
      system: {
        slug: null,
        attackEffects: { value: ["grab"] },
      },
    },
  };
}

function fumecruxActorItems() {
  return [
    {
      name: "Frightful Presence",
      type: "action",
      system: { slug: "frightful-presence" },
    },
    {
      name: "Grab",
      type: "action",
      system: {
        slug: "grab",
        description: {
          value: "<p>@Localize[PF2E.NPC.Abilities.Glossary.Grab]</p>",
        },
      },
    },
    {
      name: "Swallow Whole",
      type: "action",
      system: { slug: "swallow-whole" },
    },
  ];
}

function causticWolfJawsStrike() {
  return {
    type: "strike",
    label: "Jaws",
    item: {
      name: "Jaws",
      type: "melee",
      system: {
        slug: "jaws",
        attackEffects: { value: ["knockdown"] },
      },
    },
  };
}

function causticWolfActorItems() {
  return [
    { name: "Acid Breath", type: "action", system: { slug: null } },
    { name: "Howl", type: "action", system: { slug: null } },
    {
      name: "Knockdown",
      type: "action",
      system: {
        slug: "knockdown",
        description: {
          value: "<p>@Localize[PF2E.NPC.Abilities.Glossary.Knockdown]</p>",
        },
      },
    },
  ];
}

// blooming-guardian.json (howl-of-the-wild-bestiary): the Hooves strike
// carries attackEffects ["improved-knockdown"], but the actor has no
// separate "Improved Knockdown" ability item -- improved-knockdown is a
// trait/upgrade folded into the base Knockdown glossary text, not its own
// item, on this real stat block. Confirmed against the live JSON mirror.
function bloomingGuardianHoovesStrike() {
  return {
    type: "strike",
    label: "Hooves",
    item: {
      name: "Hooves",
      type: "melee",
      system: {
        slug: "hooves",
        attackEffects: { value: ["improved-knockdown"] },
      },
    },
  };
}

function bloomingGuardianActorItems() {
  return [
    { name: "Petal Form", type: "action", system: { slug: "petal-form" } },
    { name: "Buck", type: "action", system: { slug: "buck" } },
  ];
}

describe("extractRiderEffects", () => {
  it("matches a rider slug to its ability item by system.slug (draconic-fumecrux Jaws -> grab)", () => {
    const result = extractRiderEffects(
      fumecruxJawsStrike(),
      fumecruxActorItems(),
    );
    expect(result).toEqual([
      {
        slug: "grab",
        found: true,
        name: "Grab",
        description: "<p>@Localize[PF2E.NPC.Abilities.Glossary.Grab]</p>",
      },
    ]);
  });

  it("matches a rider slug when the strike item itself also has a slug (caustic-wolf Jaws -> knockdown)", () => {
    const result = extractRiderEffects(
      causticWolfJawsStrike(),
      causticWolfActorItems(),
    );
    expect(result).toEqual([
      {
        slug: "knockdown",
        found: true,
        name: "Knockdown",
        description: "<p>@Localize[PF2E.NPC.Abilities.Glossary.Knockdown]</p>",
      },
    ]);
  });

  it("reports an unmatched slug by name alone (blooming-guardian Hooves -> improved-knockdown)", () => {
    const result = extractRiderEffects(
      bloomingGuardianHoovesStrike(),
      bloomingGuardianActorItems(),
    );
    expect(result).toEqual([{ slug: "improved-knockdown", found: false }]);
  });

  it("falls back to a slugified item name when an ability item has no system.slug", () => {
    const strike = {
      item: {
        type: "melee",
        system: { attackEffects: { value: ["push"] } },
      },
    };
    const actorItems = [
      { name: "Push", type: "action", system: { slug: null } },
    ];
    expect(extractRiderEffects(strike, actorItems)).toEqual([
      { slug: "push", found: true, name: "Push", description: null },
    ]);
  });

  it("never matches the strike's own melee item, even if its slug happens to equal a rider slug", () => {
    const strike = {
      item: {
        type: "melee",
        system: { slug: "grab", attackEffects: { value: ["grab"] } },
      },
    };
    // No separate "Grab" action item exists on this actor -- only the
    // strike (melee-type) item itself shares the slug, which must not count
    // as a match (PF2e's own getAttackEffects excludes type === "melee" for
    // exactly this reason).
    const actorItems = [strike.item];
    expect(extractRiderEffects(strike, actorItems)).toEqual([
      { slug: "grab", found: false },
    ]);
  });

  it("returns an empty array when the strike carries no attackEffects", () => {
    const strike = { item: { type: "melee", system: {} } };
    expect(extractRiderEffects(strike, [])).toEqual([]);
  });

  it("returns an empty array when the strike item is missing entirely", () => {
    expect(extractRiderEffects({}, [])).toEqual([]);
  });

  it("handles multiple rider slugs on one strike", () => {
    const strike = {
      item: {
        type: "melee",
        system: { attackEffects: { value: ["grab", "drain-life"] } },
      },
    };
    const actorItems = [
      { name: "Grab", type: "action", system: { slug: "grab" } },
    ];
    expect(extractRiderEffects(strike, actorItems)).toEqual([
      { slug: "grab", found: true, name: "Grab", description: null },
      { slug: "drain-life", found: false },
    ]);
  });
});

describe("extractCriticalSpecializationNote", () => {
  it("finds the critical-specialization note PF2e's own CritSpecRuleElement attaches to the damage message", () => {
    // Shape confirmed against /srv/foundry/data/Data/systems/pf2e/pf2e.mjs:
    // CritSpecRuleElement#getEffect builds a RollNotePF2e (title
    // "PF2E.Actor.Creature.CriticalSpecialization", selector
    // "strike-damage", outcome ["criticalSuccess"]) that ends up in the
    // DAMAGE roll ChatMessage's flags.pf2e.context.notes (via
    // WeaponDamagePF2e.calculate), NOT the attack-roll message -- confirmed
    // by tracing both code paths directly, since extractNotes()/getAttackEffects()
    // (which do feed the attack-roll message's own notes) never read
    // actor.synthetics.criticalSpecializations at all.
    const messageData = {
      flags: {
        pf2e: {
          context: {
            type: "damage-roll",
            outcome: "criticalSuccess",
            notes: [
              {
                selector: "strike-damage",
                title: "PF2E.Actor.Creature.CriticalSpecialization",
                text: "PF2E.Item.Weapon.CriticalSpecialization.sword",
                outcome: ["criticalSuccess"],
                visibility: null,
              },
            ],
          },
        },
      },
    };
    expect(extractCriticalSpecializationNote(messageData)).toEqual({
      title: "PF2E.Actor.Creature.CriticalSpecialization",
      text: "PF2E.Item.Weapon.CriticalSpecialization.sword",
    });
  });

  it("returns null when the message has other notes but no critical-specialization one", () => {
    const messageData = {
      flags: {
        pf2e: {
          context: {
            notes: [
              { selector: "strike-damage", title: "Something Else", text: "x" },
            ],
          },
        },
      },
    };
    expect(extractCriticalSpecializationNote(messageData)).toBeNull();
  });

  it("returns null when there are no notes at all", () => {
    expect(extractCriticalSpecializationNote({})).toBeNull();
    expect(
      extractCriticalSpecializationNote({ flags: { pf2e: { context: {} } } }),
    ).toBeNull();
  });

  it("returns null when messageData itself is missing", () => {
    expect(extractCriticalSpecializationNote(undefined)).toBeNull();
    expect(extractCriticalSpecializationNote(null)).toBeNull();
  });
});

function installFoundryStubs() {
  globalThis.foundry = { utils: {} };
  globalThis.ChatMessage = {
    create: async (data) => {
      ChatMessage.calls.push(data);
    },
    calls: [],
    getWhisperRecipients: () => [{ id: "gm1" }],
  };
  globalThis.game = {
    i18n: {
      format: (key, data) => JSON.stringify({ key, data }),
      localize: (key) => key,
    },
    messages: { contents: [] },
  };
}

describe("postStrikeRiderReminder", () => {
  it("does nothing when the outcome is a miss", async () => {
    installFoundryStubs();
    const combatant = {
      name: "Fumecrux",
      actor: { items: fumecruxActorItems() },
    };
    await postStrikeRiderReminder(combatant, fumecruxJawsStrike(), "failure");
    expect(ChatMessage.calls).toHaveLength(0);
  });

  it("does nothing when the strike carries no rider effects", async () => {
    installFoundryStubs();
    const combatant = { name: "Fumecrux", actor: { items: [] } };
    const strike = { item: { type: "melee", system: {} } };
    await postStrikeRiderReminder(combatant, strike, "success");
    expect(ChatMessage.calls).toHaveLength(0);
  });

  it("posts a GM-whispered reminder for a matched rider effect on a hit", async () => {
    installFoundryStubs();
    const combatant = {
      name: "Pusher",
      actor: {
        items: [
          { name: "Push", type: "action", system: { slug: "push" } },
        ],
      },
    };
    const strike = {
      item: { type: "melee", system: { attackEffects: { value: ["push"] } } },
    };
    await postStrikeRiderReminder(combatant, strike, "success");
    expect(ChatMessage.calls).toHaveLength(1);
    expect(ChatMessage.calls[0].whisper).toEqual(["gm1"]);
    expect(ChatMessage.calls[0].content).toContain("Push");
  });

  it("excludes grab/improved-grab/tongue-grab riders (#51's resolveGrabRider whispers its own real result instead)", async () => {
    installFoundryStubs();
    const combatant = {
      name: "Fumecrux",
      actor: { items: fumecruxActorItems() },
    };
    await postStrikeRiderReminder(combatant, fumecruxJawsStrike(), "success");
    expect(ChatMessage.calls).toHaveLength(0);
  });

  it("excludes knockdown/improved-knockdown riders (#51's resolveKnockdownRider whispers its own real result instead)", async () => {
    installFoundryStubs();
    const combatant = {
      name: "Caustic Wolf",
      actor: { items: causticWolfActorItems() },
    };
    await postStrikeRiderReminder(
      combatant,
      causticWolfJawsStrike(),
      "success",
    );
    expect(ChatMessage.calls).toHaveLength(0);
  });

  it("posts a GM-whispered reminder for an unmatched rider slug on a critical hit, naming the slug", async () => {
    installFoundryStubs();
    const combatant = { name: "Something Awful", actor: { items: [] } };
    const strike = {
      item: {
        type: "melee",
        system: { attackEffects: { value: ["drain-life"] } },
      },
    };
    await postStrikeRiderReminder(combatant, strike, "criticalSuccess");
    expect(ChatMessage.calls).toHaveLength(1);
    expect(ChatMessage.calls[0].content).toContain("drain-life");
  });
});

// Draconic fumecrux's own "Grab" -- see fumecruxJawsStrike/fumecruxActorItems
// above. improvedGrabStrike/tongueGrabStrike are synthetic variants of the
// same shape, just with the other two grab-family slugs, to prove all three
// trigger resolution.
function improvedGrabStrike() {
  return {
    item: {
      type: "melee",
      system: { attackEffects: { value: ["improved-grab"] } },
    },
  };
}

function tongueGrabStrike() {
  return {
    item: {
      type: "melee",
      system: { attackEffects: { value: ["tongue-grab"] } },
    },
  };
}

function makeAttacker({ hasAthletics = true } = {}) {
  return {
    name: "Fumecrux",
    actor: {
      items: fumecruxActorItems(),
      skills: hasAthletics
        ? {
            athletics: {
              roll: async ({ dc }) => {
                game.messages.contents.push({
                  flags: {
                    pf2e: { context: { outcome: game.__nextGrappleOutcome, dc } },
                  },
                });
              },
            },
          }
        : {},
    },
  };
}

function makeTarget({
  hasFortitude = true,
  fortitudeDc = 18,
  hasReflex = true,
  reflexDc = 18,
} = {}) {
  const increaseConditionCalls = [];
  const saves = {};
  if (hasFortitude) saves.fortitude = { dc: { value: fortitudeDc } };
  if (hasReflex) saves.reflex = { dc: { value: reflexDc } };
  return {
    actor: {
      saves,
      increaseCondition: async (slug, opts) => {
        increaseConditionCalls.push({ slug, opts });
      },
    },
    increaseConditionCalls,
  };
}

describe("resolveGrabRider", () => {
  it("does nothing when the attack outcome itself is a miss", async () => {
    installFoundryStubs();
    const attacker = makeAttacker();
    const target = makeTarget();
    const result = await resolveGrabRider(
      attacker,
      target,
      fumecruxJawsStrike(),
      "failure",
    );
    expect(result).toBeNull();
    expect(target.increaseConditionCalls).toHaveLength(0);
    expect(ChatMessage.calls).toHaveLength(0);
  });

  it("does nothing when the strike carries no grab-family rider", async () => {
    installFoundryStubs();
    const attacker = makeAttacker();
    const target = makeTarget();
    const strike = {
      item: { type: "melee", system: { attackEffects: { value: ["knockdown"] } } },
    };
    const result = await resolveGrabRider(attacker, target, strike, "success");
    expect(result).toBeNull();
    expect(target.increaseConditionCalls).toHaveLength(0);
  });

  it.each([
    ["grab", fumecruxJawsStrike()],
    ["improved-grab", improvedGrabStrike()],
    ["tongue-grab", tongueGrabStrike()],
  ])(
    "rolls Athletics vs. the target's Fortitude DC and applies Grabbed on a successful %s",
    async (_slug, strike) => {
      installFoundryStubs();
      game.__nextGrappleOutcome = "success";
      const attacker = makeAttacker();
      const target = makeTarget({ fortitudeDc: 21 });

      const result = await resolveGrabRider(attacker, target, strike, "success");

      expect(result).toBe("success");
      expect(target.increaseConditionCalls).toEqual([
        { slug: "grabbed", opts: undefined },
      ]);
      const dcRoll = game.messages.contents.at(-1);
      expect(dcRoll.flags.pf2e.context.dc).toEqual({ value: 21 });
      expect(ChatMessage.calls).toHaveLength(1);
      expect(ChatMessage.calls[0].content).toContain("Grabbed");
    },
  );

  it("does not apply Grabbed when the Athletics check fails", async () => {
    installFoundryStubs();
    game.__nextGrappleOutcome = "failure";
    const attacker = makeAttacker();
    const target = makeTarget();

    const result = await resolveGrabRider(
      attacker,
      target,
      fumecruxJawsStrike(),
      "success",
    );

    expect(result).toBe("failure");
    expect(target.increaseConditionCalls).toHaveLength(0);
    expect(ChatMessage.calls).toHaveLength(1);
    expect(ChatMessage.calls[0].content).toContain("check failed");
  });

  it("no-ops when the attacker has no Athletics statistic", async () => {
    installFoundryStubs();
    const attacker = makeAttacker({ hasAthletics: false });
    const target = makeTarget();

    const result = await resolveGrabRider(
      attacker,
      target,
      fumecruxJawsStrike(),
      "success",
    );

    expect(result).toBeNull();
    expect(target.increaseConditionCalls).toHaveLength(0);
    expect(ChatMessage.calls).toHaveLength(0);
  });

  it("no-ops when the target has no Fortitude save", async () => {
    installFoundryStubs();
    const attacker = makeAttacker();
    const target = makeTarget({ hasFortitude: false });

    const result = await resolveGrabRider(
      attacker,
      target,
      fumecruxJawsStrike(),
      "success",
    );

    expect(result).toBeNull();
    expect(target.increaseConditionCalls).toHaveLength(0);
    expect(ChatMessage.calls).toHaveLength(0);
  });
});

// Synthetic improved-knockdown variant, same shape as improvedGrabStrike/
// tongueGrabStrike above -- caustic-wolf's own Jaws strike (imported via
// causticWolfJawsStrike/causticWolfActorItems) already covers the base
// "knockdown" slug with a real matched ability item.
function improvedKnockdownStrike() {
  return {
    item: {
      type: "melee",
      system: { attackEffects: { value: ["improved-knockdown"] } },
    },
  };
}

function makeKnockdownAttacker({ hasAthletics = true } = {}) {
  return {
    name: "Caustic Wolf",
    actor: {
      items: causticWolfActorItems(),
      skills: hasAthletics
        ? {
            athletics: {
              roll: async ({ dc }) => {
                game.messages.contents.push({
                  flags: {
                    pf2e: { context: { outcome: game.__nextGrappleOutcome, dc } },
                  },
                });
              },
            },
          }
        : {},
    },
  };
}

describe("resolveKnockdownRider", () => {
  it("does nothing when the attack outcome itself is a miss", async () => {
    installFoundryStubs();
    const attacker = makeKnockdownAttacker();
    const target = makeTarget();
    const result = await resolveKnockdownRider(
      attacker,
      target,
      causticWolfJawsStrike(),
      "failure",
    );
    expect(result).toBeNull();
    expect(target.increaseConditionCalls).toHaveLength(0);
    expect(ChatMessage.calls).toHaveLength(0);
  });

  it("does nothing when the strike carries no knockdown-family rider", async () => {
    installFoundryStubs();
    const attacker = makeKnockdownAttacker();
    const target = makeTarget();
    const result = await resolveKnockdownRider(
      attacker,
      target,
      fumecruxJawsStrike(),
      "success",
    );
    expect(result).toBeNull();
    expect(target.increaseConditionCalls).toHaveLength(0);
  });

  it.each([
    ["knockdown", causticWolfJawsStrike()],
    ["improved-knockdown", improvedKnockdownStrike()],
  ])(
    "rolls Athletics vs. the target's Reflex DC and applies Prone on a successful %s",
    async (_slug, strike) => {
      installFoundryStubs();
      game.__nextGrappleOutcome = "success";
      const attacker = makeKnockdownAttacker();
      const target = makeTarget({ reflexDc: 19 });

      const result = await resolveKnockdownRider(
        attacker,
        target,
        strike,
        "success",
      );

      expect(result).toBe("success");
      expect(target.increaseConditionCalls).toEqual([
        { slug: "prone", opts: undefined },
      ]);
      const dcRoll = game.messages.contents.at(-1);
      expect(dcRoll.flags.pf2e.context.dc).toEqual({ value: 19 });
      expect(ChatMessage.calls).toHaveLength(1);
      expect(ChatMessage.calls[0].content).toContain("Prone");
    },
  );

  it("does not apply Prone when the Athletics check fails", async () => {
    installFoundryStubs();
    game.__nextGrappleOutcome = "failure";
    const attacker = makeKnockdownAttacker();
    const target = makeTarget();

    const result = await resolveKnockdownRider(
      attacker,
      target,
      causticWolfJawsStrike(),
      "success",
    );

    expect(result).toBe("failure");
    expect(target.increaseConditionCalls).toHaveLength(0);
    expect(ChatMessage.calls).toHaveLength(1);
    expect(ChatMessage.calls[0].content).toContain("check failed");
  });

  it("no-ops when the attacker has no Athletics statistic", async () => {
    installFoundryStubs();
    const attacker = makeKnockdownAttacker({ hasAthletics: false });
    const target = makeTarget();

    const result = await resolveKnockdownRider(
      attacker,
      target,
      causticWolfJawsStrike(),
      "success",
    );

    expect(result).toBeNull();
    expect(target.increaseConditionCalls).toHaveLength(0);
    expect(ChatMessage.calls).toHaveLength(0);
  });

  it("no-ops when the target has no Reflex save", async () => {
    installFoundryStubs();
    const attacker = makeKnockdownAttacker();
    const target = makeTarget({ hasReflex: false });

    const result = await resolveKnockdownRider(
      attacker,
      target,
      causticWolfJawsStrike(),
      "success",
    );

    expect(result).toBeNull();
    expect(target.increaseConditionCalls).toHaveLength(0);
    expect(ChatMessage.calls).toHaveLength(0);
  });
});

describe("postCriticalSpecializationReminder", () => {
  it("does nothing when the outcome is a regular success, not a critical", async () => {
    installFoundryStubs();
    game.messages.contents.push({
      flags: {
        pf2e: {
          context: {
            notes: [
              {
                title: "PF2E.Actor.Creature.CriticalSpecialization",
                text: "PF2E.Item.Weapon.CriticalSpecialization.sword",
              },
            ],
          },
        },
      },
    });
    await postCriticalSpecializationReminder({ name: "Attacker" }, "success");
    expect(ChatMessage.calls).toHaveLength(0);
  });

  it("does nothing on a critical hit when the last message carries no critical-specialization note", async () => {
    installFoundryStubs();
    game.messages.contents.push({
      flags: { pf2e: { context: { notes: [] } } },
    });
    await postCriticalSpecializationReminder(
      { name: "Attacker" },
      "criticalSuccess",
    );
    expect(ChatMessage.calls).toHaveLength(0);
  });

  it("re-posts PF2e's own critical-specialization note as a GM-whispered reminder on a critical hit", async () => {
    installFoundryStubs();
    game.messages.contents.push({
      flags: {
        pf2e: {
          context: {
            notes: [
              {
                title: "PF2E.Actor.Creature.CriticalSpecialization",
                text: "PF2E.Item.Weapon.CriticalSpecialization.sword",
              },
            ],
          },
        },
      },
    });
    await postCriticalSpecializationReminder(
      { name: "Attacker" },
      "criticalSuccess",
    );
    expect(ChatMessage.calls).toHaveLength(1);
    expect(ChatMessage.calls[0].whisper).toEqual(["gm1"]);
  });

  it("reads a caller-supplied message instead of game.messages when given one explicitly", async () => {
    installFoundryStubs();
    const explicitMessage = {
      flags: {
        pf2e: {
          context: {
            notes: [
              {
                title: "PF2E.Actor.Creature.CriticalSpecialization",
                text: "PF2E.Item.Weapon.CriticalSpecialization.axe",
              },
            ],
          },
        },
      },
    };
    await postCriticalSpecializationReminder(
      { name: "Attacker" },
      "criticalSuccess",
      explicitMessage,
    );
    expect(ChatMessage.calls).toHaveLength(1);
  });
});
