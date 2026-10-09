import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  recordAntagonizeFloor,
  handleDemoralizeForAntagonize,
  handleAntagonizeHostileMessage,
  clearAntagonizeOnHostileAction,
  sweepAntagonizeFloors,
  handleFrightenedRemovedForAntagonize,
  clearAntagonizeForCombat,
} from "../scripts/dungeon-combat.mjs";

// #920: Antagonize's Foundry-side lifecycle. Message shapes follow the live
// world's real pf2e 8.5.0 chat messages: `speaker.token` is the roller's
// token id, `flags.pf2e.context.target.token` a "Scene.<id>.Token.<id>" UUID
// (null on the AI's own numeric-DC Demoralize), `context.origin.token` the
// same UUID form on a saving throw.

const MODULE_ID = "pf2e-dungeon-crawl";

/** An actor double whose setFlag/unsetFlag honour dotted keys the way
 * Foundry's update does (verified live on v14.368). */
function makeActor({ name, uuid, feats = [], antagonize, frightened = 1 } = {}) {
  const actor = {
    name,
    uuid,
    items: feats.map((slug) => ({ type: "feat", slug })),
    flags: { [MODULE_ID]: antagonize ? { antagonize: structuredClone(antagonize) } : {} },
    getCondition: vi.fn((slug) => (slug === "frightened" && frightened ? { value: frightened } : null)),
  };
  actor.setFlag = vi.fn(async (scope, key, value) => {
    const path = key.split(".");
    let node = actor.flags[scope];
    for (const part of path.slice(0, -1)) node = node[part] ??= {};
    node[path.at(-1)] = structuredClone(value);
  });
  actor.unsetFlag = vi.fn(async (scope, key) => {
    const path = key.split(".");
    let node = actor.flags[scope];
    for (const part of path.slice(0, -1)) node = node?.[part];
    if (node) delete node[path.at(-1)];
  });
  return actor;
}

function makeCombatant(id, tokenId, actor, extra = {}) {
  return { id, tokenId, name: actor.name, actor, isDefeated: false, ...extra };
}

const ENTRY = { antagonizerUuid: "Actor.swash", sinceWorldTime: 100, unsensedSince: null };

let combat;
let swash;
let ogre;
let goblin;

function installWorld({ swashFeats = ["antagonize"], ogreAntagonize, ogreFrightened = 1, detection = null } = {}) {
  swash = makeCombatant("cSwash", "tSwash", makeActor({ name: "Swash", uuid: "Actor.swash", feats: swashFeats }));
  ogre = makeCombatant(
    "cOgre",
    "tOgre",
    makeActor({ name: "Ogre", uuid: "Scene.s1.Token.tOgre.Actor.ogre", antagonize: ogreAntagonize, frightened: ogreFrightened }),
  );
  goblin = makeCombatant("cGob", "tGob", makeActor({ name: "Goblin", uuid: "Actor.gob" }));
  combat = {
    id: "combat1",
    round: 2,
    turn: 1,
    scene: { id: "s1" },
    combatants: [swash, ogre, goblin],
    getFlag: vi.fn((_scope, key) => (key === "detection" ? detection : undefined)),
  };
  globalThis.game = {
    users: { activeGM: { isSelf: true } },
    user: { isGM: true },
    combats: { contents: [combat] },
    time: { worldTime: 500 },
  };
  globalThis.ChatMessage = { getWhisperRecipients: () => [{ id: "gm" }], create: vi.fn(async () => {}) };
  globalThis.foundry = { utils: { escapeHTML: (v) => v } };
}

const antagonizeOf = (combatant) => combatant.actor.flags[MODULE_ID].antagonize;

beforeEach(() => installWorld());
afterEach(() => {
  vi.restoreAllMocks();
  delete globalThis.game;
  delete globalThis.ChatMessage;
  delete globalThis.foundry;
});

function demoralizeMessage({ outcome = "success", targetToken = "Scene.s1.Token.tOgre", options = ["action:demoralize"] } = {}) {
  return {
    speaker: { scene: "s1", token: "tSwash" },
    flags: {
      pf2e: {
        context: {
          type: "skill-check",
          options,
          outcome,
          target: targetToken ? { actor: "Scene.s1.Token.tOgre.Actor.ogre", token: targetToken } : null,
        },
      },
    },
  };
}

describe("recordAntagonizeFloor", () => {
  it("records an entry keyed by the antagonizer's combatant id when it has the feat", async () => {
    expect(await recordAntagonizeFloor(swash, ogre)).toBe(true);
    expect(ogre.actor.setFlag).toHaveBeenCalledWith(MODULE_ID, "antagonize.cSwash", {
      antagonizerUuid: "Actor.swash",
      sinceWorldTime: 500,
      unsensedSince: null,
    });
  });

  it("records nothing when the Demoralizer lacks the feat", async () => {
    installWorld({ swashFeats: [] });
    expect(await recordAntagonizeFloor(swash, ogre)).toBe(false);
    expect(ogre.actor.setFlag).not.toHaveBeenCalled();
  });

  it("reports and returns false (never throws) when the flag write fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    ogre.actor.setFlag.mockRejectedValue(new Error("denied"));
    await expect(recordAntagonizeFloor(swash, ogre)).resolves.toBe(false);
    expect(ChatMessage.create).toHaveBeenCalled();
  });
});

describe("handleDemoralizeForAntagonize", () => {
  it("creates the floor on a successful targeted Demoralize", async () => {
    await handleDemoralizeForAntagonize(demoralizeMessage());
    expect(antagonizeOf(ogre)).toEqual({ cSwash: { antagonizerUuid: "Actor.swash", sinceWorldTime: 500, unsensedSince: null } });
    expect(ChatMessage.create).toHaveBeenCalledTimes(1);
  });

  it("creates the floor on a critical success too", async () => {
    await handleDemoralizeForAntagonize(demoralizeMessage({ outcome: "criticalSuccess" }));
    expect(antagonizeOf(ogre)).toHaveProperty("cSwash");
  });

  it("never creates a floor on a failure or critical failure", async () => {
    await handleDemoralizeForAntagonize(demoralizeMessage({ outcome: "failure" }));
    await handleDemoralizeForAntagonize(demoralizeMessage({ outcome: "criticalFailure" }));
    expect(ogre.actor.setFlag).not.toHaveBeenCalled();
  });

  it("does nothing for a Demoralizer without the feat", async () => {
    installWorld({ swashFeats: [] });
    await handleDemoralizeForAntagonize(demoralizeMessage());
    expect(ogre.actor.setFlag).not.toHaveBeenCalled();
  });

  it("does nothing for a non-Demoralize skill check", async () => {
    await handleDemoralizeForAntagonize(demoralizeMessage({ options: ["action:feint"] }));
    expect(ogre.actor.setFlag).not.toHaveBeenCalled();
  });

  it("does nothing for an untargeted message (the AI's own Demoralize shape)", async () => {
    await handleDemoralizeForAntagonize(demoralizeMessage({ targetToken: null }));
    expect(ogre.actor.setFlag).not.toHaveBeenCalled();
  });

  it("keeps another antagonizer's existing entry", async () => {
    installWorld({ ogreAntagonize: { cOther: ENTRY } });
    await handleDemoralizeForAntagonize(demoralizeMessage());
    expect(Object.keys(antagonizeOf(ogre)).sort()).toEqual(["cOther", "cSwash"]);
  });

  it("does nothing on a client that is not the active GM", async () => {
    game.users.activeGM.isSelf = false;
    await handleDemoralizeForAntagonize(demoralizeMessage());
    expect(ogre.actor.setFlag).not.toHaveBeenCalled();
  });
});

function rollMessage({ type = "attack-roll", from = "tOgre", targetToken = "Scene.s1.Token.tSwash", options = [] } = {}) {
  return {
    speaker: { scene: "s1", token: from },
    flags: { pf2e: { context: { type, options, target: targetToken ? { token: targetToken } : null } } },
  };
}

describe("handleAntagonizeHostileMessage", () => {
  beforeEach(() => installWorld({ ogreAntagonize: { cSwash: ENTRY } }));

  it("ends the floor when the frightened creature attacks its antagonizer", async () => {
    await handleAntagonizeHostileMessage(rollMessage({ type: "attack-roll" }));
    expect(ogre.actor.unsetFlag).toHaveBeenCalledWith(MODULE_ID, "antagonize");
    expect(antagonizeOf(ogre)).toBeUndefined();
  });

  it("ends it on a spell attack roll, a damage roll, or a hostile skill check too", async () => {
    for (const msg of [
      rollMessage({ type: "spell-attack-roll" }),
      rollMessage({ type: "damage-roll" }),
      rollMessage({ type: "skill-check", options: ["action:trip", "item:trait:attack"] }),
    ]) {
      installWorld({ ogreAntagonize: { cSwash: ENTRY } });
      await handleAntagonizeHostileMessage(msg);
      expect(antagonizeOf(ogre)).toBeUndefined();
    }
  });

  it("ends it when the antagonizer saves against an effect the frightened creature originated", async () => {
    await handleAntagonizeHostileMessage({
      speaker: { scene: "s1", token: "tSwash" },
      flags: { pf2e: { context: { type: "saving-throw", origin: { token: "Scene.s1.Token.tOgre" }, target: { token: "Scene.s1.Token.tSwash" } } } },
    });
    expect(antagonizeOf(ogre)).toBeUndefined();
  });

  it("never clears a floor for an attack against someone else", async () => {
    await handleAntagonizeHostileMessage(rollMessage({ targetToken: "Scene.s1.Token.tGob" }));
    expect(ogre.actor.unsetFlag).not.toHaveBeenCalled();
  });

  it("ignores a non-hostile check against the antagonizer", async () => {
    await handleAntagonizeHostileMessage(rollMessage({ type: "skill-check", options: ["action:request"] }));
    await handleAntagonizeHostileMessage(rollMessage({ type: "perception-check" }));
    expect(ogre.actor.unsetFlag).not.toHaveBeenCalled();
  });

  it("ignores the antagonizer attacking the frightened creature (wrong direction)", async () => {
    await handleAntagonizeHostileMessage(rollMessage({ from: "tSwash", targetToken: "Scene.s1.Token.tOgre" }));
    expect(ogre.actor.unsetFlag).not.toHaveBeenCalled();
  });

  it("clears only the attacked antagonizer's entry, keeping others", async () => {
    installWorld({ ogreAntagonize: { cSwash: ENTRY, cGob: { ...ENTRY, antagonizerUuid: "Actor.gob" } } });
    await handleAntagonizeHostileMessage(rollMessage());
    expect(ogre.actor.unsetFlag).toHaveBeenCalledWith(MODULE_ID, "antagonize.cSwash");
    expect(Object.keys(antagonizeOf(ogre))).toEqual(["cGob"]);
  });
});

describe("clearAntagonizeOnHostileAction (the AI decision path)", () => {
  it("clears the floors held by the action's targets only", async () => {
    installWorld({ ogreAntagonize: { cSwash: ENTRY, cGob: ENTRY } });
    await clearAntagonizeOnHostileAction(combat, ogre, ["cGob"]);
    expect(Object.keys(antagonizeOf(ogre))).toEqual(["cSwash"]);
  });

  it("does nothing when the creature holds no floors", async () => {
    await clearAntagonizeOnHostileAction(combat, ogre, ["cSwash"]);
    expect(ogre.actor.unsetFlag).not.toHaveBeenCalled();
  });
});

describe("sweepAntagonizeFloors", () => {
  it("keeps a floor while the antagonizer is observed (no detection matrix)", async () => {
    installWorld({ ogreAntagonize: { cSwash: ENTRY } });
    await sweepAntagonizeFloors(combat);
    expect(antagonizeOf(ogre)).toEqual({ cSwash: ENTRY });
    expect(ogre.actor.unsetFlag).not.toHaveBeenCalled();
  });

  it("treats a hidden antagonizer as still sensed", async () => {
    installWorld({ ogreAntagonize: { cSwash: ENTRY }, detection: { cSwash: { cOgre: "hidden" } } });
    await sweepAntagonizeFloors(combat);
    expect(antagonizeOf(ogre).cSwash.unsensedSince).toBeNull();
  });

  it("starts the clock when the antagonizer becomes undetected, then ends the floor a full round later", async () => {
    installWorld({ ogreAntagonize: { cSwash: ENTRY }, detection: { cSwash: { cOgre: "undetected" } } });
    await sweepAntagonizeFloors(combat);
    expect(antagonizeOf(ogre).cSwash.unsensedSince).toEqual({ round: 2, turn: 1 });

    combat.turn = 2; // later the same round: still held
    await sweepAntagonizeFloors(combat);
    expect(antagonizeOf(ogre).cSwash.unsensedSince).toEqual({ round: 2, turn: 1 });

    combat.round = 3;
    combat.turn = 0; // next round, before the same initiative position: still held
    await sweepAntagonizeFloors(combat);
    expect(antagonizeOf(ogre)).toHaveProperty("cSwash");

    combat.turn = 1; // a full round without sensing
    await sweepAntagonizeFloors(combat);
    expect(antagonizeOf(ogre)).toBeUndefined();
  });

  it("resets the clock once the antagonizer is sensed again", async () => {
    installWorld({
      ogreAntagonize: { cSwash: { ...ENTRY, unsensedSince: { round: 1, turn: 1 } } },
      detection: { cSwash: { cOgre: "observed" } },
    });
    await sweepAntagonizeFloors(combat);
    expect(antagonizeOf(ogre).cSwash.unsensedSince).toBeNull();
  });

  it("only ends the floor of the antagonizer that is no longer sensed", async () => {
    installWorld({
      ogreAntagonize: { cSwash: { ...ENTRY, unsensedSince: { round: 1, turn: 1 } }, cGob: ENTRY },
      detection: { cSwash: { cOgre: "unnoticed" } },
    });
    await sweepAntagonizeFloors(combat);
    expect(Object.keys(antagonizeOf(ogre))).toEqual(["cGob"]);
  });

  it("clears every floor once the creature is no longer Frightened", async () => {
    installWorld({ ogreAntagonize: { cSwash: ENTRY }, ogreFrightened: 0 });
    await sweepAntagonizeFloors(combat);
    expect(antagonizeOf(ogre)).toBeUndefined();
  });

  it("clears every floor once the creature is defeated", async () => {
    installWorld({ ogreAntagonize: { cSwash: ENTRY } });
    ogre.isDefeated = true;
    await sweepAntagonizeFloors(combat);
    expect(antagonizeOf(ogre)).toBeUndefined();
  });

  it("clears a floor whose antagonizer is defeated or gone from the combat", async () => {
    installWorld({ ogreAntagonize: { cSwash: ENTRY, cGone: ENTRY } });
    swash.isDefeated = true;
    await sweepAntagonizeFloors(combat);
    expect(antagonizeOf(ogre)).toBeUndefined();
  });

  it("does nothing on a client that is not the active GM", async () => {
    installWorld({ ogreAntagonize: { cSwash: ENTRY }, ogreFrightened: 0 });
    game.users.activeGM.isSelf = false;
    await sweepAntagonizeFloors(combat);
    expect(ogre.actor.unsetFlag).not.toHaveBeenCalled();
  });

  it("logs and leaves the floor alone when evaluating it throws", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    installWorld({ ogreAntagonize: { cSwash: ENTRY } });
    ogre.actor.getCondition.mockImplementation(() => {
      throw new Error("gone");
    });
    await sweepAntagonizeFloors(combat);
    expect(antagonizeOf(ogre)).toEqual({ cSwash: ENTRY });
    expect(err).toHaveBeenCalled();
  });
});

describe("handleFrightenedRemovedForAntagonize", () => {
  it("clears the floors when Frightened is deleted", async () => {
    installWorld({ ogreAntagonize: { cSwash: ENTRY }, ogreFrightened: 0 });
    await handleFrightenedRemovedForAntagonize({ type: "condition", slug: "frightened", actor: ogre.actor });
    expect(antagonizeOf(ogre)).toBeUndefined();
  });

  it("ignores other deleted items", async () => {
    installWorld({ ogreAntagonize: { cSwash: ENTRY }, ogreFrightened: 0 });
    await handleFrightenedRemovedForAntagonize({ type: "condition", slug: "off-guard", actor: ogre.actor });
    await handleFrightenedRemovedForAntagonize({ type: "effect", slug: "frightened", actor: ogre.actor });
    expect(ogre.actor.unsetFlag).not.toHaveBeenCalled();
  });
});

describe("clearAntagonizeForCombat", () => {
  it("clears every combatant's floors when the combat is deleted, even while still Frightened", async () => {
    installWorld({ ogreAntagonize: { cSwash: ENTRY } });
    await clearAntagonizeForCombat(combat);
    expect(antagonizeOf(ogre)).toBeUndefined();
    expect(swash.actor.unsetFlag).not.toHaveBeenCalled();
  });
});
