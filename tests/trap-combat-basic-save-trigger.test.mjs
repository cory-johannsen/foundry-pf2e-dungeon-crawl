import { describe, it, expect, vi, beforeEach } from "vitest";
import { triggerTrap, classifyTrap } from "../scripts/trap-combat.mjs";

// PF2e degreeOfSuccess: 0 critical failure .. 3 critical success.
const DEGREE = { criticalFailure: 0, failure: 1, success: 2, criticalSuccess: 3 };

const STEAM_VENTS_DESC = `<p><strong>Effect</strong> Steam erupts from the pipes, dealing @Damage[3d6[bludgeoning],3d6[fire]]{3d6 bludgeoning damage and 3d6 fire damage} (@Check[reflex|dc:24|basic|traits:mechanical,trap,hazard]) to all creatures within 15 feet. Creatures that critically fail their save are knocked prone.</p>`;
const ELECTRIC_LATCH_DESC = `<p><strong>Effect</strong> The trap deals @Damage[3d12[electricity]] damage to the triggering creature (@Check[reflex|dc:22|basic] save).</p>`;
const INITIATIVE_DESC = `<p>The wheel begins to spin and <strong>rolls initiative</strong>.</p>`;
const INITIATIVE_AREA_DESC = `<p><strong>Effect</strong> The wheel spins and rolls initiative, flinging creatures within 10 feet.</p>`;
const NO_BASIC_DESC = `<p><strong>Effect</strong> The slab deals @Damage[3d8[bludgeoning]] damage to anyone adjacent (@Check[reflex|dc:17] save).</p>`;
const NO_DAMAGE_DESC = `<p><strong>Effect</strong> Each creature must succeed at a @Check[will|dc:23|basic] save or be cursed.</p>`;
const EXTRA_RIDER_DESC = `<p><strong>Effect</strong> It deals @Damage[2d6[fire]] (@Check[reflex|dc:20|basic]) to creatures within 10 feet. The room fills with smoke.</p>`;

function hazardActor({ items = [], actions = [], flags = {} } = {}) {
  return {
    id: "hazard1",
    name: "Test Trap",
    system: { actions },
    items,
    getFlag: (_m, k) => flags[k],
    setFlag: vi.fn(),
  };
}
const actionItem = (name, description) => ({ type: "action", name, system: { description: { value: description } } });

/** A creature whose reflex save resolves to `outcome` (null: roll gives no degree). */
function actor(id, name, outcome = "failure", extra = {}) {
  return {
    id,
    name,
    saves: {
      reflex: {
        roll: vi.fn(async () => (outcome ? { degreeOfSuccess: DEGREE[outcome] } : undefined)),
      },
    },
    applyDamage: vi.fn(async () => {}),
    increaseCondition: vi.fn(async () => {}),
    ...extra,
  };
}

/** A token DOCUMENT: pixel x/y, width/height in squares. */
function tokenDoc(a, gx, gy = 0, id = `tok-${a.id}`) {
  return { id, actor: a, x: gx * 100, y: gy * 100, width: 1, height: 1, object: { id: `obj-${id}` } };
}

let partyMembers;
let created;
let damageRolls;

beforeEach(() => {
  partyMembers = [];
  created = [];
  damageRolls = [];
  globalThis.game = {
    user: { update: vi.fn(async () => {}), flags: {} },
    messages: { contents: [{ flags: { pf2e: { context: { outcome: "criticalFailure" } } } }] }, // stale card
    actors: { get: () => null, get party() { return { members: partyMembers }; } },
    i18n: { format: (k, d) => `${k}|${JSON.stringify(d)}` },
  };
  globalThis.ChatMessage = {
    create: vi.fn(async (m) => { created.push(m); }),
    getWhisperRecipients: vi.fn(() => ["gm-user"]),
    getSpeaker: vi.fn(() => ({ alias: "speaker" })),
  };
  globalThis.CONST = {
    WALL_MOVEMENT_TYPES: { NONE: 0, NORMAL: 20 },
    WALL_DOOR_TYPES: { NONE: 0, DOOR: 1 },
    WALL_DOOR_STATES: { CLOSED: 0, OPEN: 1 },
  };
  // A faithful-enough stand-in for PF2e's DamageRoll: records its formula,
  // evaluates once, posts via toMessage, and alter() returns a new roll object.
  class DamageRoll {
    constructor(formula) {
      this.formula = formula;
      this.total = 20;
      this.toMessage = vi.fn(async () => {});
      damageRolls.push(this);
    }
    async evaluate() { return this; }
    alter = vi.fn((multiplier, addend) => ({ altered: true, multiplier, addend, base: this }));
  }
  globalThis.CONFIG = { Dice: { rolls: [class Other {}, DamageRoll] } };
});

function sceneWith(tokens, walls = []) {
  return { grid: { size: 100, distance: 5 }, tokens, walls: { contents: walls } };
}
const gmWhispers = () => created.map((m) => {
  const sep = m.content.indexOf("|");
  return { key: m.content.slice(0, sep), data: JSON.parse(m.content.slice(sep + 1)), whisper: m.whisper };
});

describe("#839 triggerTrap basic-save branch: single target", () => {
  it("resolves against only the triggering creature, with hazard context on the save", async () => {
    const alice = actor("p1", "Alice");
    const bob = actor("p2", "Bob");
    partyMembers.push(alice, bob);
    const hazardToken = tokenDoc({ id: "hz" }, 0, 0, "hz-tok");
    const aliceTok = tokenDoc(alice, 0);
    const scene = sceneWith([hazardToken, aliceTok, tokenDoc(bob, 1)]);
    const item = actionItem("Zap", ELECTRIC_LATCH_DESC);
    const h = hazardActor({ items: [item] });
    await triggerTrap(h, { actor: alice, token: aliceTok.object }, { hazardToken, scene });
    expect(alice.saves.reflex.roll).toHaveBeenCalledOnce();
    const args = alice.saves.reflex.roll.mock.calls[0][0];
    expect(args.dc).toEqual({ value: 22 });
    expect(args.origin).toBe(h);
    expect(args.item).toBe(item);
    expect(args.extraRollOptions).toContain("damaging-effect");
    expect(bob.saves.reflex.roll).not.toHaveBeenCalled();
    expect(bob.applyDamage).not.toHaveBeenCalled();
    expect(created).toHaveLength(0);
  });

  it("passes the @Check's own traits as save roll options", async () => {
    const alice = actor("p1", "Alice", "criticalSuccess");
    const hazardToken = tokenDoc({ id: "hz" }, 0, 0, "hz-tok");
    const scene = sceneWith([hazardToken, tokenDoc(alice, 0)]);
    await triggerTrap(hazardActor({ items: [actionItem("S", STEAM_VENTS_DESC)] }), { actor: alice, token: {} }, { hazardToken, scene });
    const args = alice.saves.reflex.roll.mock.calls[0][0];
    expect(args.traits).toEqual(["mechanical", "trap", "hazard"]);
    expect(args.extraRollOptions).toEqual(expect.arrayContaining(["item:trait:trap", "item:trait:mechanical"]));
  });

  it("#884: applyDamage receives item and rollOptions, matching the save roll's own trait/option list", async () => {
    const alice = actor("p1", "Alice", "failure");
    const hazardToken = tokenDoc({ id: "hz" }, 0, 0, "hz-tok");
    const scene = sceneWith([hazardToken, tokenDoc(alice, 0)]);
    const item = actionItem("S", STEAM_VENTS_DESC);
    await triggerTrap(hazardActor({ items: [item] }), { actor: alice, token: {} }, { hazardToken, scene });
    expect(alice.applyDamage).toHaveBeenCalledWith(
      expect.objectContaining({
        item,
        rollOptions: expect.arrayContaining(["item:trait:trap", "item:trait:mechanical"]),
      }),
    );
    const { rollOptions } = alice.applyDamage.mock.calls[0][0];
    expect(rollOptions).not.toContain("damaging-effect");
  });

  it("#884: an empty traits/options list still calls applyDamage normally (no rollOptions key breaks anything)", async () => {
    const alice = actor("p1", "Alice", "failure");
    const token = { id: "t" };
    const h = hazardActor({ items: [actionItem("Zap", ELECTRIC_LATCH_DESC)] });
    await triggerTrap(h, { actor: alice, token });
    expect(alice.applyDamage).toHaveBeenCalledWith(
      expect.objectContaining({ damage: expect.anything(), token, rollOptions: [] }),
    );
  });

  it.each([
    ["criticalSuccess", null],
    ["success", 0.5],
    ["failure", 1],
    ["criticalFailure", 2],
  ])("basic save %s: damage multiplier %s via the PF2e roll, never a number", async (outcome, multiplier) => {
    const alice = actor("p1", "Alice", outcome);
    const token = { id: "t" };
    const h = hazardActor({ items: [actionItem("Zap", ELECTRIC_LATCH_DESC)] });
    const result = await triggerTrap(h, { actor: alice, token });
    expect(result).toBe(outcome);
    if (multiplier === null) {
      expect(alice.applyDamage).not.toHaveBeenCalled();
      expect(damageRolls).toHaveLength(0); // nothing to apply, nothing rolled
      return;
    }
    expect(damageRolls).toHaveLength(1);
    const roll = damageRolls[0];
    const call = alice.applyDamage.mock.calls[0][0];
    expect(typeof call.damage).not.toBe("number");
    expect(call).not.toHaveProperty("outcome");
    expect(call.token).toBe(token);
    if (multiplier === 1) {
      expect(call.damage).toBe(roll);
      expect(roll.alter).not.toHaveBeenCalled();
    } else {
      expect(roll.alter).toHaveBeenCalledWith(multiplier, 0);
      expect(call.damage.multiplier).toBe(multiplier);
    }
  });

  it("rolls ONE typed DamageRoll per trigger and posts it once with apply buttons off", async () => {
    const alice = actor("p1", "Alice", "failure");
    const hazardToken = tokenDoc({ id: "hz" }, 0, 0, "hz-tok");
    const bob = actor("p2", "Bob", "success");
    const cora = actor("p3", "Cora", "criticalFailure");
    const scene = sceneWith([hazardToken, tokenDoc(alice, 0), tokenDoc(bob, 1), tokenDoc(cora, 2)]);
    await triggerTrap(hazardActor({ items: [actionItem("S", STEAM_VENTS_DESC)] }), { actor: alice, token: {} }, { hazardToken, scene });
    expect(damageRolls).toHaveLength(1);
    expect(damageRolls[0].formula).toBe("3d6[bludgeoning],3d6[fire]");
    expect(damageRolls[0].toMessage).toHaveBeenCalledOnce();
    expect(damageRolls[0].toMessage.mock.calls[0][0].flags.pf2e.suppressDamageButtons).toBe(true);
    // every target got damage derived from that same single roll
    const applied = [alice, bob, cora].map((a) => a.applyDamage.mock.calls[0][0].damage);
    expect(applied[0]).toBe(damageRolls[0]);
    expect(applied[1].base).toBe(damageRolls[0]);
    expect(applied[2].base).toBe(damageRolls[0]);
  });

  it("skips a target whose save can't be rolled and whispers the GM, never reusing a stale card", async () => {
    const alice = actor("p1", "Alice", null); // roll returns nothing
    const h = hazardActor({ items: [actionItem("Zap", ELECTRIC_LATCH_DESC)] });
    const result = await triggerTrap(h, { actor: alice, token: {} });
    expect(result).toBeNull();
    expect(alice.applyDamage).not.toHaveBeenCalled();
    const [w] = gmWhispers();
    expect(w.key).toBe("PF2EDC.Dungeon.Trap.SaveUnavailableChat");
    expect(w.whisper).toEqual(["gm-user"]);
    expect(w.data.name).toBe("Alice");
  });

  it("skips a target with no such save at all", async () => {
    const alice = actor("p1", "Alice");
    alice.saves = {};
    await triggerTrap(hazardActor({ items: [actionItem("Zap", ELECTRIC_LATCH_DESC)] }), { actor: alice, token: {} });
    expect(alice.applyDamage).not.toHaveBeenCalled();
    expect(gmWhispers()[0].key).toBe("PF2EDC.Dungeon.Trap.SaveUnavailableChat");
  });

  it("does nothing at all for a disabled trap", async () => {
    const alice = actor("p1", "Alice");
    const h = hazardActor({ items: [actionItem("Zap", ELECTRIC_LATCH_DESC)], flags: { trapDisabled: true } });
    expect(await triggerTrap(h, { actor: alice, token: {} })).toBeNull();
    expect(alice.saves.reflex.roll).not.toHaveBeenCalled();
    expect(created).toHaveLength(0);
  });
});

describe("#839 triggerTrap basic-save branch: area (every creature in the area)", () => {
  function setup(extraTokens = [], walls = []) {
    const alice = actor("p1", "Alice", "failure"); // triggerer, on the trap
    const hazardToken = tokenDoc({ id: "hz" }, 0, 0, "hz-tok");
    const aliceTok = tokenDoc(alice, 0);
    const scene = sceneWith([hazardToken, aliceTok, ...extraTokens], walls);
    partyMembers.push(alice);
    return { alice, hazardToken, aliceTok, scene };
  }
  const trap = () => hazardActor({ items: [actionItem("Steam Blast", STEAM_VENTS_DESC)] });

  it("hits every creature in range, party or not, and nobody outside it", async () => {
    const bob = actor("p2", "Bob", "success"); // 3 squares = 15 ft: in
    const orc = actor("o1", "Orc", "failure"); // hostile, in range: hit (RAW)
    const far = actor("p3", "Cora", "criticalFailure"); // 4 squares = 20 ft: out
    const { alice, hazardToken, aliceTok, scene } = setup([tokenDoc(bob, 3), tokenDoc(orc, 1), tokenDoc(far, 4)]);
    partyMembers.push(bob, far);
    await triggerTrap(trap(), { actor: alice, token: aliceTok.object }, { hazardToken, scene });
    for (const a of [alice, bob, orc]) expect(a.applyDamage).toHaveBeenCalledOnce();
    expect(far.saves.reflex.roll).not.toHaveBeenCalled();
    expect(far.applyDamage).not.toHaveBeenCalled();
  });

  it("uses PF2e 5-10-5 diagonals: 3 east + 2 north is 20 ft, outside a 15 ft burst", async () => {
    const diag = actor("p2", "Dina", "failure");
    const edge = actor("p3", "Eli", "failure"); // 2 east + 2 north = 15 ft: inside
    const { alice, hazardToken, scene } = setup([tokenDoc(diag, 3, 2), tokenDoc(edge, 2, 2)]);
    await triggerTrap(trap(), { actor: alice, token: {} }, { hazardToken, scene });
    expect(diag.saves.reflex.roll).not.toHaveBeenCalled();
    expect(edge.applyDamage).toHaveBeenCalledOnce();
  });

  it("excludes the hazard token itself, dead creatures and non-creature actors", async () => {
    const dead = actor("d1", "Corpse", "failure", { statuses: new Set(["dead"]) });
    const crate = actor("c1", "Crate", "failure", { isOfType: (t) => t !== "creature" });
    const otherTrap = actor("h2", "Other Trap", "failure", { isOfType: () => false });
    const { alice, hazardToken, scene } = setup([tokenDoc(dead, 1), tokenDoc(crate, 1, 1), tokenDoc(otherTrap, 0, 1)]);
    scene.tokens.push({ ...hazardToken, id: "hz-tok", actor: { id: "hz", saves: {}, isOfType: () => true } });
    await triggerTrap(trap(), { actor: alice, token: {} }, { hazardToken, scene });
    expect(alice.applyDamage).toHaveBeenCalledOnce();
    for (const a of [dead, crate, otherTrap]) expect(a.saves.reflex.roll).not.toHaveBeenCalled();
  });

  it("the triggerer is hit only if actually in the area (a crit-fail disarmer 4 squares away is not)", async () => {
    const alice = actor("p1", "Alice", "failure");
    const near = actor("p2", "Bob", "failure");
    const hazardToken = tokenDoc({ id: "hz" }, 0, 0, "hz-tok");
    const scene = sceneWith([hazardToken, tokenDoc(alice, 4), tokenDoc(near, 1)]);
    partyMembers.push(alice, near);
    await triggerTrap(trap(), { actor: alice, token: {} }, { hazardToken, scene });
    expect(alice.saves.reflex.roll).not.toHaveBeenCalled();
    expect(near.applyDamage).toHaveBeenCalledOnce();
  });

  it("a wall between the hazard and a nearby token blocks line of effect", async () => {
    const behind = actor("p2", "Bob", "failure");
    const { alice, hazardToken, scene } = setup([tokenDoc(behind, 2)], [
      { c: [100, 0, 100, 100], move: 20, door: 0, ds: 0 },
    ]);
    await triggerTrap(trap(), { actor: alice, token: {} }, { hazardToken, scene });
    expect(behind.saves.reflex.roll).not.toHaveBeenCalled();
    expect(alice.applyDamage).toHaveBeenCalledOnce();
  });

  it("an open door does not block line of effect, a closed one does", async () => {
    const open = actor("p2", "Bob", "failure");
    const { alice, hazardToken, scene } = setup([tokenDoc(open, 2)], [
      { c: [100, 0, 100, 100], move: 20, door: 1, ds: 1 },
    ]);
    await triggerTrap(trap(), { actor: alice, token: {} }, { hazardToken, scene });
    expect(open.applyDamage).toHaveBeenCalledOnce();
    const closed = actor("p3", "Cora", "failure");
    const s2 = setup([tokenDoc(closed, 2)], [{ c: [100, 0, 100, 100], move: 20, door: 1, ds: 0 }]);
    await triggerTrap(trap(), { actor: s2.alice, token: {} }, { hazardToken: s2.hazardToken, scene: s2.scene });
    expect(closed.saves.reflex.roll).not.toHaveBeenCalled();
  });

  it("applies prone to critical failures only, never to other outcomes", async () => {
    const crit = actor("p2", "Bob", "criticalFailure");
    const fail = actor("p3", "Cora", "failure");
    const win = actor("p4", "Dax", "criticalSuccess");
    const { alice, hazardToken, scene } = setup([tokenDoc(crit, 1), tokenDoc(fail, 2), tokenDoc(win, 3)]);
    await triggerTrap(trap(), { actor: alice, token: {} }, { hazardToken, scene });
    expect(crit.increaseCondition).toHaveBeenCalledWith("prone");
    for (const a of [alice, fail, win]) expect(a.increaseCondition).not.toHaveBeenCalled();
  });

  it("whispers the GM any rider text the parser did not consume, escaped", async () => {
    const { alice, hazardToken, scene } = setup();
    const h = hazardActor({ items: [actionItem("Burst", EXTRA_RIDER_DESC.replace("smoke.", "smoke <b>&</b>."))] });
    await triggerTrap(h, { actor: alice, token: {} }, { hazardToken, scene });
    const rider = gmWhispers().find((w) => w.key === "PF2EDC.Dungeon.Trap.RiderChat");
    expect(rider.data.text).toContain("The room fills with smoke");
    expect(rider.data.text).not.toContain("<b>");
    expect(rider.whisper).toEqual(["gm-user"]);
    // no prone rider text -> no prone
    expect(alice.increaseCondition).not.toHaveBeenCalled();
  });

  it("no rider whisper when the whole effect was consumed", async () => {
    const { alice, hazardToken, scene } = setup();
    await triggerTrap(trap(), { actor: alice, token: {} }, { hazardToken, scene });
    expect(gmWhispers().filter((w) => w.key.endsWith("RiderChat"))).toHaveLength(0);
  });

  it("whispers the GM instead of shrinking to the triggerer when geometry is missing", async () => {
    const alice = actor("p1", "Alice");
    await triggerTrap(trap(), { actor: alice, token: { id: "t" } });
    expect(alice.saves.reflex.roll).not.toHaveBeenCalled();
    expect(alice.applyDamage).not.toHaveBeenCalled();
    const [w] = gmWhispers();
    expect(w.key).toBe("PF2EDC.Dungeon.Trap.AreaUnavailableChat");
    expect(w.data.names).toBe("Alice");
    expect(w.whisper).toEqual(["gm-user"]);
  });
});

describe("#839 triggerTrap guard rail", () => {
  function geo(hazardText) {
    const alice = actor("p1", "Alice");
    const bob = actor("p2", "Bob");
    const orc = actor("o1", "Orc");
    const far = actor("p3", "Cora");
    const hazardToken = tokenDoc({ id: "hz" }, 0, 0, "hz-tok");
    const aliceTok = tokenDoc(alice, 0);
    const scene = sceneWith([hazardToken, aliceTok, tokenDoc(bob, 2), tokenDoc(orc, 3), tokenDoc(far, 10)]);
    const h = hazardActor({ items: [actionItem("Routine", hazardText)] });
    return { alice, bob, orc, far, hazardToken, aliceTok, scene, h };
  }

  it.each([
    ["an initiative-rolling routine", INITIATIVE_DESC],
    ["a save with no basic keyword", NO_BASIC_DESC],
    ["a basic save with no @Damage", NO_DAMAGE_DESC],
  ])("whispers the GM (only), naming every creature within 15 ft, for %s", async (_l, desc) => {
    const g = geo(desc);
    const result = await triggerTrap(g.h, { actor: g.alice, token: g.aliceTok.object }, { hazardToken: g.hazardToken, scene: g.scene });
    expect(result).toBeNull();
    for (const a of [g.alice, g.bob, g.orc, g.far]) {
      expect(a.saves.reflex.roll).not.toHaveBeenCalled();
      expect(a.applyDamage).not.toHaveBeenCalled();
    }
    expect(created).toHaveLength(1);
    expect(globalThis.ChatMessage.getWhisperRecipients).toHaveBeenCalledWith("GM");
    const [w] = gmWhispers();
    expect(w.whisper).toEqual(["gm-user"]);
    expect(w.key).toBe("PF2EDC.Dungeon.Trap.UnautomatedChat");
    expect(w.data.range).toBe("15");
    expect(w.data.description).toContain(desc.replace(/<[^>]+>/g, "").trim().slice(0, 18));
    expect(w.data.description).not.toContain("<");
    expect(w.data.names).toContain("Alice");
    expect(w.data.names).toContain("Bob");
    expect(w.data.names).toContain("Orc"); // not only party
    expect(w.data.names).not.toContain("Cora");
  });

  it("uses the hazard's own stated range when its text has one", async () => {
    const g = geo(INITIATIVE_AREA_DESC);
    await triggerTrap(g.h, { actor: g.alice, token: g.aliceTok.object }, { hazardToken: g.hazardToken, scene: g.scene });
    const [w] = gmWhispers();
    expect(w.data.range).toBe("10");
    expect(w.data.names).toContain("Bob"); // 2 squares = 10 ft: inside
    expect(w.data.names).not.toContain("Orc"); // 3 squares = 15 ft: outside
  });

  it("escapes hazard and creature names in the whisper", async () => {
    const g = geo(INITIATIVE_DESC);
    g.alice.name = "<img src=x>";
    g.h.name = "Trap <script>";
    await triggerTrap(g.h, { actor: g.alice, token: g.aliceTok.object }, { hazardToken: g.hazardToken, scene: g.scene });
    const [w] = gmWhispers();
    expect(w.data.names).not.toContain("<");
    expect(w.data.trap).not.toContain("<");
  });

  it("falls back to naming the triggerer, saying so, when no geometry is available", async () => {
    const alice = actor("p1", "Alice");
    const h = hazardActor({ items: [actionItem("Routine", INITIATIVE_DESC)] });
    await triggerTrap(h, { actor: alice, token: { id: "t" } });
    const [w] = gmWhispers();
    expect(w.key).toBe("PF2EDC.Dungeon.Trap.UnautomatedNoMapChat");
    expect(w.data.names).toBe("Alice");
  });
});

describe("#839 triggerTrap strike path is unchanged", () => {
  it("uses the strike and never the basic-save branch or the guard rail", async () => {
    const alice = actor("p1", "Alice");
    const damageRoll = { total: 7 };
    const strike = {
      type: "strike",
      ready: true,
      variants: [{ roll: vi.fn(async () => {}) }],
      damage: vi.fn(async () => damageRoll),
    };
    globalThis.game.messages.contents = [{ flags: { pf2e: { context: { outcome: "success" } } } }];
    const h = hazardActor({ actions: [strike], items: [actionItem("Zap", ELECTRIC_LATCH_DESC)] });
    const token = { id: "t" };
    const result = await triggerTrap(h, { actor: alice, token });
    expect(result).toBe("success");
    expect(strike.variants[0].roll).toHaveBeenCalledWith({ target: { document: token }, createMessage: true });
    expect(strike.damage).toHaveBeenCalled();
    expect(alice.applyDamage).toHaveBeenCalledWith({ damage: damageRoll, token, outcome: "success" });
    expect(alice.saves.reflex.roll).not.toHaveBeenCalled();
    expect(created).toHaveLength(0);
  });
});

describe("#839 classifyTrap counts basic-save actions", () => {
  const disable = `<p>@Check[thievery|dc:20] to disable</p>`;
  const base = (items) => ({
    system: { details: { disable, isComplex: false }, actions: [] },
    items,
  });
  it("marks a non-complex basic-save hazard with a disable check automatable", () => {
    const c = classifyTrap(base([actionItem("Steam", STEAM_VENTS_DESC)]));
    expect(c.basicSaveActionCount).toBe(1);
    expect(c.automatable).toBe(true);
  });
  it("leaves an initiative-rolling hazard non-automatable", () => {
    const c = classifyTrap(base([actionItem("Wheel", INITIATIVE_DESC)]));
    expect(c.basicSaveActionCount).toBe(0);
    expect(c.automatable).toBe(false);
  });
});
