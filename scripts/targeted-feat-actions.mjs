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
 *
 * #946 widened it from the two explicit configs below to every
 * one-action/free self-effect item whose linked effect classifies as
 * `marked` (classifyTargetEffect) and whose own prose states a checkable
 * target constraint (marked-target-requirements.mjs): Smite, Duelist's
 * Challenge, Size Up in the pf2e 8.5.0 compendium.
 */

import { parseMarkedTargetRequirement } from "./marked-target-requirements.mjs";

/**
 * #922's explicit configs, keyed by the ACTION item's slug (both are
 * `action` items in pf2e.actionspf2e, granted by same-named passive class
 * features). #946 derives every other marked-target config from data
 * (resolveTargetedSelfEffectConfig); these two stay explicit because each
 * needs handling the derivation doesn't do -- Devise's stratagem sub-choice
 * (its effect's toggleable RollOption would classify it `unsupported`) and
 * its Strike-trait gate.
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

/**
 * #946: how a linked self-effect depends on a target, from its own rule
 * elements. Replaces #914's blanket "any TokenMark / `target:` / `@target`
 * is unsafe" rule, which lumped two different things together:
 *
 * - `none`: no target reference at all -- a plain #914 self-effect.
 * - `targetConditional`: `target:` roll-option predicates only (Point Blank
 *   Stance's `target:range-increment:1`, Spell Parry's `target:self`). The
 *   system tests them against each roll's own target, so no target is
 *   chosen up front -- also a plain #914 self-effect.
 * - `marked`: exactly one `TokenMark` rule with a slug -- the actor must
 *   designate a creature first (#922's bind-and-create flow).
 * - `unsupported`: target-dependent, but outside what this module can apply
 *   unattended: a ChoiceSet or GrantItem (#991), an `@target` injected
 *   value, several/slugless TokenMarks, or a `toggleable` RollOption --
 *   a bonus that only applies when the actor separately flips the toggle at
 *   the right roll (Harsh Judgement's Seek toggle, Nothing Personal's
 *   first-Strike toggle; binding the mark alone leaves only the effect's
 *   standing penalties -- #1046). Devise a Stratagem's own toggle is
 *   pre-selected by its explicit #922 config and never reaches this check.
 *
 * The toggle/ChoiceSet/GrantItem checks apply only to target-dependent
 * effects; a `none` effect keeps #914's own gates unchanged.
 */
export function classifyTargetEffect(rules = []) {
  const text = JSON.stringify(rules ?? []);
  const marks = (rules ?? []).filter((r) => r?.key === "TokenMark");
  const atTarget = /@target\b/.test(text);
  const targetPredicate = text.includes('"target:');
  if (!marks.length && !atTarget && !targetPredicate) return "none";
  if (rules.some((r) => r?.key === "ChoiceSet" || r?.key === "GrantItem")) return "unsupported";
  if (atTarget) return "unsupported";
  if (rules.some((r) => r?.key === "RollOption" && r.toggleable)) return "unsupported";
  if (marks.length) return marks.length === 1 && marks[0].slug ? "marked" : "unsupported";
  return "targetConditional";
}

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

/**
 * #946: the targeted-self-effect config for `item` whose linked effect
 * source is `effectSource`, or `null` when this module can't use it
 * unattended. #922's two explicit configs win; otherwise the effect must
 * classify as `marked`, the item must not be `cursebound` (an oracle's
 * curse escalation this module doesn't apply -- Whispers of Weakness), and
 * its own description must give a checkable target constraint
 * (parseMarkedTargetRequirement). Shape: `{ markSlug, requiresSight,
 * needsHearing, rangeFeet, targetNotMindless, requirements, exclusiveMark,
 * suboption }` -- `exclusiveMark` when a new use moves the mark (the old
 * effect is deleted after the new one exists), otherwise the item isn't
 * re-offered while its mark is active.
 */
export function resolveTargetedSelfEffectConfig(item, effectSource) {
  const explicit = TARGETED_SELF_EFFECT_ALLOWLIST[item?.slug];
  if (explicit) {
    return { ...explicit, needsHearing: false, rangeFeet: null, targetNotMindless: false, requirements: [] };
  }
  const rules = effectSource?.system?.rules ?? [];
  if (classifyTargetEffect(rules) !== "marked") return null;
  if ((item?.system?.traits?.value ?? []).includes("cursebound")) return null;
  const target = parseMarkedTargetRequirement(item?.system?.description?.value);
  if (!target) return null;
  return {
    markSlug: rules.find((r) => r?.key === "TokenMark").slug,
    requiresSight: target.needsSight,
    needsHearing: target.needsHearing,
    rangeFeet: target.rangeFeet,
    targetNotMindless: target.targetNotMindless,
    requirements: target.requirements,
    exclusiveMark: target.reDesignates,
    suboption: null,
  };
}

function signOf(value) {
  if (typeof value === "number") return value < 0 ? "-" : "+";
  return /^\s*-|\*\s*-\s*1\b/.test(String(value ?? "")) ? "-" : "+";
}

function selectorLabel(rule) {
  const selector = rule.selector ?? rule.selectors;
  return Array.isArray(selector) ? selector.join("/") : (selector ?? "stat");
}

/**
 * #946: the deterministic effectSummary for a derived marked-target entry:
 * what the effect does, and against whom -- `vs <name>` (a `target:mark`
 * predicate: the actor's rolls against the marked creature), `vs <name>'s
 * actions` (`origin:mark`: the marked creature's rolls/effects against the
 * actor), `vs others` (`not target:mark`: Duelist's Challenge's penalty).
 * AdjustModifier upgrades and RollOptions restate a bonus already listed,
 * so they are left out. `durationLabel` is appended in parentheses.
 */
export function summarizeMarkEffect(rules, markSlug, targetName, durationLabel = null) {
  const parts = [];
  for (const rule of rules ?? []) {
    if (!rule || ["TokenMark", "AdjustModifier", "RollOption"].includes(rule.key)) continue;
    const predicate = JSON.stringify(rule.predicate ?? []);
    const scope = predicate.includes(`{"not":"target:mark:${markSlug}"}`)
      ? " vs others"
      : predicate.includes(`target:mark:${markSlug}`)
        ? ` vs ${targetName}`
        : predicate.includes(`origin:mark:${markSlug}`)
          ? ` vs ${targetName}'s actions`
          : "";
    let label;
    if (rule.key === "FlatModifier") label = `${signOf(rule.value)}${selectorLabel(rule)}`;
    else if (rule.key === "DamageDice") label = "+damage dice";
    else if (rule.key === "AdjustStrike") label = "strike adj";
    else if (rule.key === "TempHP") label = "temp HP";
    else label = rule.key;
    parts.push(`${label}${scope}`);
  }
  const body = [...new Set(parts)].join(", ") || "marks";
  return `mark ${targetName}: ${body}${durationLabel ? ` (${durationLabel})` : ""}`;
}
