import { describe, it, expect, vi, beforeEach } from "vitest";
import { strideByPosture, stepToward } from "../scripts/dungeon-combat.mjs";

// #606: live snapshot (combat VPJsV3hO1KTqYR4x, round 2). The party's AI
// actors stood in the corridor above the room's one open door, whose
// inside cell was held by the Wizard. The single shortest path to the
// Homunculus ran through that ally's square and ended on the target, so
// walkPath found no unoccupied cell to land on and reported "blocked"
// although free squares adjacent to the Homunculus were within speed.

const G = 100;
const WALLS = [{"c":[41700,3900,43000,3900],"door":0,"ds":0,"move":20},{"c":[43000,3900,43000,5200],"door":0,"ds":0,"move":20},{"c":[43000,4500,43200,4500],"door":0,"ds":0,"move":20},{"c":[43300,4500,43600,4500],"door":0,"ds":0,"move":20},{"c":[43600,3900,43600,4500],"door":0,"ds":0,"move":20},{"c":[43200,4500,43300,4500],"door":1,"ds":2,"move":20},{"c":[43000,3900,43000,4500],"door":0,"ds":0,"move":20},{"c":[43100,4600,43300,4600],"door":0,"ds":0,"move":20},{"c":[43100,4500,43100,4600],"door":0,"ds":0,"move":20},{"c":[43300,4500,43300,4600],"door":0,"ds":0,"move":20},{"c":[41700,3900,43000,3900],"door":0,"ds":0,"move":20},{"c":[43000,2900,43000,3900],"door":0,"ds":0,"move":20},{"c":[43300,3900,44300,3900],"door":0,"ds":0,"move":20},{"c":[43000,2900,43000,3900],"door":0,"ds":0,"move":20},{"c":[43000,3500,43000,3600],"door":0,"ds":0,"move":20},{"c":[43100,3500,43100,3600],"door":0,"ds":0,"move":20},{"c":[43000,3600,43000,3700],"door":0,"ds":0,"move":20},{"c":[43100,3600,43100,3700],"door":0,"ds":0,"move":20},{"c":[43000,3700,43000,3800],"door":0,"ds":0,"move":20},{"c":[43100,3700,43100,3800],"door":0,"ds":0,"move":20},{"c":[43000,3900,43100,3900],"door":0,"ds":0,"move":20},{"c":[43000,3800,43000,3900],"door":0,"ds":0,"move":20},{"c":[43100,3800,43200,3800],"door":0,"ds":0,"move":20},{"c":[43100,3900,43200,3900],"door":0,"ds":0,"move":20},{"c":[43200,3800,43300,3800],"door":0,"ds":0,"move":20},{"c":[43300,3800,43300,3900],"door":0,"ds":0,"move":20},{"c":[43000,3900,43200,3900],"door":0,"ds":0,"move":20},{"c":[43200,3900,43300,3900],"door":1,"ds":1,"move":20},{"c":[43000,3900,43200,3900],"door":0,"ds":0,"move":20},{"c":[43300,3900,43600,3900],"door":0,"ds":0,"move":20}];

beforeEach(() => {
  globalThis.foundry = { utils: {} };
  globalThis.CONST = {
    WALL_MOVEMENT_TYPES: { NONE: 0, NORMAL: 20 },
    WALL_DOOR_TYPES: { NONE: 0, DOOR: 1, SECRET: 2 },
    WALL_DOOR_STATES: { CLOSED: 0, OPEN: 1, LOCKED: 2 },
  };
  globalThis.ChatMessage = { create: async () => {}, getWhisperRecipients: () => [] };
  globalThis.game = {
    user: { isGM: true, flags: { pf2e: { settings: {} } }, update: async () => {} },
    i18n: { format: (k) => k },
    messages: { contents: [] },
    combats: { contents: [] },
    modules: { get: () => ({ version: "0" }) },
  };
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "debug").mockImplementation(() => {});
});

function mk(id, gx, gy, disposition, { size = 1, speed = 25, defeated = false } = {}) {
  return {
    id,
    isDefeated: defeated,
    token: {
      x: gx * G, y: gy * G, disposition, width: size, height: size,
      update: vi.fn(async function (c) { Object.assign(this, c); }),
    },
    actor: { system: { movement: { speeds: { land: { value: speed } } } } },
  };
}

function scenario() {
  const c = {
    armor: mk("armor", 433, 42, -1, { speed: 20 }),
    homunculus: mk("homunculus", 431, 40, -1, { size: 0.5, speed: 15 }),
    sneak: mk("sneak", 433, 41, 1, { defeated: true }),
    cleric: mk("cleric", 430, 38, 1),
    fighter: mk("fighter", 431, 41, 1, { speed: 20 }),
    paladin: mk("paladin", 431, 38, 1),
    wizard: mk("wizard", 432, 39, 1, { speed: 30 }),
    thief: mk("thief", 432, 38, 1),
  };
  const combat = {
    round: 2, turn: 7,
    combatants: Object.values(c),
    scene: {
      id: "s", grid: { size: G, distance: 5 },
      width: 44400, height: 17000,
      tokens: [], walls: { contents: WALLS },
    },
    getFlag: () => undefined, setFlag: async () => {},
  };
  return { c, combat };
}

const cellOf = (t) => ({ gx: Math.round(t.x / G), gy: Math.round(t.y / G) });

describe("#606 AI party stalls with free squares beside the target", () => {
  for (const name of ["thief", "paladin", "cleric"]) {
    it(`${name} lands on a free square adjacent to the Homunculus`, async () => {
      const { c, combat } = scenario();
      const me = c[name];
      const result = await strideByPosture(combat, me, "approach", c.homunculus);
      expect(result).toBe("moved");
      const end = cellOf(me.token);
      const occupied = ["armor", "homunculus", "fighter", "wizard", "thief", "paladin", "cleric"]
        .filter((n) => n !== name)
        .map((n) => cellOf(c[n].token));
      expect(occupied).not.toContainEqual(end);
      expect(Math.max(Math.abs(end.gx - 431), Math.abs(end.gy - 40))).toBe(1);
    });
  }

  it("stepToward lands on a free square too", async () => {
    const { c, combat } = scenario();
    const result = await stepToward(combat, c.thief, c.homunculus, 2);
    expect(result).toBe("moved");
  });

  it("still reports blocked when every reachable square is truly occupied", async () => {
    const { c, combat } = scenario();
    // Wall in the thief: corridor cell with only the wizard's cell ahead.
    c.thief.actor.system.movement.speeds.land.value = 5;
    const result = await strideByPosture(combat, c.thief, "approach", c.homunculus);
    expect(result).toBe("blocked");
  });
});
