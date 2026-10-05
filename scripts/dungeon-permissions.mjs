/**
 * Decision logic for the GM-less dungeon crawl (#109, agent-relay design) —
 * see docs/superpowers/specs/2026-09-20-gm-less-dungeon-crawl-agent-relay-design.md.
 * Every mutating action still only ever runs on a genuinely GM-privileged
 * client (a human GM, or a client logged in as the world's "Agent" GM
 * account); this file decides two separate things: whether THIS client's
 * own DungeonApp should render interactive vs. read-only, and whether a
 * routed request from another client should be honored.
 *
 * Refs are injectable so this is testable without a live Foundry — same
 * pattern as draw-target.mjs's canvasRef/userRef.
 */
function resolveUser(userRef) {
  return userRef ?? (typeof game !== "undefined" ? game.user : null);
}

/** Whether THIS client's own window should be interactive: a GM always is;
 * otherwise only the run's own tracked host. */
export function canActOnDungeon(run, { userRef = null } = {}) {
  const user = resolveUser(userRef);
  return !!user?.isGM || (!!run?.hostUserId && run.hostUserId === user?.id);
}

/** What `module.mjs`'s `openDungeon()` should do — a GM always renders; a
 * non-GM may render (starting fresh, or reopening their own already-hosted
 * run) unless a *different* player already hosts the one active run. */
export function decideOpenDungeon(hostedRun, { userRef = null } = {}) {
  const user = resolveUser(userRef);
  if (user?.isGM) return { action: "render" };
  if (hostedRun && hostedRun.hostUserId !== user?.id) {
    return { action: "warnAlreadyHosted", hostUserId: hostedRun.hostUserId };
  }
  return { action: "render" };
}

/**
 * What a non-GM client should do with its own local `DungeonApp` instance
 * whenever the `dungeonRuns` setting changes or the canvas settles — open a
 * fresh copy, re-render an existing one, close one whose run just ended, or
 * nothing. This now also drives the HOST's own client: since a non-GM host
 * no longer writes locally (it routes a request and waits), it has no
 * synchronously-fresh data to render from the moment its own request
 * resolves — the broadcast is what actually delivers the update, same as
 * for a read-only viewer. Never touches a GM's own window (never
 * auto-opened; a GM interacts directly and already has fresh data after
 * its own calls).
 */
export function decideGmLessBroadcast(
  hostedRun,
  hasOpenInstance,
  { userRef = null } = {},
) {
  const user = resolveUser(userRef);
  if (user?.isGM) return { action: "none" };
  if (hostedRun) return { action: hasOpenInstance ? "render" : "open" };
  return { action: hasOpenInstance ? "close" : "none" };
}

/**
 * Whether the GM-side relay handler (dungeon-remote.mjs) should honor a
 * routed request from `requestingUserId` — the actual authorization
 * boundary for the whole feature, since the handler itself only checks
 * `game.user.isGM` (am I allowed to act at all), not who asked. For every
 * action except starting a fresh run, the requester must be the run's own
 * tracked host. Starting a run instead just checks there's no *other*
 * active host already — `run` here is whatever `findActiveHostedRun()`
 * returned (world-wide, not scene-specific, since the scene doesn't exist
 * yet when this fires).
 */
export function isAuthorizedRequest(
  actionName,
  requestingUserId,
  run,
  { ownsPartyCharacter = false } = {},
) {
  if (!requestingUserId) return false;
  if (actionName === "startRun") {
    return !run || run.hostUserId === requestingUserId;
  }
  if (actionName === "roomFeatureInteract" || actionName === "attemptTrapDisable") {
    // #611/#623 (+ #754 attemptTrapDisable): room-feature prop tokens may be triggered by any non-GM
    // player who owns a party character (relay computes the flag), or the host.
    return (
      !!run &&
      !run.completed &&
      (ownsPartyCharacter ||
        (!!run.hostUserId && run.hostUserId === requestingUserId))
    );
  }
  return !!run?.hostUserId && run.hostUserId === requestingUserId;
}

/** Whether `userId` owns (OWNER level, 3) at least one `character` actor in
 * the party's member list. Pure; the relay supplies the members. */
export function ownsPartyCharacter(userId, partyMembers) {
  return (partyMembers ?? []).some(
    (m) => m?.type === "character" && (m.ownership?.[userId] ?? 0) >= 3,
  );
}

/** Whether the relay should treat `user` ({ id, active, isGM } or null) as
 * a party-character owner for `roomFeatureInteract`: must exist, be active,
 * not be a GM, and own a party character. Pure. */
export function canRelayRoomFeature(user, partyMembers) {
  if (!user || !user.active || user.isGM) return false;
  return ownsPartyCharacter(user.id, partyMembers);
}

/** #754: whether `userId` may roll a trap-disable attempt as `actor`. Like
 * the tracker's other skill checks, any party member may be chosen: the
 * actor must be in `partyMembers`, and the requester must be the GM, the
 * run host, or own at least one party character (so a stranger can't roll).
 * Pure. */
export function userMayAttemptTrapDisable({
  userId,
  isGM = false,
  isHost = false,
  actor,
  partyMembers = [],
} = {}) {
  if (!userId || !actor) return false;
  if (!(partyMembers ?? []).some((m) => m?.id === actor.id)) return false;
  return isGM || isHost || ownsPartyCharacter(userId, partyMembers);
}
