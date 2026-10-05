import { describe, it, expect, vi, beforeEach } from "vitest";

// #754: build-time trap placement is independent of room kind.
const roll = vi.hoisted(() => ({ succeeds: true }));
const calls = vi.hoisted(() => ({ order: [] }));

vi.mock("../scripts/dungeon-deck.mjs", async (importOriginal) => ({
  ...(await importOriginal()),
  trapRollSucceeds: vi.fn(() => roll.succeeds),
}));
vi.mock("../scripts/encounter-generator.mjs", () => ({
  generateEncounter: vi.fn(async ({ scene, extraFlags }) => {
    calls.order.push("encounter");
    scene.addToken({ dungeonSlot: extraFlags["pf2e-dungeon-crawl"].dungeonSlot });
  }),
}));
vi.mock("../scripts/trap-library.mjs", () => ({
  selectTrap: vi.fn(async () => ({ pack: "pf2e.hazards", id: "trap1" })),
}));
vi.mock("../scripts/foundry-api.mjs", () => ({
  makeFoundryApi: (scene) => ({
    partyLevel: async () => 3,
    spawnCreatures: async (_specs, { extraFlags }) => {
      calls.order.push("trap");
      scene?.addToken({ ...extraFlags["pf2e-dungeon-crawl"] });
      return [{ actorId: "no-such-actor", tokenId: "t" }];
    },
  }),
}));

import { buildPopulateAndUnlockGraphNode } from "../scripts/dungeon-scene.mjs";
import { trapRollSucceeds } from "../scripts/dungeon-deck.mjs";

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
  calls.order.length = 0;
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
