/**
 * Pure follow-the-leader movement computation for AI-controlled party
 * actors (#20) — see docs/superpowers/specs/
 * 2026-09-21-offline-player-ai-control-design.md. Operates entirely on
 * plain {gx, gy} grid coordinates and caller-supplied predicates, exactly
 * like pathfinding.mjs itself; scripts/dungeon-follow.mjs is the only
 * caller and the one place that translates real Foundry state into these
 * plain shapes.
 */
import { findPath } from "./pathfinding.mjs";
import { overlaps } from "./placement.mjs";

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
 * - `{status: "move", to: {gx, gy}}` — the destination cell to move to.
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
    if (path && path.length > 1) return { status: "move", to: target };
  }
  return { status: "no-route" };
}
