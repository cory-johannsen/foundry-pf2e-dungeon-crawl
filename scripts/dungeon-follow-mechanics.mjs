/**
 * Pure follow-the-leader movement computation for AI-controlled party
 * actors (#20) — see docs/superpowers/specs/
 * 2026-09-21-offline-player-ai-control-design.md. Operates entirely on
 * plain {gx, gy} grid coordinates and caller-supplied predicates, exactly
 * like pathfinding.mjs itself; scripts/dungeon-follow.mjs is the only
 * caller and the one place that translates real Foundry state into these
 * plain shapes.
 */
import { findPath, hasLineOfSight } from "./pathfinding.mjs";
import { overlaps, freeSpot } from "./placement.mjs";

/** The `"gx,gy"` string key used to store/compare grid cells in a Set —
 * the one place this format is spelled out, so dungeon-follow.mjs's own
 * occupied-cell bookkeeping can't silently disagree with this module's. */
export function cellKey(cell) {
  return `${cell.gx},${cell.gy}`;
}

/** A token's (or any `{x, y}` pixel position's) grid cell, given the
 * scene's grid size. Pure arithmetic — no Foundry globals. */
export function tokenCell(token, gridSize) {
  return {
    gx: Math.round(token.x / gridSize),
    gy: Math.round(token.y / gridSize),
  };
}

/** The inclusive grid-cell bounds of a `{width, height}` scene, given the
 * grid size — `null` if the scene has no usable dimensions. Pure
 * arithmetic — no Foundry globals. */
export function sceneBounds(scene, gridSize) {
  if (!scene?.width || !scene?.height) return null;
  return {
    gx0: 0,
    gy0: 0,
    gx1: Math.ceil(scene.width / gridSize) - 1,
    gy1: Math.ceil(scene.height / gridSize) - 1,
  };
}

function chebyshev(a, b) {
  return Math.max(Math.abs(a.gx - b.gx), Math.abs(a.gy - b.gy));
}

// #87 (third root cause round): a leader tucked into a corner can have
// fewer than 8 valid immediate neighbors -- with several AI-controlled
// followers all competing for that same shrunken set, one or more
// mathematically cannot get a cell and used to report "no-route" forever,
// even though plenty of free, reachable floor exists one ring farther out.
// Capped, not unbounded: followers should end up NEAR the leader, not
// wherever the nearest open square in the whole dungeon happens to be if
// something else goes wrong (e.g. every immediate cell legitimately
// occupied by other party members in a large room) -- 10 rings is well
// past any single room's own radius (ROOM_SIZE_LARGE is 12 SQUARES wide,
// not rings, so a follower anywhere inside one is always well within this)
// while still keeping a genuinely stranded follower's "no-route" honest.
const MAX_FOLLOW_SEARCH_RADIUS = 10;

function cellInFootprint(cell, f) {
  return (
    cell.gx >= f.gx &&
    cell.gx < f.gx + f.gw &&
    cell.gy >= f.gy &&
    cell.gy < f.gy + f.gh
  );
}

/** Every free cell in a `radius`-ring around `center` (its own Chebyshev
 * perimeter only, not the filled square inside it -- radius 1 is the
 * classic 8-neighborhood). */
function ringCells(center, radius) {
  const cells = [];
  for (let dx = -radius; dx <= radius; dx += 1) {
    for (let dy = -radius; dy <= radius; dy += 1) {
      if (Math.max(Math.abs(dx), Math.abs(dy)) !== radius) continue;
      cells.push({ gx: center.gx + dx, gy: center.gy + dy });
    }
  }
  return cells;
}

/** Every free grid cell within `MAX_FOLLOW_SEARCH_RADIUS` rings of
 * `leaderCell` where the mover's own `footprint.gw × footprint.gh` block,
 * anchored there, doesn't overlap anything in `occupiedFootprints` —
 * ordered ring-by-ring (closest to the leader first), and within each
 * ring closest-to-`fromCell` first, so multiple AI-controlled tokens
 * spread out around the leader instead of all aiming for the same cell,
 * and only reach farther out when the immediate neighborhood is actually
 * full. Empty if every ring up to the cap is blocked. `footprint` defaults
 * to a single square (#140: a no-op for every pre-existing caller). */
function freeCellsNear(
  leaderCell,
  fromCell,
  occupiedFootprints,
  footprint = { gw: 1, gh: 1 },
) {
  const candidates = [];
  for (let radius = 1; radius <= MAX_FOLLOW_SEARCH_RADIUS; radius += 1) {
    const ring = ringCells(leaderCell, radius)
      .filter((cell) => {
        const candidateFootprint = {
          gx: cell.gx,
          gy: cell.gy,
          gw: footprint.gw,
          gh: footprint.gh,
        };
        return !occupiedFootprints.some((f) => overlaps(candidateFootprint, f));
      })
      .sort((a, b) => chebyshev(a, fromCell) - chebyshev(b, fromCell));
    candidates.push(...ring);
  }
  return candidates;
}

/**
 * The follow-move an AI-controlled token at `fromCell` should make toward
 * `leaderCell`:
 * - `{status: "already-near"}` — within one tile already, nothing to do.
 * - `{status: "no-route"}` — every adjacent cell is occupied, or no path
 *   exists to any free adjacent cell (walls in the way on every candidate).
 * - `{status: "move", to: {gx, gy}, steps}` — the destination cell to move
 *   to, and `steps` (#610), the ordered cells to walk through to reach it
 *   (not including `fromCell`).
 *
 * `occupiedCells` is a `Set` of `"gx,gy"` keys the destination must avoid.
 * `isBlocked`/`bounds` are passed straight through to `findPath`.
 *
 * #87 (first round): tries every free adjacent cell, closest to `fromCell`
 * first, rather than only the single closest one — at a doorway, the
 * geometrically closest adjacent cell to the leader is very often a
 * walled-off pocket (e.g. a corner right next to the door) that's
 * unreachable even though the door tile itself, one square farther away by
 * this metric, is wide open. Trying only the closest candidate made every
 * AI-controlled follower report "no-route" and stay stranded in that case,
 * even though a perfectly good path existed through a different adjacent
 * cell.
 *
 * #87 (third round): that first round only ever searched the leader's own
 * immediate 8-neighborhood — a leader tucked into a corner can have fewer
 * valid cells there than there are followers, so one or more still got
 * "no-route" even with every candidate in that shrunken set correctly
 * tried, purely from running out of cells to compete over. `freeCellsNear`
 * now expands outward ring by ring (still ring-by-ring-closest-first, so a
 * follower never skips a nearer free cell for a farther one) instead of
 * stopping after the first ring.
 */
export function findFollowMove(
  fromCell,
  leaderCell,
  occupiedFootprints,
  isBlocked,
  bounds,
  footprint = { gw: 1, gh: 1 },
) {
  if (chebyshev(fromCell, leaderCell) <= 1) return { status: "already-near" };

  const candidates = freeCellsNear(
    leaderCell,
    fromCell,
    occupiedFootprints,
    footprint,
  );
  // #365: a step into a cell covered by any blocking footprint is blocked
  // too, so a path can't run through (and leapfrog) another token.
  // Footprints flagged `passable` (e.g. loot piles/corpses) don't block the
  // path, though freeCellsNear still avoids them as destinations.
  const blockers = occupiedFootprints.filter((f) => !f.passable);
  const pathBlocked = (a, b) =>
    isBlocked(a, b) || blockers.some((f) => cellInFootprint(b, f));
  for (const target of candidates) {
    const path = findPath(fromCell, target, pathBlocked, bounds, 20000, footprint);
    // #610: `steps` is the path minus its start cell, for hop-by-hop walking.
    if (path && path.length > 1)
      return { status: "move", to: target, steps: path.slice(1) };
  }
  return { status: "no-route" };
}

/** #150: the cell a drifted (off-grid) token should be corrected to.
 * Nearest-cell rounding stays the first candidate, but it's only accepted
 * if the token's footprint there overlaps no `occupied` footprint (the
 * token's own must already be excluded by the caller) and no wall/door
 * edge (`isBlocked`, same predicate findPath uses) lies on the straight
 * line from the cell the token's drifted center actually sits in to the
 * candidate's own center cell. Otherwise the nearest valid cell within
 * `maxRing` rings (placement.mjs's freeSpot) is used. If nothing valid is
 * found, falls back to the plain rounded cell with `valid: false` --
 * the pre-#150 behavior, never worse. Pure: `x`/`y` are the drifted pixel
 * position, `gw`/`gh` the token's footprint in squares. */
export function chooseResnapCell({
  x,
  y,
  gridSize,
  gw = 1,
  gh = 1,
  occupied = [],
  isBlocked = () => false,
  maxRing = 3,
}) {
  const rounded = {
    gx: Math.round(x / gridSize),
    gy: Math.round(y / gridSize),
    gw,
    gh,
  };
  const origin = {
    gx: Math.floor((x + (gw * gridSize) / 2) / gridSize),
    gy: Math.floor((y + (gh * gridSize) / 2) / gridSize),
  };
  const accept = (spot) =>
    hasLineOfSight(
      origin,
      {
        gx: spot.gx + Math.floor(gw / 2),
        gy: spot.gy + Math.floor(gh / 2),
      },
      isBlocked,
    );
  if (!occupied.some((o) => overlaps(rounded, o)) && accept(rounded)) {
    return { gx: rounded.gx, gy: rounded.gy, valid: true };
  }
  const spot = freeSpot({
    occupied,
    gx: rounded.gx,
    gy: rounded.gy,
    gw,
    gh,
    maxRing,
    accept,
  });
  return spot
    ? { gx: spot.gx, gy: spot.gy, valid: true }
    : { gx: rounded.gx, gy: rounded.gy, valid: false };
}

/** #610: the straight (Bresenham-style, one cell per step) run from `from`
 * to `to`, excluding `from`, or null if any step is out of bounds, crosses a
 * blocked edge, or cuts a blocked corner (same flank rules as findPath for a
 * 1x1 mover). findPath's tie-breaking zigzags, so extendTrail tries this
 * first. */
function straightSegment(from, to, isBlocked, bounds) {
  const n = Math.max(Math.abs(to.gx - from.gx), Math.abs(to.gy - from.gy));
  const cells = [];
  let prev = from;
  for (let i = 1; i <= n; i++) {
    const next = {
      gx: from.gx + Math.round(((to.gx - from.gx) * i) / n),
      gy: from.gy + Math.round(((to.gy - from.gy) * i) / n),
    };
    if (
      bounds &&
      !(
        next.gx >= bounds.gx0 &&
        next.gx <= bounds.gx1 &&
        next.gy >= bounds.gy0 &&
        next.gy <= bounds.gy1
      )
    )
      return null;
    if (isBlocked(prev, next)) return null;
    const dx = next.gx - prev.gx;
    const dy = next.gy - prev.gy;
    if (dx !== 0 && dy !== 0) {
      const a = { gx: prev.gx + dx, gy: prev.gy };
      const b = { gx: prev.gx, gy: prev.gy + dy };
      if (
        isBlocked(prev, a) ||
        isBlocked(prev, b) ||
        isBlocked(a, next) ||
        isBlocked(b, next)
      )
        return null;
    }
    cells.push(next);
    prev = next;
  }
  return cells;
}

/** #610: the leader's recent route as a newest-first list of cells
 * (`trail[0]` is its current cell). Extended per leader move by running
 * the wall-aware `findPath` from the previous cell to the new one -- a
 * reconstruction, so it may differ slightly from the exact route a player
 * dragged. Unchanged cell -> unchanged trail; walking back onto a trail
 * cell collapses the trail (a detour may still revisit cells; the
 * occupancy fallback prevents stacking); no path (teleport) or an empty
 * trail resets to `[toCell]`. Trimmed to `maxLen`, newest kept. */
export function extendTrail(trail, toCell, isBlocked, bounds, maxLen) {
  if (!trail.length) return [{ gx: toCell.gx, gy: toCell.gy }];
  if (trail[0].gx === toCell.gx && trail[0].gy === toCell.gy) return trail;
  const seen = trail.findIndex((c) => c.gx === toCell.gx && c.gy === toCell.gy);
  if (seen !== -1) return trail.slice(seen);
  const straight = straightSegment(trail[0], toCell, isBlocked, bounds);
  if (straight) return [...straight.reverse(), ...trail].slice(0, maxLen);
  const path = findPath(trail[0], toCell, isBlocked, bounds);
  if (!path || path.length < 2) return [{ gx: toCell.gx, gy: toCell.gy }];
  const fresh = path.slice(1).reverse();
  return [...fresh, ...trail].slice(0, maxLen);
}

/** #610: the move for a 1x1 follower to its assigned `trailCell`.
 * Returns `null` whenever the caller should fall back to `findFollowMove`
 * (no trail cell, follower larger than 1x1, destination occupied, or no
 * path). `{status:"already-near"}` when already on/adjacent to it. Same
 * result shape as `findFollowMove` otherwise. Occupancy handling mirrors
 * `findFollowMove`: non-passable footprints also block the path. */
export function findTrailMove(
  fromCell,
  trailCell,
  occupiedFootprints,
  isBlocked,
  bounds,
  footprint = { gw: 1, gh: 1 },
) {
  if (!trailCell || footprint.gw !== 1 || footprint.gh !== 1) return null;
  if (chebyshev(fromCell, trailCell) <= 1) return { status: "already-near" };
  if (occupiedFootprints.some((f) => cellInFootprint(trailCell, f))) return null;
  const blockers = occupiedFootprints.filter((f) => !f.passable);
  const pathBlocked = (a, b) =>
    isBlocked(a, b) || blockers.some((f) => cellInFootprint(b, f));
  const path = findPath(fromCell, trailCell, pathBlocked, bounds, 20000, footprint);
  if (!path || path.length < 2) return null;
  return { status: "move", to: trailCell, steps: path.slice(1) };
}
