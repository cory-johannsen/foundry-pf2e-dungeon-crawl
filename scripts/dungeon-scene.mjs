/**
 * The Foundry side of a physical dungeon: creates the run's own Scene and
 * builds one room at a time (walls, floor art, and a real reveal door).
 *
 * Rooms are built lazily — see dungeon-runner.mjs's docblock for why a
 * pre-built-everything approach would need reindexing logic this design
 * avoids entirely. dungeon-layout.mjs supplies all the grid-unit geometry;
 * this file only ever converts that to pixels and talks to Foundry.
 *
 * Modelled on scene-divination.mjs's Scene.create / activate-vs-view
 * precedent, but for a real explorable scene (tokenVision:true, real walls)
 * rather than a flat card-display one.
 *
 * Room discovery is triggered by opening a real door (the "reveal door" on
 * each room's own incoming face, flagged `dungeonRevealDoorForSlot`) rather
 * than a token merely walking into the room's footprint — module.mjs's own
 * `updateWall` hook calls `handleDungeonDoorOpened` directly (no Region or
 * `module.api` indirection needed for that, unlike the walk-in trigger this
 * replaced, which needed `module.api` because a Region's `executeScript`
 * behavior runs in a more sandboxed context).
 */
import {
  ROOM_SIZE_LARGE,
  ROOMS_PER_ROW,
  CORRIDOR_LEN,
  INITIAL_GX,
  slotRect,
  slotRowCol,
  roomEnclosureWalls,
  buildConnectionGeometry,
  corridorTileVariant,
  outgoingFaceWall,
  connectionDirection,
} from "./dungeon-layout.mjs";
import { freeSpotInRect } from "./placement.mjs";
import { generateEncounter } from "./encounter-generator.mjs";
import {
  getRunState,
  advanceToRoom,
  undoLastRoomEntry,
  canUndoRoomEntry,
  ensureSkillChallenge,
  ensurePuzzleState,
  ensureNarrativeState,
  ensureTrapState,
  ensureTreasureState,
  markRoomOutcome,
} from "./dungeon-runner.mjs";
import { depthBiasFor } from "./dungeon-deck.mjs";
import { startCombatForSlot } from "./dungeon-combat.mjs";
import { playDoorSound } from "./dungeon-sound.mjs";
import { loadDungeonSetpieces } from "./data-loader.mjs";
import { selectSkillChallengeTemplate } from "./skill-challenge-mechanics.mjs";
import { isValidNarrativeTemplate } from "./narrative-mechanics.mjs";
import { makeFoundryApi } from "./foundry-api.mjs";
import { selectTrap } from "./trap-library.mjs";
import { splitmix32, seedFromString } from "./prng.mjs";

const MODULE_ID = "pf2e-dungeon-crawl";
const GRID_SIZE = 100;
const MARGIN_ROOMS = 1;

const toPixels = (gridVal) => gridVal * GRID_SIZE;

const ROOM_ART_DIR = `modules/${MODULE_ID}/assets/dungeon-rooms`;
const CORRIDOR_ART_PATH = `${ROOM_ART_DIR}/corridor.webp`;
const CORRIDOR_ART_BY_VARIANT = {
  single: CORRIDOR_ART_PATH,
  end: `${ROOM_ART_DIR}/corridor-end.webp`,
  mid: `${ROOM_ART_DIR}/corridor-mid.webp`,
};

// A room's own light (ITEM-14) — see buildRoomAtSlot. Radii scale with the
// room's own actual size (ITEM-17, rooms are no longer all the same size):
// a room is `roomSizeSquares` squares across, so at this scene's 5ft/square
// grid its half-diagonal (center to corner) is roomSizeSquares*5/sqrt(2) ft
// — ROOM_LIGHT_BRIGHT reaches every corner at full brightness, with
// ROOM_LIGHT_DIM giving a generous soft falloff beyond the room into its
// connecting corridor. For the original fixed ROOM_SIZE_SMALL (6) this
// reproduces the exact bright:22/dim:40 this module always used.
const GRID_DISTANCE_FT = 5;
const ROOM_LIGHT_DIM_MARGIN = 18;
function roomLightRadii(roomSizeSquares) {
  const bright = Math.ceil((roomSizeSquares * GRID_DISTANCE_FT) / Math.SQRT2);
  return { bright, dim: bright + ROOM_LIGHT_DIM_MARGIN };
}
const ROOM_LIGHT_COLOR = "#ff8844";
const ROOM_LIGHT_ALPHA = 0.35;

/** The path to a room's background art — a dedicated image per locationTag
 * for the goal room (there's only ever one), or one of its regular pool of
 * pregenerated variants otherwise. */
function roomArtPath({ locationTag, isGoal, artVariant }) {
  return isGoal
    ? `${ROOM_ART_DIR}/${locationTag}-goal.webp`
    : `${ROOM_ART_DIR}/${locationTag}-${artVariant}.webp`;
}

function wallDoc(
  { x1, y1, x2, y2 },
  {
    door = CONST.WALL_DOOR_TYPES.NONE,
    ds = CONST.WALL_DOOR_STATES.CLOSED,
    flags = null,
  } = {},
) {
  return {
    c: [toPixels(x1), toPixels(y1), toPixels(x2), toPixels(y2)],
    door,
    ds,
    sight: CONST.WALL_SENSE_TYPES.NORMAL,
    move: CONST.WALL_MOVEMENT_TYPES.NORMAL,
    ...(flags ? { flags } : {}),
  };
}

// Worst-case pre-sizing (ITEM-17): rooms can now be as big as
// ROOM_SIZE_LARGE, but this only ever needs to be a safe *upper bound* — a
// row of all-small rooms just leaves some of this headroom unused, same as
// this module has always over-provisioned canvas space (see ITEM-20).
// ensureSceneCovers still grows the scene further if a run somehow needs
// more than even this. Width includes INITIAL_GX (dungeon-layout.mjs) —
// every room's gx is offset by that much to stay positive even when a
// west-moving row drifts left of where it started, so the scene itself
// needs to be wide enough to contain that same offset, or a room built out
// there silently lands outside the scene's declared bounds (confirmed live:
// a too-narrow scene clamped/misplaced a Tile whose x exceeded its width,
// before this was added — gy never needs the equivalent, since it only ever
// increases).
function requiredDimensions(maxSlot) {
  const { row } = slotRowCol(maxSlot);
  const stride = ROOM_SIZE_LARGE + CORRIDOR_LEN;
  return {
    width: toPixels(INITIAL_GX + ROOMS_PER_ROW * stride + MARGIN_ROOMS),
    height: toPixels((row + 1) * stride + MARGIN_ROOMS),
  };
}

async function ensureSceneCovers(scene, slot) {
  const { width, height } = requiredDimensions(slot);
  const nextWidth = Math.max(scene.width ?? 0, width);
  const nextHeight = Math.max(scene.height ?? 0, height);
  if (nextWidth > (scene.width ?? 0) || nextHeight > (scene.height ?? 0)) {
    await scene.update({ width: nextWidth, height: nextHeight });
  }
}

export async function createDungeonScene() {
  return Scene.create({
    name: "Dungeon Crawl",
    tokenVision: true,
    fogExploration: true,
    backgroundColor: "#2b2620",
    grid: { type: 1, size: GRID_SIZE, distance: 5, units: "ft" },
    // This module already manages its own canvas sizing via
    // ensureSceneCovers/requiredDimensions — pre-sized headroom built
    // dynamically as the run grows — rather than relying on Foundry's own
    // padding mechanic, so pad by nothing rather than silently inherit
    // Foundry's 25% default (ITEM-20 reopening).
    padding: 0,
    ...requiredDimensions(ROOMS_PER_ROW), // headroom for the first two rows
    flags: { [MODULE_ID]: { role: "dungeon-run" } },
  });
}

/**
 * Build ONE physical room at `slot`. Connects it to `slot - 1` (door starts
 * LOCKED) unless `slot === 0`. `isGoal` suppresses the outgoing side — the
 * goal room has nowhere further to lead; every other room gets a temporary
 * full-face placeholder wall there instead (ITEM-20) until the next room's
 * own build swaps it for the real door/opening geometry — see
 * outgoingFaceWall's docblock. `locationTag`/`artVariant` (from the room's
 * own data — see dungeon-deck.mjs) pick its background Tile. `seed` (the
 * run's own seed) drives the connecting door/opening's independently random
 * placement on each side (ITEM-9), *and* this room's own size (small or
 * large, ITEM-17) — deterministic per run, so it needs threading through
 * from the caller like `locationTag`/`artVariant`.
 */
export async function buildRoomAtSlot(
  scene,
  slot,
  { isGoal = false, locationTag = null, artVariant = 0, seed = "" } = {},
) {
  await ensureSceneCovers(scene, slot);

  const walls = roomEnclosureWalls(seed, slot, { hasOutgoing: !isGoal }).map(
    (side) =>
      wallDoc(side, {
        flags: {
          [MODULE_ID]: {
            dungeonEnclosureWallForSlot: slot,
            dungeonEnclosureWallDirection: side.dir,
          },
        },
      }),
  );
  const tiles = [];
  let placeholderIds = [];

  if (slot > 0) {
    // Supersede slot - 1's own temporary frontier placeholder (ITEM-20,
    // below) with the real, precisely-cut door/opening geometry this room's
    // build now provides for that connection. Looked up now, but actually
    // *deleted only after* the new walls are created below (#110) — doing
    // it the other way around (delete, then a separate awaited create call
    // afterward) left a real window, the round-trip time between those two
    // calls, where slot - 1's whole face had zero walls at all. Foundry
    // recomputes vision on every wall change, and fogExploration bakes
    // whatever was visible into the explored fog permanently; a token near
    // that boundary during the gap would get a real, if brief, unwalled
    // sightline clear across the rest of the scene, staying revealed in
    // the fog forever after even though the correct walls land moments
    // later — the "grey," already-explored-looking leak #110 reported,
    // rather than a live/current-vision leak (buildConnectionGeometry's
    // own geometry was checked by hand for this exact connection and
    // fully encloses the corridor with no gap, so the leak has to be a
    // timing issue like this one rather than wrong geometry). Creating
    // the real walls first means the placeholder and the real geometry
    // briefly overlap (redundant, but both still sight-blocking) instead
    // of a moment with neither.
    placeholderIds = scene.walls
      .filter(
        (w) => w.getFlag(MODULE_ID, "dungeonFrontierWallForSlot") === slot - 1,
      )
      .map((w) => w.id);

    const { doorWall, revealDoorWall, plainWalls, corridorRect } =
      buildConnectionGeometry(slot - 1, seed);
    walls.push(
      wallDoc(doorWall, {
        door: CONST.WALL_DOOR_TYPES.DOOR,
        ds: CONST.WALL_DOOR_STATES.LOCKED,
        flags: { [MODULE_ID]: { dungeonDoorToSlot: slot } },
      }),
    );
    // Never locked — the first door is the progress gate. This one is just
    // the "open it and see what's inside" trigger (handleDungeonDoorOpened),
    // freely operable by players the moment they're through the first door.
    walls.push(
      wallDoc(revealDoorWall, {
        door: CONST.WALL_DOOR_TYPES.DOOR,
        ds: CONST.WALL_DOOR_STATES.CLOSED,
        flags: { [MODULE_ID]: { dungeonRevealDoorForSlot: slot } },
      }),
    );
    walls.push(...plainWalls.map((w) => wallDoc(w)));
    // corridorRect is tiled once per grid square rather than stretching one
    // image across it — corridor.webp is a small self-contained "box"
    // texture that looks wrong scaled. A gallery longer than one tile
    // (ITEM-9/13) uses the open-sided corridor-end/-mid variants instead of
    // repeating the fully-walled box, so it reads as one continuous hallway
    // rather than a stack of separate boxed alcoves (ITEM-12) — see
    // corridorTileVariant's docblock for which tile/rotation goes where.
    // Unlike the room-art Tile below, these can be rotated (ITEM-12), so
    // they must NOT use anchorX/Y:0 — rotation pivots around the texture
    // anchor, and an anchor pinned to the top-left corner spins a rotated
    // tile out of its own grid cell into a neighboring one (confirmed live:
    // a 180°-rotated tile with anchorX/Y:0 rendered one cell up-and-left of
    // its declared position). Leaving anchorX/Y at Foundry's own default
    // (center) and passing the cell's center, not its corner, matches how
    // scene-divination.mjs already places its own rotated card Tiles.
    const vertical = corridorRect.gh >= corridorRect.gw;
    const length = vertical ? corridorRect.gh : corridorRect.gw;
    for (let i = 0; i < length; i += 1) {
      const dx = vertical ? 0 : i;
      const dy = vertical ? i : 0;
      const { variant, rotation } = corridorTileVariant(i, length, vertical);
      tiles.push({
        texture: { src: CORRIDOR_ART_BY_VARIANT[variant] },
        x: toPixels(corridorRect.gx + dx) + toPixels(1) / 2,
        y: toPixels(corridorRect.gy + dy) + toPixels(1) / 2,
        width: toPixels(1),
        height: toPixels(1),
        rotation,
      });
    }
  }

  if (!isGoal && !isSlotBuilt(scene, slot + 1)) {
    // Frontier placeholder (ITEM-20): this room has no outgoing connection
    // built yet, so without a wall here it's open on that entire face
    // until the next room is built — vision, light, and movement all leak
    // straight across the rest of the scene's pre-sized canvas. Deleted
    // and replaced by the real door/opening geometry above the moment
    // that next room actually gets built. Skipped entirely if the next
    // slot is ALREADY built (#62) — an eager GM-less build can build a
    // higher-numbered slot before this one (e.g. a deferred combat room
    // at slot 1 built after slot 2 already exists), in which case the
    // real connection already exists and a placeholder here would
    // immediately be stale, permanently overlaying a door that will never
    // get superseded (nothing triggers supersede-on-next-build for an
    // already-built next slot).
    walls.push(
      wallDoc(outgoingFaceWall(seed, slot), {
        flags: { [MODULE_ID]: { dungeonFrontierWallForSlot: slot } },
      }),
    );
  }

  if (walls.length) await scene.createEmbeddedDocuments("Wall", walls);
  if (placeholderIds.length)
    await scene.deleteEmbeddedDocuments("Wall", placeholderIds);

  const rect = slotRect(seed, slot);
  tiles.push({
    texture: {
      src: roomArtPath({ locationTag, isGoal, artVariant }),
      anchorX: 0,
      anchorY: 0,
    },
    x: toPixels(rect.gx),
    y: toPixels(rect.gy),
    width: toPixels(rect.gw),
    height: toPixels(rect.gh),
  });
  await scene.createEmbeddedDocuments("Tile", tiles);

  // Every room's art paints lit torches in its corners, but painted torches
  // aren't real Foundry light sources — nothing here ever placed an
  // AmbientLight to match, so a party with no darkvision (rules-based vision
  // gives a non-darkvision PC a vision radius of 0, confirmed live) couldn't
  // actually see the room they were standing in (ITEM-14). One centered
  // light per room, radius generous enough to reach every corner (scaled to
  // this room's own actual size, ITEM-17 — see roomLightRadii) plus a bit of
  // dim falloff into the connecting corridor, fixes that without needing
  // per-room-art torch positions (inconsistent across variants — e.g.
  // construct art has none at all).
  const { bright, dim } = roomLightRadii(rect.gw);
  await scene.createEmbeddedDocuments("AmbientLight", [
    {
      x: toPixels(rect.gx + rect.gw / 2),
      y: toPixels(rect.gy + rect.gh / 2),
      config: { dim, bright, color: ROOM_LIGHT_COLOR, alpha: ROOM_LIGHT_ALPHA },
    },
  ]);
}

/**
 * Retrofits a slot originally built as the goal room (isGoal: true,
 * hasOutgoing: false, no frontier placeholder) into a normal room with a
 * real outgoing connection — needed when a sequence mutation (#62) shifts
 * the goal to a new slot and a non-goal room ends up occupying this one.
 * Finds and deletes the one enclosure wall on this slot's own connection
 * direction (flagged by buildRoomAtSlot's own wall creation above), then
 * creates the same frontier-placeholder wall a normal non-goal room gets
 * from the start (buildRoomAtSlot's `if (!isGoal)` block) — after this,
 * the existing, unmodified supersede-on-next-build logic in buildRoomAtSlot
 * (the `if (slot > 0)` block) already knows how to find and replace a
 * dungeonFrontierWallForSlot-flagged wall once the chain extends past it.
 */
export async function openGoalRoomExit(scene, slot, seed) {
  const dir = connectionDirection(slot);
  const staleWallIds = scene.walls
    .filter(
      (w) =>
        w.getFlag(MODULE_ID, "dungeonEnclosureWallForSlot") === slot &&
        w.getFlag(MODULE_ID, "dungeonEnclosureWallDirection") === dir,
    )
    .map((w) => w.id);
  if (!staleWallIds.length) return;
  // Create-then-delete, not the other way around — same reasoning as the
  // buildRoomAtSlot `if (slot > 0)` block's own placeholder-supersede
  // comment: deleting the stale wall first would leave a real window with
  // zero walls on this face at all, leaking vision/light/movement straight
  // across the rest of the scene until the replacement lands.
  await scene.createEmbeddedDocuments("Wall", [
    wallDoc(outgoingFaceWall(seed, slot), {
      flags: { [MODULE_ID]: { dungeonFrontierWallForSlot: slot } },
    }),
  ]);
  await scene.deleteEmbeddedDocuments("Wall", staleWallIds);
}

/**
 * Centers this client's camera on slot's room, zoomed to actually fit it.
 * `createDungeonScene` pre-sizes the scene with headroom for the first two
 * rows of rooms so `buildRoomAtSlot` isn't resizing the canvas on every
 * single room — but that leaves the one room actually built looking tiny and
 * stuck in a corner of a mostly-empty canvas until something pans there,
 * since Foundry's default view on activation just centers on the whole
 * (oversized) scene.
 *
 * The scale is fit to the actual viewport rather than a fixed 1 — a fixed
 * zoom can leave the room's far edge past the visible area on a smaller
 * browser window, which looks exactly like the room's art doesn't reach the
 * walls and tokens are standing outside it, when really the camera just
 * isn't framing the whole room.
 *
 * Called both by the automatic room-entry trigger (which only fires once,
 * for whichever single party token happens to trip it first — with five
 * party tokens crossing one door, the other four's own tokenEnter events
 * find `currentIndex` already advanced and bail out before ever reaching a
 * camera pan) and by the tracker UI's own render, so simply having the
 * tracker window open keeps the view honest regardless of whether that
 * one-shot trigger happened to fire this time. `seed` (ITEM-17) is needed to
 * know this room's own actual size.
 */
export function focusCameraOnSlot(scene, slot, seed) {
  if (canvas?.scene?.id !== scene.id) return;
  const rect = slotRect(seed, slot);
  const roomPixelSize = Math.max(toPixels(rect.gw), toPixels(rect.gh));
  const [screenWidth, screenHeight] = canvas.screenDimensions ?? [1000, 1000];
  // Fit the room's footprint plus a 30% margin into whichever screen
  // dimension is tighter, clamped so a huge or tiny monitor doesn't zoom to
  // an unreasonable extreme.
  const fitScale = Math.min(screenWidth, screenHeight) / (roomPixelSize * 1.3);
  const scale = Math.min(1.5, Math.max(0.3, fitScale));
  canvas.animatePan({
    x: toPixels(rect.gx + rect.gw / 2),
    y: toPixels(rect.gy + rect.gh / 2),
    scale,
    duration: 250,
  });
}

export async function unlockDoorToSlot(scene, slot) {
  const wall = scene.walls.find(
    (w) => w.getFlag(MODULE_ID, "dungeonDoorToSlot") === slot,
  );
  if (wall) {
    await wall.update({ ds: CONST.WALL_DOOR_STATES.CLOSED });
    playDoorSound("unlock");
  }
}

/** Re-locks the progress-gate door AND re-closes the reveal door beyond it —
 * a full undo of both doors' state, not just the one a GM would think to
 * check, in case a player had already opened the second one too. */
export async function relockDoorToSlot(scene, slot) {
  const wall = scene.walls.find(
    (w) => w.getFlag(MODULE_ID, "dungeonDoorToSlot") === slot,
  );
  if (wall) {
    await wall.update({ ds: CONST.WALL_DOOR_STATES.LOCKED });
    playDoorSound("lock");
  }
  const revealWall = scene.walls.find(
    (w) => w.getFlag(MODULE_ID, "dungeonRevealDoorForSlot") === slot,
  );
  if (revealWall)
    await revealWall.update({ ds: CONST.WALL_DOOR_STATES.CLOSED });
}

/** Whether a combat room's monsters have already been placed. */
export function isSlotPopulated(scene, slot) {
  return scene.tokens.some((t) => t.getFlag(MODULE_ID, "dungeonSlot") === slot);
}

/** Whether slot's own walls/geometry have been built yet — `dungeonDoorToSlot`
 * only ever exists on the connecting door `buildConnectionGeometry` adds
 * inside `buildRoomAtSlot`'s `slot > 0` branch, so its presence means the
 * room itself has already been constructed (used to tell a first real combat
 * room whose build is still deliberately deferred (ITEM-11 reopening) apart
 * from one that's merely unpopulated after a cancelled Accept/Reroll). */
export function isSlotBuilt(scene, slot) {
  return scene.walls.some(
    (w) => w.getFlag(MODULE_ID, "dungeonDoorToSlot") === slot,
  );
}

/**
 * Generate a combat room's encounter inside slot's own footprint. Hidden by
 * default (the discovery beat) — room 0 is the one exception, since the
 * party starts there with no door to walk through, so Start calls this with
 * `hidden:false`. The GM still gets the existing Accept/Reroll preview —
 * nothing about that flow changes, it's just handed a target room instead of
 * "near a focus token." No theme dialog, though (ITEM-21): a dungeon run's
 * traits/excludeTraits are captured once at "Start Dungeon" and reused
 * unchanged for every room it populates (Start, Populate Next Room, combat
 * recovery all funnel through here), so re-asking for the same traits every
 * time would just repeat a prompt the GM already answered. `seed` (ITEM-17)
 * is needed to know this room's own actual size, for the encounter's
 * spawn-placement area.
 */
export async function populateSlotEncounter(
  scene,
  slot,
  {
    prefillTraits = [],
    prefillExcludeTraits = [],
    hidden = true,
    levelOffsetBias = 0,
    locationTag = null,
    seed = "",
  } = {},
) {
  const rect = slotRect(seed, slot);
  await generateEncounter({
    prefillTraits,
    prefillExcludeTraits,
    levelOffsetBias,
    locationTag,
    skipThemeDialog: true,
    scene,
    originArea: {
      x: toPixels(rect.gx),
      y: toPixels(rect.gy),
      width: toPixels(rect.gw),
      height: toPixels(rect.gh),
    },
    forceHidden: hidden,
    extraFlags: { [MODULE_ID]: { dungeonSlot: slot } },
  });
}

/**
 * Spawn a real trap-tagged hazard from `pf2e.hazards` inside slot's own
 * footprint (#135), for a `trap` room (#32; `buildPopulateAndUnlockRoom`'s
 * own job to know that — this function doesn't care where
 * `partyLevel`/`levelOffsetBias` came from). Hidden, exactly like a combat
 * room's own monsters
 * (`populateSlotEncounter` above) — `revealSlotTokens` already un-hides
 * anything flagged `dungeonSlot`, generic to token kind, so no changes
 * were needed there for this to work; #134's `rollTrapDetection` is what
 * actually "finds" a trap once revealed, the same way a Perception check
 * finds anything else hidden on the scene.
 *
 * `disposition: 0` (neutral) rather than `-1` (hostile, what
 * `spawnCreatures` defaults to for monsters) — an unattended hazard isn't
 * anyone's combatant, same reasoning #96's cover items already use.
 * `trapHazard: true` alongside the usual `dungeonSlot` flag mirrors
 * #96/#146's own `coverItem` flag: nothing currently reads it (a `trap`
 * room never starts a real Combat, so `dungeon-combat.mjs`'s
 * `combatantTokens` sweep never runs against this slot at all), but it's
 * cheap, harmless insurance against ever reintroducing that exact class of
 * bug for a hazard actor that, like a cover item, should never take a turn.
 *
 * A no-op (with a GM-facing warning) if the compendium has nothing
 * level-appropriate — the room's own setpiece stub text
 * (`dungeon-setpieces.json`) stays the only thing the GM sees for that
 * rare case, per #135's own "only fall back to a hand-authored stub for a
 * case the compendium genuinely doesn't have."
 *
 * Flags the newly spawned actor `trapCustomization: {status: 'pending',
 * locationTag, partyLevel, sceneId, roomId}` (#136, `sceneId`/`roomId`
 * added by #56) — the one place that flag gets set, read back by
 * `trap-combat.mjs`'s `getPendingTrapCustomization` for `tools/agent-loop`'s
 * poller to offer an external agent a chance to rewrite its name/description
 * before the room's reveal door ever opens, and (#56) by
 * `applyTrapCustomization` to find which room's persisted `trap` state to
 * keep in sync once a customization actually lands. `locationTag` is
 * threaded straight through from the room (this function's own caller
 * already has it; `populateSlotTrap` itself has no opinion on where it came
 * from), so the agent knows what terrain/theme to write flavor for.
 *
 * Also seeds `roomId`'s own persisted `trap` state (#56, via
 * `ensureTrapState`) with the spawned hazard's own name/description — the
 * same reason `ensurePuzzleState` persists a puzzle's name/summary onto the
 * room rather than leaving it to be read fresh off the raw setpiece every
 * render: it gives a player-facing display (dungeon-app.mjs's setpiece
 * block) real, room-specific data to show instead of always falling back to
 * one of the 3 generic, unrelated static stub blurbs in
 * `dungeon-setpieces.json`, customized or not.
 */
export async function populateSlotTrap(
  scene,
  slot,
  { partyLevel, levelOffsetBias = 0, locationTag = null, seed = "", roomId } = {},
) {
  const rect = slotRect(seed, slot);
  const api = makeFoundryApi(scene);
  const rng = splitmix32(seedFromString(`${seed}-trap-${slot}`));
  const trap = await selectTrap({ api, partyLevel, levelOffsetBias, rng });
  if (!trap) {
    ui.notifications.warn(
      game.i18n.localize("PF2EDC.Dungeon.Trap.NoneFoundWarning"),
    );
    return;
  }
  const [spawned] = await api.spawnCreatures(
    [{ pack: trap.pack, id: trap.id }],
    {
      originArea: {
        x: toPixels(rect.gx),
        y: toPixels(rect.gy),
        width: toPixels(rect.gw),
        height: toPixels(rect.gh),
      },
      disposition: 0,
      hidden: true,
      extraFlags: { [MODULE_ID]: { dungeonSlot: slot, trapHazard: true } },
    },
  );
  const actor = spawned && game.actors.get(spawned.actorId);
  if (actor) {
    await actor.setFlag(MODULE_ID, "trapCustomization", {
      status: "pending",
      locationTag,
      partyLevel,
      sceneId: scene.id,
      roomId,
    });
    await ensureTrapState(scene.id, roomId, {
      name: actor.name,
      description: actor.system?.details?.description ?? "",
    });
  }
}

/**
 * Teardown counterpart to `populateSlotEncounter` above (#62 mutation
 * reconciliation) — needed when a Reward/Ruin sequence mutation changes
 * which logical room an already-built physical slot corresponds to, so
 * that slot's stale content is removed before the new room's own content
 * populates it (otherwise the new room's tokens would just layer on top of
 * the old room's leftover tokens instead of replacing them). Deletes every
 * token flagged `getFlag(MODULE_ID, "dungeonSlot") === slot`, and (for any
 * non-party actor among them) that token's own Actor document too —
 * mirrors `sweepLooseNpcActors`'s own token+actor deletion shape exactly,
 * scoped to one slot instead of the whole scene. Guards against ever
 * deleting a real party member's Actor document (defensive: a party token
 * shouldn't carry a `dungeonSlot` flag in the first place, but this
 * doesn't assume that). A no-op if nothing is flagged for this slot.
 */
export async function clearSlotEncounter(scene, slot) {
  const tokens = scene.tokens.filter(
    (t) => t.getFlag(MODULE_ID, "dungeonSlot") === slot,
  );
  if (!tokens.length) return;
  const partyIds = partyActorIds();
  const tokenIds = tokens.map((t) => t.id);
  const actorIds = [
    ...new Set(
      tokens.map((t) => t.actor?.id).filter((id) => id && !partyIds.has(id)),
    ),
  ];
  await scene.deleteEmbeddedDocuments("Token", tokenIds);
  if (actorIds.length) await Actor.deleteDocuments(actorIds);
}

/**
 * Teardown counterpart to `populateSlotTrap` above — a trap's spawned
 * hazard token carries the same `dungeonSlot` flag a combat encounter's
 * tokens do (see `populateSlotTrap`'s own `extraFlags`), so the same
 * flag-scoped token+actor deletion `clearSlotEncounter` already does
 * applies unchanged here. Does not touch `roomId`'s persisted `trap` state
 * (`ensureTrapState`'s own field) — that's `dungeon-runner.mjs`'s
 * `clearTrapState`'s job; the caller runs both together.
 */
export async function clearSlotTrap(scene, slot) {
  await clearSlotEncounter(scene, slot);
}

/** Un-hides slot's tagged tokens (discovery). Returns the ids revealed. */
export async function revealSlotTokens(scene, slot) {
  const tokens = scene.tokens.filter(
    (t) => t.getFlag(MODULE_ID, "dungeonSlot") === slot && t.hidden,
  );
  const ids = tokens.map((t) => t.id);
  if (ids.length)
    await scene.updateEmbeddedDocuments(
      "Token",
      ids.map((id) => ({ _id: id, hidden: false })),
    );
  return ids;
}

/** Inverse of revealSlotTokens, for undo. */
export async function hideTokens(scene, tokenIds) {
  if (tokenIds?.length) {
    await scene.updateEmbeddedDocuments(
      "Token",
      tokenIds.map((id) => ({ _id: id, hidden: true })),
    );
  }
}

function partyActorIds() {
  return new Set((game.actors?.party?.members ?? []).map((m) => m.id));
}

/** An actor should only ever have one token in the world at a time (the party
 * moves as a unit between the dungeon and wherever they came from) — used by
 * both placePartyInSlot and teardownDungeonRun's return-trip placement. */
async function removeActorTokensFromAllScenes(actorId) {
  for (const s of game.scenes) {
    const existing = s.tokens.filter((t) => t.actor?.id === actorId);
    if (existing.length)
      await s.deleteEmbeddedDocuments(
        "Token",
        existing.map((t) => t.id),
      );
  }
}

/** Start-of-run: place the party's tokens inside slot, removing any of their
 * tokens elsewhere in the world first. `seed` (ITEM-17) is needed to know
 * this room's own actual size. */
export async function placePartyInSlot(scene, slot, partyMembers, seed) {
  const rect = slotRect(seed, slot);
  const occupied = [];
  const createdIds = [];
  for (const actor of partyMembers) {
    await removeActorTokensFromAllScenes(actor.id);
    const spot = freeSpotInRect({ occupied, rect, gw: 1, gh: 1 }) ?? {
      gx: rect.gx,
      gy: rect.gy,
      gw: 1,
      gh: 1,
    };
    occupied.push(spot);
    const td = await actor.getTokenDocument({
      x: toPixels(spot.gx),
      y: toPixels(spot.gy),
    });
    const [created] = await scene.createEmbeddedDocuments("Token", [
      td.toObject(),
    ]);
    createdIds.push(created.id);
  }
  return createdIds;
}

/**
 * End-of-run return trip (ITEM-18's teardownDungeonRun): cluster the party
 * near a scene's own center, in that scene's own grid units rather than this
 * module's fixed GRID_SIZE — `destScene` is an arbitrary scene this module
 * never built (the party's own regular scene, or Foundry's built-in default),
 * so it can't be assumed to share the dungeon's grid size.
 */
async function placePartyNearSceneCenter(destScene, partyMembers) {
  const spacing = Math.max(destScene.grid?.size ?? 100, 50);
  const centerX = (destScene.width ?? spacing * 10) / 2;
  const centerY = (destScene.height ?? spacing * 10) / 2;
  const perRow = 3;
  const createdIds = [];
  for (const [i, actor] of partyMembers.entries()) {
    await removeActorTokensFromAllScenes(actor.id);
    const col = i % perRow;
    const row = Math.floor(i / perRow);
    const x = centerX + (col - 1) * spacing;
    const y = centerY + row * spacing;
    const td = await actor.getTokenDocument({ x, y });
    const [created] = await destScene.createEmbeddedDocuments("Token", [
      td.toObject(),
    ]);
    createdIds.push(created.id);
  }
  return createdIds;
}

/**
 * Deletes every non-party actor (and, unless `deleteTokens` is false, its
 * token) still on `scene` — any NPC or converted loot corpse (#172) left
 * over from this run's own encounters, since `spawnCreatures`/
 * `spawnBuiltCreature` (foundry-api.mjs) always create a real, permanent
 * world Actor that otherwise outlives its token forever (confirmed live: 72
 * such orphaned actors had accumulated in this world before
 * `teardownDungeonRun` existed to catch them at Abandon time). Keyed purely
 * on "not a party member," never on actor type, so an un-looted #172 corpse
 * is swept exactly the same as an un-deleted NPC always was. Shared by
 * `teardownDungeonRun` (scene is about to be deleted, so the token deletion
 * below is redundant but harmless), #204's completion-time sweep (the scene
 * survives, so this is the only thing that actually removes them), and #14's
 * `deleteScene` hook (the scene is already gone by the time that hook fires
 * — Foundry's own delete cascade already removed its Tokens, so calling
 * `deleteEmbeddedDocuments` on it would throw; `deleteTokens: false` skips
 * straight to the Actor cleanup that cascade can't do for us).
 */
export async function sweepLooseNpcActors(scene, { deleteTokens = true } = {}) {
  const partyIds = partyActorIds();
  const looseTokens = scene.tokens.filter(
    (t) => t.actor?.id && !partyIds.has(t.actor.id),
  );
  const npcTokenIds = looseTokens.map((t) => t.id);
  const npcActorIds = [...new Set(looseTokens.map((t) => t.actor.id))];

  if (deleteTokens && npcTokenIds.length)
    await scene.deleteEmbeddedDocuments("Token", npcTokenIds);
  if (npcActorIds.length) await Actor.deleteDocuments(npcActorIds);

  return npcActorIds.length;
}

/**
 * Sweeps any #172 corpse (or plain leftover NPC) still on `scene` once a
 * dungeon run completes normally — the goal room resolved, not the party
 * abandoning the run (see `teardownDungeonRun` for that path). Unlike
 * `teardownDungeonRun`, the scene itself is left alone and the party stays
 * put: a completed dungeon is still a real place the party might keep
 * exploring or looting, not something to be yanked out of automatically.
 * Before this, only `teardownDungeonRun`'s Abandon-time sweep ever cleaned
 * these up — a party that *wins* and walks away left every un-looted corpse
 * behind indefinitely (#204).
 */
export async function sweepCompletedDungeonScene(scene) {
  return sweepLooseNpcActors(scene);
}

/**
 * Full teardown for a cancelled dungeon run (ITEM-18). Moves the party back
 * to `previousSceneId` (wherever they were before the run started — see
 * dungeon-runner.mjs's createRun) if that scene still exists, or Foundry's
 * own built-in "Foundry Virtual Tabletop" default scene otherwise. Sweeps
 * every non-party actor this run's encounters ever spawned (see
 * `sweepLooseNpcActors`), then deletes the dungeon scene itself.
 */
export async function teardownDungeonRun(
  scene,
  { previousSceneId = null } = {},
) {
  const partyIds = partyActorIds();
  const partyMembers = (game.actors?.party?.members ?? []).filter((m) =>
    partyIds.has(m.id),
  );

  let destScene = previousSceneId ? game.scenes.get(previousSceneId) : null;
  if (!destScene)
    destScene =
      game.scenes.find((s) => s.name === "Foundry Virtual Tabletop") ?? null;

  if (destScene && partyMembers.length) {
    await placePartyNearSceneCenter(destScene, partyMembers);
    await destScene.activate();
  }

  const deletedNpcActorCount = await sweepLooseNpcActors(scene);
  await scene.delete();

  return {
    destSceneId: destScene?.id ?? null,
    deletedNpcActorCount,
  };
}

/** Move already-placed tokens into slot — for undo, stepping the party back.
 * `seed` (ITEM-17) is needed to know this room's own actual size. */
export async function moveTokensToSlot(scene, tokenIds, slot, seed) {
  if (!tokenIds?.length) return;
  const rect = slotRect(seed, slot);
  const updates = tokenIds.map((id, i) => ({
    _id: id,
    x: toPixels(rect.gx + (i % rect.gw)),
    y: toPixels(rect.gy + Math.floor(i / rect.gw)),
  }));
  await scene.updateEmbeddedDocuments("Token", updates);
}

/**
 * Build+populate+unlock one room at its physical slot. Shared by
 * ui/dungeon-app.mjs's normal outcome-resolution path, its #onStart's
 * auto-advance past the safe entry room, and handleDungeonDoorOpened's own
 * auto-advance past a mid-dungeon rest room below — none of which have
 * anything to resolve, so nothing ever calls resolveCurrentRoom for them
 * (see dungeon-deck.mjs's buildRoomSequence). Lives here rather than in
 * ui/dungeon-app.mjs because handleDungeonDoorOpened needs it too, and this
 * file deliberately never imports from ui/dungeon-app.mjs (see this file's
 * own docblock).
 */
export async function buildPopulateAndUnlockRoom(
  scene,
  state,
  room,
  physicalSlot,
  { unlock = true } = {},
) {
  if (!isSlotBuilt(scene, physicalSlot)) {
    await buildRoomAtSlot(scene, physicalSlot, {
      isGoal: room.isGoal,
      locationTag: room.locationTag,
      artVariant: room.artVariant,
      seed: state.seed,
    });
  }

  if (room.kind === "combat") {
    if (!isSlotPopulated(scene, physicalSlot)) {
      await populateSlotEncounter(scene, physicalSlot, {
        prefillTraits: state.traits,
        prefillExcludeTraits: state.excludeTraits,
        levelOffsetBias: depthBiasFor({
          physicalSlot,
          roomCount: state.rooms.length,
          isGoal: room.isGoal,
        }),
        locationTag: room.locationTag,
        seed: state.seed,
      });
    }
    // Only unlock once monsters are actually in place — a cancelled theme
    // dialog leaves the door locked rather than opening onto an empty room;
    // the GM retries via the "Populate Next Room" button.
    if (unlock && isSlotPopulated(scene, physicalSlot))
      await unlockDoorToSlot(scene, physicalSlot);
  } else {
    // #109: a skill_challenge room's Victory Point state used to be
    // lazily attached the first time DungeonApp rendered it — but a
    // client logged in only to relay a GM-less host's requests never
    // renders DungeonApp at all, so that write would never happen for
    // such a run. Attaching it here instead means it's always done by
    // whichever client is actually building the room (a GM directly, or
    // the GM-side relay handler executing a routed request) — the same
    // place trap/encounter population already happens for the room
    // that's about to become current.
    if (room.kind === "skill_challenge") {
      const partyMembers = (game.actors?.party?.members ?? []).filter(
        (m) => m.type === "character",
      );
      // #164: the template (if any) is selected once, here, at the same
      // build-time this room's Victory Point state is first attached —
      // ensureSkillChallenge itself is a no-op past that point, so this
      // never re-rolls a template a later re-render/re-build might
      // otherwise see rendered differently.
      const setpieces = await loadDungeonSetpieces();
      const template = selectSkillChallengeTemplate(
        setpieces,
        state.seed,
        room.id,
      );
      await ensureSkillChallenge(scene.id, room.id, {
        seed: state.seed,
        locationTag: room.locationTag,
        partySize: partyMembers.length,
        depthBias: depthBiasFor({
          physicalSlot,
          roomCount: state.rooms.length,
          isGoal: room.isGoal,
        }),
        template,
      });
    }
    // #32: puzzle and trap are now decided up front as their own room kinds
    // (dungeon-deck.mjs's ROOM_KIND_WEIGHTS/roomKindAt), so this dispatches
    // directly on room.kind — no more resolving the setpiece just to find
    // out which branch to take, the way the old combined 'puzzle_or_trap'
    // kind required. A puzzle setpiece's own state is attached right here
    // too (#109/#137) — it used to lazily attach itself the first time the
    // room rendered in dungeon-app.mjs, the same pattern skill_challenge's
    // own state used to use above before #109 moved it to this same
    // build-time spot, for the same reason: a client only relaying a
    // GM-less host's requests never renders DungeonApp at all. A trap room
    // additionally gets a real, mechanically-functional hazard spawned from
    // pf2e.hazards for #134's engine to run.
    if (
      room.kind === "trap" &&
      room.setpieceId &&
      !isSlotPopulated(scene, physicalSlot)
    ) {
      await populateSlotTrap(scene, physicalSlot, {
        partyLevel: await makeFoundryApi().partyLevel(),
        levelOffsetBias: depthBiasFor({
          physicalSlot,
          roomCount: state.rooms.length,
          isGoal: room.isGoal,
        }),
        locationTag: room.locationTag,
        seed: state.seed,
        roomId: room.id,
      });
    } else if (room.kind === "puzzle" && room.setpieceId) {
      const setpieces = await loadDungeonSetpieces();
      const setpiece = setpieces.find((s) => s.id === room.setpieceId);
      await ensurePuzzleState(scene.id, room.id, {
        hintChecks: setpiece.hintChecks,
        requiredSuccesses: setpiece.requiredSuccesses ?? null,
        partyLevel: await makeFoundryApi().partyLevel(),
        name: setpiece.name ?? null,
        summary: setpiece.summary ?? null,
      });
    }
    // #167: a narrative room's own selected content is attached here too
    // (#165 gives it a setpieceId the same way a puzzle or trap room has
    // always had one) — persisted as `room.narrative` rather than read straight
    // off the raw setpiece (#165's original shape), so an external agent's
    // later customization (ensureNarrativeState's own docblock explains
    // why) has somewhere durable to land.
    if (room.kind === "narrative" && room.setpieceId) {
      const setpieces = await loadDungeonSetpieces();
      const setpiece = setpieces.find((s) => s.id === room.setpieceId);
      if (setpiece?.kind === "narrative" && isValidNarrativeTemplate(setpiece)) {
        await ensureNarrativeState(scene.id, room.id, { setpiece });
      }
    }
    // #89: a treasure room's own selected content is attached here too, the
    // same build-time spot as puzzle/narrative above — treasure has no
    // per-archetype mechanical shape to validate (unlike narrative's
    // isValidNarrativeTemplate) since a treasure setpiece carries nothing
    // but name/summary; any setpiece of this kind is usable as-is. This is
    // the integration point that makes treasure participate correctly in
    // #62's eager-build-for-GM-less-runs and mutation-reconciliation
    // machinery the same way every other kind already does — without it, a
    // GM-less run would never get a treasure room's flavor attached at all,
    // and a mutation that relocates a treasure room wouldn't reconcile its
    // content correctly either.
    if (room.kind === "treasure" && room.setpieceId) {
      const setpieces = await loadDungeonSetpieces();
      const setpiece = setpieces.find((s) => s.id === room.setpieceId);
      if (setpiece?.kind === "treasure") {
        await ensureTreasureState(scene.id, room.id, { setpiece });
      }
    }
    if (unlock) await unlockDoorToSlot(scene, physicalSlot);
  }
}

/**
 * Called from module.mjs's `updateWall` hook whenever any door's state
 * changes to OPEN — ignores anything that isn't the true frontier room's own
 * reveal door (`dungeonRevealDoorForSlot`), so a plain scenery door, an
 * already-passed room's door being reopened, or a GM idly clicking a wall
 * can't desync the tracker.
 *
 * Returns `{ autoOpenTracker }` (`false` on every early-return path, since
 * nothing was actually revealed) — #158: a combat room's own reveal already
 * draws the GM's attention through Foundry's native Combat Tracker the
 * instant `startCombatForSlot` runs below, but a skill challenge, puzzle/
 * trap, narrative, or rest room has no such native surface at all, so
 * without this the GM has to know to reopen the Dungeon Crawl tracker
 * themselves just to see the Succeed/Fail buttons. module.mjs's own
 * `updateWall` hook (which this file deliberately never imports back into,
 * see this file's own docblock) is what actually opens `DungeonApp` — this
 * only ever hands back the plain boolean, same bridge pattern
 * `onCombatAutoResolved` already uses for `resolveCurrentRoom`.
 */
export async function handleDungeonDoorOpened(sceneId, wallId) {
  // Called directly from a global hook, which fires on every connected
  // client — only the GM's own client should act on it.
  if (!game.user.isGM) return { autoOpenTracker: false };
  const scene = game.scenes.get(sceneId);
  const wall = scene?.walls.get(wallId);
  const slot = wall?.getFlag(MODULE_ID, "dungeonRevealDoorForSlot");
  if (slot == null) return { autoOpenTracker: false };

  const state = getRunState(sceneId);
  if (!state) return { autoOpenTracker: false };
  const nextRoomId = state.rooms[state.currentIndex + 1]?.id;
  if (!nextRoomId || state.physicalSlotByRoomId[nextRoomId] !== slot)
    return { autoOpenTracker: false };

  playDoorSound("open");
  const revealedTokenIds = await revealSlotTokens(scene, slot);
  const nextRoom = state.rooms.find((r) => r.id === nextRoomId);
  // Started here, not at populateSlotEncounter/build time — the room's
  // monsters spawn hidden, and starting Combat before the door is actually
  // opened would give away that a fight is coming.
  if (nextRoom?.kind === "combat") await startCombatForSlot(scene, slot);
  const { state: advancedState } = await advanceToRoom({
    sceneId,
    roomId: nextRoomId,
    revealedTokenIds,
  });
  focusCameraOnSlot(scene, slot, state.seed);

  // A rest room (ITEM-5) is safe and has nothing to resolve — like the
  // entry, its own way forward opens immediately, no GM click required,
  // instead of leaving the party stuck with no Succeed/Fail button to press.
  if (nextRoom?.kind === "safe_rest" && advancedState) {
    const {
      state: resolvedState,
      nextRoomId: afterRestId,
      nextPhysicalSlot: afterRestSlot,
    } = await markRoomOutcome({ sceneId, succeeded: true });
    if (afterRestId && afterRestSlot != null) {
      const afterRestRoom = resolvedState.rooms.find(
        (r) => r.id === afterRestId,
      );
      await buildPopulateAndUnlockRoom(
        scene,
        resolvedState,
        afterRestRoom,
        afterRestSlot,
      );
    }
  }

  return { autoOpenTracker: nextRoom?.kind !== "combat" };
}

/** Reverses the most recent automatic entry: re-hides what was revealed,
 * re-locks the door, and steps the party's tokens back a room. */
export async function undoRoomEntry(sceneId) {
  const scene = game.scenes.get(sceneId);
  const state = getRunState(sceneId);
  if (!scene || !canUndoRoomEntry(state)) {
    ui.notifications.warn(
      game.i18n.localize("PF2EDC.Dungeon.AlreadyResolvedUndoWarning"),
    );
    return;
  }

  const entry = state.lastAutoEntry;
  await hideTokens(scene, entry.revealedTokenIds);
  await relockDoorToSlot(scene, state.physicalSlotByRoomId[entry.roomId]);

  const previousRoomId = state.rooms[entry.fromIndex].id;
  const previousSlot = state.physicalSlotByRoomId[previousRoomId];
  const partyIds = partyActorIds();
  const partyTokenIds = scene.tokens
    .filter((t) => partyIds.has(t.actor?.id))
    .map((t) => t.id);
  await moveTokensToSlot(scene, partyTokenIds, previousSlot, state.seed);

  await undoLastRoomEntry({ sceneId });
}
