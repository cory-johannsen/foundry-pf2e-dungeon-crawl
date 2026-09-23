import { describe, it, expect, vi, afterEach } from "vitest";
import {
  followLeaderOnDoorOpened,
  followLeaderIfDue,
  runFollowMoveNow,
} from "../scripts/dungeon-follow.mjs";
import { requestDungeonAction } from "../scripts/dungeon-remote.mjs";

// Wholesale-mocked (not just requestDungeonAction picked out): dungeon-
// remote.mjs's own real module pulls in dungeon-app.mjs's entire dependency
// tree, which this file has no business loading just to assert a socket
// request was requested. This also sidesteps the real two-way import
// dungeon-follow.mjs/dungeon-remote.mjs now have (#65: follow needs
// requestDungeonAction, remote needs runFollowMoveNow) ever needing to
// resolve in this test file at all.
vi.mock("../scripts/dungeon-remote.mjs", () => ({
  requestDungeonAction: vi.fn(),
}));

const GRID = 100;
const HOST_USER_ID = "host1";
const OTHER_USER_ID = "player2";
const LEADER_ACTOR_ID = "leader-actor";
const FOLLOWER_ACTOR_ID = "follower-actor";
const SCENE_ID = "scene1";

function installFoundryStubs({
  dungeonRuns = {},
  isGM = true,
  userId = null,
} = {}) {
  globalThis.CONST = {
    WALL_MOVEMENT_TYPES: { NONE: 0, NORMAL: 20 },
    WALL_DOOR_TYPES: { NONE: 0, DOOR: 1, SECRET: 2 },
    WALL_DOOR_STATES: { CLOSED: 0, OPEN: 1, LOCKED: 2 },
  };
  globalThis.game = {
    user: { isGM, id: userId },
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
    scenes: { get: () => undefined },
    combats: [],
    settings: {
      get: (_moduleId, key) => (key === "dungeonRuns" ? dungeonRuns : {}),
    },
  };
}

function makeToken({ id, x, y, actorId, width = 1, height = 1 }) {
  const token = { id, x, y, actor: { id: actorId }, width, height };
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
  for (const t of tokens) t.parent = scene;
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
    requestDungeonAction.mockClear();
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

  it("does nothing when the current client is neither GM nor the run's host", async () => {
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
      userId: OTHER_USER_ID,
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
    expect(requestDungeonAction).not.toHaveBeenCalled();
  });

  it("requests a follow-move via the relay when the current client is the non-GM host (#65)", async () => {
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
      userId: HOST_USER_ID,
      dungeonRuns: {
        [SCENE_ID]: {
          hostUserId: HOST_USER_ID,
          aiControlledActorIds: [FOLLOWER_ACTOR_ID],
        },
      },
    });

    followLeaderOnDoorOpened(door, { ds: CONST.WALL_DOOR_STATES.OPEN });
    await vi.advanceTimersByTimeAsync(300);

    // The actual move happens on whichever client receives and executes
    // the relayed request, not this one -- this client only ever asks.
    expect(follower.update).not.toHaveBeenCalled();
    expect(requestDungeonAction).toHaveBeenCalledTimes(1);
    expect(requestDungeonAction).toHaveBeenCalledWith("followMove", {
      sceneId: SCENE_ID,
    });
  });
});

describe("followLeaderIfDue (#65)", () => {
  afterEach(() => {
    vi.useRealTimers();
    requestDungeonAction.mockClear();
  });

  function setUpScene() {
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
    const scene = makeScene({ tokens: [leader, follower] });
    return { leader, follower, scene };
  }

  it("moves followers toward the leader when its own token moves, on a GM client", async () => {
    vi.useFakeTimers();
    const { leader, follower } = setUpScene();
    installFoundryStubs({
      dungeonRuns: {
        [SCENE_ID]: {
          hostUserId: HOST_USER_ID,
          aiControlledActorIds: [FOLLOWER_ACTOR_ID],
        },
      },
    });

    followLeaderIfDue(leader, { x: leader.x, y: leader.y });
    await vi.advanceTimersByTimeAsync(300);

    expect(follower.update).toHaveBeenCalledTimes(1);
  });

  it("does nothing when the moved token isn't the leader's own", async () => {
    vi.useFakeTimers();
    const { follower } = setUpScene();
    installFoundryStubs({
      dungeonRuns: {
        [SCENE_ID]: {
          hostUserId: HOST_USER_ID,
          aiControlledActorIds: [FOLLOWER_ACTOR_ID],
        },
      },
    });

    followLeaderIfDue(follower, { x: follower.x, y: follower.y });
    await vi.advanceTimersByTimeAsync(300);

    expect(follower.update).not.toHaveBeenCalled();
    expect(requestDungeonAction).not.toHaveBeenCalled();
  });

  it("does nothing when neither x nor y changed", async () => {
    vi.useFakeTimers();
    const { leader, follower } = setUpScene();
    installFoundryStubs({
      dungeonRuns: {
        [SCENE_ID]: {
          hostUserId: HOST_USER_ID,
          aiControlledActorIds: [FOLLOWER_ACTOR_ID],
        },
      },
    });

    followLeaderIfDue(leader, { elevation: 0 });
    await vi.advanceTimersByTimeAsync(300);

    expect(follower.update).not.toHaveBeenCalled();
  });

  // #87 (reopened after #100): Foundry v14's newer ruler/pathfinding-driven
  // movement pipeline can deliver a real position change to the updateToken
  // hook with the new position only reflected in a `_movement` object
  // (`origin`/`destination`/`waypoints`/`method` -- confirmed live on a
  // v14.368 world: a moved token's own `_movement.method` was `"keyboard"`
  // with full waypoint data), not as top-level `changes.x`/`changes.y`. Pre-
  // fix, the `changes.x === undefined && changes.y === undefined` guard
  // bailed out on every such call, so AI-controlled followers never moved
  // at all under v14 even with #100's findFollowMove fix deployed and the
  // door open -- exactly the symptom reported live after #100 merged.
  it("moves followers toward the leader on a v14-style update carrying only _movement, no top-level x/y (#87)", async () => {
    vi.useFakeTimers();
    const { leader, follower } = setUpScene();
    installFoundryStubs({
      dungeonRuns: {
        [SCENE_ID]: {
          hostUserId: HOST_USER_ID,
          aiControlledActorIds: [FOLLOWER_ACTOR_ID],
        },
      },
    });

    followLeaderIfDue(leader, {
      _movement: {
        origin: { x: 4 * GRID, y: GRID },
        destination: { x: leader.x, y: leader.y },
        waypoints: [{ x: leader.x, y: leader.y }],
        method: "keyboard",
      },
    });
    await vi.advanceTimersByTimeAsync(300);

    expect(follower.update).toHaveBeenCalledTimes(1);
  });

  it("does nothing when the current client is neither GM nor the run's host", async () => {
    vi.useFakeTimers();
    const { leader, follower } = setUpScene();
    installFoundryStubs({
      isGM: false,
      userId: OTHER_USER_ID,
      dungeonRuns: {
        [SCENE_ID]: {
          hostUserId: HOST_USER_ID,
          aiControlledActorIds: [FOLLOWER_ACTOR_ID],
        },
      },
    });

    followLeaderIfDue(leader, { x: leader.x, y: leader.y });
    await vi.advanceTimersByTimeAsync(300);

    expect(follower.update).not.toHaveBeenCalled();
    expect(requestDungeonAction).not.toHaveBeenCalled();
  });

  it("requests a follow-move via the relay when the current client is the non-GM host (#65)", async () => {
    vi.useFakeTimers();
    const { leader, follower } = setUpScene();
    installFoundryStubs({
      isGM: false,
      userId: HOST_USER_ID,
      dungeonRuns: {
        [SCENE_ID]: {
          hostUserId: HOST_USER_ID,
          aiControlledActorIds: [FOLLOWER_ACTOR_ID],
        },
      },
    });

    followLeaderIfDue(leader, { x: leader.x, y: leader.y });
    await vi.advanceTimersByTimeAsync(300);

    expect(follower.update).not.toHaveBeenCalled();
    expect(requestDungeonAction).toHaveBeenCalledTimes(1);
    expect(requestDungeonAction).toHaveBeenCalledWith("followMove", {
      sceneId: SCENE_ID,
    });
  });
});

describe("runFollowMoveNow (#65)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("resolves the scene/run/leader from sceneId alone and moves followers", async () => {
    vi.useFakeTimers();
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
    const scene = makeScene({ tokens: [leader, follower] });

    installFoundryStubs({
      dungeonRuns: {
        [SCENE_ID]: {
          hostUserId: HOST_USER_ID,
          aiControlledActorIds: [FOLLOWER_ACTOR_ID],
        },
      },
    });
    game.scenes = { get: (id) => (id === SCENE_ID ? scene : undefined) };

    runFollowMoveNow(SCENE_ID);
    await vi.advanceTimersByTimeAsync(300);

    expect(follower.update).toHaveBeenCalledTimes(1);
  });

  it("is a no-op for a scene with no matching run", async () => {
    vi.useFakeTimers();
    const scene = makeScene({ tokens: [] });
    installFoundryStubs({ dungeonRuns: {} });
    game.scenes = { get: (id) => (id === SCENE_ID ? scene : undefined) };

    expect(() => runFollowMoveNow(SCENE_ID)).not.toThrow();
    await vi.advanceTimersByTimeAsync(300);
  });

  // #87: a follower stuck at the previous room's far side of a single-row
  // doorway/hallway used to report "no route" and stay put even though a
  // path existed, because findFollowMove only ever tried the one adjacent
  // cell closest to it by raw distance -- and at a doorway, that closest
  // cell is very often a walled-off pocket right next to the door rather
  // than the door tile itself. Real wall geometry (not the pure
  // dungeon-follow-mechanics.mjs unit test's synthetic isBlocked) walls in
  // gx6,gy1 -- the cell tied for closest to the follower among the 8 cells
  // adjacent to the leader -- on all four sides, while gx5,gy2 (through the
  // one-row-high door) is wide open.
  it("routes a follower through the door tile when the nearest adjacent cell to the leader is a walled-off pocket (#87)", async () => {
    vi.useFakeTimers();
    const leader = makeToken({
      id: "t-leader",
      x: 7 * GRID,
      y: 2 * GRID,
      actorId: LEADER_ACTOR_ID,
    });
    const follower = makeToken({
      id: "t-follower",
      x: 0,
      y: 2 * GRID,
      actorId: FOLLOWER_ACTOR_ID,
    });
    const doorRow = 2;
    // Vertical wall segments along the column-5 boundary blocking every row
    // except the door row (which has no wall segment at all -- a plain
    // opening -- so isBlocked never flags that boundary/row pair).
    const doorGapWalls = [0, 1, 3, 4].map((row, i) => ({
      id: `door-block-${i}`,
      c: [5 * GRID, row * GRID, 5 * GRID, (row + 1) * GRID],
      move: 20,
      door: 0,
    }));
    // Seal gx6,gy1 -- tied-closest pocket to the follower among the 8 cells
    // adjacent to the leader -- on all four sides.
    const pocketWalls = [
      {
        id: "pocket-n",
        c: [6 * GRID, 1 * GRID, 7 * GRID, 1 * GRID],
        move: 20,
        door: 0,
      },
      {
        id: "pocket-s",
        c: [6 * GRID, 2 * GRID, 7 * GRID, 2 * GRID],
        move: 20,
        door: 0,
      },
      {
        id: "pocket-w",
        c: [6 * GRID, 1 * GRID, 6 * GRID, 2 * GRID],
        move: 20,
        door: 0,
      },
      {
        id: "pocket-e",
        c: [7 * GRID, 1 * GRID, 7 * GRID, 2 * GRID],
        move: 20,
        door: 0,
      },
    ];
    const walls = [...doorGapWalls, ...pocketWalls];
    const scene = {
      id: SCENE_ID,
      grid: { size: GRID },
      width: 9 * GRID,
      height: 5 * GRID,
      walls: { contents: walls },
      tokens: [leader, follower],
    };
    for (const w of walls) w.parent = scene;
    for (const t of [leader, follower]) t.parent = scene;

    installFoundryStubs({
      dungeonRuns: {
        [SCENE_ID]: {
          hostUserId: HOST_USER_ID,
          aiControlledActorIds: [FOLLOWER_ACTOR_ID],
        },
      },
    });
    game.scenes = { get: (id) => (id === SCENE_ID ? scene : undefined) };

    runFollowMoveNow(SCENE_ID);
    await vi.advanceTimersByTimeAsync(300);

    expect(follower.update).toHaveBeenCalledTimes(1);
    const [{ x, y }] = follower.update.mock.calls[0];
    expect({ gx: x / GRID, gy: y / GRID }).not.toEqual({ gx: 6, gy: 1 });
  });

  // #86: a follower's own token can end up off-grid for reasons entirely
  // outside this module's own movement math (e.g. a manual, unsnapped drag
  // in Foundry's own UI). findFollowMove's "already-near" status -- the
  // follower is already within one square of the leader -- used to leave
  // that stale position completely untouched, since it never reaches the
  // `token.update()` call at all.
  it("snaps an already-near follower to its nearest grid cell even though it doesn't need to move (#86)", async () => {
    vi.useFakeTimers();
    const leader = makeToken({
      id: "t-leader",
      x: 5 * GRID,
      y: GRID,
      actorId: LEADER_ACTOR_ID,
    });
    // Straddling four grid squares: a half-cell offset in both axes, one
    // square away (Chebyshev) from the leader -- findFollowMove's own
    // "already-near" branch.
    const follower = makeToken({
      id: "t-follower",
      x: 5.5 * GRID,
      y: 1.5 * GRID,
      actorId: FOLLOWER_ACTOR_ID,
    });
    const scene = makeScene({ tokens: [leader, follower] });

    installFoundryStubs({
      dungeonRuns: {
        [SCENE_ID]: {
          hostUserId: HOST_USER_ID,
          aiControlledActorIds: [FOLLOWER_ACTOR_ID],
        },
      },
    });
    game.scenes = { get: (id) => (id === SCENE_ID ? scene : undefined) };

    runFollowMoveNow(SCENE_ID);
    await vi.advanceTimersByTimeAsync(300);

    expect(follower.update).toHaveBeenCalledTimes(1);
    expect(follower.x % GRID).toBe(0);
    expect(follower.y % GRID).toBe(0);
  });
});

describe("moveFollowersToward footprint-awareness (#140)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  // A 2x2 follower's own footprint, anchored at (4,0) or (4,1) — the two
  // candidate cells among the leader's 8 adjacent cells that are closest
  // to a follower starting at (0,0) — would each overlap the leader's own
  // (5,1) square (a 1x1 footprint anchored at the same cells would not).
  // Only (4,2), one step farther, is genuinely free for a mover that size.
  it("a 2x2 follower avoids landing on a cell whose own footprint would overlap the leader's square", async () => {
    vi.useFakeTimers();
    const leader = makeToken({
      id: "t-leader",
      x: 5 * GRID,
      y: 1 * GRID,
      actorId: LEADER_ACTOR_ID,
    });
    const follower = makeToken({
      id: "t-follower",
      x: 0,
      y: 0,
      actorId: FOLLOWER_ACTOR_ID,
      width: 2,
      height: 2,
    });
    const scene = makeScene({ tokens: [leader, follower] });

    installFoundryStubs({
      dungeonRuns: {
        [SCENE_ID]: {
          hostUserId: HOST_USER_ID,
          aiControlledActorIds: [FOLLOWER_ACTOR_ID],
        },
      },
    });
    game.scenes = { get: (id) => (id === SCENE_ID ? scene : undefined) };

    runFollowMoveNow(SCENE_ID);
    await vi.advanceTimersByTimeAsync(300);

    expect(follower.update).toHaveBeenCalledTimes(1);
    const [{ x, y }] = follower.update.mock.calls[0];
    const gx = x / GRID;
    const gy = y / GRID;
    const overlapsLeader = gx <= 5 && gx + 2 > 5 && gy <= 1 && gy + 2 > 1;
    expect(overlapsLeader).toBe(false);
  });
});
