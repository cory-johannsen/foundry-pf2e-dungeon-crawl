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
  roomsToEagerlyBuild,
  replaceRunState,
  // commitEagerPhysicalSlots/roomsNeedingResync (and dungeon-scene.mjs's
  // buildPopulateAndUnlockRoom below) are still referenced only by
  // resolveCurrentRoom's already-unreachable mutation-resync/next-room
  // block — Task 13 rewrites resolveCurrentRoom and drops them.
  commitEagerPhysicalSlots,
  roomsNeedingResync,
  clearPuzzleState,
  clearSkillChallengeState,
  clearNarrativeState,
  clearTrapState,
  clearTreasureState,
} from "../dungeon-runner.mjs";
import { canActOnDungeon } from "../dungeon-permissions.mjs";
import { requestDungeonAction } from "../dungeon-remote.mjs";
import {
  lootGpForTreasureRoom,
  seededPick,
  treasureRoomItemTableName,
} from "../dungeon-deck.mjs";
import { makeFoundryApi, drawTreasureItem } from "../foundry-api.mjs";
import { xpFor } from "../encounter-roster.mjs";
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
  openGoalRoomExit,
  placePartyInRoom,
  undoRoomEntry,
  focusCameraOnRoom,
  teardownDungeonRun,
  buildPopulateAndUnlockRoom,
  buildPopulateAndUnlockGraphNode,
  resizeSceneForLayout,
  unlockDoorsFromRoom,
  sweepCompletedDungeonScene,
  clearSlotEncounter,
  clearSlotTrap,
  unsealHiddenDoorFromRoom,
} from "../dungeon-scene.mjs";
import {
  startCombatForRoom,
  getCombatForRoom,
  resolveSlotCombat,
  unpauseIfGmLessRun,
} from "../dungeon-combat.mjs";
import { getGenerator } from "../generator-registry.mjs";
import { computeRanks, computeColumns } from "../dungeon-layout.mjs";

const MODULE_ID = "pf2e-dungeon-crawl";
const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

// Same escape-before-interpolating-into-chat-HTML convention as
// dungeon-combat.mjs's postReactiveStrikeChat and dungeon-critical-deck.mjs's
// `esc` -- a drawn item's name (#88) is real PF2e compendium content, not
// player input, but nothing here guarantees it can never carry HTML-special
// characters.
function escapeHtml(value) {
  return foundry.utils.escapeHTML?.(String(value)) ?? String(value);
}

const ROOM_KIND_KEYS = {
  combat: "PF2EDC.Dungeon.Kind.combat",
  skill_challenge: "PF2EDC.Dungeon.Kind.skill_challenge",
  puzzle: "PF2EDC.Dungeon.Kind.puzzle",
  trap: "PF2EDC.Dungeon.Kind.trap",
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
  // Captured before markRoomOutcome advances currentIndex — both the XP
  // grant below and applyRoomEffect's treasure-gp calc need the room that
  // was just resolved, not whatever comes next.
  const preState = getRunState(scene.id);
  const currentRoom = preState?.rooms[preState.currentIndex];
  const physicalSlot = currentRoom
    ? preState.physicalSlotByRoomId[currentRoom.id]
    : null;
  // #30/#32: a trap room grants XP on success here, whether or not a real
  // hazard actor ended up spawned for it. This is the one place both the
  // direct-GM and GM-less-relay resolution paths converge (dungeon-remote.mjs's
  // own "resolveRoom" action calls this same function) — every other room
  // kind grants its own XP before ever calling this (combat via
  // resolveSlotCombat/resolveCombat, skill challenges/puzzles via
  // recordSkillChallengeOutcome/recordPuzzleStageOutcome above — a puzzle
  // room's XP is granted there, not here). Narrative and treasure grant no
  // XP here either — neither has a pass/fail mechanic GM Core's non-combat
  // XP guidance applies to.
  if (succeeded && currentRoom?.kind === "trap") {
    const trapToken = scene.tokens.find(
      (t) =>
        t.getFlag(MODULE_ID, "trapHazard") &&
        t.getFlag(MODULE_ID, "dungeonSlot") === physicalSlot,
    );
    const trapLevel = trapToken?.actor?.system?.details?.level?.value;
    const levelOffset =
      trapLevel != null ? trapLevel - (await makeFoundryApi().partyLevel()) : 0;
    await makeFoundryApi().grantPartyXp(xpFor(levelOffset));
  }
  // #93/#156: markRoomOutcome no longer returns mutation/nextRoomId/
  // nextPhysicalSlot at all (that whole sequence-splicing/physical-slot-
  // assignment model is gone — every room is eagerly built up front now,
  // see roomsToEagerlyBuild). They're destructured here anyway (always
  // undefined) purely so the mutation-resync block and the `!nextRoomId`
  // early-return below it stay syntactically intact rather than throwing a
  // ReferenceError — both blocks are already permanently unreachable/no-op
  // dead code as a result, left for a later task in this plan to remove
  // outright alongside the rest of the one-room-ahead build path.
  const { state, effectKey, mutation, nextRoomId, nextPhysicalSlot, revealedRoomId } =
    await markRoomOutcome(
      { sceneId: scene.id, succeeded },
      {
        // #32/#165: each kind draws from its own filtered pool, so a
        // puzzle or trap room's own draw can never land on a skill_challenge
        // or narrative entry (those never use setpieceId at all —
        // skill_challenge picks its own template separately, and neither
        // would populate anything if drawn here).
        puzzleSetpieceIds: setpieces
          .filter((s) => s.kind === "puzzle")
          .map((s) => s.id),
        trapSetpieceIds: setpieces
          .filter((s) => s.kind === "trap")
          .map((s) => s.id),
        narrativeSetpieceIds: setpieces
          .filter((s) => s.kind === "narrative")
          .map((s) => s.id),
        treasureSetpieceIds: setpieces
          .filter((s) => s.kind === "treasure")
          .map((s) => s.id),
      },
    );
  if (currentRoom && effectKey) {
    await applyRoomEffect(effectKey, {
      seed: preState.seed,
      roomId: currentRoom.id,
      physicalSlot,
      roomCount: preState.rooms.length,
      isGoal: currentRoom.isGoal,
      scene,
      revealedRoomId,
    });
  }
  if (mutation === "rerun_encounter")
    ui.notifications.warn(
      game.i18n.localize("PF2EDC.Dungeon.RerunEncounterHint"),
    );
  // #62: a GM-less-hosted run already eagerly built its whole sequence
  // (startDungeonRun's own roomsToEagerlyBuild loop) — a Reward/Ruin
  // sequence mutation (remove_next/insert_after) firing here shifts which
  // logical room belongs at each already-built physical slot from this
  // point on. Without reconciling that now, the party would walk into a
  // physically-built slot showing the WRONG room's content (or, past the
  // old tail, a slot with no content at all). A GM-hosted run
  // (state.hostUserId null) never eagerly builds ahead — it has nothing to
  // reconcile, and its existing one-room-ahead build below (the
  // buildPopulateAndUnlockRoom(scene, state, nextRoom, nextPhysicalSlot)
  // call past the `!nextRoomId` guard) already handles a mutation
  // correctly today, unchanged.
  // markRoomOutcome's own `nextPhysicalSlot` return value is computed from
  // the PRE-mutation physicalSlotByRoomId via its plain reuse-or-allocate
  // logic (see its own docblock) — it has no idea a GM-less run's eager
  // build already occupies every slot by array index, and no idea
  // roomsNeedingResync is about to renumber the shifted tail. For a
  // remove_next mutation, nextRoomId's OLD slot entry still exists (from
  // its own original eager build further down the sequence), so
  // markRoomOutcome's `nextRoomId in physicalSlotByRoomId` reuse branch
  // returns that STALE old slot, not its new one. For insert_after,
  // nextRoomId is a brand-new room with no old entry, so markRoomOutcome
  // falls to its `nextPhysicalSlot` running counter instead — a number
  // from a completely different, non-eager numbering scheme, unrelated to
  // roomsNeedingResync's array-index slot for it. Either way, blindly
  // trusting the returned `nextPhysicalSlot` below would build/unlock the
  // WRONG door. `resolvedNextPhysicalSlot` is corrected from the
  // resync's own authoritative `toRebuild` list once computed just below;
  // it stays as-is (correct, unchanged) for a GM-hosted run, which never
  // eagerly builds ahead and so never hits this mismatch.
  let resolvedNextPhysicalSlot = nextPhysicalSlot;
  if (mutation && state.hostUserId) {
    const { toRebuild, toOrphan } = roomsNeedingResync(
      state,
      preState.physicalSlotByRoomId,
      state.currentIndex,
    );
    // The goal room's identity is unaffected by any mutation
    // (applySequenceMutation never targets it — see the design doc), so
    // this is the same room id whether read from the pre- or post-mutation
    // rooms array. What changes is which physical slot it occupies (a
    // fresh one, via toExtend below) — the OLD slot it used to occupy is
    // what needs its outgoing wall retrofitted, identified by matching a
    // toRebuild entry's own previousRoomId against this id.
    const previousGoalRoomId = preState.rooms.find((r) => r.isGoal)?.id;
    // Each toRebuild entry is a physical slot that now needs a DIFFERENT
    // logical room's content than whatever it was eagerly built with
    // before the mutation (an extended slot, per Task 5's own report,
    // always also appears here — buildPopulateAndUnlockRoom's isSlotBuilt
    // guard (Task 3) does a real build for it, same as any other slot that
    // was never physically built at all). Teardown+rebuild happens one
    // slot at a time, not the whole range up front, so a failure partway
    // through leaves at most one slot mid-repair rather than every slot
    // torn down with nothing rebuilt.
    for (const { room, physicalSlot, previousRoomId } of toRebuild) {
      // #62 Task 7: the room that used to occupy this slot was the goal —
      // built with hasOutgoing:false and no frontier placeholder, so its
      // one outgoing-face wall is a full solid enclosure wall nothing else
      // can find or remove. A non-goal room is about to occupy this slot
      // instead, so it needs a real outgoing connection: swap that stale
      // wall for the same frontier-placeholder wall a non-goal room gets
      // from its own original build, before any other teardown/rebuild
      // below touches this slot.
      if (previousRoomId === previousGoalRoomId) {
        await openGoalRoomExit(scene, physicalSlot, state.seed);
      }
      // Foundry-side teardown of whatever's currently AT this slot (the
      // stale room's tokens/actors) — clearSlotEncounter/clearSlotTrap key
      // purely off the slot's own dungeonSlot flag, not room identity, so
      // this is correct regardless of what kind the stale room was.
      await clearSlotEncounter(scene, physicalSlot);
      await clearSlotTrap(scene, physicalSlot);
      // Reset whatever persisted content state the room being PLACED here
      // already carries from its own original eager build (at a different
      // physical slot) — a skill_challenge's DC is calibrated by
      // depthBiasFor(physicalSlot), so reusing state generated for the
      // old slot would leave it mis-calibrated for the new one; a trap's
      // persisted name/description (ensureTrapState) would otherwise keep
      // pointing at the just-deleted hazard actor once a fresh one spawns
      // below. All five are no-ops when the room has nothing of that type
      // to clear (Task 4; #89 added clearTreasureState to this same set),
      // so calling every one unconditionally is safe and reads more
      // clearly here than re-deriving which single type this room's kind
      // implies.
      await clearPuzzleState(scene.id, room.id);
      await clearSkillChallengeState(scene.id, room.id);
      await clearNarrativeState(scene.id, room.id);
      await clearTrapState(scene.id, room.id);
      await clearTreasureState(scene.id, room.id);
      // unlock: false — this only re-establishes correct CONTENT at each
      // shifted slot; door-unlock order is still governed by the normal
      // resolution-order gate (the unchanged buildPopulateAndUnlockRoom
      // call below unlocks the door to whatever's now genuinely next).
      await buildPopulateAndUnlockRoom(scene, state, room, physicalSlot, {
        unlock: false,
      });
    }
    // A slot that fell off the end of the (now-shorter) sequence entirely
    // — remove_next only, since insert_after only ever grows the tail.
    for (const orphanSlot of toOrphan) {
      await clearSlotEncounter(scene, orphanSlot);
      await clearSlotTrap(scene, orphanSlot);
    }
    if (toRebuild.length) {
      await commitEagerPhysicalSlots(
        scene.id,
        toRebuild.map(({ room, physicalSlot }) => ({ room, physicalSlot })),
      );
    }
    // toRebuild always starts at physicalSlot === state.currentIndex + 1
    // (mutationBoundaryIndex + 1) for both remove_next (the removed room
    // WAS that slot, so whatever now occupies it differs) and insert_after
    // (the newly-inserted room IS that slot, brand new) — which is exactly
    // nextRoomId's own array position, so this lookup always finds an
    // entry whenever nextRoomId is non-null and mutation actually changed
    // the sequence.
    const nextRebuildEntry = toRebuild.find((r) => r.room.id === nextRoomId);
    if (nextRebuildEntry)
      resolvedNextPhysicalSlot = nextRebuildEntry.physicalSlot;
  }
  if (!nextRoomId) {
    // #204: the goal room was just resolved — nothing more to build, but
    // sweep any un-looted #172 corpse (or plain leftover NPC) before
    // returning, since this was previously the one completion path with no
    // cleanup trigger at all (teardownDungeonRun only ever fires on Abandon).
    // #62 final review: markRoomOutcome also returns a null nextRoomId from
    // several guards that are NOT genuine completion — its duplicate-resolve
    // guard (#152, e.g. a double-click race), its no-outcome-slot guard, and
    // its own already-completed guard. Gate on the returned state's actual
    // `completed` flag (set true only in markRoomOutcome's real
    // goal-room-resolved branch) rather than treating every null nextRoomId
    // as "run done" — with every room now eagerly built (#62), sweeping on a
    // false positive would wipe every pre-populated encounter and trap
    // hazard across the whole dungeon, not just the one room the old
    // one-room-ahead design could have lost.
    if (state?.completed) await sweepCompletedDungeonScene(scene);
    return;
  }

  const nextRoom = state.rooms.find((r) => r.id === nextRoomId);
  await buildPopulateAndUnlockRoom(
    scene,
    state,
    nextRoom,
    resolvedNextPhysicalSlot,
  );
}

// A level well under the party's own, so a `friendly_aid` ally reads as a
// helped-out traveler rather than a second combatant — arbitrary same as
// this file's other placeholder tunables (e.g. #169's TREASURE_GP_PER_LEVEL)
// until a real "ally" concept exists.
const FRIENDLY_AID_LEVEL_OFFSET = -4;

/**
 * #31: the mechanical half of the 6 previously flavor-only reward/ruin
 * outcome keys — `resolveCurrentRoom` calls this right after
 * `markRoomOutcome` resolves an `effectKey`. Per #93/#156, `markRoomOutcome`
 * no longer intercepts `reduced_travel_time`/`extra_travel_time` itself —
 * it only reveals the hidden path's data (edges/hiddenEdges) and hands back
 * `revealedRoomId`; unsealing the corresponding scene door is this
 * function's own case below.
 */
/**
 * The real treasure reward (gp + a rollable-table item draw) — shared by
 * the dedicated treasure room kind's claimTreasureFor and the `treasure`
 * outcome-slot key (#31), which draws the same reward from a different
 * room kind rather than a second, lesser concept of what "treasure" means.
 */
export async function grantTreasureReward(
  api,
  { partyLevel, physicalSlot, roomCount, isGoal },
) {
  const gp = lootGpForTreasureRoom({
    partyLevel,
    physicalSlot,
    roomCount,
    isGoal,
  });
  await api.addCoins(game.actors.party.id, { gp });
  // #88: ui.notifications is a local, ephemeral toast on whichever client
  // calls it -- never broadcast or persisted -- so a party member other
  // than that one client never saw their own treasure reward. Posted to
  // the public chat log instead, same as this module's other reward/outcome
  // announcements (see dungeon-combat.mjs's postReactiveStrikeChat,
  // dungeon-critical-deck.mjs's drawAndApplyCriticalCard): no ui.notifications
  // toast alongside it, since none of those cited chat-post conventions
  // double up a GM-local toast for the same event either.
  await ChatMessage.create({
    content: game.i18n.format("PF2EDC.Dungeon.Treasure.Found", { gp }),
  });
  const tableName = treasureRoomItemTableName({
    partyLevel,
    physicalSlot,
    roomCount,
    isGoal,
    rng: Math.random,
  });
  const itemDoc = await drawTreasureItem(tableName);
  if (itemDoc) {
    await game.actors.party.createEmbeddedDocuments("Item", [
      itemDoc.toObject(),
    ]);
    await ChatMessage.create({
      content: game.i18n.format("PF2EDC.Dungeon.Treasure.ItemFound", {
        item: escapeHtml(itemDoc.name),
      }),
    });
  }
}

async function applyRoomEffect(
  effectKey,
  { seed, roomId, physicalSlot, roomCount, isGoal, scene, revealedRoomId },
) {
  const api = makeFoundryApi();
  const partyMembers = (game.actors?.party?.members ?? []).filter(
    (m) => m.type === "character",
  );
  switch (effectKey) {
    case "treasure": {
      if (!game.actors.party) return;
      const partyLevel = await api.partyLevel();
      await grantTreasureReward(api, {
        partyLevel,
        physicalSlot,
        roomCount,
        isGoal,
      });
      return;
    }
    case "exhaustion":
    case "restless_night": {
      for (const member of partyMembers) {
        await api.increaseCondition(member.id, "fatigued", 1);
      }
      return;
    }
    case "ready_foraging": {
      for (const member of partyMembers) {
        const hasFatigued = member.itemTypes?.condition?.some(
          (c) => c.slug === "fatigued",
        );
        if (hasFatigued) await api.decreaseCondition(member.id, "fatigued", 1);
      }
      return;
    }
    case "lost_gear": {
      const candidates = [];
      for (const member of partyMembers) {
        const gear = await api.listGear(member.id);
        for (const item of gear) {
          candidates.push({
            memberId: member.id,
            memberName: member.name,
            itemId: item.id,
            itemName: item.name,
          });
        }
      }
      if (!candidates.length) return;
      const picked = seededPick(seed, `lost-gear-${roomId}`, candidates);
      await api.removeItems(picked.memberId, [picked.itemId]);
      ui.notifications.warn(
        game.i18n.format("PF2EDC.Dungeon.Effect.lost_gear_detail", {
          actor: picked.memberName,
          item: picked.itemName,
        }),
      );
      return;
    }
    case "friendly_aid": {
      const partyLevel = await api.partyLevel();
      const maxLevel = Math.max(-1, partyLevel + FRIENDLY_AID_LEVEL_OFFSET);
      const candidates = await api.findCreatures({ minLevel: -1, maxLevel });
      if (!candidates.length) {
        console.warn(
          `pf2e-dungeon-crawl: no level -1..${maxLevel} creature found for friendly_aid`,
        );
        return;
      }
      const picked = seededPick(seed, `friendly-aid-${roomId}`, candidates);
      await api.spawnCreatures([{ pack: picked.pack, id: picked.id }], {
        disposition: 1,
        // Without a focus, spawnCreatures falls back to the scene's center
        // or an unbounded ring search — the ally could land outside the
        // room the party is actually in. A party member's token is always
        // in that room by the time an outcome resolves, so anchor there.
        nearActorId: partyMembers[0]?.id ?? null,
      });
      ui.notifications.info(
        game.i18n.format("PF2EDC.Dungeon.Effect.friendly_aid_detail", {
          name: picked.name,
        }),
      );
      return;
    }
    case "reduced_travel_time":
    case "extra_travel_time": {
      if (revealedRoomId) {
        await unsealHiddenDoorFromRoom(scene, roomId, revealedRoomId);
      }
      return;
    }
    default:
      return;
  }
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
  // #32/#165: same per-kind pool filtering as resolveCurrentRoom's own
  // markRoomOutcome call — see its comment. Hoisted into locals (#93) so
  // both createRun and buildRoomGraph below share the same pools.
  const puzzleSetpieceIds = setpieces
    .filter((s) => s.kind === "puzzle")
    .map((s) => s.id);
  const trapSetpieceIds = setpieces
    .filter((s) => s.kind === "trap")
    .map((s) => s.id);
  const narrativeSetpieceIds = setpieces
    .filter((s) => s.kind === "narrative")
    .map((s) => s.id);
  const treasureSetpieceIds = setpieces
    .filter((s) => s.kind === "treasure")
    .map((s) => s.id);
  let state = await createRun(
    {
      sceneId: scene.id,
      roomCount,
      traits,
      excludeTraits,
      previousSceneId,
      hostUserId,
    },
    {
      puzzleSetpieceIds,
      trapSetpieceIds,
      narrativeSetpieceIds,
      treasureSetpieceIds,
    },
  );

  const { rooms, edges } = getGenerator().buildRoomGraph({
    seed: state.seed,
    roomCount,
    puzzleSetpieceIds,
    trapSetpieceIds,
    narrativeSetpieceIds,
  });
  const { hiddenRooms, hiddenEdges, layoutEdges, hiddenIncomingByRoomId } =
    getGenerator().attachHiddenPaths({ rooms, edges, seed: state.seed });
  // #156: rank/col must come from layoutEdges (includes detour rooms), not
  // edges (visible-only) — computing over edges leaves every detour room's
  // rank/col undefined, since its only incoming connection is hidden.
  const ranks = computeRanks(layoutEdges, 'room-entry');
  const columns = computeColumns(layoutEdges, ranks, 'room-entry');
  const layoutPositionByRoomId = Object.fromEntries(
    Object.keys(rooms).map((id) => [id, { rank: ranks[id], col: columns[id] }]),
  );
  const maxRank = Math.max(...Object.values(ranks));
  const maxCol = Math.max(...Object.values(columns));

  // #93 pre-flight fix: strip the OLD array-model fields createRun still
  // sets (currentIndex/physicalSlotByRoomId/nextPhysicalSlot, from its own
  // now-fully-discarded buildRoomSequence() generation) rather than
  // carrying them forward stale — nothing reads them once this task's own
  // migration below lands, and leaving them in persisted state is
  // needlessly confusing for anyone debugging a run later.
  const { currentIndex: _oldIndex, physicalSlotByRoomId: _oldSlots, nextPhysicalSlot: _oldNext, ...stateWithoutLegacyFields } = state;
  state = {
    ...stateWithoutLegacyFields,
    rooms,
    edges,
    layoutEdges,
    hiddenRooms: [...hiddenRooms],
    hiddenEdges,
    hiddenIncomingByRoomId,
    layoutPositionByRoomId,
    maxRank,
    currentRoomId: 'room-entry',
    history: [],
  };
  // Persist the graph-shaped state BEFORE any room is built — every
  // ensure*State reducer buildPopulateAndUnlockGraphNode calls re-reads
  // state from settings by room id, and _prepareContext's legacy-shape gate
  // would otherwise see createRun's array-shaped state and clear the run.
  await replaceRunState(scene.id, state);

  // #93: the whole graph's extent is known up front under full
  // pregeneration — resize once, before any room is built, instead of
  // the old per-room ensureSceneCovers/requiredDimensions growth.
  await resizeSceneForLayout(scene, { maxRank, maxCol });

  // #93: full pregeneration for every run, GM-present or GM-less alike —
  // no more hostUserId gate, no more ITEM-11 first-combat-room deferral.
  // Only the entry room's own outgoing doors unlock immediately; every
  // other room stays locked until its own outcome resolves (Task 13's
  // unlockDoorsFromRoom call) — so this loop always passes
  // `unlock: false` except for 'room-entry' itself. #93 merge-door
  // redesign: buildPopulateAndUnlockGraphNode resolves each room's own
  // incoming connections (real parent(s), plus any hidden extra)
  // internally from `state` — this loop only threads its OWN outgoing
  // shape through, same as Task 11's lazy fallback, so both build paths
  // agree on a room's geometry by construction rather than duplicating
  // the same lookup twice. `roomsToEagerlyBuild` walks `layoutEdges`
  // (Task 7) so detour rooms are included.
  //
  // Task 12 implementer fix: roomsToEagerlyBuild deliberately never returns
  // 'room-entry' itself (its own docblock: "every room except the entry
  // (built separately by startDungeonRun itself)"), so the entry has to be
  // built explicitly here, FIRST — its children's builds each delete one of
  // its frontier placeholders (#110 ordering) and draw their incoming door
  // from its rect. Its own outgoing doors don't exist until those children
  // are built (each child builds its own incoming door/corridor), so it's
  // built with `unlock: false` and its doors are unlocked once, after the
  // loop below.
  const { rank: entryRank, col: entryCol } = layoutPositionByRoomId['room-entry'];
  await buildPopulateAndUnlockGraphNode(scene, state, rooms['room-entry'], {
    rank: entryRank,
    col: entryCol,
    childIds: edges['room-entry'] ?? [],
    hiddenChildId: hiddenEdges['room-entry']?.[0] ?? null,
    unlock: false,
  });
  const eagerlyBuilt = roomsToEagerlyBuild(state);
  for (const { room, buildOrder } of eagerlyBuilt) {
    const { rank, col } = layoutPositionByRoomId[room.id];
    await buildPopulateAndUnlockGraphNode(scene, state, room, {
      rank,
      col,
      childIds: edges[room.id] ?? [],
      // This room's own hidden outgoing target (shortcut or detour), if
      // any — reserves and seals the extra face (#156).
      hiddenChildId: hiddenEdges[room.id]?.[0] ?? null,
      unlock: room.id === 'room-entry',
    });
  }
  // Now that every child of the entry has built its own incoming door,
  // unlock the entry's outgoing doors (see the entry build above).
  await unlockDoorsFromRoom(
    scene,
    'room-entry',
    edges['room-entry'] ?? [],
    hiddenEdges['room-entry'] ?? [],
  );
  // #93 pre-flight fix: commitEagerPhysicalSlots dropped entirely — it
  // only ever maintained physicalSlotByRoomId/nextPhysicalSlot, both fully
  // retired by this task's own migration (Step 4/6 below read state.rooms
  // directly by id; nothing reads a "physical slot" anymore).

  const partyMembers = (game.actors?.party?.members ?? []).filter(
    (m) => m.type === 'character',
  );
  await placePartyInRoom(scene, 'room-entry', entryRank, entryCol, partyMembers, state.seed);
  await scene.activate();
  unpauseIfGmLessRun(scene.id);
  await new Promise((r) => setTimeout(r, 400));
  focusCameraOnRoom(scene, 'room-entry', entryRank, entryCol, state.seed);
}

export async function recordSkillChallengeOutcome(sceneId, roomId, outcome) {
  const newState = await recordSkillChallengeAttempt(sceneId, roomId, outcome);
  const resolved = newState?.rooms[roomId]?.challenge?.resolved;
  if (resolved === "success") {
    await makeFoundryApi().grantPartyXp(xpFor(0));
  }
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
  const resolved = newState?.rooms[roomId]?.puzzle?.resolved;
  if (resolved === "success") {
    await makeFoundryApi().grantPartyXp(xpFor(0));
  }
  if (resolved)
    await resolveCurrentRoom(resolved === "success", {
      scene: game.scenes.get(sceneId),
    });
}

/** A treasure room's own resolution (#169, item draw #29): grants real
 * coins to the party actor, scaled by party level and the room's own
 * depthBiasFor ramp (lootGpForTreasureRoom), then always resolves
 * succeeded — same "nothing to fail at" shape as continueNarrativeRoom.
 * Also draws one item from a real PF2e rollable table
 * (treasureRoomItemTableName picks which; a treasure room always drops
 * something, unlike an NPC corpse's ITEM_CHANCE-gated drop) and grants it
 * to the party actor alongside the coins. Silently grants nothing if
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
    const roomCount = state.rooms.length;
    const isGoal = currentRoom.isGoal;
    await grantTreasureReward(api, {
      partyLevel,
      physicalSlot,
      roomCount,
      isGoal,
    });
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
    state?.rooms[state.currentRoomId]?.narrative?.options?.[optionIndex];
  if (option) await setObjective(sceneId, option.consequence);
  await resolveCurrentRoom(true, { scene });
}

export async function resolveCombatRoomOutcome(sceneId, succeeded) {
  const scene = game.scenes.get(sceneId);
  const state = scene ? getRunState(sceneId) : null;
  const currentRoom = state?.rooms[state.currentRoomId];
  if (!currentRoom) return;
  await resolveSlotCombat(
    scene,
    currentRoom.id,
    succeeded ? "victory" : "defeat",
    makeFoundryApi(),
  );
  await resolveCurrentRoom(succeeded, { scene });
}

export async function startCombatRecoveryFor(sceneId) {
  const scene = game.scenes.get(sceneId);
  const state = scene ? getRunState(sceneId) : null;
  const currentRoom = state?.rooms[state.currentRoomId];
  if (!currentRoom) return;
  await startCombatForRoom(scene, currentRoom.id);
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
    id: "pf2edc-dungeon-app",
    tag: "section",
    window: { title: "PF2EDC.Dungeon.Title", icon: "fa-solid fa-dungeon" },
    position: { width: 480, height: "auto" },
    actions: {
      start: DungeonApp.#onStart,
      succeed: DungeonApp.#onSucceed,
      fail: DungeonApp.#onFail,
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
    // #93: a run created before this update has state.rooms as an array with
    // currentIndex/physicalSlotByRoomId — the old linear-sequence shape this
    // app no longer understands. Same "clear and let the GM start fresh"
    // handling the pre-existing Tier-1 check already uses for an even older
    // shape, extended to also catch this one. Keyed on the NEW shape's own
    // marker (layoutPositionByRoomId) rather than physicalSlotByRoomId's
    // absence — startDungeonRun now deliberately strips physicalSlotByRoomId
    // from every new run, so testing for its absence would clear every
    // freshly started graph-shaped run on its first render. A Tier-1 run
    // lacks layoutPositionByRoomId too, so it's still caught.
    if (
      state &&
      (Array.isArray(state.rooms) || !state.layoutPositionByRoomId) &&
      game.user.isGM
    ) {
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
          buttonLabel: game.i18n.localize(
            "PF2EDC.Encounter.ChooseTraitsButton",
          ),
        }),
        excludeTraitsFieldHtml: traitFieldHtml({
          name: "excludeTraits",
          label: game.i18n.localize("PF2EDC.Encounter.ExcludeTraitsLabel"),
          buttonLabel: game.i18n.localize(
            "PF2EDC.Encounter.ChooseTraitsButton",
          ),
        }),
      };
    }

    const setpieces = await loadDungeonSetpieces();
    const setpiecesById = new Map(setpieces.map((s) => [s.id, s]));
    const currentRoom = state.rooms[state.currentRoomId] ?? null;
    const setpiece = currentRoom?.setpieceId
      ? setpiecesById.get(currentRoom.setpieceId)
      : null;
    const currentRoomResolved =
      !!currentRoom && state.history.some((h) => h.roomId === currentRoom.id);

    // #93: no more "next room" concept in a branching graph (a room can have
    // 2-3 children, not one) — and no more "pending" state at all, since full
    // pregeneration means every room is already built+populated by the time
    // its door can be opened (Task 10/11's #93 redesign). The whole
    // ITEM-11/populateNextRoom feature this powered is deleted (Step 3).
    const isCombatRoom = currentRoom?.kind === "combat" && !currentRoomResolved;
    const isSafeEntry = currentRoom?.kind === "safe_entry";
    const isSafeRest = currentRoom?.kind === "safe_rest";
    const activeCombat =
      isCombatRoom && currentRoom ? getCombatForRoom(scene, currentRoom.id) : null;

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

    // #137/#109/#32: a puzzle room uses its own hint-check UI instead of the
    // plain Succeed/Fail buttons — fully auto-resolving (per live
    // discussion), so there's no GM judgment step the way the plain buttons
    // need; resolveCurrentRoom is still what actually advances the room,
    // called automatically once recordPuzzleStageAttempt's own reducer sets
    // `resolved`, the same "only once resolved" gating
    // #onAttemptSkillChallenge already uses. The puzzle's own state is
    // attached at room-build time (dungeon-scene.mjs's
    // buildPopulateAndUnlockRoom), not lazily here — this is a pure read
    // of whatever's already persisted, same reasoning as the
    // skill_challenge block above.
    const isPuzzleRoom = currentRoom?.kind === "puzzle" && !currentRoomResolved;
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
        playerDescription: raw.playerDescription,
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

    // #56: read from the room's own *persisted* trap state (attached at
    // room-build time by dungeon-scene.mjs's ensureTrapState, kept in sync by
    // trap-combat.mjs's applyTrapCustomization/applyTrapRoomState), never
    // straight off the raw setpiece stub — the same "persisted state wins
    // over the raw template" rule puzzle/narrative already follow above.
    // Previously nothing read currentRoom.trap at all, so a trap room always
    // showed one of the 3 generic, disconnected static stub blurbs from
    // dungeon-setpieces.json regardless of which real hazard was spawned or
    // customized — the actual bug #56 fixes.
    const isTrapRoom = currentRoom?.kind === "trap" && !currentRoomResolved;
    let trap = null;
    if (isTrapRoom && currentRoom.trap) {
      const raw = currentRoom.trap;
      trap = { name: raw.name, description: raw.description };
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
    // #89: read from the room's own *persisted* treasure state (attached at
    // room-build time by dungeon-scene.mjs's ensureTreasureState), the same
    // "persisted state wins over the raw template" rule puzzle/narrative
    // already follow above — gives an external agent's customization
    // somewhere durable to land instead of being silently overwritten by
    // the shared template on the next render (#139's own invisible-
    // customization bug). Deliberately just name/summary: a treasure
    // setpiece has no archetype-specific extras the way narrative does, and
    // no GM-only mechanical field the way puzzle's summary/playerDescription
    // split protects — the gp amount and item-table draw are computed
    // entirely separately (grantTreasureReward/claimTreasureFor below) and
    // never read this state at all.
    let treasure = null;
    if (isTreasureRoom && currentRoom.treasure) {
      const raw = currentRoom.treasure;
      treasure = { name: raw.name, summary: raw.summary };
    }

    return {
      hasScene: true,
      hasRun: true,
      isGM: game.user.isGM,
      interactive,
      hostName,
      sceneId,
      currentRoomId: currentRoom?.id ?? null,
      // Not rendered — just threaded to _onRender's own focusCameraOnRoom call,
      // which needs the room's rank/col to know its actual position and size
      // (ITEM-17) — a room's geometry is no longer derivable from an integer
      // alone (#93).
      currentRoomRank: currentRoom ? state.layoutPositionByRoomId[currentRoom.id]?.rank : null,
      currentRoomCol: currentRoom ? state.layoutPositionByRoomId[currentRoom.id]?.col : null,
      seed: state.seed,
      completed: state.completed,
      // #93: neither the entry nor a mid-dungeon rest room (ITEM-5) counts
      // toward the room total — same exclusion as before, now counted via the
      // party's actual traversal path (state.history plus the current room, if
      // not yet resolved) instead of a linear array index, since a branching
      // graph has no single "position N of the sequence" the way a linear
      // dungeon did.
      roomNumber: (currentRoomResolved
        ? state.history.map((h) => h.roomId)
        : [...state.history.map((h) => h.roomId), ...(currentRoom ? [currentRoom.id] : [])]
      ).filter((id) => !UNCOUNTED_ROOM_KINDS.has(state.rooms[id]?.kind)).length,
      roomTotal: Object.values(state.rooms).filter(
        (r) => !UNCOUNTED_ROOM_KINDS.has(r.kind),
      ).length,
      currentRoomResolved,
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
        // #139/#167/#56/#89: prefers the puzzle's, narrative's, trap's, or
        // treasure room's own *persisted* name/summary/playerDescription
        // (which an agent's applyPuzzleCustomization/
        // applyNarrativeCustomization/applyTrapCustomization/
        // applyTreasureCustomization may have overwritten) over the raw
        // setpiece template's — this is the one generic display block every
        // room kind's name/summary renders through, so any kind's
        // customization needs to flow through here to be visible at all,
        // not just in its own kind-specific block below. playerDescription
        // (#49) follows the same rule: a customized puzzle's player-facing
        // flavor text must win over the raw setpiece's, the same way its
        // GM-facing summary already does — otherwise players keep seeing
        // stale, uncustomized flavor. A trap room (#56) has no separate
        // GM-only summary concept (a hazard's description carries no
        // mechanical secret the way a puzzle's summary does — verified
        // live), so trap only ever feeds playerDescription, never summary.
        // A treasure room (#89) has the same shape as trap here — its
        // flavor text has nothing GM-only to withhold either (unlike a
        // puzzle's solution-adjacent summary, there's no mechanical secret
        // to protect), so treasure only ever feeds summary, the same single
        // field narrative already uses, and never playerDescription.
        setpiece: setpiece && {
          name:
            puzzle?.name ??
            narrative?.name ??
            trap?.name ??
            treasure?.name ??
            setpiece.name,
          summary:
            puzzle?.summary ??
            narrative?.summary ??
            treasure?.summary ??
            setpiece.summary,
          playerDescription:
            puzzle?.playerDescription ??
            trap?.description ??
            setpiece.playerDescription ??
            null,
          complete: setpiece.complete,
        },
      },
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
    if (context.currentRoomId != null && canvas?.scene?.id === context.sceneId) {
      focusCameraOnRoom(canvas.scene, context.currentRoomId, context.currentRoomRank, context.currentRoomCol, context.seed);
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
    const currentRoom = state?.rooms[state.currentRoomId];
    if (!currentRoom?.challenge) return;

    const form = this.element.querySelector(
      ".pf2edc-dungeon__skill-challenge-form",
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
    const currentRoom = state?.rooms[state.currentRoomId];
    if (!currentRoom?.puzzle) return;

    const stageIndex = Number(target?.dataset?.stageIndex);
    const stage = currentRoom.puzzle.stages[stageIndex];
    if (!stage || stage.attempted) return;

    const form = this.element.querySelector(
      `.pf2edc-dungeon__puzzle-stage-form[data-stage-index="${stageIndex}"]`,
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
      '[name="pf2edc-narrative-objective"]',
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

  /** Recovery-only — mirrors the old (#93-removed) Populate Next Room
   * button's own safety-net precedent for when something (a reload mid-flow, say) left a combat room without a
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
