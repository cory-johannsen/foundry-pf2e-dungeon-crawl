// #951: pure digest for an AI combatant's tracker row and token hover.
// Records use the real shape #925's recordAgentAction writes.
import { describe, it, expect } from "vitest";
import { buildCombatantDigest, digestSummaryText, renderDigestRowHtml } from "../scripts/ai-action-digest.mjs";

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
    target: { id: "p1", name: "Fighter" },
    result: { text: "hit", tone: "success" },
    gmNote: null,
    rationale: null,
    source: "model",
    visibility: "all",
    ...over,
  };
}

const records = [
  rec({ summary: "a", rationale: "r1" }),
  rec({ round: 2, index: 0, summary: "b", result: { text: "miss", tone: "failure" }, rationale: "r2", gmNote: "DC 18" }),
  rec({ combatantId: "c3", round: 2, summary: "other" }),
  rec({ round: 2, index: 1, summary: "c", rationale: null, source: "fallback" }),
  rec({ combatantId: "c2", round: 3, summary: "d", rationale: "hidden logic", visibility: "gm" }),
];

describe("buildCombatantDigest (#951)", () => {
  it("returns the current round, the previous round and the latest action, with rationale for a GM", () => {
    const digest = buildCombatantDigest(records, { combatantId: "c1", round: 2, isGM: true });
    expect(digest.currentRound.map((r) => r.summary)).toEqual(["b", "c"]);
    expect(digest.previousRound.map((r) => r.summary)).toEqual(["a"]);
    expect(digest.stale).toBe(false);
    expect(digest.last).toEqual({ summary: "c", targetName: "Fighter", result: { text: "hit", tone: "success" }, round: 2, rationale: null });
    expect(digest.currentRound[0].rationale).toBe("r2");
    expect(digest.currentRound[0].gmNote).toBe("DC 18");
  });

  it("strips rationale, GM notes and the fallback source for a non-GM", () => {
    const digest = buildCombatantDigest(records, { combatantId: "c1", round: 2, isGM: false });
    expect(digest.currentRound.map((r) => r.summary)).toEqual(["b", "c"]);
    for (const r of [...digest.currentRound, ...digest.previousRound]) {
      expect(r.rationale).toBeUndefined();
      expect(r.gmNote).toBeUndefined();
      expect(r.source).toBeUndefined();
    }
    const rationaleDigest = buildCombatantDigest([rec({ rationale: "secret" })], { combatantId: "c1", round: 1, isGM: false });
    expect(rationaleDigest.last.rationale).toBeNull();
    expect(JSON.stringify(rationaleDigest)).not.toContain("secret");
  });

  it("gives a GM the latest action's rationale on `last`", () => {
    const digest = buildCombatantDigest([rec({ rationale: "closest" })], { combatantId: "c1", round: 1, isGM: true });
    expect(digest.last.rationale).toBe("closest");
  });

  it("orders a round's rows by index, not log position", () => {
    const digest = buildCombatantDigest(
      [rec({ index: 1, summary: "second" }), rec({ index: 0, summary: "first" })],
      { combatantId: "c1", round: 1, isGM: true },
    );
    expect(digest.currentRound.map((r) => r.summary)).toEqual(["first", "second"]);
    expect(digest.last.summary).toBe("second");
  });

  it("falls back to the most recent earlier action and marks stale when the combatant hasn't acted this round", () => {
    const digest = buildCombatantDigest(records, { combatantId: "c1", round: 5, isGM: true });
    expect(digest.currentRound).toEqual([]);
    expect(digest.stale).toBe(true);
    expect(digest.last.summary).toBe("c");
    expect(digest.last.round).toBe(2);
    // The stale fallback stays labelled separately: previousRound is round 2's own rows.
    expect(digest.previousRound.map((r) => r.summary)).toEqual(["b", "c"]);
  });

  it("previousRound is the latest earlier round that has rows, skipping empty rounds", () => {
    const digest = buildCombatantDigest(
      [rec({ round: 1, summary: "r1" }), rec({ round: 4, summary: "r4" })],
      { combatantId: "c1", round: 4, isGM: true },
    );
    expect(digest.previousRound.map((r) => r.summary)).toEqual(["r1"]);
  });

  it("hides a GM-only (hidden-token) combatant entirely from a non-GM, but not from the GM", () => {
    expect(buildCombatantDigest(records, { combatantId: "c2", round: 3, isGM: false }).last).toBeNull();
    expect(buildCombatantDigest(records, { combatantId: "c2", round: 3, isGM: true }).last.summary).toBe("d");
  });

  it("a non-GM sees a combatant's public rows but not its GM-only ones", () => {
    const log = [rec({ summary: "public" }), rec({ index: 1, summary: "while hidden", visibility: "gm" })];
    const digest = buildCombatantDigest(log, { combatantId: "c1", round: 1, isGM: false });
    expect(digest.currentRound.map((r) => r.summary)).toEqual(["public"]);
    expect(digest.last.summary).toBe("public");
  });

  it("returns last: null and empty rounds for a combatant with no records", () => {
    expect(buildCombatantDigest(records, { combatantId: "c99", round: 2, isGM: true })).toEqual({
      last: null,
      currentRound: [],
      previousRound: [],
      stale: false,
    });
  });

  it("handles a malformed log and malformed records without throwing", () => {
    for (const bad of [null, undefined, "x", {}]) {
      expect(buildCombatantDigest(bad, { combatantId: "c1", round: 2, isGM: true }).last).toBeNull();
    }
    const digest = buildCombatantDigest([null, 7, { combatantId: "c1" }], { combatantId: "c1", round: 1, isGM: true });
    expect(digest.last).toEqual({ summary: "Action", targetName: null, result: { text: "done", tone: "neutral" }, round: null, rationale: null });
    expect(digest.stale).toBe(true);
    expect(buildCombatantDigest(records, {}).last).toBeNull();
  });
});

describe("digestSummaryText (#951)", () => {
  it("reads 'last: <summary> → <target> (<result>)', prefixed when stale", () => {
    const fresh = buildCombatantDigest(records, { combatantId: "c1", round: 2, isGM: false });
    expect(digestSummaryText(fresh)).toBe("last: c → Fighter (hit)");
    const stale = buildCombatantDigest(records, { combatantId: "c1", round: 5, isGM: false });
    expect(digestSummaryText(stale)).toBe("(last round) last: c → Fighter (hit)");
    expect(digestSummaryText({ last: null })).toBe("");
  });
});

describe("renderDigestRowHtml (#951, shared with #1006)", () => {
  const record = rec({ rationale: "r", gmNote: "DC 18", source: "fallback", visibility: "gm", cost: 2 });

  it("includes rationale, GM note, fallback tag and GM-only marker for a GM", () => {
    const html = renderDigestRowHtml(record, true);
    expect(html).toContain("pf2edc-ai-rationale");
    expect(html).toContain("DC 18");
    expect(html).toContain("fallback heuristic");
    expect(html).toContain("pf2edc-ai-gm-only");
    expect(html).toContain('<span class="action-glyph">2</span>');
    expect(html).toContain("pf2edc-tone-success");
  });

  it("never renders GM-only parts for a non-GM, even from an unredacted record", () => {
    const html = renderDigestRowHtml(record, false);
    expect(html).not.toContain("pf2edc-ai-rationale");
    expect(html).not.toContain("DC 18");
    expect(html).not.toContain("fallback heuristic");
    expect(html).not.toContain("pf2edc-ai-gm-only");
  });

  it("escapes every string", () => {
    const html = renderDigestRowHtml(
      rec({ summary: "<img src=x onerror=alert(1)>", target: { name: "<b>T</b>" }, result: { text: "<i>", tone: "evil" }, rationale: "<script>" }),
      true,
    );
    expect(html).not.toMatch(/<img|<b>|<i>|<script>/);
    expect(html).toContain("&lt;img");
    expect(html).toContain("pf2edc-tone-neutral");
  });
});
