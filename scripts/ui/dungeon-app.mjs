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
} from "../dungeon-runner.mjs";
import { canActOnDungeon } from "../dungeon-permissions.mjs";
import { fulfillPendingCustomizations } from "../dungeon-customization-fulfillment.mjs";
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
  isSlotBuilt,
  placePartyInRoom,
  undoRoomEntry,
  focusCameraOnRoom,
  teardownDungeonRun,
  buildPopulateAndUnlockGraphNode,
  resizeSceneForLayout,
  unlockDoorsFromRoom,
  sweepCompletedDungeonScene,
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
  // Captured before markRoomOutcome runs — both the XP grant below and
  // applyRoomEffect's treasure-gp calc need the room that was just
  // resolved, keyed by id now that state.rooms is a dict (#93).
  const preState = getRunState(scene.id);
  const currentRoom = preState?.rooms[preState.currentRoomId];
  // #93: the dungeonSlot flag's NAME is unchanged (dungeon-combat.mjs and
  // its tests only ever compare it for equality — see Task 10's design
  // note); its VALUE is now the room's own string id instead of an
  // integer physical slot.
  if (succeeded && currentRoom?.kind === "trap") {
    const trapToken = scene.tokens.find(
      (t) =>
        t.getFlag(MODULE_ID, "trapHazard") &&
        t.getFlag(MODULE_ID, "dungeonSlot") === currentRoom.id,
    );
    const trapLevel = trapToken?.actor?.system?.details?.level?.value;
    const levelOffset =
      trapLevel != null ? trapLevel - (await makeFoundryApi().partyLevel()) : 0;
    await makeFoundryApi().grantPartyXp(xpFor(levelOffset));
  }
  const { state, effectKey, revealedRoomId } = await markRoomOutcome(
    { sceneId: scene.id, succeeded },
    {
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
    // #93 pre-flight fix (found during Task 9's review): Task 9's own
    // `applyRoomEffect` addendum (its `reduced_travel_time`/
    // `extra_travel_time` case, dungeon-app.mjs) reads `scene` and
    // `revealedRoomId` off THIS call's params to call
    // `unsealHiddenDoorFromRoom` — an earlier draft of this task dropped
    // both here, which would have silently disconnected Task 9's unseal
    // step (a hidden door revealed by outcome would never actually
    // unlock in the scene, even though the data merge succeeded).
    await applyRoomEffect(effectKey, {
      scene,
      seed: preState.seed,
      roomId: currentRoom.id,
      rank: preState.layoutPositionByRoomId[currentRoom.id].rank,
      maxRank: preState.maxRank,
      isGoal: currentRoom.isGoal,
      revealedRoomId,
    });
  }
  // #93 pre-flight fix (found during Task 9's review): the CURRENT code
  // shows a GM hint (`RerunEncounterHint`) whenever the old `mutation`
  // field was `'rerun_encounter'` — the aid_or_ambush ruin outcome's own
  // signal to reroll the room's encounter. `mutation` is gone, but the
  // SAME outcome still comes through as `effectKey === 'encounter'`
  // (`dungeon-deck.mjs`'s only outcome template using that key — grep
  // confirms it's unambiguous), so re-key the hint off that instead of
  // silently dropping it. Left unaddressed, this specific ruin's "go
  // reroll the fight" GM nudge would quietly stop firing forever.
  if (effectKey === "encounter")
    ui.notifications.warn(
      game.i18n.localize("PF2EDC.Dungeon.RerunEncounterHint"),
    );
  // #93: full pregeneration means every room the party can reach is
  // already built (Task 12's eager-build loop) in the common case, and
  // any hidden path this outcome revealed was already merged into
  // `state.edges` inside markRoomOutcome (Task 9's revealTravelTimeEffect)
  // — resolving a room never rebuilds or reconciles physical slots. All
  // that's normally left is unlocking the resolved room's own outgoing
  // doors so the party can walk through them; the goal room has none.
  //
  // #93 pre-flight fix (found during Task 11's own review): the
  // ensure-built loop below is the Review Focus item 1 safety net for
  // the uncommon case where eager pregeneration failed for one of these
  // children — NOT the normal path. A child room's own doors (both the
  // progress-gate and reveal doors) only ever get created as part of
  // THAT room's own build, in the same call that marks it built — so a
  // door-open-time fallback (the original design) could never fire for a
  // room that truly failed to build; this is the one place we already
  // know which children are about to be unlockable, before any door
  // needs to exist for the player to click. buildPopulateAndUnlockGraphNode
  // is already idempotent (checks isSlotBuilt/isSlotPopulated internally),
  // so calling it for an already-fully-built child costs nothing beyond
  // that internal check — this is not a second build pass on the common
  // path, same reasoning as Task 11's identical rest-room-branch loop.
  // #93 fix round 1 (found by this task's own review): gated on `effectKey`
  // too, not just `currentRoom && !currentRoom.isGoal`. `markRoomOutcome`
  // returns `effectKey: null` from exactly three reject/guard paths — no
  // state/already completed, the #152 duplicate-resolve guard (the SAME
  // room already appears in `state.history`), and a non-goal/non-rest room
  // with no outcome slot — and a non-null string from every genuine
  // resolution path (goal, rest, or a real outcome template), confirmed by
  // reading `markRoomOutcome` directly. Without this gate, a double-click
  // (or a slow click registering twice before the first await resolves —
  // the exact #152 scenario, still possible here since no UI-level
  // debounce exists) would re-run the ensure-built loop and
  // `unlockDoorsFromRoom` for a room that was NOT actually just resolved —
  // `unlockDoorsFromRoom` sets `ds: CLOSED` unconditionally on the matched
  // door, which would silently re-close a door the party had already
  // manually opened.
  if (currentRoom && !currentRoom.isGoal && effectKey) {
    const childIds = state.edges[currentRoom.id] ?? [];
    const hiddenChildIds = state.hiddenEdges[currentRoom.id] ?? [];
    for (const childId of [...childIds, ...hiddenChildIds]) {
      // #93 fix round 1 (found by this task's own review — the same class
      // of bug Task 11's own fix round 2 already caught and fixed in its
      // identical rest-room-branch loop): both lookups must sit INSIDE the
      // try, not before it. A throw here would otherwise abort the WHOLE
      // loop (skipping every remaining child) AND skip `unlockDoorsFromRoom`
      // below entirely — the party would be stuck behind locked doors with
      // no error shown at all, exactly the silent failure Review Focus
      // item 1 warns against.
      try {
        const child = state.rooms[childId];
        const { rank: childRank, col: childCol } = state.layoutPositionByRoomId[childId];
        await buildPopulateAndUnlockGraphNode(scene, state, child, {
          rank: childRank,
          col: childCol,
          childIds: state.edges[childId] ?? [],
          hiddenChildId: state.hiddenEdges[childId]?.[0] ?? null,
          unlock: false,
        });
      } catch (err) {
        console.error(`${MODULE_ID} | failed to build child room ${childId} before unlock`, err);
        ui.notifications?.error(
          game.i18n.localize("PF2EDC.Dungeon.RoomBuildFailedError"),
        );
      }
    }
    await unlockDoorsFromRoom(scene, currentRoom.id, childIds, hiddenChildIds);
  }
  if (state?.completed) await sweepCompletedDungeonScene(scene);
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
  { partyLevel, rank, maxRank, isGoal },
) {
  const gp = lootGpForTreasureRoom({
    partyLevel,
    rank,
    maxRank,
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
    rank,
    maxRank,
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
  { scene, seed, roomId, rank, maxRank, isGoal, revealedRoomId },
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
        rank,
        maxRank,
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

  const generated = getGenerator().buildRoomGraph({
    seed: state.seed,
    roomCount,
    puzzleSetpieceIds,
    trapSetpieceIds,
    narrativeSetpieceIds,
    treasureSetpieceIds,
  });
  // #93 post-merge fix (Task 2 addendum, found by Task 15's final review):
  // restore the mid-dungeon rest room BEFORE attachHiddenPaths runs — a
  // hidden path must never be allowed to select the rest room as its own
  // fromId (see the Task 3 addendum), so the rest room has to already
  // exist in the graph by the time attachHiddenPaths does its own
  // eligibility scan.
  const { rooms, edges } = getGenerator().insertRestRoom({
    rooms: generated.rooms,
    edges: generated.edges,
    seed: state.seed,
    roomCount,
  });
  const { hiddenRooms, hiddenEdges, layoutEdges, hiddenIncomingByRoomId } =
    getGenerator().attachHiddenPaths({
      rooms, edges, seed: state.seed,
      // #93 post-merge fix (Task 3 addendum): a revealed detour room needs
      // real content the same way a main-graph room does.
      puzzleSetpieceIds, trapSetpieceIds, narrativeSetpieceIds, treasureSetpieceIds,
    });
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
  // `unlock: false`. #93 merge-door redesign:
  // buildPopulateAndUnlockGraphNode resolves each room's own incoming
  // connections (real parent(s), plus any hidden extra) internally from
  // `state` — this loop only threads its OWN outgoing shape through, same
  // as Task 11's lazy fallback, so both build paths agree on a room's
  // geometry by construction rather than duplicating the same lookup
  // twice. `roomsToEagerlyBuild` walks `layoutEdges` (Task 7) so detour
  // rooms are included.
  // #93 fix round 1 (found by this task's own review): roomsToEagerlyBuild
  // deliberately excludes 'room-entry' (Task 7 seeds it as already
  // visited) — the brief's own loop never built OR unlocked the entry
  // room at all, stranding the party the instant a run started. Build it
  // explicitly first, walls-only (unlock happens below, once its own
  // children are confirmed built), the same idempotent call every other
  // room uses.
  //
  // #93 fix round 1: every iteration (including the entry) is now wrapped
  // in try/catch, mirroring the pre-#93 code's own #62-era reasoning —
  // "one bad room shouldn't take down every other room or the run's own
  // setup." Without this, a single compendium miss or hazard-spawn
  // failure anywhere in the whole graph would throw out of this loop and
  // abort startDungeonRun entirely, before placePartyInRoom/
  // scene.activate() even run — a far worse failure than "one room didn't
  // build," and one that defeats Task 11/13's whole resolution-time
  // "ensure-built" safety net (which only ever gets a chance to retry a
  // room once the RUN has actually started).
  const buildRoomSafely = async (room, opts) => {
    try {
      await buildPopulateAndUnlockGraphNode(scene, state, room, opts);
    } catch (err) {
      console.error(`${MODULE_ID} | eager build failed for room "${room.id}"`, err);
    }
  };

  const { rank: entryRank, col: entryCol } = layoutPositionByRoomId['room-entry'];
  await buildRoomSafely(rooms['room-entry'], {
    rank: entryRank,
    col: entryCol,
    childIds: edges['room-entry'] ?? [],
    hiddenChildId: hiddenEdges['room-entry']?.[0] ?? null,
    unlock: false,
  });

  const eagerlyBuilt = roomsToEagerlyBuild(state);
  for (const { room } of eagerlyBuilt) {
    const { rank, col } = layoutPositionByRoomId[room.id];
    await buildRoomSafely(room, {
      rank,
      col,
      childIds: edges[room.id] ?? [],
      // This room's own hidden outgoing target (shortcut or detour), if
      // any — reserves and seals the extra face (#156).
      hiddenChildId: hiddenEdges[room.id]?.[0] ?? null,
      unlock: false,
    });
  }
  // #93 pre-flight fix: the old eager physical-slot commit step is dropped
  // entirely (deleted outright by Task 15) — it only ever maintained physicalSlotByRoomId/nextPhysicalSlot, both fully
  // retired by this task's own migration (Step 4/6 below read state.rooms
  // directly by id; nothing reads a "physical slot" anymore).

  // #93 fix round 1: the entry room is never "resolved" the way every
  // other room is (markRoomOutcome returns early for it) — there is no
  // later resolution-time moment to hang an ensure-built retry off of for
  // ITS children, unlike every other room in the graph (which Task 11's
  // rest-room branch or Task 13's resolveCurrentRoom will always
  // eventually cover). So the entry's own children get one best-effort
  // retry here, right before their doors unlock — the same idempotent
  // pattern, just inlined instead of deferred to a later resolution.
  const entryChildIds = edges['room-entry'] ?? [];
  const entryHiddenChildIds = hiddenEdges['room-entry'] ?? [];
  for (const childId of [...entryChildIds, ...entryHiddenChildIds]) {
    if (isSlotBuilt(scene, childId)) continue;
    const child = rooms[childId];
    const { rank: childRank, col: childCol } = layoutPositionByRoomId[childId];
    await buildRoomSafely(child, {
      rank: childRank,
      col: childCol,
      childIds: edges[childId] ?? [],
      hiddenChildId: hiddenEdges[childId]?.[0] ?? null,
      unlock: false,
    });
  }
  await unlockDoorsFromRoom(scene, 'room-entry', entryChildIds, entryHiddenChildIds);

  const partyMembers = (game.actors?.party?.members ?? []).filter(
    (m) => m.type === 'character',
  );
  await placePartyInRoom(scene, 'room-entry', entryRank, entryCol, partyMembers, state.seed);
  await scene.activate();
  unpauseIfGmLessRun(scene.id);
  await new Promise((r) => setTimeout(r, 400));
  focusCameraOnRoom(scene, 'room-entry', entryRank, entryCol, state.seed);

  // #93 fix round 1: fire-and-forget, mirroring the old populateNextRoom
  // call site's own "never delay room population or reveal" reasoning —
  // full pregeneration means several rooms of the same customization kind
  // can be pending at once now, which is why Step 3c below also fixes
  // fulfillPendingCustomizations itself to drain every pending room per
  // kind, not just the first.
  fulfillPendingCustomizations(scene.id);
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
  const currentRoom = state?.rooms[state.currentRoomId];
  if (!currentRoom) return;
  if (game.actors.party) {
    const api = makeFoundryApi();
    const partyLevel = await api.partyLevel();
    const { rank } = state.layoutPositionByRoomId[currentRoom.id];
    const isGoal = currentRoom.isGoal;
    await grantTreasureReward(api, {
      partyLevel,
      rank,
      maxRank: state.maxRank,
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
    // buildPopulateAndUnlockGraphNode), not lazily on render — a client logged
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
    // buildPopulateAndUnlockGraphNode), not lazily here — this is a pure read
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
