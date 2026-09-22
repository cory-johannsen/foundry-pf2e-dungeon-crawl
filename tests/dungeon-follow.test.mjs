import { describe, it, expect, vi, afterEach } from "vitest";
import { followLeaderOnDoorOpened } from "../scripts/dungeon-follow.mjs";

const GRID = 100;
const HOST_USER_ID = "host1";
const LEADER_ACTOR_ID = "leader-actor";
const FOLLOWER_ACTOR_ID = "follower-actor";
const SCENE_ID = "scene1";

function installFoundryStubs({ dungeonRuns = {}, isGM = true } = {}) {
  globalThis.CONST = {
    WALL_MOVEMENT_TYPES: { NONE: 0, NORMAL: 20 },
    WALL_DOOR_TYPES: { NONE: 0, DOOR: 1, SECRET: 2 },
    WALL_DOOR_STATES: { CLOSED: 0, OPEN: 1, LOCKED: 2 },
  };
  globalThis.game = {
    user: { isGM },
    actors: {
      party: {
        members: [
          {
            id: LEADER_ACTOR_ID,
            ownership: { [HOST_USER_ID]: 3 },
          },
        ],
      },
    },
    combats: [],
    settings: {
      get: (_moduleId, key) => (key === "dungeonRuns" ? dungeonRuns : {}),
    },
  };
}

function makeToken({ id, x, y, actorId }) {
  const token = { id, x, y, actor: { id: actorId } };
  token.update = vi.fn(async (changes) => Object.assign(token, changes));
  return token;
}

// 7 columns (gx 0-6) x 3 rows (gy 0-2) — small enough that a door spanning
// the full height leaves no way around it within the scene's own bounds.
function makeScene({ id = SCENE_ID, walls = [], tokens = [] } = {}) {
  const scene = {
    id,
    grid: { size: GRID },
    width: 7 * GRID,
    height: 3 * GRID,
    walls: { contents: walls },
    tokens,
  };
  for (const w of walls) w.parent = scene;
  return scene;
}

/** A door wall spanning the full column-3 boundary (every row in the
 * scene) — the sole route between a follower at gx=0 and a leader at
 * gx=5 (both gy=1), and unavoidable regardless of which row a path takes. */
function makeDoorWall({ ds }) {
  return {
    id: "door1",
    c: [3 * GRID, 0, 3 * GRID, 3 * GRID],
    move: 20,
    door: 1,
    ds,
  };
}

describe("followLeaderOnDoorOpened (#39)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("retries a stranded follower once the blocking door opens", async () => {
    vi.useFakeTimers();
    const door = makeDoorWall({ ds: 1 }); // already OPEN, as Foundry applies
    // the document update before firing the hook
    const leader = makeToken({
      id: "t-leader",
      x: 5 * GRID,
      y: GRID,
      actorId: LEADER_ACTOR_ID,
    });
    const follower = makeToken({
      id: "t-follower",
      x: 0,
      y: GRID,
      actorId: FOLLOWER_ACTOR_ID,
    });
    const scene = makeScene({ walls: [door], tokens: [leader, follower] });

    installFoundryStubs({
      dungeonRuns: {
        [SCENE_ID]: {
          hostUserId: HOST_USER_ID,
          aiControlledActorIds: [FOLLOWER_ACTOR_ID],
        },
      },
    });

    followLeaderOnDoorOpened(door, { ds: CONST.WALL_DOOR_STATES.OPEN });
    await vi.advanceTimersByTimeAsync(300);

    expect(follower.update).toHaveBeenCalledTimes(1);
    const [{ x, y }] = follower.update.mock.calls[0];
    const followerGx = x / GRID;
    const followerGy = y / GRID;
    const chebyshev = Math.max(
      Math.abs(followerGx - 5),
      Math.abs(followerGy - 1),
    );
    expect(chebyshev).toBe(1);
  });

  it("does nothing when the wall change isn't a door opening", async () => {
    vi.useFakeTimers();
    const door = makeDoorWall({ ds: 0 });
    const leader = makeToken({
      id: "t-leader",
      x: 5 * GRID,
      y: GRID,
      actorId: LEADER_ACTOR_ID,
    });
    const follower = makeToken({
      id: "t-follower",
      x: 0,
      y: GRID,
      actorId: FOLLOWER_ACTOR_ID,
    });
    makeScene({ walls: [door], tokens: [leader, follower] });

    installFoundryStubs({
      dungeonRuns: {
        [SCENE_ID]: {
          hostUserId: HOST_USER_ID,
          aiControlledActorIds: [FOLLOWER_ACTOR_ID],
        },
      },
    });

    followLeaderOnDoorOpened(door, { ds: CONST.WALL_DOOR_STATES.CLOSED });
    await vi.advanceTimersByTimeAsync(300);

    expect(follower.update).not.toHaveBeenCalled();
  });

  it("does nothing when the current client isn't the GM", async () => {
    vi.useFakeTimers();
    const door = makeDoorWall({ ds: 1 });
    const leader = makeToken({
      id: "t-leader",
      x: 5 * GRID,
      y: GRID,
      actorId: LEADER_ACTOR_ID,
    });
    const follower = makeToken({
      id: "t-follower",
      x: 0,
      y: GRID,
      actorId: FOLLOWER_ACTOR_ID,
    });
    makeScene({ walls: [door], tokens: [leader, follower] });

    installFoundryStubs({
      isGM: false,
      dungeonRuns: {
        [SCENE_ID]: {
          hostUserId: HOST_USER_ID,
          aiControlledActorIds: [FOLLOWER_ACTOR_ID],
        },
      },
    });

    followLeaderOnDoorOpened(door, { ds: CONST.WALL_DOOR_STATES.OPEN });
    await vi.advanceTimersByTimeAsync(300);

    expect(follower.update).not.toHaveBeenCalled();
  });
});
