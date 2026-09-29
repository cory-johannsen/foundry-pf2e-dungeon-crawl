import { describe, it, expect } from 'vitest';
import { buildRoomAtGraphNode } from '../scripts/dungeon-scene.mjs';
import {
  pendingForeignMarginOpenings, cellMarginWalls, roomRect,
} from '../scripts/dungeon-layout.mjs';

const MODULE_ID = 'pf2e-dungeon-crawl'; // matches dungeon-scene.mjs's own private MODULE_ID constant
const GRID_SIZE = 100; // matches dungeon-scene.mjs's own private GRID_SIZE constant
const toPixels = (gridVal) => gridVal * GRID_SIZE;

function installFoundryStubs() {
  globalThis.CONST = {
    WALL_DOOR_TYPES: { NONE: 0, DOOR: 1, SECRET: 2 },
    WALL_DOOR_STATES: { CLOSED: 0, OPEN: 1, LOCKED: 2 },
    WALL_SENSE_TYPES: { NONE: 0, NORMAL: 20 },
    WALL_MOVEMENT_TYPES: { NONE: 0, NORMAL: 20 },
  };
}

// Minimal fake Foundry Scene: just enough of createEmbeddedDocuments /
// deleteEmbeddedDocuments / walls / tiles for buildRoomAtGraphNode to run
// end to end and leave real, inspectable Wall documents behind (mirrors
// real Foundry's own "created embedded documents land back in the
// collection" behavior).
function makeFakeScene() {
  const walls = [];
  const tiles = [];
  let nextId = 0;
  return {
    id: 'test-scene',
    walls,
    tiles,
    async createEmbeddedDocuments(type, docs) {
      const created = docs.map((data) => {
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
      return created;
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

describe('buildRoomAtGraphNode — #297 pending foreign margin openings', () => {
  it("wires a blocking room's own margin walls with a south (not east) gap for the dogleg routed through it", async () => {
    installFoundryStubs();
    // Same dogleg-repro scenario pendingForeignMarginOpenings's own
    // dungeon-layout.test.mjs describe block pins: from-room (rank 0) ->
    // to-room (rank 2), same column, with blocker-room sitting directly
    // between them at rank 1 -- the room actually built in this test.
    const seed = 'dogleg-repro-seed-0';
    const fromRoomId = 'from-room';
    const toRoomId = 'to-room';
    const blockerRoomId = 'blocker-room';
    const layoutPositionByRoomId = {
      [fromRoomId]: { rank: 0, col: 0 },
      [blockerRoomId]: { rank: 1, col: 0 },
      [toRoomId]: { rank: 2, col: 0 },
    };
    const edges = { [fromRoomId]: [toRoomId, blockerRoomId] };
    const occupiedCells = { '0,0': fromRoomId, '1,0': blockerRoomId, '2,0': toRoomId };
    const incomingFaceByRoomId = { [toRoomId]: 'north', [blockerRoomId]: 'north' };

    const scene = makeFakeScene();
    await buildRoomAtGraphNode(scene, blockerRoomId, {
      rank: 1, col: 0, childIds: [], incomingConnections: [],
      seed, layoutPositionByRoomId, occupiedCells,
      incomingFace: 'north', incomingFaceByRoomId, edges,
    });

    // Cross-check against pendingForeignMarginOpenings's own return for the
    // SAME inputs, fed into cellMarginWalls (both pure, both already
    // independently tested) -- never a second, independently hardcoded
    // expected value, the same "don't hardcode a second copy of the
    // numbers" principle as dungeon-layout.test.mjs's own
    // pendingForeignMarginOpenings tests.
    const foreignOpenings = pendingForeignMarginOpenings(
      seed, blockerRoomId, 1, 0, edges, layoutPositionByRoomId, incomingFaceByRoomId, occupiedCells,
    );
    expect(foreignOpenings.south).toHaveLength(1);
    expect(foreignOpenings.east).toEqual([]);

    const rect = roomRect(seed, blockerRoomId, 1, 0);
    const expectedMarginWalls = cellMarginWalls(rect, 1, 0, {
      east: [...foreignOpenings.east],
      south: [...foreignOpenings.south],
    });
    const byCoords = ({ x1, y1, x2, y2 }) => ({ x1, y1, x2, y2 });
    const expectedByCoords = expectedMarginWalls
      .map(({ x1, y1, x2, y2 }) => byCoords({ x1: toPixels(x1), y1: toPixels(y1), x2: toPixels(x2), y2: toPixels(y2) }))
      .sort((a, b) => a.x1 - b.x1 || a.y1 - b.y1 || a.x2 - b.x2 || a.y2 - b.y2);

    const actualMarginWalls = scene.walls.filter(
      (w) => w.getFlag(MODULE_ID, 'dungeonCellMarginWallForRoom') === blockerRoomId,
    );
    expect(actualMarginWalls).toHaveLength(expectedMarginWalls.length);
    const actualByCoords = actualMarginWalls
      .map((w) => byCoords({ x1: w.c[0], y1: w.c[1], x2: w.c[2], y2: w.c[3] }))
      .sort((a, b) => a.x1 - b.x1 || a.y1 - b.y1 || a.x2 - b.x2 || a.y2 - b.y2);
    expect(actualByCoords).toEqual(expectedByCoords);

    // Explicitly confirm the gap really landed on the blocking room's SOUTH
    // wall, not its east one -- the exact defect Task 2's own review
    // rounds found and fixed in foreignOpening.side. A south wall segment
    // is horizontal (y1 === y2); an east one is vertical (x1 === x2).
    const southMarginWalls = actualMarginWalls.filter((w) => w.c[1] === w.c[3]);
    const eastMarginWalls = actualMarginWalls.filter((w) => w.c[0] === w.c[2]);
    expect(southMarginWalls.length).toBeGreaterThan(0);
    // Two south segments (before/after the gap) -- the gap itself is a real
    // interruption, not just a coincidentally-placed single wall.
    expect(southMarginWalls.length).toBe(2);
    // The east side carries none of this foreign opening: fully sealed by
    // a single, unbroken wall spanning the whole cell height.
    expect(eastMarginWalls.length).toBe(1);
  });
});
