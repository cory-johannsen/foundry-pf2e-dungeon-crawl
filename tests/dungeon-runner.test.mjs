import { describe, it, expect } from "vitest";
import {
  createRun,
  markRoomOutcome,
  advanceToRoom,
  undoLastRoomEntry,
  canUndoRoomEntry,
  roomsToEagerlyBuild,
  commitEagerPhysicalSlots,
  abandonRun,
  getRunState,
  ensureSkillChallenge,
  recordSkillChallengeAttempt,
  clearSkillChallengeState,
  setObjective,
  findActiveHostedRun,
  findHostedRunForBroadcast,
  getPendingSkillChallengeCustomization,
  applySkillChallengeCustomization,
  ensurePuzzleState,
  recordPuzzleStageAttempt,
  clearPuzzleState,
  getPendingPuzzleCustomization,
  applyPuzzleCustomization,
  ensureNarrativeState,
  clearNarrativeState,
  getPendingNarrativeCustomization,
  applyNarrativeCustomization,
  ensureTrapState,
  clearTrapState,
  applyTrapRoomState,
  ensureTreasureState,
  clearTreasureState,
  getPendingTreasureCustomization,
  applyTreasureCustomization,
} from "../scripts/dungeon-runner.mjs";
import { registerGenerator } from '../scripts/generator-registry.mjs';
import { DefaultGenerator } from '../scripts/default-generator.mjs';

registerGenerator(DefaultGenerator);

function makeSettingsStub(initial = {}) {
  let store = { dungeonRuns: initial };
  return {
    get: (moduleId, key) => store[key],
    set: (moduleId, key, value) => {
      store = { ...store, [key]: value };
    },
  };
}

/** Moves currentRoomId from the safe entry (room 0) to the first real room
 * (room 1) — its physical slot is already assigned by createRun, so this
 * never needs markRoomOutcome, matching how the real door-open trigger
 * reaches it. */
async function advancePastEntry(sceneId, settingsRef) {
  const state = getRunState(sceneId, { settingsRef });
  // Via edges (not state.rooms[1]) so this works for both createRun's
  // array-shaped rooms and createDictRun's #93 dict-shaped ones.
  return advanceToRoom(
    { sceneId, roomId: state.edges[state.currentRoomId][0] },
    { settingsRef },
  );
}

/** #93/#156: markRoomOutcome no longer returns a `nextRoomId` — there's no
 * more per-room sequence mutation/physical-slot assignment for it to
 * compute. The single structural child recorded in `state.edges` (createRun's
 * buildRoomSequence output is a straight, non-branching chain, so there's
 * always exactly one) IS the next room, live in the graph from run start. */
function nextChildId(state) {
  return state.edges[state.currentRoomId]?.[0] ?? null;
}

/** #93: every reducer from ensureSkillChallenge onward reads/writes
 * `state.rooms` as a dict keyed by room id — the shape startDungeonRun
 * persists for every real run (createRun itself still returns the legacy
 * array). Runs createRun, then re-persists the same rooms keyed by id,
 * plus a test-only `roomOrder` (generation-order ids) so fixtures can
 * still pick "the first real room" by position. */
async function createDictRun(args, opts) {
  const created = await createRun(args, opts);
  const roomOrder = created.rooms.map((r) => r.id);
  const rooms = Object.fromEntries(created.rooms.map((r) => [r.id, r]));
  const all = opts.settingsRef.get("pf2e-dungeon-crawl", "dungeonRuns") ?? {};
  const state = { ...created, rooms, roomOrder };
  opts.settingsRef.set("pf2e-dungeon-crawl", "dungeonRuns", {
    ...all,
    [args.sceneId]: state,
  });
  return state;
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

describe("createRun / aiControlledActorIds (#20)", () => {
  function makePartyOwnershipStub({
    actors = [],
    activeUserIds = new Set(),
    gmUserIds = new Set(),
  } = {}) {
    return {
      partyActors: () => actors,
      isUserActive: (userId) => activeUserIds.has(userId),
      isUserGm: (userId) => gmUserIds.has(userId),
    };
  }

  it("flags a party actor whose non-GM owner is offline", async () => {
    const settingsRef = makeSettingsStub();
    const partyOwnershipRef = makePartyOwnershipStub({
      actors: [{ id: "actor-1", ownership: { "gm-1": 3, "user-1": 3 } }],
      activeUserIds: new Set(),
      gmUserIds: new Set(["gm-1"]),
    });
    const state = await createRun(
      { sceneId: "scene-1", roomCount: 3 },
      { settingsRef, partyOwnershipRef },
    );
    expect(state.aiControlledActorIds).toEqual(["actor-1"]);
  });

  it("leaves a party actor alone when its non-GM owner is online", async () => {
    const settingsRef = makeSettingsStub();
    const partyOwnershipRef = makePartyOwnershipStub({
      actors: [{ id: "actor-1", ownership: { "gm-1": 3, "user-1": 3 } }],
      activeUserIds: new Set(["user-1"]),
      gmUserIds: new Set(["gm-1"]),
    });
    const state = await createRun(
      { sceneId: "scene-1", roomCount: 3 },
      { settingsRef, partyOwnershipRef },
    );
    expect(state.aiControlledActorIds).toEqual([]);
  });

  it("leaves an actor off the list when only the GM owns it", async () => {
    const settingsRef = makeSettingsStub();
    const partyOwnershipRef = makePartyOwnershipStub({
      actors: [{ id: "actor-1", ownership: { "gm-1": 3 } }],
      activeUserIds: new Set(),
      gmUserIds: new Set(["gm-1"]),
    });
    const state = await createRun(
      { sceneId: "scene-1", roomCount: 3 },
      { settingsRef, partyOwnershipRef },
    );
    expect(state.aiControlledActorIds).toEqual([]);
  });

  it("handles a run with multiple party actors independently", async () => {
    const settingsRef = makeSettingsStub();
    const partyOwnershipRef = makePartyOwnershipStub({
      actors: [
        { id: "actor-1", ownership: { "gm-1": 3, "user-1": 3 } },
        { id: "actor-2", ownership: { "gm-1": 3, "user-2": 3 } },
      ],
      activeUserIds: new Set(["user-2"]),
      gmUserIds: new Set(["gm-1"]),
    });
    const state = await createRun(
      { sceneId: "scene-1", roomCount: 3 },
      { settingsRef, partyOwnershipRef },
    );
    expect(state.aiControlledActorIds).toEqual(["actor-1"]);
  });

  it("skips the 'default' ownership entry and finds the real online owner", async () => {
    const settingsRef = makeSettingsStub();
    const partyOwnershipRef = makePartyOwnershipStub({
      actors: [
        {
          id: "actor-1",
          ownership: { default: 3, "gm-1": 3, "user-1": 3 },
        },
      ],
      activeUserIds: new Set(["user-1"]),
      gmUserIds: new Set(["gm-1"]),
    });
    const state = await createRun(
      { sceneId: "scene-1", roomCount: 3 },
      { settingsRef, partyOwnershipRef },
    );
    expect(state.aiControlledActorIds).not.toContain("actor-1");
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
    await settingsRef.set("pf2e-dungeon-crawl", "dungeonRuns", {
      ...settingsRef.get("pf2e-dungeon-crawl", "dungeonRuns"),
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
    await settingsRef.set("pf2e-dungeon-crawl", "dungeonRuns", {
      ...settingsRef.get("pf2e-dungeon-crawl", "dungeonRuns"),
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
    expect(result.mutation).toBeUndefined(); // #93/#156: no longer part of the return shape
    expect(result.state).toEqual(before); // untouched — no history entry, no mutation
  });

  it("does not move currentRoomId, and records the resolution in history", async () => {
    const settingsRef = makeSettingsStub();
    await createRun(
      { sceneId: "s", roomCount: 5, seed: "fixed" },
      { settingsRef },
    );
    await advancePastEntry("s", settingsRef);
    const before = getRunState("s", { settingsRef });
    const { state, effectKey } = await markRoomOutcome(
      { sceneId: "s", succeeded: true },
      { settingsRef },
    );
    expect(state.currentRoomId).toBe(before.currentRoomId);
    expect(state.history).toHaveLength(1);
    expect(state.history[0].roomId).toBe(before.currentRoomId);
    expect(effectKey).toBeTruthy();
    // #93/#156: every room is already built eagerly at run start
    // (roomsToEagerlyBuild) — markRoomOutcome no longer assigns physical
    // slots as the party progresses, so these stay exactly as createRun set
    // them.
    expect(state.physicalSlotByRoomId).toEqual(before.physicalSlotByRoomId);
    expect(state.nextPhysicalSlot).toBe(before.nextPhysicalSlot);
  });

  it("marks the run completed when the goal room is resolved", async () => {
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
    const { state, effectKey } = await markRoomOutcome(
      { sceneId: "s", succeeded: true },
      { settingsRef },
    );
    expect(state.completed).toBe(true);
    expect(effectKey).toBe("goal_cleared");
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
    expect(again.effectKey).toBeNull();
  });

  it("is a no-op with no run at all", async () => {
    const settingsRef = makeSettingsStub();
    const result = await markRoomOutcome(
      { sceneId: "nope", succeeded: true },
      { settingsRef },
    );
    expect(result.state).toBeNull();
    expect(result.effectKey).toBeNull();
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
    expect(first.effectKey).not.toBeNull();
    expect(first.state.history).toHaveLength(1);

    const again = await markRoomOutcome(
      { sceneId: "s", succeeded: true },
      { settingsRef },
    );
    expect(again.effectKey).toBeNull();
    expect(again.mutation).toBeUndefined();
    expect(again.state).toEqual(first.state); // untouched — no second history entry, no re-mutation
  });

  it("auto-advances past a mid-dungeon rest room (ITEM-5): no reward/ruin", async () => {
    const settingsRef = makeSettingsStub();
    // roomCount 10 always gets a rest room (above MID_DUNGEON_REST_THRESHOLD).
    await createRun(
      { sceneId: "s", roomCount: 10, seed: "rest-runner" },
      { settingsRef },
    );
    await advancePastEntry("s", settingsRef);

    // Walk forward, resolving each room in turn, until currentRoomId itself
    // lands on the rest room. #93/#156: markRoomOutcome no longer returns a
    // nextRoomId to drive this — the next room is just the current room's
    // one structural child, already live in state.edges from run start.
    let state = getRunState("s", { settingsRef });
    // #93: advanceToRoom no longer writes currentIndex — look the current
    // room up by currentRoomId (createRun's own rooms are still an array).
    const currentRoomOf = (st) => st.rooms.find((r) => r.id === st.currentRoomId);
    while (currentRoomOf(state).kind !== "safe_rest") {
      const nextId = nextChildId(state);
      await markRoomOutcome(
        { sceneId: "s", succeeded: true },
        { settingsRef },
      );
      await advanceToRoom(
        { sceneId: "s", roomId: nextId },
        { settingsRef },
      );
      state = getRunState("s", { settingsRef });
    }

    const before = state;
    const { state: after, effectKey } = await markRoomOutcome(
      { sceneId: "s", succeeded: true },
      { settingsRef },
    );
    expect(effectKey).toBe("rest_room_passed");
    expect(after.history.at(-1)).toMatchObject({
      roomId: before.currentRoomId,
      effectKey: "rest_room_passed",
    });
  });
});

describe("advanceToRoom", () => {
  it("advances currentRoomId and records lastAutoEntry straight from the entry room, no markRoomOutcome needed", async () => {
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
    expect(state.currentRoomId).toBe(nextRoomId);
    expect(state.lastAutoEntry).toEqual({
      roomId: nextRoomId,
      fromRoomId: created.rooms[0].id,
      toRoomId: nextRoomId,
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
    const nextRoomId = nextChildId(getRunState("s", { settingsRef }));
    await markRoomOutcome(
      { sceneId: "s", succeeded: true },
      { settingsRef },
    );
    const { ok, state } = await advanceToRoom(
      { sceneId: "s", roomId: nextRoomId },
      { settingsRef },
    );
    expect(ok).toBe(true);
    expect(state.currentRoomId).toBe(nextRoomId);
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
    expect(state.currentRoomId).toBe(created.rooms[0].id);
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

describe("advanceToRoom (graph)", () => {
  it("accepts any of the current room's children, not just a fixed 'index + 1' successor", async () => {
    const settingsRef = makeSettingsStub();
    // Arrange a run state at a 2-exit room with children 'east-room' and 'south-room'
    const state = {
      seed: "test",
      createdAt: Date.now(),
      traits: [],
      excludeTraits: [],
      rooms: {
        'room-entry': { id: 'room-entry', kind: 'safe_entry' },
        'start-room': { id: 'start-room', kind: 'combat' },
        'east-room': { id: 'east-room', kind: 'combat' },
        'south-room': { id: 'south-room', kind: 'encounter' },
      },
      currentRoomId: 'start-room',
      edges: {
        'room-entry': ['start-room'],
        'start-room': ['east-room', 'south-room'],
        'east-room': [],
        'south-room': [],
      },
      completed: false,
      history: [],
      physicalSlotByRoomId: {
        'room-entry': 0,
        'start-room': 1,
        'east-room': 2,
        'south-room': 3,
      },
      nextPhysicalSlot: 4,
      lastAutoEntry: null,
      previousSceneId: null,
      objective: null,
      hostUserId: null,
      aiControlledActorIds: [],
    };
    await settingsRef.set('pf2e-dungeon-crawl', 'dungeonRuns', { 's': state });

    // Assert the party can move into either child
    const { ok: okEast, state: stateEast } = await advanceToRoom(
      { sceneId: 's', roomId: 'east-room', revealedTokenIds: [] },
      { settingsRef },
    );
    expect(okEast).toBe(true);
    expect(stateEast.currentRoomId).toBe('east-room');
    expect(stateEast.lastAutoEntry).toEqual({
      roomId: 'east-room',
      fromRoomId: 'start-room',
      toRoomId: 'east-room',
      revealedTokenIds: [],
    });

    // Reset and try the other direction
    await settingsRef.set('pf2e-dungeon-crawl', 'dungeonRuns', { 's': state });
    const { ok: okSouth, state: stateSouth } = await advanceToRoom(
      { sceneId: 's', roomId: 'south-room', revealedTokenIds: ['t1', 't2'] },
      { settingsRef },
    );
    expect(okSouth).toBe(true);
    expect(stateSouth.currentRoomId).toBe('south-room');
    expect(stateSouth.lastAutoEntry).toEqual({
      roomId: 'south-room',
      fromRoomId: 'start-room',
      toRoomId: 'south-room',
      revealedTokenIds: ['t1', 't2'],
    });
  });

  it("rejects a roomId that is not one of the current room's children", async () => {
    const settingsRef = makeSettingsStub();
    const state = {
      seed: "test",
      createdAt: Date.now(),
      traits: [],
      excludeTraits: [],
      rooms: {
        'room-entry': { id: 'room-entry', kind: 'safe_entry' },
        'start-room': { id: 'start-room', kind: 'combat' },
        'east-room': { id: 'east-room', kind: 'combat' },
        'south-room': { id: 'south-room', kind: 'encounter' },
        'unrelated-room': { id: 'unrelated-room', kind: 'treasure' },
      },
      currentRoomId: 'start-room',
      edges: {
        'room-entry': ['start-room'],
        'start-room': ['east-room', 'south-room'],
        'east-room': [],
        'south-room': [],
        'unrelated-room': [],
      },
      completed: false,
      history: [],
      physicalSlotByRoomId: {
        'room-entry': 0,
        'start-room': 1,
        'east-room': 2,
        'south-room': 3,
        'unrelated-room': 4,
      },
      nextPhysicalSlot: 5,
      lastAutoEntry: null,
      previousSceneId: null,
      objective: null,
      hostUserId: null,
      aiControlledActorIds: [],
    };
    await settingsRef.set('pf2e-dungeon-crawl', 'dungeonRuns', { 's': state });

    const before = getRunState('s', { settingsRef });
    const { ok, state: returned } = await advanceToRoom(
      { sceneId: 's', roomId: 'unrelated-room' },
      { settingsRef },
    );
    expect(ok).toBe(false);
    expect(returned).toEqual(before);
    expect(getRunState('s', { settingsRef })).toEqual(before);
  });

  it("undoLastRoomEntry correctly restores the previous room using fromRoomId", async () => {
    const settingsRef = makeSettingsStub();
    const state = {
      seed: "test",
      createdAt: Date.now(),
      traits: [],
      excludeTraits: [],
      rooms: {
        'room-a': { id: 'room-a', kind: 'combat' },
        'room-b': { id: 'room-b', kind: 'encounter' },
      },
      currentRoomId: 'room-b',
      edges: {
        'room-a': ['room-b'],
        'room-b': [],
      },
      completed: false,
      history: [],
      physicalSlotByRoomId: {
        'room-a': 0,
        'room-b': 1,
      },
      nextPhysicalSlot: 2,
      lastAutoEntry: {
        roomId: 'room-b',
        fromRoomId: 'room-a',
        toRoomId: 'room-b',
        revealedTokenIds: [],
      },
      previousSceneId: null,
      objective: null,
      hostUserId: null,
      aiControlledActorIds: [],
    };
    await settingsRef.set('pf2e-dungeon-crawl', 'dungeonRuns', { 's': state });

    const { ok, state: undoneState, undone } = await undoLastRoomEntry(
      { sceneId: 's' },
      { settingsRef },
    );
    expect(ok).toBe(true);
    expect(undoneState.currentRoomId).toBe('room-a');
    expect(undoneState.lastAutoEntry).toBeNull();
    expect(undone.roomId).toBe('room-b');
  });
});

describe("markRoomOutcome (graph)", () => {
  /** A minimal, fully dict-shaped graph run state (#93) — matches the
   * convention "advanceToRoom (graph)" above already established: `rooms`
   * keyed by id, `currentRoomId` (not `currentIndex`) as the pointer, and a
   * `hiddenEdges` entry on the current room so a `reduced_travel_time`/
   * `extra_travel_time` outcome has something real to reveal. */
  function seedRunState(overrides = {}) {
    return {
      seed: 'test',
      createdAt: Date.now(),
      traits: [],
      excludeTraits: [],
      rooms: {
        'room-entry': { id: 'room-entry', kind: 'safe_entry', isGoal: false, outcomeSlotId: null },
        'start-room': { id: 'start-room', kind: 'combat', isGoal: false, outcomeSlotId: 'pace' },
        'east-room': { id: 'east-room', kind: 'combat', isGoal: false, outcomeSlotId: null },
        'shortcut-target': { id: 'shortcut-target', kind: 'treasure', isGoal: false, outcomeSlotId: null },
      },
      currentRoomId: 'start-room',
      edges: {
        'room-entry': ['start-room'],
        'start-room': ['east-room'],
        'east-room': [],
        'shortcut-target': [],
      },
      hiddenEdges: {
        'start-room': ['shortcut-target'],
      },
      completed: false,
      history: [],
      physicalSlotByRoomId: {
        'room-entry': 0,
        'start-room': 1,
        'east-room': 2,
        'shortcut-target': 3,
      },
      nextPhysicalSlot: 4,
      lastAutoEntry: null,
      previousSceneId: null,
      objective: null,
      hostUserId: null,
      aiControlledActorIds: [],
      ...overrides,
    };
  }

  it("never mutates state.rooms/state.edges shape via splicing — only reveals hidden paths", async () => {
    const settingsRef = makeSettingsStub();
    const state = seedRunState();
    await settingsRef.set('pf2e-dungeon-crawl', 'dungeonRuns', { s: state });

    const { state: after, effectKey, revealedRoomId } = await markRoomOutcome(
      { sceneId: 's', succeeded: true },
      { settingsRef },
    );

    expect(effectKey).toBe('reduced_travel_time');
    expect(revealedRoomId).toBe('shortcut-target');
    // The hidden edge is now live, merged onto the existing structural edge.
    expect(after.edges['start-room']).toEqual(
      expect.arrayContaining(['east-room', 'shortcut-target']),
    );
    expect(after.hiddenEdges['start-room']).toBeUndefined();
    // state.rooms itself is never spliced/rebuilt — same keys, same room
    // objects, nothing added or removed.
    expect(Object.keys(after.rooms).sort()).toEqual(
      Object.keys(state.rooms).sort(),
    );
    expect(after.rooms).toEqual(state.rooms);
    // No physical-slot-assignment side effect either — #93's eager
    // pregeneration already built and slotted every room at run start.
    expect(after.physicalSlotByRoomId).toEqual(state.physicalSlotByRoomId);
    expect(after.nextPhysicalSlot).toBe(state.nextPhysicalSlot);
    expect(after.currentRoomId).toBe('start-room'); // unmoved — only advanceToRoom moves it
  });

  it("is a no-op (nothing revealed) when the room has no hidden edge", async () => {
    const settingsRef = makeSettingsStub();
    const state = seedRunState({
      currentRoomId: 'east-room',
      rooms: {
        ...seedRunState().rooms,
        'east-room': { id: 'east-room', kind: 'combat', isGoal: false, outcomeSlotId: 'pace' },
      },
    });
    await settingsRef.set('pf2e-dungeon-crawl', 'dungeonRuns', { s: state });

    const { revealedRoomId, state: after } = await markRoomOutcome(
      { sceneId: 's', succeeded: true },
      { settingsRef },
    );
    expect(revealedRoomId).toBeNull();
    expect(after.edges).toEqual(state.edges);
    expect(after.hiddenEdges).toEqual(state.hiddenEdges);
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
    const created = await createDictRun(
      { sceneId: "s", roomCount: 5, seed: "fixed" },
      { settingsRef },
    );
    const roomId = created.roomOrder[1];
    const state = await ensureSkillChallenge(
      "s",
      roomId,
      { seed: "fixed", locationTag: "undead", partySize: 4 },
      { settingsRef },
    );
    const room = state.rooms[roomId];
    expect(room.challenge).toBeTruthy();
    expect(room.challenge.vp).toBe(0);
    expect(room.challenge.resolved).toBeNull();
    // Every other room stays untouched.
    expect(
      state.rooms[created.roomOrder[2]].challenge,
    ).toBeUndefined();
  });

  it("is a no-op if the room already has a challenge (never rerolls it)", async () => {
    const settingsRef = makeSettingsStub();
    const created = await createDictRun(
      { sceneId: "s", roomCount: 5, seed: "fixed" },
      { settingsRef },
    );
    const roomId = created.roomOrder[1];
    const first = await ensureSkillChallenge(
      "s",
      roomId,
      { seed: "fixed", locationTag: "undead", partySize: 4 },
      { settingsRef },
    );
    const firstChallenge = first.rooms[roomId].challenge;
    const second = await ensureSkillChallenge(
      "s",
      roomId,
      { seed: "fixed", locationTag: "undead", partySize: 4 },
      { settingsRef },
    );
    expect(second.rooms[roomId].challenge).toEqual(
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
    const created = await createDictRun(
      { sceneId: "s", roomCount: 5, seed: "fixed" },
      { settingsRef },
    );
    const roomId = created.roomOrder[1];
    await ensureSkillChallenge(
      "s",
      roomId,
      { seed: "fixed", locationTag: "undead", partySize: 4 },
      { settingsRef },
    );
    const state = await recordSkillChallengeAttempt("s", roomId, "success", {
      settingsRef,
    });
    const room = state.rooms[roomId];
    expect(room.challenge.vp).toBe(1);
    expect(room.challenge.attemptsUsed).toBe(1);
  });

  it("is a no-op if the room has no challenge attached yet", async () => {
    const settingsRef = makeSettingsStub();
    const created = await createDictRun(
      { sceneId: "s", roomCount: 5, seed: "fixed" },
      { settingsRef },
    );
    const roomId = created.roomOrder[1];
    const state = await recordSkillChallengeAttempt("s", roomId, "success", {
      settingsRef,
    });
    const room = state.rooms[roomId];
    expect(room.challenge).toBeUndefined();
  });

  it("is a no-op once the challenge is already resolved", async () => {
    const settingsRef = makeSettingsStub();
    const created = await createDictRun(
      { sceneId: "s", roomCount: 5, seed: "fixed" },
      { settingsRef },
    );
    const roomId = created.roomOrder[1];
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
    const resolvedChallenge = state.rooms[roomId].challenge;
    expect(resolvedChallenge.resolved).toBe("failure");
    const again = await recordSkillChallengeAttempt(
      "s",
      roomId,
      "criticalSuccess",
      { settingsRef },
    );
    expect(again.rooms[roomId].challenge).toEqual(
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
    const created = await createDictRun(
      { sceneId: "s", roomCount: 5, seed: "fixed" },
      { settingsRef },
    );
    const roomId = created.roomOrder[1];
    const state = await ensurePuzzleState(
      "s",
      roomId,
      { hintChecks: HINT_CHECKS },
      { settingsRef },
    );
    const room = state.rooms[roomId];
    expect(room.puzzle).toBeTruthy();
    expect(room.puzzle.stages).toHaveLength(3);
    expect(room.puzzle.resolved).toBeNull();
    expect(room.puzzle.customization).toEqual({ status: "pending" });
    expect(
      state.rooms[created.roomOrder[2]].puzzle,
    ).toBeUndefined();
  });

  it("scales every stage's dc to the given partyLevel", async () => {
    const settingsRef = makeSettingsStub();
    const created = await createDictRun(
      { sceneId: "s", roomCount: 5, seed: "fixed" },
      { settingsRef },
    );
    const roomId = created.roomOrder[1];
    const state = await ensurePuzzleState(
      "s",
      roomId,
      { hintChecks: HINT_CHECKS, partyLevel: 5 },
      { settingsRef },
    );
    const room = state.rooms[roomId];
    // simpleDcForLevel(5) === 20 (skill-challenge-mechanics.mjs's own table)
    expect(room.puzzle.stages.every((s) => s.dc === 20)).toBe(true);
  });

  it("is a no-op if the room already has puzzle state (never rerolls it)", async () => {
    const settingsRef = makeSettingsStub();
    const created = await createDictRun(
      { sceneId: "s", roomCount: 5, seed: "fixed" },
      { settingsRef },
    );
    const roomId = created.roomOrder[1];
    const first = await ensurePuzzleState(
      "s",
      roomId,
      { hintChecks: HINT_CHECKS },
      { settingsRef },
    );
    const firstPuzzle = first.rooms[roomId].puzzle;
    const second = await ensurePuzzleState(
      "s",
      roomId,
      { hintChecks: HINT_CHECKS },
      { settingsRef },
    );
    expect(second.rooms[roomId].puzzle).toEqual(
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
    const created = await createDictRun(
      { sceneId: "s", roomCount: 5, seed: "fixed" },
      { settingsRef },
    );
    const roomId = created.roomOrder[1];
    await ensurePuzzleState(
      "s",
      roomId,
      { hintChecks: HINT_CHECKS },
      { settingsRef },
    );
    const state = await recordPuzzleStageAttempt("s", roomId, 0, "success", {
      settingsRef,
    });
    const room = state.rooms[roomId];
    expect(room.puzzle.stages[0].succeeded).toBe(true);
    expect(room.puzzle.successes).toBe(1);
  });

  it("is a no-op if the room has no puzzle attached yet", async () => {
    const settingsRef = makeSettingsStub();
    const created = await createDictRun(
      { sceneId: "s", roomCount: 5, seed: "fixed" },
      { settingsRef },
    );
    const roomId = created.roomOrder[1];
    const state = await recordPuzzleStageAttempt("s", roomId, 0, "success", {
      settingsRef,
    });
    const room = state.rooms[roomId];
    expect(room.puzzle).toBeUndefined();
  });

  it("is a no-op once the puzzle is already resolved", async () => {
    const settingsRef = makeSettingsStub();
    const created = await createDictRun(
      { sceneId: "s", roomCount: 5, seed: "fixed" },
      { settingsRef },
    );
    const roomId = created.roomOrder[1];
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
    const resolvedPuzzle = state.rooms[roomId].puzzle;
    expect(resolvedPuzzle.resolved).toBe("success");
    const again = await recordPuzzleStageAttempt("s", roomId, 2, "success", {
      settingsRef,
    });
    expect(again.rooms[roomId].puzzle).toEqual(
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
    await createDictRun(
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
    await createDictRun(
      { sceneId: "s", roomCount: 5, seed: "fixed" },
      { settingsRef },
    );
    await setObjective("s", "First objective", { settingsRef });
    const state = await setObjective("s", "Second objective", { settingsRef });
    expect(state.objective).toBe("Second objective");
  });

  it("treats a blank/whitespace-only string as clearing the objective", async () => {
    const settingsRef = makeSettingsStub();
    await createDictRun(
      { sceneId: "s", roomCount: 5, seed: "fixed" },
      { settingsRef },
    );
    await setObjective("s", "Something", { settingsRef });
    const state = await setObjective("s", "   ", { settingsRef });
    expect(state.objective).toBeNull();
  });

  it("clears the objective when called with null", async () => {
    const settingsRef = makeSettingsStub();
    await createDictRun(
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
    const created = await createDictRun(
      { sceneId: "s", roomCount: 5, seed: "fixed" },
      { settingsRef },
    );
    const roomId = created.roomOrder[1];
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
    const room = state.rooms[roomId];
    expect(room.challenge.customization).toEqual({ status: "pending" });
  });

  it("getPendingSkillChallengeCustomization finds the pending room and hands back its content", async () => {
    const settingsRef = makeSettingsStub();
    const roomId = await makeRoomWithChallenge(settingsRef);
    // locationTag comes from the room's own (seed-derived) field, not the
    // `locationTag` makeRoomWithChallenge passed to ensureSkillChallenge
    // (that one only ever feeds the generic specialty-skill fallback pick,
    // never stored on the room itself) — assert against the real room.
    const room = getRunState("s", { settingsRef }).rooms[roomId];
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
    const room = state.rooms[roomId];
    expect(room.challenge.name).toBe("The Iron Concord");
    expect(room.challenge.summary).toBe("A tense truce negotiation.");
    expect(room.challenge.customization).toEqual({ status: "customized" });
  });

  it("merges skillFlavor onto the existing map rather than replacing it", async () => {
    const settingsRef = makeSettingsStub();
    const roomId = await makeRoomWithChallenge(settingsRef);
    const before = getRunState("s", { settingsRef }).rooms[roomId];
    const skill = before.challenge.specialtySkills[0];
    const state = await applySkillChallengeCustomization(
      "s",
      roomId,
      { skillFlavor: { [skill]: "A vivid new detail." } },
      { settingsRef },
    );
    const room = state.rooms[roomId];
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
    const created = await createDictRun(
      { sceneId: "s", roomCount: 5, seed: "fixed" },
      { settingsRef },
    );
    const roomId = created.roomOrder[1];
    const state = await applySkillChallengeCustomization(
      "s",
      roomId,
      { name: "Anything" },
      { settingsRef },
    );
    expect(state.rooms[roomId].challenge).toBeUndefined();
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
    const created = await createDictRun(
      { sceneId: "s", roomCount: 5, seed: "fixed" },
      { settingsRef },
    );
    const roomId = created.roomOrder[1];
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
    const room = state.rooms[roomId];
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
    const room = state.rooms[roomId];
    expect(room.puzzle.name).toBe("The Whispering Vault");
    expect(room.puzzle.summary).toBe("A locked vault hums with old magic.");
    expect(room.puzzle.customization).toEqual({ status: "customized" });
  });

  it("applyPuzzleCustomization overwrites playerDescription", async () => {
    const settingsRef = makeSettingsStub();
    const roomId = await makeRoomWithPuzzle(settingsRef);
    const state = await applyPuzzleCustomization(
      "s",
      roomId,
      { playerDescription: "The vault door hums with a faint violet light." },
      { settingsRef },
    );
    const room = state.rooms[roomId];
    expect(room.puzzle.playerDescription).toBe(
      "The vault door hums with a faint violet light.",
    );
  });

  it("leaves a previously-set playerDescription untouched when a later call omits it", async () => {
    const settingsRef = makeSettingsStub();
    const roomId = await makeRoomWithPuzzle(settingsRef);
    await applyPuzzleCustomization(
      "s",
      roomId,
      { playerDescription: "Original customized flavor." },
      { settingsRef },
    );
    const state = await applyPuzzleCustomization(
      "s",
      roomId,
      { name: "New Name Only" },
      { settingsRef },
    );
    const room = state.rooms[roomId];
    expect(room.puzzle.playerDescription).toBe("Original customized flavor.");
    expect(room.puzzle.name).toBe("New Name Only");
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
    const room = state.rooms[roomId];
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
    const created = await createDictRun(
      { sceneId: "s", roomCount: 5, seed: "fixed" },
      { settingsRef },
    );
    const roomId = created.roomOrder[1];
    const state = await applyPuzzleCustomization(
      "s",
      roomId,
      { name: "Anything" },
      { settingsRef },
    );
    expect(state.rooms[roomId].puzzle).toBeUndefined();
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

describe("ensureTrapState / applyTrapRoomState", () => {
  async function makeRoom(settingsRef) {
    const created = await createDictRun(
      { sceneId: "s", roomCount: 5, seed: "fixed" },
      { settingsRef },
    );
    return created.roomOrder[1];
  }

  it("ensureTrapState attaches trap name/description to a room with none yet", async () => {
    const settingsRef = makeSettingsStub();
    const roomId = await makeRoom(settingsRef);
    const state = await ensureTrapState(
      "s",
      roomId,
      { name: "Scythe Blades", description: "A pressure plate triggers swinging blades." },
      { settingsRef },
    );
    const room = state.rooms[roomId];
    expect(room.trap).toEqual({
      name: "Scythe Blades",
      description: "A pressure plate triggers swinging blades.",
    });
  });

  it("ensureTrapState is a no-op if the room already has a trap state", async () => {
    const settingsRef = makeSettingsStub();
    const roomId = await makeRoom(settingsRef);
    await ensureTrapState(
      "s",
      roomId,
      { name: "Scythe Blades", description: "First." },
      { settingsRef },
    );
    const state = await ensureTrapState(
      "s",
      roomId,
      { name: "Different Trap", description: "Second." },
      { settingsRef },
    );
    const room = state.rooms[roomId];
    expect(room.trap).toEqual({ name: "Scythe Blades", description: "First." });
  });

  it("ensureTrapState is a no-op with no matching room", async () => {
    const settingsRef = makeSettingsStub();
    await makeRoom(settingsRef);
    const state = await ensureTrapState(
      "s",
      "room-nope",
      { name: "X", description: "Y" },
      { settingsRef },
    );
    expect(state.rooms["room-nope"]).toBeUndefined();
  });

  it("ensureTrapState is a no-op with no run at all", async () => {
    const settingsRef = makeSettingsStub();
    const result = await ensureTrapState(
      "nope",
      "room-x",
      { name: "X", description: "Y" },
      { settingsRef },
    );
    expect(result).toBeNull();
  });

  it("applyTrapRoomState overwrites name/description when the room has an existing trap state", async () => {
    const settingsRef = makeSettingsStub();
    const roomId = await makeRoom(settingsRef);
    await ensureTrapState(
      "s",
      roomId,
      { name: "Scythe Blades", description: "Original." },
      { settingsRef },
    );
    const state = await applyTrapRoomState(
      "s",
      roomId,
      { name: "The Grinning Gears", description: "A customized flavor." },
      { settingsRef },
    );
    const room = state.rooms[roomId];
    expect(room.trap).toEqual({
      name: "The Grinning Gears",
      description: "A customized flavor.",
    });
  });

  it("applyTrapRoomState preserves whatever field wasn't passed", async () => {
    const settingsRef = makeSettingsStub();
    const roomId = await makeRoom(settingsRef);
    await ensureTrapState(
      "s",
      roomId,
      { name: "Scythe Blades", description: "Original." },
      { settingsRef },
    );
    const state = await applyTrapRoomState(
      "s",
      roomId,
      { name: "The Grinning Gears" },
      { settingsRef },
    );
    const room = state.rooms[roomId];
    expect(room.trap).toEqual({ name: "The Grinning Gears", description: "Original." });
  });

  it("applyTrapRoomState is a no-op if the room has no trap state at all", async () => {
    const settingsRef = makeSettingsStub();
    const roomId = await makeRoom(settingsRef);
    const state = await applyTrapRoomState(
      "s",
      roomId,
      { name: "Anything" },
      { settingsRef },
    );
    expect(state.rooms[roomId].trap).toBeUndefined();
  });

  it("applyTrapRoomState is a no-op with no run at all", async () => {
    const settingsRef = makeSettingsStub();
    const result = await applyTrapRoomState(
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
    const created = await createDictRun(
      { sceneId: "s", roomCount: 5, seed: "fixed" },
      { settingsRef },
    );
    const roomId = created.roomOrder[1];
    await ensureNarrativeState("s", roomId, { setpiece }, { settingsRef });
    return roomId;
  }

  it("ensureNarrativeState attaches the setpiece's fields and flags it pending", async () => {
    const settingsRef = makeSettingsStub();
    const roomId = await makeRoomWithNarrative(settingsRef);
    const state = getRunState("s", { settingsRef });
    const room = state.rooms[roomId];
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
    const room = getRunState("s", { settingsRef }).rooms[roomId];
    expect(room.narrative.name).toBe("The Example");
  });

  it("getPendingNarrativeCustomization finds the pending room and hands back its content", async () => {
    const settingsRef = makeSettingsStub();
    const roomId = await makeRoomWithNarrative(settingsRef, choiceSetpiece);
    const room = getRunState("s", { settingsRef }).rooms[roomId];
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
    const room = state.rooms[roomId];
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
    const room = state.rooms[roomId];
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
    const created = await createDictRun(
      { sceneId: "s", roomCount: 5, seed: "fixed" },
      { settingsRef },
    );
    const roomId = created.roomOrder[1];
    const state = await applyNarrativeCustomization(
      "s",
      roomId,
      { name: "Anything" },
      { settingsRef },
    );
    expect(state.rooms[roomId].narrative).toBeUndefined();
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

describe("clearPuzzleState", () => {
  it("clears an already-attached puzzle state back to null", async () => {
    const settingsRef = makeSettingsStub();
    const created = await createDictRun(
      { sceneId: "s4", roomCount: 3, seed: "fixed" },
      { settingsRef },
    );
    const roomId = created.roomOrder[1];
    await ensurePuzzleState("s4", roomId, { hintChecks: [] }, { settingsRef });
    const cleared = await clearPuzzleState("s4", roomId, { settingsRef });
    const room = cleared.rooms[roomId];
    expect(room.puzzle).toBeFalsy();
  });

  it("is a no-op against a room with no puzzle state attached", async () => {
    const settingsRef = makeSettingsStub();
    const created = await createDictRun(
      { sceneId: "s5", roomCount: 3, seed: "fixed" },
      { settingsRef },
    );
    const roomId = created.roomOrder[1];
    const cleared = await clearPuzzleState("s5", roomId, { settingsRef });
    expect(cleared.rooms).toEqual(created.rooms);
  });

  it("is a no-op with no run at all", async () => {
    const settingsRef = makeSettingsStub();
    const result = await clearPuzzleState("nope", "room-x", { settingsRef });
    expect(result).toBeNull();
  });
});

describe("clearSkillChallengeState", () => {
  it("clears an already-attached challenge back to null", async () => {
    const settingsRef = makeSettingsStub();
    const created = await createDictRun(
      { sceneId: "s6", roomCount: 3, seed: "fixed" },
      { settingsRef },
    );
    const roomId = created.roomOrder[1];
    await ensureSkillChallenge(
      "s6",
      roomId,
      { seed: "fixed", locationTag: "undead", partySize: 4 },
      { settingsRef },
    );
    const cleared = await clearSkillChallengeState("s6", roomId, {
      settingsRef,
    });
    const room = cleared.rooms[roomId];
    expect(room.challenge).toBeFalsy();
  });

  it("is a no-op against a room with no challenge attached", async () => {
    const settingsRef = makeSettingsStub();
    const created = await createDictRun(
      { sceneId: "s7", roomCount: 3, seed: "fixed" },
      { settingsRef },
    );
    const roomId = created.roomOrder[1];
    const cleared = await clearSkillChallengeState("s7", roomId, {
      settingsRef,
    });
    expect(cleared.rooms).toEqual(created.rooms);
  });

  it("is a no-op with no run at all", async () => {
    const settingsRef = makeSettingsStub();
    const result = await clearSkillChallengeState("nope", "room-x", {
      settingsRef,
    });
    expect(result).toBeNull();
  });
});

describe("clearNarrativeState", () => {
  const loreSetpiece = {
    id: "the_example_lore",
    kind: "narrative",
    archetype: "lore",
    name: "The Example",
    summary: "An example lore beat.",
    revealText: "The ruins predate the empire.",
  };

  it("clears an already-attached narrative state back to null", async () => {
    const settingsRef = makeSettingsStub();
    const created = await createDictRun(
      { sceneId: "s8", roomCount: 3, seed: "fixed" },
      { settingsRef },
    );
    const roomId = created.roomOrder[1];
    await ensureNarrativeState(
      "s8",
      roomId,
      { setpiece: loreSetpiece },
      { settingsRef },
    );
    const cleared = await clearNarrativeState("s8", roomId, { settingsRef });
    const room = cleared.rooms[roomId];
    expect(room.narrative).toBeFalsy();
  });

  it("is a no-op against a room with no narrative state attached", async () => {
    const settingsRef = makeSettingsStub();
    const created = await createDictRun(
      { sceneId: "s9", roomCount: 3, seed: "fixed" },
      { settingsRef },
    );
    const roomId = created.roomOrder[1];
    const cleared = await clearNarrativeState("s9", roomId, { settingsRef });
    expect(cleared.rooms).toEqual(created.rooms);
  });

  it("is a no-op with no run at all", async () => {
    const settingsRef = makeSettingsStub();
    const result = await clearNarrativeState("nope", "room-x", {
      settingsRef,
    });
    expect(result).toBeNull();
  });
});

describe("clearTrapState", () => {
  it("clears an already-attached trap state back to null", async () => {
    const settingsRef = makeSettingsStub();
    const created = await createDictRun(
      { sceneId: "s10", roomCount: 3, seed: "fixed" },
      { settingsRef },
    );
    const roomId = created.roomOrder[1];
    await ensureTrapState(
      "s10",
      roomId,
      {
        name: "Scythe Blades",
        description: "A pressure plate triggers swinging blades.",
      },
      { settingsRef },
    );
    const cleared = await clearTrapState("s10", roomId, { settingsRef });
    const room = cleared.rooms[roomId];
    expect(room.trap).toBeFalsy();
  });

  it("is a no-op against a room with no trap state attached", async () => {
    const settingsRef = makeSettingsStub();
    const created = await createDictRun(
      { sceneId: "s11", roomCount: 3, seed: "fixed" },
      { settingsRef },
    );
    const roomId = created.roomOrder[1];
    const cleared = await clearTrapState("s11", roomId, { settingsRef });
    expect(cleared.rooms).toEqual(created.rooms);
  });

  it("is a no-op with no run at all", async () => {
    const settingsRef = makeSettingsStub();
    const result = await clearTrapState("nope", "room-x", { settingsRef });
    expect(result).toBeNull();
  });
});

describe("ensureTreasureState / getPendingTreasureCustomization / applyTreasureCustomization", () => {
  const strongboxSetpiece = {
    id: "the_example_strongbox",
    kind: "treasure",
    name: "The Example Strongbox",
    summary: "A dented iron strongbox, its lock never picked.",
  };

  async function makeRoomWithTreasure(settingsRef, setpiece = strongboxSetpiece) {
    const created = await createDictRun(
      { sceneId: "s", roomCount: 5, seed: "fixed" },
      { settingsRef },
    );
    const roomId = created.roomOrder[1];
    await ensureTreasureState("s", roomId, { setpiece }, { settingsRef });
    return roomId;
  }

  it("ensureTreasureState attaches the setpiece's name/summary and flags it pending", async () => {
    const settingsRef = makeSettingsStub();
    const roomId = await makeRoomWithTreasure(settingsRef);
    const state = getRunState("s", { settingsRef });
    const room = state.rooms[roomId];
    expect(room.treasure.name).toBe("The Example Strongbox");
    expect(room.treasure.summary).toBe(
      "A dented iron strongbox, its lock never picked.",
    );
    expect(room.treasure.customization).toEqual({ status: "pending" });
  });

  it("ensureTreasureState is a no-op if the room already has treasure state", async () => {
    const settingsRef = makeSettingsStub();
    const roomId = await makeRoomWithTreasure(settingsRef);
    await ensureTreasureState(
      "s",
      roomId,
      { setpiece: { ...strongboxSetpiece, name: "Different" } },
      { settingsRef },
    );
    const room = getRunState("s", { settingsRef }).rooms[roomId];
    expect(room.treasure.name).toBe("The Example Strongbox");
  });

  it("getPendingTreasureCustomization finds the pending room and hands back its content", async () => {
    const settingsRef = makeSettingsStub();
    const roomId = await makeRoomWithTreasure(settingsRef);
    const room = getRunState("s", { settingsRef }).rooms[roomId];
    const pending = getPendingTreasureCustomization("s", { settingsRef });
    expect(pending.roomId).toBe(roomId);
    expect(pending.sceneId).toBe("s");
    expect(pending.name).toBe("The Example Strongbox");
    expect(pending.summary).toBe(strongboxSetpiece.summary);
    expect(pending.locationTag).toBe(room.locationTag);
  });

  it("returns null when nothing is pending", () => {
    const settingsRef = makeSettingsStub();
    expect(getPendingTreasureCustomization("nope", { settingsRef })).toBeNull();
  });

  it("applyTreasureCustomization overwrites name/summary and marks it customized", async () => {
    const settingsRef = makeSettingsStub();
    const roomId = await makeRoomWithTreasure(settingsRef);
    const state = await applyTreasureCustomization(
      "s",
      roomId,
      {
        name: "The Cairn of the Unnamed",
        summary: "A low cairn of fitted stones marks a burial no one named.",
      },
      { settingsRef },
    );
    const room = state.rooms[roomId];
    expect(room.treasure.name).toBe("The Cairn of the Unnamed");
    expect(room.treasure.summary).toBe(
      "A low cairn of fitted stones marks a burial no one named.",
    );
    expect(room.treasure.customization).toEqual({ status: "customized" });
  });

  it("applyTreasureCustomization never touches gp/item mechanics (treasure state carries none)", async () => {
    const settingsRef = makeSettingsStub();
    const roomId = await makeRoomWithTreasure(settingsRef);
    const state = await applyTreasureCustomization(
      "s",
      roomId,
      { name: "New Name" },
      { settingsRef },
    );
    const room = state.rooms[roomId];
    expect(Object.keys(room.treasure).sort()).toEqual(
      ["customization", "name", "summary"].sort(),
    );
  });

  it("no longer appears as pending once customization is applied", async () => {
    const settingsRef = makeSettingsStub();
    const roomId = await makeRoomWithTreasure(settingsRef);
    await applyTreasureCustomization(
      "s",
      roomId,
      { name: "New Name" },
      { settingsRef },
    );
    expect(getPendingTreasureCustomization("s", { settingsRef })).toBeNull();
  });

  it("stops being offered once the room is resolved, even if still marked pending", async () => {
    const settingsRef = makeSettingsStub();
    const roomId = await makeRoomWithTreasure(settingsRef);
    await advancePastEntry("s", settingsRef);
    await markRoomOutcome({ sceneId: "s", succeeded: true }, { settingsRef });
    expect(getPendingTreasureCustomization("s", { settingsRef })).toBeNull();
  });

  it("applyTreasureCustomization is a no-op if the room has no treasure state at all", async () => {
    const settingsRef = makeSettingsStub();
    const created = await createDictRun(
      { sceneId: "s", roomCount: 5, seed: "fixed" },
      { settingsRef },
    );
    const roomId = created.roomOrder[1];
    const state = await applyTreasureCustomization(
      "s",
      roomId,
      { name: "Anything" },
      { settingsRef },
    );
    expect(state.rooms[roomId].treasure).toBeUndefined();
  });

  it("applyTreasureCustomization is a no-op with no run at all", async () => {
    const settingsRef = makeSettingsStub();
    const result = await applyTreasureCustomization(
      "nope",
      "room-x",
      { name: "Anything" },
      { settingsRef },
    );
    expect(result).toBeNull();
  });
});

describe("clearTreasureState", () => {
  const strongboxSetpiece = {
    id: "the_example_strongbox",
    kind: "treasure",
    name: "The Example Strongbox",
    summary: "A dented iron strongbox, its lock never picked.",
  };

  it("clears an already-attached treasure state back to null", async () => {
    const settingsRef = makeSettingsStub();
    const created = await createDictRun(
      { sceneId: "s12", roomCount: 3, seed: "fixed" },
      { settingsRef },
    );
    const roomId = created.roomOrder[1];
    await ensureTreasureState(
      "s12",
      roomId,
      { setpiece: strongboxSetpiece },
      { settingsRef },
    );
    const cleared = await clearTreasureState("s12", roomId, { settingsRef });
    const room = cleared.rooms[roomId];
    expect(room.treasure).toBeFalsy();
  });

  it("is a no-op against a room with no treasure state attached", async () => {
    const settingsRef = makeSettingsStub();
    const created = await createDictRun(
      { sceneId: "s13", roomCount: 3, seed: "fixed" },
      { settingsRef },
    );
    const roomId = created.roomOrder[1];
    const cleared = await clearTreasureState("s13", roomId, { settingsRef });
    expect(cleared.rooms).toEqual(created.rooms);
  });

  it("is a no-op with no run at all", async () => {
    const settingsRef = makeSettingsStub();
    const result = await clearTreasureState("nope", "room-x", { settingsRef });
    expect(result).toBeNull();
  });
});

describe("dungeonRuns settings namespace", () => {
  /** Regression test for a bug where this file's settings access stayed
   * pinned to a stale module id, which module.mjs no longer registers
   * "dungeonRuns" under — a real
   * game.settings.get/set throws in that case. The makeSettingsStub() used
   * by every other test in this file ignores its moduleId argument
   * entirely, so it can't catch this; this test records the exact
   * moduleId strings passed through instead. */
  it("always reads/writes dungeonRuns under the pf2e-dungeon-crawl module id", async () => {
    const seenModuleIds = new Set();
    const store = { dungeonRuns: {} };
    const settingsRef = {
      get: (moduleId, key) => {
        seenModuleIds.add(moduleId);
        return store[key];
      },
      set: (moduleId, key, value) => {
        seenModuleIds.add(moduleId);
        store[key] = value;
      },
    };

    await createRun({ sceneId: "scene-1", roomCount: 5 }, { settingsRef });
    getRunState("scene-1", { settingsRef });
    await abandonRun("scene-1", { settingsRef });

    expect(seenModuleIds).toEqual(new Set(["pf2e-dungeon-crawl"]));
  });
});

describe('roomsToEagerlyBuild (graph)', () => {
  function graphState(overrides = {}) {
    return {
      rooms: {
        'room-entry': { id: 'room-entry', kind: 'safe_entry', isGoal: false },
        a: { id: 'a', kind: 'combat', isGoal: false },
        b: { id: 'b', kind: 'trap', isGoal: false },
        goal: { id: 'goal', kind: 'combat', isGoal: true }
      },
      edges: { 'room-entry': ['a', 'b'], a: ['goal'], b: ['goal'], goal: [] },
      layoutEdges: { 'room-entry': ['a', 'b'], a: ['goal'], b: ['goal'], goal: [] },
      hostUserId: null,
      ...overrides
    };
  }

  it('builds every room except the entry, regardless of hostUserId', () => {
    const withHost = roomsToEagerlyBuild(graphState({ hostUserId: 'u1' }));
    const withoutHost = roomsToEagerlyBuild(graphState({ hostUserId: null }));
    expect(withHost.map((e) => e.room.id).sort()).toEqual(['a', 'b', 'goal']);
    expect(withoutHost.map((e) => e.room.id).sort()).toEqual(['a', 'b', 'goal']);
  });

  it('every room appears after all of its parents (topological order)', () => {
    const built = roomsToEagerlyBuild(graphState());
    const order = built.map((e) => e.room.id);
    expect(order.indexOf('a')).toBeLessThan(order.indexOf('goal'));
    expect(order.indexOf('b')).toBeLessThan(order.indexOf('goal'));
  });

  it('a combat room at generation-order position 1 is still eagerly built (ITEM-11 deferral removed)', () => {
    const built = roomsToEagerlyBuild(graphState());
    expect(built.some((e) => e.room.id === 'a' && e.room.kind === 'combat')).toBe(true);
  });

  it('#156: a detour room reachable only via layoutEdges (not edges) is still built', () => {
    const state = graphState({
      rooms: {
        'room-entry': { id: 'room-entry', kind: 'safe_entry', isGoal: false },
        a: { id: 'a', kind: 'combat', isGoal: false },
        'room-detour-0': { id: 'room-detour-0', kind: 'trap', isGoal: false },
        goal: { id: 'goal', kind: 'combat', isGoal: true }
      },
      edges: { 'room-entry': ['a'], a: ['goal'], 'room-detour-0': ['goal'], goal: [] },
      layoutEdges: { 'room-entry': ['a'], a: ['goal', 'room-detour-0'], 'room-detour-0': ['goal'], goal: [] }
    });
    const built = roomsToEagerlyBuild(state);
    expect(built.map((e) => e.room.id)).toContain('room-detour-0');
  });
});

it('roomsToEagerlyBuild returns every room after the entry, in order, as {room, buildOrder} pairs', () => {
  const r1 = { id: 'r1', kind: 'narrative' };
  const r2 = { id: 'r2', kind: 'trap' };
  const r3 = { id: 'r3', kind: 'puzzle' };
  const state = {
    rooms: {
      'room-entry': { id: 'room-entry', kind: 'narrative' },
      r1,
      r2,
      r3,
    },
    edges: { 'room-entry': ['r1', 'r2', 'r3'], r1: [], r2: [], r3: [] },
    layoutEdges: { 'room-entry': ['r1', 'r2', 'r3'], r1: [], r2: [], r3: [] },
  };
  const result = roomsToEagerlyBuild(state);
  expect(result).toHaveLength(3);
  expect(result.map((e) => e.room.id).sort()).toEqual(['r1', 'r2', 'r3']);
  expect(result.every((e) => typeof e.buildOrder === 'number')).toBe(true);
});

it('roomsToEagerlyBuild returns an empty array for a single-room (entry-only) dungeon', () => {
  const state = {
    rooms: { 'room-entry': { id: 'room-entry', kind: 'narrative' } },
    edges: { 'room-entry': [] },
    layoutEdges: { 'room-entry': [] },
  };
  expect(roomsToEagerlyBuild(state)).toEqual([]);
});

describe("commitEagerPhysicalSlots", () => {
  it("merges eagerly-built slot assignments into physicalSlotByRoomId and advances nextPhysicalSlot past the highest committed slot", async () => {
    const settingsRef = makeSettingsStub();
    const created = await createRun(
      { sceneId: "s1", roomCount: 5, traits: [], excludeTraits: [] },
      { settingsRef },
    );
    const eagerlyBuilt = [
      { room: created.rooms[2], buildOrder: 2 },
      { room: created.rooms[3], buildOrder: 3 },
      { room: created.rooms[4], buildOrder: 4 },
    ];
    const result = await commitEagerPhysicalSlots("s1", eagerlyBuilt, {
      settingsRef,
    });
    expect(result.physicalSlotByRoomId[created.rooms[2].id]).toBe(2);
    expect(result.physicalSlotByRoomId[created.rooms[3].id]).toBe(3);
    expect(result.physicalSlotByRoomId[created.rooms[4].id]).toBe(4);
    expect(result.nextPhysicalSlot).toBe(5);
  });

  it("does not regress nextPhysicalSlot when called a second time with the same or a lower slot", async () => {
    const settingsRef = makeSettingsStub();
    const created = await createRun(
      { sceneId: "s2", roomCount: 3, traits: [], excludeTraits: [] },
      { settingsRef },
    );
    await commitEagerPhysicalSlots(
      "s2",
      [{ room: created.rooms[2], buildOrder: 2 }],
      { settingsRef },
    );
    const result = await commitEagerPhysicalSlots(
      "s2",
      [{ room: created.rooms[2], buildOrder: 2 }],
      { settingsRef },
    );
    expect(result.nextPhysicalSlot).toBe(3);
  });

  it("does not touch state.rooms, state.currentIndex, or any other field", async () => {
    const settingsRef = makeSettingsStub();
    const created = await createRun(
      { sceneId: "s3", roomCount: 3, traits: [], excludeTraits: [] },
      { settingsRef },
    );
    const result = await commitEagerPhysicalSlots(
      "s3",
      [{ room: created.rooms[2], buildOrder: 2 }],
      { settingsRef },
    );
    expect(result.rooms).toEqual(created.rooms);
    expect(result.currentIndex).toBe(created.currentIndex);
  });
});
