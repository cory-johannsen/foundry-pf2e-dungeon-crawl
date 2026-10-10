// tests/dungeon-combat-npc-strike-execution.test.mjs
import { describe, it, expect, beforeEach, vi } from "vitest";
import { applyAgentDecision, getPendingAgentTurn, computeNpcStrikeEntries, sweepExpiredNpcAbilityConditions } from "../scripts/dungeon-combat.mjs";
import { recordGrab, grabRecordOf } from "../scripts/dungeon-strike-riders.mjs";
import { G, installGlobals, makeCombatant, makeCombat, makeStrike, makeWeapon, turnState } from "./helpers/feat-execution-fixture.mjs";

// #933: applyAgentDecision's `npcStrike` branch, end-to-end through the real
// getPendingAgentTurn rebuild with persisted picks (feat-execution fixture).
// Ability descriptions are real compendium text.

const DEATH_ROLL =
  "<p><strong>Requirements</strong> The crocodile must have a creature @UUID[Compendium.pf2e.conditionitems.Item.Grabbed]</p>\n<hr />\n<p><strong>Effect</strong> The crocodile tucks its legs and rolls rapidly, twisting its victim. It makes a jaws Strike with a +2 circumstance bonus to the attack roll against the grabbed creature. If it hits, it also knocks the creature @UUID[Compendium.pf2e.conditionitems.Item.Prone]. If it fails, it releases the creature.</p>";
const GNAW =
  "<p><strong>Requirements</strong> The owlbear has a creature @UUID[Compendium.pf2e.conditionitems.Item.Grabbed] with its talons.</p>\n<hr />\n<p><strong>Effect</strong> The owlbear attempts to disembowel the creature with a beak Strike. If the Strike hits, the target must attempt a @Check[will|dc:22] save.</p>\n<hr />\n<p><strong>Critical Success</strong> The target is unaffected.</p>\n<p><strong>Success</strong> The target is @UUID[Compendium.pf2e.conditionitems.Item.Sickened]{Sickened 1}.</p>\n<p><strong>Failure</strong> The target is sickened 1 and @UUID[Compendium.pf2e.conditionitems.Item.Slowed]{Slowed 1} as long as it remains sickened.</p>";
const CONSTRICT = "<p>@Damage[(1d8+6)[bludgeoning]], @Check[fortitude|dc:22|basic]</p>\n<hr />\n<p>@Localize[PF2E.NPC.Abilities.Glossary.Constrict]</p>";
const LUNGING_BITE = "<p>The dragon lunges their head forward, making a jaws Strike with an extended reach of 20 feet.</p>";
const BROAD_SWIPE =
  "<p>The giant makes two Strikes with its glaive against two adjacent foes, both of whom are within its reach. Both attacks count toward the giant's multiple attack penalty, but the penalty doesn't increase until after both attacks.</p>";
const WIDE_SWING =
  "<p>The frost giant makes a single greataxe Strike and compares the attack roll result to the ACs of up to two foes within their reach. This counts as two attacks for the frost giant's multiple attack penalty.</p>";
const MANGLING_REND =
  "<p>A megaprimatus makes two fist Strikes against the same target. If both hit, the attack deals an additional @Damage[2d6[bludgeoning]] damage, the target is @UUID[Compendium.pf2e.conditionitems.Item.Off-Guard], and the target takes a –20-foot status penalty to all Speeds until the end of its next turn.</p>\n<p>@UUID[Compendium.pf2e.bestiary-effects.Item.Effect: Mangling Rend]</p>";
const HURL_NET =
  "<p><strong>Requirements</strong> The tripkee is wielding a net in two hands</p><hr /><p><strong>Effect</strong> The tripkee makes a ranged Strike (with a [[/r 1d20+9]]{+9} attack modifier) against a Medium or smaller creature within 20 feet. On a hit, the target is @UUID[Compendium.pf2e.conditionitems.Item.Off-Guard] and takes a –10-foot circumstance penalty to its Speeds. On a critical hit, the creature is @UUID[Compendium.pf2e.conditionitems.Item.Restrained] instead. The DC to [[/act escape dc=16]] the net is 16. A creature adjacent to the target can Interact with the net to remove it.</p>\n<p>@UUID[Compendium.pf2e.bestiary-effects.Item.Effect: Hurl Net]</p>";
const REND = "<p>Claw</p>\n<hr />\n<p>@Localize[PF2E.NPC.Abilities.Glossary.Rend]</p>";

const DEGREES = ["criticalFailure", "failure", "success", "criticalSuccess"];

function ability({ id = "ab1", name, description, cost = 1, frequency = null }) {
  return {
    id,
    name,
    slug: null,
    uuid: `Actor.npc.Item.${id}`,
    type: "action",
    system: { actionType: { value: "action" }, actions: { value: cost }, traits: { value: [] }, frequency, description: { value: description } },
    update: vi.fn(async function (changes) {
      if ("system.frequency.value" in changes) this.system.frequency.value = changes["system.frequency.value"];
    }),
    toMessage: vi.fn(async () => {}),
  };
}

/** A ready Strike whose variant rolls post an attack message with
 * `outcome` (and a d20 `natural` / `total`), and whose damage roll is real
 * enough to apply. */
function strike(slug, { outcomes = ["success"], total = 25, natural = 12, reach = null } = {}) {
  const s = makeStrike(makeWeapon({ id: `w-${slug}`, slug }), { reach });
  let call = 0;
  for (const variant of s.variants) {
    variant.roll = vi.fn(async () => {
      const outcome = outcomes[Math.min(call, outcomes.length - 1)];
      call += 1;
      game.messages.contents.push({
        flags: { pf2e: { context: { outcome } } },
        rolls: [{ total, dice: [{ faces: 20, results: [{ result: natural, active: true }] }] }],
      });
    });
  }
  s.damage = vi.fn(async () => ({ total: 7, alter: async () => ({ total: 14 }) }));
  return s;
}

function withConditions(c, slugs) {
  c.actor.conditions = slugs.map((slug) => ({ slug }));
  c.actor.getCondition = (slug) => c.actor.conditions.find((x) => x.slug === slug) ?? null;
  c.actor.increaseCondition = vi.fn(async (slug) => {
    if (!c.actor.conditions.some((x) => x.slug === slug)) c.actor.conditions.push({ slug });
  });
  c.actor.decreaseCondition = vi.fn(async (slug) => {
    c.actor.conditions = c.actor.conditions.filter((x) => x.slug !== slug);
  });
  return c;
}

function setup({ item, strikes = [], opponents, picks, actionsRemaining = 3, mapIncrement = 0, npcItems = [] }) {
  const npc = makeCombatant({ id: "npc", gx: 1, gy: 1, disposition: -1, action: [item], actions: strikes });
  npc.actor.items = [item, ...npcItems];
  const combat = makeCombat(npc, opponents, { picks, actionsRemaining, mapIncrement, width: 12 });
  combat.turns = [npc, ...opponents];
  for (const c of [npc, ...opponents]) c.parent = combat;
  return { npc, combat };
}

function opponent(id, gx, gy, { conditions = [], ac = 18, size = "med", saveOutcome = "failure" } = {}) {
  const c = withConditions(makeCombatant({ id, gx, gy, disposition: 1 }), conditions);
  c.actor.armorClass = { value: ac };
  c.actor.size = size;
  c.toggleDefeated = vi.fn(async () => {});
  const save = { roll: vi.fn(async () => ({ degreeOfSuccess: DEGREES.indexOf(saveOutcome) })) };
  c.actor.saves = { fortitude: save, reflex: save, will: save };
  return c;
}

let effectDocs;
beforeEach(() => {
  installGlobals();
  // No per-square walk pause in tests.
  globalThis.game.settings = { get: (_m, key) => (key === "movementStepDelayMs" ? 0 : undefined) };
  globalThis.game.pf2e = {
    Modifier: class {
      constructor(data) {
        Object.assign(this, data);
      }
    },
  };
  class DamageRoll {
    constructor(formula) {
      this.formula = formula;
    }
    async evaluate() {
      this.total = 6;
      return this;
    }
    async alter(m) {
      return { formula: this.formula, total: this.total * m };
    }
  }
  globalThis.CONFIG.Dice.rolls = [DamageRoll];
  globalThis.Roll = class {
    constructor(formula) {
      this.formula = formula;
    }
    async evaluate() {
      this.total = globalThis.__netTotal ?? 20;
      this.dice = [{ faces: 20, results: [{ result: globalThis.__netNatural ?? 10, active: true }] }];
      return this;
    }
    async toMessage() {}
  };
  effectDocs = {
    "Effect: Mangling Rend": { _id: "mr", name: "Effect: Mangling Rend", system: { rules: [{ key: "FlatModifier", selector: "speed", value: -20 }] } },
    "Effect: Hurl Net": { _id: "hn", name: "Effect: Hurl Net", system: { rules: [{ key: "ChoiceSet", rollOption: "hurl-net" }, { key: "FlatModifier" }] } },
  };
  globalThis.game.packs = {
    get: (id) =>
      id === "pf2e.bestiary-effects"
        ? {
            getIndex: async () => Object.values(effectDocs).map((d) => ({ _id: d._id, name: d.name })),
            getDocument: async (docId) => {
              const doc = Object.values(effectDocs).find((d) => d._id === docId);
              return { toObject: () => structuredClone(doc) };
            },
          }
        : null,
  };
  globalThis.__netTotal = 20;
  globalThis.__netNatural = 10;
});

describe("npcStrike: grab follow-ups", () => {
  it("Death Roll: offered only for the grabbed creature; +2 circumstance, Prone on a hit, one attack of MAP", async () => {
    const jaws = strike("jaws");
    const item = ability({ name: "Death Roll", description: DEATH_ROLL });
    const pc = opponent("pc", 2, 1, { conditions: ["grabbed"] });
    const other = opponent("other", 1, 2);
    const { npc, combat } = setup({ item, strikes: [jaws], opponents: [pc, other], picks: [{ type: "npcStrike", slug: "death-roll", targetId: "pc", rationale: "roll it" }] });
    await recordGrab(combat, npc, pc, { limb: "jaws" });
    const pending = await getPendingAgentTurn(combat);
    expect(pending.npcStrikeVocabulary).toEqual([
      expect.objectContaining({ type: "npcStrike", shape: "strikeAgainstGrabbed", slug: "death-roll", targetId: "pc", targetIds: ["pc"], cost: 1 }),
    ]);
    expect(pending.npcStrikeVocabulary[0].summary).toBe("jaws Strike on grabbed pc; +2 to hit; on hit: prone; on a miss it releases the grab");
    await applyAgentDecision(combat, "npc", "npcStrike:ab1:pc", "r");
    const call = jaws.variants[0].roll.mock.calls[0][0];
    expect(call.modifiers).toEqual([expect.objectContaining({ modifier: 2, type: "circumstance" })]);
    expect(pc.actor.increaseCondition).toHaveBeenCalledWith("prone");
    expect(item.toMessage).toHaveBeenCalledTimes(1);
    expect(turnState(combat)).toMatchObject({ actionsRemaining: 2, mapIncrement: 1 });
    const record = combat.getFlag("pf2e-dungeon-crawl", "agentLog").at(-1);
    expect(record).toMatchObject({ type: "npcStrike", summary: "Death Roll", target: { id: "pc" }, result: { text: "hit; prone", tone: "success" } });
  });

  it("Death Roll on a miss releases the grab (condition removed, record cleared)", async () => {
    const jaws = strike("jaws", { outcomes: ["failure"] });
    const item = ability({ name: "Death Roll", description: DEATH_ROLL });
    const pc = opponent("pc", 2, 1, { conditions: ["grabbed"] });
    const { npc, combat } = setup({ item, strikes: [jaws], opponents: [pc], picks: [{ type: "npcStrike", slug: "death-roll", targetId: "pc" }] });
    await recordGrab(combat, npc, pc, { limb: "jaws" });
    await applyAgentDecision(combat, "npc", "npcStrike:ab1:pc", "r");
    expect(pc.actor.decreaseCondition).toHaveBeenCalledWith("grabbed", { forceRemove: true });
    expect(grabRecordOf(combat, "npc")).toBeNull();
    expect(pc.actor.increaseCondition).not.toHaveBeenCalledWith("prone");
  });

  it("a stale grab (the target Escaped) is never offered and the pick spends nothing", async () => {
    const jaws = strike("jaws");
    const item = ability({ name: "Death Roll", description: DEATH_ROLL });
    const pc = opponent("pc", 2, 1, { conditions: [] });
    const { npc, combat } = setup({ item, strikes: [jaws], opponents: [pc], picks: [{ type: "npcStrike", slug: "death-roll", targetId: "pc" }] });
    await recordGrab(combat, npc, pc, { limb: "jaws" });
    expect((await getPendingAgentTurn(combat)).npcStrikeVocabulary).toEqual([]);
    expect(await applyAgentDecision(combat, "npc", "npcStrike:ab1:pc", "r")).toBeNull();
    expect(jaws.variants[0].roll).not.toHaveBeenCalled();
    expect(turnState(combat)).toMatchObject({ actionsRemaining: 3, mapIncrement: 0 });
  });

  it("Gnaw needs the grab made with its talons; on a hit the Will save's failure applies Sickened 1 and Slowed 1 while sickened", async () => {
    const beak = strike("beak");
    const talon = strike("talon");
    const item = ability({ name: "Gnaw", description: GNAW });
    const pc = opponent("pc", 2, 1, { conditions: ["grabbed"], saveOutcome: "failure" });
    const { npc, combat } = setup({ item, strikes: [beak, talon], opponents: [pc], picks: [{ type: "npcStrike", slug: "gnaw", targetId: "pc" }] });
    await recordGrab(combat, npc, pc, { limb: "beak" });
    expect(computeNpcStrikeEntries(combat, npc, [pc], 3)).toEqual([]);
    await recordGrab(combat, npc, pc, { limb: "talon" });
    expect(computeNpcStrikeEntries(combat, npc, [pc], 3)).toHaveLength(1);
    await applyAgentDecision(combat, "npc", "npcStrike:ab1:pc", "r");
    expect(beak.variants[0].roll).toHaveBeenCalledTimes(1);
    expect(pc.actor.saves.will.roll).toHaveBeenCalledWith(expect.objectContaining({ dc: { value: 22 } }));
    expect(pc.actor.increaseCondition).toHaveBeenCalledWith("sickened", { value: 1 });
    expect(pc.actor.increaseCondition).toHaveBeenCalledWith("slowed", { value: 1 });
    const expiry = combat.getFlag("pf2e-dungeon-crawl", "npcAbilityExpiry");
    expect(expiry).toEqual([expect.objectContaining({ targetId: "pc", conditionSlug: "slowed", expiry: { whileCondition: "sickened" } })]);
    // Slowed stays while Sickened does, and is removed once it is gone.
    await sweepExpiredNpcAbilityConditions(combat);
    expect(pc.actor.decreaseCondition).not.toHaveBeenCalledWith("slowed", expect.anything());
    pc.actor.conditions = pc.actor.conditions.filter((c) => c.slug !== "sickened");
    await sweepExpiredNpcAbilityConditions(combat);
    expect(pc.actor.decreaseCondition).toHaveBeenCalledWith("slowed", { forceRemove: true });
  });

  it("Constrict: the grabbed creature's basic Fortitude save, full damage on a failure, no attack and no MAP", async () => {
    const item = ability({ name: "Constrict", description: CONSTRICT });
    const pc = opponent("pc", 2, 1, { conditions: ["grabbed"], saveOutcome: "failure" });
    const { npc, combat } = setup({ item, opponents: [pc], mapIncrement: 1, picks: [{ type: "npcStrike", slug: "constrict", targetId: "pc" }] });
    await recordGrab(combat, npc, pc);
    await applyAgentDecision(combat, "npc", "npcStrike:ab1:pc", "r");
    expect(pc.actor.saves.fortitude.roll).toHaveBeenCalledWith(expect.objectContaining({ dc: { value: 22 } }));
    expect(pc.actor.applyDamage).toHaveBeenCalledWith(expect.objectContaining({ damage: expect.objectContaining({ formula: "(1d8+6)[bludgeoning]" }), outcome: "failure" }));
    expect(turnState(combat)).toMatchObject({ actionsRemaining: 2, mapIncrement: 1 });
  });

  it("a grabber that Strides releases its grab (RAW: 'unless you move')", async () => {
    const pc = opponent("pc", 2, 1, { conditions: ["grabbed"] });
    const far = opponent("far", 9, 1);
    const item = ability({ name: "Constrict", description: CONSTRICT });
    const { npc, combat } = setup({ item, opponents: [pc, far], picks: [] });
    await recordGrab(combat, npc, pc);
    await applyAgentDecision(combat, "npc", "stride:approach:far", "r");
    expect(npc.token.x).toBeGreaterThan(1 * G);
    expect(pc.actor.decreaseCondition).toHaveBeenCalledWith("grabbed", { forceRemove: true });
    expect(grabRecordOf(combat, "npc")).toBeNull();
  });
});

describe("npcStrike: reach and multi-target", () => {
  it("Lunging Bite: only targets beyond the jaws' normal reach and within 20 ft; a Strike at the current MAP", async () => {
    const jaws = strike("jaws");
    const item = ability({ name: "Lunging Bite", description: LUNGING_BITE, cost: 2 });
    const near = opponent("near", 2, 1);
    const mid = opponent("mid", 5, 1);
    const far = opponent("far", 7, 1);
    const { combat } = setup({ item, strikes: [jaws], opponents: [near, mid, far], mapIncrement: 1, picks: [{ type: "npcStrike", slug: "lunging-bite", targetId: "mid" }] });
    const pending = await getPendingAgentTurn(combat);
    expect(pending.npcStrikeVocabulary.map((v) => v.targetId)).toEqual(["mid"]);
    await applyAgentDecision(combat, "npc", "npcStrike:ab1:mid", "r");
    expect(jaws.variants[1].roll).toHaveBeenCalledTimes(1);
    expect(turnState(combat)).toMatchObject({ actionsRemaining: 1, mapIncrement: 2 });
  });

  it("Broad Swipe: two adjacent foes, both Strikes at the same MAP, which then rises by two", async () => {
    const glaive = strike("glaive", { reach: 10 });
    const item = ability({ name: "Broad Swipe", description: BROAD_SWIPE, cost: 2 });
    const a = opponent("a", 3, 1);
    const b = opponent("b", 3, 2);
    const lone = opponent("lone", 1, 3);
    const { combat } = setup({ item, strikes: [glaive], opponents: [a, b, lone], picks: [{ type: "npcStrike", slug: "broad-swipe", targetId: "a" }] });
    const pending = await getPendingAgentTurn(combat);
    // `lone` is in reach but adjacent to neither foe.
    expect(pending.npcStrikeVocabulary.map((v) => v.targetIds)).toEqual([["a", "b"], ["b", "a"]]);
    await applyAgentDecision(combat, "npc", "npcStrike:ab1:a,b", "r");
    expect(glaive.variants[0].roll).toHaveBeenCalledTimes(2);
    expect(glaive.variants[1].roll).not.toHaveBeenCalled();
    expect(turnState(combat)).toMatchObject({ actionsRemaining: 1, mapIncrement: 2 });
    const record = combat.getFlag("pf2e-dungeon-crawl", "agentLog").at(-1);
    expect(record.target).toBeNull();
    expect(record.result.text).toBe("a: hit; b: hit");
  });

  it("Wide Swing: one roll, each other target judged against its own AC (natural 20/1 included), counts as two attacks", async () => {
    // Total 25 on a natural 12: hits AC 18 (pc), misses AC 26 (tank).
    const greataxe = strike("greataxe", { total: 25, natural: 12 });
    const item = ability({ name: "Wide Swing", description: WIDE_SWING });
    const pc = opponent("pc", 2, 1, { ac: 18 });
    const tank = opponent("tank", 2, 2, { ac: 26 });
    const { combat } = setup({ item, strikes: [greataxe], opponents: [pc, tank], picks: [{ type: "npcStrike", slug: "wide-swing", targetId: "pc" }] });
    const pending = await getPendingAgentTurn(combat);
    expect(pending.npcStrikeVocabulary.find((v) => v.targetId === "pc").targetIds).toEqual(["pc", "tank"]);
    await applyAgentDecision(combat, "npc", "npcStrike:ab1:pc,tank", "r");
    expect(greataxe.variants[0].roll).toHaveBeenCalledTimes(1);
    expect(tank.actor.applyDamage).not.toHaveBeenCalled();
    expect(turnState(combat)).toMatchObject({ actionsRemaining: 2, mapIncrement: 2 });
    expect(combat.getFlag("pf2e-dungeon-crawl", "agentLog").at(-1).result.text).toBe("pc: hit; tank: miss");
  });

  it("Wide Swing: the same natural 20 is a critical hit on one AC and only a hit on a much higher one", async () => {
    const greataxe = strike("greataxe", { outcomes: ["criticalSuccess"], total: 22, natural: 20 });
    const item = ability({ name: "Wide Swing", description: WIDE_SWING });
    const pc = opponent("pc", 2, 1, { ac: 18 });
    const tank = opponent("tank", 2, 2, { ac: 30 });
    const { combat } = setup({ item, strikes: [greataxe], opponents: [pc, tank], picks: [{ type: "npcStrike", slug: "wide-swing", targetId: "pc" }] });
    await applyAgentDecision(combat, "npc", "npcStrike:ab1:pc,tank", "r");
    // 22 vs AC 30 is a failure; the natural 20 raises it to a hit.
    expect(greataxe.damage).toHaveBeenCalledWith(expect.objectContaining({ outcome: "success", target: { document: tank.token } }));
    expect(tank.actor.applyDamage).toHaveBeenCalledWith(expect.objectContaining({ outcome: "success" }));
    expect(combat.getFlag("pf2e-dungeon-crawl", "agentLog").at(-1).result.text).toBe("pc: critical hit; tank: hit");
  });
});

describe("npcStrike: both-hit bundle, Hurl Net, Rend", () => {
  it("Mangling Rend: when both fists hit -- extra damage, Off-Guard until the end of its next turn, the Speed effect", async () => {
    const fist = strike("fist", { outcomes: ["success", "success"] });
    const item = ability({ name: "Mangling Rend", description: MANGLING_REND, cost: 2 });
    const pc = opponent("pc", 2, 1);
    const { combat } = setup({ item, strikes: [fist], opponents: [pc], picks: [{ type: "npcStrike", slug: "mangling-rend", targetId: "pc" }] });
    await applyAgentDecision(combat, "npc", "npcStrike:ab1:pc", "r");
    expect(fist.variants[0].roll).toHaveBeenCalledTimes(1);
    expect(fist.variants[1].roll).toHaveBeenCalledTimes(1);
    expect(pc.actor.applyDamage).toHaveBeenCalledWith(expect.objectContaining({ damage: expect.objectContaining({ formula: "2d6[bludgeoning]" }) }));
    expect(pc.actor.increaseCondition).toHaveBeenCalledWith("off-guard");
    const created = pc.actor.createEmbeddedDocuments.mock.calls.map((c) => c[1][0]);
    expect(created).toEqual([expect.objectContaining({ name: "Effect: Mangling Rend", system: expect.objectContaining({ context: expect.objectContaining({ origin: expect.objectContaining({ actor: "Actor.npc" }) }) }) })]);
    expect(combat.getFlag("pf2e-dungeon-crawl", "npcAbilityExpiry")).toEqual([
      expect.objectContaining({ targetId: "pc", conditionSlug: "off-guard", expiry: { untilRoundTurn: expect.any(Object) } }),
    ]);
    expect(turnState(combat)).toMatchObject({ actionsRemaining: 1, mapIncrement: 2 });
  });

  it("Mangling Rend: one miss and none of the rider lands", async () => {
    const fist = strike("fist", { outcomes: ["success", "failure"] });
    const item = ability({ name: "Mangling Rend", description: MANGLING_REND, cost: 2 });
    const pc = opponent("pc", 2, 1);
    const { combat } = setup({ item, strikes: [fist], opponents: [pc], picks: [{ type: "npcStrike", slug: "mangling-rend", targetId: "pc" }] });
    await applyAgentDecision(combat, "npc", "npcStrike:ab1:pc", "r");
    expect(pc.actor.applyDamage).toHaveBeenCalledTimes(1); // the first fist's own damage only
    expect(pc.actor.increaseCondition).not.toHaveBeenCalledWith("off-guard");
    expect(pc.actor.createEmbeddedDocuments).not.toHaveBeenCalled();
  });

  it("Hurl Net: Medium-or-smaller within 20 ft only; a hit creates the effect with its degree pre-chosen; the net is spent", async () => {
    const item = ability({ name: "Hurl Net", description: HURL_NET });
    const net = { type: "equipment", name: "Net", system: { quantity: 1 } };
    const pc = opponent("pc", 4, 1, { ac: 18 });
    const ogre = opponent("ogre", 3, 2, { size: "lg" });
    const { npc, combat } = setup({ item, opponents: [pc, ogre], npcItems: [net], mapIncrement: 1, picks: [{ type: "npcStrike", slug: "hurl-net", targetId: "pc" }] });
    const pending = await getPendingAgentTurn(combat);
    expect(pending.npcStrikeVocabulary.map((v) => v.targetId)).toEqual(["pc"]);
    const rolled = [];
    globalThis.Roll = class {
      constructor(formula) {
        rolled.push(formula);
      }
      async evaluate() {
        this.total = 19;
        this.dice = [{ faces: 20, results: [{ result: 15, active: true }] }];
        return this;
      }
      async toMessage() {}
    };
    await applyAgentDecision(combat, "npc", "npcStrike:ab1:pc", "r");
    // +9, minus the second attack's -5.
    expect(rolled).toEqual(["1d20 + 9 - 5"]);
    const [effect] = pc.actor.createEmbeddedDocuments.mock.calls[0][1];
    expect(effect.name).toBe("Effect: Hurl Net");
    expect(effect.system.rules[0]).toMatchObject({ key: "ChoiceSet", selection: "success" });
    expect(turnState(combat)).toMatchObject({ actionsRemaining: 2, mapIncrement: 2 });
    expect(computeNpcStrikeEntries(combat, npc, [pc, ogre], 2)).toEqual([]);
    expect(combat.getFlag("pf2e-dungeon-crawl", "agentLog").at(-1).gmNote).toContain("Escape DC is 16");
  });

  it("Rend: offered only after two consecutive claw hits on the same target this round; deals the claw's damage again, no attack", async () => {
    const claw = strike("claw", { outcomes: ["success", "success"] });
    const item = ability({ name: "Rend", description: REND });
    const pc = opponent("pc", 2, 1);
    const { combat } = setup({ item, strikes: [claw], opponents: [pc], picks: [{ type: "npcStrike", slug: "rend", targetId: "pc" }] });
    expect((await getPendingAgentTurn(combat)).npcStrikeVocabulary).toEqual([]);
    await applyAgentDecision(combat, "npc", "strike:claw:pc", "r");
    expect((await getPendingAgentTurn(combat)).npcStrikeVocabulary).toEqual([]);
    await applyAgentDecision(combat, "npc", "strike:claw:pc", "r");
    expect(turnState(combat)).toMatchObject({ actionsRemaining: 1, mapIncrement: 2 });
    const pending = await getPendingAgentTurn(combat);
    expect(pending.npcStrikeVocabulary).toEqual([expect.objectContaining({ shape: "rend", targetIds: ["pc"] })]);
    claw.damage.mockClear();
    await applyAgentDecision(combat, "npc", "npcStrike:ab1:pc", "r");
    expect(claw.damage).toHaveBeenCalledWith(expect.objectContaining({ outcome: "success" }));
    expect(pc.actor.applyDamage).toHaveBeenLastCalledWith(expect.objectContaining({ outcome: "success" }));
    // Rend is not an attack: the MAP stays where the two claws left it.
    expect(turnState(combat)).toMatchObject({ actionsRemaining: 0, mapIncrement: 2 });
  });
});
