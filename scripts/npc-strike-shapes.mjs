/**
 * #933: pure recognition of NPC "Strike-plus" abilities -- a Strike with a
 * twist (Wrestle, Death Roll, Gnaw, Maul, Constrict, Lunging Bite, Broad
 * Swipe, Wide Swing, Swipe, Mangling Rend, Hurl Net, Rend). No Foundry API
 * surface. An ability's description is matched against a small set of named
 * shapes; every sentence must be consumed by the shape's grammar (or be pure
 * flavor -- no rules words, enrichers or conditions at all), or the ability
 * is not offered (all-or-nothing, #915/#932's convention): a half-modeled
 * ability is never run, because GM-less runs have no one to apply the rest.
 * Shapes match an ability's TEXT, never its name: "Gnaw" and "Lunging Bite"
 * each name unrelated mechanics on different creatures.
 *
 * Grounded against the compendium text (pf2e packs: Monster Core 1-2,
 * Bestiary 1-3); see tests/fixtures/npc-strike-ability-slice.json.
 *
 * `parseStrikePlusAbility(item)` -> null or
 *   `{ shape, cost, frequency, requirement, params }` where `requirement` is
 *   `{ grabbed: boolean, grabLimb: string|null, item: string|null }` and
 *   `params` depends on `shape`:
 *   - strikeAgainstGrabbed: `{ limb, count, mapRule, attackBonus, onHit,
 *     onMissRelease }` -- `onHit` is a list of `{ kind: "condition", slug }`
 *     or `{ kind: "save", save, dc, traits, rollOptions, degrees }`
 *     (#915's degree shape); `mapRule` "normal" (each Strike escalates) or
 *     "same" (all at the current penalty, which rises only afterwards).
 *   - constrictLike: `{ damage, save, dc, degrees }` -- a basic-save damage
 *     with optional per-degree riders (Greater Constrict).
 *   - extendedReachStrike: `{ limb, reachFeet }`.
 *   - twoTargetStrikes: `{ limb, mapRule, adjacentTargets }`.
 *   - singleRollMultiAC: `{ limb, maxTargets, mapCount, adjacency,
 *     damageOnce }` -- `limb` null means any melee Strike;
 *     `adjacency` "none" | "eachOther" | "atLeastOne".
 *   - bundleWithBothHitRider: `{ limb, count, extraDamage, conditions,
 *     effectName }`.
 *   - strikeWithOnHit: `{ fixedModifier, rangeFeet, sizeCap, effectName,
 *     escapeDc }` (Hurl Net: the linked effect applies Off-Guard and the
 *     Speed penalty on a hit, Restrained on a critical hit).
 *   - rend: `{ limb }`.
 * Never throws.
 */

import { parseDegreeBlock, resolveDegreeReferences, KNOWN_CONDITION_SLUGS } from "./npc-ability-parse.mjs";

const NUMBER_WORDS = Object.freeze({ two: 2, three: 3, four: 4, five: 5 });
const SIZE_WORDS = Object.freeze({ tiny: "tiny", small: "sm", medium: "med", large: "lg", huge: "huge", gargantuan: "grg" });

const SUBJECT_POSSESSIVE = "(?:its|their|his|her|the [\\w'’ -]+?['’]s?)";
const LIMB = "(?<limb>[A-Za-z][A-Za-z'’-]*(?: [A-Za-z][A-Za-z'’-]*){0,2}?)";

/** Rules words: a sentence containing none of these (and no enricher or
 * condition) is flavor ("The crocodile tucks its legs and rolls rapidly,
 * twisting its victim.") and is safely ignored. Anything else must be
 * consumed by the shape's grammar. */
const RULES_WORDS = /\b(?:strikes?|attacks?|hits?|damage|saves?|saving|DC|bonus|penalty|penalties|AC|reach|feet|foot|speeds?|strides?|steps?|moves?|movement|actions?|reactions?|rounds?|turns?|minutes?|hours?|grab\w*|releases?|checks?|immune|resist\w*|weak\w*|frequency|requirements?|trigger|spells?|casts?|persistent|bleed|healing|hit points|escape|instead|unless|until|while|each|every|additional|extra)\b/i;
const CONDITION_WORDS = new RegExp(`\\b(?:${KNOWN_CONDITION_SLUGS.join("|").replace(/-/g, "[- ]")})\\b`, "i");

function isFlavor(text) {
  const t = String(text ?? "").replace(/[\s.,;:!—–-]+/g, " ").trim();
  if (!t) return true;
  if (/[@[\]{}]|\d/.test(t)) return false;
  if (RULES_WORDS.test(t) || CONDITION_WORDS.test(t)) return false;
  return true;
}

/** `regex` must match inside `sentence`; whatever is left must be flavor
 * (the creature's own name, "lunges their head forward", ...). */
function consume(sentence, regex) {
  const m = regex.exec(sentence);
  if (!m) return null;
  const leftover = sentence.slice(0, m.index) + " " + sentence.slice(m.index + m[0].length);
  return isFlavor(leftover) ? m : null;
}

/** Enriched HTML -> plain text with the tokens the grammar needs kept:
 * condition links become their name, `@Damage[...]`/`@Check[...]` stay,
 * `[[/r 1d20+9 ...]]{+9}` becomes `ROLL(9)`, other inline rolls their
 * label, `@Localize[...Glossary.X]` becomes `GLOSSARY(X)`. */
function plainText(html) {
  return String(html ?? "")
    .replace(/@Localize\[PF2E\.NPC\.Abilities\.Glossary\.(\w+)\]/g, " GLOSSARY($1) ")
    .replace(/@UUID\[[^\]]*\]\{([^}]*)\}/g, "$1")
    .replace(/@UUID\[Compendium\.pf2e\.conditionitems\.Item\.([^\]]+)\]/g, "$1")
    .replace(/@UUID\[[^\]]*?\.([^\].]+)\]/g, "$1")
    .replace(/\[\[\/r 1d20\+(\d+)[^\]]*\]\](?:\{[^}]*\})?/g, "ROLL($1)")
    .replace(/\[\[\/act (\w+)[^\]]*\]\](?:\{([^}]*)\})?/g, (_m, act, label) => label ?? act.replace(/^\w/, (c) => c.toUpperCase()))
    .replace(/(@Damage\[[^\]]*(?:\][^\]]*)*?\]\])\{[^}]*\}/g, "$1")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/[–—]/g, "-")
    .replace(/\s+/g, " ")
    .trim();
}

function splitSentences(text) {
  return text
    .replace(/\.{2,}/g, ".")
    .split(/(?<=\.)\s+(?=[A-Z@(]|GLOSSARY)/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** `<p><strong>Label</strong> ...</p>` blocks by label, the effect HTML
 * (everything that is not Requirements/Frequency/Trigger/a degree block),
 * and the linked bestiary effects. */
function splitBlocks(html) {
  const out = { requirements: null, trigger: null, frequency: null, degrees: {}, effectHtml: "", effectLinks: [] };
  let rest = String(html ?? "").replace(/<hr\s*\/?>/gi, " ");
  rest = rest.replace(/@UUID\[Compendium\.pf2e\.bestiary-effects\.Item\.([^\]]+)\](?:\{[^}]*\})?/g, (_m, name) => {
    out.effectLinks.push(name.trim());
    return " ";
  });
  const blockRe = /<p>\s*<strong>\s*([^<]+?)\s*<\/strong>([\s\S]*?)<\/p>/g;
  rest = rest.replace(blockRe, (whole, label, body) => {
    const key = label.trim().toLowerCase();
    if (key === "requirements" || key === "requirement") {
      out.requirements = body;
      return " ";
    }
    if (key === "trigger") {
      out.trigger = body;
      return " ";
    }
    if (key === "frequency") {
      out.frequency = body;
      return " ";
    }
    if (key === "effect") return `<p>${body}</p>`;
    const degree = { "critical success": "criticalSuccess", success: "success", failure: "failure", "critical failure": "criticalFailure" }[key];
    if (degree) {
      if (out.degrees[degree] !== undefined) out.duplicateDegree = true;
      out.degrees[degree] = body;
      return " ";
    }
    return whole;
  });
  out.effectHtml = rest;
  return out;
}

function limbName(text) {
  return String(text ?? "").trim().toLowerCase();
}

function parseCheck(params) {
  const parts = params.split("|").map((p) => p.trim());
  const out = { type: parts[0], dc: null, basic: false, traits: [], options: [], other: false };
  for (const part of parts.slice(1)) {
    const [key, value = ""] = part.split(":");
    if (key === "dc" && /^\d+$/.test(value)) out.dc = Number(value);
    else if (key === "basic") out.basic = true;
    else if (key === "traits") out.traits.push(...value.split(",").map((t) => t.trim()).filter(Boolean));
    else if (key === "options") out.options.push(...value.split(",").map((t) => t.trim()).filter(Boolean));
    else out.other = true;
  }
  return out;
}

/** `@Damage[(1d8+9)[bludgeoning],1d6[acid]]` -> the DamageRoll formula
 * ("(1d8+9)[bludgeoning],1d6[acid]"), or null for anything with options
 * (`|traits:...`) or no damage type. */
function damageFormula(token) {
  const m = /^@Damage\[([\s\S]+)\]$/.exec(token);
  if (!m || m[1].includes("|")) return null;
  if (!/\[[a-z]+\]/.test(m[1])) return null;
  return m[1];
}

const DAMAGE_TOKEN = "@Damage\\[(?:[^\\[\\]]|\\[[^\\]]*\\])+\\]";

// --- requirement ----------------------------------------------------------

const REQ_GRABBED = new RegExp(
  `^(?:The |the )?[\\w'’ -]+? (?:must have|has|have) a creature (?:Grabbed|grabbed)(?: (?:with|by|from) ${SUBJECT_POSSESSIVE} (?<limb>[a-z]+?)(?: Strike)?)?\\.?$`,
);
const REQ_GRABBING = /^(?:The |the )?[\w'’ -]+? (?:is|are) grabbing a creature\.?$/;
const REQ_NET = /^(?:The |the )?[\w'’ -]+? (?:is|are) (?:wielding|holding) a net in two (?:hands|appendages)\.?$/;

function parseRequirement(html) {
  if (html == null) return { grabbed: false, grabLimb: null, item: null };
  const text = plainText(html);
  const grabbed = REQ_GRABBED.exec(text);
  if (grabbed) return { grabbed: true, grabLimb: grabbed.groups.limb ? limbName(grabbed.groups.limb) : null, item: null };
  if (REQ_GRABBING.test(text)) return { grabbed: true, grabLimb: null, item: null };
  if (REQ_NET.test(text)) return { grabbed: false, grabLimb: null, item: "net" };
  return null;
}

// --- shapes ---------------------------------------------------------------

const AGAINST_GRABBED =
  "against (?:a creature (?:it|they) (?:is|are|has|have) (?:Grabbing|Grabbed|grabbed)|the (?:grabbed|Grabbed) creature|the creature (?:it|they)(?:'s|’s| is| are) grabbing)";

const GRAB_STRIKE = new RegExp(
  `\\bmakes? (?:a|an|one) ${LIMB} Strike(?: with a \\+(?<bonus>\\d+) circumstance bonus(?: to the attack roll)?)? ${AGAINST_GRABBED}\\.$`,
);
const GRAB_STRIKE_NO_TARGET = new RegExp(
  `\\b(?:makes? (?:a|an|one) ${LIMB} Strike(?: with a \\+(?<bonus>\\d+) circumstance bonus(?: to the attack roll)?)?|with (?:a|an|its|their) ${LIMB.replace("limb", "limb2")} Strike)\\.$`,
);
const GRAB_MULTI = new RegExp(`\\bmakes? (?<count>two|three|four) ${LIMB} Strikes ${AGAINST_GRABBED}\\.$`);
const HIT_PRONE =
  /^If (?:the attack|it|the Strike|this Strike) hits, (?:it also knocks the (?:creature|target) Prone|(?:that|the) (?:creature|target) is knocked Prone)\.$/;
const HIT_SAVE = /^If (?:the attack|it|the Strike|this Strike) hits, the target must attempt a (?<check>@Check\[[^\]]+\]) save\.$/;
const MISS_RELEASE = /^If (?:it|the attack|this Strike|the Strike) fails, (?:it|they|the [\w'’ -]+?) releases? the (?:creature|target)\.$/;
const SAME_MAP_SENTENCES = [
  /^Both (?:attacks )?count toward (?:its|their|the [\w'’ -]+?['’]s?) multiple attack penalty, but the penalty (?:increases only after both attacks are made|doesn't increase until after both attacks)\.$/,
];
const NORMAL_MAP_SENTENCES = [
  /^Each attack counts toward (?:its|their|the [\w'’ -]+?['’]s?) multiple attack penalty, and the multiple attack penalty increases with each attack\.$/,
];

/** Gnaw-style degree blocks after a hit: #915's degree grammar, plus PF2e's
 * convention that an unlisted critical failure uses the failure effect and
 * an unlisted critical success the success effect. */
function parseSaveDegrees(blocks) {
  if (blocks.duplicateDegree) return null;
  const raw = { ...blocks.degrees };
  if (raw.success === undefined || raw.failure === undefined) return null;
  const degrees = {};
  for (const key of ["criticalSuccess", "success", "failure", "criticalFailure"]) {
    if (raw[key] === undefined) {
      degrees[key] = { none: false, asFailure: false, conditions: [], immuneSeconds: null, asKey: key === "criticalFailure" ? "failure" : "success" };
      continue;
    }
    const parsed = parseDegreeBlock(raw[key]);
    if (!parsed) return null;
    degrees[key] = parsed;
  }
  for (const key of ["criticalSuccess", "criticalFailure"]) {
    if (degrees[key].asKey) degrees[key] = degrees[degrees[key].asKey];
  }
  // #935: an "As <degree>" block is a reference the degree grammar returns
  // unresolved.
  const resolved = resolveDegreeReferences(degrees);
  return Object.values(resolved).every(Boolean) ? resolved : null;
}

function parseStrikeAgainstGrabbed(sentences, blocks, requirement) {
  // Leading flavor ("The crocodile tucks its legs and rolls rapidly ...").
  let lead = 0;
  while (lead < sentences.length - 1 && isFlavor(sentences[lead])) lead++;
  if (lead >= sentences.length) return null;
  const [first, ...rest] = sentences.slice(lead);
  let limb;
  let count = 1;
  let attackBonus = 0;
  let m = consume(first, GRAB_STRIKE);
  if (m) {
    limb = m.groups.limb;
    attackBonus = Number(m.groups.bonus ?? 0);
  } else if ((m = consume(first, GRAB_MULTI))) {
    limb = m.groups.limb;
    count = NUMBER_WORDS[m.groups.count];
  } else if (requirement?.grabbed && (m = consume(first, GRAB_STRIKE_NO_TARGET))) {
    // The Requirements block names the grabbed creature ("has a creature
    // Grabbed with its talons"); the Strike is against "the creature".
    limb = m.groups.limb ?? m.groups.limb2;
    attackBonus = Number(m.groups.bonus ?? 0);
  } else {
    return null;
  }
  const onHit = [];
  let onMissRelease = false;
  let mapRule = count > 1 ? null : "normal";
  for (const sentence of rest) {
    if (HIT_PRONE.test(sentence) && count === 1) {
      onHit.push({ kind: "condition", slug: "prone" });
      continue;
    }
    const save = HIT_SAVE.exec(sentence);
    if (save && count === 1) {
      const check = parseCheck(/@Check\[([^\]]+)\]/.exec(save.groups.check)[1]);
      if (!["fortitude", "reflex", "will"].includes(check.type) || check.dc == null || check.basic || check.other) return null;
      const degrees = parseSaveDegrees(blocks);
      if (!degrees) return null;
      onHit.push({ kind: "save", save: check.type, dc: check.dc, traits: check.traits, rollOptions: check.options, degrees });
      continue;
    }
    if (MISS_RELEASE.test(sentence) && count === 1) {
      onMissRelease = true;
      continue;
    }
    if (count > 1 && !mapRule && SAME_MAP_SENTENCES.some((re) => re.test(sentence))) {
      mapRule = "same";
      continue;
    }
    if (count > 1 && !mapRule && NORMAL_MAP_SENTENCES.some((re) => re.test(sentence))) {
      mapRule = "normal";
      continue;
    }
    if (isFlavor(sentence)) continue;
    return null;
  }
  if (!mapRule) return null;
  // Degree blocks are only consumed by a save rider.
  if (Object.keys(blocks.degrees).length && !onHit.some((h) => h.kind === "save")) return null;
  return { limb: limbName(limb), count, mapRule, attackBonus, onHit, onMissRelease };
}

const CONSTRICT_LIMB_SENTENCES = [
  /^\(?Grabbed by (?<limb>[a-z]+?) only\)?\.?$/,
  /^(?:The |the )?[\w'’ -]+? can only Constrict creatures Grabbed by (?:its|their) (?<limb>[a-z]+)\.$/,
];

function parseConstrictLike(sentences, blocks) {
  const text = sentences.join(" ");
  const glossary = /GLOSSARY\((Constrict|GreaterConstrict)\)/.exec(text);
  if (!glossary) return null;
  const greater = glossary[1] === "GreaterConstrict";
  let grabLimb = null;
  let found = null;
  for (const sentence of sentences) {
    const s = sentence.replace(/GLOSSARY\(\w+\)/g, " ").trim();
    if (!s) continue;
    const roll = new RegExp(
      `^(?<damage>${DAMAGE_TOKEN})(?: damage)?,? (?<check>@Check\\[[^\\]]+\\])(?: save)?(?: \\((?<limbClause>Grabbed by [a-z]+? only)\\))?\\.?(?: (?<rest>.+))?$`,
    ).exec(s);
    if (roll && !found) {
      if (roll.groups.rest) {
        const limb = CONSTRICT_LIMB_SENTENCES.map((re) => re.exec(roll.groups.rest)).find(Boolean);
        if (!limb) return null;
        grabLimb = limb.groups.limb;
      }
      if (roll.groups.limbClause) grabLimb = /Grabbed by ([a-z]+?) only/.exec(roll.groups.limbClause)[1];
      found = roll;
      continue;
    }
    const limb = CONSTRICT_LIMB_SENTENCES.map((re) => re.exec(s)).find(Boolean);
    if (limb && !grabLimb) {
      grabLimb = limb.groups.limb;
      continue;
    }
    return null;
  }
  if (!found) return null;
  const damage = damageFormula(found.groups.damage);
  const check = parseCheck(/@Check\[([^\]]+)\]/.exec(found.groups.check)[1]);
  if (!damage || check.type !== "fortitude" || !check.basic || check.dc == null || check.other) return null;
  if (Object.keys(blocks.degrees).length) return null;
  // Greater Constrict's glossary: a failed save knocks the creature
  // Unconscious; a success makes it immune to that for 1 minute.
  const degrees = greater
    ? {
        criticalSuccess: { none: true, conditions: [], immuneSeconds: 60 },
        success: { none: true, conditions: [], immuneSeconds: 60 },
        failure: { none: false, conditions: [{ slug: "unconscious", value: null, durationSeconds: null }], immuneSeconds: null },
        criticalFailure: { none: false, conditions: [{ slug: "unconscious", value: null, durationSeconds: null }], immuneSeconds: null },
      }
    : null;
  return {
    params: { damage, save: "fortitude", dc: check.dc, traits: check.traits, rollOptions: check.options, degrees, greater },
    grabLimb: grabLimb ? limbName(grabLimb.replace(/s$/, "")) : null,
  };
}

const EXTENDED_REACH = new RegExp(`\\bmak(?:es|ing) (?:a|an) ${LIMB} Strike with an extended reach of (?<feet>\\d+) feet\\.$`);

function parseExtendedReachStrike(sentences) {
  if (sentences.length !== 1) return null;
  const m = consume(sentences[0], EXTENDED_REACH);
  if (!m) return null;
  return { limb: limbName(m.groups.limb), reachFeet: Number(m.groups.feet) };
}

const TWO_ADJACENT = new RegExp(
  `\\bmakes? two Strikes with (?:its|their) ${LIMB} against two adjacent foes, both of whom are within (?:its|their) reach\\.$`,
);
const TWO_DIFFERENT = new RegExp(`\\bmakes? two ${LIMB} Strikes against different targets within (?:its|their) reach\\.$`);
const SAME_MAP_BOTH =
  /^Both attacks count toward (?:its|their|the [\w'’ -]+?['’]s?) multiple attack penalty, but the penalty doesn't increase until after both attacks\.$/;

function parseTwoTargetStrikes(sentences) {
  if (!sentences.length) return null;
  let m = consume(sentences[0], TWO_ADJACENT);
  if (m) {
    if (sentences.length !== 2 || !SAME_MAP_BOTH.test(sentences[1])) return null;
    return { limb: limbName(m.groups.limb), mapRule: "same", adjacentTargets: true };
  }
  m = consume(sentences[0], TWO_DIFFERENT);
  if (m && sentences.length === 1) return { limb: limbName(m.groups.limb), mapRule: "normal", adjacentTargets: false };
  return null;
}

const SINGLE_ROLL = new RegExp(
  `\\bmakes? a (?:single )?(?:(?<melee>melee)|${LIMB}) Strike and compares the attack roll(?: result)? to the ACs? of up to (?<count>two|three|four) foes` +
    `(?:,? each of whom must be within (?:its|their|the [\\w'’ -]+?['’]s?|its tail['’]s) (?:melee )?reach and adjacent to (?<adj>each other|at least one other target)| within (?:its|their) reach)\\.$`,
);
const DAMAGE_ONCE = /^(?:It )?[Rr]olls? damage only once and appl(?:y|ies) it to each creature hit\.$/;
const COUNTS_AS = /^(?:This|It|A [A-Z][\w'’ -]*) counts as (?<count>two|three|four) attacks for (?:its|their|the [\w'’ -]+?['’]s?) multiple attack penalty\.$/;

function parseSingleRollMultiAC(sentences) {
  if (!sentences.length) return null;
  // A flavor sentence may lead ("The draugr powers their hate ...").
  let index = 0;
  let m = null;
  for (; index < sentences.length; index++) {
    m = consume(sentences[index], SINGLE_ROLL);
    if (m) break;
    if (!isFlavor(sentences[index])) return null;
  }
  if (!m) return null;
  let damageOnce = false;
  let mapCount = null;
  for (const sentence of sentences.slice(index + 1)) {
    if (DAMAGE_ONCE.test(sentence)) {
      damageOnce = true;
      continue;
    }
    const counts = COUNTS_AS.exec(sentence);
    if (counts && mapCount == null) {
      mapCount = NUMBER_WORDS[counts.groups.count];
      continue;
    }
    return null;
  }
  if (mapCount == null) return null;
  const adjacency = m.groups.adj === "each other" ? "eachOther" : m.groups.adj ? "atLeastOne" : "none";
  return {
    limb: m.groups.melee ? null : limbName(m.groups.limb),
    maxTargets: NUMBER_WORDS[m.groups.count],
    mapCount,
    adjacency,
    damageOnce,
  };
}

const SAME_TARGET = new RegExp(`\\bmakes? (?<count>two|three) ${LIMB} Strikes against the same target\\.$`);
const BOTH_HIT = /^If (?:both|all) (?:hit|Strikes hit|attacks hit), (?<rest>.+)\.$/;

function parseBundleWithBothHitRider(sentences, blocks) {
  if (sentences.length !== 2) return null;
  const m = consume(sentences[0], SAME_TARGET);
  const hit = BOTH_HIT.exec(sentences[1]);
  if (!m || !hit) return null;
  let rest = hit.groups.rest;
  let durationSeconds = null;
  const until = /,? until the end of (?:its|the target's) next turn$/.exec(rest);
  if (until) {
    durationSeconds = "untilNextTurn";
    rest = rest.slice(0, until.index);
  }
  let extraDamage = null;
  const conditions = [];
  let speedPenalty = false;
  for (const clause of rest.split(/,\s*(?:and\s+)?|\s+and\s+(?=the )/)) {
    const c = clause.trim();
    if (!c) continue;
    const dmg = new RegExp(`^the attack deals an additional (?<damage>${DAMAGE_TOKEN}) damage$`).exec(c);
    if (dmg && !extraDamage) {
      extraDamage = damageFormula(dmg.groups.damage);
      if (!extraDamage) return null;
      continue;
    }
    const cond = /^the target is (?<name>[A-Za-z -]+?)$/.exec(c);
    if (cond) {
      const slug = cond.groups.name.toLowerCase().replace(/\s+/g, "-");
      if (!KNOWN_CONDITION_SLUGS.includes(slug)) return null;
      conditions.push({ slug, value: null });
      continue;
    }
    if (/^the target takes a -\s?\d+-foot status penalty to all Speeds$/.test(c)) {
      speedPenalty = true;
      continue;
    }
    return null;
  }
  // The Speed penalty is the linked bestiary effect; without it the rider
  // is only half-modeled.
  const effectName = blocks.effectLinks[0] ?? null;
  if (speedPenalty && !effectName) return null;
  if (!extraDamage && !conditions.length && !effectName) return null;
  return {
    limb: limbName(m.groups.limb),
    count: NUMBER_WORDS[m.groups.count],
    extraDamage,
    conditions: conditions.map((c) => ({ ...c, durationSeconds })),
    effectName,
  };
}

const NET_STRIKE = /\bmakes? a ranged Strike \(with a ROLL\((?<mod>\d+)\)(?: attack)? modifier\) against a (?<size>Tiny|Small|Medium|Large|Huge) or smaller creature within (?<feet>\d+) feet\.$/;
const NET_HIT =
  /^On a hit, the target is Off-Guard and takes a -\s?\d+-foot circumstance penalty to its Speeds\.$/;
const NET_CRIT = /^On a critical hit, the creature is (?:instead )?Restrained(?: instead)?\.$/;
const NET_ESCAPE = /^The DC to Escape the net is (?<dc>\d+)\.$/;
const NET_REMOVE = /^A creature adjacent to the target can Interact with the net to remove it(?: from the target)?\.$/;

function parseStrikeWithOnHit(sentences, blocks, requirement) {
  if (requirement?.item !== "net") return null;
  const effectName = blocks.effectLinks[0] ?? null;
  if (!effectName) return null;
  let strike = null;
  let hit = false;
  let crit = false;
  let escapeDc = null;
  for (const sentence of sentences) {
    const m = !strike ? consume(sentence, NET_STRIKE) : null;
    if (m) {
      strike = m;
      continue;
    }
    if (strike && NET_HIT.test(sentence)) {
      hit = true;
      continue;
    }
    if (strike && NET_CRIT.test(sentence)) {
      crit = true;
      continue;
    }
    const esc = NET_ESCAPE.exec(sentence);
    if (esc) {
      escapeDc = Number(esc.groups.dc);
      continue;
    }
    if (NET_REMOVE.test(sentence)) continue;
    if (!strike && isFlavor(sentence)) continue;
    return null;
  }
  if (!strike || !hit || !crit) return null;
  return {
    fixedModifier: Number(strike.groups.mod),
    rangeFeet: Number(strike.groups.feet),
    sizeCap: SIZE_WORDS[strike.groups.size.toLowerCase()],
    effectName,
    escapeDc,
  };
}

function parseRend(sentences) {
  const text = sentences.join(" ").trim();
  const m = /^(?<limb>[A-Za-z][A-Za-z'’ -]*?)\.? GLOSSARY\(Rend\)$/.exec(text);
  if (!m) return null;
  return { limb: limbName(m.groups.limb) };
}

/** `parseStrikePlusAbility(item)` -- see the file comment. */
export function parseStrikePlusAbility(item) {
  try {
    return parseUnsafe(item);
  } catch {
    return null;
  }
}

function parseUnsafe(item) {
  if (item?.type !== undefined && item.type !== "action") return null;
  const actionType = item?.system?.actionType?.value;
  if (actionType !== undefined && actionType !== "action") return null;
  const cost = Number(item?.system?.actions?.value ?? 1);
  if (!(cost >= 1 && cost <= 3)) return null;
  const raw = item?.system?.description?.value;
  if (!raw || typeof raw !== "string") return null;

  const blocks = splitBlocks(raw);
  if (blocks.trigger != null) return null;
  // A Frequency paragraph must be the structured `system.frequency` too.
  if (blocks.frequency != null && !item.system?.frequency) return null;
  const requirement = parseRequirement(blocks.requirements);
  if (!requirement) return null;
  const sentences = splitSentences(plainText(blocks.effectHtml));
  const frequency = item.system?.frequency ?? null;
  const base = (shape, params, req = requirement) => ({ shape, cost, frequency, requirement: req, params });

  const rend = parseRend(sentences);
  if (rend) return requirement.grabbed || requirement.item ? null : base("rend", rend);

  const constrict = parseConstrictLike(sentences, blocks);
  if (constrict) {
    if (requirement.item) return null;
    return base("constrictLike", constrict.params, { grabbed: true, grabLimb: constrict.grabLimb ?? requirement.grabLimb, item: null });
  }
  if (sentences.some((s) => /GLOSSARY\(/.test(s))) return null;

  const grab = parseStrikeAgainstGrabbed(sentences, blocks, requirement);
  if (grab) {
    if (requirement.item) return null;
    return base("strikeAgainstGrabbed", grab, { ...requirement, grabbed: true });
  }
  if (Object.keys(blocks.degrees).length) return null;

  if (requirement.item) {
    const net = parseStrikeWithOnHit(sentences, blocks, requirement);
    return net ? base("strikeWithOnHit", net) : null;
  }
  if (requirement.grabbed) return null;
  if (blocks.effectLinks.length > 1) return null;

  const reach = parseExtendedReachStrike(sentences);
  if (reach) return blocks.effectLinks.length ? null : base("extendedReachStrike", reach);
  const two = parseTwoTargetStrikes(sentences);
  if (two) return blocks.effectLinks.length ? null : base("twoTargetStrikes", two);
  const multi = parseSingleRollMultiAC(sentences);
  if (multi) return blocks.effectLinks.length ? null : base("singleRollMultiAC", multi);
  const bundle = parseBundleWithBothHitRider(sentences, blocks);
  if (bundle) return base("bundleWithBothHitRider", bundle);
  return null;
}

const SIZE_LABEL = Object.freeze({ tiny: "Tiny", sm: "Small", med: "Medium", lg: "Large", huge: "Huge", grg: "Gargantuan" });

function degreeSummary(degrees) {
  const label = (d) => {
    if (!d || d.none) return "no effect";
    return d.conditions.map((c) => (c.value != null ? `${c.slug} ${c.value}` : c.slug)).join(", ") || "no effect";
  };
  return `success: ${label(degrees.success)}; failure: ${label(degrees.failure)}`;
}

/** #933: the deterministic one-line description the reasoning model and the
 * GM card see for a parsed Strike-plus ability against `targetNames`. The
 * model never reads the ability's prose. */
export function describeStrikePlus(descriptor, targetNames = []) {
  const p = descriptor?.params ?? {};
  const who = targetNames.length ? targetNames.join(" and ") : "the target";
  switch (descriptor?.shape) {
    case "strikeAgainstGrabbed": {
      const strikes = p.count > 1 ? `${p.count} ${p.limb} Strikes` : `${p.limb} Strike`;
      const parts = [`${strikes} on grabbed ${who}`];
      if (p.attackBonus) parts.push(`+${p.attackBonus} to hit`);
      if (p.count > 1) parts.push(p.mapRule === "same" ? `MAP rises after all ${p.count}` : "normal MAP");
      for (const h of p.onHit ?? []) {
        if (h.kind === "condition") parts.push(`on hit: ${h.slug}`);
        else parts.push(`on hit: ${h.save} DC ${h.dc} (${degreeSummary(h.degrees)})`);
      }
      if (p.onMissRelease) parts.push("on a miss it releases the grab");
      return parts.join("; ");
    }
    case "constrictLike":
      return `${p.damage} to grabbed ${who}, basic Fortitude DC ${p.dc}${p.greater ? "; failure: unconscious" : ""}; not an attack`;
    case "extendedReachStrike":
      return `${p.limb} Strike on ${who} with ${p.reachFeet}-ft reach`;
    case "twoTargetStrikes":
      return `${p.limb} Strike on each of ${who}${p.mapRule === "same" ? "; both at the current MAP, which then rises by 2" : "; normal MAP"}`;
    case "singleRollMultiAC":
      return `one ${p.limb ?? "melee"} Strike roll against the AC of each of ${who}; counts as ${p.mapCount} attacks for MAP`;
    case "bundleWithBothHitRider": {
      const rider = [p.extraDamage ? `+${p.extraDamage}` : null, ...(p.conditions ?? []).map((c) => c.slug), p.effectName].filter(Boolean);
      return `${p.count} ${p.limb} Strikes on ${who}; if all hit: ${rider.join(", ")}`;
    }
    case "strikeWithOnHit":
      return `ranged net Strike (+${p.fixedModifier}) on ${who} within ${p.rangeFeet} ft (${SIZE_LABEL[p.sizeCap] ?? p.sizeCap} or smaller); hit: off-guard and -10 ft Speed; critical: restrained`;
    case "rend":
      return `${p.limb} damage again to ${who} (hit by two ${p.limb} Strikes in a row); not an attack`;
    default:
      return "";
  }
}
