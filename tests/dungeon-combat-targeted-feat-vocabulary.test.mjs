import { readFileSync } from "node:fs";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { computeTargetedSelfEffectVocabularyEntries, getPendingAgentTurn } from "../scripts/dungeon-combat.mjs";

// #922: the targeted self-effect vocabulary (Hunt Prey, Devise a
// Stratagem). Item/effect shapes copied from the live compendium
// (pf2e.actionspf2e / pf2e.feat-effects, pf2e 8.5.0).

const HUNT_PREY_EFFECT = "Compendium.pf2e.feat-effects.Item.MeXyXqWY9qN42bSQ";
const DEVISE_EFFECT = "Compendium.pf2e.feat-effects.Item.XQpTyjXFYYNexyOk";

function effectDoc(slug, rules) {
  return { slug, system: { rules }, toObject: () => ({ name: slug, type: "effect", system: { slug, rules: structuredClone(rules) } }) };
}
const EFFECTS = {
  [HUNT_PREY_EFFECT]: effectDoc("effect-hunt-prey", [{ key: "TokenMark", slug: "hunted-prey" }]),
  [DEVISE_EFFECT]: effectDoc("effect-devise-a-stratagem", [
    { key: "TokenMark", slug: "devise-a-stratagem" },
    { key: "RollOption", option: "devise-a-stratagem", toggleable: true, alwaysActive: true, suboptions: [{ value: "attack" }, { value: "skill" }] },
  ]),
};

function huntPrey(overrides = {}) {
  return {
    id: "hp1",
    uuid: "Actor.atk.Item.hp1",
    slug: "hunt-prey",
    name: "Hunt Prey",
    type: "action",
    system: {
      actionType: { value: "action" },
      actions: { value: 1 },
      frequency: null,
      selfEffect: { uuid: HUNT_PREY_EFFECT, name: "Effect: Hunt Prey" },
      traits: { value: ["concentrate", "ranger"] },
      rules: [],
    },
    flags: { pf2e: { rulesSelections: {} } },
    ...overrides,
  };
}

function devise({ frequencyValue = 1 } = {}) {
  return {
    id: "ds1",
    uuid: "Actor.atk.Item.ds1",
    slug: "devise-a-stratagem",
    name: "Devise a Stratagem",
    type: "action",
    system: {
      actionType: { value: "action" },
      actions: { value: 1 },
      frequency: { max: 1, per: "round", value: frequencyValue },
      selfEffect: { uuid: DEVISE_EFFECT, name: "Effect: Devise a Stratagem" },
      traits: { value: ["concentrate", "investigator"] },
      rules: [],
    },
    flags: { pf2e: { rulesSelections: {} } },
  };
}

function strike(traits = ["finesse"], range = null) {
  return { type: "strike", ready: true, label: "Rapier", item: { slug: "rapier", type: "weapon", system: { range, traits: { value: traits } } } };
}

function actor({ action = [], effect = [], strikes = [strike()], tokens = 1, type = "character" } = {}) {
  return {
    type,
    itemTypes: { action, feat: [], effect },
    getActiveTokens: () => Array.from({ length: tokens }, () => ({})),
    system: { actions: strikes },
  };
}

const goblin = { id: "opp1", name: "Goblin", hasLineOfSight: true, tokenUuid: "Scene.s.Token.opp1" };
const orc = { id: "opp2", name: "Orc", hasLineOfSight: false, tokenUuid: "Scene.s.Token.opp2" };

beforeEach(() => {
  globalThis.fromUuid = vi.fn(async (uuid) => EFFECTS[uuid] ?? null);
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("computeTargetedSelfEffectVocabularyEntries (#922)", () => {
  it("offers Hunt Prey against every targetable opponent, seen or only heard", async () => {
    const entries = await computeTargetedSelfEffectVocabularyEntries(actor({ action: [huntPrey()] }), [goblin, orc], 3);
    expect(entries).toEqual([
      { itemId: "hp1", slug: "hunt-prey", name: "Hunt Prey", cost: 1, targetId: "opp1", traits: [], effectSummary: "mark prey: +bonuses vs Goblin" },
      { itemId: "hp1", slug: "hunt-prey", name: "Hunt Prey", cost: 1, targetId: "opp2", traits: [], effectSummary: "mark prey: +bonuses vs Orc" },
    ]);
  });

  it("re-designation: excludes only the creature already marked as prey", async () => {
    const marked = { slug: "effect-hunt-prey", system: { rules: [{ key: "TokenMark", slug: "hunted-prey", uuid: "Scene.s.Token.opp1" }] } };
    const entries = await computeTargetedSelfEffectVocabularyEntries(actor({ action: [huntPrey()], effect: [marked] }), [goblin, orc], 3);
    expect(entries.map((e) => e.targetId)).toEqual(["opp2"]);
  });

  it("offers Devise a Stratagem only against a creature in line of sight", async () => {
    const entries = await computeTargetedSelfEffectVocabularyEntries(actor({ action: [devise()] }), [goblin, orc], 3);
    expect(entries).toEqual([
      { itemId: "ds1", slug: "devise-a-stratagem", name: "Devise a Stratagem", cost: 1, targetId: "opp1", traits: [], effectSummary: "d20 replaces next Strike vs Goblin" },
    ]);
  });

  it("does not offer Devise a Stratagem while its effect is active (any target)", async () => {
    const active = { slug: "effect-devise-a-stratagem", system: { rules: [{ key: "TokenMark", slug: "devise-a-stratagem", uuid: "Scene.s.Token.other" }] } };
    expect(await computeTargetedSelfEffectVocabularyEntries(actor({ action: [devise()], effect: [active] }), [goblin], 3)).toEqual([]);
  });

  it("does not offer Devise a Stratagem once its 1/round frequency is spent", async () => {
    expect(await computeTargetedSelfEffectVocabularyEntries(actor({ action: [devise({ frequencyValue: 0 })] }), [goblin], 3)).toEqual([]);
  });

  it("offers Devise a Stratagem only with a Strike its d20 can replace (agile/finesse, or ranged non-thrown)", async () => {
    const longsword = strike([]);
    expect(await computeTargetedSelfEffectVocabularyEntries(actor({ action: [devise()], strikes: [longsword] }), [goblin], 3)).toEqual([]);
    const javelin = strike(["thrown-30"], 30);
    expect(await computeTargetedSelfEffectVocabularyEntries(actor({ action: [devise()], strikes: [javelin] }), [goblin], 3)).toEqual([]);
    const shortbow = strike(["deadly-d10"], 60);
    expect(await computeTargetedSelfEffectVocabularyEntries(actor({ action: [devise()], strikes: [shortbow] }), [goblin], 3)).toHaveLength(1);
    const dagger = strike(["agile", "thrown-10"]);
    expect(await computeTargetedSelfEffectVocabularyEntries(actor({ action: [devise()], strikes: [dagger] }), [goblin], 3)).toHaveLength(1);
  });

  it("excludes an item outside the allowlist, and one whose cost exceeds the actions left", async () => {
    const other = huntPrey({ id: "x", slug: "harsh-judgement", name: "Harsh Judgement" });
    expect(await computeTargetedSelfEffectVocabularyEntries(actor({ action: [other] }), [goblin], 3)).toEqual([]);
    expect(await computeTargetedSelfEffectVocabularyEntries(actor({ action: [huntPrey()] }), [goblin], 0)).toEqual([]);
  });

  it("excludes an actor with no token on the viewed canvas (the system would ignore the TokenMark)", async () => {
    expect(await computeTargetedSelfEffectVocabularyEntries(actor({ action: [huntPrey()], tokens: 0 }), [goblin], 3)).toEqual([]);
  });

  it("excludes NPC actors (character actors only, like #910's self-effects)", async () => {
    expect(await computeTargetedSelfEffectVocabularyEntries(actor({ action: [huntPrey()], type: "npc" }), [goblin], 3)).toEqual([]);
  });

  it("excludes the item when its linked effect has no matching TokenMark rule, or doesn't resolve", async () => {
    globalThis.fromUuid = vi.fn(async () => effectDoc("effect-hunt-prey", [{ key: "RollOption", option: "x" }]));
    expect(await computeTargetedSelfEffectVocabularyEntries(actor({ action: [huntPrey()] }), [goblin], 3)).toEqual([]);
    globalThis.fromUuid = vi.fn(async () => null);
    expect(await computeTargetedSelfEffectVocabularyEntries(actor({ action: [huntPrey()] }), [goblin], 3)).toEqual([]);
  });

  it("excludes an opponent whose token uuid is unknown", async () => {
    expect(await computeTargetedSelfEffectVocabularyEntries(actor({ action: [huntPrey()] }), [{ ...goblin, tokenUuid: null }], 3)).toEqual([]);
  });

  it("does not offer these concentrate actions while raging", async () => {
    const rage = { slug: "effect-rage", system: { rules: [] } };
    expect(await computeTargetedSelfEffectVocabularyEntries(actor({ action: [huntPrey()], effect: [rage] }), [goblin], 3)).toEqual([]);
  });
});

// --- getPendingAgentTurn wiring -------------------------------------------

const G = 100;

function mk(id, gx, gy, disposition, { type = "npc", action = [], strikes = [] } = {}) {
  const flags = { agentControlled: true };
  return {
    id,
    name: id,
    isDefeated: false,
    token: { x: gx * G, y: gy * G, disposition, width: 1, height: 1, uuid: `Scene.s.Token.${id}` },
    getFlag: (_m, k) => flags[k],
    actor: {
      type,
      conditions: [],
      items: [],
      skills: {},
      itemTypes: { weapon: [], action, feat: [], effect: [] },
      getActiveTokens: () => [{}],
      attributes: { immunities: [] },
      system: {
        actions: strikes,
        traits: { size: { value: "med" } },
        attributes: { hp: { value: 20, max: 20 } },
        movement: { speeds: { land: { value: 30 } } },
      },
    },
  };
}

function mkCombat(combatants, current, turnState = null) {
  const flags = { dungeonSlot: "slot-1", reactionUsed: {} };
  if (turnState) flags.agentTurnState = turnState;
  return {
    id: "c1",
    round: 1,
    turn: 0,
    combatant: current,
    combatants,
    getFlag: (_m, k) => flags[k],
    setFlag: async (_m, k, v) => {
      flags[k] = v;
    },
    scene: { id: "s", grid: { size: G, distance: 5 }, width: 10 * G, height: 3 * G, tokens: [], walls: { contents: [] }, regions: [] },
  };
}

describe("getPendingAgentTurn targeted self-effect vocabulary (#922)", () => {
  beforeEach(() => {
    globalThis.CONST = {
      WALL_MOVEMENT_TYPES: { NONE: 0, NORMAL: 20 },
      WALL_DOOR_TYPES: { NONE: 0, DOOR: 1, SECRET: 2 },
      WALL_DOOR_STATES: { CLOSED: 0, OPEN: 1, LOCKED: 2 },
    };
    globalThis.foundry = { utils: {} };
    globalThis.ChatMessage = { create: async () => {}, getWhisperRecipients: () => [] };
    globalThis.game = {
      user: { isGM: true, flags: { pf2e: { settings: {} } }, update: async () => {} },
      i18n: { format: (k) => k },
      messages: { contents: [] },
      combats: { contents: [], has: () => false },
      modules: { get: () => ({ version: "0" }) },
      time: { worldTime: 1000 },
    };
    vi.spyOn(console, "debug").mockImplementation(() => {});
  });

  it("puts a Hunt Prey entry per opponent into featVocabulary, using the opponent's token uuid", async () => {
    const me = mk("atk", 0, 0, -1, { type: "character", action: [huntPrey()] });
    const opp = mk("opp1", 2, 0, 1);
    const pending = await getPendingAgentTurn(mkCombat([me, opp], me));
    expect(pending.featVocabulary).toEqual([
      { type: "feat", kind: "targetedSelfEffect", itemId: "hp1", slug: "hunt-prey", name: "Hunt Prey", cost: 1, targetId: "opp1", traits: [], effectSummary: "mark prey: +bonuses vs opp1" },
    ]);
  });

  it("turns a persisted Hunt Prey pick into a feat:<itemId>:<targetId> candidate", async () => {
    const me = mk("atk", 0, 0, -1, { type: "character", action: [huntPrey()] });
    const opp = mk("opp1", 2, 0, 1);
    const combat = mkCombat([me, opp], me, {
      combatantId: "atk", round: 1, turn: 0, actionsRemaining: 3, mapIncrement: 0,
      maneuverPicks: [{ type: "feat", slug: "hunt-prey", targetId: "opp1", rationale: "r" }], counter: 1,
    });
    const pending = await getPendingAgentTurn(combat);
    expect(pending.candidates.filter((c) => c.type === "feat")).toEqual([
      expect.objectContaining({ id: "feat:hp1:opp1", kind: "targetedSelfEffect", targetId: "opp1" }),
    ]);
  });

  it("annotates the Strike candidate against an opponent this actor has marked, and only that one", async () => {
    const rapier = { type: "strike", ready: true, label: "Rapier", slug: "rapier", variants: [{}, {}, {}], item: { slug: "rapier", type: "weapon", system: { range: null, traits: { value: ["finesse"] } } } };
    const me = mk("atk", 0, 0, -1, { type: "character", strikes: [rapier] });
    me.actor.itemTypes.effect = [
      { slug: "effect-devise-a-stratagem", system: { rules: [{ key: "TokenMark", slug: "devise-a-stratagem", uuid: "Scene.s.Token.opp1" }], badge: { type: "value", value: 17 } } },
    ];
    const marked = mk("opp1", 1, 0, 1);
    const unmarked = mk("opp2", 0, 1, 1);
    const pending = await getPendingAgentTurn(mkCombat([me, marked, unmarked], me));
    const summaries = pending.candidates.filter((c) => c.type === "strike").map((c) => c.summary);
    expect(summaries).toEqual([
      "Rapier vs opp1 (variant 0) [marked: devise-a-stratagem, d20 = 17]",
      "Rapier vs opp2 (variant 0)",
    ]);
    expect(pending.context.opponents.find((o) => o.id === "opp2")).not.toHaveProperty("markAnnotation");
  });
});

// --- #946: derived marked-target items (real pf2e 8.5.0 data) -------------

describe("computeTargetedSelfEffectVocabularyEntries: derived marked-target items (#946)", () => {
  const POPULATION = JSON.parse(
    readFileSync(new URL("./fixtures/marked-target-population.json", import.meta.url), "utf8"),
  ).entries;

  function realItem(slug) {
    const e = POPULATION.find((p) => p.slug === slug);
    return {
      id: `${slug}-id`, slug, name: e.name, uuid: `Actor.atk.Item.${slug}-id`,
      system: {
        actionType: { value: e.actionType }, actions: { value: e.actions },
        selfEffect: { uuid: e.selfEffectUuid }, frequency: e.frequency ? { ...e.frequency, value: 1 } : null,
        traits: { value: e.traits }, rules: [], description: { value: e.description },
      },
      flags: { pf2e: { rulesSelections: {} } },
    };
  }

  beforeEach(() => {
    globalThis.fromUuid = vi.fn(async (uuid) => {
      const e = POPULATION.find((p) => p.selfEffectUuid === uuid);
      return e ? effectDoc(e.effect.slug, e.effect.rules) : null;
    });
    // effectDoc's toObject carries no duration; give the real one.
    const base = globalThis.fromUuid;
    globalThis.fromUuid = vi.fn(async (uuid) => {
      const doc = await base(uuid);
      if (!doc) return null;
      const e = POPULATION.find((p) => p.selfEffectUuid === uuid);
      const toObject = doc.toObject;
      return { ...doc, toObject: () => { const o = toObject(); o.system.duration = e.effect.duration; return o; } };
    });
  });

  const featActor = (feat, extra = {}) => ({ ...actor(), itemTypes: { action: [], feat, effect: extra.effect ?? [] }, conditions: extra.conditions ?? [] });
  const seen = { ...goblin, distanceFeet: 10, actor: { system: { traits: { value: ["goblin", "humanoid"] } } } };
  const unseen = { ...orc, distanceFeet: 10, actor: { system: { traits: { value: ["orc"] } } } };

  it("offers Smite against every opponent in sight, with a deterministic summary of what the mark does", async () => {
    const entries = await computeTargetedSelfEffectVocabularyEntries(featActor([realItem("smite")]), [seen, unseen], 3);
    expect(entries).toEqual([
      { itemId: "smite-id", slug: "smite", name: "Smite", cost: 1, targetId: "opp1", traits: [], effectSummary: "mark Goblin: +strike-damage vs Goblin (1 rounds)" },
    ]);
  });

  it("Duelist's Challenge: the summary names the penalty against everyone else; not re-offered while a challenge is active", async () => {
    const [entry] = await computeTargetedSelfEffectVocabularyEntries(featActor([realItem("duelists-challenge")]), [seen], 3);
    expect(entry.effectSummary).toBe("mark Goblin: +melee-strike-damage vs Goblin, -strike-damage vs others (until encounter ends)");
    const active = { slug: "effect-duelists-challenge", system: { rules: [{ key: "TokenMark", slug: "duelists-challenge", uuid: "Scene.s.Token.other" }] } };
    expect(await computeTargetedSelfEffectVocabularyEntries(featActor([realItem("duelists-challenge")], { effect: [active] }), [seen], 3)).toEqual([]);
  });

  it("Smite re-designates: offered against everyone except the creature it already marks", async () => {
    const active = { slug: "effect-smite", system: { rules: [{ key: "TokenMark", slug: "smite", uuid: "Scene.s.Token.opp1" }] } };
    const other = { ...seen, id: "opp3", name: "Ogre", tokenUuid: "Scene.s.Token.opp3" };
    const entries = await computeTargetedSelfEffectVocabularyEntries(featActor([realItem("smite")], { effect: [active] }), [seen, other], 3);
    expect(entries.map((e) => e.targetId)).toEqual(["opp3"]);
  });

  it("Size Up: not against a mindless creature, and not while the actor is deafened (see AND hear)", async () => {
    const zombie = { ...seen, id: "z", name: "Zombie", tokenUuid: "Scene.s.Token.z", actor: { system: { traits: { value: ["mindless", "undead"] } } } };
    const entries = await computeTargetedSelfEffectVocabularyEntries(featActor([realItem("size-up")]), [seen, zombie], 3);
    expect(entries.map((e) => e.targetId)).toEqual(["opp1"]);
    const deafened = featActor([realItem("size-up")], { conditions: [{ slug: "deafened" }] });
    expect(await computeTargetedSelfEffectVocabularyEntries(deafened, [seen], 3)).toEqual([]);
  });

  it("a stated range excludes a target beyond it (Unfazed Assessment-style 'within 30 feet' on a clean mark)", async () => {
    const item = realItem("smite");
    item.system.description.value = "<p>Choose a creature within 30 feet who you're aware of.</p>";
    const far = { ...seen, distanceFeet: 35 };
    expect(await computeTargetedSelfEffectVocabularyEntries(featActor([item]), [far], 3)).toEqual([]);
    expect(await computeTargetedSelfEffectVocabularyEntries(featActor([item]), [{ ...far, distanceFeet: 30 }], 3)).toHaveLength(1);
  });

  it("never offers the rest of the population: toggleable (Harsh Judgement, Nothing Personal), cursebound (Whispers of Weakness), untracked state (Enforce Oath, Hungry Blade, Harvest Blood, Hunt the Razer's Pawn), choices/granted items, target-conditional", async () => {
    const offered = new Set(["smite", "duelists-challenge", "size-up", "hunt-prey"]);
    const rest = POPULATION.filter((p) => !offered.has(p.slug) && p.slug !== "devise-a-stratagem").map((p) => realItem(p.slug));
    expect(await computeTargetedSelfEffectVocabularyEntries(featActor(rest), [seen], 3)).toEqual([]);
  });

  it("a Requirements clause is evaluated (handFree): excluded when both hands are full", async () => {
    const item = realItem("smite");
    item.system.description.value = "<p><strong>Requirements</strong> You have a hand free.</p><hr /><p>Designate one enemy you can see.</p>";
    const twoHanded = { ...featActor([item]), items: [{ type: "weapon", name: "Greatsword", system: { equipped: { carryType: "held", handsHeld: 2 } } }] };
    expect(await computeTargetedSelfEffectVocabularyEntries(twoHanded, [seen], 3)).toEqual([]);
    expect(await computeTargetedSelfEffectVocabularyEntries({ ...twoHanded, items: [] }, [seen], 3)).toHaveLength(1);
  });
});
