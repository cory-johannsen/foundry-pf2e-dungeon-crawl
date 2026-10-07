/**
 * #897: a PF2e `ChoiceSet` rule element (e.g. "Charm of Resistance" --
 * choose a damage type) left unresolved leaves `flags.pf2e.rulesSelections`
 * empty for a value PF2e's own system expects to be set once the item
 * exists. This module pre-resolves every such choice, picking uniformly
 * from the rule's own listed `choices` -- never an invented option, per
 * PF2e rules -- before the item/actor is ever actually created, so no
 * generation- or grant-time document write ever leaves one unresolved.
 * Pure: no Foundry globals, plain data in and out.
 */

function resolveChoiceSetsOnItemData(itemData, rng = Math.random) {
  const rules = itemData.system?.rules;
  if (!Array.isArray(rules) || !rules.length) return itemData;
  const choiceSets = rules.filter(
    (r) => r.key === "ChoiceSet" && typeof r.flag === "string" && Array.isArray(r.choices) && r.choices.length,
  );
  if (!choiceSets.length) return itemData;

  const rulesSelections = { ...(itemData.flags?.pf2e?.rulesSelections ?? {}) };
  let changed = false;
  for (const cs of choiceSets) {
    if (rulesSelections[cs.flag] !== undefined) continue; // already resolved -- never override
    const pick = cs.choices[Math.min(Math.floor(rng() * cs.choices.length), cs.choices.length - 1)];
    rulesSelections[cs.flag] = pick.value;
    changed = true;
  }
  if (!changed) return itemData;
  return {
    ...itemData,
    flags: { ...itemData.flags, pf2e: { ...itemData.flags?.pf2e, rulesSelections } },
  };
}

/** Same resolution, applied to every one of `actorData.items` -- a spawned
 * NPC/hazard's own embedded items, not the actor document's own top-level
 * rules (an Actor document has no `system.rules` of its own in PF2e). */
export function resolveChoiceSetsOnActorData(actorData, rng = Math.random) {
  if (!Array.isArray(actorData.items) || !actorData.items.length) return actorData;
  return { ...actorData, items: actorData.items.map((item) => resolveChoiceSetsOnItemData(item, rng)) };
}

export { resolveChoiceSetsOnItemData };
