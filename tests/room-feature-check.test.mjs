import { readFileSync } from "node:fs";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { promptRoomFeatureCheck } from "../scripts/room-feature-check.mjs";

const chars = [{ id: "a1", name: "Amiri" }];
const state = {
  rooms: {
    p1: {
      puzzle: {
        stages: [
          { skill: "thievery", dc: 18, attempted: false },
          { skill: "arcana", dc: 20, attempted: true },
        ],
      },
    },
    p2: { puzzle: { stages: [{ skill: "arcana", dc: 20, attempted: true }] } },
    c1: { challenge: { specialtySkills: ["diplomacy", "stealth"] } },
    c2: { challenge: { specialtySkills: [] } },
  },
};

let deps;
beforeEach(() => {
  deps = {
    getRunState: () => state,
    characters: chars,
    skillLabel: (s) => s.toUpperCase(),
    promptPuzzleStage: vi.fn(async () => ({ actorId: "a1", stageIndex: 0 })),
    promptSkillChallenge: vi.fn(async () => ({ actorId: "a1", skill: "stealth" })),
    attemptPuzzleStageFor: vi.fn(async () => ({})),
    attemptSkillChallengeFor: vi.fn(async () => ({})),
    notify: vi.fn(),
    localize: (k) => k,
    inFlight: new Set(),
  };
});

const route = (kind, roomId) => ({ sceneId: "s1", roomId, kind });

describe("promptRoomFeatureCheck (#822)", () => {
  it("puzzle: offers the stages (indexed, labeled) and attempts the chosen one", async () => {
    await promptRoomFeatureCheck(route("puzzle", "p1"), deps);
    expect(deps.promptPuzzleStage).toHaveBeenCalledWith(
      [
        { index: 0, skill: "thievery", dc: 18, label: "THIEVERY", attempted: false },
        { index: 1, skill: "arcana", dc: 20, label: "ARCANA", attempted: true },
      ],
      chars,
    );
    expect(deps.attemptPuzzleStageFor).toHaveBeenCalledWith("s1", "p1", 0, "a1");
    expect(deps.attemptSkillChallengeFor).not.toHaveBeenCalled();
  });

  it("skill challenge: offers the specialty skills and attempts the chosen one", async () => {
    await promptRoomFeatureCheck(route("skill_challenge", "c1"), deps);
    expect(deps.promptSkillChallenge).toHaveBeenCalledWith(["diplomacy", "stealth"], chars);
    expect(deps.attemptSkillChallengeFor).toHaveBeenCalledWith("s1", "a1", "stealth");
    expect(deps.attemptPuzzleStageFor).not.toHaveBeenCalled();
  });

  it("cancelled dialog attempts nothing", async () => {
    deps.promptPuzzleStage.mockResolvedValue(null);
    deps.promptSkillChallenge.mockResolvedValue(null);
    await promptRoomFeatureCheck(route("puzzle", "p1"), deps);
    await promptRoomFeatureCheck(route("skill_challenge", "c1"), deps);
    expect(deps.attemptPuzzleStageFor).not.toHaveBeenCalled();
    expect(deps.attemptSkillChallengeFor).not.toHaveBeenCalled();
  });

  it("no party characters: notice, no dialog", async () => {
    deps.characters = [];
    await promptRoomFeatureCheck(route("puzzle", "p1"), deps);
    await promptRoomFeatureCheck(route("skill_challenge", "c1"), deps);
    expect(deps.notify).toHaveBeenCalledWith("PF2EDC.Dungeon.Puzzle.DialogNoCharacters");
    expect(deps.notify).toHaveBeenCalledWith("PF2EDC.Dungeon.SkillChallenge.DialogNoCharacters");
    expect(deps.promptPuzzleStage).not.toHaveBeenCalled();
    expect(deps.promptSkillChallenge).not.toHaveBeenCalled();
  });

  it("nothing left to attempt: notice, no dialog", async () => {
    await promptRoomFeatureCheck(route("puzzle", "p2"), deps);
    await promptRoomFeatureCheck(route("skill_challenge", "c2"), deps);
    expect(deps.notify).toHaveBeenCalledWith("PF2EDC.Dungeon.Puzzle.DialogNothingToAttempt");
    expect(deps.notify).toHaveBeenCalledWith("PF2EDC.Dungeon.SkillChallenge.DialogNothingToAttempt");
    expect(deps.promptPuzzleStage).not.toHaveBeenCalled();
    expect(deps.promptSkillChallenge).not.toHaveBeenCalled();
  });

  it("treasure is completely unaffected: no prompt, no notice, no state read", async () => {
    deps.getRunState = vi.fn();
    await promptRoomFeatureCheck(route("treasure", "t1"), deps);
    expect(deps.getRunState).not.toHaveBeenCalled();
    expect(deps.promptPuzzleStage).not.toHaveBeenCalled();
    expect(deps.promptSkillChallenge).not.toHaveBeenCalled();
    expect(deps.notify).not.toHaveBeenCalled();
  });

  it("missing room/puzzle state is a quiet no-op, not a crash", async () => {
    await promptRoomFeatureCheck(route("puzzle", "nope"), deps);
    await promptRoomFeatureCheck(route("skill_challenge", "nope"), deps);
    expect(deps.promptPuzzleStage).not.toHaveBeenCalled();
  });

  it("a second click while a dialog is open does not stack another", async () => {
    let release;
    deps.promptPuzzleStage.mockImplementation(
      () => new Promise((r) => (release = () => r(null))),
    );
    const first = promptRoomFeatureCheck(route("puzzle", "p1"), deps);
    await promptRoomFeatureCheck(route("puzzle", "p1"), deps);
    expect(deps.promptPuzzleStage).toHaveBeenCalledTimes(1);
    release();
    await first;
    deps.promptPuzzleStage.mockResolvedValue(null);
    await promptRoomFeatureCheck(route("puzzle", "p1"), deps);
    expect(deps.promptPuzzleStage).toHaveBeenCalledTimes(2);
  });
});

describe("module.mjs wiring (#822)", () => {
  const src = readFileSync(new URL("../scripts/module.mjs", import.meta.url), "utf8");
  const start = src.indexOf("async function triggerRoomFeatureToken");
  const body = src.slice(start, src.indexOf('Hooks.on("targetToken"'));
  it("reveals first (GM direct / non-GM relay), then prompts the check", () => {
    expect(body).toContain("runRoomFeatureAction(");
    expect(body).toContain('requestDungeonAction("roomFeatureInteract"');
    expect(body.indexOf("runRoomFeatureAction(")).toBeLessThan(body.indexOf("promptRoomFeatureCheck("));
    expect(body.indexOf('requestDungeonAction("roomFeatureInteract"')).toBeLessThan(
      body.indexOf("promptRoomFeatureCheck("),
    );
  });
  it("wires the real dialogs and shared attempt functions, whole party only", () => {
    for (const s of [
      "promptPuzzleStage",
      "promptSkillChallenge",
      "attemptPuzzleStageFor",
      "attemptSkillChallengeFor",
      'actor.type === "character"',
    ])
      expect(src).toContain(s);
    expect(src).not.toContain("actor.isOwner");
  });
  it("a failed GM reveal does not go on to prompt", () => {
    expect(body).toMatch(/result\?\.ok === false|catch[\s\S]*return/);
  });
});
