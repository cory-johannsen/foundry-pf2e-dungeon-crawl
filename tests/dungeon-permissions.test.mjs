// tests/dungeon-permissions.test.mjs
import { describe, it, expect } from "vitest";
import {
  canActOnDungeon,
  decideOpenDungeon,
  decideGmLessBroadcast,
  isAuthorizedRequest,
} from "../scripts/dungeon-permissions.mjs";

const gm = { id: "gm-1", isGM: true };
const player = { id: "player-1", isGM: false };
const otherPlayer = { id: "player-2", isGM: false };

describe("canActOnDungeon", () => {
  it("always allows a GM, regardless of run state", () => {
    expect(canActOnDungeon(null, { userRef: gm })).toBe(true);
    expect(
      canActOnDungeon({ hostUserId: "someone-else" }, { userRef: gm }),
    ).toBe(true);
  });

  it("allows the run's own host", () => {
    const run = { hostUserId: player.id };
    expect(canActOnDungeon(run, { userRef: player })).toBe(true);
  });

  it("denies a non-host, non-GM player", () => {
    const run = { hostUserId: player.id };
    expect(canActOnDungeon(run, { userRef: otherPlayer })).toBe(false);
  });

  it("denies a non-GM when there is no run at all (normal GM-run game path)", () => {
    expect(canActOnDungeon(null, { userRef: player })).toBe(false);
    expect(canActOnDungeon({ hostUserId: null }, { userRef: player })).toBe(
      false,
    );
  });
});

describe("decideOpenDungeon", () => {
  it("always renders for a GM", () => {
    expect(decideOpenDungeon(null, { userRef: gm })).toEqual({
      action: "render",
    });
  });

  it("renders for a non-GM starting fresh with no hosted run", () => {
    expect(decideOpenDungeon(null, { userRef: player })).toEqual({
      action: "render",
    });
  });

  it("renders for a non-GM reopening their own hosted run", () => {
    const hosted = { sceneId: "scene-1", hostUserId: player.id };
    expect(decideOpenDungeon(hosted, { userRef: player })).toEqual({
      action: "render",
    });
  });

  it("warns already-hosted for a different non-GM while someone else's run is active", () => {
    const hosted = { sceneId: "scene-1", hostUserId: player.id };
    expect(decideOpenDungeon(hosted, { userRef: otherPlayer })).toEqual({
      action: "warnAlreadyHosted",
      hostUserId: player.id,
    });
  });
});

describe("decideGmLessBroadcast", () => {
  it("never acts for a GM client", () => {
    const hosted = { sceneId: "scene-1", hostUserId: player.id };
    expect(decideGmLessBroadcast(hosted, false, { userRef: gm })).toEqual({
      action: "none",
    });
  });

  it("opens a fresh instance for the host's own client with none open yet", () => {
    const hosted = { sceneId: "scene-1", hostUserId: player.id };
    expect(
      decideGmLessBroadcast(hosted, false, { userRef: player }),
    ).toEqual({ action: "open" });
  });

  it("re-renders the host's own already-open instance (catches up after a routed request)", () => {
    const hosted = { sceneId: "scene-1", hostUserId: player.id };
    expect(decideGmLessBroadcast(hosted, true, { userRef: player })).toEqual({
      action: "render",
    });
  });

  it("opens a fresh read-only instance for another player with none open yet", () => {
    const hosted = { sceneId: "scene-1", hostUserId: player.id };
    expect(
      decideGmLessBroadcast(hosted, false, { userRef: otherPlayer }),
    ).toEqual({ action: "open" });
  });

  it("re-renders an already-open read-only instance", () => {
    const hosted = { sceneId: "scene-1", hostUserId: player.id };
    expect(
      decideGmLessBroadcast(hosted, true, { userRef: otherPlayer }),
    ).toEqual({ action: "render" });
  });

  it("closes an open instance once no run is hosted any more", () => {
    expect(
      decideGmLessBroadcast(null, true, { userRef: otherPlayer }),
    ).toEqual({ action: "close" });
  });

  it("does nothing when there's no hosted run and nothing open", () => {
    expect(
      decideGmLessBroadcast(null, false, { userRef: otherPlayer }),
    ).toEqual({ action: "none" });
  });
});

describe("isAuthorizedRequest", () => {
  it("authorizes starting a run when nothing else is hosted", () => {
    expect(isAuthorizedRequest("startRun", player.id, null)).toBe(true);
  });

  it("authorizes starting a run that is this same requester's own (retry/reopen)", () => {
    const hosted = { sceneId: "scene-1", hostUserId: player.id };
    expect(isAuthorizedRequest("startRun", player.id, hosted)).toBe(true);
  });

  it("denies starting a run when a different host is already active", () => {
    const hosted = { sceneId: "scene-1", hostUserId: player.id };
    expect(isAuthorizedRequest("startRun", otherPlayer.id, hosted)).toBe(
      false,
    );
  });

  it("authorizes any other action from the run's own tracked host", () => {
    const run = { hostUserId: player.id };
    expect(isAuthorizedRequest("resolveRoom", player.id, run)).toBe(true);
  });

  it("denies any other action from a non-host requester", () => {
    const run = { hostUserId: player.id };
    expect(isAuthorizedRequest("resolveRoom", otherPlayer.id, run)).toBe(
      false,
    );
  });

  it("denies any other action when there is no run at all", () => {
    expect(isAuthorizedRequest("resolveRoom", player.id, null)).toBe(false);
  });

  it("denies a forged null requester against a normal GM-run game's run (hostUserId: null) — the exact bypass being closed", () => {
    const normalRun = { sceneId: "scene-1", hostUserId: null };
    expect(isAuthorizedRequest("resolveRoom", null, normalRun)).toBe(false);
  });

  it("denies a real requester against a normal GM-run game's run (hostUserId: null)", () => {
    const normalRun = { sceneId: "scene-1", hostUserId: null };
    expect(isAuthorizedRequest("resolveRoom", player.id, normalRun)).toBe(
      false,
    );
  });

  it("denies startRun with a falsy requestingUserId, regardless of run", () => {
    expect(isAuthorizedRequest("startRun", null, null)).toBe(false);
    expect(isAuthorizedRequest("startRun", undefined, null)).toBe(false);
    const hosted = { sceneId: "scene-1", hostUserId: player.id };
    expect(isAuthorizedRequest("startRun", null, hosted)).toBe(false);
  });
});
