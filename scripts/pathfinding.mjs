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

/**
 * Every unit grid cell the straight line from `start`'s own center to
 * `goal`'s own center passes through, `start` first and `goal` last — an
 * Amanatides–Woo grid raycast (#91's line-of-sight support), not a
 * supercover walk: when the line passes exactly through a lattice corner
 * (crossing a vertical and a horizontal cell boundary at the same point),
 * this takes that one diagonal step rather than the two orthogonal
 * "staircase" steps a supercover walk would also visit, since only the
 * corner-touching cell is actually on the line itself. Every consecutive
 * pair of cells this returns is therefore one of `findPath`'s own 8
 * adjacent directions, so `hasLineOfSight` below can reuse the exact same
 * `isBlocked(a, b)` edge predicate `findPath`/`blockedEdgesFromWalls`
 * already use for movement.
 */
function cellsAlongLine(start, goal) {
  const cells = [{ gx: start.gx, gy: start.gy }];
  if (start.gx === goal.gx && start.gy === goal.gy) return cells;

  const x0 = start.gx + 0.5;
  const y0 = start.gy + 0.5;
  const dx = goal.gx + 0.5 - x0;
  const dy = goal.gy + 0.5 - y0;
  const stepX = dx > 0 ? 1 : dx < 0 ? -1 : 0;
  const stepY = dy > 0 ? 1 : dy < 0 ? -1 : 0;
  const tDeltaX = stepX !== 0 ? Math.abs(1 / dx) : Infinity;
  const tDeltaY = stepY !== 0 ? Math.abs(1 / dy) : Infinity;

  let gx = start.gx;
  let gy = start.gy;
  let tMaxX = stepX !== 0 ? ((stepX > 0 ? gx + 1 : gx) - x0) / dx : Infinity;
  let tMaxY = stepY !== 0 ? ((stepY > 0 ? gy + 1 : gy) - y0) / dy : Infinity;

  const EPS = 1e-9;
  while (gx !== goal.gx || gy !== goal.gy) {
    if (stepX !== 0 && stepY !== 0 && Math.abs(tMaxX - tMaxY) < EPS) {
      gx += stepX;
      gy += stepY;
      tMaxX += tDeltaX;
      tMaxY += tDeltaY;
    } else if (tMaxX < tMaxY) {
      gx += stepX;
      tMaxX += tDeltaX;
    } else {
      gy += stepY;
      tMaxY += tDeltaY;
    }
    cells.push({ gx, gy });
  }
  return cells;
}

/**
 * Whether a straight, unobstructed line exists between `start` and `goal`
 * (plain `{gx, gy}` grid squares) given the same `isBlocked(a, b)` edge
 * predicate `findPath` consumes — #91: ranged/spell target eligibility
 * needs "is there a clear shot" (an arbitrary-distance straight line).
 * Reuses `cellsAlongLine`'s own straight-line cell walk, then checks every
 * consecutive pair it visits against `isBlocked` exactly like `findPath`
 * already does for its own steps: an orthogonal step is blocked whenever
 * `isBlocked` says so directly, and a diagonal step (the line passing
 * exactly through a lattice corner) is blocked if EITHER flanking
 * orthogonal edge around that corner is blocked — the identical
 * corner-cutting rule `findPath` already applies to movement (see its own
 * docblock), so a line of sight refuses to clip a wall corner exactly the
 * same way a Stride refuses to cut one.
 */
export function hasLineOfSight(start, goal, isBlocked) {
  const cells = cellsAlongLine(start, goal);
  for (let i = 1; i < cells.length; i += 1) {
    const a = cells[i - 1];
    const b = cells[i];
    const diagonal = a.gx !== b.gx && a.gy !== b.gy;
    if (diagonal) {
      const flankA = { gx: b.gx, gy: a.gy };
      const flankB = { gx: a.gx, gy: b.gy };
      const blockedNearSource = isBlocked(a, flankA) || isBlocked(a, flankB);
      const blockedNearTarget = isBlocked(flankA, b) || isBlocked(flankB, b);
      if (blockedNearSource || blockedNearTarget) return false;
    } else if (isBlocked(a, b)) {
      return false;
    }
  }
  return true;
}
