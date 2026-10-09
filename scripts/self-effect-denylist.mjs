/**
 * #914: slugs that survive the derived self-effect eligibility filter
 * (scripts/dungeon-combat.mjs's computeSelfEffectVocabularyEntries) but
 * are never worth an AI turn in THIS module's own context — reviewed by
 * the owner against the full 87-item survivor list produced live against
 * the real pf2e.feats-srd/pf2e.actionspf2e compendia while this plan was
 * written (see tests/fixtures/self-effect-audit-snapshot.json for the
 * full classified population this list was reviewed from).
 *
 * - Senses-only effects (no combat stat modifier at all): granting a
 *   sense has no mechanical payoff this module's own AI combat logic can
 *   act on mid-fight.
 * - Purely cosmetic (a light radius, nothing else).
 * - Reroll/degree-of-success-adjustment effects tied to a specific later
 *   roll: using one proactively without already knowing which roll it
 *   will apply to is not a decision this module's candidate pipeline
 *   models (the vocabulary has no "next roll" concept).
 * - Repel Ambient Magic: a counter-magic utility bonus, situational
 *   outside a magic-heavy encounter this module has no way to detect.
 */
export const SELF_EFFECT_DENYLIST = new Set([
  // Senses only
  "dissolutions-sight",
  "shadow-sight",
  "echoes-in-stone",
  "consolidated-overlay-panopticon",
  // Purely cosmetic
  "radiant-circuitry",
  // Reroll/degree-adjustment tied to a specific later roll
  "tap-the-past",
  "wish-for-luck",
  "meddling-futures",
  "reckless-abandon",
  // Situational utility outside this module's own context
  "repel-ambient-magic",
]);
