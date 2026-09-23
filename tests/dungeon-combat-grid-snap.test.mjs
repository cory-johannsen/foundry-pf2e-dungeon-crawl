import { describe, it, expect, vi } from "vitest";
import {
  stepToward,
  strideByPosture,
  pushTokenAway,
} from "../scripts/dungeon-combat.mjs";

// #86: an AI-controlled combatant's own token can end up off-grid for
// reasons entirely outside this module's own movement math (e.g. a manual,
// unsnapped drag in Foundry's own UI, or a stale token predating some other
// fix). Every mover function in dungeon-combat.mjs has at least one
// early-return path -- already within melee reach, no speed, no path found,
// no valid waypoint -- that used to leave whatever position the token
// already had completely untouched, silently preserving an off-grid
// position for the rest of that combatant's turns as long as none of those
// paths ever call `token.update()`. These tests start a mover already
// straddling four grid squares (x/y at a half-cell offset) in a scenario
// that takes one of those no-op branches, and assert the token still ends
// up corrected to its nearest grid cell.

const GRID_SIZE = 100;

function installFoundryStubs() {
  globalThis.foundry = { utils: {} };
  globalThis.ChatMessage = { create: async () => {}, calls: [] };
  globalThis.game = {
    user: {
      isGM: true,
      flags: { pf2e: { settings: {} } },
      update: async () => {},
    },
    i18n: { format: (key) => key },
    messages: { contents: [] },
    combats: { contents: [] },
  };
}

function makeToken({ x, y, disposition = -1 } = {}) {
  const token = { x, y, disposition };
  token.update = vi.fn(async function (changes) {
    Object.assign(this, changes);
  });
  return token;
}

function makeCombatant({ id, x, y, disposition = -1, speedFt = 30 } = {}) {
  return {
    id,
    isDefeated: false,
    token: makeToken({ x, y, disposition }),
    actor: { system: { movement: { speeds: { land: { value: speedFt } } } } },
  };
}

function makeCombat({ combatants = [] } = {}) {
  return {
    round: 1,
    combatants,
    scene: {
      id: "s1",
      grid: { size: GRID_SIZE, distance: 5 },
      tokens: [],
      walls: { contents: [] },
    },
    getFlag: () => undefined,
    setFlag: async () => {},
  };
}

// Straddling four grid squares: a half-cell offset in both axes.
const OFF_GRID_X = 2.5 * GRID_SIZE;
const OFF_GRID_Y = 3.5 * GRID_SIZE;

describe("stepToward corrects an off-grid mover even when it doesn't move (#86)", () => {
  it("snaps the mover to its nearest grid cell when already within melee reach", async () => {
    installFoundryStubs();
    const mover = makeCombatant({ id: "mover", x: OFF_GRID_X, y: OFF_GRID_Y });
    const target = makeCombatant({
      id: "target",
      x: OFF_GRID_X + GRID_SIZE,
      y: OFF_GRID_Y,
    });
    const combat = makeCombat({ combatants: [mover, target] });

    // distanceSquares <= MELEE_REACH_SQUARES (1): stepToward's own
    // "already adjacent, nothing to do" early return.
    await stepToward(combat, mover, target, 1);

    expect(mover.token.update).toHaveBeenCalledTimes(1);
    expect(mover.token.x % GRID_SIZE).toBe(0);
    expect(mover.token.y % GRID_SIZE).toBe(0);
    expect(mover.token.x).toBe(Math.round(OFF_GRID_X / GRID_SIZE) * GRID_SIZE);
    expect(mover.token.y).toBe(Math.round(OFF_GRID_Y / GRID_SIZE) * GRID_SIZE);
  });

  it("snaps the mover to its nearest grid cell when it has no speed to move with", async () => {
    installFoundryStubs();
    const mover = makeCombatant({
      id: "mover",
      x: OFF_GRID_X,
      y: OFF_GRID_Y,
      speedFt: 0,
    });
    const target = makeCombatant({
      id: "target",
      x: OFF_GRID_X + 400,
      y: OFF_GRID_Y,
    });
    const combat = makeCombat({ combatants: [mover, target] });

    await stepToward(combat, mover, target, 4);

    expect(mover.token.update).toHaveBeenCalledTimes(1);
    expect(mover.token.x % GRID_SIZE).toBe(0);
    expect(mover.token.y % GRID_SIZE).toBe(0);
  });

  it("does not call update at all when the mover is already grid-aligned and doesn't need to move", async () => {
    installFoundryStubs();
    const mover = makeCombatant({
      id: "mover",
      x: 2 * GRID_SIZE,
      y: 3 * GRID_SIZE,
    });
    const target = makeCombatant({
      id: "target",
      x: 3 * GRID_SIZE,
      y: 3 * GRID_SIZE,
    });
    const combat = makeCombat({ combatants: [mover, target] });

    await stepToward(combat, mover, target, 1);

    expect(mover.token.update).not.toHaveBeenCalled();
  });
});

describe("strideByPosture corrects an off-grid mover even when it doesn't move (#86)", () => {
  it("snaps the mover to its nearest grid cell when there's no target to move toward", async () => {
    installFoundryStubs();
    const mover = makeCombatant({ id: "mover", x: OFF_GRID_X, y: OFF_GRID_Y });
    const combat = makeCombat({ combatants: [mover] });

    await strideByPosture(combat, mover, "approach", null);

    expect(mover.token.update).toHaveBeenCalledTimes(1);
    expect(mover.token.x % GRID_SIZE).toBe(0);
    expect(mover.token.y % GRID_SIZE).toBe(0);
  });

  it("snaps the mover to its nearest grid cell when it has no speed to move with", async () => {
    installFoundryStubs();
    const mover = makeCombatant({
      id: "mover",
      x: OFF_GRID_X,
      y: OFF_GRID_Y,
      speedFt: 0,
    });
    const target = makeCombatant({
      id: "target",
      x: OFF_GRID_X + 400,
      y: OFF_GRID_Y,
    });
    const combat = makeCombat({ combatants: [mover, target] });

    await strideByPosture(combat, mover, "approach", target);

    expect(mover.token.update).toHaveBeenCalledTimes(1);
    expect(mover.token.x % GRID_SIZE).toBe(0);
    expect(mover.token.y % GRID_SIZE).toBe(0);
  });
});

describe("pushTokenAway corrects an off-grid target even when it can't be pushed (#86)", () => {
  it("snaps the pushed token to its nearest grid cell when it has nowhere to go", async () => {
    installFoundryStubs();
    const attacker = makeCombatant({ id: "attacker", x: 0, y: 0 });
    const target = makeCombatant({
      id: "target",
      x: OFF_GRID_X,
      y: OFF_GRID_Y,
    });
    const combat = makeCombat({ combatants: [attacker, target] });
    // A genuinely boxed-in target (walled on all four sides of its own
    // cell) still must not leave a pre-existing off-grid position
    // untouched. pushTokenAway builds its own isBlocked predicate straight
    // from combat.scene.walls, so wall the target in for real.
    const gx = Math.round(OFF_GRID_X / GRID_SIZE);
    const gy = Math.round(OFF_GRID_Y / GRID_SIZE);
    combat.scene.walls.contents = [
      {
        move: 20,
        door: 0,
        c: [
          gx * GRID_SIZE,
          gy * GRID_SIZE,
          (gx + 1) * GRID_SIZE,
          gy * GRID_SIZE,
        ],
      },
      {
        move: 20,
        door: 0,
        c: [
          gx * GRID_SIZE,
          (gy + 1) * GRID_SIZE,
          (gx + 1) * GRID_SIZE,
          (gy + 1) * GRID_SIZE,
        ],
      },
      {
        move: 20,
        door: 0,
        c: [
          gx * GRID_SIZE,
          gy * GRID_SIZE,
          gx * GRID_SIZE,
          (gy + 1) * GRID_SIZE,
        ],
      },
      {
        move: 20,
        door: 0,
        c: [
          (gx + 1) * GRID_SIZE,
          gy * GRID_SIZE,
          (gx + 1) * GRID_SIZE,
          (gy + 1) * GRID_SIZE,
        ],
      },
    ];
    globalThis.CONST = {
      WALL_MOVEMENT_TYPES: { NONE: 0, NORMAL: 20 },
      WALL_DOOR_TYPES: { NONE: 0, DOOR: 1, SECRET: 2 },
      WALL_DOOR_STATES: { CLOSED: 0, OPEN: 1, LOCKED: 2 },
    };

    await pushTokenAway(combat, attacker, target, 1);

    expect(target.token.update).toHaveBeenCalledTimes(1);
    expect(target.token.x % GRID_SIZE).toBe(0);
    expect(target.token.y % GRID_SIZE).toBe(0);
  });
});
