/**
 * GM-facing orchestration for "Generate Encounter" — dialog-driven,
 * modelled on scene-divination.mjs's direct-call style rather than the
 * card-effects plan/replay system. That machinery exists to make a single,
 * irreversible draw from the shared depleting play deck previewable; this
 * generator never touches that deck.
 * #93: the dealt roster is always accepted outright — there is no
 * Accept/Reroll preview step (see generateEncounter below).
 */
import { makeFoundryApi } from "./foundry-api.mjs";
import { buildEncounterDeck, dealEncounter } from "./encounter-deck.mjs";
import { getGenerator } from "./generator-registry.mjs";
import { loadCreatureArt, loadCreatureEnvironments } from "./data-loader.mjs";
import {
  buildEnvironmentLookup,
  normalizeEnvironment,
} from "./environments.mjs";
import { findCreatureArt, creatureArtPath } from "./creature-art.mjs";
import { startCombatForEncounterId } from "./dungeon-combat.mjs";
import { chooseCoverItemTypes } from "./cover-items.mjs";
import { depthBiasForDifficultyTier, xpBudget } from "./encounter-roster.mjs";
import { chooseEncounterForces } from "./encounter-forces-dialog.mjs";
import { splitBudget, validateShares } from "./force-budget.mjs";

const MODULE_ID = "pf2e-dungeon-crawl";

function freshSeed() {
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/** #1083: distinct token tints, one per force (wraps). */
export const FORCE_TINTS = [
  "#ff6b6b",
  "#4dabf7",
  "#69db7c",
  "#ffd43b",
  "#da77f2",
  "#ffa94d",
];
export const forceTint = (index) => FORCE_TINTS[index % FORCE_TINTS.length];

/** #1083: the combat forces table for the surviving forces. */
export function buildForceTable(forces) {
  return Object.fromEntries(
    forces.map((f) => [f.id, { hostility: f.hostility, hostileTo: [] }]),
  );
}

const NEAR_PARTY_OFFSETS = [
  { dx: 0, dy: 0 },
  { dx: 4, dy: 0 },
  { dx: -4, dy: 0 },
  { dx: 0, dy: 4 },
  { dx: 0, dy: -4 },
  { dx: 4, dy: 4 },
];

async function postEncounterChatCard(api, roster, force = null) {
  const content = await renderTemplate(
    `modules/${MODULE_ID}/templates/encounter-chat.hbs`,
    force ? { roster, force } : { roster },
  );
  await api.postChatCard({ content, whisperGM: true });
}

/** The party member (by actor id) whose token is on the current scene, to place the encounter near. */
function findFocusActorId(partyMembers) {
  const onScene = new Set(
    (canvas.tokens?.placeables ?? []).map((t) => t.actor?.id).filter(Boolean),
  );
  return (
    partyMembers.find((m) => onScene.has(m.id))?.id ??
    partyMembers[0]?.id ??
    null
  );
}

/** Full module-relative art URL for a creature-art.json filename, or null. */
function resolveArt(creatureArt, ref) {
  const filename = findCreatureArt(creatureArt, ref);
  return filename
    ? `modules/${MODULE_ID}/assets/${creatureArtPath(filename)}`
    : null;
}

/** extraFlags minus the per-force identity keys (non-force flags are kept). */
function friendFlags(extraFlags) {
  const mod = extraFlags?.[MODULE_ID];
  if (!mod) return extraFlags;
  const { forceId, forceName, originalName, ...rest } = mod;
  return { ...extraFlags, [MODULE_ID]: rest };
}

async function spawnEncounterTokens(
  api,
  roster,
  partyMembers,
  {
    originArea = null,
    forceHidden = false,
    extraFlags = null,
    creatureArt = [],
    // #1083: per-force spawn options. placementArea (a region) is separate
    // from originArea so it never triggers the dungeon-room branches.
    placementArea = null,
    originOffsetCells = null,
    tint = null,
    nameSuffix = null,
  } = {},
) {
  const nearActorId = findFocusActorId(partyMembers);
  const place = (hidden) => ({
    nearActorId,
    originArea: placementArea ?? originArea,
    extraFlags,
    hidden: hidden || forceHidden,
    ...(originOffsetCells ? { originOffsetCells } : {}),
    ...(tint ? { tint } : {}),
    ...(nameSuffix ? { nameSuffix } : {}),
  });
  const withArt = (e) => ({ ...e, imgFallback: resolveArt(creatureArt, e) });

  if (roster.foes.length) {
    const entries = roster.foes
      .flatMap((f) => Array(f.count ?? 1).fill({ pack: f.pack, id: f.id }))
      .map(withArt);
    await api.spawnCreatures(entries, { ...place(false), disposition: -1 });
  }
  if (roster.friend) {
    const entries = [
      withArt({ pack: roster.friend.pack, id: roster.friend.id }),
    ];
    // #1083: the Friend is the party's ally, never a member of the force --
    // no forceId/forceName flags, tint or name suffix.
    const placement = { ...place(false), extraFlags: friendFlags(extraFlags) };
    delete placement.tint;
    delete placement.nameSuffix;
    const [spawned] =
      (await api.spawnCreatures(entries, {
        ...placement,
        disposition: 1,
      })) ?? [];
    // #810: a Friend spawned hidden (full dungeon pregeneration, #93) is
    // announced later, when its room is revealed (dungeon-scene.mjs's
    // revealSlotTokens), not here -- that would spoil every ally in the
    // dungeon at once. A non-hidden Friend (standalone macro) is still
    // announced immediately.
    if (spawned && !placement.hidden) {
      await api.postChatCard({
        content: game.i18n.format("PF2EDC.Encounter.FriendAnnounceChat", {
          name: spawned.name,
        }),
      });
    }
  }
  if (roster.twins) {
    const entries = roster.twins.map((t) =>
      withArt({ pack: t.pack, id: t.id }),
    );
    await api.spawnCreatures(entries, { ...place(false), disposition: -1 });
  }
  if (roster.lurker) {
    // Hidden: the book has the lurker ambush once the party is distracted, not
    // stand revealed on the table from the moment the encounter is generated.
    const entries = [
      withArt({ pack: roster.lurker.pack, id: roster.lurker.id }),
    ];
    await api.spawnCreatures(entries, { ...place(true), disposition: -1 });
  }
}

/**
 * #1083: bounding rectangle of a Foundry region's shapes (rectangle x/y/
 * width/height, ellipse/circle centre + radii, polygon flat points), or null.
 */
export function regionBoundsFromShapes(shapes) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const add = (x1, y1, x2, y2) => {
    if (![x1, y1, x2, y2].every(Number.isFinite)) return;
    minX = Math.min(minX, x1);
    minY = Math.min(minY, y1);
    maxX = Math.max(maxX, x2);
    maxY = Math.max(maxY, y2);
  };
  for (const sh of Array.isArray(shapes) ? shapes : []) {
    if (!sh) continue;
    if (sh.type === "rectangle") {
      add(sh.x, sh.y, sh.x + sh.width, sh.y + sh.height);
    } else if (sh.type === "ellipse") {
      add(sh.x - sh.radiusX, sh.y - sh.radiusY, sh.x + sh.radiusX, sh.y + sh.radiusY);
    } else if (sh.type === "circle") {
      add(sh.x - sh.radius, sh.y - sh.radius, sh.x + sh.radius, sh.y + sh.radius);
    } else if (sh.type === "polygon" && Array.isArray(sh.points)) {
      for (let i = 0; i + 1 < sh.points.length; i += 2) {
        add(sh.points[i], sh.points[i + 1], sh.points[i], sh.points[i + 1]);
      }
    }
  }
  return Number.isFinite(minX)
    ? { x: minX, y: minY, width: maxX - minX, height: maxY - minY }
    : null;
}

function regionArea(scene, regionId) {
  const region = scene.regions?.get?.(regionId);
  const b = region?.bounds;
  if (b && [b.x, b.y, b.width, b.height].every(Number.isFinite)) {
    return { x: b.x, y: b.y, width: b.width, height: b.height };
  }
  const shapes = region?.shapes;
  return regionBoundsFromShapes(shapes ? Array.from(shapes) : null);
}

const FILTER_NAMES = [
  ["levelRange", (f) => f.levelOffsetMin != null || f.levelOffsetMax != null],
  ["rarity", (f) => !!f.rarity],
  ["environment", (f) => !!f.environment],
];

/** #1083: the multi-force generate/spawn path (stand-alone macro only). */
async function generateForces({
  chosen,
  scene,
  api,
  creatureArt,
  partyLevel,
  partyMembers,
  partySize,
  originArea,
  forceHidden,
  extraFlags,
  levelOffsetBias,
  locationTag,
  isBoss,
}) {
  const { difficulty, forces } = chosen;
  const shares = forces.map((f) => f.share);
  const check = validateShares(shares);
  if (!check.ok) {
    ui.notifications.warn(
      game.i18n.format("PF2EDC.Encounter.ForceSharesInvalid", { total: check.total }),
    );
    return;
  }
  const caps = splitBudget(xpBudget(difficulty, partySize), shares);
  const seed = freshSeed();
  const deckSlots = buildEncounterDeck({ seed });

  const survivors = [];
  for (const [i, force] of forces.entries()) {
    const seedI = `${seed}-${force.id}`;
    const dealt = dealEncounter(deckSlots, { seed: seedI, partySize });
    const fl = force.filters ?? {};
    // #1272: a force's own environment overrides; "" inherits the encounter's.
    const forceEnv = normalizeEnvironment(fl.environment || chosen.environment);
    const roster = { ...(await getGenerator().generateEncounterRoster({
      resolved: dealt.resolved,
      api,
      partyLevel,
      traits: fl.traits ?? [],
      excludeTraits: fl.excludeTraits ?? [],
      levelOffsetMin: fl.levelOffsetMin ?? null,
      levelOffsetMax: fl.levelOffsetMax ?? null,
      rarity: fl.rarity ?? "",
      xpCapOverride: caps[i],
      levelOffsetBias,
      requireTrait: locationTag,
      partySize,
      isBoss,
      depthBias: null,
      ...(await environmentArgs(forceEnv, creatureArt)),
    })) };
    const applied = roster.appliedFilters ?? [];
    for (const [name, requested] of FILTER_NAMES) {
      if (requested({ ...fl, environment: forceEnv }) && !applied.includes(name)) {
        roster.warnings = [
          ...(roster.warnings ?? []),
          game.i18n.format("PF2EDC.Encounter.ForceFilterUnsupported", { name }),
        ];
      }
    }
    // Only force 1 keeps the Friend/Twins/Lurker extras.
    if (i > 0) {
      roster.friend = null;
      roster.twins = null;
      roster.lurker = null;
    }
    const empty =
      !roster.foes?.length && !roster.friend && !roster.twins && !roster.lurker;
    if (empty) {
      ui.notifications.warn(
        game.i18n.format("PF2EDC.Encounter.ForceEmpty", {
          name: force.name || force.id,
        }),
      );
      continue;
    }
    survivors.push({ force, roster, index: i });
  }
  if (!survivors.length) return;

  const encounterId = freshSeed();
  for (const { force, roster, index } of survivors) {
    const mode = force.placement?.mode ?? "nearParty";
    const placementArea = mode.startsWith("region:")
      ? regionArea(scene, mode.slice("region:".length))
      : null;
    if (mode.startsWith("region:") && !placementArea) {
      roster.warnings = [
        ...(roster.warnings ?? []),
        game.i18n.format("PF2EDC.Encounter.ForceRegionUnresolved", {
          name: force.name || force.id,
        }),
      ];
    }
    await postEncounterChatCard(api, roster, force);
    const flags = foundry.utils.mergeObject(
      { [MODULE_ID]: { encounterId, forceId: force.id, forceName: force.name } },
      extraFlags ?? {},
      { inplace: false },
    );
    await spawnEncounterTokens(api, roster, partyMembers, {
      originArea,
      forceHidden,
      extraFlags: flags,
      creatureArt,
      placementArea,
      originOffsetCells:
        placementArea ? null : NEAR_PARTY_OFFSETS[index % NEAR_PARTY_OFFSETS.length],
      tint: forceTint(index),
      nameSuffix: force.name || null,
    });
  }
  if (!originArea) {
    await startCombatForEncounterId(scene, encounterId, {
      forces: buildForceTable(survivors.map((s) => s.force)),
    });
  }
}

async function environmentArgs(environment, creatureArt) {
  const env = normalizeEnvironment(environment);
  if (env == null) return {};
  return {
    environment: env,
    environmentLookup: buildEnvironmentLookup(
      creatureArt,
      await loadCreatureEnvironments(),
    ),
  };
}

export async function generateEncounter({
  prefillTraits = [],
  prefillExcludeTraits = [],
  originArea = null,
  forceHidden = false,
  extraFlags = null,
  levelOffsetBias = 0,
  depthBias = null,
  locationTag = null,
  skipThemeDialog = false,
  scene: sceneOverride = null,
  isBoss = false,
  environment = null,
} = {}) {
  const scene = sceneOverride ?? canvas?.scene;
  if (!scene) {
    ui.notifications.warn(game.i18n.localize("PF2EDC.Encounter.NoSceneWarning"));
    return;
  }
  if (!game.user.isGM) {
    ui.notifications.warn(game.i18n.localize("PF2EDC.Encounter.GmOnlyWarning"));
    return;
  }
  const api = makeFoundryApi(scene);
  const creatureArt = await loadCreatureArt();
  const partyLevel = await api.partyLevel();
  const partyMembers = (game.actors?.party?.members ?? []).filter(
    (m) => m.type === "character",
  );
  const partySize = Math.max(1, partyMembers.length);
  if (!partyMembers.length) {
    ui.notifications.warn(game.i18n.localize("PF2EDC.Encounter.PartyTooSmall"));
  }

  // A dungeon room population already has final traits — captured once at
  // "Start Dungeon" and reused unchanged for every room (ITEM-1's own
  // design), not just a prefill suggestion — so it skips straight to
  // dealing the encounter instead of asking for the same traits again (ITEM-21).
  // The standalone "Generate Encounter" macro has no such prior
  // context, so it always shows the dialog (skipThemeDialog defaults false).
  let theme;
  if (skipThemeDialog) {
    theme = { traits: prefillTraits, excludeTraits: prefillExcludeTraits };
  } else {
    const chosen = await chooseEncounterForces({ api, scene, partySize });
    if (!chosen || chosen === "cancel") return;
    if (Array.isArray(chosen.forces)) {
      return generateForces({
        chosen,
        scene,
        api,
        creatureArt,
        partyLevel,
        partyMembers,
        partySize,
        originArea,
        forceHidden,
        extraFlags,
        levelOffsetBias,
        locationTag,
        isBoss,
      });
    }
    // A bare { traits, excludeTraits, difficulty } result: single implicit force.
    theme = chosen;
    environment = chosen.environment ?? environment;
  }
  // #831: a dungeon room (skipThemeDialog) already supplies its own real
  // depth-based bias; the standalone macro has none, so its own dialog's
  // difficulty choice drives the identical cap mechanism instead.
  const effectiveDepthBias = skipThemeDialog
    ? depthBias
    : depthBiasForDifficultyTier(theme.difficulty);

  const seed = freshSeed();
  const deckSlots = buildEncounterDeck({ seed });
  const dealt = dealEncounter(deckSlots, { seed, partySize });
  // #93: the Accept/Reroll approval gate is removed outright — every run
  // pregenerates in bulk, and a synchronous per-room human approval can't
  // work against that. The roster generated above is always accepted.
  const roster = await getGenerator().generateEncounterRoster({
    resolved: dealt.resolved,
    api,
    partyLevel,
    traits: theme.traits,
    excludeTraits: theme.excludeTraits,
    levelOffsetBias,
    requireTrait: locationTag,
    partySize,
    isBoss,
    depthBias: effectiveDepthBias,
    // #1272: only a run with an environment loads the lookup and passes it,
    // so the no-environment call is identical to before.
    ...(await environmentArgs(environment, creatureArt)),
  });

  await postEncounterChatCard(api, roster);
  // Every spawned token carries an encounterId flag alongside whatever the
  // caller already asked for (a dungeon room's own dungeonSlot flag, say) —
  // ITEM-6's Combat wiring needs a way to find "this encounter's tokens"
  // that works even outside a dungeon room, where there's no slot at all.
  const encounterId = freshSeed();
  const flags = foundry.utils.mergeObject(
    { [MODULE_ID]: { encounterId } },
    extraFlags ?? {},
    { inplace: false },
  );
  await spawnEncounterTokens(api, roster, partyMembers, {
    originArea,
    forceHidden,
    extraFlags: flags,
    creatureArt,
  });
  // Cover (#96) only makes sense for a bounded room, not the standalone
  // macro's unbounded "wherever the party happens to be" placement — same
  // originArea-gated split spawnCreatures itself already draws below. Seeded
  // off this encounter's own seed, so the same accepted encounter always
  // gets the same cover if ever regenerated from its own seed.
  if (originArea) {
    const coverTypes = chooseCoverItemTypes(seed);
    if (coverTypes.length)
      await api.spawnCoverItems(coverTypes, {
        originArea,
        seed,
        extraFlags: flags,
      });
  }
  // Dungeon rooms (identified by `originArea`, which only a dungeon-room
  // population call ever sets) start their own Combat later, once the room
  // is actually revealed — starting it here would leak a hidden room's fight
  // the moment it's merely built. The standalone macro has no such reveal
  // step, so it starts Combat immediately for whatever just spawned.
  if (!originArea) {
    await startCombatForEncounterId(scene, encounterId);
  }
}
