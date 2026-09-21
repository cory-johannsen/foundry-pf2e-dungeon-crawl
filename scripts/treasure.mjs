/**
 * Real, level-appropriate treasure for a spawned NPC — a disclosed
 * placeholder heuristic, same spirit as combat-rewards.mjs's lootGpForXp
 * before it (#172), not a byte-exact implementation of PF2e's GMG
 * "Treasure by Level" table. Foundry-free: the equipment index and rng are
 * both injected, so this is fully deterministic and testable without a
 * live Foundry instance — see scripts/foundry-api.mjs's spawnCreatures for
 * the caller that fetches the real index and applies the result.
 */

// Tunable, with no anchor in the source material — same "disclosed
// heuristic" status as combat-rewards.mjs's LOOT_GP_PER_XP.
export const TREASURE_GP_PER_LEVEL = 8;
export const ITEM_CHANCE = 0.5;
export const ITEM_PRICE_BUDGET_FRACTION = 0.5;

// PF2e's own bestiary convention: humanoid, fiend, dragon and undead
// entries typically carry a "Treasure" line; beast/aberration/construct/
// elemental/plant entries typically don't. Own curated list, same style as
// dungeon-deck.mjs's LOCATION_TAGS.
export const TREASURE_ELIGIBLE_TRAITS = ['humanoid', 'fiend', 'dragon', 'undead'];

export function isTreasureEligible(npcTraits) {
  return (npcTraits ?? []).some((t) => TREASURE_ELIGIBLE_TRAITS.includes(t));
}

// The item types worth copying onto a lootable corpse — tangible gear, not
// a creature's own spells/strikes/lore/feats, which would just clutter a
// loot sheet with things nobody can actually pick up. This is also the set
// used to filter the spawn-time equipment-srd index (foundry-api.mjs's
// spawnCreatures), so nothing gets granted to a live NPC that would later
// silently fall off its corpse at death — the two call sites must agree on
// exactly the same set of real PF2e physical-item types.
//
// Confirmed live against the actual running PF2e system (`Item.TYPES`) —
// do not trust assumptions about this list without checking it live again,
// since it's easy to get wrong from the name alone: `ammo` IS a real,
// distinct PF2e item type (confirmed live: e.g. an "Arrows" item on a real
// bestiary NPC has `type: "ammo"`, and pf2e.equipment-srd itself carries
// 216 `ammo`-typed entries) — it is not folded into `consumable` the way it
// might seem. `book` is also a real, distinct type (a lootable
// tome/scroll-holder), even though no equipment-srd entry happens to use it
// today; it's included so a creature carrying one some other way isn't
// silently stripped of it. Neither is dead — both are real, kept.
// Deliberately excluded: `kit` (a real physical type, ~2 equipment-srd
// entries, but not treated as individually lootable gear by this feature).
export const LOOTABLE_ITEM_TYPES = [
  'weapon',
  'armor',
  'equipment',
  'consumable',
  'treasure',
  'backpack',
  'shield',
  'ammo',
  'book',
];

export function rollNpcTreasure({ level, index, rng }) {
  const gp = Math.round(Math.max(0, level) * TREASURE_GP_PER_LEVEL);
  let itemRef = null;
  if (rng() < ITEM_CHANCE) {
    const priceBudget = gp * ITEM_PRICE_BUDGET_FRACTION;
    const candidates = index.filter(
      (e) => e.level <= level && e.priceGp > 0 && e.priceGp <= priceBudget,
    );
    if (candidates.length) {
      const pick = candidates[Math.floor(rng() * candidates.length)];
      itemRef = { id: pick.id, pack: pick.pack };
    }
  }
  return { gp, itemRef };
}
