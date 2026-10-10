/**
 * #947: a reviewed table of complete, hand-written descriptors for real
 * targeted feats/actions the grammar in feat-action-shapes.mjs misses or
 * misreads (the same role #935's npc-ability-overrides.mjs plays for NPC
 * abilities). An entry replaces the parser's result for that item; each one
 * must name the real item (slug) and be pinned by a fixture test against
 * that item's own compendium text.
 *
 * It starts EMPTY. The pf2e 8.5.0 first-slice population
 * (tests/fixtures/targeted-feat-action-audit.json) has no feat whose text is
 * fully modeled by an executor this module has but which the grammar
 * misreads: every feat the grammar rejects needs execution machinery this
 * slice doesn't build (forced movement, item damage, Recall Knowledge,
 * counteracting, a chosen body part, a flying state, ...), and an override
 * without an executor able to act on it would be a descriptor nothing can
 * run.
 */
export const FEAT_ACTION_OVERRIDES = new Map();

/** The override descriptor for `item` (by its slug), or null. */
export function findFeatActionOverride(item) {
  if (!item?.slug) return null;
  return FEAT_ACTION_OVERRIDES.get(item.slug) ?? null;
}
