/**
 * #946: requirement and target-constraint parsing for a CHARACTER's own
 * self-effect feats/actions, read from the item's own description (a linked
 * effect's description is only "Granted by @UUID[...]" boilerplate -- the
 * real "you can see" / "within 60 feet" / Requirements text lives on the
 * feat or action). Pure, no Foundry API surface.
 *
 * Folded onto #934's closed requirement grammar (npc-self-parse.mjs): the
 * same labelled-block split and the same predicate vocabulary (`handFree`,
 * `wielding`/`wearing`, `hasCondition`/`notHasCondition`), evaluated by the
 * same dungeon-combat.mjs evaluator. Character text is second person, so two
 * clause shapes are added in front of #934's own clause parser: "You have
 * one or more hands free" (handFree) and "You are wielding a ranged weapon"
 * (`wieldingRanged`, a held weapon with a range -- WeaponPF2e#isRanged).
 * Anything outside the closed set is `null`: never defaulted to "no
 * requirement".
 */

import { parseRequirementClause, renderPlain, splitAbilityBlocks } from "./npc-self-parse.mjs";

/** Character-voice clauses #934's NPC-voice grammar doesn't cover. */
function parseCharacterClause(clause) {
  const text = String(clause).trim().replace(/\.$/, "");
  if (/^you have (?:a|one|one or more) hands? free$/i.test(text)) return { type: "handFree" };
  if (/^you are wielding a ranged weapon$/i.test(text)) return { type: "wieldingRanged" };
  return parseRequirementClause(text);
}

/**
 * The item's own Requirements block as closed-set predicates: `[]` when it
 * has none, `null` when any clause is outside the set (Monastic Archer
 * Stance's "unarmored", Hungry Blade's "previous action was a Strike with
 * your spectral dagger that dealt spirit damage", Enforce Oath's sworn
 * oath, Nothing Personal's planned course of action -- untracked state is
 * #992).
 */
export function parseFeatRequirements(descriptionHtml) {
  const { requirements } = splitAbilityBlocks(String(descriptionHtml ?? ""));
  if (requirements == null) return [];
  const text = renderPlain(requirements).replace(/\.\s*$/, "");
  if (!text) return [];
  const predicates = [];
  for (const clause of text.split(/,\s*|\s+and\s+/i)) {
    const predicate = parseCharacterClause(clause);
    if (!predicate) return null;
    predicates.push(predicate);
  }
  return predicates;
}

/** Target-choice wording this module has no state for: a sworn oath
 * (Enforce Oath), a faction allegiance or GM judgment (Hunt the Razer's
 * Pawn), a per-target immunity it doesn't track (Whispers of Weakness's
 * "temporarily immune for 1 day"), a planned course of action (Nothing
 * Personal), or the previous/last action's details (Hungry Blade, Harvest
 * Blood). */
const UNTRACKED_RE =
  /\b(?:sworn an oath|agent of|subject to the GM|temporarily immune|course of action|previous action|last action)\b/i;

/** "the prior creature loses the designation" (Hunt Prey, Size Up, Nothing
 * Personal), "Your current Smite ends if you use the Smite action again",
 * "you use Harsh Judgment on a different creature": a new use moves the
 * mark rather than adding a second one. */
const REDESIGNATE_RE =
  /\bprior (?:creature|target) loses the designation\b|\bends if you use (?:the )?[A-Za-z'’ -]+? again\b|\bon a different creature\b/i;

/**
 * `null`, or how a marked-target feat chooses its creature:
 * `{ requirements, needsSight, needsHearing, rangeFeet, targetNotMindless,
 * reDesignates }`.
 *  - needsSight: "you can see" / "see and hear"; "see or hear" or "aware
 *    of" only needs the creature to be detected.
 *  - needsHearing: "see and hear" (Size Up) -- the actor mustn't be deafened.
 *  - rangeFeet: "within N feet".
 *  - targetNotMindless: "non-mindless" (Size Up).
 * The text must say how the creature is perceived or how far it may be;
 * otherwise the target constraint can't be read and the feat is `null`.
 */
export function parseMarkedTargetRequirement(descriptionHtml) {
  const requirements = parseFeatRequirements(descriptionHtml);
  if (requirements === null) return null;
  const text = renderPlain(String(descriptionHtml ?? ""));
  if (!text || UNTRACKED_RE.test(text)) return null;
  const seeAndHear = /\bsee and hear\b/i.test(text);
  const needsSight = seeAndHear || /\byou can see\b/i.test(text);
  const detected = /\bsee or hear\b|\baware of\b/i.test(text);
  const range = /\bwithin (\d+) feet\b/i.exec(text);
  if (!needsSight && !detected && !range) return null;
  return {
    requirements,
    needsSight,
    needsHearing: seeAndHear,
    rangeFeet: range ? Number(range[1]) : null,
    targetNotMindless: /\bnon-mindless\b/i.test(text),
    reDesignates: REDESIGNATE_RE.test(text),
  };
}
