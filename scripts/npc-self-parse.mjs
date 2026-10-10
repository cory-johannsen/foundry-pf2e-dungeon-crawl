/**
 * #934: pure recognition/parsing for NPC self-buff and self-heal abilities
 * (Form a Phalanx, Reef Armor, Thesis Shield, Bob, Feed on Fear, Self-Repair,
 * ...) -- no Foundry API surface at all, mirroring npc-ability-parse.mjs's
 * own boundary (the Foundry-touching half -- effect lookup, requirement
 * evaluation, readiness -- lives in dungeon-combat.mjs's
 * computeNpcSelfVocabulary).
 *
 * Three families only, chosen all-or-nothing:
 *  - selfEffectAction: `system.selfEffect.uuid` is set (the PF2e system's own
 *    "apply this effect to yourself" marker).
 *  - linkedEffectSelf: no selfEffect, but the prose links exactly one effect
 *    item (bestiary/other/spell/feat/equipment/campaign effects) and names no
 *    other creature at all.
 *  - selfHeal: exactly one `@Damage[<formula>[healing]]` enricher, a self
 *    healing verb, and nothing else this grammar doesn't model.
 *
 * Runtime text is the COMPILED pack text: every @UUID is id-form with a
 * `{Label}` (`@UUID[Compendium.pf2e.bestiary-effects.Item.l62iAFL3EO7wSsLL]{Effect: Form a Phalanx}`),
 * never the name-form the pf2e source repo uses -- so a linked effect's uuid
 * is carried through verbatim, never rebuilt from its label.
 *
 * Everything else -- allies or any other creature, corpses, summons, zones,
 * transformations (the polymorph trait), triggers, inline saves/damage/
 * templates, a requirement outside the closed predicate set below, any
 * restriction or conditional rider -- is `null`. The design spec's `inForm`
 * predicate is deliberately absent: no NPC "Change Shape" leaves readable
 * form state anywhere (see the #934 plan's Investigation findings).
 */

import { KNOWN_CONDITION_SLUGS } from "./npc-ability-parse.mjs";

const CONDITION_SET = new Set(KNOWN_CONDITION_SLUGS);

/** Effect-item compendia a prose link may point at for linkedEffectSelf. */
const EFFECT_PACK_RE = /^Compendium\.pf2e\.(?:bestiary-effects|other-effects|spell-effects|feat-effects|equipment-effects|campaign-effects)\.Item\./;
const CONDITION_PACK_RE = /^Compendium\.pf2e\.conditionitems\.Item\./;

/** A prose-linked effect must be one authored for monsters (bestiary-effects)
 * or a generic one (Raise a Shield's equipment effect). A character effect
 * linked from a stat block (the ragewight's Rage -> the barbarian's
 * Effect: Rage) carries the character's own formulas, not the monster's
 * numbers, so it doesn't model the ability. */
const NPC_LINKED_EFFECT_RE = /^Compendium\.pf2e\.(?:bestiary-effects|equipment-effects|other-effects)\.Item\./;

const UUID_LINK_RE = /@UUID\[([^\]]+)\](?:\{([^}]*)\})?/g;

function stripHtml(html) {
  return String(html)
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Human-readable plain text: links/enrichers become their label (or, for
 * an unlabelled link, the last uuid segment). */
function renderPlain(html) {
  return stripHtml(
    String(html)
      .replace(UUID_LINK_RE, (_m, uuid, label) => label ?? uuid.split(".").pop())
      .replace(/@\w+\[[^\]]*\]\{([^}]*)\}/g, "$1"),
  );
}

function slugify(text) {
  return String(text).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
}

const LABEL_RE = /<p>\s*<strong>\s*(Frequency|Requirements?|Trigger|Effect|Cost|Special|Note)\s*<\/strong>([\s\S]*?)<\/p>/gi;

/**
 * Splits raw (enriched) HTML into its labelled `<p><strong>Label</strong>
 * ...</p>` blocks. Every byte outside a matched label span (a trailing
 * unlabelled `<p>`, an item with no labels at all) is collected into
 * `effect`, so nothing is ever silently dropped.
 */
function splitAbilityBlocks(html) {
  const blocks = { frequency: null, requirements: null, trigger: null, other: false, effect: "" };
  const spans = [];
  let match;
  LABEL_RE.lastIndex = 0;
  while ((match = LABEL_RE.exec(html))) {
    spans.push([match.index, match.index + match[0].length]);
    const key = match[1].toLowerCase();
    if (key.startsWith("requirement")) blocks.requirements = `${blocks.requirements ?? ""} ${match[2]}`;
    else if (key === "frequency") blocks.frequency = match[2];
    else if (key === "trigger") blocks.trigger = match[2];
    else if (key === "effect") blocks.effect += ` ${match[2]}`;
    else blocks.other = true;
  }
  let cursor = 0;
  for (const [start, end] of spans) {
    blocks.effect += ` ${html.slice(cursor, start)}`;
    cursor = end;
  }
  blocks.effect += ` ${html.slice(cursor)}`;
  return blocks;
}

/** Corpse/kill wording anywhere (Blood Soak's corpse requirement is plain
 * Effect prose, no Requirements label) -- corpse tracking is #982. */
const CORPSE_OR_KILL_RE = /\b(?:corpses?|dead|died|dies|slain|killed|kills|helped kill)\b/i;

/** A requirement clause additionally may not name a destroyed creature
 * (Augrael's "undead creature that was destroyed within the last hour"). */
const DESTROYED_RE = /\bdestroy(?:ed|s)?\b/i;

/** Any other creature named in the text -- the slice is self-only (#981
 * covers allies; targeted marks are #922's shape, not this one). */
const OTHER_CREATURE_RE = /\b(?:creatures?|enem(?:y|ies)|foes?|all(?:y|ies)|targets?|victims?|prey|another|willing|anyone|everyone|each|commands?|earshot)\b/i;

/** Wording this grammar never models: a further action or check inside the
 * ability, a restriction, a conditional or repeating rider, an area, a
 * spent resource, or a lost ability. */
const UNMODELED_RE = new RegExp(
  [
    String.raw`\battempts?\b`,
    String.raw`\bmakes?\b[^.]*\bStrikes?\b`,
    String.raw`\bStrikes,`,
    String.raw`\bStrikes? (?:once|twice|and|then)\b`,
    String.raw`\bhas a reach of\b`,
    String.raw`\b(?:Interacts?|Stride|Strides|Step|Steps|Demoralize|Seek|Bucks|Releases?|Casts?|Casting|teleports?|Sustains?)\b`,
    String.raw`\bif\b`,
    String.raw`\bunless\b`,
    String.raw`\binstead\b`,
    String.raw`\beach time\b`,
    String.raw`\bevery\b`,
    String.raw`\bagain\b`,
    String.raw`\bcan(?:'|’)?t\b`,
    String.raw`\bcannot\b`,
    String.raw`\bonly\b`,
    String.raw`\bloses?\b`,
    String.raw`\bpermanently\b`,
    String.raw`\buntil [^.]*\b(?:takes?|uses?|moves?|spends?|leaves?)\b`,
    String.raw`\bwithin \d+ feet\b`,
    String.raw`\baura\b`,
    String.raw`\bemanation\b`,
    String.raw`\bthe area\b`,
    String.raw`\badjacent\b`,
    String.raw`\b\d+ (?:cp|sp|gp|pp)\b`,
    String.raw`\bcounteract\b`,
    String.raw`\btemporary (?:Hit Points|HP)\b[^.]*\bexcess\b|\bexcess\b`,
    String.raw`\bfor each\b`,
    String.raw`\bchoose|chooses|choice|selects?\b`,
    String.raw`\broll\b`,
  ].join("|"),
  "i",
);

/** "<subject> (can't|cannot) use <Name> again for [[/gmr <F> #Recharge ...]]{...}"
 * -- the ability's own recharge (Vine Splint) or, under another name, a
 * different ability's (the voidglutton's Feed on Fear -> Consume Light). */
const RECHARGE_RIDER_RE = /(?:^|[.!]\s*)[^.]*?\b(?:can(?:'|’)?t|cannot) use ([A-Z][A-Za-z'’ -]+?) again for \[\[\/gmr (\d+d\d+(?:\s*[+-]\s*\d+)?) #Recharge[^\]]*\]\](?:\{[^}]*\})?[^.]*\./;

function extractRechargeRider(html, itemName) {
  const match = RECHARGE_RIDER_RE.exec(html);
  if (!match) return { rechargeFormula: null, crossRecharge: null, remaining: html };
  const name = match[1].trim();
  const formula = match[2].replace(/\s+/g, "");
  const remaining = html.replace(match[0], match[0].startsWith(".") ? ". " : " ");
  if (slugify(name) === slugify(itemName ?? "")) return { rechargeFormula: formula, crossRecharge: null, remaining };
  return { rechargeFormula: null, crossRecharge: { name, formula }, remaining };
}

/** The will-o'-wisp family's own riders, recognized so they don't count as
 * unmodeled text: ", and if it has Gone Dark, its glow reignites" / "and
 * its Glow reignites if it had been extinguished" (this module never has an
 * AI creature Go Dark, so the clause never applies -- reported to the GM by
 * the executor all the same), and "<X> can take this action only once per
 * round." restating a structured once-per-round frequency. */
const GLOW_RIDER_RE = /,?\s*(?:and )?(?:if (?:it|they)(?: has| have|'ve|’ve) Gone Dark, (?:its|their) glow reignites|(?:its|their) Glow reignites if (?:it|they) (?:had|has|have) been extinguished)/gi;
const ONCE_PER_ROUND_RE = /[^.]*\bcan take this action only once per round\./gi;

/** One requirement clause -> a Predicate, or `null` when it is outside the
 * closed set (handFree, wearing/wielding, enemyWithin, hasCondition/
 * notHasCondition). There is deliberately no `inForm`. Exported for the
 * requirement tests. */
export function parseRequirementClause(clause) {
  const text = String(clause).trim().replace(/\.$/, "");
  if (!text) return null;
  if (CORPSE_OR_KILL_RE.test(text) || DESTROYED_RE.test(text)) return null;
  if (/\bhas (?:a |one |its )?hand free\b/i.test(text)) return { type: "handFree" };
  const wearing = /\b(?:is )?wearing (?:a |an |its |their )?([a-z0-9'’ -]+?)\s*$/i.exec(text);
  if (wearing) return { type: "wearing", name: wearing[1].trim().toLowerCase() };
  const wielding = /\b(?:is )?(?:wielding|holding) (?:a |an |its |their )?([a-z0-9'’ -]+?)\s*$/i.exec(text);
  if (wielding) return { type: "wielding", name: wielding[1].trim().toLowerCase() };
  const enemy = parseEnemyWithinClause(text);
  if (enemy !== undefined) return enemy;
  const not = /^(?:the [a-z'’ -]+?|it|they|he|she|you)\s+(?:is not|isn(?:'|’)t|are not|aren(?:'|’)t)\s+([a-z-]+)$/i.exec(text);
  if (not) {
    const slug = slugify(not[1]);
    return CONDITION_SET.has(slug) ? { type: "notHasCondition", slug } : null;
  }
  const is = /^(?:the [a-z'’ -]+?|it|they|he|she|you)\s+(?:is|are)\s+([a-z-]+)$/i.exec(text);
  if (is) {
    const slug = slugify(is[1]);
    return CONDITION_SET.has(slug) ? { type: "hasCondition", slug } : null;
  }
  return null;
}

/**
 * "An enemy within 15 feet is under a fear effect or Dying", "An enemy is
 * under a fear effect or Dying within 15 feet of the will-o'-wisp", "An
 * enemy is affected by a fear effect or has the Frightened or Dying
 * condition, and is within 25 feet of the voidglutton" -- enemy, range
 * (either order) and a disjunction of states: a real condition slug or the
 * reserved `fear-effect`. `undefined` when the clause isn't about an enemy
 * at all; `null` when it is but doesn't parse completely.
 */
function parseEnemyWithinClause(text) {
  if (!/^an enemy\b/i.test(text)) return undefined;
  const range = /\bwithin (\d+) feet\b(?: of (?:the [a-z'’ -]+?|it|them|him|her)(?=\s*(?:,|$)))?/i.exec(text);
  if (!range) return null;
  let rest = text
    .replace(/^an enemy\b/i, " ")
    .replace(range[0], " ")
    .replace(/,?\s*and is\s*$/i, " ")
    .replace(/,?\s*and is\b/i, " ");
  const conditions = [];
  rest = rest.replace(/\b(?:is |being )?(?:under|affected by) a fear effect\b/i, () => {
    conditions.push("fear-effect");
    return " ";
  });
  rest = rest.replace(/\b(?:has the |is )?([A-Za-z-]+)(?= condition\b| or\b|\s*$|,)/g, (whole, word) => {
    const slug = slugify(word);
    if (!CONDITION_SET.has(slug)) return whole;
    conditions.push(slug);
    return " ";
  });
  const leftover = rest.replace(/\b(?:is|or|condition|has|the|being)\b/gi, " ").replace(/[,.\s]+/g, "");
  if (leftover || !conditions.length) return null;
  return { type: "enemyWithin", feet: Number(range[1]), conditions };
}

/** Splits a Requirements block on "and"/commas and maps every clause; one
 * unparsed clause nulls the whole list. An absent block is `[]`. */
function parseRequirements(requirementsHtml) {
  if (requirementsHtml == null) return [];
  const text = renderPlain(requirementsHtml).replace(/\.\s*$/, "");
  if (!text) return [];
  // An enemy clause carries its own "and is within" -- parse it whole.
  if (/^an enemy\b/i.test(text)) {
    const predicate = parseRequirementClause(text);
    return predicate ? [predicate] : null;
  }
  const clauses = text.split(/,\s*|\s+and\s+/i);
  const subject = /^(the [a-z'’ -]+?|it|they|he|she|you)\s+(?=is|are|has|have|isn|aren|wear|wield|hold)/i.exec(clauses[0])?.[1];
  const predicates = [];
  for (const raw of clauses) {
    // "The dero is wearing a toolkit and has a hand free": the second
    // clause inherits the first's subject.
    const clause = subject && !/^(?:the |it\b|they\b|he\b|she\b|you\b|an enemy\b)/i.test(raw) ? `${subject} ${raw}` : raw;
    const predicate = parseRequirementClause(clause);
    if (!predicate) return null;
    predicates.push(predicate);
  }
  return predicates;
}

function actionCost(item) {
  const actionType = item.system?.actionType?.value;
  if (actionType === "free") return 0;
  if (actionType !== "action") return null;
  const cost = item.system?.actions?.value;
  return typeof cost === "number" && cost >= 1 && cost <= 3 ? cost : null;
}

/** Every @UUID link in `html`, classified. */
function classifyLinks(html) {
  const effects = [];
  const conditions = [];
  const others = [];
  for (const [, uuid, label] of String(html).matchAll(UUID_LINK_RE)) {
    if (EFFECT_PACK_RE.test(uuid)) effects.push({ uuid, label: label ?? null });
    else if (CONDITION_PACK_RE.test(uuid)) conditions.push({ uuid, label: label ?? null });
    else others.push({ uuid, label: label ?? null });
  }
  return { effects, conditions, others };
}

/** Condition names that are also everyday adjectives ("its broken
 * branches", "a hidden blade") count only when capitalized, the way the
 * compiled text writes a condition (a link's label, or a bare "Broken"). */
const ADJECTIVE_CONDITIONS = new Set(["broken", "hidden", "controlled"]);

/** Known condition names mentioned in plain text (linked or bare). */
function mentionedConditions(plain) {
  return KNOWN_CONDITION_SLUGS.filter((slug) => {
    const word = slug.replace("-", "[- ]");
    if (ADJECTIVE_CONDITIONS.has(slug)) return new RegExp(`\\b${word[0].toUpperCase()}${word.slice(1)}\\b`).test(plain);
    return new RegExp(`\\b${word}\\b`, "i").test(plain);
  });
}

/** The plain text an effect family's screen runs on: the effect prose minus
 * its own effect link(s) (the trailing "Effect: X" paragraph many bestiary
 * entries carry). */
function effectProsePlain(effectHtml) {
  return renderPlain(String(effectHtml).replace(UUID_LINK_RE, (whole, uuid) => (EFFECT_PACK_RE.test(uuid) ? " " : whole)));
}

function failsEffectScreen(plain) {
  return OTHER_CREATURE_RE.test(plain) || UNMODELED_RE.test(plain) || CORPSE_OR_KILL_RE.test(plain);
}

const HEALING_DAMAGE_RE = /@Damage\[\(?([0-9d+\s-]+?)\)?\[healing\]\](?:\{[^}]*\})?/g;

/** Family 1: a structural selfEffect. Its prose is still screened -- a
 * selfEffect field doesn't mean the effect models the whole ability (Defensive
 * Assault's two Strikes, Swig's Interact, Hobgoblin Phalanx protecting allies).
 * Conditions the prose names are returned for the caller to check against
 * the effect's own GrantItem rules. */
function recognizeSelfEffectAction(item, blocks) {
  const uuid = item.system?.selfEffect?.uuid;
  if (!uuid) return null;
  const links = classifyLinks(blocks.effect);
  if (links.others.length) return null;
  if (links.effects.some((l) => l.uuid !== uuid)) return null;
  const plain = effectProsePlain(blocks.effect);
  if (failsEffectScreen(plain)) return null;
  return { family: "selfEffectAction", params: { effectUuid: uuid }, conditions: mentionedConditions(plain) };
}

/** Family 2: no selfEffect, exactly one linked effect item, no other
 * creature, nothing unmodeled. */
function recognizeLinkedEffectSelf(item, blocks) {
  if (item.system?.selfEffect?.uuid) return null;
  const links = classifyLinks(blocks.effect);
  if (links.effects.length !== 1 || links.others.length) return null;
  if (!NPC_LINKED_EFFECT_RE.test(links.effects[0].uuid)) return null;
  const plain = effectProsePlain(blocks.effect);
  if (failsEffectScreen(plain)) return null;
  return { family: "linkedEffectSelf", params: { effectUuid: links.effects[0].uuid }, conditions: mentionedConditions(plain) };
}

/** Family 3: exactly one plain-dice/flat healing enricher (no `@actor`
 * formula), a self healing verb, nothing unmodeled once the recognized
 * riders are consumed, and no effect link (a heal plus a buff is two
 * mechanics). */
function recognizeSelfHeal(item, blocks, rider) {
  if (item.system?.selfEffect?.uuid) return null;
  const html = rider.remaining.replace(GLOW_RIDER_RE, () => {
    rider.glow = true;
    return "";
  });
  const heals = [...html.matchAll(HEALING_DAMAGE_RE)];
  if (heals.length !== 1) return null;
  if ((html.match(/@Damage\[/g) ?? []).length !== 1) return null;
  const links = classifyLinks(html);
  if (links.effects.length || links.others.length || links.conditions.length) return null;
  const formula = heals[0][1].replace(/\s+/g, "");
  if (!/^(?:\d+d\d+|\d+)(?:[+-](?:\d+d\d+|\d+))*$/.test(formula)) return null;
  let plain = renderPlain(html.replace(HEALING_DAMAGE_RE, " HEAL "));
  if (item.system?.frequency?.per === "round" && item.system?.frequency?.max === 1) plain = plain.replace(ONCE_PER_ROUND_RE, " ");
  if (/\[\[/.test(plain) || /\[\[/.test(html)) return null;
  // The creature itself must be the one healed: "regains HEAL", "restores
  // HEAL ... to itself", "heals HEAL", "repairs itself, regaining HEAL".
  if (!/\b(?:regains?|regaining|recovers?|heals?|healing)\s+HEAL\b|\brestor(?:es|ing)\s+HEAL\s+(?:Hit Points|HP)\s+to (?:itself|themselves|themself|himself|herself)\b/i.test(plain)) return null;
  const screened = plain.replace(/\bto (?:itself|themselves|themself|himself|herself)\b/gi, " ");
  if (/\brestor(?:es|ing)\s+HEAL\s+(?:Hit Points|HP)\s+to\b/i.test(screened)) return null;
  if (failsEffectScreen(screened) && !/^\s*$/.test(screened)) {
    // The will-o'-wisp's own "feeds on the creature's terror" flavor names
    // the frightened enemy its Requirements already gate on.
    const withoutFeeds = screened.replace(/\bfeeds on the creature(?:'|’)s (?:terror|fear)\b/gi, " ");
    if (failsEffectScreen(withoutFeeds)) return null;
  }
  if (mentionedConditions(screened).length) return null;
  return { family: "selfHeal", params: { formula } };
}

/**
 * `null` or `{ family, cost, frequency, requirements, rechargeFormula,
 * crossRecharge, glowRider, conditions, params }` for an NPC action item.
 * `conditions` (effect families) are the condition slugs the prose names;
 * the caller only offers the ability when the effect itself grants each one.
 * Never throws.
 */
export function parseSelfAbility(item) {
  try {
    return parseUnsafe(item);
  } catch {
    return null;
  }
}

function parseUnsafe(item) {
  if (item?.type !== "action") return null;
  const cost = actionCost(item);
  if (cost === null) return null;
  const traits = item.system?.traits?.value ?? [];
  // Transformations (Crystalline Dust Form, Regain Anonymity) are #984.
  if (traits.includes("polymorph")) return null;
  const html = String(item.system?.description?.value ?? "");
  if (!html.trim()) return null;
  const blocks = splitAbilityBlocks(html);
  if (blocks.trigger != null || blocks.other) return null;
  // A Frequency paragraph must also be the structured system.frequency.
  if (blocks.frequency != null && !item.system?.frequency) return null;
  // Inline saves, area templates and non-healing damage belong to #915 and
  // the breath-weapon code; checks/counteracts are never modeled here.
  if (/@(?:Check|Template)\[/.test(html)) return null;
  if (/@Damage\[(?![^\]]*\[healing\]\])/.test(html)) return null;
  if (/\[\[\/act\b/.test(html)) return null;
  if (CORPSE_OR_KILL_RE.test(renderPlain(html))) return null;
  const requirements = parseRequirements(blocks.requirements);
  if (requirements === null) return null;

  const rider = { ...extractRechargeRider(blocks.effect, item.name), glow: false };
  const isHeal = /\[healing\]\]/.test(blocks.effect);
  let recognized = null;
  if (isHeal) {
    recognized = recognizeSelfHeal(item, blocks, rider);
  } else {
    if (rider.crossRecharge) return null;
    const effectBlocks = { ...blocks, effect: rider.remaining };
    if (/\[\[/.test(effectBlocks.effect)) return null;
    recognized = recognizeSelfEffectAction(item, effectBlocks) ?? recognizeLinkedEffectSelf(item, effectBlocks);
  }
  if (!recognized) return null;
  // A free heal with no limit would be offered again every decision.
  if (recognized.family === "selfHeal" && cost === 0 && !item.system?.frequency && !rider.rechargeFormula) return null;

  return {
    family: recognized.family,
    cost,
    frequency: item.system?.frequency ?? null,
    requirements,
    rechargeFormula: rider.rechargeFormula,
    crossRecharge: rider.crossRecharge,
    glowRider: rider.glow,
    conditions: recognized.conditions ?? [],
    params: recognized.params,
  };
}

/** #934: the deterministic one-line description the reasoning model sees
 * -- it never reads the ability's prose. Effect families get the linked
 * effect's own #914 summary when the caller has one; a heal states its
 * formula and the creature's current HP percentage. */
export function describeNpcSelfAbility(descriptor, { hpFraction = null, effectSummary = null, durationLabel = null } = {}) {
  if (descriptor.family === "selfHeal") {
    const frac = hpFraction != null ? ` (now at ${Math.round(hpFraction * 100)}% HP)` : "";
    return `heals itself ${descriptor.params.formula} HP${frac}`;
  }
  const what = effectSummary ? `self-buff: ${effectSummary}` : "self-buff (effect)";
  return durationLabel ? `${what}; lasts ${durationLabel}` : what;
}
