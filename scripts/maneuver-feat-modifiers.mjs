/**
 * #911: the curated, tested table of feats that modify #909's five basic
 * maneuvers -- a feat not listed here has no effect on eligibility or
 * execution. Confirmed against the installed PF2e system's pf2e.feats-srd
 * compendium that none of these four feats carries a rule element the
 * system itself would apply (Titan Wrestler/Sly Disarm: `rules: []`;
 * Crushing Grab/Terrified Retreat: a chat-text-only Note rule), so every
 * effect here is module-applied, never a duplicate of something PF2e
 * already does. Pure: no Foundry API surface.
 */
export const MANEUVER_FEAT_MODIFIERS = Object.freeze({
  // "creatures up to two sizes larger than you, or up to three sizes
  // larger than you if you're legendary in Athletics" (also Reposition,
  // which is not one of #909's five maneuvers).
  "titan-wrestler": { slugs: ["trip", "shove", "grapple", "disarm"], kind: "eligibility", effect: "sizeCap" },
  // "You can use Thievery instead of Athletics when you attempt a Disarm.
  // When you use Thievery ... and succeed, the target is Off-Guard against
  // the next attack you make before the end of your turn."
  "sly-disarm": { slugs: ["disarm"], kind: "eligibility+rider", effect: "thieverySubstitution+offGuard" },
  // "When you successfully Grapple a creature, you can deal bludgeoning
  // damage to that creature equal to your Strength modifier."
  "crushing-grab": { slugs: ["grapple"], kind: "rider", effect: "strModDamage" },
  // "When you critically succeed at the Demoralize action, if the target's
  // level is lower than yours, the target is Fleeing for 1 round."
  "terrified-retreat": { slugs: ["demoralize"], kind: "rider", effect: "fleeing" },
});

const SIZE_CAP_SLUGS = MANEUVER_FEAT_MODIFIERS["titan-wrestler"].slugs;
const LEGENDARY_RANK = 4;

/**
 * Pure. `featSlugs` is the slugs of the actor's own feat items;
 * `athleticsRank` (0-4), `athleticsMod` and `thieveryMod` are the actor's
 * real statistics. Returns `sizeCapSteps` (per maneuver slug, present only
 * when widened -- absent means the base RAW cap of 1 step) and `skill`
 * (per maneuver slug, present only when a feat substitutes a statistic --
 * absent means the maneuver's own base skill). Unreadable inputs fall back
 * to base RAW (non-legendary, no substitution), never more permissive.
 */
export function eligibilityModifiers(featSlugs, { athleticsRank, athleticsMod, thieveryMod } = {}) {
  const featSet = new Set(Array.isArray(featSlugs) ? featSlugs : []);
  const sizeCapSteps = {};
  const skill = {};

  if (featSet.has("titan-wrestler")) {
    const steps = athleticsRank === LEGENDARY_RANK ? 3 : 2;
    for (const slug of SIZE_CAP_SLUGS) sizeCapSteps[slug] = steps;
  }
  // Decision 6: the better statistic, deterministically; ties -> Athletics.
  if (
    featSet.has("sly-disarm") &&
    Number.isFinite(thieveryMod) &&
    thieveryMod > (Number.isFinite(athleticsMod) ? athleticsMod : -Infinity)
  ) {
    skill.disarm = "thievery";
  }
  return { sizeCapSteps, skill };
}

/**
 * Pure. The extra (non-base-RAW) effects to apply after the maneuver's own
 * base outcome has already landed. `skillUsed` is the statistic that
 * actually rolled (resolved at vocabulary-build time and carried on the
 * candidate). `actorLevel`/`targetLevel` gate Terrified Retreat ("if the
 * target's level is lower than yours"); an unreadable level withholds it.
 */
export function ridersFor(featSlugs, slug, outcome, skillUsed, { actorLevel, targetLevel } = {}) {
  const featSet = new Set(Array.isArray(featSlugs) ? featSlugs : []);
  const riders = [];
  const succeeded = outcome === "success" || outcome === "criticalSuccess";

  if (slug === "grapple" && featSet.has("crushing-grab") && succeeded) {
    riders.push({ type: "crushingGrabDamage" });
  }
  if (slug === "disarm" && featSet.has("sly-disarm") && skillUsed === "thievery" && succeeded) {
    riders.push({ type: "slyDisarmOffGuard" });
  }
  if (
    slug === "demoralize" &&
    featSet.has("terrified-retreat") &&
    outcome === "criticalSuccess" &&
    Number.isFinite(actorLevel) &&
    Number.isFinite(targetLevel) &&
    targetLevel < actorLevel
  ) {
    riders.push({ type: "terrifiedRetreatFleeing" });
  }
  return riders;
}
