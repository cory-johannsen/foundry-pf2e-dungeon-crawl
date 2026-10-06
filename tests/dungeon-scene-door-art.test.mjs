import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../scripts/data-loader.mjs", async (importOriginal) => {
  const real = await importOriginal();
  return {
    ...real,
    loadRoomFeatureArt: vi.fn(async () => ({
      undead: ["door", "treasure", "puzzle", "skill_challenge"],
      fiend: ["door"],
    })),
  };
});

import { wallDoc, buildPopulateAndUnlockGraphNode, buildRoomAtGraphNode } from "../scripts/dungeon-scene.mjs";
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
