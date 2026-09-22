/**
 * Foundry glue for follow-the-leader movement (#20) — see
 * docs/superpowers/specs/2026-09-21-offline-player-ai-control-design.md.
 * Combat has its own, separate turn-based movement (dungeon-combat.mjs);
 * this only runs between fights, whenever the run's host moves their own
 * token, and only on a genuinely GM-privileged client (mirrors
 * dungeon-combat.mjs's autoPlayCombatantTurnIfDue: every mutating action in
 * this module runs only on a human GM or the world's Agent-GM account).
 */
import { getRunState } from "./dungeon-runner.mjs";
import { blockedEdgesFromWalls } from "./pathfinding.mjs";
import { findFollowMove } from "./dungeon-follow-mechanics.mjs";

const MODULE_ID = "pf2e-dungeon-crawl";
const FOLLOW_DEBOUNCE_MS = 250;

const pendingByScene = new Map(); // sceneId -> setTimeout handle
const warnedNoLeaderForScene = new Set();

function tokenCell(token, gridSize) {
  return {
    gx: Math.round(token.x / gridSize),
    gy: Math.round(token.y / gridSize),
  };
}

function sceneBounds(scene, gridSize) {
  if (!scene?.width || !scene?.height) return null;
  return {
    gx0: 0,
    gy0: 0,
    gx1: Math.ceil(scene.width / gridSize) - 1,
    gy1: Math.ceil(scene.height / gridSize) - 1,
  };
}

/** Mirrors dungeon-combat.mjs's own wallBlocksMovement: a wall blocks
 * movement unless it's a door currently standing open. */
function wallBlocksMovement(wall) {
  if (wall.move === CONST.WALL_MOVEMENT_TYPES.NONE) return false;
  if (
    wall.door !== CONST.WALL_DOOR_TYPES.NONE &&
    wall.ds === CONST.WALL_DOOR_STATES.OPEN
  )
    return false;
  return true;
}

function movementBlockedEdges(scene, gridSize) {
  const walls = (scene.walls?.contents ?? [])
    .filter(wallBlocksMovement)
    .map((w) => ({ x1: w.c[0], y1: w.c[1], x2: w.c[2], y2: w.c[3] }));
  return blockedEdgesFromWalls(walls, gridSize);
}

/** The party actor owned (OWNER level) by the run's host user, if any —
 * "the leader" a run's AI-controlled actors follow. */
function resolveLeaderToken(scene, hostUserId) {
  if (!hostUserId) return null;
  const leaderActor = (game.actors?.party?.members ?? []).find(
    (a) => (a.ownership?.[hostUserId] ?? 0) >= 3,
  );
  if (!leaderActor) return null;
  return scene.tokens.find((t) => t.actor?.id === leaderActor.id) ?? null;
}

async function moveFollowersToward(scene, leaderToken, aiControlledIds) {
  const gridSize = scene.grid?.size ?? 100;
  const bounds = sceneBounds(scene, gridSize);
  const isBlocked = movementBlockedEdges(scene, gridSize);
  const leaderCell = tokenCell(leaderToken, gridSize);
  const occupied = new Set(
    scene.tokens.map((t) => {
      const cell = tokenCell(t, gridSize);
      return `${cell.gx},${cell.gy}`;
    }),
  );

  for (const actorId of aiControlledIds) {
    const token = scene.tokens.find((t) => t.actor?.id === actorId);
    if (!token) continue;
    const fromCell = tokenCell(token, gridSize);
    const result = findFollowMove(
      fromCell,
      leaderCell,
      occupied,
      isBlocked,
      bounds,
    );
    if (result.status === "already-near") continue;
    if (result.status === "no-route") {
      console.warn(
        `${MODULE_ID} | dungeon-follow: no route for actor ${actorId} to reach the leader.`,
      );
      continue;
    }
    occupied.delete(`${fromCell.gx},${fromCell.gy}`);
    occupied.add(`${result.to.gx},${result.to.gy}`);
    await token.update({
      x: result.to.gx * gridSize,
      y: result.to.gy * gridSize,
    });
  }
}

/** Hook target for `updateToken` (module.mjs). Debounced per scene so a
 * drag's many intermediate position updates trigger at most one recompute
 * every FOLLOW_DEBOUNCE_MS. */
export function followLeaderIfDue(tokenDoc, changes) {
  if (!game.user.isGM) return;
  if (changes.x === undefined && changes.y === undefined) return;
  const scene = tokenDoc.parent;
  if (!scene) return;

  const run = getRunState(scene.id);
  const aiControlledIds = run?.aiControlledActorIds ?? [];
  if (!aiControlledIds.length) return;

  const leaderToken = resolveLeaderToken(scene, run.hostUserId);
  if (!leaderToken) {
    if (!warnedNoLeaderForScene.has(scene.id)) {
      warnedNoLeaderForScene.add(scene.id);
      console.warn(
        `${MODULE_ID} | dungeon-follow: no leader token found for scene ${scene.id}; AI-controlled party actors won't follow.`,
      );
    }
    return;
  }
  if (leaderToken.id !== tokenDoc.id) return;

  clearTimeout(pendingByScene.get(scene.id));
  pendingByScene.set(
    scene.id,
    setTimeout(
      () => moveFollowersToward(scene, leaderToken, aiControlledIds),
      FOLLOW_DEBOUNCE_MS,
    ),
  );
}
