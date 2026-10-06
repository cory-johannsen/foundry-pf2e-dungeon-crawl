/**
 * #823: corridor piece selection from OPENINGS. A corridor cell's piece is
 * decided by which of its four sides continue to another cell of the SAME
 * corridor, not by which end of a straight segment it sits at (the old
 * corridorTileVariant put an end cap at both ends of every segment, which
 * drew a wall across every join and bend). Foundry-free and pure.
 *
 * Rotation is clockwise degrees about the tile centre. Canonical pieces:
 * end@0 open S; mid@0 open N+S; corner@0 walls N+W, open S+E.
 */
export const PIECE_OPENINGS = {
  single: [],
  'end@0': ['S'], 'end@90': ['W'], 'end@180': ['N'], 'end@270': ['E'],
  'mid@0': ['N', 'S'], 'mid@90': ['E', 'W'],
  'corner@0': ['S', 'E'], 'corner@90': ['S', 'W'],
  'corner@180': ['N', 'W'], 'corner@270': ['N', 'E'],
};

const END_ROTATION_BY_OPENING = { S: 0, W: 90, N: 180, E: 270 };
const CORNER_ROTATION_BY_PAIR = { ES: 0, SW: 90, NW: 180, EN: 270 };
const SIDE_DELTA = { N: [0, -1], E: [1, 0], S: [0, 1], W: [-1, 0] };

export function cellKey(cell) {
  return `${cell.gx},${cell.gy}`;
}

/** The sides of `cell` whose neighbour cell is in `cellSet` (keys from cellKey). */
export function openingsOf(cell, cellSet) {
  return Object.entries(SIDE_DELTA)
    .filter(([, [dx, dy]]) => cellSet.has(cellKey({ gx: cell.gx + dx, gy: cell.gy + dy })))
    .map(([side]) => side);
}

/** True when any 2x2 block of cells is fully occupied: a wide (#555) corridor. */
export function hasBlock2x2(cellSet) {
  for (const key of cellSet) {
    const [gx, gy] = key.split(',').map(Number);
    if (
      cellSet.has(cellKey({ gx: gx + 1, gy })) &&
      cellSet.has(cellKey({ gx, gy: gy + 1 })) &&
      cellSet.has(cellKey({ gx: gx + 1, gy: gy + 1 }))
    )
      return true;
  }
  return false;
}

/** The art variant + rotation for a cell with these openings. 3+ openings
 * (a T or cross where two corridors share a cell) have no dedicated art: a
 * straight `mid` along the first opposite pair (N-S preferred) is used. */
export function corridorPieceForOpenings(openings) {
  const open = new Set(openings);
  const n = open.size;
  if (n === 0) return { variant: 'single', rotation: 0 };
  if (n === 1) return { variant: 'end', rotation: END_ROTATION_BY_OPENING[[...open][0]] };
  if (n === 2) {
    if (open.has('N') && open.has('S')) return { variant: 'mid', rotation: 0 };
    if (open.has('E') && open.has('W')) return { variant: 'mid', rotation: 90 };
    const pair = [...open].sort().join('');
    return { variant: 'corner', rotation: CORNER_ROTATION_BY_PAIR[pair] };
  }
  return open.has('N') && open.has('S')
    ? { variant: 'mid', rotation: 0 }
    : { variant: 'mid', rotation: 90 };
}
