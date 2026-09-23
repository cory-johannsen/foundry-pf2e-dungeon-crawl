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

/** Every free grid cell adjacent (incl. diagonally) to `leaderCell` where
 * the mover's own `footprint.gw × footprint.gh` block, anchored there,
 * doesn't overlap anything in `occupiedFootprints` — ordered closest-to-
 * `fromCell` first so multiple AI-controlled tokens spread out around the
 * leader instead of all aiming for the same cell. Empty if all 8 are
 * blocked. `footprint` defaults to a single square (#140: a no-op for
 * every pre-existing caller). */
function freeAdjacentCells(
  leaderCell,
  fromCell,
  occupiedFootprints,
  footprint = { gw: 1, gh: 1 },
) {
  const candidates = [];
  for (let dx = -1; dx <= 1; dx += 1) {
    for (let dy = -1; dy <= 1; dy += 1) {
      if (dx === 0 && dy === 0) continue;
      const cell = { gx: leaderCell.gx + dx, gy: leaderCell.gy + dy };
      const candidateFootprint = {
        gx: cell.gx,
        gy: cell.gy,
        gw: footprint.gw,
        gh: footprint.gh,
      };
      const blocked = occupiedFootprints.some((f) =>
        overlaps(candidateFootprint, f),
      );
      if (!blocked) candidates.push(cell);
    }
  }
  candidates.sort((a, b) => chebyshev(a, fromCell) - chebyshev(b, fromCell));
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
 * #87: tries every free adjacent cell, closest to `fromCell` first, rather
 * than only the single closest one — at a doorway, the geometrically
 * closest adjacent cell to the leader is very often a walled-off pocket
 * (e.g. a corner right next to the door) that's unreachable even though
 * the door tile itself, one square farther away by this metric, is wide
 * open. Trying only the closest candidate made every AI-controlled
 * follower report "no-route" and stay stranded in that case, even though a
 * perfectly good path existed through a different adjacent cell.
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

  const candidates = freeAdjacentCells(
    leaderCell,
    fromCell,
    occupiedFootprints,
    footprint,
  );
  for (const target of candidates) {
    const path = findPath(fromCell, target, isBlocked, bounds, 20000, footprint);
    if (path && path.length > 1) return { status: "move", to: target };
  }
  return { status: "no-route" };
}
