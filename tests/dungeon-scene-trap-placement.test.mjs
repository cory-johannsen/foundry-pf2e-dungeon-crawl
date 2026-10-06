import { describe, it, expect, vi, beforeEach } from "vitest";

// #754: build-time trap placement is independent of room kind.
const roll = vi.hoisted(() => ({ succeeds: true, corridor: false }));
const overshoot = vi.hoisted(() => ({ on: false }));
const calls = vi.hoisted(() => ({ order: [], spawns: [], selects: [], origFootprint: null }));

vi.mock("../scripts/dungeon-deck.mjs", async (importOriginal) => ({
  ...(await importOriginal()),
  trapRollSucceeds: vi.fn(() => roll.succeeds),
  corridorTrapRollSucceeds: vi.fn(() => roll.corridor),
}));
// #779: lets a test lengthen the last corridor segment by half a cell, reproducing the fractional-length
// overshoot of corridorTilesForSegments (one extra cell past the corridor, inside the destination room).
vi.mock("../scripts/dungeon-layout.mjs", async (importOriginal) => {
  const orig = await importOriginal();
  return {
    ...orig,
    buildEdgeCorridor: (...a) => {
      const r = orig.buildEdgeCorridor(...a);
      if (!overshoot.on || !r?.corridorSegments?.length) return r;
      const segs = r.corridorSegments.map((x) => ({ ...x }));
      const last = segs[segs.length - 1];
      if (last.gh >= last.gw) last.gh += 0.5; else last.gw += 0.5;
      return { ...r, corridorSegments: segs };
    },
  };
});
vi.mock("../scripts/encounter-generator.mjs", () => ({
  generateEncounter: vi.fn(async ({ scene, extraFlags }) => {
    calls.order.push("encounter");
    scene.addToken({ dungeonSlot: extraFlags["pf2e-dungeon-crawl"].dungeonSlot });
  }),
}));
vi.mock("../scripts/trap-library.mjs", () => ({
  selectTrap: vi.fn(async (args) => { calls.selects.push(args); return { pack: "pf2e.hazards", id: "trap1" }; }),
}));
vi.mock("../scripts/trap-mechanics.mjs", async (importOriginal) => {
  const orig = await importOriginal();
  calls.origFootprint = orig.trapFootprintSize;
  return { ...orig, trapFootprintSize: vi.fn((...a) => orig.trapFootprintSize(...a)) };
});
vi.mock("../scripts/foundry-api.mjs", () => ({
  makeFoundryApi: (scene) => ({
    partyLevel: async () => 3,
    spawnCreatures: async (specs, { extraFlags, originArea }) => {
      calls.order.push("trap");
      calls.spawns.push({ specs, originArea });
      scene?.addToken({ ...extraFlags["pf2e-dungeon-crawl"] });
      return [{ actorId: "no-such-actor", tokenId: "t" }];
    },
  }),
}));

import { buildPopulateAndUnlockGraphNode } from "../scripts/dungeon-scene.mjs";
import { trapRollSucceeds, corridorTrapRollSucceeds, depthBiasFor, applyDifficultyShift } from "../scripts/dungeon-deck.mjs";
import { trapFootprintSize } from "../scripts/trap-mechanics.mjs";
import { splitmix32, seedFromString } from "../scripts/prng.mjs";
import { corridorTilesForSegments, corridorTrapCandidateCells, populateSlotTrap, effectiveRoomBias } from "../scripts/dungeon-scene.mjs";
import { buildEdgeCorridor, roomRect, doorSlotsForFace } from "../scripts/dungeon-layout.mjs";

const MODULE_ID = "pf2e-dungeon-crawl";

function makeScene() {
  let n = 0;
  const scene = {
    id: "test-scene", walls: [], tiles: [], tokens: [],
    addToken(flags) {
      scene.tokens.push({ id: `tok-${n += 1}`, flags: { [MODULE_ID]: flags }, getFlag: (m, k) => flags[k] });
    },
    async createEmbeddedDocuments(type, docs) {
      return docs.map((data) => {
        n += 1;
        const doc = { id: `${type}-${n}`, ...data, getFlag: (m, k) => data.flags?.[m]?.[k], update: async () => {} };
        if (type === "Wall") scene.walls.push(doc);
        if (type === "Tile") scene.tiles.push(doc);
        return doc;
      });
    },
    async deleteEmbeddedDocuments() {},
  };
  return scene;
}

const S = "room-s";
const state = {
  seed: "trap-placement-seed", maxRank: 3, difficulty: "standard", hiddenRooms: [],
  layoutPositionByRoomId: { [S]: { rank: 1, col: 2 } },
  incomingFaceByRoomId: { [S]: "north" },
  edges: {}, layoutEdges: {}, hiddenIncomingByRoomId: {}, hiddenEdges: {},
};
const mk = (kind, extra = {}) => ({ id: S, kind, isGoal: false, locationTag: null, artVariant: 0, setpieceId: null, ...extra });
const build = (scene, room) =>
  buildPopulateAndUnlockGraphNode(scene, state, room, { rank: 1, col: 2, childIds: [], unlock: true });
const trapsIn = (scene) => scene.tokens.filter((t) => t.getFlag(MODULE_ID, "trapHazard") && t.getFlag(MODULE_ID, "dungeonSlot") === S);

beforeEach(() => {
  roll.succeeds = true;
  roll.corridor = false;
  overshoot.on = false;
  calls.order.length = 0;
  calls.spawns.length = 0;
  calls.selects.length = 0;
  vi.mocked(corridorTrapRollSucceeds).mockClear();
  vi.mocked(trapFootprintSize).mockReset().mockImplementation((...a) => calls.origFootprint(...a));
  vi.mocked(trapRollSucceeds).mockClear();
  globalThis.CONST = {
    WALL_DOOR_TYPES: { NONE: 0, DOOR: 1, SECRET: 2 },
    WALL_DOOR_STATES: { CLOSED: 0, OPEN: 1, LOCKED: 2 },
    WALL_SENSE_TYPES: { NONE: 0, NORMAL: 20 },
    WALL_MOVEMENT_TYPES: { NONE: 0, NORMAL: 20 },
  };
  globalThis.game = { actors: { party: { members: [] }, get: () => null }, settings: { get: () => ({}) }, i18n: { localize: (k) => k, format: (k) => k } };
  globalThis.ui = { notifications: { warn: () => {} } };
  globalThis.fetch = async () => ({ json: async () => [] });
  globalThis.Actor = {
    createDocuments: async () => [{ getTokenDocument: async () => { throw new Error("no token docs in fake"); }, delete: async () => {} }],
  };
});

describe("buildPopulateAndUnlockGraphNode — #754 kind-agnostic trap placement", () => {
  for (const kind of ["combat", "treasure", "puzzle", "narrative", "skill_challenge"]) {
    it(`a roll-success ${kind} room gets exactly one trap`, async () => {
      const scene = makeScene();
      await build(scene, mk(kind));
      expect(trapsIn(scene)).toHaveLength(1);
    });
  }

  for (const [label, room] of [
    ["safe_entry", mk("safe_entry")],
    ["safe_rest", mk("safe_rest")],
    ["goal", mk("combat", { isGoal: true })],
  ]) {
    it(`a ${label} room never gets a trap, even on roll success`, async () => {
      const scene = makeScene();
      await build(scene, room);
      expect(trapsIn(scene)).toHaveLength(0);
    });
  }

  it("a roll-failure room gets no trap", async () => {
    roll.succeeds = false;
    const scene = makeScene();
    await build(scene, mk("narrative"));
    expect(trapsIn(scene)).toHaveLength(0);
  });

  it("rolls with the run seed and the room id", async () => {
    await build(makeScene(), mk("narrative"));
    expect(trapRollSucceeds).toHaveBeenCalledWith(state.seed, S);
  });

  it("re-running the build never gives a second trap (non-combat and combat)", async () => {
    for (const kind of ["narrative", "combat"]) {
      const scene = makeScene();
      await build(scene, mk(kind));
      await build(scene, mk(kind));
      expect(trapsIn(scene)).toHaveLength(1);
    }
  });

  it("a combat room's trap is placed after its encounter", async () => {
    const scene = makeScene();
    await build(scene, mk("combat"));
    expect(calls.order).toEqual(["encounter", "trap"]);
  });

  it("a combat room whose encounter failed gets no trap (so the retry still populates it)", async () => {
    const { generateEncounter } = await import("../scripts/encounter-generator.mjs");
    vi.mocked(generateEncounter).mockImplementationOnce(async () => { calls.order.push("encounter"); });
    const scene = makeScene();
    await build(scene, mk("combat"));
    expect(trapsIn(scene)).toHaveLength(0);
    await build(scene, mk("combat"));
    expect(calls.order).toEqual(["encounter", "encounter", "trap"]);
  });
});

// ---- #779: corridor traps -------------------------------------------------
const F = "room-f";
const EDGE = `${F}->${S}`;
const cState = (extra = {}) => {
  const edges = { [F]: [S] };
  return {
    seed: "corridor-trap-seed", maxRank: 3, difficulty: "standard", hiddenRooms: [],
    layoutPositionByRoomId: { [F]: { rank: 0, col: 2 }, [S]: { rank: 1, col: 2 } },
    incomingFaceByRoomId: { [F]: "north", [S]: "north" },
    edges, layoutEdges: edges, hiddenIncomingByRoomId: {}, hiddenEdges: {},
    ...extra,
  };
};
const cBuild = (scene, st = cState(), room = mk("narrative")) =>
  buildPopulateAndUnlockGraphNode(scene, st, room, { rank: 1, col: 2, childIds: [], unlock: false });
const corridorTraps = (scene) =>
  scene.tokens.filter((t) => t.getFlag(MODULE_ID, "trapHazard") && t.getFlag(MODULE_ID, "dungeonSlot") === EDGE);

/** The edge's own main-segment cells, derived independently via the pure layout function. */
function edgeCells(st = cState()) {
  const fromRect = roomRect(st.seed, F, 0, 2);
  const toRect = roomRect(st.seed, S, 1, 2);
  const toSlot = doorSlotsForFace(toRect, 1, "north")[0];
  const { corridorSegments } = buildEdgeCorridor(
    st.seed, F, S, fromRect, toRect, { rank: 0, col: 2 }, { rank: 1, col: 2 },
    "south", toSlot, { "0,2": F, "1,2": S }, "north",
  );
  return corridorTilesForSegments(corridorSegments).cells;
}

describe("buildPopulateAndUnlockGraphNode — #779 corridor trap placement", () => {
  it("a roll-success edge gets exactly one corridor trap, keyed by the edge id", async () => {
    roll.succeeds = false;
    roll.corridor = true;
    const scene = makeScene();
    await cBuild(scene);
    expect(corridorTraps(scene)).toHaveLength(1);
    expect(trapsIn(scene)).toHaveLength(0);
    expect(corridorTrapRollSucceeds).toHaveBeenCalledWith("corridor-trap-seed", EDGE);
  });

  it("a roll-failure edge gets no corridor trap", async () => {
    roll.succeeds = false;
    const scene = makeScene();
    await cBuild(scene);
    expect(corridorTraps(scene)).toHaveLength(0);
    expect(calls.spawns).toHaveLength(0);
  });

  it("a hidden edge never gets a corridor trap, even on roll success", async () => {
    roll.succeeds = false;
    roll.corridor = true;
    const scene = makeScene();
    await cBuild(scene, cState({ hiddenRooms: [S] }));
    expect(corridorTraps(scene)).toHaveLength(0);
    expect(calls.spawns).toHaveLength(0);
  });

  it("rebuilding the same room never gives the edge a second trap", async () => {
    roll.succeeds = false;
    roll.corridor = true;
    const scene = makeScene();
    await cBuild(scene);
    await cBuild(scene);
    expect(corridorTraps(scene)).toHaveLength(1);
  });

  it("the corridor trap is forced to 1x1 even when the seeded footprint roll says 2x2, and lands on one of the edge's own main-segment cells", async () => {
    roll.succeeds = false;
    roll.corridor = true;
    vi.mocked(trapFootprintSize).mockReturnValue({ width: 2, height: 2 });
    const scene = makeScene();
    await cBuild(scene);
    expect(calls.spawns).toHaveLength(1);
    const { specs, originArea } = calls.spawns[0];
    expect(specs[0].tokenSize).toEqual({ width: 1, height: 1 });
    expect(originArea.width).toBe(100);
    expect(originArea.height).toBe(100);
    const cells = edgeCells();
    expect(cells.length).toBeGreaterThan(0);
    expect(cells.some((c) => c.gx * 100 === originArea.x && c.gy * 100 === originArea.y)).toBe(true);
  });

  it("the corridor trap's level bias is the receiving room's effectiveRoomBias, not 0", async () => {
    roll.succeeds = false;
    roll.corridor = true;
    const st = cState({ difficulty: "extreme", maxRank: 1 });
    const scene = makeScene();
    await cBuild(scene, st);
    const expected = effectiveRoomBias({ rank: 1, maxRank: 1, isGoal: false, difficulty: "extreme" });
    expect(expected).toBe(applyDifficultyShift(depthBiasFor({ rank: 1, maxRank: 1, isGoal: false }), "extreme"));
    expect(expected).toBeGreaterThan(0);
    expect(calls.selects).toHaveLength(1);
    expect(calls.selects[0].levelOffsetBias).toBe(expected);
  });

  it("a room-level trap in the same room still uses its seeded footprint (corridor override does not leak)", async () => {
    vi.mocked(trapFootprintSize).mockReturnValue({ width: 2, height: 1 });
    roll.corridor = true;
    const scene = makeScene();
    await cBuild(scene);
    const sizes = calls.spawns.map((c) => c.specs[0].tokenSize);
    expect(sizes).toContainEqual({ width: 1, height: 1 });
    expect(sizes).toContainEqual({ width: 2, height: 1 });
  });

  it("does not change the corridor floor tiles (same count/x/y/rotation/art with or without a trap)", async () => {
    const strip = (scene) => scene.tiles.map(({ id, getFlag, update, ...r }) => r);
    roll.succeeds = false;
    const without = makeScene();
    await cBuild(without);
    roll.corridor = true;
    const withTrap = makeScene();
    await cBuild(withTrap);
    expect(corridorTraps(withTrap)).toHaveLength(1);
    expect(strip(withTrap)).toEqual(strip(without));
  });
});

describe("#779 corridor trap never lands inside a room (overshoot cell)", () => {
  const inRect = (c, r) => c.gx >= r.gx && c.gx < r.gx + r.gw && c.gy >= r.gy && c.gy < r.gy + r.gh;
  const rects = (st) => [roomRect(st.seed, F, 0, 2), roomRect(st.seed, S, 1, 2)];
  const cellOf = (originArea) => ({ gx: originArea.x / 100, gy: originArea.y / 100 });
  /** Which cell the pre-fix code (pick from the unfiltered cells) would choose. */
  const oldPick = (st) => {
    overshoot.on = true;
    const cells = edgeCells(st);
    overshoot.on = false;
    return cells[Math.floor(splitmix32(seedFromString(`${st.seed}-corridor-trap-cell-${EDGE}`))() * cells.length)];
  };

  it("fixture really overshoots: with a fractional segment, a corridor cell lies inside the destination room", () => {
    overshoot.on = true;
    const st = cState();
    expect(edgeCells(st).some((c) => inRect(c, rects(st)[1]))).toBe(true);
  });

  it("across seeds (including ones the old code would send into the room) the trap is never in either room rect", async () => {
    let oldWouldHit = 0;
    let placed = 0;
    for (let k = 0; k < 60; k += 1) {
      const st = cState({ seed: `overshoot-${k}` });
      const [fr, tr] = rects(st);
      const old = oldPick(st);
      if (inRect(old, fr) || inRect(old, tr)) oldWouldHit += 1;
      roll.succeeds = false;
      roll.corridor = true;
      overshoot.on = true;
      calls.spawns.length = 0;
      const scene = makeScene();
      await cBuild(scene, st);
      if (calls.spawns.length) {
        placed += 1;
        const cell = cellOf(calls.spawns[0].originArea);
        expect(inRect(cell, fr) || inRect(cell, tr)).toBe(false);
      }
    }
    expect(oldWouldHit).toBeGreaterThan(0); // proves the fixture exercises the old bug
    expect(placed).toBe(60); // a legitimate corridor cell still gets a trap
  });

  it("the helper drops cells inside either rect, de-duplicates, and keeps legitimate cells", () => {
    const src = { gx: 0, gy: 0, gw: 4, gh: 4 };
    const dst = { gx: 378, gy: 39, gw: 6, gh: 6 };
    const cells = [{ gx: 4, gy: 1 }, { gx: 4, gy: 1 }, { gx: 3, gy: 1 }, { gx: 377, gy: 41 }, { gx: 378, gy: 41 }, { gx: 380, gy: 40 }];
    expect(corridorTrapCandidateCells(cells, [src, dst])).toEqual([{ gx: 4, gy: 1 }, { gx: 377, gy: 41 }]);
  });

  it("when every candidate is inside a room, no candidate remains (no fallback to an excluded cell)", () => {
    const dst = { gx: 378, gy: 39, gw: 6, gh: 6 };
    expect(corridorTrapCandidateCells([{ gx: 378, gy: 41 }, { gx: 378, gy: 41 }], [dst])).toEqual([]);
  });

  it("corridor floor tiles still include the overshoot cell (art output unchanged)", () => {
    const { cells, tiles } = corridorTilesForSegments([{ gx: 5, gy: 5, gw: 1, gh: 2.5 }]);
    expect(cells).toHaveLength(3);
    expect(tiles).toHaveLength(3);
  });
});

describe("populateSlotTrap — #779 tokenSize override", () => {
  const rect = { gx: 3, gy: 3, gw: 1, gh: 1 };
  it("defaults to the seeded trapFootprintSize roll (every existing room caller)", async () => {
    vi.mocked(trapFootprintSize).mockReturnValue({ width: 2, height: 2 });
    await populateSlotTrap(makeScene(), "room-x", { rect, partyLevel: 3, seed: "s", roomId: "room-x" });
    expect(calls.spawns[0].specs[0].tokenSize).toEqual({ width: 2, height: 2 });
  });
  it("uses an explicit tokenSize without consulting the seeded roll", async () => {
    await populateSlotTrap(makeScene(), "a->b", { rect, partyLevel: 3, seed: "s", roomId: "a->b", tokenSize: { width: 1, height: 1 } });
    expect(calls.spawns[0].specs[0].tokenSize).toEqual({ width: 1, height: 1 });
    expect(trapFootprintSize).not.toHaveBeenCalled();
  });
});
