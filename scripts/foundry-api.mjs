/**
 * The Foundry/PF2e side of applying a card, kept behind one seam.
 *
 * Split into reads and writes on purpose. A card effect is *planned* before it
 * is applied (see effect-plan.mjs): the handler runs against an api that
 * performs no writes but must still be able to look things up, because a
 * handler that grants "a random magic weapon" has to pick the weapon while
 * planning so the GM can be shown its name before agreeing to it.
 *
 * READ_METHODS are passed through during planning; WRITE_METHODS are recorded
 * and replayed only once the GM confirms.
 */
export const WRITE_METHODS = [
  "updateActor",
  "increaseCondition",
  "createEffect",
  "postChatCard",
  "addCoins",
  "grantItems",
  "removeItems",
  "spawnCreatures",
  "grantInnateSpells",
  "removeCoins",
  "etchRune",
  "spawnBuiltCreature",
  "spawnCoverItems",
];

/**
 * Packs that hold creatures worth summoning.
 *
 * Matching on "bestiary" alone missed 1,214 creatures across four packs,
 * Monster Core and Monster Core 2 among them — which in the Remaster are the
 * primary creature source, not an extra. A card looking for a homunculus found
 * none, because the only ones are in Monster Core.
 */
import {
  freeSpot,
  freeSpotInRect,
  footprint,
  overlaps,
  partyLevelFrom,
} from "./placement.mjs";
import { splitmix32, seedFromString } from "./prng.mjs";
import { buildCoverItemActorData, MODULE_ID } from "./cover-items.mjs";
import { classifyTrap } from "./trap-combat.mjs";
import {
  isTreasureEligible,
  rollNpcTreasure,
  LOOTABLE_ITEM_TYPES,
} from "./treasure.mjs";

export const CREATURE_PACK_PATTERN =
  /bestiary|monster-core|npc-core|npc-gallery/i;

// Trap-tagged hazards (#135) live only here, never in a pack
// CREATURE_PACK_PATTERN would match.
export const HAZARD_PACKS = ["pf2e.hazards"];

export const READ_METHODS = [
  "findItems",
  "findCreatures",
  "listCreatureTraits",
  "findHazards",
  "classifyHazard",
  "listItems",
  "findWorldActors",
  "listLanguages",
  "getCoins",
  "listGear",
  "ancestrySpeed",
  "partyLevel",
];

// Module-scope, not per-`makeFoundryApi()` call — the theme dialog calls
// `listCreatureTraits` fresh every time it opens, and re-scanning ~60 packs
// on every open would make the dialog noticeably slow to appear.
let CREATURE_TRAITS_CACHE = null;

/**
 * PF2e's size codes, smallest first, with the words a card is likely to use.
 * A card asking for "large" means the code "lg".
 */
export const SIZE_ORDER = ["tiny", "sm", "med", "lg", "huge", "grg"];
const SIZE_WORDS = {
  tiny: "tiny",
  small: "sm",
  sm: "sm",
  medium: "med",
  med: "med",
  large: "lg",
  lg: "lg",
  huge: "huge",
  gargantuan: "grg",
  grg: "grg",
};

export function sizeAtLeast(size, min) {
  if (!min) return true;
  const want = SIZE_ORDER.indexOf(SIZE_WORDS[String(min).toLowerCase()] ?? min);
  if (want < 0) return true;
  return SIZE_ORDER.indexOf(size ?? "med") >= want;
}

/** Grades that a rune's name carries at the end and its key carries at the front. */
const RUNE_GRADES = [
  "lesser",
  "moderate",
  "greater",
  "major",
  "true",
  "supreme",
];

/**
 * The key a weapon's property array wants, from the slug the compendium uses.
 *
 * These disagree, and PF2e says nothing when they do: it stores whatever slug
 * it is given and applies no rune. "giant-killing" has to become
 * "giantKilling", and a graded variant moves its grade to the front —
 * "giant-killing-greater" becomes "greaterGiantKilling". Both were checked
 * against a real weapon, which renames itself when the rune takes.
 */
export function runeKey(slug) {
  const parts = String(slug ?? "")
    .split("-")
    .filter(Boolean);
  if (!parts.length) return "";
  const grade = RUNE_GRADES.includes(parts.at(-1)) ? parts.pop() : null;
  const ordered = grade ? [grade, ...parts] : parts;
  return ordered
    .map((p, i) => (i === 0 ? p : p[0].toUpperCase() + p.slice(1)))
    .join("");
}

/** PF2e rarities in ascending order, for "uncommon or better" style filters. */
const RARITY_ORDER = ["common", "uncommon", "rare", "unique"];

export function rarityAtLeast(rarity, min) {
  return (
    RARITY_ORDER.indexOf(rarity ?? "common") >=
    RARITY_ORDER.indexOf(min ?? "common")
  );
}

export function makeFoundryApi(sceneRef = null) {
  const getActor = (actorId) => {
    const actor = game.actors.get(actorId);
    if (!actor) throw new Error(`No actor: ${actorId}`);
    return actor;
  };

  return {
    // ---- reads -------------------------------------------------------------

    /**
     * Index entries from the equipment compendia matching a filter.
     * Returns plain objects ({pack, id, name, type, level, rarity}) rather than
     * documents, so a plan can be described, logged and replayed cheaply.
     */
    async findItems({
      types = [],
      minRarity = "common",
      maxLevel = null,
      traits = [],
      namePattern = null,
      packs = ["pf2e.equipment-srd"],
    } = {}) {
      const found = [];
      const re = namePattern ? new RegExp(namePattern, "i") : null;
      for (const id of packs) {
        const pack = game.packs.get(id);
        if (!pack) continue;
        const index = await pack.getIndex({
          // A spell's tradition is not among its traits — it lives in its own
          // array, so it has to be asked for explicitly or spells arrive
          // looking traditionless. Usage distinguishes a rune from a thing.
          fields: [
            "type",
            "system.level.value",
            "system.traits.rarity",
            "system.traits.value",
            "system.traits.traditions",
            "system.usage.value",
            "system.slug",
          ],
        });
        for (const e of index) {
          if (types.length && !types.includes(e.type)) continue;
          const rarity = e.system?.traits?.rarity ?? "common";
          if (!rarityAtLeast(rarity, minRarity)) continue;
          const level = e.system?.level?.value ?? 0;
          if (maxLevel != null && level > maxLevel) continue;
          const has = e.system?.traits?.value ?? [];
          if (traits.length && !traits.every((t) => has.includes(t))) continue;
          if (re && !re.test(e.name)) continue;
          found.push({
            pack: id,
            id: e._id,
            name: e.name,
            type: e.type,
            level,
            rarity,
            traits: has,
            traditions: e.system?.traits?.traditions ?? [],
            // Runes are plain `equipment` with no distinguishing trait;
            // only their usage says they are etched onto something else.
            usage: e.system?.usage?.value ?? null,
            slug: e.system?.slug ?? null,
          });
        }
      }
      return found;
    },

    /**
     * Creature index entries matching a filter, same shape as findItems.
     *
     * Every installed creature pack is searched by default.
     */
    async findCreatures({
      minLevel = null,
      maxLevel = null,
      traits = [],
      namePattern = null,
      minSize = null,
      excludeTraits = [],
      speaksLanguage = false,
      packs = null,
      requireTrait = null,
    } = {}) {
      packs ??= game.packs
        .filter(
          (p) =>
            p.documentName === "Actor" &&
            CREATURE_PACK_PATTERN.test(p.collection),
        )
        .map((p) => p.collection);
      const found = [];
      const re = namePattern ? new RegExp(namePattern, "i") : null;
      for (const id of packs) {
        const pack = game.packs.get(id);
        if (!pack) continue;
        const index = await pack.getIndex({
          fields: [
            "type",
            "system.details.level.value",
            "system.traits.value",
            "system.traits.size.value",
            "system.details.languages.value",
          ],
        });
        for (const e of index) {
          if (e.type !== "npc") continue;
          const level = e.system?.details?.level?.value ?? 0;
          if (minLevel != null && level < minLevel) continue;
          if (maxLevel != null && level > maxLevel) continue;
          const has = e.system?.traits?.value ?? [];
          if (traits.length && !traits.some((t) => has.includes(t))) continue;
          // A second, ANDed filter — kept separate from `traits` (any-of) on
          // purpose: folding a location's own required trait into that array
          // would make the query broader (theme OR location), not narrower.
          if (requireTrait && !has.includes(requireTrait)) continue;
          if (excludeTraits.some((t) => has.includes(t))) continue;
          if (re && !re.test(e.name)) continue;
          const size = e.system?.traits?.size?.value ?? "med";
          if (!sizeAtLeast(size, minSize)) continue;
          const languages = e.system?.details?.languages?.value ?? [];
          if (speaksLanguage && !languages.length) continue;
          found.push({
            pack: id,
            id: e._id,
            name: e.name,
            level,
            traits: has,
            size,
            languages,
          });
        }
      }
      return found;
    },

    /**
     * Every distinct trait carried by an npc in the same creature packs
     * `findCreatures` searches — so the encounter generator's theme picker
     * can only ever offer a trait something actually has, rather than a free
     * text field where a typo or a setting word (e.g. "castle", not a
     * creature trait at all) silently matches nothing.
     *
     * Cached at module scope: a pack's own index is already cached internally
     * by Foundry once fetched, but the union scan across ~60 packs is still
     * real work worth doing once per session rather than on every dialog open.
     */
    async listCreatureTraits() {
      if (CREATURE_TRAITS_CACHE) return CREATURE_TRAITS_CACHE;
      const packs = game.packs.filter(
        (p) =>
          p.documentName === "Actor" &&
          CREATURE_PACK_PATTERN.test(p.collection),
      );
      const traits = new Set();
      for (const pack of packs) {
        const index = await pack.getIndex({
          fields: ["type", "system.traits.value"],
        });
        for (const e of index) {
          if (e.type !== "npc") continue;
          for (const t of e.system?.traits?.value ?? []) traits.add(t);
        }
      }
      CREATURE_TRAITS_CACHE = [...traits].sort();
      return CREATURE_TRAITS_CACHE;
    },

    /**
     * Trap-tagged hazard index entries from `pf2e.hazards` (#135), same
     * shape/pattern as `findCreatures` but for `type: "hazard"` — hazards
     * are explicitly excluded from `findCreatures` above (`e.type !== "npc"`),
     * and live in their own compendium, never the bestiary packs
     * `CREATURE_PACK_PATTERN` matches. `requireTrait` defaults to `'trap'`
     * rather than being left for the caller to remember, since every real
     * caller wants exactly that — `pf2e.hazards` also has non-trap hazards
     * (environmental features, etc.) this module has no use for yet.
     */
    async findHazards({
      minLevel = null,
      maxLevel = null,
      requireTrait = "trap",
      excludeTraits = [],
      packs = HAZARD_PACKS,
    } = {}) {
      const found = [];
      for (const id of packs) {
        const pack = game.packs.get(id);
        if (!pack) continue;
        const index = await pack.getIndex({
          fields: ["type", "system.details.level.value", "system.traits.value"],
        });
        for (const e of index) {
          if (e.type !== "hazard") continue;
          const level = e.system?.details?.level?.value ?? 0;
          if (minLevel != null && level < minLevel) continue;
          if (maxLevel != null && level > maxLevel) continue;
          const has = e.system?.traits?.value ?? [];
          if (requireTrait && !has.includes(requireTrait)) continue;
          if (excludeTraits.some((t) => has.includes(t))) continue;
          found.push({ pack: id, id: e._id, name: e.name, level, traits: has });
        }
      }
      return found;
    },

    /**
     * Whether a specific `pf2e.hazards` entry is one #134's automation can
     * actually run (`isSimpleAutomatableTrap`) — needs the *full* document,
     * not the index `findHazards` above works from (`isComplex`/`actions`/
     * `disable` are derived PF2e Actor data, not raw index-queryable
     * fields), so this is a separate, per-candidate call rather than folded
     * into `findHazards` itself. `trap-library.mjs`'s `selectTrap` calls
     * this against `findHazards`'s (small, already level-filtered) result
     * set to prefer a trap the engine can actually run when one's
     * available, rather than picking blind.
     */
    async classifyHazard({ pack, id }) {
      const doc = await game.packs.get(pack)?.getDocument(id);
      return doc ? classifyTrap(doc) : null;
    },

    /**
     * NPCs that already exist in this world, as opposed to compendium entries.
     * Rogue turns "a non-player character" against you — someone the party may
     * already know — which is a different thing from summoning a stranger out
     * of a bestiary.
     */
    async findWorldActors({
      types = ["npc"],
      traits = [],
      minLevel = null,
      maxLevel = null,
      minSize = null,
      excludeTraits = [],
      excludeIds = [],
      speaksLanguage = false,
      withArtOnly = false,
    } = {}) {
      const skip = new Set(excludeIds);
      const isDefaultArt = (src) =>
        !src || /mystery-man|default-icons|\.svg$/i.test(src);
      return game.actors
        .filter(
          (a) => types.includes(a.type) && !skip.has(a.id) && a.name?.trim(),
        )
        .filter(
          (a) =>
            !traits.length ||
            traits.some((t) => (a.system?.traits?.value ?? []).includes(t)),
        )
        .filter(
          (a) =>
            !excludeTraits.some((t) =>
              (a.system?.traits?.value ?? []).includes(t),
            ),
        )
        .filter((a) => {
          const lvl = a.system?.details?.level?.value ?? 0;
          return (
            (minLevel == null || lvl >= minLevel) &&
            (maxLevel == null || lvl <= maxLevel)
          );
        })
        .filter(
          (a) => !withArtOnly || !isDefaultArt(a.prototypeToken?.texture?.src),
        )
        .filter((a) => sizeAtLeast(a.system?.traits?.size?.value, minSize))
        .filter(
          (a) =>
            !speaksLanguage ||
            (a.system?.details?.languages?.value ?? []).length > 0,
        )
        .map((a) => ({
          id: a.id,
          name: a.name,
          level: a.system?.details?.level?.value ?? 0,
          size: a.system?.traits?.size?.value ?? "med",
          languages: a.system?.details?.languages?.value ?? [],
          folder: a.folder?.name ?? null,
          hasArt: !isDefaultArt(a.prototypeToken?.texture?.src),
        }));
    },

    /**
     * Languages the actor could still learn, labelled for a dialog.
     * Kept behind the api because CONFIG is a live-Foundry global, and a
     * handler that reaches for it directly cannot be tested.
     */
    async listLanguages(actorId) {
      const actor = actorId ? game.actors.get(actorId) : null;
      const known = new Set(actor?.system?.details?.languages?.value ?? []);
      return Object.entries(CONFIG.PF2E?.languages ?? {})
        .filter(([slug]) => !known.has(slug))
        .map(([slug, label]) => ({
          value: slug,
          label: game.i18n.localize(label),
        }))
        .sort((a, b) => a.label.localeCompare(b.label));
    },

    /**
     * Weapons and armour the actor has, and whether they are actually using
     * them — needed by anything that wants to modify what someone wields
     * rather than hand them another object.
     */
    async listGear(actorId, { types = ["weapon", "armor"] } = {}) {
      const actor = getActor(actorId);
      return actor.items
        .filter((i) => types.includes(i.type))
        .map((i) => ({
          id: i.id,
          name: i.name,
          type: i.type,
          wielded:
            (i.system?.equipped?.handsHeld ?? 0) > 0 ||
            i.system?.equipped?.carryType === "held" ||
            i.system?.equipped?.inSlot === true,
          propertyRunes: [...(i.system?.runes?.property ?? [])],
        }));
    },

    /**
     * An ancestry's base walking speed, from the compendium rather than a
     * table that would age. Null when the ancestry is not found, which lets
     * the caller fall back to its own figures.
     */
    async ancestrySpeed(name) {
      if (!name) return null;
      const pack = game.packs.get("pf2e.ancestries");
      if (!pack) return null;
      const index = await pack.getIndex({ fields: ["type", "system.speed"] });
      const hit = [...index].find(
        (e) =>
          e.type === "ancestry" &&
          e.name.toLowerCase() === String(name).toLowerCase(),
      );
      return hit?.system?.speed ?? null;
    },

    /** What the actor is carrying in coin. */
    async getCoins(actorId) {
      const coins = getActor(actorId).inventory?.coins;
      return coins?.toObject?.() ?? { ...(coins ?? {}) };
    },

    /**
     * An actor's carried items, for cards that take things away.
     *
     * `magical` selects which side of the line: 'only' for the enchanted ones,
     * 'exclude' for mundane wealth, and null for everything.
     */
    async listItems(
      actorId,
      {
        types = null,
        magical = null,
        magicalOnly = false,
        includeCoinage = false,
      } = {},
    ) {
      const actor = getActor(actorId);
      const mode = magicalOnly ? "only" : magical;
      const isMagical = (i) =>
        (i.system?.traits?.value ?? []).includes("magical") ||
        (i.system?.traits?.rarity ?? "common") !== "common";
      // Coins are treasure items in PF2e — "Gold Pieces" sits in the same list
      // as a gemstone. They are excluded by default because coin is handled
      // through the inventory's own coin api, and listing them here would mean
      // taking the same money twice.
      const isCoinage = (i) => i.isCoinage ?? i.system?.stackGroup === "coins";
      return (
        actor.items
          .filter((i) => !types || types.includes(i.type))
          .filter((i) => includeCoinage || !isCoinage(i))
          .filter(
            (i) =>
              mode === null || (mode === "only" ? isMagical(i) : !isMagical(i)),
          )
          // The module's own flags come along so a card can recognise what an
          // earlier card left behind.
          .map((i) => ({
            id: i.id,
            name: i.name,
            type: i.type,
            dommt: i.flags?.["deck-of-many-more-things"] ?? null,
          }))
      );
    },

    // ---- writes ------------------------------------------------------------

    async updateActor(actorId, updates) {
      return getActor(actorId).update(updates);
    },

    async increaseCondition(actorId, condition, value) {
      const actor = getActor(actorId);
      if (typeof actor.increaseCondition === "function") {
        return actor.increaseCondition(condition, { value });
      }
      const cond = game.pf2e?.ConditionManager?.getCondition(condition);
      if (cond) {
        const itemData = cond.toObject();
        if (value != null) itemData.system.value = { isValued: true, value };
        return actor.createEmbeddedDocuments("Item", [itemData]);
      }
      console.warn(
        `Cannot apply condition ${condition} to ${actorId} — PF2e ConditionManager unavailable`,
      );
    },

    async createEffect(actorId, effectData) {
      return getActor(actorId).createEmbeddedDocuments("Item", [effectData]);
    },

    async addCoins(actorId, coins) {
      const actor = getActor(actorId);
      if (typeof actor.inventory?.addCoins === "function")
        return actor.inventory.addCoins(coins);
      throw new Error(`Actor ${actorId} has no inventory to add coins to`);
    },

    /**
     * Copy compendium items onto an actor. Entries are {pack, id}, optionally
     * with `updates` merged into the copy — a battle form borrowed from a
     * spell effect keeps its rule elements but needs the card's duration, not
     * the spell's one minute.
     */
    async grantItems(actorId, entries) {
      const actor = getActor(actorId);
      const sources = [];
      for (const { pack, id, updates } of entries) {
        const doc = await game.packs.get(pack)?.getDocument(id);
        if (!doc) continue;
        const obj = doc.toObject();
        sources.push(updates ? foundry.utils.mergeObject(obj, updates) : obj);
      }
      if (!sources.length) return null;
      return actor.createEmbeddedDocuments("Item", sources);
    },

    /**
     * Grant spells the character can actually cast.
     *
     * A spell item dropped on a sheet on its own belongs to no spellcasting
     * entry, so it sits there uncastable. PF2e's model for "you may cast this
     * without a slot" is an innate entry that owns the spell, with the daily
     * allowance recorded on the spell's location.
     *
     * Entry creation and spell linking have to happen together, in one call:
     * the spell references the entry by id, and a handler planning its writes
     * ahead of time cannot know an id for a document that does not exist yet.
     * The module keeps a single entry per actor and adds to it.
     */
    async grantInnateSpells(
      actorId,
      entries,
      {
        tradition = "primal",
        ability = "cha",
        uses = null,
        entryName = "Deck of Many More Things",
      } = {},
    ) {
      const actor = getActor(actorId);
      let entry = actor.itemTypes.spellcastingEntry?.find(
        (e) => e.name === entryName,
      );
      if (!entry) {
        [entry] = await actor.createEmbeddedDocuments("Item", [
          {
            name: entryName,
            type: "spellcastingEntry",
            system: {
              prepared: { value: "innate" },
              tradition: { value: tradition },
              ability: { value: ability },
            },
          },
        ]);
      }

      const sources = [];
      for (const { pack, id } of entries) {
        const doc = await game.packs.get(pack)?.getDocument(id);
        if (!doc) continue;
        const obj = doc.toObject();
        obj.system.location = {
          value: entry.id,
          // A cantrip is at-will; anything else carries a daily allowance.
          ...(uses ? { uses: { value: uses, max: uses } } : {}),
        };
        sources.push(obj);
      }
      if (!sources.length) return null;
      return actor.createEmbeddedDocuments("Item", sources);
    },

    /**
     * Etch a property rune onto something the actor already owns.
     *
     * A rune granted as a loose item is inert — it is not a thing you carry,
     * it is a property of a weapon. Adding its slug to the weapon's property
     * runes is what actually gives the character the benefit.
     */
    async etchRune(actorId, itemId, slug) {
      const item = getActor(actorId).items.get(itemId);
      if (!item) throw new Error(`No item ${itemId} to etch`);
      const key = runeKey(slug);
      const runes = item.system?.runes ?? {};
      const current = runes.property ?? [];
      if (current.includes(key)) return null;
      const updates = { "system.runes.property": [...current, key] };
      // A property rune needs a potency rune to sit on. Without one PF2e drops
      // the property array entirely, and the etching silently does nothing.
      if (!(runes.potency > 0)) updates["system.runes.potency"] = 1;
      return item.update(updates);
    },

    async removeCoins(actorId, coins) {
      const actor = getActor(actorId);
      if (typeof actor.inventory?.removeCoins === "function") {
        return actor.inventory.removeCoins(coins);
      }
      throw new Error(`Actor ${actorId} has no inventory to take coins from`);
    },

    async removeItems(actorId, itemIds) {
      const actor = getActor(actorId);
      const present = itemIds.filter((id) => actor.items.get(id));
      if (!present.length) return null;
      return actor.deleteEmbeddedDocuments("Item", present);
    },

    /**
     * Place creatures on the active scene near a focal token when there is one,
     * so a summons lands next to whoever drew rather than at the origin.
     *
     * `originArea` (scene pixels) overrides the focus-token origin entirely —
     * for dropping a dungeon encounter inside a specific generated room, which
     * may have no token anywhere near it yet. Placement then searches outward
     * from the area's own center and is clamped to its bounds via
     * freeSpotInRect, rather than freeSpot's unbounded ring search.
     */
    async spawnCreatures(
      entries,
      {
        nearActorId = null,
        disposition = -1,
        img = null,
        imgFallback = null,
        place = "beside",
        hidden = false,
        originArea = null,
        extraFlags = null,
      } = {},
    ) {
      const scene = sceneRef ?? canvas?.scene;
      if (!scene) throw new Error("No active scene to place creatures on");
      const grid = scene.grid?.size ?? 100;
      const focus =
        !originArea && nearActorId
          ? scene.tokens.find((t) => t.actor?.id === nearActorId)
          : null;
      const areaRectGrid = originArea
        ? {
            gx: Math.round(originArea.x / grid),
            gy: Math.round(originArea.y / grid),
            gw: Math.round(originArea.width / grid),
            gh: Math.round(originArea.height / grid),
          }
        : null;
      const originX = originArea
        ? originArea.x + originArea.width / 2
        : (focus?.x ?? (scene.width ?? grid * 10) / 2);
      const originY = originArea
        ? originArea.y + originArea.height / 2
        : (focus?.y ?? (scene.height ?? grid * 10) / 2);

      // Everything already on the scene, in squares. Creatures placed by this
      // call are added as they go, so a card summoning several does not stack
      // them either.
      const occupied = scene.tokens.map((t) => footprint(t, grid));

      // PF2e derives a token's disposition from the actor's alliance and wins
      // over anything set on the token — a summoned ally created straight from
      // a bestiary entry came out hostile, because every bestiary NPC is
      // `opposition`. So the alliance is set on the actor first.
      const alliance =
        disposition > 0 ? "party" : disposition < 0 ? "opposition" : null;

      // Only a hostile spawn (a monster, never a player's own summon) can
      // ever end up on the lootable-corpse path resolveCombat drives — see
      // #172. Fetched once per call, not once per creature, same "index
      // first, cheap" discipline encounter-roster.mjs already follows for
      // the bestiary.
      const equipmentIndex =
        disposition < 0
          ? (
              await game.packs
                .get("pf2e.equipment-srd")
                ?.getIndex({ fields: ["type", "system.level.value", "system.price.value"] })
            )
              // pf2e.equipment-srd also carries a couple of `kit`-typed
              // entries not in LOOTABLE_ITEM_TYPES — filtered here so
              // nothing gets granted at spawn that dungeon-combat.mjs's
              // corpse conversion would later silently strip off the corpse
              // at death for not matching that same allow-list (#172 review).
              ?.filter((e) => LOOTABLE_ITEM_TYPES.includes(e.type))
              .map((e) => ({
                id: e._id,
                pack: "pf2e.equipment-srd",
                level: e.system?.level?.value ?? 0,
                // system.price.value is keyed by denomination ({gp}, {sp}, ...)
                // rather than always gp — normalized to a single gp-equivalent
                // number so rollNpcTreasure's price ceiling comparison is
                // meaningful regardless of which denomination a cheap item uses.
                priceGp:
                  (e.system?.price?.value?.gp ?? 0) +
                  (e.system?.price?.value?.sp ?? 0) / 10 +
                  (e.system?.price?.value?.cp ?? 0) / 100,
              })) ?? []
          : [];

      const created = [];
      for (const [i, entry] of entries.entries()) {
        // An entry is either a compendium reference or a world actor to copy.
        // World actors are preferred by callers because the SRD bestiaries ship
        // no token art, while a world's own NPCs almost always have it.
        const doc = entry.actorId
          ? game.actors.get(entry.actorId)
          : await game.packs.get(entry.pack)?.getDocument(entry.id);
        if (!doc) continue;
        // Compendium creatures carry no token art, so a card may supply its
        // own. `img` replaces whatever the creature has; `imgFallback` only
        // fills in when it has nothing — which is what a card wants when the
        // creature is drawn at random and could be anything. Overriding there
        // would put one picture on every possible answer.
        const existing = doc.prototypeToken?.texture?.src ?? "";
        const bare =
          !existing || /mystery-man|default-icons|\.svg$/i.test(existing);
        // A per-entry img/imgFallback overrides the call-level default for
        // just that one creature — needed because a single `foes` call can
        // spawn several different creatures needing different art. Entries
        // that set neither fall through to the call-level values unchanged.
        const entryImg = entry.img ?? img;
        const entryImgFallback = entry.imgFallback ?? imgFallback;
        const art = entryImg ?? (bare ? entryImgFallback : null);
        const overrides = {
          "ownership.default": 0,
          "system.details.alliance": alliance,
          "prototypeToken.disposition": disposition,
          ...(art ? { img: art, "prototypeToken.texture.src": art } : {}),
        };
        const [actor] = await Actor.createDocuments([
          foundry.utils.mergeObject(doc.toObject(), overrides),
        ]);
        if (disposition < 0 && isTreasureEligible(actor.system?.traits?.value)) {
          const { gp, itemRef } = rollNpcTreasure({
            level: actor.system?.details?.level?.value ?? 0,
            index: equipmentIndex,
            rng: Math.random,
          });
          if (gp > 0) await actor.inventory.addCoins({ gp });
          if (itemRef) {
            const itemDoc = await game.packs.get(itemRef.pack)?.getDocument(itemRef.id);
            if (itemDoc) await actor.createEmbeddedDocuments("Item", [itemDoc.toObject()]);
          }
        }
        // Most summons stand next to the character. Ooze lands *on* them: the
        // card is explicit that the thing appears in your space, and a cube
        // beside you is a different card. A large token's top-left square is
        // the character's own, and a huge one straddles it, so the offset is
        // half its footprint rounded down — which also keeps it grid-aligned.
        const tw = Math.max(1, Math.round(actor.prototypeToken?.width ?? 1));
        const th = Math.max(1, Math.round(actor.prototypeToken?.height ?? 1));
        let spot;
        if (place === "on") {
          spot = {
            x: originX - grid * Math.floor((tw - 1) / 2),
            y: originY - grid * Math.floor((th - 1) / 2),
          };
        } else {
          // The first empty place big enough, searched outward. Landing one
          // square east regardless is how a witchwarg and an avatar of death
          // ended up sharing a square across two draws.
          const free = areaRectGrid
            ? freeSpotInRect({ occupied, rect: areaRectGrid, gw: tw, gh: th })
            : freeSpot({
                occupied,
                gx: Math.round(originX / grid),
                gy: Math.round(originY / grid),
                gw: tw,
                gh: th,
              });
          spot = free
            ? { x: free.gx * grid, y: free.gy * grid }
            : { x: originX + grid * (i + 1), y: originY };
        }
        occupied.push(footprint({ ...spot, width: tw, height: th }, grid));
        const td = await actor.getTokenDocument({
          ...spot,
          disposition,
          hidden,
        });
        const obj = td.toObject();
        obj.disposition = disposition;
        obj.hidden = hidden;
        if (extraFlags)
          obj.flags = foundry.utils.mergeObject(obj.flags ?? {}, extraFlags);
        const [createdToken] = await scene.createEmbeddedDocuments("Token", [
          obj,
        ]);
        // {name} only, historically — widened to include the real ids
        // (#136 needs actorId to flag a spawned trap for agent
        // customization afterward). No existing caller reads this return
        // value at all (every `spawnCreatures` call site in this module is
        // a bare `await`), so this is a safe, non-breaking shape change,
        // not a compatibility concern.
        created.push({
          name: actor.name,
          actorId: actor.id,
          tokenId: createdToken.id,
        });
      }
      return created;
    },

    /**
     * Place a creature built from scratch rather than copied from a pack.
     * Shares the placement logic with spawnCreatures so a built summons lands
     * beside the character the same way a found one does.
     */
    async spawnBuiltCreature(
      data,
      { nearActorId = null, disposition = 1 } = {},
    ) {
      const scene = sceneRef ?? canvas?.scene;
      if (!scene) throw new Error("No active scene to place a creature on");
      const grid = scene.grid?.size ?? 100;
      const focus = nearActorId
        ? scene.tokens.find((t) => t.actor?.id === nearActorId)
        : null;
      const originX = focus?.x ?? (scene.width ?? grid * 10) / 2;
      const originY = focus?.y ?? (scene.height ?? grid * 10) / 2;

      const [actor] = await Actor.createDocuments([
        foundry.utils.mergeObject(data, {
          "system.details.alliance": disposition > 0 ? "party" : "opposition",
          "prototypeToken.disposition": disposition,
        }),
      ]);
      // The same search a found creature gets. Skull's avatar and Monstrosity's
      // beast came out of two separate draws onto the same square.
      const gw = Math.max(1, Math.round(actor.prototypeToken?.width ?? 1));
      const gh = Math.max(1, Math.round(actor.prototypeToken?.height ?? 1));
      const free = freeSpot({
        occupied: scene.tokens.map((t) => footprint(t, grid)),
        gx: Math.round(originX / grid),
        gy: Math.round(originY / grid),
        gw,
        gh,
      });
      const x = free ? free.gx * grid : originX + grid;
      const y = free ? free.gy * grid : originY;
      const td = await actor.getTokenDocument({ x, y, disposition });
      const obj = td.toObject();
      obj.disposition = disposition;
      await scene.createEmbeddedDocuments("Token", [obj]);
      return actor.name;
    },

    /**
     * Place destructible cover items (#96) — crates, barrels, rubble, each a
     * real PF2e hazard actor (cover-items.mjs) with genuine HP/hardness, so
     * they're attackable and destroyable through Foundry's normal
     * target-and-strike flow with no special-casing needed here. `typeIds`
     * is a list of cover-items.mjs type ids (from `chooseCoverItemTypes`).
     *
     * Placement is bounded to `originArea` (the encounter's own room, same
     * shape spawnCreatures' own originArea takes), at a random cell within
     * it rather than always searching outward from center the way
     * freeSpotInRect does for creatures — cover items shouldn't cluster in
     * the same spot in every room. A handful of random attempts, skipping an
     * item entirely rather than overlapping something already there
     * (another cover item, a spawned creature) — a room with too little
     * free space just gets fewer than `typeIds.length`, not one stacked on
     * top of another.
     *
     * `extraFlags` merges onto each token the same way spawnCreatures'
     * own does — the caller passes the encounter's own `encounterId`/
     * `dungeonSlot` flags here so resolveCombat (dungeon-combat.mjs) can
     * find and clean these up alongside the encounter's monsters when the
     * fight ends, instead of leaving them piled up in the world forever
     * the way #98 found defeated monsters doing before that flag-scoping
     * existed at all.
     */
    async spawnCoverItems(
      typeIds,
      { originArea = null, seed = "", extraFlags = null } = {},
    ) {
      const scene = sceneRef ?? canvas?.scene;
      if (!scene || !originArea || !typeIds.length) return [];
      const grid = scene.grid?.size ?? 100;
      const rect = {
        gx: Math.round(originArea.x / grid),
        gy: Math.round(originArea.y / grid),
        gw: Math.max(1, Math.round(originArea.width / grid)),
        gh: Math.max(1, Math.round(originArea.height / grid)),
      };
      const occupied = scene.tokens.map((t) => footprint(t, grid));
      const rand = splitmix32(seedFromString(`${seed}-cover-placement`));

      const created = [];
      for (const typeId of typeIds) {
        let spot = null;
        for (let attempt = 0; attempt < 12 && !spot; attempt += 1) {
          const candidate = {
            gx: rect.gx + Math.floor(rand() * rect.gw),
            gy: rect.gy + Math.floor(rand() * rect.gh),
            gw: 1,
            gh: 1,
          };
          if (!occupied.some((o) => overlaps(candidate, o))) spot = candidate;
        }
        if (!spot) continue;

        const [actor] = await Actor.createDocuments([
          buildCoverItemActorData(typeId),
        ]);
        occupied.push(spot);
        const td = await actor.getTokenDocument({
          x: spot.gx * grid,
          y: spot.gy * grid,
          disposition: 0,
        });
        const obj = td.toObject();
        obj.disposition = 0;
        // buildCoverItemActorData's own coverItem flag lives on the Actor,
        // which a Token built from it does not automatically inherit (flags
        // are a separate namespace per document) — dungeon-combat.mjs's
        // activeCoverCells reads it straight off the Token, so it needs its
        // own copy here, same as extraFlags below.
        const coverFlags = { [MODULE_ID]: { coverItem: typeId } };
        obj.flags = foundry.utils.mergeObject(
          foundry.utils.mergeObject(obj.flags ?? {}, coverFlags),
          extraFlags ?? {},
        );
        await scene.createEmbeddedDocuments("Token", [obj]);
        created.push(actor.name);
      }
      return created;
    },

    /**
     * The level of the party, for cards that threaten everyone at once.
     *
     * PF2e keeps a real party actor and it is the only trustworthy source:
     * counting every character in the world would have included the GM's
     * eighth-level test dummy alongside five first-level players.
     */
    async partyLevel() {
      const party = game.actors?.party ?? null;
      const fromParty = partyLevelFrom(party?.members ?? null);
      if (fromParty != null) return fromParty;
      // No party actor: the characters a player actually owns.
      const owned = (game.actors ?? []).filter(
        (a) =>
          a.type === "character" &&
          Object.entries(a.ownership ?? {}).some(
            ([id, lvl]) =>
              lvl === 3 && game.users?.get(id) && !game.users.get(id).isGM,
          ),
      );
      return partyLevelFrom(owned);
    },

    async postChatCard(payload) {
      // whisperGM lets a handler tell the GM something the players must not
      // read — Rogue's new enemy is secret until someone reveals them.
      const { whisperGM, ...rest } = payload;
      if (whisperGM)
        rest.whisper = ChatMessage.getWhisperRecipients("GM").map((u) => u.id);
      return ChatMessage.create(rest);
    },
  };
}
