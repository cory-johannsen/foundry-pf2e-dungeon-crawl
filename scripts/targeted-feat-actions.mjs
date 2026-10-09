/**
 * #922: pure helpers for the targeted-self-effect feat family (Hunt Prey,
 * Devise a Stratagem). Both actions carry a `system.selfEffect` whose
 * linked effect binds itself to a chosen creature through PF2e's own
 * `TokenMark` rule element; everything that happens afterwards (Hunt
 * Prey's bonuses, Devise's d20 substitution into the next Strike) is the
 * system's own rule elements predicated on `target:mark:<slug>`. This
 * module only chooses the creature and pre-fills the rule's `uuid`, which
 * makes the system skip its interactive MarkTargetPrompt
 * (TokenMarkRuleElement#preCreate in the installed pf2e.mjs v8.5.0). No
 * Foundry API surface at all.
 */

/**
 * First-slice allowlist, keyed by the ACTION item's slug (both are `action`
 * items in pf2e.actionspf2e, granted by same-named passive class
 * features). Widening to the other marked-target self-effects is #946.
 *
 * - `markSlug`: the slug of the linked effect's own TokenMark rule
 *   (confirmed live: `Effect: Hunt Prey` -> `hunted-prey`, `Effect:
 *   Devise a Stratagem` -> `devise-a-stratagem`); NOT the action slug.
 * - `requiresSight`: Devise a Stratagem targets "a creature you can see";
 *   Hunt Prey only needs to "see or hear the prey", so any opponent the
 *   actor can currently target (the stealth detection matrix) qualifies.
 * - `exclusiveMark`: Hunt Prey designates one prey at a time and re-using
 *   it moves the designation; Devise a Stratagem (1/round, expires at the
 *   start of the investigator's next turn) is simply not re-offered while
 *   its effect is active.
 * - `suboption`: Devise's effect carries a toggleable `RollOption`
 *   (`devise-a-stratagem`) with `attack`/`skill`/`defensive` suboptions;
 *   this slice always uses the `attack` stratagem (#946 widens it).
 */
export const TARGETED_SELF_EFFECT_ALLOWLIST = Object.freeze({
  "hunt-prey": Object.freeze({ markSlug: "hunted-prey", requiresSight: false, exclusiveMark: true, suboption: null }),
  "devise-a-stratagem": Object.freeze({
    markSlug: "devise-a-stratagem",
    requiresSight: true,
    exclusiveMark: false,
    suboption: Object.freeze({ option: "devise-a-stratagem", value: "attack" }),
  }),
});

function cloneRules(effectSource) {
  return (effectSource?.system?.rules ?? []).map((r) => ({ ...r }));
}

/**
 * Returns a copy of `effectSource` whose `TokenMark` rule with slug
 * `markSlug` has its `uuid` set to `targetTokenUuid` (the system's schema
 * field `uuid`, read first by TokenMarkRuleElement#preCreate). Never
 * mutates `effectSource`. `null` when no such rule exists or no token uuid
 * is given -- an unbound TokenMark would open an interactive prompt on the
 * unattended client.
 */
export function bindTokenMarkEffect(effectSource, markSlug, targetTokenUuid) {
  if (!targetTokenUuid) return null;
  const rules = cloneRules(effectSource);
  const index = rules.findIndex((r) => r?.key === "TokenMark" && r.slug === markSlug);
  if (index < 0) return null;
  rules[index] = { ...rules[index], uuid: targetTokenUuid };
  return { ...effectSource, system: { ...effectSource.system, rules } };
}

/**
 * Returns a copy of `effectSource` whose toggleable `RollOption` rule for
 * `option` has `selection` set to `value` -- the same rule-source field the
 * system's own RollOptionRuleElement#toggle writes, so the choice is part of
 * the effect from creation (no second update after it exists). `null` when
 * the rule or that suboption doesn't exist. Never mutates `effectSource`.
 */
export function selectRollOptionSuboption(effectSource, option, value) {
  const rules = cloneRules(effectSource);
  const index = rules.findIndex(
    (r) => r?.key === "RollOption" && r.option === option && r.toggleable && Array.isArray(r.suboptions),
  );
  if (index < 0) return null;
  if (!rules[index].suboptions.some((s) => s?.value === value)) return null;
  rules[index] = { ...rules[index], selection: value };
  return { ...effectSource, system: { ...effectSource.system, rules } };
}

/**
 * The token uuids `effectItems` (an actor's own effects) currently mark with
 * `markSlug`, read from each effect's TokenMark rule source (the system
 * writes the resolved uuid back onto it at creation).
 */
export function markedTokenUuids(effectItems, markSlug) {
  const uuids = [];
  for (const effect of effectItems ?? []) {
    for (const r of effect?.system?.rules ?? []) {
      if (r?.key === "TokenMark" && r.slug === markSlug && r.uuid) uuids.push(r.uuid);
    }
  }
  return uuids;
}

/**
 * Which of `effectItems` (an actor's own active effects) mark
 * `targetTokenUuid` -- used to annotate Strike candidates against a marked
 * opponent so the reasoning model sees the follow-up is ready.
 * `badgeValue` is Devise a Stratagem's pre-rolled d20 (the system evaluates
 * the `1d20` formula badge at creation into `{type: "value", value: N}`);
 * null for an effect with no evaluated badge (Hunt Prey).
 */
export function findActiveMarkEffects(effectItems, targetTokenUuid) {
  const matches = [];
  if (!targetTokenUuid) return matches;
  for (const effect of effectItems ?? []) {
    const mark = (effect?.system?.rules ?? []).find((r) => r?.key === "TokenMark" && r.uuid === targetTokenUuid);
    if (!mark) continue;
    const badgeValue = effect.system?.badge?.value;
    matches.push({ slug: mark.slug, badgeValue: typeof badgeValue === "number" ? badgeValue : null });
  }
  return matches;
}

/** The deterministic Strike-summary annotation for `marks`, or null. */
export function markAnnotation(marks) {
  if (!marks?.length) return null;
  return marks
    .map((m) => (m.badgeValue != null ? `marked: ${m.slug}, d20 = ${m.badgeValue}` : `marked: ${m.slug}`))
    .join("; ");
}
