/**
 * The Foundry side of a physical dungeon: creates the run's own Scene and
 * builds one room at a time (walls, floor art, and a real reveal door).
 *
 * Rooms are built lazily — see dungeon-runner.mjs's docblock for why a
 * pre-built-everything approach would need reindexing logic this design
 * avoids entirely. dungeon-layout.mjs supplies all the grid-unit geometry;
 * this file only ever converts that to pixels and talks to Foundry.
 *
 * Modelled on scene-divination.mjs's Scene.create / activate-vs-view
 * precedent, but for a real explorable scene (tokenVision:true, real walls)
 * rather than a flat card-display one.
 *
 * Room discovery is triggered by opening a real door (the "reveal door" on
 * each room's own incoming face, flagged `dungeonRevealDoorForSlot`) rather
 * than a token merely walking into the room's footprint — module.mjs's own
 * `updateWall` hook calls `handleDungeonDoorOpened` directly (no Region or
 * `module.api` indirection needed for that, unlike the walk-in trigger this
 * replaced, which needed `module.api` because a Region's `executeScript`
 * behavior runs in a more sandboxed context).
 */
// #93 post-merge fix (Task 15 item 1): every old linear-slot builder (room
// build, populate+unlock, door unlock, party placement, camera focus,
// goal-exit retrofit, slot encounter/trap teardown) is deleted — every live
// caller uses the graph-node functions below — and with them this file's
// imports of the old slot-indexed layout geometry, deleted from
// dungeon-layout.mjs in the same pass.
import {
  ROOM_SIZE_LARGE,
  INITIAL_GX,
  roomEnclosureWalls,
  corridorTileVariant,
  ROW_STRIDE,
  COLUMN_STRIDE,
  roomRect,
  roomSidesForRect,
  exitFaceForIndex,
  parentRoomIdsFor,
  incomingConnectionsFor,
  doorSlotsForFace,
  buildEdgeCorridor,
  cellMarginWalls,
  transitCellContainmentWalls,
  DOOR_WIDTH,
  outgoingMarginOffset,
  pendingForeignMarginOpenings,
  incomingSlotsV3,
  findPriorityCollision,
  assignDoorSlotsWithPriority,
  outgoingDoorPlan,
  outgoingPlanForStubs,
  mergeEdgeMaps,
  plannedMarginOpenings,
  planStubGeometries,
  routingForLayout,
} from "./dungeon-layout.mjs";
import { freeSpotInRect } from "./placement.mjs";
import { generateEncounter } from "./encounter-generator.mjs";
import {
  getRunState,
  advanceToRoom,
  undoLastRoomEntry,
  canUndoRoomEntry,
  ensureSkillChallenge,
  ensurePuzzleState,
  ensureNarrativeState,
  ensureTrapState,
  ensureTreasureState,
  markRoomOutcome,
  effectiveMarchingOrder,
  retreatTo,
  markStubOpened,
} from "./dungeon-runner.mjs";
import { canRetreat, hasNoWayForward, roomDisplayLabel, roomTileName } from "./dungeon-retreat.mjs";
import { depthBiasFor, applyDifficultyCap } from "./dungeon-deck.mjs";
import { startCombatForRoom } from "./dungeon-combat.mjs";
import { playDoorSound } from "./dungeon-sound.mjs";
import { loadDungeonSetpieces } from "./data-loader.mjs";
import {
  selectSkillChallengeTemplate,
  dcAdjustmentForTier,
} from "./skill-challenge-mechanics.mjs";
import { isValidNarrativeTemplate } from "./narrative-mechanics.mjs";
import { makeFoundryApi } from "./foundry-api.mjs";
import { selectTrap } from "./trap-library.mjs";
import { splitmix32, seedFromString } from "./prng.mjs";

const MODULE_ID = "pf2e-dungeon-crawl";
const GRID_SIZE = 100;
const MARGIN_ROOMS = 1;

const toPixels = (gridVal) => gridVal * GRID_SIZE;

const ROOM_ART_DIR = `modules/${MODULE_ID}/assets/dungeon-rooms`;
const CORRIDOR_ART_PATH = `${ROOM_ART_DIR}/corridor.webp`;
const CORRIDOR_ART_BY_VARIANT = {
  single: CORRIDOR_ART_PATH,
  end: `${ROOM_ART_DIR}/corridor-end.webp`,
  mid: `${ROOM_ART_DIR}/corridor-mid.webp`,
  // #438: the collapsed-rubble cap for #427's dead-end stub corridors — not
  // chosen by corridorTileVariant; the stub builder asks for it by name.
  rubble: `${ROOM_ART_DIR}/corridor-rubble.webp`,
};

// A room's own light (ITEM-14) — see buildRoomAtGraphNode. Radii scale with the
// room's own actual size (ITEM-17, rooms are no longer all the same size):
// a room is `roomSizeSquares` squares across, so at this scene's 5ft/square
// grid its half-diagonal (center to corner) is roomSizeSquares*5/sqrt(2) ft
// — ROOM_LIGHT_BRIGHT reaches every corner at full brightness, with
// ROOM_LIGHT_DIM giving a generous soft falloff beyond the room into its
// connecting corridor. For the original fixed ROOM_SIZE_SMALL (6) this
// reproduces the exact bright:22/dim:40 this module always used.
const GRID_DISTANCE_FT = 5;
const ROOM_LIGHT_DIM_MARGIN = 18;
function roomLightRadii(roomSizeSquares) {
  const bright = Math.ceil((roomSizeSquares * GRID_DISTANCE_FT) / Math.SQRT2);
  return { bright, dim: bright + ROOM_LIGHT_DIM_MARGIN };
}
const ROOM_LIGHT_COLOR = "#ff8844";
const ROOM_LIGHT_ALPHA = 0.35;

/** The path to a room's background art — a dedicated image per locationTag
 * for the goal room (there's only ever one), or one of its regular pool of
 * pregenerated variants otherwise. */
function roomArtPath({ locationTag, isGoal, artVariant }) {
  return isGoal
    ? `${ROOM_ART_DIR}/${locationTag}-goal.webp`
    : `${ROOM_ART_DIR}/${locationTag}-${artVariant}.webp`;
}

function wallDoc(
  { x1, y1, x2, y2 },
  {
    door = CONST.WALL_DOOR_TYPES.NONE,
    ds = CONST.WALL_DOOR_STATES.CLOSED,
    flags = null,
  } = {},
) {
  return {
    c: [toPixels(x1), toPixels(y1), toPixels(x2), toPixels(y2)],
    door,
    ds,
    sight: CONST.WALL_SENSE_TYPES.NORMAL,
    move: CONST.WALL_MOVEMENT_TYPES.NORMAL,
    ...(flags ? { flags } : {}),
  };
}

/** Corridor floor Tile data for every 1x1 square in `segments` (a
 * `buildEdgeCorridor`/`transitCellCrossing` `corridorSegments` array) —
 * shared by a connection's own corridor and a #174 Task 5 transit cell's
 * own crossing, both of which lay tile-per-grid-square the same way the
 * old linear-slot builder's single corridorRect loop always did. */
function corridorTilesForSegments(segments, { fullWidth = false } = {}) {
  const tiles = [];
  for (const segment of segments) {
    const vertical = segment.gh >= segment.gw;
    const length = vertical ? segment.gh : segment.gw;
    // #555 (layoutVersion >= 3): a segment wider than one cell (the #230/#231 gap-widening bridge between a
    // source door and a clamped target slot) is tiled across its whole width, not just its first column, so the
    // door cell the bridge exists to cover has a floor tile in its own column.
    const cross = fullWidth ? Math.max(1, Math.round(vertical ? segment.gw : segment.gh)) : 1;
    for (let ci = 0; ci < cross; ci += 1) {
    // #324 (second finding, the multi-cell/transit-cell path): a
    // multi-cell corridor's own room-door anchor is deliberately
    // fractional (buildEdgeCorridor's own chainStartAnchor/chainEndAnchor,
    // "center minus half door-width" -- correct for wall/door LINE
    // geometry, which tolerates any fractional endpoint fine). Floor the
    // segment's own start ONCE here, before laying out its own tiles, so
    // every tile in this segment lands on a single whole grid cell instead
    // of straddling two -- the same single-cell approximation wall
    // geometry never needed (a fractional wall endpoint renders exactly
    // where it says; a discrete 1x1 tile needs one whole cell to occupy).
    // Flooring only the segment's own base, not each tile's own dx/dy
    // offset, keeps every tile in a segment consistently adjacent (no
    // gaps/overlaps) and keeps this scoped to tile placement only --
    // corridorSegments is never read for wall/door geometry (that comes
    // from doorWall/revealDoorWall/plainWalls, entirely separate fields on
    // buildEdgeCorridor's own return value), so this cannot affect them.
    const baseGx = Math.floor(segment.gx);
    const baseGy = Math.floor(segment.gy);
    for (let ti = 0; ti < length; ti += 1) {
      const dx = vertical ? ci : ti;
      const dy = vertical ? ti : ci;
      const { variant, rotation } = corridorTileVariant(ti, length, vertical);
      tiles.push({
        // anchorX/anchorY: 0.5 (center) -- NOT top-left. Room floor art
        // (above, roomArtPath's own Tile) uses anchor 0/0 + top-left x/y,
        // which works because it never rotates. Every corridor tile DOES
        // rotate (0/90/180/270, see corridorTileVariant) -- and Foundry
        // ties a Tile's rotation pivot directly to its own texture anchor
        // (confirmed live against Tile.LNWFJbnzjltfbwor: mesh.pivot exactly
        // equals mesh.anchor in local pixel space). A 0/0 anchor rotates
        // the art around its own CORNER, swinging a rotated tile's visible
        // content outside its own bounding box -- this was tried first and
        // broke every non-90-degree-symmetric rotation (#324, sixth
        // finding; anchor 0/0 alone was only ever correct for rotation 0).
        // Center anchor + a center-of-cell x/y sidesteps this entirely: a
        // SQUARE tile (every corridor tile is 1x1) rotated about its own
        // center by any multiple of 90 degrees re-covers the exact same
        // bounding box, so no rotation-angle-specific compensation is ever
        // needed.
        texture: { src: CORRIDOR_ART_BY_VARIANT[variant], anchorX: 0.5, anchorY: 0.5 },
        // x/y is this tile's own CENTER (toPixels(baseGx+dx) is its
        // top-left grid line; + half a cell lands on its center) -- not
        // its top-left corner, unlike every other pixel coordinate in this
        // file (e.g. wallDoc's own toPixels(x1)/toPixels(y1) above), because
        // this tile's anchor is center, not top-left (see above).
        x: toPixels(baseGx + dx) + toPixels(1) / 2,
        y: toPixels(baseGy + dy) + toPixels(1) / 2,
        width: toPixels(1),
        height: toPixels(1),
        rotation,
      });
    }
    }
  }
  return tiles;
}

/** #427: the floor tiles of one dead-end stub, door tile first and the collapsed-rubble cap (#438) on the far end.
 * `g` is a `stubGeometry` result; each tile is one cell of its single floor rect. */
function stubTilesFor(g, key) {
  const f = g.floor[0];
  const tiles = [];
  for (let k = 0; k < g.length; k += 1) {
    const gx = g.dir > 0 ? f.gx + k : f.gx + f.gw - 1 - k;
    const cap = k === g.length - 1;
    tiles.push({
      texture: { src: CORRIDOR_ART_BY_VARIANT[cap ? "rubble" : "single"], anchorX: 0.5, anchorY: 0.5 },
      x: toPixels(gx) + toPixels(1) / 2,
      y: toPixels(f.gy) + toPixels(1) / 2,
      width: toPixels(1),
      height: toPixels(1),
      // The cap faces the dead end like corridorTileVariant's far 'end' tile (90 heading east, 270 west).
      rotation: cap ? (g.dir > 0 ? 90 : 270) : 0,
      flags: { [MODULE_ID]: { dungeonStubCorridorFor: key } },
    });
  }
  return tiles;
}

/**
 * Builds (idempotently) one intermediate, empty cell's own corridor floor
 * tiles and outer-boundary containment for a multi-cell corridor path
 * (#174 Tasks 1/3/4's findCorridorPath/transitCellCrossing/
 * buildEdgeCorridor) — a cell no room is ever built at, so nothing else
 * in this file ever touches it. Two different edges can route through
 * the SAME empty cell via DIFFERENT entry/exit side pairs; each needs its
 * own opening, not a skipped or duplicated cell (design spec's own
 * "Error handling" section, and Task 5's brief Step 1 checklist item e).
 *
 * #225 fix: the marker used to omit the edge's own id, so a SECOND edge
 * crossing the same cell with the SAME entry/exit side pair (routine
 * whenever multiple sources converge on one gate face from the same
 * general direction) was silently treated as "already built" and never
 * got its own tiles or opening — this is what `cell.edgeId` in the marker
 * below fixes.
 *
 * Idempotency for this EXACT entry/exit pair is checked against this
 * crossing's own corridor floor TILE, not its containment walls —
 * mirroring buildRoomAtGraphNode's own `dungeonRoomBuilt` convention (a
 * document created once and never rebuilt is a stable "already built"
 * marker). The containment WALLS can't double as that marker themselves:
 * unlike a room's own floor tile, they DO get superseded below whenever a
 * later, different-pair crossing of the SAME cell needs to open a side
 * this crossing left solid — a marker living only on those walls would
 * vanish the moment a second crossing rebuilds them, making an idempotent
 * re-run of the FIRST crossing think it still needs building again.
 */
async function buildTransitCellIfNeeded(scene, cell) {
  const marker = `${cell.rank},${cell.col}:${cell.entrySide}-${cell.exitSide}:${cell.edgeId}`;
  const alreadyBuilt = scene.tiles.some(
    (t) => t.getFlag(MODULE_ID, "dungeonTransitCellCrossing") === marker,
  );
  if (alreadyBuilt) return;

  const tiles = corridorTilesForSegments(cell.corridorSegments).map((t) => ({
    ...t,
    flags: { [MODULE_ID]: { dungeonTransitCellCrossing: marker } },
  }));

  // This cell's outer-boundary containment accumulates across every edge
  // that ever crosses it: a second, different-pair crossing needs its own
  // opening added to whichever sides the FIRST crossing left solid, not a
  // fresh 2-opening seal that silently re-solidifies the first crossing's
  // own gap. `dungeonTransitCellOpenings` (stored on this cell's own
  // margin walls, keyed by `dungeonTransitCellMarginForCell`) is the
  // running list this rebuild reads back and appends to.
  const cellKey = `${cell.rank},${cell.col}`;
  const existingMarginWalls = scene.walls.filter(
    (w) => w.getFlag(MODULE_ID, "dungeonTransitCellMarginForCell") === cellKey,
  );
  const priorOpenings = existingMarginWalls.length
    ? (existingMarginWalls[0].getFlag(MODULE_ID, "dungeonTransitCellOpenings") ?? [])
    : [];
  const openings = [
    ...priorOpenings,
    { side: cell.entrySide, point: cell.entryPoint },
    { side: cell.exitSide, point: cell.exitPoint },
  ];
  const marginWalls = transitCellContainmentWalls(cell.rank, cell.col, openings).map((side) =>
    wallDoc(side, {
      flags: {
        [MODULE_ID]: {
          dungeonTransitCellMarginForCell: cellKey,
          dungeonTransitCellOpenings: openings,
        },
      },
    }),
  );
  const plainWalls = (cell.plainWalls ?? []).map((w) => wallDoc(w));

  // #110 ordering: create this crossing's own tiles and the new
  // (superseding) containment walls before deleting whichever earlier
  // containment walls this rebuild replaces — never the reverse, so
  // there's never a frame where this cell's boundary is neither the old
  // seal nor the new one.
  await scene.createEmbeddedDocuments("Wall", [...marginWalls, ...plainWalls]);
  if (tiles.length) await scene.createEmbeddedDocuments("Tile", tiles);
  if (existingMarginWalls.length) {
    await scene.deleteEmbeddedDocuments("Wall", existingMarginWalls.map((w) => w.id));
  }
}

/**
 * Proactively seals an empty buffer column (#174 follow-up:
 * computeColumns' skip-by-2 stride leaves one beside every room) with a
 * full 4-wall containment boundary, idempotently — using the exact same
 * `dungeonTransitCellMarginForCell`/`dungeonTransitCellOpenings` flags
 * `buildTransitCellIfNeeded` already reads and writes for a
 * corridor-crossed transit cell, so the two compose correctly regardless
 * of which runs first for a given cell:
 *
 * - Sealed here first, corridor crosses it later: `buildTransitCellIfNeeded`
 *   reads this function's own `dungeonTransitCellOpenings: []` back as
 *   `priorOpenings`, and rebuilds with its own entry/exit added — its
 *   existing, already-shipped behavior for "a second edge crosses an
 *   already-built transit cell," no special-casing needed.
 * - A corridor crosses it first, this runs later: `alreadyBuilt` below
 *   finds the crossing's own walls already tagged with this cell's key
 *   and does nothing, never re-sealing over an opening a corridor needs.
 */
async function sealBufferCellIfUnbuilt(scene, rank, col) {
  const cellKey = `${rank},${col}`;
  const alreadyBuilt = scene.walls.some(
    (w) => w.getFlag(MODULE_ID, "dungeonTransitCellMarginForCell") === cellKey,
  );
  if (alreadyBuilt) return;
  const marginWalls = transitCellContainmentWalls(rank, col, []).map((side) =>
    wallDoc(side, {
      flags: {
        [MODULE_ID]: { dungeonTransitCellMarginForCell: cellKey, dungeonTransitCellOpenings: [] },
      },
    }),
  );
  await scene.createEmbeddedDocuments("Wall", marginWalls);
}

// #93 pre-flight fix (Step 3f): requiredDimensions/ensureSceneCovers
// (the old per-room, slot-indexed canvas-growth pair) are deleted —
// superseded by resizeSceneForLayout below, called ONCE by Task 12 right
// after the whole graph's layout is known, since full pregeneration means
// the graph's max rank/col no longer needs to be discovered incrementally
// one room at a time.
export async function createDungeonScene() {
  return Scene.create({
    name: "Dungeon Crawl",
    tokenVision: true,
    fogExploration: true,
    backgroundColor: "#2b2620",
    grid: { type: 1, size: GRID_SIZE, distance: 5, units: "ft" },
    // This module already manages its own canvas sizing via
    // resizeSceneForLayout — rather than relying on Foundry's own padding
    // mechanic, so pad by nothing rather than silently inherit Foundry's
    // 25% default (ITEM-20 reopening).
    padding: 0,
    // Fixed conservative default sized for just the entry room —
    // resizeSceneForLayout corrects this to the real full graph size
    // moments later in startDungeonRun (Task 12), before any room past the
    // entry builds, now that the whole graph's extent is known up front
    // under full pregeneration rather than discovered incrementally.
    width: toPixels(INITIAL_GX + COLUMN_STRIDE + MARGIN_ROOMS),
    height: toPixels(ROW_STRIDE + MARGIN_ROOMS),
    flags: { [MODULE_ID]: { role: "dungeon-run" } },
  });
}

/**
 * #415 (layoutVersion >= 2): the outgoing door plan of `sourceId`, from the
 * persisted graph. Real children come from `edges`, the single hidden child
 * from `hiddenEdges`; the plan itself is order-independent, so a hidden edge
 * revealed into `edges` later yields the identical plan.
 */
function outgoingPlanFromState(seed, sourceId, { edges, hiddenEdges, layoutPositionByRoomId, stubEdges }) {
  // #427 (layoutVersion >= 3 only: callers pass `stubEdges` only then): dead-end stubs take south slots too.
  return outgoingPlanForStubs(seed, sourceId, { edges, hiddenEdges, stubEdges, positionByRoomId: layoutPositionByRoomId });
}

/**
 * #427: the topology-aware router's `routingFor(edgeId)` for a persisted run state. Only a run stamped
 * `topologyRouting: true` at creation (layoutVersion >= 3) routes; every other run (v1/v2, and a v3 run created before
 * the router shipped) returns `undefined` and keeps its geometry exactly.
 */
export function routingFromState(state) {
  if (!((state.layoutVersion ?? 1) >= 3) || state.topologyRouting !== true) return undefined;
  const positions = state.layoutPositionByRoomId;
  const occupiedCells = {};
  for (const [id, pos] of Object.entries(positions)) occupiedCells[`${pos.rank},${pos.col}`] = id;
  return routingForLayout({
    seed: state.seed, positionByRoomId: positions, occupiedCells, incomingFaceByRoomId: state.incomingFaceByRoomId ?? {},
    layoutEdges: state.layoutEdges, hiddenIncomingByRoomId: state.hiddenIncomingByRoomId, hiddenRooms: state.hiddenRooms ?? [],
    edges: state.edges, hiddenEdges: state.hiddenEdges ?? {}, stubEdges: state.stubEdges ?? {}, walledEdges: state.walledEdges ?? {},
  });
}

/**
 * #93 — manual/live-verification checklist (no Foundry test harness exists
 * for this file, same existing boundary the old linear-slot room builder
 * always had). Run this against a real Foundry
 * world once this function is actually wired into a caller (Task 12) —
 * nothing calls `buildRoomAtGraphNode`/`buildPopulateAndUnlockGraphNode`
 * yet, so this task's own live verification is deliberately DEFERRED to
 * Task 12's own Step 4, not skipped:
 *
 * (a) a 1-exit room behaves identically to today's single-corridor case,
 *     content and all.
 * (b) a 2-exit room gets two independently lockable doors on different
 *     faces, each leading to its own distinct populated child.
 * (c) opening either door correctly supersedes only that door's own
 *     frontier placeholder, leaving the room's other still-unopened exit's
 *     placeholder untouched.
 * (d) the real walls for a newly built connection are always created
 *     before the old frontier placeholder for that same face is deleted
 *     (never the reverse — the existing #110 fog-leak-avoidance ordering).
 * (e) a trap/skill_challenge/puzzle/narrative/treasure room's own
 *     persisted state (ensureTrapState/ensureSkillChallenge/etc.) is
 *     attached exactly once per room, same as today.
 * (f) [#156] a room with a hidden shortcut/detour edge still has that face
 *     solidly built (a real door wall, ds: LOCKED, flagged
 *     dungeonHiddenDoorForEdge) rather than left as a plain solid
 *     enclosure wall.
 * (g) [#156] opening every one of a room's *normal* doors never reveals or
 *     unlocks its hidden door.
 * (h) [merge-door fix] a merge room with 2+ real parents gets a working,
 *     independently openable door for EVERY one of them, all on its north
 *     face, none silently sealed.
 * (i) [merge-door fix] a room that is the 2nd or 3rd child of a branching
 *     parent, and that itself branches into 2-3 children, never has its
 *     incoming door collide with one of its own outgoing doors (incoming
 *     is always north, outgoing is always south/east/west, by
 *     construction — confirm live that this is what's actually built, not
 *     just assumed).
 * (j) [#225] a multi-cell corridor's target door is never covered by the
 *     final transit cell's own containment wall — the wall's gap and the
 *     room's own real door line up exactly, on a room reached by a
 *     genuinely obstacle-routed (not adjacent) connection.
 * (k) [#225] two different edges that route through the same empty
 *     transit cell (same rank/col, same entry/exit side pair) each get
 *     their own corridor floor tiles and their own opening in that
 *     cell's containment wall — neither edge's crossing silently
 *     disappears.
 */
export async function buildRoomAtGraphNode(
  scene,
  roomId,
  {
    rank, col, childIds = [], incomingConnections = [],
    hiddenChildId = null,
    isGoal = false, kind = null, locationTag = null, artVariant = 0, seed = "",
    layoutPositionByRoomId = {}, occupiedCells = {},
    incomingFace = 'north', incomingFaceByRoomId = {},
    edges = {}, layoutEdges, hiddenIncomingByRoomId = {},
    // #415: run-state `layoutVersion` (absent = 1 = legacy exit faces by child
    // index). Version 2 takes every outgoing door from outgoingDoorPlan.
    layoutVersion = 1, hiddenEdges = {},
    // #427 (layoutVersion >= 3): dead-end stubs of this room's source, and the detour rooms (stub geometry needs
    // both to see every other corridor). Ignored below v3: an older run never carries them.
    stubEdges: stubEdgesParam = {}, hiddenRooms = [],
    // #585 (layoutVersion >= 3): dead edges walled instead of built; `edges` already omits them.
    walledEdges: walledEdgesParam = {},
    // #427 (v3): the topology-aware router's routingFor(edgeId); undefined below version 3.
    routingFor,
  },
) {
  const rect = roomRect(seed, roomId, rank, col);
  const planned = layoutVersion >= 2;
  const stubEdges = layoutVersion >= 3 ? stubEdgesParam : {};
  const walledEdges = layoutVersion >= 3 ? walledEdgesParam : {};
  // #585: a walled edge builds no connection, like a stub, but (unlike a stub) no door, tile or flank either.
  const excludedEdges = mergeEdgeMaps(stubEdges, walledEdges);
  const stubChildIds = stubEdges?.[roomId] ?? [];
  const hiddenIsStub = !!hiddenChildId && stubChildIds.includes(hiddenChildId);
  const plan = planned
    ? outgoingDoorPlan(
      rect, { rank, col },
      {
        realChildIds: isGoal ? [] : childIds,
        hiddenChildIds: hiddenChildId && !hiddenIsStub ? [hiddenChildId] : [],
        stubChildIds,
      },
      layoutPositionByRoomId,
    )
    : null;

  const realOutgoingFaces = isGoal ? [] : childIds.map((_, i) => exitFaceForIndex(i, incomingFace));
  const hiddenFaceIndex = childIds.length; // reserved right after the real children
  const legacyOutgoingFaces = hiddenChildId ? [...realOutgoingFaces, exitFaceForIndex(hiddenFaceIndex, incomingFace)] : realOutgoingFaces;
  const outgoingFaces = planned ? [...new Set([...plan.values()].map((e) => e.face))] : legacyOutgoingFaces;
  // #415: a face with several doors is sealed by THIS room except for each
  // door's own one-cell span (placeholders and the child's door fill them);
  // a single-door face stays fully open for its placeholder, as before.
  const doorSpansByFace = {};
  if (planned) {
    for (const entry of plan.values()) {
      if (!entry.doorSpan) continue;
      (doorSpansByFace[entry.face] ??= []).push(entry.doorSpan);
    }
    for (const [face, spans] of Object.entries(doorSpansByFace)) {
      spans.sort((a, b) => (face === 'south' ? a.x1 - b.x1 : a.y1 - b.y1));
    }
  }
  // #174 Task 5 fix round: which child each outgoing face actually
  // connects to, so the margin-gap computation below can tell whether
  // buildEdgeCorridor will use its offset-based or center-based exit
  // point for THIS specific connection (see the margin-wall comment
  // below for why that distinction matters).
  const childIdByFace = {};
  childIds.forEach((id, i) => { childIdByFace[exitFaceForIndex(i, incomingFace)] = id; });
  if (hiddenChildId) childIdByFace[exitFaceForIndex(hiddenFaceIndex, incomingFace)] = hiddenChildId;
  // #93 pre-flight fix: incoming is ALWAYS north now (Task 5's redesign),
  // subdivided into one door slot per `incomingConnections` entry — never
  // a variable compass direction, and never overlapping with outgoingFaces
  // (which never includes north) regardless of how many incoming
  // connections this room has or which index it was among its own
  // parent's children.
  const walls = roomEnclosureWalls(seed, roomId, { incomingCount: incomingConnections.length, incomingFace, outgoingFaces, doorSpansByFace }, rect).map(
    (side) =>
      wallDoc(side, {
        flags: {
          [MODULE_ID]: {
            dungeonEnclosureWallForRoom: roomId,
            dungeonEnclosureWallDirection: side.dir,
          },
        },
      }),
  );

  // #174 Task 5: seal this room's own grid-cell margin (the dead space
  // between a room's own rect and the full cell it's allotted — a real,
  // CORRIDOR_LEN-wide margin for EVERY room size, including
  // ROOM_SIZE_LARGE; #288 fixed cellMarginWalls' own condition, which
  // used to silently treat a LARGE room as having none at all) so vision
  // and movement can never leak past the room into unbuilt void space.
  // `openOffset` comes from `outgoingMarginOffset` (dungeon-layout.mjs),
  // which re-derives exactly which of buildEdgeCorridor's own branches
  // (offset-based vs. center-based exit point) will fire for THIS
  // connection, rather than duplicating that branch logic here — the two
  // needed two fix rounds to agree before being centralized in one place
  // (see outgoingMarginOffset's own docblock for the full history).
  //
  // cellMarginWalls (Task 2) only ever accepts a SINGLE openSide at a
  // time — sufficient for a room with at most one of south/east actually
  // outgoing, but a room can have BOTH as real outgoing faces at once
  // (branching factor 2: south is exitFaceForIndex(0), east is
  // exitFaceForIndex(1)). Calling it once per margin-having outgoing
  // face and keeping only THAT call's own matching-side walls (its
  // other side, computed as if fully sealed, is discarded and handled
  // correctly by that other side's own call instead) generalizes this
  // without needing to touch cellMarginWalls' own already-tested
  // signature.
  // #297: this room's own margin walls must leave a gap for BOTH its own
  // real outgoing connection(s) (computed below, via outgoingMarginOffset,
  // same as before) AND any FOREIGN pass-through gap another edge's own
  // dogleg needs through this room's own margin band
  // (pendingForeignMarginOpenings, dungeon-layout.mjs — a pure scan over
  // the whole graph, safe to call fresh for every room regardless of
  // build order under this module's eager full-graph pregeneration; see
  // its own docblock). Task 1 generalized cellMarginWalls to accept every
  // opening for a side as an array in one call, replacing the old
  // one-call-per-face-then-merge dance this block used to need.
  const marginFaces = outgoingFaces.filter((face) => face === "east" || face === "south");
  const planFor = planned
    ? (sourceId) => outgoingPlanFromState(seed, sourceId, { edges, hiddenEdges, layoutPositionByRoomId, stubEdges })
    : undefined;
  // #415/#427: a planned room's margin openings (foreign pass-through gaps plus one gap per planned door, stubs
  // open nothing) come from the layout module's `plannedMarginOpenings`, the very function the stub planner uses
  // to place a stub, so the two can never disagree about where the margin is open.
  let openingsBySide;
  if (planned) {
    openingsBySide = plannedMarginOpenings(seed, roomId, { rank, col }, {
      plan, hiddenChildId, edges, hiddenEdges, layoutEdges, hiddenIncomingByRoomId, positionByRoomId: layoutPositionByRoomId,
      incomingFaceByRoomId, occupiedCells, planFor, layoutVersion, stubEdges: excludedEdges, routingFor,
    });
  } else {
    const foreignOpenings = pendingForeignMarginOpenings(
      seed, roomId, rank, col, edges, layoutPositionByRoomId, incomingFaceByRoomId, occupiedCells,
      layoutEdges, hiddenIncomingByRoomId,
    );
    openingsBySide = { east: [...foreignOpenings.east], south: [...foreignOpenings.south] };
    // v1 (no plan): one opening per margin-having outgoing face, as wide as that child's own corridor floor.
    for (const face of marginFaces) {
      const childId = childIdByFace[face];
      const childPos = childId ? layoutPositionByRoomId[childId] : null;
      // #174 Task 6: the CHILD's own incoming face, not this room's — this
      // must match wherever buildEdgeCorridor will actually land the
      // connection at the far end (see this task's own "Note for the
      // implementer" in the brief). This room's own incomingFace has no
      // bearing on which face its children receive their connections on.
      const childIncomingFace = childId ? (incomingFaceByRoomId?.[childId] ?? 'north') : 'north';
      const { offset, width } = outgoingMarginOffset(
        seed, roomId, childId, face, rect, { rank, col },
        childPos ?? { rank: NaN, col: NaN }, occupiedCells, childIncomingFace, undefined, undefined,
      );
      openingsBySide[face].push({ offset, width });
    }
  }
  const marginWalls = cellMarginWalls(rect, rank, col, openingsBySide);
  walls.push(
    ...marginWalls.map((side) =>
      wallDoc(side, {
        flags: { [MODULE_ID]: { dungeonCellMarginWallForRoom: roomId } },
      }),
    ),
  );

  // Supersede EACH incoming connection's own frontier placeholder (built
  // by ITS OWN source room when that room was built) — one lookup per
  // connection, keyed by the EXACT `sourceId->roomId` edge, not just an
  // endsWith suffix match: a merge room can have several placeholders all
  // ending with `->roomId`, one per real parent, and only an exact match
  // picks out the right one for THIS specific connection. Hidden
  // connections (shortcut extra, or a detour's one real parent link,
  // marked `hidden: true` by the caller — buildPopulateAndUnlockGraphNode
  // below) were flagged `dungeonHiddenDoorForEdge` instead of
  // `dungeonFrontierWallForEdge` by their source room; everything else is
  // looked up the same way. Deleted only once the caller's OWN matching
  // connection-wall creation succeeds (#110 ordering) — never here.
  const placeholderIdsByConnection = incomingConnections.map(({ sourceId, hidden }) => {
    const flag = hidden ? "dungeonHiddenDoorForEdge" : "dungeonFrontierWallForEdge";
    return scene.walls
      .filter((w) => w.getFlag(MODULE_ID, flag) === `${sourceId}->${roomId}`)
      .map((w) => w.id);
  });

  // One frontier placeholder per outgoing face — findable/superseded later
  // by whichever child builds next on that face.
  //
  // #93 post-merge fix (Task 15 item 6, found while tracing the entry-room
  // retry by hand): skipped for a child that is ALREADY built — the same
  // guard the old linear-slot builder had (#62). A placeholder is only ever
  // superseded by its child's own build; a room built AFTER its child (any
  // ensure-built retry: startDungeonRun's entry retry runs after the eager
  // loop already built the entry's children, and resolveCurrentRoom's /
  // the entry-children retry can hit a room whose own children built fine)
  // would otherwise lay a full-face wall over the child's already-built
  // door/corridor that nothing ever deletes, sealing that exit for good.
  // Never fires on the normal eager path — roomsToEagerlyBuild is
  // topological, so every parent builds before its children.
  for (let i = 0; i < childIds.length; i += 1) {
    if (isSlotBuilt(scene, childIds[i])) continue;
    // #415: a multi-door face's placeholder covers only this door's span.
    const entry = plan?.get(childIds[i]);
    const face = entry ? entry.face : exitFaceForIndex(i, incomingFace);
    const side = entry?.doorSpan ?? roomSidesForRect(rect)[face];
    walls.push(
      wallDoc(side, {
        flags: { [MODULE_ID]: { dungeonFrontierWallForEdge: `${roomId}->${childIds[i]}` } },
      }),
    );
  }
  // #156: the hidden outgoing placeholder, if any — same lifecycle as a
  // real frontier placeholder (superseded when the target room builds),
  // but flagged so the generic per-room-populated unlock step never
  // touches it.
  // Same already-built guard as the real placeholders above: a hidden
  // target that built first already carries its own sealed
  // dungeonHiddenDoorForEdge gate/reveal doors for this edge.
  if (hiddenChildId && !hiddenIsStub && !isSlotBuilt(scene, hiddenChildId)) {
    const entry = plan?.get(hiddenChildId);
    const face = entry ? entry.face : exitFaceForIndex(hiddenFaceIndex, incomingFace);
    const side = entry?.doorSpan ?? roomSidesForRect(rect)[face];
    walls.push(
      wallDoc(side, {
        ds: CONST.WALL_DOOR_STATES.LOCKED,
        flags: { [MODULE_ID]: { dungeonHiddenDoorForEdge: `${roomId}->${hiddenChildId}` } },
      }),
    );
  }

  // #427 (layoutVersion >= 3): this room's dead-end stubs. Each is a locked door on the south face (at the span the
  // plan gave it, so the enclosure above leaves exactly that gap), a south flank and an end cap, and a floor of
  // 1-4 rubble-capped tiles in the south margin row. Locked like a normal door and unlocked by this room's own
  // resolution (`unlockDoorsFromRoom`); a hidden shortcut's stub also carries the sealed hidden-door flags, so the
  // same reveal effects open it. The door never carries `dungeonDoorToRoomId` or `dungeonRevealDoorForSlot`.
  const stubTiles = [];
  if (stubChildIds.length) {
    const placed = planStubGeometries({
      seed, positionByRoomId: layoutPositionByRoomId, occupiedCells, edges, layoutEdges, hiddenEdges, hiddenRooms,
      hiddenIncomingByRoomId, incomingFaceByRoomId, stubEdges, walledEdges, routingFor,
    });
    for (const targetId of stubChildIds) {
      const key = `${roomId}->${targetId}`;
      const g = placed.geometries.get(key);
      if (!g) {
        // The precompute only keeps stubs whose door tile is free, so this is a bug elsewhere. Never leave a
        // hole in the face: wall the planned span shut.
        console.error(`${MODULE_ID} | stub ${key} has no free door tile; sealing its span`);
        walls.push(wallDoc(plan.get(targetId).doorSpan, { flags: { [MODULE_ID]: { dungeonStubWallFor: key } } }));
        continue;
      }
      const hidden = targetId === hiddenChildId;
      walls.push(
        wallDoc(g.doorWall, {
          door: CONST.WALL_DOOR_TYPES.DOOR,
          ds: CONST.WALL_DOOR_STATES.LOCKED,
          flags: {
            [MODULE_ID]: {
              dungeonStubDoorFor: targetId,
              dungeonDoorFromRoomId: roomId,
              dungeonStubFlavor: g.flavor,
              ...(hidden ? { dungeonHiddenDoorForEdge: key, dungeonHiddenDoorRole: "gate" } : {}),
            },
          },
        }),
        ...g.walls.map((w) => wallDoc(w, { flags: { [MODULE_ID]: { dungeonStubWallFor: key } } })),
      );
      stubTiles.push(...stubTilesFor(g, key));
    }
  }

  // This room's OWN enclosure walls, created now — but NONE of
  // `placeholderIdsByConnection`'s lists are deleted here. #110's
  // ordering requires each placeholder to survive until ITS OWN real
  // connecting door exists, and those doors are built by the caller
  // (buildPopulateAndUnlockGraphNode below, which has the source room
  // rect(s) this function doesn't) — deleting a placeholder here, before
  // its door exists, would leave exactly the gap #110 fixed (a face with
  // neither the placeholder nor real geometry). Returned for the caller
  // to delete, each list only once ITS OWN matching connection-wall
  // creation succeeds.
  if (walls.length) await scene.createEmbeddedDocuments("Wall", walls);

  // #174 follow-up: seal this room's own same-rank buffer-column
  // neighbors (computeColumns' skip-by-2 stride guarantees col-1/col+1
  // are never another real room) — idempotent, so it's safe to call
  // from whichever of a buffer column's two neighboring rooms happens
  // to be built first.
  for (const neighborCol of [col - 1, col + 1]) {
    if (occupiedCells[`${rank},${neighborCol}`] == null) {
      await sealBufferCellIfUnbuilt(scene, rank, neighborCol);
    }
  }

  // This room's own floor-art Tile + AmbientLight — same as the old
  // linear-slot room builder (roomArtPath for the Tile texture at anchorX/Y:0 sized to `rect`,
  // then roomLightRadii(rect.gw) for one centered AmbientLight). Unlike the
  // CORRIDOR tiles (which depend on a parent and so belong in
  // buildPopulateAndUnlockGraphNode below, not here), this room's own
  // art/light never depended on the connecting door in the old code
  // either — only the `rect` source changed (roomRect instead of the old
  // linear-slot rect).
  //
  // #93 pre-flight fix (fix round 2 — found by this task's own re-review
  // of its own round-1 fix): flagged `dungeonRoomBuilt: roomId`. isSlotBuilt
  // (below) originally checked for a room's own frontier placeholders/
  // enclosure walls as its "already built" marker — but frontier
  // placeholders are exactly the walls each CHILD's own build later
  // DELETES (#110 ordering), so under full eager pregeneration (parents
  // built before children, Task 12), by the time a room's own children are
  // ALSO built, none of those markers survive — isSlotBuilt would flip
  // back to false for an already-fully-built room, and Task 11's lazy
  // fallback would rebuild it: duplicate walls/tiles/lights, and a second
  // set of frontier placeholders laid directly over the room's already-
  // open, already-built exits, which nothing would ever delete again. This
  // Tile is the one thing this function creates exactly once and NEVER
  // deletes or supersedes afterward — a dedicated flag on it is a stable,
  // permanent "this room was built" marker, unlike any wall-based signal.
  const tiles = [
    {
      // #574: identifiable in the Foundry UI. Nothing matches room tiles by name (only by the flag below).
      name: roomTileName(kind, rank, col, isGoal, globalThis.game?.i18n),
      texture: {
        src: roomArtPath({ locationTag, isGoal, artVariant }),
        anchorX: 0,
        anchorY: 0,
      },
      x: toPixels(rect.gx),
      y: toPixels(rect.gy),
      width: toPixels(rect.gw),
      height: toPixels(rect.gh),
      flags: { [MODULE_ID]: { dungeonRoomBuilt: roomId } },
    },
  ];
  await scene.createEmbeddedDocuments("Tile", [...tiles, ...stubTiles]);

  const { bright, dim } = roomLightRadii(rect.gw);
  await scene.createEmbeddedDocuments("AmbientLight", [
    {
      x: toPixels(rect.gx + rect.gw / 2),
      y: toPixels(rect.gy + rect.gh / 2),
      config: { dim, bright, color: ROOM_LIGHT_COLOR, alpha: ROOM_LIGHT_ALPHA },
    },
  ]);

  return { rect, outgoingFaces, placeholderIdsByConnection };
}

/**
 * Centers this client's camera on roomId's room, zoomed to actually fit it
 * — without this, Foundry's default view on activation just centers on the
 * whole (pre-sized, mostly-empty) scene, leaving the one room the party is
 * actually in looking tiny and stuck in a corner.
 *
 * The scale is fit to the actual viewport rather than a fixed 1 — a fixed
 * zoom can leave the room's far edge past the visible area on a smaller
 * browser window, which looks exactly like the room's art doesn't reach the
 * walls and tokens are standing outside it, when really the camera just
 * isn't framing the whole room.
 *
 * Called both by the automatic room-entry trigger (which only fires once,
 * for whichever single party token happens to trip it first — with five
 * party tokens crossing one door, the other four's own events find
 * `currentRoomId` already advanced and bail out before ever reaching a
 * camera pan) and by the tracker UI's own render, so simply having the
 * tracker window open keeps the view honest regardless of whether that
 * one-shot trigger happened to fire this time. `seed` (ITEM-17) is needed
 * to know this room's own actual size; `rank`/`col` (#93) to know where it
 * is, since a room's position is no longer derivable from an integer alone.
 */
export function focusCameraOnRoom(scene, roomId, rank, col, seed) {
  if (canvas?.scene?.id !== scene.id) return;
  const rect = roomRect(seed, roomId, rank, col);
  const roomPixelSize = Math.max(toPixels(rect.gw), toPixels(rect.gh));
  const [screenWidth, screenHeight] = canvas.screenDimensions ?? [1000, 1000];
  const fitScale = Math.min(screenWidth, screenHeight) / (roomPixelSize * 1.3);
  const scale = Math.min(1.5, Math.max(0.3, fitScale));
  canvas.animatePan({
    x: toPixels(rect.gx + rect.gw / 2),
    y: toPixels(rect.gy + rect.gh / 2),
    scale,
    duration: 250,
  });
}

/** Undo-only twin of unlockDoorsFromRoom: re-locks the progress-gate door
 * AND re-closes the reveal door between fromRoomId and toRoomId — a full
 * undo of both doors' state, not just the one a GM would think to check,
 * in case a player had already opened the second one too. Matches on both
 * ends of the edge together, same reasoning as unlockDoorsFromRoom's own
 * fix round 1 (a merge target's several doors all share the same
 * dungeonDoorToRoomId; only the fromRoomId/dungeonDoorFromRoomId pair picks
 * out the specific one this undo needs to reverse).
 *
 * #427: a stub door is deliberately NOT relocked here. Undo reverses one edge's pair of doors; the source's
 * other doors (real siblings and stubs alike) were unlocked by its own resolution and stay unlocked, and a stub
 * is never the edge a party enters by, so it is never the edge an undo reverses. */
export async function relockDoorFromRoom(scene, fromRoomId, toRoomId) {
  const wall = scene.walls.find(
    (w) =>
      w.getFlag(MODULE_ID, "dungeonDoorToRoomId") === toRoomId &&
      w.getFlag(MODULE_ID, "dungeonDoorFromRoomId") === fromRoomId,
  );
  if (wall) {
    await wall.update({ ds: CONST.WALL_DOOR_STATES.LOCKED });
    playDoorSound("lock");
  }
  const revealWall = scene.walls.find(
    (w) =>
      w.getFlag(MODULE_ID, "dungeonRevealDoorForSlot") === toRoomId &&
      w.getFlag(MODULE_ID, "dungeonDoorFromRoomId") === fromRoomId,
  );
  if (revealWall) await revealWall.update({ ds: CONST.WALL_DOOR_STATES.CLOSED });
}

/**
 * #156: promote a hidden shortcut/detour door from sealed to normal, once
 * `revealTravelTimeEffect` (dungeon-deck.mjs, called from
 * dungeon-runner.mjs's markRoomOutcome) has merged its edge into the live
 * graph. Never builds anything — the door and its corridor were already
 * constructed (LOCKED, `dungeonHiddenDoorForEdge`-flagged) during eager
 * pregeneration (Task 10). Finds every wall flagged
 * `dungeonHiddenDoorForEdge` starting with `${roomId}->` (the doorWall on
 * the revealing room's own face, and its matching revealDoorWall on the
 * target's face both carry this prefix, per Task 10's addendum) and, per
 * wall, based on its `dungeonHiddenDoorRole` ('gate' vs 'reveal', Task 10):
 * - sets `ds: CONST.WALL_DOOR_STATES.CLOSED` (unlocked, same convention as
 *   `unlockDoorsFromRoom`) on both
 * - the 'gate' wall gets `dungeonDoorToRoomId` (matches a normal
 *   progress-gate door — not itself a reveal trigger)
 * - the 'reveal' wall gets `dungeonRevealDoorForSlot` (Task 11's actual
 *   door-open reveal trigger — without this, opening the now-unsealed
 *   door would never fire `handleDungeonDoorOpened`'s reveal/combat-
 *   start/advance sequence)
 * - both get `dungeonDoorFromRoomId: roomId` (matches the normal-door
 *   convention Task 10's own fix round 1 established, for consistency —
 *   nothing currently reads it off a promoted hidden door, but a future
 *   caller keying off both ends shouldn't find this door the one
 *   exception)
 */
export async function unsealHiddenDoorFromRoom(scene, roomId, targetRoomId) {
  const walls = scene.walls.filter(
    (w) => w.getFlag(MODULE_ID, "dungeonHiddenDoorForEdge") === `${roomId}->${targetRoomId}`,
  );
  for (const wall of walls) {
    // #427: a hidden dead-end stub's door only opens (a false shortcut); it is never promoted to a progression or
    // reveal door, so opening it can never advance the run.
    if (wall.getFlag(MODULE_ID, "dungeonStubDoorFor")) {
      await wall.update({
        ds: CONST.WALL_DOOR_STATES.CLOSED,
        [`flags.${MODULE_ID}.-=dungeonHiddenDoorForEdge`]: null,
        [`flags.${MODULE_ID}.-=dungeonHiddenDoorRole`]: null,
      });
      continue;
    }
    const isReveal = wall.getFlag(MODULE_ID, "dungeonHiddenDoorRole") === "reveal";
    await wall.update({
      ds: CONST.WALL_DOOR_STATES.CLOSED,
      [`flags.${MODULE_ID}.${isReveal ? "dungeonRevealDoorForSlot" : "dungeonDoorToRoomId"}`]: targetRoomId,
      [`flags.${MODULE_ID}.dungeonDoorFromRoomId`]: roomId,
      [`flags.${MODULE_ID}.-=dungeonHiddenDoorForEdge`]: null,
      [`flags.${MODULE_ID}.-=dungeonHiddenDoorRole`]: null,
    });
  }
}

/** Whether a combat room's monsters have already been placed. */
export function isSlotPopulated(scene, slot) {
  return scene.tokens.some((t) => t.getFlag(MODULE_ID, "dungeonSlot") === slot);
}

/**
 * Whether roomId's own walls/geometry have been built yet — the idempotency
 * check behind every ensure-built retry (startDungeonRun's entry/entry-
 * children passes, resolveCurrentRoom's children pass, and
 * buildPopulateAndUnlockGraphNode itself), so a room whose eager build
 * failed is retried and an already-built one is skipped.
 *
 * #93 pre-flight fix, TWO rounds (both found by this task's own review — a
 * Critical the first pass introduced was caught by the SAME review's own
 * re-check of its own fix):
 *
 * Round 1's problem: this used to check the OLD `dungeonDoorToSlot` flag,
 * which only the old linear-slot room builder (since deleted, #93 Task 15)
 * ever wrote —
 * `buildRoomAtGraphNode`/`buildPopulateAndUnlockGraphNode` never write it,
 * so this always returned `false` for every graph-built room.
 *
 * Round 2's problem: the round-1 fix (checking
 * `dungeonEnclosureWallForRoom`/`dungeonFrontierWallForEdge`/
 * `dungeonHiddenDoorForEdge`) LOOKED complete but wasn't — a room's own
 * frontier placeholders are exactly the walls each of ITS OWN CHILDREN's
 * build later DELETES (#110 ordering). Under full eager pregeneration
 * (parents built before children, Task 12), by the time a room's children
 * are ALSO built, none of its own frontier-placeholder markers survive —
 * this would flip back to `false` for an already-fully-built room, exactly
 * the same "not idempotent, Task 11 lazy fallback rebuilds it" failure
 * round 1 was meant to fix, just delayed until the room's children finish
 * building instead of happening immediately.
 *
 * Fix: use a dedicated marker that `buildRoomAtGraphNode` creates exactly
 * once and NEVER deletes or supersedes — the room's own floor-art Tile
 * (flagged `dungeonRoomBuilt: roomId`), not any wall.
 */
export function isSlotBuilt(scene, roomId) {
  return scene.tiles.some((t) => t.getFlag(MODULE_ID, "dungeonRoomBuilt") === roomId);
}

/**
 * Generate a combat room's encounter inside slot's own footprint. Hidden by
 * default (the discovery beat) — room 0 is the one exception, since the
 * party starts there with no door to walk through, so Start calls this with
 * `hidden:false`. The encounter is generated and spawned directly (the old
 * Accept/Reroll preview was removed by #93) — it's just handed a target
 * room instead of "near a focus token." No theme dialog, though (ITEM-21):
 * a dungeon run's traits/excludeTraits are captured once at "Start Dungeon"
 * and reused unchanged for every room it populates (eager pregeneration at
 * Start, the resolution-time ensure-built retry, and combat recovery all
 * funnel through here), so re-asking for the same traits every
 * time would just repeat a prompt the GM already answered. `seed` (ITEM-17)
 * is needed to know this room's own actual size, for the encounter's
 * spawn-placement area.
 */
export async function populateSlotEncounter(
  scene,
  roomId,
  {
    rect,
    prefillTraits = [],
    prefillExcludeTraits = [],
    hidden = true,
    levelOffsetBias = 0,
    depthBias = null,
    locationTag = null,
    seed = "",
    isBoss = false,
  } = {},
) {
  await generateEncounter({
    prefillTraits,
    prefillExcludeTraits,
    levelOffsetBias,
    depthBias,
    locationTag,
    isBoss,
    skipThemeDialog: true,
    scene,
    originArea: {
      x: toPixels(rect.gx),
      y: toPixels(rect.gy),
      width: toPixels(rect.gw),
      height: toPixels(rect.gh),
    },
    forceHidden: hidden,
    extraFlags: { [MODULE_ID]: { dungeonSlot: roomId } },
  });
}

/**
 * Spawn a real trap-tagged hazard from `pf2e.hazards` inside slot's own
 * footprint (#135), for a `trap` room (#32; `buildPopulateAndUnlockGraphNode`'s
 * own job to know that — this function doesn't care where
 * `partyLevel`/`levelOffsetBias` came from). Hidden, exactly like a combat
 * room's own monsters
 * (`populateSlotEncounter` above) — `revealSlotTokens` already un-hides
 * anything flagged `dungeonSlot`, generic to token kind, so no changes
 * were needed there for this to work; #134's `rollTrapDetection` is what
 * actually "finds" a trap once revealed, the same way a Perception check
 * finds anything else hidden on the scene.
 *
 * `disposition: 0` (neutral) rather than `-1` (hostile, what
 * `spawnCreatures` defaults to for monsters) — an unattended hazard isn't
 * anyone's combatant, same reasoning #96's cover items already use.
 * `trapHazard: true` alongside the usual `dungeonSlot` flag mirrors
 * #96/#146's own `coverItem` flag: nothing currently reads it (a `trap`
 * room never starts a real Combat, so `dungeon-combat.mjs`'s
 * `combatantTokens` sweep never runs against this slot at all), but it's
 * cheap, harmless insurance against ever reintroducing that exact class of
 * bug for a hazard actor that, like a cover item, should never take a turn.
 *
 * A no-op (with a GM-facing warning) if the compendium has nothing
 * level-appropriate — the room's own setpiece stub text
 * (`dungeon-setpieces.json`) stays the only thing the GM sees for that
 * rare case, per #135's own "only fall back to a hand-authored stub for a
 * case the compendium genuinely doesn't have."
 *
 * Flags the newly spawned actor `trapCustomization: {status: 'pending',
 * locationTag, partyLevel, sceneId, roomId}` (#136, `sceneId`/`roomId`
 * added by #56) — the one place that flag gets set, read back by
 * `trap-combat.mjs`'s `getPendingTrapCustomization` for `tools/agent-loop`'s
 * poller to offer an external agent a chance to rewrite its name/description
 * before the room's reveal door ever opens, and (#56) by
 * `applyTrapCustomization` to find which room's persisted `trap` state to
 * keep in sync once a customization actually lands. `locationTag` is
 * threaded straight through from the room (this function's own caller
 * already has it; `populateSlotTrap` itself has no opinion on where it came
 * from), so the agent knows what terrain/theme to write flavor for.
 *
 * Also seeds `roomId`'s own persisted `trap` state (#56, via
 * `ensureTrapState`) with the spawned hazard's own name/description — the
 * same reason `ensurePuzzleState` persists a puzzle's name/summary onto the
 * room rather than leaving it to be read fresh off the raw setpiece every
 * render: it gives a player-facing display (dungeon-app.mjs's setpiece
 * block) real, room-specific data to show instead of always falling back to
 * one of the 3 generic, unrelated static stub blurbs in
 * `dungeon-setpieces.json`, customized or not.
 */
export async function populateSlotTrap(
  scene,
  slot,
  { rect, partyLevel, levelOffsetBias = 0, locationTag = null, seed = "", roomId } = {},
) {
  const api = makeFoundryApi(scene);
  const rng = splitmix32(seedFromString(`${seed}-trap-${slot}`));
  const trap = await selectTrap({ api, partyLevel, levelOffsetBias, rng });
  if (!trap) {
    ui.notifications.warn(
      game.i18n.localize("PF2EDC.Dungeon.Trap.NoneFoundWarning"),
    );
    return;
  }
  const [spawned] = await api.spawnCreatures(
    [{ pack: trap.pack, id: trap.id }],
    {
      originArea: {
        x: toPixels(rect.gx),
        y: toPixels(rect.gy),
        width: toPixels(rect.gw),
        height: toPixels(rect.gh),
      },
      disposition: 0,
      hidden: true,
      extraFlags: { [MODULE_ID]: { dungeonSlot: slot, trapHazard: true } },
    },
  );
  const actor = spawned && game.actors.get(spawned.actorId);
  if (actor) {
    await actor.setFlag(MODULE_ID, "trapCustomization", {
      status: "pending",
      locationTag,
      partyLevel,
      sceneId: scene.id,
      roomId,
    });
    await ensureTrapState(scene.id, roomId, {
      name: actor.name,
      description: actor.system?.details?.description ?? "",
    });
  }
}

/** Un-hides slot's tagged tokens (discovery). Returns the ids revealed. */
export async function revealSlotTokens(scene, slot) {
  const tokens = scene.tokens.filter(
    (t) => t.getFlag(MODULE_ID, "dungeonSlot") === slot && t.hidden,
  );
  const ids = tokens.map((t) => t.id);
  if (ids.length)
    await scene.updateEmbeddedDocuments(
      "Token",
      ids.map((id) => ({ _id: id, hidden: false })),
    );
  return ids;
}

/** Inverse of revealSlotTokens, for undo. */
export async function hideTokens(scene, tokenIds) {
  if (tokenIds?.length) {
    await scene.updateEmbeddedDocuments(
      "Token",
      tokenIds.map((id) => ({ _id: id, hidden: true })),
    );
  }
}

function partyActorIds() {
  return new Set((game.actors?.party?.members ?? []).map((m) => m.id));
}

/** An actor should only ever have one token in the world at a time (the party
 * moves as a unit between the dungeon and wherever they came from) — used by
 * both placePartyInRoom and teardownDungeonRun's return-trip placement. */
async function removeActorTokensFromAllScenes(actorId) {
  for (const s of game.scenes) {
    const existing = s.tokens.filter((t) => t.actor?.id === actorId);
    if (existing.length)
      await s.deleteEmbeddedDocuments(
        "Token",
        existing.map((t) => t.id),
      );
  }
}

/** Start-of-run: place the party's tokens inside roomId, removing any of
 * their tokens elsewhere in the world first. `rank`/`col` (#93) position
 * the room via roomRect; `seed` (ITEM-17) sizes it. */
export async function placePartyInRoom(scene, roomId, rank, col, partyMembers, seed) {
  const rect = roomRect(seed, roomId, rank, col);
  const occupied = [];
  const createdIds = [];
  for (const actor of partyMembers) {
    await removeActorTokensFromAllScenes(actor.id);
    const spot = freeSpotInRect({ occupied, rect, gw: 1, gh: 1 }) ?? {
      gx: rect.gx,
      gy: rect.gy,
      gw: 1,
      gh: 1,
    };
    occupied.push(spot);
    const td = await actor.getTokenDocument({
      x: toPixels(spot.gx),
      y: toPixels(spot.gy),
    });
    const [created] = await scene.createEmbeddedDocuments("Token", [
      td.toObject(),
    ]);
    createdIds.push(created.id);
  }
  return createdIds;
}

/**
 * End-of-run return trip (ITEM-18's teardownDungeonRun): cluster the party
 * near a scene's own center, in that scene's own grid units rather than this
 * module's fixed GRID_SIZE — `destScene` is an arbitrary scene this module
 * never built (the party's own regular scene, or Foundry's built-in default),
 * so it can't be assumed to share the dungeon's grid size.
 */
async function placePartyNearSceneCenter(destScene, partyMembers) {
  const spacing = Math.max(destScene.grid?.size ?? 100, 50);
  const centerX = (destScene.width ?? spacing * 10) / 2;
  const centerY = (destScene.height ?? spacing * 10) / 2;
  const perRow = 3;
  const createdIds = [];
  for (const [i, actor] of partyMembers.entries()) {
    await removeActorTokensFromAllScenes(actor.id);
    const col = i % perRow;
    const row = Math.floor(i / perRow);
    const x = centerX + (col - 1) * spacing;
    const y = centerY + row * spacing;
    const td = await actor.getTokenDocument({ x, y });
    const [created] = await destScene.createEmbeddedDocuments("Token", [
      td.toObject(),
    ]);
    createdIds.push(created.id);
  }
  return createdIds;
}

/**
 * Deletes every non-party actor (and, unless `deleteTokens` is false, its
 * token) still on `scene` — any NPC or converted loot corpse (#172) left
 * over from this run's own encounters, since `spawnCreatures`/
 * `spawnBuiltCreature` (foundry-api.mjs) always create a real, permanent
 * world Actor that otherwise outlives its token forever (confirmed live: 72
 * such orphaned actors had accumulated in this world before
 * `teardownDungeonRun` existed to catch them at Abandon time). Keyed purely
 * on "not a party member," never on actor type, so an un-looted #172 corpse
 * is swept exactly the same as an un-deleted NPC always was. Shared by
 * `teardownDungeonRun` (scene is about to be deleted, so the token deletion
 * below is redundant but harmless), #204's completion-time sweep (the scene
 * survives, so this is the only thing that actually removes them), and #14's
 * `deleteScene` hook (the scene is already gone by the time that hook fires
 * — Foundry's own delete cascade already removed its Tokens, so calling
 * `deleteEmbeddedDocuments` on it would throw; `deleteTokens: false` skips
 * straight to the Actor cleanup that cascade can't do for us).
 */
export async function sweepLooseNpcActors(scene, { deleteTokens = true } = {}) {
  const partyIds = partyActorIds();
  const looseTokens = scene.tokens.filter(
    (t) => t.actor?.id && !partyIds.has(t.actor.id),
  );
  const npcTokenIds = looseTokens.map((t) => t.id);
  const npcActorIds = [...new Set(looseTokens.map((t) => t.actor.id))];

  if (deleteTokens && npcTokenIds.length)
    await scene.deleteEmbeddedDocuments("Token", npcTokenIds);
  if (npcActorIds.length) await Actor.deleteDocuments(npcActorIds);

  return npcActorIds.length;
}

/**
 * Sweeps any #172 corpse (or plain leftover NPC) still on `scene` once a
 * dungeon run completes normally — the goal room resolved, not the party
 * abandoning the run (see `teardownDungeonRun` for that path). Unlike
 * `teardownDungeonRun`, the scene itself is left alone and the party stays
 * put: a completed dungeon is still a real place the party might keep
 * exploring or looting, not something to be yanked out of automatically.
 * Before this, only `teardownDungeonRun`'s Abandon-time sweep ever cleaned
 * these up — a party that *wins* and walks away left every un-looted corpse
 * behind indefinitely (#204).
 */
export async function sweepCompletedDungeonScene(scene) {
  return sweepLooseNpcActors(scene);
}

/**
 * Full teardown for a cancelled dungeon run (ITEM-18). Moves the party back
 * to `previousSceneId` (wherever they were before the run started — see
 * dungeon-runner.mjs's createRun) if that scene still exists, or Foundry's
 * own built-in "Foundry Virtual Tabletop" default scene otherwise. Sweeps
 * every non-party actor this run's encounters ever spawned (see
 * `sweepLooseNpcActors`), then deletes the dungeon scene itself.
 */
export async function teardownDungeonRun(
  scene,
  { previousSceneId = null } = {},
) {
  const partyIds = partyActorIds();
  const partyMembers = (game.actors?.party?.members ?? []).filter((m) =>
    partyIds.has(m.id),
  );

  let destScene = previousSceneId ? game.scenes.get(previousSceneId) : null;
  if (!destScene)
    destScene =
      game.scenes.find((s) => s.name === "Foundry Virtual Tabletop") ?? null;

  if (destScene && partyMembers.length) {
    await placePartyNearSceneCenter(destScene, partyMembers);
    await destScene.activate();
  }

  const deletedNpcActorCount = await sweepLooseNpcActors(scene);
  await scene.delete();

  return {
    destSceneId: destScene?.id ?? null,
    deletedNpcActorCount,
  };
}

/** Move already-placed tokens into roomId — for undo, stepping the party
 * back. Keyed by roomRect(seed, roomId, rank, col), since a room's
 * position is no longer derivable from an integer alone (#93). */
export async function moveTokensToRoom(
  scene,
  tokenIds,
  roomId,
  rank,
  col,
  seed,
  { teleport = false } = {},
) {
  if (!tokenIds?.length) return;
  const rect = roomRect(seed, roomId, rank, col);
  const updates = tokenIds.map((id, i) => ({
    _id: id,
    x: toPixels(rect.gx + (i % rect.gw)),
    y: toPixels(rect.gy + Math.floor(i / rect.gw)),
  }));
  // #439: a plain update is constrained by Foundry's wall-collision pipeline
  // (the #87/#141 root cause); retreat must pass teleport so tokens cross walls.
  await scene.updateEmbeddedDocuments(
    "Token",
    updates,
    teleport ? { teleport: true } : undefined,
  );
}

/** #412: a room's depth bias with the run's difficulty cap applied. Drives
 * combat's level band + XP ceiling and trap level offset. */
export function effectiveRoomBias({ rank, maxRank, isGoal, difficulty }) {
  return applyDifficultyCap(depthBiasFor({ rank, maxRank, isGoal }), difficulty);
}

/**
 * Build+populate+unlock one graph room (#93 replacement for the old
 * linear-slot builder, since deleted) — the function Tasks 11/12/13
 * actually call. Walls (this room's own enclosure, plus every incoming connection's
 * own geometry, real AND hidden) + content population + door unlock, all
 * keyed by `room.id` (string) everywhere the original used `physicalSlot`
 * (integer) as the `dungeonSlot` flag value and the `populateSlot*`/
 * `depthBiasFor` argument — the flag NAME `dungeonSlot` is unchanged, only
 * what gets stored in it changes.
 */
export async function buildPopulateAndUnlockGraphNode(
  scene,
  state,
  room,
  { rank, col, childIds = [], hiddenChildId = null, unlock = true } = {},
) {
  const alreadyBuilt = isSlotBuilt(scene, room.id);
  const rect = roomRect(state.seed, room.id, rank, col);

  // #174 Task 5: every room's own {rank, col}, inverted from
  // state.layoutPositionByRoomId (populated once for the whole graph
  // ahead of any room build — full pregeneration, Task 12) into
  // "rank,col" -> roomId. Passed to buildEdgeCorridor below so
  // findCorridorPath can treat any OTHER room's cell as blocked when
  // routing this room's own incoming connections around it.
  const occupiedCells = {};
  for (const [otherRoomId, pos] of Object.entries(state.layoutPositionByRoomId)) {
    occupiedCells[`${pos.rank},${pos.col}`] = otherRoomId;
  }
  // #174 Task 6: this room's own real incoming face, precomputed once for
  // the whole graph (dungeon-app.mjs) — the `?? 'north'` fallback only
  // matters for a room this task's own precompute step somehow missed.
  // #174 follow-up: optional chaining here (not just the `?? 'north'`
  // fallback) matters for a run whose own state was persisted before
  // this field existed — reading a property off `undefined` would throw
  // instead of falling back, leaving the party's room-build stuck.
  const incomingFace = state.incomingFaceByRoomId?.[room.id] ?? 'north';
  // #415: absent on any run persisted before the outgoing door plan existed.
  const layoutVersion = state.layoutVersion ?? 1;
  // #427: dead-end stubs exist only on layoutVersion >= 3 runs; an older state's `stubEdges` is ignored.
  const stubEdges = layoutVersion >= 3 ? (state.stubEdges ?? {}) : {};
  // #585: walled dead edges (absent on a run created before them) build nothing: excluded like stubs below.
  const walledEdges = layoutVersion >= 3 ? (state.walledEdges ?? {}) : {};
  const excludedEdges = mergeEdgeMaps(stubEdges, walledEdges);
  const planFor = layoutVersion >= 2
    ? (sourceId) => outgoingPlanFromState(state.seed, sourceId, { ...state, stubEdges })
    : undefined;
  // #427 (layoutVersion >= 3): the whole layout's topology-aware routing; undefined below version 3.
  const routingFor = routingFromState(state);

  // #93 pre-flight fix (merge-door redesign): every real parent this room
  // has (usually 1, more for a merge room), plus a shortcut's hidden extra
  // incoming source if any. A detour room's one real parent link (found via
  // layoutEdges, since it only exists there) is marked hidden here, not by
  // incomingConnectionsFor itself — its sole connection IS the hidden path,
  // but Task 5's function has no notion of "detour" and shouldn't need
  // one; this caller already has `state.hiddenRooms`.
  const isDetour = state.hiddenRooms.includes(room.id);
  // #427 (layoutVersion >= 3): slot N goes to the Nth connection of incomingSlotsV3 (incomingDoorOrder, then
  // the priority swap), a pure function of the layout. Everything below indexes by this order, and
  // buildRoomAtGraphNode's placeholder lookup too.
  const v3Slots = layoutVersion >= 3
    ? incomingSlotsV3(state.seed, room.id, { rank, col }, {
      layoutEdges: state.layoutEdges, hiddenIncomingByRoomId: state.hiddenIncomingByRoomId,
      positionByRoomId: state.layoutPositionByRoomId, occupiedCells, incomingFace, planFor, detour: isDetour,
      stubEdges: excludedEdges,
    })
    : null;
  const incomingConnections = v3Slots
    ? v3Slots.map(({ sourceId, hidden }) => ({ sourceId, hidden }))
    : incomingConnectionsFor(state.layoutEdges, room.id, state.hiddenIncomingByRoomId, excludedEdges)
      .map((conn) => (isDetour ? { ...conn, hidden: true } : conn));

  if (!alreadyBuilt) {
    // Creates this room's own enclosure walls + floor art + light already
    // (see buildRoomAtGraphNode above) — does NOT delete any incoming
    // placeholder yet (that's this function's own job, after each
    // connection below).
    const { placeholderIdsByConnection } = await buildRoomAtGraphNode(
      scene,
      room.id,
      {
        rank, col, childIds, incomingConnections, hiddenChildId,
        isGoal: room.isGoal, kind: room.kind, locationTag: room.locationTag,
        artVariant: room.artVariant, seed: state.seed,
        layoutPositionByRoomId: state.layoutPositionByRoomId,
        occupiedCells, incomingFace,
        incomingFaceByRoomId: state.incomingFaceByRoomId,
        edges: state.edges,
        layoutEdges: state.layoutEdges,
        hiddenIncomingByRoomId: state.hiddenIncomingByRoomId,
        layoutVersion,
        hiddenEdges: state.hiddenEdges ?? {},
        stubEdges,
        walledEdges,
        hiddenRooms: state.hiddenRooms ?? [],
        routingFor,
      },
    );

    const connectionWalls = [];
    const tiles = [];
    const placeholderIdsToDelete = [];
    // One door per incoming connection, all on this room's own incoming
    // face (usually north, sometimes west — #174 Task 6) — doorSlotsForFace's
    // Nth slot corresponds to incomingConnections' Nth entry (same order,
    // same length).
    // #297 Round 2: assign door slots with priority for a colliding
    // connection, so Round 1's own already-proven dogleg never needs to
    // widen toward a co-parent's own slot -- see this room's own spec
    // ("Round 2 correction: slot priority") for the full reasoning. Every
    // OTHER connection's own slot, and Round 1's own buildEdgeCorridor call
    // below (unchanged), are completely unaffected.
    // (v3: `v3Slots` above already carries the swapped slots, on the incomingDoorOrder-sorted list.)
    const slots = v3Slots
      ? v3Slots.map(({ slot }) => slot)
      : assignDoorSlotsWithPriority(
        state.seed, rect, incomingConnections, incomingFace,
        findPriorityCollision(
          state.seed, room.id, rank, col, incomingConnections, state.layoutPositionByRoomId, occupiedCells, incomingFace, planFor,
        ),
      );
    for (let i = 0; i < incomingConnections.length; i += 1) {
      const { sourceId, hidden } = incomingConnections[i];
      const toSlot = slots[i];
      const sourcePos = state.layoutPositionByRoomId[sourceId];
      const sourceRect = roomRect(state.seed, sourceId, sourcePos.rank, sourcePos.col);
      const sourceChildIds = state.edges[sourceId] ?? [];
      // Which face did the SOURCE room use to exit toward THIS room? For a
      // real connection, whichever index this room occupies among the
      // source's own real children. For a hidden connection (shortcut
      // extra, or a detour's one real parent link), the source's hidden
      // outgoing target is always reserved right after its real children
      // (exitFaceForIndex(sourceChildIds.length) — same convention
      // buildRoomAtGraphNode's own hiddenFaceIndex uses for itself).
      const sourceIncomingFace = state.incomingFaceByRoomId?.[sourceId] ?? 'north'; // #174 Task 6: incomingFaceByRoomId is now real, non-empty data; the fallback only covers a state predating this precompute step
      // #415 (layoutVersion 2): face and door come from the source's plan.
      const plannedExit = planFor?.(sourceId).get(room.id);
      const exitFaceFromSource = plannedExit
        ? plannedExit.face
        : hidden
          ? exitFaceForIndex(sourceChildIds.length, sourceIncomingFace)
          : exitFaceForIndex(sourceChildIds.indexOf(room.id), sourceIncomingFace);
      // #174 Task 4/5: sourcePos/{rank, col} let buildEdgeCorridor pathfind
      // (findCorridorPath) a route around any other room's own occupied
      // cell instead of assuming a direct/single-corner connection.
      const { doorWall, revealDoorWall, plainWalls, corridorSegments, transitCells } =
        buildEdgeCorridor(state.seed, sourceId, room.id, sourceRect, rect, sourcePos, { rank, col }, exitFaceFromSource, toSlot, occupiedCells, incomingFace, plannedExit,
          layoutVersion >= 3 ? { ...routingFor?.(`${sourceId}->${room.id}`), coverDoorCell: true } : undefined);
      if (hidden) {
        // #156: sealed until Task 9's reveal step explicitly promotes it
        // (both doorWall and revealDoorWall share the SAME
        // dungeonHiddenDoorForEdge value, matching
        // unsealHiddenDoorFromRoom's own lookup) — never added to
        // `dungeonDoorToRoomId`/`dungeonRevealDoorForSlot`, so a locked
        // hidden door can't resolve through handleDungeonDoorOpened
        // (Task 11) before that happens.
        //
        // #93 pre-flight fix (found during Task 11's own review, fix round
        // 2): also tagged `dungeonHiddenDoorRole` ('gate'/'reveal') on each
        // wall — the two are otherwise geometrically indistinguishable
        // once queried back by their shared dungeonHiddenDoorForEdge
        // value, and `unsealHiddenDoorFromRoom` (Task 9 addendum) needs to
        // know which one to promote to `dungeonDoorToRoomId` (the
        // progress-gate flag, never itself the reveal trigger) vs.
        // `dungeonRevealDoorForSlot` (Task 11's actual reveal-open
        // trigger, added in that task's own fix round 1) — without this,
        // a revealed hidden door would carry only `dungeonDoorToRoomId`
        // and Task 11's handler (which reads `dungeonRevealDoorForSlot`)
        // would silently never fire for it.
        connectionWalls.push(
          wallDoc(doorWall, { flags: { [MODULE_ID]: { dungeonHiddenDoorForEdge: `${sourceId}->${room.id}`, dungeonHiddenDoorRole: "gate" } }, ds: CONST.WALL_DOOR_STATES.LOCKED, door: CONST.WALL_DOOR_TYPES.DOOR }),
          wallDoc(revealDoorWall, { flags: { [MODULE_ID]: { dungeonHiddenDoorForEdge: `${sourceId}->${room.id}`, dungeonHiddenDoorRole: "reveal" } }, ds: CONST.WALL_DOOR_STATES.LOCKED, door: CONST.WALL_DOOR_TYPES.DOOR }),
          ...plainWalls.map((w) => wallDoc(w)),
        );
      } else {
        // #93 pre-flight fix (fix round 1 — found by task review): a real
        // door wall must carry BOTH ends of the edge, not just the target.
        // `dungeonDoorToRoomId` alone is what Task 11's
        // `handleDungeonDoorOpened` reads off ONE specific clicked wall
        // (fine, unambiguous there) — but a merge room has MULTIPLE real
        // doors all flagged `dungeonDoorToRoomId: room.id` (one per real
        // parent), and `unlockDoorsFromRoom` (below) needs to find the ONE
        // door belonging to a SPECIFIC source room, not "whichever one
        // Array.find happens across the whole scene." Without
        // `dungeonDoorFromRoomId`, resolving room A's own outcome could
        // unlock room B's door into the merge room instead of A's — the
        // exact "every parent but one dead-ends" bug this whole redesign
        // exists to fix, just moved from build-time to unlock-time.
        connectionWalls.push(
          wallDoc(doorWall, { flags: { [MODULE_ID]: { dungeonDoorToRoomId: room.id, dungeonDoorFromRoomId: sourceId } }, ds: CONST.WALL_DOOR_STATES.LOCKED, door: CONST.WALL_DOOR_TYPES.DOOR }),
          wallDoc(revealDoorWall, { flags: { [MODULE_ID]: { dungeonRevealDoorForSlot: room.id, dungeonDoorFromRoomId: sourceId } }, ds: CONST.WALL_DOOR_STATES.CLOSED, door: CONST.WALL_DOOR_TYPES.DOOR }),
          ...plainWalls.map((w) => wallDoc(w)),
        );
      }
      // Corridor floor tiles — one per corridorSegments entry (1 for a
      // straight edge, 2 for an L-shaped edge, Task 6), same per-tile
      // variant/rotation logic the old linear-slot builder's single-corridorRect
      // loop always used, just offset by each segment's own gx/gy instead
      // of a single shared corridorRect's.
      tiles.push(...corridorTilesForSegments(corridorSegments, { fullWidth: layoutVersion >= 3 }));
      placeholderIdsToDelete.push(...placeholderIdsByConnection[i]);

      // #174 Task 4/5: every intermediate, empty cell this connection's
      // own path routes through (obstacle detour only — empty for a
      // direct/single-corner connection, today's common case) gets its
      // own corridor floor + outer-boundary containment, built here
      // rather than batched with this room's own connectionWalls/tiles
      // above, since each cell needs to read the scene's CURRENT wall/tile
      // state (for its own idempotency check and to accumulate openings
      // across possibly-multiple crossing edges) before deciding what to
      // create.
      for (const cell of transitCells) {
        await buildTransitCellIfNeeded(scene, cell);
      }
    }

    // #110 ordering: create every connection's geometry (and this room's
    // own tiles) BEFORE deleting any placeholder, so there is never a frame
    // where a shared wall is neither the placeholder nor the real
    // corridor/door.
    if (connectionWalls.length) await scene.createEmbeddedDocuments("Wall", connectionWalls);
    if (tiles.length) await scene.createEmbeddedDocuments("Tile", tiles);
    if (placeholderIdsToDelete.length) await scene.deleteEmbeddedDocuments("Wall", placeholderIdsToDelete);
  }

  if (room.kind === "combat") {
    if (!isSlotPopulated(scene, room.id)) {
      const depthBias = effectiveRoomBias({
        rank,
        maxRank: state.maxRank,
        isGoal: room.isGoal,
        difficulty: state.difficulty,
      });
      await populateSlotEncounter(scene, room.id, {
        rect,
        prefillTraits: state.traits,
        prefillExcludeTraits: state.excludeTraits,
        levelOffsetBias: depthBias,
        depthBias,
        locationTag: room.locationTag,
        seed: state.seed,
        isBoss: room.isGoal,
      });
    }
    // Only unlock once monsters are actually in place — a failed population
    // leaves the door locked rather than opening onto an empty room; the
    // parent's resolution-time ensure-built retry (resolveCurrentRoom) or
    // the tracker's combat-recovery button re-attempts it.
    if (unlock && isSlotPopulated(scene, room.id))
      await unlockDoorsFromRoom(scene, room.id, childIds, state.hiddenEdges[room.id] ?? []);
  } else {
    // Every other room.kind branch (skill_challenge / trap / puzzle /
    // narrative / treasure) is UNCHANGED from the old linear-slot
    // builder's own body (deleted, #93 Task 15), with physicalSlot ->
    // room.id/rank (as the populateSlotTrap/depthBiasFor argument
    // respectively) and its final single-door unlock -> unlockDoorsFromRoom.
    if (room.kind === "skill_challenge") {
      const partyMembers = (game.actors?.party?.members ?? []).filter(
        (m) => m.type === "character",
      );
      // #164: the template (if any) is selected once, here, at the same
      // build-time this room's Victory Point state is first attached —
      // ensureSkillChallenge itself is a no-op past that point, so this
      // never re-rolls a template a later re-render/re-build might
      // otherwise see rendered differently.
      const setpieces = await loadDungeonSetpieces();
      const template = selectSkillChallengeTemplate(
        setpieces,
        state.seed,
        room.id,
      );
      await ensureSkillChallenge(scene.id, room.id, {
        seed: state.seed,
        locationTag: room.locationTag,
        partySize: partyMembers.length,
        depthBias: depthBiasFor({ rank, maxRank: state.maxRank, isGoal: room.isGoal }),
        template,
      });
    }
    // #32: puzzle and trap are now decided up front as their own room kinds
    // (dungeon-deck.mjs's ROOM_KIND_WEIGHTS/roomKindAt), so this dispatches
    // directly on room.kind — no more resolving the setpiece just to find
    // out which branch to take, the way the old combined 'puzzle_or_trap'
    // kind required. A puzzle setpiece's own state is attached right here
    // too (#109/#137) — it used to lazily attach itself the first time the
    // room rendered in dungeon-app.mjs, the same pattern skill_challenge's
    // own state used to use above before #109 moved it to this same
    // build-time spot, for the same reason: a client only relaying a
    // GM-less host's requests never renders DungeonApp at all. A trap room
    // additionally gets a real, mechanically-functional hazard spawned from
    // pf2e.hazards for #134's engine to run.
    if (
      room.kind === "trap" &&
      room.setpieceId &&
      !isSlotPopulated(scene, room.id)
    ) {
      await populateSlotTrap(scene, room.id, {
        rect,
        partyLevel: await makeFoundryApi().partyLevel(),
        levelOffsetBias: effectiveRoomBias({
          rank,
          maxRank: state.maxRank,
          isGoal: room.isGoal,
          difficulty: state.difficulty,
        }),
        locationTag: room.locationTag,
        seed: state.seed,
        roomId: room.id,
      });
    } else if (room.kind === "puzzle" && room.setpieceId) {
      const setpieces = await loadDungeonSetpieces();
      const setpiece = setpieces.find((s) => s.id === room.setpieceId);
      await ensurePuzzleState(scene.id, room.id, {
        hintChecks: setpiece.hintChecks,
        requiredSuccesses: setpiece.requiredSuccesses ?? null,
        partyLevel: await makeFoundryApi().partyLevel(),
        name: setpiece.name ?? null,
        summary: setpiece.summary ?? null,
        dcAdjustment: dcAdjustmentForTier(state.difficulty),
      });
    }
    // #167: a narrative room's own selected content is attached here too
    // (#165 gives it a setpieceId the same way a puzzle or trap room has
    // always had one) — persisted as `room.narrative` rather than read straight
    // off the raw setpiece (#165's original shape), so an external agent's
    // later customization (ensureNarrativeState's own docblock explains
    // why) has somewhere durable to land.
    if (room.kind === "narrative" && room.setpieceId) {
      const setpieces = await loadDungeonSetpieces();
      const setpiece = setpieces.find((s) => s.id === room.setpieceId);
      if (setpiece?.kind === "narrative" && isValidNarrativeTemplate(setpiece)) {
        await ensureNarrativeState(scene.id, room.id, { setpiece });
      }
    }
    // #89: a treasure room's own selected content is attached here too, the
    // same build-time spot as puzzle/narrative above — treasure has no
    // per-archetype mechanical shape to validate (unlike narrative's
    // isValidNarrativeTemplate) since a treasure setpiece carries nothing
    // but name/summary; any setpiece of this kind is usable as-is. This is
    // the integration point that makes treasure participate correctly in
    // #62's eager-build-for-GM-less-runs and mutation-reconciliation
    // machinery the same way every other kind already does — without it, a
    // GM-less run would never get a treasure room's flavor attached at all,
    // and a mutation that relocates a treasure room wouldn't reconcile its
    // content correctly either.
    if (room.kind === "treasure" && room.setpieceId) {
      const setpieces = await loadDungeonSetpieces();
      const setpiece = setpieces.find((s) => s.id === room.setpieceId);
      if (setpiece?.kind === "treasure") {
        await ensureTreasureState(scene.id, room.id, { setpiece });
      }
    }
    if (unlock) await unlockDoorsFromRoom(scene, room.id, childIds, state.hiddenEdges[room.id] ?? []);
  }
}

/** Unlocks every one of roomId's outgoing doors whose target is in childIds
 * but not in hiddenChildIds — #93: a graph room can have several exits, all
 * needing unlocking together once its own outcome resolves, unlike the old
 * linear-slot model's single one-door unlock. Each door was flagged dungeonDoorToRoomId
 * with its own target room id AND dungeonDoorFromRoomId with its own source
 * room id at build time (buildPopulateAndUnlockGraphNode above).
 *
 * #93 pre-flight fix (fix round 1 — found by task review): matching on
 * `dungeonDoorToRoomId === targetId` ALONE is not enough — a merge target
 * can have several real doors, all flagged with the SAME target id (one
 * per real parent), so `Array.find` would return whichever one happens to
 * come first in the scene's wall list, not necessarily THIS room's own
 * door. Matching on both ends of the edge together is what actually picks
 * out the right one. */
export async function unlockDoorsFromRoom(scene, roomId, childIds, hiddenChildIds = []) {
  const targets = childIds.filter((id) => !hiddenChildIds.includes(id));
  for (const targetId of targets) {
    const wall = scene.walls.find(
      (w) =>
        w.getFlag(MODULE_ID, "dungeonDoorToRoomId") === targetId &&
        w.getFlag(MODULE_ID, "dungeonDoorFromRoomId") === roomId,
    );
    if (wall) {
      await wall.update({ ds: CONST.WALL_DOOR_STATES.CLOSED });
      playDoorSound("unlock");
    }
  }
  // #427: the source's dead-end stub doors unlock with its real doors (Decision 10: indistinguishable, no extra
  // check). A hidden stub keeps its sealed hidden-door flags and opens only when revealed (unsealHiddenDoorFromRoom).
  for (const wall of scene.walls) {
    if (
      wall.getFlag(MODULE_ID, "dungeonStubDoorFor") &&
      wall.getFlag(MODULE_ID, "dungeonDoorFromRoomId") === roomId &&
      !wall.getFlag(MODULE_ID, "dungeonHiddenDoorForEdge")
    ) {
      await wall.update({ ds: CONST.WALL_DOOR_STATES.CLOSED });
      playDoorSound("unlock");
    }
  }
}

/** Resizes the scene ONCE for the whole graph's known extent — #93:
 * replaces the old per-room ensureSceneCovers/requiredDimensions(maxSlot)
 * pair, which depended on the deleted slotRowCol. Under full pregeneration
 * the graph's max rank/col is known before any room builds, so there's no
 * need to incrementally grow the canvas per room anymore; called once by
 * Task 12's startDungeonRun wiring right after layoutPositionByRoomId is
 * computed. */
export async function resizeSceneForLayout(scene, { maxRank, maxCol }) {
  const width = toPixels(INITIAL_GX + (maxCol + 1) * COLUMN_STRIDE + MARGIN_ROOMS);
  const height = toPixels((maxRank + 1) * ROW_STRIDE + MARGIN_ROOMS);
  const nextWidth = Math.max(scene.width ?? 0, width);
  const nextHeight = Math.max(scene.height ?? 0, height);
  if (nextWidth > (scene.width ?? 0) || nextHeight > (scene.height ?? 0)) {
    await scene.update({ width: nextWidth, height: nextHeight });
  }
}

// Module-private reentrancy guard: `updateWall`'s door-open hook can in
// principle fire more than once for the same wall/room before the first
// call's advanceToRoom/markRoomOutcome round-trip settles (a fast
// close-then-reopen, or the hook double-firing) — without this, a second
// concurrent call would re-run token reveal/combat start/advance for a
// room already being handled. Declared once at module scope, alongside
// this function.
const roomsBeingOpened = new Set();

/**
 * Called from module.mjs's `updateWall` hook whenever any door's state
 * changes to OPEN — ignores anything that isn't the true reveal door
 * (`dungeonRevealDoorForSlot`) for a room that's actually a live child of
 * the party's current room (`state.edges[state.currentRoomId]`), so a plain
 * scenery door, the progress-gate door being unlocked, an already-passed
 * room's door being reopened, or a GM idly clicking a wall can't desync the
 * tracker.
 *
 * Returns `{ autoOpenTracker }` (`false` on every early-return path, since
 * nothing was actually revealed) — #158: a combat room's own reveal already
 * draws the GM's attention through Foundry's native Combat Tracker the
 * instant `startCombatForRoom` runs below, but a skill challenge, puzzle/
 * trap, narrative, or rest room has no such native surface at all, so
 * without this the GM has to know to reopen the Dungeon Crawl tracker
 * themselves just to see the Succeed/Fail buttons. module.mjs's own
 * `updateWall` hook (which this file deliberately never imports back into,
 * see this file's own docblock) is what actually opens `DungeonApp` — this
 * only ever hands back the plain boolean, same bridge pattern
 * `onCombatAutoResolved` already uses for `resolveCurrentRoom`.
 */
export async function handleDungeonDoorOpened(sceneId, wallId, deps = {}) {
  // Called directly from a global hook, which fires on every connected
  // client — only the GM's own client should act on it.
  if (!game.user.isGM) return { autoOpenTracker: false };
  const scene = game.scenes.get(sceneId);
  const wall = scene?.walls.get(wallId);
  // #93 fix round 1 (found by this task's own review): the REVEAL door
  // (`dungeonRevealDoorForSlot`) is the real "open it and see what's
  // inside" trigger — the progress-gate door (`dungeonDoorToRoomId`) only
  // ever gets unlocked programmatically by `unlockDoorsFromRoom`; resolving
  // off IT instead would fire the reveal as soon as a room's outcome
  // resolves, before the party has actually opened its real door. See
  // buildEdgeCorridor's docblock (dungeon-layout.mjs, Task 6).
  // #439: a stub door (a dead-end corridor) only records discovery and may
  // offer a retreat; it never advances the run.
  const stubTargetId = wall?.getFlag(MODULE_ID, "dungeonStubDoorFor");
  if (stubTargetId) {
    const stubSourceId = wall.getFlag(MODULE_ID, "dungeonDoorFromRoomId");
    const stubState = getRunState(sceneId);
    // Only the party's CURRENT room's own stub door counts.
    if (!stubState || stubState.currentRoomId !== stubSourceId)
      return { autoOpenTracker: false };
    playDoorSound("open");
    const first = !stubState.stubsOpened?.[`${stubSourceId}->${stubTargetId}`];
    const after = await markStubOpened({
      sceneId,
      sourceId: stubSourceId,
      targetId: stubTargetId,
    });
    if (first) {
      await ChatMessage.create({
        content: game.i18n.localize("PF2EDC.Dungeon.Retreat.StubFlavor"),
      });
      await announceRetreatIfAvailable(scene, after, deps);
    }
    return { autoOpenTracker: true };
  }

  const roomId = wall?.getFlag(MODULE_ID, "dungeonRevealDoorForSlot");
  if (!roomId) return { autoOpenTracker: false };

  const state = getRunState(sceneId);
  if (!state || !(state.edges[state.currentRoomId] ?? []).includes(roomId))
    return { autoOpenTracker: false };

  if (roomsBeingOpened.has(roomId)) return { autoOpenTracker: false };
  roomsBeingOpened.add(roomId);
  try {
    // #439: re-entering a room the party already judged (after a retreat)
    // only moves the run; it must not re-reveal tokens, restart its combat,
    // or re-unlock anything. v3 (retreatVersion >= 1) runs only.
    if (
      state.retreatVersion >= 1 &&
      (state.history ?? []).some((h) => h.roomId === roomId)
    ) {
      playDoorSound("open");
      await advanceToRoom({ sceneId, roomId, revealedTokenIds: [] });
      const { rank, col } = state.layoutPositionByRoomId[roomId];
      focusCameraOnRoom(scene, roomId, rank, col, state.seed);
      return { autoOpenTracker: false };
    }
    // #93 fix round 1: no lazy-build fallback here anymore — see this
    // task's own "fix round 1" note above. By the time this room's reveal
    // door exists at all, that room's own build (Tile flag + both doors,
    // all written in the same buildPopulateAndUnlockGraphNode call) has
    // already completed; a door-open-time build-on-demand check here could
    // never fire. The real safety net for a room eager pregeneration
    // failed to build now lives at resolution time — see the rest-room
    // branch below, and Task 13's resolveCurrentRoom for every other kind.
    playDoorSound("open");
    const revealedTokenIds = await revealSlotTokens(scene, roomId);
    const room = state.rooms[roomId];
    // Started here, not at populate/build time — the room's monsters spawn
    // hidden, and starting Combat before the door is actually opened would
    // give away that a fight is coming.
    if (room?.kind === "combat") await startCombatForRoom(scene, roomId);
    const { ok, state: advancedState } = await advanceToRoom({
      sceneId,
      roomId,
      revealedTokenIds,
    });
    const { rank, col } = state.layoutPositionByRoomId[roomId];
    focusCameraOnRoom(scene, roomId, rank, col, state.seed);

    // A rest room (ITEM-5) is safe and has nothing to resolve — like the
    // entry, its own way forward opens immediately, no GM click required,
    // instead of leaving the party stuck with no Succeed/Fail button to
    // press. #93: under full pregeneration every room is ALREADY built
    // (Task 12's eager loop) in the common case — the ensure-built loop
    // below is the Review Focus item 1 safety net for the uncommon case
    // where it wasn't, not the normal path.
    if (room?.kind === "safe_rest" && ok) {
      const { state: resolvedState } = await markRoomOutcome({
        sceneId,
        succeeded: true,
      });
      const childIds = resolvedState.edges[roomId] ?? [];
      const hiddenChildIds = resolvedState.hiddenEdges[roomId] ?? [];
      // #93 fix round 1: ensure every child this room is about to unlock
      // a door to is actually built (and, for combat rooms, populated)
      // BEFORE unlocking — the one place a door is guaranteed not to
      // exist yet for the player to click, so it's the right place for
      // the fallback build, not the door-open handler itself.
      // buildPopulateAndUnlockGraphNode is already idempotent (checks
      // isSlotBuilt/isSlotPopulated internally), so calling it for an
      // already-fully-built child is a cheap no-op, not a duplicate build.
      for (const childId of [...childIds, ...hiddenChildIds]) {
        // #93 fix round 2 (found by this fix round's own re-review): the
        // {rank, col} lookup must sit INSIDE the try too — it's a plain
        // object-property read against `layoutPositionByRoomId`, same
        // risk class as the build call itself, and letting it throw
        // uncaught would abort the whole loop (skipping every remaining
        // child) and the notification, exactly the failure this try/catch
        // exists to contain.
        try {
          const child = resolvedState.rooms[childId];
          const { rank: childRank, col: childCol } = resolvedState.layoutPositionByRoomId[childId];
          await buildPopulateAndUnlockGraphNode(scene, resolvedState, child, {
            rank: childRank,
            col: childCol,
            childIds: resolvedState.edges[childId] ?? [],
            hiddenChildId: resolvedState.hiddenEdges[childId]?.[0] ?? null,
            unlock: false,
          });
        } catch (err) {
          console.error(`${MODULE_ID} | failed to build child room ${childId} before unlock`, err);
          ui.notifications?.error(
            game.i18n.localize("PF2EDC.Dungeon.RoomBuildFailedError"),
          );
        }
      }
      await unlockDoorsFromRoom(scene, roomId, childIds, hiddenChildIds);
      // #585: a rest room whose every way forward was walled is a dead end too.
      await announceNoWayForward(scene, resolvedState, deps);
    }

    return { autoOpenTracker: room?.kind !== "combat" };
  } finally {
    roomsBeingOpened.delete(roomId);
  }
}

/** #439: true while any started combat belongs to this scene. */
function sceneHasActiveCombat(scene) {
  return !!game.combats?.some((c) => c.scene?.id === scene?.id && c.started);
}

/** #439: after a stub door is first opened, either turn back automatically
 * (autoRetreat world setting) or post a chat card with a Turn back button. */
export async function announceRetreatIfAvailable(
  scene,
  state,
  { retreatToFork: doRetreat = retreatToFork } = {},
) {
  const verdict = canRetreat(state, {
    combatActive: sceneHasActiveCombat(scene),
  });
  if (!verdict.ok) return;
  if (game.settings.get(MODULE_ID, "autoRetreat")) {
    await doRetreat(scene.id);
    return;
  }
  const target = roomDisplayLabel(state, verdict.targetId, game.i18n);
  // #585: a walled dead end has no rubble; its card just offers the turn back.
  const walled = (state.stubEdges?.[state.currentRoomId] ?? []).length === 0;
  const message = game.i18n.format(
    walled ? "PF2EDC.Dungeon.Retreat.CardNoWay" : "PF2EDC.Dungeon.Retreat.Card",
    { target },
  );
  const label = game.i18n.localize("PF2EDC.Dungeon.Retreat.Button");
  await ChatMessage.create({
    content: `<p>${message}</p><button type="button" data-pf2edc-retreat>${label}</button>`,
    flags: { [MODULE_ID]: { retreatCard: { sceneId: scene.id } } },
  });
}

/**
 * #585: a room that resolves with no walkable forward exit and no stub (every forward edge was walled) says so once,
 * then offers Turn back like a discovered stub dead end does (autoRetreat turns back straight away). Runs created
 * before the walls (no `deadEdgeWalls`) and rooms with a way forward or a stub say nothing.
 */
export async function announceNoWayForward(scene, state, deps = {}) {
  if (!hasNoWayForward(state)) return;
  await ChatMessage.create({
    content: game.i18n.localize("PF2EDC.Dungeon.Retreat.NoWayForward"),
  });
  await announceRetreatIfAvailable(scene, state, deps);
}

/** #439: turn the party back to the nearest fork. Tokens are teleported
 * FIRST and the run state persisted AFTER, so a failed move leaves the run
 * in the dead end with the button still showing. Never unlocks doors. */
export async function retreatToFork(
  sceneId,
  { runnerRetreatTo = retreatTo } = {},
) {
  const scene = game.scenes.get(sceneId);
  const state = getRunState(sceneId);
  const verdict = canRetreat(state, {
    combatActive: sceneHasActiveCombat(scene),
  });
  if (!scene || !verdict.ok) {
    ui.notifications?.warn(
      game.i18n.localize(
        `PF2EDC.Dungeon.Retreat.Refused.${verdict.reason ?? "disabled"}`,
      ),
    );
    return { ok: false, reason: verdict.reason };
  }
  const target = verdict.targetId;
  const { rank, col } = state.layoutPositionByRoomId[target];
  const order = effectiveMarchingOrder(state);
  const partyIds = partyActorIds();
  const tokens = scene.tokens.filter((t) => partyIds.has(t.actor?.id));
  // Humans (not in the AI order) first, then AI actors in marching order.
  tokens.sort((a, b) => {
    const ia = order.indexOf(a.actor.id);
    const ib = order.indexOf(b.actor.id);
    return (ia < 0 ? -1 : ia) - (ib < 0 ? -1 : ib);
  });
  await moveTokensToRoom(
    scene,
    tokens.map((t) => t.id),
    target,
    rank,
    col,
    state.seed,
    { teleport: true },
  );
  const result = await runnerRetreatTo({
    sceneId,
    combatActive: sceneHasActiveCombat(scene),
  });
  if (!result.ok) return { ok: false, reason: result.reason };
  focusCameraOnRoom(scene, target, rank, col, state.seed);
  const walled = (state.stubEdges?.[state.currentRoomId] ?? []).length === 0;
  await ChatMessage.create({
    content: game.i18n.format(
      walled ? "PF2EDC.Dungeon.Retreat.TurnedNoWay" : "PF2EDC.Dungeon.Retreat.Turned",
      { target: roomDisplayLabel(state, target, game.i18n) },
    ),
  });
  return { ok: true };
}

/** Reverses the most recent automatic entry: re-hides what was revealed,
 * re-locks the door, and steps the party's tokens back a room. */
export async function undoRoomEntry(sceneId) {
  const scene = game.scenes.get(sceneId);
  const state = getRunState(sceneId);
  if (!scene || !canUndoRoomEntry(state)) {
    ui.notifications.warn(
      game.i18n.localize("PF2EDC.Dungeon.AlreadyResolvedUndoWarning"),
    );
    return;
  }

  const entry = state.lastAutoEntry;
  await hideTokens(scene, entry.revealedTokenIds);
  await relockDoorFromRoom(scene, entry.fromRoomId, entry.roomId);

  const previousRoomId = entry.fromRoomId;
  const { rank, col } = state.layoutPositionByRoomId[previousRoomId];
  const partyIds = partyActorIds();
  const partyTokenIds = scene.tokens
    .filter((t) => partyIds.has(t.actor?.id))
    .map((t) => t.id);
  await moveTokensToRoom(scene, partyTokenIds, previousRoomId, rank, col, state.seed);

  await undoLastRoomEntry({ sceneId });
}
