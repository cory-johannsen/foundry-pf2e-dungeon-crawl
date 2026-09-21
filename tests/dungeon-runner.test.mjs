import { describe, it, expect } from "vitest";
import {
  createRun,
  markRoomOutcome,
  advanceToRoom,
  undoLastRoomEntry,
  canUndoRoomEntry,
  abandonRun,
  getRunState,
  ensureSkillChallenge,
  recordSkillChallengeAttempt,
  setObjective,
  findActiveHostedRun,
  findHostedRunForBroadcast,
  getPendingSkillChallengeCustomization,
  applySkillChallengeCustomization,
  ensurePuzzleState,
  recordPuzzleStageAttempt,
  getPendingPuzzleCustomization,
  applyPuzzleCustomization,
  ensureNarrativeState,
  getPendingNarrativeCustomization,
  applyNarrativeCustomization,
} from "../scripts/dungeon-runner.mjs";

function makeSettingsStub(initial = {}) {
  let store = { dungeonRuns: initial };
  return {
    get: (moduleId, key) => store[key],
    set: (moduleId, key, value) => {
      store = { ...store, [key]: value };
    },
  };
}

/** Moves currentIndex from the safe entry (room 0) to the first real room
 * (room 1) — its physical slot is already assigned by createRun, so this
 * never needs markRoomOutcome, matching how the real door-open trigger
 * reaches it. */
async function advancePastEntry(sceneId, settingsRef) {
  const state = getRunState(sceneId, { settingsRef });
  return advanceToRoom({ sceneId, roomId: state.rooms[1].id }, { settingsRef });
}

describe("createRun / getRunState", () => {
  it("creates a fresh run scoped to a scene: a safe entry room prepended, not counted in roomCount", async () => {
    const settingsRef = makeSettingsStub();
    const state = await createRun(
      { sceneId: "scene-1", roomCount: 5 },
      { settingsRef },
    );
    // roomCount (5) + the prepended entry room.
    expect(state.rooms).toHaveLength(6);
    expect(state.rooms[0].kind).toBe("safe_entry");
    expect(state.rooms[0].outcomeSlotId).toBeNull();
    expect(state.currentIndex).toBe(0);
    expect(state.completed).toBe(false);
    // The entry has nothing to resolve, so the first real room's slot is
    // also pre-assigned — see dungeon-runner.mjs's createRun.
    expect(state.physicalSlotByRoomId).toEqual({
      [state.rooms[0].id]: 0,
      [state.rooms[1].id]: 1,
    });
    expect(state.nextPhysicalSlot).toBe(2);
    expect(state.lastAutoEntry).toBeNull();
    expect(state.previousSceneId).toBeNull();
    expect(state.objective).toBeNull();
    expect(getRunState("scene-1", { settingsRef })).toEqual(state);
  });

  it("records the scene the party started from, for teardownDungeonRun to return them to (ITEM-18)", async () => {
    const settingsRef = makeSettingsStub();
    const state = await createRun(
      { sceneId: "scene-1", roomCount: 5, previousSceneId: "tavern-scene" },
      { settingsRef },
    );
    expect(state.previousSceneId).toBe("tavern-scene");
  });

  it("returns null for a scene with no run", () => {
    const settingsRef = makeSettingsStub();
    expect(getRunState("nothing-here", { settingsRef })).toBeNull();
  });

  it("keeps two scenes independent", async () => {
    const settingsRef = makeSettingsStub();
    await createRun(
      { sceneId: "scene-a", roomCount: 3, seed: "a" },
      { settingsRef },
    );
    await createRun(
      { sceneId: "scene-b", roomCount: 6, seed: "b" },
      { settingsRef },
    );
    const a = getRunState("scene-a", { settingsRef });
    const b = getRunState("scene-b", { settingsRef });
    expect(a.rooms).toHaveLength(4); // 3 + entry
    expect(b.rooms).toHaveLength(7); // 6 + entry
    expect(a.seed).toBe("a");
    expect(b.seed).toBe("b");
  });
});

describe("createRun hostUserId", () => {
  it("defaults hostUserId to null for a normal GM-run game", async () => {
    const settingsRef = makeSettingsStub();
    const state = await createRun(
      { sceneId: "scene-1", roomCount: 5 },
      { settingsRef },
    );
    expect(state.hostUserId).toBeNull();
  });

  it("stores an explicit hostUserId for a GM-less run", async () => {
    const settingsRef = makeSettingsStub();
    const state = await createRun(
      { sceneId: "scene-1", roomCount: 5, hostUserId: "player-1" },
      { settingsRef },
    );
    expect(state.hostUserId).toBe("player-1");
    expect(getRunState("scene-1", { settingsRef }).hostUserId).toBe("player-1");
  });
});

describe("findActiveHostedRun", () => {
  it("returns null when nothing is hosted", async () => {
    const settingsRef = makeSettingsStub();
    await createRun({ sceneId: "scene-1", roomCount: 5 }, { settingsRef });
    expect(findActiveHostedRun({ settingsRef })).toBeNull();
  });

  it("finds the one active hosted run", async () => {
    const settingsRef = makeSettingsStub();
    await createRun({ sceneId: "scene-1", roomCount: 5 }, { settingsRef });
    await createRun(
      { sceneId: "scene-2", roomCount: 5, hostUserId: "player-1" },
      { settingsRef },
    );
    expect(findActiveHostedRun({ settingsRef })).toEqual({
      sceneId: "scene-2",
      hostUserId: "player-1",
    });
  });

  it("ignores a completed run even if it was hosted", async () => {
    const settingsRef = makeSettingsStub();
    await createRun(
      { sceneId: "scene-1", roomCount: 2, hostUserId: "player-1" },
      { settingsRef },
    );
    // Resolve straight to the goal room to mark it completed.
    const state = getRunState("scene-1", { settingsRef });
    const completed = { ...state, completed: true };
    await settingsRef.set("deck-of-many-more-things", "dungeonRuns", {
      ...settingsRef.get("deck-of-many-more-things", "dungeonRuns"),
      "scene-1": completed,
    });
    expect(findActiveHostedRun({ settingsRef })).toBeNull();
  });
});

describe("findHostedRunForBroadcast", () => {
  it("returns the one active (not completed) hosted run — same as findActiveHostedRun would", async () => {
    const settingsRef = makeSettingsStub();
    await createRun({ sceneId: "scene-1", roomCount: 5 }, { settingsRef });
    await createRun(
      { sceneId: "scene-2", roomCount: 5, hostUserId: "player-1" },
      { settingsRef },
    );
    expect(findHostedRunForBroadcast({ settingsRef })).toEqual({
      sceneId: "scene-2",
      hostUserId: "player-1",
    });
  });

  it("still returns a completed hosted run — the behavioral difference from findActiveHostedRun, which excludes it", async () => {
    const settingsRef = makeSettingsStub();
    await createRun(
      { sceneId: "scene-1", roomCount: 2, hostUserId: "player-1" },
      { settingsRef },
    );
    // Resolve straight to the goal room to mark it completed.
    const state = getRunState("scene-1", { settingsRef });
    const completed = { ...state, completed: true };
    await settingsRef.set("deck-of-many-more-things", "dungeonRuns", {
      ...settingsRef.get("deck-of-many-more-things", "dungeonRuns"),
      "scene-1": completed,
    });
    expect(findActiveHostedRun({ settingsRef })).toBeNull();
    expect(findHostedRunForBroadcast({ settingsRef })).toEqual({
      sceneId: "scene-1",
      hostUserId: "player-1",
    });
  });

  it("returns null when there's no run with a hostUserId at all", async () => {
    const settingsRef = makeSettingsStub();
    await createRun({ sceneId: "scene-1", roomCount: 5 }, { settingsRef });
    expect(findHostedRunForBroadcast({ settingsRef })).toBeNull();
  });
});

describe("markRoomOutcome", () => {
  it("is a no-op on the safe entry room — nothing to resolve, no crash on a null outcome slot", async () => {
    const settingsRef = makeSettingsStub();
    await createRun(
      { sceneId: "s", roomCount: 5, seed: "fixed" },
      { settingsRef },
    );
    const before = getRunState("s", { settingsRef });
    const result = await markRoomOutcome(
      { sceneId: "s", succeeded: true },
      { settingsRef },
    );
    expect(result.effectKey).toBeNull();
    expect(result.mutation).toBeNull();
    expect(result.nextRoomId).toBeNull();
    expect(result.state).toEqual(before); // untouched — no history entry, no mutation
  });

  it("does not move currentIndex, and reports the next room + its assigned physical slot", async () => {
    const settingsRef = makeSettingsStub();
    await createRun(
      { sceneId: "s", roomCount: 5, seed: "fixed" },
      { settingsRef },
    );
    await advancePastEntry("s", settingsRef);
    const before = getRunState("s", { settingsRef });
    const { state, nextRoomId, nextPhysicalSlot } = await markRoomOutcome(
      { sceneId: "s", succeeded: true },
      { settingsRef },
    );
    expect(state.currentIndex).toBe(before.currentIndex);
    expect(state.history).toHaveLength(1);
    expect(nextRoomId).toBe(state.rooms[2].id);
    expect(nextPhysicalSlot).toBe(2); // slot 0: entry, slot 1: first real room, slot 2: this one
    expect(state.physicalSlotByRoomId[nextRoomId]).toBe(2);
    expect(state.nextPhysicalSlot).toBe(3);
  });

  it("assigns each newly-reached room the next slot number in order", async () => {
    const settingsRef = makeSettingsStub();
    await createRun(
      { sceneId: "s", roomCount: 5, seed: "fixed" },
      { settingsRef },
    );
    await advancePastEntry("s", settingsRef);
    const r1 = await markRoomOutcome(
      { sceneId: "s", succeeded: true },
      { settingsRef },
    );
    await advanceToRoom(
      { sceneId: "s", roomId: r1.nextRoomId },
      { settingsRef },
    );
    const r2 = await markRoomOutcome(
      { sceneId: "s", succeeded: true },
      { settingsRef },
    );
    expect(r2.nextPhysicalSlot).toBe(3);
  });

  it("marks the run completed when the goal room is resolved, with no next room", async () => {
    const settingsRef = makeSettingsStub();
    await createRun(
      { sceneId: "s", roomCount: 2, seed: "fixed" },
      { settingsRef },
    );
    await advancePastEntry("s", settingsRef);
    await markRoomOutcome({ sceneId: "s", succeeded: true }, { settingsRef });
    await advanceToRoom(
      { sceneId: "s", roomId: getRunState("s", { settingsRef }).rooms[2].id },
      { settingsRef },
    );
    const { state, effectKey, nextRoomId } = await markRoomOutcome(
      { sceneId: "s", succeeded: true },
      { settingsRef },
    );
    expect(state.completed).toBe(true);
    expect(effectKey).toBe("goal_cleared");
    expect(nextRoomId).toBeNull();
  });

  it("reports goal_failed on a failed goal room", async () => {
    const settingsRef = makeSettingsStub();
    await createRun(
      { sceneId: "s", roomCount: 2, seed: "fixed" },
      { settingsRef },
    );
    await advancePastEntry("s", settingsRef);
    await markRoomOutcome({ sceneId: "s", succeeded: true }, { settingsRef });
    await advanceToRoom(
      { sceneId: "s", roomId: getRunState("s", { settingsRef }).rooms[2].id },
      { settingsRef },
    );
    const { effectKey } = await markRoomOutcome(
      { sceneId: "s", succeeded: false },
      { settingsRef },
    );
    expect(effectKey).toBe("goal_failed");
  });

  it("is a no-op once the run is completed", async () => {
    const settingsRef = makeSettingsStub();
    await createRun(
      { sceneId: "s", roomCount: 2, seed: "fixed" },
      { settingsRef },
    );
    await advancePastEntry("s", settingsRef);
    await markRoomOutcome({ sceneId: "s", succeeded: true }, { settingsRef });
    await advanceToRoom(
      { sceneId: "s", roomId: getRunState("s", { settingsRef }).rooms[2].id },
      { settingsRef },
    );
    await markRoomOutcome({ sceneId: "s", succeeded: true }, { settingsRef });
    const completedState = getRunState("s", { settingsRef });
    const again = await markRoomOutcome(
      { sceneId: "s", succeeded: true },
      { settingsRef },
    );
    expect(again.state).toEqual(completedState);
    expect(again.nextRoomId).toBeNull();
  });

  it("is a no-op with no run at all", async () => {
    const settingsRef = makeSettingsStub();
    const result = await markRoomOutcome(
      { sceneId: "nope", succeeded: true },
      { settingsRef },
    );
    expect(result.state).toBeNull();
    expect(result.nextRoomId).toBeNull();
  });

  // #152 investigation: currentIndex doesn't move until the party actually
  // walks into the next room (advanceToRoom), so the room just resolved
  // stays "current" — and its Succeed/Fail/Declare Victory/Declare Defeat
  // button stays live in the UI — for the entire window before that. A
  // double-click (or a slow click registering twice) used to re-resolve the
  // same room a second time: reapplying its reward/ruin mutation and
  // re-assigning/rebuilding whatever came next all over again.
  it("is a no-op resolving the same room a second time before the party has moved on", async () => {
    const settingsRef = makeSettingsStub();
    await createRun(
      { sceneId: "s", roomCount: 5, seed: "fixed" },
      { settingsRef },
    );
    await advancePastEntry("s", settingsRef);
    const first = await markRoomOutcome(
      { sceneId: "s", succeeded: true },
      { settingsRef },
    );
    expect(first.nextRoomId).not.toBeNull();

    const again = await markRoomOutcome(
      { sceneId: "s", succeeded: true },
      { settingsRef },
    );
    expect(again.effectKey).toBeNull();
    expect(again.mutation).toBeNull();
    expect(again.nextRoomId).toBeNull();
    expect(again.state).toEqual(first.state); // untouched — no second history entry, no re-mutation
  });

  it("auto-advances past a mid-dungeon rest room (ITEM-5): no reward/ruin, but still assigns the next room its slot", async () => {
    const settingsRef = makeSettingsStub();
    // roomCount 10 always gets a rest room (above MID_DUNGEON_REST_THRESHOLD).
    await createRun(
      { sceneId: "s", roomCount: 10, seed: "rest-runner" },
      { settingsRef },
    );
    await advancePastEntry("s", settingsRef);

    // Walk forward, resolving each room in turn, until currentIndex itself
    // lands on the rest room.
    let state = getRunState("s", { settingsRef });
    while (state.rooms[state.currentIndex].kind !== "safe_rest") {
      const { nextRoomId } = await markRoomOutcome(
        { sceneId: "s", succeeded: true },
        { settingsRef },
      );
      await advanceToRoom(
        { sceneId: "s", roomId: nextRoomId },
        { settingsRef },
      );
      state = getRunState("s", { settingsRef });
    }

    const before = state;
    const {
      state: after,
      effectKey,
      mutation,
      nextRoomId,
      nextPhysicalSlot,
    } = await markRoomOutcome(
      { sceneId: "s", succeeded: true },
      { settingsRef },
    );
    expect(effectKey).toBe("rest_room_passed");
    expect(mutation).toBeNull();
    expect(nextRoomId).toBe(before.rooms[before.currentIndex + 1].id);
    expect(nextPhysicalSlot).toBeTypeOf("number");
    expect(after.physicalSlotByRoomId[nextRoomId]).toBe(nextPhysicalSlot);
    expect(after.history.at(-1)).toMatchObject({
      roomId: before.rooms[before.currentIndex].id,
      effectKey: "rest_room_passed",
    });
  });
});

describe("advanceToRoom", () => {
  it("advances currentIndex and records lastAutoEntry straight from the entry room, no markRoomOutcome needed", async () => {
    const settingsRef = makeSettingsStub();
    const created = await createRun(
      { sceneId: "s", roomCount: 5, seed: "fixed" },
      { settingsRef },
    );
    const nextRoomId = created.rooms[1].id; // slot already assigned by createRun
    const { ok, state } = await advanceToRoom(
      { sceneId: "s", roomId: nextRoomId, revealedTokenIds: ["t1"] },
      { settingsRef },
    );
    expect(ok).toBe(true);
    expect(state.currentIndex).toBe(1);
    expect(state.lastAutoEntry).toEqual({
      roomId: nextRoomId,
      fromIndex: 0,
      toIndex: 1,
      revealedTokenIds: ["t1"],
    });
  });

  it("advances a second time, past a real room, the normal markRoomOutcome-driven way", async () => {
    const settingsRef = makeSettingsStub();
    await createRun(
      { sceneId: "s", roomCount: 5, seed: "fixed" },
      { settingsRef },
    );
    await advancePastEntry("s", settingsRef);
    const { nextRoomId } = await markRoomOutcome(
      { sceneId: "s", succeeded: true },
      { settingsRef },
    );
    const { ok, state } = await advanceToRoom(
      { sceneId: "s", roomId: nextRoomId },
      { settingsRef },
    );
    expect(ok).toBe(true);
    expect(state.currentIndex).toBe(2);
  });

  it("rejects a roomId that is not genuinely the next room, without mutating state", async () => {
    const settingsRef = makeSettingsStub();
    await createRun(
      { sceneId: "s", roomCount: 5, seed: "fixed" },
      { settingsRef },
    );
    const before = getRunState("s", { settingsRef });
    const { ok, state } = await advanceToRoom(
      { sceneId: "s", roomId: "not-a-real-room" },
      { settingsRef },
    );
    expect(ok).toBe(false);
    expect(state).toEqual(before);
    expect(getRunState("s", { settingsRef })).toEqual(before);
  });

  it("is a no-op for a scene with no run", async () => {
    const settingsRef = makeSettingsStub();
    const { ok, state } = await advanceToRoom(
      { sceneId: "nope", roomId: "x" },
      { settingsRef },
    );
    expect(ok).toBe(false);
    expect(state).toBeNull();
  });
});

describe("canUndoRoomEntry / undoLastRoomEntry", () => {
  it("can undo right after the automatic entry-to-first-room transition", async () => {
    const settingsRef = makeSettingsStub();
    const created = await createRun(
      { sceneId: "s", roomCount: 5, seed: "fixed" },
      { settingsRef },
    );
    const nextRoomId = created.rooms[1].id;
    await advanceToRoom({ sceneId: "s", roomId: nextRoomId }, { settingsRef });
    expect(canUndoRoomEntry(getRunState("s", { settingsRef }))).toBe(true);

    const { ok, state, undone } = await undoLastRoomEntry(
      { sceneId: "s" },
      { settingsRef },
    );
    expect(ok).toBe(true);
    expect(state.currentIndex).toBe(0);
    expect(state.lastAutoEntry).toBeNull();
    expect(undone.roomId).toBe(nextRoomId);
  });

  it("cannot undo once the entered room has already been judged", async () => {
    const settingsRef = makeSettingsStub();
    const created = await createRun(
      { sceneId: "s", roomCount: 5, seed: "fixed" },
      { settingsRef },
    );
    const nextRoomId = created.rooms[1].id;
    await advanceToRoom({ sceneId: "s", roomId: nextRoomId }, { settingsRef });
    await markRoomOutcome({ sceneId: "s", succeeded: true }, { settingsRef });
    expect(canUndoRoomEntry(getRunState("s", { settingsRef }))).toBe(false);

    const { ok } = await undoLastRoomEntry({ sceneId: "s" }, { settingsRef });
    expect(ok).toBe(false);
  });

  it("is a no-op when there is nothing to undo", async () => {
    const settingsRef = makeSettingsStub();
    await createRun(
      { sceneId: "s", roomCount: 5, seed: "fixed" },
      { settingsRef },
    );
    expect(canUndoRoomEntry(getRunState("s", { settingsRef }))).toBe(false);
    const { ok } = await undoLastRoomEntry({ sceneId: "s" }, { settingsRef });
    expect(ok).toBe(false);
  });
});

describe("abandonRun", () => {
  it("removes only the targeted scene", async () => {
    const settingsRef = makeSettingsStub();
    await createRun({ sceneId: "scene-a", roomCount: 3 }, { settingsRef });
    await createRun({ sceneId: "scene-b", roomCount: 3 }, { settingsRef });
    await abandonRun({ sceneId: "scene-a" }, { settingsRef });
    expect(getRunState("scene-a", { settingsRef })).toBeNull();
    expect(getRunState("scene-b", { settingsRef })).not.toBeNull();
  });

  it("is a no-op for a scene with no run", async () => {
    const settingsRef = makeSettingsStub();
    await expect(
      abandonRun({ sceneId: "nothing" }, { settingsRef }),
    ).resolves.not.toThrow();
  });
});

describe("ensureSkillChallenge / recordSkillChallengeAttempt", () => {
  it("attaches a fresh challenge to the named room only", async () => {
    const settingsRef = makeSettingsStub();
    const created = await createRun(
      { sceneId: "s", roomCount: 5, seed: "fixed" },
      { settingsRef },
    );
    const roomId = created.rooms[1].id;
    const state = await ensureSkillChallenge(
      "s",
      roomId,
      { seed: "fixed", locationTag: "undead", partySize: 4 },
      { settingsRef },
    );
    const room = state.rooms.find((r) => r.id === roomId);
    expect(room.challenge).toBeTruthy();
    expect(room.challenge.vp).toBe(0);
    expect(room.challenge.resolved).toBeNull();
    // Every other room stays untouched.
    expect(
      state.rooms.find((r) => r.id === created.rooms[2].id).challenge,
    ).toBeUndefined();
  });

  it("is a no-op if the room already has a challenge (never rerolls it)", async () => {
    const settingsRef = makeSettingsStub();
    const created = await createRun(
      { sceneId: "s", roomCount: 5, seed: "fixed" },
      { settingsRef },
    );
    const roomId = created.rooms[1].id;
    const first = await ensureSkillChallenge(
      "s",
      roomId,
      { seed: "fixed", locationTag: "undead", partySize: 4 },
      { settingsRef },
    );
    const firstChallenge = first.rooms.find((r) => r.id === roomId).challenge;
    const second = await ensureSkillChallenge(
      "s",
      roomId,
      { seed: "fixed", locationTag: "undead", partySize: 4 },
      { settingsRef },
    );
    expect(second.rooms.find((r) => r.id === roomId).challenge).toEqual(
      firstChallenge,
    );
  });

  it("is a no-op with no run at all", async () => {
    const settingsRef = makeSettingsStub();
    const result = await ensureSkillChallenge(
      "nope",
      "room-x",
      { seed: "s", locationTag: null, partySize: 4 },
      { settingsRef },
    );
    expect(result).toBeNull();
  });

  it("records an attempt's VP delta against the room's own challenge", async () => {
    const settingsRef = makeSettingsStub();
    const created = await createRun(
      { sceneId: "s", roomCount: 5, seed: "fixed" },
      { settingsRef },
    );
    const roomId = created.rooms[1].id;
    await ensureSkillChallenge(
      "s",
      roomId,
      { seed: "fixed", locationTag: "undead", partySize: 4 },
      { settingsRef },
    );
    const state = await recordSkillChallengeAttempt("s", roomId, "success", {
      settingsRef,
    });
    const room = state.rooms.find((r) => r.id === roomId);
    expect(room.challenge.vp).toBe(1);
    expect(room.challenge.attemptsUsed).toBe(1);
  });

  it("is a no-op if the room has no challenge attached yet", async () => {
    const settingsRef = makeSettingsStub();
    const created = await createRun(
      { sceneId: "s", roomCount: 5, seed: "fixed" },
      { settingsRef },
    );
    const roomId = created.rooms[1].id;
    const state = await recordSkillChallengeAttempt("s", roomId, "success", {
      settingsRef,
    });
    const room = state.rooms.find((r) => r.id === roomId);
    expect(room.challenge).toBeUndefined();
  });

  it("is a no-op once the challenge is already resolved", async () => {
    const settingsRef = makeSettingsStub();
    const created = await createRun(
      { sceneId: "s", roomCount: 5, seed: "fixed" },
      { settingsRef },
    );
    const roomId = created.rooms[1].id;
    await ensureSkillChallenge(
      "s",
      roomId,
      { seed: "fixed", locationTag: "undead", partySize: 4 },
      { settingsRef },
    );
    // Drive it to a resolved failure (attemptBudget 6 for partySize 4).
    let state;
    for (let i = 0; i < 6; i += 1) {
      state = await recordSkillChallengeAttempt("s", roomId, "failure", {
        settingsRef,
      });
    }
    const resolvedChallenge = state.rooms.find(
      (r) => r.id === roomId,
    ).challenge;
    expect(resolvedChallenge.resolved).toBe("failure");
    const again = await recordSkillChallengeAttempt(
      "s",
      roomId,
      "criticalSuccess",
      { settingsRef },
    );
    expect(again.rooms.find((r) => r.id === roomId).challenge).toEqual(
      resolvedChallenge,
    );
  });

  it("is a no-op with no run at all", async () => {
    const settingsRef = makeSettingsStub();
    const result = await recordSkillChallengeAttempt(
      "nope",
      "room-x",
      "success",
      { settingsRef },
    );
    expect(result).toBeNull();
  });
});

const HINT_CHECKS = [
  {
    skill: "perception",
    dc: 20,
    hint: "Grooves fit a fanned hand of five cards.",
  },
  { skill: "society", dc: 20, hint: "The suits mirror noble houses." },
  {
    skill: "occultism",
    dc: 20,
    hint: "The arrangement echoes a divination spread.",
  },
];

describe("ensurePuzzleState / recordPuzzleStageAttempt", () => {
  it("attaches fresh puzzle state to the named room only", async () => {
    const settingsRef = makeSettingsStub();
    const created = await createRun(
      { sceneId: "s", roomCount: 5, seed: "fixed" },
      { settingsRef },
    );
    const roomId = created.rooms[1].id;
    const state = await ensurePuzzleState(
      "s",
      roomId,
      { hintChecks: HINT_CHECKS },
      { settingsRef },
    );
    const room = state.rooms.find((r) => r.id === roomId);
    expect(room.puzzle).toBeTruthy();
    expect(room.puzzle.stages).toHaveLength(3);
    expect(room.puzzle.resolved).toBeNull();
    expect(room.puzzle.customization).toEqual({ status: "pending" });
    expect(
      state.rooms.find((r) => r.id === created.rooms[2].id).puzzle,
    ).toBeUndefined();
  });

  it("scales every stage's dc to the given partyLevel", async () => {
    const settingsRef = makeSettingsStub();
    const created = await createRun(
      { sceneId: "s", roomCount: 5, seed: "fixed" },
      { settingsRef },
    );
    const roomId = created.rooms[1].id;
    const state = await ensurePuzzleState(
      "s",
      roomId,
      { hintChecks: HINT_CHECKS, partyLevel: 5 },
      { settingsRef },
    );
    const room = state.rooms.find((r) => r.id === roomId);
    // simpleDcForLevel(5) === 20 (skill-challenge-mechanics.mjs's own table)
    expect(room.puzzle.stages.every((s) => s.dc === 20)).toBe(true);
  });

  it("is a no-op if the room already has puzzle state (never rerolls it)", async () => {
    const settingsRef = makeSettingsStub();
    const created = await createRun(
      { sceneId: "s", roomCount: 5, seed: "fixed" },
      { settingsRef },
    );
    const roomId = created.rooms[1].id;
    const first = await ensurePuzzleState(
      "s",
      roomId,
      { hintChecks: HINT_CHECKS },
      { settingsRef },
    );
    const firstPuzzle = first.rooms.find((r) => r.id === roomId).puzzle;
    const second = await ensurePuzzleState(
      "s",
      roomId,
      { hintChecks: HINT_CHECKS },
      { settingsRef },
    );
    expect(second.rooms.find((r) => r.id === roomId).puzzle).toEqual(
      firstPuzzle,
    );
  });

  it("is a no-op with no run at all", async () => {
    const settingsRef = makeSettingsStub();
    const result = await ensurePuzzleState(
      "nope",
      "room-x",
      { hintChecks: HINT_CHECKS },
      { settingsRef },
    );
    expect(result).toBeNull();
  });

  it("records a stage attempt against the room's own puzzle state", async () => {
    const settingsRef = makeSettingsStub();
    const created = await createRun(
      { sceneId: "s", roomCount: 5, seed: "fixed" },
      { settingsRef },
    );
    const roomId = created.rooms[1].id;
    await ensurePuzzleState(
      "s",
      roomId,
      { hintChecks: HINT_CHECKS },
      { settingsRef },
    );
    const state = await recordPuzzleStageAttempt("s", roomId, 0, "success", {
      settingsRef,
    });
    const room = state.rooms.find((r) => r.id === roomId);
    expect(room.puzzle.stages[0].succeeded).toBe(true);
    expect(room.puzzle.successes).toBe(1);
  });

  it("is a no-op if the room has no puzzle attached yet", async () => {
    const settingsRef = makeSettingsStub();
    const created = await createRun(
      { sceneId: "s", roomCount: 5, seed: "fixed" },
      { settingsRef },
    );
    const roomId = created.rooms[1].id;
    const state = await recordPuzzleStageAttempt("s", roomId, 0, "success", {
      settingsRef,
    });
    const room = state.rooms.find((r) => r.id === roomId);
    expect(room.puzzle).toBeUndefined();
  });

  it("is a no-op once the puzzle is already resolved", async () => {
    const settingsRef = makeSettingsStub();
    const created = await createRun(
      { sceneId: "s", roomCount: 5, seed: "fixed" },
      { settingsRef },
    );
    const roomId = created.rooms[1].id;
    await ensurePuzzleState(
      "s",
      roomId,
      { hintChecks: HINT_CHECKS },
      { settingsRef },
    );
    // requiredSuccesses defaults to 2 of 3 - two successes resolves it.
    await recordPuzzleStageAttempt("s", roomId, 0, "success", { settingsRef });
    const state = await recordPuzzleStageAttempt("s", roomId, 1, "success", {
      settingsRef,
    });
    const resolvedPuzzle = state.rooms.find((r) => r.id === roomId).puzzle;
    expect(resolvedPuzzle.resolved).toBe("success");
    const again = await recordPuzzleStageAttempt("s", roomId, 2, "success", {
      settingsRef,
    });
    expect(again.rooms.find((r) => r.id === roomId).puzzle).toEqual(
      resolvedPuzzle,
    );
  });

  it("is a no-op with no run at all", async () => {
    const settingsRef = makeSettingsStub();
    const result = await recordPuzzleStageAttempt(
      "nope",
      "room-x",
      0,
      "success",
      {
        settingsRef,
      },
    );
    expect(result).toBeNull();
  });
});

describe("setObjective", () => {
  it("sets a run-wide objective, visible regardless of the current room", async () => {
    const settingsRef = makeSettingsStub();
    await createRun(
      { sceneId: "s", roomCount: 5, seed: "fixed" },
      { settingsRef },
    );
    const state = await setObjective("s", "Find the missing relic", {
      settingsRef,
    });
    expect(state.objective).toBe("Find the missing relic");
    expect(getRunState("s", { settingsRef }).objective).toBe(
      "Find the missing relic",
    );
  });

  it("overwrites a previously-set objective rather than accumulating a log", async () => {
    const settingsRef = makeSettingsStub();
    await createRun(
      { sceneId: "s", roomCount: 5, seed: "fixed" },
      { settingsRef },
    );
    await setObjective("s", "First objective", { settingsRef });
    const state = await setObjective("s", "Second objective", { settingsRef });
    expect(state.objective).toBe("Second objective");
  });

  it("treats a blank/whitespace-only string as clearing the objective", async () => {
    const settingsRef = makeSettingsStub();
    await createRun(
      { sceneId: "s", roomCount: 5, seed: "fixed" },
      { settingsRef },
    );
    await setObjective("s", "Something", { settingsRef });
    const state = await setObjective("s", "   ", { settingsRef });
    expect(state.objective).toBeNull();
  });

  it("clears the objective when called with null", async () => {
    const settingsRef = makeSettingsStub();
    await createRun(
      { sceneId: "s", roomCount: 5, seed: "fixed" },
      { settingsRef },
    );
    await setObjective("s", "Something", { settingsRef });
    const state = await setObjective("s", null, { settingsRef });
    expect(state.objective).toBeNull();
  });

  it("is a no-op with no run at all", async () => {
    const settingsRef = makeSettingsStub();
    const result = await setObjective("nope", "Anything", { settingsRef });
    expect(result).toBeNull();
  });
});

describe("getPendingSkillChallengeCustomization / applySkillChallengeCustomization", () => {
  async function makeRoomWithChallenge(settingsRef) {
    const created = await createRun(
      { sceneId: "s", roomCount: 5, seed: "fixed" },
      { settingsRef },
    );
    const roomId = created.rooms[1].id;
    await ensureSkillChallenge(
      "s",
      roomId,
      { seed: "fixed", locationTag: "undead", partySize: 4 },
      { settingsRef },
    );
    return roomId;
  }

  it("ensureSkillChallenge flags a new challenge pending", async () => {
    const settingsRef = makeSettingsStub();
    const roomId = await makeRoomWithChallenge(settingsRef);
    const state = getRunState("s", { settingsRef });
    const room = state.rooms.find((r) => r.id === roomId);
    expect(room.challenge.customization).toEqual({ status: "pending" });
  });

  it("getPendingSkillChallengeCustomization finds the pending room and hands back its content", async () => {
    const settingsRef = makeSettingsStub();
    const roomId = await makeRoomWithChallenge(settingsRef);
    // locationTag comes from the room's own (seed-derived) field, not the
    // `locationTag` makeRoomWithChallenge passed to ensureSkillChallenge
    // (that one only ever feeds the generic specialty-skill fallback pick,
    // never stored on the room itself) — assert against the real room.
    const room = getRunState("s", { settingsRef }).rooms.find(
      (r) => r.id === roomId,
    );
    const pending = getPendingSkillChallengeCustomization("s", { settingsRef });
    expect(pending.roomId).toBe(roomId);
    expect(pending.sceneId).toBe("s");
    expect(pending.locationTag).toBe(room.locationTag);
    expect(pending.specialtySkills).toHaveLength(3);
  });

  it("returns null when nothing is pending", () => {
    const settingsRef = makeSettingsStub();
    expect(
      getPendingSkillChallengeCustomization("nope", { settingsRef }),
    ).toBeNull();
  });

  it("applySkillChallengeCustomization overwrites name/summary and marks it customized", async () => {
    const settingsRef = makeSettingsStub();
    const roomId = await makeRoomWithChallenge(settingsRef);
    const state = await applySkillChallengeCustomization(
      "s",
      roomId,
      { name: "The Iron Concord", summary: "A tense truce negotiation." },
      { settingsRef },
    );
    const room = state.rooms.find((r) => r.id === roomId);
    expect(room.challenge.name).toBe("The Iron Concord");
    expect(room.challenge.summary).toBe("A tense truce negotiation.");
    expect(room.challenge.customization).toEqual({ status: "customized" });
  });

  it("merges skillFlavor onto the existing map rather than replacing it", async () => {
    const settingsRef = makeSettingsStub();
    const roomId = await makeRoomWithChallenge(settingsRef);
    const before = getRunState("s", { settingsRef }).rooms.find(
      (r) => r.id === roomId,
    );
    const skill = before.challenge.specialtySkills[0];
    const state = await applySkillChallengeCustomization(
      "s",
      roomId,
      { skillFlavor: { [skill]: "A vivid new detail." } },
      { settingsRef },
    );
    const room = state.rooms.find((r) => r.id === roomId);
    expect(room.challenge.skillFlavor[skill]).toBe("A vivid new detail.");
  });

  it("no longer appears as pending once customization is applied", async () => {
    const settingsRef = makeSettingsStub();
    const roomId = await makeRoomWithChallenge(settingsRef);
    await applySkillChallengeCustomization(
      "s",
      roomId,
      { name: "New Name" },
      { settingsRef },
    );
    expect(
      getPendingSkillChallengeCustomization("s", { settingsRef }),
    ).toBeNull();
  });

  it("stops being offered once the challenge is resolved, even if still marked pending", async () => {
    const settingsRef = makeSettingsStub();
    const roomId = await makeRoomWithChallenge(settingsRef);
    for (let i = 0; i < 6; i += 1) {
      await recordSkillChallengeAttempt("s", roomId, "failure", {
        settingsRef,
      });
    }
    expect(
      getPendingSkillChallengeCustomization("s", { settingsRef }),
    ).toBeNull();
  });

  it("applySkillChallengeCustomization is a no-op if the room has no challenge at all", async () => {
    const settingsRef = makeSettingsStub();
    const created = await createRun(
      { sceneId: "s", roomCount: 5, seed: "fixed" },
      { settingsRef },
    );
    const roomId = created.rooms[1].id;
    const state = await applySkillChallengeCustomization(
      "s",
      roomId,
      { name: "Anything" },
      { settingsRef },
    );
    expect(state.rooms.find((r) => r.id === roomId).challenge).toBeUndefined();
  });

  it("applySkillChallengeCustomization is a no-op with no run at all", async () => {
    const settingsRef = makeSettingsStub();
    const result = await applySkillChallengeCustomization(
      "nope",
      "room-x",
      { name: "Anything" },
      { settingsRef },
    );
    expect(result).toBeNull();
  });
});

describe("getPendingPuzzleCustomization / applyPuzzleCustomization", () => {
  async function makeRoomWithPuzzle(settingsRef) {
    const created = await createRun(
      { sceneId: "s", roomCount: 5, seed: "fixed" },
      { settingsRef },
    );
    const roomId = created.rooms[1].id;
    await ensurePuzzleState(
      "s",
      roomId,
      { hintChecks: HINT_CHECKS },
      { settingsRef },
    );
    return roomId;
  }

  it("ensurePuzzleState flags a new puzzle pending", async () => {
    const settingsRef = makeSettingsStub();
    const roomId = await makeRoomWithPuzzle(settingsRef);
    const state = getRunState("s", { settingsRef });
    const room = state.rooms.find((r) => r.id === roomId);
    expect(room.puzzle.customization).toEqual({ status: "pending" });
  });

  it("getPendingPuzzleCustomization finds the pending room and hands back its content", async () => {
    const settingsRef = makeSettingsStub();
    const roomId = await makeRoomWithPuzzle(settingsRef);
    const pending = getPendingPuzzleCustomization("s", { settingsRef });
    expect(pending.roomId).toBe(roomId);
    expect(pending.sceneId).toBe("s");
    expect(pending.stages).toHaveLength(3);
    expect(pending.stages[0]).toMatchObject({
      skill: "perception",
      hint: HINT_CHECKS[0].hint,
    });
  });

  it("returns null when nothing is pending", () => {
    const settingsRef = makeSettingsStub();
    expect(getPendingPuzzleCustomization("nope", { settingsRef })).toBeNull();
  });

  it("applyPuzzleCustomization overwrites name/summary and marks it customized", async () => {
    const settingsRef = makeSettingsStub();
    const roomId = await makeRoomWithPuzzle(settingsRef);
    const state = await applyPuzzleCustomization(
      "s",
      roomId,
      {
        name: "The Whispering Vault",
        summary: "A locked vault hums with old magic.",
      },
      { settingsRef },
    );
    const room = state.rooms.find((r) => r.id === roomId);
    expect(room.puzzle.name).toBe("The Whispering Vault");
    expect(room.puzzle.summary).toBe("A locked vault hums with old magic.");
    expect(room.puzzle.customization).toEqual({ status: "customized" });
  });

  it("merges stageFlavor onto the existing map rather than replacing it, never touching skill/dc", async () => {
    const settingsRef = makeSettingsStub();
    const roomId = await makeRoomWithPuzzle(settingsRef);
    const state = await applyPuzzleCustomization(
      "s",
      roomId,
      { stageFlavor: { 0: "A far more vivid clue." } },
      { settingsRef },
    );
    const room = state.rooms.find((r) => r.id === roomId);
    expect(room.puzzle.stageFlavor[0]).toBe("A far more vivid clue.");
    expect(room.puzzle.stages[0].skill).toBe("perception");
    expect(room.puzzle.stages[0].dc).toBe(HINT_CHECKS[0].dc);
  });

  it("no longer appears as pending once customization is applied", async () => {
    const settingsRef = makeSettingsStub();
    const roomId = await makeRoomWithPuzzle(settingsRef);
    await applyPuzzleCustomization(
      "s",
      roomId,
      { name: "New Name" },
      { settingsRef },
    );
    expect(getPendingPuzzleCustomization("s", { settingsRef })).toBeNull();
  });

  it("stops being offered once the puzzle is resolved, even if still marked pending", async () => {
    const settingsRef = makeSettingsStub();
    const roomId = await makeRoomWithPuzzle(settingsRef);
    await recordPuzzleStageAttempt("s", roomId, 0, "success", { settingsRef });
    await recordPuzzleStageAttempt("s", roomId, 1, "success", { settingsRef });
    expect(getPendingPuzzleCustomization("s", { settingsRef })).toBeNull();
  });

  it("applyPuzzleCustomization is a no-op if the room has no puzzle at all", async () => {
    const settingsRef = makeSettingsStub();
    const created = await createRun(
      { sceneId: "s", roomCount: 5, seed: "fixed" },
      { settingsRef },
    );
    const roomId = created.rooms[1].id;
    const state = await applyPuzzleCustomization(
      "s",
      roomId,
      { name: "Anything" },
      { settingsRef },
    );
    expect(state.rooms.find((r) => r.id === roomId).puzzle).toBeUndefined();
  });

  it("applyPuzzleCustomization is a no-op with no run at all", async () => {
    const settingsRef = makeSettingsStub();
    const result = await applyPuzzleCustomization(
      "nope",
      "room-x",
      { name: "Anything" },
      { settingsRef },
    );
    expect(result).toBeNull();
  });
});

describe("ensureNarrativeState / getPendingNarrativeCustomization / applyNarrativeCustomization", () => {
  const loreSetpiece = {
    id: "the_example_lore", kind: "narrative", archetype: "lore",
    name: "The Example", summary: "An example lore beat.",
    revealText: "The ruins predate the empire.",
  };
  const choiceSetpiece = {
    id: "the_example_choice", kind: "narrative", archetype: "choice",
    name: "The Example Choice", summary: "An example dilemma.",
    options: [
      { label: "Free them", consequence: "A grateful ally." },
      { label: "Leave them", consequence: "No new burden." },
    ],
  };

  async function makeRoomWithNarrative(settingsRef, setpiece = loreSetpiece) {
    const created = await createRun(
      { sceneId: "s", roomCount: 5, seed: "fixed" },
      { settingsRef },
    );
    const roomId = created.rooms[1].id;
    await ensureNarrativeState("s", roomId, { setpiece }, { settingsRef });
    return roomId;
  }

  it("ensureNarrativeState attaches the setpiece's fields and flags it pending", async () => {
    const settingsRef = makeSettingsStub();
    const roomId = await makeRoomWithNarrative(settingsRef);
    const state = getRunState("s", { settingsRef });
    const room = state.rooms.find((r) => r.id === roomId);
    expect(room.narrative.archetype).toBe("lore");
    expect(room.narrative.name).toBe("The Example");
    expect(room.narrative.summary).toBe("An example lore beat.");
    expect(room.narrative.revealText).toBe("The ruins predate the empire.");
    expect(room.narrative.npcName).toBeNull();
    expect(room.narrative.customization).toEqual({ status: "pending" });
  });

  it("ensureNarrativeState is a no-op if the room already has narrative state", async () => {
    const settingsRef = makeSettingsStub();
    const roomId = await makeRoomWithNarrative(settingsRef);
    await ensureNarrativeState(
      "s",
      roomId,
      { setpiece: { ...loreSetpiece, name: "Different" } },
      { settingsRef },
    );
    const room = getRunState("s", { settingsRef }).rooms.find(
      (r) => r.id === roomId,
    );
    expect(room.narrative.name).toBe("The Example");
  });

  it("getPendingNarrativeCustomization finds the pending room and hands back its content", async () => {
    const settingsRef = makeSettingsStub();
    const roomId = await makeRoomWithNarrative(settingsRef, choiceSetpiece);
    const room = getRunState("s", { settingsRef }).rooms.find(
      (r) => r.id === roomId,
    );
    const pending = getPendingNarrativeCustomization("s", { settingsRef });
    expect(pending.roomId).toBe(roomId);
    expect(pending.sceneId).toBe("s");
    expect(pending.archetype).toBe("choice");
    expect(pending.locationTag).toBe(room.locationTag);
    expect(pending.options).toEqual(choiceSetpiece.options);
  });

  it("returns null when nothing is pending", () => {
    const settingsRef = makeSettingsStub();
    expect(getPendingNarrativeCustomization("nope", { settingsRef })).toBeNull();
  });

  it("applyNarrativeCustomization overwrites name/summary/revealText and marks it customized", async () => {
    const settingsRef = makeSettingsStub();
    const roomId = await makeRoomWithNarrative(settingsRef);
    const state = await applyNarrativeCustomization(
      "s",
      roomId,
      {
        name: "The Warden's Last Stand",
        summary: "A collapsed guardpost.",
        revealText: "They knew exactly what was coming.",
      },
      { settingsRef },
    );
    const room = state.rooms.find((r) => r.id === roomId);
    expect(room.narrative.name).toBe("The Warden's Last Stand");
    expect(room.narrative.summary).toBe("A collapsed guardpost.");
    expect(room.narrative.revealText).toBe("They knew exactly what was coming.");
    expect(room.narrative.customization).toEqual({ status: "customized" });
  });

  it("applyNarrativeCustomization replaces options wholesale when given", async () => {
    const settingsRef = makeSettingsStub();
    const roomId = await makeRoomWithNarrative(settingsRef, choiceSetpiece);
    const newOptions = [
      { label: "Restore it", consequence: "A quiet favor." },
      { label: "Strip it", consequence: "Real value now." },
    ];
    const state = await applyNarrativeCustomization(
      "s",
      roomId,
      { options: newOptions },
      { settingsRef },
    );
    const room = state.rooms.find((r) => r.id === roomId);
    expect(room.narrative.options).toEqual(newOptions);
  });

  it("no longer appears as pending once customization is applied", async () => {
    const settingsRef = makeSettingsStub();
    const roomId = await makeRoomWithNarrative(settingsRef);
    await applyNarrativeCustomization(
      "s",
      roomId,
      { name: "New Name" },
      { settingsRef },
    );
    expect(getPendingNarrativeCustomization("s", { settingsRef })).toBeNull();
  });

  it("stops being offered once the room is resolved, even if still marked pending", async () => {
    const settingsRef = makeSettingsStub();
    const roomId = await makeRoomWithNarrative(settingsRef);
    await advancePastEntry("s", settingsRef);
    await markRoomOutcome({ sceneId: "s", succeeded: true }, { settingsRef });
    expect(getPendingNarrativeCustomization("s", { settingsRef })).toBeNull();
  });

  it("applyNarrativeCustomization is a no-op if the room has no narrative state at all", async () => {
    const settingsRef = makeSettingsStub();
    const created = await createRun(
      { sceneId: "s", roomCount: 5, seed: "fixed" },
      { settingsRef },
    );
    const roomId = created.rooms[1].id;
    const state = await applyNarrativeCustomization(
      "s",
      roomId,
      { name: "Anything" },
      { settingsRef },
    );
    expect(state.rooms.find((r) => r.id === roomId).narrative).toBeUndefined();
  });

  it("applyNarrativeCustomization is a no-op with no run at all", async () => {
    const settingsRef = makeSettingsStub();
    const result = await applyNarrativeCustomization(
      "nope",
      "room-x",
      { name: "Anything" },
      { settingsRef },
    );
    expect(result).toBeNull();
  });
});
