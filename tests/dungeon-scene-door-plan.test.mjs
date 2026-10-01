// #415 Chunk 4: layoutVersion 2 consumes outgoingDoorPlan in the scene. Source S
// (rank 0, col 2) has a real south child A (same column) and a HIDDEN child H in
// a lower column. Legacy puts H on a different face by child index; the plan
// puts both on south, as two one-cell doors.
import { describe, it, expect } from 'vitest';
import { buildRoomAtGraphNode, buildPopulateAndUnlockGraphNode } from '../scripts/dungeon-scene.mjs';
import { roomRect } from '../scripts/dungeon-layout.mjs';

const MODULE_ID = 'pf2e-dungeon-crawl';
const GRID_SIZE = 100;
const toPixels = (v) => v * GRID_SIZE;

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

describe('scene wiring — #415 outgoing door plan (layoutVersion 2)', () => {
  const seed = 'door-plan-seed-0';
  const S = 'room-s';
  const A = 'room-a';
  const H = 'room-h';
  const layoutPositionByRoomId = {
    [S]: { rank: 0, col: 2 }, [A]: { rank: 1, col: 2 }, [H]: { rank: 2, col: 0 },
  };
  const occupiedCells = { '0,2': S, '1,2': A, '2,0': H };
  const incomingFaceByRoomId = { [S]: 'north', [A]: 'north', [H]: 'north' };
  const edges = { [S]: [A] };
  const hiddenEdges = { [S]: [H] };
  const layoutEdges = { [S]: [A, H] };
  const hiddenIncomingByRoomId = { [H]: [S] };
  const srcRect = roomRect(seed, S, 0, 2);
  const faceY = toPixels(srcRect.gy + srcRect.gh);
  const buildSource = (scene, layoutVersion) => buildRoomAtGraphNode(scene, S, {
    rank: 0, col: 2, childIds: [A], hiddenChildId: H, incomingConnections: [],
    seed, layoutPositionByRoomId, occupiedCells, incomingFace: 'north',
    incomingFaceByRoomId, edges, layoutEdges, hiddenIncomingByRoomId, hiddenEdges,
    ...(layoutVersion ? { layoutVersion } : {}),
  });
  const southLine = (w) => w.c[1] === faceY && w.c[3] === faceY;
  const lengthX = (w) => Math.abs(w.c[2] - w.c[0]);
  const lo = (w) => Math.min(w.c[0], w.c[2]);
  const hi = (w) => Math.max(w.c[0], w.c[2]);

  it('version 2: both children on south, each placeholder covers only its own one-cell door', async () => {
    installFoundryStubs();
    const scene = makeFakeScene();
    await buildSource(scene, 2);
    const frontier = scene.walls.filter((w) => w.getFlag(MODULE_ID, 'dungeonFrontierWallForEdge') === `${S}->${A}`);
    const hidden = scene.walls.filter((w) => w.getFlag(MODULE_ID, 'dungeonHiddenDoorForEdge') === `${S}->${H}`);
    expect(frontier).toHaveLength(1);
    expect(hidden).toHaveLength(1);
    expect(hidden[0].ds).toBe(CONST.WALL_DOOR_STATES.LOCKED);
    for (const w of [frontier[0], hidden[0]]) {
      expect(southLine(w)).toBe(true);
      expect(lengthX(w)).toBe(toPixels(1));
    }
    // the face is solid except exactly the two doors: enclosure + placeholders tile it
    const enclosure = scene.walls.filter((w) => w.getFlag(MODULE_ID, 'dungeonEnclosureWallDirection') === 'south');
    expect(enclosure.length).toBeGreaterThan(0);
    const covered = [...enclosure, frontier[0], hidden[0]].map((w) => [lo(w), hi(w)]).sort((a, b) => a[0] - b[0]);
    expect(covered[0][0]).toBe(toPixels(srcRect.gx));
    expect(covered.at(-1)[1]).toBe(toPixels(srcRect.gx + srcRect.gw));
    for (let k = 1; k < covered.length; k += 1) expect(covered[k][0]).toBe(covered[k - 1][1]);
    // hidden (lower column) takes the left door
    expect(lo(hidden[0])).toBeLessThan(lo(frontier[0]));
    // nothing on the east face (legacy would have put the hidden door there)
    expect(scene.walls.some((w) => w.c[0] === w.c[2] && w.getFlag(MODULE_ID, 'dungeonHiddenDoorForEdge'))).toBe(false);
  });

  it('version 1 (and an absent version) keeps the legacy full-face placeholders', async () => {
    installFoundryStubs();
    for (const v of [undefined, 1]) {
      const scene = makeFakeScene();
      await buildSource(scene, v);
      const frontier = scene.walls.find((w) => w.getFlag(MODULE_ID, 'dungeonFrontierWallForEdge') === `${S}->${A}`);
      const hidden = scene.walls.find((w) => w.getFlag(MODULE_ID, 'dungeonHiddenDoorForEdge') === `${S}->${H}`);
      expect(lengthX(frontier)).toBe(toPixels(srcRect.gw));
      expect(southLine(frontier)).toBe(true);
      expect(hidden.c[0]).toBe(hidden.c[2]); // east face (child index 1), vertical
    }
  });

  it('version 2: the hidden target builds its gate at the planned door and nothing seals the source face', async () => {
    installFoundryStubs();
    const scene = makeFakeScene();
    await buildSource(scene, 2);
    const state = {
      seed, layoutPositionByRoomId, incomingFaceByRoomId, hiddenRooms: [], edges, layoutEdges,
      hiddenIncomingByRoomId, hiddenEdges, layoutVersion: 2,
    };
    const hiddenPlaceholder = scene.walls.find((w) => w.getFlag(MODULE_ID, 'dungeonHiddenDoorForEdge') === `${S}->${H}`);
    const frontier = scene.walls.find((w) => w.getFlag(MODULE_ID, 'dungeonFrontierWallForEdge') === `${S}->${A}`);
    const placeholderLo = lo(hiddenPlaceholder);
    const before = new Set(scene.walls.map((w) => w.id));
    await buildPopulateAndUnlockGraphNode(scene, state, {
      id: H, kind: 'narrative', isGoal: false, locationTag: null, artVariant: 0, setpieceId: null,
    }, { rank: 2, col: 0, childIds: [], unlock: false });
    const created = scene.walls.filter((w) => !before.has(w.id));
    const gate = created.find((w) => w.getFlag(MODULE_ID, 'dungeonHiddenDoorRole') === 'gate'
      && w.getFlag(MODULE_ID, 'dungeonHiddenDoorForEdge') === `${S}->${H}`);
    expect(gate).toBeDefined();
    // the gate door is exactly the placeholder's span; the placeholder was superseded
    expect([lo(gate), gate.c[1]]).toEqual([placeholderLo, faceY]);
    expect(scene.walls.includes(hiddenPlaceholder)).toBe(false);
    // A's placeholder is untouched, and no wall the child built covers A's door
    expect(scene.walls.includes(frontier)).toBe(true);
    for (const w of created.filter(southLine)) {
      expect(hi(w) <= lo(frontier) || lo(w) >= hi(frontier)).toBe(true);
    }
  });
});
