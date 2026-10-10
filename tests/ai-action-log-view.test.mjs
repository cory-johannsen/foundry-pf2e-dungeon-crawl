// #950: pure filtering/redaction for the AI Action Log window. Records use
// the real shape #925's recordAgentAction (dungeon-combat.mjs) writes.
import { describe, it, expect } from "vitest";
import { buildAiLogView, logCombatantLabel } from "../scripts/ui/ai-action-log-view.mjs";

const info = {
  c1: { name: "Goblin", img: "goblin.webp" },
  c2: { name: "Fighter", img: "fighter.webp" },
  c3: { name: "Shadow", img: "shadow.webp" },
};

function rec(over) {
  return {
    combatantId: "c1",
    tokenId: "t1",
    round: 1,
    turn: 0,
    index: 0,
    candidateId: "x",
    type: "strike",
    kind: null,
    cost: 1,
    summary: "Dagger",
    target: { id: "c2", name: "Fighter" },
    result: { text: "hit", tone: "success" },
    gmNote: null,
    rationale: null,
    source: "model",
    visibility: "all",
    ...over,
  };
}

const records = [
  rec({ rationale: "Closest.", gmNote: "DC 18" }),
  rec({ combatantId: "c2", tokenId: "t2", turn: 1, summary: "Longsword", target: { id: "c1", name: "Goblin" }, result: { text: "miss", tone: "failure" }, source: "fallback" }),
  rec({ combatantId: "c3", tokenId: "t3", round: 2, summary: "Claw", rationale: "Hidden monster logic.", visibility: "gm" }),
];

const ALL = { combatantId: null, round: null };

describe("buildAiLogView (#950)", () => {
  it("shows every row, with rationale, GM note and fallback tag, to a GM", () => {
    const view = buildAiLogView(records, info, { ...ALL, isGM: true });
    expect(view.rows).toHaveLength(3);
    expect(view.rows[0].rationale).toBe("Closest.");
    expect(view.rows[0].gmNote).toBe("DC 18");
    expect(view.rows[1].fallback).toBe(true);
    expect(view.rows[2].gmOnly).toBe(true);
  });

  it("drops GM-only rows and strips rationale/GM note/fallback for a non-GM", () => {
    const view = buildAiLogView(records, info, { ...ALL, isGM: false });
    expect(view.rows).toHaveLength(2);
    expect(view.rows.map((r) => r.combatantId)).toEqual(["c1", "c2"]);
    for (const row of view.rows) {
      expect(row.rationale).toBeNull();
      expect(row.gmNote).toBeNull();
      expect(row.fallback).toBe(false);
      expect(row.gmOnly).toBe(false);
      expect(row.source).toBeUndefined();
      expect(JSON.stringify(row)).not.toContain("Closest.");
      expect(JSON.stringify(row)).not.toContain("DC 18");
    }
  });

  it("builds the combatant/round option lists from visible rows only (never reveals the hidden actor to a player)", () => {
    const view = buildAiLogView(records, info, { ...ALL, isGM: false });
    expect(view.combatants).toEqual([
      { id: "c1", name: "Goblin" },
      { id: "c2", name: "Fighter" },
    ]);
    expect(view.rounds).toEqual([1]);
  });

  it("a GM sees the hidden actor and its round in the option lists", () => {
    const view = buildAiLogView(records, info, { ...ALL, isGM: true });
    expect(view.combatants.map((c) => c.id)).toEqual(["c1", "c2", "c3"]);
    expect(view.rounds).toEqual([1, 2]);
  });

  it("applies the combatant filter and marks the selected option", () => {
    const view = buildAiLogView(records, info, { combatantId: "c1", round: null, isGM: true });
    expect(view.rows).toHaveLength(1);
    expect(view.rows[0].combatantId).toBe("c1");
    expect(view.combatants.find((c) => c.id === "c1").selected).toBe(true);
    expect(view.selectedCombatantId).toBe("c1");
  });

  it("applies the round filter (a string round from a <select> works too)", () => {
    for (const round of [2, "2"]) {
      const view = buildAiLogView(records, info, { combatantId: null, round, isGM: true });
      expect(view.rows).toHaveLength(1);
      expect(view.rows[0].round).toBe(2);
      expect(view.selectedRound).toBe(2);
      expect(view.roundOptions.find((r) => r.value === 2).selected).toBe(true);
    }
  });

  it("a filter value absent from the visible log is treated as \"all\" (no rows silently hidden)", () => {
    const stale = buildAiLogView(records, info, { combatantId: "does-not-exist", round: 9, isGM: true });
    expect(stale.rows).toHaveLength(3);
    expect(stale.selectedCombatantId).toBeNull();
    expect(stale.selectedRound).toBeNull();
    // A player pre-filtered to the hidden actor sees everything they may see.
    const hidden = buildAiLogView(records, info, { combatantId: "c3", round: null, isGM: false });
    expect(hidden.rows).toHaveLength(2);
  });

  it("keeps log order, and carries what a row renders", () => {
    const view = buildAiLogView(records, info, { ...ALL, isGM: true });
    expect(view.rows.map((r) => r.summary)).toEqual(["Dagger", "Longsword", "Claw"]);
    expect(view.rows[0]).toMatchObject({
      combatantName: "Goblin",
      img: "goblin.webp",
      tokenId: "t1",
      round: 1,
      turn: 0,
      cost: 1,
      targetName: "Fighter",
      resultText: "hit",
      tone: "success",
    });
  });

  it("handles a malformed (non-array) log as empty", () => {
    for (const bad of [null, undefined, {}, "x"]) {
      expect(buildAiLogView(bad, info, { ...ALL, isGM: true })).toMatchObject({ rows: [], combatants: [], rounds: [] });
    }
  });

  it("skips malformed entries and fills missing fields with generic labels, never throws", () => {
    const view = buildAiLogView(
      [null, "junk", { combatantId: "ghost", round: 1 }],
      {},
      { ...ALL, isGM: true },
    );
    expect(view.rows).toHaveLength(1);
    expect(view.rows[0]).toMatchObject({
      combatantName: "Unknown",
      img: null,
      summary: "Action",
      targetName: null,
      resultText: "done",
      tone: "neutral",
      tokenId: null,
      cost: null,
    });
  });

  it("an unknown result tone renders as neutral", () => {
    const view = buildAiLogView([rec({ result: { text: "x", tone: "weird" } })], info, { ...ALL, isGM: true });
    expect(view.rows[0].tone).toBe("neutral");
  });
});

describe("logCombatantLabel (#950)", () => {
  const combatant = (playersCanSeeName) => ({ name: "Combatant", token: { name: "Ogre", playersCanSeeName } });

  it("uses the token name", () => {
    expect(logCombatantLabel(combatant(true), { isGM: false, hideNames: true })).toBe("Ogre");
  });

  it("hides a name PF2e hides from players", () => {
    expect(logCombatantLabel(combatant(false), { isGM: false, hideNames: true })).toBe("Unknown creature");
  });

  it("a GM always sees the real name; the setting off never hides it", () => {
    expect(logCombatantLabel(combatant(false), { isGM: true, hideNames: true })).toBe("Ogre");
    expect(logCombatantLabel(combatant(false), { isGM: false, hideNames: false })).toBe("Ogre");
  });

  it("falls back to the combatant name, then null", () => {
    expect(logCombatantLabel({ name: "Bob" }, { isGM: false, hideNames: false })).toBe("Bob");
    expect(logCombatantLabel(null, { isGM: false, hideNames: false })).toBeNull();
  });
});
