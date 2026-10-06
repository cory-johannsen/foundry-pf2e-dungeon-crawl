import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../scripts/data-loader.mjs", async (importOriginal) => {
  const real = await importOriginal();
  return {
    ...real,
    loadRoomFeatureArt: vi.fn(async () => ({
      undead: { door: [0], treasure: [0], puzzle: [0], skill_challenge: [0] },
      fiend: { door: [0] },
    })),
  };
});

import { wallDoc, buildPopulateAndUnlockGraphNode, buildRoomAtGraphNode, unlockDoorsFromRoom } from "../scripts/dungeon-scene.mjs";
import { roomRect } from "../scripts/dungeon-layout.mjs";
import { DOOR_TEXTURE_WIDTH_PX } from "../scripts/room-feature-art.mjs";
import { loadRoomFeatureArt } from "../scripts/data-loader.mjs";

const MODULE_ID = "pf2e-dungeon-crawl";
const GRID_SIZE = 100;
const toPixels = (v) => v * GRID_SIZE;
const ART = "modules/pf2e-dungeon-crawl/assets/room-features";

function installFoundryStubs() {
  globalThis.CONST = {
    WALL_DOOR_TYPES: { NONE: 0, DOOR: 1, SECRET: 2 },
    WALL_DOOR_STATES: { CLOSED: 0, OPEN: 1, LOCKED: 2 },
    WALL_SENSE_TYPES: { NONE: 0, NORMAL: 20 },
    WALL_MOVEMENT_TYPES: { NONE: 0, NORMAL: 20 },
  };
}

function makeFakeScene() {
  const walls = [];
  const tiles = [];
  let nextId = 0;
  return {
    id: "test-scene",
    walls,
    tiles,
    async createEmbeddedDocuments(type, docs) {
      return docs.map((data) => {
        nextId += 1;
        const doc = {
          id: `${type}-${nextId}`,
          ...data,
          getFlag: (moduleId, key) => data.flags?.[moduleId]?.[key],
          update: async (changes) => Object.assign(doc, changes),
        };
        if (type === "Wall") walls.push(doc);
        if (type === "Tile") tiles.push(doc);
        return doc;
      });
    },
    async deleteEmbeddedDocuments(type, ids) {
      const arr = type === "Wall" ? walls : tiles;
      for (const id of ids) {
        const idx = arr.findIndex((d) => d.id === id);
        if (idx >= 0) arr.splice(idx, 1);
      }
    },
  };
}

describe("wallDoc themed art (#750)", () => {
  beforeEach(installFoundryStubs);
  const span = { x1: 0, y1: 0, x2: 1, y2: 0 };

  it("gives a door wall an animation texture when art is supplied", () => {
    const w = wallDoc(span, { door: CONST.WALL_DOOR_TYPES.DOOR, art: `${ART}/undead/door.webp` });
    expect(w.animation.texture).toBe(`${ART}/undead/door.webp`);
  });
  it("leaves a door wall with no art exactly as before", () => {
    const w = wallDoc(span, { door: CONST.WALL_DOOR_TYPES.DOOR });
    expect("animation" in w).toBe(false);
  });
  it("never puts animation on a non-door wall, even with art", () => {
    const w = wallDoc(span, { art: `${ART}/undead/door.webp` });
    expect("animation" in w).toBe(false);
    expect(w.door).toBe(CONST.WALL_DOOR_TYPES.NONE);
  });
  it("does not change the geometry, state or flags", () => {
    const flags = { [MODULE_ID]: { x: 1 } };
    const w = wallDoc(span, { door: CONST.WALL_DOOR_TYPES.DOOR, ds: CONST.WALL_DOOR_STATES.LOCKED, flags, art: `${ART}/undead/door.webp` });
    expect(w.c).toEqual([0, 0, 100, 0]);
    expect(w.ds).toBe(CONST.WALL_DOOR_STATES.LOCKED);
    expect(w.flags[MODULE_ID]).toBe(flags[MODULE_ID]);
  });
});

describe("wallDoc door texture scale (#800)", () => {
  beforeEach(installFoundryStubs);
  const art = `${ART}/undead/door.webp`;

  it("sets core.textureGridSize so the strip keeps its aspect on a one-square door", () => {
    const w = wallDoc({ x1: 0, y1: 0, x2: 1, y2: 0 }, { door: CONST.WALL_DOOR_TYPES.DOOR, art });
    expect(w.flags.core.textureGridSize).toBe(DOOR_TEXTURE_WIDTH_PX);
  });
  it("scales the value with the door length in squares", () => {
    const w = wallDoc({ x1: 0, y1: 0, x2: 3, y2: 0 }, { door: CONST.WALL_DOOR_TYPES.DOOR, art });
    expect(w.flags.core.textureGridSize).toBe(DOOR_TEXTURE_WIDTH_PX / 3);
  });
  it("uses the wall length for a vertical door", () => {
    const w = wallDoc({ x1: 2, y1: 1, x2: 2, y2: 2 }, { door: CONST.WALL_DOOR_TYPES.DOOR, art });
    expect(w.flags.core.textureGridSize).toBe(DOOR_TEXTURE_WIDTH_PX);
  });
  it("keeps the caller's own flags alongside", () => {
    const flags = { [MODULE_ID]: { x: 1 }, core: { other: true } };
    const w = wallDoc({ x1: 0, y1: 0, x2: 1, y2: 0 }, { door: CONST.WALL_DOOR_TYPES.DOOR, art, flags });
    expect(w.flags[MODULE_ID]).toEqual({ x: 1 });
    expect(w.flags.core.other).toBe(true);
    expect(w.flags.core.textureGridSize).toBe(DOOR_TEXTURE_WIDTH_PX);
  });
  it("adds no core flag without art or on a non-door wall", () => {
    expect(wallDoc({ x1: 0, y1: 0, x2: 1, y2: 0 }, { door: CONST.WALL_DOOR_TYPES.DOOR }).flags).toBeUndefined();
    expect(wallDoc({ x1: 0, y1: 0, x2: 1, y2: 0 }, { art }).flags).toBeUndefined();
  });
});

describe("scene door wiring (#750)", () => {
  beforeEach(installFoundryStubs);

  const seed = "door-art-seed-0";
  const S = "room-s";
  const A = "room-a";
  const layoutPositionByRoomId = { [S]: { rank: 0, col: 2 }, [A]: { rank: 1, col: 2 } };
  const occupiedCells = { "0,2": S, "1,2": A };
  const incomingFaceByRoomId = { [S]: "north", [A]: "north" };
  const edges = { [S]: [A] };
  const layoutEdges = { [S]: [A] };
  const baseState = (rooms) => ({
    seed, layoutPositionByRoomId, incomingFaceByRoomId, hiddenRooms: [], edges, layoutEdges,
    hiddenIncomingByRoomId: {}, hiddenEdges: {}, layoutVersion: 2, rooms,
  });
  const buildSource = (scene) => buildRoomAtGraphNode(scene, S, {
    rank: 0, col: 2, childIds: [A], incomingConnections: [], seed,
    layoutPositionByRoomId, occupiedCells, incomingFace: "north", incomingFaceByRoomId,
    edges, layoutEdges, hiddenIncomingByRoomId: {}, hiddenEdges: {}, layoutVersion: 2,
    locationTag: "undead",
  });

  it("a real gate door and its reveal door get art from their own rooms' themes", async () => {
    const scene = makeFakeScene();
    await buildSource(scene);
    await buildPopulateAndUnlockGraphNode(
      scene,
      baseState({ [S]: { locationTag: "undead" }, [A]: { locationTag: "fiend" } }),
      { id: A, kind: "narrative", isGoal: false, locationTag: "fiend", artVariant: 0, setpieceId: null },
      { rank: 1, col: 2, childIds: [], unlock: false },
    );
    const gate = scene.walls.find((w) => w.getFlag(MODULE_ID, "dungeonDoorToRoomId") === A);
    const reveal = scene.walls.find((w) => w.getFlag(MODULE_ID, "dungeonRevealDoorForSlot") === A);
    expect(gate.animation.texture).toBe(`${ART}/undead/door.webp`);
    expect(reveal.animation.texture).toBe(`${ART}/fiend/door.webp`);
  });

  it("falls back to a native door when the theme is null or has no door art", async () => {
    const scene = makeFakeScene();
    await buildSource(scene);
    await buildPopulateAndUnlockGraphNode(
      scene,
      baseState({ [S]: { locationTag: null }, [A]: { locationTag: "plant" } }),
      { id: A, kind: "narrative", isGoal: false, locationTag: "plant", artVariant: 0, setpieceId: null },
      { rank: 1, col: 2, childIds: [], unlock: false },
    );
    const doors = scene.walls.filter((w) => w.door === CONST.WALL_DOOR_TYPES.DOOR);
    expect(doors.length).toBeGreaterThan(0);
    for (const d of doors) expect("animation" in d).toBe(false);
  });

  it("falls back to native doors when the manifest could not be loaded", async () => {
    loadRoomFeatureArt.mockResolvedValueOnce({});
    loadRoomFeatureArt.mockResolvedValueOnce({});
    const scene = makeFakeScene();
    await buildSource(scene);
    await buildPopulateAndUnlockGraphNode(
      scene,
      baseState({ [S]: { locationTag: "undead" }, [A]: { locationTag: "fiend" } }),
      { id: A, kind: "narrative", isGoal: false, locationTag: "fiend", artVariant: 0, setpieceId: null },
      { rank: 1, col: 2, childIds: [], unlock: false },
    );
    for (const w of scene.walls) expect("animation" in w).toBe(false);
  });

  it("tolerates a state with no rooms map", async () => {
    const scene = makeFakeScene();
    await buildSource(scene);
    const state = baseState(undefined);
    delete state.rooms;
    await expect(buildPopulateAndUnlockGraphNode(
      scene, state,
      { id: A, kind: "narrative", isGoal: false, locationTag: null, artVariant: 0, setpieceId: null },
      { rank: 1, col: 2, childIds: [], unlock: false },
    )).resolves.not.toThrow();
  });
});

describe("door floor-variant and locked-state art (#764)", () => {
  beforeEach(installFoundryStubs);

  const seed = "door-art-seed-0";
  const S = "room-s";
  const A = "room-a";
  const layoutPositionByRoomId = { [S]: { rank: 0, col: 2 }, [A]: { rank: 1, col: 2 } };
  const occupiedCells = { "0,2": S, "1,2": A };
  const incomingFaceByRoomId = { [S]: "north", [A]: "north" };
  const edges = { [S]: [A] };
  const layoutEdges = { [S]: [A] };
  const baseState = (rooms) => ({
    seed, layoutPositionByRoomId, incomingFaceByRoomId, hiddenRooms: [], edges, layoutEdges,
    hiddenIncomingByRoomId: {}, hiddenEdges: {}, layoutVersion: 2, rooms,
  });
  const buildSource = (scene, artVariant = 0) => buildRoomAtGraphNode(scene, S, {
    rank: 0, col: 2, childIds: [A], incomingConnections: [], seed,
    layoutPositionByRoomId, occupiedCells, incomingFace: "north", incomingFaceByRoomId,
    edges, layoutEdges, hiddenIncomingByRoomId: {}, hiddenEdges: {}, layoutVersion: 2,
    locationTag: "undead", artVariant,
  });
  const populate = (scene, rooms) => buildPopulateAndUnlockGraphNode(
    scene, baseState(rooms),
    { id: A, kind: "narrative", isGoal: false, locationTag: "fiend", artVariant: 1, setpieceId: null },
    { rank: 1, col: 2, childIds: [], unlock: false },
  );
  const gateOf = (scene) => scene.walls.find((w) => w.getFlag(MODULE_ID, "dungeonDoorToRoomId") === A);
  const revealOf = (scene) => scene.walls.find((w) => w.getFlag(MODULE_ID, "dungeonRevealDoorForSlot") === A);
  const stubsOf = (scene) => scene.walls.filter((w) => w.getFlag(MODULE_ID, "dungeonStubDoorFor"));

  it("gives the reveal door its room's floor-variant art", async () => {
    loadRoomFeatureArt.mockResolvedValue({
      undead: { door: [0, 1] }, fiend: { door: [0, 1] },
    });
    const scene = makeFakeScene();
    await buildSource(scene);
    await populate(scene, { [S]: { locationTag: "undead", artVariant: 0 }, [A]: { locationTag: "fiend", artVariant: 1 } });
    expect(revealOf(scene).animation.texture).toBe(`${ART}/fiend/door-1.webp`);
    expect(gateOf(scene).animation.texture).toBe(`${ART}/undead/door.webp`);
  });

  it("uses the locked art for a locked gate, from the source room's theme and variant", async () => {
    loadRoomFeatureArt.mockResolvedValue({
      undead: { door: [0, 1], door_locked: [0] }, fiend: { door: [0, 1], door_locked: [0] },
    });
    const scene = makeFakeScene();
    await buildSource(scene);
    await populate(scene, { [S]: { locationTag: "undead", artVariant: 1 }, [A]: { locationTag: "fiend", artVariant: 1 } });
    expect(gateOf(scene).animation.texture).toBe(`${ART}/undead/door_locked.webp`);
    // the reveal door is CLOSED, so it keeps the plain variant art.
    expect(revealOf(scene).animation.texture).toBe(`${ART}/fiend/door-1.webp`);
    expect(gateOf(scene).flags.core.textureGridSize).toBe(DOOR_TEXTURE_WIDTH_PX);
  });

  it("uses the locked art for a locked stub door", async () => {
    loadRoomFeatureArt.mockResolvedValue({ undead: { door: [0], door_locked: [0] } });
    const scene = makeFakeScene();
    await buildRoomAtGraphNode(scene, S, {
      rank: 0, col: 2, childIds: [], incomingConnections: [], seed,
      layoutPositionByRoomId, occupiedCells: { "0,2": S }, incomingFace: "north", incomingFaceByRoomId,
      edges: {}, layoutEdges, hiddenIncomingByRoomId: {}, hiddenEdges: {}, layoutVersion: 3,
      stubEdges: { [S]: [A] }, locationTag: "undead",
    });
    const stubs = stubsOf(scene);
    for (const d of stubs) expect(d.animation.texture).toBe(`${ART}/undead/door_locked.webp`);
  });

  it("falls back to the variant-matched door art when there is no door_locked entry", async () => {
    loadRoomFeatureArt.mockResolvedValue({
      undead: { door: [0, 1] }, fiend: { door: [0, 1] },
    });
    const scene = makeFakeScene();
    await buildSource(scene);
    await populate(scene, { [S]: { locationTag: "undead", artVariant: 1 }, [A]: { locationTag: "fiend", artVariant: 1 } });
    expect(gateOf(scene).ds).toBe(CONST.WALL_DOOR_STATES.LOCKED);
    expect(gateOf(scene).animation.texture).toBe(`${ART}/undead/door-1.webp`);
  });

  describe("unlockDoorsFromRoom", () => {
    const runWith = (rooms) => {
      globalThis.game = { settings: { get: () => ({ "test-scene": { rooms } }) } };
    };
    const lockedDoor = (extra = {}) => {
      const doc = {
        id: "w1", ds: CONST.WALL_DOOR_STATES.LOCKED,
        animation: { type: "swing", texture: `${ART}/undead/door_locked.webp` },
        flags: { core: { textureGridSize: DOOR_TEXTURE_WIDTH_PX } },
        getFlag: (m, k) => ({ dungeonDoorToRoomId: A, dungeonDoorFromRoomId: S, ...extra })[k],
        update: vi.fn(async (c) => Object.assign(doc, c)),
      };
      return doc;
    };

    it("swaps a locked door's texture back to the room's variant door art, touching only the texture", async () => {
      loadRoomFeatureArt.mockResolvedValue({ undead: { door: [0, 1], door_locked: [0] } });
      runWith({ [S]: { locationTag: "undead", artVariant: 1 } });
      const wall = lockedDoor();
      await unlockDoorsFromRoom({ id: "test-scene", walls: [wall] }, S, [A]);
      expect(wall.ds).toBe(CONST.WALL_DOOR_STATES.CLOSED);
      expect(wall.animation.texture).toBe(`${ART}/undead/door-1.webp`);
      expect(wall.animation.type).toBe("swing");
      expect(wall.flags.core.textureGridSize).toBe(DOOR_TEXTURE_WIDTH_PX);
      expect(Object.keys(wall.update.mock.calls[0][0]).sort()).toEqual(["animation", "ds"]);
    });

    it("only changes ds when the door has no animation or there is no door art", async () => {
      loadRoomFeatureArt.mockResolvedValue({});
      runWith({ [S]: { locationTag: "undead", artVariant: 0 } });
      const wall = lockedDoor();
      await unlockDoorsFromRoom({ id: "test-scene", walls: [wall] }, S, [A]);
      expect(wall.update).toHaveBeenCalledWith({ ds: CONST.WALL_DOOR_STATES.CLOSED });
    });

    it("tolerates no run state at all", async () => {
      loadRoomFeatureArt.mockResolvedValue({ undead: { door: [0] } });
      globalThis.game = { settings: { get: () => ({}) } };
      const wall = lockedDoor();
      await unlockDoorsFromRoom({ id: "test-scene", walls: [wall] }, S, [A]);
      expect(wall.update).toHaveBeenCalledWith({ ds: CONST.WALL_DOOR_STATES.CLOSED });
    });
  });
});
