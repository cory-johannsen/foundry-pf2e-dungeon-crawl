/**
 * The Foundry side of a dungeon run: reads and writes the `dungeonRuns` world
 * setting (keyed by scene id — see module.mjs) and calls into the pure logic
 * in dungeon-deck.mjs. `settingsRef` is injectable, same pattern as
 * draw-target.mjs's canvasRef/userRef, so this is testable against an
 * in-memory stub instead of live `game.settings`.
 *
 * `currentRoomId` names the room the party is physically STANDING IN, not the
 * room most recently judged (#93: `currentIndex` is no longer written or
 * read anywhere — `state.rooms` is a dict keyed by room id for every run
 * started via startDungeonRun). Resolving a room (markRoomOutcome)
 * never moves it — it only decides the outcome effect and, for a hidden-path
 * effect, reveals it (see markRoomOutcome's own docblock). Only the
 * automatic room-entry trigger (advanceToRoom) moves currentRoomId, once the
 * party has actually walked there. #93's eager pregeneration
 * (roomsToEagerlyBuild) builds every room's physical geometry up front, at
 * run start — there is no more per-room physical-slot assignment as the
 * party progresses.
 */
import { getGenerator } from "./generator-registry.mjs";
import {
  initSkillChallengeState,
  applySkillChallengeAttempt,
} from "./skill-challenge-mechanics.mjs";
import { initPuzzleState, applyPuzzleStageAttempt } from "./puzzle-mechanics.mjs";

const MODULE_ID = "pf2e-dungeon-crawl";

function defaultSettingsRef() {
  return {
    get: (...args) => game.settings.get(...args),
    set: (...args) => game.settings.set(...args),
  };
}

function defaultPartyOwnershipRef() {
  if (typeof game === "undefined") {
    // Test environment without game global
    return {
      partyActors: () => [],
      isUserActive: () => false,
      isUserGm: () => false,
    };
  }
  return {
    partyActors: () => game.actors?.party?.members ?? [],
    isUserActive: (userId) => !!game.users?.get(userId)?.active,
    isUserGm: (userId) => !!game.users?.get(userId)?.isGM,
  };
}

/** Party actor ids whose non-GM owner isn't currently connected (#20),
 * computed once at run start. Each Trusted-User player owns exactly one
 * party actor at OWNER level (ownership level 3, same literal
 * foundry-api.mjs's partyLevel() already uses); the GM/Agent account owns
 * everything too but is explicitly excluded. An actor with no non-GM owner
 * at all (misconfigured ownership) is left off the list — it stays
 * human/GM-controlled rather than guessed at. */
function computeAiControlledActorIds(partyOwnershipRef) {
  const result = [];
  for (const actor of partyOwnershipRef.partyActors()) {
    const ownerId = Object.entries(actor.ownership ?? {}).find(
      ([userId, level]) =>
        userId !== "default" &&
        level === 3 &&
        !partyOwnershipRef.isUserGm(userId),
    )?.[0];
    if (ownerId && !partyOwnershipRef.isUserActive(ownerId)) {
      result.push(actor.id);
    }
  }
  return result;
}

async function persist(sceneId, state, settingsRef) {
  const all = settingsRef.get(MODULE_ID, "dungeonRuns") ?? {};
  await settingsRef.set(MODULE_ID, "dungeonRuns", { ...all, [sceneId]: state });
  return state;
}

/** The dungeon run for this scene, or null if none has been started. */
export function getRunState(
  sceneId,
  { settingsRef = defaultSettingsRef() } = {},
) {
  const all = settingsRef.get(MODULE_ID, "dungeonRuns") ?? {};
  return all[sceneId] ?? null;
}

/**
 * Overwrite this scene's whole persisted run state (#93) — used once, by
 * ui/dungeon-app.mjs's startDungeonRun, to replace createRun's legacy
 * array-shaped state with the graph-shaped one (rooms dict, edges,
 * layoutPositionByRoomId, ...) before any room is built.
 */
export async function replaceRunState(
  sceneId,
  state,
  { settingsRef = defaultSettingsRef() } = {},
) {
  return persist(sceneId, state, settingsRef);
}

export async function createRun(
  {
    sceneId,
    roomCount,
    traits = [],
    excludeTraits = [],
    seed = null,
    previousSceneId = null,
    hostUserId = null,
  },
  {
    settingsRef = defaultSettingsRef(),
    partyOwnershipRef = defaultPartyOwnershipRef(),
    puzzleSetpieceIds = [],
    trapSetpieceIds = [],
    narrativeSetpieceIds = [],
    treasureSetpieceIds = [],
  } = {},
) {
  const runSeed =
    seed ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const rooms = getGenerator().buildRoomSequence({
    seed: runSeed,
    roomCount,
    puzzleSetpieceIds,
    trapSetpieceIds,
    narrativeSetpieceIds,
    treasureSetpieceIds,
  });
  // Room 0 is where the party starts — built and occupied at Start, before
  // any resolution happens, so it's the only slot normally assigned up
  // front. The one exception: room 0 is always the safe entry, which has
  // nothing to resolve (no outcomeSlotId — markRoomOutcome never runs for
  // it), so the room right after it also needs its physical slot assigned
  // here rather than waiting on a markRoomOutcome call that will never come.
  const physicalSlotByRoomId = { [rooms[0].id]: 0 };
  let nextPhysicalSlot = 1;
  if (rooms[0].kind === "safe_entry" && rooms[1]) {
    physicalSlotByRoomId[rooms[1].id] = 1;
    nextPhysicalSlot = 2;
  }
  // Build edges dict for graph navigation: each room maps to its children
  const edges = {};
  for (let i = 0; i < rooms.length; i += 1) {
    edges[rooms[i].id] = i + 1 < rooms.length ? [rooms[i + 1].id] : [];
  }
  const state = {
    seed: runSeed,
    createdAt: Date.now(),
    traits,
    excludeTraits,
    rooms,
    currentIndex: 0,
    currentRoomId: rooms[0].id,
    edges,
    completed: false,
    history: [],
    physicalSlotByRoomId,
    nextPhysicalSlot,
    lastAutoEntry: null,
    // The scene the party was viewing right before this run started (ITEM-18)
    // — where to send them back to if the run is later cancelled. Null if
    // they started with no scene active at all.
    previousSceneId,
    // A narrative room's own "direction for the rest of the run" (#163) —
    // free text the GM sets, persisting run-wide (not per-room) once set,
    // the same way the Journey Spread's own Reward/Ruin outcomes already
    // shape what happens next without being tied to any one room's own
    // display. Null until a narrative room sets one.
    objective: null,
    // #109: the non-GM player who started this run when no GM was active —
    // null for a normal GM-run game. The sole authorization signal for a
    // non-GM to act on this run (dungeon-permissions.mjs's
    // canActOnDungeon) and the sole trigger for broadcasting it read-only
    // to every other client (module.mjs's syncGmLessDungeonBroadcast).
    hostUserId,
    // #20: party actor ids whose owning player isn't logged in at run
    // start — see dungeon-combat.mjs (combat turns) and dungeon-follow.mjs
    // (exploration following) for what reads this.
    aiControlledActorIds: computeAiControlledActorIds(partyOwnershipRef),
  };
  return persist(sceneId, state, settingsRef);
}

/**
 * Resolve the CURRENT room (`state.currentRoomId`) as succeeded or failed.
 *
 * Does NOT move currentRoomId — see the file docblock; only advanceToRoom
 * does that, once the party actually walks there. For the goal room this
 * just ends the run. For any other room it resolves the outcome slot and,
 * for a `reduced_travel_time`/`extra_travel_time` effect, reveals whatever
 * hidden shortcut/detour path generation (#93's attachHiddenPaths) already
 * attached to this room — merging it into the live `edges` and dropping it
 * from `hiddenEdges` (see `revealTravelTimeEffect`, dungeon-deck.mjs). Every
 * room in the graph is already built at scene-creation time (#93's eager
 * pregeneration, roomsToEagerlyBuild) — this never builds, removes, or
 * reassigns a room the way the old linear-sequence version of this function
 * used to.
 *
 * Returns `revealedRoomId` (#156) — the target room id whose hidden door
 * just became live, non-null only for a genuine reveal — so the caller
 * (`ui/dungeon-app.mjs`'s `applyRoomEffect`) knows which scene door to
 * unseal, without re-deriving it from `hiddenEdges`, which is already
 * mutated by the time that runs.
 */
export async function markRoomOutcome(
  { sceneId, succeeded },
  {
    settingsRef = defaultSettingsRef(),
    puzzleSetpieceIds = [],
    trapSetpieceIds = [],
    narrativeSetpieceIds = [],
    treasureSetpieceIds = [],
  } = {},
) {
  const state = getRunState(sceneId, { settingsRef });
  if (!state || state.completed) {
    return { state, effectKey: null };
  }

  const room = Array.isArray(state.rooms)
    ? state.rooms.find((r) => r.id === state.currentRoomId)
    : state.rooms[state.currentRoomId];
  // #152 investigation: resolving a room never moves currentIndex (see this
  // file's own docblock) — only actually walking into the next one does, via
  // advanceToRoom. That means the Succeed/Fail/Declare Victory/Declare Defeat
  // button stays live and pointed at the same "current" room for the entire
  // window between resolving it and the party physically opening the next
  // room's reveal door, with no disabling/debounce on those buttons
  // (ui/dungeon-app.mjs's #onSucceed etc.). A double-click (or a slow click
  // registering twice before the first await resolves and re-renders) would
  // resolve the same room's outcome a second time — reapplying its reward/
  // ruin mutation and re-running buildPopulateAndUnlockRoom for whatever
  // comes next a second time (duplicate walls, a second set of monsters).
  // Guarded here, once, at the single place every resolution path funnels
  // through, rather than patching each caller's button individually.
  if (state.history.some((h) => h.roomId === room.id)) {
    return { state, effectKey: null };
  }
  // The entry (see buildRoomSequence) has no outcome slot and nothing to
  // resolve; its own transition happens automatically (createRun/
  // dungeon-app.mjs's Start flow), never through here. Guard rather than
  // crash on findOutcomeTemplate(null) if this is ever somehow reached
  // anyway. A mid-dungeon rest room also has no outcome slot (ITEM-5), but
  // unlike the entry it IS reached through the normal door-reveal flow, so
  // it falls through below instead of returning here — see the `safe_rest`
  // branch just past this guard.
  if (!room.isGoal && room.outcomeSlotId == null && room.kind !== "safe_rest") {
    return { state, effectKey: null };
  }

  const base = {
    roomId: room.id,
    kind: room.kind,
    outcome: succeeded ? "succeeded" : "failed",
    resolvedAt: Date.now(),
  };

  if (room.isGoal) {
    const effectKey = succeeded ? "goal_cleared" : "goal_failed";
    const newState = {
      ...state,
      completed: true,
      history: [...state.history, { ...base, effectKey }],
    };
    await persist(sceneId, newState, settingsRef);
    return { state: newState, effectKey };
  }

  // A rest room has nothing to reward or ruin — just move on to whatever
  // comes after it (ITEM-5), rather than running findOutcomeTemplate/
  // resolveRoomOutcome against its null outcomeSlotId.
  const { effectKey } =
    room.kind === "safe_rest"
      ? { effectKey: "rest_room_passed" }
      : getGenerator().resolveRoomOutcome(getGenerator().findOutcomeTemplate(room.outcomeSlotId), succeeded);

  const { edges, hiddenEdges, revealedRoomId } = getGenerator().revealTravelTimeEffect(
    { edges: state.edges, hiddenEdges: state.hiddenEdges ?? {} },
    room.id,
    effectKey,
  );

  const newState = {
    ...state,
    edges,
    hiddenEdges,
    history: [...state.history, { ...base, effectKey }],
  };
  await persist(sceneId, newState, settingsRef);
  return { state: newState, effectKey, revealedRoomId };
}

/**
 * Advance to a room the party has physically walked into. `revealedTokenIds`
 * is whatever was just un-hidden for the discovery, stashed so undo can
 * re-hide exactly those and nothing else. Rejects (without corrupting state)
 * if `roomId` isn't genuinely the room right after the current one — a stray
 * token, or a GM drag-move past a still-locked wall, shouldn't be able to
 * desync the tracker from reality.
 */
export async function advanceToRoom(
  { sceneId, roomId, revealedTokenIds = [] },
  { settingsRef = defaultSettingsRef() } = {},
) {
  const state = getRunState(sceneId, { settingsRef });
  if (!state) return { ok: false, state: null };
  const children = state.edges[state.currentRoomId] ?? [];
  if (!children.includes(roomId)) return { ok: false, state };

  const newState = {
    ...state,
    currentRoomId: roomId,
    lastAutoEntry: {
      roomId,
      fromRoomId: state.currentRoomId,
      toRoomId: roomId,
      revealedTokenIds,
    },
  };
  await persist(sceneId, newState, settingsRef);
  return { ok: true, state: newState };
}

/**
 * Whether the most recent automatic entry can still be safely undone — false
 * once the entered room has already been judged (Mark Succeeded/Failed),
 * since that may have already cascaded a further door-unlock/build that an
 * undo here would leave dangling.
 */
export function canUndoRoomEntry(state) {
  if (!state?.lastAutoEntry) return false;
  return !state.history.some((h) => h.roomId === state.lastAutoEntry.roomId);
}

/**
 * Every room #93's full-graph pregeneration should build eagerly at run
 * start, as `{room, buildOrder}` pairs in topological order (a room always
 * appears after every one of its parents) — every room except the entry
 * (built separately by startDungeonRun itself). Unconditional: applies to
 * every run, GM-present or GM-less alike (no more hostUserId gate), and no
 * longer special-cases a combat room at generation-order position 1 — the
 * ITEM-11 manual deferral is removed, since per-door lazy building and the
 * Accept/Reroll dialog it paced around are both gone.
 */
export function roomsToEagerlyBuild(state) {
  const { rooms, layoutEdges } = state;
  const order = [];
  const visited = new Set(['room-entry']);
  const indegree = {};
  for (const id of Object.keys(rooms)) indegree[id] = 0;
  for (const children of Object.values(layoutEdges)) {
    for (const childId of children) indegree[childId] += 1;
  }
  const queue = (layoutEdges['room-entry'] ?? []).slice();
  while (queue.length) {
    const id = queue.shift();
    if (visited.has(id)) continue;
    // Only ready once every parent has already been queued/visited — a
    // simple readiness re-check via indegree decrement per visit below.
    visited.add(id);
    order.push(rooms[id]);
    for (const childId of layoutEdges[id] ?? []) {
      indegree[childId] -= 1;
      if (indegree[childId] <= 0 && !visited.has(childId)) queue.push(childId);
    }
  }
  return order.map((room, i) => ({ room, buildOrder: i }));
}

/**
 * What a GM-less-hosted run's already-eagerly-built physical slots need
 * after a Reward/Ruin sequence mutation (#62) — computed by comparing the
 * "natural" slot for each still-unplayed room (physicalSlot === its index
 * into the now-mutated state.rooms, the same invariant roomsToEagerlyBuild
 * used when it originally built everything) against what was actually
 * built there before the mutation. Geometry never needs to change (a pure
 * function of slot number, confirmed in the design doc) — only which
 * logical room's CONTENT occupies a slot does.
 */
export function roomsNeedingResync(
  state,
  previousPhysicalSlotByRoomId,
  mutationBoundaryIndex,
) {
  const previousRoomIdBySlot = {};
  for (const [roomId, slot] of Object.entries(previousPhysicalSlotByRoomId)) {
    previousRoomIdBySlot[slot] = roomId;
  }

  const toRebuild = [];
  const usedSlots = new Set();
  for (let i = mutationBoundaryIndex + 1; i < state.rooms.length; i += 1) {
    const room = state.rooms[i];
    const physicalSlot = i;
    usedSlots.add(physicalSlot);
    const previousRoomId = previousRoomIdBySlot[physicalSlot] ?? null;
    if (previousRoomId !== room.id) {
      toRebuild.push({ room, physicalSlot, previousRoomId });
    }
  }

  const maxPreviousSlot = Object.values(previousPhysicalSlotByRoomId).reduce(
    (max, slot) => Math.max(max, slot),
    -1,
  );
  const toOrphan = [];
  for (
    let slot = mutationBoundaryIndex + 1;
    slot <= maxPreviousSlot;
    slot += 1
  ) {
    if (previousRoomIdBySlot[slot] != null && !usedSlots.has(slot)) {
      toOrphan.push(slot);
    }
  }

  const toExtend = toRebuild
    .filter(({ physicalSlot }) => physicalSlot > maxPreviousSlot)
    .map(({ room, physicalSlot }) => ({ room, physicalSlot }));

  return { toRebuild, toOrphan, toExtend };
}

/**
 * Persists the physical-slot assignments startDungeonRun's eager GM-less
 * build loop already made in memory (#62) — without this, the run's
 * tracked physicalSlotByRoomId/nextPhysicalSlot bookkeeping would never
 * learn those rooms were built, and markRoomOutcome's own reuse-or-allocate
 * logic (which already correctly handles "this room's slot may already be
 * assigned" for the lazy/mutation case) would reassign colliding slots via
 * its counter instead of reusing them. `eagerlyBuilt` is exactly what
 * roomsToEagerlyBuild(state) returned — {room, buildOrder} pairs, any
 * order.
 */
export async function commitEagerPhysicalSlots(
  sceneId,
  eagerlyBuilt,
  { settingsRef = defaultSettingsRef() } = {},
) {
  const state = getRunState(sceneId, { settingsRef });
  if (!state) return state;
  const physicalSlotByRoomId = { ...state.physicalSlotByRoomId };
  let nextPhysicalSlot = state.nextPhysicalSlot;
  for (const { room, buildOrder } of eagerlyBuilt) {
    physicalSlotByRoomId[room.id] = buildOrder;
    nextPhysicalSlot = Math.max(nextPhysicalSlot, buildOrder + 1);
  }
  const newState = { ...state, physicalSlotByRoomId, nextPhysicalSlot };
  return persist(sceneId, newState, settingsRef);
}

export async function undoLastRoomEntry(
  { sceneId },
  { settingsRef = defaultSettingsRef() } = {},
) {
  const state = getRunState(sceneId, { settingsRef });
  if (!state || !canUndoRoomEntry(state))
    return { ok: false, state: state ?? null, undone: null };

  const undone = state.lastAutoEntry;
  const newState = {
    ...state,
    currentRoomId: undone.fromRoomId,
    lastAutoEntry: null,
  };
  await persist(sceneId, newState, settingsRef);
  return { ok: true, state: newState, undone };
}

export async function abandonRun(
  { sceneId },
  { settingsRef = defaultSettingsRef() } = {},
) {
  const all = settingsRef.get(MODULE_ID, "dungeonRuns") ?? {};
  if (!(sceneId in all)) return;
  const rest = { ...all };
  delete rest[sceneId];
  await settingsRef.set(MODULE_ID, "dungeonRuns", rest);
}

/**
 * The scene id and host of whichever GM-less run is currently active
 * (not completed, hostUserId set) anywhere in the world, or null if none.
 * Used to keep a second non-GM player from starting a competing run
 * (module.mjs's openDungeon) and to drive the read-only broadcast to every
 * other client (#109). At most one should ever exist in practice, since
 * openDungeon() itself refuses to start a second one.
 */
export function findActiveHostedRun({ settingsRef = defaultSettingsRef() } = {}) {
  const all = settingsRef.get(MODULE_ID, "dungeonRuns") ?? {};
  for (const [sceneId, state] of Object.entries(all)) {
    if (state && !state.completed && state.hostUserId) {
      return { sceneId, hostUserId: state.hostUserId };
    }
  }
  return null;
}

/**
 * Like findActiveHostedRun, but also matches a run that just completed —
 * used by the broadcast hook (module.mjs's syncGmLessDungeonBroadcast) so
 * a run's completion is actually shown to everyone instead of silently
 * closing their tracker the instant the goal room resolves. Only an
 * abandoned/reset run (its entry deleted entirely from dungeonRuns) should
 * ever stop showing up here — findActiveHostedRun's own `!completed`
 * exclusion stays correct for its own purpose (openDungeon()'s "is a
 * different host already running something" collision check, where a
 * finished run shouldn't block a fresh start).
 */
export function findHostedRunForBroadcast({ settingsRef = defaultSettingsRef() } = {}) {
  const all = settingsRef.get(MODULE_ID, "dungeonRuns") ?? {};
  for (const [sceneId, state] of Object.entries(all)) {
    if (state?.hostUserId) return { sceneId, hostUserId: state.hostUserId };
  }
  return null;
}

/**
 * Lazily attaches a fresh Victory Point challenge (#162) to `roomId`'s own
 * room object the first time it's needed — a no-op if that room already
 * has one, so a re-render (or a recovery retry) never rerolls its
 * specialty skills mid-challenge. `initSkillChallengeState` itself is pure
 * (`skill-challenge-mechanics.mjs`); this is only the read-mutate-persist
 * wrapper around it, same shape every other room-state write in this file
 * already uses. `template` (#164, optional) — a hand-authored
 * `dungeon-setpieces.json` entry the caller already selected via
 * `selectSkillChallengeTemplate` — passes straight through to
 * `initSkillChallengeState`, which falls back to its own generic pick when
 * none is given.
 *
 * Also flags the new challenge `customization: {status: 'pending'}` (#166)
 * — read back by `getPendingSkillChallengeCustomization` for
 * `tools/agent-loop`'s poller to offer an external agent a chance to
 * rewrite its name/summary/skillFlavor. Unlike a trap (spawned hidden,
 * with a real window to customize before the party ever sees it), a
 * skill-challenge room's content is shown the instant the room becomes
 * current — there's no hidden window here, so the party may well see the
 * un-customized name/summary first and see it update in place once (and
 * if) the agent's customization lands and something re-renders the
 * tracker. Accepted as the honest v1 trade-off rather than blocking room
 * display on it, matching #94's own "never stalls" fallback contract.
 */
export async function ensureSkillChallenge(
  sceneId,
  roomId,
  { seed, locationTag, partySize, depthBias, template = null },
  { settingsRef = defaultSettingsRef() } = {},
) {
  const state = getRunState(sceneId, { settingsRef });
  if (!state) return null;
  const room = state.rooms[roomId];
  if (!room || room.challenge) return state;
  const challenge = {
    ...initSkillChallengeState({
      seed,
      roomId,
      locationTag,
      partySize,
      depthBias,
      template,
    }),
    customization: { status: "pending" },
  };
  const rooms = { ...state.rooms, [roomId]: { ...room, challenge } };
  const newState = { ...state, rooms };
  await persist(sceneId, newState, settingsRef);
  return newState;
}

/**
 * Teardown counterpart to `ensureSkillChallenge` above (#62 mutation
 * reconciliation) — clears `roomId`'s own `challenge` state back to `null`
 * so a later `ensureSkillChallenge` call (once a Reward/Ruin mutation
 * changes which logical room occupies this physical slot) attaches fresh
 * state instead of finding the old room's `challenge` still set and
 * treating it as "already attached." A no-op (no persist) if that room has
 * no `challenge` at all, the same no-op shape `ensureSkillChallenge` itself
 * uses.
 */
export async function clearSkillChallengeState(
  sceneId,
  roomId,
  { settingsRef = defaultSettingsRef() } = {},
) {
  const state = getRunState(sceneId, { settingsRef });
  if (!state) return null;
  const room = state.rooms[roomId];
  if (!room || !room.challenge) return state;
  const rooms = { ...state.rooms, [roomId]: { ...room, challenge: null } };
  const newState = { ...state, rooms };
  await persist(sceneId, newState, settingsRef);
  return newState;
}

/**
 * The skill-challenge room whose `challenge.customization.status ===
 * 'pending'` (#166), still unresolved — mirrors `trap-combat.mjs`'s
 * `getPendingTrapCustomization` exactly, adapted for a challenge's own
 * persisted state instead of a live Foundry Actor (a skill challenge has
 * no document of its own to flag; its "pending" marker lives directly on
 * the room's own `challenge` object in this run's persisted state).
 * Stops offering a challenge once it's resolved, the same "don't rewrite
 * something the party's already finished with" reasoning the trap
 * version's "stop once revealed" gate uses. `null` if nothing's pending.
 * The *only* read surface `tools/agent-loop`'s poller uses for this.
 */
export function getPendingSkillChallengeCustomization(
  sceneId,
  { settingsRef = defaultSettingsRef() } = {},
) {
  const state = getRunState(sceneId, { settingsRef });
  if (!state) return null;
  const room = Object.values(state.rooms).find(
    (r) =>
      r.challenge?.customization?.status === "pending" && !r.challenge.resolved,
  );
  if (!room) return null;
  const c = room.challenge;
  return {
    sceneId,
    roomId: room.id,
    name: c.name,
    summary: c.summary,
    specialtySkills: c.specialtySkills,
    skillFlavor: c.skillFlavor,
    locationTag: room.locationTag,
  };
}

/**
 * Applies an external agent's customized name/summary/skillFlavor to
 * `roomId`'s own pending challenge (#166) — a no-op if that room has no
 * challenge at all. Only ever touches these three display fields, never
 * `specialtySkills`/`vpTarget`/`attemptBudget`/DCs — this cannot change
 * which skills are mechanically eligible or how hard the challenge
 * actually is, by construction, the same boundary `applyTrapCustomization`
 * already draws for a trap's own name/description. `skillFlavor` merges
 * onto the existing map rather than replacing it wholesale, so a partial
 * customization (flavor for only some of the 3 specialty skills) doesn't
 * blank out the rest. See module.mjs's api.applySkillChallengeCustomization.
 */
export async function applySkillChallengeCustomization(
  sceneId,
  roomId,
  { name = null, summary = null, skillFlavor = null } = {},
  { settingsRef = defaultSettingsRef() } = {},
) {
  const state = getRunState(sceneId, { settingsRef });
  if (!state) return null;
  const room = state.rooms[roomId];
  if (!room?.challenge) return state;
  const challenge = {
    ...room.challenge,
    name: name ?? room.challenge.name,
    summary: summary ?? room.challenge.summary,
    skillFlavor: skillFlavor
      ? { ...room.challenge.skillFlavor, ...skillFlavor }
      : room.challenge.skillFlavor,
    customization: { status: "customized" },
  };
  const rooms = { ...state.rooms, [roomId]: { ...room, challenge } };
  const newState = { ...state, rooms };
  await persist(sceneId, newState, settingsRef);
  return newState;
}

/**
 * Sets (or clears, with `objective: null`) the run's current narrative
 * objective (#163) — a plain, run-wide field, not scoped to any one room,
 * so it's visible from `getRunState` regardless of where the party is by
 * the time a player asks "wait, what were we doing again?" A blank/
 * whitespace-only string is treated the same as `null` (nothing to show),
 * rather than persisting an empty-looking objective line.
 */
export async function setObjective(
  sceneId,
  objective,
  { settingsRef = defaultSettingsRef() } = {},
) {
  const state = getRunState(sceneId, { settingsRef });
  if (!state) return null;
  const trimmed = objective?.trim();
  const newState = { ...state, objective: trimmed ? trimmed : null };
  await persist(sceneId, newState, settingsRef);
  return newState;
}

/**
 * Records one resolved skill-challenge attempt (#162) against `roomId`'s
 * own Victory Point state — a no-op if that room has no challenge attached
 * yet (`ensureSkillChallenge` never ran) or it's already resolved
 * (`applySkillChallengeAttempt` itself is already a no-op past that point
 * too; this wrapper just avoids the pointless persist).
 */
export async function recordSkillChallengeAttempt(
  sceneId,
  roomId,
  outcome,
  { settingsRef = defaultSettingsRef() } = {},
) {
  const state = getRunState(sceneId, { settingsRef });
  if (!state) return null;
  const room = state.rooms[roomId];
  if (!room?.challenge || room.challenge.resolved) return state;
  const challenge = applySkillChallengeAttempt(room.challenge, outcome);
  const rooms = { ...state.rooms, [roomId]: { ...room, challenge } };
  const newState = { ...state, rooms };
  await persist(sceneId, newState, settingsRef);
  return newState;
}

/**
 * Lazily attaches fresh puzzle state (#137) to `roomId`'s own room object
 * the first time it's needed — a no-op if that room already has one, the
 * same read-mutate-persist wrapper `ensureSkillChallenge` already uses
 * around `initSkillChallengeState`, here around `initPuzzleState`
 * instead. `hintChecks`/`requiredSuccesses`/`name`/`summary` come from the
 * room's own resolved `puzzle`-kind setpiece (the caller's job to have
 * looked that up — `dungeon-setpieces.json` entries aren't loaded from
 * here). `partyLevel` (#138, optional) scales every stage's own flat DC
 * to the actual party's level — locked in at this first attach, the same
 * way specialtySkills/vpTarget are locked in for a skill challenge,
 * rather than drifting if the party's level changes mid-room. `name`/
 * `summary` (#139) are persisted onto the puzzle state itself (not just
 * read fresh off the setpiece on every render) so
 * `applyPuzzleCustomization` has a stable place to overwrite that
 * actually sticks — the same reason `initSkillChallengeState` persists
 * its own template name/summary instead of re-deriving them each render.
 *
 * Also flags the new puzzle `customization: {status: 'pending'}`, read
 * back by `getPendingPuzzleCustomization`/`applyPuzzleCustomization`
 * (#139) below.
 */
export async function ensurePuzzleState(
  sceneId,
  roomId,
  {
    hintChecks,
    requiredSuccesses = null,
    partyLevel = null,
    name = null,
    summary = null,
  },
  { settingsRef = defaultSettingsRef() } = {},
) {
  const state = getRunState(sceneId, { settingsRef });
  if (!state) return null;
  const room = state.rooms[roomId];
  if (!room || room.puzzle) return state;
  const puzzle = {
    ...initPuzzleState({
      hintChecks,
      requiredSuccesses,
      partyLevel,
      name,
      summary,
    }),
    customization: { status: "pending" },
  };
  const rooms = { ...state.rooms, [roomId]: { ...room, puzzle } };
  const newState = { ...state, rooms };
  await persist(sceneId, newState, settingsRef);
  return newState;
}

/**
 * Teardown counterpart to `ensurePuzzleState` above (#62 mutation
 * reconciliation) — clears `roomId`'s own `puzzle` state back to `null` so
 * a later `ensurePuzzleState` call (once a Reward/Ruin mutation changes
 * which logical room occupies this physical slot) attaches fresh state
 * instead of finding the old room's `puzzle` still set and treating it as
 * "already attached." A no-op (no persist) if that room has no `puzzle` at
 * all, the same no-op shape `ensurePuzzleState` itself uses.
 */
export async function clearPuzzleState(
  sceneId,
  roomId,
  { settingsRef = defaultSettingsRef() } = {},
) {
  const state = getRunState(sceneId, { settingsRef });
  if (!state) return null;
  const room = state.rooms[roomId];
  if (!room || !room.puzzle) return state;
  const rooms = { ...state.rooms, [roomId]: { ...room, puzzle: null } };
  const newState = { ...state, rooms };
  await persist(sceneId, newState, settingsRef);
  return newState;
}

/**
 * Lazily attaches a trap's real name/description (#56) to `roomId`'s own
 * room object the first time it's needed — a no-op if that room already
 * has a `trap` state, the same "first attach wins" shape `ensurePuzzleState`
 * uses above. `dungeon-scene.mjs`'s `populateSlotTrap` is the only caller,
 * seeding this from the just-spawned hazard Actor's own `name`/
 * `system.details.description` at room-build time. Exists so a player-facing
 * surface (dungeon-app.mjs's setpiece display block) has real, room-specific
 * trap data to read instead of always falling back to one of the 3 generic,
 * unrelated static stub blurbs in `dungeon-setpieces.json` — the actual bug
 * #56 fixes.
 */
export async function ensureTrapState(
  sceneId,
  roomId,
  { name = null, description = null } = {},
  { settingsRef = defaultSettingsRef() } = {},
) {
  const state = getRunState(sceneId, { settingsRef });
  if (!state) return null;
  const room = state.rooms[roomId];
  if (!room || room.trap) return state;
  const trap = { name, description };
  const rooms = { ...state.rooms, [roomId]: { ...room, trap } };
  const newState = { ...state, rooms };
  await persist(sceneId, newState, settingsRef);
  return newState;
}

/**
 * Teardown counterpart to `ensureTrapState` above (#62 mutation
 * reconciliation) — clears `roomId`'s own `trap` state back to `null` so a
 * later `ensureTrapState` call (once a Reward/Ruin mutation changes which
 * logical room occupies this physical slot) attaches fresh state instead of
 * finding the old room's `trap` still set and treating it as "already
 * attached." A no-op (no persist) if that room has no `trap` at all, the
 * same no-op shape `clearPuzzleState` itself uses. `dungeon-scene.mjs`'s
 * `clearSlotTrap` handles the Foundry-side hazard actor/token teardown;
 * this is the room-state-only counterpart the caller runs alongside it.
 */
export async function clearTrapState(
  sceneId,
  roomId,
  { settingsRef = defaultSettingsRef() } = {},
) {
  const state = getRunState(sceneId, { settingsRef });
  if (!state) return null;
  const room = state.rooms[roomId];
  if (!room || !room.trap) return state;
  const rooms = { ...state.rooms, [roomId]: { ...room, trap: null } };
  const newState = { ...state, rooms };
  await persist(sceneId, newState, settingsRef);
  return newState;
}

/**
 * Applies an external agent's customized name/description to `roomId`'s own
 * trap state (#56) — a no-op if that room has no `trap` state at all.
 * `name`/`description` each override-or-keep-existing, same as
 * `applyPuzzleCustomization`'s `name`/`summary` merge. Named
 * `applyTrapRoomState` rather than `applyTrapCustomization` — that name is
 * already taken by `trap-combat.mjs`'s own function (which writes the
 * customization onto the live hazard Actor's `system.details.description`
 * and is this function's only caller, right after that actor write, so the
 * room-state mirror this function maintains stays in sync with it) — reusing
 * the same name across the two modules would be confusing where they're
 * imported together. This is what actually makes a trap customization
 * visible to players: the raw actor field alone is never read by any
 * player-facing surface, since the hazard Actor is spawned with
 * `ownership.default: 0`.
 */
export async function applyTrapRoomState(
  sceneId,
  roomId,
  { name = null, description = null } = {},
  { settingsRef = defaultSettingsRef() } = {},
) {
  const state = getRunState(sceneId, { settingsRef });
  if (!state) return null;
  const room = state.rooms[roomId];
  if (!room?.trap) return state;
  const trap = {
    name: name ?? room.trap.name,
    description: description ?? room.trap.description,
  };
  const rooms = { ...state.rooms, [roomId]: { ...room, trap } };
  const newState = { ...state, rooms };
  await persist(sceneId, newState, settingsRef);
  return newState;
}

/**
 * Records one resolved puzzle-stage attempt (#137) against `roomId`'s own
 * puzzle state — a no-op if that room has no puzzle attached yet
 * (`ensurePuzzleState` never ran) or it's already resolved
 * (`applyPuzzleStageAttempt` itself is already a no-op past that point
 * too, and also a no-op for an already-attempted stage; this wrapper just
 * avoids the pointless persist for the "no puzzle/already resolved" case).
 */
export async function recordPuzzleStageAttempt(
  sceneId,
  roomId,
  stageIndex,
  outcome,
  { settingsRef = defaultSettingsRef() } = {},
) {
  const state = getRunState(sceneId, { settingsRef });
  if (!state) return null;
  const room = state.rooms[roomId];
  if (!room?.puzzle || room.puzzle.resolved) return state;
  const puzzle = applyPuzzleStageAttempt(room.puzzle, stageIndex, outcome);
  const rooms = { ...state.rooms, [roomId]: { ...room, puzzle } };
  const newState = { ...state, rooms };
  await persist(sceneId, newState, settingsRef);
  return newState;
}

/**
 * The puzzle room whose `puzzle.customization.status === 'pending'` (#139),
 * still unresolved — mirrors `getPendingSkillChallengeCustomization`
 * exactly, adapted for a puzzle's own persisted state. `stages` (each
 * stage's `skill`/`dc`/`hint`) is exposed as context an external agent can
 * write flavor around — the same "context only, never rewrite gameplay
 * values" boundary `getPendingSkillChallengeCustomization`'s own
 * `specialtySkills` already draws. The *only* read surface
 * `tools/agent-loop`'s MCP server uses for this.
 */
export function getPendingPuzzleCustomization(
  sceneId,
  { settingsRef = defaultSettingsRef() } = {},
) {
  const state = getRunState(sceneId, { settingsRef });
  if (!state) return null;
  const room = Object.values(state.rooms).find(
    (r) => r.puzzle?.customization?.status === "pending" && !r.puzzle.resolved,
  );
  if (!room) return null;
  const p = room.puzzle;
  return {
    sceneId,
    roomId: room.id,
    name: p.name ?? null,
    summary: p.summary ?? null,
    stages: p.stages.map((s) => ({ skill: s.skill, dc: s.dc, hint: s.hint })),
    stageFlavor: p.stageFlavor ?? {},
    locationTag: room.locationTag,
  };
}

/**
 * Applies an external agent's customized name/summary/playerDescription/
 * stageFlavor to `roomId`'s own pending puzzle (#139) — a no-op if that
 * room has no puzzle at all. Only ever touches these display fields, never
 * `stages[].skill`/`stages[].dc`/`requiredSuccesses` — this cannot change
 * which skills are mechanically eligible, how hard a stage's check is, or
 * how many successes are needed, by construction, the same boundary
 * `applySkillChallengeCustomization` already draws for a challenge's own
 * name/summary/skillFlavor. `name`/`summary`/`playerDescription` each
 * override-or-keep-existing (a call that omits one leaves it as it was);
 * `stageFlavor` (keyed by stage index, a string per JSON's own key
 * convention) merges onto the existing map rather than replacing it
 * wholesale, so a partial customization (flavor for only some stages)
 * doesn't blank out the rest — it overrides a stage's *displayed* hint
 * text (read by whatever renders `stages[i].hint` once that stage
 * succeeds); the stage's own mechanically-real `hint` field itself is
 * never touched. `playerDescription` (#49) is the player-facing flavor
 * text shown instead of the GM-facing `summary` — see dungeon-app.mjs's
 * setpiece display block, which now prefers this over the raw setpiece
 * template's own playerDescription the same way it already preferred
 * `name`/`summary`. See module.mjs's api.applyPuzzleCustomization.
 */
export async function applyPuzzleCustomization(
  sceneId,
  roomId,
  { name = null, summary = null, playerDescription = null, stageFlavor = null } = {},
  { settingsRef = defaultSettingsRef() } = {},
) {
  const state = getRunState(sceneId, { settingsRef });
  if (!state) return null;
  const room = state.rooms[roomId];
  if (!room?.puzzle) return state;
  const puzzle = {
    ...room.puzzle,
    name: name ?? room.puzzle.name,
    summary: summary ?? room.puzzle.summary,
    playerDescription: playerDescription ?? room.puzzle.playerDescription,
    stageFlavor: stageFlavor
      ? { ...room.puzzle.stageFlavor, ...stageFlavor }
      : room.puzzle.stageFlavor,
    customization: { status: "customized" },
  };
  const rooms = { ...state.rooms, [roomId]: { ...room, puzzle } };
  const newState = { ...state, rooms };
  await persist(sceneId, newState, settingsRef);
  return newState;
}

/**
 * Attaches `setpiece`'s own archetype-specific content to `roomId` as
 * persisted `room.narrative` state (#167) — a no-op if that room already
 * has one. Unlike puzzle/skill_challenge, a narrative room has no evolving
 * mechanical state of its own (#165's own design: it resolves in a single
 * Continue action, nothing to track across attempts), so this exists
 * purely to give an external agent's customization somewhere durable to
 * land — without it, a customization would overwrite nothing (#165 read
 * every field straight off the shared, immutable setpiece template) and
 * be invisible the next render, the exact bug #139 caught and fixed for
 * puzzles before #139 ever shipped. Flags the room `customization:
 * {status: 'pending'}`, read back by `getPendingNarrativeCustomization`/
 * `applyNarrativeCustomization` below.
 */
export async function ensureNarrativeState(
  sceneId,
  roomId,
  { setpiece },
  { settingsRef = defaultSettingsRef() } = {},
) {
  const state = getRunState(sceneId, { settingsRef });
  if (!state) return null;
  const room = state.rooms[roomId];
  if (!room || room.narrative) return state;
  const narrative = {
    archetype: setpiece.archetype,
    name: setpiece.name,
    summary: setpiece.summary,
    revealText: setpiece.revealText ?? null,
    npcName: setpiece.npcName ?? null,
    npcHook: setpiece.npcHook ?? null,
    options: setpiece.options ?? null,
    suggestedObjective: setpiece.suggestedObjective ?? null,
    customization: { status: "pending" },
  };
  const rooms = { ...state.rooms, [roomId]: { ...room, narrative } };
  const newState = { ...state, rooms };
  await persist(sceneId, newState, settingsRef);
  return newState;
}

/**
 * Teardown counterpart to `ensureNarrativeState` above (#62 mutation
 * reconciliation) — clears `roomId`'s own `narrative` state back to `null`
 * so a later `ensureNarrativeState` call (once a Reward/Ruin mutation
 * changes which logical room occupies this physical slot) attaches the new
 * room's own setpiece content instead of finding the old room's
 * `narrative` still set and treating it as "already attached." A no-op (no
 * persist) if that room has no `narrative` at all, the same no-op shape
 * `ensureNarrativeState` itself uses.
 */
export async function clearNarrativeState(
  sceneId,
  roomId,
  { settingsRef = defaultSettingsRef() } = {},
) {
  const state = getRunState(sceneId, { settingsRef });
  if (!state) return null;
  const room = state.rooms[roomId];
  if (!room || !room.narrative) return state;
  const rooms = { ...state.rooms, [roomId]: { ...room, narrative: null } };
  const newState = { ...state, rooms };
  await persist(sceneId, newState, settingsRef);
  return newState;
}

/**
 * The narrative room whose `narrative.customization.status === 'pending'`
 * (#167), still unresolved — mirrors `getPendingPuzzleCustomization`
 * exactly, adapted for narrative's own state. Unlike puzzle/skill_challenge
 * (each tracks its own `resolved` flag on its own state object, flipped by
 * a dedicated reducer), a narrative room's resolution goes straight through
 * the shared `markRoomOutcome` path without ever touching `room.narrative`
 * itself — so "already resolved" is read off `state.history` instead, the
 * same check `ui/dungeon-app.mjs`'s own `currentRoomResolved` already
 * computes. The *only* read surface `tools/agent-loop`'s poller uses for
 * this.
 */
export function getPendingNarrativeCustomization(
  sceneId,
  { settingsRef = defaultSettingsRef() } = {},
) {
  const state = getRunState(sceneId, { settingsRef });
  if (!state) return null;
  const room = Object.values(state.rooms).find(
    (r) =>
      r.narrative?.customization?.status === "pending" &&
      !state.history.some((h) => h.roomId === r.id),
  );
  if (!room) return null;
  const n = room.narrative;
  return {
    sceneId,
    roomId: room.id,
    archetype: n.archetype,
    name: n.name ?? null,
    summary: n.summary ?? null,
    revealText: n.revealText ?? null,
    npcName: n.npcName ?? null,
    npcHook: n.npcHook ?? null,
    options: n.options ?? null,
    suggestedObjective: n.suggestedObjective ?? null,
    locationTag: room.locationTag,
  };
}

/**
 * Applies an external agent's customized content to `roomId`'s own pending
 * narrative state (#167) — a no-op if that room has no narrative state at
 * all. Only ever touches display fields (name/summary plus whichever of
 * revealText/npcName/npcHook/options/suggestedObjective the archetype
 * actually uses), the same boundary `applyPuzzleCustomization`/
 * `applySkillChallengeCustomization` already draw — there's no separate
 * "mechanical" field to protect here at all, since a narrative room has no
 * mechanics beyond the single Continue action every archetype shares.
 * `options` replaces wholesale rather than merging (unlike `skillFlavor`/
 * `stageFlavor`'s key-based merge) — its two entries are a matched pair,
 * not independently addressable slots, so a partial override wouldn't mean
 * anything coherent. See module.mjs's api.applyNarrativeCustomization.
 */
export async function applyNarrativeCustomization(
  sceneId,
  roomId,
  {
    name = null,
    summary = null,
    revealText = null,
    npcName = null,
    npcHook = null,
    options = null,
    suggestedObjective = null,
  } = {},
  { settingsRef = defaultSettingsRef() } = {},
) {
  const state = getRunState(sceneId, { settingsRef });
  if (!state) return null;
  const room = state.rooms[roomId];
  if (!room?.narrative) return state;
  const narrative = {
    ...room.narrative,
    name: name ?? room.narrative.name,
    summary: summary ?? room.narrative.summary,
    revealText: revealText ?? room.narrative.revealText,
    npcName: npcName ?? room.narrative.npcName,
    npcHook: npcHook ?? room.narrative.npcHook,
    options: options ?? room.narrative.options,
    suggestedObjective: suggestedObjective ?? room.narrative.suggestedObjective,
    customization: { status: "customized" },
  };
  const rooms = { ...state.rooms, [roomId]: { ...room, narrative } };
  const newState = { ...state, rooms };
  await persist(sceneId, newState, settingsRef);
  return newState;
}

/**
 * Attaches `setpiece`'s own name/summary to `roomId` as persisted
 * `room.treasure` state (#89) — a no-op if that room already has one.
 * Mirrors `ensureNarrativeState` exactly, but for treasure's own,
 * deliberately smaller field shape: a treasure setpiece has no mechanical
 * fields at all (no archetype, no revealText/npcName/npcHook/options/
 * suggestedObjective) — the gp amount and item-table draw
 * (grantTreasureReward/claimTreasureFor in ui/dungeon-app.mjs) are computed
 * entirely separately and never read this state at all, by design (this
 * exists purely for flavor text, never for anything a treasure room's real
 * reward depends on). Flags the room `customization: {status: 'pending'}`,
 * read back by `getPendingTreasureCustomization`/`applyTreasureCustomization`
 * below.
 */
export async function ensureTreasureState(
  sceneId,
  roomId,
  { setpiece },
  { settingsRef = defaultSettingsRef() } = {},
) {
  const state = getRunState(sceneId, { settingsRef });
  if (!state) return null;
  const room = state.rooms[roomId];
  if (!room || room.treasure) return state;
  const treasure = {
    name: setpiece.name,
    summary: setpiece.summary,
    customization: { status: "pending" },
  };
  const rooms = { ...state.rooms, [roomId]: { ...room, treasure } };
  const newState = { ...state, rooms };
  await persist(sceneId, newState, settingsRef);
  return newState;
}

/**
 * Teardown counterpart to `ensureTreasureState` above (#62 mutation
 * reconciliation) — clears `roomId`'s own `treasure` state back to `null`
 * so a later `ensureTreasureState` call (once a Reward/Ruin mutation
 * changes which logical room occupies this physical slot) attaches the new
 * room's own setpiece content instead of finding the old room's `treasure`
 * still set and treating it as "already attached." A no-op (no persist) if
 * that room has no `treasure` at all, the same no-op shape
 * `ensureTreasureState` itself uses.
 */
export async function clearTreasureState(
  sceneId,
  roomId,
  { settingsRef = defaultSettingsRef() } = {},
) {
  const state = getRunState(sceneId, { settingsRef });
  if (!state) return null;
  const room = state.rooms[roomId];
  if (!room || !room.treasure) return state;
  const rooms = { ...state.rooms, [roomId]: { ...room, treasure: null } };
  const newState = { ...state, rooms };
  await persist(sceneId, newState, settingsRef);
  return newState;
}

/**
 * The treasure room whose `treasure.customization.status === 'pending'`
 * (#89), still unresolved — mirrors `getPendingNarrativeCustomization`
 * exactly, adapted for treasure's own smaller state (just name/summary, no
 * archetype-specific extras). A treasure room's resolution goes straight
 * through the shared `markRoomOutcome` path without ever touching
 * `room.treasure` itself — so "already resolved" is read off
 * `state.history` instead, the same check `getPendingNarrativeCustomization`
 * already uses. The *only* read surface `tools/agent-loop`'s poller uses
 * for this.
 */
export function getPendingTreasureCustomization(
  sceneId,
  { settingsRef = defaultSettingsRef() } = {},
) {
  const state = getRunState(sceneId, { settingsRef });
  if (!state) return null;
  const room = Object.values(state.rooms).find(
    (r) =>
      r.treasure?.customization?.status === "pending" &&
      !state.history.some((h) => h.roomId === r.id),
  );
  if (!room) return null;
  const t = room.treasure;
  return {
    sceneId,
    roomId: room.id,
    name: t.name ?? null,
    summary: t.summary ?? null,
    locationTag: room.locationTag,
  };
}

/**
 * Applies an external agent's customized name/summary to `roomId`'s own
 * pending treasure state (#89) — a no-op if that room has no treasure state
 * at all. Only ever touches these two display fields — there is no
 * "mechanical" field to protect here at all, by construction: a treasure
 * room's real reward (gp amount, item-table draw) is computed entirely
 * separately in ui/dungeon-app.mjs's grantTreasureReward/claimTreasureFor
 * and never reads `room.treasure`, so this can never rewrite gameplay
 * values even by accident. See module.mjs's api.applyTreasureCustomization.
 */
export async function applyTreasureCustomization(
  sceneId,
  roomId,
  { name = null, summary = null } = {},
  { settingsRef = defaultSettingsRef() } = {},
) {
  const state = getRunState(sceneId, { settingsRef });
  if (!state) return null;
  const room = state.rooms[roomId];
  if (!room?.treasure) return state;
  const treasure = {
    ...room.treasure,
    name: name ?? room.treasure.name,
    summary: summary ?? room.treasure.summary,
    customization: { status: "customized" },
  };
  const rooms = { ...state.rooms, [roomId]: { ...room, treasure } };
  const newState = { ...state, rooms };
  await persist(sceneId, newState, settingsRef);
  return newState;
}
