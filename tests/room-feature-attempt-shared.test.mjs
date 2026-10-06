import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";

// #822: the roll-then-record-or-relay logic extracted from the tracker's
// #onAttemptPuzzleStage / #onAttemptSkillChallenge so the token-click
// dialogs share it. dungeon-app.mjs destructures foundry.applications.api
// at import time, hence the stubs before the dynamic import.

const mocks = vi.hoisted(() => ({
  state: null,
  grantXp: vi.fn(async () => {}),
  rollPuzzle: vi.fn(),
  rollChallenge: vi.fn(),
  relay: vi.fn(async () => {}),
  recordPuzzle: vi.fn(async () => ({ rooms: {} })),
  recordChallenge: vi.fn(async () => ({ rooms: {} })),
}));

vi.mock("../scripts/puzzle.mjs", () => ({ rollPuzzleStageAttempt: mocks.rollPuzzle }));
vi.mock("../scripts/skill-challenge.mjs", () => ({ rollSkillChallengeAttempt: mocks.rollChallenge }));
vi.mock("../scripts/dungeon-remote.mjs", () => ({ requestDungeonAction: mocks.relay }));
vi.mock("../scripts/foundry-api.mjs", async (orig) => ({
  ...(await orig()),
  makeFoundryApi: () => ({ partyLevel: async () => 3, grantPartyXp: mocks.grantXp }),
}));
vi.mock("../scripts/dungeon-runner.mjs", async (orig) => ({
  ...(await orig()),
  getRunState: () => mocks.state,
  recordPuzzleStageAttempt: mocks.recordPuzzle,
  recordSkillChallengeAttempt: mocks.recordChallenge,
}));

let attemptPuzzleStageFor, attemptSkillChallengeFor, skillLabel;

beforeAll(async () => {
  globalThis.foundry = {
    applications: { api: { ApplicationV2: class {}, HandlebarsApplicationMixin: (B) => B } },
    utils: { escapeHTML: (s) => String(s) },
  };
  globalThis.Hooks = { on() {}, once() {}, off() {}, callAll() {} };
  globalThis.CONFIG = { PF2E: { skills: {} } };
  ({ attemptPuzzleStageFor, attemptSkillChallengeFor, skillLabel } = await import(
    "../scripts/ui/dungeon-app.mjs"
  ));
});

function setup({ isGM }) {
  globalThis.game = {
    user: { isGM },
    actors: { get: (id) => (id === "a1" ? { id: "a1" } : null) },
    scenes: { get: () => null },
    i18n: { localize: (k) => k, format: (k) => k },
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.relay.mockResolvedValue(true);
  mocks.grantXp.mockResolvedValue(undefined);
  mocks.recordPuzzle.mockResolvedValue({ rooms: {} });
  mocks.recordChallenge.mockResolvedValue({ rooms: {} });
  mocks.state = {
    currentRoomId: "r1",
    difficulty: "moderate",
    rooms: {
      r1: {
        id: "r1",
        puzzle: {
          stages: [
            { skill: "thievery", dc: 18, attempted: false },
            { skill: "arcana", dc: 20, attempted: true },
          ],
        },
        challenge: { specialtySkills: ["diplomacy", "stealth"] },
      },
    },
  };
  mocks.rollPuzzle.mockResolvedValue({ outcome: "success" });
  mocks.rollChallenge.mockResolvedValue({ outcome: "criticalSuccess" });
});

describe("attemptPuzzleStageFor (#822)", () => {
  it("GM: rolls the stage's own skill/DC and records the outcome directly", async () => {
    setup({ isGM: true });
    const r = await attemptPuzzleStageFor("s1", "r1", 0, "a1");
    expect(r).toEqual({ outcome: "success" });
    expect(mocks.rollPuzzle).toHaveBeenCalledWith({ id: "a1" }, "thievery", 18);
    expect(mocks.recordPuzzle).toHaveBeenCalledWith("s1", "r1", 0, "success");
    expect(mocks.relay).not.toHaveBeenCalled();
  });

  it("non-GM: rolls locally and relays only the outcome", async () => {
    setup({ isGM: false });
    await attemptPuzzleStageFor("s1", "r1", 0, "a1");
    expect(mocks.relay).toHaveBeenCalledWith("recordPuzzleStageOutcome", {
      sceneId: "s1",
      roomId: "r1",
      stageIndex: 0,
      outcome: "success",
    });
    expect(mocks.recordPuzzle).not.toHaveBeenCalled();
  });

  it("null (no roll) for an already-attempted stage, unknown stage, actor or room", async () => {
    setup({ isGM: true });
    expect(await attemptPuzzleStageFor("s1", "r1", 1, "a1")).toBeNull();
    expect(await attemptPuzzleStageFor("s1", "r1", 9, "a1")).toBeNull();
    expect(await attemptPuzzleStageFor("s1", "r1", 0, "nope")).toBeNull();
    expect(await attemptPuzzleStageFor("s1", "zz", 0, "a1")).toBeNull();
    expect(mocks.rollPuzzle).not.toHaveBeenCalled();
  });

  it("null and nothing recorded when the roll comes back empty", async () => {
    setup({ isGM: true });
    mocks.rollPuzzle.mockResolvedValue(null);
    expect(await attemptPuzzleStageFor("s1", "r1", 0, "a1")).toBeNull();
    expect(mocks.recordPuzzle).not.toHaveBeenCalled();
  });
});

describe("attemptSkillChallengeFor (#822)", () => {
  it("GM: records; non-GM: relays; only specialty skills allowed", async () => {
    setup({ isGM: true });
    const r = await attemptSkillChallengeFor("s1", "a1", "diplomacy");
    expect(r).toEqual({ outcome: "criticalSuccess" });
    expect(mocks.recordChallenge).toHaveBeenCalledWith("s1", "r1", "criticalSuccess");

    setup({ isGM: false });
    await attemptSkillChallengeFor("s1", "a1", "stealth");
    expect(mocks.relay).toHaveBeenCalledWith("recordSkillChallengeOutcome", {
      sceneId: "s1",
      roomId: "r1",
      outcome: "criticalSuccess",
    });

    vi.clearAllMocks();
    expect(await attemptSkillChallengeFor("s1", "a1", "athletics")).toBeNull();
    expect(await attemptSkillChallengeFor("s1", "nope", "stealth")).toBeNull();
    expect(mocks.rollChallenge).not.toHaveBeenCalled();
  });
});

describe("relayed (requestingUserId) validation, GM-side (#822)", () => {
  const mine = { id: "a1", ownership: { p: 3 } };
  const theirs = { id: "a2", ownership: { q: 3 } };
  function relaySetup() {
    globalThis.game = {
      user: { isGM: true },
      users: { get: (id) => ({ isGM: id === "gm" }) },
      actors: {
        get: (id) => ({ a1: mine, a2: theirs, zz: { id: "zz", ownership: { p: 3 } } })[id] ?? null,
        party: { members: [mine, theirs] },
      },
      scenes: { get: () => null },
      i18n: { localize: (k) => k, format: (k) => k },
    };
    mocks.state.hostUserId = "h";
    mocks.state.completed = false;
  }
  beforeEach(relaySetup);

  it("puzzle: a non-host owner rolls their own PC GM-side and it is recorded (no relay back)", async () => {
    const r = await attemptPuzzleStageFor("s1", "r1", 0, "a1", { requestingUserId: "p" });
    expect(r).toEqual({ outcome: "success" });
    expect(mocks.recordPuzzle).toHaveBeenCalledWith("s1", "r1", 0, "success");
    expect(mocks.relay).not.toHaveBeenCalled();
  });
  it("puzzle: refuses a PC the requester doesn't own, a non-party actor, a stranger, a stale room", async () => {
    const d = { requestingUserId: "p" };
    expect(await attemptPuzzleStageFor("s1", "r1", 0, "a2", d)).toBeNull();
    expect(await attemptPuzzleStageFor("s1", "r1", 0, "zz", d)).toBeNull();
    expect(await attemptPuzzleStageFor("s1", "r1", 0, "a1", { requestingUserId: "x" })).toBeNull();
    mocks.state.currentRoomId = "other";
    expect(await attemptPuzzleStageFor("s1", "r1", 0, "a1", d)).toBeNull();
    mocks.state.currentRoomId = "r1";
    mocks.state.completed = true;
    expect(await attemptPuzzleStageFor("s1", "r1", 0, "a1", d)).toBeNull();
    expect(mocks.rollPuzzle).not.toHaveBeenCalled();
  });
  it("puzzle: refuses an already-attempted stage and a resolved puzzle", async () => {
    const d = { requestingUserId: "p" };
    expect(await attemptPuzzleStageFor("s1", "r1", 1, "a1", d)).toBeNull();
    mocks.state.rooms.r1.puzzle.resolved = "success";
    expect(await attemptPuzzleStageFor("s1", "r1", 0, "a1", d)).toBeNull();
    expect(mocks.rollPuzzle).not.toHaveBeenCalled();
  });
  it("puzzle: GM and host may choose any party member", async () => {
    expect(await attemptPuzzleStageFor("s1", "r1", 0, "a2", { requestingUserId: "gm" })).not.toBeNull();
    expect(await attemptPuzzleStageFor("s1", "r1", 0, "a2", { requestingUserId: "h" })).not.toBeNull();
  });
  it("skill challenge: owner ok; not-owned / non-party / stranger / resolved / non-specialty refused", async () => {
    expect(await attemptSkillChallengeFor("s1", "a1", "stealth", { requestingUserId: "p" })).toEqual({ outcome: "criticalSuccess" });
    expect(mocks.recordChallenge).toHaveBeenCalledWith("s1", "r1", "criticalSuccess");
    vi.clearAllMocks();
    const d = { requestingUserId: "p" };
    expect(await attemptSkillChallengeFor("s1", "a2", "stealth", d)).toBeNull();
    expect(await attemptSkillChallengeFor("s1", "zz", "stealth", d)).toBeNull();
    expect(await attemptSkillChallengeFor("s1", "a1", "stealth", { requestingUserId: "x" })).toBeNull();
    expect(await attemptSkillChallengeFor("s1", "a1", "athletics", d)).toBeNull();
    mocks.state.rooms.r1.challenge.resolved = "failure";
    expect(await attemptSkillChallengeFor("s1", "a1", "stealth", d)).toBeNull();
    expect(mocks.rollChallenge).not.toHaveBeenCalled();
  });
});

describe("GM-side attempt lock and idempotent XP (#822)", () => {
  const deferred = () => {
    let resolve;
    const promise = new Promise((r) => (resolve = r));
    return { promise, resolve };
  };
  beforeEach(() => {
    globalThis.game = {
      user: { isGM: true },
      users: { get: () => ({ isGM: true }) },
      actors: {
        get: (id) => ({ id }),
        party: { members: [{ id: "a1" }, { id: "a2" }] },
      },
      scenes: { get: () => null },
      i18n: { localize: (k) => k, format: (k) => k },
    };
    mocks.state.hostUserId = "h";
    mocks.state.completed = false;
    mocks.state.rooms.r2 = { id: "r2", puzzle: { stages: [{ skill: "arcana", dc: 20, attempted: false }] } };
    mocks.state.rooms.r1.puzzle.stages[1].attempted = false;
  });

  it("(a) a second concurrent attempt on the same room is refused and records exactly once", async () => {
    const d = deferred();
    mocks.rollPuzzle.mockReturnValueOnce(d.promise);
    const gm = { requestingUserId: "gm" };
    const first = attemptPuzzleStageFor("s1", "r1", 0, "a1", gm);
    const second = await attemptPuzzleStageFor("s1", "r1", 1, "a2", gm);
    expect(second).toBeNull();
    expect(mocks.rollPuzzle).toHaveBeenCalledTimes(1);
    d.resolve({ outcome: "success" });
    await first;
    expect(mocks.recordPuzzle).toHaveBeenCalledTimes(1);
  });

  it("(a) same for skill challenges", async () => {
    const d = deferred();
    mocks.rollChallenge.mockReturnValueOnce(d.promise);
    const first = attemptSkillChallengeFor("s1", "a1", "stealth", { requestingUserId: "gm" });
    const second = await attemptSkillChallengeFor("s1", "a2", "stealth", { requestingUserId: "gm" });
    expect(second).toBeNull();
    d.resolve({ outcome: "success" });
    await first;
    expect(mocks.recordChallenge).toHaveBeenCalledTimes(1);
  });

  it("(b) the lock is released after a throw in the roll; a later attempt succeeds", async () => {
    mocks.rollPuzzle.mockRejectedValueOnce(new Error("boom"));
    await expect(attemptPuzzleStageFor("s1", "r1", 0, "a1")).rejects.toThrow("boom");
    expect(await attemptPuzzleStageFor("s1", "r1", 0, "a1")).toEqual({ outcome: "success" });
    mocks.rollChallenge.mockRejectedValueOnce(new Error("boom"));
    await expect(attemptSkillChallengeFor("s1", "a1", "stealth")).rejects.toThrow("boom");
    expect(await attemptSkillChallengeFor("s1", "a1", "stealth")).not.toBeNull();
  });

  it("(d) different rooms do not block each other", async () => {
    const d = deferred();
    mocks.rollPuzzle.mockReturnValueOnce(d.promise);
    const first = attemptPuzzleStageFor("s1", "r1", 0, "a1");
    const other = await attemptPuzzleStageFor("s1", "r2", 0, "a1");
    expect(other).toEqual({ outcome: "success" });
    d.resolve({ outcome: "success" });
    await first;
  });

  it("(c) recording an already-resolved puzzle/challenge grants no XP and resolves nothing", async () => {
    const { recordPuzzleStageOutcome, recordSkillChallengeOutcome } = await import("../scripts/ui/dungeon-app.mjs");
    mocks.state.rooms.r1.puzzle.resolved = "success";
    mocks.state.rooms.r1.challenge.resolved = "success";
    mocks.recordPuzzle.mockResolvedValue({ rooms: { r1: { puzzle: { resolved: "success" } } } });
    mocks.recordChallenge.mockResolvedValue({ rooms: { r1: { challenge: { resolved: "success" } } } });
    await recordPuzzleStageOutcome("s1", "r1", 0, "success");
    await recordSkillChallengeOutcome("s1", "r1", "success");
    expect(mocks.grantXp).not.toHaveBeenCalled();
  });

  it("(c) the not-resolved -> resolved transition grants XP exactly once", async () => {
    const { recordPuzzleStageOutcome } = await import("../scripts/ui/dungeon-app.mjs");
    mocks.recordPuzzle.mockResolvedValue({ rooms: { r1: { puzzle: { resolved: "success" } } } });
    await recordPuzzleStageOutcome("s1", "r1", 0, "success").catch(() => {});
    expect(mocks.grantXp).toHaveBeenCalledTimes(1);
  });

  it("skill challenge relay: a payload roomId that isn't the current room is refused", async () => {
    const d = { requestingUserId: "gm", roomId: "elsewhere" };
    expect(await attemptSkillChallengeFor("s1", "a1", "stealth", d)).toBeNull();
    expect(mocks.rollChallenge).not.toHaveBeenCalled();
    expect(await attemptSkillChallengeFor("s1", "a1", "stealth", { requestingUserId: "gm", roomId: "r1" })).not.toBeNull();
  });
});

describe("relay wiring (#822)", () => {
  const remote = readFileSync(new URL("../scripts/dungeon-remote.mjs", import.meta.url), "utf8");
  it("attempt actions registered with requestingUserId; widening via WIDENED_ACTIONS; outcome actions not widened", () => {
    expect(remote).toContain("attemptPuzzleStage: async");
    expect(remote).toContain("attemptSkillChallenge: async");
    expect(remote).toContain("requestingUserId: args.requestingUserId");
    expect(remote).toContain("WIDENED_ACTIONS.has(msg.actionName)");
    const perms = readFileSync(new URL("../scripts/dungeon-permissions.mjs", import.meta.url), "utf8");
    const set = perms.slice(perms.indexOf("WIDENED_ACTIONS = new Set"), perms.indexOf("]);", perms.indexOf("WIDENED_ACTIONS = new Set")));
    expect(set).toContain("attemptPuzzleStage");
    expect(set).toContain("attemptSkillChallenge");
    expect(set).not.toContain("Outcome");
  });
});

describe("tracker handlers delegate to the shared functions (#822)", () => {
  const src = readFileSync(new URL("../scripts/ui/dungeon-app.mjs", import.meta.url), "utf8");
  it("both private handlers call the extracted helpers", () => {
    expect(src).toContain("await attemptPuzzleStageFor(");
    expect(src).toContain("await attemptSkillChallengeFor(sceneId, actorId, skill)");
    expect(src).toContain("export function skillLabel(");
  });
});
