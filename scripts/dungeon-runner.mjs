/**
 * The Foundry side of a dungeon run: reads and writes the `dungeonRuns` world
 * setting (keyed by scene id — see module.mjs) and calls into the pure logic
 * in dungeon-deck.mjs. `settingsRef` is injectable, same pattern as
 * draw-target.mjs's canvasRef/userRef, so this is testable against an
 * in-memory stub instead of live `game.settings`.
 *
 * `currentIndex` names the room the party is physically STANDING IN, not the
 * room most recently judged. Resolving a room (markRoomOutcome) never moves
 * it — it only decides what comes next and assigns that next room a physical
 * slot number so dungeon-scene.mjs knows what to build. Only the automatic
 * room-entry trigger (advanceToRoom) moves currentIndex, once the party has
 * actually walked there. Physical slots are handed out in the exact order
 * rooms are approached (a plain incrementing counter), never reassigned —
 * see dungeon-layout.mjs for why that needs no reindexing even when a Ruin
 * or Reward inserts or removes a room from the sequence.
 */
import {
  buildRoomSequence,
  findOutcomeTemplate,
  resolveRoomOutcome,
  applySequenceMutation,
} from "./dungeon-deck.mjs";
import {
  initSkillChallengeState,
  applySkillChallengeAttempt,
} from "./skill-challenge-mechanics.mjs";
import { initPuzzleState, applyPuzzleStageAttempt } from "./puzzle-mechanics.mjs";

const MODULE_ID = "deck-of-many-more-things";

function defaultSettingsRef() {
  return {
    get: (...args) => game.settings.get(...args),
    set: (...args) => game.settings.set(...args),
  };
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
  { settingsRef = defaultSettingsRef(), setpieceIds = [], narrativeSetpieceIds = [] } = {},
) {
  const runSeed =
    seed ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const rooms = buildRoomSequence({ seed: runSeed, roomCount, setpieceIds, narrativeSetpieceIds });
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
  const state = {
    seed: runSeed,
    createdAt: Date.now(),
    traits,
    excludeTraits,
    rooms,
    currentIndex: 0,
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
  };
  return persist(sceneId, state, settingsRef);
}

/**
 * Resolve the CURRENT room as succeeded or failed.
 *
 * Does NOT move currentIndex — see the file docblock. For the goal room this
 * just ends the run. For any other room it resolves the outcome slot, applies
 * any sequence mutation, and — if there's a room after it — assigns that next
 * room its physical slot number the first time it's ever reached (a plain
 * incrementing counter; `dungeon-deck.mjs`'s own mutation logic already
 * decides which logical room that is, this file doesn't need to know why).
 *
 * Returns `nextRoomId`/`nextPhysicalSlot` (both null once there's nothing
 * left, i.e. the goal room was just resolved) so the caller knows what to
 * physically build next.
 */
export async function markRoomOutcome(
  { sceneId, succeeded },
  { settingsRef = defaultSettingsRef(), setpieceIds = [], narrativeSetpieceIds = [] } = {},
) {
  const state = getRunState(sceneId, { settingsRef });
  if (!state || state.completed) {
    return {
      state,
      effectKey: null,
      mutation: null,
      nextRoomId: null,
      nextPhysicalSlot: null,
    };
  }

  const room = state.rooms[state.currentIndex];
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
    return {
      state,
      effectKey: null,
      mutation: null,
      nextRoomId: null,
      nextPhysicalSlot: null,
    };
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
    return {
      state,
      effectKey: null,
      mutation: null,
      nextRoomId: null,
      nextPhysicalSlot: null,
    };
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
    return {
      state: newState,
      effectKey,
      mutation: null,
      nextRoomId: null,
      nextPhysicalSlot: null,
    };
  }

  // A rest room has nothing to reward or ruin — just move the sequence along
  // to whatever comes after it, same slot-assignment bookkeeping as any
  // other room (ITEM-5), rather than running findOutcomeTemplate/
  // resolveRoomOutcome against its null outcomeSlotId.
  const { effectKey, mutation } =
    room.kind === "safe_rest"
      ? { effectKey: "rest_room_passed", mutation: null }
      : resolveRoomOutcome(findOutcomeTemplate(room.outcomeSlotId), succeeded);
  const rooms =
    mutation === "remove_next" || mutation === "insert_after"
      ? applySequenceMutation(state.rooms, state.currentIndex, mutation, {
          seed: state.seed,
          setpieceIds,
          narrativeSetpieceIds,
        })
      : state.rooms;

  const nextRoomId = rooms[state.currentIndex + 1]?.id ?? null;
  let physicalSlotByRoomId = state.physicalSlotByRoomId;
  let nextPhysicalSlot = state.nextPhysicalSlot;
  let assignedSlot = null;
  if (nextRoomId) {
    if (nextRoomId in physicalSlotByRoomId) {
      assignedSlot = physicalSlotByRoomId[nextRoomId];
    } else {
      assignedSlot = nextPhysicalSlot;
      physicalSlotByRoomId = {
        ...physicalSlotByRoomId,
        [nextRoomId]: assignedSlot,
      };
      nextPhysicalSlot += 1;
    }
  }

  const newState = {
    ...state,
    rooms,
    physicalSlotByRoomId,
    nextPhysicalSlot,
    history: [...state.history, { ...base, effectKey }],
  };
  await persist(sceneId, newState, settingsRef);
  return {
    state: newState,
    effectKey,
    mutation,
    nextRoomId,
    nextPhysicalSlot: assignedSlot,
  };
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
  const expectedId = state.rooms[state.currentIndex + 1]?.id ?? null;
  if (!expectedId || expectedId !== roomId) return { ok: false, state };

  const newState = {
    ...state,
    currentIndex: state.currentIndex + 1,
    lastAutoEntry: {
      roomId,
      fromIndex: state.currentIndex,
      toIndex: state.currentIndex + 1,
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
    currentIndex: undone.fromIndex,
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
  { seed, locationTag, partySize, template = null },
  { settingsRef = defaultSettingsRef() } = {},
) {
  const state = getRunState(sceneId, { settingsRef });
  if (!state) return null;
  const room = state.rooms.find((r) => r.id === roomId);
  if (!room || room.challenge) return state;
  const challenge = {
    ...initSkillChallengeState({
      seed,
      roomId,
      locationTag,
      partySize,
      template,
    }),
    customization: { status: "pending" },
  };
  const rooms = state.rooms.map((r) =>
    r.id === roomId ? { ...r, challenge } : r,
  );
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
  const room = state.rooms.find(
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
  const room = state.rooms.find((r) => r.id === roomId);
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
  const rooms = state.rooms.map((r) =>
    r.id === roomId ? { ...r, challenge } : r,
  );
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
  const room = state.rooms.find((r) => r.id === roomId);
  if (!room?.challenge || room.challenge.resolved) return state;
  const challenge = applySkillChallengeAttempt(room.challenge, outcome);
  const rooms = state.rooms.map((r) =>
    r.id === roomId ? { ...r, challenge } : r,
  );
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
  const room = state.rooms.find((r) => r.id === roomId);
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
  const rooms = state.rooms.map((r) => (r.id === roomId ? { ...r, puzzle } : r));
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
  const room = state.rooms.find((r) => r.id === roomId);
  if (!room?.puzzle || room.puzzle.resolved) return state;
  const puzzle = applyPuzzleStageAttempt(room.puzzle, stageIndex, outcome);
  const rooms = state.rooms.map((r) => (r.id === roomId ? { ...r, puzzle } : r));
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
  const room = state.rooms.find(
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
 * Applies an external agent's customized name/summary/stageFlavor to
 * `roomId`'s own pending puzzle (#139) — a no-op if that room has no
 * puzzle at all. Only ever touches these three display fields, never
 * `stages[].skill`/`stages[].dc`/`requiredSuccesses` — this cannot change
 * which skills are mechanically eligible, how hard a stage's check is, or
 * how many successes are needed, by construction, the same boundary
 * `applySkillChallengeCustomization` already draws for a challenge's own
 * name/summary/skillFlavor. `stageFlavor` (keyed by stage index, a string
 * per JSON's own key convention) merges onto the existing map rather than
 * replacing it wholesale, so a partial customization (flavor for only
 * some stages) doesn't blank out the rest — it overrides a stage's
 * *displayed* hint text (read by whatever renders `stages[i].hint` once
 * that stage succeeds); the stage's own mechanically-real `hint` field
 * itself is never touched. See module.mjs's api.applyPuzzleCustomization.
 */
export async function applyPuzzleCustomization(
  sceneId,
  roomId,
  { name = null, summary = null, stageFlavor = null } = {},
  { settingsRef = defaultSettingsRef() } = {},
) {
  const state = getRunState(sceneId, { settingsRef });
  if (!state) return null;
  const room = state.rooms.find((r) => r.id === roomId);
  if (!room?.puzzle) return state;
  const puzzle = {
    ...room.puzzle,
    name: name ?? room.puzzle.name,
    summary: summary ?? room.puzzle.summary,
    stageFlavor: stageFlavor
      ? { ...room.puzzle.stageFlavor, ...stageFlavor }
      : room.puzzle.stageFlavor,
    customization: { status: "customized" },
  };
  const rooms = state.rooms.map((r) => (r.id === roomId ? { ...r, puzzle } : r));
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
  const room = state.rooms.find((r) => r.id === roomId);
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
  const rooms = state.rooms.map((r) =>
    r.id === roomId ? { ...r, narrative } : r,
  );
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
  const room = state.rooms.find(
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
  const room = state.rooms.find((r) => r.id === roomId);
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
  const rooms = state.rooms.map((r) =>
    r.id === roomId ? { ...r, narrative } : r,
  );
  const newState = { ...state, rooms };
  await persist(sceneId, newState, settingsRef);
  return newState;
}
