import { describe, it, expect, vi, afterEach } from "vitest";
import {
  followLeaderOnDoorOpened,
  followLeaderIfDue,
  runFollowMoveNow,
  resnapDriftedTokens,
  resnapTokenNow,
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

function makeToken({
  id,
  x,
  y,
  actorId,
  width = 1,
  height = 1,
  animationContexts = new Map(),
}) {
  const token = {
    id,
    x,
    y,
    actor: { id: actorId },
    width,
    height,
    object: { animationContexts },
  };
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

  it("does not treat the follower's own body as an obstacle to itself", async () => {
    vi.useFakeTimers();
    const leader = makeToken({
      id: "t-leader",
      x: 5 * GRID,
      y: 5 * GRID,
      actorId: LEADER_ACTOR_ID,
    });
    const follower = makeToken({
      id: "t-follower",
      x: 6 * GRID,
      y: 7 * GRID,
      actorId: FOLLOWER_ACTOR_ID,
      width: 2,
      height: 2,
    });
    const scene = makeScene({ tokens: [leader, follower] });
    // The default scene (7x3 grid cells) is too small for this test's
    // coordinates (follower starts at gy=7) -- widen it so the follower
    // has genuine room to path in every direction.
    scene.width = 12 * GRID;
    scene.height = 12 * GRID;

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
    // Verified independently by running findFollowMove directly: with
    // the follower's own footprint wrongly counted as an obstacle to
    // itself, the result is {gx:4,gy:6} -- one square worse (farther
    // from the follower's own start) than the correct {gx:5,gy:6}.
    expect({ gx: x / GRID, gy: y / GRID }).toEqual({ gx: 5, gy: 6 });
  });
});

describe("moveFollowersToward chain-following (#181)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  // The actual live-reproduced bug this fixes: in a 1-wide corridor, every
  // follower searching for a cell "near the leader" can only ever find one
  // reachable candidate (whoever's already closest occupies the only
  // passage cell) — the rest jitter in place forever. Chain-following
  // fixes this by having each follower target whoever is immediately
  // ahead of it in marching order instead of the leader directly, so they
  // naturally queue up single-file.
  it("queues followers single-file through a 1-wide corridor, in marching order", async () => {
    vi.useFakeTimers();
    const leader = makeToken({
      id: "t-leader",
      x: 0,
      y: 10 * GRID,
      actorId: LEADER_ACTOR_ID,
    });
    const followerA = makeToken({ id: "t-a", x: 0, y: 0, actorId: "actor-a" });
    const followerB = makeToken({ id: "t-b", x: 0, y: 0, actorId: "actor-b" });
    const followerC = makeToken({ id: "t-c", x: 0, y: 0, actorId: "actor-c" });
    const scene = makeScene({ tokens: [leader, followerA, followerB, followerC] });
    // Force single-file movement: block every edge that isn't strictly
    // along column gx=0. The default scene (7x3 grid cells) is also too
    // short for this test's coordinates (leader at gy=10) -- widen it so
    // the whole column is in bounds.
    scene.height = 11 * GRID;
    // Two long parallel walls flanking column gx=0 (boundary columns 0 and
    // 1, per blockedEdgesFromWalls' `boundary = max(a.gx, b.gx)` -- the
    // wall's own pixel x must be an exact grid-column multiple, not a
    // half-grid offset, or blockedEdgesFromWalls silently ignores it via
    // its `Number.isInteger(col)` guard), spanning the whole way from
    // gy=-1 to gy=11 so every row transition down the corridor is blocked.
    scene.walls.contents = [
      { move: 20, door: 0, c: [0, -GRID, 0, 11 * GRID] },
      { move: 20, door: 0, c: [GRID, -GRID, GRID, 11 * GRID] },
    ];
    globalThis.CONST = {
      WALL_MOVEMENT_TYPES: { NONE: 0, NORMAL: 20 },
      WALL_DOOR_TYPES: { NONE: 0, DOOR: 1, SECRET: 2 },
      WALL_DOOR_STATES: { CLOSED: 0, OPEN: 1, LOCKED: 2 },
    };

    installFoundryStubs({
      dungeonRuns: {
        [SCENE_ID]: {
          hostUserId: HOST_USER_ID,
          aiControlledActorIds: ["actor-a", "actor-b", "actor-c"],
          marchingOrder: ["actor-a", "actor-b", "actor-c"],
        },
      },
    });
    game.scenes = { get: (id) => (id === SCENE_ID ? scene : undefined) };

    // Several follow-cycles, mirroring a real leader advancing repeatedly.
    // Marching order is checked after EVERY cycle, not just the final one:
    // pre-fix, every follower independently retargets the leader's own tiny
    // (single-cell) neighborhood each cycle, which doesn't just stall B and
    // C -- it makes their relative order genuinely OSCILLATE cycle to cycle
    // (live-confirmed while writing this test: pre-fix this exact scenario
    // produces a stable 3-cycle-period swap between B and C, landing on the
    // WRONG order roughly a third of the time), so asserting only the final
    // cycle's snapshot could pass or fail depending on how many cycles
    // happen to run. Checking every cycle catches the very first violation
    // regardless of cycle count.
    for (let i = 0; i < 6; i += 1) {
      runFollowMoveNow(SCENE_ID);
      await vi.advanceTimersByTimeAsync(300);
      expect(followerA.y).toBeGreaterThanOrEqual(followerB.y);
      expect(followerB.y).toBeGreaterThanOrEqual(followerC.y);
    }

    // All three made real progress toward the leader (not stuck at y=0).
    expect(followerA.y).toBeGreaterThan(0);
    expect(followerB.y).toBeGreaterThan(0);
    expect(followerC.y).toBeGreaterThan(0);
  });

  // Review Focus: zero AI-controlled followers must not crash.
  it("does nothing when there are no AI-controlled followers", async () => {
    vi.useFakeTimers();
    const leader = makeToken({ id: "t-leader", x: 0, y: 0, actorId: LEADER_ACTOR_ID });
    const scene = makeScene({ tokens: [leader] });
    installFoundryStubs({
      dungeonRuns: {
        [SCENE_ID]: { hostUserId: HOST_USER_ID, aiControlledActorIds: [], marchingOrder: [] },
      },
    });
    game.scenes = { get: (id) => (id === SCENE_ID ? scene : undefined) };

    expect(() => runFollowMoveNow(SCENE_ID)).not.toThrow();
    await vi.advanceTimersByTimeAsync(300);
  });
});

describe("resnapTokenNow (#141)", () => {
  it("snaps an off-grid token back to the nearest grid cell", async () => {
    const token = makeToken({
      id: "t-drifted",
      x: 5.49 * GRID,
      y: 3.49 * GRID,
      actorId: "some-actor",
    });
    const scene = makeScene({ tokens: [token] });
    installFoundryStubs();
    game.scenes = { get: (id) => (id === SCENE_ID ? scene : undefined) };

    await resnapTokenNow(SCENE_ID, "t-drifted");

    expect(token.update).toHaveBeenCalledTimes(1);
    expect(token.update).toHaveBeenCalledWith({ x: 5 * GRID, y: 3 * GRID });
  });

  it("does not call update on a token that's already grid-aligned", () => {
    const token = makeToken({
      id: "t-aligned",
      x: 5 * GRID,
      y: 3 * GRID,
      actorId: "some-actor",
    });
    const scene = makeScene({ tokens: [token] });
    installFoundryStubs();
    game.scenes = { get: (id) => (id === SCENE_ID ? scene : undefined) };

    resnapTokenNow(SCENE_ID, "t-aligned");

    expect(token.update).not.toHaveBeenCalled();
  });

  it("is a no-op when the scene or token can't be found", () => {
    installFoundryStubs();
    game.scenes = { get: () => undefined };

    expect(() => resnapTokenNow(SCENE_ID, "nonexistent")).not.toThrow();
  });

  it("defers correcting a token while it's still mid-animation, then corrects once settled (#87)", async () => {
    vi.useFakeTimers();
    const animationContexts = new Map([["move", {}]]);
    const token = makeToken({
      id: "t-animating",
      x: 5.49 * GRID,
      y: 3.49 * GRID,
      actorId: "some-actor",
      animationContexts,
    });
    const scene = makeScene({ tokens: [token] });
    installFoundryStubs();
    game.scenes = { get: (id) => (id === SCENE_ID ? scene : undefined) };

    const promise = resnapTokenNow(SCENE_ID, "t-animating");

    // Still animating -- no correction yet, even though the position is
    // currently off-grid (exactly the #87 race: a mid-flight fractional
    // position must never be judged as "drifted").
    expect(token.update).not.toHaveBeenCalled();

    // The animation genuinely finishes.
    animationContexts.clear();
    await vi.advanceTimersByTimeAsync(100);
    await promise;

    expect(token.update).toHaveBeenCalledTimes(1);
    expect(token.update).toHaveBeenCalledWith({ x: 5 * GRID, y: 3 * GRID });
    vi.useRealTimers();
  });

  it("corrects anyway once the defensive cap elapses, even if still animating (#87)", async () => {
    vi.useFakeTimers();
    const animationContexts = new Map([["move", {}]]);
    const token = makeToken({
      id: "t-stuck-animating",
      x: 5.49 * GRID,
      y: 3.49 * GRID,
      actorId: "some-actor",
      animationContexts,
    });
    const scene = makeScene({ tokens: [token] });
    installFoundryStubs();
    game.scenes = { get: (id) => (id === SCENE_ID ? scene : undefined) };

    const promise = resnapTokenNow(SCENE_ID, "t-stuck-animating");
    // animationContexts is deliberately never cleared -- simulates the
    // defensive cap's own fallback path, not the normal settle path.
    // RESNAP_MAX_WAIT_MS (final review, 2026-09-30: bumped from 3000 to
    // 10000 -- generous above even a long single-jump move, not a guess
    // at typical slide duration).
    await vi.advanceTimersByTimeAsync(10100);
    await promise;

    expect(token.update).toHaveBeenCalledTimes(1);
    expect(token.update).toHaveBeenCalledWith({ x: 5 * GRID, y: 3 * GRID });
    vi.useRealTimers();
  });

  // Final review (2026-09-30): the original version of this test used
  // makeToken's default synchronous `update` mock, which happened to
  // serialize the two calls' own decisions by luck of setTimeout's FIFO
  // callback order (the first call's write lands before the second call
  // re-checks), so it passed even with the reentrancy guard deleted --
  // confirmed by mutation testing. Gating `token.update` on an
  // externally-released promise breaks that accidental serialization:
  // without the guard, BOTH calls would independently decide "not yet
  // aligned" and both call update() before either write lands, which is
  // exactly the race the guard exists to prevent.
  it("does not start a second correction for a token that already has one pending (#87)", async () => {
    vi.useFakeTimers();
    const animationContexts = new Map([["move", {}]]);
    const token = makeToken({
      id: "t-reentrant",
      x: 5.49 * GRID,
      y: 3.49 * GRID,
      actorId: "some-actor",
      animationContexts,
    });
    let releaseUpdate;
    const updateGate = new Promise((resolve) => {
      releaseUpdate = resolve;
    });
    token.update = vi.fn(async (changes) => {
      await updateGate;
      Object.assign(token, changes);
    });
    const scene = makeScene({ tokens: [token] });
    installFoundryStubs();
    game.scenes = { get: (id) => (id === SCENE_ID ? scene : undefined) };

    const first = resnapTokenNow(SCENE_ID, "t-reentrant");
    const second = resnapTokenNow(SCENE_ID, "t-reentrant");

    animationContexts.clear();
    await vi.advanceTimersByTimeAsync(100);
    releaseUpdate();
    await Promise.all([first, second]);

    expect(token.update).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it("releases its guard once a correction finishes, so a later call for the same token id can still run (#87)", async () => {
    installFoundryStubs();
    game.scenes = { get: () => undefined };

    // First call: token doesn't exist yet -- the early return is inside
    // the try/finally, so it must still release the guard.
    await resnapTokenNow(SCENE_ID, "t-guard-release");

    const token = makeToken({
      id: "t-guard-release",
      x: 5.49 * GRID,
      y: 3.49 * GRID,
      actorId: "some-actor",
    });
    const scene = makeScene({ tokens: [token] });
    game.scenes = { get: (id) => (id === SCENE_ID ? scene : undefined) };

    await resnapTokenNow(SCENE_ID, "t-guard-release");

    expect(token.update).toHaveBeenCalledTimes(1);
    expect(token.update).toHaveBeenCalledWith({ x: 5 * GRID, y: 3 * GRID });
  });

  it("corrects two different animating tokens independently, not serialized by each other (#87)", async () => {
    vi.useFakeTimers();
    const contextsA = new Map([["move", {}]]);
    const contextsB = new Map([["move", {}]]);
    const tokenA = makeToken({
      id: "t-a",
      x: 5.49 * GRID,
      y: 0,
      actorId: "actor-a",
      animationContexts: contextsA,
    });
    const tokenB = makeToken({
      id: "t-b",
      x: 2.49 * GRID,
      y: 0,
      actorId: "actor-b",
      animationContexts: contextsB,
    });
    const scene = makeScene({ tokens: [tokenA, tokenB] });
    installFoundryStubs();
    game.scenes = { get: (id) => (id === SCENE_ID ? scene : undefined) };

    const promiseA = resnapTokenNow(SCENE_ID, "t-a");
    const promiseB = resnapTokenNow(SCENE_ID, "t-b");

    // B settles well before A -- must not wait on A's own guard entry.
    contextsB.clear();
    await vi.advanceTimersByTimeAsync(100);
    await promiseB;
    expect(tokenB.update).toHaveBeenCalledTimes(1);
    expect(tokenA.update).not.toHaveBeenCalled();

    contextsA.clear();
    await vi.advanceTimersByTimeAsync(100);
    await promiseA;
    expect(tokenA.update).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it("no-ops if the token is deleted from the scene while a correction is deferred (#87)", async () => {
    vi.useFakeTimers();
    const animationContexts = new Map([["move", {}]]);
    const token = makeToken({
      id: "t-deleted-mid-wait",
      x: 5.49 * GRID,
      y: 3.49 * GRID,
      actorId: "some-actor",
      animationContexts,
    });
    const scene = makeScene({ tokens: [token] });
    installFoundryStubs();
    game.scenes = { get: (id) => (id === SCENE_ID ? scene : undefined) };

    const promise = resnapTokenNow(SCENE_ID, "t-deleted-mid-wait");

    // The token is removed from the scene before the animation settles.
    scene.tokens = [];
    animationContexts.clear();
    await vi.advanceTimersByTimeAsync(100);

    await expect(promise).resolves.not.toThrow();
    expect(token.update).not.toHaveBeenCalled();
    vi.useRealTimers();
  });
});

describe("resnapDriftedTokens (#141)", () => {
  afterEach(() => {
    requestDungeonAction.mockClear();
  });

  it("snaps an off-grid token directly on a GM client, on a dungeon-run-managed scene", async () => {
    const token = makeToken({
      id: "t-drifted",
      x: 5.49 * GRID,
      y: 3.49 * GRID,
      actorId: "some-actor",
    });
    const scene = makeScene({ tokens: [token] });
    installFoundryStubs({
      dungeonRuns: {
        [SCENE_ID]: { hostUserId: HOST_USER_ID, aiControlledActorIds: [] },
      },
    });
    game.scenes = { get: (id) => (id === SCENE_ID ? scene : undefined) };

    await resnapDriftedTokens(token, { x: token.x, y: token.y });

    expect(token.update).toHaveBeenCalledTimes(1);
    expect(token.update).toHaveBeenCalledWith({ x: 5 * GRID, y: 3 * GRID });
    expect(requestDungeonAction).not.toHaveBeenCalled();
  });

  it("does nothing on a scene with no active dungeon run", () => {
    const token = makeToken({
      id: "t-drifted",
      x: 5.49 * GRID,
      y: 3.49 * GRID,
      actorId: "some-actor",
    });
    makeScene({ tokens: [token] });
    installFoundryStubs({ dungeonRuns: {} });

    resnapDriftedTokens(token, { x: token.x, y: token.y });

    expect(token.update).not.toHaveBeenCalled();
    expect(requestDungeonAction).not.toHaveBeenCalled();
  });

  it("does nothing when the update isn't a position change", () => {
    const token = makeToken({
      id: "t-drifted",
      x: 5.49 * GRID,
      y: 3.49 * GRID,
      actorId: "some-actor",
    });
    makeScene({ tokens: [token] });
    installFoundryStubs({
      dungeonRuns: {
        [SCENE_ID]: { hostUserId: HOST_USER_ID, aiControlledActorIds: [] },
      },
    });

    resnapDriftedTokens(token, { elevation: 0 });

    expect(token.update).not.toHaveBeenCalled();
  });

  it("does nothing when the token is already grid-aligned", () => {
    const token = makeToken({
      id: "t-aligned",
      x: 5 * GRID,
      y: 3 * GRID,
      actorId: "some-actor",
    });
    const scene = makeScene({ tokens: [token] });
    installFoundryStubs({
      dungeonRuns: {
        [SCENE_ID]: { hostUserId: HOST_USER_ID, aiControlledActorIds: [] },
      },
    });
    game.scenes = { get: (id) => (id === SCENE_ID ? scene : undefined) };

    resnapDriftedTokens(token, { x: token.x, y: token.y });

    expect(token.update).not.toHaveBeenCalled();
    expect(requestDungeonAction).not.toHaveBeenCalled();
  });

  it("requests a resnap via the relay when the current client is the non-GM host (#65)", () => {
    const token = makeToken({
      id: "t-drifted",
      x: 5.49 * GRID,
      y: 3.49 * GRID,
      actorId: "some-actor",
    });
    makeScene({ tokens: [token] });
    installFoundryStubs({
      isGM: false,
      userId: HOST_USER_ID,
      dungeonRuns: {
        [SCENE_ID]: { hostUserId: HOST_USER_ID, aiControlledActorIds: [] },
      },
    });

    resnapDriftedTokens(token, { x: token.x, y: token.y });

    expect(token.update).not.toHaveBeenCalled();
    expect(requestDungeonAction).toHaveBeenCalledTimes(1);
    expect(requestDungeonAction).toHaveBeenCalledWith("resnapToken", {
      sceneId: SCENE_ID,
      tokenId: "t-drifted",
    });
  });

  it("does nothing when the current client is neither GM nor the run's host", () => {
    const token = makeToken({
      id: "t-drifted",
      x: 5.49 * GRID,
      y: 3.49 * GRID,
      actorId: "some-actor",
    });
    makeScene({ tokens: [token] });
    installFoundryStubs({
      isGM: false,
      userId: OTHER_USER_ID,
      dungeonRuns: {
        [SCENE_ID]: { hostUserId: HOST_USER_ID, aiControlledActorIds: [] },
      },
    });

    resnapDriftedTokens(token, { x: token.x, y: token.y });

    expect(token.update).not.toHaveBeenCalled();
    expect(requestDungeonAction).not.toHaveBeenCalled();
  });
});

describe("moveFollowersToward + resnapDriftedTokens interaction (#87)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  // The actual live-reported bug (#87, 2026-09-30): resnapDriftedTokens
  // used to read a follower's position WHILE its own legitimate
  // moveFollowersToward move was still mid-animation, round the
  // still-fractional position back toward the follower's STARTING cell,
  // and silently cancel the move -- confirmed live via a monkeypatched
  // TokenDocument.update() call-stack capture (see #87's comment
  // history). This produced the originally-reported symptom (two
  // AI-controlled followers stacking on the same cell -- #181's own
  // chain-following is what made it visible). Reproduced here at the
  // single-follower level, since the race itself doesn't need a second
  // follower to occur.
  it("does not let resnapDriftedTokens cancel a follower's own in-flight move", async () => {
    vi.useFakeTimers();
    const leader = makeToken({ id: "t-leader", x: 3 * GRID, y: 0, actorId: LEADER_ACTOR_ID });
    const follower = makeToken({ id: "t-f", x: 0, y: 0, actorId: "actor-f" });
    // Simulates Foundry's own animated slide: the instant the real
    // moveFollowersToward move is issued, animationContexts becomes
    // non-empty and the position only partially advances toward the
    // real destination (stays fractional/off-grid) -- the exact
    // live-confirmed shape of the #87 race, not yet the final position.
    follower.update = vi.fn(async (changes) => {
      follower.object.animationContexts.set("move", {});
      follower.__destination = { x: changes.x, y: changes.y };
      follower.x = follower.x + (changes.x - follower.x) * 0.2;
      follower.y = follower.y + (changes.y - follower.y) * 0.2;
    });
    const scene = makeScene({ tokens: [leader, follower] });

    installFoundryStubs({
      dungeonRuns: {
        [SCENE_ID]: {
          hostUserId: HOST_USER_ID,
          aiControlledActorIds: ["actor-f"],
          marchingOrder: ["actor-f"],
        },
      },
    });
    game.scenes = { get: (id) => (id === SCENE_ID ? scene : undefined) };

    runFollowMoveNow(SCENE_ID);
    await vi.advanceTimersByTimeAsync(300);

    expect(follower.update).toHaveBeenCalledTimes(1);
    const destination = follower.__destination;

    // Simulate Foundry's updateToken hook firing reactively while the
    // follower is still mid-flight -- exactly the moment the pre-fix
    // code would round it back to the follower's STARTING cell and
    // cancel its own legitimate move.
    const resnapPromise = resnapDriftedTokens(follower, { x: follower.x, y: follower.y });

    // Not reverted while still animating: no second update() call yet.
    expect(follower.update).toHaveBeenCalledTimes(1);

    // The animation genuinely finishes: Foundry lands the token at its
    // real destination and animationContexts empties.
    follower.object.animationContexts.clear();
    Object.assign(follower, destination);
    await vi.advanceTimersByTimeAsync(150);
    await resnapPromise;

    // Still only the one legitimate update() call -- the deferred
    // resnap found the token already grid-aligned at its real
    // destination and correctly left it alone.
    expect(follower.update).toHaveBeenCalledTimes(1);
    expect(follower.x).toBe(destination.x);
    expect(follower.y).toBe(destination.y);
  });
});
