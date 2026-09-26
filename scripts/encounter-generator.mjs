/**
 * GM-facing orchestration for "PF2EDC: Generate Encounter" — dialog-driven,
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
import { loadCreatureArt } from "./data-loader.mjs";
import { findCreatureArt, creatureArtPath } from "./creature-art.mjs";
import {
  traitFieldHtml,
  wireTraitPickerButtons,
  readTraitField,
} from "./trait-picker.mjs";
import { startCombatForEncounterId } from "./dungeon-combat.mjs";
import { chooseCoverItemTypes } from "./cover-items.mjs";

const MODULE_ID = "pf2e-dungeon-crawl";

function freshSeed() {
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

async function chooseThemeAndSize({
  api,
  prefillTraits = [],
  prefillExcludeTraits = [],
} = {}) {
  const { DialogV2 } = foundry.applications.api;
  const traits = await api.listCreatureTraits();
  return DialogV2.wait({
    window: { title: game.i18n.localize("PF2EDC.Encounter.Title") },
    content: `
      <form>
        ${traitFieldHtml({
          name: "traits",
          label: game.i18n.localize("PF2EDC.Encounter.ThemeLabel"),
          buttonLabel: game.i18n.localize("PF2EDC.Encounter.ChooseTraitsButton"),
          selected: prefillTraits,
        })}
        ${traitFieldHtml({
          name: "excludeTraits",
          label: game.i18n.localize("PF2EDC.Encounter.ExcludeTraitsLabel"),
          buttonLabel: game.i18n.localize("PF2EDC.Encounter.ChooseTraitsButton"),
          selected: prefillExcludeTraits,
        })}
      </form>`,
    render: (_event, dialog) => wireTraitPickerButtons(dialog.element, traits),
    buttons: [
      {
        action: "generate",
        label: game.i18n.localize("PF2EDC.Encounter.GenerateButton"),
        default: true,
        callback: (_event, _button, dialog) => ({
          traits: readTraitField(dialog.element, "traits"),
          excludeTraits: readTraitField(dialog.element, "excludeTraits"),
        }),
      },
      { action: "cancel", label: "Cancel" },
    ],
    rejectClose: false,
  });
}

async function postEncounterChatCard(api, roster) {
  const content = await renderTemplate(
    `modules/${MODULE_ID}/templates/encounter-chat.hbs`,
    { roster },
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

async function spawnEncounterTokens(
  api,
  roster,
  partyMembers,
  {
    originArea = null,
    forceHidden = false,
    extraFlags = null,
    creatureArt = [],
  } = {},
) {
  const nearActorId = findFocusActorId(partyMembers);
  const place = (hidden) => ({
    nearActorId,
    originArea,
    extraFlags,
    hidden: hidden || forceHidden,
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
    await api.spawnCreatures(entries, { ...place(false), disposition: 1 });
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

export async function generateEncounter({
  prefillTraits = [],
  prefillExcludeTraits = [],
  originArea = null,
  forceHidden = false,
  extraFlags = null,
  levelOffsetBias = 0,
  locationTag = null,
  skipThemeDialog = false,
  scene: sceneOverride = null,
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
  // The standalone "PF2EDC: Generate Encounter" macro has no such prior
  // context, so it always shows the dialog (skipThemeDialog defaults false).
  const theme = skipThemeDialog
    ? { traits: prefillTraits, excludeTraits: prefillExcludeTraits }
    : await chooseThemeAndSize({ api, prefillTraits, prefillExcludeTraits });
  if (!theme || theme === "cancel") return;

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
