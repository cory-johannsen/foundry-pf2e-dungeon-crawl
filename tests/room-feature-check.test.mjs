import { readFileSync } from "node:fs";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { promptRoomFeatureCheck, handleRoomFeatureClick } from "../scripts/room-feature-check.mjs";

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
    p3: { puzzle: { resolved: "success", stages: [{ skill: "arcana", dc: 20, attempted: false }] } },
    c3: { challenge: { resolved: "failure", specialtySkills: ["stealth"] } },
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
    isGM: true,
    relay: vi.fn(async () => true),
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

  it("resolved puzzle / challenge: notice, no dialog (even with unattempted stages / skills left)", async () => {
    await promptRoomFeatureCheck(route("puzzle", "p3"), deps);
    expect(deps.notify).toHaveBeenCalledWith("PF2EDC.Dungeon.Puzzle.DialogNothingToAttempt");
    await promptRoomFeatureCheck(route("skill_challenge", "c3"), deps);
    expect(deps.notify).toHaveBeenCalledWith("PF2EDC.Dungeon.SkillChallenge.DialogNothingToAttempt");
    expect(deps.promptPuzzleStage).not.toHaveBeenCalled();
    expect(deps.promptSkillChallenge).not.toHaveBeenCalled();
  });

  it("non-GM: relays attemptPuzzleStage / attemptSkillChallenge and never rolls or records locally", async () => {
    deps.isGM = false;
    await promptRoomFeatureCheck(route("puzzle", "p1"), deps);
    await promptRoomFeatureCheck(route("skill_challenge", "c1"), deps);
    expect(deps.relay).toHaveBeenCalledWith("attemptPuzzleStage", { sceneId: "s1", roomId: "p1", stageIndex: 0, actorId: "a1" });
    expect(deps.relay).toHaveBeenCalledWith("attemptSkillChallenge", { sceneId: "s1", roomId: "c1", actorId: "a1", skill: "stealth" });
    expect(deps.relay).not.toHaveBeenCalledWith("recordPuzzleStageOutcome", expect.anything());
    expect(deps.attemptPuzzleStageFor).not.toHaveBeenCalled();
    expect(deps.attemptSkillChallengeFor).not.toHaveBeenCalled();
  });

  it("non-GM: a refused/failed relay shows the request-failed notice", async () => {
    deps.isGM = false;
    deps.relay.mockResolvedValue(false);
    await promptRoomFeatureCheck(route("puzzle", "p1"), deps);
    expect(deps.notify).toHaveBeenCalledWith("PF2EDC.Dungeon.RequestFailedWarning");
  });

  it("GM keeps the direct path (no relay)", async () => {
    await promptRoomFeatureCheck(route("puzzle", "p1"), deps);
    expect(deps.relay).not.toHaveBeenCalled();
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

describe("handleRoomFeatureClick (#822)", () => {
  const withClick = (over) => (deps.promptPuzzleStage.mockClear(), deps.promptSkillChallenge.mockClear(), { ...deps, runAction: vi.fn(async () => ({ ok: true })), onError: vi.fn(), ...over });
  it("GM: reveals then prompts; a not-acted reveal or a throw never prompts", async () => {
    let d = withClick({});
    await handleRoomFeatureClick(route("puzzle", "p1"), d);
    expect(d.runAction).toHaveBeenCalled();
    expect(d.promptPuzzleStage).toHaveBeenCalledTimes(1);
    d = withClick({ runAction: vi.fn(async () => ({ ok: false })) });
    await handleRoomFeatureClick(route("puzzle", "p1"), d);
    expect(d.promptPuzzleStage).not.toHaveBeenCalled();
    d = withClick({ runAction: vi.fn(async () => { throw new Error("x"); }) });
    await handleRoomFeatureClick(route("puzzle", "p1"), d);
    expect(d.promptPuzzleStage).not.toHaveBeenCalled();
    expect(d.onError).toHaveBeenCalled();
  });
  it("non-GM: relays the reveal first, and a failed reveal relay never opens the dialog", async () => {
    let d = withClick({ isGM: false });
    await handleRoomFeatureClick(route("puzzle", "p1"), d);
    expect(d.relay.mock.calls[0][0]).toBe("roomFeatureInteract");
    expect(d.promptPuzzleStage).toHaveBeenCalledTimes(1);
    d = withClick({ isGM: false, relay: vi.fn(async () => false) });
    await handleRoomFeatureClick(route("puzzle", "p1"), d);
    await handleRoomFeatureClick(route("skill_challenge", "c1"), d);
    expect(d.promptPuzzleStage).not.toHaveBeenCalled();
    expect(d.promptSkillChallenge).not.toHaveBeenCalled();
    expect(d.relay).not.toHaveBeenCalledWith("attemptPuzzleStage", expect.anything());
  });
  it("treasure click: reveal/claim only, no dialog, no notice", async () => {
    const d = withClick({});
    await handleRoomFeatureClick(route("treasure", "t1"), d);
    expect(d.runAction).toHaveBeenCalled();
    expect(d.promptPuzzleStage).not.toHaveBeenCalled();
    expect(d.promptSkillChallenge).not.toHaveBeenCalled();
    expect(d.notify).not.toHaveBeenCalled();
  });
});

describe("module.mjs wiring (#822)", () => {
  const src = readFileSync(new URL("../scripts/module.mjs", import.meta.url), "utf8");
  const start = src.indexOf("async function triggerRoomFeatureToken");
  const body = src.slice(start, src.indexOf('Hooks.on("targetToken"'));
  it("delegates the click to handleRoomFeatureClick with the real collaborators", () => {
    expect(body).toContain("handleRoomFeatureClick(");
    expect(body).toContain("relay: requestDungeonAction");
    expect(body).toContain("runRoomFeatureAction(");
    for (const s of [
      "promptPuzzleStage",
      "promptSkillChallenge",
      "attemptPuzzleStageFor",
      "attemptSkillChallengeFor",
      "attemptableCharacters(",
    ])
      expect(body).toContain(s);
    expect(src).not.toContain("actor.isOwner");
  });
});
