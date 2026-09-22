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

/** A free grid cell adjacent (incl. diagonally) to `leaderCell`, not present
 * in `occupiedCells` — preferring whichever is closest to `fromCell` so
 * multiple AI-controlled tokens spread out around the leader instead of
 * all aiming for the same cell. `null` if all 8 are occupied. */
function freeAdjacentCell(leaderCell, fromCell, occupiedCells) {
  const candidates = [];
  for (let dx = -1; dx <= 1; dx += 1) {
    for (let dy = -1; dy <= 1; dy += 1) {
      if (dx === 0 && dy === 0) continue;
      const cell = { gx: leaderCell.gx + dx, gy: leaderCell.gy + dy };
      if (!occupiedCells.has(cellKey(cell))) candidates.push(cell);
    }
  }
  if (!candidates.length) return null;
  candidates.sort((a, b) => chebyshev(a, fromCell) - chebyshev(b, fromCell));
  return candidates[0];
}

/**
 * The follow-move an AI-controlled token at `fromCell` should make toward
 * `leaderCell`:
 * - `{status: "already-near"}` — within one tile already, nothing to do.
 * - `{status: "no-route"}` — every adjacent cell is occupied, or no path
 *   exists to the one free adjacent cell found (a wall in the way).
 * - `{status: "move", to: {gx, gy}}` — the destination cell to move to.
 *
 * `occupiedCells` is a `Set` of `"gx,gy"` keys the destination must avoid.
 * `isBlocked`/`bounds` are passed straight through to `findPath`.
 */
export function findFollowMove(
  fromCell,
  leaderCell,
  occupiedCells,
  isBlocked,
  bounds,
) {
  if (chebyshev(fromCell, leaderCell) <= 1) return { status: "already-near" };

  const target = freeAdjacentCell(leaderCell, fromCell, occupiedCells);
  if (!target) return { status: "no-route" };

  const path = findPath(fromCell, target, isBlocked, bounds);
  if (!path || path.length <= 1) return { status: "no-route" };

  return { status: "move", to: path[path.length - 1] };
}
