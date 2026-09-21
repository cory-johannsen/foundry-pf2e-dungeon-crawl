import { describe, it, expect } from "vitest";
import {
  defaultRequiredSuccesses,
  isValidPuzzleTemplate,
  initPuzzleState,
  applyPuzzleStageAttempt,
} from "../scripts/puzzle-mechanics.mjs";

const HINT_CHECKS = [
  { skill: "perception", dc: 20, hint: "Grooves fit a fanned hand of five cards." },
  { skill: "society", dc: 20, hint: "The suits mirror noble houses." },
  { skill: "occultism", dc: 20, hint: "The arrangement echoes a divination spread." },
];

describe("defaultRequiredSuccesses", () => {
  it("is a majority (ceil of half) of the stage count", () => {
    expect(defaultRequiredSuccesses(3)).toBe(2);
    expect(defaultRequiredSuccesses(4)).toBe(2);
    expect(defaultRequiredSuccesses(1)).toBe(1);
  });

  it("is 0 for an empty stage list", () => {
    expect(defaultRequiredSuccesses(0)).toBe(0);
  });
});

describe("isValidPuzzleTemplate", () => {
  it("accepts a real puzzle-kind entry with well-formed hintChecks", () => {
    expect(
      isValidPuzzleTemplate({ kind: "puzzle", hintChecks: HINT_CHECKS }),
    ).toBe(true);
  });

  it("rejects a non-puzzle kind", () => {
    expect(
      isValidPuzzleTemplate({ kind: "trap", hintChecks: HINT_CHECKS }),
    ).toBe(false);
  });

  it("rejects an entry with no hintChecks at all", () => {
    expect(isValidPuzzleTemplate({ kind: "puzzle", hintChecks: [] })).toBe(
      false,
    );
    expect(isValidPuzzleTemplate({ kind: "puzzle" })).toBe(false);
  });

  it("rejects a hintCheck missing a skill, dc, or hint", () => {
    expect(
      isValidPuzzleTemplate({
        kind: "puzzle",
        hintChecks: [{ skill: "perception", dc: 20 }],
      }),
    ).toBe(false);
  });
});

describe("initPuzzleState", () => {
  it("starts every stage unattempted, 0 successes, unresolved", () => {
    const state = initPuzzleState({ hintChecks: HINT_CHECKS });
    expect(state.stages).toHaveLength(3);
    expect(state.stages[0]).toEqual({
      skill: "perception",
      dc: 20,
      hint: "Grooves fit a fanned hand of five cards.",
      attempted: false,
      succeeded: false,
    });
    expect(state.successes).toBe(0);
    expect(state.attemptsUsed).toBe(0);
    expect(state.resolved).toBeNull();
  });

  it("defaults requiredSuccesses to a majority of the stage count", () => {
    const state = initPuzzleState({ hintChecks: HINT_CHECKS });
    expect(state.requiredSuccesses).toBe(2);
  });

  it("honors an explicit requiredSuccesses override", () => {
    const state = initPuzzleState({
      hintChecks: HINT_CHECKS,
      requiredSuccesses: 3,
    });
    expect(state.requiredSuccesses).toBe(3);
  });

  it("lowercases each stage's skill, matching PF2e's own real hand-authored data (Title Case)", () => {
    const state = initPuzzleState({
      hintChecks: [
        { skill: "Perception", dc: 10, hint: "h1" },
        { skill: "Society", dc: 10, hint: "h2" },
      ],
    });
    expect(state.stages[0].skill).toBe("perception");
    expect(state.stages[1].skill).toBe("society");
  });

  it("uses each hintCheck's own flat dc verbatim when partyLevel isn't given", () => {
    const state = initPuzzleState({
      hintChecks: [{ skill: "society", dc: 10, hint: "h1" }],
    });
    expect(state.stages[0].dc).toBe(10);
  });

  it("persists name/summary and starts with an empty stageFlavor map, for #139's customization to land on", () => {
    const state = initPuzzleState({
      hintChecks: HINT_CHECKS,
      name: "The Perfect Hand",
      summary: "A statue holds one card.",
    });
    expect(state.name).toBe("The Perfect Hand");
    expect(state.summary).toBe("A statue holds one card.");
    expect(state.stageFlavor).toEqual({});
  });

  it("defaults name/summary to null when not given", () => {
    const state = initPuzzleState({ hintChecks: HINT_CHECKS });
    expect(state.name).toBeNull();
    expect(state.summary).toBeNull();
  });

  it("scales every stage's dc to simpleDcForLevel(partyLevel), ignoring the template's own flat dc, when given", () => {
    const state = initPuzzleState({
      hintChecks: [
        { skill: "society", dc: 10, hint: "h1" },
        { skill: "occultism", dc: 10, hint: "h2" },
      ],
      partyLevel: 5,
    });
    // simpleDcForLevel(5) === 20 (skill-challenge-mechanics.mjs's own table)
    expect(state.stages[0].dc).toBe(20);
    expect(state.stages[1].dc).toBe(20);
  });
});

describe("applyPuzzleStageAttempt", () => {
  const fresh = () => initPuzzleState({ hintChecks: HINT_CHECKS });

  it("marks the stage attempted and succeeded on a successful outcome", () => {
    const next = applyPuzzleStageAttempt(fresh(), 0, "success");
    expect(next.stages[0].attempted).toBe(true);
    expect(next.stages[0].succeeded).toBe(true);
    expect(next.successes).toBe(1);
    expect(next.attemptsUsed).toBe(1);
    expect(next.resolved).toBeNull();
  });

  it("marks the stage attempted but not succeeded on a failed outcome", () => {
    const next = applyPuzzleStageAttempt(fresh(), 0, "failure");
    expect(next.stages[0].attempted).toBe(true);
    expect(next.stages[0].succeeded).toBe(false);
    expect(next.successes).toBe(0);
  });

  it("treats criticalSuccess as a success and criticalFailure as a failure", () => {
    expect(
      applyPuzzleStageAttempt(fresh(), 0, "criticalSuccess").stages[0]
        .succeeded,
    ).toBe(true);
    expect(
      applyPuzzleStageAttempt(fresh(), 0, "criticalFailure").stages[0]
        .succeeded,
    ).toBe(false);
  });

  it("resolves success the moment enough stages succeed", () => {
    let state = fresh(); // requiredSuccesses 2
    state = applyPuzzleStageAttempt(state, 0, "success");
    expect(state.resolved).toBeNull();
    state = applyPuzzleStageAttempt(state, 1, "success");
    expect(state.resolved).toBe("success");
  });

  it("resolves failure as soon as the threshold becomes unreachable", () => {
    let state = fresh(); // 3 stages, requiredSuccesses 2
    state = applyPuzzleStageAttempt(state, 0, "failure");
    expect(state.resolved).toBeNull(); // 2 stages left, still reachable
    state = applyPuzzleStageAttempt(state, 1, "failure");
    // only 1 stage left, already have 0 successes - can reach at most 1, need 2
    expect(state.resolved).toBe("failure");
  });

  it("is a no-op once already resolved", () => {
    let state = fresh();
    state = applyPuzzleStageAttempt(state, 0, "success");
    state = applyPuzzleStageAttempt(state, 1, "success");
    expect(state.resolved).toBe("success");
    const after = applyPuzzleStageAttempt(state, 2, "success");
    expect(after).toBe(state);
  });

  it("is a no-op on a stage that's already been attempted", () => {
    let state = fresh();
    state = applyPuzzleStageAttempt(state, 0, "failure");
    const again = applyPuzzleStageAttempt(state, 0, "success");
    expect(again).toBe(state);
  });

  it("is a no-op on an out-of-range stage index", () => {
    const state = fresh();
    const after = applyPuzzleStageAttempt(state, 99, "success");
    expect(after).toBe(state);
  });
});
