import { describe, it, expect, vi, beforeEach } from "vitest";
import { stepToward, strideByPosture } from "../scripts/dungeon-combat.mjs";

// #567: living cover items (scene tokens, never Combatants) block AI movement.

const G = 100;

beforeEach(() => {
  globalThis.foundry = { utils: {} };
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

function combatant(id, gx, gy, disposition, size = 1) {
  return {
    id,
    isDefeated: false,
    token: {
      x: gx * G,
      y: gy * G,
      disposition,
      width: size,
      height: size,
      update: vi.fn(async function (c) {
        Object.assign(this, c);
      }),
      // #631: positions are written via move({x, y, action: "displace"}).
      move: vi.fn(async function ({ x, y }) {
        Object.assign(this, { x, y });
      }),
    },
    actor: { system: { movement: { speeds: { land: { value: 30 } } } } },
  };
}

function sceneToken(gx, gy, { cover = true, hp = 10 } = {}) {
  return {
    x: gx * G,
    y: gy * G,
    width: 1,
    height: 1,
    getFlag: (_m, k) => (k === "coverItem" ? cover : undefined),
    actor: { system: { attributes: { hp: { value: hp } } } },
  };
}

function makeCombat(combatants, tokens, rows = 1) {
  return {
    round: 1,
    turn: 0,
    combatants,
    scene: {
      id: "s",
      grid: { size: G, distance: 5 },
      width: 10 * G,
      height: rows * G,
      tokens,
      walls: { contents: [] },
    },
    getFlag: () => undefined,
    setFlag: async () => {},
  };
}

// Every cell the token was ever moved onto, by its move() calls.
function visited(token) {
  return token.move.mock.calls.map((c) => ({
    gx: Math.round((c[0].x ?? 0) / G),
    gy: Math.round((c[0].y ?? 0) / G),
  }));
}

describe("living cover blocks AI movement (#567)", () => {
  it("(a) goes around a living crate, never crossing or ending on it", async () => {
    const me = combatant("m", 0, 1, -1);
    const foe = combatant("f", 8, 1, 1);
    const combat = makeCombat([me, foe], [sceneToken(3, 1)], 3);
    await stepToward(combat, me, foe, 6);
    const cells = visited(me.token);
    expect(cells.length).toBeGreaterThan(0);
    for (const c of cells) expect(c).not.toEqual({ gx: 3, gy: 1 });
  });

  it("(a2) a crate filling a 1-wide gap blocks the route entirely", async () => {
    const me = combatant("m", 0, 0, -1);
    const foe = combatant("f", 9, 0, 1);
    const combat = makeCombat([me, foe], [sceneToken(3, 0)], 1);
    await strideByPosture(combat, me, "approach", foe);
    expect(me.token.x).toBeLessThan(3 * G);
  });

  it("(b) never ends on a living crate even when it is the farthest cell", async () => {
    // Speed 6 from gx 0 would otherwise land on gx 6; crate sits at 6 with
    // a free row to go around, so the mover must still not stop on it.
    const me = combatant("m", 0, 0, -1);
    const foe = combatant("f", 9, 0, 1);
    const combat = makeCombat([me, foe], [sceneToken(6, 0)], 2);
    await strideByPosture(combat, me, "approach", foe);
    for (const c of visited(me.token)) expect(c).not.toEqual({ gx: 6, gy: 0 });
    expect(me.token.x === 6 * G && me.token.y === 0).toBe(false);
  });

  it("(c) a destroyed crate (hp 0) does not block", async () => {
    const me = combatant("m", 0, 0, -1);
    const foe = combatant("f", 9, 0, 1);
    const combat = makeCombat([me, foe], [sceneToken(6, 0, { hp: 0 })], 1);
    await strideByPosture(combat, me, "approach", foe);
    expect(me.token.x).toBe(6 * G);
  });

  it("(d) a non-cover token (loot corpse) does not block", async () => {
    const me = combatant("m", 0, 0, -1);
    const foe = combatant("f", 9, 0, 1);
    const combat = makeCombat([me, foe], [sceneToken(6, 0, { cover: false })], 1);
    await strideByPosture(combat, me, "approach", foe);
    expect(me.token.x).toBe(6 * G);
  });

  it("(e) a 2x2 mover is blocked by cover overlapping any of its cells", async () => {
    const me = combatant("m", 0, 0, -1, 2);
    const foe = combatant("f", 9, 0, 1);
    // Crate at (4,1): any 2x2 anchor with gx 3..4 and gy 0..1 overlaps it.
    const combat = makeCombat([me, foe], [sceneToken(4, 1)], 2);
    await strideByPosture(combat, me, "approach", foe);
    for (const c of visited(me.token))
      expect(c.gx + 2 > 4 && c.gx < 5 && c.gy + 2 > 1 && c.gy < 2).toBe(false);
    expect(me.token.x).toBeLessThan(3 * G);
  });
});
