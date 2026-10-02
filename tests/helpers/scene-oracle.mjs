// tests/helpers/scene-oracle.mjs
// Scene-level check for #427: build every room of a sweep layout through the real scene builder on a fake
// Foundry scene, then ask questions of the REAL walls (not the pure geometry's claims).
import { buildPopulateAndUnlockGraphNode } from '../../scripts/dungeon-scene.mjs';
import { buildSweepLayout } from './layout-sweep.mjs';

const MODULE_ID = 'pf2e-dungeon-crawl';

export function installFoundryStubs() {
  globalThis.CONST = {
    WALL_DOOR_TYPES: { NONE: 0, DOOR: 1, SECRET: 2 },
    WALL_DOOR_STATES: { CLOSED: 0, OPEN: 1, LOCKED: 2 },
    WALL_SENSE_TYPES: { NONE: 0, NORMAL: 20 },
    WALL_MOVEMENT_TYPES: { NONE: 0, NORMAL: 20 },
  };
}

export function makeFakeScene() {
  const walls = [];
  const tiles = [];
  let nextId = 0;
  return {
    id: 'test-scene',
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
        if (type === 'Wall') walls.push(doc);
        if (type === 'Tile') tiles.push(doc);
        return doc;
      });
    },
    async deleteEmbeddedDocuments(type, ids) {
      const arr = type === 'Wall' ? walls : tiles;
      for (const id of ids) {
        const idx = arr.findIndex((d) => d.id === id);
        if (idx >= 0) arr.splice(idx, 1);
      }
    },
  };
}

/** Builds every room of `buildSweepLayout(i, { layoutVersion })` and returns `{ layout, scene }`. */
export async function buildSweepScene(i, layoutVersion) {
  installFoundryStubs();
  const L = buildSweepLayout(i, { layoutVersion });
  const scene = makeFakeScene();
  const state = {
    seed: L.seed, layoutPositionByRoomId: L.pos, incomingFaceByRoomId: L.incFace, hiddenRooms: L.hiddenRooms,
    edges: L.edges, layoutEdges: L.layoutEdges, hiddenIncomingByRoomId: L.hiddenIncomingByRoomId,
    hiddenEdges: L.hiddenEdges, layoutVersion, maxRank: 20,
  };
  for (const id of Object.keys(L.rooms)) {
    await buildPopulateAndUnlockGraphNode(scene, state, {
      id, kind: 'narrative', isGoal: false, locationTag: null, artVariant: 0, setpieceId: null,
    }, {
      rank: L.pos[id].rank, col: L.pos[id].col, childIds: L.edges[id] ?? [],
      hiddenChildId: (L.hiddenEdges[id] ?? [])[0] ?? null, unlock: false,
    });
  }
  return { layout: L, scene };
}

const overlapsOnLine = (w, d) => {
  const [x1, y1, x2, y2] = d.c;
  const [a, b, c, e] = w.c;
  if (y1 === y2) return b === y1 && e === y1 && Math.max(Math.min(a, c), Math.min(x1, x2)) < Math.min(Math.max(a, c), Math.max(x1, x2));
  return a === x1 && c === x1 && Math.max(Math.min(b, e), Math.min(y1, y2)) < Math.min(Math.max(b, e), Math.max(y1, y2));
};

/** Door walls whose span is covered, even partly, by a collinear SOLID wall (the door cannot be walked
 * through in full): `{ doors, sealed, byFlag }`. */
export function sealedDoors(scene) {
  const solid = scene.walls.filter((w) => !w.door);
  const doors = scene.walls.filter((w) => w.door);
  const sealed = doors.filter((d) => solid.some((w) => overlapsOnLine(w, d)));
  return {
    doors: doors.length,
    sealed: sealed.length,
    sealedDoorWalls: sealed.map((d) => ({ coords: d.c, flags: d.flags?.[MODULE_ID] ?? {} })),
  };
}
