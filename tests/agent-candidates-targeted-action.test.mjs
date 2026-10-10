// #947: the targetedAction feat kind in the pure candidate pipeline, and
// PF2e's finisher rule ("Once you use a finisher, you can't use actions
// that have the attack trait for the rest of your turn").
import { describe, it, expect } from "vitest";
import {
  buildFeatVocabulary,
  buildFeatCandidates,
  buildCandidateList,
  applyCandidateToTurnState,
  initAgentTurnState,
  isAttackCandidate,
} from "../scripts/agent-candidates.mjs";

const strikeEntry = {
  itemId: "uf1", slug: "unbalancing-finisher", name: "Unbalancing Finisher", cost: 1, targetId: "opp1",
  traits: ["finisher"], attack: true, effectSummary: "melee Strike Goblin; hit+damage: off-guard",
};
const effectEntry = {
  itemId: "io1", slug: "instant-opening", name: "Instant Opening", cost: 1, targetId: "opp1",
  traits: [], attack: false, effectSummary: "Goblin off-guard to your attacks",
};
const opponents = [{ id: "opp1", name: "Goblin", distanceSquares: 1, hp: 10 }];

describe("buildFeatVocabulary targetedAction entries (#947)", () => {
  it("adds one targetedAction entry per legal target, carrying its attack flag and summary", () => {
    expect(buildFeatVocabulary({ targetedActionEntries: [strikeEntry, effectEntry] })).toEqual([
      { type: "feat", kind: "targetedAction", itemId: "uf1", slug: "unbalancing-finisher", name: "Unbalancing Finisher", cost: 1, targetId: "opp1", traits: ["finisher"], attack: true, effectSummary: strikeEntry.effectSummary },
      { type: "feat", kind: "targetedAction", itemId: "io1", slug: "instant-opening", name: "Instant Opening", cost: 1, targetId: "opp1", traits: [], attack: false, effectSummary: effectEntry.effectSummary },
    ]);
  });

  it("drops Strike-making feats (targeted and composite) after a finisher, keeping non-attacks", () => {
    const composite = { itemId: "sc1", slug: "sudden-charge", name: "Sudden Charge", cost: 2, targetId: "opp1", traits: ["flourish"] };
    const vocabulary = buildFeatVocabulary({
      compositeEntries: [composite],
      targetedActionEntries: [strikeEntry, effectEntry],
      turnState: { ...initAgentTurnState(), finisherUsed: true },
    });
    expect(vocabulary.map((v) => v.slug)).toEqual(["instant-opening"]);
  });
});

describe("buildFeatCandidates targetedAction (#947)", () => {
  it("validates a pick by (slug, targetId) and labels it with the effect summary", () => {
    const featVocabulary = buildFeatVocabulary({ targetedActionEntries: [strikeEntry] });
    const [candidate] = buildFeatCandidates({
      featVocabulary,
      picks: [{ type: "feat", slug: "unbalancing-finisher", targetId: "opp1", rationale: "why" }],
      opponents,
    });
    expect(candidate).toEqual({
      id: "feat:uf1:opp1", type: "feat", kind: "targetedAction", itemId: "uf1", slug: "unbalancing-finisher",
      name: "Unbalancing Finisher", targetId: "opp1", cost: 1, attack: true, traits: ["finisher"],
      summary: "Unbalancing Finisher (melee Strike Goblin; hit+damage: off-guard) — why",
    });
  });
});

describe("finisher turn rule (#947)", () => {
  it("a finisher candidate sets finisherUsed and counts its Strike toward MAP", () => {
    const next = applyCandidateToTurnState(initAgentTurnState(), { type: "feat", kind: "targetedAction", cost: 1, traits: ["finisher"], attacks: 1 });
    expect(next).toMatchObject({ actionsRemaining: 2, mapIncrement: 1, finisherUsed: true });
  });

  it("isAttackCandidate covers Strikes, spell attacks, attack maneuvers and Strike-based feats only", () => {
    expect(isAttackCandidate({ type: "strike" })).toBe(true);
    expect(isAttackCandidate({ type: "multiStrike" })).toBe(true);
    expect(isAttackCandidate({ type: "castAttack" })).toBe(true);
    expect(isAttackCandidate({ type: "maneuver", slug: "trip" })).toBe(true);
    expect(isAttackCandidate({ type: "maneuver", slug: "demoralize" })).toBe(false);
    expect(isAttackCandidate({ type: "feat", kind: "composite" })).toBe(true);
    expect(isAttackCandidate({ type: "feat", kind: "targetedAction", attack: true })).toBe(true);
    expect(isAttackCandidate({ type: "feat", kind: "targetedAction", attack: false })).toBe(false);
    expect(isAttackCandidate({ type: "feat", kind: "selfEffect" })).toBe(false);
    expect(isAttackCandidate({ type: "stride" })).toBe(false);
    expect(isAttackCandidate({ type: "cast" })).toBe(false);
  });

  it("buildCandidateList drops every attack candidate after a finisher, keeping movement and end turn", () => {
    const readyActions = [{ slug: "rapier", label: "Rapier", variantCount: 3, reachSquares: 1 }];
    const far = [...opponents, { id: "opp2", name: "Orc", distanceSquares: 4, hp: 10 }];
    const before = buildCandidateList({ opponents: far, readyActions, turnState: initAgentTurnState() });
    expect(before.some((c) => c.type === "strike")).toBe(true);
    const after = buildCandidateList({ opponents: far, readyActions, turnState: { ...initAgentTurnState(), finisherUsed: true } });
    expect(after.some((c) => c.type === "strike")).toBe(false);
    expect(after.some((c) => c.type === "stride")).toBe(true);
    expect(after.at(-1).type).toBe("endTurn");
  });
});
