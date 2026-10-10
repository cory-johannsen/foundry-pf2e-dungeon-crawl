// tests/agent-candidates-npc-self.test.mjs
import { describe, it, expect } from "vitest";
import {
  buildNpcSelfVocabulary,
  buildNpcSelfCandidates,
  buildCandidateList,
  applyCandidateToTurnState,
  NPC_SELF_VOCABULARY_CAP,
} from "../scripts/agent-candidates.mjs";

// #934: the pure halves of the npcSelf vocabulary -- dungeon-combat.mjs's
// computeNpcSelfEntries has already applied every eligibility gate.

function entry(overrides = {}) {
  return {
    itemId: "i1",
    slug: "form-a-phalanx",
    name: "Form a Phalanx",
    family: "selfEffectAction",
    cost: 1,
    traits: [],
    hpFraction: null,
    tier: 0,
    effectSummary: "+ac",
    durationLabel: "1 rounds",
    frequencyLabel: null,
    summary: "self-buff: +ac; lasts 1 rounds",
    ...overrides,
  };
}

const heal = (overrides = {}) =>
  entry({ itemId: "h1", slug: "self-repair", name: "Self-Repair", family: "selfHeal", tier: 2, effectSummary: null, durationLabel: null, summary: "heals itself 30 HP (now at 40% HP)", hpFraction: 0.4, ...overrides });

describe("buildNpcSelfVocabulary (#934)", () => {
  it("emits a self-only entry (targetId null) carrying only what the model reads", () => {
    expect(buildNpcSelfVocabulary({ npcSelfEntries: [entry({ frequencyLabel: "1/day" })] })).toEqual([
      {
        type: "npcSelf", family: "selfEffectAction", itemId: "i1", slug: "form-a-phalanx", name: "Form a Phalanx",
        cost: 1, targetId: null, traits: [], summary: "self-buff: +ac; lasts 1 rounds", frequencyLabel: "1/day",
      },
    ]);
  });

  it("ranks heals first, the more hurt the earlier, then effects by relevance tier", () => {
    const vocab = buildNpcSelfVocabulary({
      npcSelfEntries: [
        entry({ itemId: "senses", slug: "s", tier: 2 }),
        entry({ itemId: "ac", slug: "a", tier: 0 }),
        heal({ itemId: "h-mild", slug: "hm", hpFraction: 0.9 }),
        entry({ itemId: "resist", slug: "r", tier: 1 }),
        heal({ itemId: "h-bad", slug: "hb", hpFraction: 0.2 }),
      ],
    });
    expect(vocab.map((v) => v.itemId)).toEqual(["h-bad", "h-mild", "ac", "resist", "senses"]);
  });

  it("caps at NPC_SELF_VOCABULARY_CAP", () => {
    const many = Array.from({ length: NPC_SELF_VOCABULARY_CAP + 3 }, (_, i) => entry({ itemId: `i${i}`, slug: `s${i}` }));
    expect(buildNpcSelfVocabulary({ npcSelfEntries: many })).toHaveLength(NPC_SELF_VOCABULARY_CAP);
  });

  it("drops a stance once a stance was used this turn, and a flourish once a flourish was", () => {
    const entries = [entry({ itemId: "st", slug: "st", traits: ["stance"] }), entry({ itemId: "fl", slug: "fl", traits: ["flourish"] }), entry()];
    expect(buildNpcSelfVocabulary({ npcSelfEntries: entries, turnState: { stanceUsed: true } }).map((v) => v.itemId)).toEqual(["fl", "i1"]);
    expect(buildNpcSelfVocabulary({ npcSelfEntries: entries, turnState: { flourishUsed: true } }).map((v) => v.itemId)).toEqual(["st", "i1"]);
  });
});

describe("buildNpcSelfCandidates (#934)", () => {
  const vocab = buildNpcSelfVocabulary({ npcSelfEntries: [entry(), heal()] });

  it("turns a pick into a self-only candidate with the rationale", () => {
    expect(buildNpcSelfCandidates({ npcSelfVocabulary: vocab, picks: [{ type: "npcSelf", slug: "form-a-phalanx", targetId: null, rationale: "brace for the charge" }] })).toEqual([
      {
        id: "npcSelf:i1", type: "npcSelf", family: "selfEffectAction", itemId: "i1", slug: "form-a-phalanx", name: "Form a Phalanx",
        targetId: null, cost: 1, traits: [], summary: "Form a Phalanx: self-buff: +ac; lasts 1 rounds — brace for the charge",
      },
    ]);
  });

  it("drops picks of another type, unknown slugs, a disagreeing itemId and duplicates", () => {
    const picks = [
      { type: "feat", slug: "form-a-phalanx" },
      { type: "npcSelf", slug: "not-offered" },
      { type: "npcSelf", slug: "self-repair", itemId: "other" },
      { type: "npcSelf", slug: "self-repair" },
      { type: "npcSelf", slug: "self-repair" },
      null,
    ];
    expect(buildNpcSelfCandidates({ npcSelfVocabulary: vocab, picks }).map((c) => c.id)).toEqual(["npcSelf:h1"]);
  });

  it("returns [] when there are no picks yet", () => {
    expect(buildNpcSelfCandidates({ npcSelfVocabulary: vocab, picks: null })).toEqual([]);
  });

  it("flows through buildCandidateList", () => {
    const list = buildCandidateList({
      opponents: [],
      readyActions: [],
      turnState: { actionsRemaining: 2, mapIncrement: 0 },
      maneuverPicks: [{ type: "npcSelf", slug: "self-repair", targetId: null }],
      npcSelfVocabulary: vocab,
    });
    expect(list.filter((c) => c.type === "npcSelf").map((c) => c.id)).toEqual(["npcSelf:h1"]);
  });
});

describe("applyCandidateToTurnState: npcSelf (#934)", () => {
  const base = { actionsRemaining: 3, mapIncrement: 1, maneuverPicks: [], flourishUsed: false, stanceUsed: false };

  it("spends the cost, leaves MAP alone (no attack) and a free action costs nothing", () => {
    expect(applyCandidateToTurnState(base, { type: "npcSelf", cost: 2, attacks: 0 })).toMatchObject({ actionsRemaining: 1, mapIncrement: 1 });
    expect(applyCandidateToTurnState(base, { type: "npcSelf", cost: 0, attacks: 0 })).toMatchObject({ actionsRemaining: 3, mapIncrement: 1 });
  });

  it("records a stance", () => {
    expect(applyCandidateToTurnState(base, { type: "npcSelf", cost: 1, traits: ["stance"] }).stanceUsed).toBe(true);
  });
});
