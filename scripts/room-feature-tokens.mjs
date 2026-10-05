/**
 * Interactable room-feature prop tokens (#611/#623): a player-visible,
 * player-targetable scene object for a treasure/puzzle/skill-challenge
 * room, replacing the sidebar-only trigger those rooms used to have.
 * Pure data + a builder — no Foundry documents touched here; dungeon-scene.mjs
 * is the one place that turns this into a real Actor/Token (same pure/glue
 * split cover-items.mjs already uses for its own scene-prop actors).
 */
export const ROOM_FEATURE_TOKEN_TYPES = {
  treasure: { name: "Treasure Chest", img: "icons/svg/chest.svg" },
  puzzle: { name: "Puzzle Mechanism", img: "icons/svg/clockwork.svg" },
  skill_challenge: { name: "Challenge Marker", img: "icons/svg/dice-target.svg" },
};

const MODULE_ID = "pf2e-dungeon-crawl";

/** Full Actor-creation payload for one room-feature prop — a PF2e `loot`
 * actor (needs no HP/combat schema, confirmed live), flagged with its own
 * kind and room id so module.mjs's `targetToken` handler can tell which
 * room/feature was interacted with without any further lookup. */
export function buildRoomFeatureTokenActorData(kind, roomId) {
  const type = ROOM_FEATURE_TOKEN_TYPES[kind];
  if (!type) throw new Error(`Unknown room-feature kind: ${kind}`);
  return {
    name: type.name,
    type: "loot",
    img: type.img,
    prototypeToken: { texture: { src: type.img } },
    flags: {
      [MODULE_ID]: { roomFeatureKind: kind, roomFeatureRoomId: roomId },
    },
  };
}

/**
 * Authoritative guard for a room-feature interaction (#611/#623). Pure.
 * Check order (first failing wins): no-state, unknown-kind, run-completed,
 * missing room (-> room-kind-mismatch), not-current-room,
 * room-kind-mismatch, already-resolved.
 */
export function planRoomFeatureAction({ state, kind, roomId }) {
  if (!state) return { ok: false, reason: "no-state" };
  if (!ROOM_FEATURE_TOKEN_TYPES[kind]) return { ok: false, reason: "unknown-kind" };
  if (state.completed) return { ok: false, reason: "run-completed" };
  const room = state.rooms?.[roomId];
  if (!room) return { ok: false, reason: "room-kind-mismatch" };
  if (roomId !== state.currentRoomId) return { ok: false, reason: "not-current-room" };
  if (room.kind !== kind) return { ok: false, reason: "room-kind-mismatch" };
  if ((state.history ?? []).some((h) => h.roomId === roomId)) {
    return { ok: false, reason: "already-resolved" };
  }
  return { ok: true, room };
}

const moduleInFlight = new Set();

/**
 * GM-side executor: re-reads state, plans, takes a per-room lock
 * synchronously after the plan check (no await in between, so two
 * simultaneous callers cannot both pass), then acts. All collaborators
 * are injected so this stays Foundry-free.
 */
export async function runRoomFeatureAction(
  { sceneId, roomId, kind },
  {
    // MUST be the real SYNCHRONOUS getRunState: the in-flight lock's
    // correctness relies on there being no await between plan and lock.
    getRunState,
    claimTreasureFor,
    revealRoomFeature,
    inFlight = moduleInFlight,
  },
) {
  const plan = planRoomFeatureAction({ state: getRunState(sceneId), kind, roomId });
  if (!plan.ok) return { ok: false, reason: plan.reason };
  const key = `${sceneId}:${roomId}`;
  if (inFlight.has(key)) return { ok: false, reason: "in-flight" };
  inFlight.add(key);
  try {
    if (kind === "treasure") await claimTreasureFor(sceneId);
    else await revealRoomFeature(sceneId, roomId, kind);
    return { ok: true };
  } finally {
    inFlight.delete(key);
  }
}

/**
 * Pure decision for the `targetToken` hook: null (no-op) or the route to
 * run. Guard order: targeted, user-id, flag, sceneId, state, plan.
 * `flags` is the token's `flags["pf2e-dungeon-crawl"]` (may be undefined).
 */
export function routeTargetTokenEvent({ userId, gameUserId, targeted, flags, sceneId, state }) {
  if (!targeted) return null;
  if (userId !== gameUserId) return null;
  if (!flags?.roomFeatureKind) return null;
  if (!sceneId) return null;
  if (!state) return null;
  const kind = flags.roomFeatureKind;
  const roomId = flags.roomFeatureRoomId;
  if (!planRoomFeatureAction({ state, kind, roomId }).ok) return null;
  return { sceneId, roomId, kind };
}

/**
 * Whether a prop for (roomId, kind) already exists. `flagsList` is an
 * iterable of each scene token's `flags["pf2e-dungeon-crawl"]` object
 * (possibly undefined). Pure; lets a rebuild skip spawning duplicates.
 */
export function hasRoomFeatureToken(flagsList, roomId, kind) {
  for (const f of flagsList ?? []) {
    if (f?.roomFeatureRoomId === roomId && f?.roomFeatureKind === kind) return true;
  }
  return false;
}

/**
 * #611/#623: whether the tracker shows the sidebar claim/reveal controls.
 * The GM always does; a non-GM operator (the run's host) only when the room
 * has no prop token to interact with, so a prop-less room is never a dead end.
 */
export function showRoomFeatureFallback({ interactive, isGM, tokenPresent }) {
  if (!interactive) return false;
  return !!isGM || !tokenPresent;
}
