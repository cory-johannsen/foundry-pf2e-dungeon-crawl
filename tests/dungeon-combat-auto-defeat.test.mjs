import { describe, it, expect, beforeEach } from "vitest";
import {
  autoDefeatZeroHpNpcs,
  resolveSlotCombat,
} from "../scripts/dungeon-combat.mjs";
import { totalCombatXp } from "../scripts/combat-rewards.mjs";

let toggles;

function makeCombatant({
  id,
  actorId,
  type = "npc",
  hp = 0,
  isDefeated = false,
  disposition = -1,
  level = 3,
}) {
  const c = {
    id,
    actorId,
    tokenId: `tok-${id}`,
    isDefeated,
    token: { disposition, update: async () => {} },
    actor: {
      id: actorId,
      type,
      system: {
        attributes: { hp: { value: hp } },
        details: { level: { value: level } },
      },
      increaseCondition: async () => {},
      toObject: () => ({ items: [] }),
      inventory: { coins: {} },
    },
    toggleDefeated: async () => {
      toggles.push(id);
      c.isDefeated = !c.isDefeated;
    },
  };
  return c;
}

function makeCombat(combatants) {
  const flags = { dungeonSlot: 1 };
  return {
    id: "combat1",
    combatants,
    scene: {
      id: "scene1",
      tokens: [],
      deleteEmbeddedDocuments: async () => {},
    },
    getFlag: (_m, k) => flags[k],
    delete: async () => {},
  };
}

function install(combat, { isSelf = true } = {}) {
  globalThis.foundry = {
    audio: { AudioHelper: { play: () => ({ catch: () => {} }) } },
  };
  globalThis.Actor = {
    deleteDocuments: async () => {},
    createDocuments: async () => [],
  };
  globalThis.game = {
    user: { isGM: true },
    users: { activeGM: { isSelf } },
    actors: { party: { members: [{ id: "pc" }] } },
    combats: {
      find: (fn) => [combat].find(fn),
      filter: (fn) => [combat].filter(fn),
      has: () => true,
      contents: [combat],
    },
  };
}

beforeEach(() => {
  toggles = [];
});

describe("autoDefeatZeroHpNpcs (#476)", () => {
  it("marks a 0-HP NPC defeated", async () => {
    const npc = makeCombatant({ id: "n1", actorId: "a1", hp: 0 });
    install(makeCombat([npc]));
    await autoDefeatZeroHpNpcs(npc.actor);
    expect(toggles).toEqual(["n1"]);
  });

  it("leaves a 0-HP character untouched", async () => {
    const pc = makeCombatant({
      id: "p1",
      actorId: "pc",
      type: "character",
      hp: 0,
    });
    install(makeCombat([pc]));
    await autoDefeatZeroHpNpcs(pc.actor);
    expect(toggles).toEqual([]);
  });

  it("does nothing on a client that is not the active GM", async () => {
    const npc = makeCombatant({ id: "n1", actorId: "a1", hp: 0 });
    install(makeCombat([npc]), { isSelf: false });
    await autoDefeatZeroHpNpcs(npc.actor);
    expect(toggles).toEqual([]);
  });

  it("does not re-toggle an already-defeated NPC", async () => {
    const npc = makeCombatant({
      id: "n1",
      actorId: "a1",
      hp: 0,
      isDefeated: true,
    });
    install(makeCombat([npc]));
    await autoDefeatZeroHpNpcs(npc.actor);
    expect(toggles).toEqual([]);
  });

  it("leaves an NPC with HP > 0 untouched", async () => {
    const npc = makeCombatant({ id: "n1", actorId: "a1", hp: 5 });
    install(makeCombat([npc]));
    await autoDefeatZeroHpNpcs(npc.actor);
    expect(toggles).toEqual([]);
  });
});

describe("resolveCombat XP safety net (#476)", () => {
  it("grants XP for a 0-HP unflagged hostile", async () => {
    const npc = makeCombatant({ id: "n1", actorId: "a1", hp: 0, level: 3 });
    install(makeCombat([npc]));
    const grants = [];
    await resolveSlotCombat({ id: "scene1" }, 1, "victory", {
      partyLevel: async () => 3,
      grantPartyXp: async (xp) => grants.push(xp),
    });
    expect(grants).toHaveLength(1);
    expect(grants[0]).toBeGreaterThan(0);
    expect(grants[0]).toBe(totalCombatXp([3], 3));
  });

  it("names combat as the XP source so the party is told where it came from (#626)", async () => {
    const npc = makeCombatant({ id: "n1", actorId: "a1", hp: 0, level: 3 });
    install(makeCombat([npc]));
    const sources = [];
    await resolveSlotCombat({ id: "scene1" }, 1, "victory", {
      partyLevel: async () => 3,
      grantPartyXp: async (_xp, source) => sources.push(source),
    });
    expect(sources).toEqual(["combat"]);
  });

  it("grants no XP for a living unflagged hostile (party fled)", async () => {
    const npc = makeCombatant({ id: "n1", actorId: "a1", hp: 7, level: 3 });
    install(makeCombat([npc]));
    const grants = [];
    await resolveSlotCombat({ id: "scene1" }, 1, "victory", {
      partyLevel: async () => 3,
      grantPartyXp: async (xp) => grants.push(xp),
    });
    expect(grants).toEqual([0]);
  });
});
