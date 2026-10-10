// #950: pure filtering/redaction for the AI Action Log window. Records use
// the real shape #925's recordAgentAction (dungeon-combat.mjs) writes.
import { describe, it, expect } from "vitest";
import { buildAiLogView, logCombatantLabel, visibleRecords } from "../scripts/ui/ai-action-log-view.mjs";

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

describe("visibleRecords (#951: the shared visibility rule)", () => {
  it("returns a GM every well-formed record unchanged, in log order", () => {
    const out = visibleRecords(records, true);
    expect(out).toHaveLength(3);
    expect(out[0]).toBe(records[0]);
    expect(out.map((r) => r.summary)).toEqual(["Dagger", "Longsword", "Claw"]);
  });

  it("drops GM-only records for a non-GM and strips every GM-only field", () => {
    const out = visibleRecords(records, false);
    expect(out.map((r) => r.combatantId)).toEqual(["c1", "c2"]);
    for (const r of out) {
      expect(r).not.toHaveProperty("rationale");
      expect(r).not.toHaveProperty("gmNote");
      expect(r).not.toHaveProperty("source");
      expect(r).not.toHaveProperty("candidateId");
      expect(JSON.stringify(r)).not.toContain("Closest.");
      expect(JSON.stringify(r)).not.toContain("DC 18");
    }
    expect(out[0]).toMatchObject({ summary: "Dagger", target: { id: "c2", name: "Fighter" }, result: { text: "hit", tone: "success" }, round: 1, index: 0 });
  });

  it("never mutates the stored records", () => {
    const copy = JSON.parse(JSON.stringify(records));
    visibleRecords(records, false);
    expect(records).toEqual(copy);
  });

  it("treats anything but true as non-GM", () => {
    for (const isGM of [undefined, null, "yes", 1]) {
      expect(visibleRecords(records, isGM).some((r) => r.visibility === "gm")).toBe(false);
    }
  });

  it("reads a malformed log as empty and skips malformed entries", () => {
    for (const bad of [null, undefined, {}, "x"]) expect(visibleRecords(bad, true)).toEqual([]);
    expect(visibleRecords([null, "junk", 3, { combatantId: "c1" }], false)).toEqual([{ combatantId: "c1" }]);
  });

  it("buildAiLogView shows exactly the records visibleRecords lets through", () => {
    for (const isGM of [true, false]) {
      const view = buildAiLogView(records, info, { ...ALL, isGM });
      expect(view.rows.map((r) => r.summary)).toEqual(visibleRecords(records, isGM).map((r) => r.summary));
    }
  });
});

describe("decision details (#952)", () => {
  const detailed = [
    rec({
      alternatives: [{ id: "x", summary: "Dagger vs Fighter", chosen: true }, { id: "y", summary: "Secret flank route", chosen: false }],
      moreCount: 4,
      meta: { provider: "litellm", model: "secret-model", tier: "fast", clientMs: 1200, serverMs: 1000, usage: { totalTokens: 50 }, costUsd: 0.5 },
    }),
    rec({ index: 1, source: "fallback", fallbackReason: "error", meta: { provider: "heuristic" } }),
  ];
  const DETAIL_FIELDS = ["alternatives", "moreCount", "meta", "fallbackReason", "candidateId", "source", "rationale", "gmNote"];

  it("visibleRecords never gives a non-GM the alternatives, meta or fallback reason", () => {
    for (const r of visibleRecords(detailed, false)) {
      for (const field of DETAIL_FIELDS) expect(r).not.toHaveProperty(field);
      const json = JSON.stringify(r);
      for (const secret of ["Secret flank route", "secret-model", "litellm", "heuristic", "error"]) expect(json).not.toContain(secret);
    }
    // Only an explicit `true` is a GM.
    for (const r of visibleRecords(detailed, "yes")) expect(r).not.toHaveProperty("meta");
  });

  it("visibleRecords keeps them for a GM", () => {
    const [first, second] = visibleRecords(detailed, true);
    expect(first.alternatives).toHaveLength(2);
    expect(first.meta.provider).toBe("litellm");
    expect(second.fallbackReason).toBe("error");
  });

  it("gives each GM row a collapsed Details disclosure and every non-GM row none", () => {
    const gm = buildAiLogView(detailed, info, { ...ALL, isGM: true });
    expect(gm.rows[0].detailsHtml).toMatch(/^<details class="pf2edc-ai-details"><summary>Details<\/summary>/);
    expect(gm.rows[0].detailsHtml).toContain("Secret flank route");
    expect(gm.rows[0].detailsHtml).toContain("+4 more");
    expect(gm.rows[0].detailsHtml).toContain("Latency: 1.2 s (server 1.0 s)");
    expect(gm.rows[1].detailsHtml).toContain("Fallback: the decision call failed");

    const player = buildAiLogView(detailed, info, { ...ALL, isGM: false });
    for (const row of player.rows) {
      expect(row.detailsHtml).toBe("");
      expect(JSON.stringify(row)).not.toMatch(/Secret flank route|secret-model|Details/);
    }
  });

  it("gives an old record without details no disclosure, even for a GM", () => {
    expect(buildAiLogView([rec({})], info, { ...ALL, isGM: true }).rows[0].detailsHtml).toBe("");
  });
});
