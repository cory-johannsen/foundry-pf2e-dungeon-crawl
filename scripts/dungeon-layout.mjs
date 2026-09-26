/**
 * Pure grid-unit geometry for a physical dungeon room layout — no Foundry
 * dependency, same split as dungeon-deck.mjs. A caller multiplies by the
 * scene's grid size to get pixels; this file only ever deals in grid
 * squares, the same separation scene-divination.mjs keeps between its
 * LAYOUT design space and layoutTransform()'s canvas space.
 *
 * Rooms are positioned by their graph rank/column (#93, roomRect) on a
 * uniform grid of cells (ROW_STRIDE/COLUMN_STRIDE) — computeRanks/
 * computeColumns below assign each room its cell; this file only answers
 * "given a room's rank/col, where is it and how does it connect to its
 * children," with no idea of when a room gets built.
 *
 * A connection runs from one of a room's own outgoing faces
 * (south/east/west, exitFaceForIndex) to a door slot on its child's north
 * face (northDoorSlots), each end at its own independently-randomized
 * offset — see buildEdgeCorridor's docblock.
 *
 * Every room is square, either ROOM_SIZE_SMALL or ROOM_SIZE_LARGE on a side
 * (ITEM-17) — picked per room, deterministically, by roomSizeAt.
 */
import { splitmix32, seedFromString } from './prng.mjs';

export const ROOM_SIZE_SMALL = 6;
export const ROOM_SIZE_LARGE = 12;
// Tunable, no anchor in the source material — most rooms are a normal size;
// a large one is a notable but not dominant occurrence.
const ROOM_SIZE_WEIGHTS = [
  { size: ROOM_SIZE_SMALL, weight: 3 },
  { size: ROOM_SIZE_LARGE, weight: 1 }
];
export const ROOMS_PER_ROW = 5;
export const CORRIDOR_LEN = 1;
export const DOOR_WIDTH = 1;

// gx starts at INITIAL_GX, not 0 — a west-moving row can walk backward by up
// to its own full width (confirmed live while implementing this: a 2-row
// dungeon with an all-small east row followed by an all-large west row drove
// gx to -6), and unlike gy (which only ever increases), nothing else bounds
// gx from below. Worst realistic case, given the Start form's own 20-room
// cap (at most 4 rows): each row's width is at most
// `ROOMS_PER_ROW * ROOM_SIZE_LARGE + (ROOMS_PER_ROW - 1) * CORRIDOR_LEN` =
// 64, so the most an odd (west-moving) row can ever drive gx down by, net of
// whatever the row before it added, is on that order — INITIAL_GX is set
// generously past that so gx stays positive (Foundry Tiles/Walls at a
// negative coordinate would sit outside this module's own scene, which only
// ever grows from an assumed (0,0) origin — see ensureSceneCovers) for any
// dungeon this module can actually generate, including a mutation or two
// (ITEM-9's Extra Travel Time) past the form's own cap.
export const INITIAL_GX = 300;

// Uniform grid cell strides — a deliberate simplification of a fully
// variable-width tree layout (see the design spec): every column is wide
// enough for the largest room, every rank tall enough for the tallest, so
// no two rooms ever overlap regardless of their individual roomSizeAt
// roll, and a room is still visually centered over its children via
// computeColumns' own column averaging.
export const ROW_STRIDE = ROOM_SIZE_LARGE + CORRIDOR_LEN;
export const COLUMN_STRIDE = ROOM_SIZE_LARGE + CORRIDOR_LEN;

/** A room's footprint, positioned by its graph rank/column instead of a linear slot. */
export function roomRect(seed, roomId, rank, col) {
  const size = roomSizeAt(seed, roomId);
  return {
    gx: INITIAL_GX + col * COLUMN_STRIDE,
    gy: rank * ROW_STRIDE,
    gw: size,
    gh: size
  };
}

/** Deterministic compass face for a room's Nth exit (0-2), always distinct. */
export function exitFaceForIndex(index) {
  return ['south', 'east', 'west'][index];
}

// Still used by Task 6's corridor routing to determine a straight
// segment's opposite endpoint direction — unrelated to which face a
// room's OWN incoming/outgoing connections land on (see below, #93
// pre-flight fix: incoming and outgoing are now always on structurally
// disjoint faces, north vs. south/east/west, never computed via OPPOSITE
// of each other for a room's own enclosure).
export const OPPOSITE = { north: 'south', south: 'north', east: 'west', west: 'east' };

/**
 * Deterministic size (ROOM_SIZE_SMALL or ROOM_SIZE_LARGE) for a room at a
 * given physical slot — same seeded-per-index convention as dungeon-deck.mjs
 * (doorOffsetAt's own docblock). A room is always square, so this one value
 * is both its width and its height.
 */
export function roomSizeAt(seed, slot) {
  const r = splitmix32(seedFromString(`${seed}-roomsize-${slot}`))();
  const totalWeight = ROOM_SIZE_WEIGHTS.reduce((sum, w) => sum + w.weight, 0);
  let x = r * totalWeight;
  for (const entry of ROOM_SIZE_WEIGHTS) {
    x -= entry.weight;
    if (x < 0) return entry.size;
  }
  return ROOM_SIZE_WEIGHTS[ROOM_SIZE_WEIGHTS.length - 1].size;
}

/**
 * Every real parent of `roomId` in `layoutEdges`, in deterministic
 * `Object.entries` order. Empty for the entry room. Usually length 1; a
 * merge room (multiple tips forced together by Task 2's forced-merge
 * algorithm — routine throughout the graph, not just the final goal) can
 * be longer. `layoutEdges` (not bare `edges`) so a detour room's one real
 * parent link — which only exists as a `layoutEdges` entry (#156) —
 * resolves too; `layoutEdges` equals `edges` for every non-detour room,
 * so every call site is safe to pass either.
 */
export function parentRoomIdsFor(layoutEdges, roomId) {
  if (roomId === 'room-entry') return [];
  const parents = [];
  for (const [parentId, children] of Object.entries(layoutEdges)) {
    if (children.includes(roomId)) parents.push(parentId);
  }
  return parents;
}

/**
 * Every incoming connection `roomId` needs its own door for, in slot
 * order — real parents first (`parentRoomIdsFor`, deterministic), then a
 * shortcut's hidden extra incoming source if any (`hiddenIncomingByRoomId`,
 * Task 3 — set only for a shortcut's target room; a detour room's one
 * incoming is already counted via its real `layoutEdges` parent link
 * above, never both). #93 pre-flight fix: this is the whole redesign in
 * one function — every entry this returns gets its own door slot on the
 * room's NORTH face (northDoorSlots, below), never a separate compass
 * direction. That's what actually guarantees a merge room gets a door
 * for EVERY real parent (previously only one was ever built, silently
 * dead-ending every other branch) and that incoming can never collide
 * with a room's own outgoing faces (south/east/west, always disjoint
 * from north).
 */
export function incomingConnectionsFor(layoutEdges, roomId, hiddenIncomingByRoomId = {}) {
  const real = parentRoomIdsFor(layoutEdges, roomId).map((sourceId) => ({ sourceId, hidden: false }));
  const hidden = (hiddenIncomingByRoomId[roomId] ?? []).map((sourceId) => ({ sourceId, hidden: true }));
  return [...real, ...hidden];
}

/** A room's own four wall segments, by compass side — exported (Task 10's
 * own #93 pre-flight fix) so dungeon-scene.mjs can look up an individual
 * outgoing face's segment directly (e.g. for a per-connection frontier
 * placeholder) without needing a new wrapper here. */
export function roomSidesForRect(rect) {
  const { gx, gy, gw, gh } = rect;
  return {
    north: { x1: gx, y1: gy, x2: gx + gw, y2: gy },
    south: { x1: gx, y1: gy + gh, x2: gx + gw, y2: gy + gh },
    west: { x1: gx, y1: gy, x2: gx, y2: gy + gh },
    east: { x1: gx + gw, y1: gy, x2: gx + gw, y2: gy + gh }
  };
}

/**
 * Divides a room's north wall into `count` equal, contiguous, left-to-
 * right door slots. Used for EVERY incoming connection — whether 1 for a
 * normal room, N for a merge room, or a normal room's real parent plus a
 * shortcut's extra hidden one (see `incomingConnectionsFor`, whose Nth
 * entry corresponds to this function's Nth slot).
 */
export function northDoorSlots(rect, count) {
  const { gx, gy, gw } = rect;
  const step = gw / count;
  return Array.from({ length: count }, (_, i) => ({
    x1: gx + i * step, y1: gy, x2: gx + (i + 1) * step, y2: gy,
  }));
}

/**
 * A room's own enclosing walls (#93 generalization). South/east/west stay
 * full-face, excluded per `outgoingFaces` (unchanged from before). North
 * is either a single solid wall (`incomingCount === 0`, the entry room)
 * or entirely excluded (`incomingCount > 0`) — its individual door slots
 * are built separately by the caller via `northDoorSlots`, one per real
 * connection-building step (needs the connecting room's rect, which this
 * function doesn't have), not here. `rect` is the room's own already-
 * computed `roomRect(...)` result — required, since rank/col (and so the
 * rect) aren't derivable from `roomId` alone the way the old slot-indexed
 * version could derive its own rect internally.
 */
export function roomEnclosureWalls(seed, roomId, { incomingCount = 0, outgoingFaces = [] }, rect) {
  const sides = roomSidesForRect(rect);
  const walls = [];
  for (const face of ['south', 'east', 'west']) {
    if (!outgoingFaces.includes(face)) walls.push({ dir: face, ...sides[face] });
  }
  if (incomingCount === 0) walls.push({ dir: 'north', ...sides.north });
  return walls;
}

/**
 * Deterministic offset (integer grid units, `[0, roomSize - DOOR_WIDTH]`)
 * for one room's own door/opening along a connecting face. `role` is
 * `'outgoing'` (a room's own lockable door, into its connection to the next
 * slot) or `'incoming'` (a room's own plain opening, on the face receiving
 * the connection from the previous slot) — a room's incoming and outgoing
 * faces are almost always different sides, so these are two independent
 * seeded picks, same per-index convention as dungeon-deck.mjs's
 * `locationTagAt` — not two reads of the same value. `roomSize` is the
 * *acting* room's own size (whichever room this door/opening sits on, not
 * necessarily the room on the other end of the connection) — every room is
 * square, so one value bounds the offset on either axis (ITEM-17).
 */
export function doorOffsetAt(seed, slot, role, roomSize) {
  const r = splitmix32(seedFromString(`${seed}-door-${role}-${slot}`))();
  // #93 pre-flight fix (found during this task's own final review, a
  // third independent pass, via a 13,860-configuration sweep): floored,
  // not bare `roomSize - DOOR_WIDTH`. Every OLD caller always passed an
  // integer roomSize (ROOM_SIZE_SMALL/ROOM_SIZE_LARGE), so this never
  // mattered before — but buildEdgeCorridor (Task 6) is the first caller
  // to pass a slotWidth (`toSlot.x2 - toSlot.x1`, from northDoorSlots),
  // which is fractional whenever the incoming-door count doesn't evenly
  // divide the room's width (e.g. ROOM_SIZE_SMALL = 6 split 4 ways ->
  // slotWidth = 1.5). Unfloored, `Math.floor(r * (maxOffset + 1))` can
  // round UP PAST a fractional maxOffset (e.g. maxOffset = 0.5 can still
  // return 1), pushing a door outside its own slot into a sibling's —
  // zero behavior change for every existing integer-roomSize call site,
  // since Math.floor of an already-integer value is a no-op.
  const maxOffset = Math.floor(roomSize - DOOR_WIDTH);
  return Math.floor(r * (maxOffset + 1));
}

// ============ Old slot-based helper ============
// #93 post-merge fix (Task 15 item 1): the old linear-slot connection
// geometry (slot rect walk, connection direction, outgoing-face
// placeholder, slot-to-slot connection) is deleted. slotRowCol was only
// ever called by that deleted code and now has no caller either — left in
// place because Task 15's own dead-code list didn't name it; flagged for a
// follow-up sweep.

/** Row/column of a physical slot, boustrophedon — independent of room size,
 * since it only decides *order*, not position. */
export function slotRowCol(slot) {
  const row = Math.floor(slot / ROOMS_PER_ROW);
  const posInRow = slot % ROOMS_PER_ROW;
  const col = row % 2 === 0 ? posInRow : ROOMS_PER_ROW - 1 - posInRow;
  return { row, col };
}

/**
 * Edge geometry connecting fromRoomId's exitFace to a specific door slot
 * on toRoomId's north face (`toSlot`, from `northDoorSlots` — Task 5's
 * redesign means "incoming" is always north, but potentially one of
 * several slots when the target has more than one real parent or a
 * hidden extra). `fromPos`/`toPos` are the two rooms' own {rank, col}
 * (#174 Task 4) — used to pathfind a route (`findCorridorPath`) around
 * any `occupiedCells` blocking a direct or single-corner connection.
 *
 * When the resulting path is length <= 2 (already adjacent, or no path
 * found so this falls back to a direct line), this is EXACTLY the
 * pre-#174 geometry below, unchanged: same-column rooms still get a
 * single straight corridor; different-column rooms get an L-shaped
 * 2-segment corridor (first segment leaves fromRect on exitFace, second
 * segment approaches `toSlot`, joined by a single corner) — generalizing
 * the old linear-slot connection geometry (slot to slot+1, always
 * straight, deleted by #93 Task 15) to any two graph-positioned rects.
 *
 * Otherwise (a longer path routing around an obstacle), a `transitCells`
 * entry is built for every intermediate cell via `transitCellCrossing`
 * (#174 Task 3), chained together and connected to fromRect/toRect by
 * the same corner-connector shape the branch below already uses between
 * its own exitPoint and entryPoint (`cornerConnector`, below).
 */
export function buildEdgeCorridor(seed, fromRoomId, toRoomId, fromRect, toRect, fromPos, toPos, exitFace, toSlot, occupiedCells) {
  const path = findCorridorPath(fromPos, toPos, occupiedCells, { fromRoomId, toRoomId });
  const slotWidth = toSlot.x2 - toSlot.x1;
  const outgoingOffset = doorOffsetAt(seed, `${fromRoomId}-${exitFace}`, 'outgoing', fromRect.gw);
  const incomingOffset = doorOffsetAt(seed, `${toRoomId}-north-${toSlot.x1}`, 'incoming', slotWidth);

  if (path && path.length > 2) {
    // Multi-cell path (#174): chain transitCellCrossing across every
    // intermediate cell, then connect fromRect's own exit point to the
    // first transit cell's entry point, and the last transit cell's exit
    // point to toRect's own entry point, via the same corner-connector
    // shape used below between exitPoint and entryPoint directly.
    const edgeId = `${fromRoomId}->${toRoomId}`;
    const transitCells = [];
    for (let i = 1; i < path.length - 1; i += 1) {
      const cell = path[i];
      const entrySide = directionBetween(cell, path[i - 1]);
      const exitSide = directionBetween(cell, path[i + 1]);
      const crossing = transitCellCrossing(seed, cell.rank, cell.col, entrySide, exitSide, edgeId);
      transitCells.push({ rank: cell.rank, col: cell.col, entrySide, exitSide, ...crossing });
    }

    const exitPoint = exitFace === 'east'
      ? { x: fromRect.gx + fromRect.gw, y: fromRect.gy + fromRect.gh / 2 }
      : exitFace === 'west'
      ? { x: fromRect.gx, y: fromRect.gy + fromRect.gh / 2 }
      : { x: fromRect.gx + fromRect.gw / 2, y: fromRect.gy + fromRect.gh };
    const doorWall = exitFace === 'south'
      ? { x1: exitPoint.x - DOOR_WIDTH / 2, y1: exitPoint.y, x2: exitPoint.x + DOOR_WIDTH / 2, y2: exitPoint.y }
      : { x1: exitPoint.x, y1: exitPoint.y - DOOR_WIDTH / 2, x2: exitPoint.x, y2: exitPoint.y + DOOR_WIDTH / 2 };
    const entryPoint = { x: toSlot.x1 + slotWidth / 2, y: toSlot.y1 };
    const revealDoorWall = { x1: entryPoint.x - DOOR_WIDTH / 2, y1: entryPoint.y, x2: entryPoint.x + DOOR_WIDTH / 2, y2: entryPoint.y };

    const firstCellPoint = transitCells[0].entryPoint;
    const lastCellPoint = transitCells[transitCells.length - 1].exitPoint;
    // #174 Task 4 deviation from the plan's own reference code: the plan
    // connected exitPoint->firstCellPoint (and lastCellPoint->entryPoint)
    // with a single bounding-box segment covering both the x AND y
    // difference. Traced by hand for a south-exit/east-entry combination
    // (fromRect at (300,0)-12x12, first transit cell to the WEST at
    // rank 0 col -1): that produces a segment spanning x:[300,306],
    // y:[0,12] — entirely inside fromRect's OWN footprint (which spans
    // x:[300,312], y:[0,12]) whenever the transit cell's entry offset
    // lands anywhere but the very bottom of its shared edge. That's a
    // room/corridor overlap, not a corridor.
    //
    // Using the same corner-connector shape the path.length<=2 branch
    // above already uses (one CORRIDOR_LEN-wide leg at the departure
    // axis, one at the arrival axis) fixes the general case, but the leg
    // anchored at the TRANSIT cell's own entry/exit point needs one more
    // fix: transitCellCrossing's round-2 fix (Task 3) established that a
    // point on a cell's 'east'/'south' side sits at that cell's FAR edge
    // (SIDE_POINT uses cell.gx+gw / cell.gy+gh), so a CORRIDOR_LEN-wide
    // leg extending forward from it overflows past that cell — here,
    // into whatever's on the other side, which (unlike two transit cells
    // side by side) can be fromRect/toRect's own flush west/north edge
    // (rooms have no west/north margin — cellMarginWalls' own docblock).
    // `cornerConnector`'s optional fromSide/toSide extends inward instead
    // on the leg that needs it, exactly like Task 3's own fix.
    //
    // Known residual gap (task-4-report.md has the full trace): this only
    // fully resolves the connector1 (fromRect -> firstCellPoint) case,
    // where the DEPARTING leg can lean on fromRect's own exit-face margin
    // (south/east) as a safe lane before the corrected leg turns toward
    // the transit cell. connector2 (lastCellPoint -> entryPoint) has no
    // such lane available — entryPoint is always on toRect's NORTH face,
    // which (like west) has NO margin at all — so when the path's LAST
    // hop approaches the target from anywhere but directly north, both
    // legs can still cut through toRect's own footprint (transitCellCrossing's
    // own randomized crossing offset has no awareness of a neighboring
    // room's footprint on a flush side). Filed for a follow-up rather than
    // solved here — a real fix needs either findCorridorPath (Task 1)
    // preferring an endpoint's margined sides, or a margin-aware crossing
    // point next to a room's own cell, both bigger than this task's scope.
    const corridorSegments = [
      ...cornerConnector(exitPoint, firstCellPoint, { toSide: transitCells[0].entrySide }),
      ...cornerConnector(lastCellPoint, entryPoint, { fromSide: transitCells[transitCells.length - 1].exitSide }),
    ];
    const plainWalls = [
      { x1: toSlot.x1, y1: entryPoint.y, x2: entryPoint.x - DOOR_WIDTH / 2, y2: entryPoint.y },
      { x1: entryPoint.x + DOOR_WIDTH / 2, y1: entryPoint.y, x2: toSlot.x2, y2: entryPoint.y },
    ].filter((w) => w.x1 !== w.x2 || w.y1 !== w.y2);

    return { doorWall, revealDoorWall, plainWalls, corridorSegments, transitCells };
  }

  // Adjacent (path.length <= 2), or no path found so we fall back to a
  // direct line (path == null) — UNCHANGED from before #174's Task 4,
  // verbatim, just with transitCells: [] added.
  const sameColumn = fromRect.gx === toRect.gx;
  if (exitFace === 'south' && sameColumn) {
    const faceY = fromRect.gy + fromRect.gh;
    // #93 pre-flight fix (found during Task 10's review): was
    // `faceY + CORRIDOR_LEN`, which only reached the target's actual
    // north edge when the source's room-size exactly filled one
    // ROW_STRIDE gap AND the two rooms were exactly one rank apart. A
    // merge room's rank is the MAX over all its real parents' ranks + 1
    // (computeRanks, Task 4) — a parent not on the longest path can sit
    // several ranks above the merge room, or roomSizeAt can roll a
    // smaller-than-max size, either of which left the corridor short of
    // the target (a door floating in empty space, not actually
    // connected). Use the target's real position directly instead.
    const corridorEndY = toRect.gy;
    const doorX0 = fromRect.gx + outgoingOffset;
    const doorX1 = doorX0 + DOOR_WIDTH;
    const gapX0 = toSlot.x1 + incomingOffset;
    const gapX1 = gapX0 + DOOR_WIDTH;
    const spanX0 = Math.min(doorX0, gapX0);
    const spanX1 = Math.max(doorX1, gapX1);
    return {
      doorWall: { x1: doorX0, y1: faceY, x2: doorX1, y2: faceY },
      revealDoorWall: { x1: gapX0, y1: corridorEndY, x2: gapX1, y2: corridorEndY },
      plainWalls: [
        { x1: fromRect.gx, y1: faceY, x2: doorX0, y2: faceY },
        { x1: doorX1, y1: faceY, x2: Math.max(fromRect.gx + fromRect.gw, spanX1), y2: faceY },
        // #93 pre-flight fix, round 2 (found during Task 6's own redo):
        // capped strictly at `toSlot.x1`/`toSlot.x2` — NEVER `spanX1`.
        // `spanX1` also folds in the SOURCE room's own door offset
        // (`doorX1`, bounded by the SOURCE's full width, not the
        // TARGET's narrower slot) — using it here (round 1's fix used
        // `Math.max(toSlot.x2, spanX1)`, which picks whichever is
        // LARGER) could still push this flanking wall past the slot
        // boundary into a sibling connection's own territory whenever
        // the source room is wider than one slot — routine for any
        // merge room with 2+ real parents. `gapX0`/`gapX1` are already
        // guaranteed within `[toSlot.x1, toSlot.x2]` (`incomingOffset`
        // is bounded by `slotWidth`), so these two walls need no
        // `Math.max`/`Math.min` at all — just the slot's own edges.
        { x1: toSlot.x1, y1: corridorEndY, x2: gapX0, y2: corridorEndY },
        { x1: gapX1, y1: corridorEndY, x2: toSlot.x2, y2: corridorEndY }
      ].filter((w) => w.x1 !== w.x2 || w.y1 !== w.y2),
      corridorSegments: [{ gx: spanX0, gy: faceY, gw: spanX1 - spanX0, gh: corridorEndY - faceY }],
      transitCells: [],
    };
  }

  // Different column (or a non-south exit face): a straight leg out of
  // fromRect on exitFace, a corner, then a straight leg into `toSlot`.
  // Simpler than the same-column case's precise two-door offset
  // trimming — a candidate for a future refinement pass if a reviewer
  // finds the corner geometry too blocky in practice.
  const exitPoint = exitFace === 'east'
    ? { x: fromRect.gx + fromRect.gw, y: fromRect.gy + fromRect.gh / 2 }
    : exitFace === 'west'
    ? { x: fromRect.gx, y: fromRect.gy + fromRect.gh / 2 }
    : { x: fromRect.gx + fromRect.gw / 2, y: fromRect.gy + fromRect.gh };
  const entryPoint = { x: toSlot.x1 + slotWidth / 2, y: toSlot.y1 };
  const corner = { x: entryPoint.x, y: exitPoint.y };

  const doorWall = exitFace === 'south'
    ? { x1: exitPoint.x - DOOR_WIDTH / 2, y1: exitPoint.y, x2: exitPoint.x + DOOR_WIDTH / 2, y2: exitPoint.y }
    : { x1: exitPoint.x, y1: exitPoint.y - DOOR_WIDTH / 2, x2: exitPoint.x, y2: exitPoint.y + DOOR_WIDTH / 2 };
  const revealDoorWall = { x1: entryPoint.x - DOOR_WIDTH / 2, y1: entryPoint.y, x2: entryPoint.x + DOOR_WIDTH / 2, y2: entryPoint.y };

  // #93 pre-flight fix: flank the door WITHIN this connection's own
  // `toSlot` (was `plainWalls: []` — left the room's whole north face
  // open beyond just the door itself, and left nothing to separate this
  // slot from a sibling's). Mirrors the same-column branch's own
  // slot-constrained plainWalls above.
  const plainWalls = [
    { x1: toSlot.x1, y1: entryPoint.y, x2: entryPoint.x - DOOR_WIDTH / 2, y2: entryPoint.y },
    { x1: entryPoint.x + DOOR_WIDTH / 2, y1: entryPoint.y, x2: toSlot.x2, y2: entryPoint.y },
  ].filter((w) => w.x1 !== w.x2 || w.y1 !== w.y2);

  return {
    doorWall,
    revealDoorWall,
    plainWalls,
    corridorSegments: [
      { gx: Math.min(exitPoint.x, corner.x), gy: Math.min(exitPoint.y, corner.y), gw: Math.max(CORRIDOR_LEN, Math.abs(corner.x - exitPoint.x)), gh: CORRIDOR_LEN },
      { gx: Math.min(corner.x, entryPoint.x), gy: Math.min(corner.y, entryPoint.y), gw: CORRIDOR_LEN, gh: Math.max(CORRIDOR_LEN, Math.abs(entryPoint.y - corner.y)) }
    ],
    transitCells: [],
  };
}

/** Which compass direction `from` a cell faces to reach an
 * orthogonally-adjacent `to` cell — 'north' if to is one rank up, etc.
 * (#174 Task 4 — used to label each transitCells entry's own
 * entrySide/exitSide when chaining transitCellCrossing across a
 * multi-cell findCorridorPath route.) */
function directionBetween(from, to) {
  if (to.rank < from.rank) return 'north';
  if (to.rank > from.rank) return 'south';
  if (to.col < from.col) return 'west';
  return 'east';
}

/**
 * Two CORRIDOR_LEN-wide segments joining `from` to `to` via a single
 * right-angle corner at (to.x, from.y) — `from`'s own leg runs
 * horizontal (fixed at from.y, variable x), `to`'s own leg runs vertical
 * (fixed at to.x, variable y), terminating exactly at `to`. Same shape
 * the path.length <= 2 branch above already uses between its own
 * exitPoint and entryPoint (see the `corner` variable there); generalized
 * here (#174 Task 4) for two arbitrary points — a fromRect/toRect
 * endpoint plus a transit cell's own entryPoint/exitPoint — since a
 * transit cell can be approached from any of its four sides, not just
 * the fixed exit-face/north-face pairing the adjacent branch assumes.
 *
 * `fromSide`/`toSide` (optional) are the compass side of a CELL boundary
 * that `from`/`to` sits on, when that point is a transit cell's own
 * entryPoint/exitPoint (never passed for a real room's exitPoint/
 * entryPoint, which always has margin/slack built in and never needs
 * this correction — see the call sites). Only 'south' (for `fromSide`,
 * affecting the from-anchored leg's fixed Y) or 'east' (for `toSide`,
 * affecting the to-anchored leg's fixed X) matter: those are the two
 * sides transitCellCrossing's SIDE_POINT places at a cell's FAR edge
 * (cell.gy+gh / cell.gx+gw), so extending that leg's CORRIDOR_LEN
 * thickness forward from there — the default, correct for every other
 * side/for a real room's own margin-having anchors — overflows past that
 * cell's own boundary. 'north'/'west' sit at a NEAR edge (cell.gy /
 * cell.gx) where extending forward already stays inward, same as Task
 * 3's own round-2 fix for transitCellCrossing's internal corner case.
 */
function cornerConnector(from, to, { fromSide, toSide } = {}) {
  const corner = { x: to.x, y: from.y };
  const leg1Gy = fromSide === 'south' ? from.y - CORRIDOR_LEN : Math.min(from.y, corner.y);
  const leg2Gx = toSide === 'east' ? to.x - CORRIDOR_LEN : Math.min(corner.x, to.x);
  return [
    { gx: Math.min(from.x, corner.x), gy: leg1Gy, gw: Math.max(CORRIDOR_LEN, Math.abs(corner.x - from.x)), gh: CORRIDOR_LEN },
    { gx: leg2Gx, gy: Math.min(corner.y, to.y), gw: CORRIDOR_LEN, gh: Math.max(CORRIDOR_LEN, Math.abs(to.y - corner.y)) },
  ];
}

/**
 * Which corridor art tile — and what rotation — belongs at `index` (0-based)
 * of a `length`-tile gallery (ITEM-12). `corridor.webp` is a fully-walled 1x1
 * box, correct on its own only for a single-tile gallery (`length <= 1`,
 * `'single'`, unrotated). A longer gallery is 1 square wide the whole way,
 * with real walls only along its two long sides (east/west, for a vertical
 * i.e. east/west-connection gallery; north/south, for a horizontal
 * south-connection one) — dungeon-scene.mjs's corridor-mid/-end assets are
 * built "wall on top" in that canonical orientation, so:
 * - the two end tiles (`index` 0 and `length - 1`) use `'end'` (wall on one
 *   side, open on the other, facing inward) — unrotated for the near end of
 *   a vertical gallery, 180° for its far end; 270°/90° for a horizontal
 *   gallery's near/far end (rotating the canonical top-wall onto the left,
 *   then the right).
 * - every tile in between uses `'mid'` (walled on both long sides, open on
 *   both ends) — unrotated for a vertical gallery, 90° for a horizontal one
 *   (its own walls are symmetric, so 90° and 270° are equivalent here).
 */
export function corridorTileVariant(index, length, vertical) {
  if (length <= 1) return { variant: 'single', rotation: 0 };
  if (index === 0) return { variant: 'end', rotation: vertical ? 0 : 270 };
  if (index === length - 1) return { variant: 'end', rotation: vertical ? 180 : 90 };
  return { variant: 'mid', rotation: vertical ? 0 : 90 };
}

/** Topological rank (longest path from entryId) for every room in edges. */
export function computeRanks(edges, entryId) {
  const ranks = { [entryId]: 0 };
  // Kahn-style relaxation: repeatedly push rank = max(parent ranks) + 1
  // until stable — simpler than a strict topo-sort given this graph's
  // small size, and just as correct for a DAG.
  let changed = true;
  while (changed) {
    changed = false;
    for (const [fromId, children] of Object.entries(edges)) {
      if (!(fromId in ranks)) continue;
      for (const childId of children) {
        const candidate = ranks[fromId] + 1;
        if (!(childId in ranks) || ranks[childId] < candidate) {
          ranks[childId] = candidate;
          changed = true;
        }
      }
    }
  }
  return ranks;
}

/**
 * Column index (integer, per-rank left-to-right order) via a single DFS
 * pass from entryId — #93 pre-flight fix (see the note below the
 * function for what the original bottom-up-width/top-down-centering
 * design got wrong and why it was replaced). Every room is visited
 * exactly once (first parent to reach it wins, matching the design's
 * "merge rooms placed once, whichever parent reaches them first"
 * intent); each NEW room claims the next unused column at its own rank
 * via a monotonic per-rank counter, which is what actually guarantees
 * two different rooms at the same rank can never collide on a column —
 * `ranks` (pre-computed by computeRanks, already correctly reflecting a
 * merge room's longest-path rank) is looked up directly, not re-derived
 * from DFS depth, so a merge room still lands at its correct rank
 * regardless of which parent's branch reaches it first.
 */
export function computeColumns(edges, ranks, entryId) {
  const columns = {};
  const nextColByRank = {};
  const visited = new Set();

  function visit(roomId) {
    if (visited.has(roomId)) return;
    visited.add(roomId);
    const rank = ranks[roomId];
    const col = nextColByRank[rank] ?? 0;
    columns[roomId] = col;
    nextColByRank[rank] = col + 1;
    for (const childId of edges[roomId] ?? []) visit(childId);
  }
  visit(entryId);
  return columns;
}

/** Full grid-cell rect for (rank, col) — a room/corridor's allotted
 * space, independent of the room's own actual size. Same origin roomRect
 * uses: a room always anchors at its cell's own top-left corner, so a
 * room's own rect and its cellBounds share the same gx/gy always. */
export function cellBounds(rank, col) {
  return {
    gx: INITIAL_GX + col * COLUMN_STRIDE,
    gy: rank * ROW_STRIDE,
    gw: COLUMN_STRIDE,
    gh: ROW_STRIDE,
  };
}

/**
 * Seals a room's grid-cell margin beyond its own rect — the space between
 * a (possibly smaller) room and the full COLUMN_STRIDE x ROW_STRIDE cell
 * it's allotted. A room always anchors at its cell's own top-left corner
 * (roomRect), so its north and west edges always coincide with the
 * cell's own north/west edges — only east and south can ever have
 * margin, regardless of room size. The room's OWN east/south walls
 * (roomEnclosureWalls, unchanged) already seal the room's interior from
 * this margin whenever those faces aren't used for an outgoing
 * connection; this function seals the OUTER edge of the margin (the
 * cell's own east/south boundary), so the margin becomes fully enclosed
 * dead space rather than open void — see the design's own reasoning for
 * why only two walls are needed to close an L-shaped region.
 */
export function cellMarginWalls(rect, rank, col, { openSide = null, openOffset = 0, openWidth = 0 } = {}) {
  const cell = cellBounds(rank, col);
  const walls = [];

  const sealSide = (dir, hasMargin, along) => {
    if (!hasMargin) return;
    if (openSide !== dir) {
      walls.push(along(cell.gx, cell.gy, cell.gx + cell.gw, cell.gy + cell.gh));
      return;
    }
    const gapStart = openOffset;
    const gapEnd = openOffset + openWidth;
    const full = dir === 'east' ? cell.gh : cell.gw;
    if (gapStart > 0) walls.push(along(cell.gx, cell.gy, cell.gx + cell.gw, cell.gy + cell.gh, 0, gapStart));
    if (gapEnd < full) walls.push(along(cell.gx, cell.gy, cell.gx + cell.gw, cell.gy + cell.gh, gapEnd, full));
  };

  const eastLine = (cgx, cgy, cgx2, cgy2, from = 0, to = cgy2 - cgy) =>
    ({ dir: 'east', x1: cgx2, y1: cgy + from, x2: cgx2, y2: cgy + to });
  const southLine = (cgx, cgy, cgx2, cgy2, from = 0, to = cgx2 - cgx) =>
    ({ dir: 'south', x1: cgx + from, y1: cgy2, x2: cgx + to, y2: cgy2 });

  sealSide('east', rect.gw < cell.gw && rect.gw === ROOM_SIZE_SMALL, eastLine);
  sealSide('south', rect.gh < cell.gh && rect.gh === ROOM_SIZE_SMALL, southLine);

  return walls;
}

const SIDE_POINT = {
  north: (cell, offset) => ({ x: cell.gx + offset, y: cell.gy }),
  south: (cell, offset) => ({ x: cell.gx + offset, y: cell.gy + cell.gh }),
  west: (cell, offset) => ({ x: cell.gx, y: cell.gy + offset }),
  east: (cell, offset) => ({ x: cell.gx + cell.gw, y: cell.gy + offset }),
};
const SIDE_SPAN = { north: 'gw', south: 'gw', west: 'gh', east: 'gh' };
const OPPOSITE_SIDE = { north: 'south', south: 'north', east: 'west', west: 'east' };

/**
 * Geometry for one EMPTY cell a corridor path crosses through — a
 * pseudo-random point on entrySide to a pseudo-random point on exitSide
 * (same seeded-offset convention as doorOffsetAt/buildEdgeCorridor),
 * connected by a straight segment (opposite sides) or a single-corner
 * L-shape (adjacent sides), always staying inside this one cell's own
 * bounds. `edgeId` (e.g. `${fromRoomId}->${toRoomId}`) salts the offset
 * so two different edges crossing the same cell get independently
 * randomized entry/exit points, not identical ones.
 *
 * Straight-vs-turn is decided from entrySide/exitSide themselves
 * (OPPOSITE_SIDE), not from whether the two seeded points happen to share
 * a coordinate — entry and exit offsets are independently randomized, so
 * even opposite sides (e.g. north/south, both offset along `gw`) will
 * almost never land on the same x by chance.
 */
export function transitCellCrossing(seed, rank, col, entrySide, exitSide, edgeId) {
  const cell = cellBounds(rank, col);
  const entryOffset = doorOffsetAt(seed, `transit-${rank}-${col}-${entrySide}-${edgeId}`, 'incoming', cell[SIDE_SPAN[entrySide]]);
  const exitOffset = doorOffsetAt(seed, `transit-${rank}-${col}-${exitSide}-${edgeId}`, 'outgoing', cell[SIDE_SPAN[exitSide]]);
  const entryPoint = SIDE_POINT[entrySide](cell, entryOffset);
  const exitPoint = SIDE_POINT[exitSide](cell, exitOffset);

  const corridorSegments = [];
  const plainWalls = [];

  if (OPPOSITE_SIDE[entrySide] === exitSide) {
    // Straight through (opposite sides) — one bounding-box segment from
    // entry to exit directly, same shape buildEdgeCorridor's own
    // same-column branch uses even when the two offsets don't align.
    corridorSegments.push({
      gx: Math.min(entryPoint.x, exitPoint.x),
      gy: Math.min(entryPoint.y, exitPoint.y),
      gw: Math.max(CORRIDOR_LEN, Math.abs(exitPoint.x - entryPoint.x)),
      gh: Math.max(CORRIDOR_LEN, Math.abs(exitPoint.y - entryPoint.y)),
    });
  } else {
    // Adjacent sides — one corner, inside this cell, at the entry point's
    // own axis crossed with the exit point's own axis. entryPoint->corner
    // shares an x (vertical leg: fixed gw, variable gh); corner->exitPoint
    // shares a y (horizontal leg: variable gw, fixed gh) — mirroring
    // buildEdgeCorridor's own corner-case segments exactly, just walked in
    // the opposite direction (entry->corner->exit instead of
    // exit->corner->entry).
    const corner = { x: entryPoint.x, y: exitPoint.y };

    // #174 fix round 2 (found by review): the fixed-CORRIDOR_LEN dimension
    // must extend INWARD from whichever point anchors it, not always in
    // the positive direction — entryPoint.x sits at the cell's own FAR
    // east edge exactly when entrySide is 'east' (SIDE_POINT.east uses
    // `cell.gx + cell.gw`), so a segment extending its CORRIDOR_LEN width
    // rightward from there overflows past this cell into the next
    // column's cell. Same reasoning for exitPoint.y and 'south'
    // (SIDE_POINT.south uses `cell.gy + cell.gh`). Every other anchor side
    // sits at the cell's own near edge or an interior offset (bounded by
    // doorOffsetAt's own maxOffset), where extending positively never
    // leaves the cell.
    const seg1X = entrySide === 'east' ? entryPoint.x - CORRIDOR_LEN : entryPoint.x;
    const seg2Y = exitSide === 'south' ? exitPoint.y - CORRIDOR_LEN : exitPoint.y;

    corridorSegments.push({
      gx: seg1X, gy: Math.min(entryPoint.y, corner.y),
      gw: CORRIDOR_LEN, gh: Math.max(CORRIDOR_LEN, Math.abs(corner.y - entryPoint.y)),
    });
    corridorSegments.push({
      gx: Math.min(corner.x, exitPoint.x), gy: seg2Y,
      gw: Math.max(CORRIDOR_LEN, Math.abs(exitPoint.x - corner.x)), gh: CORRIDOR_LEN,
    });
  }

  return { entryPoint, exitPoint, plainWalls, corridorSegments };
}

/**
 * Seals an EMPTY transit cell's outer boundary — all four compass sides,
 * unlike `cellMarginWalls`' room case. A room always anchors at its own
 * cell's top-left corner (`roomRect`), so its north/west edges always
 * coincide with the cell's own north/west edges and only east/south can
 * ever have margin (see `cellMarginWalls`' own docblock) — but a transit
 * cell (#174 Task 3/4, `transitCellCrossing`) is empty space a corridor
 * merely passes through, with no room and so no anchor corner: its own
 * crossing's `entrySide`/`exitSide` can be ANY of the four sides, so all
 * four of the cell's outer edges need sealing here, not just two.
 *
 * `openings` is `[{ side, point }]` — one entry per corridor crossing
 * point that lands on this cell's boundary. Ordinarily 2 (this crossing's
 * own `entryPoint`/`exitPoint`, from `transitCellCrossing`), but a SECOND
 * edge crossing the SAME empty cell via a different entry/exit pair
 * contributes its own 1-2 more (idempotency, see
 * `buildPopulateAndUnlockGraphNode`'s own accumulation of prior
 * openings) — multiple openings on the SAME side are supported (sorted,
 * whatever's between two consecutive openings on one side stays a solid
 * wall), the same "seal minus every declared gap" pattern
 * `cellMarginWalls` uses for its own single opening, generalized here to
 * N sides x N openings. `point` is reused directly from
 * `transitCellCrossing`'s own `entryPoint`/`exitPoint` (an absolute grid
 * coordinate already sitting exactly on that side) rather than
 * re-derived, so every gap lines up exactly with its own crossing's
 * randomized point, whatever it happened to be. A side with no opening
 * at all gets one full-length wall, same as a room's fully-sealed
 * margin side.
 */
export function transitCellContainmentWalls(rank, col, openings) {
  const cell = cellBounds(rank, col);

  const LINE = {
    north: (from, to) => ({ dir: 'north', x1: cell.gx + from, y1: cell.gy, x2: cell.gx + to, y2: cell.gy }),
    south: (from, to) => ({ dir: 'south', x1: cell.gx + from, y1: cell.gy + cell.gh, x2: cell.gx + to, y2: cell.gy + cell.gh }),
    west: (from, to) => ({ dir: 'west', x1: cell.gx, y1: cell.gy + from, x2: cell.gx, y2: cell.gy + to }),
    east: (from, to) => ({ dir: 'east', x1: cell.gx + cell.gw, y1: cell.gy + from, x2: cell.gx + cell.gw, y2: cell.gy + to }),
  };
  const SPAN = { north: cell.gw, south: cell.gw, east: cell.gh, west: cell.gh };

  const offsetsBySide = { north: [], south: [], east: [], west: [] };
  for (const { side, point } of openings) {
    const offset = side === 'north' || side === 'south' ? point.x - cell.gx : point.y - cell.gy;
    offsetsBySide[side].push(offset);
  }

  const walls = [];
  for (const side of ['north', 'south', 'east', 'west']) {
    const full = SPAN[side];
    const along = LINE[side];
    const offsets = offsetsBySide[side].slice().sort((a, b) => a - b);
    if (offsets.length === 0) {
      walls.push(along(0, full));
      continue;
    }
    let cursor = 0;
    for (const offset of offsets) {
      const gapStart = offset;
      const gapEnd = offset + CORRIDOR_LEN;
      if (gapStart > cursor) walls.push(along(cursor, gapStart));
      cursor = Math.max(cursor, gapEnd);
    }
    if (cursor < full) walls.push(along(cursor, full));
  }
  return walls;
}

/**
 * BFS shortest path of cells from fromPos to toPos over the rank/column
 * grid, treating any cell occupied by a room other than fromRoomId/
 * toRoomId as blocked. Returns an ordered array of {rank, col} from
 * fromPos to toPos inclusive (length 2 when already adjacent with
 * nothing to route around), or null if no path exists within the search
 * bounds — callers fall back to a direct line in that case (see
 * buildEdgeCorridor), so returning null rather than throwing is
 * deliberate. The search space is bounded to a small margin around the
 * two endpoints' own bounding box (not the whole graph) — real dungeons
 * never need a detour wider than a room or two, and an unbounded search
 * risks wandering arbitrarily far in a degenerate all-blocked case.
 */
export function findCorridorPath(fromPos, toPos, occupiedCells, { fromRoomId, toRoomId }) {
  const SEARCH_MARGIN = 2;
  const key = (pos) => `${pos.rank},${pos.col}`;
  const minRank = Math.max(0, Math.min(fromPos.rank, toPos.rank) - SEARCH_MARGIN);
  const maxRank = Math.max(fromPos.rank, toPos.rank) + SEARCH_MARGIN;
  const minCol = Math.min(fromPos.col, toPos.col) - SEARCH_MARGIN;
  const maxCol = Math.max(fromPos.col, toPos.col) + SEARCH_MARGIN;
  const inBounds = (pos) =>
    pos.rank >= minRank && pos.rank <= maxRank && pos.col >= minCol && pos.col <= maxCol;
  const isBlocked = (pos) => {
    const occupant = occupiedCells[key(pos)];
    return occupant != null && occupant !== fromRoomId && occupant !== toRoomId;
  };
  // #174 fix round (found by Task 4's own review, not anticipated when
  // this task was first written): a room's own incoming connection
  // always lands on its north face (fixed since #93's Task 5 redesign),
  // and entryPoint has no spare margin to route through on any other
  // side (cellMarginWalls only ever seals east/south margin). A path
  // that reaches toPos from anywhere but its own north-adjacent cell
  // cannot be turned into corridor geometry without cutting into the
  // target room's own interior -- confirmed to happen with certainty
  // whenever toPos's own north neighbor is occupied by an unrelated
  // room, forcing a same-column detour to approach from another side.
  // Only toPos's own north neighbor may step into it; every other
  // neighbor treats toPos as unreachable from itself, same as any other
  // blocked cell. If that leaves no path at all, this correctly returns
  // null and the caller falls back to the existing direct-line
  // degradation (already an accepted, explicitly-designed imperfection
  // for the "no free path" case) rather than a "successful" path this
  // geometry cannot actually build without overlap.
  const canEnter = (from, to) => {
    if (to.rank === toPos.rank && to.col === toPos.col) {
      return from.rank === toPos.rank - 1 && from.col === toPos.col;
    }
    return true;
  };

  const goalKey = key(toPos);
  const queue = [fromPos];
  const cameFrom = new Map([[key(fromPos), null]]);
  while (queue.length) {
    const current = queue.shift();
    const currentKey = key(current);
    if (currentKey === goalKey) {
      const path = [];
      let step = currentKey;
      while (step !== null) {
        const [rank, col] = step.split(',').map(Number);
        path.unshift({ rank, col });
        step = cameFrom.get(step);
      }
      return path;
    }
    const neighbors = [
      { rank: current.rank - 1, col: current.col },
      { rank: current.rank + 1, col: current.col },
      { rank: current.rank, col: current.col - 1 },
      { rank: current.rank, col: current.col + 1 },
    ];
    for (const next of neighbors) {
      if (!inBounds(next)) continue;
      const nextKey = key(next);
      if (cameFrom.has(nextKey)) continue;
      if (isBlocked(next)) continue;
      if (!canEnter(current, next)) continue;
      cameFrom.set(nextKey, currentKey);
      queue.push(next);
    }
  }
  return null;
}
