import { loadDungeonSetpieces } from "../data-loader.mjs";
import {
  getRunState,
  createRun,
  markRoomOutcome,
  abandonRun,
  canUndoRoomEntry,
  recordSkillChallengeAttempt,
  setObjective,
  recordPuzzleStageAttempt,
} from "../dungeon-runner.mjs";
import { canActOnDungeon } from "../dungeon-permissions.mjs";
import { requestDungeonAction } from "../dungeon-remote.mjs";
import { depthBiasFor, lootGpForTreasureRoom } from "../dungeon-deck.mjs";
import { makeFoundryApi } from "../foundry-api.mjs";
import { rollSkillChallengeAttempt } from "../skill-challenge.mjs";
import { rollPuzzleStageAttempt } from "../puzzle.mjs";
import { ALL_SKILLS, dcForAttempt } from "../skill-challenge-mechanics.mjs";
import {
  traitFieldHtml,
  wireTraitPickerButtons,
  readTraitField,
} from "../trait-picker.mjs";
import {
  createDungeonScene,
  buildRoomAtSlot,
  unlockDoorToSlot,
  populateSlotEncounter,
  isSlotPopulated,
  isSlotBuilt,
  placePartyInSlot,
  undoRoomEntry,
  focusCameraOnSlot,
  teardownDungeonRun,
  buildPopulateAndUnlockRoom,
  sweepCompletedDungeonScene,
} from "../dungeon-scene.mjs";
import {
  startCombatForSlot,
  getCombatForSlot,
  resolveSlotCombat,
} from "../dungeon-combat.mjs";

const MODULE_ID = "pf2e-dungeon-crawl";
const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

const ROOM_KIND_KEYS = {
  combat: "PF2EDC.Dungeon.Kind.combat",
  skill_challenge: "PF2EDC.Dungeon.Kind.skill_challenge",
  puzzle_or_trap: "PF2EDC.Dungeon.Kind.puzzle_or_trap",
  narrative: "PF2EDC.Dungeon.Kind.narrative",
  treasure: "PF2EDC.Dungeon.Kind.treasure",
  safe_entry: "PF2EDC.Dungeon.Kind.safe_entry",
  safe_rest: "PF2EDC.Dungeon.Kind.safe_rest",
};

const EFFECT_KEYS = {
  friendly_aid: "PF2EDC.Dungeon.Effect.friendly_aid",
  encounter: "PF2EDC.Dungeon.Effect.encounter",
  ready_foraging: "PF2EDC.Dungeon.Effect.ready_foraging",
  restless_night: "PF2EDC.Dungeon.Effect.restless_night",
  reduced_travel_time: "PF2EDC.Dungeon.Effect.reduced_travel_time",
  extra_travel_time: "PF2EDC.Dungeon.Effect.extra_travel_time",
  treasure: "PF2EDC.Dungeon.Effect.treasure",
  lost_gear: "PF2EDC.Dungeon.Effect.lost_gear",
  exhaustion: "PF2EDC.Dungeon.Effect.exhaustion",
  goal_cleared: "PF2EDC.Dungeon.Effect.goal_cleared",
  goal_failed: "PF2EDC.Dungeon.Effect.goal_failed",
  rest_room_passed: "PF2EDC.Dungeon.Effect.rest_room_passed",
};

/** Rooms with nothing to resolve (no outcomeSlotId ever assigned) — never
 * counted toward the GM's own requested room total (ITEM-5's rest room joins
 * the entry here). */
const UNCOUNTED_ROOM_KINDS = new Set(["safe_entry", "safe_rest"]);

/** A skill slug's own display name — `CONFIG.PF2E.skills[slug].label` is an
 * i18n *key* (confirmed live: `"PF2E.Skill.Acrobatics"`, not resolved
 * text), not the label itself, so this always needs the extra localize
 * step. Falls back to the bare slug for a key PF2e's own config doesn't
 * carry (shouldn't happen for anything out of `ALL_SKILLS`, which was
 * itself confirmed live to match `CONFIG.PF2E.skills`'s own keys exactly)
 * — except `"perception"` (#137's own puzzle stages can use it, unlike
 * `ALL_SKILLS`, which excludes it): confirmed live it has no entry in
 * `CONFIG.PF2E.skills` at all (it's not a "skill" in PF2e's own model),
 * resolved instead via the same `"PF2E.PerceptionLabel"` key the system's
 * own UI uses for it. */
function skillLabel(slug) {
  if (slug === "perception") return game.i18n.localize("PF2E.PerceptionLabel");
  const key = CONFIG.PF2E?.skills?.[slug]?.label;
  return key ? game.i18n.localize(key) : slug;
}

/**
 * Resolve the current room's outcome and build+populate+unlock whatever
 * follows. Not a class method — it only touches globals and the
 * dungeon-scene/runner modules, so the two action handlers below can call it
 * directly rather than needing `this` threaded through a shared private
 * static method. Exported (with an explicit `scene` override) because
 * dungeon-combat.mjs's automatic combat-resolution hooks need to call this
 * too, and a hook can fire while the GM is looking at a different scene
 * entirely — `canvas?.scene` alone isn't reliable there the way it is for a
 * button click inside this app.
 */
export async function resolveCurrentRoom(succeeded, { scene } = {}) {
  if (!scene) return;
  const setpieces = await loadDungeonSetpieces();
  const { state, mutation, nextRoomId, nextPhysicalSlot } =
    await markRoomOutcome(
      { sceneId: scene.id, succeeded },
      {
        // #165: filtered by kind so a puzzle_or_trap room's own draw can
        // never land on a skill_challenge or narrative entry (those never
        // use setpieceId at all — skill_challenge picks its own template
        // separately, and neither would populate anything if drawn here) —
        // a real, pre-existing bug this filter also fixes, not just a
        // narrative-specific concern.
        setpieceIds: setpieces
          .filter((s) => s.kind === "puzzle" || s.kind === "trap")
          .map((s) => s.id),
        narrativeSetpieceIds: setpieces
          .filter((s) => s.kind === "narrative")
          .map((s) => s.id),
      },
    );
  if (mutation === "rerun_encounter")
    ui.notifications.warn(
      game.i18n.localize("PF2EDC.Dungeon.RerunEncounterHint"),
    );
  if (!nextRoomId) {
    // #204: the goal room was just resolved — nothing more to build, but
    // sweep any un-looted #172 corpse (or plain leftover NPC) before
    // returning, since this was previously the one completion path with no
    // cleanup trigger at all (teardownDungeonRun only ever fires on Abandon).
    await sweepCompletedDungeonScene(scene);
    return;
  }

  const nextRoom = state.rooms.find((r) => r.id === nextRoomId);
  await buildPopulateAndUnlockRoom(scene, state, nextRoom, nextPhysicalSlot);
}

export async function startDungeonRun({
  roomCount,
  traits,
  excludeTraits,
  previousSceneId,
  hostUserId,
}) {
  const scene = await createDungeonScene();
  const setpieces = await loadDungeonSetpieces();
  const state = await createRun(
    {
      sceneId: scene.id,
      roomCount,
      traits,
      excludeTraits,
      previousSceneId,
      hostUserId,
    },
    {
      // #165: same kind-filtering as resolveCurrentRoom's own markRoomOutcome
      // call — see its comment for why an unfiltered pool is a real bug, not
      // just a narrative-specific concern.
      setpieceIds: setpieces
        .filter((s) => s.kind === "puzzle" || s.kind === "trap")
        .map((s) => s.id),
      narrativeSetpieceIds: setpieces
        .filter((s) => s.kind === "narrative")
        .map((s) => s.id),
    },
  );

  // Room 0 is always the safe entry — no encounter, trap or puzzle ever
  // spawns there (see dungeon-deck.mjs's buildRoomSequence).
  const entryRoom = state.rooms[0];
  await buildRoomAtSlot(scene, 0, {
    isGoal: entryRoom.isGoal,
    locationTag: entryRoom.locationTag,
    artVariant: entryRoom.artVariant,
    seed: state.seed,
  });

  // A combat first room's build+populate is deliberately deferred to the
  // next "Populate Next Room" action instead — see #onPopulateNext/
  // populateNextRoom below (ITEM-11).
  const firstRealRoom = state.rooms[1];
  if (firstRealRoom && firstRealRoom.kind !== "combat") {
    await buildPopulateAndUnlockRoom(scene, state, firstRealRoom, 1);
  }

  const partyMembers = (game.actors?.party?.members ?? []).filter(
    (m) => m.type === "character",
  );
  await placePartyInSlot(scene, 0, partyMembers, state.seed);
  await scene.activate();
  // The canvas doesn't finish switching to the new scene the instant
  // activate() resolves — animatePan needs a beat to land on it, same
  // settling delay scene-divination.mjs already relies on for its own
  // post-activate scene work.
  await new Promise((r) => setTimeout(r, 400));
  focusCameraOnSlot(scene, 0, state.seed);
}

export async function recordSkillChallengeOutcome(sceneId, roomId, outcome) {
  const newState = await recordSkillChallengeAttempt(sceneId, roomId, outcome);
  const resolved = newState?.rooms.find((r) => r.id === roomId)?.challenge
    ?.resolved;
  if (resolved)
    await resolveCurrentRoom(resolved === "success", {
      scene: game.scenes.get(sceneId),
    });
}

export async function recordPuzzleStageOutcome(
  sceneId,
  roomId,
  stageIndex,
  outcome,
) {
  const newState = await recordPuzzleStageAttempt(
    sceneId,
    roomId,
    stageIndex,
    outcome,
  );
  const resolved = newState?.rooms.find((r) => r.id === roomId)?.puzzle
    ?.resolved;
  if (resolved)
    await resolveCurrentRoom(resolved === "success", {
      scene: game.scenes.get(sceneId),
    });
}

/** A treasure room's own resolution (#169): grants real coins to the party
 * actor, scaled by party level and the room's own depthBiasFor ramp
 * (lootGpForTreasureRoom), then always resolves succeeded — same "nothing
 * to fail at" shape as continueNarrativeRoom. Silently grants nothing if
 * there's no party actor to fund (matches resolveSlotCombat's own
 * `game.actors.party` guard for its combat-loot grant). */
export async function claimTreasureFor(sceneId) {
  const scene = game.scenes.get(sceneId);
  const state = scene ? getRunState(sceneId) : null;
  const currentRoom = state?.rooms[state.currentIndex];
  const physicalSlot = currentRoom
    ? state.physicalSlotByRoomId[currentRoom.id]
    : null;
  if (physicalSlot == null) return;
  if (game.actors.party) {
    const api = makeFoundryApi();
    const partyLevel = await api.partyLevel();
    const gp = lootGpForTreasureRoom({
      partyLevel,
      physicalSlot,
      roomCount: state.rooms.length,
      isGoal: currentRoom.isGoal,
    });
    await api.addCoins(game.actors.party.id, { gp });
    ui.notifications.info(
      game.i18n.format("PF2EDC.Dungeon.Treasure.Found", { gp }),
    );
  }
  await resolveCurrentRoom(true, { scene });
}

/**
 * A narrative room's own resolution (#163): saves whatever's in the
 * objective textarea (if anything — see #onContinueNarrative's own comment
 * on why a blank field leaves any existing objective alone) and always
 * resolves the room succeeded, since a narrative beat has nothing to fail.
 */
export async function continueNarrativeRoom(sceneId, objective) {
  if (objective) await setObjective(sceneId, objective);
  await resolveCurrentRoom(true, { scene: game.scenes.get(sceneId) });
}

/**
 * A choice-archetype narrative room's own resolution (#208) — sets the
 * run's objective directly from the picked option's own `consequence` text
 * instead of a free-typed one (the branch IS the objective for this
 * archetype), then always resolves succeeded, same as every other
 * narrative room (#163) — a narrative beat still has nothing to fail;
 * branching only ever changes which objective gets set, never the room's
 * own Reward-side Journey Spread outcome.
 */
export async function chooseNarrativeOption(sceneId, optionIndex) {
  const scene = game.scenes.get(sceneId);
  const state = scene ? getRunState(sceneId) : null;
  const option =
    state?.rooms[state.currentIndex]?.narrative?.options?.[optionIndex];
  if (option) await setObjective(sceneId, option.consequence);
  await resolveCurrentRoom(true, { scene });
}

export async function resolveCombatRoomOutcome(sceneId, succeeded) {
  const scene = game.scenes.get(sceneId);
  const state = scene ? getRunState(sceneId) : null;
  const currentRoom = state?.rooms[state.currentIndex];
  const slot = currentRoom ? state.physicalSlotByRoomId[currentRoom.id] : null;
  if (slot == null) return;
  await resolveSlotCombat(
    scene,
    slot,
    succeeded ? "victory" : "defeat",
    makeFoundryApi(),
  );
  await resolveCurrentRoom(succeeded, { scene });
}

export async function startCombatRecoveryFor(sceneId) {
  const scene = game.scenes.get(sceneId);
  const state = scene ? getRunState(sceneId) : null;
  const currentRoom = state?.rooms[state.currentIndex];
  const slot = currentRoom ? state.physicalSlotByRoomId[currentRoom.id] : null;
  if (slot == null) return;
  await startCombatForSlot(scene, slot);
}

export async function populateNextRoom(sceneId) {
  const scene = game.scenes.get(sceneId);
  const state = scene ? getRunState(sceneId) : null;
  const nextRoom = state?.rooms[state.currentIndex + 1] ?? null;
  const slot = nextRoom ? state.physicalSlotByRoomId[nextRoom.id] : null;
  if (!scene || slot == null) return;

  // A combat first room's walls don't exist yet the first time this runs
  // for it — startDungeonRun deliberately skipped building it — so build
  // them here too, same as every other recovery this function already
  // covers. A no-op for every normal case, where the room was already
  // built back when the room before it resolved.
  if (!isSlotBuilt(scene, slot)) {
    await buildRoomAtSlot(scene, slot, {
      isGoal: nextRoom.isGoal,
      locationTag: nextRoom.locationTag,
      artVariant: nextRoom.artVariant,
      seed: state.seed,
    });
  }

  await populateSlotEncounter(scene, slot, {
    prefillTraits: state.traits,
    prefillExcludeTraits: state.excludeTraits,
    levelOffsetBias: depthBiasFor({
      physicalSlot: slot,
      roomCount: state.rooms.length,
      isGoal: nextRoom.isGoal,
    }),
    locationTag: nextRoom.locationTag,
    seed: state.seed,
  });
  if (isSlotPopulated(scene, slot)) await unlockDoorToSlot(scene, slot);
}

export async function abandonDungeonRun(sceneId) {
  const scene = game.scenes.get(sceneId);
  const state = getRunState(sceneId);
  await abandonRun({ sceneId });
  if (scene)
    await teardownDungeonRun(scene, {
      previousSceneId: state?.previousSceneId ?? null,
    });
}

export class DungeonApp extends HandlebarsApplicationMixin(ApplicationV2) {
  static DEFAULT_OPTIONS = {
    id: "dommt-dungeon-app",
    tag: "section",
    window: { title: "PF2EDC.Dungeon.Title", icon: "fa-solid fa-dungeon" },
    position: { width: 480, height: "auto" },
    actions: {
      start: DungeonApp.#onStart,
      succeed: DungeonApp.#onSucceed,
      fail: DungeonApp.#onFail,
      populateNext: DungeonApp.#onPopulateNext,
      undo: DungeonApp.#onUndo,
      abandon: DungeonApp.#onAbandon,
      declareVictory: DungeonApp.#onDeclareVictory,
      declareDefeat: DungeonApp.#onDeclareDefeat,
      startCombatRecovery: DungeonApp.#onStartCombatRecovery,
      openCombatTracker: DungeonApp.#onOpenCombatTracker,
      hide: DungeonApp.#onHide,
      attemptSkillChallenge: DungeonApp.#onAttemptSkillChallenge,
      attemptPuzzleStage: DungeonApp.#onAttemptPuzzleStage,
      continueNarrative: DungeonApp.#onContinueNarrative,
      chooseNarrativeOption: DungeonApp.#onChooseNarrativeOption,
      claimTreasure: DungeonApp.#onClaimTreasure,
    },
  };

  static PARTS = {
    main: { template: `modules/${MODULE_ID}/templates/dungeon-tracker.hbs` },
  };

  async _prepareContext() {
    const scene = canvas?.scene ?? null;
    const sceneId = scene?.id ?? null;
    if (!sceneId) return { hasScene: false };

    let state = getRunState(sceneId);
    // A run created before physical scenes existed (Tier 1) has no
    // physicalSlotByRoomId at all — it predates the shape this app now
    // assumes, and there's no real geometry behind it to resume. Rather than
    // crash on every render, clear it and let the GM start fresh.
    // #109: gated on game.user.isGM, not just "some state exists" — a
    // read-only broadcast viewer's render must never delete the run entry
    // for everyone. This legacy-migration path only ever needs to run once,
    // for a GM, since every run createRun produces today always carries
    // physicalSlotByRoomId already.
    if (state && !state.physicalSlotByRoomId && game.user.isGM) {
      await abandonRun({ sceneId });
      ui.notifications.info(
        game.i18n.localize("PF2EDC.Dungeon.StaleRunCleared"),
      );
      state = null;
    }
    if (!state) {
      const availableTraits = await makeFoundryApi().listCreatureTraits();
      return {
        hasScene: true,
        hasRun: false,
        defaultRoomCount: 6,
        availableTraits,
        traitsFieldHtml: traitFieldHtml({
          name: "traits",
          label: game.i18n.localize("PF2EDC.Encounter.ThemeLabel"),
          buttonLabel: game.i18n.localize("PF2EDC.Encounter.ChooseTraitsButton"),
        }),
        excludeTraitsFieldHtml: traitFieldHtml({
          name: "excludeTraits",
          label: game.i18n.localize("PF2EDC.Encounter.ExcludeTraitsLabel"),
          buttonLabel: game.i18n.localize("PF2EDC.Encounter.ChooseTraitsButton"),
        }),
      };
    }

    const setpieces = await loadDungeonSetpieces();
    const setpiecesById = new Map(setpieces.map((s) => [s.id, s]));
    const currentRoom = state.rooms[state.currentIndex] ?? null;
    const setpiece = currentRoom?.setpieceId
      ? setpiecesById.get(currentRoom.setpieceId)
      : null;
    const currentRoomResolved =
      !!currentRoom && state.history.some((h) => h.roomId === currentRoom.id);

    const nextRoom = state.rooms[state.currentIndex + 1] ?? null;
    const nextSlot = nextRoom ? state.physicalSlotByRoomId[nextRoom.id] : null;
    const nextRoomPending = !!(
      nextRoom &&
      nextRoom.kind === "combat" &&
      nextSlot != null &&
      !isSlotPopulated(scene, nextSlot)
    );

    const currentSlot = currentRoom
      ? state.physicalSlotByRoomId[currentRoom.id]
      : null;
    const isCombatRoom = currentRoom?.kind === "combat" && !currentRoomResolved;
    const isSafeEntry = currentRoom?.kind === "safe_entry";
    const isSafeRest = currentRoom?.kind === "safe_rest";
    const activeCombat =
      isCombatRoom && currentSlot != null
        ? getCombatForSlot(scene, currentSlot)
        : null;

    // #109: whether THIS client may act on the run, not just whether one
    // exists — false for every read-only broadcast viewer, and also false
    // for the run's own host once any GM connects (see dungeon-permissions.mjs).
    const interactive = canActOnDungeon(state);
    const hostName = state.hostUserId
      ? (game.users.get(state.hostUserId)?.name ?? "?")
      : null;

    // #162/#109: the challenge (including its #164 template, if any) is
    // attached at room-build time (dungeon-scene.mjs's
    // buildPopulateAndUnlockRoom), not lazily on render — a client logged
    // in only to relay a GM-less host's requests never renders DungeonApp
    // at all, so a render-time write would never happen for such a run.
    // This is a pure read of whatever's already persisted; #166's
    // `name`/`summary`/`skillFlavor` customization fields are read
    // straight back off the challenge the same way.
    const isSkillChallenge =
      currentRoom?.kind === "skill_challenge" && !currentRoomResolved;
    let challenge = null;
    if (isSkillChallenge && currentRoom.challenge) {
      const raw = currentRoom.challenge;
      challenge = {
        vp: raw.vp,
        vpTarget: raw.vpTarget,
        attemptsRemaining: raw.attemptBudget - raw.attemptsUsed,
        templateName: raw.name,
        templateSummary: raw.summary,
        specialtySkills: raw.specialtySkills.map((slug) => ({
          slug,
          label: skillLabel(slug),
          flavor: raw.skillFlavor?.[slug] ?? null,
        })),
        allSkills: ALL_SKILLS.map((slug) => ({
          slug,
          label: skillLabel(slug),
          isSpecialty: raw.specialtySkills.includes(slug),
        })),
      };
    }

    // #137/#109: a puzzle_or_trap room whose resolved setpiece is
    // puzzle-kind uses its own hint-check UI instead of the plain
    // Succeed/Fail buttons — fully auto-resolving (per live discussion),
    // so there's no GM judgment step the way the plain buttons need;
    // resolveCurrentRoom is still what actually advances the room, called
    // automatically once recordPuzzleStageAttempt's own reducer sets
    // `resolved`, the same "only once resolved" gating
    // #onAttemptSkillChallenge already uses. The puzzle's own state is
    // attached at room-build time (dungeon-scene.mjs's
    // buildPopulateAndUnlockRoom), not lazily here — this is a pure read
    // of whatever's already persisted, same reasoning as the
    // skill_challenge block above.
    const isPuzzleRoom =
      currentRoom?.kind === "puzzle_or_trap" &&
      setpiece?.kind === "puzzle" &&
      !currentRoomResolved;
    let puzzle = null;
    if (isPuzzleRoom && currentRoom.puzzle) {
      // #139: persisted onto the puzzle itself so applyPuzzleCustomization
      // has a stable place to overwrite that actually sticks across
      // renders — read back below via raw.name/raw.summary, never
      // setpiece.name/setpiece.summary directly, the same "persisted
      // state wins over the raw template" rule skill_challenge's own
      // templateName/templateSummary already follow.
      const raw = currentRoom.puzzle;
      puzzle = {
        name: raw.name,
        summary: raw.summary,
        requiredSuccesses: raw.requiredSuccesses,
        successes: raw.successes,
        resolved: raw.resolved,
        // Narrative payoff shown once solved, never during play — #137's
        // own live-discussed model has no GM judgment step reading this
        // as "the correct answer" the way the source book's puzzle text
        // implies; it's flavor color for the reveal, not a check.
        solution:
          raw.resolved === "success" ? (setpiece.solution ?? null) : null,
        stages: raw.stages.map((s, i) => ({
          index: i,
          skill: s.skill,
          skillLabel: skillLabel(s.skill),
          dc: s.dc,
          attempted: s.attempted,
          succeeded: s.succeeded,
          // #139: an agent's customized stageFlavor entry for this stage
          // overrides the displayed hint text once revealed — never the
          // stage's own mechanically-real hint field itself (stored
          // separately, untouched by applyPuzzleCustomization).
          hint: s.succeeded ? (raw.stageFlavor?.[i] ?? s.hint) : null,
        })),
      };
    }

    // #163: a narrative room is never succeeded/failed the way every other
    // resolvable room kind is — it's not a check or a fight, so it always
    // resolves as succeeded (still running the room's own Reward-side
    // Journey Spread outcome via the usual markRoomOutcome/resolveCurrentRoom
    // path, just never the Ruin side) via a single Continue action instead
    // of the plain Succeed/Fail choice.
    const isNarrativeRoom =
      currentRoom?.kind === "narrative" && !currentRoomResolved;
    // #167: read from the room's own *persisted* narrative state (attached
    // at room-build time by dungeon-scene.mjs's ensureNarrativeState), not
    // straight off the raw setpiece the way #165 originally did — a
    // persisted copy is what gives an external agent's customization
    // somewhere durable to land (see ensureNarrativeState's own docblock)
    // instead of being silently overwritten by the shared template on the
    // very next render, the same invisible-customization bug #139 already
    // caught and fixed for puzzles.
    let narrative = null;
    if (isNarrativeRoom && currentRoom.narrative) {
      const raw = currentRoom.narrative;
      narrative = {
        archetype: raw.archetype,
        name: raw.name,
        summary: raw.summary,
        revealText: raw.revealText ?? null,
        npcName: raw.npcName ?? null,
        npcHook: raw.npcHook ?? null,
        options: raw.options ?? null,
        suggestedObjective: raw.suggestedObjective ?? null,
      };
    }
    // #169: a treasure room, like a narrative room, is never succeeded/
    // failed the plain way — it always has something to find, so claiming
    // it always succeeds (still running the usual Reward-side Journey
    // Spread outcome via resolveCurrentRoom/markRoomOutcome).
    const isTreasureRoom =
      currentRoom?.kind === "treasure" && !currentRoomResolved;

    return {
      hasScene: true,
      hasRun: true,
      interactive,
      hostName,
      sceneId,
      currentSlot,
      // Not rendered — just threaded to _onRender's own focusCameraOnSlot
      // call, which needs it to know the current room's actual size (ITEM-17).
      seed: state.seed,
      completed: state.completed,
      // Neither the entry nor a mid-dungeon rest room (ITEM-5) count toward
      // the room total the GM asked for — currentIndex 1 is real room 1 of
      // roomTotal, not room 2 of roomTotal+1, and a rest room further along
      // doesn't bump either number for the rooms after it.
      roomNumber: state.rooms
        .slice(0, state.currentIndex + 1)
        .filter((r) => !UNCOUNTED_ROOM_KINDS.has(r.kind)).length,
      roomTotal: state.rooms.filter((r) => !UNCOUNTED_ROOM_KINDS.has(r.kind))
        .length,
      currentRoomResolved,
      nextRoomPending,
      canUndo: canUndoRoomEntry(state),
      isSafeEntry,
      isSafeRest,
      isSafeRoom: isSafeEntry || isSafeRest,
      // A combat room never uses the plain Succeed/Fail buttons — it's
      // either mid-fight (combatActive) or something interrupted Combat's
      // own creation and needs the recovery button (combatMissing).
      isCombatRoom,
      combatActive: !!activeCombat,
      combatMissing: isCombatRoom && !activeCombat,
      // #162: a skill_challenge room uses its own Victory Point UI instead
      // of the plain Succeed/Fail buttons every other resolvable room kind
      // still uses.
      isSkillChallenge,
      challenge,
      // #137: a puzzle room uses its own hint-check UI instead of the
      // plain Succeed/Fail buttons.
      isPuzzleRoom,
      puzzle,
      // #163: a narrative room's own "direction for the rest of the run" —
      // run-wide, not per-room, so it's shown here regardless of which
      // room kind is actually current, the same way it persists in
      // `state.objective` regardless of which room set it.
      isNarrativeRoom,
      // #165: the selected archetype's own extra fields (revealText,
      // npcName/npcHook, options, suggestedObjective) — null when the room
      // has no valid narrative template (no set-pieces available yet, or
      // this run predates #165).
      narrative,
      isTreasureRoom,
      objective: state.objective ?? null,
      partyMembers: (game.actors?.party?.members ?? [])
        .filter((m) => m.type === "character")
        .map((m) => ({ id: m.id, name: m.name })),
      currentRoom: currentRoom && {
        isGoal: currentRoom.isGoal,
        kind: currentRoom.kind,
        kindLabel: game.i18n.localize(
          ROOM_KIND_KEYS[currentRoom.kind] ?? currentRoom.kind,
        ),
        // #139/#167: prefers the puzzle's or narrative room's own
        // *persisted* name/summary (which an agent's applyPuzzleCustomization/
        // applyNarrativeCustomization may have overwritten) over the raw
        // setpiece template's — this is the one generic display block every
        // room kind's name/summary renders through, so either kind's
        // customization needs to flow through here to be visible at all,
        // not just in its own kind-specific block below.
        setpiece: setpiece && {
          name: puzzle?.name ?? narrative?.name ?? setpiece.name,
          summary: puzzle?.summary ?? narrative?.summary ?? setpiece.summary,
          complete: setpiece.complete,
        },
      },
      traits: state.traits.join(", "),
      excludeTraits: state.excludeTraits.join(", "),
      history: state.history
        .slice()
        .reverse()
        .map((h) => ({
          ...h,
          effectLabel: game.i18n.localize(
            EFFECT_KEYS[h.effectKey] ?? h.effectKey,
          ),
          outcomeLabel: game.i18n.localize(
            `PF2EDC.Dungeon.Outcome.${h.outcome}`,
          ),
        })),
    };
  }

  _onRender(context, options) {
    super._onRender(context, options);
    wireTraitPickerButtons(this.element, context.availableTraits ?? []);
    // Re-frame the current room on every render, not just on the one-shot
    // automatic room-entry trigger — see focusCameraOnSlot's own docs for why
    // that trigger alone isn't reliable with a five-token party.
    if (context.currentSlot != null && canvas?.scene?.id === context.sceneId) {
      focusCameraOnSlot(canvas.scene, context.currentSlot, context.seed);
    }
    // #109: a read-only broadcast viewer sees every control disabled
    // except Hide, which only closes their own local window. This is a
    // UI nicety, not the real enforcement — every mutating handler below
    // branches on game.user.isGM (direct call if GM, else routes a
    // request over the relay), and the GM-side relay handler is what
    // actually authorizes a routed request against the run's own tracked
    // host before executing it (see dungeon-remote.mjs).
    if (context.hasRun && !context.interactive) {
      // Not just `footer button[data-action]` — the skill-challenge
      // (#onAttemptSkillChallenge) and narrative (#onContinueNarrative)
      // action buttons live inside their own <form>, not the footer.
      // Scoped to .window-content, not the whole element — the frame's own
      // header also has data-action buttons (close, toggleControls) that
      // must stay usable for a read-only viewer.
      this.element
        .querySelectorAll(".window-content button[data-action]")
        .forEach((btn) => {
          if (btn.dataset.action !== "hide") btn.disabled = true;
        });
    }
  }

  /**
   * Builds a fresh run's entry room, first real room, party placement, and
   * scene activation — the actual privileged work `#onStart` either does
   * directly (a GM) or asks the GM-side relay to do (dungeon-remote.mjs's
   * "startRun" action, for a non-GM host). Never touches `canvas?.scene` —
   * see this plan's Global Constraints.
   */
  static async #onStart() {
    const form = this.element.querySelector("form");
    const roomCount = Math.max(
      2,
      parseInt(form?.querySelector('[name="roomCount"]')?.value ?? "6", 10),
    );
    const traits = readTraitField(this.element, "traits");
    const excludeTraits = readTraitField(this.element, "excludeTraits");
    // Wherever the GM/party were right before starting — teardownDungeonRun
    // (ITEM-18) sends them back here if this run is later abandoned.
    const previousSceneId = canvas?.scene?.id ?? null;

    if (game.user.isGM) {
      await startDungeonRun({
        roomCount,
        traits,
        excludeTraits,
        previousSceneId,
        hostUserId: null,
      });
    } else {
      await requestDungeonAction(
        "startRun",
        {
          roomCount,
          traits,
          excludeTraits,
          previousSceneId,
        },
        { timeoutMs: 60_000 },
      );
    }
    this.render();
  }

  static async #onSucceed() {
    await DungeonApp.#resolveRoom(this, true);
  }
  static async #onFail() {
    await DungeonApp.#resolveRoom(this, false);
  }

  static async #resolveRoom(app, succeeded) {
    const sceneId = canvas?.scene?.id;
    if (!sceneId) return;
    if (game.user.isGM) {
      await resolveCurrentRoom(succeeded, { scene: game.scenes.get(sceneId) });
    } else {
      await requestDungeonAction("resolveRoom", { sceneId, succeeded });
    }
    app.render();
  }

  /**
   * Rolls the form's own selected actor/skill against the current room's
   * challenge (#162), records the attempt, and — only once the challenge
   * actually resolves — hands off to the same `resolveCurrentRoom` every
   * other room kind uses, so a skill challenge's own success/failure
   * consequences flow through the exact same room-resolution path combat,
   * traps, and puzzles already do. A no-op if the form has nothing
   * selected, or the roll itself came back empty (`actor.skills[skill]`
   * missing — shouldn't happen for a real `ALL_SKILLS` slug, guarded
   * anyway rather than trusted blind).
   */
  static async #onAttemptSkillChallenge() {
    const scene = canvas?.scene;
    const sceneId = scene?.id;
    const state = sceneId ? getRunState(sceneId) : null;
    const currentRoom = state?.rooms[state.currentIndex];
    if (!currentRoom?.challenge) return;

    const form = this.element.querySelector(
      ".dommt-dungeon__skill-challenge-form",
    );
    const actorId = form?.querySelector('[name="actorId"]')?.value;
    const skill = form?.querySelector('[name="skill"]')?.value;
    const actor = actorId ? game.actors.get(actorId) : null;
    if (!actor || !skill) return;

    const dc = dcForAttempt({
      partyLevel: await makeFoundryApi().partyLevel(),
      skill,
      specialtySkills: currentRoom.challenge.specialtySkills,
    });
    const result = await rollSkillChallengeAttempt(actor, skill, dc);
    if (!result) return;

    if (game.user.isGM) {
      await recordSkillChallengeOutcome(
        sceneId,
        currentRoom.id,
        result.outcome,
      );
    } else {
      await requestDungeonAction("recordSkillChallengeOutcome", {
        sceneId,
        roomId: currentRoom.id,
        outcome: result.outcome,
      });
    }
    this.render();
  }

  /**
   * Rolls the selected actor against one puzzle stage's own fixed
   * skill/DC (#137 — unlike a skill challenge, a stage's skill isn't the
   * player's choice), records the attempt, and — only once the puzzle
   * actually resolves (auto-resolving, no GM judgment step) — hands off
   * to `resolveCurrentRoom`, the same "only once resolved" gating
   * `#onAttemptSkillChallenge` already uses. `target` is the clicked
   * button (Foundry's own ApplicationV2 action-handler signature); its
   * own `data-stage-index` says which stage's form to read the chosen
   * actor from. A no-op if the stage doesn't exist, was already
   * attempted, or the form has no actor selected.
   */
  static async #onAttemptPuzzleStage(event, target) {
    const sceneId = canvas?.scene?.id;
    const state = sceneId ? getRunState(sceneId) : null;
    const currentRoom = state?.rooms[state.currentIndex];
    if (!currentRoom?.puzzle) return;

    const stageIndex = Number(target?.dataset?.stageIndex);
    const stage = currentRoom.puzzle.stages[stageIndex];
    if (!stage || stage.attempted) return;

    const form = this.element.querySelector(
      `.dommt-dungeon__puzzle-stage-form[data-stage-index="${stageIndex}"]`,
    );
    const actorId = form?.querySelector('[name="actorId"]')?.value;
    const actor = actorId ? game.actors.get(actorId) : null;
    if (!actor) return;

    const result = await rollPuzzleStageAttempt(actor, stage.skill, stage.dc);
    if (!result) return;

    if (game.user.isGM) {
      await recordPuzzleStageOutcome(
        sceneId,
        currentRoom.id,
        stageIndex,
        result.outcome,
      );
    } else {
      await requestDungeonAction("recordPuzzleStageOutcome", {
        sceneId,
        roomId: currentRoom.id,
        stageIndex,
        outcome: result.outcome,
      });
    }
    this.render();
  }

  /**
   * A narrative room's own resolution (#163): saves whatever's in the
   * objective textarea (if anything — a blank field just leaves whatever
   * objective was already set alone, `setObjective` itself only clears on
   * an explicit `null`/whitespace-only call, and an empty textarea here
   * means "nothing new to set," not "clear it") and always resolves the
   * room succeeded, since a narrative beat has nothing to fail.
   */
  static async #onContinueNarrative() {
    const sceneId = canvas?.scene?.id;
    if (!sceneId) return;
    const textarea = this.element.querySelector(
      '[name="dommt-narrative-objective"]',
    );
    const objective = textarea?.value?.trim() || null;
    if (game.user.isGM) {
      await continueNarrativeRoom(sceneId, objective);
    } else {
      await requestDungeonAction("continueNarrativeRoom", {
        sceneId,
        objective,
      });
    }
    this.render();
  }

  /**
   * A choice-archetype narrative room's own resolution (#208) — see
   * chooseNarrativeOption's own comment for what picking an option does.
   * `target.dataset.optionIndex` is set per-button by the template's own
   * `{{@index}}`, same indexed-dataset pattern #137's puzzle-stage buttons
   * already use.
   */
  static async #onChooseNarrativeOption(event, target) {
    const sceneId = canvas?.scene?.id;
    if (!sceneId) return;
    const optionIndex = Number(target?.dataset?.optionIndex);
    if (Number.isNaN(optionIndex)) return;
    if (game.user.isGM) {
      await chooseNarrativeOption(sceneId, optionIndex);
    } else {
      await requestDungeonAction("chooseNarrativeOption", {
        sceneId,
        optionIndex,
      });
    }
    this.render();
  }

  /**
   * A treasure room's own resolution (#169) — see claimTreasureFor above for
   * the actual coin grant + resolution logic, routed the same isGM-direct-
   * vs-relayed way every other mutating action is.
   */
  static async #onClaimTreasure() {
    const sceneId = canvas?.scene?.id;
    if (!sceneId) return;
    if (game.user.isGM) {
      await claimTreasureFor(sceneId);
    } else {
      await requestDungeonAction("claimTreasure", { sceneId });
    }
    this.render();
  }

  /** Manual GM override — always available while a combat room's Combat is
   * active, alongside the automatic all-one-side-defeated detection.
   * `DungeonApp.#declareOutcome(this, ...)`, not `this.constructor...` —
   * a private static called this way is a plain function call, so `this`
   * has to be threaded through explicitly rather than relying on the
   * instance binding Foundry's action dispatcher gives #onDeclareVictory
   * itself. */
  static async #onDeclareVictory() {
    await DungeonApp.#declareOutcome(this, true);
  }
  static async #onDeclareDefeat() {
    await DungeonApp.#declareOutcome(this, false);
  }

  static async #declareOutcome(app, succeeded) {
    const sceneId = canvas?.scene?.id;
    if (!sceneId) return;
    if (game.user.isGM) {
      await resolveCombatRoomOutcome(sceneId, succeeded);
    } else {
      await requestDungeonAction("declareOutcome", { sceneId, succeeded });
    }
    app.render();
  }

  /** Recovery-only — mirrors #onPopulateNext's own safety-net precedent for
   * when something (a reload mid-flow, say) left a combat room without a
   * Combat despite its monsters already being visible. */
  static async #onStartCombatRecovery() {
    const sceneId = canvas?.scene?.id;
    if (!sceneId) return;
    if (game.user.isGM) {
      await startCombatRecoveryFor(sceneId);
    } else {
      await requestDungeonAction("startCombatRecovery", { sceneId });
    }
    this.render();
  }

  static #onOpenCombatTracker() {
    ui.sidebar.activateTab("combat");
  }

  /** #158: a plain, explicit "close this for a bit" affordance, distinct
   * from Abandon (which deletes the whole run) — this only closes the
   * rendered window, exactly what the standard window-chrome close button
   * already does (confirmed live: no `_onClose` override exists on this
   * class, so `close()` here has no side effect on the persisted run
   * state). Needed once #158's auto-open makes the tracker pop open on its
   * own more often — a labeled in-content button makes it obvious this is
   * safe to dismiss, rather than relying on the small title-bar X. */
  static #onHide() {
    this.close();
  }

  static async #onPopulateNext() {
    const sceneId = canvas?.scene?.id;
    if (!sceneId) return;
    if (game.user.isGM) {
      await populateNextRoom(sceneId);
    } else {
      await requestDungeonAction("populateNext", { sceneId });
    }
    this.render();
  }

  static async #onUndo() {
    const sceneId = canvas?.scene?.id;
    if (!sceneId) return;
    if (game.user.isGM) {
      await undoRoomEntry(sceneId);
    } else {
      await requestDungeonAction("undoRoomEntry", { sceneId });
    }
    this.render();
  }

  /**
   * Cancels the run (ITEM-18): confirms first — this now does far more than
   * clear a settings entry, it moves the party out, deletes every NPC actor
   * the run's encounters spawned, and deletes the dungeon scene itself, none
   * of which is undoable. The confirmation itself always happens locally
   * (it's just a prompt); only the actual teardown is routed for a non-GM
   * host.
   */
  static async #onAbandon() {
    const sceneId = canvas?.scene?.id;
    if (!sceneId) return;

    const confirmed = await foundry.applications.api.DialogV2.confirm({
      window: { title: game.i18n.localize("PF2EDC.Dungeon.AbandonButton") },
      content: `<p>${game.i18n.localize("PF2EDC.Dungeon.AbandonConfirm")}</p>`,
      rejectClose: false,
    });
    if (!confirmed) return;

    if (game.user.isGM) {
      await abandonDungeonRun(sceneId);
    } else {
      await requestDungeonAction(
        "abandonRun",
        { sceneId },
        { timeoutMs: 60_000 },
      );
    }
    this.close();
  }
}
