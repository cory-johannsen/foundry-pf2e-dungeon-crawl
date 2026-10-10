/**
 * #931: the NPC reaction registry -- generalizes #202's single hard-coded
 * Reactive Strike / Attack of Opportunity path into a data table, plus the
 * pure decision logic every trigger path shares. No Foundry API surface:
 * dungeon-combat.mjs owns the geometry (reach, line of sight, detection),
 * the trigger hooks and the executors, and calls in here for "which
 * reactions does this creature have", "does this trigger fire at this point
 * of the move", "would this AC bonus turn the hit into a miss" and "which
 * reaction does this creature use" (the hybrid decision).
 *
 * Every row was checked against the compendium item text (Monster Core,
 * Bestiary 1-3, pf2e 8.5.0):
 *   - Reactive Strike / Attack of Opportunity (+ "(Jaws Only)"-style limb
 *     variants): a melee Strike against the triggering creature.
 *   - Twisting Tail: "A creature within reach of the dragon's tail uses a
 *     move action or leaves a square during a move action it's using" ->
 *     tail Strike at -2 (the item's own `twisting-tail` roll option +
 *     FlatModifier); "If the Strike hits, the dragon disrupts the
 *     creature's action."
 *   - Wing Rebuff (roc): "A creature moves from beyond the reach of the
 *     roc's wing to within the reach of the roc's wing" -> wing Strike; "If
 *     the roc Pushes the creature, it disrupts the triggering move action"
 *     (the wing carries `improved-push`).
 *   - Shield Block: glossary reaction; needs a raised, unbroken shield and
 *     a physical attack's damage; the system applies Hardness itself
 *     (`applyDamage({ shieldBlockRequest: true })`).
 *   - Wing Deflection: "targeted with an attack" -> +2 circumstance AC.
 *   - Ghost Dodge: "targeted by a Strike or spell" -> +2 circumstance AC
 *     (its resistances are out of scope).
 *   - Swat Projectile: "targeted by a physical ranged attack" -> +4
 *     circumstance AC (the throw-back is out of scope).
 */

const MODULE_ID = "pf2e-dungeon-crawl";

/** How long the hybrid decision waits for the agent service (spec). */
export const REACTION_DECISION_TIMEOUT_MS = 5000;

/** Event kinds a reaction can answer.
 *  - `move`: a creature moved (a path of positions is known).
 *  - `strideEnd`: an AI Stride just ended (#202's own end-of-move check;
 *    only Reactive Strike answers it, preserving #202's exact behavior).
 *  - `rangedAttack`: a creature made a ranged Strike.
 *  - `manual`: the GM's "Reactive Strike Check" context-menu button.
 *  - `targetedByAttack`: an attack roll against the reactor resolved.
 *  - `damageIncoming`: a Strike's damage is about to be applied to it. */
export const REACTION_TRIGGERS = Object.freeze([
  "move",
  "strideEnd",
  "rangedAttack",
  "manual",
  "targetedByAttack",
  "damageIncoming",
]);

const always = () => true;

/** The registry. `priority` breaks ties in the deterministic fallback
 * (higher first). `moveTrigger` says how a `move` event fires the
 * reaction: `withinReach` (uses a move action while within reach, or
 * leaves a square within reach) or `entersReach` (moves from beyond reach
 * to within it). `limb` restricts the Strike to that named attack;
 * `disrupts` says what disrupts the triggering move (`hit` or `push`). */
export const REACTION_DEFS = Object.freeze([
  Object.freeze({
    id: "reactive-strike",
    label: "Reactive Strike",
    match: /^(Reactive Strike|Attack of Opportunity)\b/i,
    triggers: ["move", "strideEnd", "rangedAttack", "manual"],
    kind: "strike",
    moveTrigger: "withinReach",
    priority: 10,
    policy: always,
  }),
  Object.freeze({
    id: "twisting-tail",
    label: "Twisting Tail",
    match: /^Twisting Tail\b/i,
    triggers: ["move", "manual"],
    kind: "strike",
    moveTrigger: "withinReach",
    limb: "tail",
    rollOption: "twisting-tail",
    penalty: -2,
    disrupts: "hit",
    priority: 20,
    policy: always,
  }),
  Object.freeze({
    id: "wing-rebuff",
    label: "Wing Rebuff",
    match: /^Wing Rebuff\b/i,
    triggers: ["move"],
    kind: "strike",
    moveTrigger: "entersReach",
    limb: "wing",
    disrupts: "push",
    priority: 15,
    policy: always,
  }),
  Object.freeze({
    id: "shield-block",
    label: "Shield Block",
    match: /^Shield Block\b/i,
    triggers: ["damageIncoming"],
    kind: "damageReduction",
    priority: 10,
    // Spec: block when the incoming damage exceeds the shield's Hardness.
    policy: (ctx) => Number(ctx.incomingDamage) > Number(ctx.shieldHardness ?? 0),
  }),
  Object.freeze({
    id: "wing-deflection",
    label: "Wing Deflection",
    match: /^Wing Deflection\b/i,
    triggers: ["targetedByAttack"],
    kind: "acBonus",
    acBonus: 2,
    priority: 10,
    policy: (ctx) => acBonusTurnsHitToMiss(ctx, 2),
  }),
  Object.freeze({
    id: "ghost-dodge",
    label: "Ghost Dodge",
    match: /^Ghost Dodge\b/i,
    triggers: ["targetedByAttack"],
    kind: "acBonus",
    acBonus: 2,
    priority: 10,
    policy: (ctx) => acBonusTurnsHitToMiss(ctx, 2),
  }),
  Object.freeze({
    id: "swat-projectile",
    label: "Swat Projectile",
    match: /^Swat Projectile\b/i,
    triggers: ["targetedByAttack"],
    kind: "acBonus",
    acBonus: 4,
    requiresPhysicalRanged: true,
    priority: 10,
    policy: (ctx) => acBonusTurnsHitToMiss(ctx, 4),
  }),
]);

export function reactionDefById(id) {
  return REACTION_DEFS.find((d) => d.id === id) ?? null;
}

/** Whether `item` is an NPC reaction action (`type: "action"`,
 * `actionType: reaction`) -- the same item shape #202's
 * `isReactiveStrikeInScope` keys on. */
export function isReactionActionItem(item) {
  return item?.type === "action" && item?.system?.actionType?.value === "reaction";
}

/** Every registry reaction `actor` has, as `[{ def, item }]` (first
 * matching item per definition). Unknown reactions are never offered. */
export function reactionItemsFor(actor) {
  const items = Array.from(actor?.items ?? []).filter(isReactionActionItem);
  const found = [];
  for (const def of REACTION_DEFS) {
    const item = items.find((i) => def.match.test(i.name ?? ""));
    if (item) found.push({ def, item });
  }
  return found;
}

/**
 * The index into `inReach` (one boolean per position of the move: origin,
 * then each square entered, the last being the destination) at which a
 * `move` event fires a reaction with this `moveTrigger`, or -1.
 *  - `withinReach` (Reactive Strike, Twisting Tail): the creature uses a
 *    move action while within reach (origin) or leaves a square within
 *    reach -- the first non-final position that is within reach. Ending a
 *    move in reach does not trigger it.
 *  - `entersReach` (Wing Rebuff): the creature moves from beyond reach to
 *    within reach -- the first position within reach, when the origin was
 *    not.
 */
export function moveTriggerIndex(moveTrigger, inReach) {
  const points = Array.isArray(inReach) ? inReach : [];
  if (points.length < 2) return -1;
  const last = points.length - 1;
  if (moveTrigger === "withinReach") {
    for (let i = 0; i < last; i++) if (points[i]) return i;
    return -1;
  }
  if (moveTrigger === "entersReach") {
    if (points[0]) return -1;
    for (let i = 1; i <= last; i++) if (points[i]) return i;
    return -1;
  }
  return -1;
}

const DEGREES = ["criticalFailure", "failure", "success", "criticalSuccess"];

/** PF2e's degree of success for `total` against `dc` (+/-10 for a
 * critical, then one step up on a natural 20 / down on a natural 1) --
 * the same arithmetic as the system's own `DegreeOfSuccess` (pf2e 8.5.0),
 * which needs a live roll this module's chat-message hooks no longer have.
 * Property-rune/rule-element degree adjustments are not re-applied. */
export function degreeOfSuccess(total, dc, natural = null) {
  let index;
  if (total - dc >= 10) index = 3;
  else if (dc - total >= 10) index = 0;
  else if (total >= dc) index = 2;
  else index = 1;
  if (natural === 20) index = Math.min(3, index + 1);
  else if (natural === 1) index = Math.max(0, index - 1);
  return DEGREES[index];
}

export const isHitOutcome = (outcome) =>
  outcome === "success" || outcome === "criticalSuccess";

/** Whether a +`bonus` circumstance bonus to AC would have turned this
 * resolved attack (`ctx.rollTotal` against `ctx.dcValue`, `ctx.natural`,
 * `ctx.outcome` as rolled) from a hit into a miss -- the AC-bonus
 * reactions' policy. A critical hit that would only drop to a hit does not
 * count (the module cannot un-crit damage that was already rolled). */
export function acBonusTurnsHitToMiss(ctx, bonus) {
  const total = Number(ctx?.rollTotal);
  const dc = Number(ctx?.dcValue);
  if (!Number.isFinite(total) || !Number.isFinite(dc)) return false;
  if (ctx.outcome && !isHitOutcome(ctx.outcome)) return false;
  const natural = Number.isInteger(ctx.natural) ? ctx.natural : null;
  if (!isHitOutcome(degreeOfSuccess(total, dc, natural))) return false;
  return !isHitOutcome(degreeOfSuccess(total, dc + bonus, natural));
}

/** Candidate id for the agent-service reaction decision. */
export function reactionCandidateId(defId, reactorId) {
  return `reaction:${defId}:${reactorId}`;
}

/** The highest-priority option whose deterministic policy says yes. */
export function fallbackReaction(options) {
  return (
    [...options]
      .sort((a, b) => b.def.priority - a.def.priority)
      .find((o) => safePolicy(o)) ?? null
  );
}

function safePolicy(option) {
  try {
    return !!option.def.policy(option.ctx ?? {});
  } catch {
    return false;
  }
}

function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${ms} ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * The hybrid decision for ONE reactor (a creature has one reaction per
 * round, so its options never compete with another creature's).
 * `options` are `[{ def, ctx }]` -- every registry reaction eligible for
 * this trigger.
 *  - none: no reaction.
 *  - one: its deterministic `policy` decides.
 *  - several: `requestDecision({ candidates })` (the agent service, with
 *    `timeoutMs`) picks one of `reaction:<defId>:<reactorId>` or `decline`;
 *    a timeout, error, unknown id, or no service (`requestDecision` null,
 *    or it resolves null) falls back to the highest-priority option whose
 *    policy says yes.
 * Returns `{ choice, source, rationale }`; `source` is `policy`, `model`,
 * `declined` or `fallback`. Never throws.
 */
export async function decideReaction(
  options,
  { reactorId, requestDecision = null, timeoutMs = REACTION_DECISION_TIMEOUT_MS, describe = null } = {},
) {
  const list = Array.isArray(options) ? options : [];
  if (!list.length) return { choice: null, source: "policy", rationale: null };
  if (list.length === 1) {
    const only = list[0];
    return { choice: safePolicy(only) ? only : null, source: "policy", rationale: null };
  }
  const byId = new Map(list.map((o) => [reactionCandidateId(o.def.id, reactorId), o]));
  const candidates = [
    ...list.map((o) => ({
      id: reactionCandidateId(o.def.id, reactorId),
      summary: describe ? describe(o) : `Use ${o.def.label}`,
    })),
    { id: "decline", summary: "Decline to react (keep the reaction for later this round)" },
  ];
  const fallback = (why) => ({ choice: fallbackReaction(list), source: "fallback", rationale: why });
  if (typeof requestDecision !== "function") return fallback(null);
  let decision;
  try {
    decision = await withTimeout(Promise.resolve(requestDecision({ candidates })), timeoutMs);
  } catch (err) {
    return fallback(`agent service unavailable (${err?.message ?? err}); used the default priority`);
  }
  if (!decision) return fallback(null);
  if (decision.candidateId === "decline") {
    return { choice: null, source: "declined", rationale: decision.rationale ?? null };
  }
  const picked = byId.get(decision.candidateId);
  if (!picked) return fallback(`agent service picked an unknown option; used the default priority`);
  return { choice: picked, source: "model", rationale: decision.rationale ?? null };
}

/** True when `run` (a dungeon run state) is a hosted GM-less run that is
 * still going -- the same "hostUserId and not completed" test
 * `findActiveHostedRun` uses. */
export function isGmLessRunState(run) {
  return !!run?.hostUserId && !run.completed;
}

/**
 * Whether a defensive reaction (`acBonus`/`damageReduction`) runs at once
 * or waits for a GM's one-click confirmation (spec, "Player-driven
 * attacks"): automatic when the attacker is AI-driven (monster vs monster,
 * the module owns that attack) or when there is no human GM (a hosted
 * GM-less run) -- never a card in GM-less mode; a confirm card only for a
 * player-driven attacker at a table with a human GM.
 */
export function defensiveReactionMode({ attackerIsPlayerDriven, gmLess }) {
  if (!attackerIsPlayerDriven) return "automatic";
  return gmLess ? "automatic" : "confirm";
}

/** The click action of a reaction confirm card, or null when `message`
 * is not one or the clicking user may not answer it (GM only). */
export function reactionConfirmActionFor(message, { isGM = false } = {}) {
  const card = message?.flags?.[MODULE_ID]?.reactionConfirm;
  if (!card?.combatId || !card?.confirmId) return null;
  return { combatId: card.combatId, confirmId: card.confirmId, enabled: !!isGM && !card.resolved };
}

/** Escapes text for chat HTML. */
export function escapeReactionHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** The GM-only part of a reaction announcement (why it was used): the
 * model's rationale or the deterministic policy's reason. Empty when
 * there is nothing to add. */
export function reactionGmNoteHtml(note) {
  if (!note) return "";
  return `<div data-visibility="gm" class="pf2edc-agent-rationale"><em>${escapeReactionHtml(note)}</em></div>`;
}
