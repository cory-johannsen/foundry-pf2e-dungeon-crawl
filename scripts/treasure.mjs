/**
 * Real, level-appropriate treasure for a spawned NPC (#29). The coin amount
 * is still a disclosed placeholder heuristic, same spirit as
 * combat-rewards.mjs's lootGpForXp before it (#172) — no anchor in PF2e's
 * GMG "Treasure by Level" table for the gp figure itself. The item pick,
 * though, now draws from PF2e's own level-based rollable tables (the
 * `pf2e.rollable-tables` compendium's Nth-Level Consumables/Permanent Items
 * and Art Object/Gemstone tables) rather than a flat price-filtered index.
 * Foundry-free: this only decides WHICH table to draw from and returns its
 * exact name — the rng is injected, so the decision is fully deterministic
 * and testable without a live Foundry instance. Actually drawing from the
 * named table and resolving a real item document is Foundry-dependent and
 * lives in scripts/foundry-api.mjs's spawnCreatures/drawTreasureItem.
 */

// Tunable, with no anchor in the source material — same "disclosed
// heuristic" status as combat-rewards.mjs's LOOT_GP_PER_XP.
export const TREASURE_GP_PER_LEVEL = 8;
export const ITEM_CHANCE = 0.5;
export const ITEM_PRICE_BUDGET_FRACTION = 0.5;

// Which kind of table a dropped item draws from — tunable, no anchor in the
// source material (PF2e's GMG doesn't specify a mix for a single creature's
// corpse), same disclosed-heuristic spirit as everything else here. Skewed
// toward consumables: a random mook is far more likely to be carrying a
// potion than a magic ring.
export const NPC_TREASURE_CATEGORY_WEIGHTS = [
  { category: 'consumable', weight: 60 },
  { category: 'permanent', weight: 25 },
  { category: 'valuable', weight: 15 },
];

// Cumulative-weight pick over `{ category, weight }` entries. `r` is a
// single [0,1) float — the caller already consumed one rng() call for it —
// same shape as dungeon-deck.mjs's private weightedPick.
export function pickWeightedCategory(weights, r) {
  const total = weights.reduce((sum, w) => sum + w.weight, 0);
  let x = r * total;
  for (const w of weights) {
    x -= w.weight;
    if (x < 0) return w.category;
  }
  return weights[weights.length - 1].category;
}

// Ordinal suffix for levels 1-20 — the only range these tables ever need.
function ordinal(n) {
  if (n === 1) return '1st';
  if (n === 2) return '2nd';
  if (n === 3) return '3rd';
  return `${n}th`;
}

/**
 * The exact `pf2e.rollable-tables` name for a given category/level,
 * confirmed live against the running PF2e system — naming is NOT consistent
 * across the range: levels 1-3 are "Nth-Level Consumables", 4-19 are
 * "Nth-Level Consumables Items", and 20 is the singular "20th-Level
 * Consumable Items". Permanent Items has no such exception. `level` is
 * clamped into [1, 20], the only range these tables cover.
 */
export function nthLevelTableName(category, level) {
  const clamped = Math.min(20, Math.max(1, Math.round(level)));
  const ord = ordinal(clamped);
  if (category === 'permanent') return `${ord}-Level Permanent Items`;
  if (clamped <= 3) return `${ord}-Level Consumables`;
  if (clamped === 20) return '20th-Level Consumable Items';
  return `${ord}-Level Consumables Items`;
}

// Art Object and Semiprecious/Precious Stone tables, in ascending price
// order — confirmed live against the running PF2e system's actual
// compendium item prices, not assumed from the GMG page. Note art-object
// tier order is Minor < Lesser < Moderate < Greater < Major, NOT the naive
// Minor/Lesser/Moderate/Major/Greater reading of the names — verified, not
// a typo. These tables carry no level field of their own (they're priced
// treasure items), so selection here is by gp price budget instead.
export const VALUABLE_TIERS = [
  { name: 'Lesser Semiprecious Stones', minPriceGp: 0.5 },
  { name: 'Minor Art Object', minPriceGp: 2 },
  { name: 'Moderate Semiprecious Stones', minPriceGp: 2.5 },
  { name: 'Greater Semiprecious Stones', minPriceGp: 5 },
  { name: 'Lesser Art Object', minPriceGp: 10 },
  { name: 'Moderate Art Object', minPriceGp: 10 },
  { name: 'Lesser Precious Stones', minPriceGp: 50 },
  { name: 'Moderate Precious Stones', minPriceGp: 100 },
  { name: 'Greater Art Object', minPriceGp: 250 },
  { name: 'Greater Precious Stones', minPriceGp: 500 },
  { name: 'Major Art Object', minPriceGp: 1000 },
];

/**
 * The priciest valuable tier whose price is still within budget, or the
 * cheapest tier if the budget can't afford even that one (always returns a
 * name — a "valuable" category drop is never skipped for being too poor).
 */
export function valuableTierForBudget(priceBudget) {
  let pick = VALUABLE_TIERS[0];
  for (const tier of VALUABLE_TIERS) {
    if (tier.minPriceGp <= priceBudget) pick = tier;
  }
  return pick.name;
}

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
// used elsewhere (dungeon-combat.mjs's corpse conversion) to decide what
// survives onto a defeated NPC's lootable corpse — the two must agree on
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

/**
 * A defeated NPC's corpse loot: a flat gp-per-level amount, plus an
 * ITEM_CHANCE roll for one item drawn from a real PF2e rollable table
 * (Consumables/Permanent Items by level, or an Art Object/Gemstone tier by
 * price budget). Returns the table's exact name, not a resolved item —
 * drawing from it and resolving a document is Foundry-dependent, see
 * scripts/foundry-api.mjs's spawnCreatures.
 */
export function rollNpcTreasure({ level, rng }) {
  const gp = Math.round(Math.max(0, level) * TREASURE_GP_PER_LEVEL);
  let tableName = null;
  if (rng() < ITEM_CHANCE) {
    const category = pickWeightedCategory(NPC_TREASURE_CATEGORY_WEIGHTS, rng());
    tableName =
      category === 'valuable'
        ? valuableTierForBudget(gp * ITEM_PRICE_BUDGET_FRACTION)
        : nthLevelTableName(category, level);
  }
  return { gp, tableName };
}
