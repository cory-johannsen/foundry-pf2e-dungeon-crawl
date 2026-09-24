/**
 * Foundry glue for follow-the-leader movement (#20) — see
 * docs/superpowers/specs/2026-09-21-offline-player-ai-control-design.md.
 * Combat has its own, separate turn-based movement (dungeon-combat.mjs);
 * this only runs between fights, whenever the run's host moves their own
 * token, and only on a genuinely GM-privileged client (mirrors
 * dungeon-combat.mjs's autoPlayCombatantTurnIfDue: every mutating action in
 * this module runs only on a human GM or the world's Agent-GM account) —
 * a non-GM host requests it instead, via the same dungeon-remote.mjs relay
 * every other GM-less mutating action in this codebase already uses (#65:
 * previously there was no fallback at all, so follow-movement silently
 * never ran whenever no GM-privileged client happened to be connected).
 */
import { getRunState } from "./dungeon-runner.mjs";
import { requestDungeonAction } from "./dungeon-remote.mjs";
import { blockedEdgesFromWalls } from "./pathfinding.mjs";
import { footprint } from "./placement.mjs";
import {
  findFollowMove,
  tokenCell,
  sceneBounds,
} from "./dungeon-follow-mechanics.mjs";

const MODULE_ID = "pf2e-dungeon-crawl";
const FOLLOW_DEBOUNCE_MS = 250;

const pendingByScene = new Map(); // sceneId -> setTimeout handle
const warnedNoLeaderForScene = new Set();
const inFlightScenes = new Set();

/** Whether a started PF2e combat currently exists on `scene` — following
 * must never race the combat turn engine's own token.update() calls or
 * bypass action economy while a fight is live. */
function hasActiveCombat(scene) {
  return !!game.combats?.some((c) => c.started && c.scene?.id === scene.id);
}

// Mirrors dungeon-combat.mjs's own wallBlocksMovement/movementBlockedEdges
// (private, combat-scoped) — keep the wall/door logic in sync if either
// changes.
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

// Mirrors dungeon-combat.mjs's own wallBlocksMovement/movementBlockedEdges
// (private, combat-scoped) — keep the wall/door logic in sync if either
// changes.
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
    (a) => (a.ownership?.[hostUserId] ?? 0) === 3,
  );
  if (!leaderActor) return null;
  return scene.tokens.find((t) => t.actor?.id === leaderActor.id) ?? null;
}

async function moveFollowersToward(scene, leaderToken, aiControlledIds) {
  if (hasActiveCombat(scene)) return;
  if (inFlightScenes.has(scene.id)) return;
  inFlightScenes.add(scene.id);
  try {
    const gridSize = scene.grid?.size ?? 100;
    const bounds = sceneBounds(scene, gridSize);
    const isBlocked = movementBlockedEdges(scene, gridSize);
    const leaderCell = tokenCell(leaderToken, gridSize);
    const occupied = scene.tokens.map((t) => footprint(t, gridSize));

    for (const actorId of aiControlledIds) {
      const token = scene.tokens.find((t) => t.actor?.id === actorId);
      if (!token) continue;
      // #86: correct a follower's own off-grid position (e.g. from a
      // manual, unsnapped drag in Foundry's own UI) before
      // findFollowMove's "already-near" status can skip straight past it
      // without ever calling `update()` at all -- mirrors
      // dungeon-combat.mjs's own `snapTokenToGrid`.
      const snappedX = Math.round(token.x / gridSize) * gridSize;
      const snappedY = Math.round(token.y / gridSize) * gridSize;
      if (token.x !== snappedX || token.y !== snappedY) {
        await token.update({ x: snappedX, y: snappedY });
      }
      const moverFootprint = footprint(token, gridSize);
      const fromCell = tokenCell(token, gridSize);
      // #140: exclude the follower's own current footprint from the
      // occupancy list before searching for its own move -- otherwise a
      // 2x2+ follower's own body can make a leader-adjacent candidate
      // look "occupied" by itself, unlike dungeon-combat.mjs's own
      // hostileFootprints/otherCombatantFootprints, which both already
      // exclude the mover itself (c.id !== combatant.id). Restored below
      // if the follower doesn't actually move, so later followers in
      // this same loop still see it correctly occupying its own cell.
      const myIndex = occupied.findIndex(
        (f) =>
          f.gx === fromCell.gx &&
          f.gy === fromCell.gy &&
          f.gw === moverFootprint.gw &&
          f.gh === moverFootprint.gh,
      );
      const myFootprint =
        myIndex !== -1 ? occupied.splice(myIndex, 1)[0] : null;
      const result = findFollowMove(
        fromCell,
        leaderCell,
        occupied,
        isBlocked,
        bounds,
        moverFootprint,
      );
      if (result.status === "already-near" || result.status === "no-route") {
        if (myFootprint) occupied.push(myFootprint);
        if (result.status === "no-route") {
          console.warn(
            `${MODULE_ID} | dungeon-follow: no route for actor ${actorId} to reach the leader.`,
          );
        }
        continue;
      }
      occupied.push({
        gx: result.to.gx,
        gy: result.to.gy,
        gw: moverFootprint.gw,
        gh: moverFootprint.gh,
      });
      await token.update({
        x: result.to.gx * gridSize,
        y: result.to.gy * gridSize,
      });
    }
  } finally {
    inFlightScenes.delete(scene.id);
  }
}

/** Debounces a `moveFollowersToward` call for `scene`, same as a leader
 * token move — shared by both `followLeaderIfDue` and
 * `followLeaderOnDoorOpened` so a leader move and a door opening right
 * after it collapse into a single recompute. */
function scheduleFollowMove(scene, leaderToken, aiControlledIds) {
  clearTimeout(pendingByScene.get(scene.id));
  pendingByScene.set(
    scene.id,
    setTimeout(
      () =>
        moveFollowersToward(scene, leaderToken, aiControlledIds).catch((err) =>
          console.warn(
            `${MODULE_ID} | dungeon-follow: error moving followers`,
            err,
          ),
        ),
      FOLLOW_DEBOUNCE_MS,
    ),
  );
}

/**
 * Runs a follow-move computation for `sceneId` alone, resolving the scene/
 * run/leader itself — the one entry point dungeon-remote.mjs's relayed
 * `followMove` action calls on whichever client actually receives and
 * executes the request (always genuinely GM-privileged by the time it gets
 * here, per registerDungeonActionSocket's own game.user.isGM guard). #65:
 * a non-GM host's own followLeaderIfDue/followLeaderOnDoorOpened can't run
 * the move themselves, so they request it here instead of silently doing
 * nothing.
 */
export function runFollowMoveNow(sceneId) {
  const scene = game.scenes.get(sceneId);
  if (!scene) return;
  const run = getRunState(sceneId);
  const aiControlledIds = run?.aiControlledActorIds ?? [];
  if (!aiControlledIds.length) return;
  const leaderToken = resolveLeaderToken(scene, run.hostUserId);
  if (!leaderToken) return;
  scheduleFollowMove(scene, leaderToken, aiControlledIds);
}

/** Whether `changes` (an `updateToken` hook payload) represents an actual
 * position-changing update, on either of two payload shapes:
 * - pre-v14 (and still possible on v14): top-level `changes.x`/`changes.y`.
 * - v14's newer ruler/pathfinding-driven movement pipeline (#87, reopened
 *   after #100): confirmed live on a v14.368 world that a moved token's
 *   `_movement` carries `origin`/`destination`/`waypoints`/`method` (e.g.
 *   `_movement.method: "keyboard"` with full waypoint data). Foundry's own
 *   docs show `TokenDocument#move()` is otherwise equivalent to `update()`
 *   with top-level x/y, so `_movement` is believed to be *additive*
 *   alongside x/y rather than a replacement for it — but that couldn't be
 *   confirmed against a live v14 world (relay access ended before a real
 *   payload could be captured, see #87), so this checks for `_movement`'s
 *   presence too rather than betting entirely on x/y still being there.
 *   This function doesn't need to read a position out of `_movement`
 *   itself: `moveFollowersToward` always re-reads the leader token's live
 *   `x`/`y` off the scene at the time it actually runs (debounced by
 *   FOLLOW_DEBOUNCE_MS), so it's correct however many separate
 *   `updateToken` calls a single leader move ends up split across, as long
 *   as at least one of them is recognized here as "a move happened" and
 *   re-arms the debounce. */
function isPositionChange(changes) {
  if (changes.x !== undefined || changes.y !== undefined) return true;
  return changes._movement !== undefined;
}

/** Hook target for `updateToken` (module.mjs). Debounced per scene so a
 * drag's many intermediate position updates trigger at most one recompute
 * every FOLLOW_DEBOUNCE_MS. Runs the move directly on a GM-privileged
 * client; a non-GM client that's the run's own host requests it via the
 * relay instead (#65) — any other connected client does nothing, same as
 * before. */
export function followLeaderIfDue(tokenDoc, changes) {
  if (!isPositionChange(changes)) return;
  const scene = tokenDoc.parent;
  if (!scene) return;
  if (hasActiveCombat(scene)) return;

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

  if (game.user.isGM) {
    scheduleFollowMove(scene, leaderToken, aiControlledIds);
    return;
  }
  if (game.user.id === run.hostUserId) {
    requestDungeonAction("followMove", { sceneId: scene.id });
  }
}

/** Hook target for `updateWall` (module.mjs), alongside
 * `handleDungeonDoorOpened`. #39: a follower that found "no route"
 * (dungeon-follow-mechanics.mjs) because the connecting door was still
 * closed at the time the leader moved is never retried by
 * `followLeaderIfDue` alone — that only reacts to the leader's own token
 * moving, not to the door opening afterward. Retrying here whenever any
 * door opens is what actually resolves that stranding, via the same
 * eligibility checks and debounce as a leader move. Same GM-direct vs.
 * host-relay split as `followLeaderIfDue` (#65). */
export function followLeaderOnDoorOpened(wallDoc, changes) {
  if (changes.ds !== CONST.WALL_DOOR_STATES.OPEN) return;
  const scene = wallDoc.parent;
  if (!scene) return;
  if (hasActiveCombat(scene)) return;

  const run = getRunState(scene.id);
  const aiControlledIds = run?.aiControlledActorIds ?? [];
  if (!aiControlledIds.length) return;

  const leaderToken = resolveLeaderToken(scene, run.hostUserId);
  if (!leaderToken) return;

  if (game.user.isGM) {
    scheduleFollowMove(scene, leaderToken, aiControlledIds);
    return;
  }
  if (game.user.id === run.hostUserId) {
    requestDungeonAction("followMove", { sceneId: scene.id });
  }
}

/** Snaps `tokenId` on `sceneId` back to the grid if it's currently off-grid
 * — the actual correction `dungeon-remote.mjs`'s relayed `resnapToken`
 * action runs on whichever client executes it (always genuinely
 * GM-privileged by the time it gets here, same as `runFollowMoveNow`).
 * Re-reads the token's current position fresh from the scene rather than
 * trusting caller-supplied coordinates, since a non-GM host's own request
 * only carries the ids that triggered it, not a position it's entitled to
 * dictate. A no-op if the scene/token can't be found or is already
 * grid-aligned. */
export async function resnapTokenNow(sceneId, tokenId) {
  const scene = game.scenes.get(sceneId);
  const token = scene?.tokens.find((t) => t.id === tokenId);
  if (!token) return;
  const gridSize = scene.grid?.size ?? 100;
  const snappedX = Math.round(token.x / gridSize) * gridSize;
  const snappedY = Math.round(token.y / gridSize) * gridSize;
  if (token.x !== snappedX || token.y !== snappedY) {
    await token.update({ x: snappedX, y: snappedY });
  }
}

/** Hook target for `updateToken` (module.mjs), registered alongside
 * `followLeaderIfDue` — a separate concern on the same hook. Self-heals
 * ANY token that lands off-grid after a position-changing update, on any
 * scene this module manages, not just the leader or AI-controlled
 * followers (#141: Foundry's own drag-animation pipeline can nudge an
 * unrelated token to a non-grid-aligned position as a side effect of
 * dragging a different token — confirmed live against a real v14.368
 * world; this module's own write paths are already grid-exact by
 * construction throughout, so the drift is never this module's own doing).
 * Closes the same gap for combat-time monster drift (#86, #140) that
 * `moveFollowersToward`'s own snap-correction already closes for
 * followers mid-follow-move — deliberately NOT gated on `hasActiveCombat`
 * like `followLeaderIfDue` is, since a non-acting combatant drifting
 * during someone else's turn is exactly the scenario #86/#140 describe.
 * Safe to run unconditionally during combat because every position this
 * module's own combat code writes (`dungeon-combat.mjs`'s
 * `snapTokenToGrid`/`waypoint.gx * gridSize` throughout) is already
 * grid-exact by construction, so a real combat step is never mistaken
 * for drift. Same GM-direct vs. host-relay split as `followLeaderIfDue`
 * (#65). Self-limiting: the correction write is itself a real
 * `updateToken` event, but it's already grid-aligned, so this no-ops on
 * it — no separate debounce or reentrancy guard needed.
 *
 * Known limitation (tracked as a follow-up, not fixed here): this snaps
 * to the *nearest* grid cell, which isn't necessarily the cell this
 * module originally intended — a drifted token could round to a cell
 * across a wall, or one already occupied. `snapTokenToGrid` shares this
 * same limitation; this hook just applies it more broadly. `getRunState`
 * also keeps returning a completed (not just active) run's data until
 * `abandonRun` clears it, so this stays live on a finished run's scene
 * too — harmless (still the same square-grid dungeon scene) but worth
 * knowing. A GM's own deliberate off-grid placement on a managed scene
 * gets snapped back too; there's no way to distinguish that from drift. */
export function resnapDriftedTokens(tokenDoc, changes) {
  if (!isPositionChange(changes)) return;
  const scene = tokenDoc.parent;
  if (!scene) return;
  const run = getRunState(scene.id);
  if (!run) return;
  const gridSize = scene.grid?.size ?? 100;
  const snappedX = Math.round(tokenDoc.x / gridSize) * gridSize;
  const snappedY = Math.round(tokenDoc.y / gridSize) * gridSize;
  if (tokenDoc.x === snappedX && tokenDoc.y === snappedY) return;

  if (game.user.isGM) {
    return resnapTokenNow(scene.id, tokenDoc.id);
  }
  if (game.user.id === run.hostUserId) {
    requestDungeonAction("resnapToken", {
      sceneId: scene.id,
      tokenId: tokenDoc.id,
    });
  }
}
