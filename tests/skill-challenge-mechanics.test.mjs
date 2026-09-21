import { describe, it, expect } from "vitest";
import {
  simpleDcForLevel,
  vpDeltaForOutcome,
  attemptBudgetForPartySize,
  chooseSpecialtySkills,
  dcForAttempt,
  initSkillChallengeState,
  applySkillChallengeAttempt,
  isValidSkillChallengeTemplate,
  selectSkillChallengeTemplate,
  ALL_SKILLS,
  VP_TARGET,
  NON_SPECIALTY_DC_BUMP,
} from "../scripts/skill-challenge-mechanics.mjs";

describe("simpleDcForLevel", () => {
  it("matches GM Core's Simple DC table at a few known points", () => {
    expect(simpleDcForLevel(0)).toBe(14);
    expect(simpleDcForLevel(1)).toBe(15);
    expect(simpleDcForLevel(5)).toBe(20);
    expect(simpleDcForLevel(10)).toBe(27);
    expect(simpleDcForLevel(20)).toBe(40);
  });

  it("clamps below -1 and above 25 rather than extrapolating", () => {
    expect(simpleDcForLevel(-5)).toBe(simpleDcForLevel(-1));
    expect(simpleDcForLevel(99)).toBe(simpleDcForLevel(25));
  });

  it("defaults a missing level to 0", () => {
    expect(simpleDcForLevel(undefined)).toBe(14);
  });

  it("rounds a fractional level", () => {
    expect(simpleDcForLevel(4.6)).toBe(simpleDcForLevel(5));
  });
});

describe("vpDeltaForOutcome", () => {
  it("matches GM Core's standard VP table", () => {
    expect(vpDeltaForOutcome("criticalSuccess")).toBe(2);
    expect(vpDeltaForOutcome("success")).toBe(1);
    expect(vpDeltaForOutcome("failure")).toBe(0);
    expect(vpDeltaForOutcome("criticalFailure")).toBe(-1);
  });

  it("defaults an unrecognized outcome to 0", () => {
    expect(vpDeltaForOutcome("something-else")).toBe(0);
  });
});

describe("attemptBudgetForPartySize", () => {
  it("is partySize + 2, with a floor of 3", () => {
    expect(attemptBudgetForPartySize(4)).toBe(6);
    expect(attemptBudgetForPartySize(1)).toBe(3);
    expect(attemptBudgetForPartySize(0)).toBe(3);
  });

  it("defaults a missing partySize to 4", () => {
    expect(attemptBudgetForPartySize(undefined)).toBe(6);
  });
});

describe("chooseSpecialtySkills", () => {
  it("always returns exactly 3 distinct real skills", () => {
    const skills = chooseSpecialtySkills("seed-a", "room-1", "undead");
    expect(skills).toHaveLength(3);
    expect(new Set(skills).size).toBe(3);
    for (const s of skills) expect(ALL_SKILLS).toContain(s);
  });

  it("always includes the location tag's own 2 theme-linked skills", () => {
    const skills = chooseSpecialtySkills("seed-a", "room-1", "undead");
    expect(skills).toEqual(
      expect.arrayContaining(["religion", "intimidation"]),
    );
  });

  it("falls back to generic skills for an unrecognized/missing location tag", () => {
    const skills = chooseSpecialtySkills("seed-a", "room-1", null);
    expect(skills).toHaveLength(3);
    for (const s of skills) expect(ALL_SKILLS).toContain(s);
  });

  it("is deterministic for the same seed/roomId/tag", () => {
    const a = chooseSpecialtySkills("seed-x", "room-9", "dragon");
    const b = chooseSpecialtySkills("seed-x", "room-9", "dragon");
    expect(a).toEqual(b);
  });

  it("varies by roomId under the same seed (different rooms get different picks)", () => {
    const a = chooseSpecialtySkills("seed-x", "room-1", "beast");
    const b = chooseSpecialtySkills("seed-x", "room-2", "beast");
    // Both share beast's 2 themed skills; only the 3rd (generic) slot can differ.
    expect(a[0]).toBe(b[0]);
    expect(a[1]).toBe(b[1]);
  });
});

describe("dcForAttempt", () => {
  const specialtySkills = ["religion", "intimidation", "society"];

  it("uses the room's Simple DC for a specialty skill", () => {
    expect(
      dcForAttempt({ partyLevel: 5, skill: "religion", specialtySkills }),
    ).toBe(20);
  });

  it("adds NON_SPECIALTY_DC_BUMP for a non-specialty skill", () => {
    expect(
      dcForAttempt({ partyLevel: 5, skill: "athletics", specialtySkills }),
    ).toBe(20 + NON_SPECIALTY_DC_BUMP);
  });
});

describe("initSkillChallengeState", () => {
  it("starts at 0 VP, 0 attempts, unresolved, with the tunable target", () => {
    const state = initSkillChallengeState({
      seed: "s",
      roomId: "r1",
      locationTag: "undead",
      partySize: 4,
    });
    expect(state.vp).toBe(0);
    expect(state.attemptsUsed).toBe(0);
    expect(state.resolved).toBeNull();
    expect(state.vpTarget).toBe(VP_TARGET);
    expect(state.attemptBudget).toBe(6);
    expect(state.specialtySkills).toHaveLength(3);
  });

  it("uses a valid template's own specialtySkills instead of the generic location-tag pick", () => {
    const template = {
      kind: "skill_challenge",
      specialtySkills: ["diplomacy", "deception", "intimidation"],
    };
    const state = initSkillChallengeState({
      seed: "s",
      roomId: "r1",
      locationTag: "undead",
      partySize: 4,
      template,
    });
    expect(state.specialtySkills).toEqual([
      "diplomacy",
      "deception",
      "intimidation",
    ]);
  });

  it("falls back to the generic pick for an invalid/missing template", () => {
    const withNull = initSkillChallengeState({
      seed: "s",
      roomId: "r1",
      locationTag: "undead",
      partySize: 4,
      template: null,
    });
    const withInvalid = initSkillChallengeState({
      seed: "s",
      roomId: "r1",
      locationTag: "undead",
      partySize: 4,
      template: { kind: "puzzle", specialtySkills: ["diplomacy"] },
    });
    const generic = chooseSpecialtySkills("s", "r1", "undead");
    expect(withNull.specialtySkills).toEqual(generic);
    expect(withInvalid.specialtySkills).toEqual(generic);
    expect(withNull.name).toBeNull();
    expect(withNull.summary).toBeNull();
    expect(withNull.skillFlavor).toEqual({});
  });

  it("persists a valid template's own name/summary/skillFlavor (#166)", () => {
    const template = {
      kind: "skill_challenge",
      name: "A Council Divided",
      summary: "Quarreling factions need talking down.",
      specialtySkills: ["diplomacy", "deception", "intimidation"],
      skillFlavor: { diplomacy: "Appeal to shared interests." },
    };
    const state = initSkillChallengeState({
      seed: "s",
      roomId: "r1",
      locationTag: "undead",
      partySize: 4,
      template,
    });
    expect(state.name).toBe("A Council Divided");
    expect(state.summary).toBe("Quarreling factions need talking down.");
    expect(state.skillFlavor).toEqual({
      diplomacy: "Appeal to shared interests.",
    });
  });
});

describe("isValidSkillChallengeTemplate", () => {
  it("accepts a real skill_challenge entry with exactly 3 real skills", () => {
    expect(
      isValidSkillChallengeTemplate({
        kind: "skill_challenge",
        specialtySkills: ["acrobatics", "athletics", "stealth"],
      }),
    ).toBe(true);
  });

  it("rejects the wrong kind", () => {
    expect(
      isValidSkillChallengeTemplate({
        kind: "puzzle",
        specialtySkills: ["acrobatics", "athletics", "stealth"],
      }),
    ).toBe(false);
  });

  it("rejects anything other than exactly 3 specialtySkills", () => {
    expect(
      isValidSkillChallengeTemplate({
        kind: "skill_challenge",
        specialtySkills: ["acrobatics", "athletics"],
      }),
    ).toBe(false);
  });

  it("rejects a skill slug that isn't a real ALL_SKILLS entry", () => {
    expect(
      isValidSkillChallengeTemplate({
        kind: "skill_challenge",
        specialtySkills: ["acrobatics", "athletics", "perception"],
      }),
    ).toBe(false);
  });

  it("rejects null/undefined", () => {
    expect(isValidSkillChallengeTemplate(null)).toBe(false);
    expect(isValidSkillChallengeTemplate(undefined)).toBe(false);
  });
});

describe("selectSkillChallengeTemplate", () => {
  const entries = [
    { id: "a", kind: "puzzle", specialtySkills: ["society"] },
    {
      id: "b",
      kind: "skill_challenge",
      specialtySkills: ["acrobatics", "athletics", "stealth"],
    },
    {
      id: "c",
      kind: "skill_challenge",
      specialtySkills: ["diplomacy", "deception", "intimidation"],
    },
    { id: "d", kind: "trap", specialtySkills: [] },
  ];

  it("only ever picks from valid skill_challenge entries, never other kinds", () => {
    for (let i = 0; i < 20; i += 1) {
      const picked = selectSkillChallengeTemplate(entries, `seed-${i}`, "r1");
      expect(["b", "c"]).toContain(picked.id);
    }
  });

  it("is deterministic for the same seed/roomId", () => {
    const a = selectSkillChallengeTemplate(entries, "seed-x", "room-9");
    const b = selectSkillChallengeTemplate(entries, "seed-x", "room-9");
    expect(a).toEqual(b);
  });

  it("returns null when there is no valid skill_challenge entry at all", () => {
    const noneValid = [{ id: "a", kind: "puzzle", specialtySkills: [] }];
    expect(selectSkillChallengeTemplate(noneValid, "s", "r1")).toBeNull();
  });

  it("returns null for an empty/missing entries list", () => {
    expect(selectSkillChallengeTemplate([], "s", "r1")).toBeNull();
    expect(selectSkillChallengeTemplate(undefined, "s", "r1")).toBeNull();
  });
});

describe("applySkillChallengeAttempt", () => {
  const fresh = () =>
    initSkillChallengeState({
      seed: "s",
      roomId: "r1",
      locationTag: "undead",
      partySize: 4,
    });

  it("adds a success's VP and consumes one attempt", () => {
    const next = applySkillChallengeAttempt(fresh(), "success");
    expect(next.vp).toBe(1);
    expect(next.attemptsUsed).toBe(1);
    expect(next.resolved).toBeNull();
  });

  it("resolves success the moment vp reaches vpTarget", () => {
    let state = fresh();
    state = applySkillChallengeAttempt(state, "criticalSuccess"); // vp 2
    state = applySkillChallengeAttempt(state, "criticalSuccess"); // vp 4
    state = applySkillChallengeAttempt(state, "criticalSuccess"); // vp 6 -> target
    expect(state.vp).toBe(6);
    expect(state.resolved).toBe("success");
  });

  it("resolves success even on the party's very last available attempt", () => {
    // attemptBudget 6, vpTarget 6: six plain successes (+1 VP each) land
    // exactly on target on the final available attempt, not before.
    let state = fresh();
    for (let i = 0; i < 5; i += 1) {
      state = applySkillChallengeAttempt(state, "success");
      expect(state.resolved).toBeNull();
    }
    state = applySkillChallengeAttempt(state, "success");
    expect(state.vp).toBe(6);
    expect(state.attemptsUsed).toBe(6);
    expect(state.resolved).toBe("success");
  });

  it("resolves failure once the attempt budget runs out short of the target", () => {
    let state = fresh(); // attemptBudget 6, vpTarget 6
    for (let i = 0; i < 6; i += 1)
      state = applySkillChallengeAttempt(state, "failure");
    expect(state.vp).toBe(0);
    expect(state.attemptsUsed).toBe(6);
    expect(state.resolved).toBe("failure");
  });

  it("never lets vp go negative even after a critical failure at 0", () => {
    const next = applySkillChallengeAttempt(fresh(), "criticalFailure");
    expect(next.vp).toBe(0);
  });

  it("is a no-op once already resolved", () => {
    let state = fresh();
    for (let i = 0; i < 6; i += 1)
      state = applySkillChallengeAttempt(state, "failure");
    expect(state.resolved).toBe("failure");
    const again = applySkillChallengeAttempt(state, "criticalSuccess");
    expect(again).toEqual(state);
  });
});
