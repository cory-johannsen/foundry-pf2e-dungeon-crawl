/**
 * Grid-square A* pathfinding, decoupled from Foundry entirely — every export
 * here operates on plain {gx, gy} integer grid coordinates and caller-supplied
 * predicates/data, never a live Scene/Wall document. dungeon-combat.mjs is
 * the only caller, and it's the one place that translates real Foundry state
 * (Scene#grid#size, Scene#walls, Token#x/#y) into the plain shapes this file
 * consumes — same split this module already uses elsewhere (dungeon-layout.mjs
 * is pure/tested, dungeon-combat.mjs is Foundry-glue/live-verified per #98's
 * PR notes: "no pure-function surface here"). This file is the pure half of
 * #100's "real, obstacle- and wall-aware pathfinding."
 */

const DIRECTIONS = [
  { dx: -1, dy: -1 },
  { dx: 0, dy: -1 },
  { dx: 1, dy: -1 },
  { dx: -1, dy: 0 },
  { dx: 1, dy: 0 },
  { dx: -1, dy: 1 },
  { dx: 0, dy: 1 },
  { dx: 1, dy: 1 },
];

function key(cell) {
  return `${cell.gx},${cell.gy}`;
}

function inBounds(cell, bounds) {
  if (!bounds) return true;
  return (
    cell.gx >= bounds.gx0 &&
    cell.gx <= bounds.gx1 &&
    cell.gy >= bounds.gy0 &&
    cell.gy <= bounds.gy1
  );
}

/** Chebyshev distance in squares — the same "diagonal costs the same as
 * orthogonal" metric chebyshevSquares (dungeon-combat.mjs) already uses for
 * range/distance, kept consistent here since it's also this search's edge
 * cost (every step, diagonal or not, costs exactly 1 square) and therefore
 * an admissible, consistent A* heuristic for it. */
function chebyshev(a, b) {
  return Math.max(Math.abs(a.gx - b.gx), Math.abs(a.gy - b.gy));
}

function reconstructPath(cameFrom, current) {
  const path = [current];
  let k = key(current);
  while (cameFrom.has(k)) {
    current = cameFrom.get(k);
    path.push(current);
    k = key(current);
  }
  return path.reverse();
}

/**
 * A* over an 8-directional grid of unit squares. `start`/`goal` are
 * `{gx, gy}` integer grid-square coordinates. `isBlocked(a, b)` takes two
 * adjacent cells (`b` one step from `a`, any of the 8 directions) and
 * returns whether movement between them is blocked — the caller owns what
 * "blocked" means (walls, in dungeon-combat.mjs's case).
 *
 * A diagonal step from A to D also checks the four orthogonal edges around
 * the shared corner — A to each flanking cell, and each flanking cell to D
 * — and is blocked if any of them is, even when `isBlocked` itself allows
 * the diagonal pair (A, D) directly. Checking only the two edges leaving A
 * isn't enough: a wall pair anchored at D's side of the corner (e.g. both of
 * D's own orthogonal approaches walled off, D reachable only diagonally)
 * forms just as solid a corner as one anchored at A's side. (This is exactly
 * the class of leak #110 reports on the vision side; this search refuses to
 * reproduce it on the movement side.)
 *
 * `bounds`, if given, is `{gx0, gy0, gx1, gy1}` (inclusive) — cells outside
 * are never visited. Omit it only when the caller already knows the search
 * space is small (bounded by a `maxExpansions` safety valve either way, so a
 * pathological unbounded call can't loop forever).
 *
 * Returns an array of `{gx, gy}` waypoints from `start` to `goal` inclusive
 * (`start` is always first), or `null` if no path exists.
 */
export function findPath(
  start,
  goal,
  isBlocked,
  bounds = null,
  maxExpansions = 20000,
) {
  if (start.gx === goal.gx && start.gy === goal.gy) return [{ ...start }];
  if (!inBounds(goal, bounds)) return null;

  const open = new Map(); // key -> {cell, f}
  const cameFrom = new Map();
  const gScore = new Map([[key(start), 0]]);
  open.set(key(start), { cell: start, f: chebyshev(start, goal) });

  let expansions = 0;
  while (open.size > 0) {
    if (expansions++ > maxExpansions) return null;

    let currentKey = null;
    let current = null;
    let bestF = Infinity;
    for (const [k, entry] of open) {
      if (entry.f < bestF) {
        bestF = entry.f;
        currentKey = k;
        current = entry.cell;
      }
    }
    open.delete(currentKey);

    if (current.gx === goal.gx && current.gy === goal.gy)
      return reconstructPath(cameFrom, current);

    const currentG = gScore.get(currentKey);
    for (const { dx, dy } of DIRECTIONS) {
      const neighbor = { gx: current.gx + dx, gy: current.gy + dy };
      if (!inBounds(neighbor, bounds)) continue;

      const diagonal = dx !== 0 && dy !== 0;
      if (diagonal) {
        const flankA = { gx: current.gx + dx, gy: current.gy };
        const flankB = { gx: current.gx, gy: current.gy + dy };
        const blockedNearSource =
          isBlocked(current, flankA) || isBlocked(current, flankB);
        const blockedNearTarget =
          isBlocked(flankA, neighbor) || isBlocked(flankB, neighbor);
        if (blockedNearSource || blockedNearTarget) continue;
      }
      if (isBlocked(current, neighbor)) continue;

      const tentativeG = currentG + 1;
      const neighborKey = key(neighbor);
      if (tentativeG < (gScore.get(neighborKey) ?? Infinity)) {
        cameFrom.set(neighborKey, current);
        gScore.set(neighborKey, tentativeG);
        open.set(neighborKey, {
          cell: neighbor,
          f: tentativeG + chebyshev(neighbor, goal),
        });
      }
    }
  }
  return null;
}

/**
 * Builds the `isBlocked(a, b)` predicate `findPath` expects from a flat list
 * of axis-aligned wall segments in pixel space — the same `{x1, y1, x2, y2}`
 * shape `wallDoc`/`buildConnectionGeometry` (dungeon-scene.mjs,
 * dungeon-layout.mjs) already produce. Every wall this generator ever
 * creates is axis-aligned (ITEM-13/17's geometry never emits a diagonal
 * segment), so a non-axis-aligned segment is ignored rather than mishandled.
 *
 * `gridSize` is pixels per grid square (`Scene#grid#size`). A vertical wall
 * at pixel `x = X` spanning `[y0, y1)` blocks every east/west step across
 * the grid-column boundary at `X / gridSize`, for whichever rows it spans;
 * a horizontal wall blocks north/south steps the same way across a row
 * boundary. Diagonal steps aren't handled here directly — `findPath`'s own
 * flanking-edge check already covers them from these same orthogonal edges.
 */
export function blockedEdgesFromWalls(walls, gridSize) {
  const verticalBoundaries = new Map(); // boundary column index -> Set of row indices it blocks
  const horizontalBoundaries = new Map(); // boundary row index -> Set of column indices it blocks

  for (const wall of walls) {
    const { x1, y1, x2, y2 } = wall;
    if (x1 === x2) {
      const col = x1 / gridSize;
      if (!Number.isInteger(col)) continue;
      const rowLo = Math.round(Math.min(y1, y2) / gridSize);
      const rowHi = Math.round(Math.max(y1, y2) / gridSize);
      let rows = verticalBoundaries.get(col);
      if (!rows) verticalBoundaries.set(col, (rows = new Set()));
      for (let r = rowLo; r < rowHi; r += 1) rows.add(r);
    } else if (y1 === y2) {
      const row = y1 / gridSize;
      if (!Number.isInteger(row)) continue;
      const colLo = Math.round(Math.min(x1, x2) / gridSize);
      const colHi = Math.round(Math.max(x1, x2) / gridSize);
      let cols = horizontalBoundaries.get(row);
      if (!cols) horizontalBoundaries.set(row, (cols = new Set()));
      for (let c = colLo; c < colHi; c += 1) cols.add(c);
    }
    // Diagonal wall segments never occur in this generator's output; ignored.
  }

  return function isBlocked(a, b) {
    if (a.gy === b.gy) {
      // East/west step: crosses the vertical boundary between the two columns.
      const boundary = Math.max(a.gx, b.gx);
      return verticalBoundaries.get(boundary)?.has(a.gy) ?? false;
    }
    if (a.gx === b.gx) {
      // North/south step: crosses the horizontal boundary between the two rows.
      const boundary = Math.max(a.gy, b.gy);
      return horizontalBoundaries.get(boundary)?.has(a.gx) ?? false;
    }
    // Diagonal pair: blocked only if a wall runs exactly along that diagonal's
    // own footprint is meaningless for an axis-aligned wall, so a direct
    // diagonal is never blocked here — findPath's flanking-edge check is what
    // actually stops corner-cutting past an axis-aligned wall.
    return false;
  };
}
