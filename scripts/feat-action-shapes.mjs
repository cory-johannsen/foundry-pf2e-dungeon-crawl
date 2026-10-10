/**
 * #947: pure recognition of a CHARACTER's targeted feats/class actions that
 * have no `selfEffect` -- the long tail #910/#914/#922/#946 never offered.
 * No Foundry API surface; dungeon-combat.mjs owns every live read and the
 * execution.
 *
 * Scope (the #947 spec's first slice): `feat`/`action` items whose action
 * type is `action` or `free`, that carry one of the nine first-slice class
 * traits (FEAT_ACTION_CLASS_SET), and have no `selfEffect`. A feat is
 * recognized by SHAPE from its own description, all-or-nothing: every
 * sentence must be consumed by the shape's grammar (leading flavor prose
 * excepted, see isFlavorSentence), and its Requirements must be in the
 * closed set below. Two shapes are modeled, both checked against the pf2e
 * 8.5.0 compendium (tests/fixtures/targeted-feat-action-audit.json):
 *
 * - `strikePlus`: "Make a [melee] Strike. If you hit and deal damage, the
 *   target is <condition>[, or <condition> on a critical hit][ <duration>]
 *   [(or <duration> on a critical hit)]." (Intimidating Strike, Vicious
 *   Evisceration, Resounding Blow, Unbalancing Finisher).
 * - `targetEffect`: "Choose a target within N feet. It's Off-Guard against
 *   your attacks <duration>." (Instant Opening), with its "auditory or
 *   visual trait" sentence.
 *
 * The spec's skill-check/save families (`rollVsTargetDefense` in the #947
 * plan) are NOT modeled: no first-slice feat of that shape has outcomes this
 * module can apply (Predictable!'s effect is a ChoiceSet/GrantItem pair with
 * a one-use save bonus, Sabotage deals item damage, Leading Dance and
 * Whirling Throw move creatures, Connect the Dots needs an ally, Pointed
 * Question's outcomes hang on a later Devise a Stratagem). The audit fixture
 * records each such feat's reason.
 */

import { renderPlain, splitAbilityBlocks } from "./npc-self-parse.mjs";
import { KNOWN_CONDITION_SLUGS } from "./npc-ability-parse.mjs";
import { findFeatActionOverride } from "./feat-action-overrides.mjs";

export const FEAT_ACTION_CLASS_SET = new Set([
  "fighter", "rogue", "champion", "swashbuckler", "monk", "ranger", "barbarian", "investigator", "thaumaturge",
]);

/** #910's hand-written composite feats keep their own executors. */
const COMPOSITE_SLUGS = new Set(["sudden-charge", "lunge", "twin-feint", "power-attack"]);

/** Traits that keep an item out of an encounter turn (as #910). */
const EXCLUDED_TRAITS = new Set(["exploration", "downtime"]);

/** pf2e's Off-Guard condition item -- the EphemeralEffect a
 * `targetEffect` "Off-Guard against your attacks" grants (the same uuid the
 * system's own Effect: Pointed Question uses). */
export const OFF_GUARD_CONDITION_UUID = "Compendium.pf2e.conditionitems.Item.AJh5ex99aV6VTggg";

const CONDITION_SET = new Set(KNOWN_CONDITION_SLUGS);
const SECONDS = { round: 6, rounds: 6, minute: 60, minutes: 60, hour: 3600, hours: 3600 };

/** An item's action cost: 0 for a free action, 1-3, or null. */
function actionCost(item) {
  const actionType = item?.system?.actionType?.value;
  if (actionType === "free") return 0;
  if (actionType !== "action") return null;
  const cost = item.system?.actions?.value;
  return typeof cost === "number" && cost > 0 ? cost : null;
}

function sentences(text) {
  return String(text)
    .split(/(?<=[.!?])\s+(?=[A-Z(])/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Leading descriptive prose ("Your blow not only wounds creatures but also
 * shatters their confidence.") -- a sentence before the shape's first
 * mechanical sentence that carries no rules vocabulary at all: no number,
 * no capitalized game term (Strike), no condition name, no check/DC/
 * damage/bonus/penalty/turn/range wording. Anything else is mechanics the
 * grammar must consume, so the feat is rejected. */
function isFlavorSentence(sentence) {
  if (/\d|@|\bStrike\b/.test(sentence)) return false;
  if (/\b(?:check|DC|saves?|saving throw|bonus|penalty|damage|turn|round|feet|reaction|condition|you can|choose|select)\b/i.test(sentence)) {
    return false;
  }
  const lower = sentence.toLowerCase();
  return !KNOWN_CONDITION_SLUGS.some((slug) => new RegExp(`\\b${slug}\\b`).test(lower));
}

/** "Frightened 1" -> {slug, value}; null for anything that isn't a known
 * condition. */
function parseCondition(text) {
  const match = /^([a-z][a-z-]*)(?: (\d+))?$/i.exec(String(text).trim());
  if (!match) return null;
  const slug = match[1].toLowerCase();
  if (!CONDITION_SET.has(slug)) return null;
  return { slug, value: match[2] ? Number(match[2]) : null };
}

/** A duration phrase, from the ACTOR's point of view (these are the actor's
 * own feats): "until the start/beginning of your next turn" ->
 * `actorNextTurnStart`, "until the end of your next turn" ->
 * `actorNextTurnEnd`, "for N rounds/minutes/hours" -> seconds. `undefined`
 * for anything else. */
function parseDuration(text) {
  const t = String(text ?? "").trim().toLowerCase();
  if (!t) return null;
  if (/^until the (?:start|beginning) of your next turn$/.test(t)) return "actorNextTurnStart";
  if (/^until the end of your next turn$/.test(t)) return "actorNextTurnEnd";
  const timed = /^for (\d+|an?|one) (rounds?|minutes?|hours?)$/.exec(t);
  if (timed) {
    const n = /^\d+$/.test(timed[1]) ? Number(timed[1]) : 1;
    return n * SECONDS[timed[2]];
  }
  return undefined;
}

const DURATION_SRC = "until the (?:start|beginning|end) of your next turn|for (?:\\d+|an?|one) (?:rounds?|minutes?|hours?)";
const COND_SRC = "[A-Za-z][A-Za-z-]*(?: \\d+)?";

/** "If you hit and deal damage, the target is Frightened 1, or Frightened 2
 * on a critical hit." / "If the Strike hits and deals damage, the target is
 * Deafened until the start of your next turn (or for 1 minute on a critical
 * hit)." -> `{ success, criticalSuccess }` degree descriptors
 * (`{ conditions: [{slug, value, durationSeconds}] }`), or null. */
const ON_HIT_DAMAGE_RE = new RegExp(
  "^if (?:you hit|it hits|the strike hits) and deals? damage, the target is " +
    `(${COND_SRC})(?: (${DURATION_SRC}))?` +
    `(?:, or (${COND_SRC}) on a critical (?:hit|success))?` +
    `(?:,? (${DURATION_SRC}))?` +
    `(?: \\(or (${DURATION_SRC}) on a critical hit\\))?\\.$`,
  "i",
);

function parseOnHitDamageRider(sentence) {
  const m = ON_HIT_DAMAGE_RE.exec(sentence);
  if (!m) return null;
  const [, hitCond, hitDur, critCond, sharedDur, critDurAlt] = m;
  const hit = parseCondition(hitCond);
  if (!hit) return null;
  const crit = critCond ? parseCondition(critCond) : { ...hit };
  if (!crit) return null;
  if (critCond && crit.slug !== hit.slug) return null;
  if (hitDur && sharedDur) return null;
  const baseDuration = parseDuration(hitDur ?? sharedDur);
  if (baseDuration === undefined) return null;
  const critDuration = critDurAlt ? parseDuration(critDurAlt) : baseDuration;
  if (critDuration === undefined) return null;
  return {
    success: { conditions: [{ ...hit, durationSeconds: baseDuration }] },
    criticalSuccess: { conditions: [{ ...crit, durationSeconds: critDuration }] },
  };
}

/** Requirements this module can check for a targeted feat: none, or exactly
 * "You are wielding a melee weapon that deals <type> damage" (Resounding
 * Blow) -- read as the Strike's own weapon requirement. Anything else
 * (a previous action, a stance, a grabbed creature, an implement, a Raised
 * Shield, ...) is untracked state: `null`, never "no requirement". */
function parseWeaponRequirement(requirementsHtml) {
  if (requirementsHtml == null) return { weapon: null };
  const text = renderPlain(requirementsHtml).replace(/\.\s*$/, "").trim();
  if (!text) return { weapon: null };
  const m = /^you are wielding a melee weapon that deals (bludgeoning|piercing|slashing) damage$/i.exec(text);
  return m ? { weapon: { melee: true, damageType: m[1].toLowerCase() } } : null;
}

const STRIKE_SENTENCE_RE = /^make an? (melee )?strike\.$/i;

function recognizeStrikePlus(lines) {
  const strikeIndex = lines.findIndex((s) => STRIKE_SENTENCE_RE.test(s));
  if (strikeIndex < 0) return { reason: "no plain 'Make a Strike.' sentence" };
  if (!lines.slice(0, strikeIndex).every(isFlavorSentence)) return { reason: "mechanics before the Strike" };
  const rest = lines.slice(strikeIndex + 1);
  if (rest.length !== 1) return { reason: rest.length ? "unmodeled rider text" : "no rider" };
  const degrees = parseOnHitDamageRider(rest[0]);
  if (!degrees) return { reason: "unmodeled rider text" };
  return {
    descriptor: {
      shape: "strikePlus",
      params: { melee: !!STRIKE_SENTENCE_RE.exec(lines[strikeIndex])[1], degrees },
    },
  };
}

const CHOOSE_TARGET_RE = /^choose a target within (\d+) feet\.$/i;
const TARGET_EFFECT_RE = new RegExp(`^(?:it's|it is) (${COND_SRC}) against your attacks (${DURATION_SRC})\\.$`, "i");
/** Instant Opening's own trait choice; the actor picks whichever sense the
 * target has (visual: it must see; auditory: it must hear). */
const SENSE_TRAIT_RE = /^depending on the way you describe your distraction, this action gains either the auditory or visual trait\.$/i;

function recognizeTargetEffect(lines) {
  const chooseIndex = lines.findIndex((s) => CHOOSE_TARGET_RE.test(s));
  if (chooseIndex < 0) return { reason: "no 'Choose a target within N feet.' sentence" };
  if (!lines.slice(0, chooseIndex).every(isFlavorSentence)) return { reason: "mechanics before the target choice" };
  const rest = lines.slice(chooseIndex + 1);
  const effect = rest.length ? TARGET_EFFECT_RE.exec(rest[0]) : null;
  if (!effect) return { reason: "unmodeled target effect" };
  const condition = parseCondition(effect[1]);
  // Only Off-Guard has a per-attacker form in the system (an EphemeralEffect
  // of the Off-Guard condition on the actor's own attack rolls).
  if (!condition || condition.slug !== "off-guard" || condition.value != null) {
    return { reason: "unmodeled target effect" };
  }
  const durationSeconds = parseDuration(effect[2]);
  if (durationSeconds === undefined || durationSeconds === null) return { reason: "unmodeled duration" };
  const trailing = rest.slice(1);
  const senseChoice = trailing.length === 1 && SENSE_TRAIT_RE.test(trailing[0]);
  if (trailing.length && !senseChoice) return { reason: "unmodeled target effect" };
  return {
    descriptor: {
      shape: "targetEffect",
      params: {
        rangeFeet: Number(CHOOSE_TARGET_RE.exec(lines[chooseIndex])[1]),
        condition: { slug: "off-guard", uuid: OFF_GUARD_CONDITION_UUID },
        scope: "actorAttacks",
        durationSeconds,
        senseChoice,
      },
    },
  };
}

/**
 * Explains how #947 treats `item`: `{ descriptor, reason }` -- `descriptor`
 * is `{ shape, cost, traits, requirements: { weapon }, params, source }`
 * (`source`: "shape" or "override") when the feat is offered, otherwise
 * null with a short `reason`. Never throws.
 */
export function explainTargetedFeat(item) {
  try {
    if (item?.type !== "action" && item?.type !== "feat") return { descriptor: null, reason: "not a feat/action" };
    const traits = item.system?.traits?.value ?? [];
    if (!traits.some((t) => FEAT_ACTION_CLASS_SET.has(t))) return { descriptor: null, reason: "outside the first-slice classes" };
    if (item.system?.selfEffect) return { descriptor: null, reason: "has a selfEffect (#910/#914/#922/#946)" };
    if (COMPOSITE_SLUGS.has(item.slug)) return { descriptor: null, reason: "#910 composite feat" };
    if (traits.some((t) => EXCLUDED_TRAITS.has(t))) return { descriptor: null, reason: "exploration/downtime" };
    const cost = actionCost(item);
    if (cost === null) return { descriptor: null, reason: "not an action or free action" };

    const override = findFeatActionOverride(item);
    if (override) return { descriptor: { ...override, cost, traits, source: "override" }, reason: null };

    const html = String(item.system?.description?.value ?? "");
    const blocks = splitAbilityBlocks(html);
    if (blocks.trigger != null) return { descriptor: null, reason: "has a trigger" };
    if (blocks.frequency != null) return { descriptor: null, reason: "has a frequency" };
    if (blocks.other) return { descriptor: null, reason: "has a Special/other labelled block" };
    const requirements = parseWeaponRequirement(blocks.requirements);
    if (!requirements) return { descriptor: null, reason: "requirement outside the closed set" };
    // An Access line, a trailing "Effect: <name>" link and degree blocks all
    // leave sentences the grammars below don't consume.
    const lines = sentences(renderPlain(blocks.effect));
    if (!lines.length) return { descriptor: null, reason: "no text" };

    const strike = recognizeStrikePlus(lines);
    const target = strike.descriptor ? null : recognizeTargetEffect(lines);
    const found = strike.descriptor ?? target?.descriptor ?? null;
    if (!found) {
      const reason = lines.some((s) => STRIKE_SENTENCE_RE.test(s) || /\bstrike\b/i.test(s)) ? strike.reason : target.reason;
      return { descriptor: null, reason };
    }
    if (found.shape === "targetEffect" && requirements.weapon) return { descriptor: null, reason: "requirement outside the closed set" };
    if (found.shape === "strikePlus" && requirements.weapon && !found.params.melee) {
      return { descriptor: null, reason: "weapon requirement on a non-melee Strike" };
    }
    return { descriptor: { ...found, cost, traits, requirements, source: "shape" }, reason: null };
  } catch {
    return { descriptor: null, reason: "unreadable" };
  }
}

/** The #947 descriptor for `item`, or null when it isn't offered. */
export function parseTargetedFeat(item) {
  return explainTargetedFeat(item).descriptor;
}

const DURATION_LABELS = { actorNextTurnStart: "until your next turn", actorNextTurnEnd: "until the end of your next turn" };

function durationLabel(seconds) {
  if (seconds == null) return null;
  if (typeof seconds === "string") return DURATION_LABELS[seconds] ?? seconds;
  if (seconds % 60 === 0) return `${seconds / 60} min`;
  return `${Math.ceil(seconds / 6)} rd`;
}

function conditionLabel(c) {
  const name = c.value != null ? `${c.slug} ${c.value}` : c.slug;
  const d = durationLabel(c.durationSeconds);
  return d ? `${name} ${d}` : name;
}

/** The deterministic vocabulary summary of a parsed feat against
 * `targetName` (the reasoning model never reads feat prose). */
export function summarizeTargetedFeat(descriptor, targetName) {
  if (descriptor?.shape === "strikePlus") {
    const { success, criticalSuccess } = descriptor.params.degrees;
    const hit = success.conditions.map(conditionLabel).join(", ");
    const crit = criticalSuccess.conditions.map(conditionLabel).join(", ");
    const finisher = (descriptor.traits ?? []).includes("finisher") ? "; finisher: spends panache, no more attacks this turn" : "";
    return `${descriptor.params.melee ? "melee " : ""}Strike ${targetName}; hit+damage: ${hit}${crit !== hit ? `, crit: ${crit}` : ""}${finisher}`;
  }
  if (descriptor?.shape === "targetEffect") {
    const d = durationLabel(descriptor.params.durationSeconds);
    return `${targetName} off-guard to your attacks${d ? ` (${d})` : ""}`;
  }
  return targetName;
}
