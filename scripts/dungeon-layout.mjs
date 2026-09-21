/**
 * Pure grid-unit geometry for a physical dungeon room layout — no Foundry
 * dependency, same split as dungeon-deck.mjs. A caller multiplies by the
 * scene's grid size to get pixels; this file only ever deals in grid
 * squares, the same separation scene-divination.mjs keeps between its
 * LAYOUT design space and layoutTransform()'s canvas space.
 *
 * Rooms are laid out boustrophedon (even rows run east, odd rows run west)
 * so a row's last room and the next row's first room always share a grid
 * column — the wrap between rows is a plain straight corridor, never a jog.
 * Physical slots are assigned lazily, one at a time, as the party actually
 * approaches each room (see dungeon-scene.mjs) — this file only answers
 * "given a slot number, where is it and how does it connect," with no idea
 * of when a slot gets built.
 *
 * A connection's door lives on exactly ONE wall: the earlier room's
 * forward-facing side, at its own independently-randomized offset. The
 * later room's facing side isn't wall-less any more (ITEM-9) — it gets a
 * plain opening (no door object, always passable) at its *own* independently
 * random offset, so the two ends of a connection often don't line up. The
 * shared 1-square-wide gap between them is enclosed by each room's own
 * gapped wall plus two fixed caps — see buildConnectionGeometry's docblock.
 *
 * Every room is square, either ROOM_SIZE_SMALL or ROOM_SIZE_LARGE on a side
 * (ITEM-17) — picked per slot, deterministically, by roomSizeAt. Positions
 * (slotRect) are therefore a *cumulative* walk from slot 0 up to the target
 * slot rather than a fixed `slot * stride` formula — see slotRect's own
 * docblock for why that's what actually keeps the boustrophedon wrap's
 * "shared column, never a jog" guarantee intact once rooms stop being a
 * uniform size.
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

const OPPOSITE = { north: 'south', south: 'north', east: 'west', west: 'east' };

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

/** Row/column of a physical slot, boustrophedon — independent of room size,
 * since it only decides *order*, not position. */
export function slotRowCol(slot) {
  const row = Math.floor(slot / ROOMS_PER_ROW);
  const posInRow = slot % ROOMS_PER_ROW;
  const col = row % 2 === 0 ? posInRow : ROOMS_PER_ROW - 1 - posInRow;
  return { row, col };
}

/** Compass direction from `slot` to `slot + 1`: 'east' | 'west' | 'south'. */
export function connectionDirection(slot) {
  const { row } = slotRowCol(slot);
  const posInRow = slot % ROOMS_PER_ROW;
  if (posInRow === ROOMS_PER_ROW - 1) return 'south';
  return row % 2 === 0 ? 'east' : 'west';
}

/**
 * The room's footprint in grid units (top-left + size) — a cumulative walk
 * from slot 0, not a fixed `slot * stride` formula, now that rooms can be
 * different sizes (ITEM-17). Two rules keep the boustrophedon wrap's "shared
 * column, never a jog" guarantee intact regardless of size:
 * - An east/west step moves along the *current* row: gy never changes (every
 *   room in a row shares its top edge — "top-aligned," not centered — so a
 *   large room in an otherwise-small row simply extends further down than
 *   its neighbours), and gx advances by the room being left behind's own
 *   width (east) or the room being entered's own width (west), plus
 *   CORRIDOR_LEN either way.
 * - A south step (the row wrap) carries gx forward completely unchanged —
 *   not recomputed from either room's width — which is exactly what
 *   guarantees the two wrap-connected rooms share a column no matter how
 *   different their sizes are. gy advances by the room being left behind's
 *   own height, plus CORRIDOR_LEN.
 *
 * Slot count in real dungeons is small (the Start form caps it at 20), so
 * this being an O(slot) walk rather than an O(1) formula is not worth
 * caching against.
 *
 * gx starts at INITIAL_GX, not 0 — a west-moving row can walk backward by up
 * to its own full width (confirmed live while implementing this: a 2-row
 * dungeon with an all-small east row followed by an all-large west row drove
 * gx to -6), and unlike gy (which only ever increases), nothing else bounds
 * gx from below. Worst realistic case, given the Start form's own 20-room
 * cap (at most 4 rows): each row's width is at most
 * `ROOMS_PER_ROW * ROOM_SIZE_LARGE + (ROOMS_PER_ROW - 1) * CORRIDOR_LEN` =
 * 64, so the most an odd (west-moving) row can ever drive gx down by, net of
 * whatever the row before it added, is on that order — INITIAL_GX is set
 * generously past that so gx stays positive (Foundry Tiles/Walls at a
 * negative coordinate would sit outside this module's own scene, which only
 * ever grows from an assumed (0,0) origin — see ensureSceneCovers) for any
 * dungeon this module can actually generate, including a mutation or two
 * (ITEM-9's Extra Travel Time) past the form's own cap.
 */
export const INITIAL_GX = 300;

export function slotRect(seed, slot) {
  let gx = INITIAL_GX;
  let gy = 0;
  let size = roomSizeAt(seed, 0);
  for (let s = 0; s < slot; s += 1) {
    const dir = connectionDirection(s);
    const nextSize = roomSizeAt(seed, s + 1);
    if (dir === 'east') {
      gx += size + CORRIDOR_LEN;
    } else if (dir === 'west') {
      gx -= CORRIDOR_LEN + nextSize;
    } else {
      // 'south' — gx deliberately untouched, see docblock above.
      gy += size + CORRIDOR_LEN;
    }
    size = nextSize;
  }
  return { gx, gy, gw: size, gh: size };
}

function roomSides(seed, slot) {
  const { gx, gy, gw, gh } = slotRect(seed, slot);
  return {
    north: { x1: gx, y1: gy, x2: gx + gw, y2: gy },
    south: { x1: gx, y1: gy + gh, x2: gx + gw, y2: gy + gh },
    west: { x1: gx, y1: gy, x2: gx, y2: gy + gh },
    east: { x1: gx + gw, y1: gy, x2: gx + gw, y2: gy + gh }
  };
}

/**
 * The room's own enclosing walls, as compass-labelled grid-unit segments,
 * excluding whichever side(s) face a connection. The incoming side (shared
 * with slot - 1) is derived and excluded automatically — its wall was
 * already drawn as slot - 1's outgoing connection geometry, so drawing it
 * again here would duplicate (and wrongly solidify) that boundary.
 */
export function roomEnclosureWalls(seed, slot, { hasOutgoing }) {
  const excluded = new Set();
  if (slot > 0) excluded.add(OPPOSITE[connectionDirection(slot - 1)]);
  if (hasOutgoing) excluded.add(connectionDirection(slot));

  return Object.entries(roomSides(seed, slot))
    .filter(([dir]) => !excluded.has(dir))
    .map(([dir, c]) => ({ dir, ...c }));
}

/**
 * The full, unsplit wall segment on slot's own outgoing-connection face
 * (ITEM-20) — a temporary placeholder dungeon-scene.mjs's buildRoomAtSlot
 * creates the instant a non-goal room is built, since roomEnclosureWalls
 * deliberately excludes this side (buildConnectionGeometry supplies the real,
 * precisely-cut door/opening geometry there, but only once the *next* room is
 * actually built). Without it, a room's outgoing face has zero wall segments
 * — and therefore blocks nothing — for however long the party sits in it
 * before the next room exists, leaking vision/light (and movement) straight
 * across the rest of the scene's pre-sized canvas. Superseded — deleted, not
 * merely covered — by buildConnectionGeometry's own plainWalls the moment
 * that next room's build step runs; see buildRoomAtSlot.
 */
export function outgoingFaceWall(seed, slot) {
  const dir = connectionDirection(slot);
  return { dir, ...roomSides(seed, slot)[dir] };
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
  const maxOffset = roomSize - DOOR_WIDTH;
  return Math.floor(r * (maxOffset + 1));
}

/**
 * Door geometry connecting `slot` to `slot + 1`, each end at its own
 * independent offset (`doorOffsetAt`) so the two doors often don't line up.
 *
 * Both ends are real Foundry doors. `slot`'s side (`doorWall`) is the
 * progress gate — locked/unlocked by the GM as today. `slot + 1`'s side
 * (`revealDoorWall`) starts merely closed, never locked — players can always
 * open it once they're through the first door — and *opening* it is what
 * reveals the next room and advances the tracker (see
 * dungeon-scene.mjs's handleDungeonDoorOpened), replacing the earlier
 * walk-into-the-room-boundary trigger with a real "open the door and see
 * what's inside" beat.
 *
 * Both rooms' own *wall* segments (the room's actual perimeter, minus that
 * room's own one-square gap) still span their entire connecting face,
 * regardless of where the other side's gap sits — a room's wall is a room's
 * wall, and (ITEM-17) each room's own segments are built from that room's
 * *own* rect (`slotRect(seed, slot)` / `slotRect(seed, slot + 1)`), not a
 * shared one, since the two rooms can now be different sizes. But the shared
 * 1-square-wide gap *column* between the two faces is only as tall
 * (east/west) or wide (south) as it needs to be to connect the two doors:
 * two capping segments close it off at `min(doorY0, gapY0)` and
 * `max(doorY1, gapY1)` (transposed for south), not at either room's own
 * top/bottom or left/right edges (ITEM-13) — so two closely-offset doors get
 * a short connecting hallway and two far-apart doors get a longer one,
 * instead of every connection rendering as a fixed full-face gallery.
 * `corridorRect` matches that same trimmed span, tiled once per grid square
 * by dungeon-scene.mjs (corridor.webp is a small self-contained "box"
 * texture that looks wrong stretched, so repeating it beats scaling it).
 */
export function buildConnectionGeometry(slot, seed) {
  const dir = connectionDirection(slot);
  const a = slotRect(seed, slot);
  const b = slotRect(seed, slot + 1);
  const outgoingOffset = doorOffsetAt(seed, slot, 'outgoing', a.gw);
  const incomingOffset = doorOffsetAt(seed, slot + 1, 'incoming', b.gw);
  const plainWalls = [];
  let doorWall;
  let revealDoorWall;
  let corridorRect;

  if (dir === 'east' || dir === 'west') {
    const faceX = dir === 'east' ? a.gx + a.gw : a.gx;
    const corridorEndX = dir === 'east' ? faceX + CORRIDOR_LEN : faceX - CORRIDOR_LEN;
    const doorY0 = a.gy + outgoingOffset;
    const doorY1 = doorY0 + DOOR_WIDTH;
    const gapY0 = b.gy + incomingOffset;
    const gapY1 = gapY0 + DOOR_WIDTH;
    // The gap column only needs to span between the two doors, not either
    // room's full height (ITEM-13) — always within [min(a.gy,b.gy),
    // max(a.gy+a.gh, b.gy+b.gh)] since both offsets are clamped to their own
    // room's face. a.gy === b.gy always (same row, top-aligned — see
    // slotRect), so this is really just [a.gy, max(a.gh, b.gh) + a.gy], but
    // computed from the actual offsets rather than assumed.
    const spanY0 = Math.min(doorY0, gapY0);
    const spanY1 = Math.max(doorY1, gapY1);
    doorWall = { x1: faceX, y1: doorY0, x2: faceX, y2: doorY1 };
    revealDoorWall = { x1: corridorEndX, y1: gapY0, x2: corridorEndX, y2: gapY1 };
    plainWalls.push(
      { x1: faceX, y1: a.gy, x2: faceX, y2: doorY0 },
      { x1: faceX, y1: doorY1, x2: faceX, y2: a.gy + a.gh },
      { x1: corridorEndX, y1: b.gy, x2: corridorEndX, y2: gapY0 },
      { x1: corridorEndX, y1: gapY1, x2: corridorEndX, y2: b.gy + b.gh },
      { x1: Math.min(faceX, corridorEndX), y1: spanY0, x2: Math.max(faceX, corridorEndX), y2: spanY0 },
      { x1: Math.min(faceX, corridorEndX), y1: spanY1, x2: Math.max(faceX, corridorEndX), y2: spanY1 }
    );
    corridorRect = { gx: Math.min(faceX, corridorEndX), gy: spanY0, gw: CORRIDOR_LEN, gh: spanY1 - spanY0 };
  } else {
    // 'south'
    const faceY = a.gy + a.gh;
    const corridorEndY = faceY + CORRIDOR_LEN;
    const doorX0 = a.gx + outgoingOffset;
    const doorX1 = doorX0 + DOOR_WIDTH;
    const gapX0 = b.gx + incomingOffset;
    const gapX1 = gapX0 + DOOR_WIDTH;
    // Same trim as the east/west branch, along x instead of y (ITEM-13).
    // a.gx === b.gx always (the wrap's own "shared column" guarantee — see
    // slotRect), so this is really just [a.gx, max(a.gw, b.gw) + a.gx].
    const spanX0 = Math.min(doorX0, gapX0);
    const spanX1 = Math.max(doorX1, gapX1);
    doorWall = { x1: doorX0, y1: faceY, x2: doorX1, y2: faceY };
    revealDoorWall = { x1: gapX0, y1: corridorEndY, x2: gapX1, y2: corridorEndY };
    plainWalls.push(
      { x1: a.gx, y1: faceY, x2: doorX0, y2: faceY },
      { x1: doorX1, y1: faceY, x2: a.gx + a.gw, y2: faceY },
      { x1: b.gx, y1: corridorEndY, x2: gapX0, y2: corridorEndY },
      { x1: gapX1, y1: corridorEndY, x2: b.gx + b.gw, y2: corridorEndY },
      { x1: spanX0, y1: Math.min(faceY, corridorEndY), x2: spanX0, y2: Math.max(faceY, corridorEndY) },
      { x1: spanX1, y1: Math.min(faceY, corridorEndY), x2: spanX1, y2: Math.max(faceY, corridorEndY) }
    );
    corridorRect = { gx: spanX0, gy: Math.min(faceY, corridorEndY), gw: spanX1 - spanX0, gh: CORRIDOR_LEN };
  }

  // A door/opening offset landing at either extreme (0 or its own room's max)
  // leaves no room for the flanking segment on that side — drop the
  // resulting zero-length segment rather than create a degenerate Wall.
  const nonDegenerate = plainWalls.filter((w) => w.x1 !== w.x2 || w.y1 !== w.y2);
  return { doorWall, revealDoorWall, plainWalls: nonDegenerate, corridorRect };
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
