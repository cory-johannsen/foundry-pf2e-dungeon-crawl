import { describe, it, expect, vi, beforeEach } from "vitest";
import { triggerTrap } from "../scripts/trap-combat.mjs";

// PF2e degreeOfSuccess: 0 critical failure .. 3 critical success.
const DEGREE = { criticalFailure: 0, failure: 1, success: 2, criticalSuccess: 3 };

const STEAM_VENTS_DESC = `Steam erupts from the pipes, dealing @Damage[3d6[bludgeoning],3d6[fire]] (@Check[reflex|dc:24|basic]) to all creatures within 15 feet.`;
const ELECTRIC_LATCH_DESC = `The trap deals @Damage[3d12[electricity]] damage to the triggering creature (@Check[reflex|dc:22|basic] save).`;
const INITIATIVE_DESC = `<p>The wheel begins to spin and <strong>rolls initiative</strong>.</p>`;
const NO_BASIC_DESC = `The slab deals @Damage[3d8[bludgeoning]] damage to anyone adjacent (@Check[reflex|dc:17] save).`;
const NO_DAMAGE_DESC = `Each creature must succeed at a @Check[will|dc:23|basic] save or be cursed.`;

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

function actionItem(name, description) {
  return { type: "action", name, system: { description: { value: description } } };
}

/** A party/hostile actor whose reflex save resolves to `outcome`. */
function actor(id, name, outcome) {
  return {
    id,
    name,
    saves: { reflex: { roll: vi.fn(async () => ({ degreeOfSuccess: DEGREE[outcome] })) } },
    applyDamage: vi.fn(async () => {}),
  };
}

/** A token DOCUMENT: pixel x/y, width/height in squares. */
function tokenDoc(a, gx, gy = 0) {
  return { actor: a, x: gx * 100, y: gy * 100, width: 1, height: 1, object: { id: `obj-${a.id}` } };
}

let partyMembers;
let createdMessages;

beforeEach(() => {
  partyMembers = [];
  createdMessages = [];
  globalThis.game = {
    user: { update: vi.fn(async () => {}), flags: {} },
    messages: { contents: [] },
    actors: { get: () => null, get party() { return { members: partyMembers }; } },
    i18n: { format: (k, d) => `${k}|${JSON.stringify(d)}` },
  };
  globalThis.ChatMessage = {
    create: vi.fn(async (m) => { createdMessages.push(m); }),
    getWhisperRecipients: vi.fn(() => ["gm-user"]),
  };
  // Deterministic dice: every NdM term rolls 20 (so a single 3d12 total is 20).
  globalThis.Roll = class {
    constructor(formula) { this.formula = formula; }
    async evaluate() { this.total = 20; return this; }
  };
});

function sceneWith(tokens) {
  return { grid: { size: 100, distance: 5 }, tokens };
}

describe("#839 triggerTrap basic-save branch: single target", () => {
  it("resolves against only the triggering creature, never other party members", async () => {
    const alice = actor("p1", "Alice", "failure");
    const bob = actor("p2", "Bob", "failure");
    partyMembers.push(alice, bob);
    const hazardToken = tokenDoc({ id: "hz" }, 0);
    const scene = sceneWith([hazardToken, tokenDoc(alice, 0), tokenDoc(bob, 1)]);
    const h = hazardActor({ items: [actionItem("Zap", ELECTRIC_LATCH_DESC)] });
    await triggerTrap(h, { actor: alice, token: scene.tokens[1].object }, { hazardToken, scene });
    expect(alice.saves.reflex.roll).toHaveBeenCalledOnce();
    expect(alice.saves.reflex.roll.mock.calls[0][0].dc).toEqual({ value: 22 });
    expect(alice.applyDamage).toHaveBeenCalledOnce();
    expect(bob.saves.reflex.roll).not.toHaveBeenCalled();
    expect(bob.applyDamage).not.toHaveBeenCalled();
    expect(createdMessages).toHaveLength(0);
  });

  it.each([
    ["criticalSuccess", 0],
    ["success", 10],
    ["failure", 20],
    ["criticalFailure", 40],
  ])("basic save %s applies %s damage (0 / half / full / double)", async (outcome, expected) => {
    const alice = actor("p1", "Alice", outcome);
    partyMembers.push(alice);
    const token = { id: "t" };
    const h = hazardActor({ items: [actionItem("Zap", ELECTRIC_LATCH_DESC)] });
    const result = await triggerTrap(h, { actor: alice, token });
    expect(result).toBe(outcome);
    if (expected === 0) {
      expect(alice.applyDamage).not.toHaveBeenCalled();
    } else {
      expect(alice.applyDamage).toHaveBeenCalledOnce();
      const arg = alice.applyDamage.mock.calls[0][0];
      expect(arg.damage).toBe(expected);
      expect(arg.token).toBe(token);
    }
  });

  it("falls back to the last chat message's outcome when the roll returns no degree", async () => {
    const alice = actor("p1", "Alice", "failure");
    alice.saves.reflex.roll = vi.fn(async () => undefined);
    globalThis.game.messages.contents = [{ flags: { pf2e: { context: { outcome: "criticalFailure" } } } }];
    const h = hazardActor({ items: [actionItem("Zap", ELECTRIC_LATCH_DESC)] });
    await triggerTrap(h, { actor: alice, token: { id: "t" } });
    expect(alice.applyDamage.mock.calls[0][0].damage).toBe(40);
  });

  it("does nothing at all for a disabled trap", async () => {
    const alice = actor("p1", "Alice", "failure");
    const h = hazardActor({ items: [actionItem("Zap", ELECTRIC_LATCH_DESC)], flags: { trapDisabled: true } });
    expect(await triggerTrap(h, { actor: alice, token: {} })).toBeNull();
    expect(alice.saves.reflex.roll).not.toHaveBeenCalled();
    expect(createdMessages).toHaveLength(0);
  });
});

describe("#839 triggerTrap basic-save branch: area", () => {
  it("hits every party member within range (incl. the triggerer), scaled per save, and nobody outside it", async () => {
    const alice = actor("p1", "Alice", "failure"); // triggerer, on the trap
    const bob = actor("p2", "Bob", "success"); // 3 squares = 15 ft: in range
    const far = actor("p3", "Cora", "criticalFailure"); // 4 squares = 20 ft: out
    const orc = actor("o1", "Orc", "criticalFailure"); // hostile, in range: not party
    partyMembers.push(alice, bob, far);
    const hazardToken = tokenDoc({ id: "hz" }, 0);
    const aliceToken = tokenDoc(alice, 0);
    const scene = sceneWith([
      hazardToken,
      aliceToken,
      tokenDoc(bob, 3),
      tokenDoc(far, 4),
      tokenDoc(orc, 1),
    ]);
    const h = hazardActor({ items: [actionItem("Steam Blast", STEAM_VENTS_DESC)] });
    const result = await triggerTrap(h, { actor: alice, token: aliceToken.object }, { hazardToken, scene });
    expect(result).toBe("failure");
    // two 3d6 terms, each rolls 20 in the mock -> 40 base
    expect(alice.applyDamage.mock.calls[0][0].damage).toBe(40);
    expect(bob.applyDamage.mock.calls[0][0].damage).toBe(20);
    expect(bob.applyDamage.mock.calls[0][0].token).toBe(scene.tokens[2].object);
    for (const outside of [far, orc]) {
      expect(outside.saves.reflex.roll).not.toHaveBeenCalled();
      expect(outside.applyDamage).not.toHaveBeenCalled();
    }
  });

  it("includes the triggering creature even if its token is not found in the scene list", async () => {
    const alice = actor("p1", "Alice", "failure");
    partyMembers.push(alice);
    const hazardToken = tokenDoc({ id: "hz" }, 0);
    const scene = sceneWith([hazardToken]);
    const h = hazardActor({ items: [actionItem("Steam Blast", STEAM_VENTS_DESC)] });
    await triggerTrap(h, { actor: alice, token: { id: "t" } }, { hazardToken, scene });
    expect(alice.applyDamage).toHaveBeenCalledOnce();
  });

  it("degrades to the triggering creature alone when hazard geometry is unavailable", async () => {
    const alice = actor("p1", "Alice", "failure");
    const bob = actor("p2", "Bob", "failure");
    partyMembers.push(alice, bob);
    const h = hazardActor({ items: [actionItem("Steam Blast", STEAM_VENTS_DESC)] });
    await triggerTrap(h, { actor: alice, token: { id: "t" } });
    expect(alice.applyDamage).toHaveBeenCalledOnce();
    expect(bob.applyDamage).not.toHaveBeenCalled();
  });
});

describe("#839 triggerTrap guard rail", () => {
  it.each([
    ["an initiative-rolling routine", INITIATIVE_DESC],
    ["a save with no basic keyword", NO_BASIC_DESC],
    ["a basic save with no @Damage", NO_DAMAGE_DESC],
  ])("whispers the GM (only) instead of automating %s", async (_label, desc) => {
    const alice = actor("p1", "Alice", "failure");
    const bob = actor("p2", "Bob", "failure");
    const far = actor("p3", "Cora", "failure");
    partyMembers.push(alice, bob, far);
    const hazardToken = tokenDoc({ id: "hz" }, 0);
    const aliceToken = tokenDoc(alice, 0);
    const scene = sceneWith([hazardToken, aliceToken, tokenDoc(bob, 2), tokenDoc(far, 10)]);
    const h = hazardActor({ items: [actionItem("Routine", desc)] });
    const result = await triggerTrap(h, { actor: alice, token: aliceToken.object }, { hazardToken, scene });
    expect(result).toBeNull();
    for (const a of [alice, bob, far]) {
      expect(a.saves.reflex.roll).not.toHaveBeenCalled();
      expect(a.applyDamage).not.toHaveBeenCalled();
    }
    expect(createdMessages).toHaveLength(1);
    const msg = createdMessages[0];
    expect(msg.whisper).toEqual(["gm-user"]);
    expect(globalThis.ChatMessage.getWhisperRecipients).toHaveBeenCalledWith("GM");
    const sep = msg.content.indexOf("|");
    const key = msg.content.slice(0, sep);
    const json = msg.content.slice(sep + 1);
    expect(key).toBe("PF2EDC.Dungeon.Trap.UnautomatedChat");
    const data = JSON.parse(json);
    expect(data.trap).toBe("Test Trap");
    // the hazard's own text, HTML stripped -- not just its name
    expect(data.description).toContain(desc.replace(/<[^>]+>/g, "").slice(0, 20));
    expect(data.description).not.toContain("<");
    // names only who is really in range
    expect(data.names).toContain("Alice");
    expect(data.names).toContain("Bob");
    expect(data.names).not.toContain("Cora");
  });

  it("names the triggering creature when no geometry is available", async () => {
    const alice = actor("p1", "Alice", "failure");
    const h = hazardActor({ items: [actionItem("Routine", INITIATIVE_DESC)] });
    await triggerTrap(h, { actor: alice, token: { id: "t" } });
    expect(JSON.parse(createdMessages[0].content.slice(createdMessages[0].content.indexOf("|") + 1)).names).toBe("Alice");
  });
});

describe("#839 triggerTrap strike path is unchanged", () => {
  it("uses the strike and never the basic-save branch or the guard rail", async () => {
    const alice = actor("p1", "Alice", "failure");
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
    expect(createdMessages).toHaveLength(0);
  });
});
