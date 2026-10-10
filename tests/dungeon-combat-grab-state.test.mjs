// tests/dungeon-combat-grab-state.test.mjs
import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  recordGrab,
  clearGrab,
  clearGrabsInvolving,
  currentGrabTarget,
  grabRecordOf,
  releaseGrab,
  handleGrabConditionRemoved,
  resolveGrabRider,
} from "../scripts/dungeon-strike-riders.mjs";

// #933: who-grabbed-whom tracking. PF2e's increaseCondition("grabbed")
// carries no origin, so the module records the grab itself (on the Combat
// document) wherever it applies Grabbed/Restrained on purpose, and every
// grab follow-up reads it back through currentGrabTarget's staleness checks.

function combatant(id, { conditions = [] } = {}) {
  const actor = {
    uuid: `Actor.${id}`,
    conditions: conditions.map((slug) => ({ slug })),
    decreaseCondition: vi.fn(async function (slug) {
      this.conditions = this.conditions.filter((c) => c.slug !== slug);
    }),
  };
  return { id, name: id, isDefeated: false, actor };
}

function makeCombat(combatants) {
  const flags = {};
  return {
    round: 2,
    combatants,
    getFlag: (_m, key) => flags[key],
    setFlag: vi.fn(async (_m, key, value) => {
      flags[key] = value;
    }),
  };
}

beforeEach(() => {
  globalThis.game = { messages: { contents: [] } };
  globalThis.ChatMessage = { create: vi.fn(async () => {}), getWhisperRecipients: () => [] };
  globalThis.foundry = { utils: { escapeHTML: (v) => v } };
});

describe("grab-state records", () => {
  it("records the target, its actor, the grabbing limb and the round", async () => {
    const croc = combatant("croc");
    const pc = combatant("pc", { conditions: ["grabbed"] });
    const combat = makeCombat([croc, pc]);
    await recordGrab(combat, croc, pc, { limb: "Jaws" });
    expect(grabRecordOf(combat, "croc")).toEqual({ targetId: "pc", targetActorUuid: "Actor.pc", limb: "jaws", round: 2 });
    expect(currentGrabTarget(combat, croc)).toEqual({ record: grabRecordOf(combat, "croc"), target: pc });
  });

  it("keeps one grab per grabber (a new grab replaces the old record)", async () => {
    const croc = combatant("croc");
    const a = combatant("a", { conditions: ["grabbed"] });
    const b = combatant("b", { conditions: ["grabbed"] });
    const combat = makeCombat([croc, a, b]);
    await recordGrab(combat, croc, a);
    await recordGrab(combat, croc, b);
    expect(grabRecordOf(combat, "croc").targetId).toBe("b");
  });

  it("clearGrab forgets the record; null when nothing was ever recorded", async () => {
    const croc = combatant("croc");
    const pc = combatant("pc", { conditions: ["grabbed"] });
    const combat = makeCombat([croc, pc]);
    expect(currentGrabTarget(combat, croc)).toBeNull();
    await recordGrab(combat, croc, pc);
    await clearGrab(combat, "croc");
    expect(grabRecordOf(combat, "croc")).toBeNull();
  });

  it("a Restrained target (critical Grapple) still counts as held", async () => {
    const croc = combatant("croc");
    const pc = combatant("pc", { conditions: ["restrained"] });
    const combat = makeCombat([croc, pc]);
    await recordGrab(combat, croc, pc);
    expect(currentGrabTarget(combat, croc)?.target).toBe(pc);
  });

  it("is stale (null) once the target lost the condition, was defeated, or left, or the grabber was defeated", async () => {
    const croc = combatant("croc");
    const pc = combatant("pc", { conditions: ["grabbed"] });
    const combat = makeCombat([croc, pc]);
    await recordGrab(combat, croc, pc);
    pc.actor.conditions = [];
    expect(currentGrabTarget(combat, croc)).toBeNull();
    pc.actor.conditions = [{ slug: "grabbed" }];
    pc.isDefeated = true;
    expect(currentGrabTarget(combat, croc)).toBeNull();
    pc.isDefeated = false;
    croc.isDefeated = true;
    expect(currentGrabTarget(combat, croc)).toBeNull();
    croc.isDefeated = false;
    combat.combatants = [croc];
    expect(currentGrabTarget(combat, croc)).toBeNull();
  });

  it("clearGrabsInvolving drops records where the creature is grabber or target (defeat)", async () => {
    const croc = combatant("croc");
    const tiger = combatant("tiger");
    const pc = combatant("pc", { conditions: ["grabbed"] });
    const fighter = combatant("fighter", { conditions: ["grabbed"] });
    const combat = makeCombat([croc, tiger, pc, fighter]);
    await recordGrab(combat, croc, pc);
    await recordGrab(combat, tiger, fighter);
    await clearGrabsInvolving(combat, "pc");
    expect(grabRecordOf(combat, "croc")).toBeNull();
    expect(grabRecordOf(combat, "tiger")).not.toBeNull();
    await clearGrabsInvolving(combat, "tiger");
    expect(grabRecordOf(combat, "tiger")).toBeNull();
  });
});

describe("releaseGrab (the grabber moves; Death Roll's 'it releases the creature')", () => {
  it("removes Grabbed/Restrained from the target and forgets the record", async () => {
    const croc = combatant("croc");
    const pc = combatant("pc", { conditions: ["grabbed"] });
    const combat = makeCombat([croc, pc]);
    await recordGrab(combat, croc, pc);
    expect(await releaseGrab(combat, croc)).toBe(true);
    expect(pc.actor.decreaseCondition).toHaveBeenCalledWith("grabbed", { forceRemove: true });
    expect(pc.actor.conditions).toEqual([]);
    expect(grabRecordOf(combat, "croc")).toBeNull();
  });

  it("does nothing for a creature holding no one", async () => {
    const croc = combatant("croc");
    const pc = combatant("pc", { conditions: ["grabbed"] });
    const combat = makeCombat([croc, pc]);
    expect(await releaseGrab(combat, croc)).toBe(false);
    expect(pc.actor.decreaseCondition).not.toHaveBeenCalled();
  });
});

describe("handleGrabConditionRemoved (deleteItem hook)", () => {
  it("forgets every record targeting the actor whose Grabbed was removed", async () => {
    const croc = combatant("croc");
    const pc = combatant("pc", { conditions: ["grabbed"] });
    const combat = makeCombat([croc, pc]);
    await recordGrab(combat, croc, pc);
    pc.actor.conditions = [];
    await handleGrabConditionRemoved({ type: "condition", slug: "grabbed", parent: pc.actor }, { combats: [combat] });
    expect(grabRecordOf(combat, "croc")).toBeNull();
  });

  it("keeps the record while the actor still carries Restrained", async () => {
    const croc = combatant("croc");
    const pc = combatant("pc", { conditions: ["restrained"] });
    const combat = makeCombat([croc, pc]);
    await recordGrab(combat, croc, pc);
    await handleGrabConditionRemoved({ type: "condition", slug: "grabbed", parent: pc.actor }, { combats: [combat] });
    expect(grabRecordOf(combat, "croc")).not.toBeNull();
  });

  it("ignores other conditions and non-GM clients", async () => {
    const croc = combatant("croc");
    const pc = combatant("pc");
    const combat = makeCombat([croc, pc]);
    await recordGrab(combat, croc, pc);
    await handleGrabConditionRemoved({ type: "condition", slug: "prone", parent: pc.actor }, { combats: [combat] });
    await handleGrabConditionRemoved({ type: "condition", slug: "grabbed", parent: pc.actor }, { combats: [combat], isGm: false });
    expect(grabRecordOf(combat, "croc")).not.toBeNull();
  });
});

describe("resolveGrabRider records the grab", () => {
  function attacker(outcome) {
    return {
      id: "croc",
      name: "Croc",
      actor: {
        items: [{ type: "action", name: "Grab", system: { slug: "grab" } }],
        skills: {
          athletics: {
            roll: async () => {
              game.messages.contents.push({ flags: { pf2e: { context: { outcome } } } });
            },
          },
        },
      },
    };
  }
  const strike = { label: "Jaws", item: { type: "melee", slug: "jaws", system: { attackEffects: { value: ["grab"] } } } };

  it("records (grabber, target, limb) on a successful grab", async () => {
    const pc = combatant("pc");
    pc.actor.saves = { fortitude: { dc: { value: 18 } } };
    pc.actor.increaseCondition = vi.fn(async () => {});
    const croc = attacker("success");
    const combat = makeCombat([croc, pc]);
    await resolveGrabRider(croc, pc, strike, "success", combat);
    expect(grabRecordOf(combat, "croc")).toMatchObject({ targetId: "pc", limb: "jaws" });
  });

  it("records nothing when the grab's Athletics check fails", async () => {
    const pc = combatant("pc");
    pc.actor.saves = { fortitude: { dc: { value: 18 } } };
    pc.actor.increaseCondition = vi.fn(async () => {});
    const croc = attacker("failure");
    const combat = makeCombat([croc, pc]);
    await resolveGrabRider(croc, pc, strike, "success", combat);
    expect(grabRecordOf(combat, "croc")).toBeNull();
  });
});
