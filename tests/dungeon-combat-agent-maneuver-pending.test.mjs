import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  getPendingAgentTurn,
  setDemoralizeImmunityUntil,
} from "../scripts/dungeon-combat.mjs";

// #909: getPendingAgentTurn builds the turn's maneuver vocabulary from real
// actor data. Stub shape copied from dungeon-combat-downed-targets.test.mjs.

const G = 100;

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
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "debug").mockImplementation(() => {});
});

function mk(id, gx, gy, disposition, { type = "npc", skills = {}, size = "med", immunities = [], agent = true, held = true } = {}) {
  const flags = { agentControlled: agent };
  const items = held ? [{ type: "weapon", system: { equipped: { carryType: "held" } } }] : [];
  return {
    id,
    name: id,
    isDefeated: false,
    token: { x: gx * G, y: gy * G, disposition, width: 1, height: 1 },
    getFlag: (_m, k) => flags[k],
    actor: {
      type,
      conditions: [],
      items,
      skills,
      itemTypes: { weapon: [] },
      attributes: { immunities },
      system: {
        actions: [],
        traits: { size: { value: size } },
        attributes: { hp: { value: 20, max: 20 } },
        movement: { speeds: { land: { value: 30 } } },
      },
    },
  };
}

function mkCombat(combatants, current) {
  const flags = { dungeonSlot: "slot-1", reactionUsed: {} };
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
    scene: {
      id: "s",
      grid: { size: G, distance: 5 },
      width: 10 * G,
      height: 3 * G,
      tokens: [],
      walls: { contents: [] },
      regions: [],
    },
  };
}

const SKILLED = { athletics: {}, intimidation: {} };

describe("getPendingAgentTurn maneuver vocabulary (#909)", () => {
  it("includes all five maneuvers for an eligible attacker with an in-reach, visible opponent", async () => {
    const me = mk("atk", 0, 0, -1, { skills: SKILLED });
    const opp = mk("opp1", 1, 0, 1, { type: "character" });
    const pending = await getPendingAgentTurn(mkCombat([me, opp], me));
    expect(pending.maneuverVocabulary).toEqual([
      { type: "maneuver", slug: "trip", targetId: "opp1" },
      { type: "maneuver", slug: "shove", targetId: "opp1" },
      { type: "maneuver", slug: "grapple", targetId: "opp1" },
      { type: "maneuver", slug: "disarm", targetId: "opp1" },
      { type: "maneuver", slug: "demoralize", targetId: "opp1" },
    ]);
  });

  it("excludes disarm against an opponent holding nothing", async () => {
    const me = mk("atk", 0, 0, -1, { skills: SKILLED });
    const opp = mk("opp1", 1, 0, 1, { held: false });
    const pending = await getPendingAgentTurn(mkCombat([me, opp], me));
    expect(pending.maneuverVocabulary.map((v) => v.slug)).toEqual(["trip", "shove", "grapple", "demoralize"]);
  });

  it("returns an empty maneuverVocabulary for an attacker with no Athletics/Intimidation at all", async () => {
    const me = mk("atk", 0, 0, -1);
    const opp = mk("opp1", 1, 0, 1, { type: "character" });
    const pending = await getPendingAgentTurn(mkCombat([me, opp], me));
    expect(pending.maneuverVocabulary).toEqual([]);
  });

  it("offers only demoralize against an opponent beyond melee reach but within 30 ft, and nothing beyond 30 ft", async () => {
    const me = mk("atk", 0, 0, -1, { skills: SKILLED });
    const mid = mk("mid", 4, 0, 1, { type: "character" });
    const far = mk("far", 8, 0, 1, { type: "character" });
    const pending = await getPendingAgentTurn(mkCombat([me, mid, far], me));
    expect(pending.maneuverVocabulary).toEqual([
      { type: "maneuver", slug: "demoralize", targetId: "mid" },
    ]);
  });

  it("excludes the Athletics maneuvers against a target more than one size larger", async () => {
    const me = mk("atk", 0, 0, -1, { skills: SKILLED, size: "sm" });
    const big = mk("big", 1, 0, 1, { type: "character", size: "lg" });
    const pending = await getPendingAgentTurn(mkCombat([me, big], me));
    expect(pending.maneuverVocabulary.map((v) => v.slug)).toEqual(["demoralize"]);
  });

  it("excludes demoralize against a target immune to mental effects", async () => {
    const me = mk("atk", 0, 0, -1, { skills: SKILLED });
    const mindless = mk("opp1", 1, 0, 1, { immunities: [{ type: "mental" }] });
    const pending = await getPendingAgentTurn(mkCombat([me, mindless], me));
    expect(pending.maneuverVocabulary.map((v) => v.slug)).toEqual(["trip", "shove", "grapple", "disarm"]);
  });

  it("excludes demoralize while a recorded 10-minute immunity window is still active, and offers it again once it lapses", async () => {
    const me = mk("atk", 0, 0, -1, { skills: SKILLED });
    const opp = mk("opp1", 1, 0, 1, { type: "character" });
    const combat = mkCombat([me, opp], me);
    await setDemoralizeImmunityUntil(combat, "atk", "opp1", game.time.worldTime + 600);
    let pending = await getPendingAgentTurn(combat);
    expect(pending.maneuverVocabulary.some((v) => v.slug === "demoralize")).toBe(false);

    game.time.worldTime += 600;
    pending = await getPendingAgentTurn(combat);
    expect(pending.maneuverVocabulary.some((v) => v.slug === "demoralize")).toBe(true);
  });

  it("turns persisted maneuverPicks into real candidates only when they match the vocabulary", async () => {
    const me = mk("atk", 0, 0, -1, { skills: SKILLED });
    const opp = mk("opp1", 1, 0, 1, { type: "character" });
    const combat = mkCombat([me, opp], me);
    await combat.setFlag("pf2e-dungeon-crawl", "agentTurnState", {
      combatantId: "atk",
      round: 1,
      turn: 0,
      actionsRemaining: 3,
      mapIncrement: 0,
      maneuverPicks: [
        { type: "maneuver", slug: "trip", targetId: "opp1", rationale: "r" },
        { type: "maneuver", slug: "trip", targetId: "ghost", rationale: "r" },
      ],
      counter: 1,
    });
    const pending = await getPendingAgentTurn(combat);
    const maneuvers = pending.candidates.filter((c) => c.type === "maneuver");
    expect(maneuvers.map((c) => c.id)).toEqual(["maneuver:trip:opp1"]);
  });
});
