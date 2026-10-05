import { describe, it, expect, vi } from "vitest";
import {
  ROOM_FEATURE_TOKEN_TYPES,
  buildRoomFeatureTokenActorData,
  planRoomFeatureAction,
  runRoomFeatureAction,
  routeTargetTokenEvent,
} from "../scripts/room-feature-tokens.mjs";

describe("ROOM_FEATURE_TOKEN_TYPES", () => {
  it("has exactly the three room kinds this feature covers", () => {
    expect(Object.keys(ROOM_FEATURE_TOKEN_TYPES).sort()).toEqual([
      "puzzle",
      "skill_challenge",
      "treasure",
    ]);
  });

  it("every entry has a name and an icon path", () => {
    for (const entry of Object.values(ROOM_FEATURE_TOKEN_TYPES)) {
      expect(typeof entry.name).toBe("string");
      expect(entry.name.length).toBeGreaterThan(0);
      expect(entry.img).toMatch(/^icons\/svg\/.+\.svg$/);
    }
  });
});

describe("buildRoomFeatureTokenActorData", () => {
  it("builds a loot-type actor with the kind's own name and icon", () => {
    const data = buildRoomFeatureTokenActorData("treasure", "room-1");
    expect(data.type).toBe("loot");
    expect(data.name).toBe(ROOM_FEATURE_TOKEN_TYPES.treasure.name);
    expect(data.img).toBe(ROOM_FEATURE_TOKEN_TYPES.treasure.img);
    expect(data.prototypeToken.texture.src).toBe(ROOM_FEATURE_TOKEN_TYPES.treasure.img);
  });

  it("flags the actor with its room-feature kind and room id", () => {
    const data = buildRoomFeatureTokenActorData("puzzle", "room-42");
    expect(data.flags["pf2e-dungeon-crawl"]).toEqual({
      roomFeatureKind: "puzzle",
      roomFeatureRoomId: "room-42",
    });
  });

  it("builds a distinct actor per kind", () => {
    const puzzle = buildRoomFeatureTokenActorData("puzzle", "room-1");
    const challenge = buildRoomFeatureTokenActorData("skill_challenge", "room-1");
    expect(puzzle.name).not.toBe(challenge.name);
    expect(puzzle.img).not.toBe(challenge.img);
  });

  it("throws on an unknown kind", () => {
    expect(() => buildRoomFeatureTokenActorData("not-a-kind", "room-1")).toThrow(
      /not-a-kind/,
    );
  });
});

function makeState(overrides = {}) {
  return {
    completed: false,
    currentRoomId: "r1",
    history: [],
    rooms: { r1: { kind: "treasure" }, r2: { kind: "puzzle" } },
    ...overrides,
  };
}

describe("planRoomFeatureAction", () => {
  it("ok for the current, unresolved room of the matching kind", () => {
    const state = makeState();
    expect(planRoomFeatureAction({ state, kind: "treasure", roomId: "r1" })).toEqual({
      ok: true,
      room: state.rooms.r1,
    });
  });
  it("no-state", () => {
    expect(planRoomFeatureAction({ state: null, kind: "treasure", roomId: "r1" })).toEqual({ ok: false, reason: "no-state" });
  });
  it("unknown-kind", () => {
    expect(planRoomFeatureAction({ state: makeState(), kind: "nope", roomId: "r1" })).toEqual({ ok: false, reason: "unknown-kind" });
  });
  it("run-completed", () => {
    expect(planRoomFeatureAction({ state: makeState({ completed: true }), kind: "treasure", roomId: "r1" })).toEqual({ ok: false, reason: "run-completed" });
  });
  it("room-kind-mismatch for a missing room", () => {
    expect(planRoomFeatureAction({ state: makeState({ currentRoomId: "zz" }), kind: "treasure", roomId: "zz" })).toEqual({ ok: false, reason: "room-kind-mismatch" });
  });
  it("not-current-room", () => {
    expect(planRoomFeatureAction({ state: makeState(), kind: "puzzle", roomId: "r2" })).toEqual({ ok: false, reason: "not-current-room" });
  });
  it("room-kind-mismatch for a wrong kind", () => {
    expect(planRoomFeatureAction({ state: makeState(), kind: "puzzle", roomId: "r1" })).toEqual({ ok: false, reason: "room-kind-mismatch" });
  });
  it("already-resolved", () => {
    const state = makeState({ history: [{ roomId: "r1" }] });
    expect(planRoomFeatureAction({ state, kind: "treasure", roomId: "r1" })).toEqual({ ok: false, reason: "already-resolved" });
  });
});

function deps(state, extra = {}) {
  return {
    getRunState: vi.fn(() => state),
    claimTreasureFor: vi.fn(async () => {}),
    revealRoomFeature: vi.fn(async () => {}),
    inFlight: new Set(),
    ...extra,
  };
}

describe("runRoomFeatureAction", () => {
  const args = { sceneId: "s", roomId: "r1", kind: "treasure" };

  it.each([
    ["no-state", null, args],
    ["unknown-kind", makeState(), { ...args, kind: "nope" }],
    ["run-completed", makeState({ completed: true }), args],
    ["not-current-room", makeState(), { ...args, roomId: "r2", kind: "puzzle" }],
    ["room-kind-mismatch", makeState(), { ...args, kind: "puzzle" }],
    ["already-resolved", makeState({ history: [{ roomId: "r1" }] }), args],
  ])("%s: returns the reason and calls nothing", async (reason, state, a) => {
    const d = deps(state);
    expect(await runRoomFeatureAction(a, d)).toEqual({ ok: false, reason });
    expect(d.claimTreasureFor).not.toHaveBeenCalled();
    expect(d.revealRoomFeature).not.toHaveBeenCalled();
    expect(d.inFlight.size).toBe(0);
  });

  it("treasure claims once and never reveals", async () => {
    const d = deps(makeState());
    expect(await runRoomFeatureAction(args, d)).toEqual({ ok: true });
    expect(d.claimTreasureFor.mock.calls).toEqual([["s"]]);
    expect(d.revealRoomFeature).not.toHaveBeenCalled();
  });

  it.each(["puzzle", "skill_challenge"])("%s only reveals", async (kind) => {
    const state = makeState({ rooms: { r1: { kind } } });
    const d = deps(state);
    expect(await runRoomFeatureAction({ sceneId: "s", roomId: "r1", kind }, d)).toEqual({ ok: true });
    expect(d.revealRoomFeature.mock.calls).toEqual([["s", "r1", kind]]);
    expect(d.claimTreasureFor).not.toHaveBeenCalled();
  });

  it("two concurrent treasure calls claim exactly once", async () => {
    let release;
    const gate = new Promise((r) => (release = r));
    const d = deps(makeState(), { claimTreasureFor: vi.fn(() => gate) });
    const first = runRoomFeatureAction(args, d);
    const second = await runRoomFeatureAction(args, d);
    expect(second).toEqual({ ok: false, reason: "in-flight" });
    release();
    expect(await first).toEqual({ ok: true });
    expect(d.claimTreasureFor).toHaveBeenCalledTimes(1);
  });

  it("releases the lock after success", async () => {
    const d = deps(makeState());
    await runRoomFeatureAction(args, d);
    expect(d.inFlight.size).toBe(0);
    expect(await runRoomFeatureAction(args, d)).toEqual({ ok: true });
    expect(d.claimTreasureFor).toHaveBeenCalledTimes(2);
  });

  it("releases the lock after a throw and propagates it", async () => {
    const d = deps(makeState(), {
      claimTreasureFor: vi.fn().mockRejectedValueOnce(new Error("boom")),
    });
    await expect(runRoomFeatureAction(args, d)).rejects.toThrow("boom");
    expect(d.inFlight.size).toBe(0);
    expect(await runRoomFeatureAction(args, d)).toEqual({ ok: true });
  });
});

describe("routeTargetTokenEvent", () => {
  const base = () => ({
    userId: "u1",
    gameUserId: "u1",
    targeted: true,
    flags: { roomFeatureKind: "treasure", roomFeatureRoomId: "r1" },
    sceneId: "s",
    state: makeState(),
  });

  it("null when un-targeting", () => {
    expect(routeTargetTokenEvent({ ...base(), targeted: false })).toBeNull();
  });
  it("null for another user's event", () => {
    expect(routeTargetTokenEvent({ ...base(), userId: "u2" })).toBeNull();
  });
  it("null with no flags", () => {
    expect(routeTargetTokenEvent({ ...base(), flags: undefined })).toBeNull();
  });
  it("null with no roomFeatureKind flag", () => {
    expect(routeTargetTokenEvent({ ...base(), flags: {} })).toBeNull();
  });
  it("null with no sceneId", () => {
    expect(routeTargetTokenEvent({ ...base(), sceneId: null })).toBeNull();
  });
  it("null with no state", () => {
    expect(routeTargetTokenEvent({ ...base(), state: null })).toBeNull();
  });
  it("null for a stale room", () => {
    expect(routeTargetTokenEvent({ ...base(), state: makeState({ currentRoomId: "r2" }) })).toBeNull();
  });
  it("null for an already-resolved room", () => {
    expect(routeTargetTokenEvent({ ...base(), state: makeState({ history: [{ roomId: "r1" }] }) })).toBeNull();
  });
  it("null for a completed run", () => {
    expect(routeTargetTokenEvent({ ...base(), state: makeState({ completed: true }) })).toBeNull();
  });
  it.each(["treasure", "puzzle", "skill_challenge"])("routes a %s token", (kind) => {
    const b = base();
    b.flags = { roomFeatureKind: kind, roomFeatureRoomId: "r1" };
    b.state = makeState({ rooms: { r1: { kind } } });
    expect(routeTargetTokenEvent(b)).toEqual({ sceneId: "s", roomId: "r1", kind });
  });
});
