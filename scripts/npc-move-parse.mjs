/**
 * #932: pure recognition of NPC movement abilities (Gallop, Speed Surge,
 * Swift Leap, Swoop, Eagle Dive, Rush, Phase Jump, ...) -- no Foundry API
 * surface. An ability's description is matched against a small closed
 * grammar; every sentence must be recognized or the ability is not offered
 * at all (all-or-nothing, #915's convention): a movement this module only
 * partly understands is never executed with a wrong or incomplete effect.
 *
 * Grounded against the compendium text (pf2e 8.5.0 packs, every bestiary):
 *   - movement sentence: "<creature> Strides twice", "Strides or Flies
 *     twice", "Strides, Flies, or Swims twice", "jumps up to half its
 *     Speed", "Flies up to double its fly Speed in a straight line,
 *     descending at least 10 feet, and then makes a talon Strike", "Strides
 *     and makes a Strike at the end of that movement", "Flies up to its
 *     Speed and makes one beak or talon Strike at any point during that
 *     movement", "uses 2 move actions, each of which can be either Stride or
 *     Fly";
 *   - Speed-bonus sentence: "It has a +10-foot circumstance bonus to its
 *     Speed during these Strides", "During the Stride, it gains a +10-foot
 *     circumstance bonus to its Speed";
 *   - teleport sentence: "teleports up to 75 feet", "teleports into an
 *     unoccupied space it can see within 50 feet", "teleports up to 40 feet
 *     to a location it can see";
 *   - rider table: "This movement doesn't trigger reactions" (Swift Leap),
 *     Phase Jump's "If they are airborne ... do not fall" (elevation and
 *     falling are not modeled at all, so the clause changes nothing here),
 *     and a recharge sentence ("It can't use Jaunt again for 1d4 rounds").
 * Anything else -- Pounce's hiding clause, charge damage riders, pushes,
 * multi-target Strikes, Requirements/Trigger gates, Leap without a stated
 * distance -- leaves the ability unrecognized (#972 widens the riders).
 */

const PRON = "(?:its|their|his|her)";
// The acting creature's name ("The giant short-faced bear", "Bun the
// Black", "It"): no clause words, so "The dwarf warrior Raises a Shield and
// Strides twice" (a second action) never reads as a subject.
const SUBJECT_WORD = "(?!(?:and|or|then|a|an|to|with|of|in|its|their|his|her|uses|makes)\\b)[\\w'’-]+";
const SUBJECT = `(?!(?:If|When|While|After|Once|Each|Every)\\b)[A-Z][\\w'’-]*(?:\\s+${SUBJECT_WORD}){0,6}?`;

const VERB_MODE = Object.freeze({
  Strides: "land",
  Flies: "fly",
  Swims: "swim",
  Burrows: "burrow",
  Climbs: "climb",
  jumps: "land",
  Leaps: "land",
});
const JUMP_VERBS = new Set(["jumps", "Leaps"]);
const VERB = "(?:Strides|Flies|Swims|Burrows|Climbs|jumps|Leaps)";
const VERB_LIST = `${VERB}(?:(?:,\\s*${VERB})*,?\\s+or\\s+${VERB})?`;

const MODE_WORDS = new Set(["land", "fly", "swim", "burrow", "climb"]);
const FACTOR_WORDS = Object.freeze({ half: 0.5, double: 2, twice: 2 });
const REPEAT_WORDS = Object.freeze({ twice: 2, "three times": 3 });

const STRIKE_TIMING = "at the end of (?:that|its|the) movement|at any point during (?:that|its|the|it's) movement";

const MOVE_SENTENCE = new RegExp(
  `^${SUBJECT}\\s+(?<verbs>${VERB_LIST})` +
    `(?:\\s+(?<repeat>twice|three times)` +
    `|\\s+up to (?:(?<factor>half|double|twice)\\s+)?(?:${PRON}\\s+)?(?:(?<modeWord>land|fly|swim|burrow|climb)\\s+)?[Ss]peed` +
    `|\\s+up to (?<fixedFeet>\\d+) feet)?` +
    `(?:,?\\s+with ${PRON} [Ss]peed increased by (?<increase>\\d+) feet)?` +
    `(?:\\s+with a \\+(?<inlineBonus>\\d+)-foot (?<inlineBonusType>circumstance|status) bonus to ${PRON} [Ss]peeds?)?` +
    `(?<straight>\\s+in a straight line)?` +
    `(?:,?\\s+(?<elevation>(?:descending|ascending) at least \\d+ feet),?)?` +
    `(?:,?\\s+(?:and|then|and then)\\s+(?:makes|attempts)\\s+(?:a|an|one)\\s+(?:(?<melee>melee)\\s+|(?<limb>[a-z]+(?:\\s+or\\s+[a-z]+)?)\\s+)?Strike` +
    `(?:\\s+(?<timing>${STRIKE_TIMING}))?)?` +
    `\\.?$`,
);

/** "The pegasus uses 2 move actions, each of which can be either Stride or Fly." */
const MOVE_ACTIONS_SENTENCE = new RegExp(
  `^${SUBJECT}\\s+uses (?:2|two) move actions, each of which can be either (?<first>Stride|Fly|Swim|Burrow|Climb) or (?<second>Stride|Fly|Swim|Burrow|Climb)\\.?$`,
);
const ACTION_MODE = Object.freeze({ Stride: "land", Fly: "fly", Swim: "swim", Burrow: "burrow", Climb: "climb" });

/** A subject later in a sentence ("During the Stride, it gains ..."). */
const INNER_SUBJECT = `(?:it|they|he|she|the(?:\\s+${SUBJECT_WORD}){1,6}?|${SUBJECT})`;

const BONUS_SENTENCE = new RegExp(
  `^(?:During (?:the|this|these) Strides?,\\s+)?${INNER_SUBJECT}\\s+(?:has|have|gains|gain)\\s+a\\s+\\+(?<bonus>\\d+)-foot\\s+(?<bonusType>circumstance|status)\\s+bonus\\s+to\\s+${PRON}\\s+[Ss]peeds?` +
    `(?:\\s+during\\s+(?:these Strides|this Stride|the Stride|this movement|that movement|an? [A-Z][\\w' ]*))?\\.?$`,
);

const TELEPORT_SENTENCE = new RegExp(
  `^${SUBJECT}\\s+teleports(?:\\s+(?:itself|themself|themselves|himself|herself))?\\s+` +
    `(?:up to (?<upTo>\\d+) feet(?: to (?:a location|a space|an? (?:unoccupied|empty|open|clear) space) (?:it|they|he|she) can see)?` +
    `|(?:to|into) an? (?:(?:unoccupied|empty|open|clear) )?space(?: (?:it|they|he|she) can see)? within (?<within>\\d+) feet(?: (?:that|which) (?:it|they|he|she) can see)?)\\.?$`,
);

/** Sudden Charge's own wording (Player Core, and NPCs that copy it):
 * "If they end their movement within melee reach of at least one enemy,
 * they can make a melee Strike against that enemy." -- the same as a Strike
 * at the end of the movement, which already needs the target in reach. */
const CONDITIONAL_STRIKE_SENTENCE = new RegExp(
  `^If ${INNER_SUBJECT} ends? ${PRON} movement within (?:a )?melee reach of (?:at least one enemy|an enemy|a target), ${INNER_SUBJECT} can make an? (?:(?<melee>melee)|(?<limb>[a-z]+)) Strike against that (?:enemy|target)\\.?$`,
);

/** Trailing sentences that are recognized. `apply` folds one into the plan. */
const RIDER_TABLE = Object.freeze([
  {
    id: "no-reactions",
    re: /^This movement (?:doesn't|does not) (?:trigger|provoke) reactions\.?$/,
    apply: (plan) => {
      plan.suppressReactions = true;
    },
  },
  {
    // Phase Jump: elevation and falling are not modeled (spec Resolved
    // Decision #3), so this clause has nothing to change.
    id: "airborne-momentum",
    re: /^If (?:they are|it is|he is|she is) airborne, (?:they|it|he|she) maintains? (?:their|its|his|her) momentum, and (?:do|does) not fall at the end of (?:their|its|his|her) turn, even if (?:they|it|he|she) didn't use an action to Fly\.?$/,
    apply: () => {},
  },
  {
    // "It can't use Jaunt again for [[/gmr 1d4 #Recharge Jaunt]]{1d4 rounds}."
    // -- the formula is read from the inline roll; this only accepts it.
    id: "recharge",
    re: new RegExp(`^(?:${SUBJECT}) can't use [\\w'’ -]+? again for \\d+d\\d+ rounds\\.?$`),
    apply: () => {},
  },
]);

const RECHARGE_ROLL = /\[\[\/gmr (\d+d\d+) #Recharge[^\]]*\]\]/;

function plainText(html) {
  return String(html)
    .replace(/@UUID\[[^\]]*\]\{([^}]*)\}/g, "$1")
    .replace(/@UUID\[[^\]]*?\.([^\].]+)\]/g, "$1")
    .replace(/\[\[[^\]]*\]\]\{([^}]*)\}/g, "$1")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function splitSentences(text) {
  return text
    .split(/(?<=\.)\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function limbList(text) {
  if (!text) return [];
  return text.split(/\s+or\s+/).map((l) => l.trim().toLowerCase()).filter(Boolean);
}

/** The movement modes a verb list names ("Strides, Flies, or Swims"). */
function modesFor(verbsText) {
  const verbs = verbsText.match(new RegExp(VERB, "g")) ?? [];
  return { modes: [...new Set(verbs.map((v) => VERB_MODE[v]))], verbs };
}

function parseMoveSentence(sentence) {
  const actions = MOVE_ACTIONS_SENTENCE.exec(sentence);
  if (actions) {
    return {
      modes: [...new Set([ACTION_MODE[actions.groups.first], ACTION_MODE[actions.groups.second]])],
      speedFactor: 1,
      repeat: 2,
      fixedFeet: null,
      bonusFeet: 0,
      bonusType: null,
      straightLine: false,
      elevationNote: null,
      strike: null,
      jump: false,
    };
  }
  const m = MOVE_SENTENCE.exec(sentence);
  if (!m) return null;
  const g = m.groups;
  let { modes, verbs } = modesFor(g.verbs);
  const jump = verbs.some((v) => JUMP_VERBS.has(v));
  // A jump/Leap's distance must be stated: PF2e's basic Leap is a fixed
  // distance, not a Speed (Breach's "Leaps and makes a Strike").
  if (jump && !g.factor && !g.fixedFeet && !/\bSpeed\b/i.test(sentence)) return null;
  if (jump && verbs.length > 1) return null;
  if (g.modeWord && MODE_WORDS.has(g.modeWord)) {
    // "Flies up to double its fly Speed": the named Speed must belong to
    // one of the verbs' own modes.
    if (!modes.includes(g.modeWord)) return null;
    modes = [g.modeWord];
  }
  const bonus = g.increase ?? g.inlineBonus ?? null;
  const strikeClause = /\bStrike\b/.test(sentence);
  let strike = null;
  if (strikeClause) {
    strike = {
      limbs: g.melee ? [] : limbList(g.limb),
      timing: g.timing && /any point/.test(g.timing) ? "any" : "end",
    };
  }
  return {
    modes,
    speedFactor: g.factor ? FACTOR_WORDS[g.factor] : 1,
    repeat: g.repeat ? REPEAT_WORDS[g.repeat] : 1,
    fixedFeet: g.fixedFeet ? Number(g.fixedFeet) : null,
    bonusFeet: bonus ? Number(bonus) : 0,
    bonusType: g.inlineBonusType ?? (g.increase ? "untyped" : null),
    straightLine: !!g.straight,
    elevationNote: g.elevation ?? null,
    strike,
    jump,
  };
}

function baseDescriptor(item, plan, rechargeFormula) {
  const actionType = item.system?.actionType?.value;
  return {
    cost: actionType === "free" ? 0 : (item.system?.actions?.value ?? 1),
    frequency: item.system?.frequency ?? null,
    rechargeFormula,
    plan,
    mode: "auto",
  };
}

/**
 * `parseMovementAbility(item)` -> `null` or
 * `{ cost, frequency, rechargeFormula, mode: "auto", plan }` where `plan` is
 *   `{ kind: "move", modes, speedFactor, repeat, fixedFeet, bonusFeet,
 *      bonusType, straightLine, elevationNote, strike, suppressReactions }`
 *   (`modes`: the movement types the creature may use, e.g. ["land","fly"]
 *   for "Strides or Flies"; `repeat`: separate moves, e.g. 2 for "Strides
 *   twice"; `strike`: `{ limbs, timing: "end"|"any" }` or null), or
 *   `{ kind: "teleport", teleportFeet, suppressReactions }`.
 * Never throws.
 */
export function parseMovementAbility(item) {
  try {
    return parseMovementAbilityUnsafe(item);
  } catch {
    return null;
  }
}

function parseMovementAbilityUnsafe(item) {
  if (item?.type !== undefined && item.type !== "action") return null;
  const actionType = item?.system?.actionType?.value;
  if (actionType !== undefined && actionType !== "action" && actionType !== "free") return null;
  const raw = item?.system?.description?.value;
  if (!raw || typeof raw !== "string") return null;
  // Requirements/Trigger/Prerequisite gates can't be verified here.
  if (/<strong>\s*(?:Requirements?|Trigger|Prerequisites?)\s*<\/strong>/i.test(raw)) return null;
  if (/\bPrerequisites?\b/.test(raw)) return null;

  const rechargeFormula = RECHARGE_ROLL.exec(raw)?.[1] ?? null;
  // A free action with no limit would be offered again every decision.
  if (actionType === "free" && !rechargeFormula && !item.system?.frequency) return null;

  let html = raw
    .replace(/<p>\s*<strong>\s*Frequency\s*<\/strong>[\s\S]*?<\/p>/gi, " ")
    .replace(/<hr\s*\/?>/gi, " ")
    .replace(/<strong>\s*Effect\s*<\/strong>/gi, " ");
  // Any other enricher (@Damage, @Check, @Template) is an effect this
  // grammar doesn't model.
  if (/@(?!UUID\[)\w+\[/.test(html)) return null;
  if (/\[\[(?!\/gmr \d+d\d+ #Recharge)/.test(html)) return null;
  const sentences = splitSentences(plainText(html));
  if (!sentences.length) return null;

  let plan;
  const teleport = TELEPORT_SENTENCE.exec(sentences[0]);
  if (teleport) {
    plan = {
      kind: "teleport",
      teleportFeet: Number(teleport.groups.upTo ?? teleport.groups.within),
      suppressReactions: false,
    };
  } else {
    const move = parseMoveSentence(sentences[0]);
    if (!move) return null;
    plan = { kind: "move", ...move, suppressReactions: false };
  }

  for (const sentence of sentences.slice(1)) {
    if (plan.kind === "move") {
      const bonus = BONUS_SENTENCE.exec(sentence);
      if (bonus && !plan.bonusFeet) {
        plan.bonusFeet = Number(bonus.groups.bonus);
        plan.bonusType = bonus.groups.bonusType;
        continue;
      }
    }
    const conditional = plan.kind === "move" && !plan.strike ? CONDITIONAL_STRIKE_SENTENCE.exec(sentence) : null;
    if (conditional) {
      plan.strike = { limbs: conditional.groups.melee ? [] : limbList(conditional.groups.limb), timing: "end" };
      continue;
    }
    const rider = RIDER_TABLE.find((r) => r.re.test(sentence));
    if (!rider) return null;
    if (rider.id === "recharge" && !rechargeFormula) return null;
    rider.apply(plan);
  }
  // Teleportation never triggers movement reactions (Player Core,
  // teleportation trait) -- the flag is about the move kind only.
  return baseDescriptor(item, plan, rechargeFormula);
}

const MODE_LABEL = Object.freeze({ land: "Stride", fly: "Fly", swim: "Swim", burrow: "Burrow", climb: "Climb" });

/**
 * The movement budget, in grid squares, `plan` gives a mover with `speeds`
 * (`{ land, fly, swim, burrow, climb }` in feet, absent/0 = none) -- or
 * null when the mover has no Speed for any of the plan's modes. A Speed
 * bonus applies to each separate move ("Strides twice ... +10-foot bonus to
 * its Speed during these Strides": two Strides of Speed + 10), and each
 * move is floored to whole squares on its own. With several usable modes
 * ("Strides or Flies") the best Speed is used. `mode` is the one chosen.
 */
export function npcMoveBudget(plan, speeds, gridDistanceFt = 5) {
  if (!plan || plan.kind !== "move") return null;
  let best = null;
  for (const mode of plan.modes ?? []) {
    const speed = Number(speeds?.[mode] ?? 0);
    if (!(speed > 0)) continue;
    if (!best || speed > best.speed) best = { mode, speed };
  }
  if (!best) return null;
  const perMoveFeet =
    plan.fixedFeet != null
      ? plan.fixedFeet
      : Math.floor(best.speed * (plan.speedFactor ?? 1)) + (plan.bonusFeet ?? 0);
  const perMoveSquares = Math.floor(perMoveFeet / gridDistanceFt);
  const squares = perMoveSquares * (plan.repeat ?? 1);
  if (squares <= 0) return null;
  return { mode: best.mode, squares, feet: perMoveSquares * gridDistanceFt * (plan.repeat ?? 1) };
}

/**
 * The deterministic one-line description of a parsed movement ability the
 * reasoning model and the GM card see ("Stride twice, +10 ft each, toward
 * Goblin; triggers reactions"). The model never reads the ability's prose.
 */
export function describeNpcMove(plan, { mode = null, feet = null, posture = null, targetName = null } = {}) {
  if (!plan) return "";
  const who = targetName ?? "the target";
  if (plan.kind === "teleport") {
    const where = posture === "away-from" ? `away from ${who}` : `next to ${who}`;
    return `teleport up to ${plan.teleportFeet} ft, ${where}; no reactions`;
  }
  const verb = plan.jump ? "Leap" : (MODE_LABEL[mode] ?? MODE_LABEL[plan.modes?.[0]] ?? "Move");
  const times = plan.repeat === 2 ? " twice" : plan.repeat === 3 ? " three times" : "";
  const parts = [`${verb}${times}`];
  if (feet != null) parts.push(`${feet} ft in all`);
  if (plan.straightLine) parts.push("straight line");
  let direction;
  if (posture === "retreat") direction = `away from ${who}`;
  else if (posture === "hitAndRun") direction = `to ${who}, Strike, then away`;
  else direction = `toward ${who}`;
  let text = `${parts.join(", ")} ${direction}`;
  if (plan.strike && posture !== "hitAndRun") {
    const limb = plan.strike.limbs?.length ? `${plan.strike.limbs.join(" or ")} ` : "";
    text += plan.strike.timing === "any" ? `, ${limb}Strike when in reach` : `, then ${limb}Strike`;
  }
  text += plan.suppressReactions ? "; no reactions" : "; can trigger reactions";
  return text;
}
