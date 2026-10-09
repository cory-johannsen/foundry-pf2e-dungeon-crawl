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
 */

import { AGENT_MELEE_REACH_SQUARES } from "./agent-candidates.mjs";

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

const DEGREE_LABELS = {
  "Critical Success": "criticalSuccess",
  Success: "success",
  Failure: "failure",
  "Critical Failure": "criticalFailure",
};
const DEGREE_KEYS = ["criticalSuccess", "success", "failure", "criticalFailure"];

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

const CONDITION_LINK = /@UUID\[Compendium\.pf2e\.conditionitems\.Item\.([^\]]+)\](?:\{([^}]*)\})?/g;

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

/** The first duration phrase in `text` ("for N rounds/minutes/hours/days",
 * "until the end of its next turn"), consumed. */
function extractDuration(text) {
  const timed = new RegExp(`\\bfor (\\d+) (${DURATION_UNITS})\\b`, "i").exec(text);
  if (timed) {
    return {
      durationSeconds: Number(timed[1]) * DURATION_UNIT_SECONDS[timed[2].toLowerCase()],
      remaining: text.replace(timed[0], " "),
    };
  }
  const untilNextTurn = /\buntil the end of (?:its|their|the target's|the creature's) next turn\b/i.exec(text);
  if (untilNextTurn) {
    return { durationSeconds: "untilNextTurn", remaining: text.replace(untilNextTurn[0], " ") };
  }
  return { durationSeconds: null, remaining: text };
}

function extractImmunity(text) {
  const match = new RegExp(`\\btemporarily immune(?:\\s+to\\s+[^.]+?)?\\s+for\\s+(\\d+)\\s+(${DURATION_UNITS})\\b`, "i").exec(text);
  if (!match) return { immuneSeconds: null, remaining: text };
  return {
    immuneSeconds: Number(match[1]) * DURATION_UNIT_SECONDS[match[2].toLowerCase()],
    remaining: text.replace(match[0], " "),
  };
}

function extractNone(text) {
  const match = /\b(unaffected|no effect)\b/i.exec(text);
  if (!match) return { none: false, remaining: text };
  return { none: true, remaining: text.replace(match[0], " ") };
}

const BOILERPLATE = /\b(the creature is|the target is|the creature|the target|it is|they are|and|also|is|becomes)\b/gi;

/**
 * Parses one degree-of-success block's raw (enriched) HTML. Returns `null`
 * when anything non-trivial is left over after consuming every recognized
 * clause -- the ability's own `mode` becomes "reportOnly" when ANY degree
 * returns null here (all-or-nothing).
 */
function parseDegreeBlock(blockHtml) {
  if (/^\s*as failure\s*\.?\s*$/i.test(renderPlain(blockHtml))) {
    return { none: false, asFailure: true, conditions: [], immuneSeconds: null };
  }
  let text = stripHtml(blockHtml);
  const noneResult = extractNone(text);
  text = noneResult.remaining;
  const immunityResult = extractImmunity(text);
  text = immunityResult.remaining;

  // A duration attaches to the conditions in its own clause: Terrifying
  // Display's "Frightened 2 and Fleeing until the end of its next turn" is
  // Fleeing for that long while Frightened decays on its own (#943's
  // end-of-turn hook). A duration in a clause with no condition of its
  // own ("For 1 hour, the target is Stupefied 2") covers every condition in
  // the block that has none.
  const conditions = [];
  let floatingDuration = null;
  let leftover = "";
  for (const clause of text.split(/,|\band\b/i)) {
    let rest = clause;
    const linked = extractLinkedConditions(rest);
    rest = linked.remaining;
    const bare = extractBareConditions(rest);
    rest = bare.remaining;
    const duration = extractDuration(rest);
    rest = duration.remaining;
    const found = [...linked.conditions, ...bare.conditions];
    if (duration.durationSeconds !== null && !found.length) {
      if (floatingDuration !== null) return null;
      floatingDuration = duration.durationSeconds;
    }
    for (const c of found) conditions.push({ ...c, durationSeconds: duration.durationSeconds });
    leftover += ` ${rest}`;
  }
  if (floatingDuration !== null) {
    for (const c of conditions) if (c.durationSeconds === null) c.durationSeconds = floatingDuration;
  }

  if (leftover.replace(BOILERPLATE, " ").replace(/[.,;\s]+/g, " ").trim().length > 0) return null;
  // A "none" block that also names a condition is self-contradictory.
  if (noneResult.none && conditions.length) return null;
  if (!noneResult.none && !conditions.length) return null;

  return {
    none: noneResult.none,
    asFailure: false,
    conditions,
    immuneSeconds: immunityResult.immuneSeconds,
  };
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
  // an emanation, not one target in range.
  const groupRangeMatch = /\b(?:creatures|each (?:creature|enemy|foe)|all (?:creatures|enemies|foes)|enemies|foes) within (\d+) feet\b/i.exec(rangeText);
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

  const degrees = {};
  const degreeText = {};
  let mode = "auto";
  for (const key of DEGREE_KEYS) {
    const blockHtml = blocks[key];
    if (blockHtml === undefined) {
      degrees[key] = null;
      degreeText[key] = null;
      mode = "reportOnly";
      continue;
    }
    degreeText[key] = renderPlain(blockHtml);
    const parsed = parseDegreeBlock(blockHtml);
    degrees[key] = parsed;
    if (!parsed) mode = "reportOnly";
  }
  if (blocks.duplicate) mode = "reportOnly";
  // A second check (a follow-up save, a skill check) or a non-recharge
  // inline roll is outside the grammar too.
  if (checks.length > 1) mode = "reportOnly";
  if (/\[\[\/(?!gmr \d+d\d+ #Recharge)/.test(html)) mode = "reportOnly";

  const itemTraits = item.system?.traits?.value ?? [];
  const traits = [...new Set(check.overrideTraits ? check.traits : [...check.traits, ...itemTraits])];

  return {
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
    immuneSeconds: extractImmunity(preamblePlain).immuneSeconds,
    riderText: extractRiderText(preamble),
    degrees,
    degreeText,
    mode,
  };
}

const DEGREE_SUMMARY_LABELS = { success: "success", failure: "failure", criticalFailure: "critical failure" };

function durationLabel(durationSeconds) {
  if (durationSeconds === "untilNextTurn") return "until end of its next turn";
  if (durationSeconds % 86400 === 0) return `${durationSeconds / 86400} day`;
  if (durationSeconds % 3600 === 0) return `${durationSeconds / 3600} hour`;
  if (durationSeconds % 60 === 0) return `${durationSeconds / 60} minute`;
  return `${durationSeconds / SECONDS_PER_ROUND} round`;
}

/** #915: the deterministic one-line description the reasoning model (and
 * the GM's decision card) sees for an NPC ability -- it never reads the
 * ability's prose. Critical success is left out (never worse than success). */
export function describeNpcAbility(descriptor) {
  const { shape } = descriptor;
  const shapeLabel = shape.areaType
    ? `${shape.distanceFeet}-ft ${shape.areaType}`
    : `single target within ${shape.rangeFeet} ft`;
  const head = `${descriptor.save} DC ${descriptor.dc}, ${shapeLabel}`;
  if (descriptor.mode !== "auto") return `${head}; outcome resolved by the GM`;
  const parts = Object.entries(DEGREE_SUMMARY_LABELS).map(([key, label]) => {
    const degree = descriptor.degrees[key];
    if (degree.asFailure) return `${label}: as failure`;
    if (degree.none) return `${label}: no effect`;
    const effects = degree.conditions.map((c) => {
      const name = c.value != null ? `${c.slug} ${c.value}` : c.slug;
      return c.durationSeconds != null ? `${name} (${durationLabel(c.durationSeconds)})` : name;
    });
    return `${label}: ${effects.join(", ")}`;
  });
  return `${head}; ${parts.join("; ")}`;
}
