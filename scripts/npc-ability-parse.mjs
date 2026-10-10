/**
 * #915: pure recognition/parsing for NPC save-based, no-damage special
 * abilities (Terrifying Display, Radiant Wings, Vanth's Curse, ...) -- no
 * Foundry API surface at all. Bestiary ability text is prose enriched with a
 * fixed set of Foundry text-enricher tags (@Check, @Template, @UUID); the
 * grammar below targets exactly those tags plus a small set of confirmed
 * English phrasings, nothing more. Anything outside the grammar inside a
 * degree-of-success block drops the whole ability to `mode: "reportOnly"`
 * (saves rolled, nothing applied, the text whispered to the GM) -- never a
 * partial auto-application.
 *
 * #935 widens the grammar (all-or-nothing is unchanged):
 * - degree blocks: "As <degree>" for any degree, with one parseable suffix
 *   (a changed duration, a changed/added condition); an immunity-only block
 *   ("The creature is temporarily immune ... for 24 hours"); "for as long as
 *   it's <condition>" durations; a trailing duration shared by the
 *   conditions listed before it in the same sentence ("Confused and
 *   Stupefied 1 for 1 round"); an unlisted critical success/failure takes
 *   the success/failure effect (PF2e's convention, as #933's Gnaw shapes);
 *   success-only preamble immunity ("A creature that succeeds at its save is
 *   temporarily immune") applies to the success degrees only.
 * - an inline-outcome grammar for abilities with no degree blocks at all
 *   ("... must succeed at a @Check save or become X (Y on a critical
 *   failure)", "... becomes X unless they succeed at a @Check save", "On a
 *   failure, a creature becomes X", "... that fail a @Check save become X").
 * - a simple penalty outcome ("takes a -1 status penalty to attack rolls
 *   for 1 minute"), applied by the executor as a synthesized effect item.
 * - a target filter from the subject ("Any non-boggard", "each living
 *   creature"): a creature trait outside a closed list makes the ability
 *   reportOnly, never a guess.
 * - a timed-style condition with no stated end (Off-Guard, Dazzled, ...)
 *   is never applied open-ended: the ability is reportOnly instead.
 * - a reviewed per-ability override table (npc-ability-overrides.mjs).
 */

import { AGENT_MELEE_REACH_SQUARES } from "./agent-candidates.mjs";
import { findNpcAbilityOverride } from "./npc-ability-overrides.mjs";

/** Touch/melee-range abilities (Vanth's Curse: "by touching it with its
 * scythe") use the same 1-square reach AI maneuvers use, at 5 ft/square. */
export const AGENT_MELEE_REACH_FEET = AGENT_MELEE_REACH_SQUARES * 5;

const SAVES = new Set(["fortitude", "reflex", "will"]);

const SECONDS_PER_ROUND = 6;
const DURATION_UNIT_SECONDS = {
  round: SECONDS_PER_ROUND, rounds: SECONDS_PER_ROUND,
  minute: 60, minutes: 60,
  hour: 3600, hours: 3600,
  day: 86400, days: 86400,
};
const DURATION_UNITS = "rounds?|minutes?|hours?|days?";
/** #935: "for one minute", "for a round" -- number words in durations. */
const NUMBER_WORDS = Object.freeze({
  a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
});
const COUNT = `\\d+|${Object.keys(NUMBER_WORDS).join("|")}`;

function durationSeconds(count, unit) {
  const n = /^\d+$/.test(count) ? Number(count) : NUMBER_WORDS[count.toLowerCase()];
  return n * DURATION_UNIT_SECONDS[unit.toLowerCase()];
}

/** The installed PF2e system's own CONFIG.PF2E.conditionTypes keys (read
 * from pf2e.mjs), minus `persistent-damage` (applied through damage, not
 * increaseCondition) and `cursebound` (class-feature bookkeeping). */
export const KNOWN_CONDITION_SLUGS = Object.freeze([
  "blinded", "broken", "clumsy", "concealed", "confused", "controlled", "dazzled",
  "deafened", "doomed", "drained", "dying", "encumbered", "enfeebled", "fascinated",
  "fatigued", "fleeing", "frightened", "grabbed", "hidden", "immobilized", "invisible",
  "off-guard", "paralyzed", "petrified", "prone", "quickened", "restrained", "sickened",
  "slowed", "stunned", "stupefied", "unconscious", "undetected", "wounded",
]);
const CONDITION_SET = new Set(KNOWN_CONDITION_SLUGS);

/** #935: conditions whose own rules end them (Frightened decays, Stunned is
 * spent on actions, Sickened is retched away, Prone ends on standing, ...),
 * so applying one with no stated duration is the rules as written. Any other
 * condition with no stated end (Off-Guard, Dazzled, Slowed, ...) would be
 * applied forever -- such an ability is reportOnly instead. */
const SELF_ENDING_CONDITIONS = new Set([
  "frightened", "stunned", "sickened", "drained", "doomed", "wounded", "dying", "prone", "unconscious", "fatigued",
]);

/** #935: creature traits a "non-<trait>" subject may exclude (each one
 * checked against the installed system's CONFIG.PF2E.creatureTraits). A
 * "non-" word outside this list (non-sabosan, non-terror bird) is not a
 * trait the module can test, so the ability is reportOnly. */
const FILTER_TRAITS = new Set([
  "aberration", "aeon", "angel", "animal", "archon", "azata", "beast", "boggard", "celestial", "construct",
  "daemon", "demon", "devil", "dragon", "dwarf", "elemental", "elf", "fey", "fiend", "fungus", "giant",
  "gnome", "goblin", "hag", "halfling", "human", "kobold", "lizardfolk", "merfolk", "monitor", "ooze", "orc",
  "plant", "psychopomp", "spirit", "troll", "undead",
]);

/** #935: the closed penalty-statistic vocabulary -> the system's own
 * FlatModifier selectors (statistic domains read from pf2e.mjs: every speed
 * carries `all-speeds`, an attack roll `attack-roll`, a save
 * `saving-throw`, a skill `skill-check`). A backward reference ("checks
 * using that skill") or anything else is never matched, so the clause stays
 * leftover and the ability is reportOnly. */
export const PENALTY_SELECTORS = Object.freeze({
  "all checks and dcs": "all",
  "attack rolls": "attack-roll",
  "saving throws": "saving-throw",
  "skill checks": "skill-check",
  "fortitude saves": "fortitude",
  "reflex saves": "reflex",
  "will saves": "will",
  "perception checks": "perception",
  perception: "perception",
  "armor class": "ac",
  ac: "ac",
  speeds: "all-speeds",
  speed: "all-speeds",
});
const SELECTOR_PHRASE = Object.keys(PENALTY_SELECTORS)
  .sort((a, b) => b.length - a.length)
  .map((p) => p.replace(/ /g, "\\s+"))
  .join("|");
const PENALTY_RE = new RegExp(
  `\\b(?:(?:takes?|suffers?|gains?)\\s+)?(?:an?\\s+)?-(\\d+)(-foot)?\\s+(status|circumstance|item)\\s+penalty\\s+to\\s+(?:its\\s+|their\\s+|all\\s+)?((?:${SELECTOR_PHRASE})(?:(?:\\s*,\\s*(?:and\\s+)?|\\s+and\\s+)(?:${SELECTOR_PHRASE}))*)\\b`,
  "gi",
);

const DEGREE_LABELS = {
  "Critical Success": "criticalSuccess",
  Success: "success",
  Failure: "failure",
  "Critical Failure": "criticalFailure",
};
const DEGREE_KEYS = ["criticalSuccess", "success", "failure", "criticalFailure"];
const DEGREE_WORDS = {
  "critical success": "criticalSuccess",
  success: "success",
  failure: "failure",
  "critical failure": "criticalFailure",
};

function slugify(text) {
  return String(text).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
}

function stripHtml(html) {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** En/minus dashes ("a –1 status penalty", "non–terror bird") as "-". */
function normalizeDashes(text) {
  return text.replace(/[–−]/g, "-");
}

const CONDITION_LINK = /@UUID\[Compendium\.pf2e\.conditionitems\.Item\.([^\]]+)\](?:\{([^}]*)\})?/g;
const CONDITION_WORD_RE = new RegExp(`\\b(?:${KNOWN_CONDITION_SLUGS.join("|").replace(/-/g, "[- ]")})\\b`, "i");

/** A condition link's `{slug, value}`: from its label ("Frightened 2") when
 * present (compiled runtime text), else from the link's own name-form id
 * (raw source data: `Item.Off-Guard`, no label). `null` when neither names a
 * known condition. */
function conditionFromLink(idOrName, label) {
  const source = label ?? idOrName;
  const match = /^\s*([A-Za-z][A-Za-z -]*?)(?:\s+(\d+))?\s*$/.exec(source);
  if (!match) return null;
  const slug = slugify(match[1]);
  if (!CONDITION_SET.has(slug)) return null;
  return { slug, value: match[2] ? Number(match[2]) : null };
}

/** Human-readable plain text: condition links become their label/name. */
function renderPlain(html) {
  return stripHtml(
    html
      .replace(CONDITION_LINK, (_m, id, label) => label ?? id.replace(/-/g, " "))
      .replace(/@UUID\[[^\]]+\]\{([^}]*)\}/g, "$1")
      .replace(/@\w+\[[^\]]*\]\{([^}]*)\}/g, "$1"),
  );
}

/** Pulls every condition link out of `text`, returning the conditions found
 * and the text with each recognized link consumed. An unrecognized link
 * (not a known condition) is left in place, so it shows up as leftover. */
function extractLinkedConditions(text) {
  const conditions = [];
  const remaining = text.replace(CONDITION_LINK, (whole, id, label) => {
    const condition = conditionFromLink(id, label);
    if (!condition) return whole;
    conditions.push(condition);
    return " ";
  });
  return { conditions, remaining };
}

/** A bare (unlinked) known condition name, e.g. Radiant Wings' own
 * "dazzled for 1 minute" -- not every mention is a link. */
function extractBareConditions(text) {
  const conditions = [];
  let remaining = text;
  for (const slug of KNOWN_CONDITION_SLUGS) {
    const re = new RegExp(`\\b${slug}\\b(?:\\s+(\\d+))?`, "i");
    const match = re.exec(remaining);
    if (!match) continue;
    conditions.push({ slug, value: match[1] ? Number(match[1]) : null });
    remaining = remaining.replace(re, " ");
  }
  return { conditions, remaining };
}

const WHILE_CONDITION_RE = new RegExp(
  `\\b(?:for )?as long as (?:it|they|the target|the creature)(?:['’]s|['’]re| is| are| remains?) (${KNOWN_CONDITION_SLUGS.join("|")})\\b`,
  "i",
);
const UNTIL_NO_LONGER_RE = new RegExp(
  `\\buntil (?:it is |it['’]s |they are )?no longer (${KNOWN_CONDITION_SLUGS.join("|")})\\b`,
  "i",
);

/** The first duration phrase in `text` ("for N rounds/minutes/hours/days",
 * "until the end of its next turn", "as long as it remains <condition>"),
 * consumed. */
function extractDuration(text) {
  const timed = new RegExp(`\\bfor (${COUNT}) (${DURATION_UNITS})\\b`, "i").exec(text);
  if (timed) {
    return {
      durationSeconds: durationSeconds(timed[1], timed[2]),
      remaining: text.replace(timed[0], " "),
    };
  }
  const untilNextTurn = /\buntil the end of (?:its|their|the target's|the creature's) next turn\b/i.exec(text);
  if (untilNextTurn) {
    return { durationSeconds: "untilNextTurn", remaining: text.replace(untilNextTurn[0], " ") };
  }
  // #933: Gnaw's "Slowed 1 as long as it remains sickened" -- the condition
  // lasts exactly as long as another one does. #935: also "for as long as
  // it's frightened" and "until no longer sickened".
  const whileCondition = WHILE_CONDITION_RE.exec(text) ?? UNTIL_NO_LONGER_RE.exec(text);
  if (whileCondition) {
    return { durationSeconds: `while:${whileCondition[1].toLowerCase()}`, remaining: text.replace(whileCondition[0], " ") };
  }
  return { durationSeconds: null, remaining: text };
}

const IMMUNITY_RE = new RegExp(
  `\\b(?:temporarily )?immune(?:\\s+to(?:\\s+[^.]+?)?)?\\s+for\\s+(${COUNT})\\s+(${DURATION_UNITS})\\b`,
  "i",
);

/** "temporarily immune [to <ability>] for N <unit>" (#935: also without
 * "temporarily", as Frost Worm's "immune to Worm Trill for 24 hours"). */
function extractImmunity(text) {
  const match = IMMUNITY_RE.exec(text);
  if (!match) return { immuneSeconds: null, remaining: text };
  return {
    immuneSeconds: durationSeconds(match[1], match[2]),
    remaining: text.replace(match[0], " "),
  };
}

function extractNone(text) {
  const match = /\b(unaffected|no effect)\b/i.exec(text);
  if (!match) return { none: false, remaining: text };
  return { none: true, remaining: text.replace(match[0], " ") };
}

/** #935: every penalty clause, replaced by a `§P<n>§` placeholder so the
 * clause loop can attach a duration to it like a condition. The selector
 * list must be made only of PENALTY_SELECTORS phrases; a `-N-foot` penalty
 * is a Speed penalty only. `null` for a malformed match. */
function extractPenalties(text) {
  const penalties = [];
  let invalid = false;
  const remaining = text.replace(PENALTY_RE, (_whole, value, foot, type, list) => {
    const selectors = list
      .split(/\s*,\s*(?:and\s+)?|\s+and\s+/i)
      .map((p) => PENALTY_SELECTORS[p.trim().toLowerCase().replace(/\s+/g, " ")]);
    if (selectors.some((s) => !s)) invalid = true;
    if (foot && selectors.some((s) => s !== "all-speeds")) invalid = true;
    if (!foot && selectors.includes("all-speeds")) invalid = true;
    penalties.push({ type: type.toLowerCase(), value: -Number(value), selectors: [...new Set(selectors)], durationSeconds: null });
    return ` §P${penalties.length - 1}§ `;
  });
  return invalid ? null : { penalties, remaining };
}

const BOILERPLATE =
  /\b(?:the target creature|the creature is|the target is|the creature|the target|a creature|it is|it['’]s|they are|is|are|and|also|then|becomes?|be|falls?|knocked)\b/gi;

function hasLeftover(text) {
  return text.replace(BOILERPLATE, " ").replace(/[.,;:\s]+/g, " ").trim().length > 0;
}

/**
 * #935: the shared outcome-clause parser behind degree blocks, "As X"
 * suffixes and inline outcomes. Returns `null` when anything non-trivial is
 * left over, else `{ none, conditions, penalties, immuneSeconds,
 * floatingDuration }` (the caller decides whether an empty result is
 * valid). A duration attaches to the conditions in its own clause:
 * Terrifying Display's "Frightened 2 and Fleeing until the end of its next
 * turn" is Fleeing for that long while Frightened decays on its own (#943's
 * end-of-turn hook). The same duration also covers the conditions listed
 * before it in the same sentence that have no end of their own ("Confused
 * and Stupefied 1 for 1 round"). A duration in a clause with no condition
 * of its own ("For 1 hour, the target is Stupefied 2") covers every
 * condition in the text that has none.
 */
function parseOutcomeText(rawText) {
  let text = normalizeDashes(rawText);
  // A single-use "next roll" modifier is #987's, never a timed penalty.
  if (/\bthe next\b|\bnext (?:saving throw|roll|attack|check|d20)\b/i.test(text)) return null;
  const penaltyResult = extractPenalties(text);
  if (!penaltyResult) return null;
  text = penaltyResult.remaining;
  const noneResult = extractNone(text);
  text = noneResult.remaining;
  const immunityResult = extractImmunity(text);
  text = immunityResult.remaining;

  const conditions = [];
  const penalties = [];
  let floatingDuration = null;
  let leftover = "";
  for (const sentence of text.split(/(?<=\.)\s+/)) {
    const sentenceConditions = [];
    for (const clause of sentence.split(/,|;|\band\b/i)) {
      let rest = clause;
      const clausePenalties = [];
      rest = rest.replace(/§P(\d+)§/g, (_m, i) => {
        clausePenalties.push(penaltyResult.penalties[Number(i)]);
        return " ";
      });
      // The duration first: #933's "as long as it remains sickened" names a
      // condition that is not itself applied.
      const duration = extractDuration(rest);
      rest = duration.remaining;
      const linked = extractLinkedConditions(rest);
      rest = linked.remaining;
      const bare = extractBareConditions(rest);
      rest = bare.remaining;
      const found = [...linked.conditions, ...bare.conditions];
      // "Fascinated with the nosoi" / "by the melody on the wind": the
      // subject of the fascination, not a separate effect.
      if (found.some((c) => c.slug === "fascinated")) {
        rest = rest.replace(/\b(?:with|by) (?:the |this |that |its )?[a-z][a-z'’ -]*[.\s]*$/i, " ");
      }
      if (duration.durationSeconds !== null && !found.length && !clausePenalties.length) {
        if (floatingDuration !== null) return null;
        floatingDuration = duration.durationSeconds;
      }
      if (duration.durationSeconds !== null && found.length) {
        for (const c of sentenceConditions) {
          if (c.durationSeconds === null && !SELF_ENDING_CONDITIONS.has(c.slug)) c.durationSeconds = duration.durationSeconds;
        }
      }
      for (const c of found) {
        const condition = { ...c, durationSeconds: duration.durationSeconds };
        conditions.push(condition);
        sentenceConditions.push(condition);
      }
      for (const p of clausePenalties) penalties.push({ ...p, durationSeconds: duration.durationSeconds });
      leftover += ` ${rest}`;
    }
  }
  if (floatingDuration !== null) {
    for (const c of conditions) if (c.durationSeconds === null) c.durationSeconds = floatingDuration;
    for (const p of penalties) if (p.durationSeconds === null) p.durationSeconds = floatingDuration;
  }
  if (hasLeftover(leftover)) return null;
  return {
    none: noneResult.none,
    conditions,
    penalties,
    immuneSeconds: immunityResult.immuneSeconds,
    floatingDuration,
  };
}

/** A concrete degree from a parsed outcome, or `null` when it is empty or
 * self-contradictory ("no effect" plus a condition). An immunity-only
 * block ("The creature is temporarily immune to pangolin musk for 1
 * minute") is "no effect" plus the immunity. */
function concreteDegree(outcome) {
  if (!outcome) return null;
  const effects = outcome.conditions.length + outcome.penalties.length;
  const none = outcome.none || (!effects && outcome.immuneSeconds !== null);
  if (none && effects) return null;
  if (!none && !effects) return null;
  return { none, conditions: outcome.conditions, penalties: outcome.penalties, immuneSeconds: outcome.immuneSeconds };
}

const AS_DEGREE_RE = /^\s*as (?:an? )?(critical success|critical failure|success|failure)\b\s*[,;]?\s*(.*?)\s*\.?\s*$/i;

/** #935: "As <degree>[, <suffix>]" -> `{ ref: { degree, durationSeconds,
 * conditions } }`, resolved against the referenced degree by
 * resolveDegreeReferences. The suffix (after "but"/"plus"/"and also") may
 * only change the duration ("As failure, but for 1 minute") or change/add
 * conditions ("As failure, plus Dazzled for as long as it's frightened",
 * "As failure, but the creature is Slowed 2"); anything else is `null`. */
function parseAsDegree(text) {
  const match = AS_DEGREE_RE.exec(text);
  if (!match) return undefined;
  const degree = DEGREE_WORDS[match[1].toLowerCase()];
  const suffix = match[2].replace(/^(?:but|plus|and also|and)\s+/i, "").trim();
  if (!suffix) return { ref: { degree, durationSeconds: null, conditions: [] } };
  const outcome = parseOutcomeText(suffix);
  if (!outcome || outcome.none || outcome.immuneSeconds !== null || outcome.penalties.length) return null;
  if (outcome.conditions.length) return { ref: { degree, durationSeconds: null, conditions: outcome.conditions } };
  if (outcome.floatingDuration !== null) return { ref: { degree, durationSeconds: outcome.floatingDuration, conditions: [] } };
  return null;
}

/**
 * Parses one degree-of-success block's raw (enriched) HTML. Returns `null`
 * when anything non-trivial is left over after consuming every recognized
 * clause -- the ability's own `mode` becomes "reportOnly" when ANY degree
 * returns null here (all-or-nothing). Returns `{ none, conditions,
 * penalties, immuneSeconds }`, or `{ ref }` for an "As <degree>" block
 * (resolveDegreeReferences turns it into the referenced degree's outcome).
 */
export function parseDegreeBlock(blockHtml) {
  const text = normalizeDashes(stripHtml(blockHtml));
  const asDegree = parseAsDegree(text);
  if (asDegree !== undefined) return asDegree;
  return concreteDegree(parseOutcomeText(text));
}

/** Adds `condition` to `list`, replacing a same-slug entry (whose duration
 * it keeps when it has none of its own). */
function mergeCondition(list, condition) {
  const index = list.findIndex((c) => c.slug === condition.slug);
  if (index < 0) list.push({ ...condition });
  else list[index] = { ...condition, durationSeconds: condition.durationSeconds ?? list[index].durationSeconds };
}

function applyReference(target, ref) {
  const retime = (entry) =>
    ref.durationSeconds !== null && (entry.durationSeconds !== null || !SELF_ENDING_CONDITIONS.has(entry.slug))
      ? { ...entry, durationSeconds: ref.durationSeconds }
      : { ...entry };
  const conditions = target.conditions.map(retime);
  const penalties = target.penalties.map(retime);
  for (const c of ref.conditions) mergeCondition(conditions, c);
  return {
    none: target.none && !conditions.length && !penalties.length,
    conditions,
    penalties,
    immuneSeconds: target.immuneSeconds,
  };
}

/** #935: replaces every `{ ref }` degree with its referenced degree's own
 * outcome (plus the reference's changes). A reference to a missing,
 * unparseable or itself-referencing degree becomes `null`. */
export function resolveDegreeReferences(degrees) {
  const resolved = { ...degrees };
  for (const key of DEGREE_KEYS) {
    const degree = degrees[key];
    if (!degree?.ref) continue;
    const target = degrees[degree.ref.degree];
    resolved[key] = target && !target.ref && degree.ref.degree !== key ? applyReference(target, degree.ref) : null;
  }
  return resolved;
}

/** `<p><strong>Label</strong> body</p>` degree paragraphs, by key, plus the
 * HTML before the first one (the "preamble": flavor, the save sentence,
 * range/area, and any off-degree rider). */
function splitDegreeBlocks(html) {
  const re = /<p>\s*<strong>\s*(Critical Success|Success|Failure|Critical Failure)\s*<\/strong>([\s\S]*?)<\/p>/g;
  const blocks = {};
  let firstIndex = -1;
  let match;
  while ((match = re.exec(html))) {
    if (firstIndex < 0) firstIndex = match.index;
    const key = DEGREE_LABELS[match[1]];
    if (blocks[key] !== undefined) blocks.duplicate = true;
    blocks[key] = match[2];
  }
  return { blocks, preamble: firstIndex < 0 ? html : html.slice(0, firstIndex) };
}

/** `@Check[will|dc:27|traits:x,y|options:a,b|name:...]` -> its parts. */
function parseCheck(params) {
  const parts = params.split("|").map((p) => p.trim());
  const out = { type: null, dc: null, basic: false, traits: [], overrideTraits: false, options: [] };
  parts.forEach((part, index) => {
    const colon = part.indexOf(":");
    const key = colon < 0 ? part : part.slice(0, colon);
    const value = colon < 0 ? "" : part.slice(colon + 1);
    if (index === 0 && colon < 0) out.type = part;
    else if (key === "type") out.type = value;
    else if (key === "dc") out.dc = /^\d+$/.test(value) ? Number(value) : null;
    else if (key === "basic") out.basic = true;
    else if (key === "traits") out.traits.push(...value.split(",").map((t) => t.trim()).filter(Boolean));
    else if (key === "overrideTraits") out.overrideTraits = true;
    else if (key === "options") out.options.push(...value.split(",").map((t) => t.trim()).filter(Boolean));
    else if (key === "inflicts") out.options.push(`inflicts:${value}`);
  });
  return out;
}

/** The sentences of `preambleHtml` that mention a condition: an effect the
 * degree grammar doesn't model (Terrifying Display's "While a creature is
 * Frightened by this ability, it is Off-Guard to ..."), reported to the GM
 * to apply by hand. The @Check sentence itself is excluded. */
function extractRiderText(preambleHtml) {
  const sentences = renderPlain(preambleHtml).split(/(?<=\.)\s+/);
  const mentionsCondition = (s) =>
    KNOWN_CONDITION_SLUGS.some((slug) => new RegExp(`\\b${slug}\\b`, "i").test(s));
  const riders = [];
  // Re-check against the raw HTML so a sentence carrying the @Check is skipped.
  const rawSentences = stripHtml(preambleHtml).split(/(?<=\.)\s+/);
  sentences.forEach((sentence, i) => {
    if (/@Check\[/.test(rawSentences[i] ?? "")) return;
    if (mentionsCondition(sentence)) riders.push(sentence);
  });
  return riders.length ? riders.join(" ") : null;
}

/** #935: which degrees an immunity sentence covers: "those who critically
 * succeed" -> the critical success only; "regardless of the result" /
 * "any creature that attempts the save" / unqualified -> everyone
 * (`"all"`); "a creature that succeeds" / "creatures that successfully
 * save" / "on a success" -> success and critical success. */
function immunityScope(sentence) {
  if (/\bcritically succeed/i.test(sentence)) return "criticalSuccess";
  if (/\b(?:regardless|no matter|whether|attempts?|attempting)\b/i.test(sentence)) return "all";
  if (/\bsucce(?:ed|eds|ss|ssfully)\b/i.test(sentence)) return "success";
  if (/\bfail/i.test(sentence)) return null;
  return "all";
}

/** Immunity sentences of a block-form preamble -> `{ all, success,
 * criticalSuccess }` seconds (each null when absent). */
function preambleImmunity(preamblePlain) {
  const out = { all: null, success: null, criticalSuccess: null };
  for (const sentence of preamblePlain.split(/(?<=[.;])\s+/)) {
    const { immuneSeconds } = extractImmunity(sentence);
    if (immuneSeconds === null) continue;
    const scope = immunityScope(sentence);
    if (scope === null) return null;
    out[scope] ??= immuneSeconds;
  }
  return out;
}

function applyScopedImmunity(degrees, scope, seconds) {
  if (seconds === null) return;
  const keys = scope === "success" ? ["success", "criticalSuccess"] : [scope];
  for (const key of keys) {
    if (degrees[key] && degrees[key].immuneSeconds === null) degrees[key] = { ...degrees[key], immuneSeconds: seconds };
  }
}

/** #935: "Any non-boggard", "Non-goblin creatures", "Non-archons", "each
 * living creature" -> `{ excludeTraits, excludeNames, livingOnly }`;
 * `null` when there is no restriction; `undefined` when a restriction names
 * something the module can't test (a word that is neither a creature trait
 * nor the acting creature's own kind, "living or undead"). "Non-d'ziriaks"
 * and "Each non-emperor cobra creature" name the acting creature's own kind
 * (the text calls it "the d'ziriak" / "the emperor cobra"): creatures of
 * that name are excluded. */
function extractTargetFilter(plainText) {
  const text = normalizeDashes(plainText);
  const excludeTraits = [];
  const excludeNames = [];
  for (const match of text.matchAll(/\bnon-\s?([a-z][a-z'’]*)(?: ([a-z][a-z'’]*))?/gi)) {
    const words = [match[1], match[2]].filter(Boolean).map((w) => w.toLowerCase());
    const singular = (w) => w.replace(/s$/, "");
    const trait = [words[0], singular(words[0])].find((w) => FILTER_TRAITS.has(w));
    if (trait) {
      if (!excludeTraits.includes(trait)) excludeTraits.push(trait);
      continue;
    }
    // "non-sabosan creatures", "non-d'ziriaks in": a one-word name;
    // "non-emperor cobra creature": a two-word name (never its first word
    // alone -- "the terror shrike" is not a "terror bird").
    const oneWord = !words[1] || /^(?:creatures?|in|within|that|who|of|and|or|is|are|must)$/.test(words[1]);
    const candidates = oneWord
      ? [words[0], singular(words[0])]
      : [`${words[0]} ${words[1]}`, `${words[0]} ${singular(words[1])}`];
    const own = candidates.find((name) => new RegExp(`\\bthe ${name.replace(/['’]/g, "['’]")}\\b`, "i").test(text));
    if (!own) return undefined;
    if (!excludeNames.includes(own)) excludeNames.push(own);
  }
  if (/\bliving or\b/i.test(text)) return undefined;
  const livingOnly = /\bliving (?:creatures?|targets?|foes?|enem(?:y|ies))\b/i.test(text);
  if (!excludeTraits.length && !excludeNames.length && !livingOnly) return null;
  return { excludeTraits, excludeNames, livingOnly };
}

const SAVE_CHECK = String.raw`@Check\[[^\]]+\](?:\{[^}]*\})?\s+(?:save|saving throw)`;
const OR_FORM = new RegExp(
  String.raw`^(.*?)\b(?:must (?:each )?succeed(?: at)?|(?:must |to )?attempt) (?:an? )?${SAVE_CHECK} or (.+)$`,
  "i",
);
const UNLESS_FORM = new RegExp(
  String.raw`^(.*?)\b(?:becomes?|is|are) (.+?),? unless (?:they|it) succeeds? at (?:an? )?${SAVE_CHECK}(.*)$`,
  "i",
);
const ATTEMPT_FORM = new RegExp(String.raw`^(.*?)\b(?:must |to )?attempt (?:an? )?${SAVE_CHECK}$`, "i");
const FAIL_FORM = new RegExp(
  String.raw`^(.*?)\bthat fails? (?:a|an|the|its) ${SAVE_CHECK},? (?:becomes?|is|are) (.+)$`,
  "i",
);
const ON_FAILURE = /^on a failure, (?:a |the |each )?(?:creature|target)s? (?:becomes?|is|are) (.+)$/i;
const ON_CRITICAL_FAILURE = /^on a critical failure, (?:a |the |each )?(?:creature|target)s? (?:becomes?|is|are) (?:also )?(.+)$/i;
const RECHARGE_SENTENCE = /^the .+ can['’]t use .+ again for \[\[\/gmr \d+d\d+ #Recharge[^\]]*\]\](?:\{[^}]*\})?$/i;
/** Words that make a sentence before the save sentence more than flavor. */
const INLINE_RULES_WORDS =
  /\b(?:immune|penalty|penalties|bonus|damage|saves?|saving|checks?|unless|until|instead|if|can['’]t|cannot|must|DC|effects?)\b|@(?!Template\[)|\[\[/i;

/** Words that make a save sentence's subject more than a subject. */
const SUBJECT_RULES_WORDS =
  /\b(?:immune|penalty|penalties|bonus|damage|unless|until|instead|if|is|are|becomes?|takes?|can['’]t|cannot)\b|@(?!Template\[)|\[\[/i;

/** Splits off a `;`-joined tail that isn't inside parentheses. */
function splitTopLevelSemicolon(text) {
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "(") depth++;
    else if (text[i] === ")") depth--;
    else if (text[i] === ";" && depth === 0) return [text.slice(0, i), text.slice(i + 1)];
  }
  return [text, ""];
}

/** "(Frightened 3 on a critical failure, Frightened 1 on a success, or
 * unaffected on a critical success)" -> `[{ degree, text }]`; `null` when
 * the parenthetical isn't wholly such a list. */
function parseDegreeParenthetical(content) {
  const re = /\s*(?:,\s*)?(?:or\s+|and\s+)?(.+?)\s+on an? (critical success|critical failure|success|failure)\s*(?=,|$)/giy;
  const items = [];
  let match;
  while (re.lastIndex < content.length && (match = re.exec(content))) {
    items.push({ degree: DEGREE_WORDS[match[2].toLowerCase()], text: match[1] });
  }
  if (!items.length || re.lastIndex !== content.length) return null;
  return items;
}

/** An inline outcome phrase ("be Dazzled and Slowed 1 (or Slowed 2 on a
 * critical failure) for 1 round") -> `{ failure, extras }`, where `extras`
 * are the parenthetical's per-degree items. */
function parseInlineOutcomePhrase(phrase) {
  const parens = [...phrase.matchAll(/\(([^()]*)\)/g)];
  if (parens.length > 1) return null;
  let base = phrase;
  let extras = [];
  if (parens.length) {
    base = phrase.replace(parens[0][0], " ");
    extras = parseDegreeParenthetical(parens[0][1].trim());
    if (!extras) return null;
  }
  const failure = concreteDegree(parseOutcomeText(base));
  if (!failure || failure.none || failure.immuneSeconds !== null) return null;
  return { failure, extras };
}

const cloneDegree = (d) => ({
  ...d,
  conditions: d.conditions.map((c) => ({ ...c })),
  penalties: d.penalties.map((p) => ({ ...p })),
});
const NO_EFFECT = Object.freeze({ none: true, conditions: [], penalties: [], immuneSeconds: null });

/**
 * #935: the inline-outcome grammar, for an ability with no degree blocks.
 * Every sentence must be accounted for: flavor before the save sentence
 * (no conditions, saves, penalties, immunity or other rules words), the save
 * sentence in one of four closed shapes, and after it only "On a failure /
 * On a critical failure, a creature is ..." outcome sentences, immunity
 * sentences and the recharge sentence. Returns `{ degrees, immuneSeconds }`
 * or `null`. A failure outcome is required; an unstated success is "no
 * effect"; an unstated critical success/failure takes the success/failure
 * outcome.
 */
function parseInlineOutcome(html) {
  const body = html
    .replace(/<p>\s*<strong>\s*Frequency\s*<\/strong>[\s\S]*?<\/p>/i, " ")
    .replace(/<strong>\s*Effect\s*<\/strong>/gi, " ");
  const text = normalizeDashes(stripHtml(body));
  // A spell, effect or action link is an outcome this grammar can't apply.
  if (/@UUID\[(?!Compendium\.pf2e\.conditionitems\.)/.test(text)) return null;
  const sentences = text.split(/(?<=[.!?])\s+/).map((s) => s.replace(/\.\s*$/, "").trim()).filter(Boolean);
  const saveIndexes = sentences.map((s, i) => (/@Check\[/.test(s) ? i : -1)).filter((i) => i >= 0);
  if (saveIndexes.length !== 1) return null;
  const saveIndex = saveIndexes[0];
  for (const sentence of sentences.slice(0, saveIndex)) {
    if (INLINE_RULES_WORDS.test(sentence) || CONDITION_WORD_RE.test(sentence) || /conditionitems\./.test(sentence)) return null;
  }

  const saveSentence = sentences[saveIndex];
  // The subject before the save ("Any non-boggard within 30 feet", "The
  // venedaemon whispers to a creature within 15 feet, which") must not carry
  // an effect of its own (Cytillesh Stare's "The target is Dazzled for 1
  // round and must succeed ...").
  const subjectOk = (subject) => !CONDITION_WORD_RE.test(subject) && !/conditionitems\./.test(subject) && !SUBJECT_RULES_WORDS.test(subject);
  const post = [];
  let failurePhrase = null;
  let successOnUnless = false;
  let match;
  if ((match = UNLESS_FORM.exec(saveSentence))) {
    if (!subjectOk(match[1])) return null;
    failurePhrase = match[2];
    successOnUnless = true;
    const tail = match[3].replace(/^\s*[;,]\s*/, "").trim();
    if (tail) post.push(tail);
  } else if ((match = OR_FORM.exec(saveSentence))) {
    if (!subjectOk(match[1])) return null;
    const [phrase, tail] = splitTopLevelSemicolon(match[2]);
    failurePhrase = phrase;
    if (tail.trim()) post.push(tail.trim());
  } else if ((match = FAIL_FORM.exec(saveSentence))) {
    if (!subjectOk(match[1])) return null;
    failurePhrase = match[2];
  } else if (!(match = ATTEMPT_FORM.exec(saveSentence)) || !subjectOk(match[1])) {
    return null;
  }
  post.push(...sentences.slice(saveIndex + 1));

  const criticalFailureExtras = [];
  const immunities = [];
  for (const sentence of post) {
    if ((match = ON_FAILURE.exec(sentence))) {
      if (failurePhrase !== null) return null;
      failurePhrase = match[1];
    } else if ((match = ON_CRITICAL_FAILURE.exec(sentence))) {
      const extra = concreteDegree(parseOutcomeText(match[1]));
      if (!extra || extra.none || extra.immuneSeconds !== null) return null;
      criticalFailureExtras.push(extra);
    } else if (RECHARGE_SENTENCE.test(sentence)) {
      continue;
    } else if (/\bimmune\b/i.test(sentence)) {
      const { immuneSeconds, remaining } = extractImmunity(sentence);
      if (immuneSeconds === null) return null;
      if (CONDITION_WORD_RE.test(remaining) || /@|\b(?:penalty|bonus|damage|unless|until|instead|if|can['’]t)\b/i.test(remaining)) return null;
      const scope = immunityScope(sentence);
      if (!scope) return null;
      immunities.push({ scope, seconds: immuneSeconds });
    } else {
      return null;
    }
  }
  if (failurePhrase === null) return null;
  const phrase = parseInlineOutcomePhrase(failurePhrase);
  if (!phrase) return null;

  const failure = phrase.failure;
  const criticalFailure = cloneDegree(failure);
  let success = null;
  let criticalSuccess = null;
  for (const extra of phrase.extras) {
    if (extra.degree === "criticalFailure") {
      const durationOnly = new RegExp(`^(?:for )?(${COUNT}) (${DURATION_UNITS})$`, "i").exec(extra.text.trim());
      if (durationOnly) {
        const seconds = durationSeconds(durationOnly[1], durationOnly[2]);
        for (const entry of [...criticalFailure.conditions, ...criticalFailure.penalties]) {
          if (entry.durationSeconds !== null || !SELF_ENDING_CONDITIONS.has(entry.slug)) entry.durationSeconds = seconds;
        }
        continue;
      }
      const outcome = concreteDegree(parseOutcomeText(extra.text));
      if (!outcome || outcome.none || outcome.immuneSeconds !== null || outcome.penalties.length) return null;
      for (const c of outcome.conditions) mergeCondition(criticalFailure.conditions, c);
    } else if (extra.degree === "success" || extra.degree === "criticalSuccess") {
      const outcome = concreteDegree(parseOutcomeText(extra.text));
      if (!outcome || outcome.immuneSeconds !== null) return null;
      if (extra.degree === "success") success = outcome;
      else criticalSuccess = outcome;
    } else {
      return null;
    }
  }
  for (const extra of criticalFailureExtras) for (const c of extra.conditions) mergeCondition(criticalFailure.conditions, c);
  success ??= { ...NO_EFFECT };
  criticalSuccess ??= successOnUnless ? { ...NO_EFFECT } : cloneDegree(success);

  const degrees = { criticalSuccess, success, failure, criticalFailure };
  let immuneSeconds = null;
  for (const { scope, seconds } of immunities) {
    if (scope === "all") immuneSeconds ??= seconds;
    else applyScopedImmunity(degrees, scope, seconds);
  }
  return { degrees, immuneSeconds };
}

/** #935: a degree this module can't apply as written: a timed-style
 * condition or a penalty with no stated end, or a duration-based Stunned
 * ("stunned for 1 round" -- PF2e's non-valued Stunned, not Stunned N). */
function hasUnsupportedEffect(degree) {
  if (!degree || degree.none) return false;
  return (
    degree.conditions.some(
      (c) =>
        (c.durationSeconds === null && !SELF_ENDING_CONDITIONS.has(c.slug)) ||
        (c.slug === "stunned" && c.value === null),
    ) || degree.penalties.some((p) => typeof p.durationSeconds !== "number")
  );
}

export function parseSaveAbility(item) {
  if (item?.type !== "action") return null;
  const actionType = item.system?.actionType?.value;
  if (actionType !== "action" && actionType !== "free") return null;

  const html = item.system?.description?.value ?? "";
  if (/@Damage\[/.test(html)) return null;
  // Requirements/Trigger gates can't be verified here; never offer them.
  if (/<strong>\s*(Requirements?|Trigger)\s*<\/strong>/i.test(html)) return null;

  const checks = [...html.matchAll(/@Check\[([^\]]+)\]/g)].map((m) => parseCheck(m[1]));
  const check = checks[0];
  if (!check || !SAVES.has(check.type) || check.dc == null) return null;
  // A basic save is a damage save -- the breath-weapon/strike code's turf.
  if (check.basic) return null;

  const { blocks, preamble } = splitDegreeBlocks(html);
  const preamblePlain = stripHtml(preamble);

  // "Up to three creatures within 30 feet": a target-count choice this
  // module doesn't model.
  if (/\bup to (?:\d+|two|three|four|five|six) (?:creatures|targets|enemies|foes)\b/i.test(preamblePlain)) return null;

  const templateMatch = /@Template\[(?:type:)?(\w+)\|distance:(\d+)[^\]]*\]/.exec(html);
  const rangeText = preamblePlain.replace(/@Template\[[^\]]*\](\{[^}]*\})?/g, " ");
  const rangeMatch = /\b(?:within|up to) (\d+) feet\b/i.exec(rangeText);
  // "Creatures within 30 feet of the aqudel must attempt ..." (Strobe) is
  // an emanation, not one target in range; #935: so is "Each non-aberration
  // creature within 120 feet" (Unnatural Shriek).
  const groupRangeMatch = /\b(?:creatures|each (?:(?:living |non[-–][a-z'’]+(?: [a-z'’]+)? )?(?:creature|enemy|foe))|all (?:creatures|enemies|foes)|enemies|foes) within (\d+) feet\b/i.exec(rangeText);
  let shape;
  if (templateMatch) {
    shape = { areaType: templateMatch[1], distanceFeet: Number(templateMatch[2]) };
    if (shape.areaType === "burst") {
      // A burst's center must be in a stated range ("centered on a point
      // within 60 feet"); "within reach" or no range at all is not offered.
      if (!rangeMatch) return null;
      shape.rangeFeet = Number(rangeMatch[1]);
    }
  } else if (groupRangeMatch) {
    shape = { areaType: "emanation", distanceFeet: Number(groupRangeMatch[1]) };
  } else if (rangeMatch) {
    shape = { rangeFeet: Number(rangeMatch[1]) };
  } else if (/\btouch(?:es|ing)?\b/i.test(preamblePlain)) {
    shape = { rangeFeet: AGENT_MELEE_REACH_FEET };
  } else {
    return null;
  }

  const rechargeMatch = /\[\[\/gmr (\d+d\d+) #Recharge/.exec(html);
  const frequency = item.system?.frequency ?? null;
  // A free action with no limit would be offered again every decision.
  if (actionType === "free" && !rechargeMatch && !frequency) return null;

  let degrees = {};
  const degreeText = {};
  let mode = "auto";
  let family = "blocks";
  let immuneSeconds = null;
  let riderText = null;
  let targetFilter = null;
  let preambleImmunityOk = true;
  const hasBlocks = DEGREE_KEYS.some((key) => blocks[key] !== undefined);
  if (hasBlocks) {
    for (const key of DEGREE_KEYS) {
      const blockHtml = blocks[key];
      degreeText[key] = blockHtml === undefined ? null : renderPlain(blockHtml);
      degrees[key] = blockHtml === undefined ? undefined : parseDegreeBlock(blockHtml);
    }
    // PF2e's convention: an unlisted critical success uses the success
    // effect, an unlisted critical failure the failure effect. Success and
    // failure themselves must be stated.
    if (degrees.criticalSuccess === undefined && degrees.success !== undefined) {
      degrees.criticalSuccess = { ref: { degree: "success", durationSeconds: null, conditions: [] } };
    }
    if (degrees.criticalFailure === undefined && degrees.failure !== undefined) {
      degrees.criticalFailure = { ref: { degree: "failure", durationSeconds: null, conditions: [] } };
    }
    for (const key of DEGREE_KEYS) degrees[key] ??= null;
    degrees = resolveDegreeReferences(degrees);
    const immunity = preambleImmunity(preamblePlain);
    if (immunity) {
      immuneSeconds = immunity.all;
      applyScopedImmunity(degrees, "success", immunity.success);
      applyScopedImmunity(degrees, "criticalSuccess", immunity.criticalSuccess);
    } else {
      preambleImmunityOk = false;
    }
    riderText = extractRiderText(preamble);
    targetFilter = extractTargetFilter(preamblePlain);
  } else {
    family = "inline";
    for (const key of DEGREE_KEYS) degreeText[key] = null;
    const inline = parseInlineOutcome(html);
    if (inline) {
      degrees = inline.degrees;
      immuneSeconds = inline.immuneSeconds;
    } else {
      for (const key of DEGREE_KEYS) degrees[key] = null;
      // #915: the whole roll-and-report text is the ability card itself.
      immuneSeconds = extractImmunity(preamblePlain).immuneSeconds;
    }
    targetFilter = extractTargetFilter(stripHtml(html));
  }
  // #935: why an ability is reportOnly, for the coverage audit's triage
  // (#987/#988). Any reason at all means reportOnly.
  const reasons = [];
  if (hasBlocks && DEGREE_KEYS.some((key) => !degrees[key])) reasons.push("unparsedBlock");
  if (!hasBlocks && DEGREE_KEYS.some((key) => !degrees[key])) reasons.push("unparsedInline");
  if (hasBlocks && !preambleImmunityOk) reasons.push("immunityScope");
  if (DEGREE_KEYS.some((key) => hasUnsupportedEffect(degrees[key]))) reasons.push("openEndedEffect");
  if (targetFilter === undefined) {
    reasons.push("targetFilter");
    targetFilter = null;
  }
  if (blocks.duplicate) reasons.push("duplicateBlock");
  // A second check (a follow-up save, a skill check) or a non-recharge
  // inline roll is outside the grammar too.
  if (checks.length > 1) reasons.push("multipleChecks");
  if (/\[\[\/(?!gmr \d+d\d+ #Recharge)/.test(html)) reasons.push("inlineRoll");
  if (reasons.length) mode = "reportOnly";

  const itemTraits = item.system?.traits?.value ?? [];
  const traits = [...new Set(check.overrideTraits ? check.traits : [...check.traits, ...itemTraits])];

  const descriptor = {
    save: check.type,
    dc: check.dc,
    shape,
    traits,
    rollOptions: check.options,
    cost: actionType === "free" ? 0 : (item.system?.actions?.value ?? 1),
    frequency,
    rechargeFormula: rechargeMatch ? rechargeMatch[1] : null,
    // "Each enemy in ..." spares allies; "Creatures within ..." does not.
    affectsAllies: !/\benem(?:y|ies)\b/i.test(preamblePlain),
    // "Regardless of the result, creatures are temporarily immune for 1
    // minute" (Bloodcurdling Screech): immunity for every creature that
    // attempted the save, whatever its degree.
    immuneSeconds,
    riderText,
    targetFilter,
    degrees,
    degreeText,
    mode,
    family,
    reportReasons: reasons,
  };

  // #935: a reviewed hand-written outcome replaces the grammar's -- only
  // while the item's text still reads exactly as it did when reviewed.
  const override = findNpcAbilityOverride(item, renderPlain(html), check.type);
  if (override) {
    return {
      ...descriptor,
      ...override,
      family: "override",
      mode: "auto",
      reportReasons: [],
    };
  }
  return descriptor;
}

/** #935: whether `actor` is outside the ability's stated targets ("Any
 * non-boggard", "each living creature"). The actor's own traits are the
 * system's (`actor.traits`, ancestry traits included for a PC); "living"
 * is the system's own `modeOfBeing`. */
export function npcAbilityExcludesTarget(descriptor, actor) {
  const filter = descriptor?.targetFilter;
  if (!filter || !actor) return false;
  const traits = actor.traits instanceof Set ? actor.traits : new Set(actor.system?.traits?.value ?? []);
  if ((filter.excludeTraits ?? []).some((t) => traits.has(t))) return true;
  const name = String(actor.name ?? "").toLowerCase();
  if ((filter.excludeNames ?? []).some((n) => name.includes(n))) return true;
  if (filter.livingOnly) {
    const mode = actor.modeOfBeing ?? (traits.has("undead") ? "undead" : traits.has("construct") ? "construct" : "living");
    if (mode !== "living") return true;
  }
  return false;
}

export { durationLabel as npcAbilityDurationLabel };

const DEGREE_SUMMARY_LABELS = { success: "success", failure: "failure", criticalFailure: "critical failure" };

function durationLabel(durationSeconds) {
  if (durationSeconds === "untilNextTurn") return "until end of its next turn";
  if (typeof durationSeconds === "string" && durationSeconds.startsWith("while:")) {
    return `while ${durationSeconds.slice("while:".length)}`;
  }
  if (durationSeconds % 86400 === 0) return `${durationSeconds / 86400} day`;
  if (durationSeconds % 3600 === 0) return `${durationSeconds / 3600} hour`;
  if (durationSeconds % 60 === 0) return `${durationSeconds / 60} minute`;
  return `${durationSeconds / SECONDS_PER_ROUND} round`;
}

/** #935: "-1 status penalty to attack-roll/saving-throw (1 minute)". */
export function describeNpcPenalty(penalty) {
  const head = `${penalty.value} ${penalty.type} penalty to ${penalty.selectors.join("/")}`;
  return penalty.durationSeconds != null ? `${head} (${durationLabel(penalty.durationSeconds)})` : head;
}

/** #915: the deterministic one-line description the reasoning model (and
 * the GM's decision card) sees for an NPC ability -- it never reads the
 * ability's prose. Critical success is left out (never worse than success). */
export function describeNpcAbility(descriptor) {
  const { shape } = descriptor;
  const shapeLabel = shape.areaType
    ? `${shape.distanceFeet}-ft ${shape.areaType}`
    : `single target within ${shape.rangeFeet} ft`;
  const filter = descriptor.targetFilter;
  const filterLabel = filter
    ? ` (${[...(filter.excludeTraits ?? []), ...(filter.excludeNames ?? [])].map((t) => `non-${t}`).concat(filter.livingOnly ? ["living"] : []).join(", ")} only)`
    : "";
  const head = `${descriptor.save} DC ${descriptor.dc}, ${shapeLabel}${filterLabel}`;
  if (descriptor.mode !== "auto") return `${head}; outcome resolved by the GM`;
  const parts = Object.entries(DEGREE_SUMMARY_LABELS).map(([key, label]) => {
    const degree = descriptor.degrees[key];
    if (degree.none) return `${label}: no effect`;
    const effects = degree.conditions.map((c) => {
      const name = c.value != null ? `${c.slug} ${c.value}` : c.slug;
      return c.durationSeconds != null ? `${name} (${durationLabel(c.durationSeconds)})` : name;
    });
    effects.push(...(degree.penalties ?? []).map(describeNpcPenalty));
    return `${label}: ${effects.join(", ")}`;
  });
  return `${head}; ${parts.join("; ")}`;
}
