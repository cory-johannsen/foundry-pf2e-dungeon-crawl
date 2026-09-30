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
 * (south/east/west, exitFaceForIndex) to a door slot on its child's incoming
 * face (doorSlotsForFace). The multi-cell/corner branches still seed each
 * end independently; the same-column/same-rank fast path derives the
 * child's own end from the parent's (#230) — see buildEdgeCorridor's
 * docblock.
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
// roll. computeColumns assigns columns via a skip-by-2 counter (#174
// follow-up), leaving a permanent empty buffer column beside every real
// room for routing/incoming-face use, sealed by sealBufferCellIfUnbuilt
// (dungeon-scene.mjs).
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

const OUTGOING_CANDIDATES = {
  north: ['south', 'east', 'west'], // byte-identical to today's literal array
  west: ['south', 'east', 'north'],
};

/** Deterministic compass face for a room's Nth exit (0-2), always
 * distinct from its own incoming face (`incomingFaceFor`) — 'north' by
 * default, preserving every existing call site's exact behavior. */
export function exitFaceForIndex(index, incomingFace = 'north') {
  return OUTGOING_CANDIDATES[incomingFace][index];
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
 * room's incoming face (doorSlotsForFace, selected by incomingFaceFor), never a separate compass
 * direction. That's what actually guarantees a merge room gets a door
 * for EVERY real parent (previously only one was ever built, silently
 * dead-ending every other branch) and that incoming can never collide
 * with a room's own outgoing faces (south/east/west, always disjoint
 * from the incoming face).
 */
export function incomingConnectionsFor(layoutEdges, roomId, hiddenIncomingByRoomId = {}) {
  const real = parentRoomIdsFor(layoutEdges, roomId).map((sourceId) => ({ sourceId, hidden: false }));
  const hidden = (hiddenIncomingByRoomId[roomId] ?? []).map((sourceId) => ({ sourceId, hidden: true }));
  return [...real, ...hidden];
}

/**
 * Which compass face `roomId` should receive its incoming connection(s)
 * on — 'north' (today's only option, unchanged for the common case) or
 * 'west' as a fallback, chosen once per room from the fully precomputed
 * layout (every room's rank/col is already known before any room is
 * built). `legitimateSourceIds` is the set of this room's own real
 * parents (`parentRoomIdsFor`) plus its hidden detour source, if any —
 * one of THOSE occupying a candidate neighbor cell is the normal,
 * expected "parent directly above/beside" shape, not a blocker.
 *
 * North and west are the only two candidates because they're the only
 * two structurally marginless faces (a room always anchors at its own
 * cell's top-left corner, so north/west always coincide with the cell's
 * own edges regardless of room size) — neither ever needs new
 * margin-gap-coordination logic (`cellMarginWalls` stays scoped to
 * east/south only, unchanged).
 *
 * Returns 'north' for the residual case where BOTH neighbors are
 * occupied by an unrelated room (#196, not solved here) — the caller's
 * existing "no free path" fallback already handles this gracefully.
 */
export function incomingFaceFor(roomId, positionByRoomId, occupiedCells, legitimateSourceIds) {
  const pos = positionByRoomId[roomId];
  // A room's own id is never the occupant of a NEIGHBOR cell (each cell
  // holds at most one room, and a neighbor is by definition a different
  // cell) — the only exclusions that matter are this room's own real
  // parents/hidden source, which legitimately DO occupy an adjacent
  // cell in the common "parent directly above/beside" case.
  //
  // #174 follow-up: a same-plan attempt to also require a legitimate
  // occupant be the room's SOLE source (so a merge room with 2+ sources
  // wouldn't treat a co-parent's own cell as an available gate) was
  // reverted. It was architecturally motivated -- routing a DIFFERENT
  // source's edge through a co-parent's own real room is genuinely
  // unsound (findCorridorPath's own isBlocked fix for that stays
  // reverted too, see its own docblock) -- but this plan's own final
  // whole-branch review found the multi-cell/transit-cell machinery
  // this "fix" pushed more connections into is itself broken in the
  // large majority of cases (consecutive transit cells' own crossing
  // offsets don't line up on a shared border; a second edge converging
  // on an already-crossed cell with the same entry/exit side pair is
  // silently dropped instead of adding its own opening; transit-cell
  // exit offsets aren't pinned to the actual door position they're
  // supposed to reach). Net effect measured: it converted ~1083
  // previously-direct, known-good connections into detours, of which
  // ~89% ended up with their own target door covered by a wall — a
  // worse outcome than the merge-room gate conflict it was meant to
  // fix. Reverted back to the original rule (any legitimate source is
  // an available gate, regardless of source count) until the
  // multi-cell/transit-cell geometry itself is fixed — tracked as a
  // separate, ongoing investigation (filed as issue #225), not attempted
  // here.
  const isFreeOrLegitimate = (rank, col) => {
    const occupant = occupiedCells[`${rank},${col}`];
    return occupant == null || legitimateSourceIds.has(occupant);
  };
  if (isFreeOrLegitimate(pos.rank - 1, pos.col)) return 'north';
  if (isFreeOrLegitimate(pos.rank, pos.col - 1)) return 'west';
  return 'north';
}

/**
 * Divides a room's incoming face into `count` equal, contiguous door
 * slots, left-to-right (`face === 'north'`) or top-to-bottom
 * (`face === 'west'`). Replaces the old `northDoorSlots` (single-face
 * version) now that incoming can land on either of a room's two
 * marginless faces (`incomingFaceFor`) — `face === 'north'` produces
 * byte-identical output to the old function for the same inputs.
 */
export function doorSlotsForFace(rect, count, face) {
  const { gx, gy, gw, gh } = rect;
  if (face === 'west') {
    const step = gh / count;
    return Array.from({ length: count }, (_, i) => ({
      x1: gx, y1: gy + i * step, x2: gx, y2: gy + (i + 1) * step,
    }));
  }
  const step = gw / count;
  return Array.from({ length: count }, (_, i) => ({
    x1: gx + i * step, y1: gy, x2: gx + (i + 1) * step, y2: gy,
  }));
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
 * A room's own enclosing walls (#93 generalization). South/east/west stay
 * full-face, excluded per `outgoingFaces` (unchanged from before). North
 * is either a single solid wall (`incomingCount === 0`, the entry room)
 * or entirely excluded (`incomingCount > 0`) — its individual door slots
 * are built separately by the caller via `doorSlotsForFace`, one per real
 * connection-building step (needs the connecting room's rect, which this
 * function doesn't have), not here. `rect` is the room's own already-
 * computed `roomRect(...)` result — required, since rank/col (and so the
 * rect) aren't derivable from `roomId` alone the way the old slot-indexed
 * version could derive its own rect internally.
 */
export function roomEnclosureWalls(seed, roomId, { incomingCount = 0, incomingFace = 'north', outgoingFaces = [] }, rect) {
  const sides = roomSidesForRect(rect);
  const walls = [];
  const ALL_FACES = ['north', 'south', 'east', 'west'];
  for (const face of ALL_FACES) {
    if (face === incomingFace) continue;
    if (!outgoingFaces.includes(face)) walls.push({ dir: face, ...sides[face] });
  }
  if (incomingCount === 0) walls.push({ dir: incomingFace, ...sides[incomingFace] });
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
 * The "turn 1" jog every #297 dogleg (Round 1) uses: a short floor
 * segment confined to the SOURCE room's own margin band (never the
 * blocking cell itself -- see Round 1's own spec section for why: a
 * room's floor starts immediately at its own cell's NW corner, so there
 * is no y-range inside the blocking cell where turning wouldn't overlap
 * that room's own floor), jogging from the source's own real door
 * (doorX0..doorX1 at faceY) sideways to wherever the corridor needs to
 * continue (targetLaneX0..+targetLaneWidth) -- the blocking room's own
 * margin edge. Extracted here (Round 2 Task 1) purely to give Round 1's
 * own already-proven dogleg logic a single, readable implementation
 * instead of inline duplication across the south/east branches. (An
 * earlier Round 2 design planned a second caller here -- a "ride-along"
 * corridor landing on a co-parent's own corridor position instead of the
 * blocker's own margin edge -- but that design was found geometrically
 * unsound during its own implementation and replaced with slot-priority
 * assignment, which needs no corridor-geometry helper at all. This
 * function has exactly one caller.)
 */
export function marginBandApproach(doorX0, doorX1, faceY, targetLaneX0, targetLaneWidth) {
  const turnGx = Math.min(doorX0, targetLaneX0);
  const turnGx2 = Math.max(doorX1, targetLaneX0 + targetLaneWidth);
  const turnBottom = faceY + DOOR_WIDTH;
  const turnSegment = { gx: turnGx, gy: faceY, gw: turnGx2 - turnGx, gh: DOOR_WIDTH };
  const turnWalls = [
    // Side containment (Round 1's own round-2 self-review fix).
    { x1: turnGx, y1: faceY, x2: turnGx, y2: turnBottom },
    { x1: turnGx2, y1: faceY, x2: turnGx2, y2: turnBottom },
    // Bottom cap, except where the lane continues down through it.
    { x1: turnGx, y1: turnBottom, x2: targetLaneX0, y2: turnBottom },
    { x1: targetLaneX0 + targetLaneWidth, y1: turnBottom, x2: turnGx2, y2: turnBottom },
  ].filter((w) => w.x1 !== w.x2 || w.y1 !== w.y2);
  return { turnGx, turnGx2, turnBottom, turnSegment, turnWalls };
}

/** East-branch mirror of `marginBandApproach` — axes swapped (see the
 * south/east mirror this file's own east-branch dogleg comments already
 * document). */
export function marginBandApproachY(doorY0, doorY1, faceX, targetLaneY0, targetLaneWidth) {
  const turnGy = Math.min(doorY0, targetLaneY0);
  const turnGy2 = Math.max(doorY1, targetLaneY0 + targetLaneWidth);
  const turnRight = faceX + DOOR_WIDTH;
  const turnSegment = { gx: faceX, gy: turnGy, gw: DOOR_WIDTH, gh: turnGy2 - turnGy };
  const turnWalls = [
    { x1: faceX, y1: turnGy, x2: turnRight, y2: turnGy },
    { x1: faceX, y1: turnGy2, x2: turnRight, y2: turnGy2 },
    { x1: turnRight, y1: turnGy, x2: turnRight, y2: targetLaneY0 },
    { x1: turnRight, y1: targetLaneY0 + targetLaneWidth, x2: turnRight, y2: turnGy2 },
  ].filter((w) => w.x1 !== w.x2 || w.y1 !== w.y2);
  return { turnRight, turnGy, turnGy2, turnSegment, turnWalls };
}

/**
 * Edge geometry connecting fromRoomId's exitFace to a specific door slot
 * on toRoomId's incoming face (`toSlot`, from `doorSlotsForFace` — Task 5's
 * redesign means "incoming" can be north or west per room, but potentially one of
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
/**
 * #324: a DOOR_WIDTH-wide door's own START coordinate, grid-cell-aligned
 * (a whole integer) AND clamped to stay entirely within `[lo, hi]` (a
 * target's own real door slot, which can itself have fractional bounds --
 * `doorSlotsForFace` divides a room's own face into N equal slots, and
 * N doesn't always evenly divide the room's own width). `ideal` is the
 * door's own un-clamped, may-be-fractional preferred position (typically
 * a slot's own center, shifted to gap-START semantics already). Rounding
 * `ideal` to the nearest integer, then clamping into the slot's own
 * INTEGER-safe sub-range (`ceil(lo)` .. `floor(hi) - DOOR_WIDTH`),
 * guarantees the door both fits its own assigned slot (never spilling
 * into a sibling connection's own slot -- the exact shape #297's own
 * Critical-1/2 findings were about) AND occupies exactly one whole grid
 * cell (never straddling two -- this file's own newest finding, #324).
 * Mirrors the `Math.min(Math.max(x, slot.x1), slot.x2 - DOOR_WIDTH)` clamp
 * this file's own offset-based fast path already uses, generalized with
 * rounding for a fractional slot.
 *
 * Degenerate case: when the slot itself is narrower than DOOR_WIDTH
 * (possible whenever a room's own incoming-connection count exceeds its
 * own width -- e.g. 7 connections on a SMALL, 6-wide room gives a
 * 0.857-wide slot), no integer position can keep a DOOR_WIDTH-wide door
 * entirely inside it -- `ceil(lo)` and `floor(hi - DOOR_WIDTH)` invert
 * (`minStart > maxStart`). Grid alignment (this file's own newest,
 * non-negotiable rule) takes priority over full slot containment here;
 * `Math.min(Math.max(x, minStart), maxStart)` naturally falls through to
 * `maxStart` in that case regardless of `x` (a plain consequence of
 * Math.min/Math.max composition, not a special-cased branch) -- measured
 * against a symmetric (slot-centered) fallback alternative and found to
 * produce FEWER real cross-connection collisions in the #297 sweep (see
 * that sweep's own updated ceiling comment), so kept as the deliberate
 * choice rather than "more principled-looking." Documented as a residual
 * (#231/#232 already track slot-boundary encroachment as an existing,
 * real, measured defect class -- this is the same class, now
 * grid-aligned instead of fractional, not a new failure mode).
 */
function clampDoorStart(lo, hi, ideal) {
  return Math.min(Math.max(Math.round(ideal), Math.ceil(lo)), Math.floor(hi - DOOR_WIDTH));
}

/**
 * #324 (fourth finding, live-reported: "I should not be able to see the
 * hallway through the wall, the door is closed"): the multi-cell and
 * corner-case branches of `buildEdgeCorridor` only ever built containment
 * walls flanking the TARGET's own entry point -- nothing capped the
 * SOURCE room's own remaining exit face outside its own narrow
 * `doorWall`. Whether that door is open, closed, or locked is irrelevant
 * when the rest of that same wall-face has no Wall document there at
 * all: a token (or a line of sight) can simply go around the door
 * through the unwalled remainder of the source room's own face. This is
 * the exact same "seal everything except the declared opening"
 * containment the offset-based fast path's own `plainWalls` already
 * builds for the source side (see its own `#294` fix, two segments
 * capping `[fromRect's own far edge, doorX0)` and
 * `(doorX1, fromRect's own OTHER far edge]`) -- extended here to the two
 * branches that never had it. Mirrors `exitPoint`'s own already-computed,
 * now-grid-aligned door span (`[exitPoint, exitPoint + DOOR_WIDTH)`)
 * directly, so it can never independently disagree with `doorWall`'s own
 * position.
 */
function sourceFaceCapWalls(fromRect, exitFace, exitPoint) {
  return (exitFace === 'south'
    ? [
        { x1: fromRect.gx, y1: exitPoint.y, x2: exitPoint.x, y2: exitPoint.y },
        { x1: exitPoint.x + DOOR_WIDTH, y1: exitPoint.y, x2: fromRect.gx + fromRect.gw, y2: exitPoint.y },
      ]
    : [
        { x1: exitPoint.x, y1: fromRect.gy, x2: exitPoint.x, y2: exitPoint.y },
        { x1: exitPoint.x, y1: exitPoint.y + DOOR_WIDTH, x2: exitPoint.x, y2: fromRect.gy + fromRect.gh },
      ]
  ).filter((w) => w.x1 !== w.x2 || w.y1 !== w.y2);
}

export function buildEdgeCorridor(seed, fromRoomId, toRoomId, fromRect, toRect, fromPos, toPos, exitFace, toSlot, occupiedCells, incomingFace = 'north') {
  const path = findCorridorPath(fromPos, toPos, occupiedCells, { fromRoomId, toRoomId, incomingFace });
  const slotSpan = incomingFace === 'west' ? (toSlot.y2 - toSlot.y1) : (toSlot.x2 - toSlot.x1);
  const outgoingOffset = doorOffsetAt(seed, `${fromRoomId}-${exitFace}`, 'outgoing', fromRect.gw);

  if (path && path.length > 2) {
    // Multi-cell path (#174): chain transitCellCrossing across every
    // intermediate cell, then connect fromRect's own exit point to the
    // first transit cell's entry point, and the last transit cell's exit
    // point to toRect's own entry point, via the same corner-connector
    // shape used below between exitPoint and entryPoint directly.
    const edgeId = `${fromRoomId}->${toRoomId}`;
    // #324 (third finding): a room's own exact geometric center always
    // lands exactly ON a grid line (room sizes are even), so a DOOR_WIDTH
    // -wide door centered there -- the old `± DOOR_WIDTH / 2` construction
    // below used to do -- straddles two cells (half in each), never fits
    // in one. Subtracting a FULL `DOOR_WIDTH` (not half) here instead
    // gives `exitPoint`/`entryPoint` "gap-START" semantics directly (the
    // door's own span is exactly `[point, point + DOOR_WIDTH)`, always one
    // whole cell, ending flush on the room's own true center line) --
    // matching the "gap-START, not gap-CENTER" semantics the chain anchor
    // conversion just below already used internally; extending it to the
    // room's own real door too means that conversion is no longer needed
    // as a separate step (see chainStartAnchor/chainEndAnchor below).
    const exitPoint = exitFace === 'east'
      ? { x: fromRect.gx + fromRect.gw, y: fromRect.gy + fromRect.gh / 2 - DOOR_WIDTH }
      : exitFace === 'west'
      ? { x: fromRect.gx, y: fromRect.gy + fromRect.gh / 2 - DOOR_WIDTH }
      : { x: fromRect.gx + fromRect.gw / 2 - DOOR_WIDTH, y: fromRect.gy + fromRect.gh };
    const doorWall = exitFace === 'south'
      ? { x1: exitPoint.x, y1: exitPoint.y, x2: exitPoint.x + DOOR_WIDTH, y2: exitPoint.y }
      : { x1: exitPoint.x, y1: exitPoint.y, x2: exitPoint.x, y2: exitPoint.y + DOOR_WIDTH };
    const entryPoint = incomingFace === 'west'
      ? { x: toSlot.x1, y: clampDoorStart(toSlot.y1, toSlot.y2, toSlot.y1 + slotSpan / 2 - DOOR_WIDTH) }
      : { x: clampDoorStart(toSlot.x1, toSlot.x2, toSlot.x1 + slotSpan / 2 - DOOR_WIDTH), y: toSlot.y1 };
    // Face-aware, mirroring entryPoint's own conditional above: a west
    // toSlot is a VERTICAL line (x1===x2===toRect.gx, doorSlotsForFace's
    // own west shape), so its reveal door and flanking walls must run
    // vertically too -- the unconditional horizontal formula here was a
    // gap in this task's own brief (entryPoint was made face-aware, this
    // wasn't), found by a later review's own hand-tracing.
    const revealDoorWall = incomingFace === 'west'
      ? { x1: entryPoint.x, y1: entryPoint.y, x2: entryPoint.x, y2: entryPoint.y + DOOR_WIDTH }
      : { x1: entryPoint.x, y1: entryPoint.y, x2: entryPoint.x + DOOR_WIDTH, y2: entryPoint.y };

    // #225: chain every intermediate cell's crossing point to its
    // neighbor's, anchored at the two real room doors just computed above
    // (exitPoint/entryPoint) — the fix for "two pieces sharing a physical
    // boundary don't agree on where they cross it" (see the design spec's
    // own Problem section for the three-symptom repro this closes). The
    // first cell's entry is forced from the SOURCE room's own door; the
    // last cell's exit is forced from the TARGET room's own door; every
    // interior cell's exit becomes the NEXT cell's forced entry, never
    // independently reseeded. A cell's own free perpendicular axis (when
    // entry/exit are adjacent, not opposite, sides) is still seeded via
    // doorOffsetAt inside transitCellCrossing, unchanged — only the FORCED
    // axis stops being random.
    // Chain values use gap-START semantics (matching transitCellContainmentWalls
    // and every other doorOffsetAt-based offset in this file) — #324's own
    // fix made exitPoint/entryPoint gap-START too (see their own docblock
    // above), so no further center->start conversion is needed here; the
    // chain anchors are simply the room's own real door positions,
    // directly. (Historical note: this used to subtract a second,
    // independent DOOR_WIDTH/2 here on top of exitPoint/entryPoint's own
    // then-gap-CENTER value — since half of DOOR_WIDTH=1 is 0.5, that
    // conversion produced a fractional anchor whenever the room's own true
    // center (always grid-line-aligned) was an integer, which is always —
    // #324's own root cause for both the door itself and every tile/wall
    // derived from this chain. Fixed at the source instead of patched here.)
    const chainStartAnchor = exitPoint;
    const chainEndAnchor = entryPoint;

    const transitCells = [];
    let chainAnchor = chainStartAnchor;
    for (let i = 1; i < path.length - 1; i += 1) {
      const cell = path[i];
      const cellRect = cellBounds(cell.rank, cell.col);
      const entrySide = directionBetween(cell, path[i - 1]);
      const exitSide = directionBetween(cell, path[i + 1]);
      const isLast = i === path.length - 2;
      const forcedEntryPoint = projectOntoSide(cellRect, entrySide, chainAnchor);
      // #225 I1: a non-last, non-corner (entry/exit on OPPOSITE sides)
      // "straight through" cell shares the same forced axis on both its
      // entry and exit — it has no free perpendicular axis at all, so its
      // exit must be forced too, not independently reseeded. Only a
      // genuine corner cell (entry/exit on ADJACENT sides) still has a
      // free axis left to randomize.
      const forcedExitPoint = isLast
        ? projectOntoSide(cellRect, exitSide, chainEndAnchor)
        : OPPOSITE_SIDE[entrySide] === exitSide
        ? projectOntoSide(cellRect, exitSide, forcedEntryPoint)
        : undefined;
      const crossing = transitCellCrossing(seed, cell.rank, cell.col, entrySide, exitSide, edgeId, { forcedEntryPoint, forcedExitPoint });
      transitCells.push({ rank: cell.rank, col: cell.col, entrySide, exitSide, edgeId, ...crossing });
      chainAnchor = crossing.exitPoint;
    }

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
      ...sourceFaceCapWalls(fromRect, exitFace, exitPoint),
      ...(incomingFace === 'west'
        ? [
            { x1: entryPoint.x, y1: toSlot.y1, x2: entryPoint.x, y2: entryPoint.y },
            { x1: entryPoint.x, y1: entryPoint.y + DOOR_WIDTH, x2: entryPoint.x, y2: toSlot.y2 },
          ]
        : [
            { x1: toSlot.x1, y1: entryPoint.y, x2: entryPoint.x, y2: entryPoint.y },
            { x1: entryPoint.x + DOOR_WIDTH, y1: entryPoint.y, x2: toSlot.x2, y2: entryPoint.y },
          ]
      ),
    ].filter((w) => w.x1 !== w.x2 || w.y1 !== w.y2);

    return { doorWall, revealDoorWall, plainWalls, corridorSegments, transitCells, foreignOpening: null };
  }

  // Adjacent (path.length <= 2), or no path found so we fall back to a
  // direct line (path == null) — UNCHANGED from before #174's Task 4,
  // verbatim, just with transitCells: [] added. #174 Task 5 reverts the
  // `!path` sub-case back to this same direct-line/corner shape: Task 6's
  // own trunkLaneCorridorSegments detour (previously here) was found
  // unsound by a later review (100% broken for west-exit connections,
  // and roughly half its remaining cases were bisected by a real
  // containment wall) — the honest direct-line fallback below, though it
  // can still cut through an occupied cell in the boxed-in case, is a
  // known, documented limitation rather than a hack that silently draws
  // through walls just as often.
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
    // #230 fix: derive the target's own gap from the SOURCE's already-
    // committed door offset (doorX0) instead of independently seeding it
    // — clamped to the target's own slot bounds, since a merge room's own
    // slot can be narrower than the source's full face. Two independently
    // seeded offsets almost never coincide, and the corridor's own floor
    // (spanX0..spanX1 below) is drawn wide enough to bridge whatever gap
    // that leaves — but `outgoingMarginOffset` (below in this same file;
    // called by dungeon-scene.mjs's own `cellMarginWalls` to seal a
    // room's own cell margin, both SOURCE south/east margin here and, per
    // #288, a LARGE room's own real margin too) needs to open a gap wide
    // enough to cover that same real floor, not just a fixed DOOR_WIDTH
    // at doorX0 — #288's own review round found and fixed this: it now
    // calls buildEdgeCorridor itself (with an assumed single, full-width
    // incoming slot) and reads back the REAL span, rather than
    // re-deriving just doorX0 — see outgoingMarginOffset's own docblock.
    // Deriving gapX0 from doorX0 collapses
    // spanX0===spanX1-DOOR_WIDTH===doorX0 in the common case (single
    // incoming connection, target slot at least as wide as the source's
    // face), which is exactly the case outgoingMarginOffset's own assumed
    // slot matches precisely.
    //
    // Known, MEASURED residual (not solved here): a review of the
    // original #230 fix found the live/system-wide door-coverage rate
    // only dropped from ~25.9% to ~12.8% (not to 0%), because #230 only
    // ever targeted the single-incoming-connection case. Two more,
    // separate mechanisms remain: (a) the clamped case just described,
    // when a merge room's own slot is narrower than where the source's
    // door offset lands (measured ~62% covered for a SMALL source, ~67%
    // for a LARGE source — #288 sealed a LARGE room's own margin at all,
    // which made this same residual apply there too; tracked by this
    // file's own test sweep, split by source size, neither asserted to
    // zero — see #231); and (b) the corner/multi-cell branch's OWN door
    // coverage from a completely different cause (other rooms' own
    // margin walls, and neighbouring-slot walls) — a bug class neither
    // fix touched or measured (see #232). Neither "closes #230" nor
    // "closes #288" means every door-coverage defect in this file is
    // gone.
    // #297: exactly one intermediate cell exists between source and
    // target when they're 2 ranks apart in the same column on a null
    // path -- if that cell holds a real room (not this edge's own
    // source/target) whose own footprint the fixed doorX0 column would
    // cross, reroute through that room's own east margin (a vertical
    // "lane"), then jog sideways again through that same room's own south
    // margin (turn 2 -- see `legTop` below) to reach wherever the
    // target's real door lands, instead of cutting straight through the
    // room. A larger rank gap always has more than one intermediate cell
    // and is left on the pre-existing direct-line fallback unconditionally
    // (#297's own documented scope limit).
    let dogleg = null;
    let foreignOpening = null;
    if (!path && toPos.rank === fromPos.rank + 2) {
      const blockRank = fromPos.rank + 1;
      const blockCol = fromPos.col;
      const occupantId = occupiedCells[`${blockRank},${blockCol}`];
      if (occupantId != null && occupantId !== fromRoomId && occupantId !== toRoomId) {
        const blockCell = cellBounds(blockRank, blockCol);
        const occupantRect = roomRect(seed, occupantId, blockRank, blockCol);
        // occupantRect.gx === blockCell.gx === fromRect.gx always (NW
        // anchor, same column) -- the occupant's own footprint spans
        // exactly [blockCell.gx, blockCell.gx + occupantRect.gw].
        const occupantEastEdge = occupantRect.gx + occupantRect.gw;
        // #297 fix round 3: doorX0 alone isn't the only way the corridor's real
        // floor can reach into the blocker's footprint -- #230/#231's own
        // gap-widening (spanX0/spanX1, widened when the target is a merge room
        // with a narrower clamped slot than the source's face) can stretch the
        // NON-dogleg span back across the blocker even when doorX0 itself sits
        // outside it (measured: 40/455, 8.79%, in the closing system-wide
        // sweep). Compute the SAME provisional gap/span the non-dogleg branch
        // would actually produce, and trigger on THAT overlapping the blocker's
        // footprint, not just doorX0 in isolation.
        const provisionalGapX0 = Math.min(Math.max(doorX0, toSlot.x1), toSlot.x2 - DOOR_WIDTH);
        const provisionalGapX1 = provisionalGapX0 + DOOR_WIDTH;
        const provisionalSpanX0 = Math.min(doorX0, provisionalGapX0);
        const provisionalSpanX1 = Math.max(doorX1, provisionalGapX1);
        const spanOverlapsBlocker = provisionalSpanX0 < occupantEastEdge && provisionalSpanX1 > occupantRect.gx;
        if (spanOverlapsBlocker) {
          // The turn MUST happen while still inside the SOURCE's own
          // margin band (faceY..blockCell.gy), never inside the blocking
          // cell itself -- a room's floor starts immediately at its own
          // cell's NW corner (no margin above/left of it), so there is no
          // y-range inside the blocking cell where turning wouldn't
          // overlap that room's own floor. The source's own margin is
          // always >= DOOR_WIDTH deep (the same margin invariant
          // cellMarginWalls relies on), so a DOOR_WIDTH-tall turn always
          // fits there even for a LARGE source room.
          const laneX0 = occupantEastEdge;
          const laneX1 = laneX0 + DOOR_WIDTH;
          // #297 Round 2 Task 1: turn 1's own geometry (turnGx/turnGx2/
          // turnBottom) plus its own containment walls, extracted into
          // `marginBandApproach` (see its own docblock) purely for
          // readability -- this dogleg is the function's only caller.
          const { turnGx, turnGx2, turnBottom, turnSegment: turn1Segment, turnWalls: turn1Walls } =
            marginBandApproach(doorX0, doorX1, faceY, laneX0, DOOR_WIDTH);
          // Review round 1 fix: the lane's own vertical run can't reach
          // all the way to corridorEndY and stop -- that leaves it
          // sealed off from wherever the target's real door (gapX0/gapX1
          // below) actually lands, whenever the lane's own x doesn't
          // happen to coincide with the door (measured: 84% of dogleg
          // activations in a 2,000-seed sweep, including this file's own
          // dogleg-repro-seed-0 test). A second turn, inside the
          // BLOCKING room's own south margin band (>= DOOR_WIDTH deep,
          // same invariant as every other margin in this file), jogs the
          // lane sideways to the real door before crossing into the
          // target's cell.
          const legTop = corridorEndY - DOOR_WIDTH;
          // occupantId/blockCell carried on `dogleg` itself -- `foreignOpening`
          // can't be built here anymore (review round 2 fix: it needs
          // gapX0/gapX1, computed below, which depend on `dogleg.laneX0`, so
          // building it before gapX0 exists would mean re-deriving values
          // that must actually agree with gapX0 -- see `foreignOpening`'s
          // own assignment below).
          dogleg = { laneX0, laneX1, turnGx, turnGx2, turnBottom, legTop, occupantId, blockCell, turn1Segment, turn1Walls };
        }
      }
    }
    // #297: when a dogleg is active, the corridor's real approach to the
    // target is from the lane's own x, not the original (now-abandoned)
    // doorX0 -- the target's own gap must track wherever the corridor
    // actually lands, the same "two things must agree on a shared
    // boundary" requirement #230 already established for the non-dogleg
    // case.
    const targetFacingX0 = dogleg ? dogleg.laneX0 : doorX0;
    // #324: clampDoorStart (not a bare clamp) so a fractional toSlot bound
    // (a merge room's own face split an odd number of ways) can't produce
    // a fractional, grid-straddling gap -- same fix as buildEdgeCorridor's
    // own multi-cell/corner-case entryPoint, applied here to this fast
    // path's own already-established clamp (#230's own fix, pre-existing).
    const gapX0 = clampDoorStart(toSlot.x1, toSlot.x2, targetFacingX0);
    const gapX1 = gapX0 + DOOR_WIDTH;
    const spanX0 = dogleg ? dogleg.turnGx : Math.min(doorX0, gapX0);
    const spanX1 = dogleg ? dogleg.turnGx2 : Math.max(doorX1, gapX1);
    // Review round 2 fix: `foreignOpening` must describe the SAME x-range
    // turn 2's own real floor spans (`Math.min(laneX0,gapX0)` ..
    // `Math.max(laneX1,gapX1)`), computed from the SAME gapX0/gapX1 the
    // containment walls below use -- not the narrower `[laneX0,laneX1)`
    // lane width round 1 used. A future task feeds this straight into
    // cellMarginWalls to open the blocking room's own south wall; an
    // under-width opening there would wall off exactly the part of turn 2
    // that reaches the real door -- the same "the margin gap must match
    // the real floor's own width" defect #288/outgoingMarginOffset already
    // fixed once for the SOURCE room's own margin, one level removed here
    // for the BLOCKING room's.
    if (dogleg) {
      const openingX0 = Math.min(dogleg.laneX0, gapX0);
      const openingX1 = Math.max(dogleg.laneX1, gapX1);
      foreignOpening = {
        roomId: dogleg.occupantId,
        // The lane travels vertically through the blocking room's own
        // EAST margin band but never actually crosses that room's own
        // east wall -- it stays inside the cell throughout. It crosses
        // the blocking room's own SOUTH wall (via the turn-2 jog) to
        // continue into the target's cell below, so the opening this
        // creates is on the blocking room's SOUTH side, not its east.
        side: 'south',
        offset: openingX0 - dogleg.blockCell.gx,
        width: openingX1 - openingX0,
      };
    }
    // Review round 1 fix: turn 2 (the jog inside the blocker's own south
    // margin, see `legTop` above) can reach wider than `toSlot`'s own
    // bounds whenever `laneX0`/`laneX1` sit outside the target's slot --
    // exactly the case the turn exists to handle. The target-face capping
    // walls below must widen to seal turn 2's own full reach, not just
    // `toSlot`'s bounds, or its own outer edge stays open past the wall.
    const targetCapX0 = dogleg ? Math.min(toSlot.x1, dogleg.laneX0, gapX0) : toSlot.x1;
    const targetCapX1 = dogleg ? Math.max(toSlot.x2, dogleg.laneX1, gapX1) : toSlot.x2;
    // #294 fix round: the new side walls below must never reach past the
    // SOURCE's own cell boundary — see their own comment for why. Equals
    // corridorEndY exactly in the found-path (adjacent) case; strictly
    // less than it in the null-path (boxed-in) case.
    const sideWallEndY = Math.min(corridorEndY, cellBounds(fromPos.rank, fromPos.col).gy + ROW_STRIDE);
    const plainWalls = [
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
      // guaranteed within `[toSlot.x1, toSlot.x2]` (#230's own clamp),
      // so these two walls need no `Math.max`/`Math.min` at all — just
      // the slot's own edges (`targetCapX0`/`targetCapX1`, which equal
      // `toSlot.x1`/`toSlot.x2` outside a dogleg — see their own comment
      // above for the dogleg-widened case).
      { x1: targetCapX0, y1: corridorEndY, x2: gapX0, y2: corridorEndY },
      { x1: gapX1, y1: corridorEndY, x2: targetCapX1, y2: corridorEndY },
      // #294 fix: the two walls above only ever cap the corridor's own
      // depth HORIZONTALLY (at the source's own face and the target's
      // own face) — nothing previously closed its SIDES. A token
      // standing anywhere between faceY and corridorEndY could walk
      // laterally to any x within the room's own margin band, not just
      // the actual [spanX0,spanX1] floor — confirmed live: seeing and
      // walking into space beside a correctly-narrow corridor tile.
      // These two VERTICAL walls, at the corridor floor's own real
      // edges (spanX0/spanX1 — the ACTUAL floor width, which can still
      // be wider than DOOR_WIDTH in the #231 clamped-merge-room
      // residual case; using doorX0/doorX1 here instead would wall over
      // part of that real floor, reintroducing a #230-style defect),
      // running its own depth, seal the rest of the margin band on both
      // sides — same "seal everything except the declared opening"
      // philosophy transitCellContainmentWalls already uses for a
      // transit cell.
      //
      // #294 fix round: clipped at `sideWallEndY`, NOT `corridorEndY`
      // directly — a review found the unclipped version was the #288
      // first-draft pattern all over again. This fast path also fires
      // for a NULL path (`!path`, boxed in — #93/#174's own documented,
      // accepted "direct line can cut through an occupied cell"
      // limitation), where `corridorEndY = toRect.gy` can sit several
      // ROW_STRIDEs below the source when the target is multiple ranks
      // away — the unclipped side walls ran that FULL distance,
      // slicing through whatever occupied the cells in between
      // (routine: a revealed hidden-detour room sitting directly north
      // of the target is EXACTLY what forces the null path in the first
      // place). Measured: 57% of generated dungeons had at least one
      // room sliced, breaking 179 previously-working connections.
      // Clipping to the SOURCE's own cell boundary — the same span
      // `cellMarginWalls` already seals for this room — fixes it: in
      // the adjacent (found-path) case `corridorEndY` already equals
      // this same boundary exactly (no behavior change there, the
      // live-reported leak stays fixed), and in the null-path case the
      // side walls now stop at the source's own margin, never reaching
      // into cells this function has no business drawing walls through.
      ...(dogleg
        ? [
            // Self-review finding (round 2, discovered via the explicit
            // "every corridor floor tile walled on all four sides except
            // the door" hand-verification): turn 1's own left/right sides
            // (`turnGx`/`turnGx2`, spanning `faceY..turnBottom`) had NO
            // containment at all -- neither `cellMarginWalls` (only ever
            // draws 2 lines, along a CELL's own OUTER east/south
            // boundary, never an interior x) nor `roomEnclosureWalls`
            // (only the room's own rect edges, at `faceY` itself, not
            // south of it) covers this. This is the exact same margin-
            // band-lateral-walk defect #294 already fixed once for the
            // non-dogleg case's own `spanX0`/`spanX1` walls (which run
            // this identical `faceY..sideWallEndY` depth) -- turn 1 is
            // that same region for the dogleg case and needs the same
            // containment. (#297 Round 2 Task 1: these 4 walls -- the pair
            // above plus the south-cap pair below -- now come straight
            // from `marginBandApproach`'s own `turnWalls`, not duplicated
            // inline.)
            ...dogleg.turn1Walls,
            // Contain the lane's own sides for its own remaining run,
            // through the rest of the source's own margin AND into the
            // blocking cell -- but only down to `legTop`, not
            // `corridorEndY`: below `legTop` the lane bends sideways into
            // turn 2 (below), so a wall running the lane's own x all the
            // way to `corridorEndY` would wall the lane off from that
            // turn instead of just containing it (review round 1 fix —
            // this was the dead-end bug: the original single-turn dogleg
            // never anticipated a SECOND turn sharing the same band).
            { x1: dogleg.laneX0, y1: dogleg.turnBottom, x2: dogleg.laneX0, y2: dogleg.legTop },
            { x1: dogleg.laneX1, y1: dogleg.turnBottom, x2: dogleg.laneX1, y2: dogleg.legTop },
            // Cap turn 2's own top edge (at legTop) except where the lane
            // continues down into it -- same "seal everything except the
            // declared opening" shape as the pair above. Turn 2's own
            // south edge (at corridorEndY) is sealed by the two
            // `targetCapX0`/`targetCapX1` walls earlier in this array,
            // except at the real door (gapX0..gapX1).
            { x1: Math.min(dogleg.laneX0, gapX0), y1: dogleg.legTop, x2: dogleg.laneX0, y2: dogleg.legTop },
            { x1: dogleg.laneX1, y1: dogleg.legTop, x2: Math.max(dogleg.laneX1, gapX1), y2: dogleg.legTop },
            // Review round 2 fix: turn 2's own floor is WIDER than the
            // lane (it spans `[min(laneX0,gapX0), max(laneX1,gapX1))`,
            // not just `[laneX0,laneX1)`) whenever `gapX0 !== laneX0` or
            // `gapX1 !== laneX1` -- the common case, exactly the condition
            // turn 2 exists to handle. The lane's own side walls above
            // only run `turnBottom..legTop`, so turn 2's own sides (the
            // part of its floor that extends past the lane, from `legTop`
            // down to `corridorEndY`) were left completely unwalled --
            // a token could walk laterally off the corridor into the
            // blocking room's own open south-margin band. These two
            // walls seal turn 2's own real left/right edges for its own
            // depth (`legTop..corridorEndY`), the same "contain the
            // floor's own real edges, not a narrower guess" shape as the
            // lane's own side walls above and the non-dogleg span walls
            // below.
            { x1: Math.min(dogleg.laneX0, gapX0), y1: dogleg.legTop, x2: Math.min(dogleg.laneX0, gapX0), y2: corridorEndY },
            { x1: Math.max(dogleg.laneX1, gapX1), y1: dogleg.legTop, x2: Math.max(dogleg.laneX1, gapX1), y2: corridorEndY },
          ]
        : [
            { x1: spanX0, y1: faceY, x2: spanX0, y2: sideWallEndY },
            { x1: spanX1, y1: faceY, x2: spanX1, y2: sideWallEndY },
          ]),
    ].filter((w) => w.x1 !== w.x2 || w.y1 !== w.y2);
    const doorWall = { x1: doorX0, y1: faceY, x2: doorX1, y2: faceY };
    const revealDoorWall = { x1: gapX0, y1: corridorEndY, x2: gapX1, y2: corridorEndY };

    // #174 Task 5: a null path and a length<=2 path now produce identical
    // geometry — the distinction only mattered when `!path` took the
    // (now-deleted) trunk-lane detour.
    return {
      doorWall, revealDoorWall, plainWalls,
      corridorSegments: dogleg
        ? [
            dogleg.turn1Segment,
            { gx: dogleg.laneX0, gy: dogleg.turnBottom, gw: DOOR_WIDTH, gh: dogleg.legTop - dogleg.turnBottom },
            {
              gx: Math.min(dogleg.laneX0, gapX0),
              gy: dogleg.legTop,
              gw: Math.max(dogleg.laneX1, gapX1) - Math.min(dogleg.laneX0, gapX0),
              gh: DOOR_WIDTH,
            },
          ]
        : [{ gx: spanX0, gy: faceY, gw: spanX1 - spanX0, gh: corridorEndY - faceY }],
      transitCells: [],
      foreignOpening,
    };
  }

  // #230 review note: computeRanks/computeColumns always place a real
  // child at least one rank below its own parent (Task 4's ranking
  // walk), so an east-exit connection to a same-RANK target — the only
  // way this branch fires — doesn't occur in this generator's own
  // current output; a 500-seed sweep found zero real cases. Kept (not
  // deleted) for symmetry with the south/sameColumn branch above and in
  // case a future graph shape reaches it; the fix below is still exact
  // for whichever `incomingFace` this connection actually uses.
  const sameRank = fromRect.gy === toRect.gy;
  if (exitFace === 'east' && sameRank) {
    const faceX = fromRect.gx + fromRect.gw;
    const corridorEndX = toRect.gx;
    const doorY0 = fromRect.gy + outgoingOffset;
    const doorY1 = doorY0 + DOOR_WIDTH;
    // #297: exact mirror of the south/sameColumn branch's own dogleg above
    // (see its own comment for the full reasoning) — exactly one
    // intermediate cell exists between source and target when they're 2
    // columns apart on the same rank on a null path; if that cell holds a
    // real room whose own footprint the fixed doorY0 row would cross,
    // reroute through that room's own south margin (a horizontal "lane"),
    // then jog again through that same room's own east margin (turn 2) to
    // reach wherever the target's real door lands, instead of cutting
    // straight through the room.
    let dogleg = null;
    let foreignOpening = null;
    if (!path && toPos.col === fromPos.col + 2) {
      const blockRank = fromPos.rank;
      const blockCol = fromPos.col + 1;
      const occupantId = occupiedCells[`${blockRank},${blockCol}`];
      if (occupantId != null && occupantId !== fromRoomId && occupantId !== toRoomId) {
        const blockCell = cellBounds(blockRank, blockCol);
        const occupantRect = roomRect(seed, occupantId, blockRank, blockCol);
        // occupantRect.gy === blockCell.gy === fromRect.gy always (NW
        // anchor, same rank) -- the occupant's own footprint spans
        // exactly [blockCell.gy, blockCell.gy + occupantRect.gh].
        const occupantSouthEdge = occupantRect.gy + occupantRect.gh;
        // #297 fix round 3: mirror of the south branch's own fix -- doorY0
        // alone isn't the only way the corridor's real floor can reach into
        // the blocker's footprint; #230/#231's own gap-widening (spanY0/
        // spanY1, widened when the target is a merge room with a narrower
        // clamped slot than the source's face) can stretch the NON-dogleg
        // span back across the blocker even when doorY0 itself sits outside
        // it. Compute the SAME provisional gap/span the non-dogleg branch
        // would actually produce, and trigger on THAT overlapping the
        // blocker's footprint, not just doorY0 in isolation.
        const provisionalGapY0 = Math.min(Math.max(doorY0, toSlot.y1), toSlot.y2 - DOOR_WIDTH);
        const provisionalGapY1 = provisionalGapY0 + DOOR_WIDTH;
        const provisionalSpanY0 = Math.min(doorY0, provisionalGapY0);
        const provisionalSpanY1 = Math.max(doorY1, provisionalGapY1);
        const spanOverlapsBlocker = provisionalSpanY0 < occupantSouthEdge && provisionalSpanY1 > occupantRect.gy;
        if (spanOverlapsBlocker) {
          // The turn MUST happen while still inside the SOURCE's own
          // margin band (faceX..blockCell.gx), never inside the blocking
          // cell itself -- same margin invariant as the south branch's
          // own turn 1.
          const laneY0 = occupantSouthEdge;
          const laneY1 = laneY0 + DOOR_WIDTH;
          // #297 Round 2 Task 1: mirror of the south branch's own
          // `marginBandApproach` call above, via `marginBandApproachY` (see
          // its own docblock) — same shared jog math, axes swapped.
          const { turnRight, turnGy, turnGy2, turnSegment: turn1Segment, turnWalls: turn1Walls } =
            marginBandApproachY(doorY0, doorY1, faceX, laneY0, DOOR_WIDTH);
          // Mirror of the south branch's own `legTop` fix: the lane's own
          // horizontal run can't reach all the way to corridorEndX and
          // stop -- a second turn, inside the BLOCKING room's own east
          // margin band, jogs the lane down/up to the real door before
          // crossing into the target's cell.
          const legRight = corridorEndX - DOOR_WIDTH;
          dogleg = { laneY0, laneY1, turnGy, turnGy2, turnRight, legRight, occupantId, blockCell, turn1Segment, turn1Walls };
        }
      }
    }
    // #297: when a dogleg is active, the corridor's real approach to the
    // target is from the lane's own y, not the original (now-abandoned)
    // doorY0 -- mirror of the south branch's own `targetFacingX0`.
    const targetFacingY0 = dogleg ? dogleg.laneY0 : doorY0;
    // #230 fix: same derivation as the south-exit/same-column branch
    // above, mirrored onto the y-axis — see its own comment for the full
    // reasoning.
    // #324: clampDoorStart, mirror of the south branch's own fix above.
    const gapY0 = clampDoorStart(toSlot.y1, toSlot.y2, targetFacingY0);
    const gapY1 = gapY0 + DOOR_WIDTH;
    const spanY0 = dogleg ? dogleg.turnGy : Math.min(doorY0, gapY0);
    const spanY1 = dogleg ? dogleg.turnGy2 : Math.max(doorY1, gapY1);
    // Mirror of the south branch's own review round 2 fix: `foreignOpening`
    // must describe the SAME y-range turn 2's own real floor spans, computed
    // from the SAME gapY0/gapY1 the containment walls below use.
    if (dogleg) {
      const openingY0 = Math.min(dogleg.laneY0, gapY0);
      const openingY1 = Math.max(dogleg.laneY1, gapY1);
      foreignOpening = {
        roomId: dogleg.occupantId,
        // The lane travels horizontally through the blocking room's own
        // SOUTH margin band but never actually crosses that room's own
        // south wall -- it stays inside the cell throughout. It crosses
        // the blocking room's own EAST wall (via the turn-2 jog) to
        // continue into the target's cell, so the opening this creates is
        // on the blocking room's EAST side, not its south.
        side: 'east',
        offset: openingY0 - dogleg.blockCell.gy,
        width: openingY1 - openingY0,
      };
    }
    // Mirror of the south branch's own review round 1 fix: turn 2 can
    // reach wider than `toSlot`'s own bounds whenever `laneY0`/`laneY1`
    // sit outside the target's slot -- the target-face capping walls
    // below must widen to seal turn 2's own full reach.
    const targetCapY0 = dogleg ? Math.min(toSlot.y1, dogleg.laneY0, gapY0) : toSlot.y1;
    const targetCapY1 = dogleg ? Math.max(toSlot.y2, dogleg.laneY1, gapY1) : toSlot.y2;
    // #294 fix round: mirror of the south branch's own sideWallEndY —
    // never reach past the SOURCE's own cell boundary. See its own
    // comment (in the south branch above) for the full reasoning.
    const sideWallEndX = Math.min(corridorEndX, cellBounds(fromPos.rank, fromPos.col).gx + COLUMN_STRIDE);
    const plainWalls = [
      { x1: faceX, y1: fromRect.gy, x2: faceX, y2: doorY0 },
      { x1: faceX, y1: doorY1, x2: faceX, y2: Math.max(fromRect.gy + fromRect.gh, spanY1) },
      { x1: corridorEndX, y1: targetCapY0, x2: corridorEndX, y2: gapY0 },
      { x1: corridorEndX, y1: gapY1, x2: corridorEndX, y2: targetCapY1 },
      // #294 fix: same missing-side-walls defect as the south/sameColumn
      // branch above, mirrored onto the x-axis — see its own comment for
      // the full reasoning. These two HORIZONTAL walls, at the corridor
      // floor's own real edges (spanY0/spanY1), seal the rest of the
      // margin band above and below the corridor's own path — clipped to
      // sideWallEndX for the same null-path reason as the south branch.
      ...(dogleg
        ? [
            // Mirror of the south branch's own turn-1-side containment
            // fix (self-discovered round-2 leak): turn 1's own top/bottom
            // sides (`turnGy`/`turnGy2`, spanning `faceX..turnRight`) need
            // the same containment `#294` already established for the
            // non-dogleg case's own `spanY0`/`spanY1` walls. (#297 Round 2
            // Task 1: these 4 walls now come straight from
            // `marginBandApproachY`'s own `turnWalls`, not duplicated
            // inline.)
            ...dogleg.turn1Walls,
            { x1: dogleg.turnRight, y1: dogleg.laneY0, x2: dogleg.legRight, y2: dogleg.laneY0 },
            { x1: dogleg.turnRight, y1: dogleg.laneY1, x2: dogleg.legRight, y2: dogleg.laneY1 },
            { x1: dogleg.legRight, y1: Math.min(dogleg.laneY0, gapY0), x2: dogleg.legRight, y2: dogleg.laneY0 },
            { x1: dogleg.legRight, y1: dogleg.laneY1, x2: dogleg.legRight, y2: Math.max(dogleg.laneY1, gapY1) },
            { x1: dogleg.legRight, y1: Math.min(dogleg.laneY0, gapY0), x2: corridorEndX, y2: Math.min(dogleg.laneY0, gapY0) },
            { x1: dogleg.legRight, y1: Math.max(dogleg.laneY1, gapY1), x2: corridorEndX, y2: Math.max(dogleg.laneY1, gapY1) },
          ]
        : [
            { x1: faceX, y1: spanY0, x2: sideWallEndX, y2: spanY0 },
            { x1: faceX, y1: spanY1, x2: sideWallEndX, y2: spanY1 },
          ]),
    ].filter((w) => w.x1 !== w.x2 || w.y1 !== w.y2);
    // A null path (boxed in, both north and west neighbors occupied,
    // #196) and a found path.length<=2 now draw the exact same direct
    // line -- the distinction only mattered back when a null path took
    // the (now-deleted) trunkLaneCorridorSegments detour instead.
    return {
      doorWall: { x1: faceX, y1: doorY0, x2: faceX, y2: doorY1 },
      revealDoorWall: { x1: corridorEndX, y1: gapY0, x2: corridorEndX, y2: gapY1 },
      plainWalls,
      corridorSegments: dogleg
        ? [
            dogleg.turn1Segment,
            { gx: dogleg.turnRight, gy: dogleg.laneY0, gw: dogleg.legRight - dogleg.turnRight, gh: DOOR_WIDTH },
            {
              gx: dogleg.legRight,
              gy: Math.min(dogleg.laneY0, gapY0),
              gw: DOOR_WIDTH,
              gh: Math.max(dogleg.laneY1, gapY1) - Math.min(dogleg.laneY0, gapY0),
            },
          ]
        : [{ gx: faceX, gy: spanY0, gw: corridorEndX - faceX, gh: spanY1 - spanY0 }],
      transitCells: [],
      foreignOpening,
    };
  }

  // Different column (or a non-south, non-east-fast-path exit face): a
  // straight leg out of fromRect on exitFace, a corner, then a straight
  // leg into `toSlot`. Simpler than the same-column case's precise
  // two-door offset trimming — a candidate for a future refinement pass
  // if a reviewer finds the corner geometry too blocky in practice.
  //
  // #174 Task 5: a null path and a found path.length<=2 now take this
  // same corner-based route unconditionally — the (now-deleted)
  // trunkLaneCorridorSegments detour this branch used to take for a null
  // path was found unsound by a later review (100% broken for west-exit
  // connections, ~half its remaining cases bisected by a real
  // containment wall).
  // #324 (third finding): same fix as the multi-cell branch above -- a
  // room's own exact center always lands exactly on a grid line, so
  // subtract a FULL DOOR_WIDTH (not half) to give exitPoint/entryPoint
  // gap-START semantics directly, keeping the door's own span
  // `[point, point + DOOR_WIDTH)` inside one whole cell instead of
  // straddling two.
  const exitPoint = exitFace === 'east'
    ? { x: fromRect.gx + fromRect.gw, y: fromRect.gy + fromRect.gh / 2 - DOOR_WIDTH }
    : exitFace === 'west'
    ? { x: fromRect.gx, y: fromRect.gy + fromRect.gh / 2 - DOOR_WIDTH }
    : { x: fromRect.gx + fromRect.gw / 2 - DOOR_WIDTH, y: fromRect.gy + fromRect.gh };
  const entryPoint = incomingFace === 'west'
    ? { x: toSlot.x1, y: clampDoorStart(toSlot.y1, toSlot.y2, toSlot.y1 + slotSpan / 2 - DOOR_WIDTH) }
    : { x: clampDoorStart(toSlot.x1, toSlot.x2, toSlot.x1 + slotSpan / 2 - DOOR_WIDTH), y: toSlot.y1 };
  const corner = { x: entryPoint.x, y: exitPoint.y };

  const doorWall = exitFace === 'south'
    ? { x1: exitPoint.x, y1: exitPoint.y, x2: exitPoint.x + DOOR_WIDTH, y2: exitPoint.y }
    : { x1: exitPoint.x, y1: exitPoint.y, x2: exitPoint.x, y2: exitPoint.y + DOOR_WIDTH };
  // Face-aware, mirroring entryPoint's own conditional above -- same fix
  // as the multi-cell branch's own revealDoorWall/plainWalls (see its
  // comment for why: a west toSlot is a vertical line, so its reveal
  // door and flanking walls must run vertically too).
  const revealDoorWall = incomingFace === 'west'
    ? { x1: entryPoint.x, y1: entryPoint.y, x2: entryPoint.x, y2: entryPoint.y + DOOR_WIDTH }
    : { x1: entryPoint.x, y1: entryPoint.y, x2: entryPoint.x + DOOR_WIDTH, y2: entryPoint.y };

  const plainWalls = [
    ...sourceFaceCapWalls(fromRect, exitFace, exitPoint),
    ...(incomingFace === 'west'
      ? [
          { x1: entryPoint.x, y1: toSlot.y1, x2: entryPoint.x, y2: entryPoint.y },
          { x1: entryPoint.x, y1: entryPoint.y + DOOR_WIDTH, x2: entryPoint.x, y2: toSlot.y2 },
        ]
      : [
          { x1: toSlot.x1, y1: entryPoint.y, x2: entryPoint.x, y2: entryPoint.y },
          { x1: entryPoint.x + DOOR_WIDTH, y1: entryPoint.y, x2: toSlot.x2, y2: entryPoint.y },
        ]
    ),
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
    foreignOpening: null,
  };
}

/**
 * The `openOffset` a room's own cell-margin containment wall (Task 2's
 * `cellMarginWalls`) must use for its outgoing connection on `exitFace`,
 * so the gap it leaves lines up with wherever `buildEdgeCorridor` will
 * actually route that same connection's real corridor (#174 Task 5's own
 * fix round, amended after a re-review found the first pass incomplete;
 * #288's own review round widened the return shape — see below).
 *
 * `buildEdgeCorridor` uses a doorOffsetAt-based exit point for a
 * south-face connection where `fromPos.col === toPos.col`, or an
 * east-face connection where `fromPos.rank === toPos.rank` (#174 Task 5's
 * own same-rank/east-exit fast path) — in either case ONLY when it takes
 * its adjacent-or-no-path fallback branch (`!path || path.length <= 2`)
 * — never just `path.length <= 2` alone, since a null path (no free
 * route — e.g. the target's own north-neighbor cell is occupied,
 * findCorridorPath's north-only-entry rule) falls back to the SAME
 * offset-based branch as a directly-adjacent connection, and this is a
 * routine shape for a merge room several ranks below a parent, not a
 * rare corner. Every other case — a different-column south connection, a
 * different-rank east connection, or any connection whose path takes the
 * multi-cell branch — uses buildEdgeCorridor's center-based exit point
 * instead. This function re-derives exactly which branch buildEdgeCorridor
 * will take (by calling the same `findCorridorPath` the caller already
 * needs for `buildEdgeCorridor` itself) rather than approximating it,
 * since the two must never independently drift.
 *
 * Returns `{offset, width}`, not a bare offset (#288's own review round):
 * `buildEdgeCorridor`'s offset-based branch can draw a corridor floor
 * WIDER than DOOR_WIDTH — the union of the source's own door offset and
 * the target's own (#230-clamped) incoming offset, whenever those two
 * differ. A margin wall (`cellMarginWalls`) opened only DOOR_WIDTH wide,
 * at the source's own offset alone, left the REST of that wider real
 * floor — up to and including the target's own entire door, once a
 * LARGE room's own margin started being sealed at all (#288) — covered
 * by solid wall. Rather than re-deriving the target's own offset here
 * too (duplicating buildEdgeCorridor's own clamp logic, and risking a
 * third independent place these could drift apart), this calls
 * `buildEdgeCorridor` directly with an assumed single, full-width
 * incoming slot — exactly right for the common case (a target with
 * exactly one incoming connection, where that assumption IS the real
 * slot) — and reads back its own actual `corridorSegments[0]`, the real
 * span the corridor floor will occupy. A merge target's own narrower,
 * per-connection slot (this assumption doesn't know about) is a
 * separate, already-tracked residual — #231 — not solved here.
 */
export function outgoingMarginOffset(seed, fromRoomId, toRoomId, exitFace, fromRect, fromPos, toPos, occupiedCells, incomingFace = 'north') {
  if (exitFace !== 'south' && exitFace !== 'east') {
    // West never takes buildEdgeCorridor's offset-based branch — always
    // center-based, regardless of the child's rank/column. #324: matches
    // buildEdgeCorridor's own exitPoint gap-START fix (full DOOR_WIDTH,
    // not half) -- these two must never independently drift.
    return { offset: fromRect.gh / 2 - DOOR_WIDTH, width: DOOR_WIDTH };
  }
  const aligned = exitFace === 'south' ? fromPos.col === toPos.col : fromPos.rank === toPos.rank;
  const path = aligned
    ? findCorridorPath(fromPos, toPos, occupiedCells, { fromRoomId, toRoomId, incomingFace })
    : null;
  const usesOffsetBasedExit = aligned && (!path || path.length <= 2);
  // South's offset runs along the room's own width (gw); east's runs
  // along its own height (gh) — buildEdgeCorridor's own `outgoingOffset`
  // and center-based fallback make the identical face-based choice (see
  // its own doorX0/doorY0 computations).
  const faceSpan = exitFace === 'south' ? fromRect.gw : fromRect.gh;
  if (!usesOffsetBasedExit) {
    // #324: matches buildEdgeCorridor's own exitPoint gap-START fix in
    // both its multi-cell and corner-case branches (full DOOR_WIDTH, not
    // half) -- these must never independently drift.
    return { offset: faceSpan / 2 - DOOR_WIDTH, width: DOOR_WIDTH };
  }
  const toRect = roomRect(seed, toRoomId, toPos.rank, toPos.col);
  const toSlot = doorSlotsForFace(toRect, 1, incomingFace)[0];
  const { corridorSegments } = buildEdgeCorridor(
    seed, fromRoomId, toRoomId, fromRect, toRect, fromPos, toPos, exitFace, toSlot, occupiedCells, incomingFace,
  );
  const seg = corridorSegments[0];
  return exitFace === 'south'
    ? { offset: seg.gx - fromRect.gx, width: seg.gw }
    : { offset: seg.gy - fromRect.gy, width: seg.gh };
}

/**
 * Whether a connection's own candidate corridor's `foreignOpening` (a
 * #297 Round 1 dogleg trigger) points at ANOTHER of the same target
 * room's own real parents -- the #297 Round 2 collision this file's own
 * spec calls out: the blocking room turns out to be the target's own
 * co-parent. Returns that co-parent's own index in `incomingConnections`,
 * or -1 for "no collision" -- covers both "no dogleg at all" and "dogleg
 * fired, but the blocker is genuinely unrelated" (Round 1's own original,
 * still-valid case). Reused by `findPriorityCollision` (Round 2 Task 4,
 * slot-priority design) with a synthetic `{roomId: blockerId}` argument,
 * to confirm a blocking room is genuinely one of the target's own real
 * parents before granting it slot priority.
 *
 * A HIDDEN connection's own sourceId never matches, even if it happens to
 * equal `roomId` -- a hidden connection's own door stays sealed/
 * unrevealed until a later game-state event, and the whole point of
 * Round 1's own dungeonHiddenDoorForEdge/dungeonDoorFromRoomId split is
 * that a hidden connection's own geometry is handled by a completely
 * separate mechanism this file does not touch.
 */
export function findCoParentCollision(candidateForeignOpening, incomingConnections) {
  if (!candidateForeignOpening) return -1;
  return incomingConnections.findIndex(
    (c) => !c.hidden && c.sourceId === candidateForeignOpening.roomId,
  );
}

/**
 * #297 Round 2: the slot index a colliding connection would land on if
 * granted priority -- whichever slot already contains, or sits nearest
 * east/south of, the blocking room's own far margin edge (the documented
 * residual: a LARGE blocker with a SMALL target falls back to the LAST
 * slot, since the edge falls past every slot's own far end). Extracted
 * (2026-09-29, fixing final-review finding D properly -- see below) as
 * the SINGLE shared source of truth for this index, used by BOTH
 * `findPriorityCollision` (to check the span this connection would
 * actually receive if granted priority) and `assignDoorSlotsWithPriority`
 * (to actually grant it) -- two separately-hand-copied computations of
 * this same index is exactly the "independently-computed positions,
 * nothing forces agreement" shape this file keeps re-discovering the hard
 * way (#230/#231, the abandoned ride-along design, and this very
 * function's own first version, which computed the span using the
 * connection's PLAIN list-order slot instead of the slot it would
 * actually be assigned, catching 1 of 11 real cases instead of all 11 --
 * see the SDD ledger's own review entry for the full trace).
 */
function priorityIndexForEdge(slots, axis, blockerRect) {
  let priorityIndex = slots.findIndex((s) => {
    const edgeCoord = axis === 'south' ? blockerRect.gx + blockerRect.gw : blockerRect.gy + blockerRect.gh;
    const end = axis === 'south' ? s.x2 : s.y2;
    return edgeCoord < end;
  });
  if (priorityIndex < 0) priorityIndex = slots.length - 1;
  return priorityIndex;
}

/**
 * #297 Round 2 (revised after the "ride-along" design in this file's own
 * earlier docblocks was found geometrically unsound): detects whether ANY
 * of `roomId`'s own real incoming connections is blocked, on its own
 * null-path fast-path fallback (Round 1's own dogleg trigger condition --
 * 2 ranks/columns apart, same column/row), by a cell occupied by ANOTHER
 * of `roomId`'s own real parents. Unlike the abandoned ride-along design,
 * this needs NO `buildEdgeCorridor` call -- the detection reuses only the
 * same cheap primitives Round 1's own trigger already uses
 * (`findCorridorPath`, `doorOffsetAt`, plain arithmetic), so it can run
 * BEFORE any connection's own door slot or corridor is built, in a single
 * pass.
 *
 * Reuses `findCoParentCollision` (unchanged, already merged) to confirm
 * the blocking room is genuinely one of `roomId`'s own real parents, by
 * passing it a synthetic `{roomId: blockerId}` -- that function only ever
 * reads `.roomId` off its own first argument, so this is a legitimate
 * reuse of its own already-tested hidden-connection guard, not a hack.
 *
 * #297 Round 2 fix (final-review finding D, 2026-09-29; corrected the same
 * day after an independent re-review caught the first version of this fix
 * checking the wrong slot): an occupied, real-co-parent intermediate cell
 * is NECESSARY but not SUFFICIENT for Round 1's own dogleg to actually
 * fire -- its own trigger (`buildEdgeCorridor`'s south/east fast-path
 * branches) additionally requires `findCorridorPath` to have failed
 * (`!path`) AND the corridor's own provisional span to actually overlap
 * the blocker's footprint (`spanOverlapsBlocker`, the same #230/#231
 * gap-widening check Round 1's own trigger uses) -- computed using the
 * slot this connection would ACTUALLY receive if granted priority
 * (`priorityIndexForEdge`, shared with `assignDoorSlotsWithPriority`), not
 * its own plain list-order slot. The first version of this fix used the
 * plain slot, which only coincidentally matches the priority slot when a
 * connection's own list index already equals `priorityIndexForEdge`'s own
 * result -- true for exactly 1 of the 11 real cases the final review
 * measured, so that version fixed 1 case and left 10 broken (an
 * independent re-review, dispatched specifically to verify this fix,
 * caught it by hand-tracing a case where the two slots differ). The
 * pre-fix version of this function (before either attempt) skipped both
 * checks entirely, granting slot priority in all 11 cases where the
 * colliding corridor was never actually going to dogleg at all.
 * `incomingFace` is a required parameter (the target room's own real
 * incoming face) so `doorSlotsForFace` below matches what
 * `buildEdgeCorridor` will actually receive.
 *
 * Returns the FIRST such collision found (scope: exactly one, per this
 * feature's own spec) or `null`.
 */
export function findPriorityCollision(seed, roomId, rank, col, incomingConnections, layoutPositionByRoomId, occupiedCells, incomingFace) {
  const targetRect = roomRect(seed, roomId, rank, col);
  const targetPos = { rank, col };
  const slots = incomingConnections.length
    ? doorSlotsForFace(targetRect, incomingConnections.length, incomingFace)
    : [];
  for (let i = 0; i < incomingConnections.length; i += 1) {
    const { sourceId, hidden } = incomingConnections[i];
    if (hidden) continue;
    const sourcePos = layoutPositionByRoomId[sourceId];
    if (!sourcePos) continue;
    let blockerId = null;
    let axis = null;
    let blockRank = null;
    let blockCol = null;
    if (sourcePos.col === col && rank === sourcePos.rank + 2) {
      blockRank = sourcePos.rank + 1;
      blockCol = col;
      blockerId = occupiedCells[`${blockRank},${blockCol}`];
      axis = 'south';
    } else if (sourcePos.rank === rank && col === sourcePos.col + 2) {
      blockRank = rank;
      blockCol = sourcePos.col + 1;
      blockerId = occupiedCells[`${blockRank},${blockCol}`];
      axis = 'east';
    }
    if (blockerId == null || blockerId === sourceId || blockerId === roomId) continue;
    if (findCoParentCollision({ roomId: blockerId }, incomingConnections) < 0) continue;

    const path = findCorridorPath(sourcePos, targetPos, occupiedCells, { fromRoomId: sourceId, toRoomId: roomId, incomingFace });
    if (path) continue;

    const sourceRect = roomRect(seed, sourceId, sourcePos.rank, sourcePos.col);
    const blockerRect = roomRect(seed, blockerId, blockRank, blockCol);
    const prioritySlot = slots[priorityIndexForEdge(slots, axis, blockerRect)];
    const outgoingOffset = doorOffsetAt(seed, `${sourceId}-${axis}`, 'outgoing', sourceRect.gw);
    let spanOverlapsBlocker;
    if (axis === 'south') {
      const doorX0 = sourceRect.gx + outgoingOffset;
      const doorX1 = doorX0 + DOOR_WIDTH;
      const occupantEastEdge = blockerRect.gx + blockerRect.gw;
      const provisionalGapX0 = Math.min(Math.max(doorX0, prioritySlot.x1), prioritySlot.x2 - DOOR_WIDTH);
      const provisionalGapX1 = provisionalGapX0 + DOOR_WIDTH;
      const provisionalSpanX0 = Math.min(doorX0, provisionalGapX0);
      const provisionalSpanX1 = Math.max(doorX1, provisionalGapX1);
      spanOverlapsBlocker = provisionalSpanX0 < occupantEastEdge && provisionalSpanX1 > blockerRect.gx;
    } else {
      const doorY0 = sourceRect.gy + outgoingOffset;
      const doorY1 = doorY0 + DOOR_WIDTH;
      const occupantSouthEdge = blockerRect.gy + blockerRect.gh;
      const provisionalGapY0 = Math.min(Math.max(doorY0, prioritySlot.y1), prioritySlot.y2 - DOOR_WIDTH);
      const provisionalGapY1 = provisionalGapY0 + DOOR_WIDTH;
      const provisionalSpanY0 = Math.min(doorY0, provisionalGapY0);
      const provisionalSpanY1 = Math.max(doorY1, provisionalGapY1);
      spanOverlapsBlocker = provisionalSpanY0 < occupantSouthEdge && provisionalSpanY1 > blockerRect.gy;
    }
    if (!spanOverlapsBlocker) continue;

    return { collidingIndex: i, axis, blockerId, blockRank, blockCol };
  }
  return null;
}

/**
 * #297 Round 2: the real per-connection slot list (`doorSlotsForFace`'s
 * own output, unchanged), with the colliding connection's own entry
 * (per `findPriorityCollision`) reassigned to whichever slot already
 * contains -- or sits nearest east/south of, when the blocking room's
 * own margin edge falls past every slot (the documented residual: a
 * LARGE blocker with a SMALL target) -- the blocking room's own far
 * margin edge. When `collision` is `null`, returns `doorSlotsForFace`'s
 * own direct output, byte-identical to today.
 *
 * #297 Round 2 fix (final-review finding B, 2026-09-29): the co-parent's
 * own connection (`collision.blockerId`'s own entry in
 * `incomingConnections`) is now explicitly pinned to the remaining slot
 * immediately WEST of the priority slot (`priorityIndex - 1`) -- every
 * slot with an index below `priorityIndex` is guaranteed west of (or at)
 * the blocking room's own margin edge, since `doorSlotsForFace` produces
 * slots left-to-right and `priorityIndex` is the FIRST slot whose own far
 * edge exceeds that margin edge. The pre-fix version merely preserved
 * every non-colliding connection's own original list-order position
 * across the leftover slots, with no guarantee THIS SPECIFIC connection
 * (the co-parent) ended up west of the edge rather than some other,
 * unrelated third connection -- whenever list order put an unrelated
 * connection there instead, the co-parent itself could land east of the
 * edge, in the dogleg's own reserved lane. Measured by the final review
 * at 22 real cases, all 22 sealing the colliding connection. Every OTHER
 * non-colliding, non-co-parent connection still keeps its own original
 * relative order across whatever slots remain -- only the co-parent's own
 * placement is now guaranteed rather than incidental. Defensive-only:
 * when `priorityIndex` is 0 (no slot exists west of the edge at all), it
 * falls back to the pre-fix list-order behavior rather than throwing --
 * given this codebase's own room-size discretization (only `ROOM_SIZE_
 * SMALL`/`ROOM_SIZE_LARGE`, `N >= 2` connections for any collision to
 * exist at all), a blocker's own margin edge can never actually fall
 * inside the very first slot, so this branch is believed unreachable in
 * practice, not merely unobserved in this file's own 500-seed corpus --
 * kept as a guard against a future change to room sizing invalidating
 * that math silently, not because it fires today.
 */
export function assignDoorSlotsWithPriority(seed, rect, incomingConnections, incomingFace, collision) {
  const slots = incomingConnections.length
    ? doorSlotsForFace(rect, incomingConnections.length, incomingFace)
    : [];
  if (!collision) return slots;
  const blockerRect = roomRect(seed, collision.blockerId, collision.blockRank, collision.blockCol);
  const priorityIndex = priorityIndexForEdge(slots, collision.axis, blockerRect);

  const coParentIndex = incomingConnections.findIndex((c) => c.sourceId === collision.blockerId);
  const pinCoParentSlotIndex = coParentIndex >= 0 && priorityIndex > 0 ? priorityIndex - 1 : null;

  const assignment = new Array(incomingConnections.length);
  assignment[collision.collidingIndex] = slots[priorityIndex];
  if (pinCoParentSlotIndex !== null) {
    assignment[coParentIndex] = slots[pinCoParentSlotIndex];
  }
  const remainingIndices = [];
  for (let idx = 0; idx < slots.length; idx += 1) {
    if (idx !== priorityIndex && idx !== pinCoParentSlotIndex) remainingIndices.push(idx);
  }
  let r = 0;
  for (let i = 0; i < incomingConnections.length; i += 1) {
    if (i === collision.collidingIndex) continue;
    if (i === coParentIndex && pinCoParentSlotIndex !== null) continue;
    assignment[i] = slots[remainingIndices[r]];
    r += 1;
  }
  return assignment;
}

/**
 * Every foreign margin opening `roomId`'s own `cellMarginWalls` call must
 * leave, for OTHER edges whose #297 dogleg routes through this room's own
 * margin band. A pure scan over the whole graph's real edges (`edges`,
 * never `layoutEdges` -- a hidden/detour edge's own routing is a separate,
 * untouched mechanism per this feature's own documented scope), calling
 * the SAME `buildEdgeCorridor` every real edge already goes through
 * (`buildPopulateAndUnlockGraphNode`'s own incoming-connections loop) and
 * reading back its `foreignOpening` field -- never re-deriving the
 * dogleg's own geometry separately, the same "call the real function,
 * don't approximate" precedent `outgoingMarginOffset` already set. Note
 * this function never hardcodes `DOOR_WIDTH` or a specific `side` value --
 * it passes through whatever `buildEdgeCorridor` computed, so it stays
 * correct even though Task 2's own review rounds widened `foreignOpening`'s
 * real meaning (real crossing width, potentially > DOOR_WIDTH; the side
 * the corridor actually CROSSES, not the margin band the lane merely sits
 * in) after this function's own design was first written.
 *
 * Correct regardless of build order: this module performs eager,
 * full-graph pregeneration (`roomsToEagerlyBuild`), so every input here
 * (`edges`, `layoutPositionByRoomId`, `incomingFaceByRoomId`) is already
 * fully known before ANY room is built -- no persisted registry, no
 * retroactive wall-patching needed (see this feature's own spec for the
 * full reasoning and the two wrong designs it replaced).
 *
 * Round 2 (#297) fix: each candidate edge's own target door slot is now
 * resolved via `incomingConnectionsFor(layoutEdges ?? edges, childId,
 * hiddenIncomingByRoomId)` -- the SAME per-connection slot
 * `buildPopulateAndUnlockGraphNode`'s own incoming-connections loop
 * assigns that target room when it's actually built -- rather than always
 * assuming the target has exactly one incoming connection
 * (`doorSlotsForFace(targetRect, 1, targetIncomingFace)[0]`). A merge
 * room with 2+ real parents gets a narrower, correctly-indexed slot per
 * edge instead of every edge sharing one assumed full-width slot; a
 * single-connection target still resolves to that same slot 0 as before
 * (strict generalization). `layoutEdges`/`hiddenIncomingByRoomId` are
 * optional trailing params so this stays a pure scan callable with just
 * `edges` when no detour/hidden-path data is available (`layoutEdges ??
 * edges` falls back to `edges` itself, which equals `layoutEdges` for
 * every non-detour room).
 */
export function pendingForeignMarginOpenings(seed, roomId, rank, col, edges, layoutPositionByRoomId, incomingFaceByRoomId, occupiedCells, layoutEdges, hiddenIncomingByRoomId = {}) {
  const result = { east: [], south: [] };
  for (const [sourceId, childIds] of Object.entries(edges)) {
    const sourcePos = layoutPositionByRoomId[sourceId];
    if (!sourcePos) continue;
    const sourceIncomingFace = incomingFaceByRoomId?.[sourceId] ?? 'north';
    childIds.forEach((childId, index) => {
      const targetPos = layoutPositionByRoomId[childId];
      if (!targetPos) return;
      const exitFace = exitFaceForIndex(index, sourceIncomingFace);
      const sameColumnTwoDown = exitFace === 'south' && sourcePos.col === targetPos.col && targetPos.rank === sourcePos.rank + 2;
      const sameRankTwoOver = exitFace === 'east' && sourcePos.rank === targetPos.rank && targetPos.col === sourcePos.col + 2;
      if (!sameColumnTwoDown && !sameRankTwoOver) return;
      // Only worth calling buildEdgeCorridor (real work) when THIS room is
      // actually the blocking cell for this candidate edge.
      const blockRank = sameColumnTwoDown ? sourcePos.rank + 1 : sourcePos.rank;
      const blockCol = sameColumnTwoDown ? sourcePos.col : sourcePos.col + 1;
      if (blockRank !== rank || blockCol !== col) return;
      const sourceRect = roomRect(seed, sourceId, sourcePos.rank, sourcePos.col);
      const targetRect = roomRect(seed, childId, targetPos.rank, targetPos.col);
      const targetIncomingFace = incomingFaceByRoomId?.[childId] ?? 'north';
      const targetConnections = incomingConnectionsFor(layoutEdges ?? edges, childId, hiddenIncomingByRoomId);
      const slotIndex = targetConnections.findIndex((c) => !c.hidden && c.sourceId === sourceId);
      // A real parent not found among its own target's real connections
      // would be a graph-consistency bug elsewhere (childIds and
      // parentRoomIdsFor disagreeing) -- fall back to a single full-width
      // slot rather than crash, matching this function's own existing
      // defensive style (the `if (!sourcePos) continue`/`if (!targetPos)
      // return` guards just above).
      const toSlot = slotIndex >= 0
        ? doorSlotsForFace(targetRect, targetConnections.length, targetIncomingFace)[slotIndex]
        : doorSlotsForFace(targetRect, 1, targetIncomingFace)[0];
      const { foreignOpening } = buildEdgeCorridor(
        seed, sourceId, childId, sourceRect, targetRect, sourcePos, targetPos,
        exitFace, toSlot, occupiedCells, targetIncomingFace,
      );
      if (foreignOpening && foreignOpening.roomId === roomId) {
        result[foreignOpening.side].push({ offset: foreignOpening.offset, width: foreignOpening.width });
      }
    });
  }
  return result;
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
 * A point on `cell`'s own `side` boundary that shares `anchor`'s
 * axis-coordinate along that side — north/south share `x`, east/west
 * share `y`. The other coordinate is always `cell`'s own boundary line,
 * never `anchor`'s (#225): `anchor` is typically a point on a NEIGHBORING
 * cell's own boundary, or a room's real door, not necessarily on `cell`
 * itself. Used by `buildEdgeCorridor`'s multi-cell chain (Task 3) to derive
 * each transit cell's forced entry/exit point from its neighbor's, so two
 * pieces that share a physical boundary always agree on where they cross
 * it, by construction rather than by coincidence.
 */
export function projectOntoSide(cell, side, anchor) {
  if (side === 'north') return { x: anchor.x, y: cell.gy };
  if (side === 'south') return { x: anchor.x, y: cell.gy + cell.gh };
  if (side === 'west') return { x: cell.gx, y: anchor.y };
  return { x: cell.gx + cell.gw, y: anchor.y }; // east
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
 * Column index (integer, per-rank left-to-right order, always even) via
 * a single DFS pass from entryId — #93 pre-flight fix (see the note
 * below the function for what the original bottom-up-width/top-down-centering
 * design got wrong and why it was replaced). Every room is visited
 * exactly once (first parent to reach it wins, matching the design's
 * "merge rooms placed once, whichever parent reaches them first"
 * intent); each NEW room claims the next unused EVEN column at its own
 * rank via a monotonic per-rank counter stepping by 2 (#174 follow-up —
 * previously stepped by 1), which guarantees two different rooms at the
 * same rank can never collide on a column AND leaves the odd column
 * immediately to every room's own west side permanently empty — a
 * genuinely free routing/incoming-face lane, not just a side effect of
 * visit order. `ranks` (pre-computed by computeRanks, already correctly
 * reflecting a merge room's longest-path rank) is looked up directly,
 * not re-derived from DFS depth, so a merge room still lands at its
 * correct rank regardless of which parent's branch reaches it first.
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
    nextColByRank[rank] = col + 2;
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
 *
 * #288 fix: `hasMargin` used to require `rect.gw === ROOM_SIZE_SMALL`
 * (or `gh`), silently treating a ROOM_SIZE_LARGE room as having zero
 * margin. That was never true once ROW_STRIDE/COLUMN_STRIDE became
 * `ROOM_SIZE_LARGE + CORRIDOR_LEN` (#174's own skip-by-2 follow-up) — a
 * LARGE room still has a real `CORRIDOR_LEN`-wide margin on its own
 * south/east sides, exactly like a SMALL room's wider one, just
 * narrower. The `=== ROOM_SIZE_SMALL` check left every LARGE room's own
 * margin completely unsealed: no wall at all, not just a misaligned
 * gap — confirmed live, a player could see past a LARGE room's own real
 * wall into whatever lay beyond, and walk through the open margin
 * around a still-LOCKED gate door entirely. `rect.gw < cell.gw` (already
 * computed inline in the old condition, just not used on its own) is the
 * correct, size-agnostic test: does this room's own rect actually fall
 * short of its cell's full span, regardless of which named size it is.
 */
/**
 * Seals a room's grid-cell margin beyond its own rect (see original
 * docblock above this function, unchanged — the L-shaped-margin
 * reasoning, the #288 `rect.gw < cell.gw` fix, all still apply).
 *
 * #297: generalized from a single `{openSide, openOffset, openWidth}` to
 * `openingsBySide` (`{ east?: [{offset, width}], south?: [{offset, width}]
 * }`), so a side can carry the room's OWN outgoing gap and an independent
 * FOREIGN pass-through gap (another edge's dogleg routed through this
 * room's own margin) at once — needed because a foreign dogleg's lane can
 * land on the same side as this room's own outgoing connection. Every
 * existing call site passing a single opening is expressible as a
 * one-element array on that side; this function's own test suite pins
 * that the single-opening case produces byte-identical output to the old
 * single-opening signature (see this task's own review focus).
 */
export function cellMarginWalls(rect, rank, col, openingsBySide = {}) {
  const cell = cellBounds(rank, col);
  const walls = [];

  const sealSide = (dir, hasMargin, along) => {
    if (!hasMargin) return;
    const openings = (openingsBySide[dir] ?? [])
      .slice()
      .sort((a, b) => a.offset - b.offset);
    const full = dir === 'east' ? cell.gh : cell.gw;
    let cursor = 0;
    for (const { offset, width } of openings) {
      const gapStart = offset;
      const gapEnd = offset + width;
      if (gapStart > cursor) walls.push(along(cell.gx, cell.gy, cell.gx + cell.gw, cell.gy + cell.gh, cursor, gapStart));
      cursor = Math.max(cursor, gapEnd);
    }
    if (cursor < full) walls.push(along(cell.gx, cell.gy, cell.gx + cell.gw, cell.gy + cell.gh, cursor, full));
  };

  const eastLine = (cgx, cgy, cgx2, cgy2, from = 0, to = cgy2 - cgy) =>
    ({ dir: 'east', x1: cgx2, y1: cgy + from, x2: cgx2, y2: cgy + to });
  const southLine = (cgx, cgy, cgx2, cgy2, from = 0, to = cgx2 - cgx) =>
    ({ dir: 'south', x1: cgx + from, y1: cgy2, x2: cgx + to, y2: cgy2 });

  sealSide('east', rect.gw < cell.gw, eastLine);
  sealSide('south', rect.gh < cell.gh, southLine);

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
export function transitCellCrossing(seed, rank, col, entrySide, exitSide, edgeId, { forcedEntryPoint, forcedExitPoint } = {}) {
  const cell = cellBounds(rank, col);
  // #225: a forced point (from buildEdgeCorridor's chain, Task 3) is used
  // verbatim in place of this cell's own independently-seeded offset —
  // the whole fix for "two pieces sharing a boundary don't agree on where
  // they cross it." Omitting both (every pre-#225 call site) falls
  // through to the exact original seeded behavior.
  const entryPoint = forcedEntryPoint
    ?? SIDE_POINT[entrySide](cell, doorOffsetAt(seed, `transit-${rank}-${col}-${entrySide}-${edgeId}`, 'incoming', cell[SIDE_SPAN[entrySide]]));
  const exitPoint = forcedExitPoint
    ?? SIDE_POINT[exitSide](cell, doorOffsetAt(seed, `transit-${rank}-${col}-${exitSide}-${edgeId}`, 'outgoing', cell[SIDE_SPAN[exitSide]]));

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
export function findCorridorPath(fromPos, toPos, occupiedCells, { fromRoomId, toRoomId, incomingFace = 'north' }) {
  const SEARCH_MARGIN = 2;
  const key = (pos) => `${pos.rank},${pos.col}`;
  const minRank = Math.max(0, Math.min(fromPos.rank, toPos.rank) - SEARCH_MARGIN);
  const maxRank = Math.max(fromPos.rank, toPos.rank) + SEARCH_MARGIN;
  const minCol = Math.min(fromPos.col, toPos.col) - SEARCH_MARGIN;
  const maxCol = Math.max(fromPos.col, toPos.col) + SEARCH_MARGIN;
  const inBounds = (pos) =>
    pos.rank >= minRank && pos.rank <= maxRank && pos.col >= minCol && pos.col <= maxCol;
  // #174 follow-up: a broader legitimateSourceIds exemption was tried
  // here (so a co-parent legitimately sitting at a merge room's own gate
  // cell wouldn't block a DIFFERENT parent's own edge) and reverted --
  // this plan's own final whole-branch review found it unsound (C1):
  // exempting a co-parent HERE let a path route straight through that
  // co-parent's own real room as if it were empty transit space, which
  // then got walled like a transit cell, potentially sealing the
  // co-parent's own door. A follow-up attempt moved the fix into
  // incomingFaceFor instead, but that was ALSO reverted (see its own
  // docblock) once found net-negative given the current state of the
  // multi-cell/transit-cell machinery. Both fixes are deferred until
  // that machinery itself is fixed -- so occupiedCells CAN still
  // legitimately contain a co-parent at a real entry point today; when it
  // does, this function correctly returns null (the existing, honest
  // "no free path" degradation), same as before either fix was tried.
  const isBlocked = (pos) => {
    const occupant = occupiedCells[key(pos)];
    return occupant != null && occupant !== fromRoomId && occupant !== toRoomId;
  };
  // Generalized from #174's own north-only-entry fix: a room's incoming
  // connection lands on whichever face incomingFaceFor chose for it
  // (north or west, both structurally marginless) -- only that ONE
  // neighbor cell may step into the target; every other neighbor treats
  // it as unreachable, same as any blocked cell.
  const incomingNeighbor = incomingFace === 'west'
    ? { rank: toPos.rank, col: toPos.col - 1 }
    : { rank: toPos.rank - 1, col: toPos.col };
  const canEnter = (from, to) => {
    if (to.rank === toPos.rank && to.col === toPos.col) {
      return from.rank === incomingNeighbor.rank && from.col === incomingNeighbor.col;
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
