import { describe, it, expect } from "vitest";
import {
  buildPublicPageHtml,
  buildGmPageHtml,
  encounterLabel,
  runDisplayName,
  publicJournalName,
  gmJournalName,
  EMPTY_PAGE_HTML,
} from "../scripts/ai-history-pages.mjs";

const records = [
  {
    combatantId: "c1", tokenId: "t1", round: 1, turn: 0, index: 0, type: "strike",
    summary: "Dagger vs Fighter", target: { id: "c2", name: "Fighter" },
    result: { text: "hit", tone: "success" }, rationale: "Closest.", gmNote: "MAP -5",
    source: "model", visibility: "all",
    alternatives: [{ id: "a", summary: "Strike Cleric", chosen: false }, { id: "b", summary: "Dagger vs Fighter", chosen: true }],
    moreCount: 3, meta: { provider: "litellm", model: "reasoning" },
  },
  {
    combatantId: "c3", round: 1, turn: 1, index: 0, summary: "Claw vs Fighter",
    target: { id: "c2", name: "Fighter" }, result: { text: "miss", tone: "failure" },
    rationale: "Hidden monster.", source: "model", visibility: "gm",
  },
  {
    combatantId: "c1", round: 2, turn: 0, index: 0, summary: "Stride", target: null,
    result: { text: "moved", tone: "neutral" }, source: "fallback", fallbackReason: "timeout",
    meta: { timeoutMs: 30000 }, visibility: "all",
  },
];
const names = { c1: "Goblin", c3: "Lurker" };

describe("buildPublicPageHtml (#953)", () => {
  it("shows what each visible AI did and the result, per round", () => {
    const html = buildPublicPageHtml(records, { names });
    expect(html).toContain("Dagger vs Fighter");
    expect(html).toContain("Goblin");
    expect(html).toContain("Fighter");
    expect(html).toContain("hit");
    expect(html).toContain("<h3>Round 1</h3>");
    expect(html).toContain("<h3>Round 2</h3>");
    expect(html.indexOf("Round 1")).toBeLessThan(html.indexOf("Round 2"));
  });

  it("omits GM-only rows and every GM-only field", () => {
    const html = buildPublicPageHtml(records, { names });
    expect(html).not.toContain("Claw vs Fighter");
    expect(html).not.toContain("Lurker");
    for (const secret of ["Closest.", "MAP -5", "Strike Cleric", "litellm", "reasoning", "fallback", "timed out", "Hidden monster."])
      expect(html).not.toContain(secret);
    expect(html).not.toContain("<details");
  });

  it("escapes hostile strings", () => {
    const html = buildPublicPageHtml(
      [{ ...records[0], summary: "<script>alert(1)</script>", target: { name: '<img src=x onerror="a">' } }],
      { names: { c1: "<b>Gob</b>" } },
    );
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<b>Gob");
    expect(html).toContain("&lt;script&gt;");
  });

  it("returns the empty-state text for no/malformed/all-hidden input", () => {
    expect(buildPublicPageHtml([])).toBe(EMPTY_PAGE_HTML);
    expect(buildPublicPageHtml(null)).toBe(EMPTY_PAGE_HTML);
    expect(buildPublicPageHtml([records[1]])).toBe(EMPTY_PAGE_HTML);
    expect(buildPublicPageHtml([records[0]])).not.toContain("undefined");
  });

  it("keeps append order within a round (index is per combatant, not a turn order)", () => {
    const html = buildPublicPageHtml([
      { combatantId: "c1", round: 1, index: 1, summary: "Second action", visibility: "all" },
      { combatantId: "c3", round: 1, index: 0, summary: "Third action", visibility: "all" },
    ]);
    expect(html.indexOf("Second action")).toBeLessThan(html.indexOf("Third action"));
  });

  it("falls back to Unknown for a combatant with no name", () => {
    expect(buildPublicPageHtml([records[0]])).toContain("Unknown");
  });
});

describe("buildGmPageHtml (#953)", () => {
  it("includes every row, rationale, GM note, alternatives and metadata", () => {
    const html = buildGmPageHtml(records, { names });
    for (const s of ["Dagger vs Fighter", "Claw vs Fighter", "Lurker", "Closest.", "MAP -5", "Hidden monster.", "Strike Cleric", "+3 more", "litellm", "(chosen)"])
      expect(html).toContain(s);
    expect(html).toContain("hidden from players");
  });

  it("tags fallback rows with the reason", () => {
    const html = buildGmPageHtml(records, { names });
    expect(html).toContain("fallback heuristic");
    expect(html).toContain("Fallback: timed out after 30 s");
  });

  it("escapes hostile strings in rationale and notes", () => {
    const html = buildGmPageHtml([{ ...records[0], rationale: "<img onerror=alert(1)>", gmNote: "<script>x</script>" }]);
    expect(html).not.toContain("<img onerror");
    expect(html).not.toContain("<script>");
  });

  it("returns the empty-state text for no input", () => {
    expect(buildGmPageHtml(undefined)).toBe(EMPTY_PAGE_HTML);
  });
});

describe("encounterLabel (#953)", () => {
  const runState = {
    rooms: {
      "room-entry": { kind: "safe_entry" },
      r1: { kind: "combat" },
      rest: { kind: "safe_rest" },
      r2: { kind: "trap" },
      r3: { kind: "combat" },
    },
    history: [{ roomId: "room-entry" }, { roomId: "r1" }, { roomId: "rest" }, { roomId: "r2" }],
  };
  const kindLabel = (k) => ({ combat: "Combat", trap: "Trap", safe_rest: "A Resting Room" })[k] ?? k;

  it("numbers a dungeon room the way the tracker does (entry/rest uncounted, current room appended)", () => {
    expect(encounterLabel({ roomId: "r3", runState, kindLabel })).toBe("Room 3 — Combat");
    expect(encounterLabel({ roomId: "r1", runState, kindLabel })).toBe("Room 1 — Combat");
    expect(encounterLabel({ roomId: "r2", runState, kindLabel })).toBe("Room 2 — Trap");
  });

  it("uses just the kind for an uncounted room, and Room for an unknown one", () => {
    expect(encounterLabel({ roomId: "rest", runState, kindLabel })).toBe("A Resting Room");
    expect(encounterLabel({ roomId: "nope", runState, kindLabel })).toBe("Room");
    expect(encounterLabel({ roomId: "r1", runState: null, kindLabel })).toBe("Room");
  });

  it("labels a standalone combat by its scene", () => {
    expect(encounterLabel({ sceneName: "Forest" })).toBe("Encounter — Forest");
    expect(encounterLabel({})).toBe("Encounter");
  });
});

describe("journal names (#953)", () => {
  it("adds the run start to the scene name", () => {
    const at = new Date(2026, 9, 9, 14, 3).getTime();
    expect(runDisplayName("Dungeon Crawl", at)).toBe("Dungeon Crawl (2026-10-09 14:03)");
    expect(runDisplayName("Dungeon Crawl", undefined)).toBe("Dungeon Crawl");
    expect(runDisplayName(null, undefined)).toBe("Dungeon Run");
  });

  it("names the public and GM journals", () => {
    expect(publicJournalName("X")).toBe("AI Action History — X");
    expect(gmJournalName("X")).toBe("AI Action Details — X (GM)");
  });
});
