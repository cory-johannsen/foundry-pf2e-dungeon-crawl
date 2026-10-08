// #427 Task 2.1: layoutVersion 3 hands the merge room's incoming door slots out by incomingDoorOrder;
// v1/v2 keep the list order. sweep-0's room-merge-3 (rank 3, col 0) has two real parents: room-room-entry-1
// (rank 1, col 2, east of it) listed first, and its co-parent room-room-room-entry-0-0 (rank 2, col 0).
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { NEW_RUN_LAYOUT_VERSION } from '../scripts/dungeon-layout.mjs';
import { buildPopulateAndUnlockGraphNode } from '../scripts/dungeon-scene.mjs';
import { buildSweepLayout } from './helpers/layout-sweep.mjs';
import { buildSweepScene, sealedDoors } from './helpers/scene-oracle.mjs';

const MODULE_ID = 'pf2e-dungeon-crawl';
const TARGET = 'room-merge-3';
const EAST_PARENT = 'room-room-entry-1';
const CO_PARENT = 'room-room-room-entry-0-0';

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
    async deleteEmbeddedDocuments() {},
  };
}

async function doorXByParent(layoutVersion) {
  installFoundryStubs();
  const L = buildSweepLayout(0, { layoutVersion });
  const scene = makeFakeScene();
  const state = {
    seed: L.seed, layoutPositionByRoomId: L.pos, incomingFaceByRoomId: L.incFace, hiddenRooms: L.hiddenRooms,
    edges: L.edges, layoutEdges: L.layoutEdges, hiddenIncomingByRoomId: L.hiddenIncomingByRoomId,
    hiddenEdges: L.hiddenEdges, layoutVersion,
  };
  await buildPopulateAndUnlockGraphNode(scene, state, {
    id: TARGET, kind: 'narrative', isGoal: false, locationTag: null, artVariant: 0, setpieceId: null,
  }, { rank: L.pos[TARGET].rank, col: L.pos[TARGET].col, childIds: L.edges[TARGET] ?? [], unlock: false });
  const door = (from) => scene.walls.find((w) => w.getFlag(MODULE_ID, 'dungeonRevealDoorForSlot') === TARGET
    && w.getFlag(MODULE_ID, 'dungeonDoorFromRoomId') === from);
  return {
    east: Math.min(door(EAST_PARENT).c[0], door(EAST_PARENT).c[2]),
    co: Math.min(door(CO_PARENT).c[0], door(CO_PARENT).c[2]),
  };
}

describe('scene wiring: incoming door order (#427, layoutVersion 3)', () => {
  it('version 3: the east parent gets the slot east of its co-parent', async () => {
    const { east, co } = await doorXByParent(3);
    expect(co).toBeLessThan(east);
  });
  it('version 2 keeps the list order (east parent first, west slot)', async () => {
    const { east, co } = await doorXByParent(2);
    expect(east).toBeLessThan(co);
  });
});

describe('layoutVersion stamp (#427)', () => {
  it('new runs are version 3, stamped from the one constant', () => {
    expect(NEW_RUN_LAYOUT_VERSION).toBe(3);
    const app = readFileSync(new URL('../scripts/ui/dungeon-app.mjs', import.meta.url), 'utf8');
    expect(app).toMatch(/layoutVersion: NEW_RUN_LAYOUT_VERSION,/);
    expect(app).not.toMatch(/layoutVersion: [0-9]/);
  });
});

// Scene-level oracle: every room of a sweep layout built through the real scene builder, then asked which door
// spans are (even partly) covered by a collinear solid wall. v2 is the baseline (its own known residuals, #231
// and #309); v3 may not exceed it. The ceilings only fall.
const ORACLE_SEEDS = 200;
const V2_SEALED_DOORS = 689;
const V3_SEALED_DOORS_CEILING = 619;
describe('scene oracle: sealed doors (#427)', () => {
  const count = async (v) => {
    let sealed = 0;
    let doors = 0;
    for (let i = 0; i < ORACLE_SEEDS; i += 1) {
      const r = sealedDoors((await buildSweepScene(i, v)).scene);
      sealed += r.sealed;
      doors += r.doors;
    }
    return { sealed, doors };
  };
  it('v2 baseline is reproduced exactly (the harness is the same one that measures v3)', async () => {
    const v2 = await count(2);
    expect(v2.doors).toBeGreaterThan(7000);
    expect(v2.sealed).toBe(V2_SEALED_DOORS);
  }, 120000);
  it('v3 seals fewer doors than v2, and no more than its ceiling', async () => {
    const v3 = await count(3);
    expect(v3.sealed).toBeLessThan(V2_SEALED_DOORS);
    expect(v3.sealed).toBeLessThanOrEqual(V3_SEALED_DOORS_CEILING);
  }, 120000);
});
