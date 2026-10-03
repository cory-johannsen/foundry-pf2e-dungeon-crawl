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
import { getRunState, effectiveMarchingOrder } from "./dungeon-runner.mjs";
import { requestDungeonAction } from "./dungeon-remote.mjs";
import { blockedEdgesFromWalls } from "./pathfinding.mjs";
import { footprint } from "./placement.mjs";
import { walkTokenThroughSteps } from "./token-walk.mjs";
import {
  findFollowMove,
  extendTrail,
  findTrailMove,
  tokenCell,
  sceneBounds,
  chooseResnapCell,
} from "./dungeon-follow-mechanics.mjs";

const MODULE_ID = "pf2e-dungeon-crawl";
const FOLLOW_DEBOUNCE_MS = 250;
// #361 revert of #141's own fix: passing {animation:{duration:0}} here
// correctly stopped the interrupted-animation drift #141 diagnosed, but
// live-confirmed (this same session, right after #141/#359 both deployed)
// it also reliably triggers a genuine Foundry v14 core bug -- every real
// leader move started throwing `TypeError: can't redefine non-configurable
// property "<id>"` from Foundry's own #preUpdateMovement, aborting
// moveFollowersToward before it could move ANY follower at all. Could not
// reproduce the crash via isolated scripted token.update() calls (same
// option, same tokens) -- it appears to specifically require Foundry's own
// richer keyboard/ruler-driven movement pathway a real player move engages,
// which a raw scripted update doesn't. A hard crash that stops every
// follower, every time, is strictly worse than #141's own occasional
// off-grid drift -- reverted to Foundry's default animated update
// everywhere this constant was used, pending a fix that doesn't trigger
// the Foundry-core bug (see #361).

// #87 (2026-10-01, round 3 -- the real fix): every position read in this
// file that feeds a drift/off-grid DECISION must come from the token's
// own committed `_source`, never the top-level `token.x`/`token.y`.
// Independently confirmed live against a real v14.368 world (both by
// reading Foundry's own client source, TokenDocument's #animateFrame/
// #completeAnimation in client/canvas/placeables/token.mjs, and by
// querying a live token's own `_source` directly): Foundry's animation
// pipeline overwrites `token.x`/`token.y` every rendered frame with the
// client-side interpolated position while a slide is in progress --
// `token._source.x`/`token._source.y` is the sealed, server-committed
// value animation never touches. Two earlier fix rounds this same session
// (polling `token.object.animationContexts`, then requiring a
// stable-across-two-polls reading) were both built on the wrong premise
// -- that waiting long enough would make `token.x`/`token.y` trustworthy
// -- and both still let drift-correction read/write a client-only
// interpolated position in at least one case (round 1's own cap-expiry
// path and the no-animation-check fast path; round 2's own fast path and
// the `stopAnimation({reset:false})` case, where contexts empty out but
// `token.x`/`token.y` stays frozen at a non-final value indefinitely, not
// just briefly). Reading `_source` instead sidesteps the whole "is it
// currently animating" question -- it's correct unconditionally,
// regardless of whatever the animation is visually doing, so neither
// `resnapTokenNow` nor the inline snap below needs to poll, wait, or
// check animation state as a correctness condition at all anymore.
function sourcePosition(token) {
  return {
    x: token._source?.x ?? token.x,
    y: token._source?.y ?? token.y,
  };
}

const resnapInFlight = new Set(); // tokenIds with a correction already pending

// #87 (2026-10-01, round 5 -- the robust fix): live-confirmed that even
// `_source` isn't a safe read at every possible moment. A fresh live
// capture caught `resnapDriftedTokens` firing via Foundry's own incoming
// socket handler (`#handleUpdateDocuments`) ~40ms after this module's own
// `moveFollowersToward` had already CALLED `token.update()` for a
// legitimate move -- and at that exact instant, `tokenDoc._source` itself
// still read an off-grid value that rounded back to the follower's
// STARTING cell, not its real destination. Controlled live experiments
// (polling a token's own `_source` during a real animated move) couldn't
// pin down a precise, reliably-reproducible window where `_source` lags a
// just-called `update()` -- browser background-tab timer throttling made
// fine-grained polling itself unreliable -- but the live production
// capture is unambiguous: `_source` is NOT guaranteed to reflect this
// module's own just-issued write at every point in Foundry's own
// multi-phase update/socket-confirmation lifecycle, however it happens.
//
// Rounds 1-4 each tried a different way to decide WHEN a position read is
// trustworthy (animationContexts, two-poll stability, `_source`) and each
// still left a live-reproducible gap. This round stops trying to answer
// that question at all: `resnapDriftedTokens` now trusts this module's
// own recent writes unconditionally and skips reacting to them entirely,
// rather than reading ANY position value (`x`/`y` OR `_source`) during a
// short window after this module itself touched that token. This can
// only ever matter for genuine drift from OUTSIDE this module's own
// control (a manual unsnapped drag, Foundry's own internal nudging) --
// exactly #141's original, narrower intent for this self-heal hook in
// the first place.
const RECENT_WRITE_SUPPRESS_MS = 1000; // generous above any realistic animation + socket round-trip
const recentlyWrittenByUs = new Map(); // tokenId -> Date.now() of our own last write

// #87 (2026-10-01, round 7 -- the actual root cause): round 6 shipped and
// the symptom reproduced AGAIN. Live-caught this time with the frozen
// evidence still sitting in the world: two followers permanently resting
// at genuinely off-grid, QUARTER-CELL-offset `_source` positions (e.g.
// x=30424/y=549 against a 100px grid) right next to a door's wall corner
// -- no animation in progress, unchanged across repeated reads seconds
// apart, so not a timing/read-staleness artifact of any kind. Confirmed
// by reading Foundry v14's own client source
// (client/documents/token.mjs's TokenDocument#move/#_regulateMovement,
// client/placeables/token.mjs's Token#constrainMovementPath/
// #getCollisionWaypoint): a plain `TokenDocument#update({x, y})` is
// internally converted into a waypoint-based move through Foundry's own
// movement/pathing pipeline, which runs a WALL-COLLISION CHECK on the
// straight-line path from the token's current position to the requested
// destination whenever the token is rendered -- regardless of whether the
// caller is a human dragging/pathfinding or a script calling `update()`
// directly. If that straight-line path clips a wall (exactly what
// happens when a follower's path passes close to a door frame corner),
// Foundry silently overrides the destination with a "collision waypoint"
// snapped to quarter-cell granularity, not our requested exact grid
// cell -- and that overridden value is what actually gets committed to
// `_source`. None of rounds 1-6 could ever have caught this: every one of
// them assumed the bug was about reading a position at the wrong TIME:
// this is Foundry's own write path silently substituting a DIFFERENT,
// non-grid-exact destination for the one this module asked for.
//
// This module already does its own wall-aware pathfinding
// (`movementBlockedEdges`/`findFollowMove`) before ever calling
// `update()` -- a follower is never asked to move anywhere its own path
// doesn't already clear. Foundry's additional wall-collision check on the
// write itself is therefore redundant for every `token.update()` call
// this module makes, and is the actual mechanism silently relocating
// followers to the wrong cell. Foundry exposes `{ teleport: true }` as an
// update option for exactly this -- a deprecated-but-fully-functional
// (since v13, removal "until: 15") compatibility shim that maps to the
// `displace` movement action, which has `walls: null` (no collision
// check at all). Passed on every `token.update({x, y}, ...)` call this
// module makes (the inline #86 snap, the real move write, and
// `resnapTokenNow`'s own correction) so none of them can ever again be
// silently redirected by a wall collision mid-write.

function markRecentlyWritten(tokenId) {
  recentlyWrittenByUs.set(tokenId, Date.now());
}

/** Test-only: clears this module's own real-wall-clock write-tracking
 * state between tests. This file's own tests reuse token ids extensively
 * across otherwise-unrelated `it()` blocks (e.g. "t-drifted"), and
 * `recentlyWrittenByUs` uses genuine `Date.now()`, not vi's fake timers,
 * so a correction in one test can otherwise leak into and suppress a
 * later, unrelated test reusing the same id. Not imported by any
 * production code path. */
export function __clearRecentWritesForTests() {
  recentlyWrittenByUs.clear();
}

function wasRecentlyWrittenByUs(tokenId) {
  const writtenAt = recentlyWrittenByUs.get(tokenId);
  return writtenAt !== undefined && Date.now() - writtenAt < RECENT_WRITE_SUPPRESS_MS;
}

const pendingByScene = new Map(); // sceneId -> setTimeout handle

// #610: sceneId -> the leader's recent route, newest-first (see
// extendTrail). Lives on the GM client, the only one that moves followers.
const leaderTrails = new Map();
const TRAIL_EXTRA_CELLS = 3;

export function __clearLeaderTrailsForTests() {
  leaderTrails.clear();
}
export function __getLeaderTrailForTests(sceneId) {
  return leaderTrails.get(sceneId);
}

function recordLeaderMove(scene, leaderToken, followerCount) {
  const gridSize = scene.grid?.size ?? 100;
  const cell = tokenCell(sourcePosition(leaderToken), gridSize);
  leaderTrails.set(
    scene.id,
    extendTrail(
      leaderTrails.get(scene.id) ?? [],
      cell,
      movementBlockedEdges(scene, gridSize),
      sceneBounds(scene, gridSize),
      followerCount + TRAIL_EXTRA_CELLS,
    ),
  );
}
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
    // #87 (round 3): leaderCell/occupied both feed pathing DECISIONS, so
    // both read each token's own committed `_source` position, not its
    // possibly mid-animation `x`/`y` -- see sourcePosition's own doc
    // comment above.
    const leaderCell = tokenCell(sourcePosition(leaderToken), gridSize);
    // #365: loot-type tokens (corpses/piles) are `passable` -- they don't
    // block follower pathing, though destinations still avoid them.
    const occupied = scene.tokens.map((t) => ({
      ...footprint(
        { ...sourcePosition(t), width: t.width, height: t.height },
        gridSize,
      ),
      ...(t.actor?.type === "loot" ? { passable: true } : {}),
    }));

    // #181: chain-following — the first follower in marching order
    // targets the leader, exactly as before; every follower after it
    // targets whoever is immediately ahead of it in the order, using that
    // predecessor's CURRENT cell (updated below after each iteration) —
    // not the leader directly. This is what actually lets followers queue
    // single-file through a corridor too narrow for more than one of them
    // to be "near the leader" at once, instead of every follower
    // independently failing to path past whoever's already closest.
    //
    // #365: findFollowMove's path is occupancy-aware (non-loot tokens
    // block it), so a follower can no longer cut through another token --
    // including the leader's -- e.g. after a mid-corridor marching-order
    // reorder. Fixed; this used to be a known limitation of #181.
    let referenceCell = leaderCell;
    // #610: use the trail only while it still starts at the leader's real
    // cell (a door-open retry may run with a stale one).
    const storedTrail = leaderTrails.get(scene.id) ?? [];
    const trail =
      storedTrail[0] &&
      storedTrail[0].gx === leaderCell.gx &&
      storedTrail[0].gy === leaderCell.gy
        ? storedTrail
        : [];
    let slot = 0;
    for (const actorId of aiControlledIds) {
      const token = scene.tokens.find((t) => t.actor?.id === actorId);
      if (!token) continue;
      slot += 1;
      // #86: correct a follower's own off-grid position (e.g. from a
      // manual, unsnapped drag in Foundry's own UI) before
      // findFollowMove's "already-near" status can skip straight past it
      // without ever calling `update()` at all -- mirrors
      // dungeon-combat.mjs's own `snapTokenToGrid`.
      //
      // #87 (2026-10-01, round 3): reads the follower's own committed
      // `_source` position, never `token.x`/`token.y` -- see
      // sourcePosition's own doc comment above. This needs no animation
      // check at all: `_source` already reflects wherever this follower's
      // own most recent legitimate move committed to, regardless of
      // whether that move's slide is still visually playing out, so this
      // can never read/write a transient, in-flight value. A prior round
      // of this same fix skipped this snap entirely while `isAnimating`
      // was true -- unnecessary now, and itself relied on animation
      // timing this module has no reliable way to observe from outside
      // Foundry's own rendering pipeline.
      const followerSource = sourcePosition(token);
      const snappedX = Math.round(followerSource.x / gridSize) * gridSize;
      const snappedY = Math.round(followerSource.y / gridSize) * gridSize;
      if (followerSource.x !== snappedX || followerSource.y !== snappedY) {
        markRecentlyWritten(token.id);
        await token.update({ x: snappedX, y: snappedY }, { teleport: true });
        // #87 (round 6): re-mark after the await resolves too, not just
        // before -- the suppression window should cover however long the
        // round-trip to the server and back actually takes, not just the
        // time between issuing the write and it being accepted locally.
        markRecentlyWritten(token.id);
      }
      const moverFootprint = footprint(
        { ...sourcePosition(token), width: token.width, height: token.height },
        gridSize,
      );
      const fromCell = tokenCell(sourcePosition(token), gridSize);
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
      const trailResult = findTrailMove(
        fromCell,
        trail[slot] ?? null,
        occupied,
        isBlocked,
        bounds,
        moverFootprint,
      );
      const result =
        trailResult ??
        findFollowMove(
          fromCell,
          referenceCell,
          occupied,
          isBlocked,
          bounds,
          moverFootprint,
        );
      if (result.status === "already-near" || result.status === "no-route") {
        if (myFootprint) occupied.push(myFootprint);
        if (result.status === "no-route") {
          console.warn(
            `${MODULE_ID} | dungeon-follow: no route for actor ${actorId} to reach its marching-order target.`,
          );
        }
        // #181: this follower didn't move — the next one in the chain
        // still targets wherever it currently is.
        referenceCell = fromCell;
        // #610: a follower staying put on a farther trail cell than its
        // slot (near a corner) must not let the next follower aim between
        // it and the leader -- that would walk past it and invert order.
        if (trailResult?.status === "already-near") {
          const k = trail.findIndex(
            (c) => c.gx === fromCell.gx && c.gy === fromCell.gy,
          );
          if (k > slot) slot = k;
        }
        continue;
      }
      occupied.push({
        gx: result.to.gx,
        gy: result.to.gy,
        gw: moverFootprint.gw,
        gh: moverFootprint.gh,
      });
      // #610: walk the path one cell at a time (each hop still
      // { teleport: true }, #87/#141/#361), re-marking the #87 suppression
      // window around every hop's write.
      await walkTokenThroughSteps(token, result.steps, gridSize, () =>
        markRecentlyWritten(token.id),
      );
      referenceCell = result.to;
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
  const aiControlledIds = effectiveMarchingOrder(run);
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
 *   itself: `moveFollowersToward` always re-reads the leader token's own
 *   committed `_source` position off the scene at the time it actually
 *   runs (debounced by FOLLOW_DEBOUNCE_MS), so it's correct however many
 *   separate
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
  if (hasActiveCombat(scene)) {
    // #610: a trail must not span a fight; the next leader move rebuilds it.
    leaderTrails.delete(scene.id);
    return;
  }

  const run = getRunState(scene.id);
  const aiControlledIds = effectiveMarchingOrder(run);
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
    recordLeaderMove(scene, leaderToken, aiControlledIds.length);
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
  const aiControlledIds = effectiveMarchingOrder(run);
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
 * grid-aligned.
 *
 * #87 (2026-10-01, round 3): reads `token._source`, not `token.x`/
 * `token.y` -- see `sourcePosition`'s own doc comment above. This needs
 * no animation-state check, polling, or deadline at all anymore: two
 * earlier rounds this same session tried to infer "has the animation
 * really finished" from `token.object.animationContexts` (first "is it
 * currently empty", then "has it stayed empty and unchanged across two
 * polls") and both still had a live-confirmed gap, because neither
 * question is actually what this function needs answered -- `_source` IS
 * the answer, directly, regardless of what the animation is doing. */
export async function resnapTokenNow(sceneId, tokenId) {
  // A second call for a token that already has a correction pending must
  // not race a parallel write -- the live capture that originally found
  // this gap showed 6+ overlapping resnap attempts for the same token
  // within ~150ms (both the GM-direct and relayed paths reacting
  // independently).
  if (resnapInFlight.has(tokenId)) return;
  // #87 (2026-10-01, round 5): the relayed path (dungeon-remote.mjs's
  // `resnapToken` action) calls this function directly, bypassing
  // `resnapDriftedTokens`'s own suppression check -- a non-GM host's own
  // client has no way to know this GM-privileged client just wrote to
  // this token (that bookkeeping only exists in moveFollowersToward's
  // own local memory, which only runs here), so re-check it on this
  // side too, the one place both the direct and relayed paths converge.
  if (wasRecentlyWrittenByUs(tokenId)) return;
  resnapInFlight.add(tokenId);
  try {
    const scene = game.scenes.get(sceneId);
    const token = scene?.tokens.find((t) => t.id === tokenId);
    if (!token) return;
    const gridSize = scene.grid?.size ?? 100;
    const { x, y } = sourcePosition(token);
    if (x % gridSize !== 0 || y % gridSize !== 0) {
      // #150: validate the rounded cell (occupancy, walls, footprint)
      // instead of trusting it blindly; the token's own footprint is
      // excluded from `occupied` so it can't block its own correction.
      const fp = footprint({ x, y, width: token.width, height: token.height }, gridSize);
      const occupied = scene.tokens
        .filter((t) => t.id !== tokenId)
        .map((t) =>
          footprint({ ...sourcePosition(t), width: t.width, height: t.height }, gridSize),
        );
      const cell = chooseResnapCell({
        x,
        y,
        gridSize,
        gw: fp.gw,
        gh: fp.gh,
        occupied,
        isBlocked: movementBlockedEdges(scene, gridSize),
      });
      if (!cell.valid) {
        console.warn(
          `${MODULE_ID} | dungeon-follow: resnapTokenNow found no free valid cell near token ${tokenId}; using nearest-cell rounding`,
        );
      }
      const snappedX = cell.gx * gridSize;
      const snappedY = cell.gy * gridSize;
      markRecentlyWritten(tokenId);
      await token.update({ x: snappedX, y: snappedY }, { teleport: true });
      // #87 (round 6): re-mark after the await resolves too -- see the
      // inline #86 snap's own comment in moveFollowersToward for why.
      markRecentlyWritten(tokenId);
    }
  } finally {
    resnapInFlight.delete(tokenId);
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
 * (#65). The correction write is itself a real `updateToken` event, but
 * it's already grid-aligned by the time it lands, so it doesn't
 * re-trigger this function's own correction logic. This hook's own
 * `tokenDoc.x`/`tokenDoc.y` read is only ever used as a cheap "should I
 * even bother calling resnapTokenNow" gate -- `resnapTokenNow` itself
 * (#87, 2026-10-01, round 3) always re-reads the token's own `_source`
 * fresh regardless of what triggered it, so a stale/interpolated reading
 * here can at worst cause one skipped or one unnecessary call, never a
 * wrong correction. Needs its own reentrancy guard (`resnapInFlight`,
 * live-confirmed 2026-09-30: 6+ overlapping resnap attempts for the same
 * token within ~150ms, both the GM-direct and relayed paths reacting
 * independently) -- a prior version of this comment claimed no guard was
 * necessary; live evidence disproved that.
 *
 * #150: the correction (`resnapTokenNow`) validates the rounded cell
 * against occupancy/walls/footprint and ring-searches for a valid one
 * (`chooseResnapCell`), falling back to plain rounding if none exists.
 * Combat's `snapTokenToGrid` still uses plain nearest-cell rounding. `getRunState`
 * also keeps returning a completed (not just active) run's data until
 * `abandonRun` clears it, so this stays live on a finished run's scene
 * too — harmless (still the same square-grid dungeon scene) but worth
 * knowing. A GM's own deliberate off-grid placement on a managed scene
 * gets snapped back too; there's no way to distinguish that from drift.
 *
 * #87 (2026-10-01, round 6): accepts Foundry's own 4th `updateToken` hook
 * argument, `userId` (the id of whoever's client issued the write that
 * triggered this call) -- unused by any correctness decision here, only
 * logged, alongside `changes`, whenever a correction actually proceeds.
 * Round 5's suppression window stops this module from reacting to its
 * OWN writes, but doesn't explain who/what commits a genuinely off-grid
 * position in the first place when it isn't suppressed -- if that still
 * happens live, this log line is what turns the next investigation into
 * reading a console line instead of another round of guessing. */
export function resnapDriftedTokens(tokenDoc, changes, _options, userId) {
  if (!isPositionChange(changes)) return;
  const scene = tokenDoc.parent;
  if (!scene) return;
  const run = getRunState(scene.id);
  if (!run) return;
  // #87 (2026-10-01, round 5 -- the robust fix): if this module itself
  // wrote this token's position within the last RECENT_WRITE_SUPPRESS_MS,
  // trust that write unconditionally and skip entirely -- don't read
  // ANY position field (`x`/`y` OR `_source`) to decide whether a
  // correction is needed at all. Live-confirmed that even `_source`
  // isn't reliably readable at every point in Foundry's own multi-phase
  // update/socket-confirmation lifecycle (see RECENT_WRITE_SUPPRESS_MS's
  // own doc comment above for the live evidence) -- the only way to stop
  // guessing which read is safe is to not read anything at all for a
  // token we know we just touched ourselves.
  if (wasRecentlyWrittenByUs(tokenDoc.id)) return;
  const gridSize = scene.grid?.size ?? 100;
  const { x, y } = sourcePosition(tokenDoc);
  const snappedX = Math.round(x / gridSize) * gridSize;
  const snappedY = Math.round(y / gridSize) * gridSize;
  if (x === snappedX && y === snappedY) return;

  console.warn(
    `${MODULE_ID} | dungeon-follow: resnapDriftedTokens correcting token ${tokenDoc.id} (source ${x},${y} -> ${snappedX},${snappedY}), writer userId=${userId}`,
    changes,
  );

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
