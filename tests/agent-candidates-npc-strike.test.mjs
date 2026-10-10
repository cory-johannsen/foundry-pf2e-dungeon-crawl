// tests/agent-candidates-npc-strike.test.mjs
import { describe, it, expect } from "vitest";
import {
  buildNpcStrikeVocabulary,
  buildNpcStrikeCandidates,
  buildCandidateList,
  applyCandidateToTurnState,
  NPC_STRIKE_VOCABULARY_CAP,
} from "../scripts/agent-candidates.mjs";

// #933: the pure halves of the npcStrike vocabulary -- dungeon-combat.mjs
// has already checked each option against the board (computeNpcStrikeEntries).

const opponents = [
  { id: "a", name: "Ann", distanceSquares: 1 },
  { id: "b", name: "Bo", distanceSquares: 1 },
  { id: "c", name: "Cy", distanceSquares: 4 },
];

function entry(overrides = {}) {
  return {
    itemId: "i1",
    slug: "wide-swing",
    name: "Wide Swing",
    cost: 1,
    shape: "singleRollMultiAC",
    traits: [],
    options: [{ targetIds: ["a", "b"] }, { targetIds: ["b", "a"] }],
    ...overrides,
  };
}

describe("buildNpcStrikeVocabulary", () => {
  it("one entry per option; targetId is the group's primary target", () => {
    const vocab = buildNpcStrikeVocabulary({ npcStrikeEntries: [entry()], opponents, describe: (_e, names) => `vs ${names.join("+")}` });
    expect(vocab).toEqual([
      { type: "npcStrike", shape: "singleRollMultiAC", itemId: "i1", slug: "wide-swing", name: "Wide Swing", cost: 1, targetId: "a", targetIds: ["a", "b"], traits: [], summary: "vs Ann+Bo" },
      { type: "npcStrike", shape: "singleRollMultiAC", itemId: "i1", slug: "wide-swing", name: "Wide Swing", cost: 1, targetId: "b", targetIds: ["b", "a"], traits: [], summary: "vs Bo+Ann" },
    ]);
  });

  it("drops a group naming an unknown opponent and a flourish already spent this turn", () => {
    expect(buildNpcStrikeVocabulary({ npcStrikeEntries: [entry({ options: [{ targetIds: ["a", "zz"] }] })], opponents })).toEqual([]);
    expect(
      buildNpcStrikeVocabulary({ npcStrikeEntries: [entry({ traits: ["flourish"] })], opponents, turnState: { flourishUsed: true } }),
    ).toEqual([]);
  });

  it("caps the vocabulary, interleaving abilities so one can't crowd the others out", () => {
    const many = entry({ options: Array.from({ length: 12 }, () => ({ targetIds: ["c"] })) });
    const other = entry({ itemId: "i2", slug: "death-roll", name: "Death Roll", shape: "strikeAgainstGrabbed", options: [{ targetIds: ["a"] }] });
    const vocab = buildNpcStrikeVocabulary({ npcStrikeEntries: [many, other], opponents });
    expect(vocab).toHaveLength(NPC_STRIKE_VOCABULARY_CAP);
    expect(vocab.some((v) => v.slug === "death-roll")).toBe(true);
  });
});

describe("buildNpcStrikeCandidates", () => {
  const vocab = buildNpcStrikeVocabulary({ npcStrikeEntries: [entry()], opponents, describe: () => "one roll" });

  it("returns [] without picks", () => {
    expect(buildNpcStrikeCandidates({ npcStrikeVocabulary: vocab, picks: null, opponents })).toEqual([]);
  });

  it("validates a pick by (slug, primary targetId); the id carries the whole group", () => {
    const [c] = buildNpcStrikeCandidates({ npcStrikeVocabulary: vocab, picks: [{ type: "npcStrike", slug: "wide-swing", targetId: "b", rationale: "two at once" }], opponents });
    expect(c).toMatchObject({ id: "npcStrike:i1:b,a", type: "npcStrike", shape: "singleRollMultiAC", targetId: "b", targetIds: ["b", "a"], summary: "Wide Swing: one roll — two at once" });
  });

  it("drops picks of another type, an unmatched target, a disagreeing itemId, or a gone opponent", () => {
    const picks = [
      { type: "npcMove", slug: "wide-swing", targetId: "a" },
      { type: "npcStrike", slug: "wide-swing", targetId: "c" },
      { type: "npcStrike", slug: "wide-swing", targetId: "a", itemId: "other" },
    ];
    expect(buildNpcStrikeCandidates({ npcStrikeVocabulary: vocab, picks, opponents })).toEqual([]);
    expect(
      buildNpcStrikeCandidates({ npcStrikeVocabulary: vocab, picks: [{ type: "npcStrike", slug: "wide-swing", targetId: "a" }], opponents: opponents.filter((o) => o.id !== "b") }),
    ).toEqual([]);
  });

  it("flows through buildCandidateList", () => {
    const list = buildCandidateList({
      opponents,
      readyActions: [],
      turnState: { actionsRemaining: 3, mapIncrement: 0 },
      maneuverPicks: [{ type: "npcStrike", slug: "wide-swing", targetId: "a" }],
      npcStrikeVocabulary: vocab,
    });
    expect(list.filter((c) => c.type === "npcStrike").map((c) => c.id)).toEqual(["npcStrike:i1:a,b"]);
  });
});

describe("applyCandidateToTurnState: npcStrike", () => {
  const base = { actionsRemaining: 3, mapIncrement: 1, maneuverPicks: [], flourishUsed: false, stanceUsed: false };

  it("advances MAP by the attacks its executor reports (Wide Swing: 2; Constrict: 0)", () => {
    expect(applyCandidateToTurnState(base, { type: "npcStrike", cost: 1, attacks: 2 })).toMatchObject({ actionsRemaining: 2, mapIncrement: 3 });
    expect(applyCandidateToTurnState(base, { type: "npcStrike", cost: 1, attacks: 0 })).toMatchObject({ actionsRemaining: 2, mapIncrement: 1 });
  });

  it("records a flourish", () => {
    expect(applyCandidateToTurnState(base, { type: "npcStrike", cost: 1, attacks: 1, traits: ["flourish"] }).flourishUsed).toBe(true);
  });
});
