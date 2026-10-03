import { describe, it, expect } from 'vitest';
import { effectiveRoomBias, buildRoomAtGraphNode, buildPopulateAndUnlockGraphNode } from '../scripts/dungeon-scene.mjs';
import {
  pendingForeignMarginOpenings, cellMarginWalls, roomRect, cellBounds,
  buildEdgeCorridor, doorSlotsForFace, findPriorityCollision, assignDoorSlotsWithPriority,
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
    // is horizontal (y1 === y2); an east one is vertical (x1 === x2) AND
    // sits at the cell's own east boundary specifically -- #353's own new
    // passage-cap walls for the south opening are ALSO vertical (they cap
    // that opening's own left/right sides), so "vertical" alone no longer
    // disambiguates east from south; the east boundary's own x-coordinate
    // does.
    const cell = cellBounds(1, 0);
    const eastBoundaryX = toPixels(cell.gx + cell.gw);
    const southMarginWalls = actualMarginWalls.filter((w) => w.c[1] === w.c[3]);
    const eastMarginWalls = actualMarginWalls.filter(
      (w) => w.c[0] === w.c[2] && w.c[0] === eastBoundaryX,
    );
    expect(southMarginWalls.length).toBeGreaterThan(0);
    // Two south segments (before/after the gap) -- the gap itself is a real
    // interruption, not just a coincidentally-placed single wall.
    expect(southMarginWalls.length).toBe(2);
    // The east side carries none of this foreign opening: fully sealed by
    // a single, unbroken wall spanning the whole cell height.
    expect(eastMarginWalls.length).toBe(1);
  });
});

describe('buildPopulateAndUnlockGraphNode — #297 Round 2 (slot priority)', () => {
  it("assigns the colliding co-parent connection a door that doesn't overlap or get covered by the other's walls, for the pinned collision scenario", async () => {
    installFoundryStubs();
    // Same pinned dogleg-repro scenario as tests/dungeon-layout.test.mjs's
    // own findPriorityCollision/assignDoorSlotsWithPriority describe
    // blocks: from-room (rank 0) and blocker-room (rank 1) are BOTH real
    // parents of to-room (rank 2, same column) -- from-room's own
    // connection routes through blocker-room's own cell (a dogleg), and
    // blocker-room turns out to be to-room's own co-parent (the #297
    // Round 2 collision this task's own slot-priority fix targets).
    const seed = 'dogleg-repro-seed-0';
    const fromRoomId = 'from-room';
    const blockerRoomId = 'blocker-room';
    const mergeRoomId = 'to-room';
    const layoutPositionByRoomId = {
      [fromRoomId]: { rank: 0, col: 0 },
      [blockerRoomId]: { rank: 1, col: 0 },
      [mergeRoomId]: { rank: 2, col: 0 },
    };
    // Object.entries insertion order matters here: from-room first (index
    // 0, the colliding connection), blocker-room second (index 1, the
    // co-parent) -- same order Task 2's own pinned scenario established.
    const layoutEdges = { [fromRoomId]: [mergeRoomId], [blockerRoomId]: [mergeRoomId] };
    const occupiedCells = { '0,0': fromRoomId, '1,0': blockerRoomId, '2,0': mergeRoomId };
    const incomingFaceByRoomId = { [fromRoomId]: 'north', [blockerRoomId]: 'north', [mergeRoomId]: 'north' };
    const state = {
      seed,
      layoutPositionByRoomId,
      incomingFaceByRoomId,
      hiddenRooms: [],
      edges: layoutEdges,
      layoutEdges,
      hiddenIncomingByRoomId: {},
      hiddenEdges: {},
    };
    const room = {
      id: mergeRoomId, kind: 'narrative', isGoal: false,
      locationTag: null, artVariant: 0, setpieceId: null,
    };

    const scene = makeFakeScene();
    await buildPopulateAndUnlockGraphNode(scene, state, room, {
      rank: 2, col: 0, childIds: [], unlock: false,
    });

    // Both connections' own real doors exist, with distinct
    // dungeonDoorFromRoomId flags (Review Focus item 2 -- no dropped or
    // duplicated connection).
    const doorWalls = scene.walls.filter((w) => w.getFlag(MODULE_ID, 'dungeonDoorToRoomId') === mergeRoomId);
    expect(doorWalls).toHaveLength(2);
    const doorFromIds = doorWalls.map((w) => w.getFlag(MODULE_ID, 'dungeonDoorFromRoomId')).sort();
    expect(doorFromIds).toEqual([blockerRoomId, fromRoomId].sort());

    const revealWalls = scene.walls.filter((w) => w.getFlag(MODULE_ID, 'dungeonRevealDoorForSlot') === mergeRoomId);
    expect(revealWalls).toHaveLength(2);
    const revealFor = (sourceId) => revealWalls.find((w) => w.getFlag(MODULE_ID, 'dungeonDoorFromRoomId') === sourceId);
    const fromReveal = revealFor(fromRoomId);
    const blockerReveal = revealFor(blockerRoomId);
    expect(fromReveal).toBeDefined();
    expect(blockerReveal).toBeDefined();
    // Every connection's own door is genuinely distinct (Review Focus item
    // 2 -- no duplicated slot).
    expect(fromReveal.c).not.toEqual(blockerReveal.c);

    // Cross-check against the pure functions this task adds (already
    // independently unit-tested in tests/dungeon-layout.test.mjs) rather
    // than a second, independently hardcoded copy of the expected
    // coordinates -- this file's own established pattern.
    const incomingConnections = [
      { sourceId: fromRoomId, hidden: false },
      { sourceId: blockerRoomId, hidden: false },
    ];
    const rect = roomRect(seed, mergeRoomId, 2, 0);
    const priorityCollision = findPriorityCollision(
      seed, mergeRoomId, 2, 0, incomingConnections, layoutPositionByRoomId, occupiedCells,
    );
    expect(priorityCollision).not.toBeNull();
    expect(priorityCollision.collidingIndex).toBe(0);
    const slots = assignDoorSlotsWithPriority(seed, rect, incomingConnections, 'north', priorityCollision);

    const fromRect = roomRect(seed, fromRoomId, 0, 0);
    const blockerRect = roomRect(seed, blockerRoomId, 1, 0);
    const fromCorridor = buildEdgeCorridor(
      seed, fromRoomId, mergeRoomId, fromRect, rect, { rank: 0, col: 0 }, { rank: 2, col: 0 },
      'south', slots[0], occupiedCells, 'north',
    );
    const blockerCorridor = buildEdgeCorridor(
      seed, blockerRoomId, mergeRoomId, blockerRect, rect, { rank: 1, col: 0 }, { rank: 2, col: 0 },
      'south', slots[1], occupiedCells, 'north',
    );

    // The scene's own actual doors match what the pure functions predict
    // -- confirms the wiring (state.layoutPositionByRoomId/occupiedCells
    // threading) is correct, not just that the pure functions themselves
    // are.
    const toWallCoords = (w) => [toPixels(w.x1), toPixels(w.y1), toPixels(w.x2), toPixels(w.y2)];
    expect(fromReveal.c).toEqual(toWallCoords(fromCorridor.revealDoorWall));
    expect(blockerReveal.c).toEqual(toWallCoords(blockerCorridor.revealDoorWall));

    // The real property Round 1's own final review found violated: neither
    // connection's own revealDoorWall (its real door) is covered by the
    // OTHER connection's own plainWalls (the target-side plain segments a
    // dogleg-adjacent slot might otherwise widen into). Checked on the
    // target's own shared north face only (y1 === rect.gy), the only face
    // where the two connections' own geometry could ever collide.
    const targetFaceY = rect.gy;
    const coveredBy = (doorWall, otherPlainWalls) => otherPlainWalls
      .filter((w) => w.y1 === targetFaceY && w.y2 === targetFaceY)
      .some((w) => {
        const wx1 = Math.min(w.x1, w.x2);
        const wx2 = Math.max(w.x1, w.x2);
        const dx1 = Math.min(doorWall.x1, doorWall.x2);
        const dx2 = Math.max(doorWall.x1, doorWall.x2);
        // Overlap, not just containment -- any shared span at all would
        // mean the door is (partially or fully) sealed by a plain wall.
        return wx1 < dx2 && wx2 > dx1;
      });
    expect(coveredBy(fromCorridor.revealDoorWall, blockerCorridor.plainWalls)).toBe(false);
    expect(coveredBy(blockerCorridor.revealDoorWall, fromCorridor.plainWalls)).toBe(false);
  });

  it('produces Wall/Tile output identical to doorSlotsForFace\'s own direct output for a non-colliding two-parent merge room (Review Focus item 4 -- the common case is unaffected)', async () => {
    installFoundryStubs();
    const seed = 'dogleg-repro-seed-0';
    const parentAId = 'room-a';
    const parentBId = 'room-b';
    const mergeRoomId = 'room-m';
    // Both parents directly adjacent (rank diff 1) to the merge room --
    // Round 1's own dogleg trigger (2 ranks/cols apart, same column/row)
    // never fires for either, so findPriorityCollision must return null
    // and assignDoorSlotsWithPriority must fall through to
    // doorSlotsForFace's own direct output, unchanged.
    const layoutPositionByRoomId = {
      [parentAId]: { rank: 0, col: 0 },
      [parentBId]: { rank: 0, col: 1 },
      [mergeRoomId]: { rank: 1, col: 0 },
    };
    const layoutEdges = { [parentAId]: [mergeRoomId], [parentBId]: [mergeRoomId] };
    const occupiedCells = { '0,0': parentAId, '0,1': parentBId, '1,0': mergeRoomId };
    const incomingFaceByRoomId = { [parentAId]: 'north', [parentBId]: 'north', [mergeRoomId]: 'north' };
    const state = {
      seed,
      layoutPositionByRoomId,
      incomingFaceByRoomId,
      hiddenRooms: [],
      edges: layoutEdges,
      layoutEdges,
      hiddenIncomingByRoomId: {},
      hiddenEdges: {},
    };
    const room = {
      id: mergeRoomId, kind: 'narrative', isGoal: false,
      locationTag: null, artVariant: 0, setpieceId: null,
    };

    const scene = makeFakeScene();
    await buildPopulateAndUnlockGraphNode(scene, state, room, {
      rank: 1, col: 0, childIds: [], unlock: false,
    });

    const incomingConnections = [
      { sourceId: parentAId, hidden: false },
      { sourceId: parentBId, hidden: false },
    ];
    const rect = roomRect(seed, mergeRoomId, 1, 0);
    const priorityCollision = findPriorityCollision(
      seed, mergeRoomId, 1, 0, incomingConnections, layoutPositionByRoomId, occupiedCells,
    );
    expect(priorityCollision).toBeNull();
    const plainSlots = doorSlotsForFace(rect, 2, 'north');
    const prioritySlots = assignDoorSlotsWithPriority(seed, rect, incomingConnections, 'north', priorityCollision);
    expect(prioritySlots).toEqual(plainSlots);

    const parentARect = roomRect(seed, parentAId, 0, 0);
    const parentBRect = roomRect(seed, parentBId, 0, 1);
    const expectedFromA = buildEdgeCorridor(
      seed, parentAId, mergeRoomId, parentARect, rect, { rank: 0, col: 0 }, { rank: 1, col: 0 },
      'south', plainSlots[0], occupiedCells, 'north',
    );
    const expectedFromB = buildEdgeCorridor(
      seed, parentBId, mergeRoomId, parentBRect, rect, { rank: 0, col: 1 }, { rank: 1, col: 0 },
      'south', plainSlots[1], occupiedCells, 'north',
    );

    const toWallCoords = (w) => [toPixels(w.x1), toPixels(w.y1), toPixels(w.x2), toPixels(w.y2)];
    const revealWalls = scene.walls.filter((w) => w.getFlag(MODULE_ID, 'dungeonRevealDoorForSlot') === mergeRoomId);
    expect(revealWalls).toHaveLength(2);
    const actualFromA = revealWalls.find((w) => w.getFlag(MODULE_ID, 'dungeonDoorFromRoomId') === parentAId);
    const actualFromB = revealWalls.find((w) => w.getFlag(MODULE_ID, 'dungeonDoorFromRoomId') === parentBId);
    expect(actualFromA.c).toEqual(toWallCoords(expectedFromA.revealDoorWall));
    expect(actualFromB.c).toEqual(toWallCoords(expectedFromB.revealDoorWall));

    // Tile count matches what the two independently-computed corridors'
    // own segments would produce, plus exactly one for the room's own
    // floor-art tile (buildRoomAtGraphNode's own `dungeonRoomBuilt`
    // marker) -- confirms the wiring change didn't alter how many corridor
    // floor tiles get laid for the common case. Mirrors
    // corridorTilesForSegments' own per-segment length rule
    // (dungeon-scene.mjs, private): one tile per grid square along
    // whichever axis the segment runs (vertical when gh >= gw), counted
    // with ti < length (fractional lengths truncate, matching the real
    // for-loop's own behavior).
    const segmentTileCount = (seg) => {
      const length = seg.gh >= seg.gw ? seg.gh : seg.gw;
      let count = 0;
      for (let ti = 0; ti < length; ti += 1) count += 1;
      return count;
    };
    const expectedTileCount = 1 + [...expectedFromA.corridorSegments, ...expectedFromB.corridorSegments]
      .reduce((sum, seg) => sum + segmentTileCount(seg), 0);
    expect(scene.tiles.length).toBe(expectedTileCount);
  });
});

describe('buildPopulateAndUnlockGraphNode — corridor floor tile grid alignment (#324)', () => {
  it('places every corridor floor tile flush with its own grid cell, not offset by half a cell', async () => {
    installFoundryStubs();
    const seed = 'dogleg-repro-seed-0';
    const fromRoomId = 'tile-align-from';
    const toRoomId = 'tile-align-to';
    const layoutPositionByRoomId = {
      [fromRoomId]: { rank: 0, col: 0 },
      [toRoomId]: { rank: 1, col: 0 },
    };
    const layoutEdges = { [fromRoomId]: [toRoomId] };
    const occupiedCells = { '0,0': fromRoomId, '1,0': toRoomId };
    const incomingFaceByRoomId = { [fromRoomId]: 'north', [toRoomId]: 'north' };
    const state = {
      seed,
      layoutPositionByRoomId,
      incomingFaceByRoomId,
      hiddenRooms: [],
      edges: layoutEdges,
      layoutEdges,
      hiddenIncomingByRoomId: {},
      hiddenEdges: {},
    };
    const room = {
      id: toRoomId, kind: 'narrative', isGoal: false,
      locationTag: null, artVariant: 0, setpieceId: null,
    };

    const scene = makeFakeScene();
    await buildPopulateAndUnlockGraphNode(scene, state, room, {
      rank: 1, col: 0, childIds: [], unlock: false,
    });

    // Cross-check against the pure buildEdgeCorridor's own corridorSegments
    // -- never a second, independently hardcoded expected value.
    const fromRect = roomRect(seed, fromRoomId, 0, 0);
    const toRect = roomRect(seed, toRoomId, 1, 0);
    const toSlot = doorSlotsForFace(toRect, 1, 'north')[0];
    const expected = buildEdgeCorridor(
      seed, fromRoomId, toRoomId, fromRect, toRect, { rank: 0, col: 0 }, { rank: 1, col: 0 },
      'south', toSlot, occupiedCells, 'north',
    );
    expect(expected.corridorSegments.length).toBeGreaterThan(0);

    // Every corridor floor tile (excluding the target room's own single
    // floor-art tile, flagged dungeonRoomBuilt) must have its own CENTER
    // -- not top-left corner -- exactly half a cell off a grid line (see
    // the sixth-finding comment below for why this tile type is
    // center-anchored, unlike every other pixel coordinate in this file).
    const corridorTiles = scene.tiles.filter((t) => !t.getFlag(MODULE_ID, 'dungeonRoomBuilt'));
    expect(corridorTiles.length).toBeGreaterThan(0);

    const expectedPositions = [];
    for (const seg of expected.corridorSegments) {
      const vertical = seg.gh >= seg.gw;
      const length = vertical ? seg.gh : seg.gw;
      for (let ti = 0; ti < length; ti += 1) {
        const dx = vertical ? 0 : ti;
        const dy = vertical ? ti : 0;
        expectedPositions.push({
          x: toPixels(seg.gx + dx) + GRID_SIZE / 2,
          y: toPixels(seg.gy + dy) + GRID_SIZE / 2,
        });
      }
    }
    expect(corridorTiles.length).toBe(expectedPositions.length);

    const byXY = (a, b) => a.x - b.x || a.y - b.y;
    const actualPositions = corridorTiles.map((t) => ({ x: t.x, y: t.y })).sort(byXY);
    const sortedExpected = [...expectedPositions].sort(byXY);
    // The real bug this test pins (#324): the shipped code added an extra
    // toPixels(1)/2 to both x and y, so every actual position would be off
    // by exactly (50, 50) before the fix.
    expect(actualPositions).toEqual(sortedExpected);

    // Every tile is exactly one grid cell, and its own CENTER lands
    // exactly half a cell off a grid line (i.e. its own top-left, x-50/
    // y-50, is flush with the grid) -- confirms this isn't a coincidental
    // match on gx/gy alone.
    for (const t of corridorTiles) {
      expect((t.x - GRID_SIZE / 2) % GRID_SIZE).toBe(0);
      expect((t.y - GRID_SIZE / 2) % GRID_SIZE).toBe(0);
      expect(t.width).toBe(GRID_SIZE);
      expect(t.height).toBe(GRID_SIZE);
      // #324 (sixth finding): a top-left (0/0) anchor -- correct for a
      // NEVER-rotated tile like room floor art -- rotates a corridor
      // tile's art around its own CORNER instead of its center (Foundry
      // ties rotation pivot to texture anchor), swinging rotated tiles
      // outside their own bounding box. Every corridor tile rotates, so
      // it needs center anchor (0.5/0.5) + a center-of-cell x/y instead,
      // which keeps any multiple-of-90-degree rotation inside the same
      // square bounding box with no per-angle compensation.
      expect(t.texture.anchorX).toBe(0.5);
      expect(t.texture.anchorY).toBe(0.5);
    }
  });

  it('also grid-aligns a MULTI-CELL corridor\'s own floor tiles (transit cells and their room-side connectors) -- distinct from the single-cell case #327 already fixed', async () => {
    installFoundryStubs();
    // Straight same-column descent, rank 0 -> rank 3, nothing blocking --
    // findCorridorPath still returns a multi-cell path (routes cell-by-cell,
    // not room-to-room: ranks 1 and 2 become real transit cells), same
    // fixture shape as dungeon-layout.test.mjs's own "chains every crossing
    // point end-to-end" test. This is the branch #327 did NOT touch: the
    // multi-cell chain's own room-door anchor is genuinely, deliberately
    // fractional (buildEdgeCorridor's own chainStartAnchor/chainEndAnchor,
    // "center minus half door-width") -- correct for wall/door line
    // geometry, but wrong when the SAME coordinate is reused to place a
    // discrete 1x1 floor tile.
    const seed = 'dogleg-repro-seed-0';
    const fromRoomId = 'multicell-tile-align-from';
    const toRoomId = 'multicell-tile-align-to';
    const layoutPositionByRoomId = {
      [fromRoomId]: { rank: 0, col: 0 },
      [toRoomId]: { rank: 3, col: 0 },
    };
    const layoutEdges = { [fromRoomId]: [toRoomId] };
    const occupiedCells = { '0,0': fromRoomId, '3,0': toRoomId };
    const incomingFaceByRoomId = { [fromRoomId]: 'north', [toRoomId]: 'north' };
    const state = {
      seed,
      layoutPositionByRoomId,
      incomingFaceByRoomId,
      hiddenRooms: [],
      edges: layoutEdges,
      layoutEdges,
      hiddenIncomingByRoomId: {},
      hiddenEdges: {},
    };
    const room = {
      id: toRoomId, kind: 'narrative', isGoal: false,
      locationTag: null, artVariant: 0, setpieceId: null,
    };

    const scene = makeFakeScene();
    await buildPopulateAndUnlockGraphNode(scene, state, room, {
      rank: 3, col: 0, childIds: [], unlock: false,
    });

    // Cross-check against the pure buildEdgeCorridor's own output -- never
    // a second, independently hardcoded expected value.
    const fromRect = roomRect(seed, fromRoomId, 0, 0);
    const toRect = roomRect(seed, toRoomId, 3, 0);
    const toSlot = doorSlotsForFace(toRect, 1, 'north')[0];
    const expected = buildEdgeCorridor(
      seed, fromRoomId, toRoomId, fromRect, toRect, { rank: 0, col: 0 }, { rank: 3, col: 0 },
      'south', toSlot, occupiedCells, 'north',
    );
    expect(expected.transitCells.length).toBeGreaterThan(0); // sanity: really the multi-cell branch

    const corridorTiles = scene.tiles.filter((t) => !t.getFlag(MODULE_ID, 'dungeonRoomBuilt'));
    expect(corridorTiles.length).toBeGreaterThan(0);

    // Every corridor floor tile -- both the room-side connector segments
    // and every transit cell's own crossing -- must land flush on the
    // grid (center half a cell off a grid line), exactly as the
    // single-cell case already requires.
    for (const t of corridorTiles) {
      expect((t.x - GRID_SIZE / 2) % GRID_SIZE).toBe(0);
      expect((t.y - GRID_SIZE / 2) % GRID_SIZE).toBe(0);
      // #324 (sixth finding) -- see the single-cell test's own comment above.
      expect(t.texture.anchorX).toBe(0.5);
      expect(t.texture.anchorY).toBe(0.5);
    }
  });
});

describe('effectiveRoomBias (#412)', () => {
  const room = { rank: 3, maxRank: 6, isGoal: false }; // ramp bias 1
  const goal = { rank: 6, maxRank: 6, isGoal: true }; // ramp bias 2

  it('severe and a missing difficulty equal the raw depth ramp', () => {
    expect(effectiveRoomBias({ ...room, difficulty: 'severe' })).toBe(1);
    expect(effectiveRoomBias({ ...room })).toBe(1);
    expect(effectiveRoomBias({ ...goal, difficulty: undefined })).toBe(2);
  });

  it('low flattens the ramp, trivial goes below zero everywhere', () => {
    expect(effectiveRoomBias({ ...goal, difficulty: 'low' })).toBe(0);
    expect(effectiveRoomBias({ ...goal, difficulty: 'trivial' })).toBe(-1);
    expect(effectiveRoomBias({ ...room, difficulty: 'trivial' })).toBe(-1);
  });

  it('extreme lifts only the deepest rooms', () => {
    expect(effectiveRoomBias({ ...room, difficulty: 'extreme' })).toBe(1);
    expect(effectiveRoomBias({ ...goal, difficulty: 'extreme' })).toBe(3);
  });
});
